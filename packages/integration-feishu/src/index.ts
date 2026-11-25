import { defineCapability, type NumenValue, type CapabilityProvider } from '@numenjs/core'
import type { ConnectionAdapterDefinition, ConnectionTypeDefinition } from '@numenjs/connections'
import type { CredentialTypeDefinition } from '@numenjs/credentials'
import type { Context } from 'cordis'
import z from 'schemastery'
import { createFeishuRuntime, validateFeishuTimeout, FeishuError, type FeishuBotRuntime, type FeishuIntegrationConfig, type FeishuSendTextInput, type FeishuSendTextOutput } from './runtime.js'

export { FeishuError, feishuLimits } from './runtime.js'
export type { FeishuBotRuntime, FeishuErrorCode, FeishuIntegrationConfig, FeishuSendTextInput, FeishuSendTextOutput } from './runtime.js'

export const feishuWebhookCredential: CredentialTypeDefinition = {
  id: 'feishu:webhook', version: 1, title: 'Feishu Bot Webhook',
  secret: z.object({
    webhookUrl: z.string().pattern(/^https:\/\/open\.feishu\.cn\/open-apis\/bot\/v2\/hook\/[A-Za-z0-9_-]{1,128}$/).role('secret').required().description('Private Feishu custom bot URL. Stored encrypted; never put it in workflow inputs.'),
    secret: z.string().min(1).max(4096).role('secret').description('Signing secret, required when signature verification is enabled in the bot settings.'),
  }),
}
export const feishuBotConnectionType: ConnectionTypeDefinition<FeishuBotRuntime> = {
  id: 'feishu:bot', version: 1, title: 'Feishu Bot',
}
export const feishuWebhookAdapter: ConnectionAdapterDefinition<Record<string, NumenValue>, FeishuBotRuntime> = {
  id: 'feishu:webhook', version: 1, title: 'Feishu Custom Bot', type: feishuBotConnectionType,
  credentialType: feishuWebhookCredential.id, config: z.object({}),
}
export const feishuSendTextCapability = defineCapability<FeishuSendTextInput, FeishuSendTextOutput>({
  id: 'feishu:send-text', version: 1, kind: 'action', title: 'Send Feishu Text',
  description: 'Submit a text message to a Feishu custom bot. Timeouts can leave delivery uncertain, so failed sends are not automatically retried.',
  input: z.object({ text: z.string().min(1).max(20 * 1024).role('numen/multiline').required().description('Text with optional Feishu mention markup. The complete encoded UTF-8 request must fit within 20 KiB.') }),
  output: z.object({ accepted: z.const(true).required().extra('extra', { numen: { execution: 'public' } }) }),
  connections: [{ name: 'bot', required: true, accepts: ['feishu:bot@1'] }],
  semantics: { sideEffect: true, idempotent: false, retrySafe: false },
})

export function feishuIntegrationPlugin(ctx: Context, config: FeishuIntegrationConfig = {}): void {
  const timeoutMs = validateFeishuTimeout(config)
  ctx.capabilities.define(ctx, feishuSendTextCapability)
  ctx.credentials.defineType(ctx, feishuWebhookCredential)
  ctx.connections.defineType(ctx, feishuBotConnectionType)
  ctx.connections.defineAdapter(ctx, feishuWebhookAdapter)
  ctx.connections.provideAdapter(ctx, feishuWebhookAdapter, { async open({ credential, signal }) {
    if (!credential) throw new FeishuError('FEISHU_UNAVAILABLE')
    return createFeishuRuntime(ctx, credential.value, signal, timeoutMs)
  } })
  ctx.capabilities.provide(ctx, feishuSendTextCapability, { async invoke({ input, connections, signal }) {
    const bot = connections.bot as FeishuBotRuntime | undefined
    if (!bot || typeof bot.sendText !== 'function') throw new FeishuError('FEISHU_UNAVAILABLE')
    return bot.sendText(input, signal)
  } } satisfies CapabilityProvider<FeishuSendTextInput, FeishuSendTextOutput>)
}
feishuIntegrationPlugin.inject = ['capabilities', 'credentials', 'connections', 'http']
feishuIntegrationPlugin.Config = z.object({ timeoutMs: z.natural().min(1).max(300_000).default(30_000).description('Overall send deadline, including response body receipt.') })
export default feishuIntegrationPlugin
