import Server from '@cordisjs/plugin-server'
import { AutomationService } from '@numenjs/automation'
import { ConnectionService } from '@numenjs/connections'
import { ConsoleEntryRegistry, ConsoleService, SingleUserConsoleAuthService } from '@numenjs/console'
import { CapabilityRegistry } from '@numenjs/core'
import { CredentialService } from '@numenjs/credentials'
import { DatabaseService } from '@numenjs/database'
import { LoggingService } from '@numenjs/logging'
import { ResourceService } from '@numenjs/resources'
import { SchedulerService } from '@numenjs/scheduler'
import { TriggerService } from '@numenjs/triggers'
import { coreWorkbenchEntryId, WorkbenchRuntimeService } from '@numenjs/workbench/runtime'
import { Context } from 'cordis'
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import type { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import githubPlugin, { githubWebhookPath, githubWebhookTrigger } from '../src/plugin.js'

describe('GitHub optional frontend lifecycle', () => {
  it('keeps durable ingress active while Workbench and Console dependencies are added, removed and restored', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'numen-github-frontend-'))
    const keyVariable = 'NUMEN_GITHUB_FRONTEND_TEST_KEY'
    const previousKey = process.env[keyVariable]
    process.env[keyVariable] = randomBytes(32).toString('base64')
    const secret = 'github-optional-frontend-secret'
    const signature = (body: string) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
    const root = new Context()
    const sockets = new Set<Socket>()
    try {
      await root.plugin(LoggingService, { console: false })
      await root.plugin(Server, { host: '127.0.0.1', port: 0 })
      root.server._http.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
      await root.plugin(DatabaseService, { path: join(directory, 'numen.db') })
      await root.plugin(CapabilityRegistry)
      await root.plugin(CredentialService, { masterKeyEnv: keyVariable })
      await root.plugin(ConnectionService)
      await root.plugin(githubPlugin)
      await root.plugin(AutomationService)
      await root.plugin(ResourceService, { path: join(directory, 'resources') })
      await root.plugin(SchedulerService, { autoDispatch: false })
      await root.plugin(TriggerService)

      const credential = root.credentials.create('GitHub signing secret', { id: 'github:webhook-secret', version: 1 }, { secret })
      const connection = root.connections.create({ name: 'GitHub authentication', adapter: { id: 'github:webhook-secret', version: 1 }, credentialId: credential.id, config: {}, enabled: true })
      await root.connections.reconcile()
      const { automation } = root.automations.create({ name: 'Independent GitHub', source: {
        triggers: [{ id: 'incoming', capability: githubWebhookTrigger, config: {}, connections: { auth: connection.id } }],
        flow: { type: 'block', id: 'flow', steps: [] },
      } })
      const revision = root.automations.publishDraft(automation.id, 1)
      root.automations.activateRevision(automation.id, revision.id)
      root.automations.setEnabled(automation.id, true)
      const endpoint = `${root.server.baseUrl}${githubWebhookPath(automation.id, 'incoming')}`
      const accepted = new Set<string>()
      const accept = async (phase: string) => {
        expect(root.triggers.automationHealth(automation.id)?.status).toBe('READY')
        const body = JSON.stringify({ phase })
        const deliveryId = randomUUID()
        const response = await fetch(endpoint, {
          method: 'POST', headers: { 'content-type': 'application/json', 'x-github-event': 'push', 'x-github-delivery': deliveryId, 'x-hub-signature-256': signature(body) },
          body,
        })
        expect(response.status).toBe(202)
        const receipt = await response.json() as { status: string; runId: string }
        expect(receipt.status).toBe('accepted')
        expect(root.scheduler.getRun(receipt.runId)).toMatchObject({
          revisionId: revision.id, status: 'QUEUED', trigger: { body: { phase }, deliveryId },
        })
        expect(accepted.has(receipt.runId)).toBe(false)
        accepted.add(receipt.runId)
      }

      expect(root.console).toBeUndefined()
      expect(root.consoleEntries).toBeUndefined()
      expect(root.workbench).toBeUndefined()
      await accept('backend-only')

      let entries = await root.plugin(ConsoleEntryRegistry)
      let consoleService = await root.plugin(ConsoleService)
      await root.plugin(SingleUserConsoleAuthService, { token: 'independent-console-token' })
      expect(root.consoleEntries.list()).toEqual([])
      await accept('console-without-workbench')

      // Use real services and local fixtures: registration must not require a
      // built Workbench app or the GitHub browser bundle during unit tests.
      const entrySource = join(directory, 'core-entry.js')
      await writeFile(entrySource, 'export default function core() {}\n')
      await writeFile(join(directory, 'index.html'), '<main>Workbench fixture</main>')
      const workbenchConfig = { root: directory, entrySource }
      let workbench = await root.plugin(WorkbenchRuntimeService, workbenchConfig)
      const expectedEntries = [
        { id: coreWorkbenchEntryId, prod: entrySource },
        { id: 'numen:github-webhook-details', prod: new URL('../src/client.js', import.meta.url).href },
      ].sort((left, right) => left.id.localeCompare(right.id))
      const assertEntries = async () => vi.waitFor(() => expect(root.consoleEntries.list()).toEqual(expectedEntries))
      await assertEntries()
      await accept('frontend-ready')

      // Hold a real request across the Workbench restart. A wrapper that also
      // restarts the backend activation would reject this old request as stale.
      let started!: () => void
      const requestStarted = new Promise<void>(resolve => { started = resolve })
      const unsubscribe = root.on('server/route-request', async (_request, _response, _route, next) => { started(); return next() })
      const pending = httpRequest(endpoint, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-github-event': 'push', 'x-github-delivery': randomUUID(), 'x-hub-signature-256': signature(JSON.stringify({ phase: 'during-workbench-restart' })) },
      })
      const pendingResponse = new Promise<IncomingMessage>((resolve, reject) => { pending.once('response', resolve); pending.once('error', reject) })
      pending.write('{"phase":')
      await requestStarted
      unsubscribe()
      await new Promise<void>(resolve => setImmediate(resolve))

      await workbench.dispose()
      await vi.waitFor(() => expect(root.workbench).toBeUndefined())
      expect(root.consoleEntries.list()).toEqual([])
      await accept('workbench-removed')
      workbench = await root.plugin(WorkbenchRuntimeService, workbenchConfig)
      await assertEntries()
      pending.end('"during-workbench-restart"}')
      const response = await pendingResponse
      expect(response.statusCode).toBe(202)
      let responseText = ''
      for await (const chunk of response) responseText += chunk.toString()
      const receipt = JSON.parse(responseText) as { status: string; runId: string }
      expect(receipt.status).toBe('accepted')
      expect(root.scheduler.getRun(receipt.runId)).toMatchObject({
        revisionId: revision.id, trigger: { body: { phase: 'during-workbench-restart' } },
      })
      accepted.add(receipt.runId)

      // Losing a transitive Workbench dependency must remove its optional Entry,
      // even though both plugin Fibers remain installed and later resume.
      await consoleService.dispose()
      await vi.waitFor(() => expect(root.workbench).toBeUndefined())
      expect(root.consoleEntries.list()).toEqual([])
      await accept('console-removed')
      consoleService = await root.plugin(ConsoleService)
      await assertEntries()
      await accept('console-restored')

      // Replace the registry too, so stale child ownership cannot leave the
      // contribution attached to the old service or register it twice.
      const oldRegistry = root.consoleEntries
      await entries.dispose()
      await vi.waitFor(() => expect(root.workbench).toBeUndefined())
      expect(oldRegistry.list()).toEqual([])
      expect(root.consoleEntries).toBeUndefined()
      await accept('entry-registry-removed')
      entries = await root.plugin(ConsoleEntryRegistry)
      await assertEntries()
      expect(root.consoleEntries).not.toBe(oldRegistry)
      await accept('entry-registry-restored')

      expect(root.scheduler.listRuns(100)).toHaveLength(accepted.size)
      expect(accepted.size).toBe(9)
      await root.scheduler.dispatchUntilIdle()
      for (const runId of accepted) expect(root.scheduler.getRun(runId)?.status).toBe('COMPLETED')
    } finally {
      for (const socket of sockets) socket.destroy()
      await root.fiber.dispose()
      await rm(directory, { recursive: true, force: true })
      if (previousKey === undefined) delete process.env[keyVariable]; else process.env[keyVariable] = previousKey
    }
  })
})
