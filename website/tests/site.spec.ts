import { expect, test, type Page } from '@playwright/test'
import { readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const base = process.env.DOCS_BASE || '/'
const sitePath = (path = '') => `${base}${path}`
const errors = new WeakMap<Page, string[]>()

test.beforeEach(async ({ page }) => {
  const messages: string[] = []
  errors.set(page, messages)
  page.on('pageerror', error => messages.push(error.message))
  page.on('console', message => {
    if (message.type() === 'error') messages.push(message.text())
  })
})

test.afterEach(async ({ page }) => {
  expect(errors.get(page), 'The built documentation must not emit browser errors').toEqual([])
})

async function expectNoHorizontalOverflow(page: Page) {
  await expect.poll(() => page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth,
  ), { message: `Page must not overflow horizontally at ${page.url()}` }).toBeLessThanOrEqual(1)
}

test('landing examples work with keyboard and the main CTA opens the installation guide', async ({ page }, testInfo) => {
  await page.goto(sitePath())
  await expect(page.getByRole('heading', { level: 1 })).toContainText('把重复的事')
  await expect(page.getByRole('main')).toHaveCount(1)
  await expect(page.locator('.VPSidebar')).not.toBeVisible()
  const examples = page.getByRole('tablist', { name: '示例流程' })
  const webhook = examples.getByRole('tab', { name: 'Webhook 数据整理', exact: true })
  const mqtt = examples.getByRole('tab', { name: 'MQTT 告警通知', exact: true })
  await expect(webhook).toHaveAttribute('aria-selected', 'true')
  await webhook.focus()
  await page.keyboard.press('ArrowRight')
  await expect(mqtt).toBeFocused()
  await expect(mqtt).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('tabpanel')).toContainText('mqtt:message@1')
  await page.keyboard.press('ArrowLeft')
  await expect(webhook).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('tabpanel')).toContainText('webhook:receive@1')
  const dateNode = page.locator('[data-capability="datetime:add"]')
  await dateNode.click()
  await expect(dateNode).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('[data-capability="webhook:receive"]')).toHaveAttribute('aria-pressed', 'false')
  await expect(page.locator('#node-preview')).toContainText('日历运算')
  await expect(page.locator('#node-preview')).toContainText('"timezone": "UTC"')
  await expectNoHorizontalOverflow(page)
  await page.screenshot({ path: testInfo.outputPath('landing-desktop.png'), fullPage: true })
  await page.getByRole('link', { name: '开始使用', exact: true }).first().click()
  await expect(page).toHaveURL(new RegExp(`${base}guide/getting-started(?:\\.html)?(?:#.*)?$`))
  await expect(page.locator('.vp-doc h1')).toBeVisible()
  await expect(page.locator('.vp-doc')).toContainText('pnpm')
})

test('integration filters expose the correct guides and startup commands copy to the clipboard', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.goto(sitePath())
  const filters = page.getByRole('group', { name: '筛选官方集成' })
  await expect(page.locator('.integration-list a')).toHaveCount(12)
  const triggers = filters.getByRole('button', { name: '事件触发 4', exact: true })
  await triggers.click()
  await expect(triggers).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.integration-list a')).toHaveCount(4)
  await expect(page.locator('.integration-list')).toContainText('Webhook')
  await expect(page.locator('.integration-list')).toContainText('GitHub')
  await expect(page.locator('.integration-list')).not.toContainText('SMTP')
  await filters.getByRole('button', { name: '查询与动作 10', exact: true }).click()
  await expect(page.locator('.integration-list a')).toHaveCount(10)
  await expect(page.locator('.integration-list')).not.toContainText('Webhook')
  await expect(page.locator('.integration-list')).toContainText('GitHub')
  await expect(page.locator('.integration-list')).toContainText('RSS / Atom')
  await expect(page.locator('.integration-list')).toContainText('SMTP')
  await expect(page.locator('.integration-list')).toContainText('飞书')
  await page.getByRole('button', { name: '复制启动命令', exact: true }).click()
  await expect(page.getByRole('status')).toHaveText('已复制')
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('pnpm install\npnpm build\npnpm dev --print-launch-url')
  await page.locator('.integration-list a[href$="#mqtt"]').click()
  await expect(page).toHaveURL(/\/integrations\/#mqtt$/)
  await expect(page.locator('#mqtt')).toBeVisible()
  await page.getByRole('link', { name: '配置 GitHub Webhook、签名与去重 →', exact: true }).click()
  await expect(page).toHaveURL(/\/integrations\/github(?:\.html)?$/)
  await expect(page.locator('.vp-doc h1')).toHaveText('GitHub：接收仓库事件')
  await expect(page.locator('.vp-doc')).toContainText('github:webhook-auth@1')
  await expect(page.locator('.vp-doc')).toContainText('X-GitHub-Delivery')
  await page.getByRole('link', { name: 'Issue 查询、创建与评论', exact: true }).click()
  await expect(page.locator('.vp-doc h1')).toHaveText('GitHub：Issue 查询与协作')
  await expect(page.locator('.vp-doc')).toContainText('github:token@1')
  await page.getByRole('link', { name: '组合 RSS → ForEach → GitHub Issue →', exact: true }).click()
  await expect(page.locator('.vp-doc h1')).toHaveText('RSS / Atom：读取并处理订阅')
  await expect(page.locator('.vp-doc')).toContainText('直接定时执行上例会重复创建 Issue')
})

