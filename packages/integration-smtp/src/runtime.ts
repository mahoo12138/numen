import SMTPConnection from 'nodemailer/lib/smtp-connection'
import MailComposer from 'nodemailer/lib/mail-composer'
import { isIP } from 'node:net'
import type { Readable } from 'node:stream'
import { createSecureContext } from 'node:tls'

export interface SmtpSendInput {
  to: string[]
  subject: string
  text: string
  html?: string
}

export interface SmtpSendOutput {
  messageId: string
  accepted: string[]
  rejected: string[]
}

export interface SmtpConnectionConfig {
  host: string
  port?: number
  tls?: 'tls' | 'starttls'
  from: string
  caPem?: string
}

export interface SmtpIntegrationConfig {
  sendTimeoutMs?: number
  maxConcurrency?: number
  maxPending?: number
}

export interface SmtpTransportRuntime {
  send(input: SmtpSendInput, signal: AbortSignal): Promise<SmtpSendOutput>
}

export type SmtpErrorCode = 'SMTP_INPUT_INVALID' | 'SMTP_MESSAGE_TOO_LARGE' | 'SMTP_CONFIG_INVALID'
  | 'SMTP_UNAVAILABLE' | 'SMTP_BUSY' | 'SMTP_CANCELLED' | 'SMTP_TIMEOUT' | 'SMTP_AUTH_FAILED'
  | 'SMTP_TLS_FAILED' | 'SMTP_RECIPIENTS_REJECTED' | 'SMTP_SEND_FAILED'

const messages: Record<SmtpErrorCode, string> = {
  SMTP_INPUT_INVALID: 'The email input is invalid.',
  SMTP_MESSAGE_TOO_LARGE: 'The email exceeds the 1 MiB input limit.',
  SMTP_CONFIG_INVALID: 'The SMTP connection configuration is invalid.',
  SMTP_UNAVAILABLE: 'The SMTP connection is no longer available.',
  SMTP_BUSY: 'The SMTP connection has reached its pending send limit.',
  SMTP_CANCELLED: 'The email operation was cancelled; an attempted submission may already have been accepted and retry may send a duplicate.',
  SMTP_TIMEOUT: 'The email operation timed out; an attempted submission may already have been accepted and retry may send a duplicate.',
  SMTP_AUTH_FAILED: 'The SMTP server rejected authentication.',
  SMTP_TLS_FAILED: 'A verified TLS connection to the SMTP server could not be established.',
  SMTP_RECIPIENTS_REJECTED: 'The SMTP server rejected all recipients.',
  SMTP_SEND_FAILED: 'The email could not be confirmed as accepted; the server may already have accepted it and retry may send a duplicate.',
}

export class SmtpError extends Error {
  override name = 'SmtpError'
  constructor(public readonly code: SmtpErrorCode, public readonly outcome: 'not-submitted' | 'unknown' = 'not-submitted') {
    super(`[${code}] ${messages[code]}`)
  }
}

export const smtpLimits = { maxRecipients: 50, maxInputBytes: 1024 * 1024 } as const

function objectWithKeys(value: unknown, keys: string[], code: SmtpErrorCode): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !keys.includes(key))) throw new SmtpError(code)
}

// V1 deliberately accepts bare ASCII addr-specs, not address lists, display names or EAI local parts.
export function isMailbox(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 254 || /[\r\n\0]/.test(value)) return false
  const parts = value.split('@')
  if (parts.length !== 2) return false
  const [local = '', domain = ''] = parts
  return local.length > 0 && local.length <= 64 && !local.startsWith('.') && !local.endsWith('.') && !local.includes('..')
    && /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local)
    && domain.length > 0 && domain.length <= 253
    && domain.split('.').every(label => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label))
}

export function validateSmtpInput(value: unknown, from: string): SmtpSendInput {
  objectWithKeys(value, ['to', 'subject', 'text', 'html'], 'SMTP_INPUT_INVALID')
  if (!Array.isArray(value.to) || value.to.length < 1 || value.to.length > smtpLimits.maxRecipients
    || !value.to.every(isMailbox) || typeof value.subject !== 'string' || /[\r\n\0]/.test(value.subject)
    || typeof value.text !== 'string' || (value.html !== undefined && typeof value.html !== 'string')) {
    throw new SmtpError('SMTP_INPUT_INVALID')
  }
  const to = [...new Set(value.to as string[])]
  const bytes = [from, ...value.to, value.subject, value.text, value.html ?? '']
    .reduce<number>((total, field) => total + Buffer.byteLength(field as string, 'utf8'), 0)
  if (bytes > smtpLimits.maxInputBytes) throw new SmtpError('SMTP_MESSAGE_TOO_LARGE')
  return { to, subject: value.subject, text: value.text, ...(value.html === undefined ? {} : { html: value.html as string }) }
}

