import { expect, test, type Locator, type Page } from '@playwright/test'
import { writeConfig } from '../packages/config/dist/index.js'
import { startRuntime, type NumenApplication } from '../packages/runtime/dist/index.js'
import { startSmtpFixture } from '../packages/integration-smtp/tests/fixture.js'
import { startMqttFixture } from '../packages/integration-mqtt/tests/fixture.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

let application: NumenApplication, directory: string
let smtp: Awaited<ReturnType<typeof startSmtpFixture>>, mqtt: Awaited<ReturnType<typeof startMqttFixture>>
const keyVariable = 'NUMEN_MESSAGING_E2E_MASTER_KEY'
const previousKey = process.env[keyVariable]

test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'numen-messaging-e2e-'))
  process.env[keyVariable] = randomBytes(32).toString('base64')
  smtp = await startSmtpFixture({ tls: 'starttls' })
  mqtt = await startMqttFixture()
  const configPath = join(directory, 'numen.config.yml')
  await writeConfig(configPath, { version: 2, dataDir: 'data', logger: { console: false }, plugins: {
    database: { path: 'data/numen.db' }, capabilities: {}, controls: {}, coreControls: {},
    credentials: { masterKeyEnv: keyVariable }, resources: { path: 'data/resources' }, connections: {},
    data: {}, csv: {}, smtp: {},
    // Exercise the external plugin path instead of the host's mqtt alias.
    externalMqtt: { $package: fileURLToPath(new URL('../packages/integration-mqtt/dist/index.js', import.meta.url)) },
    automations: {}, scheduler: {}, triggers: {}, console: {},
    server: { host: '127.0.0.1', port: 0 }, workbench: {},
  } })
  application = await startRuntime({ configPath })
})
test.afterAll(async () => {
  await application?.stop()
  await mqtt?.close()
  await smtp?.close()
  if (directory) await rm(directory, { recursive: true, force: true })
  if (previousKey === undefined) delete process.env[keyVariable]; else process.env[keyVariable] = previousKey
})
const saved = (page: Page) => expect(page.locator('.status-bar')).toHaveAttribute('data-save-phase', 'CLEAN')
async function fill(scope: Page | Locator, label: string, value: string) {
  const input = scope.getByLabel(label, { exact: true })
  await input.fill(value)
  await input.press('Tab')
}
async function select(scope: Page | Locator, page: Page, label: string, option: string | RegExp) {
  await scope.getByRole('button', { name: label, exact: true }).click()
  await page.getByRole('option', { name: option, exact: typeof option === 'string' }).click()
}
async function reference(page: Page, label: string, path: string) {
  await select(page, page, `${label} value mode`, 'Reference')
  await fill(page, label, path)
}
async function add(page: Page, title: string) {
  await page.getByRole('button', { name: 'Add step', exact: true }).click()
  await page.getByText(title, { exact: true }).click()
  const id = await page.locator('.automation-step[data-selected="true"]').filter({ hasText: title }).getAttribute('data-node-id')
  if (!id) throw new Error('Added step has no ID')
  return id
}
async function credential(page: Page, protocol: 'MQTT' | 'SMTP', value: { username: string; password: string }) {
  await page.goto(new URL('/connections/credentials', application.serverUrl).href)
  await page.getByRole('button', { name: 'New Credential', exact: true }).click()
  await page.getByLabel('Credential name', { exact: true }).fill(`${protocol} fixture credential`)
  await select(page, page, 'Credential type', new RegExp(`^${protocol} Username and Password`))
  await page.getByLabel('Username', { exact: true }).fill(value.username)
  await page.getByLabel('Password', { exact: true }).fill(value.password)
  await page.getByRole('button', { name: 'Create Credential', exact: true }).click()
  await expect(page.getByText(`${protocol} fixture credential`, { exact: true })).toBeVisible()
  await expect(page.locator('input[type="password"]')).toHaveCount(0)
}
async function createConnection(page: Page, slot: string, name: string, adapter: string, config: Record<string, string>) {
  const binding = page.locator(`[data-connection-slot="${slot}"]`)
  await binding.getByRole('button', { name: 'Create compatible Connection', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Connection configuration', exact: true })
  await dialog.getByRole('textbox', { name: /^Name/ }).fill(name)
  await select(dialog, page, 'Adapter', adapter)
  for (const [key, value] of Object.entries(config)) {
    const input = dialog.getByRole('textbox', { name: new RegExp(`^${key}(?:\\s|$)`) })
    await input.fill(value)
    await input.press('Tab')
  }
  await dialog.getByRole('button', { name: 'Create Connection', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(binding.getByRole('button', { name: `${slot} connection`, exact: true })).toContainText(name)
}

test('loads an external MQTT package, authors a CSV email workflow and restores subscriptions after unload', async ({ page }) => {
  test.setTimeout(150_000)
  page.setDefaultTimeout(10_000)
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(application.workbenchUrl!)
  await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible()
  await credential(page, 'MQTT', mqtt.credential)
  await credential(page, 'SMTP', smtp.credential)
  await page.getByRole('button', { name: 'Automations', exact: true }).click()
  await page.getByRole('button', { name: 'Create automation', exact: true }).click()
  await page.getByLabel('Automation name', { exact: true }).fill('MQTT CSV email report')
  await page.locator('form.automation-create-form').getByRole('button', { name: 'Create', exact: true }).click()
  const triggerId = await add(page, 'MQTT Message')
  await fill(page, 'Topic Filter', 'numen/reports/+')
  await fill(page, 'Event Id Field', 'id')
  await createConnection(page, 'client', 'Report broker', 'MQTT Password Authentication', { Url: mqtt.url })
  await saved(page)
  const dedupeId = await add(page, 'Remove Duplicate Items')
  await reference(page, 'Items', 'trigger.payload.rows')
  await fill(page, 'Key', 'device')
  await saved(page)
  const csvId = await add(page, 'Stringify CSV')
  await reference(page, 'Rows', `steps.${dedupeId}.items`)
  await fill(page, 'Columns', '["device","value"]')
  // A tab enum is visible and preserves its actual character through save/reload.
  await select(page, page, 'Delimiter', '"\\t"')
  await saved(page)
  const ctx = application.context
  const automation = ctx.automations.list().find(item => item.name === 'MQTT CSV email report')!
  const flow = ctx.automations.getDraft(automation.id)!.source.flow
  if (flow.type !== 'block') throw new Error('Expected authored block')
  expect(flow.steps.find(item => item.id === csvId)).toMatchObject({ input: { delimiter: { type: 'literal', value: '\t' } } })
  await select(page, page, 'Delimiter', ',')
  await saved(page)
  const emailId = await add(page, 'Send Email')
  await fill(page, 'To', '["reports@example.test"]')
  await fill(page, 'Subject', 'Device report')
  await expect(page.getByLabel('Text', { exact: true })).toHaveJSProperty('tagName', 'TEXTAREA')
  await fill(page, 'Text', 'first line\nsecond line')
  await saved(page)
  await page.reload()
  await page.locator(`.automation-step[data-node-id="${emailId}"]`).click()
  await expect(page.getByLabel('Text', { exact: true })).toHaveValue('first line\nsecond line')
  await reference(page, 'Text', `steps.${csvId}.text`)
  await createConnection(page, 'transport', 'Report mail', 'SMTP with Password', {
    Host: smtp.config.host, Port: String(smtp.config.port), From: smtp.config.from, 'Ca Pem': smtp.config.caPem,
  })
  await saved(page)
  const mail = ctx.connections.list().find(item => item.name === 'Report mail')!
  expect(mail.config.caPem).toBe(smtp.config.caPem)

  await page.goto(new URL('/connections', application.serverUrl).href)
  for (const name of ['Report broker', 'Report mail']) {
    await page.getByRole('switch', { name: `Enable ${name}`, exact: true }).click()
    await expect(page.getByRole('row').filter({ hasText: name }).locator('[data-connection-status="READY"]')).toBeVisible()
  }
  await page.goto(new URL(`/automations?automation=${automation.id}&tab=Editor`, application.serverUrl).href)
  await page.getByRole('button', { name: 'Publish', exact: true }).click()
  await expect(page.getByText('Published r1', { exact: true })).toBeVisible()
  await page.getByRole('tab', { name: 'Revisions', exact: true }).click()
  await page.getByRole('button', { name: 'Activate Revision 1', exact: true }).click()
  await page.getByRole('switch', { name: 'Enable Automation', exact: true }).click()
  await expect.poll(() => ctx.triggers.automationHealth(automation.id)?.status).toBe('READY')

  const payload = (id: string) => JSON.stringify({ id, rows: [{ device: 'sensor-a', value: 21 }, { device: 'sensor-a', value: 21 }, { device: 'sensor-b', value: 18 }] })
  const publish = (id: string) => mqtt.publish('numen/reports/demo', payload(id), { qos: 1 })
  const runs = () => ctx.scheduler.listRuns().filter(run => run.automationId === automation.id)
  await publish('report-1')
  await expect.poll(() => runs()[0]?.status).toBe('COMPLETED')
  expect(runs()).toHaveLength(1)
  const executions = ctx.scheduler.listExecutions(runs()[0]!.id)
  expect(executions.find(item => item.instructionId === csvId)?.output).toEqual({ text: 'device,value\nsensor-a,21\nsensor-b,18\n' })
  expect(executions.find(item => item.instructionId === emailId)?.output).toMatchObject({ accepted: ['reports@example.test'], rejected: [] })
  await expect.poll(() => smtp.messages.length).toBe(1)
  expect(smtp.messages[0]!.raw).toContain('sensor-a,21')
  expect(smtp.messages[0]!.raw).toContain('sensor-b,18')
  expect(smtp.messages[0]!.raw).toContain('Subject: Device report')
  const journal = JSON.stringify({ runs: runs(), executions })
  expect(journal).not.toContain(smtp.credential.password)
  expect(journal).not.toContain(mqtt.credential.password)
  await Promise.all([publish('report-1'), publish('report-1')])
  // A later distinct event acts as a processing barrier for the prior duplicate deliveries.
  await publish('report-2')
  await expect.poll(() => runs().filter(run => run.status === 'COMPLETED').length).toBe(2)
  expect(smtp.messages).toHaveLength(2)
  await page.getByRole('tab', { name: 'Runs', exact: true }).click()
  await expect(page.getByText('Completed', { exact: true }).first()).toBeVisible()
  await page.screenshot({ path: '/tmp/numen-messaging-runs.png', fullPage: true })

  await page.getByRole('button', { name: 'Plugins', exact: true }).click()
  const plugin = page.locator('[data-entry-id="externalMqtt"]')
  await plugin.getByRole('button', { name: 'Disable', exact: true }).click()
  await page.getByRole('button', { name: 'Save and apply this change', exact: true }).click()
  await expect(plugin.getByRole('button', { name: 'Enable', exact: true })).toBeVisible()
  await expect.poll(() => ctx.triggers.automationHealth(automation.id)?.status).toBe('WAITING')
  await publish('during-unload')
  expect(runs()).toHaveLength(2)
  await plugin.getByRole('button', { name: 'Enable', exact: true }).click()
  await page.getByRole('button', { name: 'Save and apply this change', exact: true }).click()
  await expect.poll(() => ctx.triggers.automationHealth(automation.id)?.status).toBe('READY')
  await publish('report-1')
  await publish('after-restore')
  await expect.poll(() => runs().filter(run => run.status === 'COMPLETED').length).toBe(3)
  expect(smtp.messages).toHaveLength(3)
  await mqtt.stop()
  await expect.poll(() => ctx.triggers.automationHealth(automation.id)?.status).toBe('WAITING')
  await mqtt.start()
  await expect.poll(() => ctx.triggers.automationHealth(automation.id)?.status).toBe('READY')
  await publish('after-reconnect')
  await expect.poll(() => runs().filter(run => run.status === 'COMPLETED').length).toBe(4)
  expect(smtp.messages).toHaveLength(4)
  await page.goto(new URL(`/automations?automation=${automation.id}&tab=Editor`, application.serverUrl).href)
  await page.locator(`.automation-step[data-node-id="${triggerId}"]`).click()
  await expect(page.getByLabel('Topic Filter', { exact: true })).toHaveValue('numen/reports/+')
  await page.screenshot({ path: '/tmp/numen-messaging-editor.png', fullPage: true })
  expect(errors).toEqual([])
})
