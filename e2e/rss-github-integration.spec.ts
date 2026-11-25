import { expect, test, type Locator, type Page } from '@playwright/test'
import type { ControlSource } from '../packages/core/dist/index.js'
import { writeConfig } from '../packages/config/dist/index.js'
import { startRuntime, type NumenApplication } from '../packages/runtime/dist/index.js'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let application: NumenApplication, directory: string, fixtureServer: Server, fixtureOrigin: string
let feedRequests = 0, rejectComments = false
const keyVariable = 'NUMEN_RSS_GITHUB_E2E_KEY'
const previousKey = process.env[keyVariable]
const token = 'github_pat_numen_browser_fixture_secret'
const automationName = 'RSS snapshots to GitHub issues'
const credentialName = 'Feed issue token'
const connectionName = 'Feed issue API'
const titles = ['安全公告 café 🚀', '重复项仍然保留', '重复项仍然保留']
const requests: Array<{ method: string; path: string; authorization?: string; version?: string; body?: Record<string, unknown> }> = []
const destinations: string[] = []
const issues = new Map<number, Record<string, unknown>>()
const feed = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel>
  <title>Numen 本地测试</title><link>https://example.test/</link><description>完整快照</description>
  ${titles.map((title, index) => `<item><title>${title}</title><guid>${index === 0 ? 'announcement' : 'duplicate'}</guid><description>第 ${index + 1} 条内容</description><link>https://example.test/${index}</link></item>`).join('')}
</channel></rss>`

test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'numen-rss-github-e2e-'))
  process.env[keyVariable] = randomBytes(32).toString('base64')
  fixtureServer = createServer(async (request, response) => {
    if (request.url === '/feed.xml') {
      feedRequests += 1
      response.writeHead(200, { 'content-type': 'application/rss+xml; charset=utf-8', 'cache-control': 'no-store' })
      response.end(feed)
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const text = Buffer.concat(chunks).toString('utf8')
    const body = text ? JSON.parse(text) as Record<string, unknown> : undefined
    requests.push({ method: request.method!, path: request.url!, authorization: request.headers.authorization,
      version: request.headers['x-github-api-version'] as string | undefined, body })
    const json = (status: number, value: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(value))
    }
    if (request.url === '/repos/numen/fixture/issues' && request.method === 'POST') {
      const number = issues.size + 101
      const issue = { id: number + 1000, number, title: body?.title, body: body?.body ?? null,
        state: 'open', html_url: `https://github.com/numen/fixture/issues/${number}` }
      issues.set(number, issue)
      json(201, issue)
      return
    }
    const match = /^\/repos\/numen\/fixture\/issues\/(\d+)(\/comments)?$/.exec(request.url ?? '')
    if (!match || !issues.has(Number(match[1]))) { json(404, { message: 'Not found' }); return }
    if (request.method === 'GET' && !match[2]) { json(200, issues.get(Number(match[1]))); return }
    if (request.method === 'POST' && match[2]) {
      if (rejectComments) { json(503, { message: `Remote diagnostic includes ${token}` }); return }
      json(201, { id: requests.length + 5000, body: body?.body, html_url: `https://github.com/numen/fixture/issues/${match[1]}#issuecomment-${requests.length}` })
      return
    }
    json(405, { message: 'Unexpected method' })
  })
  await new Promise<void>((resolve, reject) => {
    fixtureServer.once('error', reject)
    fixtureServer.listen(0, '127.0.0.1', resolve)
  })
  const address = fixtureServer.address()
  if (!address || typeof address === 'string') throw new Error('Fixture server has no TCP port')
  fixtureOrigin = `http://127.0.0.1:${address.port}`
  const configPath = join(directory, 'numen.config.yml')
  await writeConfig(configPath, { version: 2, dataDir: 'data', logger: { console: false }, plugins: {
    database: { path: 'data/numen.db' }, capabilities: {}, controls: {}, coreControls: {},
    credentials: { masterKeyEnv: keyVariable }, resources: { path: 'data/resources' }, connections: {},
    github: {}, rss: {}, http: {}, automations: {}, scheduler: {}, triggers: {}, console: {},
    server: { host: '127.0.0.1', port: 0 }, workbench: {},
  } })
  application = await startRuntime({ configPath })
  application.context.on('http/fetch', async (url, _init, _config, next) => {
    if (url.hostname === 'api.github.com') {
      destinations.push(url.href)
      url.href = new URL(url.pathname, fixtureOrigin).href
    }
    return next()
  })
})

