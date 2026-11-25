import { defineCapability, type CapabilityProvider } from '@numenjs/core'
import type { ConnectionAdapterDefinition, ConnectionTypeDefinition } from '@numenjs/connections'
import type { CredentialTypeDefinition } from '@numenjs/credentials'
import type { Context } from 'cordis'
import type Schema from 'schemastery'
import z from 'schemastery'
import { createSmtpRuntime, SmtpError, validateSmtpLimits, type SmtpConnectionConfig, type SmtpIntegrationConfig,
  type SmtpSendInput, type SmtpSendOutput, type SmtpTransportRuntime } from './runtime.js'

export { SmtpError, smtpLimits } from './runtime.js'
export type { SmtpConnectionConfig, SmtpIntegrationConfig, SmtpSendInput, SmtpSendOutput, SmtpTransportRuntime } from './runtime.js'

export const smtpPasswordCredential: CredentialTypeDefinition = {
  id: 'smtp:password', version: 1, title: 'SMTP Username and Password',
  secret: z.object({
    username: z.string().min(1).max(4096).required().description('SMTP authentication username, stored only in the encrypted Credential.'),
    password: z.string().min(1).max(4096).role('secret').required().description('SMTP password or application password.'),
  }),
}

export const smtpTransportConnectionType: ConnectionTypeDefinition<SmtpTransportRuntime> = {
  id: 'smtp:transport', version: 1, title: 'SMTP Transport',
}

export const smtpPasswordAdapter: ConnectionAdapterDefinition<SmtpConnectionConfig, SmtpTransportRuntime> = {
  id: 'smtp:password', version: 1, title: 'SMTP with Password', type: smtpTransportConnectionType,
  credentialType: smtpPasswordCredential.id,
  config: z.object({
    host: z.string().min(1).max(253).required().description('SMTP hostname or IP address, without a URL scheme or credentials.'),
    port: z.natural().min(1).max(65535).description('Defaults to 465 for TLS or 587 for STARTTLS. Custom ports support self-hosted servers.'),
    tls: z.union(['starttls', 'tls']).default('starttls').description('STARTTLS is mandatory when selected; TLS encrypts from connection establishment. Certificates are always verified.'),
    from: z.string().min(1).max(254).pattern(/^[^\r\n\0]+$/).required().description('Fixed sender as a single bare ASCII email address. Display names and address lists are not accepted.'),
    caPem: z.string().max(64 * 1024).role('numen/multiline').description('Optional PEM CA certificate bundle for a private SMTP server. This replaces the default trust roots; certificate verification remains enabled.'),
  }) as Schema<SmtpConnectionConfig>,
}

export const smtpSendCapability = defineCapability<SmtpSendInput, SmtpSendOutput>({
  id: 'smtp:send', version: 1, kind: 'action', title: 'Send Email',
  description: 'Submit a text or HTML email over verified SMTP TLS. Partial recipient rejection is returned explicitly. Acceptance does not guarantee inbox delivery; retries can send duplicates.',
  input: z.object({
    to: z.array(z.string().min(1).max(254).pattern(/^[^\r\n\0]+$/)).min(1).max(50).required().description('Up to 50 bare ASCII recipient addresses. Duplicate addresses are submitted once.'),
    subject: z.string().pattern(/^[^\r\n\0]*$/).required().description('Email subject. Unicode is supported; CR, LF and NUL are rejected.'),
    text: z.string().role('numen/multiline').required().description('Plain-text message. Combined UTF-8 sender, recipients, subject and bodies must not exceed 1 MiB.'),
    html: z.string().role('numen/multiline').description('Optional HTML alternative. Literal HTML only; the plugin does not fetch images, URLs or files.'),
  }) as Schema<SmtpSendInput>,
  output: z.object({
    messageId: z.string().required().description('Message-ID generated for this SMTP submission; this is not a delivery receipt.'),
    accepted: z.array(z.string()).required().description('Recipients accepted by the SMTP server for this submission.'),
    rejected: z.array(z.string()).required().description('Recipients rejected by the SMTP server. Non-empty means partial acceptance and does not cause an automatic retry.'),
  }),
  connections: [{ name: 'transport', required: true, accepts: ['smtp:transport@1'] }],
  semantics: { sideEffect: true, idempotent: false, retrySafe: false },
})

export function smtpIntegrationPlugin(ctx: Context, config: SmtpIntegrationConfig = {}): void {
  const limits = validateSmtpLimits(config)
  ctx.capabilities.define(ctx, smtpSendCapability)
  ctx.credentials.defineType(ctx, smtpPasswordCredential)
  ctx.connections.defineType(ctx, smtpTransportConnectionType)
  ctx.connections.defineAdapter(ctx, smtpPasswordAdapter)
  ctx.connections.provideAdapter(ctx, smtpPasswordAdapter, {
    async open({ connection, credential, signal }) {
      if (!credential || typeof credential.value.username !== 'string' || typeof credential.value.password !== 'string') {
        throw new SmtpError('SMTP_UNAVAILABLE')
      }
      return createSmtpRuntime(connection.config as unknown as SmtpConnectionConfig,
        { username: credential.value.username, password: credential.value.password }, signal, limits)
    },
  })
  ctx.capabilities.provide(ctx, smtpSendCapability, {
    async invoke({ input, connections, signal }) {
      const transport = connections.transport as SmtpTransportRuntime | undefined
      if (!transport || typeof transport.send !== 'function') throw new SmtpError('SMTP_UNAVAILABLE')
      return transport.send(input, signal)
    },
  } satisfies CapabilityProvider<SmtpSendInput, SmtpSendOutput>)
}

smtpIntegrationPlugin.inject = ['capabilities', 'credentials', 'connections']
smtpIntegrationPlugin.Config = z.object({
  sendTimeoutMs: z.natural().min(1).max(300_000).default(30_000).description('Overall deadline per send, including queue time, connection and SMTP submission.'),
  maxConcurrency: z.natural().min(1).max(32).default(4).description('Maximum simultaneous sends per Connection.'),
  maxPending: z.natural().max(128).default(16).description('Maximum waiting sends per Connection. Excess requests fail immediately.'),
})

export default smtpIntegrationPlugin
