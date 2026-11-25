import { AutomationService } from '@numenjs/automation'
import { CapabilityRegistry, type AutomationSource } from '@numenjs/core'
import { ConnectionService } from '@numenjs/connections'
import { CredentialService } from '@numenjs/credentials'
import { DatabaseService } from '@numenjs/database'
import { LoggingService } from '@numenjs/logging'
import { ResourceService } from '@numenjs/resources'
import { SchedulerService } from '@numenjs/scheduler'
import { Context } from 'cordis'
import { createHmac, randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OutboundHttpService } from '../../http/src/index.js'
import feishuPlugin, { feishuLimits, feishuSendTextCapability, feishuWebhookAdapter, feishuWebhookCredential, type FeishuBotRuntime } from '../src/index.js'
import { createFeishuRuntime, validateFeishuCredential } from '../src/runtime.js'

const webhookUrl = 'https://open.feishu.cn/open-apis/bot/v2/hook/private-fixture-token'
const secret = 'private-fixture-signing-secret'
const keyEnv = 'NUMEN_FEISHU_INTEGRATION_TEST_KEY'
const cleanup: Array<() => Promise<void>> = []
const directories: string[] = []

type Received = { path: string; method?: string; contentType?: string; raw: Buffer; body: Record<string, any> }
type Mode = 'ok' | '429' | 'rate-limit' | 'rejected' | 'invalid' | 'invalid-code' | 'invalid-utf8' | 'large-length' | 'large-stream' | 'redirect' | 'disconnect' | 'hold'

async function fixture() {
  const requests: Received[] = []
  const sockets = new Set<Socket>()
  const held: ServerResponse[] = []
  let mode: Mode = 'ok'
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const raw = Buffer.concat(chunks)
    const body = JSON.parse(raw.toString('utf8'))
    requests.push({ path: request.url!, method: request.method, contentType: request.headers['content-type'], raw, body })
    response.setHeader('content-type', 'application/json')
    if (mode === 'disconnect') { response.destroy(); return }
    if (mode === 'hold' || body.content?.text === 'hold') {
      response.write('{"code":')
      held.push(response)
      return
    }
    if (mode === 'redirect') { response.writeHead(302, { location: '/redirect-target' }); response.end(); return }
    if (mode === '429') { response.statusCode = 429; response.end(JSON.stringify({ code: 11232, msg: secret })); return }
    if (mode === 'large-length') { response.setHeader('content-length', String(feishuLimits.maxResponseBytes + 1)); response.end(' '); return }
    if (mode === 'large-stream') { response.write(' '.repeat(40_000)); response.end(' '.repeat(40_000)); return }
    if (mode === 'invalid') { response.end(`private-response-body-${secret}`); return }
    if (mode === 'invalid-utf8') { response.end(Buffer.from([0xc3, 0x28])); return }
    if (mode === 'invalid-code') { response.end('{"code":"0"}'); return }
    response.end(JSON.stringify({ code: mode === 'rate-limit' ? 11232 : mode === 'rejected' ? 19024 : 0, msg: `${webhookUrl} ${secret}` }))
  })
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('expected TCP fixture')
  const origin = `http://127.0.0.1:${address.port}`
  cleanup.push(async () => {
    for (const response of held) response.destroy()
    for (const socket of sockets) socket.destroy()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })
  return { requests, origin, setMode(next: Mode) { mode = next } }
}

async function harness(server: Awaited<ReturnType<typeof fixture>>, options: { directory?: string; timeoutMs?: number } = {}) {
  const directory = options.directory ?? await mkdtemp(join(tmpdir(), 'numen-feishu-'))
  if (!directories.includes(directory)) directories.push(directory)
  process.env[keyEnv] ??= randomBytes(32).toString('base64')
  const root = new Context()
  await root.plugin(LoggingService, { console: false, levels: { base: 3 } })
  await root.plugin(DatabaseService, { path: join(directory, 'numen.db') })
  await root.plugin(CapabilityRegistry)
  await root.plugin(CredentialService, { masterKeyEnv: keyEnv })
  await root.plugin(ConnectionService)
  await root.plugin(OutboundHttpService, { proxyAgentEnv: '', noProxyEnv: '' })
  const originalUrls: string[] = []
  root.on('http/fetch', async (url, _init, _config, next) => {
    // Only this test hook changes transport; actual runtime validation, encoding,
    // fetch, streaming response and cancellation remain the production path.
    expect(url.origin).toBe('https://open.feishu.cn')
    originalUrls.push(url.href)
    const original = url.href
    url.href = server.origin + url.pathname
    try { return await next() } finally { url.href = original }
  })
  const plugin = await root.plugin(feishuPlugin, { timeoutMs: options.timeoutMs ?? 1_000 })
  await root.plugin(AutomationService)
  await root.plugin(ResourceService, { path: join(directory, 'resources') })
  await root.plugin(SchedulerService, { autoDispatch: false })
  let stopped = false
  const stop = async () => { if (!stopped) { stopped = true; await root.fiber.dispose() } }
  cleanup.unshift(stop)
  return { root, directory, originalUrls, plugin, stop }
}

