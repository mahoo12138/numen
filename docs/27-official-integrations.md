# 官方基础插件：数据、日期时间与 Webhook

默认开发配置和容器配置启用 `data: {}`、`datetime: {}`、`webhook: {}`。已有部署升级后，需要自行在插件配置中添加这些实例；不会自动改写用户配置。包仍为本地 workspace 包，本次没有发布 npm。

每个操作是独立、固定版本的 Capability。数组是普通值；逐项执行继续使用 ForEach，条件分支使用 If。插件不引入 n8n 的隐式 item 流。

## 数据处理

| Capability v1 | 参数 | 输出 |
| --- | --- | --- |
| `data:json-parse` | `text`：JSON 文本 | `{ value }` |
| `data:json-stringify` | `value`：待序列化值 | `{ text }` |
| `data:object-merge` | `base`、`fields`：对象 | `{ value }`，浅合并，fields 覆盖同名键 |
| `data:array-unique` | `items`；可选 `key`：顶层字段名 | `{ items }`，保留首次出现顺序 |

完整值去重忽略对象键的顺序，但保留数组顺序和类型差异；指定 key 时缺失字段会报错，显式 null 是正常值。操作不修改输入。

输入输出上限（包含完整参数和结果对象）为 UTF-8 JSON 1 MiB、嵌套 64 层、整个值累计 10,000 个数组元素。非法 JSON、非有限数、循环引用和超限值明确失败。外部 JSON 文本中的 `$resource` 为保留字段，任何层级都不接受；内部合法 ResourceRef 可以作为原子值传递，不能通过字段合并伪造。

## 日期时间

| Capability v1 | 参数 | 输出 |
| --- | --- | --- |
| `datetime:now` | `timezone`，默认 UTC | `{ iso, epochMs, timezone }` |
| `datetime:format` | `date`、`format`、`timezone` | `{ text }` |
| `datetime:add` | `date`、`amount`、`unit`、`timezone` | `{ iso, epochMs, timezone }` |
| `datetime:diff` | `start`、`end`、`unit`、`timezone` | `{ value, unit }` |

输入采用 ISO 日期字符串；带 offset 的输入表示绝对时刻，无 offset 的输入按指定时区解释。默认 UTC，不依赖服务器时区。不存在或有歧义的本地时间会报错，可提供明确 offset 消歧。

单位为 `milliseconds`、`seconds`、`minutes`、`hours`、`days`、`weeks`、`months`、`years`。日历加减的日、周、月、年要求整数；负数表示减法。月末会收敛到目标月最后一天，例如 2024-01-31 加一个月得到 2024-02-29。跨夏令时时，加一天不等于加 24 小时；日历结果落在不存在或歧义的当地时刻也明确失败。

