# 29. 官方消息、通知与 CSV 插件

这一批补上“消息到达 → 整理数据 → 生成 CSV → 邮件通知”的路径。三个独立包均使用现有 Capability、Credential、Connection、Schema 和 Scheduler，默认配置启用其定义；只有用户配置并启用 Connection/Automation 后才连接外部服务。它们不需要独立的前端 Entry。

| 包 | 版本 1 Capability | 用途 |
| --- | --- | --- |
| `@numenjs/integration-mqtt` | `mqtt:message` / `mqtt:publish` | Broker 推送触发、向 topic 发布消息 |
| `@numenjs/integration-smtp` | `smtp:send` | 使用认证 SMTP 与 TLS 提交文本或 HTML 邮件 |
| `@numenjs/integration-csv` | `csv:parse` / `csv:stringify` | CSV 文本与行对象数组互转 |

字段、返回值、限制与协议测试详见 [MQTT](../packages/integration-mqtt/README.md)、[SMTP](../packages/integration-smtp/README.md)、[CSV](../packages/integration-csv/README.md)。竞品能力依据和后续平台优先级见 [生态对照](28-ecosystem-comparison.md)。这批交付不包含 Google Calendar 轮询、附件、XLSX、OAuth、可安装模板或 npm 发布。

## 配置连接

1. 配置运行时的 `NUMEN_MASTER_KEY`，在 **Connections → Credentials** 创建密码凭据。MQTT 和 SMTP 使用各自的 Credential Type，不在 Automation 输入或全局插件 YAML 中保存密码。
2. MQTT 选择 `mqtt:password@1` Adapter，配置 Broker URL，例如 `mqtts://broker.example.com:8883`，绑定 MQTT 凭据。明确允许匿名的 Broker 可选择独立的 `mqtt:anonymous@1` Adapter；缺失密码不会自动降级为匿名。
3. SMTP 选择 `smtp:password@1` Adapter，配置 `host`、`port`、`tls` 和固定 `from`。`tls` 使用 `starttls`（默认端口 587）或 `tls`（默认端口 465）。私有 CA 可粘贴到 `caPem`；证书验证始终开启。
4. 单独启用两个 Connection。MQTT Connection 的 READY 表示客户端已初始化；实际 Trigger 要在 CONNACK 和 SUBACK 完成后才可用。SMTP 为按需连接，实际认证、TLS 和提交结果以执行为准。

MQTT 使用 MQTT 3.1.1 的 TCP/TLS 连接，不通过 HTTP 代理；SMTP 同样使用自己的 TCP/TLS 协议。需要为实际部署配置对应网络出口。配置 SMTP 的 `from` 应符合邮件服务商对账号发件地址的要求。

## 在 Workbench 创建完整流程

创建 Automation，按顺序添加下列节点。下表中的 `<节点 ID>` 由画布实际节点决定；Reference 模式填写路径本身，不加模板括号。

| 节点 | 配置 |
| --- | --- |
| MQTT Trigger (`mqtt:message`) | `client` 绑定 MQTT Connection；`topicFilter` = `numen/reports/+`；`qos` = `1`；`format` = `json`；`includeRetained` = `false`；`eventIdField` = `id` |
| Remove Duplicate Items (`data:array-unique`) | `items` Reference = `trigger.payload.rows`；`key` = `device` |
| Stringify CSV (`csv:stringify`) | `rows` Reference = `steps.<去重节点 ID>.items`；`columns` Literal JSON = `["device", "value"]`；`delimiter` = `,`；`escapeFormulas` = `true` |
| Send Email (`smtp:send`) | `transport` 绑定 SMTP Connection；`to` Literal JSON = `["your-address@example.com"]`；`subject` = `Device report`；`text` Reference = `steps.<CSV 节点 ID>.text` |

邮件的 CSV 在正文中，首版不提供附件。`csv:parse` 则用于接收已有 CSV 文本；解析保留字符串，不把编号 `001` 隐式转换成数值。多行文本字段使用通用多行编辑器，Tab 分隔符显示为 `"\t"`，保存的仍是真实 Tab 字符。

发布 Revision，在 **Revisions** 激活，再开启 **Enable Automation**。确认 Trigger 可用后，使用 Broker 的管理工具或 MQTT 客户端向 `numen/reports/demo` 发布 QoS 1 JSON 消息：