type Harness = Awaited<ReturnType<typeof harness>>
async function connect(h: Harness, options: { unsigned?: boolean; enabled?: boolean } = {}) {
  const credential = h.root.credentials.create('Bot credential', feishuWebhookCredential, { webhookUrl, ...(options.unsigned ? {} : { secret }) })
  const connection = h.root.connections.create({ name: 'Bot', adapter: feishuWebhookAdapter, credentialId: credential.id, config: {}, enabled: options.enabled ?? true })
  await h.root.connections.reconcile()
  const runtime = () => h.root.connections.resolveRuntimes({ bot: connection.id }, feishuSendTextCapability.connections!).bot as FeishuBotRuntime
  return { credential, connection, runtime }
}
const send = (runtime: FeishuBotRuntime, text = '你好，世界 🌍', signal = new AbortController().signal) => runtime.sendText({ text }, signal)
function publish(h: Harness, connectionId: string, text: string, retry = false) {
  const source: AutomationSource = { triggers: [], flow: {
    type: 'capability', id: 'send', capability: feishuSendTextCapability, connections: { bot: connectionId },
    input: { text: { type: 'literal', value: text } },
    ...(retry ? { policy: { retry: { maxAttempts: 3, backoffMs: 0 } } } : {}),
  } }
  const { automation } = h.root.automations.create({ name: 'Bot notice', source })
  const revision = h.root.automations.publishDraft(automation.id, 1)
  h.root.automations.activateRevision(automation.id, revision.id)
  return h.root.scheduler.startManual(automation.id)
}
async function settlesSoon<T>(promise: Promise<T>): Promise<T | 'did not settle'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([promise, new Promise<'did not settle'>(resolve => { timer = setTimeout(() => resolve('did not settle'), 600) })]) }
  finally { if (timer) clearTimeout(timer) }
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(stop => stop()))
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
  delete process.env[keyEnv]
})

