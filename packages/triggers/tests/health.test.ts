import { AutomationService } from '@numenjs/automation'
import { ConnectionService } from '@numenjs/connections'
import { CapabilityRegistry, defineCapability, type TriggerActivation } from '@numenjs/core'
import { CredentialService } from '@numenjs/credentials'
import { DatabaseService } from '@numenjs/database'
import { LoggingService } from '@numenjs/logging'
import { ResourceService } from '@numenjs/resources'
import { SchedulerService } from '@numenjs/scheduler'
import { Context } from 'cordis'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import z from 'schemastery'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TriggerService } from '../src/index.js'

const roots: Context[] = []
const directories: string[] = []
const masterKeyEnv = 'NUMEN_TRIGGER_HEALTH_TEST_KEY'

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => root.fiber.dispose()))
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
  delete process.env[masterKeyEnv]
})

const definition = defineCapability({
  id: 'test:push-health', version: 1, kind: 'trigger', title: 'Push test',
  input: z.object({}), output: z.object({ value: z.string().required() }),
  connections: [{ name: 'account', required: true, accepts: ['test:push-account@1'] }],
  semantics: { sideEffect: false, idempotent: true, retrySafe: true },
})

async function harness(ids: string[], activate: (activation: TriggerActivation, root: Context) => void | (() => void) = () => {}) {
  const directory = await mkdtemp(join(tmpdir(), 'numen-trigger-health-'))
  directories.push(directory)
  process.env[masterKeyEnv] = randomBytes(32).toString('base64')
  const root = new Context()
  roots.push(root)
  await root.plugin(LoggingService, { console: false })
  await root.plugin(DatabaseService, { path: ':memory:' })
  await root.plugin(CredentialService, { masterKeyEnv })
  await root.plugin(ConnectionService)
  await root.plugin(CapabilityRegistry)
  const credentialType = { id: 'test:push-token', version: 1, title: 'Push token', secret: z.object({ token: z.string().required() }) }
  root.credentials.defineType(root, credentialType)
  const credential = root.credentials.create('Account', credentialType, { token: 'initial' })
  const type = { id: 'test:push-account', version: 1, title: 'Push account' }
  const adapter = { id: 'test:push-adapter', version: 1, title: 'Push adapter', type, credentialType: credentialType.id, config: z.object({}) }
  root.connections.defineType(root, type)
  root.connections.defineAdapter(root, adapter)
  root.connections.provideAdapter(root, adapter, { async open({ credential }) { return { value: { version: credential!.secretVersion } } } })
  const connection = root.connections.create({ name: 'Push account', adapter, config: {}, credentialId: credential.id, enabled: true })
  await root.connections.reconcile()
  root.capabilities.define(root, definition)
  const activations: TriggerActivation[] = []
  const providerPlugin = (ctx: Context) => {
    ctx.capabilities.provideTrigger(ctx, definition, { activate(activation) { activations.push(activation); return activate(activation, root) } })
  }
  providerPlugin.inject = ['capabilities']
  const provider = await root.plugin(providerPlugin)
  await root.plugin(AutomationService)
  await root.plugin(ResourceService, { path: join(directory, 'resources') })
  await root.plugin(SchedulerService, { autoDispatch: false })
  await root.plugin(TriggerService)
  const { automation } = root.automations.create({ name: 'Background health', source: {
    triggers: ids.map(id => ({ id, capability: definition, config: {}, connections: { account: connection.id } })),
    flow: { type: 'block', id: 'flow', steps: [] },
  } })
  const revision = root.automations.publishDraft(automation.id, 1)
  root.automations.activateRevision(automation.id, revision.id)
  root.automations.setEnabled(automation.id, true)
  return { root, activations, automation, credential, provider }
}