export function validateSmtpConfig(value: unknown): Required<Pick<SmtpConnectionConfig, 'host' | 'port' | 'tls' | 'from'>> & Pick<SmtpConnectionConfig, 'caPem'> {
  objectWithKeys(value, ['host', 'port', 'tls', 'from', 'caPem'], 'SMTP_CONFIG_INVALID')
  const tls = value.tls ?? 'starttls'
  const port = value.port ?? (tls === 'tls' ? 465 : 587)
  if (typeof value.host !== 'string' || value.host.length < 1 || value.host.length > 253
    || (!isIP(value.host) && !value.host.split('.').every(label => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label)))
    || !Number.isSafeInteger(port) || (port as number) < 1 || (port as number) > 65535
    || (tls !== 'tls' && tls !== 'starttls') || !isMailbox(value.from)) throw new SmtpError('SMTP_CONFIG_INVALID')
  if (value.caPem !== undefined) {
    if (typeof value.caPem !== 'string' || value.caPem.length < 1 || Buffer.byteLength(value.caPem) > 64 * 1024
      || !/^\s*-----BEGIN CERTIFICATE-----/.test(value.caPem) || value.caPem.includes('PRIVATE KEY')) {
      throw new SmtpError('SMTP_CONFIG_INVALID')
    }
    try { createSecureContext({ ca: value.caPem }) } catch { throw new SmtpError('SMTP_CONFIG_INVALID') }
  }
  return { host: value.host, port: port as number, tls, from: value.from,
    ...(value.caPem === undefined ? {} : { caPem: value.caPem as string }) }
}

export function validateSmtpLimits(config: SmtpIntegrationConfig): Required<SmtpIntegrationConfig> {
  const limits = { sendTimeoutMs: config.sendTimeoutMs ?? 30_000, maxConcurrency: config.maxConcurrency ?? 4, maxPending: config.maxPending ?? 16 }
  if (!Number.isSafeInteger(limits.sendTimeoutMs) || limits.sendTimeoutMs < 1 || limits.sendTimeoutMs > 300_000
    || !Number.isSafeInteger(limits.maxConcurrency) || limits.maxConcurrency < 1 || limits.maxConcurrency > 32
    || !Number.isSafeInteger(limits.maxPending) || limits.maxPending < 0 || limits.maxPending > 128) {
    throw new SmtpError('SMTP_CONFIG_INVALID')
  }
  return limits
}

interface SendJob {
  input: SmtpSendInput
  signal: AbortSignal
  started: boolean
  settled: boolean
  connection?: SMTPConnection
  stream?: Readable
  timer?: ReturnType<typeof setTimeout>
  abort(): void
  finish(error?: SmtpError, result?: SmtpSendOutput): void
}

function safeSendError(error: unknown): SmtpError {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
  const originalCode = error && typeof error === 'object' && 'originalCode' in error ? error.originalCode : undefined
  if (code === 'EAUTH') return new SmtpError('SMTP_AUTH_FAILED')
  if (code === 'EENVELOPE') return new SmtpError('SMTP_RECIPIENTS_REJECTED')
  const tlsCodes = ['ETLS', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'ERR_TLS_CERT_ALTNAME_INVALID']
  if ([code, originalCode].some(value => typeof value === 'string' && tlsCodes.includes(value))) return new SmtpError('SMTP_TLS_FAILED')
  if (code === 'ETIMEDOUT') return new SmtpError('SMTP_TIMEOUT', 'unknown')
  return new SmtpError('SMTP_SEND_FAILED', 'unknown')
}

