import { expect, test, type Page } from '@playwright/test'
import { writeConfig } from '../packages/config/dist/index.js'
import { startRuntime, type NumenApplication } from '../packages/runtime/dist/index.js'
import { githubWebhookPath } from '../packages/integration-github/dist/path.js'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let application: NumenApplication, directory: string
let feishuServer: Server
const feishuRequests: Array<{ method?: string; path?: string; contentType?: string; body: Record<string, unknown> }> = []
const feishuDestinations: string[] = []
const secret = 'github-browser-secret-original'
const rotatedSecret = 'github-browser-secret-rotated'
const feishuSecret = 'feishu-browser-signing-secret'
const feishuWebhookUrl = 'https://open.feishu.cn/open-apis/bot/v2/hook/numen-private-browser-fixture'
const keyVariable = 'NUMEN_GITHUB_E2E_MASTER_KEY'
const previousKey = process.env[keyVariable]
const automationName = 'GitHub issue notifications'
const credentialName = 'GitHub webhook credential'
const connectionName = 'GitHub webhook receiver'

test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'numen-github-e2e-'))
  process.env[keyVariable] = randomBytes(32).toString('base64')
  feishuServer = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    feishuRequests.push({ method: request.method, path: request.url, contentType: request.headers['content-type'],
      body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> })
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ code: 0, msg: 'success' }))
  })
  await new Promise<void>(resolve => feishuServer.listen(0, '127.0.0.1', resolve))
  const address = feishuServer.address()
  if (!address || typeof address === 'string') throw new Error('Feishu fixture has no local port')
  const feishuOrigin = `http://127.0.0.1:${address.port}`
  const configPath = join(directory, 'numen.config.yml')
  await writeConfig(configPath, { version: 2, dataDir: 'data', logger: { console: false }, plugins: {
    database: { path: 'data/numen.db' }, capabilities: {}, controls: {}, coreControls: {},
    credentials: { masterKeyEnv: keyVariable }, resources: { path: 'data/resources' }, connections: {},
    github: {}, feishu: {}, http: {}, demo: {}, automations: {}, scheduler: {}, triggers: {}, console: {},
    server: { host: '127.0.0.1', port: 0 }, workbench: {},
  } })
  application = await startRuntime({ configPath })
  application.context.on('http/fetch', async (url, _init, _config, next) => {
    if (url.hostname === 'open.feishu.cn') {
      feishuDestinations.push(url.href)
      url.href = new URL(url.pathname, feishuOrigin).href
    }
    return next()
  })
})

test.afterAll(async () => {
  await application?.stop()
  if (feishuServer) {
    feishuServer.closeAllConnections()
    await new Promise<void>((resolve, reject) => feishuServer.close(error => error ? reject(error) : resolve()))
  }
  if (directory) await rm(directory, { recursive: true, force: true })
  if (previousKey === undefined) delete process.env[keyVariable]; else process.env[keyVariable] = previousKey
})

const saved = (page: Page) => expect(page.locator('.status-bar')).toHaveAttribute('data-save-phase', 'CLEAN')

async function fill(page: Page, label: string, value: string) {
  const input = page.getByLabel(label, { exact: true })
  await input.fill(value)
  await input.press('Tab')
}

async function add(page: Page, title: string) {
  await page.getByRole('button', { name: 'Add step', exact: true }).click()
  await page.getByText(title, { exact: true }).click()
  const node = page.locator('.automation-step[data-selected="true"]').filter({ hasText: title })
  await expect(node).toBeVisible()
  const id = await node.getAttribute('data-node-id')
  if (!id) throw new Error(`The added ${title} node has no ID`)
  return id
}

async function openEditor(page: Page, automationId: string) {
  await page.goto(new URL(`/automations?automation=${automationId}&tab=Editor`, application.serverUrl).href)
  await expect(page.getByRole('heading', { name: automationName, exact: true })).toBeVisible()
}

