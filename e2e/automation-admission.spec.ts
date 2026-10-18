import { expect, test, type Page } from '@playwright/test'
import { writeConfig } from '../packages/config/dist/index.js'
import { startRuntime, type NumenApplication } from '../packages/runtime/dist/index.js'
import { webhookPath } from '../packages/integration-webhook/dist/path.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let application: NumenApplication, directory: string
const title = 'Webhook concurrency policy'
test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'numen-admission-e2e-'))
  const configPath = join(directory, 'numen.config.yml')
  await writeConfig(configPath, { version: 2, dataDir: 'data', logger: { console: false }, plugins: {
    database: { path: 'data/numen.db' }, capabilities: {}, controls: {}, coreControls: {}, credentials: {},
    resources: { path: 'data/resources' }, connections: {}, webhook: {}, automations: {}, scheduler: {}, triggers: {}, console: {},
    server: { host: '127.0.0.1', port: 0 }, workbench: {},
  } })
  application = await startRuntime({ configPath })
})
test.afterAll(async () => {
  for (const run of application?.context.scheduler.listRuns() ?? []) {
    if (['QUEUED', 'RUNNING', 'CANCELLING'].includes(run.status)) application.context.scheduler.cancelRun(run.id)
  }
  await application?.stop()
  if (directory) await rm(directory, { recursive: true, force: true })
})

