import Server from '@cordisjs/plugin-server'
import { AutomationService } from '@numenjs/automation'
import { ConnectionService } from '@numenjs/connections'
import { CapabilityRegistry, defineCapability, type AutomationSource } from '@numenjs/core'
import { CredentialService } from '@numenjs/credentials'
import { DatabaseService } from '@numenjs/database'
import { LoggingService } from '@numenjs/logging'
import { ResourceService } from '@numenjs/resources'
import { SchedulerService } from '@numenjs/scheduler'
import { TriggerService } from '@numenjs/triggers'
import { Context } from 'cordis'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import type { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import z from 'schemastery'
import { afterEach, describe, expect, it, vi } from 'vitest'
import webhookIntegrationPlugin, {
  webhookHeaderTokenAdapter,
  webhookHeaderTokenCredential,
  webhookPath,
  webhookReceiveTrigger,
} from '../src/index.js'

const directories: string[] = []
const cleanup: Array<() => Promise<void>> = []
const masterKeyEnv = 'NUMEN_WEBHOOK_TEST_KEY'

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(cleanup.splice(0).map(stop => stop()))
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
  delete process.env[masterKeyEnv]
})

async function harness(directory?: string) {
  directory ??= await mkdtemp(join(tmpdir(), 'numen-webhook-'))
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
  const plugin = await root.plugin(webhookIntegrationPlugin)
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
    method: 'POST', body, headers: { 'content-type': 'application/json', ...headers },
  })
  return { root, directory, stop, post, plugin }
}

type Harness = Awaited<ReturnType<typeof harness>>

function publish(h: Harness, options: { authentication?: 'token' | 'none'; auth?: string; triggerId?: string; source?: AutomationSource } = {}) {
  const triggerId = options.triggerId ?? 'incoming'
  const source: AutomationSource = options.source ?? {
    triggers: [{ id: triggerId, capability: webhookReceiveTrigger,
      config: options.authentication === undefined ? {} : { authentication: options.authentication },
      ...(options.auth ? { connections: { auth: options.auth } } : {}) }],
    flow: { type: 'block', id: 'flow', steps: [] },
  }
  const { automation } = h.root.automations.create({ name: 'Webhook receiver', source })
  const revision = h.root.automations.publishDraft(automation.id, 1)
  h.root.automations.activateRevision(automation.id, revision.id)
  h.root.automations.setEnabled(automation.id, true)
  return { automationId: automation.id, revisionId: revision.id, path: webhookPath(automation.id, triggerId) }
}

async function tokenConnection(h: Harness, token = 'webhook-test-token') {
  const credential = h.root.credentials.create('Webhook authentication', webhookHeaderTokenCredential, { token })
  const connection = h.root.connections.create({ name: 'Webhook token', adapter: webhookHeaderTokenAdapter, config: {}, credentialId: credential.id, enabled: true })
  await h.root.connections.reconcile()
  expect(h.root.connections.getRuntimeState(connection.id).status).toBe('READY')
  return { credential, connection, token }
}

