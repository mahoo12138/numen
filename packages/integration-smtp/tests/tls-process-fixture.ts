import assert from 'node:assert/strict'
import { createSmtpRuntime } from '../src/runtime.js'
import { startSmtpFixture } from './fixture.js'

// This runs outside Vitest's process so native TLS teardown regressions are observable.
for (let index = 0; index < 12; index += 1) {
  const server = await startSmtpFixture({ tls: index % 2 ? 'starttls' : 'tls' })
  const { caPem: _ca, ...config } = server.config
  const runtime = createSmtpRuntime(config, server.credential, new AbortController().signal,
    { sendTimeoutMs: 2_000, maxConcurrency: 1, maxPending: 0 })
  try {
    await assert.rejects(runtime.value.send({ to: ['recipient@example.test'], subject: 'TLS', text: 'Test' },
      new AbortController().signal), { code: 'SMTP_TLS_FAILED', outcome: 'not-submitted' })
    assert.equal(server.authCount, 0)
  } finally {
    runtime.close()
    await server.close()
  }
}
console.log('TLS rejection and shutdown completed: 12')
