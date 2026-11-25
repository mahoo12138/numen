# @numenjs/integration-smtp

Send text and HTML email through an authenticated SMTP server using verified TLS. This package uses pinned [Nodemailer](https://nodemailer.com/smtp) **10.1.2** for SMTP and MIME encoding and participates in Numen's existing Credential, Connection and Capability lifecycle.

| Registration | Version | Purpose |
| --- | --- | --- |
| `smtp:send` | 1 | Action, displayed as **Send Email** |
| `smtp:password` Credential | 1 | **SMTP Username and Password**, encrypted username and password |
| `smtp:transport` ConnectionType | 1 | **SMTP Transport**, bound to the Action's required `transport` slot |
| `smtp:password` Adapter | 1 | **SMTP with Password**, creates the runtime from configuration and Credential |

## Configure a Connection

Create the SMTP Credential first. Put the account username and password or application password in its secret fields. They are never Connection configuration or Action inputs.

```json
{
  "host": "smtp.example.com",
  "port": 587,
  "tls": "starttls",
  "from": "reports@example.com"
}
```

`host` accepts a hostname or IP address, without a URL scheme. `tls` defaults to `starttls`, which requires a successful TLS upgrade before authentication. `tls: "tls"` encrypts immediately. Omitting `port` selects 587 for STARTTLS or 465 for TLS; custom ports support self-hosted servers.

Certificates and hostnames are always verified, with TLS 1.2 as the minimum version. An optional `caPem` field accepts a PEM CA bundle of up to 64 KiB for a private SMTP server. This replaces the default trust roots; it does not disable verification. Its editor preserves newlines.

The sender `from` is fixed in the Connection. Sender and recipient fields accept single bare ASCII email addresses, such as `person@example.com`. Display names, comma-separated address lists, Unicode local parts, CR/LF and NUL are rejected. Subject and message bodies support Unicode.

Opening a Connection constructs a lazy runtime. **READY means the runtime is available; it does not mean the remote server was contacted or authenticated.** Each send establishes and authenticates its own SMTP connection, and remote authentication/network errors are reported by that send. Disabled, removed or stale Connections are unavailable to workflow invocation.

## Send Email

```json
{
  "to": ["recipient@example.com"],
  "subject": "Daily report",
  "text": "The report is ready.\nOpen the dashboard for details.",
  "html": "<p>The report is ready.</p>"
}
```

`to`, `subject` and `text` are required; `html` is an optional alternative. At most 50 recipient entries are accepted, and repeated identical addresses are submitted once. The total UTF-8 bytes of the sender, original recipient entries, subject, text and HTML must not exceed **1 MiB**. This is an input-content limit; MIME transfer encoding can make the transmitted message larger. Empty subject or text strings are supported.

The plugin accepts only these fields. Arbitrary headers, attachments, file paths and URL content inputs are rejected; Nodemailer's file and URL access are disabled. HTML is literal content and is not fetched or rendered by Numen. The text and HTML editors preserve multiple lines.

```json
{
  "messageId": "<generated-id@example.com>",
  "accepted": ["recipient@example.com"],
  "rejected": []
}
```

The output follows the final SMTP acceptance reply. `accepted` contains the recipients the SMTP server accepted and `rejected` contains recipients it refused. Partial acceptance returns both lists explicitly and counts as a successful Action; inspect `rejected` in downstream logic when every recipient matters. If all recipients are refused, the Action fails with a fixed safe error. Acceptance is not a delivery receipt, and the generated Message-ID does not guarantee deduplication.

## Cancellation, limits and uncertain outcomes

The plugin-level configuration defaults to:

```json
{ "sendTimeoutMs": 30000, "maxConcurrency": 4, "maxPending": 16 }
```

`sendTimeoutMs` is an overall deadline including queue time, connection, authentication and submission, from 1 to 300,000 ms. Each Connection permits 1–32 simultaneous sends and 0–128 queued sends. The default limits are four active and sixteen queued sends; overflow fails immediately with `SMTP_BUSY`.

Each send owns its SMTP/TLS connection. Cancelling it closes only that send, leaving other sends on the same Numen Connection running. Closing the runtime, changing its configuration, disabling it or rotating its Credential cancels all of that runtime's active and queued sends. Old runtime references cannot start new sends.

This Action declares `sideEffect: true`, `idempotent: false` and `retrySafe: false`. Numen rejects automatic retry policies with more than one attempt during publication. The plugin never retries a message automatically.

A disconnect, timeout, cancellation or runtime closure can happen after the server accepted a message but before Numen received confirmation. Retrying then can deliver a duplicate. A queued send cancelled before SMTP starts is known not to have been submitted; after it starts, uncertainty is reported conservatively. There is no exactly-once delivery guarantee.

Direct runtime calls throw `SmtpError` with a safe `code` and an `outcome` of `not-submitted` or `unknown`. Raw SMTP replies, credentials and cancellation reasons are not exposed. Scheduler persistence currently retains the error's **name and message**, not those structured fields. SMTP's own deadline or network failure produces a failed Attempt/Run and no automatic resend; Scheduler-level invocation timeout or process interruption uses the Scheduler's separate recovery semantics. Inspect the safe failure message before any manual resend.

## Verification and reusable fixture

Tests use pinned [`smtp-server`](https://nodemailer.com/extras/smtp-server) **3.19.23** on loopback with a committed test-only certificate, without an external account. Coverage includes verified TLS and STARTTLS, certificate rejection before AUTH, missing STARTTLS, authentication failure, Unicode and multiline MIME, header injection, limits, partial/all recipient rejection, cancellation isolation, queue pressure and Credential rotation.

SQLite/Scheduler tests cover a disabled Connection becoming available, saved output after restart, DATA accepted locally with the final SMTP reply lost or withheld, and no resend across restart. An independent Node process repeats untrusted TLS/STARTTLS handshakes and immediate shutdown twelve times to detect native TLS cleanup regressions.

`tests/fixture.ts` exports `startSmtpFixture(options?)`, returning `{ config, credential, messages, errors, authCount, activeConnections, close }`. It supports TLS/STARTTLS, recipient refusal, and holding or dropping the final DATA reply. `messages` contains the raw MIME text, envelope addresses and whether transport was secure. The fixture's `close()` owns cleanup through smtp-server; callers must not destroy underlying raw sockets beneath a TLS wrapper. The key in `tests/fixtures/` is public test material, never a deployment credential.

From the repository root:

```sh
pnpm exec tsc -b packages/integration-smtp --pretty false
pnpm exec vitest run packages/integration-smtp/tests/integration.test.ts
```
