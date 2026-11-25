---
description: Numen 官方集成的能力、连接要求与使用边界。
---

# 官方集成

从本地数据处理到外部事件和通知，当前工作区提供 12 个官方集成。每个操作都是独立的版本化 Capability；下表中的版本均为 `1`。

**Trigger** 接收事件并创建 Run，**Query** 读取或转换数据，**Action** 执行操作。Query 和 Action 都可作为流程节点。数组是普通值，需要逐项执行时使用 ForEach。

::: info 从源码使用
这些集成包含在当前工作区及默认配置中。本页不表示它们已发布到 npm，也不提供未经发布验证的安装命令。已有部署升级时，需要在配置文件中显式加入新增插件。
:::

| 集成 | 默认配置项 | Capability | 类型 |
| --- | --- | --- | --- |
| [Echo](#echo) | `demo` | `demo:echo` | Query |
| [HTTP](#http) | `httpIntegration` | `http:request` | Action |
| [Cron](#cron) | `schedule` | `schedule:cron` | Trigger |
| [数据处理](#data) | `data` | `data:json-parse`、`data:json-stringify`、`data:object-merge`、`data:array-unique` | Query |
| [日期时间](#datetime) | `datetime` | `datetime:now`、`datetime:format`、`datetime:add`、`datetime:diff` | Query |
| [Webhook](#webhook) | `webhook` | `webhook:receive` | Trigger |
| [GitHub](#github) | `github` | `github:webhook`、`github:issue-get`、`github:issue-create`、`github:issue-comment` | Trigger / Query / Action |
| [CSV](#csv) | `csv` | `csv:parse`、`csv:stringify` | Query |
| [MQTT](#mqtt) | `mqtt` | `mqtt:message` / `mqtt:publish` | Trigger / Action |
| [SMTP](#smtp) | `smtp` | `smtp:send` | Action |
| [RSS / Atom](#rss) | `rss` | `rss:read` | Query |
| [飞书](#feishu) | `feishu` | `feishu:send-text` | Action |

## Echo {#echo}

`demo:echo` 接收 `{ message }`，原样返回 `{ message }`。无需网络或 Connection，适合验证第一个流程、字段引用和运行结果。界面中的名称为 **Echo**。

[从快速开始运行第一个流程](/guide/getting-started)

## HTTP {#http}

`http:request` 通过宿主管理的 HTTP 客户端发送请求，支持 GET、HEAD、POST、PUT、PATCH、DELETE，以及文本或 JSON 请求体。返回 `ok`、`status`、`statusText`、`headers`、`bodyType`、`body`。

```json
{
  "method": "GET",
  "url": "https://example.com/",
  "timeoutMs": 10000
}
```

请求和响应的默认边界各为 1 MiB；只支持 HTTP(S)，URL 中不能包含用户名和密码。HTTP 状态错误由返回的 `ok` / `status` 表达；网络、超时、非法响应和超限会抛出错误。请求使用宿主 HTTP 代理配置，但不要把秘密直接写进工作流字段；需要鉴权的服务应通过 Credential 支持的集成接入。

由于方法和目标可以动态变化，此能力统一声明为有副作用、非幂等、不可安全自动重试。[源码与配置项](https://github.com/Mahoo12138/numen/blob/main/packages/integration-http/src/index.ts)

## Cron {#cron}

`schedule:cron` 使用五字段表达式：**分 时 日 月 星期**。例如 `*/5 * * * *` 表示每五分钟一次；`timezone` 默认 UTC，可指定 `Asia/Shanghai`。输出为 `{ scheduledAt }`。

流程发布、激活且启用后才会订阅。当前实现计算未来的计划时间；已经接受的 Run 可以恢复，进程离线期间没有接受的计划不会自动补发。它不是秒级 Cron，也不是外部服务轮询。

## 数据处理 {#data}

| 操作 | 输入 | 输出 |
| --- | --- | --- |
| `data:json-parse` | `text` | `{ value }` |
| `data:json-stringify` | `value` | `{ text }` |
| `data:object-merge` | `base`、`fields` | `{ value }` |
| `data:array-unique` | `items`，可选 `key` | `{ items }` |

对象合并是浅合并：`fields` 覆盖同名字段，不修改输入。去重保留第一次出现的值，结构比较忽略对象键顺序；指定 `key` 时，它是顶层字段名，缺失字段会报错。

完整输入、输出分别受 UTF-8 JSON **1 MiB、64 层深度、累计 10,000 个数组元素**限制。非法 JSON、非有限数和超限值明确失败。外部 JSON 任何层级的 `$resource` 都被拒绝，以免伪造内部资源引用。

## 日期时间 {#datetime}

| 操作 | 输入 | 输出 |
| --- | --- | --- |
| `datetime:now` | `timezone` | `{ iso, epochMs, timezone }` |
| `datetime:format` | `date`、`format`、`timezone` | `{ text }` |
| `datetime:add` | `date`、`amount`、`unit`、`timezone` | `{ iso, epochMs, timezone }` |
| `datetime:diff` | `start`、`end`、`unit`、`timezone` | `{ value, unit }` |

日期使用 ISO 字符串；无 offset 时按指定时区解释，默认 UTC，不采用服务器本地时区。不存在或有歧义的本地时间会报错，可用明确 offset 消歧。

支持 `milliseconds`、`seconds`、`minutes`、`hours`、`days`、`weeks`、`months`、`years`。日、周、月、年的加减要求整数，采用日历规则；`2024-01-31` 加一个月得到 `2024-02-29`。跨夏令时，加一天可能不等于加 24 小时。格式使用 Luxon token，如 `yyyy-MM-dd HH:mm:ss`。

`datetime:now` 会实际采样当前时间，因此不是幂等操作，也不声明可安全重试。已成功持久化的节点输出在恢复时复用。

## Webhook {#webhook}

`webhook:receive` 接收 POST JSON，在事件和 Run 持久化后立即返回回执。默认 Bearer token 鉴权，也支持显式匿名。固定入口属于 Automation 与 Trigger；草稿没有临时监听地址。

[配置入口、鉴权与完整示例 →](./webhook)

## GitHub {#github}

`github:webhook` 验证 GitHub 原始请求体的 HMAC-SHA256 签名，按事件和 action 筛选投递，通过 `auth` 槽位绑定 `github:webhook-auth@1` Connection。Webhook Secret 保存在 Credential 中。

通过验证的 `ping` 只返回确认；匹配的业务事件持久化后创建 Run。同 Revision、同 Trigger 的相同 delivery ID 返回原 Run，重启后仍可去重。激活新 Revision 会开始新的去重范围。签名覆盖请求体，不覆盖事件类型和 delivery ID 请求头。

`github:issue-get` 查询 Issue，`github:issue-create` 创建 Issue，`github:issue-comment` 添加评论。这三个操作通过 `api` 槽位绑定 GitHub API Token Connection，与 Webhook Secret 分开。写操作不自动重试。

[配置 GitHub Webhook、签名与去重 →](./github) · [配置 Token 与 Issue 操作 →](./github-actions)

## CSV {#csv}

`csv:parse` 将文本变为 `{ rows, columns }`，单元格保持字符串；`csv:stringify` 将行对象变为 `{ text }`。支持逗号、分号和 Tab，识别 BOM、引号及多行单元格。

导出默认启用公式转义，会改变以公式前缀开头的文本。当前操作处理文本与普通对象，不读取宿主文件、不输出 Resource，也不支持 XLSX。

[在报告流程中使用 CSV →](./messaging#csv)

## MQTT {#mqtt}

`mqtt:message` 订阅 Broker 推送，`mqtt:publish` 发布 UTF-8 文本。两者通过 `client` 槽位绑定 `mqtt:client@1` Connection；支持用户名密码或显式匿名、TCP/TLS、QoS 0/1。

当前使用 clean session，不保证离线补发。可从 JSON 顶层字段提取业务 ID，为同 Revision、同 Trigger 去重；协议 QoS 不等于工作流副作用恰好一次。

[配置 Broker 与消息流程 →](./messaging#mqtt)

## SMTP {#smtp}

`smtp:send` 通过 `transport` 槽位绑定 `smtp:transport@1` Connection，发送文本及可选 HTML 邮件。用户名和密码保存在 Credential，发件人固定在 Connection。必须使用已验证的 STARTTLS 或隐式 TLS。

输出包括 `messageId`、`accepted`、`rejected`。服务器接受提交不代表最终送达；部分拒收需要检查 `rejected`。当前不含附件、任意请求头或文件读取，不会自动重发结果不确定的邮件。

[配置 SMTP 与发送报告 →](./messaging#smtp)

## 飞书 {#feishu}

`feishu:send-text` 使用 `bot` 槽位绑定 `feishu:bot@1` Connection，向群自定义机器人提交文本。Webhook 地址和可选签名密钥保存在 Credential；发送使用宿主 HTTP 客户端，明确报告限流、拒绝、取消和超时，不自动重试。

[配置飞书机器人与 GitHub 通知 →](./feishu)

## RSS / Atom {#rss}

`rss:read` 读取 RSS 2.0 或 Atom 1.0，返回订阅信息、标准化的 `items` 数组和截断信息。无需 Connection，可与 Cron、ForEach、GitHub 和飞书组合。保留原始顺序与重复条目；它读取当前快照，不维护跨次执行的已读游标。

[读取订阅并逐条创建 Issue →](./rss)
