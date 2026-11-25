import { expect, test, type Page } from '@playwright/test'
import { writeConfig } from '../packages/config/dist/index.js'
import type { NumenValue, ValueExpr } from '../packages/core/dist/index.js'
import { startRuntime, type NumenApplication } from '../packages/runtime/dist/index.js'
import { webhookPath } from '../packages/integration-webhook/dist/path.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let application: NumenApplication, directory: string
const secret = 'official-integrations-e2e-webhook-token'
const keyVariable = 'NUMEN_OFFICIAL_E2E_MASTER_KEY'
const previousKey = process.env[keyVariable]
const literal = (value: NumenValue): ValueExpr => ({ type: 'literal', value })
const reference = (path: string): ValueExpr => ({ type: 'ref', path })

test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'numen-official-e2e-'))
  process.env[keyVariable] = randomBytes(32).toString('base64')
  const configPath = join(directory, 'numen.config.yml')
  await writeConfig(configPath, { version: 2, dataDir: 'data', logger: { console: false }, plugins: {
    database: { path: 'data/numen.db' }, capabilities: {}, controls: {}, coreControls: {},
    credentials: { masterKeyEnv: keyVariable }, resources: { path: 'data/resources' }, connections: {},
    data: {}, datetime: {}, webhook: {}, automations: {}, scheduler: {}, triggers: {}, console: {},
    server: { host: '127.0.0.1', port: 0 }, workbench: {},
  } })
  application = await startRuntime({ configPath })
})
test.afterAll(async () => {
  await application?.stop()
  if (directory) await rm(directory, { recursive: true, force: true })
  if (previousKey === undefined) delete process.env[keyVariable]; else process.env[keyVariable] = previousKey
})

async function openEditor(page: Page, automationId: string) {
  await page.goto(new URL(`/automations?automation=${automationId}&tab=Editor`, application.serverUrl).href)
  await expect(page.getByRole('heading', { name: 'Webhook calendar example', exact: true })).toBeVisible()
}

const saved = (page: Page) => expect(page.locator('.status-bar')).toHaveAttribute('data-save-phase', 'CLEAN')
const mode = (page: Page, label: string) => page.getByRole('button', { name: `${label} value mode`, exact: true })
const field = (page: Page, label: string) => page.locator('.schema-field').filter({ has: mode(page, label) }).last()
const collection = (page: Page, label: string) => field(page, label).locator(':scope > .schema-field-row > .schema-value-editor > .schema-value-control > .collection-expression-editor')

async function chooseMode(page: Page, label: string, value: string) {
  await mode(page, label).click()
  await page.getByRole('option', { name: value, exact: true }).click()
  await expect(mode(page, label)).toContainText(value)
}

async function fill(page: Page, label: string, value: string) {
  const input = page.getByLabel(label, { exact: true })
  await input.fill(value)
  await input.press('Tab')
}

async function addCapability(page: Page, title: string): Promise<string> {
  await page.getByRole('button', { name: 'Add step', exact: true }).click()
  await page.getByText(title, { exact: true }).click()
  const node = page.locator('.automation-step[data-selected="true"]').filter({ hasText: title })
  await expect(node).toBeVisible()
  const id = await node.getAttribute('data-node-id')
  if (!id) throw new Error(`The added ${title} node has no ID`)
  return id
}

