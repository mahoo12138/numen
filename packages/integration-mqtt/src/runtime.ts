import type { NumenValue, TriggerActivation } from '@numenjs/core'
import { MAX_JSON_BYTES, parsePlainJson } from '@numenjs/integration-data/json'
import { MqttClient, type IPublishPacket } from 'mqtt'
import { createHash } from 'node:crypto'
import { connect as connectTcp, isIP, type Socket } from 'node:net'
import { connect as connectTls } from 'node:tls'
import { matchesTopic, MqttError, validateConnection, validatePublish, validateTopic, validateTrigger, type MqttConnectionConfig, type MqttPublishInput, type MqttTriggerConfig } from './validation.js'

export interface MqttEvent { topic: string; payload: NumenValue; receivedAt: string; qos: 0 | 1; retained: boolean; eventId?: string }
export interface MqttRuntime {
  subscribe(activation: TriggerActivation<MqttEvent>): () => void
  publish(input: MqttPublishInput, signal: AbortSignal): Promise<{ published: true; qos: 0 | 1 }>
}

export const mqttLimits = Object.freeze({ maxPayloadBytes: MAX_JSON_BYTES, maxSubscriptions: 256, maxFilters: 128, maxPendingPublishes: 64, reconnectMinMs: 250, reconnectMaxMs: 30_000 })
const usedClientIds = new Set<string>()
type TriggerConfig = ReturnType<typeof validateTrigger>
interface Entry { activation: TriggerActivation<MqttEvent>; config: TriggerConfig; alive: boolean }
interface Group { filter: string; entries: Set<Entry>; qos: 0 | 1 }
interface Session { client: MqttClient; active: boolean; connected: boolean; pending: Set<(error: MqttError) => void>; subscribed: Map<string, 0 | 1>; controls: Set<string>; refresh: Set<string> }

/** Stop oversized packets as soon as the Remaining Length header arrives. */
function boundPackets(socket: Socket): void {
  let remaining = 0
  let headerBytes = -1
  let multiplier = 1
  let size = 0
  socket.prependListener('data', (chunk: Buffer) => {
    let offset = 0
    while (offset < chunk.length) {
      if (remaining > 0) {
        const count = Math.min(remaining, chunk.length - offset)
        remaining -= count; offset += count
        if (remaining === 0) headerBytes = -1
      } else if (headerBytes === -1) {
        const first = chunk[offset++]!
        // This Connection never subscribes at QoS 2; reject a violating broker.
        if ((first >> 4) === 3 && ((first >> 1) & 3) > 1) { socket.destroy(new MqttError('MQTT_PROTOCOL_ERROR')); return }
        headerBytes = 0; multiplier = 1; size = 0
      } else {
        const byte = chunk[offset++]!
        size += (byte & 127) * multiplier
        headerBytes++
        if (headerBytes > 4 || size > MAX_JSON_BYTES + 65539 || (headerBytes === 4 && (byte & 128))) { socket.destroy(new MqttError('MQTT_LIMIT')); return }
        if (byte & 128) multiplier *= 128
        else { remaining = size; if (!remaining) headerBytes = -1 }
      }
    }
  })
}

