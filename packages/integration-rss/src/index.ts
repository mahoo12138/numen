import { defineCapability, type CapabilityProvider } from '@numenjs/core'
import type {} from '@numenjs/http'
import { withLogSecrets } from '@numenjs/logging'
import type { Context } from 'cordis'
import type Schema from 'schemastery'
import z from 'schemastery'
import { projectFeed } from './parser.js'

export interface RssReadInput { url: string; maxItems?: number; timeoutMs?: number }
export interface RssFeed { title: string; link: string; description: string; language: string; updated: string }
export interface RssItem { id: string; title: string; link: string; published: string; updated: string; author: string; summary: string; content: string }
export interface RssReadOutput {
  format: 'rss2' | 'atom'
  feed: RssFeed
  items: RssItem[]
  totalItems: number
  returnedItems: number
  truncated: boolean
}

export const rssLimits = { maxResponseBytes: 1024 * 1024, maxOutputBytes: 1024 * 1024, maxDepth: 32, maxElements: 20_000, maxFeedItems: 10_000, maxRedirects: 5, maxItems: 1_000 } as const
export type RssErrorCode = 'RSS_INPUT_INVALID' | 'RSS_URL_INVALID' | 'RSS_HTTP_ERROR' | 'RSS_REDIRECT_INVALID'
  | 'RSS_REDIRECT_LIMIT' | 'RSS_RESPONSE_TOO_LARGE' | 'RSS_MEDIA_TYPE_UNSUPPORTED' | 'RSS_ENCODING_UNSUPPORTED'
  | 'RSS_XML_INVALID' | 'RSS_DTD_FORBIDDEN' | 'RSS_FORMAT_UNSUPPORTED' | 'RSS_LIMIT_EXCEEDED'
  | 'RSS_OUTPUT_TOO_LARGE' | 'RSS_TIMEOUT' | 'RSS_CANCELLED' | 'RSS_UNAVAILABLE' | 'RSS_NETWORK_ERROR'

/** Deliberately omit URLs, response text, parser excerpts and transport causes. */
export class RssError extends Error {
  override name = 'RssError'
  constructor(public readonly code: RssErrorCode) { super(`[${code}] RSS feed read failed.`) }
}

const itemSchema = z.object({
  id: z.string().required(), title: z.string().required(), link: z.string().required(),
  published: z.string().required(), updated: z.string().required(), author: z.string().required(),
  summary: z.string().required(), content: z.string().required(),
})

export const rssReadCapability = defineCapability<RssReadInput, RssReadOutput>({
  id: 'rss:read', version: 1, kind: 'query', title: 'Read RSS Feed',
  description: 'Read one bounded RSS 2.0 or Atom 1.0 snapshot. Preserves source order and duplicate items; does not poll or remember previously read entries.',
  input: z.object({
    url: z.string().required().description('Absolute HTTP(S) feed URL. URL userinfo is forbidden. URLs and feed data remain private in Run inspection.'),
    maxItems: z.natural().min(1).max(rssLimits.maxItems).default(100).description('Return the first N entries in source order. truncated and totalItems report omitted entries; the full feed is still validated.'),
    timeoutMs: z.natural().min(1).max(300_000).default(30_000).role('ms').description('Total timeout for all redirects and response body reading.'),
  }) as Schema<RssReadInput>,
  output: z.object({
    format: z.union(['rss2', 'atom']).required(),
    feed: z.object({ title: z.string().required(), link: z.string().required(), description: z.string().required(), language: z.string().required(), updated: z.string().required() }).required(),
    items: z.array(itemSchema).required(), totalItems: z.natural().required(), returnedItems: z.natural().required(), truncated: z.boolean().required(),
  }) as Schema<RssReadOutput>,
  semantics: { sideEffect: false, idempotent: true, retrySafe: true },
})

function target(source: string, base?: URL): URL {
  let url: URL
  try { url = new URL(source, base) } catch { throw new RssError('RSS_URL_INVALID') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new RssError('RSS_URL_INVALID')
  url.hash = ''
  return url
}

function checkContentType(source: string | null): void {
  if (!source) return
  const [raw, ...parameters] = source.split(';')
  const type = raw!.trim().toLowerCase()
  if (!['application/rss+xml', 'application/atom+xml', 'application/xml', 'text/xml', 'text/plain', 'application/octet-stream'].includes(type)) {
    throw new RssError('RSS_MEDIA_TYPE_UNSUPPORTED')
  }
  for (const parameter of parameters) {
    const match = /^\s*charset\s*=\s*"?([^";\s]+)"?\s*$/i.exec(parameter)
    if (match && !/^utf-?8$/i.test(match[1]!)) throw new RssError('RSS_ENCODING_UNSUPPORTED')
  }
}

