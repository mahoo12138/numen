# 官方 GitHub Webhook 插件

`@numenjs/integration-github` 接收 GitHub 推送的 Webhook，验证签名后将匹配事件交给现有 TriggerService 与 Scheduler。默认开发配置和容器配置包含 `github: {}`。已有部署需显式加入该插件；升级不会改写用户配置。当前交付为本地 workspace 包，没有执行 npm 发布或真实 GitHub 公网投递验收。

面向使用者的完整配置步骤见[文档站 GitHub 指南](../website/src/integrations/github.md)。

## 契约与配置

| 对象 | 版本化 ID | 含义 |
| --- | --- | --- |
| Trigger | `github:webhook@1` | 接收已签名的 GitHub 事件 |
| Credential | `github:webhook-secret@1` | `secret` 字段保存 Webhook Secret |
| Connection Type | `github:webhook-auth@1` | 提供当前凭据版本的签名验证运行时 |
| Adapter | `github:webhook-secret@1` | 使用 Secret 创建验证运行时，无额外连接参数 |

Trigger 的 `auth` 槽位必须绑定就绪的 `github:webhook-auth@1` Connection，没有匿名模式。密钥保存在 Credential 中，不写入 Automation Source、请求路径或 Trigger 输出。

`events: string[]` 默认为 `[]`，接受所有非 `ping` 事件；非空时按 `X-GitHub-Event` 精确匹配。`actions: string[]` 默认为 `[]`，不限制 action；非空时按请求体顶层 `action` 精确匹配，无 action 的事件也会被筛掉。两个筛选条件同时生效。

events/actions 数组各最多 100 项；event 名称符合 `^[a-z][a-z0-9_]{0,99}$`，action 为 1–100 个字符的字符串并精确匹配，保留大小写、连字符和 Unicode，以支持 `repository_dispatch` 的自定义事件类型。请求中的 event 与存在的 action 也遵循各自约束。Secret 长度为 1–4096 个 JavaScript 字符。

输出字段为 `body`、`event`、`deliveryId`、`receivedAt` 和可选 `action`。`body` 保留验证并解析后的业务数据；不输出全部请求头、Cookie、签名或完整 URL。

## 入口和投递

单一插件路由为 `POST /api/github/webhooks/:automationId/:triggerId`。Automation 与 Trigger 决定固定路径，Revision 切换不改变地址。必须发布并激活 Revision、启用 Automation，且 auth Connection 已就绪，入口才接收事件。草稿测试不会创建临时监听入口。

请求要求 `Content-Type: application/json`、`X-Hub-Signature-256`、`X-GitHub-Event`、`X-GitHub-Delivery`。插件对原始请求体字节执行 HMAC-SHA256 校验，验证后解析 JSON；重新序列化 JSON 或修改空白都会改变签名。比较采用恒定时间比较。算法与请求头依据 [GitHub 的签名验证说明](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)。

签名必须为 `sha256=` 加 64 位十六进制字符；delivery ID 必须为 `8-4-4-4-12` 十六进制 UUID，接受大小写并统一转为小写。签名、event、delivery 和 Content-Type 请求头都必须恰好出现一次。

请求必须是未压缩 UTF-8 `application/json`，body 最大 1 MiB，读取超时 9 秒。JSON 根必须是对象，受 64 层嵌套、累计 10,000 个数组元素限制，并拒绝任何层级的 `$resource` 保留键。9 秒限制只约束读取请求体，不保证包含磁盘提交在内的总响应时长。

| HTTP 状态 | 结果 |
| --- | --- |
| `202` | 匹配事件已持久化为 Run，返回 `{"status":"accepted","runId":"…"}` |
| `200` | 重复投递返回 `{"status":"duplicate","runId":"…"}`；`{"status":"ping"}` 或 `{"status":"ignored"}` 不创建 Run |
| `400` | 请求头、JSON 或值结构无效 |
| `401` | 缺失或无效签名 |
| `404` | 当前没有可用入口 |
| `408` | 请求体读取超时 |
| `413` | 请求体超限 |
| `415` | 内容类型、编码或字符集不支持 |
| `503` | 订阅失效或持久化接受失败 |

`ping` 和筛掉的事件也必须通过签名和请求格式验证，不得用它们绕过鉴权。匹配事件只有在数据库事务提交后才返回接受回执，HTTP 响应不等待下游节点完成。`accepted` 表示事件已接受，Run 仍可能排队、被准入策略丢弃或在执行中失败。

## 去重与生命周期

`X-GitHub-Delivery` 作为 `eventId` 交给 Scheduler，数据库唯一键为 `(revision_id, trigger_id, event_id)`，不在插件内维护去重缓存。同 Revision、同 Trigger 的并发重送、进程重启后重送以及 disable/enable 后重送返回原 Run。相同 ID 即使携带不同请求体仍视为重复。新 Revision 拥有新的去重范围，旧 delivery ID 可以在新版本创建 Run。

Run、Trigger Event 与准入记录在同一事务中写入；持久化失败不能返回成功，也不能留下部分 Run。请求接受后若回执丢失，使用原 delivery ID 重送可以取得已提交的 Run 回执。

禁用、换版、凭据轮换、Connection 失效和插件卸载会终止旧订阅。请求读完后必须再次检查订阅 signal 与 endpoint 对象身份，防止在途旧请求转投新订阅；旧订阅的 disposer 只能删除自身 endpoint，不能移除已替换的新实例。服务端能力不依赖 Workbench；可选前端 Entry 只负责 Inspector 中的入口路径和复制操作。

## 安全与实现边界

GitHub 的 HMAC 签名只覆盖请求体，**不覆盖 `X-GitHub-Event` 和 `X-GitHub-Delivery` 请求头**。因此 delivery 去重不是带签名的防重放凭据，event 筛选也不能独立证明请求来自某个仓库。生产入口需要 HTTPS，并保持代理转发时的原始 body 与请求头；如流程限定仓库，应同时检查已签名 body 中的 `repository.id` 等业务字段。

插件仅接收事件，不创建 GitHub Webhook，不申请 OAuth/PAT，不轮询 GitHub，不调用 GitHub REST/GraphQL API，也不提供同步工作流结果或草稿监听。该功能无需 GitHub API token；Credential 中保存的是 Webhook Secret。

## 验证入口

执行 `pnpm exec vitest run packages/integration-github/tests` 验证插件契约、HTTP 接收与持久化边界；执行 `pnpm docs:test` 验证文档站构建、集成筛选和 GitHub 指南导航。具体通过情况以本次实际命令结果为准，文档列出的命令本身不构成通过记录。

实现应覆盖签名字节差异、错误及重复请求头、ping/筛选不执行、并发与重启去重、读 body 中途换版或轮换密钥、数据库接受失败和卸载后路由回收。真实 GitHub → HTTPS 代理 → Numen 的端到端联调仍需有对应部署及仓库权限时单独执行。