describe('Trigger background health', () => {
  it('disposes an activation disabled synchronously before activate returns', async () => {
    const disposed = vi.fn()
    const h = await harness(['pushing'], (activation, root) => {
      root.automations.setEnabled(activation.binding.automationId, false)
      return disposed
    })
    expect(h.root.automations.get(h.automation.id)?.enabled).toBe(false)
    expect(h.root.triggers.health()).toMatchObject({ desiredSubscriptions: 0, activeSubscriptions: 0 })
    expect(h.activations[0]!.signal.aborted).toBe(true)
    expect(disposed).toHaveBeenCalledTimes(1)
  })

  it('coalesces reentrant health observers and disposes each subscription once', async () => {
    const disposed = vi.fn()
    const h = await harness(['pushing'], (_, root) => () => {
      disposed()
      root.triggers.reconcile()
    })
    let notifying = false
    const statuses: string[] = []
    h.root.on('numen/trigger-runtime-change', () => {
      expect(notifying).toBe(false)
      notifying = true
      const status = h.root.triggers.automationHealth(h.automation.id)!.status
      statuses.push(status)
      if (status === 'WAITING') h.root.automations.setEnabled(h.automation.id, false)
      h.root.triggers.reconcile()
      notifying = false
    })
    h.activations[0]!.reportStatus?.('ERROR')
    expect(statuses).toEqual(['WAITING', 'DISABLED'])
    expect(disposed).toHaveBeenCalledTimes(1)
    expect(h.root.triggers.health()).toMatchObject({ activeSubscriptions: 0, unavailableSubscriptions: 0 })
    expect(await h.activations[0]!.emit({ data: { value: 'late' } })).toEqual({ status: 'stale' })
  })

  it('retains the new generation enabled synchronously by an old abort listener', async () => {
    let restored = false
    const h = await harness(['pushing'], (activation, root) => {
      activation.signal.addEventListener('abort', () => {
        if (restored) return
        restored = true
        root.automations.setEnabled(activation.binding.automationId, true)
      })
    })
    h.root.automations.setEnabled(h.automation.id, false)
    expect(h.root.automations.get(h.automation.id)?.enabled).toBe(true)
    expect(h.activations).toHaveLength(2)
    expect(h.activations[0]!.signal.aborted).toBe(true)
    expect(h.activations[1]!.signal.aborted).toBe(false)
    expect(h.root.triggers.health()).toMatchObject({ desiredSubscriptions: 1, activeSubscriptions: 1 })
    expect(h.root.triggers.automationHealth(h.automation.id)).toMatchObject({ status: 'READY', expected: 1, active: 1 })
    h.activations[0]!.reportStatus?.('ERROR')
    expect(h.root.triggers.automationHealth(h.automation.id)?.status).toBe('READY')
  })

  it('recomputes generations changed during activate without duplicate live subscriptions', async () => {
    let changed = false
    const h = await harness(['pushing'], (activation, root) => {
      if (changed) return
      changed = true
      root.automations.setEnabled(activation.binding.automationId, false)
      root.automations.setEnabled(activation.binding.automationId, true)
    })
    expect(h.activations).toHaveLength(2)
    expect(h.activations[0]!.signal.aborted).toBe(true)
    expect(h.activations[1]!.signal.aborted).toBe(false)
    expect(h.activations[1]!.binding.activationGeneration).toBe(h.root.automations.get(h.automation.id)!.activationGeneration)
    expect(h.root.triggers.automationHealth(h.automation.id)).toMatchObject({ status: 'READY', expected: 1, active: 1 })
  })

  it('aggregates reported errors without stopping subscriptions, and recovers without duplicate notifications', async () => {
    const h = await harness(['pushing', 'legacy'], activation => {
      if (activation.binding.triggerId === 'pushing') activation.reportStatus?.('ERROR')
    })
    const pushing = h.activations.find(item => item.binding.triggerId === 'pushing')!
    const legacy = h.activations.find(item => item.binding.triggerId === 'legacy')!
    expect(h.root.triggers.automationHealth(h.automation.id)).toMatchObject({ status: 'WAITING', expected: 2, active: 1 })
    expect(h.root.triggers.health()).toMatchObject({ activeSubscriptions: 2, unavailableSubscriptions: 1 })
    const changed = vi.fn()
    h.root.on('numen/trigger-runtime-change', changed)
    pushing.reportStatus?.('ERROR')
    pushing.reportStatus?.('ERROR')
    expect(changed).not.toHaveBeenCalled()
    pushing.reportStatus?.('READY')
    expect(changed).toHaveBeenCalledTimes(1)
    pushing.reportStatus?.('READY')
    expect(changed).toHaveBeenCalledTimes(1)
    expect(h.root.triggers.automationHealth(h.automation.id)).toMatchObject({ status: 'READY', active: 2 })

    legacy.reportStatus?.('ERROR')
    pushing.reportStatus?.('ERROR')
    expect(changed).toHaveBeenCalledTimes(3)
    expect(h.root.triggers.health()).toMatchObject({ activeSubscriptions: 2, unavailableSubscriptions: 2 })
    expect(h.root.triggers.automationHealth(h.automation.id)).toMatchObject({ status: 'WAITING', active: 0 })
    h.root.triggers.reconcile()
    expect(h.activations).toHaveLength(2)
    expect(changed).toHaveBeenCalledTimes(3)
    // A successful retry may emit before the provider reports its recovery.
    const receipt = await pushing.emit({ eventId: 'recovered-push', data: { value: 'event' } })
    expect(receipt.status).toBe('accepted')
    expect(h.root.scheduler.getRun(receipt.runId!)?.status).toBe('QUEUED')
    expect(pushing.signal.aborted).toBe(false)
    pushing.reportStatus?.('READY')
    legacy.reportStatus?.('READY')
    expect(changed).toHaveBeenCalledTimes(5)
    expect(h.root.triggers.health()).toMatchObject({ activeSubscriptions: 2, unavailableSubscriptions: 0 })
    expect(h.root.triggers.automationHealth(h.automation.id)).toMatchObject({ status: 'READY', active: 2 })
  })

  it('fences stale health callbacks after credential rotation, revision changes, disable and provider disposal', async () => {
    const h = await harness(['pushing'])
    const initial = h.activations[0]!
    initial.reportStatus?.('ERROR')
    h.root.credentials.rotate(h.credential.id, h.credential.secretVersion, { token: 'rotated' })
    await h.root.connections.reconcile()
    await vi.waitFor(() => expect(h.activations).toHaveLength(2))
    const rotated = h.activations[1]!
    expect(initial.signal.aborted).toBe(true)
    expect(rotated.connections).toEqual({ account: { version: 2 } })
    expect(h.root.triggers.health()).toMatchObject({ activeSubscriptions: 1, unavailableSubscriptions: 0 })
    const changed = vi.fn()
    h.root.on('numen/trigger-runtime-change', changed)
    initial.reportStatus?.('ERROR')
    expect(changed).not.toHaveBeenCalled()
    rotated.reportStatus?.('ERROR')
    initial.reportStatus?.('READY')
    expect(changed).toHaveBeenCalledTimes(1)
    expect(h.root.triggers.automationHealth(h.automation.id)?.status).toBe('WAITING')

    const revision = h.root.automations.publishDraft(h.automation.id, 1)
    h.root.automations.activateRevision(h.automation.id, revision.id)
    const revised = h.activations[2]!
    expect(rotated.signal.aborted).toBe(true)
    changed.mockClear()
    rotated.reportStatus?.('ERROR')
    expect(changed).not.toHaveBeenCalled()
    expect(h.root.triggers.automationHealth(h.automation.id)?.status).toBe('READY')
    revised.reportStatus?.('ERROR')
    h.root.automations.setEnabled(h.automation.id, false)
    changed.mockClear()
    revised.reportStatus?.('READY')
    expect(changed).not.toHaveBeenCalled()
    expect(h.root.triggers.health()).toMatchObject({ activeSubscriptions: 0, unavailableSubscriptions: 0 })
    expect(h.root.triggers.automationHealth(h.automation.id)?.status).toBe('DISABLED')

    h.root.automations.setEnabled(h.automation.id, true)
    const restored = h.activations[3]!
    await h.provider.dispose()
    expect(restored.signal.aborted).toBe(true)
    changed.mockClear()
    restored.reportStatus?.('ERROR')
    restored.reportStatus?.('READY')
    expect(changed).not.toHaveBeenCalled()
    expect(h.root.triggers.health()).toMatchObject({ activeSubscriptions: 0, unavailableSubscriptions: 1 })
    expect(h.root.triggers.automationHealth(h.automation.id)?.status).toBe('WAITING')
    expect(await initial.emit({ data: { value: 'stale' } })).toEqual({ status: 'stale' })
  })

  it('aborts a partially activated provider before it can report or emit after throwing', async () => {
    const h = await harness(['pushing'], activation => {
      activation.reportStatus?.('ERROR')
      throw new Error('private upstream failure')
    })
    const failed = h.activations[0]!
    expect(failed.signal.aborted).toBe(true)
    expect(h.root.triggers.health()).toMatchObject({ activeSubscriptions: 0, unavailableSubscriptions: 1 })
    const changed = vi.fn()
    h.root.on('numen/trigger-runtime-change', changed)
    failed.reportStatus?.('READY')
    failed.reportStatus?.('ERROR')
    expect(changed).not.toHaveBeenCalled()
    expect(await failed.emit({ data: { value: 'late' } })).toEqual({ status: 'stale' })
    expect(h.root.scheduler.listRuns()).toEqual([])
    expect(JSON.stringify(h.root.triggers.automationHealth(h.automation.id))).not.toContain('private upstream failure')
    await h.provider.dispose()
    h.root.capabilities.provideTrigger(h.root, definition, { activate() {} })
    failed.reportStatus?.('ERROR')
    expect(h.root.triggers.automationHealth(h.automation.id)?.status).toBe('READY')
    expect(h.root.triggers.health()).toMatchObject({ activeSubscriptions: 1, unavailableSubscriptions: 0 })
  })
})