test('authors GitHub to Feishu notifications, rotates secrets and restores the optional endpoint UI', async ({ page, context }) => {
  test.setTimeout(150_000)
  page.setDefaultTimeout(10_000)
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.goto(application.workbenchUrl!)
  await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible()

  // All authored state goes through Workbench. Runtime reads below inspect the
  // persisted result; local HTTP deliveries stand in for GitHub itself.
  await page.goto(new URL('/connections/credentials', application.serverUrl).href)
  await page.getByRole('button', { name: 'New Credential', exact: true }).click()
  await page.getByLabel('Credential name', { exact: true }).fill(credentialName)
  await page.getByRole('button', { name: 'Credential type', exact: true }).click()
  await page.getByRole('option', { name: /^GitHub Webhook Secret/ }).click()
  await page.getByLabel('Secret', { exact: true }).fill(secret)
  await page.getByRole('button', { name: 'Create Credential', exact: true }).click()
  await expect(page.getByText(credentialName, { exact: true })).toBeVisible()
  await expect(page.locator('input[type="password"]')).toHaveCount(0)
  await page.getByRole('button', { name: 'New Credential', exact: true }).click()
  await page.getByLabel('Credential name', { exact: true }).fill('Feishu notifications credential')
  await page.getByRole('button', { name: 'Credential type', exact: true }).click()
  await page.getByRole('option', { name: /^Feishu Bot Webhook/ }).click()
  await page.getByLabel('Webhook Url', { exact: true }).fill(feishuWebhookUrl)
  await page.getByLabel('Secret', { exact: true }).fill(feishuSecret)
  await page.getByRole('button', { name: 'Create Credential', exact: true }).click()
  await expect(page.getByText('Feishu notifications credential', { exact: true })).toBeVisible()
  await expect(page.locator('input[type="password"]')).toHaveCount(0)

  await page.getByRole('button', { name: 'Automations', exact: true }).click()
  await page.getByRole('button', { name: 'Create automation', exact: true }).click()
  await page.getByLabel('Automation name', { exact: true }).fill(automationName)
  await page.locator('form.automation-create-form').getByRole('button', { name: 'Create', exact: true }).click()
  const triggerId = await add(page, 'GitHub Webhook')
  await fill(page, 'Events', '["issues"]')
  await fill(page, 'Actions', '["opened","reopened"]')
  const auth = page.locator('[data-connection-slot="auth"]')
  await auth.getByRole('button', { name: 'Create compatible Connection', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Connection configuration', exact: true })
  await dialog.getByRole('textbox', { name: /^Name/ }).fill(connectionName)
  await expect(dialog.getByRole('button', { name: 'Credential', exact: true })).toContainText(credentialName)
  await dialog.getByRole('button', { name: 'Create Connection', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(auth.getByRole('button', { name: 'auth connection', exact: true })).toContainText(connectionName)
  await saved(page)

  const ctx = application.context
  const automation = ctx.automations.list().find(item => item.name === automationName)!
  const path = githubWebhookPath(automation.id, triggerId)
  const endpoint = new URL(path, application.serverUrl)
  await expect(page.getByLabel('GitHub webhook request path', { exact: true })).toHaveValue(path)
  await page.getByRole('button', { name: 'Copy path', exact: true }).click()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(path)
  expect((await fetch(endpoint, { method: 'POST', body: '{}' })).status).toBe(404)

  const echoId = await add(page, 'Echo')
  await page.getByRole('button', { name: 'Message value mode', exact: true }).click()
  await page.getByRole('option', { name: 'Reference', exact: true }).click()
  await fill(page, 'Message', 'trigger.body.issue.title')
  await saved(page)
  const feishuId = await add(page, 'Send Feishu Text')
  await expect(page.getByLabel('Text', { exact: true })).toHaveJSProperty('tagName', 'TEXTAREA')
  await page.getByRole('button', { name: 'Text value mode', exact: true }).click()
  await page.getByRole('option', { name: 'Reference', exact: true }).click()
  await fill(page, 'Text', 'trigger.body.issue.title')
  const bot = page.locator('[data-connection-slot="bot"]')
  await bot.getByRole('button', { name: 'Create compatible Connection', exact: true }).click()
  await dialog.getByRole('textbox', { name: /^Name/ }).fill('Feishu notification bot')
  await expect(dialog.getByRole('button', { name: 'Adapter', exact: true })).toContainText('Feishu Custom Bot')
  await expect(dialog.getByRole('button', { name: 'Credential', exact: true })).toContainText('Feishu notifications credential')
  await dialog.getByRole('button', { name: 'Create Connection', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(bot.getByRole('button', { name: 'bot connection', exact: true })).toContainText('Feishu notification bot')
  await saved(page)
  const source = ctx.automations.getDraft(automation.id)!.source
  expect(source.triggers).toMatchObject([{ id: triggerId, capability: { id: 'github:webhook', version: 1 },
    config: { events: ['issues'], actions: ['opened', 'reopened'] } }])
  if (source.flow.type !== 'block') throw new Error('Expected an authored block')
  expect(source.flow.steps).toMatchObject([
    { id: echoId, capability: { id: 'demo:echo', version: 1 }, input: { message: { type: 'ref', path: 'trigger.body.issue.title' } } },
    { id: feishuId, capability: { id: 'feishu:send-text', version: 1 }, input: { text: { type: 'ref', path: 'trigger.body.issue.title' } } },
  ])
  await page.reload()
  await page.locator(`.automation-step[data-node-id="${triggerId}"]`).click()
  await expect(page.getByLabel('Events', { exact: true })).toHaveValue(JSON.stringify(['issues'], null, 2))
  await expect(page.getByLabel('Actions', { exact: true })).toHaveValue(JSON.stringify(['opened', 'reopened'], null, 2))

  await page.goto(new URL('/connections', application.serverUrl).href)
  for (const name of [connectionName, 'Feishu notification bot']) {
    await page.getByRole('switch', { name: `Enable ${name}`, exact: true }).click()
    await expect(page.getByRole('row').filter({ hasText: name }).locator('[data-connection-status="READY"]')).toBeVisible()
  }
  await openEditor(page, automation.id)
  await page.getByRole('button', { name: 'Publish', exact: true }).click()
  await expect(page.getByText('Published r1', { exact: true })).toBeVisible()
  await page.getByRole('tab', { name: 'Revisions', exact: true }).click()
  await page.getByRole('button', { name: 'Activate Revision 1', exact: true }).click()
  await page.getByRole('switch', { name: 'Enable Automation', exact: true }).click()
  await expect.poll(() => ctx.triggers.automationHealth(automation.id)?.status).toBe('READY')

  const issueTitle = 'Webhook 验收: café 🚀'
  const fixture = { action: 'opened', issue: { number: 42, title: issueTitle }, repository: { full_name: 'numen/fixture' } }
  const deliveryIds = new Map<string, string>()
  const deliveryId = (name: string) => {
    if (!deliveryIds.has(name)) deliveryIds.set(name, randomUUID())
    return deliveryIds.get(name)!
  }
  const send = (name: string, options: { event?: string; body?: object; key?: string } = {}) => {
    // Deliberate whitespace and multibyte text exercise signatures over raw bytes.
    const body = JSON.stringify(options.body ?? fixture, null, 2)
    const signature = createHmac('sha256', options.key ?? secret).update(body).digest('hex')
    return fetch(endpoint, { method: 'POST', headers: {
      'content-type': 'application/json', 'x-hub-signature-256': `sha256=${signature}`,
      'x-github-event': options.event ?? 'issues', 'x-github-delivery': deliveryId(name),
    }, body })
  }
  const runs = () => ctx.scheduler.listRuns().filter(run => run.automationId === automation.id)
  expect((await send('invalid-signature', { key: 'wrong-secret' })).status).toBe(401)
  for (const [deliveryId, options, status] of [
    ['ping-delivery', { event: 'ping', body: { zen: 'Keep it logically awesome.' } }, 'ping'],
    ['filtered-event', { event: 'pull_request' }, 'ignored'],
    ['filtered-action', { body: { ...fixture, action: 'closed' } }, 'ignored'],
    ['missing-action', { body: { issue: fixture.issue } }, 'ignored'],
  ] as const) {
    const response = await send(deliveryId, options)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status })
  }
  expect(runs()).toHaveLength(0)
  expect(feishuRequests).toHaveLength(0)

  const deliveries = await Promise.all(Array.from({ length: 4 }, () => send('concurrent-issue-delivery')))
  expect(deliveries.map(response => response.status).sort()).toEqual([200, 200, 200, 202])
  const receipts = await Promise.all(deliveries.map(response => response.json() as Promise<{ status: string; runId: string }>))
  const runId = receipts.find(receipt => receipt.status === 'accepted')!.runId
  expect(receipts.filter(receipt => receipt.status === 'duplicate')).toHaveLength(3)
  expect(new Set(receipts.map(receipt => receipt.runId))).toEqual(new Set([runId]))
  await expect.poll(() => ctx.scheduler.getRun(runId)?.status).toBe('COMPLETED')
  expect(runs()).toHaveLength(1)
  expect(ctx.scheduler.getRun(runId)?.trigger).toMatchObject({ body: fixture, event: 'issues', action: 'opened', deliveryId: deliveryId('concurrent-issue-delivery') })
  expect(ctx.scheduler.listExecutions(runId).find(item => item.instructionId === echoId)?.output).toEqual({ message: issueTitle })
  expect(ctx.scheduler.listExecutions(runId).find(item => item.instructionId === feishuId)?.output).toEqual({ accepted: true })
  expect(feishuRequests).toHaveLength(1)
  await page.getByRole('tab', { name: 'Runs', exact: true }).click()
  await expect(page.getByText('Completed', { exact: true }).first()).toBeVisible()
  await page.screenshot({ path: '/tmp/numen-github-runs.png', fullPage: true })

  // Rotation must replace the live verifier without editing or republishing the workflow.
  await page.goto(new URL('/connections/credentials', application.serverUrl).href)
  await page.getByRole('button', { name: `Manage ${credentialName}`, exact: true }).click()
  await expect(page.getByLabel('Secret', { exact: true })).toHaveValue('')
  await page.getByLabel('Secret', { exact: true }).fill(rotatedSecret)
  await page.getByRole('button', { name: 'Rotate secret', exact: true }).click()
  await expect(page.locator('input[type="password"]')).toHaveCount(0)
  await expect(page.getByRole('row').filter({ hasText: credentialName })).toContainText('v2')
  await expect.poll(() => ctx.triggers.automationHealth(automation.id)?.status).toBe('READY')
  expect((await send('old-key-after-rotation')).status).toBe(401)
  const rotated = await send('after-rotation', { key: rotatedSecret })
  expect(rotated.status).toBe(202)
  const rotatedReceipt = await rotated.json() as { runId: string }
  await expect.poll(() => ctx.scheduler.getRun(rotatedReceipt.runId)?.status).toBe('COMPLETED')
  expect(runs()).toHaveLength(2)
  expect(feishuRequests).toHaveLength(2)

  await page.getByRole('button', { name: 'Plugins', exact: true }).click()
  const plugin = page.locator('[data-entry-id="github"]')
  await plugin.getByRole('button', { name: 'Disable', exact: true }).click()
  await page.getByRole('button', { name: 'Save and apply this change', exact: true }).click()
  await expect(plugin.getByRole('button', { name: 'Enable', exact: true })).toBeVisible()
  await expect.poll(() => ctx.triggers.automationHealth(automation.id)?.status).toBe('WAITING')
  expect((await send('during-unload', { key: rotatedSecret })).status).toBe(404)
  await openEditor(page, automation.id)
  await page.locator(`.automation-step[data-node-id="${triggerId}"]`).click()
  await expect(page.getByLabel('GitHub webhook request path', { exact: true })).toHaveCount(0)

  await page.getByRole('button', { name: 'Plugins', exact: true }).click()
  await plugin.getByRole('button', { name: 'Enable', exact: true }).click()
  await page.getByRole('button', { name: 'Save and apply this change', exact: true }).click()
  await expect.poll(() => ctx.triggers.automationHealth(automation.id)?.status).toBe('READY')
  const replay = await send('concurrent-issue-delivery', { key: rotatedSecret })
  expect(replay.status).toBe(200)
  expect(await replay.json()).toEqual({ status: 'duplicate', runId })
  const restored = await send('after-reload', { key: rotatedSecret, body: { ...fixture, action: 'reopened' } })
  expect(restored.status).toBe(202)
  const restoredReceipt = await restored.json() as { runId: string }
  await expect.poll(() => ctx.scheduler.getRun(restoredReceipt.runId)?.status).toBe('COMPLETED')
  expect(runs()).toHaveLength(3)
  expect(ctx.scheduler.listExecutions(restoredReceipt.runId).find(item => item.instructionId === echoId)?.output).toEqual({ message: issueTitle })
  expect(feishuRequests).toHaveLength(3)
  expect(feishuDestinations).toEqual(Array(3).fill(feishuWebhookUrl))
  for (const request of feishuRequests) {
    expect(request).toMatchObject({ method: 'POST', path: new URL(feishuWebhookUrl).pathname,
      contentType: 'application/json; charset=utf-8', body: { msg_type: 'text', content: { text: issueTitle } } })
    expect(request.body.timestamp).toMatch(/^\d+$/)
    expect(request.body.sign).toBe(createHmac('sha256', `${request.body.timestamp}\n${feishuSecret}`).update('').digest('base64'))
  }

  const journal = JSON.stringify({ runs: runs(), executions: runs().flatMap(run => ctx.scheduler.listExecutions(run.id)), credentials: ctx.credentials.list() })
  const secrets = [secret, rotatedSecret, feishuSecret, feishuWebhookUrl, 'numen-private-browser-fixture']
  for (const value of secrets) expect(journal).not.toContain(value)
  const dataDirectory = join(directory, 'data')
  const databaseFiles = (await readdir(dataDirectory)).filter(name => name.startsWith('numen.db'))
  expect(databaseFiles).toContain('numen.db')
  for (const filename of databaseFiles) {
    const bytes = await readFile(join(dataDirectory, filename))
    for (const value of secrets) expect(bytes.includes(Buffer.from(value))).toBe(false)
  }

  await openEditor(page, automation.id)
  await page.locator(`.automation-step[data-node-id="${triggerId}"]`).click()
  await expect(page.getByLabel('GitHub webhook request path', { exact: true })).toHaveValue(path)
  await page.screenshot({ path: '/tmp/numen-github-desktop.png', fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  const openInspector = page.getByRole('button', { name: 'Open Inspector', exact: true })
  if (await openInspector.isVisible()) await openInspector.click()
  await expect(page.getByLabel('GitHub webhook request path', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: '/tmp/numen-github-mobile.png', fullPage: true })
  expect(errors).toEqual([])
})
