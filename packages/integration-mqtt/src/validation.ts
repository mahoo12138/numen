import { MAX_JSON_BYTES } from '@numenjs/integration-data/json'

export type MqttErrorCode = 'MQTT_CONFIG_INVALID' | 'MQTT_CREDENTIAL_INVALID' | 'MQTT_CLIENT_ID_IN_USE' | 'MQTT_TOPIC_INVALID' | 'MQTT_PAYLOAD_INVALID' | 'MQTT_EVENT_ID_INVALID' | 'MQTT_UNAVAILABLE' | 'MQTT_LIMIT' | 'MQTT_TIMEOUT' | 'MQTT_ABORTED' | 'MQTT_PROTOCOL_ERROR'
const messages: Record<MqttErrorCode, string> = {
  MQTT_CONFIG_INVALID: 'MQTT requires a mqtt:// or mqtts:// broker URL without credentials, path, query or fragment and valid connection options.',
  MQTT_CREDENTIAL_INVALID: 'MQTT password authentication requires a username and password credential.',
  MQTT_CLIENT_ID_IN_USE: 'This MQTT client ID is already in use in this process.',
  MQTT_TOPIC_INVALID: 'MQTT topic or topic filter is invalid or unsupported.',
  MQTT_PAYLOAD_INVALID: 'MQTT payload must be valid UTF-8 and at most 1 MiB; JSON must be plain bounded JSON.',
  MQTT_EVENT_ID_INVALID: 'The configured MQTT event ID field must contain a nonblank string of at most 256 UTF-8 bytes.',
  MQTT_UNAVAILABLE: 'MQTT is not connected to the broker.',
  MQTT_LIMIT: 'MQTT has reached its subscription or pending operation limit.',
  MQTT_TIMEOUT: 'MQTT operation timed out; delivery may already have occurred.',
  MQTT_ABORTED: 'MQTT operation was cancelled; delivery may already have occurred.',
  MQTT_PROTOCOL_ERROR: 'MQTT broker operation failed; delivery may already have occurred.',
}

/** Never include broker errors, URLs, credentials, topics, or payload excerpts. */
export class MqttError extends Error {
  override name = 'MqttError'
  constructor(public readonly code: MqttErrorCode) { super(messages[code]) }
}

export interface MqttConnectionConfig { url: string; clientId?: string; timeoutMs?: number }
export interface MqttTriggerConfig { topicFilter: string; qos?: 0 | 1; format?: 'json' | 'text'; includeRetained?: boolean; eventIdField?: string }
export interface MqttPublishInput { topic: string; payload: string; qos?: 0 | 1; retain?: boolean }

function validString(value: unknown): value is string {
  return typeof value === 'string' && !/[\u0000\ud800-\udfff]/u.test(value)
}

export function validateTopic(value: unknown, filter: boolean): asserts value is string {
  if (!validString(value) || !value || Buffer.byteLength(value) > 65535 || value.startsWith('$share/') || value.startsWith('$queue/')) throw new MqttError('MQTT_TOPIC_INVALID')
  if (!filter) {
    if (/[+#]/.test(value)) throw new MqttError('MQTT_TOPIC_INVALID')
    return
  }
  const levels = value.split('/')
  for (let index = 0; index < levels.length; index++) {
    const level = levels[index]!
    if ((level.includes('+') && level !== '+') || (level.includes('#') && (level !== '#' || index !== levels.length - 1))) throw new MqttError('MQTT_TOPIC_INVALID')
  }
}

export function matchesTopic(filter: string, topic: string): boolean {
  if (topic.startsWith('$') && !filter.startsWith('$')) return false
  const filters = filter.split('/')
  const levels = topic.split('/')
  for (let index = 0; index < filters.length; index++) {
    const part = filters[index]!
    if (part === '#') return true
    if (index >= levels.length || (part !== '+' && part !== levels[index])) return false
  }
  return filters.length === levels.length
}

export function validateConnection(config: MqttConnectionConfig): { host: string; port: number; secure: boolean; timeoutMs: number } {
  let url: URL
  try { url = new URL(config.url) } catch { throw new MqttError('MQTT_CONFIG_INVALID') }
  const timeoutMs = config.timeoutMs ?? 10_000
  if (!['mqtt:', 'mqtts:'].includes(url.protocol) || !url.hostname || url.username || url.password || (url.pathname && url.pathname !== '/') || url.search || url.hash
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000
    || (config.clientId !== undefined && (!/^[A-Za-z0-9_-]{1,64}$/.test(config.clientId)))) throw new MqttError('MQTT_CONFIG_INVALID')
  const port = url.port ? Number(url.port) : url.protocol === 'mqtts:' ? 8883 : 1883
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new MqttError('MQTT_CONFIG_INVALID')
  return { host: url.hostname.replace(/^\[|\]$/g, ''), port, secure: url.protocol === 'mqtts:', timeoutMs }
}

export function validateTrigger(config: MqttTriggerConfig): Required<Omit<MqttTriggerConfig, 'eventIdField'>> & Pick<MqttTriggerConfig, 'eventIdField'> {
  validateTopic(config.topicFilter, true)
  const { qos = 1, format = 'json', includeRetained = false, eventIdField } = config
  if ((qos !== 0 && qos !== 1) || (format !== 'text' && format !== 'json') || typeof includeRetained !== 'boolean'
    || (eventIdField !== undefined && (format !== 'json' || typeof eventIdField !== 'string' || !eventIdField || Buffer.byteLength(eventIdField) > 256))) throw new MqttError('MQTT_CONFIG_INVALID')
  return { topicFilter: config.topicFilter, qos, format, includeRetained, ...(eventIdField === undefined ? {} : { eventIdField }) }
}

export function validatePublish(input: MqttPublishInput): { qos: 0 | 1; retain: boolean } {
  validateTopic(input.topic, false)
  if (typeof input.payload !== 'string' || /[\ud800-\udfff]/u.test(input.payload) || Buffer.byteLength(input.payload) > MAX_JSON_BYTES) throw new MqttError('MQTT_PAYLOAD_INVALID')
  const { qos = 1, retain = false } = input
  if ((qos !== 0 && qos !== 1) || typeof retain !== 'boolean') throw new MqttError('MQTT_CONFIG_INVALID')
  return { qos, retain }
}
