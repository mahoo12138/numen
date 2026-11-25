import { createHmac, timingSafeEqual } from 'node:crypto'

export interface GithubWebhookAuthRuntime {
  verify(body: Uint8Array, signature: string): boolean
}

export const githubSignaturePattern = /^sha256=[0-9a-fA-F]{64}$/

/** Keep the secret inside the Connection runtime, never in emitted events. */
export function createGithubWebhookAuth(secret: string, signal: AbortSignal) {
  const key = Buffer.from(secret, 'utf8')
  let closed = false
  return {
    value: {
      verify(body: Uint8Array, signature: string): boolean {
        if (closed || signal.aborted || !githubSignaturePattern.test(signature)) return false
        const expected = createHmac('sha256', key).update(body).digest()
        return timingSafeEqual(expected, Buffer.from(signature.slice(7), 'hex'))
      },
    } satisfies GithubWebhookAuthRuntime,
    close() { closed = true; key.fill(0) },
  }
}