describe('Feishu custom bot through real local HTTP and Connection/Scheduler services', () => {
  it('encrypts URL and secret, signs exact Unicode JSON, and redacts debug transport logs', async () => {
    const server = await fixture()
    const h = await harness(server)
    const auth = await connect(h)
    expect(h.root.connections.getRuntimeState(auth.connection.id).status).toBe('READY')
    expect(server.requests).toHaveLength(0)
    const row = h.root.database.db.prepare('SELECT ciphertext FROM credentials WHERE id = ?').get(auth.credential.id) as { ciphertext: Buffer }
    expect(row.ciphertext.includes(Buffer.from(webhookUrl))).toBe(false)
    expect(row.ciphertext.includes(Buffer.from(secret))).toBe(false)
    await expect(send(auth.runtime())).resolves.toEqual({ accepted: true })
    const request = server.requests[0]!
    expect(request).toMatchObject({ method: 'POST', path: '/open-apis/bot/v2/hook/private-fixture-token' })
    expect(request.contentType).toBe('application/json; charset=utf-8')
    expect(request.body).toMatchObject({ msg_type: 'text', content: { text: '你好，世界 🌍' } })
    expect(request.body.sign).toBe(createHmac('sha256', `${request.body.timestamp}\n${secret}`).update('').digest('base64'))
    expect(Number(request.body.timestamp)).toBeGreaterThanOrEqual(Math.floor(Date.now() / 1000) - 2)
    expect(h.originalUrls).toEqual([webhookUrl])
    const logs = h.root.logs.query({ maxLevel: 3, limit: 200 }).records
    expect(logs.some(record => record.namespace.startsWith('http:'))).toBe(true)
    const visible = JSON.stringify({ logs, connections: h.root.connections.list(), credentials: h.root.credentials.list() })
    for (const privateValue of [webhookUrl, 'private-fixture-token', secret]) expect(visible).not.toContain(privateValue)
  })

  it('counts UTF-8 and JSON escaping at the complete 20 KiB boundary, with unsigned requests supported', async () => {
    const server = await fixture()
    const h = await harness(server)
    const auth = await connect(h, { unsigned: true })
    const overhead = Buffer.byteLength(JSON.stringify({ msg_type: 'text', content: { text: '' } }))
    const limitText = 'a'.repeat(feishuLimits.maxRequestBytes - overhead)
    await expect(send(auth.runtime(), limitText)).resolves.toEqual({ accepted: true })
    expect(server.requests[0]!.raw.byteLength).toBe(feishuLimits.maxRequestBytes)
    expect(server.requests[0]!.body).not.toHaveProperty('sign')
    expect(server.requests[0]!.body).not.toHaveProperty('timestamp')
    for (const text of [limitText + 'a', '界'.repeat(7000), '\\'.repeat(11_000)]) {
      await expect(send(auth.runtime(), text)).rejects.toMatchObject({ code: 'FEISHU_REQUEST_TOO_LARGE' })
    }
    for (const text of ['', ' \n\t ']) await expect(send(auth.runtime(), text)).rejects.toMatchObject({ code: 'FEISHU_TEXT_INVALID' })
    expect(server.requests).toHaveLength(1)
  })

  it('rejects untrusted URLs and pre-cancelled work before any network request', async () => {
    const server = await fixture()
    const h = await harness(server)
    for (const url of [webhookUrl.replace('https:', 'http:'), webhookUrl.replace('open.feishu.cn', 'evil.test'), webhookUrl + '?token=x', webhookUrl + '#secret', webhookUrl.replace('open.feishu.cn', 'open.feishu.cn:443'), webhookUrl.replace('private-fixture-token', '%2e%2e'), 'https://open.feishu.cn@evil.test/open-apis/bot/v2/hook/token']) {
      expect(() => validateFeishuCredential({ webhookUrl: url })).toThrow('[FEISHU_CREDENTIAL_INVALID]')
      expect(() => h.root.credentials.create('Invalid', feishuWebhookCredential, { webhookUrl: url })).toThrow()
    }
    expect(() => createFeishuRuntime(h.root, { webhookUrl }, AbortSignal.abort(), 100)).toThrow('[FEISHU_UNAVAILABLE]')
    const auth = await connect(h)
    await expect(send(auth.runtime(), 'ignored', AbortSignal.abort(new Error(secret)))).rejects.toMatchObject({ code: 'FEISHU_CANCELLED' })
    expect(h.originalUrls).toHaveLength(0)
    expect(server.requests).toHaveLength(0)
  })

  it.each([
    ['429', 'FEISHU_RATE_LIMITED'], ['rate-limit', 'FEISHU_RATE_LIMITED'], ['rejected', 'FEISHU_REJECTED'],
    ['invalid', 'FEISHU_RESPONSE_INVALID'], ['invalid-code', 'FEISHU_RESPONSE_INVALID'], ['invalid-utf8', 'FEISHU_RESPONSE_INVALID'],
    ['large-length', 'FEISHU_RESPONSE_TOO_LARGE'], ['large-stream', 'FEISHU_RESPONSE_TOO_LARGE'],
    ['redirect', 'FEISHU_HTTP_ERROR'], ['disconnect', 'FEISHU_NETWORK_ERROR'],
  ] as const)('handles %s with a safe error and a single HTTP attempt', async (mode, code) => {
    const server = await fixture()
    server.setMode(mode)
    const h = await harness(server)
    const auth = await connect(h)
    const error = await send(auth.runtime()).catch(error => error)
    expect(error).toMatchObject({ name: 'FeishuError', code })
    expect(error).not.toHaveProperty('cause')
    const serialized = `${String(error)} ${JSON.stringify(error)} ${JSON.stringify(h.root.logs.query().records)}`
    for (const value of [webhookUrl, 'private-fixture-token', secret, 'private-response-body']) expect(serialized).not.toContain(value)
    expect(server.requests).toHaveLength(1)
    expect(h.originalUrls).toHaveLength(1)
  })

  it('enforces an overall timeout after response headers without resubmitting an uncertain send', async () => {
    const server = await fixture()
    server.setMode('hold')
    const h = await harness(server, { timeoutMs: 80 })
    const auth = await connect(h)
    const outcome = await settlesSoon(send(auth.runtime()).catch(error => error))
    expect(outcome).toMatchObject({ code: 'FEISHU_TIMEOUT' })
    expect(server.requests).toHaveLength(1)
  })

  it('cancels one streaming response without interrupting a simultaneous send on the same Connection', async () => {
    const server = await fixture()
    const h = await harness(server)
    const auth = await connect(h)
    const controller = new AbortController()
    const held = send(auth.runtime(), 'hold', controller.signal).catch(error => error)
    await expect.poll(() => server.requests.length).toBe(1)
    const completed = send(auth.runtime(), 'continue')
    controller.abort(new Error(secret))
    const error = await settlesSoon(held)
    expect(error).toMatchObject({ code: 'FEISHU_CANCELLED' })
    expect(String(error)).not.toContain(secret)
    await expect(completed).resolves.toEqual({ accepted: true })
    expect(server.requests).toHaveLength(2)
  })

  it('rotation and unload cancel active responses, fence old runtimes, and keep unrelated HTTP usable', async () => {
    const server = await fixture()
    const h = await harness(server)
    const auth = await connect(h)
    const old = auth.runtime()
    const held = send(old, 'hold').catch(error => error)
    await expect.poll(() => server.requests.length).toBe(1)
    const rotatedUrl = webhookUrl.replace('private-fixture-token', 'rotated-fixture-token')
    const rotatedSecret = 'rotated-signing-secret'
    h.root.credentials.rotate(auth.credential.id, 1, { webhookUrl: rotatedUrl, secret: rotatedSecret })
    await h.root.connections.reconcile()
    expect(await settlesSoon(held)).toMatchObject({ code: 'FEISHU_UNAVAILABLE' })
    await expect(send(old)).rejects.toMatchObject({ code: 'FEISHU_UNAVAILABLE' })
    const current = auth.runtime()
    await expect(send(current)).resolves.toEqual({ accepted: true })
    expect(h.originalUrls.at(-1)).toBe(rotatedUrl)
    const body = server.requests.at(-1)!.body
    expect(body.sign).toBe(createHmac('sha256', `${body.timestamp}\n${rotatedSecret}`).update('').digest('base64'))
    const unloading = send(current, 'hold').catch(error => error)
    await expect.poll(() => server.requests.length).toBe(3)
    await h.plugin.dispose()
    expect(await settlesSoon(unloading)).toMatchObject({ code: 'FEISHU_UNAVAILABLE' })
    await expect(send(current)).rejects.toMatchObject({ code: 'FEISHU_UNAVAILABLE' })
    const unrelated = await h.root.http(webhookUrl, { method: 'POST', data: JSON.stringify({ msg_type: 'text', content: { text: 'unrelated' } }) })
    expect(unrelated.ok).toBe(true)
    await unrelated.body?.cancel()
    expect(server.requests).toHaveLength(4)
  })

  it('persists completed output through Scheduler, blocks on a disabled Connection, and never resends after restart', async () => {
    const server = await fixture()
    let h = await harness(server)
    const auth = await connect(h, { enabled: false })
    const run = publish(h, auth.connection.id, 'scheduled notice')
    await h.root.scheduler.dispatchUntilIdle()
    expect(h.root.scheduler.listExecutions(run.id)[0]).toMatchObject({ status: 'BLOCKED', blockedReason: 'CONNECTION_UNAVAILABLE' })
    expect(h.root.scheduler.listAttempts(run.id)).toHaveLength(0)
    h.root.connections.setEnabled(auth.connection.id, auth.connection.generation, true)
    await h.root.connections.reconcile()
    await expect.poll(async () => { await h.root.scheduler.dispatchUntilIdle(); return h.root.scheduler.getRun(run.id)?.status }).toBe('COMPLETED')
    expect(h.root.scheduler.listExecutions(run.id)[0]!.output).toEqual({ accepted: true })
    expect(h.root.scheduler.listAttempts(run.id)).toHaveLength(1)
    expect(server.requests).toHaveLength(1)
    const directory = h.directory
    await h.stop()
    h = await harness(server, { directory })
    await h.root.connections.reconcile()
    await h.root.scheduler.dispatchUntilIdle()
    expect(h.root.scheduler.getRun(run.id)?.status).toBe('COMPLETED')
    expect(h.root.scheduler.listExecutions(run.id)[0]!.output).toEqual({ accepted: true })
    expect(server.requests).toHaveLength(1)
  })

  it('persists one failed uncertain attempt across restart and refuses automatic retry policies', async () => {
    const server = await fixture()
    server.setMode('disconnect')
    let h = await harness(server)
    const auth = await connect(h)
    const run = publish(h, auth.connection.id, 'uncertain notice')
    await h.root.scheduler.dispatchUntilIdle()
    expect(h.root.scheduler.getRun(run.id)?.status).toBe('FAILED')
    const attempts = h.root.scheduler.listAttempts(run.id)
    expect(attempts).toHaveLength(1)
    expect(attempts[0]!.error).toMatchObject({ name: 'FeishuError', message: expect.stringContaining('FEISHU_NETWORK_ERROR') })
    expect(feishuSendTextCapability.semantics).toEqual({ sideEffect: true, idempotent: false, retrySafe: false })
    let failure: unknown
    try { publish(h, auth.connection.id, 'retry forbidden', true) } catch (error) { failure = error }
    expect(failure).toMatchObject({ diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'RETRY_UNSAFE' })]) })
    const safeState = JSON.stringify({ attempts, logs: h.root.logs.query({ limit: 200 }).records })
    for (const value of [webhookUrl, 'private-fixture-token', secret]) expect(safeState).not.toContain(value)
    const directory = h.directory
    await h.stop()
    h = await harness(server, { directory })
    await h.root.connections.reconcile()
    await h.root.scheduler.dispatchUntilIdle()
    expect(h.root.scheduler.getRun(run.id)?.status).toBe('FAILED')
    expect(h.root.scheduler.listAttempts(run.id)).toEqual(attempts)
    expect(server.requests).toHaveLength(1)
  })
})
