import { defineConfig } from 'vitepress'

const base = process.env.DOCS_BASE ?? '/'
if (!base.startsWith('/') || !base.endsWith('/') || base.includes('//') || /[?#]/.test(base)) {
  throw new Error('DOCS_BASE must be an absolute path with a trailing slash, such as /numen/.')
}

export default defineConfig({
  title: 'Numen',
  titleTemplate: ':title · Numen',
  description: '插件优先的个人自动化 Runtime。连接事件、处理数据，让每一次运行都有迹可循。',
  lang: 'zh-CN',
  srcDir: './src',
  base,
  cleanUrls: true,
  appearance: true,
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: `${base}mark.svg` }],
    ['meta', { name: 'theme-color', content: '#3451d1' }],
    ['meta', { property: 'og:type', content: 'website' }],
  ],
  themeConfig: {
    logo: '/mark.svg',
    siteTitle: 'Numen',
    nav: [
      { text: '指南', link: '/guide/getting-started', activeMatch: '/guide/' },
      { text: '官方集成', link: '/integrations/', activeMatch: '/integrations/' },
      { text: '插件开发', link: '/development/', activeMatch: '/development/' },
      { text: '参考', link: '/reference/architecture', activeMatch: '/reference/' },
    ],
    socialLinks: [{ icon: 'github', link: 'https://github.com/Mahoo12138/numen', ariaLabel: 'Numen GitHub 源码' }],
    sidebar: [
      { text: '开始使用', items: [
        { text: '认识 Numen', link: '/guide/' },
        { text: '快速开始', link: '/guide/getting-started' },
        { text: '核心概念', link: '/guide/concepts' },
        { text: '创建与运行流程', link: '/guide/workflows' },
        { text: '并发与排队', link: '/guide/concurrency' },
      ] },
      { text: '官方集成', items: [
        { text: '集成目录', link: '/integrations/' },
        { text: 'Webhook 数据流程', link: '/integrations/webhook' },
        { text: 'GitHub 事件接入', link: '/integrations/github' },
        { text: 'GitHub Issue 操作', link: '/integrations/github-actions' },
        { text: 'RSS / Atom 订阅', link: '/integrations/rss' },
        { text: '飞书群通知', link: '/integrations/feishu' },
        { text: 'MQTT、CSV 与邮件', link: '/integrations/messaging' },
      ] },
      { text: '扩展 Numen', items: [
        { text: '编写第一个插件', link: '/development/' },
        { text: '凭据与连接', link: '/development/connections' },
      ] },
      { text: '参考', items: [
        { text: '架构与实现边界', link: '/reference/architecture' },
        { text: '部署与运行', link: '/reference/deployment' },
      ] },
    ],
    search: { provider: 'local', options: { locales: { root: { translations: {
      button: { buttonText: '搜索文档', buttonAriaLabel: '搜索文档' },
      modal: { displayDetails: '显示详细列表', resetButtonTitle: '清除搜索', backButtonTitle: '返回', noResultsText: '没有找到相关结果', footer: { selectText: '选择', navigateText: '切换', closeText: '关闭' } },
    } } } } },
    outline: { level: [2, 3], label: '本页目录' },
    docFooter: { prev: '上一页', next: '下一页' },
    returnToTopLabel: '返回顶部',
    sidebarMenuLabel: '文档目录',
    darkModeSwitchLabel: '外观',
    lightModeSwitchTitle: '切换为浅色',
    darkModeSwitchTitle: '切换为深色',
    skipToContentLabel: '跳转到内容',
    notFound: { title: '页面未找到', quote: '这条路径还没有文档。可以返回首页，或搜索你想了解的内容。', linkLabel: '返回 Numen 首页', linkText: '返回首页' },
    footer: { message: '让意图在背后自动发生。', copyright: 'Numen · 插件优先的个人自动化 Runtime' },
  },
})