test.afterAll(async () => {
  await application?.stop()
  if (fixtureServer) {
    fixtureServer.closeAllConnections()
    await new Promise<void>((resolve, reject) => fixtureServer.close(error => error ? reject(error) : resolve()))
  }
  if (directory) await rm(directory, { recursive: true, force: true })
  if (previousKey === undefined) delete process.env[keyVariable]; else process.env[keyVariable] = previousKey
})

const source = (automationId: string) => application.context.automations.getDraft(automationId)!.source
function controls(root: ControlSource): ControlSource[] {
  const children = root.type === 'block' ? root.steps : root.type === 'foreach' ? [root.body]
    : root.type === 'if' ? [root.then, ...(root.else ? [root.else] : [])]
      : root.type === 'parallel' || root.type === 'race' ? root.branches : []
  return [root, ...children.flatMap(controls)]
}
const node = (page: Page, id: string) => page.locator(`[data-structure-node-id="${id}"]`).first()
const saved = (page: Page) => expect(page.locator('.status-bar')).toHaveAttribute('data-save-phase', 'CLEAN')
async function insert(page: Page, automationId: string, button: Locator, title: string) {
  const before = new Set(controls(source(automationId).flow).map(item => item.id))
  await button.click()
  const picker = page.getByRole('dialog', { name: 'Add automation step', exact: true })
  await picker.getByRole('option').filter({ has: page.getByText(title, { exact: true }) }).click()
  await expect(picker).toHaveCount(0)
  await expect.poll(() => controls(source(automationId).flow).some(item => !before.has(item.id))).toBe(true)
  await saved(page)
  const added = controls(source(automationId).flow).find(item => !before.has(item.id) && item.type !== 'block')!
  await expect(node(page, added.id)).toBeVisible()
  return added.id
}
async function fill(page: Page, label: string, value: string) {
  const field = page.getByLabel(label, { exact: true })
  await field.fill(value)
  await field.press('Tab')
  await saved(page)
}
async function expression(page: Page, label: string, mode: 'Reference' | 'Template', value: string) {
  await page.getByRole('button', { name: `${label} value mode`, exact: true }).click()
  await page.getByRole('option', { name: mode, exact: true }).click()
  await fill(page, label, value)
}
async function bindExisting(page: Page) {
  const slot = page.locator('[data-connection-slot="api"]')
  await slot.getByRole('button', { name: 'api connection', exact: true }).click()
  await page.getByRole('option').filter({ hasText: connectionName }).click()
  await expect(slot.getByRole('button', { name: 'api connection', exact: true })).toContainText(connectionName)
  await saved(page)
}
async function startRun(page: Page, automationId: string, status: 'COMPLETED' | 'FAILED') {
  const scheduler = application.context.scheduler
  const before = new Set(scheduler.listRuns().map(run => run.id))
  await page.goto(new URL(`/automations?automation=${automationId}&tab=Runs`, application.serverUrl).href)
  await page.getByText('Run a published version', { exact: true }).first().click()
  await page.getByRole('button', { name: 'Start Run', exact: true }).click()
  await expect(page.getByRole('button', { name: 'View Run', exact: true })).toBeVisible()
  await expect.poll(() => scheduler.listRuns().find(run => run.automationId === automationId && !before.has(run.id))?.status).toBe(status)
  return scheduler.listRuns().find(run => run.automationId === automationId && !before.has(run.id))!
}