```json
{
  "id": "device-report-001",
  "rows": [
    { "device": "sensor-a", "value": 21 },
    { "device": "sensor-a", "value": 21 },
    { "device": "sensor-b", "value": 18 }
  ]
}
```

在 **Runs** 检查 Trigger 数据、CSV 输出和 SMTP 收据。CSV 应为：

```csv
device,value
sensor-a,21
sensor-b,18
```

再次发布同一 `id`，同 Revision、同 Trigger 不应新增 Run。修改 `id` 后才是新的业务事件。新 Revision 有独立的去重范围。不要使用随连接复用的 MQTT packet ID 代替业务 ID。

## 接受、恢复与副作用边界

- MQTT 是 Broker 推送订阅，不定时轮询。断线后客户端重连，Trigger 显示等待；重新订阅成功后恢复。停用流程、插件卸载和 Credential 轮换都会隔离旧订阅。
- 首版 MQTT 使用 clean session，不承诺 Numen 离线时的消息补发。QoS 0 可能丢失；QoS 1 允许重复。业务 ID 去重与 Run 持久接受不能把所有下游副作用变为恰好一次。
- `includeRetained` 默认关闭，避免新启用的流程把历史 retained 值误当新事件；开启后会接受 Broker 在订阅时返回的 retained 消息。
- MQTT publish 成功表示当前 QoS 对应的客户端/Broker 发布完成，不表示订阅端的业务处理完成。SMTP 成功表示服务器接受提交，不表示最终投递到收件箱。
- SMTP 的部分收件人拒收通过 `accepted` / `rejected` 返回。服务器已接收 DATA 而最终响应丢失时，结果可能不确定；SMTP 和 MQTT publish 都声明为非幂等、不可安全自动重试。人工重跑可能重复外部副作用。
- CSV 和 MQTT JSON 复用有界 JSON 校验，拒绝 `$resource` 伪造资源引用，安全处理原型相关字段。CSV 导出默认给公式前缀加单引号，这会改变文本；向可信机器消费者导出且要求原值时，可显式关闭 `escapeFormulas`。

## 对外部插件适配的验证方法

生产运行时支持内建别名和 `$package` 加载。可在构建后使用插件的绝对入口路径，例如：

```yaml
plugins:
  # 替换默认 mqtt 项，不要同时重复注册同一份 Contract。
  externalMqtt:
    $package: /absolute/path/to/numen/packages/integration-mqtt/dist/index.js
```

三个插件没有把字段表单、连接槽位或执行逻辑硬编码到 Workbench。此次为实际使用补齐两处通用能力：`TriggerActivation.reportStatus()` 回报订阅健康状态，以及 `numen/multiline` Schema role/空白枚举标签。旧 Trigger Provider 不实现健康回调时保持原有行为。

测试分为包级协议测试和浏览器组合测试：

```sh
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm numen config validate
pnpm numen config validate --config deploy/numen.config.yml
```

浏览器组合用临时 SQLite、真实本地 MQTT Broker 和具有测试 CA 的 SMTP Server，经过表单配置、发布、推送、执行及插件停用/恢复；并通过 `$package` 加载 MQTT 入口验证独立包适配。测试服务只监听回环地址，不发送真实外部邮件。对外部 Broker、邮箱账号及网络的验收需要另行完成；本地协议验收不等于这些服务已完成联调。

### 本轮实际验证（2026-10-18）

- `pnpm typecheck` 通过；生产构建通过。
- `pnpm test`：160 个测试文件、1,387 项测试全部通过。
- `pnpm test:e2e`：122 项 Chromium 浏览器测试全部通过。最终消息插件代码更新后，另行重跑 `messaging-integrations.spec.ts`，1/1 通过。
- 默认与 `deploy/numen.config.yml` 两份配置校验、`git diff --check` 通过。
- 真实协议覆盖：MQTT 18 项、SMTP 28 项；CSV 30 项。SMTP 包含独立 Node 进程反复 TLS/STARTTLS 证书拒绝与立即关闭；消息提交后断连、超时、SQLite 重启均检查没有自动重发。
- 额外隔离审计复跑了可信 CA 的 MQTT TLS 收发，以及 128 filters / 256 subscriptions 容量与释放，共 2 项通过；测试信任根仅注入该测试进程。

本轮未验证真实外部邮箱投递、真实外部 Broker、Docker 容器运行、Firefox/Safari，也未发布 npm 包。MQTT clean session 的离线缺口和 SMTP 提交结果不确定的边界仍然适用。
