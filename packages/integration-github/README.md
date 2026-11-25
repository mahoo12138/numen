# GitHub Integration

`@numenjs/integration-github` adds a signed Webhook Trigger and three GitHub.com REST capabilities: read an issue, create an issue, and add an issue comment. The Webhook uses an independent signing secret and remains available without outbound HTTP. REST capabilities appear when the host HTTP service is available. No polling, OAuth flow, or automatic webhook installation is involved.

## GitHub issue and comment API

1. Create a **GitHub API Token** Credential (`github:token@1`) with its secret `token` field. Prefer a fine-grained personal access token restricted to the repositories this workflow needs: **Issues: read** for fetching, **Issues: write** for issue creation or comments. A private repository may return 404 when the token lacks access; check the token's repository selection and organization approval as well as its permissions.
2. Create and enable a **GitHub API** Connection using the **GitHub API Token** adapter (`github:token@1`) and that Credential; its config is `{}`. READY means the credential and runtime are locally available, not that GitHub permissions were remotely verified. Opening a Connection makes no network request.
3. Add a capability below and bind its required `api` slot to the Connection. The REST token is separate from the Webhook's `auth` Connection.

| Capability | Kind | Inputs | Output |
| --- | --- | --- | --- |
| `github:issue-get@1` · Get GitHub Issue | Query | `owner`, `repo`, `issueNumber` | `{ id, number, title, body, state, url }` |
| `github:issue-create@1` · Create GitHub Issue | Action | `owner`, `repo`, `title`, optional `body` | `{ id, number, title, body, state, url }` |
| `github:issue-comment@1` · Comment on GitHub Issue | Action | `owner`, `repo`, `issueNumber`, `body` | `{ id, body, url }` |

For example, create an issue from a previous RSS node by binding its entry title to `title` and its link or description to `body`. The resulting `number` can feed a comment node, and `url` can feed a Feishu notification. A failed later notification does not roll back an already-created GitHub issue.

The output contains only the fields shown above. `url` is GitHub's browser URL, `state` is `open` or `closed`, and a null GitHub body becomes `""`. Unrelated fields such as users, permissions and repository metadata are discarded. GitHub's Issues API also supports pull request numbers for reads and comments. Input and output issue content can be private and becomes part of execution history.

### REST boundaries and failures

- Requests are fixed to `https://api.github.com`, using `Accept: application/vnd.github+json`, Bearer authentication, a Numen User-Agent and `X-GitHub-Api-Version: 2026-03-10`. This release does not support GitHub Enterprise Server, arbitrary base URLs, pagination, issue updates, labels or assignees. Each operation sends exactly one HTTP request.
- Owner names contain 1–39 ASCII alphanumeric/hyphen characters and must start with an alphanumeric character. Repository names contain 1–100 ASCII alphanumeric, dot, underscore or hyphen characters; `.` and `..` are excluded. Use the name without `.git`. Issue numbers must be positive safe integers. Path separators, percent escapes, queries and fragments are rejected.
- Issue titles contain 1–256 characters and cannot be whitespace-only. Bodies are limited to 65,536 JavaScript string code units; comment bodies cannot be empty or whitespace-only. The entire UTF-8 encoded JSON request must fit within **256 KiB**, including escaping; a body within the character limit can still exceed the byte limit.
- Responses are limited to **1 MiB**, whether Content-Length is present or streamed, and require valid UTF-8 JSON and the expected output fields. The **30-second overall deadline** includes headers and the complete response body. A malformed, oversized or interrupted successful response does not establish that a write failed remotely.
- The host's proxy, transport and HTTP hooks are retained. Host default headers, credentials, query parameters, body and response decoder are isolated from these requests. Redirects are rejected, including repository-renaming redirects: update `owner`/`repo` rather than forwarding the token to a new address.
- Errors expose stable `GITHUB_API_*` codes. HTTP failures retain numeric `status`; valid `retryAfterSeconds`, `rateLimitRemaining` and `rateLimitReset` values are included when supplied. These numeric values also appear in the persisted attempt's error message. HTTP 429 and HTTP 403 with rate-limit evidence produce `GITHUB_API_RATE_LIMITED`; other 403 responses remain `GITHUB_API_HTTP_ERROR`. Remote response messages, response content, tokens and transport causes are excluded. Response bodies are never logged by the plugin.
- GET is read-only and retry-safe; an explicit Scheduler retry policy can retry it. The plugin itself does not retry or wait. When GitHub rate-limits a read, use the reported delay/reset time before retrying; a fixed Scheduler backoff does not dynamically interpret GitHub's response headers.
- Create and comment Actions are non-idempotent and **not retry-safe**. Scheduler rejects automatic retry policies for them. A timeout, disconnect or invalid response may follow a successful remote write: inspect the repository before starting another run. Existing completed or failed attempts are not resubmitted after restart; a process interrupted during a write can require outcome review. There is no remote idempotency key or exactly-once guarantee.
- Cancellation affects only the current invocation. Credential rotation, Connection retirement, HTTP service removal and plugin unload abort all in-flight operations on that runtime and fence old runtime references. HTTP removal withdraws REST capabilities but leaves signed Webhook ingress working; returning HTTP restores REST registration. The token stays in the encrypted Credential store and is redacted from outbound debug logs.

