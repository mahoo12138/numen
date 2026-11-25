# 30. 自动化运行并发与持久准入

本轮补齐 `AutomationSource.policy` 的执行语义。并发策略控制一个流程中允许同时活动的 **Run 数量**；节点执行仍受 `scheduler.maxConcurrentExecutions` 的全局上限约束。Parallel、Race 和 ForEach 的多个节点属于同一 Run，不分别消耗流程运行名额。

## 配置与适用范围

在 Workbench 的流程设置中打开“并发控制”，设置最大活动运行数、达到上限时的处理方式，以及可选分组。保存草稿后发布新 Revision；正式运行使用自己的已接受版本，不因草稿编辑或后续发布而改写策略。

Source 示例：

```json
{
  "policy": {
    "maxActive": 2,
    "overflow": "queue",
    "groupBy": { "type": "ref", "path": "input.customerId" }
  }
}
```

这是 Source 中的策略片段，需要流程声明相应的 `customerId` 输入。使用 Trigger 数据时可改为 `trigger.customerId`；实际路径必须存在于接受的数据中。

| 配置 | 语义 |
| --- | --- |
| `maxActive` | 正的 JavaScript 安全整数。未设置时不限制流程活动 Run 数量；此时 overflow 不生效。 |
| `overflow` | `queue`、`drop` 或 `replace`，默认 `queue`。 |
| `groupBy` | 接受时求值的 ValueExpr，只能引用 `trigger` 和 `input`。未设置时使用流程的统一组。 |

`groupBy` 可以使用普通表达式、常量及其组合，但不能引用 `run`、步骤输出、变量、循环项或错误上下文。引用不存在、求值失败或结果不符合 NumenValue 时接受失败，不写入半成品 Run。分组值按 JSON 结构规范化后保存摘要：对象键顺序不影响分组；字符串 `"1"`、数字 `1`、`null`、`false` 和空字符串保持区别。这里沿用表达式及 NumenValue 校验，不继承外部 JSON 插件的 1 MiB、64 层等专用边界。

容量作用域由 **Automation ID、正式/测试命名空间、冻结分组值** 决定：

- 同一流程不同 Revision 的相同分组共享名额。每个候选 Run 仍使用自己接受时冻结的 `maxActive` 和 `overflow`。
- 修改上限不会主动取消已运行任务；新请求按自己的策略判断当前占用。新增或改变分组也不会重新分配既有 Run。
- 正式手动运行和 Trigger 运行共享正式名额。
- Revision 试运行、Draft 试运行和局部测试使用测试名额，彼此按同一流程和分组限制，与正式运行隔离。试运行不会触发正式任务替换，正式任务也不会替换测试任务。

## 到达上限后的行为

| 策略 | 行为 | 历史记录 |
| --- | --- | --- |
| `queue` | 保留 `QUEUED`，等待同组空位。其他未满组可以继续准入。 | 接受收据和排队 Run 保留。 |
| `drop` | 新 Run 在执行前取消，不创建节点 Execution 或 Provider Attempt。 | `CANCELLED`，取消原因为 `OVERFLOW`；保留接受收据和去重记录。 |
| `replace` | 从同组最早开始的运行中选择，只取消腾出所需名额的数量；等待取消完成后启动替代 Run。原有排队 Run 保留。 | 被替换 Run 使用 `REPLACED` 原因；新 Run 保留自己的接受身份。 |

例如同组上限为 2，A、B 已运行，C 排队，D 以 `replace` 到达。只取消较早开始的 A；B 继续运行、C 继续排队，D 等 A 释放名额后开始。不会取消整个分组，也不会清空 C。已经发起替换的 Run 在数据库保存预留意图，避免取消期间释放的名额被普通排队 Run 抢占；进程重启后继续处理该意图。

最早运行按保存的开始时间排序；开始时间相同则按接受序号排序。

存在同组替换预留时，后来的有限 `drop` 请求仍以 `OVERFLOW` 取消，不会借预留期排队并在之后执行；未设置 `maxActive` 的请求保持不限制语义。一次替换只选择一次待取消任务，不在等待清理期间追加取消后来进入的无限 Run。

正常排队顺序来自接受事务生成的持久递增序号，不使用毫秒时间戳加随机 ID 排序。相同时间戳、系统时间调整、SQLite `VACUUM` 或进程重启不会改变新接受 Run 的先后次序。不同组之间不承诺完成顺序。

## 哪些运行仍占用名额

`QUEUED` 表示已接受、尚未获准开始。已准入 Run 在节点等待定时器、重试退避、Provider/Connection 不可用、结构化子任务等待或外部结果 `OUTCOME_UNKNOWN` 时继续占用名额，不能通过进入 WAITING/BLOCKED 绕开上限。

取消先持久保存 `CANCELLING` 意图，再传播 AbortSignal 和取消子执行。现有取消 API 可以立即返回 `CANCELLED`，表示取消已提交、执行结果不再被接纳。本进程另外跟踪 Provider 原始调用 Promise：状态进入终态、取消或超时的包装 Promise 提前返回，都不代表底层调用已经停止。底层调用尚未 settled 时仍保留占用，替代运行继续等待。忽略取消且永不完成的 Provider 会阻止同组继续取得被占用的名额；不会以一个任意清理超时冒充已停止。

