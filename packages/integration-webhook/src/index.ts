import type { Request, Response } from '@cordisjs/plugin-server'
import { defineCapability, type NumenValue, type TriggerActivation, type TriggerProvider } from '@numenjs/core'
import type { ConnectionAdapterDefinition, ConnectionTypeDefinition } from '@numenjs/connections'
import type { CredentialTypeDefinition } from '@numenjs/credentials'
import type { Context } from 'cordis'
import { createHash, timingSafeEqual } from 'node:crypto'
import z from 'schemastery'
import { webhookPath } from './path.js'
import { headerCount, readEventId, readWebhookBody, validateContentType, WebhookRequestError } from './request.js'

export { webhookPath } from './path.js'
export { webhookRequestLimits, WebhookRequestError } from './request.js'

export interface WebhookTriggerConfig {
  authentication: 'token' | 'none'
}

export interface WebhookEvent {
  body: NumenValue
  receivedAt: string
  eventId?: string
}

export interface WebhookAuthRuntime {
  verify(token: string): boolean
}

export const webhookHeaderTokenCredential: CredentialTypeDefinition = {
  id: 'webhook:header-token',
  version: 1,
  title: 'Webhook Header Token',
  secret: z.object({ token: z.string().min(1).max(4096).pattern(/^[\x21-\x7e]+$/).role('secret').required() }),
}

export const webhookAuthConnectionType: ConnectionTypeDefinition<WebhookAuthRuntime> = {
  id: 'webhook:auth',
  version: 1,
  title: 'Webhook Authentication',
}

export const webhookHeaderTokenAdapter: ConnectionAdapterDefinition<Record<string, NumenValue>, WebhookAuthRuntime> = {
  id: 'webhook:header-token',
  version: 1,
  title: 'Webhook Header Token',
  type: webhookAuthConnectionType,
  credentialType: webhookHeaderTokenCredential.id,
  config: z.object({}),
}

export const webhookReceiveTrigger = defineCapability({
  id: 'webhook:receive',
  version: 1,
  kind: 'trigger',
  title: 'Webhook',
  description: 'Accept a POST JSON request durably, then return its Run receipt. The published and enabled Automation owns the endpoint.',
  input: z.object({
    authentication: z.union(['token', 'none']).default('token').description('Token requires an Authentication Connection and Authorization: Bearer header. None explicitly allows unauthenticated requests.'),
  }),
  output: z.object({
    // Schemastery required() rejects null; JSON null is a valid received body.
    // The provider always supplies this property after validating plain JSON.
    body: z.any(),
    receivedAt: z.string().required().extra('extra', { numen: { execution: 'public' } }),
    eventId: z.string(),
  }),
  // The slot is conditional: activate() enforces it for the default token mode.
  connections: [{ name: 'auth', required: false, accepts: ['webhook:auth@1'] }],
  semantics: { sideEffect: false, idempotent: true, retrySafe: true },
})

interface ActiveEndpoint {
  activation: TriggerActivation<WebhookEvent>
  authentication: WebhookTriggerConfig['authentication']
  auth?: WebhookAuthRuntime
}

function reject(response: Response, error: WebhookRequestError): void {
  response.status = error.status
  response.headers.set('cache-control', 'no-store')
  // Also stops unread, oversized, or indefinitely streaming request bodies.
  response.headers.set('connection', 'close')
  response.json({ error: { code: error.code, message: error.message } })
}

function authenticate(request: Request, endpoint: ActiveEndpoint): void {
  if (endpoint.authentication === 'none') return
  const authorization = request.headers.get('authorization') ?? ''
  const token = /^Bearer ([\x21-\x7e]+)$/.exec(authorization)?.[1] ?? ''
  const matches = endpoint.auth?.verify(token) ?? false
  if (headerCount(request, 'authorization') !== 1 || !token || !matches) {
    throw new WebhookRequestError(401, 'WEBHOOK_AUTHENTICATION_REQUIRED', 'A valid webhook Bearer token is required.')
  }
}

