import type { Response } from '@cordisjs/plugin-server'
import type { ConnectionAdapterDefinition, ConnectionTypeDefinition } from '@numenjs/connections'
import { defineCapability, type NumenValue, type TriggerActivation, type TriggerProvider } from '@numenjs/core'
import type { CredentialTypeDefinition } from '@numenjs/credentials'
import type { Context } from 'cordis'
import type Schema from 'schemastery'
import z from 'schemastery'
import { createGithubWebhookAuth, type GithubWebhookAuthRuntime } from './auth.js'
import { githubWebhookPath } from './path.js'
import { GithubRequestError, githubNamePattern, parseGithubBody, readGithubBody, readGithubHeaders, validateGithubContentType } from './request.js'
import { githubApiPlugin } from './api.js'

export * from './api.js'
export { githubWebhookPath } from './path.js'
export { GithubRequestError, githubRequestLimits } from './request.js'
export type { GithubWebhookAuthRuntime } from './auth.js'

export interface GithubWebhookConfig { events: string[]; actions: string[] }
export interface GithubWebhookEvent {
  body: Record<string, NumenValue>
  event: string
  deliveryId: string
  receivedAt: string
  action?: string
}

export const githubWebhookSecretCredential: CredentialTypeDefinition = {
  id: 'github:webhook-secret', version: 1, title: 'GitHub Webhook Secret',
  secret: z.object({ secret: z.string().min(1).max(4096).role('secret').required() }),
}
export const githubWebhookAuthConnectionType: ConnectionTypeDefinition<GithubWebhookAuthRuntime> = {
  id: 'github:webhook-auth', version: 1, title: 'GitHub Webhook Authentication',
}
export const githubWebhookSecretAdapter: ConnectionAdapterDefinition<Record<string, NumenValue>, GithubWebhookAuthRuntime> = {
  id: 'github:webhook-secret', version: 1, title: 'GitHub Webhook Secret',
  type: githubWebhookAuthConnectionType, credentialType: githubWebhookSecretCredential.id, config: z.object({}),
}

export const githubWebhookTrigger = defineCapability<GithubWebhookConfig, GithubWebhookEvent>({
  id: 'github:webhook', version: 1, kind: 'trigger', title: 'GitHub Webhook',
  description: 'Verify GitHub HMAC-SHA256 deliveries and durably accept matching events. Configure the webhook manually in GitHub; ping only checks connectivity.',
  input: z.object({
    events: z.array(z.string().pattern(githubNamePattern)).max(100).default([]).description('GitHub event names, such as issues or push. Empty accepts all events except ping.'),
    actions: z.array(z.string().min(1).max(100)).max(100).default([]).description('Exact payload actions, such as opened, closed or a custom repository_dispatch event type. Empty accepts any action; a nonempty list excludes events without action.'),
  }) as Schema<GithubWebhookConfig>,
  output: z.object({ body: z.any().required(), event: z.string().required(), deliveryId: z.string().required(),
    receivedAt: z.string().required().extra('extra', { numen: { execution: 'public' } }), action: z.string() }) as Schema<GithubWebhookEvent>,
  connections: [{ name: 'auth', required: true, accepts: ['github:webhook-auth@1'] }],
  semantics: { sideEffect: false, idempotent: true, retrySafe: true },
})

interface ActiveEndpoint {
  activation: TriggerActivation<GithubWebhookEvent>
  auth: GithubWebhookAuthRuntime
  events: Set<string>
  actions: Set<string>
}

function reject(response: Response, error: GithubRequestError): void {
  response.status = error.status
  response.headers.set('cache-control', 'no-store')
  response.headers.set('connection', 'close')
  response.json({ error: { code: error.code, message: error.message } })
}

