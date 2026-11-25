---
title: 核心概念
description: 理解 Draft、Revision、Activation、Run 与插件连接如何共同工作。
---

# 核心概念

Numen 把“正在编辑什么”“当前接收事件的版本是什么”和“某次运行实际执行了什么”分别记录。理解这几层后，发布、排查与恢复就更容易判断。

## 流程与版本

| 概念 | 含义 | 什么时候变化 |
| --- | --- | --- |
| **Automation** | 一个流程的稳定身份，带名称、启用状态和当前激活版本。 | 重命名、启停或切换激活版本时。 |
| **Draft** | 可编辑的流程草稿，保存 Source、展示信息和草稿版本号。 | 编辑并保存时。 |
| **Revision** | 从草稿发布的固定快照，包含 Source、编译计划和能力契约。 | 每次发布产生新版本；旧版本保持不变。 |
| **Activation** | 指向当前用于 Trigger 订阅的已发布版本。 | 激活另一 Revision 时。 |

发布只产生 Revision；激活选择接收事件的版本；启用 Automation 后才会建立有效订阅。某个 Trigger 还可能因 Provider 或 Connection 不可用而等待恢复。

草稿试运行另存固定的测试快照，不获得发布编号，也不能用于激活。修改 Draft 或激活新版本，都不会改写已接受的 Run。

## 一次运行的三个层级

**Run → Execution → Attempt** 分别回答不同的问题。

| 层级 | 回答的问题 | 示例 |
| --- | --- | --- |
| **Run** | 这次流程为什么运行，使用哪个快照，现在到哪一步？ | 一次 Webhook 事件创建一个 Run。 |
| **Execution** | 执行计划中的某个节点现在是什么状态，输入输出是什么？ | CSV 节点已完成，邮件节点正在等待连接恢复。 |
| **Attempt** | 某次具体 Provider 调用结果如何？ | 第一次 HTTP 请求超时，下一次尝试成功。 |

Run 的 `RUNNING` 不代表每个节点都在消耗 CPU：节点可能在等待定时器、重试退避或依赖恢复。Run 的 `QUEUED` 则表示已持久接受、尚未得到运行名额。

成功输出会持久保存。重启恢复时，已成功完成的节点复用输出；中断调用是否能再尝试，取决于能力声明及保存的执行状态。无法安全判断外部调用结果时，可能进入 `OUTCOME_UNKNOWN`，需要查看运行详情。

## Capability 与 Provider

**Capability** 是带版本的操作契约，例如 `data:json-parse@1`。它声明输入、输出、连接槽位及副作用语义。输入 Schema 同时用于 Workbench 自动生成配置表单。

**Provider** 是实际执行或监听该操作的实现。契约存在和 Provider 当前可用是两件事；插件停用后，编辑器可以保留原有引用，而运行需要等待兼容的实现恢复。

能力分为三类：

- **Trigger：** 接收事件并发起 Run，例如 Cron、Webhook、MQTT 消息。
- **Query：** 读取或计算数据，例如 Echo、日期计算。
- **Action：** 产生外部操作，例如 HTTP 请求、SMTP 提交邮件。

具体能力的幂等性和安全重试声明以其契约为准，不能仅根据名称或种类判断。

## Credential、Connection 与 Adapter

| 概念 | 保存或提供什么 |
| --- | --- |
| **Credential** | 令牌、密码等秘密值，使用宿主主密钥加密保存。 |
| **Connection** | 服务地址等配置、选定的 Adapter、固定版本的凭据引用及启用状态。 |
| **Connection Type** | 能力需要的连接契约。 |
| **Adapter** | 将配置与凭据转换成满足连接契约的运行时对象。 |

在节点的连接槽位选择兼容 Connection，而不是把密码写入流程参数。新建连接后需要单独启用；`READY` 的具体含义由适配器决定，例如 SMTP 的实际 TLS、认证和提交发生在执行时。

## 数据引用

输入可以是固定值、引用、模板或结构化表达式。常见引用路径包括：

```text
trigger.body.customerId
input.customerId
steps.prepare.value
```

第一条读取本次 Trigger 数据，第二条读取流程输入，第三条读取 ID 为 `prepare` 的上游节点输出。`prepare` 应替换成实际节点的 Source ID。

引用可见范围由流程结构决定。并发分组在接受 Run 时求值，因此只能读取 `trigger` 和 `input`，不能读取尚未执行的节点输出。模板也不是任意 JavaScript 执行入口。

继续阅读[编排与运行](./workflows.md)，或查看[架构参考](/reference/architecture)中的模块与执行模型。
