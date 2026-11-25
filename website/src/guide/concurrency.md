---
title: 并发控制
description: 配置流程运行上限、按业务字段分组，以及排队、丢弃和替换策略。
---

# 并发控制

在流程“设置 → 并发控制”中，限制同时活动的 **Run 数量**。一个 Run 内的 Parallel、Race 或 ForEach 节点不会分别消耗流程名额；节点执行还受 Scheduler 的全局 `maxConcurrentExecutions` 上限约束。

## 配置策略

| 字段 | 作用 |
| --- | --- |
| 最大活动运行数 `maxActive` | 正的 JavaScript 安全整数；留空表示不限制。 |
| 达到上限时 `overflow` | `queue` 排队、`drop` 丢弃新运行、`replace` 替换最早活动运行。默认为 `queue`。 |
| 分组值 `groupBy` | 接受 Run 时求值的表达式，只能引用 Trigger 数据和流程输入。未设置时整个流程使用同一组。 |

以下是 Automation Source 的策略片段，需要流程已声明 `customerId` 输入：

```json
{
  "policy": {
    "maxActive": 2,
    "overflow": "queue",
    "groupBy": { "type": "ref", "path": "input.customerId" }
  }
}
```

使用 Webhook 的客户字段时，可将路径改为 `trigger.body.customerId`。接受数据必须具有这个路径，缺失或求值失败会明确拒绝接受；不会创建半成品 Run。

`maxActive` 留空时，即使配置了 `drop` 或 `replace`，也不会隐式启用限制。

## 到达上限后

| 策略 | 新运行的处理 | 已有记录 |
| --- | --- | --- |
| 排队 `queue` | 保持 `QUEUED`，空位可用后开始。其他未满分组可以继续。 | 保留接受记录与排队 Run。 |
| 丢弃 `drop` | 在执行节点前取消。 | Run 为 `CANCELLED`，原因为 `OVERFLOW`；保留去重记录。 |
| 替换 `replace` | 取消同组最早开始的活动运行，只选择腾出所需名额的数量，清理完成后启动新 Run。 | 被替换 Run 原因为 `REPLACED`，其他排队任务保留。 |

例如上限为 2，A、B 已运行，C 排队，D 按 `replace` 到达：取消较早开始的 A，B 继续，C 保留排队，D 等待 A 释放名额后开始。

替代 Run 会保存预留意图，避免清理期间刚释放的空位被普通排队任务抢占。取消中的任务仍可能需要等待底层调用完成。

## 分组、版本和测试隔离

名额的范围由 **Automation ID + 正式/测试类别 + 分组值** 决定。

- 同一流程、同一分组的不同 Revision 共享名额，但每个新 Run 按自己的固定版本策略申请准入。
- 分组在接受时冻结。对象键顺序不影响分组；字符串 `"1"` 和数字 `1` 属于不同组。
- 改草稿、发布新版本或修改上限，不会重新分组已有 Run，也不会主动取消既有任务。
- 正式手动运行与 Trigger 运行使用正式名额。
- 草稿试运行、发布版本试运行和局部测试共用测试名额，与正式名额隔离。测试的 `replace` 不会取消正式 Run。

并发隔离不隔离外部副作用。测试仍可能调用同一个邮箱或 Broker，详见[编排与运行](./workflows.md#选择测试范围)。

## 什么会继续占用名额

Run 获准开始后，即使节点处于定时等待、重试退避、依赖阻塞或 `OUTCOME_UNKNOWN`，仍然占用名额。只有 `QUEUED` 尚未占用活动名额。

取消状态表示取消意图已提交、后续结果不再被接纳。本进程还会跟踪 Provider 的原始调用：包装层因取消或超时先返回时，底层调用尚未结束，名额仍然保留。忽略取消且永不结束的 Provider 会持续阻塞该名额。

Provider 调用结束也不代表外部系统撤销了已经接受的请求。并发控制不会提供邮件、支付或其他远端操作“严格一次”的保证。

## 队列与重启

新 Run 的排队次序来自接受事务中的持久递增序号，不依赖随机 ID 或时间戳精度。重启后，队列、分组和替换预留继续保留；不同分组之间不承诺完成顺序。

数据库升级时，历史活动 Run 会从原有快照、输入和 Trigger 数据回填策略。旧数据库没有保存新接受序号，不能保证恢复此前已经丢失的同毫秒原始顺序；回填后的次序保持稳定。

`drop` 也属于已持久接受的结果。事件重投仍取得原来的 Run，而不是再尝试创建一个；通过 Run 状态区分“已接受”与“已执行”。

::: warning 部署边界
当前仅支持一个活跃 Scheduler 执行同一数据库，没有多 worker 的租约和领导者选举。不要让多个运行时共同调度同一个 SQLite 数据库。进程崩溃后也无法证明上一进程发出的远端请求已经停止。
:::

实现入口：[Scheduler](https://github.com/Mahoo12138/numen/blob/main/packages/scheduler/src/service.ts) · [流程策略类型](https://github.com/Mahoo12138/numen/blob/main/packages/core/src/automation.ts)。
