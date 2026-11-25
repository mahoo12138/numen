import type { Context } from 'cordis'
import type { Http } from '@numenjs/http'
import { withLogSecrets } from '@numenjs/logging'

export const githubApiLimits = { maxRequestBytes: 256 * 1024, maxResponseBytes: 1024 * 1024, maxBodyCharacters: 65536, timeoutMs: 30_000 } as const
export const githubApiVersion = '2026-03-10'
export const githubOwnerPattern = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/
export const githubRepoPattern = /^(?!\.{1,2}$)[A-Za-z0-9_.-]{1,100}$/
export const githubTokenPattern = /^[A-Za-z0-9_]{4,4096}$/

export interface GithubRepositoryInput { owner: string; repo: string }
export interface GithubIssueGetInput extends GithubRepositoryInput { issueNumber: number }
export interface GithubIssueCreateInput extends GithubRepositoryInput { title: string; body?: string }
export interface GithubIssueCommentInput extends GithubIssueGetInput { body: string }
export interface GithubIssueOutput { id: number; number: number; title: string; body: string; state: 'open' | 'closed'; url: string }
export interface GithubCommentOutput { id: number; body: string; url: string }
export interface GithubApiRuntime {
  getIssue(input: GithubIssueGetInput, signal: AbortSignal): Promise<GithubIssueOutput>
  createIssue(input: GithubIssueCreateInput, signal: AbortSignal): Promise<GithubIssueOutput>
  commentOnIssue(input: GithubIssueCommentInput, signal: AbortSignal): Promise<GithubCommentOutput>
}
export type GithubApiErrorCode = 'GITHUB_API_CREDENTIAL_INVALID' | 'GITHUB_API_UNAVAILABLE' | 'GITHUB_API_INPUT_INVALID'
  | 'GITHUB_API_REQUEST_TOO_LARGE' | 'GITHUB_API_RESPONSE_INVALID' | 'GITHUB_API_RESPONSE_TOO_LARGE'
  | 'GITHUB_API_RATE_LIMITED' | 'GITHUB_API_HTTP_ERROR' | 'GITHUB_API_NETWORK_ERROR' | 'GITHUB_API_CANCELLED' | 'GITHUB_API_TIMEOUT'
export interface GithubApiErrorMetadata { status?: number; retryAfterSeconds?: number; rateLimitRemaining?: number; rateLimitReset?: number }

/** Only validated numeric metadata is retained; remote messages and transport causes can contain secrets. */
export class GithubApiError extends Error {
  override name = 'GithubApiError'
  readonly status?: number
  readonly retryAfterSeconds?: number
  readonly rateLimitRemaining?: number
  readonly rateLimitReset?: number
  constructor(public readonly code: GithubApiErrorCode, metadata: GithubApiErrorMetadata = {}) {
    const details = Object.entries(metadata).map(([name, value]) => `${name}=${value}`).join(', ')
    super(`[${code}] GitHub API request failed${details ? ` (${details})` : ''}.`)
    Object.assign(this, metadata)
  }
}

function repositoryPath(input: GithubRepositoryInput): string {
  if (typeof input?.owner !== 'string' || !githubOwnerPattern.test(input.owner)
    || typeof input.repo !== 'string' || !githubRepoPattern.test(input.repo)) throw new GithubApiError('GITHUB_API_INPUT_INVALID')
  return `/repos/${input.owner}/${input.repo}/issues`
}
function issuePath(input: GithubIssueGetInput): string {
  const path = repositoryPath(input)
  if (!Number.isSafeInteger(input.issueNumber) || input.issueNumber < 1) throw new GithubApiError('GITHUB_API_INPUT_INVALID')
  return `${path}/${input.issueNumber}`
}
function bodyText(value: unknown, required = false): void {
  if (value === undefined && !required) return
  if (typeof value !== 'string' || value.length > githubApiLimits.maxBodyCharacters || (required && !value.trim())) throw new GithubApiError('GITHUB_API_INPUT_INVALID')
}
function encoded(data: object): string {
  const value = JSON.stringify(data)
  if (Buffer.byteLength(value) > githubApiLimits.maxRequestBytes) throw new GithubApiError('GITHUB_API_REQUEST_TOO_LARGE')
  return value
}
function metadata(response: Response): GithubApiErrorMetadata {
  const result: GithubApiErrorMetadata = { status: response.status }
  for (const [header, field] of [['retry-after', 'retryAfterSeconds'], ['x-ratelimit-remaining', 'rateLimitRemaining'], ['x-ratelimit-reset', 'rateLimitReset']] as const) {
    const value = response.headers.get(header)
    if (value !== null && /^\d{1,16}$/.test(value) && Number.isSafeInteger(Number(value))) result[field] = Number(value)
  }
  return result
}

