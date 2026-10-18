import type { Request } from '@cordisjs/plugin-server'
import { parsePlainJson } from '@numenjs/integration-data/json'
import type { NumenValue } from '@numenjs/core'

export const webhookRequestLimits = { maxBytes: 1024 * 1024, timeoutMs: 30_000 } as const

export class WebhookRequestError extends Error {
  override name = 'WebhookRequestError'

  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message)
  }
}

export function headerCount(request: Request, name: string): number {
  let count = 0
  for (let index = 0; index < request._req.rawHeaders.length; index += 2) {
    if (request._req.rawHeaders[index]?.toLowerCase() === name) count += 1
  }
  return count
}

export function readEventId(request: Request): string | undefined {
  const eventId = request.headers.get('idempotency-key')
  if (eventId === null) return
  if (headerCount(request, 'idempotency-key') !== 1 || !/^[\x20-\x7e]{1,128}$/.test(eventId) || !eventId.trim()) {
    throw new WebhookRequestError(400, 'WEBHOOK_EVENT_ID_INVALID', 'Idempotency-Key must contain 1 to 128 printable ASCII characters and cannot be blank.')
  }
  return eventId
}

export function validateContentType(request: Request): void {
  const encoding = request.headers.get('content-encoding')?.toLowerCase().trim()
  const contentType = request.headers.get('content-type') ?? ''
  const [mediaType, ...parameters] = contentType.toLowerCase().split(';').map(value => value.trim())
  const charset = parameters.find(value => value.startsWith('charset='))?.slice(8).replace(/^"|"$/g, '')
  if ((encoding && encoding !== 'identity')
    || !/^application\/(?:json|[a-z0-9!#$&^_.+-]+\+json)$/.test(mediaType ?? '')
    || (charset && charset !== 'utf-8' && charset !== 'utf8')) {
    throw new WebhookRequestError(415, 'WEBHOOK_MEDIA_TYPE_UNSUPPORTED', 'The request must contain uncompressed UTF-8 JSON.')
  }
}

/** Read the raw stream without allowing request.json() to buffer an unbounded body. */
export async function readWebhookBody(request: Pick<Request, 'body' | 'headers'>, signal: AbortSignal): Promise<NumenValue> {
  const length = request.headers.get('content-length')
  if (length && /^\d+$/.test(length) && Number(length) > webhookRequestLimits.maxBytes) {
    throw new WebhookRequestError(413, 'WEBHOOK_BODY_TOO_LARGE', 'The request body exceeds 1 MiB.')
  }
  const reader = request.body?.getReader()
  if (!reader) throw new WebhookRequestError(400, 'WEBHOOK_JSON_INVALID', 'The request body must contain valid plain JSON.')
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort: (() => void) | undefined
  const interrupted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new WebhookRequestError(503, 'WEBHOOK_UNAVAILABLE', 'The webhook subscription is no longer available.'))
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
    timer = setTimeout(() => reject(new WebhookRequestError(408, 'WEBHOOK_BODY_TIMEOUT', 'The request body was not received within 30 seconds.')), webhookRequestLimits.timeoutMs)
    timer.unref?.()
  })
  try {
    const consume = async () => {
      let bytes = new Uint8Array(16 * 1024)
      let size = 0
      while (true) {
        const result = await reader.read()
        if (result.done) return bytes.subarray(0, size)
        const nextSize = size + result.value.byteLength
        if (nextSize > webhookRequestLimits.maxBytes) {
          throw new WebhookRequestError(413, 'WEBHOOK_BODY_TOO_LARGE', 'The request body exceeds 1 MiB.')
        }
        if (nextSize > bytes.byteLength) {
          const expanded = new Uint8Array(Math.min(webhookRequestLimits.maxBytes, Math.max(nextSize, bytes.byteLength * 2)))
          expanded.set(bytes.subarray(0, size))
          bytes = expanded
        }
        bytes.set(result.value, size)
        size = nextSize
      }
    }
    // One race for the entire read prevents tiny chunks from accumulating one
    // pending abort reaction per chunk for the lifetime of the request.
    const bytes = await Promise.race([consume(), interrupted])
    // Check again when an abort and the final chunk arrive in the same turn.
    if (signal.aborted) throw new WebhookRequestError(503, 'WEBHOOK_UNAVAILABLE', 'The webhook subscription is no longer available.')
    try {
      return parsePlainJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    } catch {
      // Never return JSON parser excerpts, body contents, or reserved Resource IDs.
      throw new WebhookRequestError(400, 'WEBHOOK_JSON_INVALID', 'The request body must contain valid plain JSON within the depth and array limits, without reserved resource values.')
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (abort) signal.removeEventListener('abort', abort)
    // Canceling the Node-backed stream here can destroy the socket before the
    // HTTP error is written. The handler closes failed requests after responding.
    reader.releaseLock()
  }
}
