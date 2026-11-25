# n8n 生态参考：RSS 读取与 GitHub Issue 操作

> 核对日期：2026-10-18。下列外部事实来自第一方文档、源码和协议规范；“Numen 采用范围”是本轮实现约束，验证结果另以实际测试记录为准。

## 采用范围

本轮新增 RSS 快照读取，并在现有 GitHub 插件中增加 Issue 查询、创建和评论。参考 n8n 的服务覆盖和操作粒度，继续使用 Numen 的 Query / Action / Trigger、Connection、Credential 和现有编辑器，不引入 n8n 的执行引擎、items 传播模型或 OAuth 授权系统。

| 能力 | 采用理由与边界 | 第一方依据 |
| --- | --- | --- |
| RSS Read | 不需要账号即可接入内容源；每次执行返回当前 feed 快照，可由现有 Cron 发起读取 | [n8n RSS Read](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.rssfeedread/) 将读取节点与 RSS Trigger 分开 |
| GitHub Get / Create Issue / Create Comment | 补足现有入站 Webhook 的后续查询与写回能力；使用 PAT Connection | [n8n GitHub](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.github/) 将这三项作为独立 Issue 操作 |
| Postgres，后续候选 | n8n 支持参数化查询、读写和事务批处理；引入时需另外冻结连接池、事务边界、结果大小和 SQL 参数契约 | [n8n Postgres](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.postgres/) |
| Redis，后续候选 | n8n 支持 get / set / increment / publish；Numen 需要先区分业务存储操作与平台自身状态 | [n8n Redis](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.redis/) |
| S3，后续候选 | n8n 区分 AWS S3 与 S3 兼容服务，并支持文件上传下载；Numen 应先确定 Resource 二进制流、上传大小和 endpoint 契约 | [n8n S3](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.s3/) |

后三项的适配成本是本轮工程判断，不是 n8n 对 Numen 的结论。本轮不恢复 Google Calendar 轮询，也不增加 RSS 轮询订阅或持久 cursor。

## RSS：快照语义与解析边界

RSS Read 是普通 Query。**重复读取同一 feed 会重复返回相同条目，Cron 不提供“仅新条目”语义。** 本轮不执行跨 Run 去重，也不保证某条目只通知一次。需要增量消费的流程必须另外设计持久 checkpoint 与发送成功的提交边界；不能将 `guid` 或 `id` 存在等同于已消费。