时间差计算 `end - start`，使用选定单位并保留小数。格式采用 [Luxon token](https://moment.github.io/luxon/#/formatting?id=table-of-tokens)，如 `yyyy-MM-dd HH:mm:ss`。当前时间由节点显式采样，成功输出持久化后不会因恢复执行而重取。

## Webhook

1. 在 Connections → Credentials 创建 **Webhook Header Token** 凭据，填写随机令牌。宿主必须已配置 `NUMEN_MASTER_KEY`；令牌不会写进工作流 Source。
2. 在自动化中添加 **Webhook** Trigger。保留 `authentication = token`，通过 `auth` 槽位的 **Create compatible Connection** 创建连接并选择该凭据。
3. 新建 Connection 默认停用。前往 Connections 启用该连接，确认运行状态为 **READY**。
4. 返回自动化，Inspector 显示入口路径，点击 **Copy path**。路径为 `/api/webhooks/<automationId>/<triggerId>`，发布新 Revision 不改变路径。
5. 发布、激活 Revision，并启用自动化。只有当前有效订阅接收事件；草稿没有临时监听地址。
6. 向对应宿主地址发送 POST JSON，在 Runs 查看结果。

令牌使用 `Authorization: Bearer`。只有显式选择 `authentication = none` 才允许匿名；缺失令牌连接不会自动降级。切换为匿名时，应同时移除 auth 绑定；保留的连接仍遵循宿主的就绪检查。既有默认开发地址仅监听 loopback；从外部调用需要部署者配置可达地址和 TLS，复制的相对路径不会猜测反向代理域名。

```sh
curl --request POST 'https://YOUR_NUMEN_HOST/api/webhooks/AUTOMATION_ID/TRIGGER_ID' \
  --header 'Authorization: Bearer YOUR_WEBHOOK_TOKEN' \
  --header 'Content-Type: application/json' \
  --header 'Idempotency-Key: delivery-2024-01-31-001' \
  --data '{"date":"2024-01-31T12:00:00Z","customer":"Alice"}'
```

首次接受返回 `202 {"status":"accepted","runId":"..."}`，表示事件和 Run 已持久化，不表示流程执行成功。相同事件 ID 重试返回 `200 {"status":"duplicate","runId":"..."}`。去重范围是同 Revision、同 Trigger；激活新 Revision 后相同事件 ID 会被重新接受。相同 ID 的不同请求体仍视为重复，调用者必须为不同事件使用不同 ID；没有 ID 的每次请求都会创建新 Run。

`Idempotency-Key` 为 1–128 个可打印 ASCII 字符且不能全为空白。请求体为未压缩 UTF-8 JSON，最大 1 MiB，读取超时 30 秒，并受数据插件的深度/数组边界约束。输出仅含 `body`、`receivedAt` 和可选 `eventId`，不会携带 Authorization、Cookie 或完整请求 URL。

| HTTP 状态 | 含义 |
| --- | --- |
| 400 | JSON、事件 ID、值结构或保留字段无效 |
| 401 | 缺失或无效令牌 |
| 404 | 没有已启用的入口 |
| 408 | 请求体读取超时 |
| 413 | 请求体超限 |
| 415 | 不支持的内容类型、编码或字符集 |
| 503 | 订阅已失效或持久化接受失败，可按相同事件 ID 重试 |

禁用、换版、凭据轮换或卸载时，旧请求不能转投新订阅。提交后连接中断时，调用者应复用事件 ID 重试，以取得同一个 Run 回执。同步响应流程结果、HMAC、文件上传和草稿监听不在此版本范围内。

## 完整示例：接收事件并计算下月日期

保留上述 Webhook，顺序添加以下节点。引用字段选择 **Reference** 模式，可使用变量选择器或直接输入路径；任意 JSON 内部的动态字段（如 `.value.date`）需在路径中手动补全。下表的 `prepare`、`due`、`encode` 是示例 Source ID，实际配置时替换为各节点 Inspector 中显示的 Source ID。

| 节点 | 配置 |
| --- | --- |
| Merge Object Fields（`prepare`） | `base` 引用 `trigger.body`；`fields` 固定值 `{"source":"webhook"}` |
| Add to Date & Time（`due`） | `date` 引用 `steps.prepare.value.date`；`amount = 1`；`unit = months`；`timezone = UTC` |
| Stringify JSON（`encode`） | `value` 使用对象表达式：`event` 引用 `steps.prepare.value`；`dueAt` 引用 `steps.due.iso` |

发送前述请求后，`encode.text` 为下面对象的 JSON 文本：

```json
{
  "event": { "date": "2024-01-31T12:00:00Z", "customer": "Alice", "source": "webhook" },
  "dueAt": "2024-02-29T12:00:00.000Z"
}
```

Runs 的执行数据检查沿用既有分类与展示上限；含业务数据的字段可能显示受限提示。不要为方便调试把全部 Webhook body 标成公开数据。

## 插件展示扩展

Workbench 提供 `workbench:trigger-details@1` Slot，贡献内容为 `{ capability: {id, version}, component }`；组件收到 `{ automationId, trigger }`。从 `@numenjs/workbench/trigger-details` 导入契约。Webhook 的可选前端 Entry 负责入口展示和复制，禁用插件会移除贡献。服务端接收不依赖 Console 或 Workbench。

参考 n8n 的 [Edit Fields](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.set/)、[Date & Time](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.datetime/) 和 [Webhook](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.webhook/)；没有复制其运行时或 item 数据模型。
