import type { Request } from '@cordisjs/plugin-server'
import { isResourceRef, type NumenValue } from '@numenjs/core'
import { parsePlainJson } from '@numenjs/integration-data/json'
import { githubSignaturePattern } from './auth.js'

export const githubRequestLimits = { maxBytes: 1024 * 1024, timeoutMs: 9_000 } as const
export const githubNamePattern = /^[a-z][a-z0-9_]{0,99}$/

export class GithubRequestError extends Error {
  override name = 'GithubRequestError'

  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message)
  }
}

function headerCount(request: Request, name: string): number {
  let count = 0
  for (let index = 0; index < request._req.rawHeaders.length; index += 2) {
    if (request._req.rawHeaders[index]?.toLowerCase() === name) count += 1
  }
  return count
}

export function readGithubHeaders(request: Request): { signature: string; event: string; deliveryId: string } {
  const signature = request.headers.get('x-hub-signature-256') ?? ''
  if (headerCount(request, 'x-hub-signature-256') !== 1 || !githubSignaturePattern.test(signature)) {
    throw new GithubRequestError(401, 'GITHUB_SIGNATURE_INVALID', 'A valid GitHub SHA-256 signature is required.')
  }
  const event = request.headers.get('x-github-event') ?? ''
  const deliveryId = request.headers.get('x-github-delivery') ?? ''
  if (headerCount(request, 'x-github-event') !== 1 || !githubNamePattern.test(event)
    || headerCount(request, 'x-github-delivery') !== 1 || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(deliveryId)) {
    throw new GithubRequestError(400, 'GITHUB_HEADERS_INVALID', 'One GitHub event name and one delivery UUID are required.')
  }
  // UUID casing is insignificant; canonicalization also preserves deduplication.
  return { signature, event, deliveryId: deliveryId.toLowerCase() }
}

export function validateGithubContentType(request: Request): void {
  const encoding = request.headers.get('content-encoding')?.trim().toLowerCase()
  const [mediaType, ...parameters] = (request.headers.get('content-type') ?? '').toLowerCase().split(';').map(value => value.trim())
  if (headerCount(request, 'content-type') !== 1 || headerCount(request, 'content-encoding') > 1
    || (encoding && encoding !== 'identity') || mediaType !== 'application/json'
    || parameters.some(value => !/^charset=(?:utf-?8|"utf-?8")$/.test(value))) {
    throw new GithubRequestError(415, 'GITHUB_MEDIA_TYPE_UNSUPPORTED', 'The request must contain uncompressed UTF-8 application/json.')
  }
}

/** Buffer bounded raw bytes before HMAC validation. Never parse/re-encode first. */
export async function readGithubBody(request: Pick<Request, 'body' | 'headers'>, signal: AbortSignal): Promise<Uint8Array> {
  const length = request.headers.get('content-length')
  if (length && /^\d+$/.test(length) && Number(length) > githubRequestLimits.maxBytes) {
    throw new GithubRequestError(413, 'GITHUB_BODY_TOO_LARGE', 'The request body exceeds 1 MiB.')
  }
  const reader = request.body?.getReader()
  if (!reader) throw new GithubRequestError(400, 'GITHUB_JSON_INVALID', 'The request body must contain a JSON object.')
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort: (() => void) | undefined
  const interrupted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new GithubRequestError(503, 'GITHUB_UNAVAILABLE', 'The GitHub subscription is no longer available.'))
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
    timer = setTimeout(() => reject(new GithubRequestError(408, 'GITHUB_BODY_TIMEOUT', 'The request body was not received within 9 seconds.')), githubRequestLimits.timeoutMs)
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
        if (nextSize > githubRequestLimits.maxBytes) throw new GithubRequestError(413, 'GITHUB_BODY_TOO_LARGE', 'The request body exceeds 1 MiB.')
        if (nextSize > bytes.byteLength) {
          const expanded = new Uint8Array(Math.min(githubRequestLimits.maxBytes, Math.max(nextSize, bytes.byteLength * 2)))
          expanded.set(bytes.subarray(0, size))
          bytes = expanded
        }
        bytes.set(result.value, size)
        size = nextSize
      }
    }
    const bytes = await Promise.race([consume(), interrupted])
    if (signal.aborted) throw new GithubRequestError(503, 'GITHUB_UNAVAILABLE', 'The GitHub subscription is no longer available.')
    return bytes
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (abort) signal.removeEventListener('abort', abort)
    // Canceling the Node-backed stream could close the socket before the error
    // response is sent. The route closes failed connections after responding.
    reader.releaseLock()
  }
}

export function parseGithubBody(bytes: Uint8Array): Record<string, NumenValue> {
  try {
    const body = parsePlainJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    if (!body || typeof body !== 'object' || Array.isArray(body) || isResourceRef(body)) throw new TypeError('object required')
    // repository_dispatch uses the caller's custom event_type as action; it is
    // not limited to the lowercase identifiers used by built-in event names.
    if (Object.hasOwn(body, 'action') && (typeof body.action !== 'string' || body.action.length < 1 || body.action.length > 100)) throw new TypeError('invalid action')
    return body
  } catch {
    throw new GithubRequestError(400, 'GITHUB_JSON_INVALID', 'The request body must contain a plain JSON object within the depth and array limits, without reserved resource values; action must contain 1 to 100 characters when present.')
  }
}