export function webhookIntegrationPlugin(ctx: Context): void {
  // Register the unique contract before routes: a second instance must fail
  // before it can install a competing ingress route on the shared Server.
  ctx.capabilities.define(ctx, webhookReceiveTrigger)
  ctx.credentials.defineType(ctx, webhookHeaderTokenCredential)
  ctx.connections.defineType(ctx, webhookAuthConnectionType)
  ctx.connections.defineAdapter(ctx, webhookHeaderTokenAdapter)
  ctx.connections.provideAdapter(ctx, webhookHeaderTokenAdapter, {
    async open({ credential, signal }) {
      const token = credential?.value.token
      if (signal.aborted || typeof token !== 'string' || !token) throw new Error('Webhook credential is unavailable.')
      const digest = createHash('sha256').update(token).digest()
      let closed = false
      return {
        value: { verify(candidate: string) {
          const equal = timingSafeEqual(digest, createHash('sha256').update(candidate).digest())
          return !closed && !signal.aborted && equal
        } } satisfies WebhookAuthRuntime,
        close() { closed = true; digest.fill(0) },
      }
    },
  })

  const endpoints = new Map<string, ActiveEndpoint>()
  ctx.effect(() => () => endpoints.clear())
  ctx.capabilities.provideTrigger(ctx, webhookReceiveTrigger, {
    activate(activation) {
      const authentication = activation.binding.config.authentication ?? 'token'
      if (authentication !== 'token' && authentication !== 'none') throw new Error('Webhook authentication mode is invalid.')
      const auth = activation.connections.auth as WebhookAuthRuntime | undefined
      if (authentication === 'token' && (!auth || typeof auth.verify !== 'function')) {
        throw new Error('Webhook token authentication requires a ready Authentication Connection.')
      }
      const key = webhookPath(activation.binding.automationId, activation.binding.triggerId)
      const previous = endpoints.get(key)
      if (previous && !previous.activation.signal.aborted) throw new Error('Webhook endpoint is already active.')
      const endpoint: ActiveEndpoint = { activation, authentication, ...(auth ? { auth } : {}) }
      endpoints.set(key, endpoint)
      return () => { if (endpoints.get(key) === endpoint) endpoints.delete(key) }
    },
  } satisfies TriggerProvider<WebhookEvent>)

  ctx.server.post('/api/webhooks/:automationId/:triggerId', async (request, response) => {
    try {
      const key = webhookPath(request.params.automationId, request.params.triggerId)
      const endpoint = endpoints.get(key)
      if (!endpoint || endpoint.activation.signal.aborted) {
        throw new WebhookRequestError(404, 'WEBHOOK_NOT_FOUND', 'The webhook endpoint is unavailable.')
      }
      authenticate(request, endpoint)
      validateContentType(request)
      const eventId = readEventId(request)
      const body = await readWebhookBody(request, endpoint.activation.signal)
      if (endpoint.activation.signal.aborted || endpoints.get(key) !== endpoint) {
        throw new WebhookRequestError(503, 'WEBHOOK_UNAVAILABLE', 'The webhook subscription is no longer available.')
      }
      const receivedAt = new Date().toISOString()
      const result = await endpoint.activation.emit({
        data: { body, receivedAt, ...(eventId === undefined ? {} : { eventId }) },
        occurredAt: receivedAt,
        ...(eventId === undefined ? {} : { eventId }),
      })
      if (result.status === 'stale') throw new WebhookRequestError(503, 'WEBHOOK_UNAVAILABLE', 'The webhook subscription is no longer available.')
      response.status = result.status === 'accepted' ? 202 : 200
      response.headers.set('cache-control', 'no-store')
      response.json({ status: result.status, runId: result.runId })
    } catch (error) {
      if (request._req.aborted || response._res.destroyed) return
      reject(response, error instanceof WebhookRequestError ? error
        : new WebhookRequestError(503, 'WEBHOOK_ACCEPTANCE_FAILED', 'The webhook request could not be accepted.'))
    }
  })
}

webhookIntegrationPlugin.inject = ['capabilities', 'credentials', 'connections', 'server']

export default webhookIntegrationPlugin
