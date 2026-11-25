# @numenjs/integration-rss

读取 HTTP(S) 上的 RSS 2.0 / Atom 1.0 快照，提供 `rss:read@1` Query（Workbench 名称：**Read RSS Feed**）。可以组合 Cron → RSS → ForEach → 通知。该插件没有自己的后台轮询，也不保存“上次已读”状态；重复条目、重复 ID 和重复读取的内容都保留。

默认导出 `rssIntegrationPlugin`，具名导出 `rssReadCapability`。依赖宿主的 `capabilities` 与 `http` 服务，无需 Connection 或 Credential。

## 输入与输出

```json
{ "url": "https://example.com/feed.xml", "maxItems": 100, "timeoutMs": 30000 }
```

`url` 必须是绝对 HTTP(S) 地址，不接受用户名/密码。`maxItems` 为 1–1000 的整数，默认 100。`timeoutMs` 为 1–300000 毫秒的整数，默认 30000，覆盖所有重定向与整个响应体读取。

```json
{
  "format": "rss2",
  "feed": {
    "title": "Updates", "link": "https://example.com/",
    "description": "Release notes", "language": "en", "updated": ""
  },
  "items": [{
    "id": "release-1", "title": "Release 1", "link": "https://example.com/releases/1",
    "published": "Sun, 18 Oct 2026 12:00:00 GMT", "updated": "", "author": "",
    "summary": "An update", "content": ""
  }],
  "totalItems": 1, "returnedItems": 1, "truncated": false
}
```

- `format` 为 `rss2` 或 `atom`。缺失字符串统一为 `""`，不生成随机 ID。
- `items` 按原文顺序返回前 `maxItems` 项，不排序、不去重。`totalItems` 是完整 Feed 中的条目数，`returnedItems` 是实际返回数，`truncated` 明确标识截断。即使只返回一项，完整 XML 仍需通过校验与资源限制。
- RSS 映射 `guid`、`title`、`link`、`pubDate`、`author`、`description`，以及 Dublin Core `date` / `creator`、Content Module `encoded`。Feed 更新时间优先 `lastBuildDate`，其次 `pubDate`。
- Atom 按命名空间 URI 识别 Feed/Entry，支持默认和前缀命名空间。映射 `id`、`title`、`published`、`updated`、`summary`、`content`；使用首个可用 `rel="alternate"` 或省略 `rel` 的链接。作者使用 Entry 的首个 `author/name`，缺失时回退 Feed 的首个作者。
- 日期保留源文本，不猜时区、不转换、不补缺失时间。相对链接依最终响应 URL 和继承的 `xml:base` 解析。RSS `language` 和 Atom `xml:lang` 输出为 Feed 语言。
- CDATA / XML 字符引用会解码为字符串；Atom XHTML 返回后代文本，HTML 类型内容仍是带标记的**不可信字符串**，不是可执行 HTML 或已经清理的 HTML。消费方必须按文本展示，或使用自己的 HTML 清理策略。
- 不抓取 enclosure、Atom `content/src`、附件或子页面。Atom 非文本内容不输出；Feed 扩展只读取上述明确支持的字段，不返回任意 XML 对象。

## 边界与资源限制

固定限制：解压后的响应体 1 MiB，序列化 JSON 输出 1 MiB，XML 元素深度 32、元素总数 20000、Feed 条目总数 10000；超过直接失败，不返回部分结果。XML 树在 1 MiB 输入限制内构建，再校验结构限制与投影；同步解析结束后也检查总超时。

最多跟随 5 次重定向；每一跳均验证协议与 URL userinfo，拒绝 HTTPS 降级到 HTTP。只发送 GET 和固定 Accept 头，不继承宿主认证、Cookie 或其他自定义请求头。请求依然经过宿主管理的 HTTP 客户端、代理和生命周期。插件卸载会中止正在进行的读取，并使旧 Provider 失效。

只接受严格 UTF-8。HTTP charset / XML encoding 显式声明其他编码时失败。允许 `application/rss+xml`、`application/atom+xml`、`application/xml`、`text/xml`，以及常见误配置的 `text/plain`、`application/octet-stream` 或缺失 Content-Type；仍必须包含有效 Feed XML。HTML、JSON、RSS 1.0 / RDF 与 RSS 0.9 不支持。

使用精确锁定的 `@rgrove/parse-xml@4.2.0` 进行 XML 1.0 良构校验。DTD 不允许，未知实体失败，不加载外部实体或外部 DTD。4.2.0 保持项目 Node.js 22.0 最低版本兼容性；5.x 的 Node.js 最低版本为 22.12。命名空间解析、投影和资源边界由本插件补充。

输入 URL 与 Feed 内容默认保持私密，不在 Run 的公开执行摘要中展示。传输日志通过宿主日志服务脱敏完整请求 URL / 查询值；错误仅包含稳定 `RSS_*` 代码，不保留源 XML、远端消息或 transport cause。URL query 中的 token 仍属于自动化输入数据，并不因此成为加密 Credential。

语义为 `sideEffect: false, idempotent: true, retrySafe: true`，表示 GET 可以安全重试；不代表不同时间的内容相同。重复 Run 可能再次触发下游通知；需要跨 Run 去重时，应另行设计持久去重状态。

## 验证

```sh
pnpm exec vitest run packages/integration-rss/tests/integration.test.ts
pnpm exec tsc -b packages/integration-rss
```

测试使用真实本地 HTTP Server，覆盖 RSS/Atom、命名空间、相对 URL、HTML/CDATA、重复条目、截断后继续校验、恶意 XML、编码/数量/大小边界、重定向、总超时、取消、卸载、宿主凭据隔离和日志脱敏。HTTPS 降级用宿主 HTTP hook 返回重定向验证，未在测试中绕过 TLS 证书校验。

参考：[n8n RSS Read](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.rssfeedread/)、[RSS 2.0 规范](https://www.rssboard.org/rss-specification)、[Atom RFC 4287](https://www.rfc-editor.org/rfc/rfc4287)、[parse-xml 源码与边界](https://github.com/rgrove/parse-xml)。
