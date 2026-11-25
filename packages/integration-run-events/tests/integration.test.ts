import { AutomationService } from '@numenjs/automation'
import { CapabilityRegistry, type AutomationSource, type CapabilityDefinition, type NumenValue } from '@numenjs/core'
import { ConnectionService } from '@numenjs/connections'
import { CredentialService } from '@numenjs/credentials'
import { DatabaseService } from '@numenjs/database'
import { ResourceService } from '@numenjs/resources'
import { SchedulerService } from '@numenjs/scheduler'
import { TriggerService } from '@numenjs/triggers'
import smtpIntegrationPlugin, { smtpPasswordAdapter, smtpPasswordCredential } from '@numenjs/integration-smtp'
import { Context } from 'cordis'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import z from 'schemastery'
import { afterEach, describe, expect, it } from 'vitest'
import { startSmtpFixture, type SmtpFixtureOptions } from '../../integration-smtp/tests/fixture.js'
import runEventsIntegrationPlugin, { runAttentionTrigger } from '../src/index.js'

const contexts = new Set<Context>()
const directories: string[] = []
const servers: Awaited<ReturnType<typeof startSmtpFixture>>[] = []
const keyEnv = 'NUMEN_RUN_EVENTS_TEST_KEY'
const previousKey = process.env[keyEnv]
const privateValue = 'never-forward-this-original-input-or-provider-error'
const literal = (value: NumenValue) => ({ type: 'literal' as const, value })
const failDefinition: CapabilityDefinition = {
  id: 'test:attention-fail', version: 1, kind: 'query', title: 'Fail privately',
  input: z.object({}), output: z.object({}),
  semantics: { sideEffect: false, idempotent: true, retrySafe: true },
}

afterEach(async () => {
  for (const root of contexts) await root.fiber.dispose()
  contexts.clear()
  await Promise.all(servers.splice(0).map(server => server.close()))
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
  if (previousKey === undefined) delete process.env[keyEnv]; else process.env[keyEnv] = previousKey
})

async function fixture(smtpOptions: SmtpFixtureOptions = {}) {
  process.env[keyEnv] = randomBytes(32).toString('base64')
  const directory = await mkdtemp(join(tmpdir(), 'numen-run-events-')); directories.push(directory)
  const smtp = await startSmtpFixture(smtpOptions); servers.push(smtp)
  const root = new Context(); contexts.add(root)
  await root.plugin(DatabaseService, { path: join(directory, 'db') })
  await root.plugin(CapabilityRegistry)
  await root.plugin(CredentialService, { masterKeyEnv: keyEnv })
  await root.plugin(ResourceService, { path: join(directory, 'resources') })
  await root.plugin(ConnectionService)
  await root.plugin(AutomationService)
  await root.plugin(SchedulerService, { sweepIntervalMs: 60_000 })
  await root.plugin(smtpIntegrationPlugin, { sendTimeoutMs: 2000 })
  root.capabilities.define(root, failDefinition)
  root.capabilities.provide(root, failDefinition, { async invoke() { throw new Error(privateValue) } })
  const plugin = await root.plugin(runEventsIntegrationPlugin, { reconcileIntervalMs: 100 })
  await root.plugin(TriggerService)
  const credential = root.credentials.create('Notification mail', smtpPasswordCredential, smtp.credential)
  const connection = root.connections.create({ name: 'Notification transport', adapter: smtpPasswordAdapter,
    credentialId: credential.id, config: smtp.config as unknown as Record<string, NumenValue>, enabled: true })
  await root.connections.reconcile()
  const source = publish(root, 'Source failure', {
    triggers: [], flow: { type: 'capability', id: 'fail', capability: failDefinition, input: {} },
  })
  const notificationSource: AutomationSource = {
    triggers: [{ id: 'attention', capability: runAttentionTrigger, config: { kinds: ['FAILED', 'OUTCOME_UNKNOWN'], automationIds: [] } }],
    policy: { maxActive: 1, overflow: 'queue' },
    flow: { type: 'capability', id: 'notify', capability: { id: 'smtp:send', version: 1 }, connections: { transport: connection.id }, input: {
      to: literal(['operator@example.test']), subject: literal('Run needs attention'),
      text: { type: 'template', parts: [{ ref: 'trigger.summary' }, '\n', { ref: 'trigger.runPath' }] },
    } },
  }
  const notification = publish(root, 'Failure notification', notificationSource)
  root.automations.setEnabled(notification.id, true)
  return { root, smtp, source, notification, notificationSource, plugin }
}
function publish(root: Context, name: string, source: AutomationSource) {
  const { automation } = root.automations.create({ name, source })
  const revision = root.automations.publishDraft(automation.id, 1)
  root.automations.activateRevision(automation.id, revision.id)
  return automation
}

