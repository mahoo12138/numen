---
description: 配置 GitHub Webhook Secret、筛选仓库事件，并理解签名、投递回执和去重边界。
---

# GitHub：接收仓库事件

`github:webhook@1` 接收 GitHub 推送，验证原始请求体的 HMAC-SHA256 签名，再将匹配事件持久化为 Run。本例接收新建 Issue，把标题交给 Echo 节点，先验证一条完整的数据路径。

默认配置已包含 `github: {}`。已有部署升级后需在插件配置中显式添加它，再按[快速开始](/guide/getting-started)启动 Numen。当前包随源码工作区提供，不代表已发布到 npm。

## 1. 保存 Secret 并连接 Trigger

1. 确认宿主已配置 `NUMEN_MASTER_KEY`，参见[部署与运维](/reference/deployment)。
2. 在 **Connections → Credentials** 创建 **GitHub Webhook Secret**，在 `secret` 字段填入随机 Secret。
3. 在 Automation 中添加 **GitHub Webhook** Trigger，在必需的 `auth` 槽位创建兼容 Connection，选择该 Credential。
4. 前往 Connections 启用新建连接，确认状态为 **READY**。

对应契约为 Credential / Adapter `github:webhook-secret@1`，Connection Type `github:webhook-auth@1`。这里保存的是 Webhook Secret，不是 GitHub API token；Secret 不进入工作流 Source。

## 2. 筛选事件并配置下游

在 Trigger 中设置：

```json
{
  "events": ["issues"],
  "actions": ["opened"]
}
```

`events` 对应 `X-GitHub-Event` 请求头，`actions` 对应请求体顶层 `action`。两个数组都默认 `[]`：事件不限类型，但 `ping` 只确认；action 不限值。非空数组按名称精确匹配；指定 actions 后，没有 action 的事件不会进入流程。每个数组最多 100 项；event 名称以小写字母开头，只含小写字母、数字和下划线，最长 100 个字符。action 为 1–100 个字符，支持大小写、连字符和 Unicode，例如 `repository_dispatch` 的自定义事件 `on-demand-test`。

添加 **Echo** 节点，将 `message` 切换到 **Reference**，填写 `trigger.body.issue.title`。这个路径对应本例的 `issues / opened` 请求；其他事件需要按其实际 payload 选择字段。

Trigger 输出提供以下字段：

| 字段 | 含义 |
| --- | --- |
| `body` | 验签后解析的 GitHub payload |
| `event` | 事件类型，例如 `issues` |
| `deliveryId` | `X-GitHub-Delivery` 投递 ID |
| `receivedAt` | Numen 接受请求时的时间 |
| `action` | payload 顶层 action，可能没有 |

## 3. 发布流程并取得地址

保存并发布 Revision，在 **Revisions** 中激活它，再开启 **Enable Automation**。确认 Trigger 已就绪。

选中 GitHub Trigger，Inspector 的 **GitHub Webhook 入口** 显示路径；点击 **复制路径 / Copy path**：

```text
/api/github/webhooks/<automationId>/<triggerId>
```

路径属于 Automation 与 Trigger，切换 Revision 不改变地址。复制的只是路径，需要加上部署的 HTTPS 域名。默认的 `127.0.0.1:5140` 不能供 GitHub 公网直接投递；先配置可达入口，保留原始请求体和签名请求头。

只有已发布、激活且启用的流程接收事件。草稿测试不会创建临时监听地址。

## 4. 在 GitHub 配置 Webhook

在目标仓库的 Webhook 设置中创建投递配置：

| 设置 | 值 |
| --- | --- |
| Payload URL | `https://YOUR_NUMEN_HOST` 加上复制的路径 |
| Content type | `application/json` |
| Secret | 与 Numen Credential 中完全相同的 Secret |
| Events | 本例选择 Issues |

GitHub 使用 Secret 生成 `X-Hub-Signature-256`，签名内容是原始请求体；反向代理不要重新序列化或改写 JSON。[GitHub 签名验证说明](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)

创建后发送的 `ping` 在通过验证后返回 HTTP `200`、`{"status":"ping"}`，不会创建 Run。随后在目标仓库新建一个 Issue，在 GitHub 的投递记录中检查响应，并在 Numen **Runs** 中检查对应 Run 和 Echo 输出。事件及 action 的来源与处理方式参见 [GitHub 投递说明](https://docs.github.com/en/webhooks/using-webhooks/handling-webhook-deliveries)。

本文说明配置方法，不表示当前环境已完成真实 GitHub 公网投递验收。

## 回执与重送

匹配事件首次接受返回 HTTP `202`：

```json
{"status":"accepted","runId":"…"}
```

这表示事件和 Run 已持久化，HTTP 回执不会等待下游完成。Run 之后可能排队、被并发策略丢弃或执行失败，需要继续检查其状态。

同 Revision、同 Trigger 重送相同 `X-GitHub-Delivery`，返回 HTTP `200` 和原来的 Run：

```json
{"status":"duplicate","runId":"…"}
```

delivery ID 必须是标准 `8-4-4-4-12` 十六进制 UUID，接收后统一为小写。去重跨进程重启保留。相同 delivery ID 即使请求体不同仍视为重复；激活新 Revision 后，相同 ID 可以创建新 Run。禁用再启用同一 Revision 不会重置去重范围。请求提交后若回执丢失，重送原 delivery ID 可找回已持久化的回执。

事件或 action 不匹配时返回 HTTP `200`、`status: ignored`，不创建 Run。`ping` 与过滤掉的请求仍必须通过签名和格式验证。

## 签名与生命周期边界

签名只保护请求体，**不覆盖 `X-GitHub-Event` 和 `X-GitHub-Delivery` 请求头**。不要把 delivery ID 当作带签名的防重放凭据；若流程只允许某个仓库的数据，应进一步核对已签名 body 中的 `repository.id` 等字段。入口使用 HTTPS，并确保转发链路不改写 body 和请求头。

禁用流程、切换 Revision、轮换凭据或卸载插件都会使旧订阅失效；在途旧请求不会转投新订阅。Secret 轮换后，需要同步更新 GitHub 端配置。整个请求体可能包含业务数据，执行结果的展示仍遵循 Numen 的字段分类与上限。

请求只接受未压缩 UTF-8 `application/json`，JSON 根必须是对象。body 最大 1 MiB，读取超时 9 秒；同时限制 64 层嵌套、累计 10,000 个数组元素，并拒绝 `$resource` 保留键。读取超时不包含后续磁盘提交，因此不保证总响应时间低于 9 秒。重复的签名、event、delivery 或 Content-Type 请求头会被拒绝。

| 状态码 | 含义与处理 |
| --- | --- |
| `400` | 请求头、JSON 或值结构无效 |
| `401` | 缺少或无效签名，检查两端 Secret 与 body 是否被改写 |
| `404` | 没有已启用入口，检查路径、Revision 和 Connection 状态 |
| `408` | 请求体读取超时 |
| `413` | 请求体超限 |
| `415` | 内容类型、编码或字符集不支持 |
| `503` | 订阅失效或持久化接受失败，恢复后可用原 delivery ID 重送 |

Webhook 能力不自动创建 GitHub Webhook，也不轮询仓库。同一个插件另提供 [Issue 查询、创建与评论](./github-actions)，使用独立的 API Token Connection；可接在事件、数据处理或订阅读取之后。

[查看插件契约与实现](https://github.com/Mahoo12138/numen/tree/main/packages/integration-github)
