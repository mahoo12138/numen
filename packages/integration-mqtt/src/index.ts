import { defineCapability, type CapabilityProvider, type TriggerProvider } from '@numenjs/core'
import type { ConnectionAdapterDefinition, ConnectionTypeDefinition } from '@numenjs/connections'
import type { CredentialTypeDefinition } from '@numenjs/credentials'
import type { Context } from 'cordis'
import type Schema from 'schemastery'
import z from 'schemastery'
import { createMqttRuntime, type MqttEvent, type MqttRuntime } from './runtime.js'
import { MqttError, type MqttConnectionConfig, type MqttPublishInput, type MqttTriggerConfig } from './validation.js'

export { MqttError, type MqttConnectionConfig, type MqttPublishInput, type MqttTriggerConfig } from './validation.js'
export { mqttLimits, type MqttEvent, type MqttRuntime } from './runtime.js'

export const mqttPasswordCredential: CredentialTypeDefinition = {
  id: 'mqtt:password', version: 1, title: 'MQTT Username and Password',
  secret: z.object({ username: z.string().max(65535).required(), password: z.string().max(65535).role('secret').required() }),
}
export const mqttClientConnectionType: ConnectionTypeDefinition<MqttRuntime> = { id: 'mqtt:client', version: 1, title: 'MQTT Client' }
const connectionConfig = z.object({
  url: z.string().required().description('mqtt://host:1883 or mqtts://host:8883. TLS certificates are always verified. Put credentials in a Credential, never in the URL.'),
  clientId: z.string().pattern(/^[A-Za-z0-9_-]{1,64}$/).description('Optional stable, unique broker client ID. Defaults to a stable ID derived from this Connection; replicas must use distinct Connections/IDs.'),
  timeoutMs: z.natural().min(100).max(60000).default(10000).role('ms').description('Connection, subscription, delivery acceptance and publish timeout.'),
}) as Schema<MqttConnectionConfig>
export const mqttPasswordAdapter: ConnectionAdapterDefinition<MqttConnectionConfig, MqttRuntime> = {
  id: 'mqtt:password', version: 1, title: 'MQTT Password Authentication', type: mqttClientConnectionType, credentialType: mqttPasswordCredential.id, config: connectionConfig,
}
export const mqttAnonymousAdapter: ConnectionAdapterDefinition<MqttConnectionConfig, MqttRuntime> = {
  id: 'mqtt:anonymous', version: 1, title: 'MQTT Explicit Anonymous Access', type: mqttClientConnectionType, config: connectionConfig,
}
const connectionSlots = [{ name: 'client', required: true, accepts: ['mqtt:client@1'] }]

export const mqttMessageTrigger = defineCapability<MqttTriggerConfig, MqttEvent>({
  id: 'mqtt:message', version: 1, kind: 'trigger', title: 'MQTT Message',
  description: 'Receive live broker messages. Clean sessions do not recover offline messages. Supply a JSON event ID field for durable Run deduplication.',
  input: z.object({
    topicFilter: z.string().required().description('MQTT topic filter; + matches one level and # matches the remaining levels. Shared subscriptions are unsupported.'),
    qos: z.union([0, 1]).default(1),
    format: z.union(['json', 'text']).default('json'),
    includeRetained: z.boolean().default(false).description('Explicitly include the retained snapshot sent when subscribing.'),
    eventIdField: z.string().description('Optional top-level JSON key containing a nonblank string ID, at most 256 UTF-8 bytes. Missing or invalid IDs drop the message.'),
  }) as Schema<MqttTriggerConfig>,
  output: z.object({ topic: z.string().required(), payload: z.any(), receivedAt: z.string().required(), qos: z.union([0, 1]).required(), retained: z.boolean().required(), eventId: z.string() }) as Schema<MqttEvent>,
  connections: connectionSlots,
  semantics: { sideEffect: false, idempotent: true, retrySafe: true },
})

export const mqttPublishAction = defineCapability<MqttPublishInput, { published: true; qos: 0 | 1 }>({
  id: 'mqtt:publish', version: 1, kind: 'action', title: 'Publish MQTT Message',
  description: 'Publish at most 1 MiB of UTF-8 text. QoS 1 completes on broker PUBACK; QoS 0 only confirms a local socket write. Neither waits for subscriber execution.',
  input: z.object({ topic: z.string().required(), payload: z.string().required(), qos: z.union([0, 1]).default(1), retain: z.boolean().default(false) }) as Schema<MqttPublishInput>,
  output: z.object({ published: z.const(true).required(), qos: z.union([0, 1]).required() }),
  connections: connectionSlots,
  semantics: { sideEffect: true, idempotent: false, retrySafe: false, defaultTimeoutMs: 15000 },
})

export default function mqttIntegrationPlugin(ctx: Context): void {
  ctx.capabilities.define(ctx, mqttMessageTrigger)
  ctx.capabilities.define(ctx, mqttPublishAction)
  ctx.credentials.defineType(ctx, mqttPasswordCredential)
  ctx.connections.defineType(ctx, mqttClientConnectionType)
  ctx.connections.defineAdapter(ctx, mqttPasswordAdapter)
  ctx.connections.defineAdapter(ctx, mqttAnonymousAdapter)
  ctx.connections.provideAdapter(ctx, mqttPasswordAdapter, { async open({ connection, credential, signal }) {
    const { username, password } = credential?.value ?? {}
    if (typeof username !== 'string' || !username || typeof password !== 'string' || !password || Buffer.byteLength(username) > 65535 || Buffer.byteLength(password) > 65535) throw new MqttError('MQTT_CREDENTIAL_INVALID')
    return createMqttRuntime(connection.id, connection.config as unknown as MqttConnectionConfig, signal, { username, password })
  } })
  ctx.connections.provideAdapter(ctx, mqttAnonymousAdapter, { async open({ connection, signal }) {
    return createMqttRuntime(connection.id, connection.config as unknown as MqttConnectionConfig, signal)
  } })
  ctx.capabilities.provideTrigger(ctx, mqttMessageTrigger, { activate(activation) {
    return (activation.connections.client as MqttRuntime).subscribe(activation)
  } } satisfies TriggerProvider<MqttEvent>)
  ctx.capabilities.provide(ctx, mqttPublishAction, { async invoke({ input, connections, signal }) {
    return (connections.client as MqttRuntime).publish(input, signal)
  } } satisfies CapabilityProvider<MqttPublishInput, { published: true; qos: 0 | 1 }>)
}

mqttIntegrationPlugin.inject = ['capabilities', 'credentials', 'connections']
