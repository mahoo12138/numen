import Server from '@cordisjs/plugin-server'
import { AutomationService } from '@numenjs/automation'
import { CapabilityRegistry, type AutomationSource } from '@numenjs/core'
import { ConnectionService } from '@numenjs/connections'
import { CredentialService } from '@numenjs/credentials'
import { DatabaseService } from '@numenjs/database'
import { LoggingService } from '@numenjs/logging'
import { ResourceService } from '@numenjs/resources'
import { SchedulerService } from '@numenjs/scheduler'
import { TriggerService } from '@numenjs/triggers'
import { Context } from 'cordis'
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OutboundHttpService } from '../../http/src/index.js'
import githubPlugin, { createGithubApiRuntime, githubApiLimits, githubApiVersion, githubIssueGetCapability, githubIssueCreateCapability,
  githubIssueCommentCapability, githubTokenAdapter, githubTokenCredential, githubWebhookTrigger, githubWebhookPath,
  githubWebhookSecretAdapter, githubWebhookSecretCredential, type GithubApiRuntime } from '../src/index.js'

const token = 'github_pat_private_fixture_token'
const keyEnv = 'NUMEN_GITHUB_API_TEST_KEY'
const cleanup: Array<() => Promise<void>> = []
const directories: string[] = []
const repository = { owner: 'octo-org', repo: 'fixture.repo' }
const issue = { ...repository, issueNumber: 12 }
const remoteIssue = { id: 100, number: 12, title: '发布 🌍', body: 'Release details', state: 'open', html_url: 'https://github.com/octo-org/fixture.repo/issues/12', private_extra: token }
const issueOutput = { id: 100, number: 12, title: '发布 🌍', body: 'Release details', state: 'open', url: remoteIssue.html_url }
type Received = { path: string; method?: string; headers: Record<string, string | string[] | undefined>; raw: Buffer; body: Record<string, any> }
type Mode = 'ok' | '429' | '403-limit' | '403' | '401' | '404' | '422' | '503' | 'invalid' | 'invalid-object' | 'invalid-url' | 'invalid-utf8'
  | 'null-body' | 'large-length' | 'large-stream' | 'redirect' | 'disconnect' | 'hold' | 'no-headers' | 'bad-rate-headers'

async function fixture() {
  const requests: Received[] = []
  const sockets = new Set<Socket>()
  const held: ServerResponse[] = []
  let mode: Mode = 'ok'
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const raw = Buffer.concat(chunks)
    const body = raw.length ? JSON.parse(raw.toString('utf8')) : {}
    requests.push({ path: request.url!, method: request.method, headers: request.headers, raw, body })
    response.setHeader('content-type', 'application/json')
    if (mode === 'disconnect') { response.destroy(); return }
    if (mode === 'no-headers') { held.push(response); return }
    if (mode === 'hold' || body.title === 'hold' || body.body === 'hold') {
      response.writeHead(request.method === 'GET' ? 200 : 201)
      response.write('{"id":')
      held.push(response)
      return
    }
    if (mode === 'redirect') { response.writeHead(307, { location: '/redirect-target' }); response.end(); return }
    if (/^(429|403-limit|403|401|404|422|503)$/.test(mode)) {
      response.statusCode = Number.parseInt(mode, 10)
      if (mode === '429' || mode === '403-limit') {
        response.setHeader('retry-after', '61')
        response.setHeader('x-ratelimit-remaining', '0')
        response.setHeader('x-ratelimit-reset', '1800000000')
      }
      response.end(JSON.stringify({ message: `${token} private-response-content` }))
      return
    }
    if (mode === 'bad-rate-headers') {
      response.writeHead(403, { 'retry-after': token, 'x-ratelimit-remaining': '-1', 'x-ratelimit-reset': '9999999999999999999999' })
      response.end(token)
      return
    }
    response.statusCode = request.method === 'GET' ? 200 : 201
    if (mode === 'large-length') { response.setHeader('content-length', String(githubApiLimits.maxResponseBytes + 1)); response.end(' '); return }
    if (mode === 'large-stream') { response.write(' '.repeat(600_000)); response.end(' '.repeat(600_000)); return }
    if (mode === 'invalid') { response.end(`private-response-content-${token}`); return }
    if (mode === 'invalid-utf8') { response.end(Buffer.from([0xc3, 0x28])); return }
    if (mode === 'invalid-object') { response.end(JSON.stringify({ ...remoteIssue, id: '100' })); return }
    if (mode === 'invalid-url') { response.end(JSON.stringify({ ...remoteIssue, html_url: 'javascript:alert(1)' })); return }
    if (request.url?.endsWith('/comments')) {
      response.end(JSON.stringify({ id: 200, body: body.body, html_url: remoteIssue.html_url + '#issuecomment-200', extra: token }))
      return
    }
    response.end(JSON.stringify({ ...remoteIssue, ...(request.method === 'POST' ? { title: body.title, body: body.body ?? null } : {}), ...(mode === 'null-body' ? { body: null } : {}) }))
  })
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('expected TCP fixture')
  cleanup.push(async () => {
    for (const response of held) response.destroy()
    for (const socket of sockets) socket.destroy()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })
  return { requests, origin: `http://127.0.0.1:${address.port}`, setMode(next: Mode) { mode = next } }
}

