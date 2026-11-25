import { AutomationService } from '@numenjs/automation'
import { CapabilityRegistry, type NumenValue } from '@numenjs/core'
import { ConnectionService } from '@numenjs/connections'
import { CredentialService } from '@numenjs/credentials'
import { DatabaseService } from '@numenjs/database'
import { ResourceService } from '@numenjs/resources'
import { SchedulerService } from '@numenjs/scheduler'
import { Context } from 'cordis'
import { randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import smtpIntegrationPlugin, {
  smtpPasswordAdapter, smtpPasswordCredential, smtpSendCapability,
  type SmtpConnectionConfig, type SmtpIntegrationConfig, type SmtpSendInput, type SmtpTransportRuntime,
} from '../src/index.js'
import { startSmtpFixture, type SmtpFixtureOptions } from './fixture.js'

const roots: Context[] = []
const fixtures: Awaited<ReturnType<typeof startSmtpFixture>>[] = []
const directories: string[] = []
const keyEnv = 'NUMEN_SMTP_TEST_KEY'
const message: SmtpSendInput = { to: ['recipient@example.test'], subject: 'Report', text: 'Report body' }

async function fixture(options: SmtpFixtureOptions = {}) {
  const result = await startSmtpFixture(options)
  fixtures.push(result)
  return result
}

async function createRoot(config: SmtpIntegrationConfig = {}, path = ':memory:') {
  process.env[keyEnv] ??= randomBytes(32).toString('base64')
  const root = new Context()
  roots.push(root)
  await root.plugin(DatabaseService, { path })
  await root.plugin(CapabilityRegistry)
  await root.plugin(CredentialService, { masterKeyEnv: keyEnv })
  await root.plugin(ConnectionService)
  smtpIntegrationPlugin(root, { sendTimeoutMs: 2_000, ...config })
  return root
}

async function connect(root: Context, server: Awaited<ReturnType<typeof fixture>>, options: {
  config?: Partial<SmtpConnectionConfig>
  password?: string
  enabled?: boolean
} = {}) {
  const credential = root.credentials.create('SMTP test', smtpPasswordCredential, {
    ...server.credential, ...(options.password === undefined ? {} : { password: options.password }),
  })
  const connection = root.connections.create({
    name: 'SMTP test', adapter: smtpPasswordAdapter,
    config: { ...server.config, ...options.config } as unknown as Record<string, NumenValue>,
    credentialId: credential.id, enabled: options.enabled ?? true,
  })
  await root.connections.reconcile()
  const runtime = () => root.connections.resolveRuntimes({ transport: connection.id }, smtpSendCapability.connections!).transport as SmtpTransportRuntime
  return { credential, connection, runtime }
}

function send(runtime: SmtpTransportRuntime, input = message, signal = new AbortController().signal) {
  return runtime.send(input, signal)
}

function decodedSinglePartBody(raw: string): string {
  const [headers = '', ...body] = raw.split('\r\n\r\n')
  const content = body.join('\r\n\r\n').trimEnd()
  if (/Content-Transfer-Encoding: base64/i.test(headers)) return Buffer.from(content, 'base64').toString('utf8')
  if (/Content-Transfer-Encoding: quoted-printable/i.test(headers)) {
    const bytes = content.replace(/=\r\n/g, '').replace(/=([A-Fa-f0-9]{2})/g, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
    return Buffer.from(bytes, 'binary').toString('utf8')
  }
  return content
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => root.fiber.dispose()))
  await Promise.all(fixtures.splice(0).map(server => server.close()))
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
  delete process.env[keyEnv]
})

