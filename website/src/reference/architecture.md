---
description: 当前 Numen 的模块边界、运行数据流，以及架构设计文档和已实现能力的区别。
---

# 架构与源码导航

Numen 是建立在 Cordis 之上的个人自动化 Runtime。SQLite 保存用户配置与执行事实，插件提供能力和连接，Workbench 负责编辑与检查；持久化记录与进程内订阅、socket、Provider 分开管理。

本页按当前工作区源码整理。仓库原有 `docs/` 同时包含设计提案、阶段决策与历史验收记录，不能把其中的未来规划直接理解为已经实现。

## 一次事件如何成为 Run

1. 用户编辑 **Automation Draft**，编译器校验 Schema、表达式引用和控制流。
2. 发布生成不可变的 **Revision**；激活版本并启用流程后，TriggerService 根据当前版本建立订阅。
3. Trigger Provider 调用 `emit()`。Scheduler 事务性接受事件、处理业务 ID 去重并创建 **Run**。
4. 接受时冻结并发策略和分组键。Run 经过准入后，执行编译出的 **Core IR**。
5. 节点通过 Capability Provider 执行；ConnectionService 将已就绪的运行时对象注入连接槽位。
6. Run、Execution、Attempt 与输出被持久化，Workbench 展示状态、时间线及受分类约束的执行数据。

恢复时复用已经成功保存的输出；中断的外部副作用是否能重试取决于 Capability 的语义。持久化不意味着外部操作恰好一次。

## 当前模块

| 模块 | 已实现职责 | 源码 |
| --- | --- | --- |
| Host / Config / CLI | 配置加载、内建别名与外部包、生命周期、校验和 safe mode | [runtime](https://github.com/Mahoo12138/numen/tree/main/packages/runtime)、[config](https://github.com/Mahoo12138/numen/tree/main/packages/config)、[cli](https://github.com/Mahoo12138/numen/tree/main/packages/cli) |
| Core / Automation | 版本化 Contract、表达式、结构化控制流、图式 Source、编译与不可变 Revision | [core](https://github.com/Mahoo12138/numen/tree/main/packages/core)、[automation](https://github.com/Mahoo12138/numen/tree/main/packages/automation) |
| Database / Scheduler | SQLite 迁移、Run 日志、并发准入、重试、超时、取消和恢复 | [database](https://github.com/Mahoo12138/numen/tree/main/packages/database)、[scheduler](https://github.com/Mahoo12138/numen/tree/main/packages/scheduler) |
| Triggers | 当前有效版本订阅、健康状态与旧订阅隔离 | [triggers](https://github.com/Mahoo12138/numen/tree/main/packages/triggers) |
| Credentials / Connections | 加密秘密、固定版本快照、适配器和可重建 Runtime | [credentials](https://github.com/Mahoo12138/numen/tree/main/packages/credentials)、[connections](https://github.com/Mahoo12138/numen/tree/main/packages/connections) |
| Resources | 内容寻址资源、Owner / Lease 及垃圾回收 | [resources](https://github.com/Mahoo12138/numen/tree/main/packages/resources) |
| Console / WebUI / Workbench | 鉴权调用、前端 Entry 生命周期、Schema 表单、编辑器与 Run 检查 | [console](https://github.com/Mahoo12138/numen/tree/main/packages/console)、[webui](https://github.com/Mahoo12138/numen/tree/main/packages/webui)、[workbench](https://github.com/Mahoo12138/numen/tree/main/packages/workbench) |
| HTTP / Logging / i18n | 托管 HTTP 出站与代理、关联日志和轮转、双语词条 | [http](https://github.com/Mahoo12138/numen/tree/main/packages/http)、[logging](https://github.com/Mahoo12138/numen/tree/main/packages/logging)、[i18n](https://github.com/Mahoo12138/numen/tree/main/packages/i18n) |

## 插件为什么可以独立接入

`CapabilityDefinition` 描述 ID、版本、类型、Schema、语义和连接槽位；Provider 提供实现。这些契约保留在固定版本的流程中，当前 Provider 的可用性由运行时管理。插件缺失会使依赖不可用，但不会删除用户的流程意图。

默认字段表单由 Schema 生成，插件无需为每个操作定制编辑器。前端 Page / Slot / Renderer 贡献绑定所属 Entry 生命周期；Webhook 的入口详情就是一个可选 Slot 贡献。

从 [编写第一个插件](/development/) 开始，再阅读[连接契约](/development/connections)。

## 当前边界

- **单个活跃 Scheduler。** 并发准入是同一 Runtime 内的持久调度，不是多进程 worker 竞争或分布式租约。
- **测试名额隔离。** 草稿、节点及发布版本试运行与正式运行使用独立并发名额；等待和阻塞的已准入 Run 仍占名额。
- **外部操作可能结果不确定。** 取消和进程退出无法保证撤回对方已接受的邮件、消息或 HTTP 请求。
- **已有 Run 恢复不等于漏跑补发。** Cron 离线计划和 MQTT clean session 离线消息没有通用 backfill 保证。
- **生态仍在扩展。** Marketplace / Installer、通用 OAuth 授权、可安装工作流模板、Try/Catch/Finally 与子流程契约不属于当前已完成的产品能力。

## 深入设计记录

以下链接指向源码仓库中的原始文档。阅读时结合文档状态和源码日期；历史验收数量不是本次运行结果。

| 主题 | 设计与记录 |
| --- | --- |
| Runtime 与插件生命周期 | [01 Runtime / Loader / HMR](https://github.com/Mahoo12138/numen/blob/main/docs/01-runtime-loader-hmr.md) |
| 工作流语言与执行 | [03 Automation Language](https://github.com/Mahoo12138/numen/blob/main/docs/03-automation-language.md)、[06 Run / Scheduler](https://github.com/Mahoo12138/numen/blob/main/docs/06-run-scheduler.md) |
| 凭据、连接与资源 | [04 Capability / Connection / Resource](https://github.com/Mahoo12138/numen/blob/main/docs/04-capability-connection-resource.md) |
| 发布与就绪 | [07 Revision / Publishing / Readiness](https://github.com/Mahoo12138/numen/blob/main/docs/07-revision-publishing-readiness.md) |
| 图式编辑器 | [26 Graph 工作流画布](https://github.com/Mahoo12138/numen/blob/main/docs/26-graph-workflow-canvas.md) |
| 当前并发语义 | [30 运行并发与持久准入](https://github.com/Mahoo12138/numen/blob/main/docs/30-run-admission.md) |
| 已知生态差距 | [28 官方生态对照与优先级](https://github.com/Mahoo12138/numen/blob/main/docs/28-ecosystem-comparison.md) |
| 全部设计文档 | [docs/README.md](https://github.com/Mahoo12138/numen/blob/main/docs/README.md) |