async function unfinishedRequest(h: Harness, path: string, headers: Record<string, string> = {}) {
  let started!: () => void
  const startedPromise = new Promise<void>(resolve => { started = resolve })
  const dispose = h.root.on('server/route-request', async (_request, _response, _route, next) => { started(); return next() })
  const request = httpRequest(`${h.root.server.baseUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers } })
  const response = new Promise<IncomingMessage>((resolve, reject) => { request.once('response', resolve); request.once('error', reject) })
  request.write('{"pending":')
  await startedPromise
  dispose()
  // Let the real stream deliver its first chunk and leave the handler waiting.
  await new Promise<void>(resolve => setImmediate(resolve))
  return { request, response }
}

async function responseText(response: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of response) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

describe('Webhook Integration', () => {
  it('accepts and executes authenticated JSON without exposing transport secrets or metadata', async () => {
    const h = await harness()
    const auth = await tokenConnection(h, 'private-hook-token')
    const echo = defineCapability({ id: 'test:echo-json', version: 1, kind: 'query', title: 'Echo JSON',
      input: z.object({ value: z.any().required() }), output: z.any(), semantics: { sideEffect: false, idempotent: true, retrySafe: true } })
    h.root.capabilities.define(h.root, echo)
    h.root.capabilities.provide(h.root, echo, { async invoke({ input }) { return input.value } })
    const endpoint = publish(h, { source: {
      triggers: [{ id: 'incoming', capability: webhookReceiveTrigger, config: {}, connections: { auth: auth.connection.id } }],
      flow: { type: 'capability', id: 'echo', capability: echo, input: { value: { type: 'ref', path: 'trigger.body' } } },
    } })
    const response = await h.post(`${endpoint.path}?secret=private-query`, '{"value":[1,true,null]}', {
      authorization: `Bearer ${auth.token}`, cookie: 'private-cookie', 'x-private-header': 'private-header', 'idempotency-key': 'event-1',
    })
    expect(response.status).toBe(202)
    const receipt = await response.json() as { status: string; runId: string }
    const accepted = h.root.scheduler.getRun(receipt.runId)!
    expect(receipt.status).toBe('accepted')
    expect(accepted.status).toBe('QUEUED')
    expect(accepted.trigger).toEqual({ body: { value: [1, true, null] }, receivedAt: expect.any(String), eventId: 'event-1' })
    await h.root.scheduler.dispatchUntilIdle()
    expect(h.root.scheduler.getRun(receipt.runId)?.status).toBe('COMPLETED')
    expect(h.root.scheduler.listExecutions(receipt.runId).find(item => item.instructionId === 'echo')?.output).toEqual({ value: [1, true, null] })
    const persisted = JSON.stringify({ runs: h.root.scheduler.listRuns(), events: h.root.scheduler.listEvents(receipt.runId), logs: h.root.logs.query({}).records,
      connections: h.root.connections.list(), credentials: h.root.credentials.list() })
    for (const secret of ['private-hook-token', 'private-query', 'private-cookie', 'private-header']) expect(persisted).not.toContain(secret)
  })

  it('defaults to token authentication, rejects wrong tokens, and only enables anonymous mode explicitly', async () => {
    const h = await harness()
    const missing = publish(h)
    expect(h.root.triggers.automationHealth(missing.automationId)?.status).toBe('WAITING')
    expect((await h.post(missing.path)).status).toBe(404)
    const auth = await tokenConnection(h)
    const endpoint = publish(h, { auth: auth.connection.id })
    for (const authorization of ['', 'Bearer wrong', `Basic ${auth.token}`]) {
      const response = await h.post(endpoint.path, '{"not":"read"}', { authorization })
      expect(response.status).toBe(401)
      expect(await response.text()).not.toContain(authorization || 'not')
    }
    const anonymous = publish(h, { authentication: 'none' })
    expect((await h.post(anonymous.path)).status).toBe(202)
    expect(h.root.scheduler.listRuns()).toHaveLength(1)
  })

  it('deduplicates concurrent events durably across restart and treats requests without a key independently', async () => {
    let h = await harness()
    const endpoint = publish(h, { authentication: 'none' })
    const responses = await Promise.all(Array.from({ length: 10 }, () => h.post(endpoint.path, '{"event":1}', { 'idempotency-key': 'same-key' })))
    expect(responses.filter(item => item.status === 202)).toHaveLength(1)
    expect(responses.filter(item => item.status === 200)).toHaveLength(9)
    const receipts = await Promise.all(responses.map(item => item.json())) as Array<{ runId: string }>
    expect(new Set(receipts.map(item => item.runId)).size).toBe(1)
    expect(h.root.scheduler.listRuns()).toHaveLength(1)
    await h.stop()
    h = await harness(h.directory)
    const duplicate = await h.post(endpoint.path, '{"event":"different ignored payload"}', { 'idempotency-key': 'same-key' })
    expect(duplicate.status).toBe(200)
    expect(await duplicate.json()).toEqual({ status: 'duplicate', runId: receipts[0]!.runId })
    await h.post(endpoint.path)
    await h.post(endpoint.path)
    expect(h.root.scheduler.listRuns()).toHaveLength(3)
  })

  it('keeps one route, fences in-flight disable and revision changes, and restores the same endpoint', async () => {
    const h = await harness()
    const endpoint = publish(h, { authentication: 'none' })
    const second = publish(h, { authentication: 'none' })
    expect([...h.root.server.httpRoutes]).toHaveLength(1)
    const pending = await unfinishedRequest(h, endpoint.path)
    h.root.automations.setEnabled(endpoint.automationId, false)
    const disabled = await pending.response
    expect(disabled.statusCode).toBe(503)
    await responseText(disabled)
    pending.request.destroy()
    expect((await h.post(endpoint.path)).status).toBe(404)
    expect((await h.post(second.path)).status).toBe(202)
    h.root.automations.setEnabled(endpoint.automationId, true)
    const old = await unfinishedRequest(h, endpoint.path)
    const draft = h.root.automations.getDraft(endpoint.automationId)!
    const saved = h.root.automations.saveDraft({ automationId: endpoint.automationId, expectedVersion: draft.version,
      source: { ...draft.source, flow: { type: 'block', id: 'new-flow', steps: [] } } })
    const revision = h.root.automations.publishDraft(endpoint.automationId, saved.version)
    h.root.automations.activateRevision(endpoint.automationId, revision.id)
    const stale = await old.response
    expect(stale.statusCode).toBe(503)
    await responseText(stale)
    old.request.destroy()
    const accepted = await h.post(endpoint.path)
    expect(accepted.status).toBe(202)
    const { runId } = await accepted.json() as { runId: string }
    expect(h.root.scheduler.getRun(runId)?.revisionId).toBe(revision.id)
    expect([...h.root.server.httpRoutes]).toHaveLength(1)
    expect(h.root.scheduler.listRuns()).toHaveLength(2)
  })

  it('rotates credentials, fences an authenticated in-flight request, and rejects the old token', async () => {
    const h = await harness()
    const auth = await tokenConnection(h, 'first-secret-token')
    const endpoint = publish(h, { auth: auth.connection.id })
    const pending = await unfinishedRequest(h, endpoint.path, { authorization: `Bearer ${auth.token}` })
    h.root.credentials.rotate(auth.credential.id, 1, { token: 'second-secret-token' })
    await h.root.connections.reconcile()
    const response = await pending.response
    expect(response.statusCode).toBe(503)
    await responseText(response)
    pending.request.destroy()
    expect((await h.post(endpoint.path, '{}', { authorization: `Bearer ${auth.token}` })).status).toBe(401)
    expect((await h.post(endpoint.path, '{}', { authorization: 'Bearer second-secret-token' })).status).toBe(202)
    expect(h.root.scheduler.listRuns()).toHaveLength(1)
  })

  it('rejects unsupported or malformed bodies and reserved JSON before creating any Run', async () => {
    const h = await harness()
    const endpoint = publish(h, { authentication: 'none' })
    const cases: Array<[string | Uint8Array, Record<string, string>, number]> = [
      ['', {}, 400], ['{"secret":"private-parser-body",', {}, 400], [new Uint8Array([0xc3, 0x28]), {}, 400],
      ['{}', { 'content-type': 'text/plain' }, 415], ['{}', { 'content-encoding': 'gzip' }, 415],
      ['{"deep":[{"$resource":"res_private"}]}', {}, 400], ['{"$resource":"res_private","extra":1}', {}, 400],
      ['['.repeat(65) + '0' + ']'.repeat(65), {}, 400], [JSON.stringify(Array(10_001).fill(0)), {}, 400],
      ['{}', { 'idempotency-key': 'x'.repeat(129) }, 400], ['{}', { 'idempotency-key': '   ' }, 400],
    ]
    for (const [body, headers, status] of cases) {
      const response = await h.post(endpoint.path, body, headers)
      expect(response.status).toBe(status)
      const text = await response.text()
      expect(text).not.toContain('private-parser-body')
      expect(text).not.toContain('res_private')
    }
    expect(h.root.scheduler.listRuns()).toEqual([])
    expect((await h.post(endpoint.path, 'null')).status).toBe(202)
    expect((await fetch(`${h.root.server.baseUrl}${endpoint.path}`)).status).toBe(405)
  })

  it('rejects a declared oversized upload before reading it and never acquires ownership of external resource references', async () => {
    const h = await harness()
    const endpoint = publish(h, { authentication: 'none' })
    // A sender still uploading after an early rejection may observe EPIPE. Use
    // headers-only HTTP here to verify the actual early 413 response separately.
    const request = httpRequest(`${h.root.server.baseUrl}${endpoint.path}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'content-length': String(1024 * 1024 + 1) },
    })
    const received = new Promise<IncomingMessage>((resolve, reject) => { request.once('response', resolve); request.once('error', reject) })
    request.flushHeaders()
    const response = await received
    expect(response.statusCode).toBe(413)
    await responseText(response)
    request.destroy()
    const resource = await h.root.resources.stage({ name: 'Internal resource', mediaType: 'text/plain', content: Buffer.from('private stored bytes') })
    expect((await h.post(endpoint.path, JSON.stringify({ nested: [resource.ref] }))).status).toBe(400)
    expect(h.root.resources.listOwners(resource.id)).toEqual([])
    expect(h.root.resources.get(resource.id)?.state).toBe('STAGED')
    expect(h.root.scheduler.listRuns()).toHaveLength(0)
  })

  it('bounds chunked requests and survives client disconnects without partially accepting data', async () => {
    const h = await harness()
    const endpoint = publish(h, { authentication: 'none' })
    const oversized = await unfinishedRequest(h, endpoint.path)
    oversized.request.write('"' + 'x'.repeat(1024 * 1024 + 100))
    const response = await oversized.response
    expect(response.statusCode).toBe(413)
    await responseText(response)
    oversized.request.destroy()
    const disconnected = await unfinishedRequest(h, endpoint.path)
    // This promise intentionally rejects when the sender disconnects.
    const rejected = expect(disconnected.response).rejects.toThrow()
    disconnected.request.destroy(new Error('sender disconnected'))
    await rejected
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(h.root.scheduler.listRuns()).toHaveLength(0)
    expect((await h.post(endpoint.path)).status).toBe(202)
  })

  it('returns a real HTTP timeout for a stalled sender and releases the connection', async () => {
    const h = await harness()
    const endpoint = publish(h, { authentication: 'none' })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const pending = await unfinishedRequest(h, endpoint.path)
    await vi.advanceTimersByTimeAsync(30_000)
    const response = await pending.response
    expect(response.statusCode).toBe(408)
    expect(await responseText(response)).toContain('WEBHOOK_BODY_TIMEOUT')
    pending.request.destroy()
    expect(vi.getTimerCount()).toBe(0)
    vi.useRealTimers()
    expect(h.root.scheduler.listRuns()).toHaveLength(0)
    expect((await h.post(endpoint.path)).status).toBe(202)
  })

  it('rejects ambiguous duplicate authentication and event ID headers', async () => {
    const h = await harness()
    const auth = await tokenConnection(h)
    const endpoint = publish(h, { auth: auth.connection.id })
    for (const [headers, status] of [
      [{ authorization: [`Bearer ${auth.token}`, 'Bearer other'] }, 401],
      [{ authorization: `Bearer ${auth.token}`, 'idempotency-key': ['first', 'second'] }, 400],
    ] as const) {
      const request = httpRequest(`${h.root.server.baseUrl}${endpoint.path}`, { method: 'POST',
        headers: { 'content-type': 'application/json', ...headers } })
      const received = new Promise<IncomingMessage>((resolve, reject) => { request.once('response', resolve); request.once('error', reject) })
      request.end('{}')
      const response = await received
      expect(response.statusCode).toBe(status)
      await responseText(response)
    }
    expect(h.root.scheduler.listRuns()).toHaveLength(0)
  })

  it('does not ACK or partially persist when durable acceptance fails', async () => {
    const h = await harness()
    const endpoint = publish(h, { authentication: 'none' })
    h.root.database.db.exec("CREATE TRIGGER reject_webhook BEFORE INSERT ON trigger_events BEGIN SELECT RAISE(ABORT, 'private-storage-error'); END;")
    const response = await h.post(endpoint.path, '{}', { 'idempotency-key': 'retry-after-storage-failure' })
    expect(response.status).toBe(503)
    expect(await response.text()).not.toContain('private-storage-error')
    expect(h.root.scheduler.listRuns()).toHaveLength(0)
    h.root.database.db.exec('DROP TRIGGER reject_webhook')
    expect((await h.post(endpoint.path, '{}', { 'idempotency-key': 'retry-after-storage-failure' })).status).toBe(202)
    expect(h.root.scheduler.listRuns()).toHaveLength(1)
  })

  it('recovers a committed receipt when the connection disappears before the ACK reaches the sender', async () => {
    const h = await harness()
    const endpoint = publish(h, { authentication: 'none' })
    let socket: Socket | undefined
    const capture = h.root.on('server/route-request', async (request, _response, _route, next) => {
      socket = request._req.socket
      return next()
    })
    const loseReceipt = h.root.on('numen/run-change', () => socket?.destroy())
    await expect(h.post(endpoint.path, '{}', { 'idempotency-key': 'lost-receipt' })).rejects.toThrow()
    loseReceipt()
    capture()
    expect(h.root.scheduler.listRuns()).toHaveLength(1)
    const response = await h.post(endpoint.path, '{}', { 'idempotency-key': 'lost-receipt' })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'duplicate', runId: h.root.scheduler.listRuns()[0]!.id })
  })

  it('does not let a stale activation disposer erase its replacement', async () => {
    const h = await harness()
    const provider = h.root.capabilities.resolveTriggerProvider(webhookReceiveTrigger)!
    const first = new AbortController()
    const second = new AbortController()
    const binding = { automationId: 'auto_identity', triggerId: 'trigger', revisionId: 'rev_identity', activationGeneration: 1,
      capability: webhookReceiveTrigger, config: { authentication: 'none' }, connectionIds: {} }
    const firstEmit = vi.fn(async () => ({ status: 'accepted' as const, runId: 'old-run' }))
    const secondEmit = vi.fn(async () => ({ status: 'accepted' as const, runId: 'new-run' }))
    const disposeFirst = provider.activate({ binding, connections: {}, signal: first.signal, emit: firstEmit })!
    first.abort()
    const disposeSecond = provider.activate({ binding: { ...binding, activationGeneration: 2 }, connections: {}, signal: second.signal, emit: secondEmit })!
    disposeFirst()
    const response = await h.post(webhookPath(binding.automationId, binding.triggerId))
    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({ status: 'accepted', runId: 'new-run' })
    expect(firstEmit).not.toHaveBeenCalled()
    expect(secondEmit).toHaveBeenCalledOnce()
    second.abort()
    disposeSecond()
  })

  it('removes its route on unload and rejects duplicate plugin registration before installing another route', async () => {
    const h = await harness()
    const endpoint = publish(h, { authentication: 'none' })
    expect(() => webhookIntegrationPlugin(h.root)).toThrow('already defined')
    expect([...h.root.server.httpRoutes]).toHaveLength(1)
    const pending = await unfinishedRequest(h, endpoint.path)
    await h.plugin.dispose()
    const response = await pending.response
    expect(response.statusCode).toBe(503)
    await responseText(response)
    pending.request.destroy()
    expect([...h.root.server.httpRoutes]).toHaveLength(0)
    expect((await h.post(endpoint.path)).status).toBe(404)
    await h.root.plugin(webhookIntegrationPlugin)
    expect([...h.root.server.httpRoutes]).toHaveLength(1)
    expect((await h.post(endpoint.path)).status).toBe(202)
  })
})
