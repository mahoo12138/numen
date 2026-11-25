# 28. 官方生态对照与平台差距

调研日期：2026-10-18。外部能力以官方文档为依据，Numen 状态以当前源码为依据；架构文档中的规划不代表代码已经实现。本轮选定 **MQTT 推送、SMTP 通知、CSV 转换**，沿用 Numen 的执行模型、独立 Capability、Credential/Connection 与 Schema 表单。使用步骤见 [消息与 CSV 指南](29-official-messaging-integrations.md)。

## 外部系统值得借鉴的能力

| 系统 | 官方能力依据 | 对 Numen 的适配判断 |
| --- | --- | --- |
| n8n | [SMTP Send Email](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.sendemail/)、[Extract From File](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.extractfromfile/)、[Convert to File](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.converttofile/) | 先形成“事件 → 转换 → 通知”的完整路径。每个操作保留自己的 Capability；不复制 n8n 的隐式 item 执行或 binary property 模型。 |
| Activepieces | [Piece Auth](https://www.activepieces.com/docs/build-pieces/piece-reference/authentication)、[Webhook Trigger](https://www.activepieces.com/docs/build-pieces/piece-reference/triggers/webhook-trigger) | 认证声明、订阅启用/握手/停用要作为完整生命周期处理。插件不能只封装一次 API 调用而忽略断线、凭据轮换和卸载。 |
| Node-RED | [MQTT Broker](https://cookbook.nodered.org/mqtt/connect-to-broker)、[Catch 与 Status](https://nodered.org/docs/user-guide/handling-errors) | 复用连接并显式回报断线状态。消息送达与持久 Run 成功是不同语义，不能将协议 ACK 当作下游业务完成。 |
| Temporal | [Workflow Execution](https://docs.temporal.io/workflow-execution)、[Schedule](https://docs.temporal.io/schedule) | 借鉴可恢复执行、重叠运行策略、迟到窗口和 backfill 的明确边界；不为几个插件引入另一套工作流服务。 |
| Quartz | [Job 并发](https://www.quartz-scheduler.org/documentation/quartz-2.3.0/tutorials/tutorial-lesson-03.html)、[SimpleTrigger misfire](https://www.quartz-scheduler.org/documentation/quartz-2.3.0/tutorials/tutorial-lesson-05.html) | 计划计算、运行互斥与漏跑处理需要分别建模。进程内锁和插件自己的定时器不能替代持久调度策略。 |

“适配判断”是结合这些来源与 Numen 源码作出的设计取舍，不表示这些产品使用相同的内部实现。

## 当前代码具备什么，还缺什么

| 领域 | 当前代码与差距 | 优先级 / 归属 |
| --- | --- | --- |
| 官方集成覆盖 | 已有 Echo、HTTP、Cron、数据/日期/Webhook、MQTT、SMTP、CSV；已补充 GitHub Webhook、Issue 查询/创建/评论、飞书文本通知和 RSS/Atom 读取。仍缺常见数据库、对象存储及更多 SaaS 专用封装。见 [Runtime 注册](../packages/runtime/src/app.ts) 和各 `integration-*` 包。 | 按实际场景补插件，不以空壳节点数量衡量生态。 |
| 外部包加载 | [Runtime](../packages/runtime/src/app.ts) 已支持 Loader、`$package` 和 Entry 生命周期；本轮浏览器用真实 MQTT 包的外部入口验证。注册/表单/执行不要求把插件逻辑写进 Workbench。 | 已有基础，不重建插件机制。 |
| 触发健康与生命周期 | [TriggerService](../packages/triggers/src/service.ts) 原有激活/停止和持久接受；本轮补充 `reportStatus()`，让长连接断线后可以回报 ERROR 并在恢复后 READY。同步激活/清理期间的重入也要串行重算并隔离旧订阅。 | 本轮通用适配修复。 |
| 自动化并发策略 | 后续本轮补齐 `maxActive/overflow/groupBy` 的持久准入：接受时冻结、按组排队、丢弃收据、按需替换最早运行、测试名额隔离，以及 Workbench 策略配置。SQLite v18 迁移、25 项准入组合测试和真实 Webhook 浏览器验收已通过。 | **P0 已交付**。行为与边界见 [运行并发与持久准入](30-run-admission.md)。单活跃 Scheduler；不承诺外部副作用严格一次。 |
| 错误处理与复用 | 已有 retry/timeout/cancel、Parallel/Race/ForEach 和持久恢复；[Source](../packages/core/src/automation.ts) 没有 Try/Catch/Finally 或子流程契约。普通 SMTP 节点可主动发送通知，但不是全局失败处理系统。 | **P1 平台**。定义错误分支、错误处理自身失败、父子 Run、版本与取消传播。 |
| OAuth | [Credential](../packages/credentials/src/service.ts) 已加密保存材料，[Connection](../packages/connections/src/service.ts) 支持版本快照与轮换；尚无通用 consent/state/PKCE/callback、scope、重新授权产品流程。 | **P1 平台**。先共享授权基础，再做依赖 OAuth 的 SaaS；不会恢复已停止的 Google Calendar 轮询方案。 |
| 可安装模板 | [Workbench 创建流程](../packages/workbench/src/AutomationSidebar.tsx) 从名称创建草稿；现有示例是说明与测试，没有模板安装、依赖检查、连接重绑定或通用导入流程。 | **P1 产品/平台**。参考 [n8n 模板](https://docs.n8n.io/build/ways-of-building-workflows/use-templates.md)，模板不能包含秘密或某台机器的 Connection ID，导入后保持未启用。 |
| 漏跑补发 | [Cron 插件](../packages/integration-schedule/src/index.ts) 生成当前计划事件；已经接受的 Run 可以恢复，不等于离线期间所有计划都已接受或会补发。 | **P1 平台**。明确迟到窗口、补发上限、时区、并发与用户主动 backfill。 |
| 分发与安装 | 已有 workspace 构建、包入口和本地消费机制；[生态设计](02-plugin-ecosystem.md) 中的 Marketplace/Installer 仍属规划。新集成包为 private，本轮不宣称可从 npm 安装。 | **P2 生态**。先冻结公开依赖契约与独立包消费验收，再建设分发。 |

这些差距中，并发准入、错误分支、子流程和 OAuth 都需要平台契约，不能通过某个插件扫描日志、直接操作 Scheduler 内部或另建状态数据库来补。

## 本轮实现范围

| 插件 | 已选定契约 | 本轮边界 |
| --- | --- | --- |
| MQTT | `mqtt:message@1`、`mqtt:publish@1`；密码和显式匿名 Adapter；MQTT 3.1.1 TCP/TLS；QoS 0/1；topic 通配、JSON/text、显式 retained 策略、可选业务 ID 去重。 | clean session，无离线消息补发保证。等待所有匹配 Trigger 的持久接受后才进行接收侧 QoS 1 ACK；存储失败断开而不 ACK，但 clean session 仍可能在断线后失去消息。协议 QoS 不等于工作流副作用恰好一次。 |
| SMTP | `smtp:send@1`；加密 Credential；固定发件人 Connection；强制 STARTTLS 或隐式 TLS；文本/HTML；accepted/rejected 收件人收据。 | 不含附件、任意 headers、文件/URL 读取。提交结果不确定时不自动重试；SMTP 接受不保证进入收件箱。 |
| CSV | `csv:parse@1`、`csv:stringify@1`；普通文本与行对象；BOM、引号、换行、显式列顺序；公式转义开关；字节/层级/元素/列数边界。 | 不含 Resource 文件操作、UTF-8 字节解码、XLSX/PDF、宿主磁盘路径或附件。字段保留字符串，默认公式保护的文本变化明确说明。 |

协议细节参考 [MQTT 3.1.1 规范](https://docs.oasis-open.org/mqtt/mqtt/v3.1.1/os/mqtt-v3.1.1-os.html)、[Nodemailer SMTP](https://nodemailer.com/smtp)、[SMTP 测试服务器](https://nodemailer.com/extras/smtp-server) 和 [RFC 4180](https://datatracker.ietf.org/doc/html/rfc4180)。实现使用已固定版本的库，不自造 SMTP 或 CSV 协议解析器。

验收使用真实本地 Broker、TLS/STARTTLS SMTP Server、SQLite、Credential、Connection、TriggerService 和 Scheduler。浏览器从配置凭据开始，发布并启用流程后发送消息，检查 Run 与邮件内容，再验证插件卸载/恢复与 Broker 断线。包测试补充认证失败、证书拒绝、部分接受、取消、超时、重启和边界输入。实际运行结果在交付时分别报告；本地 fixture 不替代外部 Broker/邮箱账号联调。

## 后续交付与下一批建议

1. **GitHub webhook 已实现**：手工配置回调，按事件/action 过滤，使用 delivery ID，基于原始 body 验证 HMAC；去重范围为同 Revision、同 Trigger。详见 [GitHub 插件](32-official-github-integration.md)。GitHub App 安装与订阅管理仍待后续；本地签名 fixture 不替代真实公网投递验收。
2. **飞书文本通知已实现**：加密 webhook URL、可选签名、消息大小边界和明确限流错误，沿用现有 Connection 和 HTTP 服务。详见 [飞书指南](../website/src/integrations/feishu.md)。Slack、消息卡片和应用机器人授权仍待后续。
3. **RSS/Atom 与 GitHub Issue 已实现**：参考 n8n 的独立操作设计，新增订阅快照读取，以及 PAT 连接下的 Issue 查询、创建与评论。RSS 不维护跨次游标；GitHub 写操作不自动重试。详见 [调研与边界](33-n8n-next-integrations-research.md)。
4. **Resource 文本/文件桥接与邮件附件**：使用已有 Resource 所有权、租约和回收机制。验证失败/取消清理、重启后可读和附件上限；不要开放任意宿主文件路径。
5. **模板安装流程**：先提供“MQTT 告警通知”“Webhook 数据清洗”“CSV 报告邮件”三个模板，以版本检查、连接重绑定和未启用草稿导入作为验收标准。

不引入 n8n/Activepieces/Node-RED 文件兼容层，不替换编辑器或执行模型，不做 Google Calendar 轮询，也不以新增插件为理由重写整个调度器。