async function harness(server: Awaited<ReturnType<typeof fixture>>, directory?: string) {
  directory ??= await mkdtemp(join(tmpdir(), 'numen-github-api-'))
  if (!directories.includes(directory)) directories.push(directory)
  process.env[keyEnv] ??= randomBytes(32).toString('base64')
  const root = new Context()
  await root.plugin(LoggingService, { console: false, levels: { base: 3 } })
  await root.plugin(Server, { host: '127.0.0.1', port: 0 })
  await root.plugin(DatabaseService, { path: join(directory, 'numen.db') })
  await root.plugin(CapabilityRegistry)
  await root.plugin(CredentialService, { masterKeyEnv: keyEnv })
  await root.plugin(ConnectionService)
  const http = await root.plugin(OutboundHttpService, { proxyAgentEnv: '', noProxyEnv: '' })
  const originalUrls: string[] = []
  root.on('http/fetch', async (url, _init, _config, next) => {
    expect(url.origin).toBe('https://api.github.com')
    originalUrls.push(url.href)
    const original = url.href
    url.href = server.origin + url.pathname
    try { return await next() } finally { url.href = original }
  })
  const plugin = await root.plugin(githubPlugin)
  await root.plugin(AutomationService)
  await root.plugin(ResourceService, { path: join(directory, 'resources') })
  await root.plugin(SchedulerService, { autoDispatch: false })
  let stopped = false
  const stop = async () => { if (!stopped) { stopped = true; await root.fiber.dispose() } }
  cleanup.unshift(stop)
  return { root, directory, originalUrls, plugin, http, stop }
}
type Harness = Awaited<ReturnType<typeof harness>>
async function connect(h: Harness, enabled = true) {
  const credential = h.root.credentials.create('GitHub token', githubTokenCredential, { token })
  const connection = h.root.connections.create({ name: 'GitHub API', adapter: githubTokenAdapter, credentialId: credential.id, config: {}, enabled })
  await h.root.connections.reconcile()
  const runtime = () => h.root.connections.resolveRuntimes({ api: connection.id }, githubIssueGetCapability.connections!).api as GithubApiRuntime
  return { credential, connection, runtime }
}
const get = (api: GithubApiRuntime, signal = new AbortController().signal) => api.getIssue(issue, signal)
const create = (api: GithubApiRuntime, title = '新发布 🌍', signal = new AbortController().signal) => api.createIssue({ ...repository, title, body: '正文\nMarkdown' }, signal)
const comment = (api: GithubApiRuntime, body = '已审核', signal = new AbortController().signal) => api.commentOnIssue({ ...issue, body }, signal)
function publish(h: Harness, connectionId: string, kind: 'get' | 'create' | 'comment' = 'create', retry = false) {
  const capability = kind === 'get' ? githubIssueGetCapability : kind === 'comment' ? githubIssueCommentCapability : githubIssueCreateCapability
  const values = kind === 'get' ? issue : kind === 'comment' ? { ...issue, body: 'Scheduled comment' } : { ...repository, title: 'Scheduled issue' }
  const source: AutomationSource = { triggers: [], flow: { type: 'capability', id: 'issue', capability, connections: { api: connectionId },
    input: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { type: 'literal' as const, value }])),
    ...(retry ? { policy: { retry: { maxAttempts: 3, backoffMs: 0 } } } : {}),
  } }
  const { automation } = h.root.automations.create({ name: 'GitHub issue', source })
  const revision = h.root.automations.publishDraft(automation.id, 1)
  h.root.automations.activateRevision(automation.id, revision.id)
  return h.root.scheduler.startManual(automation.id)
}
async function settlesSoon<T>(promise: Promise<T>): Promise<T | 'did not settle'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([promise, new Promise<'did not settle'>(resolve => { timer = setTimeout(() => resolve('did not settle'), 800) })]) }
  finally { if (timer) clearTimeout(timer) }
}
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(stop => stop()))
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
  delete process.env[keyEnv]
})

