import { AutomationService } from '@numenjs/automation'
import { ConnectionService } from '@numenjs/connections'
import { CapabilityRegistry, type NumenValue, type TriggerActivation } from '@numenjs/core'
import { CredentialService } from '@numenjs/credentials'
import { DatabaseService } from '@numenjs/database'
import { LoggingService } from '@numenjs/logging'
import { ResourceService } from '@numenjs/resources'
import { SchedulerService } from '@numenjs/scheduler'
import { TriggerService } from '@numenjs/triggers'
import { Context } from 'cordis'
import { randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer as createTlsServer } from 'node:tls'
import { afterEach, describe, expect, it, vi } from 'vitest'
import mqttIntegrationPlugin, { mqttAnonymousAdapter, mqttMessageTrigger, mqttPasswordAdapter, mqttPasswordCredential, mqttPublishAction, type MqttEvent, type MqttRuntime } from '../src/index.js'
import { matchesTopic, validateConnection, validateTopic } from '../src/validation.js'
import { startMqttFixture } from './fixture.js'

const cleanups: Array<() => Promise<void>> = []
const directories: string[] = []
const masterKeyEnv = 'NUMEN_MQTT_TEST_KEY'
afterEach(async () => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  for (const directory of directories.splice(0)) await rm(directory, { force: true, recursive: true })
  delete process.env[masterKeyEnv]
})

async function broker(options?: Parameters<typeof startMqttFixture>[0]) {
  const fixture = await startMqttFixture(options)
  cleanups.push(fixture.close)
  return fixture
}
async function harness(directory?: string) {
  directory ??= await mkdtemp(join(tmpdir(), 'numen-mqtt-'))
  if (!directories.includes(directory)) directories.push(directory)
  process.env[masterKeyEnv] ??= randomBytes(32).toString('base64')
  const root = new Context()
  await root.plugin(LoggingService, { console: false })
  await root.plugin(DatabaseService, { path: join(directory, 'numen.db') })
  await root.plugin(CapabilityRegistry)
  await root.plugin(CredentialService, { masterKeyEnv })
  await root.plugin(ConnectionService)
  const plugin = await root.plugin(mqttIntegrationPlugin)
  await root.plugin(AutomationService)
  await root.plugin(ResourceService, { path: join(directory, 'resources') })
  await root.plugin(SchedulerService, { autoDispatch: false })
  await root.plugin(TriggerService)
  let stopped = false
  const stop = async () => { if (stopped) return; stopped = true; await root.fiber.dispose() }
  cleanups.push(stop)
  return { root, directory, plugin, stop }
}
type Harness = Awaited<ReturnType<typeof harness>>
type Broker = Awaited<ReturnType<typeof broker>>
async function connection(h: Harness, b: Broker, options: { anonymous?: boolean; timeoutMs?: number; clientId?: string } = {}) {
  const credential = options.anonymous ? undefined : h.root.credentials.create('MQTT test password', mqttPasswordCredential, b.credential)
  const connection = h.root.connections.create({ name: 'MQTT broker', adapter: options.anonymous ? mqttAnonymousAdapter : mqttPasswordAdapter,
    config: { url: b.url, timeoutMs: options.timeoutMs ?? 1000, ...(options.clientId ? { clientId: options.clientId } : {}) }, ...(credential ? { credentialId: credential.id } : {}), enabled: true })
  await h.root.connections.reconcile()
  expect(h.root.connections.getRuntimeState(connection.id).status).toBe('READY')
  const runtime = h.root.connections.resolveRuntimes({ client: connection.id }, mqttPublishAction.connections).client as MqttRuntime
  return { connection, credential, runtime }
}
function automation(h: Harness, connectionId: string, configs: Array<Record<string, NumenValue>> = [{ topicFilter: 'events/#' }]) {
  const { automation } = h.root.automations.create({ name: 'MQTT receiver', source: {
    triggers: configs.map((config, index) => ({ id: `message${index}`, capability: mqttMessageTrigger, config, connections: { client: connectionId } })),
    flow: { type: 'block', id: 'flow', steps: [] },
  } })
  const revision = h.root.automations.publishDraft(automation.id, 1)
  h.root.automations.activateRevision(automation.id, revision.id)
  h.root.automations.setEnabled(automation.id, true)
  return automation
}
async function ready(h: Harness, id: string) { await vi.waitFor(() => expect(h.root.triggers.automationHealth(id)?.status).toBe('READY'), { timeout: 6000, interval: 10 }) }
async function count(h: Harness, number: number) { await vi.waitFor(() => expect(h.root.scheduler.listRuns(100)).toHaveLength(number), { interval: 10 }) }
const tick = (ms = 40) => new Promise<void>(resolve => setTimeout(resolve, ms))

