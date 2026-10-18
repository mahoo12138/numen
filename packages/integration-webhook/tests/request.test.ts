import { afterEach, describe, expect, it, vi } from 'vitest'
import { readWebhookBody, webhookRequestLimits } from '../src/request.js'

afterEach(() => vi.useRealTimers())

describe('Webhook bounded body reader', () => {
  it('times out a stalled stream after 30 seconds and releases its reader and timer', async () => {
    vi.useFakeTimers()
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('{"waiting":')) } })
    const result = readWebhookBody({ body, headers: new Headers() }, new AbortController().signal)
    const rejected = expect(result).rejects.toMatchObject({ status: 408, code: 'WEBHOOK_BODY_TIMEOUT' })
    await vi.advanceTimersByTimeAsync(webhookRequestLimits.timeoutMs)
    await rejected
    expect(body.locked).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    await body.cancel()
  })

  it('aborts pending reads on subscription changes without returning buffered partial JSON', async () => {
    const controller = new AbortController()
    const body = new ReadableStream<Uint8Array>()
    const result = readWebhookBody({ body, headers: new Headers() }, controller.signal)
    controller.abort()
    await expect(result).rejects.toMatchObject({ status: 503, code: 'WEBHOOK_UNAVAILABLE' })
    expect(body.locked).toBe(false)
    await body.cancel()
  })

  it('checks declared length before acquiring a reader and accepts exactly 1 MiB', async () => {
    const body = new ReadableStream<Uint8Array>()
    await expect(readWebhookBody({ body, headers: new Headers({ 'content-length': String(webhookRequestLimits.maxBytes + 1) }) }, new AbortController().signal))
      .rejects.toMatchObject({ status: 413 })
    expect(body.locked).toBe(false)
    await body.cancel()
    const text = JSON.stringify('x'.repeat(webhookRequestLimits.maxBytes - 2))
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(text)); controller.close() } })
    await expect(readWebhookBody({ body: stream, headers: new Headers() }, new AbortController().signal)).resolves.toHaveLength(webhookRequestLimits.maxBytes - 2)
  })
})
