import Server from '@cordisjs/plugin-server'
import { AutomationService } from '@numenjs/automation'
import { ConnectionService } from '@numenjs/connections'
import { CapabilityRegistry, type AutomationSource } from '@numenjs/core'
import { CredentialService } from '@numenjs/credentials'
import { DatabaseService } from '@numenjs/database'
import { LoggingService } from '@numenjs/logging'
import { ResourceService } from '@numenjs/resources'
import { SchedulerService } from '@numenjs/scheduler'
import { TriggerService } from '@numenjs/triggers'
import { Context } from 'cordis'
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import type { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, vi } from 'vitest'
import githubIntegrationPlugin, { githubWebhookPath, githubWebhookSecretAdapter, githubWebhookSecretCredential, githubWebhookTrigger } from '../src/index.js'

const directories: string[] = []
const cleanup: Array<() => Promise<void>> = []
const masterKeyEnv = 'NUMEN_GITHUB_INTEGRATION_TEST_KEY'
export const testSecret = 'private-github-test-secret'
export const signature = (body: string | Uint8Array, secret = testSecret) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(cleanup.splice(0).map(stop => stop()))
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
  delete process.env[masterKeyEnv]
})

export async function harness(directory?: string) {
  directory ??= await mkdtemp(join(tmpdir(), 'numen-github-'))
  if (!directories.includes(directory)) directories.push(directory)
  process.env[masterKeyEnv] ??= randomBytes(32).toString('base64')
  const root = new Context()
  const sockets = new Set<Socket>()
  await root.plugin(LoggingService, { console: false })
  await root.plugin(Server, { host: '127.0.0.1', port: 0 })
  root.server._http.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  await root.plugin(DatabaseService, { path: join(directory, 'numen.db') })
  await root.plugin(CapabilityRegistry)
  await root.plugin(CredentialService, { masterKeyEnv })
  await root.plugin(ConnectionService)
  const plugin = await root.plugin(githubIntegrationPlugin)
  await root.plugin(AutomationService)
  await root.plugin(ResourceService, { path: join(directory, 'resources') })
  await root.plugin(SchedulerService, { autoDispatch: false })
  await root.plugin(TriggerService)
  let stopped = false
  const stop = async () => {
    if (stopped) return
    stopped = true
    for (const socket of sockets) socket.destroy()
    await root.fiber.dispose()
  }
  cleanup.push(stop)
  const post = (path: string, body: string | Uint8Array = '{}', headers: Record<string, string> = {}) => fetch(`${root.server.baseUrl}${path}`, {
    method: 'POST', body, headers: { 'content-type': 'application/json', 'x-github-event': 'push', 'x-github-delivery': randomUUID(), 'x-hub-signature-256': signature(body), ...headers },
  })
  return { root, directory, stop, post, plugin }
}

export type Harness = Awaited<ReturnType<typeof harness>>

export async function authConnection(h: Harness, secret = testSecret) {
  const credential = h.root.credentials.create('GitHub signing secret', githubWebhookSecretCredential, { secret })
  const connection = h.root.connections.create({ name: 'GitHub authentication', adapter: githubWebhookSecretAdapter, config: {}, credentialId: credential.id, enabled: true })
  await h.root.connections.reconcile()
  expect(h.root.connections.getRuntimeState(connection.id).status).toBe('READY')
  return { credential, connection, secret }
}

export function publish(h: Harness, connectionId: string, options: { events?: string[]; actions?: string[]; triggerId?: string; source?: AutomationSource } = {}) {
  const triggerId = options.triggerId ?? 'incoming'
  const source: AutomationSource = options.source ?? {
    triggers: [{ id: triggerId, capability: githubWebhookTrigger, config: { events: options.events ?? [], actions: options.actions ?? [] }, connections: { auth: connectionId } }],
    flow: { type: 'block', id: 'flow', steps: [] },
  }
  const { automation } = h.root.automations.create({ name: 'GitHub receiver', source })
  const revision = h.root.automations.publishDraft(automation.id, 1)
  h.root.automations.activateRevision(automation.id, revision.id)
  h.root.automations.setEnabled(automation.id, true)
  return { automationId: automation.id, revisionId: revision.id, path: githubWebhookPath(automation.id, triggerId) }
}

export async function unfinishedRequest(h: Harness, path: string, headers: Record<string, string> = {}) {
  let started!: () => void
  const startedPromise = new Promise<void>(resolve => { started = resolve })
  const dispose = h.root.on('server/route-request', async (_request, _response, _route, next) => { started(); return next() })
  const request = httpRequest(`${h.root.server.baseUrl}${path}`, { method: 'POST', headers: {
    'content-type': 'application/json', 'x-github-event': 'push', 'x-github-delivery': randomUUID(), 'x-hub-signature-256': signature('{"pending":true}'), ...headers,
  } })
  const response = new Promise<IncomingMessage>((resolve, reject) => { request.once('response', resolve); request.once('error', reject) })
  request.write('{"pending":')
  await startedPromise
  dispose()
  await new Promise<void>(resolve => setImmediate(resolve))
  return { request, response }
}

export async function responseText(response: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of response) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}
