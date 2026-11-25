# Feishu custom bot

`@numenjs/integration-feishu` provides `feishu:send-text@1`, an Action that submits text to a Feishu group custom bot through the Runtime-managed HTTP client. New default configurations include `feishu: {}`; existing deployments must add it explicitly. This private workspace package has not been published to npm.

## Configure

1. Add a custom bot in the target Feishu group. Copy its webhook URL and, if signature verification is enabled, its signing secret.
2. Create a **Feishu Bot Webhook** Credential (`feishu:webhook@1`) with `webhookUrl` and optional `secret`. Both are encrypted secret fields. The URL must match `https://open.feishu.cn/open-apis/bot/v2/hook/<token>`; other hosts, ports, query strings, fragments, userinfo and redirects are rejected.
3. Create and enable a **Feishu Custom Bot** Connection (`feishu:webhook@1` Adapter, `feishu:bot@1` type) using that Credential. No additional config is required. READY means local configuration is available; opening a Connection does not send a message or verify the remote bot.
4. Add **Send Feishu Text** to a workflow. Bind the Connection to `bot` and supply `text`, literally or by reference. For GitHub `issues.opened`, use `trigger.body.issue.title`.

## Contract

- Input: `{ text: string }`, nonempty and not only whitespace. Feishu mention markup is passed through and can notify group members or everyone.
- Output: `{ accepted: true }`, only for successful HTTP with integer `code: 0`. This is submission acceptance, not a read receipt. Legacy `StatusCode` alone is insufficient.
- Optional signing uses a seconds timestamp and Base64 HMAC-SHA256 of an empty message with `timestamp + "\n" + secret` as the key. Keep the host clock synchronized.
- Complete encoded UTF-8 request, including escaping and signing fields: at most 20 KiB. Response: at most 64 KiB.
- Plugin `timeoutMs`: defaults to 30,000, range 1–300,000, covers headers and response body. Cancellation, Credential rotation and Connection/plugin unload abort in-flight requests.
- Semantics: side effect, non-idempotent, unsafe to retry. No automatic retry. A timeout may occur after Feishu accepted the message; check before manual retry.

The Connection uses the host HTTP proxy. Errors contain stable codes and optionally a numeric `remoteCode`, never remote messages, bodies, webhook URLs or transport causes. HTTP debug logs redact webhook URLs/tokens and secrets.

| Error | Meaning |
| --- | --- |
| `FEISHU_RATE_LIMITED` | HTTP 429 or Feishu code 11232 |
| `FEISHU_REJECTED` | Other nonzero Feishu code, exposed as numeric `remoteCode` |
| `FEISHU_HTTP_ERROR` | Non-success HTTP status, including redirect |
| `FEISHU_RESPONSE_INVALID` | Invalid UTF-8/JSON or absent/noninteger `code` |
| `FEISHU_RESPONSE_TOO_LARGE` / `FEISHU_REQUEST_TOO_LARGE` | Byte limit exceeded |
| `FEISHU_TIMEOUT` / `FEISHU_CANCELLED` / `FEISHU_UNAVAILABLE` | Deadline, cancellation or retired Connection |
| `FEISHU_NETWORK_ERROR` | Transport failure, sensitive details removed |

No Lark regions, application-bot OAuth, cards, images, attachments, incoming events or rate-limiting queue are provided. Protocol details follow the [official custom bot guide](https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot).

## Verification

`pnpm exec vitest run packages/integration-feishu/tests` uses local HTTP fixtures through the real outbound service with test-only routing. After `pnpm build`, `pnpm exec playwright test e2e/github-integration.spec.ts` exercises the authored GitHub-to-Feishu workflow. These checks do not contact real groups or establish account permissions and public-network delivery.
