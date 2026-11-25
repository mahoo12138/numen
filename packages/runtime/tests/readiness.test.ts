import Server from '@cordisjs/plugin-server'
import { Context } from 'cordis'
import { describe, expect, it } from 'vitest'
import { readinessPlugin, type ReadinessDocument } from '../src/health.js'

describe('Readiness diagnostics', () => {
  it('reports each missing dependency instead of removing the route', async () => {
    const root = new Context()
    await root.plugin(Server, { host: '127.0.0.1', port: 0 })
    await root.plugin(readinessPlugin)

    const response = await fetch(`${root.server.baseUrl}/api/ready`)
    const document = await response.json() as ReadinessDocument

    expect(response.status).toBe(503)
    expect(document.status).toBe('not_ready')
    expect(document.checks.database.ready).toBe(false)
    expect(document.checks.capabilities.ready).toBe(false)
    expect(document.checks.connections).toEqual({
      ready: false, total: 0, enabled: 0, unavailable: 0, starting: 0, runtimeReady: 0, errors: 0,
    })
    expect(document.checks.credentials).toEqual({
      ready: false, encryptionConfigured: false, count: 0, unavailableTypes: 0,
    })
    expect(document.checks.resources).toEqual({
      ready: false, staged: 0, committed: 0, deleting: 0, gone: 0, activeLeases: 0,
    })
    expect(document.checks.automations).toEqual({ ready: false, count: 0 })
    expect(document.checks.scheduler).toEqual({
      ready: false, queuedRuns: 0, runnableExecutions: 0, waitingExecutions: 0, blockedExecutions: 0,
    })
    expect(document.checks.triggers).toEqual({
      ready: false, desiredSubscriptions: 0, activeSubscriptions: 0, unavailableSubscriptions: 0,
    })

    await root.fiber.dispose()
  })
})