test('built local search finds concurrency documentation and opens the selected result', async ({ page }) => {
  await page.goto(sitePath())
  await page.locator('.DocSearch-Button').click()
  const search = page.locator('#localsearch-input')
  await expect(search).toBeFocused()
  await search.fill('并发')
  const result = page.locator('.VPLocalSearchBox a.result[href*="/guide/concurrency"]').first()
  await expect(result).toBeVisible()
  await result.click()
  await expect(page).toHaveURL(/\/guide\/concurrency(?:\.html)?(?:#.*)?$/)
  await expect(page.locator('.VPLocalSearchBox')).toHaveCount(0)
  await expect(page.locator('.vp-doc h1')).toContainText('并发')
})

test('dark appearance survives reload and applies to documentation pages', async ({ page }, testInfo) => {
  await page.goto(sitePath())
  const appearance = page.locator('.VPNavBarAppearance .VPSwitchAppearance')
  await expect(appearance).toHaveAttribute('aria-checked', 'false')
  await appearance.click()
  await expect(page.locator('html')).toHaveClass(/dark/)
  await expect(appearance).toHaveAttribute('aria-checked', 'true')
  await page.reload()
  await expect(page.locator('html')).toHaveClass(/dark/)
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('landing-dark.png'), fullPage: true })
  await page.goto(sitePath('guide/concurrency'))
  await expect(page.locator('html')).toHaveClass(/dark/)
  await expect(page.locator('.vp-doc h1')).toContainText('并发')
  await page.screenshot({ path: testInfo.outputPath('documentation-dark.png'), fullPage: true })
})

test('375px navigation reaches documentation and its sidebar opens and closes after navigation', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 375, height: 812 })
  await page.goto(sitePath())
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await expectNoHorizontalOverflow(page)
  await page.screenshot({ path: testInfo.outputPath('landing-mobile.png'), fullPage: true })
  const navigation = page.locator('.VPNavBarHamburger')
  await navigation.click()
  await expect(navigation).toHaveAttribute('aria-expanded', 'true')
  await page.locator('.VPNavScreen a[href$="/guide/getting-started"]').click()
  await expect(page.locator('.vp-doc h1')).toBeVisible()
  await expect(navigation).toHaveAttribute('aria-expanded', 'false')
  const menu = page.locator('.VPLocalNav .menu')
  await menu.click()
  await expect(menu).toHaveAttribute('aria-expanded', 'true')
  await page.locator('.VPSidebar a[href$="/guide/concurrency"]').click()
  await expect(page.locator('.vp-doc h1')).toContainText('并发')
  await expect(menu).toHaveAttribute('aria-expanded', 'false')
  await expectNoHorizontalOverflow(page)
  await page.screenshot({ path: testInfo.outputPath('documentation-mobile.png'), fullPage: true })
})