async function readResponse(response: Response, signal: AbortSignal): Promise<Record<string, unknown>> {
  const length = response.headers.get('content-length')
  if (length && /^\d+$/.test(length) && Number(length) > githubApiLimits.maxResponseBytes) {
    await response.body?.cancel()
    throw new GithubApiError('GITHUB_API_RESPONSE_TOO_LARGE')
  }
  const reader = response.body?.getReader()
  if (!reader) throw new GithubApiError('GITHUB_API_RESPONSE_INVALID')
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      signal.throwIfAborted()
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > githubApiLimits.maxResponseBytes) {
        await reader.cancel()
        throw new GithubApiError('GITHUB_API_RESPONSE_TOO_LARGE')
      }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
    return value as Record<string, unknown>
  } catch { throw new GithubApiError('GITHUB_API_RESPONSE_INVALID') }
}
function positiveInteger(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 }
function projectComment(value: Record<string, unknown>): GithubCommentOutput {
  if (!positiveInteger(value.id) || (value.body !== null && typeof value.body !== 'string') || typeof value.html_url !== 'string') throw new GithubApiError('GITHUB_API_RESPONSE_INVALID')
  let url: URL
  try { url = new URL(value.html_url) } catch { throw new GithubApiError('GITHUB_API_RESPONSE_INVALID') }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || url.port) throw new GithubApiError('GITHUB_API_RESPONSE_INVALID')
  return { id: value.id, body: value.body ?? '', url: value.html_url }
}
function projectIssue(value: Record<string, unknown>): GithubIssueOutput {
  const base = projectComment(value)
  if (!positiveInteger(value.number) || typeof value.title !== 'string' || !['open', 'closed'].includes(value.state as string)) throw new GithubApiError('GITHUB_API_RESPONSE_INVALID')
  return { ...base, number: value.number, title: value.title, state: value.state as 'open' | 'closed' }
}

export function createGithubApiRuntime(ctx: Context, value: Record<string, unknown>, lifetime: AbortSignal, timeoutMs: number = githubApiLimits.timeoutMs) {
  if (typeof value.token !== 'string' || !githubTokenPattern.test(value.token)) throw new GithubApiError('GITHUB_API_CREDENTIAL_INVALID')
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw new TypeError('GitHub API timeout must be an integer between 1 and 300000.')
  // Keep the host's transport/proxy policy while isolating request credentials,
  // payloads and decoding defaults. extend() owns a separate config object.
  const client: Http = ctx.http.extend()
  const defaults = client.config as Http.RequestConfig
  defaults.headers = {}
  delete defaults.params
  delete defaults.data
  delete defaults.responseType
  delete defaults.validateStatus
  let token = value.token
  let closed = false
  const active = new Set<AbortController>()
  const close = () => {
    closed = true
    for (const controller of active) controller.abort(new GithubApiError('GITHUB_API_UNAVAILABLE'))
    token = ''
    lifetime.removeEventListener('abort', close)
  }
  if (lifetime.aborted) throw new GithubApiError('GITHUB_API_UNAVAILABLE')
  lifetime.addEventListener('abort', close, { once: true })
  async function request<T>(method: 'GET' | 'POST', path: string, data: string | undefined, signal: AbortSignal, project: (value: Record<string, unknown>) => T): Promise<T> {
    if (closed || lifetime.aborted) throw new GithubApiError('GITHUB_API_UNAVAILABLE')
    if (signal.aborted) throw new GithubApiError('GITHUB_API_CANCELLED')
    const controller = new AbortController()
    active.add(controller)
    const abort = () => controller.abort(new GithubApiError('GITHUB_API_CANCELLED'))
    signal.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => controller.abort(new GithubApiError('GITHUB_API_TIMEOUT')), timeoutMs)
    timer.unref()
    try {
      return await withLogSecrets([token], async () => {
        const response = await client(`https://api.github.com${path}`, {
          method, headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': githubApiVersion,
            'user-agent': 'Numen-GitHub-Integration', ...(data === undefined ? {} : { 'content-type': 'application/json; charset=utf-8' }) },
          data, params: {}, signal: controller.signal, timeout: 0, validateStatus: () => true,
          // Even repository-rename redirects require the user to update owner/repo.
          redirect: 'manual',
        })
        const info = metadata(response)
        if (response.status !== (method === 'GET' ? 200 : 201)) {
          await response.body?.cancel()
          const limited = response.status === 429 || (response.status === 403 && (info.rateLimitRemaining === 0 || info.retryAfterSeconds !== undefined))
          throw new GithubApiError(limited ? 'GITHUB_API_RATE_LIMITED' : 'GITHUB_API_HTTP_ERROR', info)
        }
        const result = await readResponse(response, controller.signal)
        controller.signal.throwIfAborted()
        return project(result)
      })
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason
      if (error instanceof GithubApiError) throw error
      throw new GithubApiError('GITHUB_API_NETWORK_ERROR')
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      active.delete(controller)
    }
  }
  return {
    value: {
      async getIssue(input, signal) { return request('GET', issuePath(input), undefined, signal, projectIssue) },
      async createIssue(input, signal) {
        const path = repositoryPath(input)
        if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 256) throw new GithubApiError('GITHUB_API_INPUT_INVALID')
        bodyText(input.body)
        return request('POST', path, encoded({ title: input.title, ...(input.body === undefined ? {} : { body: input.body }) }), signal, projectIssue)
      },
      async commentOnIssue(input, signal) {
        const path = `${issuePath(input)}/comments`
        bodyText(input.body, true)
        return request('POST', path, encoded({ body: input.body }), signal, projectComment)
      },
    } satisfies GithubApiRuntime,
    close,
  }
}
