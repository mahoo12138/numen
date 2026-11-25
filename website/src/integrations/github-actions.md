---
description: 使用加密的 GitHub API Token 查询 Issue、创建 Issue 和添加评论。
---

# GitHub：Issue 查询与协作

GitHub 插件提供三个独立操作，可接在 RSS、Webhook 或其他步骤之后。它们使用 GitHub.com REST API；Webhook 接收端仍使用独立的 [Webhook Secret](./github)。

## 配置 Token Connection

1. 在 GitHub 为需要访问的仓库创建 Personal Access Token。Fine-grained token 查询需要 **Issues: read**，创建 Issue 和评论需要 **Issues: write**；组织策略可能还要求审批。
2. 在 Numen **Connections → Credentials** 新建 **GitHub API Token**，将 token 填入密码字段。
3. 添加下表任意操作，在 `api` 槽位创建兼容 Connection，选择这个 Credential。
4. 前往 Connections 启用连接，确认状态为 **READY**，再运行流程。

Credential / Adapter 为 `github:token@1`，Connection Type 为 `github:api@1`。凭据加密保存，不把 token 写入流程输入。默认配置包含 `github: {}` 和 `http: {}`；旧部署需要启用这两个插件。只有共享 HTTP 服务可用时，REST 操作才注册，Webhook 接收能力不受此依赖影响。

Token 权限与仓库访问由 GitHub 检查，详见 [GitHub Issue API](https://docs.github.com/en/rest/issues/issues) 和 [Issue Comment API](https://docs.github.com/en/rest/issues/comments)。

## 操作与字段

| 界面名称 | Capability | 输入 |
| --- | --- | --- |
| Get GitHub Issue | `github:issue-get@1` | `owner`、`repo`、`issueNumber` |
| Create GitHub Issue | `github:issue-create@1` | `owner`、`repo`、`title`，可选 `body` |
| Comment on GitHub Issue | `github:issue-comment@1` | `owner`、`repo`、`issueNumber`、`body` |

`owner` 为用户或组织名称，`repo` 为仓库名称，不填写 URL。`issueNumber` 为正整数。`body` 为 Markdown 文本；创建时可以省略，评论不能为空。

查询与创建直接返回 `{ id, number, title, body, state, url }`；评论返回 `{ id, body, url }`。无正文时 `body` 为 `""`。未返回的 GitHub 字段不会透传到下一步。GitHub 的 Issue API 也支持 Pull Request 编号，但这些操作不创建 Pull Request。

例如先添加创建操作，再添加评论操作，把评论的 **Issue Number** 切换成 **Reference**，填写 `steps.<创建步骤ID>.number`。评论内容也可以引用前面步骤的字段。

## 请求失败与重复写入

查询声明为可安全重试；是否重试仍由流程策略决定。创建和评论有副作用，**不自动重试**。如果服务器已接收写入，但响应丢失或客户端超时，结果可能不确定；先在 GitHub 检查，再决定是否手动重跑。手动重跑整个流程可能创建第二个 Issue 或重复评论。

限流错误保留状态码和经过验证的数字信息，例如 `retryAfterSeconds`、`rateLimitRemaining`、`rateLimitReset`。不会把远端错误正文或底层网络错误直接写入运行错误，避免其中回显凭据。

目标固定为 `https://api.github.com`，请求不自动跟随重定向；仓库迁移后请更新 `owner` / `repo`。每次调用有完整请求与响应读取超时，取消、凭据轮换、连接停用或插件卸载会终止在途请求。

当前不支持 Enterprise 自定义域名、OAuth、GitHub App 安装、批量列表、附件或 Webhook 自动创建。具体大小上限和固定 API 版本见[插件契约](https://github.com/Mahoo12138/numen/tree/main/packages/integration-github)。

[组合 RSS → ForEach → GitHub Issue →](./rss)
