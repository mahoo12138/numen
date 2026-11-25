import type { Context } from 'cordis'

export interface HealthDocument {
  status: 'ok'
  name: 'numen'
  version: string
  uptimeSeconds: number
}

export interface ReadinessDocument {
  status: 'ready' | 'not_ready'
  checks: {
    database: {
      ready: boolean
      migrationVersion?: number
    }
    capabilities: {
      ready: boolean
      definitions: number
      providers: number
    }
    connections: {
      ready: boolean
      total: number
      enabled: number
      unavailable: number
      starting: number
      runtimeReady: number
      errors: number
    }
    credentials: {
      ready: boolean
      encryptionConfigured: boolean
      count: number
      unavailableTypes: number
    }
    resources: {
      ready: boolean
      staged: number
      committed: number
      deleting: number
      gone: number
      activeLeases: number
    }
    automations: {
      ready: boolean
      count: number
    }
    scheduler: {
      ready: boolean
      queuedRuns: number
      runnableExecutions: number
      waitingExecutions: number
      blockedExecutions: number
    }
    triggers: {
      ready: boolean
      desiredSubscriptions: number
      activeSubscriptions: number
      unavailableSubscriptions: number
    }
  }
}

export function healthPlugin(ctx: Context): void {
  ctx.server.get('/api/health', async (_request, response) => {
    response.json({
      status: 'ok',
      name: 'numen',
      version: '0.1.0',
      uptimeSeconds: Math.floor(process.uptime()),
    } satisfies HealthDocument)
  })

}

healthPlugin.inject = ['server']

export function readinessPlugin(ctx: Context): void {
  ctx.server.get('/api/ready', async (_request, response) => {
    const database = optionalService(() => ctx.get('database'))
    let databaseReady = false
    let migrationVersion: number | undefined
    if (database) {
      try {
        const health = database.health()
        databaseReady = health.ready
        migrationVersion = health.migrationVersion
      } catch {
        databaseReady = false
      }
    }

    const capabilities = optionalService(() => ctx.get('capabilities'))
    let statuses: ReturnType<Context['capabilities']['list']> = []
    try {
      statuses = capabilities?.list() ?? []
    } catch {
      statuses = []
    }
    const capabilitiesReady = !!capabilities
    const connections = optionalService(() => ctx.get('connections'))
    const credentials = optionalService(() => ctx.get('credentials'))
    const resources = optionalService(() => ctx.get('resources'))
    const automations = optionalService(() => ctx.get('automations'))
    const scheduler = optionalService(() => ctx.get('scheduler'))
    const triggers = optionalService(() => ctx.get('triggers'))
    const document: ReadinessDocument = {
      status: 'not_ready',
      checks: {
        database: {
          ready: databaseReady,
          ...(migrationVersion === undefined ? {} : { migrationVersion }),
        },
        capabilities: {
          ready: capabilitiesReady,
          definitions: statuses.length,
          providers: statuses.filter(status => status.providerAvailable).length,
        },
        connections: connections ? connections.health() : missingConnections(),
        credentials: credentials ? credentials.health() : missingCredentials(),
        resources: resources ? resources.health() : missingResources(),
        automations: automations
          ? { ready: true, count: automations.count() }
          : { ready: false, count: 0 },
        scheduler: scheduler ? scheduler.health() : missingScheduler(),
        triggers: triggers ? triggers.health() : missingTriggers(),
      },
    }
    // A missing dependency must stay visible in the document instead of
    // removing the route, so a failing probe says *which* service is
    // unavailable rather than returning an empty 404. With every service
    // present, readiness keeps its original database + capabilities rule.
    const servicesPresent = !!(connections && credentials && resources && automations && scheduler && triggers)
    document.status = databaseReady && capabilitiesReady && servicesPresent ? 'ready' : 'not_ready'
    response.status = document.status === 'ready' ? 200 : 503
    response.json(document)
  })
}

function optionalService<T>(resolve: () => T | undefined): T | undefined {
  try {
    return resolve()
  } catch {
    return undefined
  }
}

function missingConnections(): ReadinessDocument['checks']['connections'] {
  return { ready: false, total: 0, enabled: 0, unavailable: 0, starting: 0, runtimeReady: 0, errors: 0 }
}

function missingCredentials(): ReadinessDocument['checks']['credentials'] {
  return { ready: false, encryptionConfigured: false, count: 0, unavailableTypes: 0 }
}

function missingResources(): ReadinessDocument['checks']['resources'] {
  return { ready: false, staged: 0, committed: 0, deleting: 0, gone: 0, activeLeases: 0 }
}

function missingScheduler(): ReadinessDocument['checks']['scheduler'] {
  return { ready: false, queuedRuns: 0, runnableExecutions: 0, waitingExecutions: 0, blockedExecutions: 0 }
}

function missingTriggers(): ReadinessDocument['checks']['triggers'] {
  return { ready: false, desiredSubscriptions: 0, activeSubscriptions: 0, unavailableSubscriptions: 0 }
}

readinessPlugin.inject = ['server']