RSS 2.0 的 item 可以缺少 title，也可以缺少 description，但两者至少一个存在；`guid` 是可选项，不能要求所有合法条目都有完整的 title/link/guid/date。Atom 则有自己的 `id`、多种 link、content 与 summary 模型。适配应保留源顺序、同一快照内重复项与 Unicode，不猜造缺失业务字段。[RSS 2.0 规范](https://www.rssboard.org/rss-specification)，[Atom RFC 4287](https://www.rfc-editor.org/rfc/rfc4287)

### 解析器与 HTTP 分工

n8n 当前实现通过自己的 HTTP helper 下载 XML，然后调用 `rss-parser.parseString()`，并为 XML tag / attribute 名称配置处理器。此结构支持 Numen 继续采用共享 `ctx.http`，保持宿主代理与取消机制有效，而不是让解析器自行联网。[n8n GenericFunctions 源码](https://github.com/n8n-io/n8n/blob/master/packages/nodes-base/nodes/RssFeedRead/GenericFunctions.ts)

`rss-parser` 的第一方实现将 XML 交给 `xml2js`，识别 RSS 0.9、RSS 1、RSS 2 和 Atom。它另有 `parseURL()`，包含自己的超时、重定向及缓存状态，因此不宜直接用它绕过 Numen transport。[rss-parser 源码](https://github.com/rbren/rss-parser/blob/master/lib/parser.js)

底层 `sax` 明确不获取 DTD，也不自行展开 DTD 中定义的实体；严格模式会拒绝未知实体。这不能替代调用方的输入限制。若改用 `fast-xml-parser`，其项目说明明确支持 DOCTYPE 实体，需要重新检查选项及安全测试，不能假设默认行为相同。[sax 官方说明](https://github.com/isaacs/sax-js#regarding-doctypes-and-entitys)，[fast-xml-parser 官方说明](https://github.com/NaturalIntelligence/fast-xml-parser)

Numen 本轮实际采用 `@rgrove/parse-xml@4.2.0` 负责 XML 语法解析，自行投影限定的 RSS 2.0 / Atom 1.0 字段。该版本的第一方说明确认：只处理 UTF-8，支持保留 DOCTYPE 节点，但不加载外部 DTD、不解析 DTD 自定义实体；Numen 在节点层再拒绝 DOCTYPE。它构建内存树，因此仍需要下载字节上限以及投影阶段的深度、节点数、条目数上限；不声称无限输入可以流式处理。[所用版本 README](https://github.com/rgrove/parse-xml/blob/v4.2.0/README.md)

Numen 采用以下约束；具体数值写入插件指南，并由测试验证：

- 使用共享 HTTP 客户端并支持执行取消；超时覆盖读取响应体，不能只覆盖收到 headers。
- URL 限于 HTTP(S)，拒绝内嵌用户名/密码；重定向必须有限次，并逐跳检查协议，不允许 HTTPS 降级到 HTTP。
- 下载时累计实际字节并终止超限 body；不能只信任 `Content-Length`，也不能在读完整个超大 body 后才检查大小。
- 显式拒绝 DTD / ENTITY 声明，验证恶意实体、深层 XML、畸形 XML 和非 feed XML。
- 输出保留 feed / item 信息，HTML content 只作为数据返回；这不是已消毒、可以任意插入页面的 HTML。
- 不新增忽略 TLS 证书错误选项。URL 协议检查不等于完整 SSRF 隔离；不能对 DNS 重绑定、网络出口控制作未经验证的安全承诺。

上述限制是 Numen 的工程决策，不能宣传为 n8n 或解析器自动提供的全部保障。

## GitHub：Issue REST 契约

| Numen 操作 | HTTP 端点 | 最小输入 | 成功响应 | Fine-grained PAT 权限 |
| --- | --- | --- | --- | --- |
| Get Issue | `GET /repos/{owner}/{repo}/issues/{issue_number}` | owner、repo、正整数 issueNumber | `200`，单个 Issue | Issues read；公开资源可匿名，但本轮统一使用 Connection |
| Create Issue | `POST /repos/{owner}/{repo}/issues` | owner、repo、title；可选 body | `201`，单个新 Issue | Issues write |
| Create Comment | `POST /repos/{owner}/{repo}/issues/{issue_number}/comments` | owner、repo、issueNumber、body | `201`，单个新 Comment | Issues write 或 Pull requests write |

依据：[GitHub Issue 端点](https://docs.github.com/en/rest/issues/issues)，[GitHub Issue Comment 端点](https://docs.github.com/en/rest/issues/comments)。Issue 查询可能返回 PR 对应的 Issue；普通 Issue 评论不同于 PR diff review comment。应读取返回对象的 `number`，而不是从 `html_url` 截取编号。

本轮 PAT 与现有 Webhook Secret 是不同 Credential，不能互换。n8n 同时支持 PAT 和 OAuth，且其通用说明偏向 classic PAT；Numen 只实现本轮端点已明确支持的 PAT，指南优先建议限制仓库和权限的 fine-grained token，并说明组织策略或审批可能影响可用性，不将 n8n 的宽 `repo` scope 推荐机械照搬。[n8n GitHub credentials](https://docs.n8n.io/integrations/builtin/credentials/github/)

请求显式发送 `Authorization: Bearer …`、`Accept: application/vnd.github+json`、`User-Agent` 和 `X-GitHub-Api-Version`；token 只在 Connection runtime 内使用，不进入 Source、Run 输出或错误文本。[GitHub REST 入门](https://docs.github.com/en/rest/using-the-rest-api/getting-started-with-the-rest-api)

截至核对日，GitHub 已发布 `2026-03-10` 版本，本轮显式固定此版本。旧版 `2022-11-28` 仍受支持至 2028-03-10，但已不是最新版本。新版本变更涉及 Issue 响应中的嵌套仓库旧字段等；Numen 仅投影本轮需要的 Issue `id / number / title / body / state / html_url` 与 Comment `id / body / html_url`，不依赖被移除字段。将来切换版本仍需先审查变更并验证响应契约。[API Versions](https://docs.github.com/en/rest/about-the-rest-api/api-versions)，[Breaking changes](https://docs.github.com/en/rest/about-the-rest-api/breaking-changes)

### 错误、重定向、重试

`401` 应提示凭据，`403` 可能为权限或限流，`404` 也可能是无权访问私有仓库，`410` 可表示仓库关闭 Issues，`422` 表示参数或滥用限制。GitHub 的 labels / assignees 参数在调用者缺少 push 权限时可能被静默丢弃，本轮暂不暴露这些字段，后续加入时不能仅依据 HTTP 201 宣称它们已设置。[Issue 端点](https://docs.github.com/en/rest/issues/issues)

GitHub 要求处理重定向，并在 rate limit 时停止请求：优先等待 `retry-after`，若剩余额度为零则等待 `x-ratelimit-reset`，其他 secondary limit 至少等待一分钟。Numen 本轮不在插件内部自动重试写请求；POST 超时或断连可能发生在服务端已写入之后，再次请求会创建重复内容。错误信息应保留安全的 HTTP 状态及可用限流提示，不能吞掉失败或暴露完整请求。[GitHub 最佳实践](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api)

本轮为避免 PAT 随重定向泄漏，选择拒绝所有 3xx，并报告 HTTP 状态；因此仓库重命名等场景需要用户更新 owner / repo。这是相对 GitHub 自动跟随重定向建议的已知功能限制。后续若支持跟随，必须限定可信 API origin、路径和最大跳数。业务 Source 不允许任意改写 API base URL；本地测试通过宿主测试 transport 重定向到 fixture server。

三项操作均返回单对象，本轮无需分页。若后续增加 List Issues / List Comments，应依据 `Link` 的 `rel="next"` 逐页读取，并设总项数/页数上限；不能把默认第一页当全集，也不能未经 origin 检查就将 token 发送到分页 URL。[GitHub 分页说明](https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api)

## 验证要求与交付界限

1. RSS 覆盖 RSS 2 / Atom、空 feed、多项 Unicode、重复项、缺失可选字段、错误协议、重定向、慢响应体、取消、body 超限、DTD / ENTITY、畸形 XML 和非法输出键。
2. GitHub 覆盖三项真实 HTTP 请求形态、必填和边界输入、PAT 隐藏、签名 Secret 与 PAT 分离、权限/限流/服务端失败、慢 body、取消及 POST 失败不重试。
3. 使用本地 fixture server 验证 RSS → ForEach → Create Issue → Get Issue → Create Comment，确保每项取到自身创建的 Issue number，而非错误复用上一项输出。
4. 在真实编辑器中创建 Credential、Connection、流程和测试 Run，并检查持久化输出。插件单测通过不代表 UI 可配置或流程组合正确。
5. 本地测试不等于真实 GitHub / 企业仓库权限联调，不进行未经明确授权的外部 Issue 或评论写入；npm 发布、部署和公网 RSS 兼容范围需按实际完成情况单独说明。

本文件记录调研与采用边界，不预先声称上述测试已经通过。
