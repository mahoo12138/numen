import { afterEach, describe, expect, it, vi } from 'vitest'
import { createGithubWebhookAuth } from '../src/auth.js'
import { githubWebhookPath } from '../src/path.js'
import { githubRequestLimits, parseGithubBody, readGithubBody } from '../src/request.js'

afterEach(() => vi.useRealTimers())

describe('GitHub HMAC verification', () => {
  // GitHub Docs publishes this independent known-answer vector.
  const body = new TextEncoder().encode('Hello, World!')
  const signature = 'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17'

  it('matches the official SHA-256 test vector and refuses mutated bytes', () => {
    const auth = createGithubWebhookAuth("It's a Secret to Everybody", new AbortController().signal)
    expect(auth.value.verify(body, signature)).toBe(true)
    expect(auth.value.verify(body, `sha256=${signature.slice(7).toUpperCase()}`)).toBe(true)
    expect(auth.value.verify(new TextEncoder().encode('Hello, World!\n'), signature)).toBe(false)
    expect(auth.value.verify(body, 'sha256=' + '0'.repeat(64))).toBe(false)
    auth.close()
    expect(auth.value.verify(body, signature)).toBe(false)
    auth.close()
  })

  it.each(['', 'sha1=' + '0'.repeat(40), 'sha256=' + 'x'.repeat(64), 'sha256=00', 'sha256=' + '0'.repeat(66)])('rejects malformed signature %s without throwing', candidate => {
    const auth = createGithubWebhookAuth("It's a Secret to Everybody", new AbortController().signal)
    expect(auth.value.verify(body, candidate)).toBe(false)
    auth.close()
  })

  it('fences a runtime immediately when its Connection signal aborts', () => {
    const controller = new AbortController()
    const auth = createGithubWebhookAuth("It's a Secret to Everybody", controller.signal)
    controller.abort()
    expect(auth.value.verify(body, signature)).toBe(false)
    auth.close()
  })
})

describe('GitHub bounded raw body reader', () => {
  it('preserves every original byte across chunk boundaries including split UTF-8 codepoints', async () => {
    const expected = new TextEncoder().encode('{ "message": "你好 🥚" }\n')
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      for (const byte of expected) controller.enqueue(Uint8Array.of(byte))
      controller.close()
    } })
    const actual = await readGithubBody({ body, headers: new Headers() }, new AbortController().signal)
    expect(actual).toEqual(expected)
    expect(parseGithubBody(actual)).toEqual({ message: '你好 🥚' })
    expect(body.locked).toBe(false)
  })

  it('rejects a stalled stream and releases its reader and deadline timer', async () => {
    vi.useFakeTimers()
    const body = new ReadableStream<Uint8Array>()
    const result = readGithubBody({ body, headers: new Headers() }, new AbortController().signal)
    const rejected = expect(result).rejects.toMatchObject({ status: 408, code: 'GITHUB_BODY_TIMEOUT' })
    await vi.advanceTimersByTimeAsync(githubRequestLimits.timeoutMs)
    await rejected
    expect(body.locked).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    await body.cancel()
  })

  it('rejects aborts during read and before a queued final chunk can be consumed', async () => {
    for (const hasData of [false, true]) {
      const controller = new AbortController()
      const body = new ReadableStream<Uint8Array>({ start(stream) { if (hasData) { stream.enqueue(new TextEncoder().encode('{}')); stream.close() } } })
      const result = readGithubBody({ body, headers: new Headers() }, controller.signal)
      controller.abort()
      await expect(result).rejects.toMatchObject({ status: 503, code: 'GITHUB_UNAVAILABLE' })
      expect(body.locked).toBe(false)
      await body.cancel()
    }
  })

  it('checks declared length before acquiring a reader and accepts exactly one MiB', async () => {
    const body = new ReadableStream<Uint8Array>()
    await expect(readGithubBody({ body, headers: new Headers({ 'content-length': String(githubRequestLimits.maxBytes + 1) }) }, new AbortController().signal))
      .rejects.toMatchObject({ status: 413 })
    expect(body.locked).toBe(false)
    await body.cancel()
    const expected = new TextEncoder().encode('{"body":"' + 'x'.repeat(githubRequestLimits.maxBytes - 11) + '"}')
    expect(expected.byteLength).toBe(githubRequestLimits.maxBytes)
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(expected); controller.close() } })
    const received = await readGithubBody({ body: stream, headers: new Headers() }, new AbortController().signal)
    expect(received.byteLength).toBe(githubRequestLimits.maxBytes)
    expect(parseGithubBody(received).body).toHaveLength(githubRequestLimits.maxBytes - 11)
  })

  it('encodes each callback segment independently', () => {
    expect(githubWebhookPath('automation/a', 'issue opened')).toBe('/api/github/webhooks/automation%2Fa/issue%20opened')
  })
})