/** Each send owns an SMTPConnection, including its current TLS socket, so cancellation is isolated. */
export function createSmtpRuntime(
  configInput: SmtpConnectionConfig,
  credential: { username: string; password: string },
  lifetime: AbortSignal,
  limits: Required<SmtpIntegrationConfig>,
): { value: SmtpTransportRuntime; close(): void } {
  const config = validateSmtpConfig(configInput)
  if (lifetime.aborted || !credential || typeof credential.username !== 'string' || !credential.username
    || typeof credential.password !== 'string' || !credential.password
    || credential.username.length > 4096 || credential.password.length > 4096) throw new SmtpError('SMTP_UNAVAILABLE')
  const auth = { user: credential.username, pass: credential.password }
  const queue: SendJob[] = []
  const active = new Set<SendJob>()
  let closed = false

  const pump = () => {
    while (!closed && active.size < limits.maxConcurrency && queue.length) {
      const job = queue.shift()!
      if (job.settled) continue
      job.started = true
      active.add(job)
      try {
        const connection = new SMTPConnection({
          host: config.host, port: config.port, secure: config.tls === 'tls', requireTLS: config.tls === 'starttls',
          logger: false, debug: false,
          connectionTimeout: limits.sendTimeoutMs, greetingTimeout: limits.sendTimeoutMs,
          socketTimeout: limits.sendTimeoutMs, dnsTimeout: limits.sendTimeoutMs, maxResponseSize: 64 * 1024,
          tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2', ...(config.caPem ? { ca: config.caPem } : {}) },
        })
        job.connection = connection
        connection.once('error', error => job.finish(safeSendError(error)))
        connection.once('end', () => job.finish(new SmtpError('SMTP_SEND_FAILED', 'unknown')))
        connection.connect(error => {
          if (job.settled) return
          if (error) { job.finish(safeSendError(error)); return }
          connection.login(auth, error => {
            if (job.settled) return
            if (error) { job.finish(safeSendError(error)); return }
            try {
              const mail = new MailComposer({
                from: config.from, to: job.input.to, subject: job.input.subject, text: job.input.text,
                ...(job.input.html === undefined ? {} : { html: job.input.html }),
                disableFileAccess: true, disableUrlAccess: true,
              }).compile()
              const messageId = mail.messageId()
              job.stream = mail.createReadStream()
              job.stream.once('error', error => job.finish(safeSendError(error)))
              connection.send(mail.getEnvelope(), job.stream, (error, info) => {
                if (job.settled) return
                if (error || !info) { job.finish(safeSendError(error)); return }
                const accepted = info.accepted.filter((address): address is string => typeof address === 'string')
                const rejected = info.rejected.filter((address): address is string => typeof address === 'string')
                if (!accepted.length) { job.finish(new SmtpError('SMTP_RECIPIENTS_REJECTED')); return }
                job.finish(undefined, { messageId, accepted, rejected })
              })
            } catch (error) { job.finish(safeSendError(error)) }
          })
        })
      } catch (error) { job.finish(safeSendError(error)) }
    }
  }

  const close = () => {
    if (closed) return
    closed = true
    lifetime.removeEventListener('abort', close)
    for (const job of [...queue, ...active]) job.finish(new SmtpError('SMTP_UNAVAILABLE', job.started ? 'unknown' : 'not-submitted'))
    auth.user = ''
    auth.pass = ''
  }
  lifetime.addEventListener('abort', close, { once: true })

  return { close, value: {
    async send(input, signal) {
      if (closed || lifetime.aborted) throw new SmtpError('SMTP_UNAVAILABLE')
      if (signal.aborted) throw new SmtpError('SMTP_CANCELLED')
      const checked = validateSmtpInput(input, config.from)
      if (active.size >= limits.maxConcurrency && queue.length >= limits.maxPending) throw new SmtpError('SMTP_BUSY')
      return new Promise<SmtpSendOutput>((resolve, reject) => {
        const job: SendJob = {
          input: checked, signal, started: false, settled: false,
          abort() { job.finish(new SmtpError('SMTP_CANCELLED', job.started ? 'unknown' : 'not-submitted')) },
          finish(error, result) {
            if (job.settled) return
            job.settled = true
            if (job.timer) clearTimeout(job.timer)
            signal.removeEventListener('abort', job.abort)
            const index = queue.indexOf(job)
            if (index >= 0) queue.splice(index, 1)
            active.delete(job)
            job.connection?.close()
            job.stream?.destroy()
            if (error) reject(error)
            else resolve(result!)
            queueMicrotask(pump)
          },
        }
        signal.addEventListener('abort', job.abort, { once: true })
        job.timer = setTimeout(() => job.finish(new SmtpError('SMTP_TIMEOUT', job.started ? 'unknown' : 'not-submitted')), limits.sendTimeoutMs)
        job.timer.unref()
        queue.push(job)
        pump()
      })
    },
  } }
}
