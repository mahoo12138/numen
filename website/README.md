# Numen 文档站

Numen 的用户指南、官方集成说明和插件开发入口，使用 VitePress 1.6.4 与 Vue 3。首页采用浅色技术编辑风，并提供深色主题、交互流程示意和集成筛选。

这是主仓库中的独立 pnpm workspace 包 `@numenjs/docs`。文档站只生成静态文件，不需要启动 Numen、连接数据库或配置外部服务。原有 `docs/` 保留架构决策与工程记录；面向使用者的当前说明维护在这里。

## 本地开发

要求 Node.js 22+、pnpm 10；从仓库根目录运行：

```sh
pnpm install
pnpm docs:dev
```

按终端给出的地址访问，默认仅监听 `127.0.0.1`。文档修改会自动更新。

```sh
pnpm docs:build
pnpm docs:preview
```

构建产物位于 `website/.vitepress/dist/`，缓存和产物不提交到 Git。应用的 `pnpm build` 与文档构建分别运行。

## 内容与主题

```text
website/
├── src/
│   ├── index.md                 # 落地页入口
│   ├── guide/                   # 入门、工作流、并发
│   ├── integrations/            # 官方能力与完整示例
│   ├── development/             # 插件、凭据与连接
│   ├── reference/               # 架构、部署边界
│   └── public/mark.svg          # 本地品牌图形
├── .vitepress/
│   ├── config.mts               # 导航、侧栏、中文本地搜索
│   └── theme/                   # 首页 Vue 组件与主题样式
├── tests/site.spec.ts           # 构建产物的浏览器验收
└── DESIGN.md                    # 视觉与交互约定
```

新增文档时，在 `src/` 内添加 Markdown，并更新 `config.mts` 的导航或侧栏。页面可以使用 frontmatter 设置 `title`、`description`。保留有意义的标题层级和稳定锚点；VitePress 构建会检查 Markdown 死链。

Markdown 链接使用站内路径，例如 `/guide/getting-started`。Vue 组件中的站内地址通过 `withBase()` 生成，不能写死部署前缀。首页示例是交互说明，不会执行真实流程；修改示例时同步相应指南，使用对象生成 JSON，避免手写转义。

内容以当前源码、Schema、CLI 与可验证行为为准。架构草案中的未来能力需要明确标注；不要把插件 Connection READY、事件已接受和远端操作成功混为一谈。

## 浏览器验收

首次使用 Playwright 时安装 Chromium：

```sh
pnpm exec playwright install chromium
pnpm docs:test
DOCS_BASE=/numen/ pnpm docs:test
```

测试自动构建静态站并启动独立预览进程，使用端口 `4178`。测试覆盖首页键盘操作、真实剪贴板、中文搜索、主题持久化、375px 导航、横屏、减少动态效果、200% 文字放大，以及所有已构建页面的站内链接和锚点。截图与失败 trace 位于根目录 `test-results/docs/`。

两个部署路径的测试需要依次执行，因为它们共享构建目录。子路径测试后，重新执行 `pnpm docs:build`，即可恢复根路径产物。

## 静态部署

将 `website/.vitepress/dist/` 部署到静态文件服务即可。本站使用 `cleanUrls: true`，服务器需要支持把无扩展名路径映射到对应 `.html` 文件，并支持目录 `index.html`；未知路径应返回 `404.html` 与 HTTP 404，不要把所有请求重写到首页。

例如发布到域名下的 `/numen/`，构建和本地预览必须使用相同前缀：

```sh
DOCS_BASE=/numen/ pnpm docs:build
DOCS_BASE=/numen/ pnpm docs:preview
```

`DOCS_BASE` 必须以 `/` 开头和结尾。构建产物需要放在该前缀对应的目录；修改前缀后必须重新构建。没有配置线上域名、第三方搜索、分析服务或自动发布流程。

VitePress 参考：[主题扩展](https://vitepress.dev/guide/extending-default-theme) · [本地搜索](https://vitepress.dev/reference/default-theme-search) · [部署](https://vitepress.dev/guide/deploy)。
