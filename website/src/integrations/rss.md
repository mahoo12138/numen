---
description: 读取 RSS 2.0 和 Atom 1.0，用 ForEach 处理订阅条目，并与 GitHub Issue 操作组合。
---

# RSS / Atom：读取并处理订阅

`rss:read@1` 是读取订阅快照的 Query。它将 RSS 2.0 或 Atom 1.0 转换为普通对象和 `items` 数组，供后续步骤引用。默认配置包含 `rss: {}`；旧部署需要加入它，并启用共享 `http` 服务。

## 输入与返回值

| 输入 | 含义 |
| --- | --- |
| `url` | HTTP(S) 订阅地址，必填，不允许 URL 用户名或密码 |
| `maxItems` | 最多返回条目数，默认 100，范围 1–1000 |
| `timeoutMs` | 完整请求与响应读取超时，默认 30000 毫秒，范围 1–300000 |

输出包括：

| 字段 | 含义 |
| --- | --- |
| `format` | `rss2` 或 `atom` |
| `feed` | `{ title, link, description, language, updated }` |
| `items` | 每项为 `{ id, title, link, published, updated, author, summary, content }` |
| `totalItems` / `returnedItems` | 文档条目数 / 本次返回数 |
| `truncated` | 是否因 `maxItems` 截断 |

缺少的文本字段返回空字符串；日期保留订阅源原文，不隐式推断时区。条目按源文件顺序返回，重复条目也会保留。`summary` / `content` 可能包含 HTML 文本，不执行其中的脚本；在需要 HTML 展示的下游必须自行安全处理。

`maxItems` 不按日期排序，也不自动选最新条目。即使只返回第一条，仍校验整份 XML，文档后面的语法错误也会失败。

## 在编辑器中组合流程

1. 添加 **Read RSS Feed**，填写订阅地址。
2. 添加 **For each**，将 **Items** 设置为 Reference：`steps.<RSS步骤ID>.items`。
3. 在 ForEach 的 Body 中添加 **Create GitHub Issue**，绑定已启用的 [GitHub API Token Connection](./github-actions)。
4. 填写 `owner`、`repo`，将 **Title** 设置为 Reference：`loop.item.title`。将 **Body** 设置为 Template，例如 <code v-pre>来源：{{ loop.item.link }}</code>。
5. 发布 Revision 后试运行，在 Runs 检查每一项的输出。空标题的条目不能直接用作 GitHub Issue 标题，应在上游用条件节点筛选。

需要定期运行时，添加 **Cron Schedule** Trigger，再发布、激活并启用 Automation。每个条目的创建操作都独立执行；某条失败前，之前已经创建的 Issue 不会回滚。

::: warning 定时读取会重复返回旧条目
RSS Read 没有后台轮询，也没有跨次运行的已读游标。Cron 只决定何时重新读取；直接定时执行上例会重复创建 Issue。`data:array-unique` 只可去除一次运行数组中的重复项，不能解决跨次执行去重。需要只处理新条目的生产流程，应先设计持久化的业务去重机制。
:::

## 支持范围

支持 UTF-8 RSS 2.0 和 Atom 1.0，不支持 RSS 1.0/RDF 或 JSON Feed。采用严格 XML 解析器，拒绝 DTD 和外部实体；网络重定向数量有限，每一跳都检查 URL。请求和重定向共享同一超时，取消或卸载会停止在途读取。

响应和输出 JSON 各限 1 MiB，XML 深度最多 32 层、元素最多 20000 个、条目最多 10000 个。非法 UTF-8、格式不支持、XML 错误、超限及 HTTP 失败会给出明确错误。

本能力不提供账号鉴权 Connection，不接受任意认证请求头。请求经过宿主 HTTP 代理配置；不要把可长期复用的私密订阅 token 硬编码到流程中，因为 URL 输入会随流程保存。

[查看解析、网络与错误契约](https://github.com/Mahoo12138/numen/tree/main/packages/integration-rss)