export function createMqttRuntime(connectionId: string, config: MqttConnectionConfig, signal: AbortSignal, credential?: { username: string; password: string }): { value: MqttRuntime; close(): void } {
  const address = validateConnection(config)
  const clientId = config.clientId ?? `numen${createHash('sha256').update(connectionId).digest('hex').slice(0, 18)}`
  if (usedClientIds.has(clientId)) throw new MqttError('MQTT_CLIENT_ID_IN_USE')
  if (signal.aborted) throw new MqttError('MQTT_ABORTED')
  usedClientIds.add(clientId)
  const groups = new Map<string, Group>()
  let subscriptionCount = 0
  let closed = false
  let current: Session | undefined
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let retryDelay: number = mqttLimits.reconnectMinMs
  let pendingPublishes = 0

  function active(session: Session): boolean { return !closed && !signal.aborted && current === session && session.active }
  function alive(entry: Entry): boolean { return !closed && entry.alive && !entry.activation.signal.aborted }
  function report(entry: Entry, state: 'READY' | 'ERROR'): void { if (alive(entry)) entry.activation.reportStatus?.(state) }
  function reportAll(state: 'READY' | 'ERROR'): void { for (const group of groups.values()) for (const entry of group.entries) report(entry, state) }
  function failSession(session: Session, error: MqttError): void {
    if (!session.active) return
    session.active = false
    session.connected = false
    for (const reject of [...session.pending]) reject(error)
    session.pending.clear()
    session.subscribed.clear(); session.controls.clear(); session.refresh.clear()
    reportAll('ERROR')
    // Fresh clients on reconnect avoid replaying timed-out/cancelled outgoing work.
    session.client.end(true)
    session.client.stream?.destroy()
    if (!closed && !signal.aborted && current === session && !retryTimer) {
      retryTimer = setTimeout(() => { retryTimer = undefined; connect() }, retryDelay)
      retryTimer.unref()
      retryDelay = Math.min(retryDelay * 2, mqttLimits.reconnectMaxMs)
    }
  }

  function syncFilter(filter: string, session: Session): void {
    if (!active(session) || !session.connected || session.controls.has(filter)) return
    const group = groups.get(filter)
    const remove = !group || session.refresh.has(filter)
    if (remove && !session.subscribed.has(filter)) { session.refresh.delete(filter); if (group) syncFilter(filter, session); return }
    if (!remove && session.subscribed.get(filter) === group.qos) { for (const entry of group.entries) report(entry, 'READY'); return }
    if (session.pending.size >= mqttLimits.maxFilters + mqttLimits.maxPendingPublishes) { failSession(session, new MqttError('MQTT_LIMIT')); return }
    session.controls.add(filter)
    const timer = setTimeout(() => failSession(session, new MqttError('MQTT_TIMEOUT')), address.timeoutMs)
    const cancel = () => clearTimeout(timer)
    session.pending.add(cancel)
    const finish = (error: boolean) => {
      clearTimeout(timer); session.pending.delete(cancel)
      if (!active(session)) return
      session.controls.delete(filter)
      if (error) { failSession(session, new MqttError('MQTT_PROTOCOL_ERROR')); return }
      syncFilter(filter, session)
    }
    if (remove) {
      session.client.unsubscribe(filter, error => {
        session.subscribed.delete(filter); session.refresh.delete(filter)
        finish(!!error)
      })
    } else {
      const requestedQos = group.qos
      session.client.subscribe(filter, { qos: requestedQos }, (error, grants) => {
        if (!error && grants?.length === 1 && grants[0]!.qos <= requestedQos) {
          session.subscribed.set(filter, requestedQos)
          finish(false)
        } else finish(true)
      })
    }
  }

  async function deliver(session: Session, entry: Entry, packet: IPublishPacket, receivedAt: string): Promise<void> {
    if (!active(session) || !alive(entry) || (packet.retain && !entry.config.includeRetained)) return
    let payload: NumenValue
    let eventId: string | undefined
    try {
      validateTopic(packet.topic, false)
      if (packet.payload.length > MAX_JSON_BYTES) throw new MqttError('MQTT_PAYLOAD_INVALID')
      const text = new TextDecoder('utf-8', { fatal: true }).decode(packet.payload as Buffer)
      payload = entry.config.format === 'json' ? parsePlainJson(text, entry.activation.signal) : text
      if (entry.config.eventIdField !== undefined) {
        const candidate = payload && typeof payload === 'object' && !Array.isArray(payload) && Object.hasOwn(payload, entry.config.eventIdField)
          ? (payload as Record<string, NumenValue>)[entry.config.eventIdField] : undefined
        if (typeof candidate !== 'string' || !candidate.trim() || Buffer.byteLength(candidate) > 256) throw new MqttError('MQTT_EVENT_ID_INVALID')
        eventId = candidate
      }
    } catch {
      // Invalid external messages are intentionally dropped and acknowledged.
      report(entry, 'ERROR')
      return
    }
    if (!active(session) || !alive(entry)) return
    const result = await entry.activation.emit({ data: { topic: packet.topic, payload, receivedAt, qos: packet.qos as 0 | 1, retained: !!packet.retain, ...(eventId === undefined ? {} : { eventId }) }, occurredAt: receivedAt, ...(eventId === undefined ? {} : { eventId }) })
    // MQTT permits PUBLISH before SUBACK; accepting such a live message must
    // not advertise a subscription as healthy before the broker grants it.
    if (result.status !== 'stale' && active(session) && session.subscribed.has(entry.config.topicFilter) && !session.refresh.has(entry.config.topicFilter)) report(entry, 'READY')
  }

  function connect(): void {
    if (closed || signal.aborted) return
    const client = new MqttClient(() => {
      const socket = address.secure
        ? connectTls({ host: address.host, port: address.port, rejectUnauthorized: true, ...(!isIP(address.host) ? { servername: address.host } : {}) })
        : connectTcp({ host: address.host, port: address.port })
      boundPackets(socket)
      return socket
    }, { clientId, protocolVersion: 4, clean: true, reconnectPeriod: 0, resubscribe: false, queueQoSZero: false, manualConnect: true, connectTimeout: address.timeoutMs, keepalive: 30, log: () => {}, ...(credential ?? {}) })
    const session: Session = { client, active: true, connected: false, pending: new Set(), subscribed: new Map(), controls: new Set(), refresh: new Set() }
    current = session
    client.on('connect', () => {
      if (!active(session)) return
      session.connected = true
      retryDelay = mqttLimits.reconnectMinMs
      for (const filter of groups.keys()) syncFilter(filter, session)
    })
    client.on('error', () => failSession(session, new MqttError('MQTT_PROTOCOL_ERROR')))
    client.on('close', () => failSession(session, new MqttError('MQTT_UNAVAILABLE')))
    client.handleMessage = (packet, done) => {
      if (!active(session)) { done(new MqttError('MQTT_UNAVAILABLE')); return }
      // Capture entry identities once; a later activation cannot receive this packet.
      const entries = [...groups.values()].filter(group => matchesTopic(group.filter, packet.topic)).flatMap(group => [...group.entries])
      const receivedAt = new Date().toISOString()
      let completed = false
      const finish = (error?: MqttError) => {
        if (completed) return
        completed = true; clearTimeout(timer); session.pending.delete(cancel)
        done(error)
      }
      const cancel = (error: MqttError) => finish(error)
      const timer = setTimeout(() => failSession(session, new MqttError('MQTT_TIMEOUT')), address.timeoutMs)
      session.pending.add(cancel)
      // MQTT.js 5.16.1 sends QoS 1 PUBACK only after this callback succeeds.
      Promise.all(entries.map(entry => deliver(session, entry, packet, receivedAt))).then(() => {
        if (active(session)) finish()
        else finish(new MqttError('MQTT_UNAVAILABLE'))
      }, () => failSession(session, new MqttError('MQTT_PROTOCOL_ERROR')))
    }
    client.connect()
  }

  function close(): void {
    if (closed) return
    closed = true
    signal.removeEventListener('abort', close)
    if (retryTimer) clearTimeout(retryTimer)
    retryTimer = undefined
    if (current) failSession(current, new MqttError('MQTT_ABORTED'))
    for (const group of groups.values()) for (const entry of group.entries) entry.alive = false
    groups.clear()
    usedClientIds.delete(clientId)
  }

  const value: MqttRuntime = {
    subscribe(activation) {
      if (closed || signal.aborted || activation.signal.aborted) throw new MqttError('MQTT_UNAVAILABLE')
      const config = validateTrigger(activation.binding.config as unknown as MqttTriggerConfig)
      let group = groups.get(config.topicFilter)
      if (subscriptionCount >= mqttLimits.maxSubscriptions || (!group && groups.size >= mqttLimits.maxFilters)) throw new MqttError('MQTT_LIMIT')
      if (!group) { group = { filter: config.topicFilter, qos: config.qos, entries: new Set() }; groups.set(config.topicFilter, group) }
      const entry: Entry = { activation, config, alive: true }
      group.entries.add(entry); subscriptionCount++
      group.qos = Math.max(...[...group.entries].map(item => item.config.qos)) as 0 | 1
      report(entry, 'ERROR')
      if (current) syncFilter(group.filter, current)
      const release = () => {
        if (!entry.alive) return
        entry.alive = false; subscriptionCount--
        activation.signal.removeEventListener('abort', release)
        group!.entries.delete(entry)
        if (group!.entries.size) {
          group!.qos = Math.max(...[...group!.entries].map(item => item.config.qos)) as 0 | 1
          if (current) syncFilter(group!.filter, current)
        } else {
          groups.delete(config.topicFilter)
          if (current) { current.refresh.add(config.topicFilter); syncFilter(config.topicFilter, current) }
        }
      }
      activation.signal.addEventListener('abort', release, { once: true })
      return release
    },
    async publish(input, publishSignal) {
      const { qos, retain } = validatePublish(input)
      if (publishSignal.aborted) throw new MqttError('MQTT_ABORTED')
      const session = current
      if (!session || !active(session) || !session.connected) throw new MqttError('MQTT_UNAVAILABLE')
      if (pendingPublishes >= mqttLimits.maxPendingPublishes) throw new MqttError('MQTT_LIMIT')
      pendingPublishes++
      return new Promise((resolve, reject) => {
        let finished = false
        const finish = (error?: MqttError) => {
          if (finished) return
          finished = true; clearTimeout(timer); publishSignal.removeEventListener('abort', abort); session.pending.delete(cancel); pendingPublishes--
          if (error) reject(error); else resolve({ published: true, qos })
        }
        const cancel = (error: MqttError) => finish(error)
        const abort = () => failSession(session, new MqttError('MQTT_ABORTED'))
        const timer = setTimeout(() => failSession(session, new MqttError('MQTT_TIMEOUT')), address.timeoutMs)
        session.pending.add(cancel)
        publishSignal.addEventListener('abort', abort, { once: true })
        try { session.client.publish(input.topic, input.payload, { qos, retain }, error => finish(error ? new MqttError('MQTT_PROTOCOL_ERROR') : undefined)) }
        catch { failSession(session, new MqttError('MQTT_PROTOCOL_ERROR')) }
      })
    },
  }
  signal.addEventListener('abort', close, { once: true })
  try { connect() } catch { close(); throw new MqttError('MQTT_PROTOCOL_ERROR') }
  return { value, close }
}