describe('official durable Run attention trigger', () => {
  it('submits a real TLS notification using safe metadata and excludes published tests', async () => {
    const { root, smtp, source, notification } = await fixture()
    const run = root.scheduler.startManual(source.id, {}, { privateValue })
    await expect.poll(() => root.scheduler.getRun(run.id)?.status).toBe('FAILED')
    await expect.poll(() => root.scheduler.listRuns().find(item => item.automationId === notification.id)?.status).toBe('COMPLETED')
    expect(smtp.messages).toHaveLength(1)
    const notificationRun = root.scheduler.listRuns().find(item => item.automationId === notification.id)!
    expect(notificationRun.trigger).toMatchObject({ kind: 'FAILED', runId: run.id, runPath: `/runs/${run.id}/flow` })
    expect(JSON.stringify(notificationRun.trigger)).not.toContain(privateValue)
    expect(smtp.messages[0]!.raw).not.toContain(privateValue)
    const test = root.scheduler.startRevisionTest(source.id, run.revisionId, {}, null, 'test-attention-ignore-0001')
    await expect.poll(() => root.scheduler.getRun(test.id)?.status).toBe('FAILED')
    expect(root.scheduler.listAttention({ runId: test.id }).items).toEqual([])
    expect(root.scheduler.listRuns().filter(item => item.automationId === notification.id)).toHaveLength(1)
  })

  it('restores pending delivery after provider unload and keeps cross-Revision receipts', async () => {
    const { root, smtp, source, notification, notificationSource, plugin } = await fixture()
    await plugin.dispose()
    const run = root.scheduler.startManual(source.id)
    await expect.poll(() => root.scheduler.getRun(run.id)?.status).toBe('FAILED')
    expect(root.scheduler.listRuns().filter(item => item.automationId === notification.id)).toHaveLength(0)
    await root.plugin(runEventsIntegrationPlugin, { reconcileIntervalMs: 100 })
    await expect.poll(() => smtp.messages.length).toBe(1)
    await expect.poll(() => root.scheduler.listRuns().find(item => item.automationId === notification.id)?.status).toBe('COMPLETED')
    const draft = root.automations.getDraft(notification.id)!
    const updated = root.automations.saveDraft({ automationId: notification.id, expectedVersion: draft.version, source: notificationSource, presentation: { note: 'new revision' } })
    const revision = root.automations.publishDraft(notification.id, updated.version)
    root.automations.activateRevision(notification.id, revision.id)
    const current = root.automations.get(notification.id)!
    root.scheduler.dispatchAttention({ automationId: current.id, revisionId: revision.id, activationGeneration: current.activationGeneration,
      triggerId: 'attention', capability: runAttentionTrigger, config: notificationSource.triggers[0]!.config, connectionIds: {} })
    expect(root.scheduler.listRuns().filter(item => item.automationId === notification.id)).toHaveLength(1)
    expect(smtp.messages).toHaveLength(1)
  })

  it('keeps an uncertain SMTP outcome visible without recursively sending more mail', async () => {
    const { root, smtp, source, notification } = await fixture({ finalResponse: 'disconnect' })
    const run = root.scheduler.startManual(source.id)
    await expect.poll(() => root.scheduler.getRun(run.id)?.status).toBe('FAILED')
    await expect.poll(() => root.scheduler.listAttention({ automationId: notification.id }).items.length).toBe(1)
    const attention = root.scheduler.listAttention({ automationId: notification.id }).items[0]!
    expect(attention.kind).toBe('OUTCOME_UNKNOWN')
    const active = root.automations.get(notification.id)!
    for (let i = 0; i < 3; i++) root.scheduler.dispatchAttention({ automationId: active.id, revisionId: active.activeRevisionId!, activationGeneration: active.activationGeneration,
      triggerId: 'attention', capability: runAttentionTrigger, config: { kinds: ['FAILED', 'OUTCOME_UNKNOWN'], automationIds: [] }, connectionIds: {} })
    expect(root.scheduler.listRuns().filter(item => item.automationId === notification.id)).toHaveLength(1)
    expect(smtp.messages).toHaveLength(1)
    root.scheduler.cancelRun(attention.runId)
  })
})
