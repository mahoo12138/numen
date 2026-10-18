---
description: 配置有令牌保护的 JSON Webhook，并完成字段整理、日期计算和 JSON 输出。
---

# Webhook：把外部事件接入流程

Webhook 入口在收到 JSON 后创建持久化 Run，立即返回 `{ status, runId }`。流程在后台执行；HTTP 回执不会等待下游节点完成。

本例实现 **Webhook → 字段整理 → 日期计算 → JSON 输出**。先按[快速开始](/guide/getting-started)启动 Numen。

## 1. 配置令牌和连接

1. 确认宿主已配置 `NUMEN_MASTER_KEY`，参见[部署与运维](/reference/deployment)。
2. 在 **Connections → Credentials** 创建 **Webhook Header Token**，填入随机令牌。
3. 添加 **Webhook** Trigger，保留 `authentication = token`。
4. 在 Trigger 的 `auth` 槽位选择 **Create compatible Connection**，选择刚创建的凭据。
5. 新 Connection 默认停用。在 Connections 中启用它，确认运行状态为 **READY**。

对应契约是 Credential / Adapter `webhook:header-token@1`，Connection Type `webhook:auth@1`，Trigger `webhook:receive@1`。令牌通过 `Authorization: Bearer` 传递，不写进工作流 Source。

如果入口确实允许匿名，显式选择 `authentication = none`，并移除不再需要的 `auth` 绑定。缺少令牌连接不会自动变成匿名；仍保留的绑定也必须满足连接就绪检查。

## 2. 配置下游节点

在流程中按顺序添加以下三个节点。表中的 `prepare`、`due`、`encode` 是示例 Source ID，请替换成 Inspector 中实际显示的节点 ID。

| 节点 | 字段配置 |
| --- | --- |
| **Merge Object Fields** (`data:object-merge`) | `base` 使用 Reference：`trigger.body`；`fields` 使用固定对象 `{"source":"webhook"}` |
| **Add to Date & Time** (`datetime:add`) | `date` 引用 `steps.prepare.value.date`；`amount` 为 `1`；`unit` 为 `months`；`timezone` 为 `UTC` |
| **Stringify JSON** (`data:json-stringify`) | `value` 使用对象表达式：`event` 引用 `steps.prepare.value`，`dueAt` 引用 `steps.due.iso` |

对于任意 JSON 内部的字段，变量选择器可能只提供到 `.value`；可在 Reference 路径中补全 `.date`。

## 3. 发布、激活并启用

保存并发布 Revision，在 **Revisions** 中激活它，然后开启 **Enable Automation**。确认 Trigger 已就绪。

选中 Webhook Trigger，Inspector 的入口详情会显示只读路径，点击 **Copy path**：

```text
/api/webhooks/<automationId>/<triggerId>
```

地址随 Automation 和 Trigger 固定，换 Revision 不会改变。复制的是路径，需加上部署时的宿主地址；默认开发服务器是 `http://127.0.0.1:5140`。从外部调用需要可达地址与 TLS。

只有当前有效订阅接收事件。草稿测试和节点测试不会创建临时 Webhook 入口。

## 4. 发送请求并检查 Run

替换 URL、令牌和 ID 后，在你自己的终端发送：

```sh
curl --request POST 'http://127.0.0.1:5140/api/webhooks/AUTOMATION_ID/TRIGGER_ID' \
  --header 'Authorization: Bearer YOUR_WEBHOOK_TOKEN' \
  --header 'Content-Type: application/json' \
  --header 'Idempotency-Key: delivery-2024-01-31-001' \
  --data '{"date":"2024-01-31T12:00:00Z","customer":"Alice"}'
```

首次接受返回 HTTP `202`：

```json
{"status":"accepted","runId":"…"}
```

在 **Runs** 中打开对应 Run，检查 Trigger 数据、各节点状态和输出。最后一个节点的 `text` 应为以下对象的 JSON 文本：

```json
{
  "event": {
    "date": "2024-01-31T12:00:00Z",
    "customer": "Alice",
    "source": "webhook"
  },
  "dueAt": "2024-02-29T12:00:00.000Z"
}
```

执行数据查看遵循字段分类和展示上限，业务字段可能显示受限提示。不要为了调试把整个请求体声明为公开数据。

## 幂等重试

再次发送同一 `Idempotency-Key`，同 Revision、同 Trigger 返回 HTTP `200` 和原来的 Run：

```json
{"status":"duplicate","runId":"…"}
```

键必须为 1–128 个可打印 ASCII 字符，且不能全为空白。相同键但不同请求体仍算重复；没有键时，每次投递都可能产生新 Run。新 Revision 使用新的去重范围。

如果请求提交后断连，用原事件 ID 重试以找回回执。`accepted` 只表示已持久接受：运行可能排队、被并发策略丢弃或在后续节点失败，应继续检查 Run。

## 限制与错误

请求必须是未压缩 UTF-8 JSON，最大 1 MiB，读取超时 30 秒；同时限制 64 层嵌套和累计 10,000 个数组元素，拒绝 `$resource` 保留键。Trigger 输出只有 `body`、`receivedAt` 和可选 `eventId`，不含请求头、Cookie 或完整 URL。

| 状态码 | 含义与处理 |
| --- | --- |
| `400` | JSON、事件 ID、值结构或保留字段无效，修正请求 |
| `401` | 缺少或错误的 Bearer token，检查令牌与连接 |
| `404` | 没有已启用入口，检查路径、激活版本和启用状态 |
| `408` | 读取请求体超时 |
| `413` | 请求体超限 |
| `415` | 内容类型、编码或字符集不支持 |
| `503` | 订阅失效或持久化接受失败，可保留事件 ID 重试 |

禁用、换版、凭据轮换和插件卸载会使旧订阅失效；已经在途的旧请求不会转投到新版本。本版本不支持同步返回流程结果、HMAC 验签、文件上传或草稿监听。

[查看 Webhook 实现](https://github.com/Mahoo12138/numen/blob/main/packages/integration-webhook/src/index.ts)