这项保证只覆盖进程中被跟踪的调用生命周期。Provider Promise settled 也不能证明远端服务撤销了已接收的请求；进程崩溃后更无法检查上一进程的 Promise。发送邮件、付款或其他外部副作用仍需由对应集成说明幂等性和结果不确定边界。并发控制不提供外部副作用严格一次承诺。

## 接受、去重与事务

Run 接受事务同时保存：

1. 固定执行快照引用、归一化输入和 Trigger 数据。
2. 冻结的策略、分组摘要、正式/测试命名空间及递增接受序号。
3. 手动请求或 Trigger 事件去重记录、接受事件，以及该接受路径需要的 Resource 所有权。

任一步失败则整体回滚。相同请求重投首先查找已接受的 Run；不会重新分组、重复占用名额或重新执行 overflow。`drop` 也是已持久接受的运行结果，因此 Webhook/MQTT 等集成仍返回或确认原有接受收据。接收成功只表示事件与 Run 已持久化；查看 Run 状态才能区分排队、被丢弃、被替换或执行完成。

SQLite v18 新增内部 `run_admissions` 表，保存接受序号和策略；已有 `runs.group_key` 保存分组摘要。Run 删除时 admission 通过外键级联删除，Automation purge 沿用已有 Resource Owner 清理规则。取消和丢弃保留运行历史，不提前释放历史仍引用的资源。

## 升级与恢复

v18 数据库迁移只创建表和索引，不重编译或改写旧 Revision、Run、Execution、Attempt 和资源归属。Scheduler 启动时，在调度新工作前为缺少 admission 的历史活动 Run 回填；策略从该 Run 的固定快照读取，分组从其已保存的输入和 Trigger 数据求值。

历史回填按 `created_at`、迁移时可见的旧 Run `rowid` 建立确定顺序。旧数据库没有保存本次新增的接受序号；若历史同毫秒插入顺序已因维护操作丢失，不能声称恢复了原始严格 FIFO。回填生成的序号之后保持稳定。

历史策略、快照或分组无法恢复时：未启动的排队 Run 明确失败；已运行 Run 保守保留占用并记录 `AdmissionRecoveryFailed`，不把未知状态默认为空闲。无法确定分组的历史活动 Run 不能通过换一个分组绕过；需要检查运行详情并处理旧任务。回填必须幂等，不能每次启动重新排序或重复记录恢复失败。

实现面向一个活跃 Scheduler。事务保护单次准入决定；当前没有跨进程 worker lease、leader election 或活跃 worker fencing，不支持同时运行多个 Scheduler 连接同一数据库的生产部署。进程重启会按已有规则恢复安全重试、外部结果未知及取消意图。

## 验证记录与边界

2026-10-18 在当前工作区实际完成：

| 检查 | 结果 |
| --- | --- |
| `pnpm typecheck` | 通过。 |
| `pnpm build` | 通过；全量浏览器命令也重新构建主程序和示例插件。 |
| `pnpm test` | **165 个文件、1503 项测试通过**。 |
| `pnpm test:e2e` | **123 项浏览器测试通过**。 |
| `pnpm numen config validate` | 默认配置通过。 |
| `pnpm numen config validate --config deploy/numen.config.yml` | 部署配置通过。 |
| `git diff --check` | 通过。 |

新增准入组合测试 25 项，覆盖真实 SQLite 接受事务、同毫秒 FIFO、结构分组、140 条排队请求跨页公平性、等待/阻塞/未知结果占位、幂等收据、旧数据回填、重启恢复、替换预留、非协作 Provider 及迟到结果屏蔽。即时唤醒测试将一致性扫描间隔设为 60 秒，验证新的接受请求无需等待扫描或旧调用结束。双连接仅验证接受 API 幂等，执行验收仍使用单个 Scheduler。

数据库 6 个文件、24 项测试覆盖 populated v17 历史保留、外键和字段约束、Run/admission 一致回滚、迁移失败重试、删除与 VACUUM 后序号保持、尾序号不复用。表达式回归确认不能把继承属性误当作输入字段，自有 JSON 字段仍可读取。

新增浏览器组合使用真实 HTTP Webhook、SQLite、TriggerService 和 Scheduler，验证设置自动保存、撤销/重做、无效输入保护、发布启用、跨 Revision 的 queue/replace/drop、旧排队任务保留，以及发布版本试运行与正式运行隔离。桌面与中文手机截图已检查。

尚未验证真实外部服务在取消后的行为、网络分区或生产规模压力；不支持多个活跃 Scheduler 共同执行同一数据库。浏览器验收为 Chromium，未覆盖 Firefox/Safari。本地 Provider fixture 的成功不代表远端副作用已撤销。

代码入口：[数据库迁移](../packages/database/src/migrations.ts)、[Scheduler](../packages/scheduler/src/service.ts)、[流程策略类型](../packages/core/src/automation.ts)、[策略配置界面](../packages/workbench/src/AutomationAdmissionSettings.tsx)。