describe('MQTT official integration with real broker and SQLite', () => {
  it('routes overlapping and separate filters, waits for durable acceptance before QoS1 ACK, and executes Runs', async () => {
    const b = await broker()
    const h = await harness()
    const c = await connection(h, b)
    const provider = h.root.capabilities.resolveTriggerProvider<MqttEvent>(mqttMessageTrigger)!
    const original = provider.activate.bind(provider)
    let resume!: () => void
    const held = new Promise<void>(resolve => { resume = resolve })
    let entered = 0
    vi.spyOn(provider, 'activate').mockImplementation(activation => original({ ...activation, async emit(event) { entered++; await held; return activation.emit(event) } }))
    const a = automation(h, c.connection.id, [{ topicFilter: 'events/+' }, { topicFilter: 'events/#' }, { topicFilter: 'other/#' }])
    await ready(h, a.id)
    const acks: number[] = []
    b.broker.on('ack', () => { acks.push(h.root.scheduler.listRuns().length) })
    await b.publish('events/new', '{"value":42}')
    await vi.waitFor(() => expect(entered).toBe(2))
    expect(h.root.scheduler.listRuns()).toHaveLength(0)
    expect(acks).toEqual([])
    resume()
    await count(h, 2)
    await vi.waitFor(() => expect(acks.length).toBeGreaterThan(0))
    expect(acks.every(value => value === 2)).toBe(true)
    expect(h.root.scheduler.listRuns()[0]!.trigger).toEqual({ topic: 'events/new', payload: { value: 42 }, receivedAt: expect.any(String), qos: 1, retained: false })
    await h.root.scheduler.dispatchUntilIdle()
    expect(h.root.scheduler.listRuns().every(run => run.status === 'COMPLETED')).toBe(true)
  })

  it('deduplicates concurrent business IDs per trigger across runtime restart without inventing IDs for unkeyed messages', async () => {
    const b = await broker()
    let h = await harness()
    const c = await connection(h, b)
    const a = automation(h, c.connection.id, [{ topicFilter: 'events/keyed', eventIdField: 'id' }, { topicFilter: 'events/unkeyed' }])
    await ready(h, a.id)
    await Promise.all(Array.from({ length: 12 }, () => b.publish('events/keyed', '{"id":"same","value":1}')))
    await count(h, 1)
    await tick(100)
    expect(h.root.scheduler.listRuns()).toHaveLength(1)
    await h.stop()
    h = await harness(h.directory)
    await ready(h, a.id)
    await b.publish('events/keyed', '{"id":"same","value":"changed"}')
    await b.publish('events/unkeyed', '{}')
    await b.publish('events/unkeyed', '{}')
    await count(h, 3)
  })

  it('rejects unsafe, malformed, oversized JSON and invalid event IDs while another trigger continues to receive text', async () => {
    const b = await broker()
    const h = await harness()
    const c = await connection(h, b)
    const a = automation(h, c.connection.id, [{ topicFilter: 'events/json', eventIdField: 'id' }, { topicFilter: 'events/text', format: 'text' }])
    await ready(h, a.id)
    const invalid = ['{', '{"id":"x","nested":{"$resource":"private-id"}}}', '{"id":3}', '{"id":""}', '{}', '{"id":"x","v":' + '['.repeat(65) + '0' + ']'.repeat(65) + '}', JSON.stringify({ id: 'x', v: new Array(10001).fill(0) }), 'x'.repeat(1048577)]
    for (const payload of invalid) await b.publish('events/json', payload)
    await b.publish('events/json', Buffer.from([0xff]))
    await b.publish('events/text', 'raw text\u0000')
    await count(h, 1)
    expect(h.root.scheduler.listRuns()[0]!.trigger).toMatchObject({ payload: 'raw text\u0000' })
    expect(h.root.triggers.automationHealth(a.id)?.status).toBe('WAITING')
    await b.publish('events/json', '{"id":"valid","__proto__":{"safe":true}}')
    await count(h, 2)
    await ready(h, a.id)
    const snapshot = JSON.stringify({ runs: h.root.scheduler.listRuns(), logs: h.root.logs.query({}).records, credentials: h.root.credentials.list() })
    expect(snapshot).not.toContain(b.credential.password)
    expect(snapshot).not.toContain('private-id')
  })

  it('ignores retained snapshots by default, permits explicit retained JSON null, and accepts QoS0 text', async () => {
    const b = await broker({ anonymous: true })
    await b.publish('events/snapshot', 'null', { retain: true })
    const h = await harness()
    const c = await connection(h, b, { anonymous: true })
    const a = automation(h, c.connection.id, [{ topicFilter: 'events/snapshot' }, { topicFilter: 'events/snapshot', includeRetained: true }, { topicFilter: 'text', qos: 0, format: 'text' }])
    await ready(h, a.id)
    await count(h, 1)
    expect(h.root.scheduler.listRuns()[0]!.trigger).toMatchObject({ payload: null, retained: true })
    await b.publish('text', '', { qos: 0 })
    await count(h, 2)
    expect(h.root.scheduler.listRuns().find(run => (run.trigger as MqttEvent).topic === 'text')?.trigger).toMatchObject({ payload: '', qos: 0 })
  })

  it('recovers from disconnection and credential rotation, fences old runtimes, and stops all work on plugin unload', async () => {
    const b = await broker()
    const h = await harness()
    const c = await connection(h, b)
    const a = automation(h, c.connection.id)
    await ready(h, a.id)
    await b.stop()
    await vi.waitFor(() => expect(h.root.triggers.automationHealth(a.id)?.status).toBe('WAITING'))
    await expect(c.runtime.publish({ topic: 'events/test', payload: '{}' }, new AbortController().signal)).rejects.toMatchObject({ code: 'MQTT_UNAVAILABLE' })
    await b.start()
    await ready(h, a.id)
    await b.publish('events/resumed', '{}')
    await count(h, 1)
    b.credential.password = 'rotated-private-password'
    h.root.credentials.rotate(c.credential!.id, c.credential!.secretVersion, b.credential)
    await h.root.connections.reconcile()
    await ready(h, a.id)
    await expect(c.runtime.publish({ topic: 'events/test', payload: '{}' }, new AbortController().signal)).rejects.toMatchObject({ code: 'MQTT_UNAVAILABLE' })
    await b.publish('events/rotated', '{}')
    await count(h, 2)
    await h.plugin.dispose()
    await vi.waitFor(() => expect(b.broker.connectedClients).toBe(0))
    await b.publish('events/unloaded', '{}')
    await tick(400)
    expect(b.broker.connectedClients).toBe(0)
    expect(h.root.scheduler.listRuns()).toHaveLength(2)
    await h.root.plugin(mqttIntegrationPlugin)
    await h.root.connections.reconcile()
    await ready(h, a.id)
    await b.publish('events/reloaded', '{}')
    await count(h, 3)
  })

  it('fences a disabled in-flight activation without re-routing the held packet to the replacement activation', async () => {
    const b = await broker()
    const h = await harness()
    const c = await connection(h, b)
    const provider = h.root.capabilities.resolveTriggerProvider<MqttEvent>(mqttMessageTrigger)!
    const original = provider.activate.bind(provider)
    let resume!: () => void
    let entered = false
    const gate = new Promise<void>(resolve => { resume = resolve })
    vi.spyOn(provider, 'activate').mockImplementation(activation => original({ ...activation, async emit(event) { entered = true; await gate; return activation.emit(event) } }))
    const a = automation(h, c.connection.id)
    await ready(h, a.id)
    await b.publish('events/old', '{}')
    await vi.waitFor(() => expect(entered).toBe(true))
    h.root.automations.setEnabled(a.id, false)
    h.root.automations.setEnabled(a.id, true)
    resume()
    await ready(h, a.id)
    await b.publish('events/new', '{}')
    await count(h, 1)
    expect(h.root.scheduler.listRuns()[0]!.trigger).toMatchObject({ topic: 'events/new' })
  })

  it('does not ACK storage failure, retries network subscription, and acknowledges after a successful retry', async () => {
    const b = await broker()
    const h = await harness()
    const c = await connection(h, b)
    const a = automation(h, c.connection.id)
    await ready(h, a.id)
    let failedAcks = 0
    const onAck = () => { failedAcks++ }
    b.broker.on('ack', onAck)
    const accept = vi.spyOn(h.root.scheduler, 'acceptTrigger').mockImplementationOnce(() => { throw new Error('private database failure') })
    await b.publish('events/failure', '{}')
    await vi.waitFor(() => expect(accept).toHaveBeenCalled())
    expect(h.root.scheduler.listRuns()).toHaveLength(0)
    expect(failedAcks).toBe(0)
    await ready(h, a.id)
    b.broker.removeListener('ack', onAck)
    await b.publish('events/retry', '{}')
    await count(h, 1)
    expect(failedAcks).toBe(0)
  })

  it('keeps rejected broker authentication/subscriptions unavailable and recovers when allowed', async () => {
    const b = await broker()
    let permitted = false
    b.broker.authorizeSubscribe = (_client, subscription, callback) => callback(null, permitted ? subscription : null)
    const h = await harness()
    const c = await connection(h, b)
    const a = automation(h, c.connection.id)
    await tick(100)
    expect(h.root.triggers.automationHealth(a.id)?.status).toBe('WAITING')
    permitted = true
    await ready(h, a.id)
    await b.publish('events/ok', '{}')
    await count(h, 1)
    b.credential.password = 'new-password'
    await b.restart()
    await vi.waitFor(() => expect(h.root.triggers.automationHealth(a.id)?.status).toBe('WAITING'))
    await tick(350)
    expect(h.root.triggers.automationHealth(a.id)?.status).toBe('WAITING')
    h.root.credentials.rotate(c.credential!.id, 1, b.credential)
    await h.root.connections.reconcile()
    await ready(h, a.id)
  })

  it('publishes through the action provider, preserves metadata, rejects denied writes and never exposes broker errors', async () => {
    const b = await broker()
    const h = await harness()
    const c = await connection(h, b)
    const a = automation(h, c.connection.id)
    await ready(h, a.id)
    const action = h.root.capabilities.resolveProvider(mqttPublishAction)!
    const bindings = h.root.connections.resolveRuntimes({ client: c.connection.id }, mqttPublishAction.connections)
    await expect(action.invoke({ input: { topic: 'events/published', payload: '{"published":true}' }, connections: bindings, signal: new AbortController().signal })).resolves.toEqual({ published: true, qos: 1 })
    await count(h, 1)
    b.broker.authorizePublish = (_client, _packet, callback) => callback(new Error('sensitive broker password'))
    await expect(c.runtime.publish({ topic: 'events/denied', payload: 'private payload' }, new AbortController().signal)).rejects.toMatchObject({ code: 'MQTT_UNAVAILABLE' })
    expect(mqttPublishAction.semantics).toMatchObject({ sideEffect: true, idempotent: false, retrySafe: false })
    expect(JSON.stringify(h.root.logs.query({}).records)).not.toContain('sensitive broker password')
  })

  it('accepts the exact UTF-8 payload boundary and rejects oversized publishes before any broker write', async () => {
    const b = await broker()
    const h = await harness()
    const c = await connection(h, b)
    const a = automation(h, c.connection.id, [{ topicFilter: 'bytes', format: 'text' }])
    await ready(h, a.id)
    const payload = '😀'.repeat(1048576 / 4)
    await expect(c.runtime.publish({ topic: 'bytes', payload }, new AbortController().signal)).resolves.toEqual({ published: true, qos: 1 })
    await count(h, 1)
    expect((h.root.scheduler.listRuns()[0]!.trigger as MqttEvent).payload).toBe(payload)
    await expect(c.runtime.publish({ topic: 'bytes', payload: payload + 'x' }, new AbortController().signal)).rejects.toMatchObject({ code: 'MQTT_PAYLOAD_INVALID' })
    await expect(c.runtime.publish({ topic: 'bytes', payload: '\ud800' }, new AbortController().signal)).rejects.toMatchObject({ code: 'MQTT_PAYLOAD_INVALID' })
    await expect(c.runtime.publish({ topic: 'bytes', payload: '', qos: 0 }, new AbortController().signal)).resolves.toEqual({ published: true, qos: 0 })
    await count(h, 2)
  })

  it('bounds pending publishes, times out missing PUBACK, aborts in-flight work, and never replays it on reconnect', async () => {
    const b = await broker()
    const h = await harness()
    const c = await connection(h, b, { timeoutMs: 150 })
    const a = automation(h, c.connection.id)
    await ready(h, a.id)
    let incoming = 0
    b.broker.authorizePublish = () => { incoming++ }
    const pending = Array.from({ length: 64 }, () => c.runtime.publish({ topic: 'blocked', payload: 'private' }, new AbortController().signal).catch(error => error))
    await expect(c.runtime.publish({ topic: 'blocked', payload: 'overflow' }, new AbortController().signal)).rejects.toMatchObject({ code: 'MQTT_LIMIT' })
    const errors = await Promise.all(pending)
    expect(errors.every(error => error.code === 'MQTT_TIMEOUT')).toBe(true)
    await ready(h, a.id)
    const prior = incoming
    await tick(50)
    expect(incoming).toBe(prior)
    const controller = new AbortController()
    const operation = c.runtime.publish({ topic: 'blocked', payload: 'cancelled' }, controller.signal)
    const rejected = expect(operation).rejects.toMatchObject({ code: 'MQTT_ABORTED' })
    await vi.waitFor(() => expect(incoming).toBeGreaterThan(prior))
    controller.abort()
    await rejected
    await ready(h, a.id)
    const after = incoming
    await tick(50)
    expect(incoming).toBe(after)
    expect(h.root.scheduler.listRuns()).toHaveLength(0)
  })

  it('requires explicit authentication, rejects duplicate stable client IDs and accepts only supported topics and URLs', async () => {
    const b = await broker()
    const h = await harness()
    expect(() => h.root.connections.create({ name: 'Missing password', adapter: mqttPasswordAdapter, config: { url: b.url }, enabled: true })).toThrow()
    const c = await connection(h, b, { clientId: 'unique-test-client' })
    const duplicate = h.root.connections.create({ name: 'Duplicate', adapter: mqttPasswordAdapter, config: { url: b.url, clientId: 'unique-test-client' }, credentialId: c.credential!.id, enabled: true })
    await h.root.connections.reconcile()
    expect(h.root.connections.getRuntimeState(duplicate.id)).toMatchObject({ status: 'ERROR', error: expect.stringContaining('already in use') })
    for (const url of ['https://broker', 'ws://broker', 'mqtt://user:private@broker', 'mqtt://broker?clientId=other', 'mqtt://broker/topic', 'mqtt://broker#x']) expect(() => validateConnection({ url })).toThrow()
    expect(validateConnection({ url: 'mqtts://broker.example' })).toMatchObject({ secure: true, port: 8883 })
    for (const topic of ['', 'a/#/b', 'a+', 'a/+b', '$share/group/a', 'a\u0000']) expect(() => validateTopic(topic, true)).toThrow()
    expect(() => validateTopic('a/+', false)).toThrow()
    expect(matchesTopic('a/#', 'a')).toBe(true)
    expect(matchesTopic('+/b', '/b')).toBe(true)
    expect(matchesTopic('#', '$SYS/status')).toBe(false)
    expect(matchesTopic('$SYS/#', '$SYS/status')).toBe(true)
  })

  it('keeps a second subscription live when the first is removed and rejects invalid trigger filters', async () => {
    const b = await broker()
    const h = await harness()
    const c = await connection(h, b)
    const first = automation(h, c.connection.id, [{ topicFilter: 'first/#' }])
    const second = automation(h, c.connection.id, [{ topicFilter: 'second/#' }])
    await ready(h, first.id); await ready(h, second.id)
    let disconnects = 0
    b.broker.on('clientDisconnect', () => disconnects++)
    h.root.automations.setEnabled(first.id, false)
    await b.publish('first/ignored', '{}')
    await b.publish('second/live', '{}')
    await count(h, 1)
    expect(disconnects).toBe(0)
    expect(h.root.scheduler.listRuns()[0]!.automationId).toBe(second.id)
    const invalid = automation(h, c.connection.id, [{ topicFilter: 'wrong/#/suffix' }])
    expect(h.root.triggers.automationHealth(invalid.id)?.status).toBe('WAITING')
    await b.publish('second/also-live', '{}')
    await count(h, 2)
  })

  it('enforces distinct-filter and total-subscription bounds and makes released capacity reusable', async () => {
    const b = await broker()
    const h = await harness()
    const c = await connection(h, b)
    let sequence = 0
    const subscribe = (topicFilter: string) => {
      const controller = new AbortController()
      const activation: TriggerActivation<MqttEvent> = {
        binding: { automationId: 'limit-test', revisionId: 'revision', activationGeneration: 0, triggerId: `t${sequence++}`, capability: mqttMessageTrigger, config: { topicFilter }, connectionIds: { client: c.connection.id } },
        connections: { client: c.runtime }, signal: controller.signal, emit: async () => ({ status: 'accepted' }),
      }
      const release = c.runtime.subscribe(activation)
      return () => { controller.abort(); release() }
    }
    const filters = Array.from({ length: 128 }, (_, index) => subscribe(`limit/${index}`))
    expect(() => subscribe('overflow')).toThrowError(expect.objectContaining({ code: 'MQTT_LIMIT' }))
    filters.pop()!()
    const replacement = subscribe('replacement')
    replacement()
    for (const release of filters) release()
    const entries = Array.from({ length: 256 }, () => subscribe('shared'))
    expect(() => subscribe('shared')).toThrowError(expect.objectContaining({ code: 'MQTT_LIMIT' }))
    entries.pop()!()
    const last = subscribe('shared')
    last()
    for (const release of entries) release()
    const a = automation(h, c.connection.id)
    await ready(h, a.id)
    await b.publish('events/after-capacity', '{}')
    await count(h, 1)
  })

  it('reports a missing SUBACK as unavailable and recovers with a fresh subscription', async () => {
    const b = await broker()
    let release: (() => void) | undefined
    let allowed = false
    b.broker.authorizeSubscribe = (_client, subscription, callback) => {
      if (allowed) callback(null, subscription)
      else release = () => callback(null, subscription)
    }
    const h = await harness()
    const c = await connection(h, b, { timeoutMs: 100 })
    const a = automation(h, c.connection.id)
    await vi.waitFor(() => expect(release).toBeDefined())
    expect(h.root.triggers.automationHealth(a.id)?.status).toBe('WAITING')
    await tick(150)
    expect(h.root.triggers.automationHealth(a.id)?.status).toBe('WAITING')
    allowed = true
    release?.()
    await ready(h, a.id)
    await b.publish('events/ready', '{}')
    await count(h, 1)
  })

  it('does not let a received message report READY before the corresponding SUBACK', async () => {
    const b = await broker()
    const h = await harness()
    const c = await connection(h, b)
    const first = automation(h, c.connection.id)
    await ready(h, first.id)
    let grant!: () => void
    b.broker.authorizeSubscribe = (_client, subscription, callback) => { grant = () => callback(null, subscription) }
    const second = automation(h, c.connection.id, [{ topicFilter: 'events/+' }])
    await vi.waitFor(() => expect(grant).toBeDefined())
    // The existing broad subscription supplies a live matching message while
    // the second filter is waiting for its own broker grant.
    await b.publish('events/before-grant', '{}')
    await count(h, 2)
    expect(h.root.triggers.automationHealth(second.id)?.status).toBe('WAITING')
    grant()
    await ready(h, second.id)
  })

  it('closes an oversized MQTT frame from its header before reading the advertised body, then reconnects', async () => {
    const b = await broker()
    const h = await harness()
    const c = await connection(h, b)
    const a = automation(h, c.connection.id)
    await ready(h, a.id)
    const client = Object.values(b.broker.clients)[0]!
    // PUBLISH declares a 268435455-byte body; no actual payload is allocated.
    client.conn.write(Buffer.from([0x30, 0xff, 0xff, 0xff, 0x7f]))
    await vi.waitFor(() => expect(h.root.triggers.automationHealth(a.id)?.status).toBe('WAITING'))
    expect(h.root.scheduler.listRuns()).toHaveLength(0)
    await ready(h, a.id)
    await b.publish('events/after-frame', '{}')
    await count(h, 1)
  })

  it('rejects an untrusted TLS certificate without an insecure fallback or credential leak', async () => {
    const [key, cert] = await Promise.all([
      readFile(new URL('./fixtures/localhost-key.pem', import.meta.url)),
      readFile(new URL('./fixtures/localhost-cert.pem', import.meta.url)),
    ])
    const server = createTlsServer({ key, cert })
    let failures = 0
    server.on('tlsClientError', () => { failures++ })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
    const h = await harness()
    const port = (server.address() as { port: number }).port
    const c = h.root.connections.create({ name: 'Self-signed broker', adapter: mqttAnonymousAdapter, config: { url: `mqtts://127.0.0.1:${port}`, timeoutMs: 100 }, enabled: true })
    await h.root.connections.reconcile()
    const a = automation(h, c.id)
    await vi.waitFor(() => expect(failures).toBeGreaterThan(0))
    expect(h.root.triggers.automationHealth(a.id)?.status).toBe('WAITING')
    expect(h.root.scheduler.listRuns()).toHaveLength(0)
  })
})