test('landscape layout and reduced motion support retain usable content', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 844, height: 390 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto(sitePath())
  await expectNoHorizontalOverflow(page)
  await page.getByRole('tab', { name: 'MQTT 告警通知', exact: true }).click()
  await expect(page.getByRole('tabpanel')).toContainText('mqtt:message@1')
  const movingElements = await page.locator('main').evaluate(element =>
    [element, ...element.querySelectorAll('*')].filter(node => {
      const style = getComputedStyle(node)
      return style.animationName !== 'none' && style.animationDuration.split(',').some(duration => parseFloat(duration) > 0.01)
    }).map(node => node.tagName),
  )
  expect(movingElements, 'Reduced motion must disable decorative animation').toEqual([])
  await page.screenshot({ path: testInfo.outputPath('landing-landscape-reduced-motion.png'), fullPage: true })
  await page.goto(sitePath('guide/getting-started'))
  await expectNoHorizontalOverflow(page)
})

test('200 percent text size preserves landing content and documentation controls', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 960 })
  await page.goto(sitePath())
  const heading = page.getByRole('heading', { level: 1 })
  const normalSize = await heading.evaluate(element => parseFloat(getComputedStyle(element).fontSize))
  const normalBodySize = await page.locator('.hero-description').evaluate(element => parseFloat(getComputedStyle(element).fontSize))
  await page.addStyleTag({ content: 'html { font-size: 200% !important; }' })
  await expect(heading).toBeVisible()
  expect(await heading.evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(normalSize * 1.99)
  expect(await page.locator('.hero-description').evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(normalBodySize * 1.99)
  const crampedLabels = await page.locator('.integration-item strong, .integration-item small').evaluateAll(elements =>
    elements.filter(element => {
      const style = getComputedStyle(element)
      return parseFloat(style.lineHeight) < parseFloat(style.fontSize)
    }).map(element => element.textContent),
  )
  expect(crampedLabels, 'Integration names and descriptions must not overlap when text is enlarged').toEqual([])
  await expectNoHorizontalOverflow(page)
  await page.getByRole('tab', { name: 'MQTT 告警通知', exact: true }).click()
  await expect(page.getByRole('tabpanel')).toContainText('mqtt:message@1')
  await page.screenshot({ path: testInfo.outputPath('landing-large-text.png'), fullPage: true })
  await page.getByRole('link', { name: '开始使用', exact: true }).first().click()
  await expect(page.locator('.vp-doc h1')).toBeVisible()
  await expectNoHorizontalOverflow(page)
})

test('every built page and rendered local link has a destination, including fragment anchors', async ({ page, request }) => {
  test.setTimeout(120_000)
  const dist = fileURLToPath(new URL('../.vitepress/dist/', import.meta.url))
  const files = await readdir(dist, { recursive: true })
  const htmlFiles = files.filter(file => file.endsWith('.html') && file !== '404.html')
  expect(htmlFiles.length, 'The build must include guides, integrations, and developer documentation').toBeGreaterThan(8)
  const links = new Set<string>()
  const anchors = new Map<string, Set<string>>()
  const canonicalPath = (path: string) => path.replace(/(?:index)?\.html$/, '').replace(/\/$/, '') || '/'
  for (const file of htmlFiles) {
    const pathname = sitePath(file.replace(/(?:index)?\.html$/, ''))
    const response = await page.goto(pathname)
    expect(response?.status(), pathname).toBe(200)
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    const documentLinks = await page.locator('a[href]').evaluateAll(elements => elements.map(element => (element as HTMLAnchorElement).href))
    documentLinks.forEach(link => links.add(link))
    anchors.set(canonicalPath(new URL(page.url()).pathname), new Set(await page.locator('[id]').evaluateAll(elements => elements.map(element => element.id))))
  }
  const origin = new URL(page.url()).origin
  const checked = new Set<string>()
  for (const link of links) {
    const url = new URL(link)
    if (url.origin !== origin) continue
    expect(url.pathname.startsWith(base), `Link must preserve the deployed base path: ${link}`).toBe(true)
    const target = `${url.origin}${url.pathname}${url.search}`
    if (!checked.has(target)) {
      const response = await request.get(target)
      expect(response.status(), `Broken local destination: ${link}`).toBe(200)
      checked.add(target)
    }
    if (url.hash && url.hash !== '#') {
      const id = decodeURIComponent(url.hash.slice(1))
      expect(anchors.get(canonicalPath(url.pathname))?.has(id), `Missing fragment destination: ${link}`).toBe(true)
    }
  }
})