// Browser plugin not available; the repository's Playwright workflow drives all
// authoring, publishing, connection enablement and Run creation through Workbench.
// Runtime reads only inspect persisted evidence. GitHub writes stay on the fixture.
test('authors RSS → ForEach → GitHub issue/get/comment and preserves snapshot and write-failure semantics', async ({ page }, testInfo) => {
  test.setTimeout(180_000)
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  await page.goto(application.workbenchUrl!)
  await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible()
  await page.goto(new URL('/connections/credentials', application.serverUrl).href)
  await page.getByRole('button', { name: 'New Credential', exact: true }).click()
  await page.getByLabel('Credential name', { exact: true }).fill(credentialName)
  await page.getByRole('button', { name: 'Credential type', exact: true }).click()
  await page.getByRole('option', { name: /^GitHub API Token/ }).click()
  await page.getByLabel('Token', { exact: true }).fill(token)
  await page.getByRole('button', { name: 'Create Credential', exact: true }).click()
  await expect(page.getByText(credentialName, { exact: true })).toBeVisible()
  await expect(page.locator('input[type="password"]')).toHaveCount(0)
  await page.getByRole('button', { name: 'Automations', exact: true }).click()
  await page.getByRole('button', { name: 'Create automation', exact: true }).click()
  await page.getByLabel('Automation name', { exact: true }).fill(automationName)
  await page.locator('form.automation-create-form').getByRole('button', { name: 'Create', exact: true }).click()
  await saved(page)
  const automationId = application.context.automations.list().find(item => item.name === automationName)!.id
  const rootAdd = () => page.getByRole('button', { name: 'Add step', exact: true })
  const rssId = await insert(page, automationId, rootAdd(), 'Read RSS Feed')
  await fill(page, 'Url', `${fixtureOrigin}/feed.xml`)
  const foreachId = await insert(page, automationId, rootAdd(), 'For each')
  await expression(page, 'Items', 'Reference', `steps.${rssId}.items`)
  const loop = controls(source(automationId).flow).find(item => item.id === foreachId)!
  if (loop.type !== 'foreach') throw new Error('Expected ForEach')
  const bodyAdd = () => page.locator(`[data-block-id="${loop.body.id}"]`).getByRole('button', { name: 'Add step to Body', exact: true })

  const createId = await insert(page, automationId, bodyAdd(), 'Create GitHub Issue')
  await fill(page, 'Owner', 'numen')
  await fill(page, 'Repo', 'fixture')
  await expression(page, 'Title', 'Reference', 'loop.item.title')
  await expression(page, 'Body', 'Reference', 'loop.item.summary')
  const api = page.locator('[data-connection-slot="api"]')
  await api.getByRole('button', { name: 'Create compatible Connection', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Connection configuration', exact: true })
  await dialog.getByRole('textbox', { name: /^Name/ }).fill(connectionName)
  await expect(dialog.getByRole('button', { name: 'Adapter', exact: true })).toContainText('GitHub API Token')
  await expect(dialog.getByRole('button', { name: 'Credential', exact: true })).toContainText(credentialName)
  await dialog.getByRole('button', { name: 'Create Connection', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await saved(page)

  const getId = await insert(page, automationId, bodyAdd(), 'Get GitHub Issue')
  await fill(page, 'Owner', 'numen')
  await fill(page, 'Repo', 'fixture')
  await expression(page, 'Issue Number', 'Reference', `steps.${createId}.number`)
  await bindExisting(page)
  const commentId = await insert(page, automationId, bodyAdd(), 'Comment on GitHub Issue')
  await fill(page, 'Owner', 'numen')
  await fill(page, 'Repo', 'fixture')
  await expression(page, 'Issue Number', 'Reference', `steps.${getId}.number`)
  await expression(page, 'Body', 'Template', `已读取：{{ steps.${getId}.title }}`)
  await bindExisting(page)
  const authored = structuredClone(source(automationId))
  expect(authored.flow).toMatchObject({ type: 'block', steps: [
    { id: rssId, capability: { id: 'rss:read', version: 1 } },
    { id: foreachId, type: 'foreach', body: { steps: [{ id: createId }, { id: getId }, { id: commentId }] } },
  ] })
  expect(JSON.stringify(authored)).not.toContain(token)
  await page.reload()
  await expect(page.getByRole('heading', { name: automationName, exact: true })).toBeVisible()
  expect(source(automationId)).toEqual(authored)

  await page.goto(new URL('/connections', application.serverUrl).href)
  await page.getByRole('switch', { name: `Enable ${connectionName}`, exact: true }).click()
  await expect(page.getByRole('row').filter({ hasText: connectionName }).locator('[data-connection-status="READY"]')).toBeVisible()
  await page.goto(new URL(`/automations?automation=${automationId}&tab=Editor`, application.serverUrl).href)
  await page.getByRole('button', { name: 'Publish', exact: true }).click()
  await expect(page.getByText('Published r1', { exact: true })).toBeVisible()
  await page.getByRole('tab', { name: 'Revisions', exact: true }).click()
  await page.getByRole('button', { name: 'Activate Revision 1', exact: true }).click()
  await expect(page.getByText('Active r1', { exact: true })).toBeVisible()

  for (let pass = 0; pass < 2; pass += 1) {
    const run = await startRun(page, automationId, 'COMPLETED')
    const executions = application.context.scheduler.listExecutions(run.id)
    const rss = executions.find(item => item.instructionId === rssId)?.output
    expect(rss).toMatchObject({ format: 'rss2', totalItems: 3, returnedItems: 3, truncated: false })
    expect((rss as { items: Array<{ title: string }> }).items.map(item => item.title)).toEqual(titles)
    expect(executions.filter(item => item.instructionId === createId).map(item => (item.output as { title: string }).title)).toEqual(titles)
    const numbers = executions.filter(item => item.instructionId === createId).map(item => (item.output as { number: number }).number)
    expect(numbers).toEqual([101, 102, 103].map(number => number + pass * 3))
    expect(executions.filter(item => item.instructionId === getId).map(item => (item.output as { number: number }).number)).toEqual(numbers)
    expect(executions.filter(item => item.instructionId === commentId).map(item => (item.output as { body: string }).body)).toEqual(titles.map(title => `已读取：${title}`))
    expect(JSON.stringify(executions)).not.toContain(token)
  }
  expect(feedRequests).toBe(2)
  expect(issues.size).toBe(6)
  expect(requests).toHaveLength(18)
  expect(requests.map(item => item.method)).toEqual(Array.from({ length: 6 }, () => ['POST', 'GET', 'POST']).flat())
  for (const request of requests) {
    expect(request.authorization).toBe(`Bearer ${token}`)
    expect(request.version).toBe('2026-03-10')
  }
  expect(destinations.every(url => url.startsWith('https://api.github.com/repos/numen/fixture/issues'))).toBe(true)

  rejectComments = true
  const failedRun = await startRun(page, automationId, 'FAILED')
  const failedExecutions = application.context.scheduler.listExecutions(failedRun.id)
  expect(feedRequests).toBe(3)
  expect(issues.size).toBe(7)
  expect(requests).toHaveLength(21)
  expect(requests.filter(item => item.path === '/repos/numen/fixture/issues/107/comments')).toHaveLength(1)
  expect(failedExecutions.filter(item => item.instructionId === commentId)).toHaveLength(1)
  expect(JSON.stringify(failedExecutions)).toContain('GITHUB_API_HTTP_ERROR')
  expect(JSON.stringify(failedExecutions)).not.toContain(token)
  expect((await readFile(join(directory, 'data/numen.db'))).includes(Buffer.from(token))).toBe(false)
  await expect(page.locator('body')).not.toContainText(token)
  await page.getByText('Run a published version', { exact: true }).first().click()
  await expect(page.getByText('Failed', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('Completed', { exact: true }).first()).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('rss-github-runs.png'), fullPage: true, animations: 'disabled' })

  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(new URL(`/automations?automation=${automationId}&tab=Editor`, application.serverUrl).href)
  await node(page, commentId).locator('.automation-step').first().click()
  await expect(page.locator('.inspector')).toBeInViewport({ ratio: 0.99 })
  await expect(page.getByLabel('Body', { exact: true })).toHaveValue(`已读取：{{ steps.${getId}.title }}`)
  await expect(page.locator('[data-connection-slot="api"]')).toContainText(connectionName)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await expect(page.locator('vite-error-overlay')).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('rss-github-mobile.png'), fullPage: true, animations: 'disabled' })
  expect(source(automationId)).toEqual(authored)
  expect(errors).toEqual([])
})