describe('SMTP integration with real TLS protocol fixtures', () => {
  it.each(['tls', 'starttls'] as const)('submits Unicode mail over verified %s and constructs READY without connecting', async tls => {
    const server = await fixture({ tls })
    const root = await createRoot()
    const { connection, runtime } = await connect(root, server)
    expect(root.connections.getRuntimeState(connection.id).status).toBe('READY')
    expect(server.authCount).toBe(0)
    const result = await send(runtime(), { ...message, subject: '每日报告 ✓', text: '你好，世界 🌍\nSecond line.' })
    expect(result).toEqual({ messageId: expect.stringMatching(/^<.+>$/), accepted: message.to, rejected: [] })
    expect(server.messages).toHaveLength(1)
    expect(server.messages[0]).toMatchObject({ from: server.config.from, to: message.to, secure: true })
    expect(server.messages[0]!.raw).toMatch(/Subject: =\?UTF-8\?/i)
    expect(decodedSinglePartBody(server.messages[0]!.raw).replaceAll('\r\n', '\n')).toBe('你好，世界 🌍\nSecond line.')
    expect(server.authCount).toBe(1)
  })

  it('returns partial recipient acceptance and never repeats the message automatically', async () => {
    const server = await fixture({ rejectRecipients: ['no@example.test'] })
    const root = await createRoot()
    const { runtime } = await connect(root, server)
    const result = await send(runtime(), { ...message, to: ['yes@example.test', 'no@example.test', 'yes@example.test'], html: '<strong>Report</strong>' })
    expect(result).toMatchObject({ accepted: ['yes@example.test'], rejected: ['no@example.test'] })
    expect(server.messages).toHaveLength(1)
    expect(server.messages[0]!.to).toEqual(['yes@example.test'])
    expect(server.messages[0]!.raw).toContain('multipart/alternative')
  })

  it('rejects all refused recipients without exposing server response details', async () => {
    const server = await fixture({ rejectRecipients: message.to })
    const root = await createRoot()
    const { runtime } = await connect(root, server)
    await expect(send(runtime())).rejects.toMatchObject({ code: 'SMTP_RECIPIENTS_REJECTED', outcome: 'not-submitted' })
    expect(server.messages).toHaveLength(0)
  })

  it('rejects authentication and does not include supplied credentials in errors', async () => {
    const server = await fixture()
    const root = await createRoot()
    const { runtime } = await connect(root, server, { password: 'super-secret-invalid-password' })
    const error = await send(runtime()).catch(error => error)
    expect(error).toMatchObject({ code: 'SMTP_AUTH_FAILED' })
    expect(String(error)).not.toContain('super-secret')
    expect(server.messages).toHaveLength(0)
  })

  it('rejects an untrusted certificate before AUTH and rejects unavailable STARTTLS', async () => {
    const tlsServer = await fixture()
    const root = await createRoot()
    const { caPem: _ca, ...withoutCa } = tlsServer.config
    const tlsConnection = await connect(root, { ...tlsServer, config: withoutCa })
    await expect(send(tlsConnection.runtime())).rejects.toMatchObject({ code: 'SMTP_TLS_FAILED' })
    expect(tlsServer.authCount).toBe(0)
    const plainServer = await fixture({ tls: 'starttls', disableStartTls: true })
    const plainConnection = await connect(root, plainServer)
    await expect(send(plainConnection.runtime())).rejects.toMatchObject({ code: 'SMTP_TLS_FAILED' })
    expect(plainServer.authCount).toBe(0)
  })

  it('survives repeated failed TLS handshakes and immediate shutdown in an independent Node process', async () => {
    const require = createRequire(import.meta.url)
    const result = await promisify(execFile)(process.execPath, [
      require.resolve('tsx/cli'), fileURLToPath(new URL('./tls-process-fixture.ts', import.meta.url)),
    ], { timeout: 15_000, maxBuffer: 64 * 1024 })
    expect(result.stdout.trim()).toBe('TLS rejection and shutdown completed: 12')
    expect(result.stderr).toBe('')
  }, 20_000)

  it.each([
    { ...message, subject: 'Allowed\r\nBcc: hidden@example.test' },
    { ...message, to: ['person@example.test\r\nBcc: hidden@example.test'] },
    { ...message, to: ['a@example.test,b@example.test'] },
    { ...message, to: ['Name <person@example.test>'] },
    { ...message, to: [] },
    { ...message, to: Array.from({ length: 51 }, (_, index) => `person${index}@example.test`) },
    { ...message, text: { path: '/etc/passwd' } },
    { ...message, html: { href: 'https://example.test/private' } },
    { ...message, headers: { Bcc: 'hidden@example.test' } },
    { ...message, attachments: [{ path: '/etc/passwd' }] },
  ])('rejects invalid input before opening SMTP: %j', async input => {
    const server = await fixture()
    const root = await createRoot()
    const { runtime } = await connect(root, server)
    await expect(send(runtime(), input as SmtpSendInput)).rejects.toMatchObject({ code: 'SMTP_INPUT_INVALID' })
    expect(server.authCount).toBe(0)
  })

  it('counts UTF-8 bytes across all input fields, supports 50 recipients and rejects excess bytes', async () => {
    const server = await fixture()
    const root = await createRoot()
    const { runtime } = await connect(root, server)
    await expect(send(runtime(), { ...message, text: '界'.repeat(350_000) })).rejects.toMatchObject({ code: 'SMTP_MESSAGE_TOO_LARGE' })
    expect(server.authCount).toBe(0)
    const recipients = Array.from({ length: 50 }, (_, index) => `person${index}@example.test`)
    const result = await send(runtime(), { ...message, to: recipients })
    expect(result.accepted).toEqual(recipients)
  })

  it('treats DATA received without the final 250 reply as an uncertain outcome', async () => {
    const server = await fixture({ finalResponse: 'disconnect' })
    const root = await createRoot()
    const { runtime } = await connect(root, server)
    await expect(send(runtime())).rejects.toMatchObject({ code: 'SMTP_SEND_FAILED', outcome: 'unknown' })
    expect(server.messages).toHaveLength(1)
    expect(smtpSendCapability.semantics).toEqual({ sideEffect: true, idempotent: false, retrySafe: false })
  })

  it('bounds a stalled DATA response and closes its socket', async () => {
    const server = await fixture({ finalResponse: 'hold' })
    const root = await createRoot({ sendTimeoutMs: 350 })
    const { runtime } = await connect(root, server)
    await expect(send(runtime())).rejects.toMatchObject({ code: 'SMTP_TIMEOUT', outcome: 'unknown' })
    expect(server.messages).toHaveLength(1)
    await expect.poll(() => server.activeConnections).toBe(0)
  })

  it('cancels one active send without interrupting another send using the same Connection', async () => {
    const server = await fixture({ finalResponse: mail => mail.raw.includes('Subject: Hold') ? 'hold' : 'accept' })
    const root = await createRoot({ maxConcurrency: 2 })
    const { runtime } = await connect(root, server)
    const signal = new AbortController()
    const cancelled = send(runtime(), { ...message, subject: 'Hold' }, signal.signal).catch(error => error)
    await expect.poll(() => server.messages.length).toBe(1)
    const completed = send(runtime(), { ...message, subject: 'Continue' })
    signal.abort(new Error('must-not-be-propagated-secret'))
    expect(await cancelled).toMatchObject({ code: 'SMTP_CANCELLED', outcome: 'unknown' })
    expect(String(await cancelled)).not.toContain('must-not-be-propagated')
    await expect(completed).resolves.toMatchObject({ accepted: message.to })
    expect(server.messages).toHaveLength(2)
  })

  it('bounds the pending queue and can cancel a queued send before SMTP submission', async () => {
    const server = await fixture({ finalResponse: 'hold' })
    const root = await createRoot({ maxConcurrency: 1, maxPending: 1 })
    const { runtime } = await connect(root, server)
    const firstSignal = new AbortController()
    const first = send(runtime(), message, firstSignal.signal).catch(error => error)
    await expect.poll(() => server.messages.length).toBe(1)
    const secondSignal = new AbortController()
    const second = send(runtime(), message, secondSignal.signal).catch(error => error)
    await expect(send(runtime())).rejects.toMatchObject({ code: 'SMTP_BUSY', outcome: 'not-submitted' })
    secondSignal.abort()
    expect(await second).toMatchObject({ code: 'SMTP_CANCELLED', outcome: 'not-submitted' })
    firstSignal.abort()
    expect(await first).toMatchObject({ code: 'SMTP_CANCELLED' })
    expect(server.messages).toHaveLength(1)
  })

  it('rejects pre-aborted sends and invalid connection configuration without contacting SMTP', async () => {
    const server = await fixture()
    const root = await createRoot()
    const { runtime } = await connect(root, server)
    await expect(send(runtime(), message, AbortSignal.abort())).rejects.toMatchObject({ code: 'SMTP_CANCELLED', outcome: 'not-submitted' })
    for (const config of [{ host: 'https://server.test' }, { host: 'server.test\r\nAUTH LOGIN' }, { caPem: 'not a certificate' }]) {
      const { connection } = await connect(root, server, { config })
      expect(root.connections.getRuntimeState(connection.id)).toMatchObject({ status: 'ERROR', error: expect.stringContaining('SMTP_CONFIG_INVALID') })
    }
    expect(server.authCount).toBe(0)
  })

  it('rotation cancels active and queued sends, fences old runtimes, and uses the new credential', async () => {
    const server = await fixture({ finalResponse: mail => mail.raw.includes('Subject: Hold') ? 'hold' : 'accept' })
    const root = await createRoot({ maxConcurrency: 1, maxPending: 1 })
    const { credential, connection, runtime } = await connect(root, server)
    const previous = runtime()
    const active = send(previous, { ...message, subject: 'Hold' }).catch(error => error)
    await expect.poll(() => server.messages.length).toBe(1)
    const queued = send(previous).catch(error => error)
    root.credentials.rotate(credential.id, 1, { ...server.credential, password: 'rotated-wrong-password' })
    await root.connections.reconcile()
    expect(await active).toMatchObject({ code: 'SMTP_UNAVAILABLE', outcome: 'unknown' })
    expect(await queued).toMatchObject({ code: 'SMTP_UNAVAILABLE', outcome: 'not-submitted' })
    await expect(send(previous)).rejects.toMatchObject({ code: 'SMTP_UNAVAILABLE' })
    expect(root.connections.getRuntimeState(connection.id).status).toBe('READY')
    await expect(send(runtime())).rejects.toMatchObject({ code: 'SMTP_AUTH_FAILED' })
    expect(server.messages).toHaveLength(1)
  })

  it('uses real Scheduler/SQLite, blocks on disabled Connection, and preserves completed output after restart', async () => {
    const server = await fixture()
    const directory = await mkdtemp(join(tmpdir(), 'numen-smtp-'))
    directories.push(directory)
    const databasePath = join(directory, 'numen.db')
    const root = await createRoot({}, databasePath)
    const { connection } = await connect(root, server, { enabled: false })
    await root.plugin(AutomationService)
    await root.plugin(ResourceService, { path: join(directory, 'resources') })
    await root.plugin(SchedulerService, { autoDispatch: false })
    const { automation } = root.automations.create({ name: 'SMTP report', source: {
      triggers: [], flow: {
        type: 'capability', id: 'send', capability: smtpSendCapability,
        connections: { transport: connection.id },
        input: { to: { type: 'literal', value: message.to }, subject: { type: 'literal', value: message.subject }, text: { type: 'literal', value: message.text } },
      },
    } })
    const revision = root.automations.publishDraft(automation.id, 1)
    root.automations.activateRevision(automation.id, revision.id)
    const run = root.scheduler.startManual(automation.id)
    await root.scheduler.dispatchUntilIdle()
    expect(root.scheduler.listExecutions(run.id)[0]).toMatchObject({ status: 'BLOCKED', blockedReason: 'CONNECTION_UNAVAILABLE' })
    expect(root.scheduler.listAttempts(run.id)).toHaveLength(0)
    expect(server.messages).toHaveLength(0)
    root.connections.setEnabled(connection.id, connection.generation, true)
    await root.connections.reconcile()
    await expect.poll(async () => {
      await root.scheduler.dispatchUntilIdle()
      return root.scheduler.getRun(run.id)?.status
    }).toBe('COMPLETED')
    const output = root.scheduler.listExecutions(run.id)[0]!.output
    expect(output).toMatchObject({ accepted: message.to, rejected: [], messageId: expect.any(String) })
    expect(server.messages).toHaveLength(1)
    expect(JSON.stringify(root.scheduler.listAttempts(run.id))).not.toContain(server.credential.password)
    await root.fiber.dispose()

    const restarted = await createRoot({}, databasePath)
    await restarted.plugin(AutomationService)
    await restarted.plugin(ResourceService, { path: join(directory, 'resources') })
    await restarted.plugin(SchedulerService, { autoDispatch: false })
    await restarted.connections.reconcile()
    await restarted.scheduler.dispatchUntilIdle()
    expect(restarted.scheduler.listExecutions(run.id)[0]!.output).toEqual(output)
    expect(server.messages).toHaveLength(1)
  })

  it.each(['disconnect', 'hold'] as const)('persists an unknown outcome after DATA %s without automatic resend across restart', async finalResponse => {
    const server = await fixture({ finalResponse })
    const directory = await mkdtemp(join(tmpdir(), 'numen-smtp-failure-'))
    directories.push(directory)
    const databasePath = join(directory, 'numen.db')
    const root = await createRoot({ sendTimeoutMs: 350 }, databasePath)
    const { connection } = await connect(root, server)
    await root.plugin(AutomationService)
    await root.plugin(ResourceService, { path: join(directory, 'resources') })
    await root.plugin(SchedulerService, { autoDispatch: false })
    const { automation } = root.automations.create({ name: 'SMTP uncertain submission', source: {
      triggers: [], flow: {
        type: 'capability', id: 'send', capability: smtpSendCapability,
        connections: { transport: connection.id },
        input: { to: { type: 'literal', value: message.to }, subject: { type: 'literal', value: message.subject }, text: { type: 'literal', value: message.text } },
      },
    } })
    const revision = root.automations.publishDraft(automation.id, 1)
    root.automations.activateRevision(automation.id, revision.id)
    const run = root.scheduler.startManual(automation.id)
    await root.scheduler.dispatchUntilIdle()
    expect(root.scheduler.getRun(run.id)?.status).toBe('RUNNING')
    expect(root.scheduler.listExecutions(run.id)[0]).toMatchObject({ status: 'BLOCKED', blockedReason: 'OUTCOME_UNKNOWN' })
    expect(server.messages).toHaveLength(1)
    const attempts = root.scheduler.listAttempts(run.id)
    expect(attempts).toHaveLength(1)
    expect(attempts[0]?.status).toBe('OUTCOME_UNKNOWN')
    expect(attempts[0]!.error).toMatchObject({ name: 'SmtpError', message: expect.stringContaining('duplicate') })
    expect(JSON.stringify(attempts)).not.toContain(server.credential.password)
    await root.fiber.dispose()
    const restarted = await createRoot({}, databasePath)
    await restarted.plugin(AutomationService)
    await restarted.plugin(ResourceService, { path: join(directory, 'resources') })
    await restarted.plugin(SchedulerService, { autoDispatch: false })
    await restarted.connections.reconcile()
    await restarted.scheduler.dispatchUntilIdle()
    expect(restarted.scheduler.getRun(run.id)?.status).toBe('RUNNING')
    expect(restarted.scheduler.listExecutions(run.id)[0]).toMatchObject({ status: 'BLOCKED', blockedReason: 'OUTCOME_UNKNOWN' })
    expect(restarted.scheduler.listAttempts(run.id)).toEqual(attempts)
    expect(server.messages).toHaveLength(1)
  })

  it('refuses publication when an SMTP action requests automatic retry', async () => {
    const server = await fixture()
    const root = await createRoot()
    const { connection } = await connect(root, server)
    await root.plugin(AutomationService)
    const { automation } = root.automations.create({ name: 'Unsafe SMTP retry', source: {
      triggers: [], flow: {
        type: 'capability', id: 'send', capability: smtpSendCapability,
        connections: { transport: connection.id }, policy: { retry: { maxAttempts: 3, backoffMs: 0 } },
        input: { to: { type: 'literal', value: message.to }, subject: { type: 'literal', value: message.subject }, text: { type: 'literal', value: message.text } },
      },
    } })
    let failure: unknown
    try { root.automations.publishDraft(automation.id, 1) } catch (error) { failure = error }
    expect(failure).toMatchObject({ diagnostics: expect.arrayContaining([
      expect.objectContaining({ code: 'RETRY_UNSAFE' }),
    ]) })
    expect(server.authCount).toBe(0)
  })
})
