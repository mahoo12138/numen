---
description: 使用 MQTT 推送接收业务数据，经 CSV 转换后通过 SMTP 发送报告。
---

# 消息与通知：MQTT → CSV → SMTP

这条流程将设备事件整理成 CSV 文本并发送邮件。需要一个可访问的 MQTT Broker 和支持 TLS 的 SMTP 账号；本地协议测试通过不代表你的外部账号已经联调。

## 配置 MQTT {#mqtt}

在 Credentials 创建 **MQTT Username and Password** (`mqtt:password@1`)，然后创建 **MQTT Password Authentication** Connection：

```json
{
  "url": "mqtts://broker.example.com:8883",
  "clientId": "numen-device-reports",
  "timeoutMs": 10000
}
```

`clientId` 可省略，默认由 Connection ID 派生。多个运行实例必须使用不同 ID。用户名和密码只能填在 Credential，不能嵌入 URL。允许匿名的 Broker 必须显式使用 `mqtt:anonymous@1` Adapter。

启用 Connection，为 **MQTT Message** Trigger 的 `client` 槽位绑定它，设置：

```json
{
  "topicFilter": "numen/reports/demo",
  "qos": 1,
  "format": "json",
  "includeRetained": false,
  "eventIdField": "id"
}
```

连接 READY 表示托管 Runtime 可用；Trigger 还需要实际连接 Broker 并订阅成功。断线会使 Trigger 不可用，重连并订阅成功后恢复。

- 支持 MQTT 3.1.1 的 `mqtt://` 与 `mqtts://`，QoS 0/1；不含 WebSocket、QoS 2、共享订阅和代理传输。
- `+` 匹配一级，末尾 `#` 匹配剩余层级。前置通配符不匹配 `$` 系统主题。
- JSON/text 都要求有效 UTF-8、最大 1 MiB。业务 ID 是可选的 JSON 顶层非空字符串，最多 256 UTF-8 字节；配置该字段后，缺失或非法 ID 会丢弃该消息。
- 默认不接受订阅时的 retained 快照。当前使用 clean session，离线和重订阅期间的消息可能丢失；retained 不等于消息积压队列。

## 配置 SMTP {#smtp}

创建 **SMTP Username and Password** (`smtp:password@1`) Credential，填入账号及密码或应用专用密码。创建 **SMTP with Password** Connection：

```json
{
  "host": "smtp.example.com",
  "port": 587,
  "tls": "starttls",
  "from": "reports@example.com"
}
```

STARTTLS 必须升级成功才能认证；隐式 TLS 使用 `tls = tls`，默认端口 465。证书和主机名始终校验。私有服务可通过 `caPem` 配置 CA PEM，但不能关闭校验。

发件人固定在 Connection，地址使用单个裸 ASCII 邮箱，不含显示名。启用 Connection 后，**Send Email** 节点的 `transport` 槽位绑定此连接。READY 表示发送 Runtime 已初始化；真正的远端连接和认证发生在发送时。

## 连接流程 {#csv}

在 MQTT Trigger 后顺序添加：

| 节点 | 配置 |
| --- | --- |
| **Remove Duplicate Items** | `items` 引用 `trigger.payload.rows`；`key = device` |
| **Stringify CSV** | `rows` 引用 `steps.<去重节点ID>.items`；`columns` 固定数组 `["device", "value"]`；`delimiter = ,`；`escapeFormulas = true` |
| **Send Email** | `transport` 绑定 SMTP Connection；`to` 固定数组 `["your-address@example.com"]`；`subject = Device report`；`text` 引用 `steps.<CSV节点ID>.text` |

邮件携带 CSV **正文**，当前没有附件。单独使用 `csv:parse` 可把已有 CSV 文本转换成行对象，它保留字符串，例如 `001` 不会被转换成数字。

CSV 支持 BOM、引号内分隔符和多行内容；空文本返回空数组。重复/空白列名、格式错误和列数不一致会失败。最多 256 列，完整输入输出还受 1 MiB、64 层、累计 10,000 个数组元素边界限制。

导出默认给公式前缀增加单引号，包括负数的文本形式。向可信机器消费者输出、需要保留原值时，可显式关闭 `escapeFormulas`。

## 发布与验证

发布 Revision、激活并启用流程，等待 MQTT Trigger 就绪。使用你自己的 MQTT 客户端向 `numen/reports/demo` 以 QoS 1 发布：

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

打开 **Runs**，检查 Trigger 输入、去重输出和 CSV 文本：

```csv
device,value
sensor-a,21
sensor-b,18
```

SMTP 输出包含 `messageId`、`accepted` 和 `rejected`。部分收件人被拒绝仍会返回成功结果，后续业务应检查 `rejected`。再次发布相同业务 ID，在同 Revision、同 Trigger 下应复用原 Run；换 ID 才是新事件。换 Revision 后会重新接受。

## 接受、恢复和副作用

接收侧 QoS 1 ACK 等待所有匹配且有效的 Trigger 持久接受或去重后发出。存储失败或接受超时会断开而不 ACK，但 clean session 仍不保证重连后补发。非法消息会被丢弃并确认，避免堵住连接。

`mqtt:publish` 的 QoS 1 成功表示 Broker 已返回 PUBACK，QoS 0 表示本地写出；都不表示下游业务完成。SMTP 成功表示服务器接受邮件提交，也不等于进入收件箱。

MQTT 发布和 SMTP 发送都声明为非幂等、不可安全自动重试。连接可能在外部服务已接受后中断，人工重跑可能重复发送。取消也无法撤回已提交的消息。

SMTP 只支持最多 50 个收件人、文本和可选 HTML，输入内容总量最多 1 MiB；不支持附件、自定义 headers、文件或 URL 内容。每条 Connection 默认最多 4 个同时发送、16 个排队发送，整体超时默认 30 秒且包含排队时间。

[MQTT 详细契约](https://github.com/Mahoo12138/numen/blob/main/packages/integration-mqtt/README.md) · [CSV 边界](https://github.com/Mahoo12138/numen/blob/main/packages/integration-csv/README.md) · [SMTP 发送语义](https://github.com/Mahoo12138/numen/blob/main/packages/integration-smtp/README.md)