test('authors authenticated Webhook, publishes a data/date workflow and restores its optional UI after reload', async ({ page, context }) => {
  test.setTimeout(120_000)
  page.setDefaultTimeout(10_000)
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', event => { if (event.type() === 'error') errors.push(event.text()) })
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.goto(application.workbenchUrl!)
  await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible()
  await expect(page).toHaveTitle(/Numen/)

  await page.goto(new URL('/connections/credentials', application.serverUrl).href)
  await page.getByRole('button', { name: 'New Credential', exact: true }).click()
  await page.getByLabel('Credential name', { exact: true }).fill('Webhook acceptance token')
  await page.getByLabel('Token', { exact: true }).fill(secret)
  await page.getByRole('button', { name: 'Create Credential', exact: true }).click()
  await expect(page.getByText('Webhook acceptance token', { exact: true })).toBeVisible()
  await expect(page.locator('input[type="password"]')).toHaveCount(0)

  await page.getByRole('button', { name: 'Automations', exact: true }).click()
  await page.getByRole('button', { name: 'Create automation', exact: true }).click()
  await page.getByLabel('Automation name', { exact: true }).fill('Webhook calendar example')
  await page.locator('form.automation-create-form').getByRole('button', { name: 'Create', exact: true }).click()
  await page.getByRole('button', { name: 'Add step', exact: true }).click()
  await page.getByText('Webhook', { exact: true }).click()
  await expect(page.getByRole('button', { name: 'Authentication', exact: true })).toContainText('token')
  const auth = page.locator('[data-connection-slot="auth"]')
  await auth.getByRole('button', { name: 'Create compatible Connection', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Connection configuration', exact: true })
  await dialog.getByRole('textbox', { name: /^Name/ }).fill('Webhook receiver')
  await expect(dialog.getByRole('button', { name: 'Credential', exact: true })).toContainText('Webhook acceptance token')
  await dialog.getByRole('button', { name: 'Create Connection', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(auth.getByRole('button', { name: 'auth connection', exact: true })).toContainText('Webhook receiver')
  await expect(page.locator('.status-bar')).toHaveAttribute('data-save-phase', 'CLEAN')

  const ctx = application.context
  const automation = ctx.automations.list().find(item => item.name === 'Webhook calendar example')!
  const draft = ctx.automations.getDraft(automation.id)!
  const trigger = draft.source.triggers[0]!
  const path = webhookPath(automation.id, trigger.id)
  await expect(page.getByLabel('Webhook request path', { exact: true })).toHaveValue(path)
  await page.getByRole('button', { name: 'Copy path', exact: true }).click()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(path)
  expect((await fetch(new URL(path, application.serverUrl), { method: 'POST', body: '{}' })).status).toBe(404)

  // New Connections deliberately start disabled, independently of the workflow.
  await page.goto(new URL('/connections', application.serverUrl).href)
  await page.getByRole('switch', { name: 'Enable Webhook receiver', exact: true }).click()
  await expect(page.getByRole('row').filter({ hasText: 'Webhook receiver' }).locator('[data-connection-status="READY"]')).toBeVisible()

  // Author every downstream node using the same Schema and expression controls
  // as a user; backend access below only inspects the saved result.
  await openEditor(page, automation.id)
  const mergeId = await addCapability(page, 'Merge Object Fields')
  await chooseMode(page, 'Base', 'Reference')
  await fill(page, 'Base', 'trigger.body')
  await fill(page, 'Fields', JSON.stringify({ source: 'webhook' }))
  await saved(page)

  const dateId = await addCapability(page, 'Add to Date & Time')
  await chooseMode(page, 'Date', 'Reference')
  await fill(page, 'Date', `steps.${mergeId}.value.date`)
  await fill(page, 'Amount', '1')
  await page.getByRole('button', { name: 'Unit', exact: true }).click()
  await page.getByRole('option', { name: 'months', exact: true }).click()
  await fill(page, 'Timezone', 'UTC')
  await saved(page)

  const encodeId = await addCapability(page, 'Stringify JSON')
  await chooseMode(page, 'Value', 'Object')
  await collection(page, 'Value').getByRole('button', { name: 'Add field', exact: true }).click()
  await fill(page, 'Value field name 1', 'event')
  await chooseMode(page, 'event', 'Reference')
  await fill(page, 'event', `steps.${mergeId}.value`)
  await collection(page, 'Value').getByRole('button', { name: 'Add field', exact: true }).click()
  await fill(page, 'Value field name 2', 'dueAt')
  await chooseMode(page, 'dueAt', 'Reference')
  await fill(page, 'dueAt', `steps.${dateId}.iso`)
  await saved(page)
  const authoredFlow = ctx.automations.getDraft(automation.id)!.source.flow
  if (authoredFlow.type !== 'block') throw new Error('The authored workflow must be a block')
  expect(authoredFlow.steps).toMatchObject([
    { id: mergeId, capability: { id: 'data:object-merge', version: 1 }, input: { base: reference('trigger.body'), fields: literal({ source: 'webhook' }) } },
    { id: dateId, capability: { id: 'datetime:add', version: 1 }, input: { date: reference(`steps.${mergeId}.value.date`), amount: literal(1), unit: literal('months'), timezone: literal('UTC') } },
    { id: encodeId, capability: { id: 'data:json-stringify', version: 1 }, input: { value: { type: 'object', entries: { event: reference(`steps.${mergeId}.value`), dueAt: reference(`steps.${dateId}.iso`) } } } },
  ])
  await page.reload()
  await page.locator(`.automation-step[data-node-id="${encodeId}"]`).click()
  await expect(page.getByLabel('event', { exact: true })).toHaveValue(`steps.${mergeId}.value`)
  await expect(page.getByLabel('dueAt', { exact: true })).toHaveValue(`steps.${dateId}.iso`)
  await page.getByRole('button', { name: 'Publish', exact: true }).click()
  await expect(page.getByText('Published r1', { exact: true })).toBeVisible()
  await page.getByRole('tab', { name: 'Revisions', exact: true }).click()
  await page.getByRole('button', { name: 'Activate Revision 1', exact: true }).click()
  await page.getByRole('switch', { name: 'Enable Automation', exact: true }).click()
  await expect.poll(() => ctx.triggers.automationHealth(automation.id)?.status).toBe('READY')

  const endpoint = new URL(path, application.serverUrl)
  const send = () => fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}`, 'idempotency-key': 'browser-delivery-1' }, body: JSON.stringify({ date: '2024-01-31T12:00:00Z', customer: 'Alice' }) })
  const unauthorized = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  expect(unauthorized.status).toBe(401)
  const accepted = await send()
  expect(accepted.status).toBe(202)
  const receipt = await accepted.json() as { status: string; runId: string }
  const duplicate = await send()
  expect(duplicate.status).toBe(200)
  expect(await duplicate.json()).toEqual({ status: 'duplicate', runId: receipt.runId })
  await expect.poll(() => ctx.scheduler.getRun(receipt.runId)?.status).toBe('COMPLETED')
  const output = ctx.scheduler.listExecutions(receipt.runId).find(item => item.instructionId === encodeId)!.output as { text: string }
  expect(JSON.parse(output.text)).toEqual({ event: { date: '2024-01-31T12:00:00Z', customer: 'Alice', source: 'webhook' }, dueAt: '2024-02-29T12:00:00.000Z' })
  expect(JSON.stringify(ctx.scheduler.getRun(receipt.runId))).not.toContain(secret)
  await page.getByRole('tab', { name: 'Runs', exact: true }).click()
  await expect(page.getByText('Completed', { exact: true }).first()).toBeVisible()
  await page.screenshot({ path: '/tmp/numen-official-integrations-runs.png', fullPage: true })

  await page.getByRole('button', { name: 'Plugins', exact: true }).click()
  const plugin = page.locator('[data-entry-id="webhook"]')
  await plugin.getByRole('button', { name: 'Disable', exact: true }).click()
  await page.getByRole('button', { name: 'Save and apply this change', exact: true }).click()
  await expect(plugin.getByRole('button', { name: 'Enable', exact: true })).toBeVisible()
  expect((await send()).status).toBe(404)
  await openEditor(page, automation.id)
  await page.locator(`.automation-step[data-node-id="${trigger.id}"]`).click()
  await expect(page.getByLabel('Webhook request path', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Plugins', exact: true }).click()
  await plugin.getByRole('button', { name: 'Enable', exact: true }).click()
  await page.getByRole('button', { name: 'Save and apply this change', exact: true }).click()
  await expect.poll(() => ctx.triggers.automationHealth(automation.id)?.status).toBe('READY')
  expect((await send()).status).toBe(200)

  await openEditor(page, automation.id)
  await page.locator(`.automation-step[data-node-id="${trigger.id}"]`).first().click()
  await expect(page.getByLabel('Webhook request path', { exact: true })).toHaveValue(path)
  await page.screenshot({ path: '/tmp/numen-official-integrations-desktop.png', fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  const openInspector = page.getByRole('button', { name: 'Open Inspector', exact: true })
  if (await openInspector.isVisible()) await openInspector.click()
  await expect(page.getByLabel('Webhook request path', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: '/tmp/numen-official-integrations-mobile.png', fullPage: true })
  expect(errors).toEqual([])
})
