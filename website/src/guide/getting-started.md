---
title: 快速开始
description: 从源码启动 Numen，用无需外部账号的 Cron → Echo 流程完成第一次运行。
---

# 快速开始

先在本地运行一个 **Cron → Echo** 流程。安装依赖需要网络；流程本身不需要外部服务、账号或 Connection。

## 1. 安装并构建

准备 Node.js 22 或更高版本，以及 pnpm 10。仓库的 `packageManager` 当前固定为 `pnpm@10.6.3`。

```sh
git clone https://github.com/Mahoo12138/numen.git
cd numen
pnpm install
pnpm build
pnpm numen config validate
```

已经在 Numen 工作区时，直接从 `pnpm install` 开始。本站描述当前工作区实现，不使用“安装已发布 npm 包”的方式启动。

构建会生成运行时所需的包与 Workbench 前端资源。开发启动也需要这些资源，首次运行请先完成 `pnpm build`。

## 2. 打开 Workbench

```sh
pnpm dev --print-launch-url
```

这会通过 CLI 启动运行时，并在终端输出 **Workbench launch URL (keep private)**。打开这条完整链接进入工作台。它包含本次运行的私有 bootstrap 信息，请勿把完整链接提交到仓库、聊天记录或截图中。

默认服务地址是 `http://127.0.0.1:5140`。裸地址本身不包含首次登录所需的信息；需要时可以使用等价的显式命令：

```sh
pnpm numen start --print-launch-url
```

默认配置文件为仓库根目录的 `numen.config.yml`，数据库及本地资源保存在 `.numen/`。使用 `Ctrl+C` 停止进程；再次启动会读取原来的数据。

::: tip 无需先创建凭据
Cron 和 Echo 都不需要连接。以后使用令牌或密码集成时，再配置运行时的 `NUMEN_MASTER_KEY` 并创建 Credential。主密钥用于解密持久化凭据，需要安全保存并在重启时保持一致。
:::

## 3. 创建一个每分钟执行的流程

在 Workbench 中选择“自动化 → 创建自动化”，命名为“我的第一个流程”。英文界面可通过顶栏语言选择器切换为简体中文。

1. 点击“添加步骤”，选择 **Cron 定时 / Cron Schedule**。
2. 将 Cron 表达式设置为 `* * * * *`，时区设置为 `Asia/Shanghai`。这是五段式表达式，每分钟触发一次。
3. 再次添加步骤，选择 **回显 / Echo**。
4. 将“消息 / Message”设为 `Hello, Numen!`，保持固定值模式。
5. 等待草稿显示“已保存”，处理编辑器中的校验问题。

| 节点 | Capability | 本例参数 |
| --- | --- | --- |
| Cron 定时 | `schedule:cron@1` | `cron = * * * * *`，`timezone = Asia/Shanghai` |
| 回显 | `demo:echo@1` | `message = Hello, Numen!` |

## 4. 发布、激活并启用

这三个动作分别控制不同的状态：

1. 点击“发布”，生成第一个固定版本 `r1`。
2. 打开“已发布版本 / Revisions”，激活版本 1。
3. 点击“启用自动化 / Enable Automation”，开始接收定时事件。

确认 Trigger 状态可用，然后等待下一个分钟边界。Cron 不会因为刚启用就立即补发一次事件，也不承诺补发进程停止期间错过的每个时刻。

## 5. 检查第一次 Run

进入这个流程的“运行记录 / Runs”，打开新出现的运行：

- Run 最终应为 `COMPLETED`。
- Trigger 数据包含 `scheduledAt`。
- Echo 的节点输出包含下面的值。

```json
{
  "message": "Hello, Numen!"
}
```

你也可以试运行已发布版本来立即检查节点，但这是一次测试运行，不代表定时订阅已验证。完成入门后停用自动化，避免持续产生每分钟运行记录。

## 启动或触发不符合预期

| 现象 | 检查方法 |
| --- | --- |
| 页面无法加载前端 | 确认 `pnpm build` 完成，再启动运行时。 |
| 工作台要求认证 | 使用带 `--print-launch-url` 启动时输出的私有完整链接。 |
| 没有定时 Run | 检查是否已激活版本、启用自动化，Trigger 是否可用，并等待下一个分钟边界。 |
| Run 一直排队 | 检查流程[并发控制](./concurrency.md)及已有活动运行。 |
| 修改了消息但运行仍输出旧值 | 发布并激活新的 Revision；已接受 Run 会继续使用原版本。 |

CLI 还提供以下检查：

```sh
pnpm numen doctor
pnpm numen --help
```

下一步阅读[编排与运行](./workflows.md)，或者从[官方集成](/integrations/)选择 Webhook、数据处理或消息通知能力。