async function readBody(response: Response, signal: AbortSignal): Promise<string> {
  const length = response.headers.get('content-length')
  if (length && /^\d+$/.test(length) && Number(length) > rssLimits.maxResponseBytes) {
    await response.body?.cancel()
    throw new RssError('RSS_RESPONSE_TOO_LARGE')
  }
  const reader = response.body?.getReader()
  if (!reader) throw new RssError('RSS_XML_INVALID')
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      signal.throwIfAborted()
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > rssLimits.maxResponseBytes) {
        await reader.cancel()
        throw new RssError('RSS_RESPONSE_TOO_LARGE')
      }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)) }
  catch { throw new RssError('RSS_ENCODING_UNSUPPORTED') }
}

export function rssIntegrationPlugin(ctx: Context): void {
  // extend() creates a plugin-owned configuration while retaining the host transport,
  // proxy routing and lifecycle. Do not inherit authentication or query parameters.
  const client = ctx.http.extend()
  client.config.headers = {}
  let disposed = false
  const active = new Set<AbortController>()
  ctx.effect(() => () => {
    disposed = true
    for (const controller of active) controller.abort(new RssError('RSS_UNAVAILABLE'))
  })
  ctx.capabilities.define(ctx, rssReadCapability)
  ctx.capabilities.provide(ctx, rssReadCapability, {
    async invoke({ input, signal }) {
      if (disposed) throw new RssError('RSS_UNAVAILABLE')
      if (signal.aborted) throw new RssError('RSS_CANCELLED')
      if (typeof input.url !== 'string' || input.url.length > 8_192) throw new RssError('RSS_INPUT_INVALID')
      const maxItems = input.maxItems ?? 100
      const timeoutMs = input.timeoutMs ?? 30_000
      if (!Number.isSafeInteger(maxItems) || maxItems < 1 || maxItems > rssLimits.maxItems
        || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw new RssError('RSS_INPUT_INVALID')
      let url = target(input.url)
      const controller = new AbortController()
      active.add(controller)
      const cancel = () => controller.abort(new RssError('RSS_CANCELLED'))
      signal.addEventListener('abort', cancel, { once: true })
      const timer = setTimeout(() => controller.abort(new RssError('RSS_TIMEOUT')), timeoutMs)
      timer.unref()
      const deadline = performance.now() + timeoutMs
      try {
        for (let redirects = 0; ; redirects++) {
          controller.signal.throwIfAborted()
          const secrets = [url.href, ...url.searchParams.values()]
          const response = await withLogSecrets(secrets, () => client(url, {
            method: 'GET', redirect: 'manual', signal: controller.signal, timeout: 0, params: {}, data: undefined,
            headers: { accept: 'application/atom+xml, application/rss+xml, application/xml, text/xml, text/plain;q=0.5' },
            validateStatus: () => true,
          }))
          if ([301, 302, 303, 307, 308].includes(response.status)) {
            await response.body?.cancel()
            if (redirects >= rssLimits.maxRedirects) throw new RssError('RSS_REDIRECT_LIMIT')
            const location = response.headers.get('location')
            if (!location || location.length > 8_192) throw new RssError('RSS_REDIRECT_INVALID')
            try {
              const next = target(location, url)
              if (url.protocol === 'https:' && next.protocol === 'http:') throw new Error()
              url = next
            } catch { throw new RssError('RSS_REDIRECT_INVALID') }
            continue
          }
          if (!response.ok) {
            await response.body?.cancel()
            throw new RssError('RSS_HTTP_ERROR')
          }
          try { checkContentType(response.headers.get('content-type')) }
          catch (error) { await response.body?.cancel(); throw error }
          const text = await readBody(response, controller.signal)
          controller.signal.throwIfAborted()
          const output = projectFeed(text, url, maxItems)
          // Parsing is synchronous and bounded by bytes/elements/depth; check the
          // wall clock as well, since a timer cannot fire during synchronous work.
          if (performance.now() >= deadline) throw new RssError('RSS_TIMEOUT')
          controller.signal.throwIfAborted()
          return output
        }
      } catch (error) {
        if (controller.signal.aborted) throw controller.signal.reason
        if (error instanceof RssError) throw error
        throw new RssError('RSS_NETWORK_ERROR')
      } finally {
        clearTimeout(timer)
        signal.removeEventListener('abort', cancel)
        active.delete(controller)
      }
    },
  } satisfies CapabilityProvider<RssReadInput, RssReadOutput>)
}

rssIntegrationPlugin.inject = ['capabilities', 'http']
export default rssIntegrationPlugin