describe('GitHub REST API through real HTTP, Connection and Scheduler services', () => {
  it('encrypts tokens, scopes authorization to api.github.com, sends documented headers and projects issue/comment output', async () => {
    const server = await fixture()
    const h = await harness(server)
    const auth = await connect(h)
    expect(server.requests).toHaveLength(0)
    const row = h.root.database.db.prepare('SELECT ciphertext FROM credentials WHERE id = ?').get(auth.credential.id) as { ciphertext: Buffer }
    expect(row.ciphertext.includes(Buffer.from(token))).toBe(false)
    await expect(get(auth.runtime())).resolves.toEqual(issueOutput)
    await expect(create(auth.runtime())).resolves.toEqual({ ...issueOutput, title: '新发布 🌍', body: '正文\nMarkdown' })
    await expect(comment(auth.runtime())).resolves.toEqual({ id: 200, body: '已审核', url: remoteIssue.html_url + '#issuecomment-200' })
    expect(server.requests.map(({ method, path }) => ({ method, path }))).toEqual([
      { method: 'GET', path: '/repos/octo-org/fixture.repo/issues/12' }, { method: 'POST', path: '/repos/octo-org/fixture.repo/issues' },
      { method: 'POST', path: '/repos/octo-org/fixture.repo/issues/12/comments' },
    ])
    for (const request of server.requests) expect(request.headers).toMatchObject({ authorization: `Bearer ${token}`, accept: 'application/vnd.github+json',
      'x-github-api-version': githubApiVersion, 'user-agent': 'Numen-GitHub-Integration' })
    expect(server.requests[0]!.raw.length).toBe(0)
    expect(server.requests[1]!.body).toEqual({ title: '新发布 🌍', body: '正文\nMarkdown' })
    expect(server.requests[2]!.body).toEqual({ body: '已审核' })
    const logs = h.root.logs.query({ maxLevel: 3, limit: 200 }).records
    expect(logs.some(record => record.namespace.startsWith('http:'))).toBe(true)
    expect(JSON.stringify({ logs, credentials: h.root.credentials.list(), connections: h.root.connections.list() })).not.toContain(token)
    server.setMode('null-body')
    await expect(get(auth.runtime())).resolves.toEqual({ ...issueOutput, body: '' })
  })

  it('rejects path injection, unsafe numbers, invalid credentials and empty content before network', async () => {
    const server = await fixture()
    const h = await harness(server)
    const auth = await connect(h)
    for (const owner of ['', '../org', 'x/y', 'foo?bar', 'foo#bar', 'https://evil.test', 'a'.repeat(40)]) {
      await expect(auth.runtime().getIssue({ ...issue, owner }, AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'GITHUB_API_INPUT_INVALID' })
    }
    for (const repo of ['', '.', '..', '%2e%2e', 'foo/bar', 'foo?bar', 'foo#bar', 'a'.repeat(101)]) {
      await expect(auth.runtime().getIssue({ ...issue, repo }, AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'GITHUB_API_INPUT_INVALID' })
    }
    for (const issueNumber of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(auth.runtime().getIssue({ ...issue, issueNumber }, AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'GITHUB_API_INPUT_INVALID' })
      expect(() => githubIssueGetCapability.input({ ...issue, issueNumber })).toThrow()
    }
    for (const invalid of ['', 'a b', 'abc\r\nAuthorization: x', 'x'.repeat(4097)]) {
      expect(() => h.root.credentials.create('Invalid', githubTokenCredential, { token: invalid })).toThrow()
      expect(() => createGithubApiRuntime(h.root, { token: invalid }, new AbortController().signal)).toThrow('[GITHUB_API_CREDENTIAL_INVALID]')
    }
    for (const title of ['', '  \n', 'x'.repeat(257)]) await expect(create(auth.runtime(), title)).rejects.toMatchObject({ code: 'GITHUB_API_INPUT_INVALID' })
    for (const body of ['', '  \n', 'x'.repeat(65537)]) await expect(comment(auth.runtime(), body)).rejects.toMatchObject({ code: 'GITHUB_API_INPUT_INVALID' })
    await expect(get(auth.runtime(), AbortSignal.abort(new Error(token)))).rejects.toMatchObject({ code: 'GITHUB_API_CANCELLED' })
    expect(server.requests).toHaveLength(0)
    expect(h.originalUrls).toHaveLength(0)
  })

  it('isolates API requests from host authentication, params, payload and decoding defaults without mutating the host', async () => {
    const server = await fixture()
    const h = await harness(server)
    const hostDefaults = { headers: { Authorization: 'Bearer host-private-token', Cookie: 'session=host-private-token', 'x-host-secret': 'private' },
      params: { hostQuery: 'private' }, data: 'host-private-payload', responseType: 'json', validateStatus: () => false }
    Object.assign(h.root.http.config, hostDefaults)
    const auth = await connect(h)
    await expect(get(auth.runtime())).resolves.toEqual(issueOutput)
    await expect(create(auth.runtime())).resolves.toHaveProperty('id', 100)
    const getRequest = server.requests[0]!
    expect(getRequest.headers.authorization).toBe(`Bearer ${token}`)
    expect(getRequest.headers.cookie).toBeUndefined()
    expect(getRequest.headers['x-host-secret']).toBeUndefined()
    expect(getRequest.raw.length).toBe(0)
    expect(h.originalUrls).toEqual(['https://api.github.com/repos/octo-org/fixture.repo/issues/12', 'https://api.github.com/repos/octo-org/fixture.repo/issues'])
    server.setMode('403')
    await expect(get(auth.runtime())).rejects.toMatchObject({ code: 'GITHUB_API_HTTP_ERROR', status: 403 })
    expect(h.root.http.config).toMatchObject(hostDefaults)
  })

  it('counts UTF-8 JSON bytes, omits absent issue body, and rejects escaped requests over the byte bound', async () => {
    const server = await fixture()
    const h = await harness(server)
    const auth = await connect(h)
    await expect(auth.runtime().createIssue({ ...repository, title: 'No body' }, new AbortController().signal)).resolves.toMatchObject({ body: '' })
    expect(server.requests[0]!.body).toEqual({ title: 'No body' })
    await expect(comment(auth.runtime(), '界'.repeat(65536))).resolves.toHaveProperty('id', 200)
    expect(server.requests[1]!.raw.length).toBeLessThan(githubApiLimits.maxRequestBytes)
    await expect(comment(auth.runtime(), '\u0000'.repeat(65536))).rejects.toMatchObject({ code: 'GITHUB_API_REQUEST_TOO_LARGE' })
    expect(server.requests).toHaveLength(2)
  })

  it.each([
    ['401', 'GITHUB_API_HTTP_ERROR'], ['403', 'GITHUB_API_HTTP_ERROR'], ['404', 'GITHUB_API_HTTP_ERROR'], ['422', 'GITHUB_API_HTTP_ERROR'], ['503', 'GITHUB_API_HTTP_ERROR'],
    ['invalid', 'GITHUB_API_RESPONSE_INVALID'], ['invalid-object', 'GITHUB_API_RESPONSE_INVALID'], ['invalid-url', 'GITHUB_API_RESPONSE_INVALID'], ['invalid-utf8', 'GITHUB_API_RESPONSE_INVALID'],
    ['large-length', 'GITHUB_API_RESPONSE_TOO_LARGE'], ['large-stream', 'GITHUB_API_RESPONSE_TOO_LARGE'], ['redirect', 'GITHUB_API_HTTP_ERROR'], ['disconnect', 'GITHUB_API_NETWORK_ERROR'],
  ] as const)('handles %s without leaking remote content or repeating a POST', async (mode, code) => {
    const server = await fixture()
    server.setMode(mode)
    const h = await harness(server)
    const auth = await connect(h)
    const error = await create(auth.runtime()).catch(error => error)
    expect(error).toMatchObject({ name: 'GithubApiError', code })
    expect(error).not.toHaveProperty('cause')
    const serialized = `${String(error)} ${JSON.stringify(error)} ${JSON.stringify(h.root.logs.query({ limit: 200 }).records)}`
    expect(serialized).not.toContain(token)
    expect(serialized).not.toContain('private-response-content')
    expect(server.requests).toHaveLength(1)
    expect(h.originalUrls).toHaveLength(1)
  })

  it.each(['429', '403-limit'] as const)('preserves validated numeric rate metadata for %s without retrying', async mode => {
    const server = await fixture()
    server.setMode(mode)
    const h = await harness(server)
    const auth = await connect(h)
    const error = await comment(auth.runtime()).catch(error => error)
    expect(error).toMatchObject({ code: 'GITHUB_API_RATE_LIMITED', status: mode === '429' ? 429 : 403, retryAfterSeconds: 61, rateLimitRemaining: 0, rateLimitReset: 1800000000 })
    expect(String(error)).toContain('retryAfterSeconds=61')
    expect(server.requests).toHaveLength(1)
  })

  it('discards malformed or secret-bearing rate metadata', async () => {
    const server = await fixture()
    server.setMode('bad-rate-headers')
    const h = await harness(server)
    const auth = await connect(h)
    const error = await get(auth.runtime()).catch(error => error)
    expect(error).toMatchObject({ code: 'GITHUB_API_HTTP_ERROR', status: 403 })
    expect(error.retryAfterSeconds).toBeUndefined()
    expect(error.rateLimitRemaining).toBeUndefined()
    expect(error.rateLimitReset).toBeUndefined()
    expect(`${error} ${JSON.stringify(error)} ${JSON.stringify(h.root.logs.query().records)}`).not.toContain(token)
  })

  it.each(['hold', 'no-headers'] as const)('enforces the complete deadline during %s and never resends', async mode => {
    const server = await fixture()
    server.setMode(mode)
    const h = await harness(server)
    const runtime = createGithubApiRuntime(h.root, { token }, new AbortController().signal, 80)
    try { expect(await settlesSoon(create(runtime.value).catch(error => error))).toMatchObject({ code: 'GITHUB_API_TIMEOUT' }) }
    finally { runtime.close() }
    expect(server.requests).toHaveLength(1)
  })

  it('cancels one response while concurrent requests on the same Connection continue', async () => {
    const server = await fixture()
    const h = await harness(server)
    const auth = await connect(h)
    const controller = new AbortController()
    const held = create(auth.runtime(), 'hold', controller.signal).catch(error => error)
    await expect.poll(() => server.requests.length).toBe(1)
    const completed = comment(auth.runtime())
    controller.abort(new Error(token))
    expect(await settlesSoon(held)).toMatchObject({ code: 'GITHUB_API_CANCELLED' })
    await expect(completed).resolves.toHaveProperty('id', 200)
    expect(server.requests).toHaveLength(2)
  })

  it('rotation and unload abort in-flight requests, fence retired runtimes and preserve unrelated HTTP', async () => {
    const server = await fixture()
    const h = await harness(server)
    const auth = await connect(h)
    const old = auth.runtime()
    const held = create(old, 'hold').catch(error => error)
    await expect.poll(() => server.requests.length).toBe(1)
    const nextToken = 'github_pat_rotated_fixture_token'
    h.root.credentials.rotate(auth.credential.id, 1, { token: nextToken })
    await h.root.connections.reconcile()
    expect(await settlesSoon(held)).toMatchObject({ code: 'GITHUB_API_UNAVAILABLE' })
    await expect(get(old)).rejects.toMatchObject({ code: 'GITHUB_API_UNAVAILABLE' })
    const current = auth.runtime()
    await expect(get(current)).resolves.toEqual(issueOutput)
    expect(server.requests.at(-1)!.headers.authorization).toBe(`Bearer ${nextToken}`)
    const unloading = comment(current, 'hold').catch(error => error)
    await expect.poll(() => server.requests.length).toBe(3)
    await h.plugin.dispose()
    expect(await settlesSoon(unloading)).toMatchObject({ code: 'GITHUB_API_UNAVAILABLE' })
    await expect(get(current)).rejects.toMatchObject({ code: 'GITHUB_API_UNAVAILABLE' })
    const unrelated = await h.root.http('https://api.github.com/health')
    expect(unrelated.ok).toBe(true)
    await unrelated.body?.cancel()
    expect(server.requests).toHaveLength(4)
  })

  it('optional HTTP service loss removes only REST capabilities and restores them when HTTP returns', async () => {
    const server = await fixture()
    const h = await harness(server)
    const auth = await connect(h)
    await h.root.plugin(TriggerService)
    const webhookSecret = 'independent-webhook-secret'
    const credential = h.root.credentials.create('Webhook signing secret', githubWebhookSecretCredential, { secret: webhookSecret })
    const connection = h.root.connections.create({ name: 'Webhook', adapter: githubWebhookSecretAdapter, credentialId: credential.id, config: {}, enabled: true })
    await h.root.connections.reconcile()
    const { automation } = h.root.automations.create({ name: 'Independent webhook', source: {
      triggers: [{ id: 'incoming', capability: githubWebhookTrigger, config: {}, connections: { auth: connection.id } }], flow: { type: 'block', id: 'flow', steps: [] },
    } })
    const revision = h.root.automations.publishDraft(automation.id, 1)
    h.root.automations.activateRevision(automation.id, revision.id)
    h.root.automations.setEnabled(automation.id, true)
    const deliver = async () => {
      const body = '{"action":"opened"}'
      const response = await fetch(h.root.server.baseUrl + githubWebhookPath(automation.id, 'incoming'), { method: 'POST', body, headers: {
        'content-type': 'application/json', 'x-github-event': 'issues', 'x-github-delivery': randomUUID(),
        'x-hub-signature-256': `sha256=${createHmac('sha256', webhookSecret).update(body).digest('hex')}`,
      } })
      expect(response.status).toBe(202)
      expect(await response.json()).toMatchObject({ status: 'accepted' })
    }
    await deliver()
    const old = auth.runtime()
    const held = create(old, 'hold').catch(error => error)
    await expect.poll(() => server.requests.length).toBe(1)
    await h.http.dispose()
    expect(await settlesSoon(held)).toMatchObject({ code: 'GITHUB_API_UNAVAILABLE' })
    await expect(get(old)).rejects.toMatchObject({ code: 'GITHUB_API_UNAVAILABLE' })
    expect(h.root.capabilities.get(githubWebhookTrigger)).toBeDefined()
    expect(h.root.capabilities.get(githubIssueGetCapability)).toBeUndefined()
    await deliver()
    await h.root.plugin(OutboundHttpService, { proxyAgentEnv: '', noProxyEnv: '' })
    await h.root.connections.reconcile()
    await expect(get(auth.runtime())).resolves.toEqual(issueOutput)
    expect(h.root.capabilities.get(githubWebhookTrigger)).toBeDefined()
    await deliver()
    expect(server.requests).toHaveLength(2)
  })

  it('blocks disabled Connections, persists outputs and never repeats a completed create after restart', async () => {
    const server = await fixture()
    let h = await harness(server)
    const auth = await connect(h, false)
    const run = publish(h, auth.connection.id)
    await h.root.scheduler.dispatchUntilIdle()
    expect(h.root.scheduler.listExecutions(run.id)[0]).toMatchObject({ status: 'BLOCKED', blockedReason: 'CONNECTION_UNAVAILABLE' })
    expect(h.root.scheduler.listAttempts(run.id)).toHaveLength(0)
    h.root.connections.setEnabled(auth.connection.id, auth.connection.generation, true)
    await h.root.connections.reconcile()
    await expect.poll(async () => { await h.root.scheduler.dispatchUntilIdle(); return h.root.scheduler.getRun(run.id)?.status }).toBe('COMPLETED')
    expect(h.root.scheduler.listExecutions(run.id)[0]!.output).toEqual({ ...issueOutput, title: 'Scheduled issue', body: '' })
    const directory = h.directory
    await h.stop()
    h = await harness(server, directory)
    await h.root.connections.reconcile()
    await h.root.scheduler.dispatchUntilIdle()
    expect(h.root.scheduler.getRun(run.id)?.status).toBe('COMPLETED')
    expect(h.root.scheduler.listAttempts(run.id)).toHaveLength(1)
    expect(server.requests).toHaveLength(1)
  })

  it.each(['create', 'comment'] as const)('preserves an uncertain %s failure across restart and forbids automatic retry policies', async kind => {
    const server = await fixture()
    server.setMode('disconnect')
    let h = await harness(server)
    const auth = await connect(h)
    const run = publish(h, auth.connection.id, kind)
    await h.root.scheduler.dispatchUntilIdle()
    expect(h.root.scheduler.getRun(run.id)?.status).toBe('FAILED')
    const attempts = h.root.scheduler.listAttempts(run.id)
    expect(attempts).toHaveLength(1)
    expect(attempts[0]!.error).toMatchObject({ name: 'GithubApiError', message: expect.stringContaining('GITHUB_API_NETWORK_ERROR') })
    let failure: unknown
    try { publish(h, auth.connection.id, kind, true) } catch (error) { failure = error }
    expect(failure).toMatchObject({ diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'RETRY_UNSAFE' })]) })
    const directory = h.directory
    await h.stop()
    h = await harness(server, directory)
    await h.root.connections.reconcile()
    await h.root.scheduler.dispatchUntilIdle()
    expect(h.root.scheduler.getRun(run.id)?.status).toBe('FAILED')
    expect(h.root.scheduler.listAttempts(run.id)).toEqual(attempts)
    expect(server.requests).toHaveLength(1)
  })

  it('permits explicit Scheduler retries for the read-only query', async () => {
    const server = await fixture()
    server.setMode('503')
    const h = await harness(server)
    const auth = await connect(h)
    const run = publish(h, auth.connection.id, 'get', true)
    await h.root.scheduler.dispatchUntilIdle()
    expect(h.root.scheduler.getRun(run.id)?.status).toBe('FAILED')
    expect(h.root.scheduler.listAttempts(run.id)).toHaveLength(3)
    expect(server.requests).toHaveLength(3)
    expect(server.requests.every(request => request.method === 'GET')).toBe(true)
  })
})
