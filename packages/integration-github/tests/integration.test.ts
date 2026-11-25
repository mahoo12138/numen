import { defineCapability } from '@numenjs/core'
import { randomUUID } from 'node:crypto'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import type { Socket } from 'node:net'
import z from 'schemastery'
import { describe, expect, it, vi } from 'vitest'
import githubIntegrationPlugin, { githubWebhookPath, githubWebhookTrigger } from '../src/index.js'
import { createGithubWebhookAuth } from '../src/auth.js'
import { authConnection, harness, publish, responseText, signature, testSecret, unfinishedRequest } from './fixture.js'

describe('GitHub Webhook Integration', () => {
  it('validates the original Unicode bytes and executes the accepted body without leaking transport secrets', async () => {
    const h = await harness()
    const auth = await authConnection(h)
    const echo = defineCapability({ id: 'test:echo-github', version: 1, kind: 'query', title: 'Echo GitHub',
      input: z.object({ value: z.any().required() }), output: z.any(), semantics: { sideEffect: false, idempotent: true, retrySafe: true } })
    h.root.capabilities.define(h.root, echo)
    h.root.capabilities.provide(h.root, echo, { async invoke({ input }) { return input.value } })
    const endpoint = publish(h, auth.connection.id, { source: {
      triggers: [{ id: 'incoming', capability: githubWebhookTrigger, config: {}, connections: { auth: auth.connection.id } }],
      flow: { type: 'capability', id: 'echo', capability: echo, input: { value: { type: 'ref', path: 'trigger.body' } } },
    } })
    const body = '{ "action": "opened", "issue": { "title": "新问题 🥚", "number": 7 }, "nullable": null }\n'
    const deliveryId = randomUUID()
    const response = await h.post(`${endpoint.path}?secret=private-query`, body, { 'x-github-event': 'issues', 'x-github-delivery': deliveryId, cookie: 'private-cookie', 'x-private-header': 'private-header' })
    expect(response.status).toBe(202)
    const receipt = await response.json() as { status: string; runId: string }
    expect(receipt.status).toBe('accepted')
    expect(h.root.scheduler.getRun(receipt.runId)).toMatchObject({ status: 'QUEUED', trigger: {
      body: JSON.parse(body), event: 'issues', deliveryId, action: 'opened', receivedAt: expect.any(String),
    } })
    await h.root.scheduler.dispatchUntilIdle()
    expect(h.root.scheduler.getRun(receipt.runId)?.status).toBe('COMPLETED')
    expect(h.root.scheduler.listExecutions(receipt.runId).find(item => item.instructionId === 'echo')?.output).toEqual(JSON.parse(body))
    const stored = JSON.stringify({ runs: h.root.scheduler.listRuns(), events: h.root.scheduler.listEvents(receipt.runId), logs: h.root.logs.query({}).records,
      connections: h.root.connections.list(), credentials: h.root.credentials.list() })
    for (const secret of [testSecret, signature(body), 'private-query', 'private-cookie', 'private-header']) expect(stored).not.toContain(secret)
    expect((await h.post(endpoint.path, JSON.stringify(JSON.parse(body)), { 'x-hub-signature-256': signature(body) })).status).toBe(401)
    expect(h.root.scheduler.listRuns()).toHaveLength(1)
  })

  it('authenticates ping and filters events and actions before creating Runs', async () => {
    const h = await harness()
    const auth = await authConnection(h)
    const endpoint = publish(h, auth.connection.id, { events: ['issues'], actions: ['opened', 'reopened'] })
    expect(await (await h.post(endpoint.path, '{"zen":"Keep it logically awesome."}', { 'x-github-event': 'ping' })).json()).toEqual({ status: 'ping' })
    expect((await h.post(endpoint.path, '{}', { 'x-github-event': 'ping', 'x-hub-signature-256': signature('{}', 'wrong') })).status).toBe(401)
    for (const [event, body] of [['push', '{}'], ['issues', '{}'], ['issues', '{"action":"closed"}'], ['pull_request', '{"action":"opened"}']]) {
      expect(await (await h.post(endpoint.path, body, { 'x-github-event': event! })).json()).toEqual({ status: 'ignored' })
    }
    expect(h.root.scheduler.listRuns()).toHaveLength(0)
    expect((await h.post(endpoint.path, '{"action":"opened"}', { 'x-github-event': 'issues' })).status).toBe(202)
    expect((await h.post(endpoint.path, '{"action":"reopened"}', { 'x-github-event': 'issues' })).status).toBe(202)
    expect(h.root.scheduler.listRuns()).toHaveLength(2)
  })

  it('deduplicates concurrent deliveries across restart and scopes the receipt to revision and trigger', async () => {
    let h = await harness()
    const auth = await authConnection(h)
    const endpoint = publish(h, auth.connection.id)
    const deliveryId = randomUUID()
    const responses = await Promise.all(Array.from({ length: 12 }, () => h.post(endpoint.path, '{}', { 'x-github-delivery': deliveryId })))
    expect(responses.filter(response => response.status === 202)).toHaveLength(1)
    expect(responses.filter(response => response.status === 200)).toHaveLength(11)
    const receipts = await Promise.all(responses.map(response => response.json())) as Array<{ runId: string }>
    expect(new Set(receipts.map(receipt => receipt.runId)).size).toBe(1)
    await h.stop()
    h = await harness(h.directory)
    await h.root.connections.reconcile()
    const duplicate = await h.post(endpoint.path, '{"different":"payload"}', { 'x-github-delivery': deliveryId.toUpperCase() })
    expect(duplicate.status).toBe(200)
    expect(await duplicate.json()).toEqual({ status: 'duplicate', runId: receipts[0]!.runId })
    h.root.automations.setEnabled(endpoint.automationId, false)
    h.root.automations.setEnabled(endpoint.automationId, true)
    expect((await h.post(endpoint.path, '{}', { 'x-github-delivery': deliveryId })).status).toBe(200)
    const draft = h.root.automations.getDraft(endpoint.automationId)!
    const saved = h.root.automations.saveDraft({ automationId: endpoint.automationId, expectedVersion: draft.version, source: {
      ...draft.source, triggers: [...draft.source.triggers, { ...draft.source.triggers[0]!, id: 'second' }],
    } })
    const revision = h.root.automations.publishDraft(endpoint.automationId, saved.version)
    h.root.automations.activateRevision(endpoint.automationId, revision.id)
    expect((await h.post(endpoint.path, '{}', { 'x-github-delivery': deliveryId })).status).toBe(202)
    expect((await h.post(githubWebhookPath(endpoint.automationId, 'second'), '{}', { 'x-github-delivery': deliveryId })).status).toBe(202)
    expect(h.root.scheduler.listRuns()).toHaveLength(3)
  })

  it('accepts repository_dispatch custom action strings instead of limiting them to builtin action names', async () => {
    const h = await harness()
    const auth = await authConnection(h)
    const endpoint = publish(h, auth.connection.id, { events: ['repository_dispatch'], actions: ['on-demand-test', 'Release.发布'] })
    for (const action of ['on-demand-test', 'Release.发布']) {
      const response = await h.post(endpoint.path, JSON.stringify({ action, client_payload: { tag: 'v1' } }), { 'x-github-event': 'repository_dispatch' })
      expect(response.status).toBe(202)
    }
    expect(await (await h.post(endpoint.path, '{"action":"ON-DEMAND-TEST"}', { 'x-github-event': 'repository_dispatch' })).json()).toEqual({ status: 'ignored' })
    expect(h.root.scheduler.listRuns()).toHaveLength(2)
  })

  it('removes only the endpoints of a disabled Connection and restores them when ready', async () => {
    const h = await harness()
    const firstAuth = await authConnection(h)
    const secondAuth = await authConnection(h)
    const first = publish(h, firstAuth.connection.id)
    const second = publish(h, secondAuth.connection.id)
    const pending = await unfinishedRequest(h, first.path)
    const disabled = h.root.connections.setEnabled(firstAuth.connection.id, firstAuth.connection.generation, false)
    await h.root.connections.reconcile()
    expect((await pending.response).statusCode).toBe(503)
    await responseText(await pending.response)
    pending.request.destroy()
    expect(h.root.triggers.automationHealth(first.automationId)?.status).toBe('WAITING')
    expect((await h.post(first.path)).status).toBe(404)
    expect((await h.post(second.path)).status).toBe(202)
    h.root.connections.setEnabled(firstAuth.connection.id, disabled.generation, true)
    await h.root.connections.reconcile()
    expect((await h.post(first.path)).status).toBe(202)
    expect(h.root.scheduler.listRuns()).toHaveLength(2)
  })

  it('fences in-flight disable and revision changes while retaining unrelated endpoints', async () => {
    const h = await harness()
    const auth = await authConnection(h)
    const endpoint = publish(h, auth.connection.id)
    const other = publish(h, auth.connection.id)
    const pending = await unfinishedRequest(h, endpoint.path)
    h.root.automations.setEnabled(endpoint.automationId, false)
    const disabled = await pending.response
    expect(disabled.statusCode).toBe(503)
    await responseText(disabled)
    pending.request.destroy()
    expect((await h.post(endpoint.path)).status).toBe(404)
    expect((await h.post(other.path)).status).toBe(202)
    h.root.automations.setEnabled(endpoint.automationId, true)
    const stale = await unfinishedRequest(h, endpoint.path)
    const draft = h.root.automations.getDraft(endpoint.automationId)!
    const saved = h.root.automations.saveDraft({ automationId: endpoint.automationId, expectedVersion: draft.version,
      source: { ...draft.source, flow: { type: 'block', id: 'replacement', steps: [] } } })
    const revision = h.root.automations.publishDraft(endpoint.automationId, saved.version)
    h.root.automations.activateRevision(endpoint.automationId, revision.id)
    const response = await stale.response
    expect(response.statusCode).toBe(503)
    await responseText(response)
    stale.request.destroy()
    expect((await h.post(endpoint.path)).status).toBe(202)
    expect(h.root.scheduler.listRuns()).toHaveLength(2)
  })

  it('rotates a secret during an upload, revokes the old runtime and preserves durable receipts', async () => {
    const h = await harness()
    const auth = await authConnection(h)
    const endpoint = publish(h, auth.connection.id)
    const deliveryId = randomUUID()
    expect((await h.post(endpoint.path, '{}', { 'x-github-delivery': deliveryId })).status).toBe(202)
    const pending = await unfinishedRequest(h, endpoint.path)
    const secret = 'replacement-github-secret'
    h.root.credentials.rotate(auth.credential.id, 1, { secret })
    await h.root.connections.reconcile()
    const response = await pending.response
    expect(response.statusCode).toBe(503)
    await responseText(response)
    pending.request.destroy()
    expect((await h.post(endpoint.path)).status).toBe(401)
    expect((await h.post(endpoint.path, '{}', { 'x-hub-signature-256': signature('{}', secret), 'x-github-delivery': deliveryId })).status).toBe(200)
    expect((await h.post(endpoint.path, '{}', { 'x-hub-signature-256': signature('{}', secret) })).status).toBe(202)
    expect(h.root.scheduler.listRuns()).toHaveLength(2)
  })

  it('rejects malformed signed JSON, reserved resources, unsupported transport and missing metadata', async () => {
    const h = await harness()
    const auth = await authConnection(h)
    const endpoint = publish(h, auth.connection.id)
    const cases: Array<[string | Uint8Array, Record<string, string>, number]> = [
      ['', {}, 400], ['null', {}, 400], ['[]', {}, 400], ['{"secret":"private-parser-body",', {}, 400],
      [new Uint8Array([0xc3, 0x28]), {}, 400], ['{"action":null}', {}, 400], ['{"action":""}', {}, 400],
      ['{"nested":{"$resource":"res_private"}}', {}, 400], ['{"x":' + '['.repeat(65) + '0' + ']'.repeat(65) + '}', {}, 400],
      [JSON.stringify({ values: Array(10_001).fill(0) }), {}, 400], ['{}', { 'content-type': 'application/x-www-form-urlencoded' }, 415],
      ['{}', { 'content-type': 'application/json; charset=latin1' }, 415], ['{}', { 'content-encoding': 'gzip' }, 415],
      ['{}', { 'x-github-event': '' }, 400], ['{}', { 'x-github-delivery': 'not-a-uuid' }, 400],
      ['{}', { 'x-hub-signature-256': '' }, 401], ['{}', { 'x-hub-signature-256': 'sha1=' + 'a'.repeat(40) }, 401],
      ['{}', { 'x-hub-signature-256': 'sha256=' + 'a'.repeat(63) }, 401],
    ]
    for (const [body, headers, status] of cases) {
      const response = await h.post(endpoint.path, body, headers)
      expect(response.status).toBe(status)
      const text = await response.text()
      for (const secret of ['private-parser-body', 'res_private', testSecret]) expect(text).not.toContain(secret)
    }
    const resource = await h.root.resources.stage({ name: 'Internal', mediaType: 'text/plain', content: Buffer.from('private stored bytes') })
    expect((await h.post(endpoint.path, JSON.stringify({ nested: resource.ref }))).status).toBe(400)
    expect(h.root.resources.listOwners(resource.id)).toEqual([])
    expect(h.root.scheduler.listRuns()).toHaveLength(0)
    expect((await fetch(`${h.root.server.baseUrl}${endpoint.path}`)).status).toBe(405)
    expect((await h.post(endpoint.path, '{}', { 'content-type': 'application/json; charset=utf-8' })).status).toBe(202)
  })

  it('rejects ambiguous duplicate signature, event, delivery and content headers', async () => {
    const h = await harness()
    const auth = await authConnection(h)
    const endpoint = publish(h, auth.connection.id)
    for (const [name, values, status] of [
      ['x-hub-signature-256', [signature('{}'), signature('{}')], 401],
      ['x-github-event', ['push', 'issues'], 400], ['x-github-delivery', [randomUUID(), randomUUID()], 400],
      ['content-type', ['application/json', 'application/json'], 415],
    ] as const) {
      const request = httpRequest(`${h.root.server.baseUrl}${endpoint.path}`, { method: 'POST', headers: {
        'content-type': 'application/json', 'x-github-event': 'push', 'x-github-delivery': randomUUID(), 'x-hub-signature-256': signature('{}'), [name]: [...values],
      } })
      const received = new Promise<IncomingMessage>((resolve, reject) => { request.once('response', resolve); request.once('error', reject) })
      request.end('{}')
      const response = await received
      expect(response.statusCode).toBe(status)
      await responseText(response)
    }
    expect(h.root.scheduler.listRuns()).toHaveLength(0)
  })

  it('bounds declared and chunked uploads and accepts a later delivery after disconnection', async () => {
    const h = await harness()
    const auth = await authConnection(h)
    const endpoint = publish(h, auth.connection.id)
    const declared = await unfinishedRequest(h, endpoint.path, { 'content-length': String(1024 * 1024 + 1) })
    expect((await declared.response).statusCode).toBe(413)
    await responseText(await declared.response)
    declared.request.destroy()
    const oversized = await unfinishedRequest(h, endpoint.path)
    oversized.request.write('"' + 'x'.repeat(1024 * 1024 + 100))
    expect((await oversized.response).statusCode).toBe(413)
    await responseText(await oversized.response)
    oversized.request.destroy()
    const disconnected = await unfinishedRequest(h, endpoint.path)
    const rejected = expect(disconnected.response).rejects.toThrow()
    disconnected.request.destroy(new Error('sender disconnected'))
    await rejected
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(h.root.scheduler.listRuns()).toHaveLength(0)
    expect((await h.post(endpoint.path)).status).toBe(202)
  })

  it('returns an HTTP timeout for a stalled sender before GitHub’s ten second deadline', async () => {
    const h = await harness()
    const auth = await authConnection(h)
    const endpoint = publish(h, auth.connection.id)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const pending = await unfinishedRequest(h, endpoint.path)
    await vi.advanceTimersByTimeAsync(9_000)
    const response = await pending.response
    expect(response.statusCode).toBe(408)
    expect(await responseText(response)).toContain('GITHUB_BODY_TIMEOUT')
    pending.request.destroy()
    expect(vi.getTimerCount()).toBe(0)
    vi.useRealTimers()
    expect(h.root.scheduler.listRuns()).toHaveLength(0)
    expect((await h.post(endpoint.path)).status).toBe(202)
  })

  it('rolls back on durable storage failure and recovers committed receipts after a lost HTTP response', async () => {
    const h = await harness()
    const auth = await authConnection(h)
    const endpoint = publish(h, auth.connection.id)
    const deliveryId = randomUUID()
    h.root.database.db.exec("CREATE TRIGGER reject_github BEFORE INSERT ON trigger_events BEGIN SELECT RAISE(ABORT, 'private-storage-error'); END;")
    const failed = await h.post(endpoint.path, '{}', { 'x-github-delivery': deliveryId })
    expect(failed.status).toBe(503)
    expect(await failed.text()).not.toContain('private-storage-error')
    expect(h.root.scheduler.listRuns()).toHaveLength(0)
    h.root.database.db.exec('DROP TRIGGER reject_github')
    let socket: Socket | undefined
    const capture = h.root.on('server/route-request', async (request, _response, _route, next) => { socket = request._req.socket; return next() })
    const loseReceipt = h.root.on('numen/run-change', () => socket?.destroy())
    await expect(h.post(endpoint.path, '{}', { 'x-github-delivery': deliveryId })).rejects.toThrow()
    loseReceipt()
    capture()
    expect(h.root.scheduler.listRuns()).toHaveLength(1)
    const recovered = await h.post(endpoint.path, '{}', { 'x-github-delivery': deliveryId })
    expect(recovered.status).toBe(200)
    expect(await recovered.json()).toEqual({ status: 'duplicate', runId: h.root.scheduler.listRuns()[0]!.id })
  })

  it('unloads its route and pending uploads, then restores ingress without duplicate registration', async () => {
    const h = await harness()
    const auth = await authConnection(h)
    const endpoint = publish(h, auth.connection.id)
    expect(() => githubIntegrationPlugin(h.root)).toThrow('already defined')
    expect([...h.root.server.httpRoutes]).toHaveLength(1)
    const pending = await unfinishedRequest(h, endpoint.path)
    await h.plugin.dispose()
    const response = await pending.response
    expect(response.statusCode).toBe(503)
    await responseText(response)
    pending.request.destroy()
    expect([...h.root.server.httpRoutes]).toHaveLength(0)
    expect((await h.post(endpoint.path)).status).toBe(404)
    await h.root.plugin(githubIntegrationPlugin)
    await h.root.connections.reconcile()
    expect([...h.root.server.httpRoutes]).toHaveLength(1)
    expect((await h.post(endpoint.path)).status).toBe(202)
    expect(h.root.scheduler.listRuns()).toHaveLength(1)
  })

  it('does not let a stale activation disposer remove the replacement endpoint', async () => {
    const h = await harness()
    const provider = h.root.capabilities.resolveTriggerProvider(githubWebhookTrigger)!
    const first = new AbortController()
    const second = new AbortController()
    const auth = createGithubWebhookAuth(testSecret, new AbortController().signal)
    const binding = { automationId: 'auto_identity', triggerId: 'trigger', revisionId: 'rev_identity', activationGeneration: 1,
      capability: githubWebhookTrigger, config: {}, connectionIds: {} }
    const firstEmit = vi.fn(async () => ({ status: 'accepted' as const, runId: 'old-run' }))
    const secondEmit = vi.fn(async () => ({ status: 'accepted' as const, runId: 'new-run' }))
    const disposeFirst = provider.activate({ binding, connections: { auth: auth.value }, signal: first.signal, emit: firstEmit })!
    first.abort()
    const disposeSecond = provider.activate({ binding: { ...binding, activationGeneration: 2 }, connections: { auth: auth.value }, signal: second.signal, emit: secondEmit })!
    disposeFirst()
    const response = await h.post(githubWebhookPath(binding.automationId, binding.triggerId))
    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({ status: 'accepted', runId: 'new-run' })
    expect(firstEmit).not.toHaveBeenCalled()
    expect(secondEmit).toHaveBeenCalledOnce()
    second.abort()
    disposeSecond()
    auth.close()
  })
})
