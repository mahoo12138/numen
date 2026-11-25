import type { Context } from 'cordis'
import type {} from '@numenjs/http'
import { createHmac } from 'node:crypto'
import { withLogSecrets } from '@numenjs/logging'

export const feishuLimits = { maxRequestBytes: 20 * 1024, maxResponseBytes: 64 * 1024 } as const
export interface FeishuSendTextInput { text: string }
export interface FeishuSendTextOutput { accepted: true }
export interface FeishuBotRuntime { sendText(input: FeishuSendTextInput, signal: AbortSignal): Promise<FeishuSendTextOutput> }
export interface FeishuIntegrationConfig { timeoutMs?: number }
export type FeishuErrorCode = 'FEISHU_CREDENTIAL_INVALID' | 'FEISHU_UNAVAILABLE' | 'FEISHU_TEXT_INVALID'
  | 'FEISHU_REQUEST_TOO_LARGE' | 'FEISHU_RESPONSE_INVALID' | 'FEISHU_RESPONSE_TOO_LARGE'
  | 'FEISHU_RATE_LIMITED' | 'FEISHU_REJECTED' | 'FEISHU_HTTP_ERROR' | 'FEISHU_NETWORK_ERROR'
  | 'FEISHU_CANCELLED' | 'FEISHU_TIMEOUT'

/** Remote messages, URLs and transport causes may contain secrets. Never retain them. */
export class FeishuError extends Error {
  override name = 'FeishuError'
  constructor(public readonly code: FeishuErrorCode, public readonly remoteCode?: number) {
    super(`[${code}] Feishu text submission ${code === 'FEISHU_RATE_LIMITED' ? 'was rate limited' : 'failed'}.`)
  }
}

export function validateFeishuCredential(value: Record<string, unknown>): { webhookUrl: string; secret?: string } {
  if (typeof value.webhookUrl !== 'string' || !/^https:\/\/open\.feishu\.cn\/open-apis\/bot\/v2\/hook\/[A-Za-z0-9_-]{1,128}$/.test(value.webhookUrl)
    || (value.secret !== undefined && (typeof value.secret !== 'string' || !value.secret || value.secret.length > 4096))) {
    throw new FeishuError('FEISHU_CREDENTIAL_INVALID')
  }
  return { webhookUrl: value.webhookUrl, ...(value.secret === undefined ? {} : { secret: value.secret as string }) }
}

export function validateFeishuTimeout(config: FeishuIntegrationConfig): number {
  const timeoutMs = config.timeoutMs ?? 30_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw new TypeError('Feishu timeoutMs must be an integer between 1 and 300000.')
  return timeoutMs
}

function encodeMessage(input: FeishuSendTextInput, secret?: string): string {
  if (typeof input.text !== 'string' || !input.text.trim()) throw new FeishuError('FEISHU_TEXT_INVALID')
  // Avoid allocating a large encoded copy for an already oversized input.
  if (Buffer.byteLength(input.text) > feishuLimits.maxRequestBytes) throw new FeishuError('FEISHU_REQUEST_TOO_LARGE')
  const timestamp = String(Math.floor(Date.now() / 1000))
  const data = JSON.stringify({ msg_type: 'text', content: { text: input.text }, ...(secret ? {
    timestamp, sign: createHmac('sha256', `${timestamp}\n${secret}`).update('').digest('base64'),
  } : {}) })
  if (Buffer.byteLength(data) > feishuLimits.maxRequestBytes) throw new FeishuError('FEISHU_REQUEST_TOO_LARGE')
  return data
}

async function readResponse(response: Response, signal: AbortSignal): Promise<unknown> {
  const length = response.headers.get('content-length')
  if (length && /^\d+$/.test(length) && Number(length) > feishuLimits.maxResponseBytes) {
    await response.body?.cancel()
    throw new FeishuError('FEISHU_RESPONSE_TOO_LARGE')
  }
  const reader = response.body?.getReader()
  if (!reader) throw new FeishuError('FEISHU_RESPONSE_INVALID')
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      signal.throwIfAborted()
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > feishuLimits.maxResponseBytes) {
        await reader.cancel()
        throw new FeishuError('FEISHU_RESPONSE_TOO_LARGE')
      }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) }
  catch { throw new FeishuError('FEISHU_RESPONSE_INVALID') }
}

export function createFeishuRuntime(ctx: Context, value: Record<string, unknown>, lifetime: AbortSignal, timeoutMs: number) {
  let credential = validateFeishuCredential(value)
  let closed = false
  const active = new Set<AbortController>()
  const close = () => {
    closed = true
    for (const controller of active) controller.abort(new FeishuError('FEISHU_UNAVAILABLE'))
    credential = { webhookUrl: '' }
    lifetime.removeEventListener('abort', close)
  }
  if (lifetime.aborted) throw new FeishuError('FEISHU_UNAVAILABLE')
  lifetime.addEventListener('abort', close, { once: true })
  return {
    value: { async sendText(input, signal) {
      if (closed || lifetime.aborted) throw new FeishuError('FEISHU_UNAVAILABLE')
      if (signal.aborted) throw new FeishuError('FEISHU_CANCELLED')
      const data = encodeMessage(input, credential.secret)
      const controller = new AbortController()
      active.add(controller)
      const abort = () => controller.abort(new FeishuError('FEISHU_CANCELLED'))
      signal.addEventListener('abort', abort, { once: true })
      const timer = setTimeout(() => controller.abort(new FeishuError('FEISHU_TIMEOUT')), timeoutMs)
      timer.unref()
      try {
        const response = await withLogSecrets([credential.webhookUrl, credential.webhookUrl.split('/').at(-1), credential.secret], () => ctx.http(credential.webhookUrl, {
          method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' }, data,
          // Redirects must never forward the private webhook path or signed message.
          redirect: 'manual', timeout: timeoutMs, signal: controller.signal,
        }))
        if (!response.ok) {
          await response.body?.cancel()
          throw new FeishuError(response.status === 429 ? 'FEISHU_RATE_LIMITED' : 'FEISHU_HTTP_ERROR')
        }
        const result = await readResponse(response, controller.signal)
        controller.signal.throwIfAborted()
        if (!result || typeof result !== 'object' || Array.isArray(result)
          || !Object.hasOwn(result, 'code') || !Number.isSafeInteger((result as { code: unknown }).code)) throw new FeishuError('FEISHU_RESPONSE_INVALID')
        const code = (result as { code: number }).code
        if (code !== 0) throw new FeishuError(code === 11232 ? 'FEISHU_RATE_LIMITED' : 'FEISHU_REJECTED', code)
        return { accepted: true }
      } catch (error) {
        if (controller.signal.aborted) throw controller.signal.reason
        if (error instanceof FeishuError) throw error
        throw new FeishuError('FEISHU_NETWORK_ERROR')
      } finally {
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        active.delete(controller)
      }
    } } satisfies FeishuBotRuntime,
    close,
  }
}
