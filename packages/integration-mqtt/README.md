# MQTT integration

Official MQTT 3.1.1 integration. Exports `mqtt:message@1` (Trigger) and
`mqtt:publish@1` (Action); depends on the Core, Credential and Connection services.
No Console or Workbench service is required. MQTT.js is pinned to `5.16.1` and
the real broker used in tests is Aedes `1.2.0`.

## Connection

Create a `mqtt:password@1` Credential with `{username, password}`, then choose
the `mqtt:password@1` Connection Adapter. Brokers allowing anonymous access
require explicitly choosing `mqtt:anonymous@1`; missing credentials never cause
an authentication downgrade. Both adapters implement `mqtt:client@1`.

Connection configuration:

```json
{
  "url": "mqtts://broker.example:8883",
  "clientId": "numen-production-events",
  "timeoutMs": 10000
}
```

- `url`: `mqtt://` or `mqtts://`. Username, password, query, fragment and non-root
  paths are rejected. WebSocket, Unix sockets and proxy transport are unsupported.
  TLS uses the normal system trust chain and always verifies the server certificate
  and hostname. No insecure override, custom certificate file or mutual TLS option
  is exposed in v1. Plain MQTT is intended for trusted networks/local testing.
- `clientId`: optional, 1–64 ASCII letters, digits, `_` or `-`. The default is
  stable and derived from the durable Connection ID. Duplicate active IDs are
  rejected in this process. Distinct Numen installations/replicas must use distinct
  Connections/IDs; there is no cross-process ownership election. Copying a database
  to another concurrently running replica also copies its default client IDs.
- `timeoutMs`: 100–60000 ms, default 10000, bounding initial connection, SUBACK,
  UNSUBACK, Run acceptance and publish operations.

Connection `READY` means that its managed runtime was initialized. The runtime
reconnects in the background; it does **not** imply a live network connection.
Trigger health stays unavailable until CONNACK and successful SUBACK, becomes
unavailable on disconnection/rejection/invalid payload and recovers after a
successful resubscription or valid accepted message. Reconnect delay starts at
250 ms, doubles after connection failures and caps at 30 s. Closing the Connection,
rotating credentials or unloading the plugin cancels its sockets, timers and
pending operations. New generations cannot receive old in-flight callbacks.

## Receive

Bind the Trigger's required `client` slot to an MQTT Connection:

```json
{
  "topicFilter": "devices/+/events",
  "qos": 1,
  "format": "json",
  "includeRetained": false,
  "eventIdField": "id"
}
```

- `qos`: 0 or 1 (default 1). QoS 2 is unsupported. A broker may grant lower QoS;
  the output records the QoS actually received.
- `format`: `json` (default) or `text`. Both require valid UTF-8, at most 1 MiB.
  JSON also rejects `$resource` at every depth, nesting beyond 64 levels, arrays
  beyond 10000 items and non-finite numeric values. JSON `null` is allowed.
- `includeRetained`: false by default. True receives the retained snapshot sent
  on subscribing. Ordinary live messages published with retain=true are normally
  forwarded by the broker with retain=false and are still live messages.
- `eventIdField`: optional literal, top-level JSON key. Its value must be a
  nonblank string of at most 256 UTF-8 bytes; missing or invalid values drop this
  Trigger's message. It cannot be combined with text format.
- `+` matches exactly one topic level; final `#` matches the remainder. Empty
  levels are supported. A leading wildcard does not match `$` system topics.
  Shared subscriptions (`$share/`, `$queue/`) are unsupported.

Output is `{topic, payload, receivedAt, qos, retained, eventId?}`. It contains
neither connection configuration nor credentials. One Connection supports up to
256 active Trigger subscriptions and 128 distinct filters. Identical filters
share a broker subscription; each matching Trigger independently accepts its Run.
Removing a filter waits for UNSUBACK before reusing that filter, and does not
disconnect other subscriptions.

### Delivery and acknowledgement

Sessions are always **clean sessions**. There is no offline message recovery or
durable broker subscription. Messages sent during downtime, reconnect or
subscription changes can be lost. Retained messages are snapshots, not a backlog.

For a received QoS 1 PUBLISH, MQTT.js's `handleMessage` callback is delayed until
all matching, still-active Triggers have durably accepted (or deduplicated) their
Runs. Only then is PUBACK sent. Invalid payloads/IDs are intentionally dropped
and acknowledged so they cannot block the connection. A storage failure or
acceptance timeout closes the connection without acknowledging that packet.
Some matching Triggers may already have accepted before another fails. Clean
sessions still mean the broker need not redeliver after reconnect.

The Scheduler deduplicates a business event ID per **revision + Trigger ID**,
including across process restarts. The same ID in a new revision is a new event;
reusing an ID with different content keeps the original Run. Without an event ID,
every broker delivery may create a Run. QoS retries and overlapping filters,
especially retained snapshots, can yield duplicate deliveries; packet IDs and
payload equality are deliberately not treated as durable event IDs. This is not
an exactly-once delivery guarantee. Run completion is separate from MQTT ACK.

## Publish

Bind the Action's `client` slot and provide:

```json
{"topic":"devices/42/commands","payload":"{\"command\":\"refresh\"}","qos":1,"retain":false}
```

The payload is UTF-8 text up to 1 MiB; empty text is valid. Use the Data JSON
stringify capability for structured content. Publish topics cannot contain
wildcards. Success returns `{published:true, qos}`. At QoS 1 it means the broker
returned PUBACK; at QoS 0 it means the local socket write completed. Neither means
that a subscriber received, processed or completed the command. MQTT 3.1.1 has
no negative PUBACK reason code, so some authorization failures can only surface
as connection close/timeout.

Publishing is a side effect, non-idempotent and not safe to retry automatically.
An offline Connection fails immediately, without an offline queue. At most 64
publishes can be pending per Connection. Timeout/abort closes that session and
fails its other pending operations; a fresh client reconnects without replaying
those outgoing messages. Already transmitted messages cannot be undone, so an
error may still mean the broker accepted the message. Publish retries require
an application-level business ID and corresponding receiver deduplication.

## Validation

`pnpm exec vitest run packages/integration-mqtt/tests` exercises a real Aedes
broker, encrypted Credentials, managed Connections, Triggers and the SQLite
Scheduler. It covers delayed durable ACK, failed acceptance, business-ID dedupe
across restart, invalid JSON/UTF-8 and size/structure bounds, overlapping filters,
retained handling, lifecycle fencing, reconnect and credential rotation, denied
subscriptions/publications, timeout/abort/pending bounds and TLS verification.
The PEM files under `tests/fixtures` are public, self-signed test-only material.