const saved = (page: Page) => expect(page.locator('.status-bar')).toHaveAttribute('data-save-phase', 'CLEAN')
const draft = (id: string) => application.context.automations.getDraft(id)!
const status = (id: string) => application.context.scheduler.getRun(id)?.status
async function fill(page: Page, label: string, value: string) {
  const input = page.getByLabel(label, { exact: true })
  await input.fill(value)
  await input.press('Tab')
}
async function discard(page: Page, accept: boolean, action: () => Promise<unknown>) {
  const dialog = page.waitForEvent('dialog')
  const clicked = action()
  await (await dialog)[accept ? 'accept' : 'dismiss']()
  await clicked
}
async function openSettings(page: Page) {
  await page.getByRole('tab', { name: 'Settings', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Concurrency', exact: true })).toBeVisible()
}
async function overflow(page: Page, label: string) {
  await page.getByRole('button', { name: 'When the limit is reached', exact: true }).click()
  await page.getByRole('option', { name: label, exact: true }).click()
  await saved(page)
}
async function publishAndActivate(page: Page, revision: number) {
  await saved(page)
  await page.getByRole('button', { name: 'Publish', exact: true }).click()
  await expect(page.getByText(`Published r${revision}`, { exact: true })).toBeVisible()
  await page.getByRole('tab', { name: 'Revisions', exact: true }).click()
  await page.getByRole('button', { name: `Activate Revision ${revision}`, exact: true }).click()
  await expect(page.getByText(`Active r${revision}`, { exact: true })).toBeVisible()
}

test('authors durable grouped policies, queues and replaces Webhook runs across revisions, and isolates published tests', async ({ page }, testInfo) => {
  test.setTimeout(120_000)
  page.setDefaultTimeout(10_000)
  const browserErrors: string[] = []
  page.on('pageerror', error => browserErrors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') browserErrors.push(message.text()) })
  const ctx = application.context
  const { automation } = ctx.automations.create({ name: title, source: {
    inputs: { note: { type: 'string', title: 'Operator note', default: 'preserved-input' } },
    triggers: [{ id: 'received', capability: { id: 'webhook:receive', version: 1 }, config: { authentication: 'none' } }],
    flow: { type: 'block', id: 'flow', steps: [{ type: 'wait', id: 'hold', durationMs: { type: 'literal', value: 86_400_000 } }] },
  } })
  const editorUrl = new URL(`/automations?automation=${automation.id}&tab=Settings`, application.serverUrl).href
  await page.goto(application.workbenchUrl!)
  await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible()
  await page.goto(editorUrl)
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible()
  await expect(page.getByText('Leave empty for no limit.', { exact: false })).toBeVisible()
  await fill(page, 'Maximum active runs', '1')
  await page.getByRole('button', { name: 'Add grouping', exact: true }).click()
  await page.getByRole('button', { name: 'Group key value mode', exact: true }).click()
  await page.getByRole('option', { name: 'Reference', exact: true }).click()
  await fill(page, 'Group key', 'trigger.body.customerId')
  await saved(page)
  expect(draft(automation.id).source.policy).toEqual({ maxActive: 1, groupBy: { type: 'ref', path: 'trigger.body.customerId' } })
  const inputs = structuredClone(draft(automation.id).source.inputs)

  // Settings changes use the document's existing undo history and never replace input declarations.
  await fill(page, 'Maximum active runs', '2')
  await saved(page)
  await page.getByRole('tab', { name: 'Editor', exact: true }).click()
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await saved(page)
  expect(draft(automation.id).source.policy?.maxActive).toBe(1)
  await page.getByRole('button', { name: 'Redo', exact: true }).click()
  await saved(page)
  expect(draft(automation.id).source.policy?.maxActive).toBe(2)
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await saved(page)
  await openSettings(page)
  await fill(page, 'Maximum active runs', '0')
  await expect(page.getByLabel('Maximum active runs', { exact: true })).toHaveAttribute('aria-invalid', 'true')
  await discard(page, false, () => page.getByRole('tab', { name: 'Editor', exact: true }).click())
  await expect(page.getByLabel('Maximum active runs', { exact: true })).toHaveValue('0')
  expect(draft(automation.id).source.policy?.maxActive).toBe(1)
  await discard(page, true, () => page.getByRole('tab', { name: 'Editor', exact: true }).click())
  await openSettings(page)
  await expect(page.getByLabel('Maximum active runs', { exact: true })).toHaveValue('1')
  await page.reload()
  await expect(page.getByLabel('Group key', { exact: true })).toHaveValue('trigger.body.customerId')
  expect(draft(automation.id).source.inputs).toEqual(inputs)
  await publishAndActivate(page, 1)
  await page.getByRole('switch', { name: 'Enable Automation', exact: true }).click()
  await expect.poll(() => ctx.triggers.automationHealth(automation.id)?.status).toBe('READY')

  const endpoint = new URL(webhookPath(automation.id, 'received'), application.serverUrl)
  let sequence = 0
  const send = async (customerId: string) => {
    const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': `admission-${++sequence}` }, body: JSON.stringify({ customerId }) })
    expect(response.status).toBe(202)
    const receipt = await response.json() as { runId: string }
    expect(ctx.scheduler.getRun(receipt.runId)?.automationId).toBe(automation.id)
    return receipt.runId
  }
  const first = await send('A')
  await expect.poll(() => status(first)).toBe('RUNNING')
  const queued = await send('A'), otherGroup = await send('B')
  await expect.poll(() => status(otherGroup)).toBe('RUNNING')
  expect(status(queued)).toBe('QUEUED')
  expect(ctx.scheduler.listExecutions(queued)).toEqual([])
  expect(ctx.scheduler.listExecutions(first)).toContainEqual(expect.objectContaining({ status: 'WAITING' }))

  await openSettings(page)
  await overflow(page, 'Replace oldest active run')
  await publishAndActivate(page, 2)
  await expect.poll(() => ctx.triggers.automationHealth(automation.id)?.status).toBe('READY')
  const replacement = await send('A')
  await expect.poll(() => status(replacement)).toBe('RUNNING')
  expect(ctx.scheduler.getRun(first)).toMatchObject({ status: 'CANCELLED', cancelReason: 'REPLACED' })
  expect(status(queued)).toBe('QUEUED')
  expect(status(otherGroup)).toBe('RUNNING')
  expect(ctx.scheduler.getRun(replacement)?.revisionId).not.toBe(ctx.scheduler.getRun(first)?.revisionId)

  // The published-revision test has the same grouping value and replace policy,
  // but must neither wait behind nor cancel a production run.
  await page.getByRole('tab', { name: 'Runs', exact: true }).click()
  await page.locator('.automation-run-launcher > summary').click()
  const testForm = page.locator('.automation-run-launcher .automation-manual-run')
  await expect(testForm.getByRole('button', { name: 'Run source', exact: true })).toContainText('Test a published Revision')
  await testForm.getByLabel('Trigger data (JSON)', { exact: true }).fill('{"body":{"customerId":"A"}}')
  const startTest = async () => {
    const before = new Set(ctx.scheduler.listRuns().map(run => run.id))
    await testForm.getByRole('button', { name: 'Start Run', exact: true }).click()
    await expect.poll(() => ctx.scheduler.listRuns().filter(run => !before.has(run.id)).length).toBe(1)
    const id = ctx.scheduler.listRuns().find(run => !before.has(run.id))!.id
    await expect.poll(() => status(id)).toBe('RUNNING')
    return id
  }
  const firstTest = await startTest(), secondTest = await startTest()
  expect(ctx.scheduler.getRun(firstTest)).toMatchObject({ status: 'CANCELLED', cancelReason: 'REPLACED' })
  expect(status(secondTest)).toBe('RUNNING')
  expect(status(replacement)).toBe('RUNNING')
  expect(status(queued)).toBe('QUEUED')
  await page.getByRole('button', { name: `Open Run ${first}`, exact: true }).click()
  await expect(page.locator('.run-cancel-reason')).toHaveText('Replaced by a newer run')

  await page.goto(editorUrl)
  await overflow(page, 'Drop new run')
  await publishAndActivate(page, 3)
  await expect.poll(() => ctx.triggers.automationHealth(automation.id)?.status).toBe('READY')
  const dropped = await send('A')
  await expect.poll(() => status(dropped)).toBe('CANCELLED')
  expect(ctx.scheduler.getRun(dropped)?.cancelReason).toBe('OVERFLOW')
  expect(ctx.scheduler.listExecutions(dropped)).toEqual([])
  expect(status(replacement)).toBe('RUNNING')
  expect(status(queued)).toBe('QUEUED')
  await page.goto(new URL(`/runs/${dropped}/flow`, application.serverUrl).href)
  await expect(page.locator('.run-cancel-reason')).toHaveText('Concurrency limit reached')
  await page.screenshot({ path: testInfo.outputPath('admission-dropped-run.png'), fullPage: true })

  await page.goto(editorUrl)
  await expect(page.getByLabel('Maximum active runs', { exact: true })).toHaveValue('1')
  await expect(page.getByRole('button', { name: 'When the limit is reached', exact: true })).toContainText('Drop new run')
  await page.screenshot({ path: testInfo.outputPath('admission-settings-desktop.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: 'Language', exact: true }).click()
  await page.getByRole('option', { name: '简体中文', exact: true }).click()
  await expect(page.getByRole('heading', { name: '并发控制', exact: true })).toBeVisible()
  await expect(page.getByLabel('最大活动运行数', { exact: true })).toHaveValue('1')
  await page.getByLabel('最大活动运行数', { exact: true }).click()
  await expect(page.getByLabel('最大活动运行数', { exact: true })).toBeFocused()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('admission-settings-mobile-zh.png'), fullPage: true })
  expect(browserErrors).toEqual([])
})