export function githubIntegrationPlugin(ctx: Context): void {
  ctx.inject(['http'], child => githubApiPlugin(child))
  ctx.capabilities.define(ctx, githubWebhookTrigger)
  ctx.credentials.defineType(ctx, githubWebhookSecretCredential)
  ctx.connections.defineType(ctx, githubWebhookAuthConnectionType)
  ctx.connections.defineAdapter(ctx, githubWebhookSecretAdapter)
  ctx.connections.provideAdapter(ctx, githubWebhookSecretAdapter, { async open({ credential, signal }) {
    const secret = credential?.value.secret
    if (signal.aborted || typeof secret !== 'string' || !secret) throw new Error('GitHub webhook credential is unavailable.')
    return createGithubWebhookAuth(secret, signal)
  } })

  const endpoints = new Map<string, ActiveEndpoint>()
  ctx.effect(() => () => endpoints.clear())
  ctx.capabilities.provideTrigger(ctx, githubWebhookTrigger, { activate(activation) {
    const config = githubWebhookTrigger.input(activation.binding.config as unknown as GithubWebhookConfig)
    const auth = activation.connections.auth as GithubWebhookAuthRuntime | undefined
    if (!auth || typeof auth.verify !== 'function') throw new Error('GitHub webhook requires a ready Authentication Connection.')
    const key = githubWebhookPath(activation.binding.automationId, activation.binding.triggerId)
    const previous = endpoints.get(key)
    if (previous && !previous.activation.signal.aborted) throw new Error('GitHub webhook endpoint is already active.')
    const endpoint: ActiveEndpoint = { activation, auth, events: new Set(config.events), actions: new Set(config.actions) }
    endpoints.set(key, endpoint)
    return () => { if (endpoints.get(key) === endpoint) endpoints.delete(key) }
  } } satisfies TriggerProvider<GithubWebhookEvent>)

  ctx.server.post('/api/github/webhooks/:automationId/:triggerId', async (request, response) => {
    try {
      const key = githubWebhookPath(request.params.automationId, request.params.triggerId)
      const endpoint = endpoints.get(key)
      if (!endpoint || endpoint.activation.signal.aborted) throw new GithubRequestError(404, 'GITHUB_NOT_FOUND', 'The GitHub webhook endpoint is unavailable.')
      const { signature, event, deliveryId } = readGithubHeaders(request)
      validateGithubContentType(request)
      const bytes = await readGithubBody(request, endpoint.activation.signal)
      if (endpoint.activation.signal.aborted || endpoints.get(key) !== endpoint) throw new GithubRequestError(503, 'GITHUB_UNAVAILABLE', 'The GitHub subscription is no longer available.')
      if (!endpoint.auth.verify(bytes, signature)) throw new GithubRequestError(401, 'GITHUB_SIGNATURE_INVALID', 'A valid GitHub SHA-256 signature is required.')
      const body = parseGithubBody(bytes)
      const action = typeof body.action === 'string' ? body.action : undefined
      response.headers.set('cache-control', 'no-store')
      if (event === 'ping') {
        response.status = 200
        response.json({ status: 'ping' })
        return
      }
      if ((endpoint.events.size && !endpoint.events.has(event)) || (endpoint.actions.size && (!action || !endpoint.actions.has(action)))) {
        response.status = 200
        response.json({ status: 'ignored' })
        return
      }
      const receivedAt = new Date().toISOString()
      const result = await endpoint.activation.emit({
        data: { body, event, deliveryId, receivedAt, ...(action === undefined ? {} : { action }) },
        occurredAt: receivedAt,
        eventId: deliveryId,
      })
      if (result.status === 'stale') throw new GithubRequestError(503, 'GITHUB_UNAVAILABLE', 'The GitHub subscription is no longer available.')
      response.status = result.status === 'accepted' ? 202 : 200
      response.json({ status: result.status, runId: result.runId })
    } catch (error) {
      if (request._req.aborted || response._res.destroyed) return
      reject(response, error instanceof GithubRequestError ? error
        : new GithubRequestError(503, 'GITHUB_ACCEPTANCE_FAILED', 'The GitHub delivery could not be accepted.'))
    }
  })
}

githubIntegrationPlugin.inject = ['capabilities', 'credentials', 'connections', 'server']
export default githubIntegrationPlugin