API sources: [get/create issue endpoints](https://docs.github.com/en/rest/issues/issues?apiVersion=2026-03-10), [issue comment endpoint](https://docs.github.com/en/rest/issues/comments?apiVersion=2026-03-10#create-an-issue-comment), [API versions](https://docs.github.com/en/rest/about-the-rest-api/api-versions), and [rate-limit guidance](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api).

## Configure a webhook

1. Create a **GitHub Webhook Secret** Credential (`github:webhook-secret@1`) with a random `secret` (1–4096 characters).
2. Create and enable a **GitHub Webhook Authentication** Connection using the `github:webhook-secret@1` adapter and that Credential. Its config is `{}`.
3. Add a **GitHub Webhook** Trigger, bind its required `auth` slot to the Connection, and set optional `events` / `actions` filters. Publish, activate and enable the Automation.
4. Copy the Trigger's callback URL from its detail panel. Its path is `/api/github/webhooks/<automationId>/<triggerId>`; use your public HTTPS origin.
5. In GitHub repository or organization webhook settings, set that URL, choose **application/json**, enter the same secret, select the needed events and leave SSL verification enabled.

For example, `events: ["issues"]` and `actions: ["opened", "reopened"]` receives newly opened or reopened issues. Empty arrays accept any event or action; `ping` always checks connectivity without running the Automation. A nonempty `actions` filter excludes events whose payload has no action, such as `push`. Event names match `[a-z][a-z0-9_]{0,99}`. Actions contain 1–100 characters and match exactly, including case; this supports custom `repository_dispatch` actions such as `on-demand-test`. Each filter list accepts at most 100 entries. An explicit list is useful when GitHub adds new event types or actions.

Only published, active and enabled Automations with a ready Connection own endpoints. Disabling or archiving the Automation, removing its Trigger, losing its Connection, or unloading the plugin removes ingress. Credential rotation and revision activation invalidate uploads using the previous subscription. Unrelated endpoints continue to work. Coordinate the secret change in Numen and GitHub, then redeliver any failed deliveries from GitHub.

## Data and response contract

The Trigger emits:

```json
{
  "body": { "action": "opened", "issue": { "number": 123 } },
  "event": "issues",
  "deliveryId": "72d3162e-cc78-11e3-81ab-4c9367dc0958",
  "receivedAt": "2026-10-18T08:00:00.000Z",
  "action": "opened"
}
```

`action` is omitted when absent. The body retains GitHub's complete JSON payload, subject to the limits below. Headers, URL query parameters, the signing secret and signature are not emitted or stored as Trigger data. Payload fields can contain private repository data, and become part of execution history.

| HTTP | Response | Meaning |
| --- | --- | --- |
| 202 | `{"status":"accepted","runId":"…"}` | Event and queued Run committed; workflow execution has not necessarily started. |
| 200 | `{"status":"duplicate","runId":"…"}` | Previously accepted delivery in this revision and Trigger. |
| 200 | `{"status":"ping"}` | Signature and JSON verified; no Run created. |
| 200 | `{"status":"ignored"}` | Valid delivery excluded by filters; no Run created. |
| 400 | `{"error":{"code":"…","message":"…"}}` | Invalid metadata or JSON. |
| 401 | Same error envelope | Missing, malformed or mismatched SHA-256 signature. |
| 404 | Same error envelope | Endpoint unavailable. |
| 408 / 413 / 415 | Same error envelope | Body read timeout / size limit / unsupported content encoding or media type. |
| 503 | Same error envelope | Subscription changed or durable acceptance failed. |

Errors never include parser excerpts, request content, credentials or internal storage errors. A missing route after plugin unload is served by the host's normal 404 handler.

## Verification, bounds and delivery semantics

- Require exactly one `X-Hub-Signature-256`, one `X-GitHub-Event`, and one `X-GitHub-Delivery`. Signature format is `sha256=` plus 64 hex digits; the original request bytes are checked with `timingSafeEqual` before parsing. SHA-1 is unsupported.
- The event header uses the same name format as filters. Delivery ID must use the UUID `8-4-4-4-12` hexadecimal format; its case is normalized to lowercase. HMAC authenticates **the body only**: event and delivery headers are not covered by GitHub's signature. Use HTTPS and preserve all headers and bytes through proxies. Delivery deduplication does not authenticate those headers or prevent replay under a changed delivery ID.
- Accept only uncompressed UTF-8 `application/json`, with an optional UTF-8 charset. The root must be an object. If present, top-level `action` must be a string of 1–100 characters. The raw body limit is **1 MiB**; the JSON limit is **64 container levels** and **10,000 total array entries**. External `$resource` values are forbidden. Larger GitHub deliveries are rejected, not truncated.
- Body reading has a **9-second deadline**. Acceptance returns after durable enqueue and does not wait for workflow execution. GitHub expects a response within 10 seconds; a slow storage commit can still exceed that limit, so monitor delivery results and redeliver failures.
- The shared Trigger/Scheduler services deduplicate accepted deliveries by **revision ID + Trigger ID + delivery ID** in the database. Concurrent redeliveries, restart, disable/re-enable and secret rotation reuse the stored Run. Activating a new revision creates a new deduplication scope. Separate Triggers each accept their own Run. This is durable acceptance deduplication, not an exactly-once guarantee for downstream side effects.
- Ping and filtered deliveries are not persisted. Retries of those requests return their current ping/filter result. A failed durable commit returns 503 without a partial Run or receipt; if the HTTP response is lost after commit, redelivery returns the existing receipt.

The optional Workbench/Console contribution displays the callback URL and setup guidance. Its lifecycle is independent of the backend; temporarily removing those UI services does not interrupt uploads.

Protocol sources: [GitHub signature validation](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries), [webhook best practices](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks), and [webhook events and payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads).
