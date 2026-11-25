import type { ConsoleProcedureRef } from '@numenjs/console'

export type WorkbenchRunStatus =
  | 'QUEUED'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLING'
  | 'CANCELLED'

export interface WorkbenchHomeRun {
  id: string
  automationId: string
  automationName: string
  status: WorkbenchRunStatus
  createdAt: string
  finishedAt?: string
}

export const workbenchHomeOverviewQueryRef = {
  id: 'numen:home-overview',
  version: 1,
} as const satisfies ConsoleProcedureRef

export interface WorkbenchHomeAutomation {
  id: string
  name: string
  enabled: boolean
  updatedAt: string
}

export interface WorkbenchHomeOverview {
  automations: {
    total: number
    enabled: number
    recent: WorkbenchHomeAutomation[]
  }
  runs: {
    queued: number
    active: number
    recent: WorkbenchHomeRun[]
  }
  connections: {
    ready: boolean
    total: number
    enabled: number
    runtimeReady: number
    unavailable: number
    errors: number
  }
}

export const workbenchInvalidationSubscriptionRef = {
  id: 'numen:workbench-invalidation',
  version: 1,
} as const satisfies ConsoleProcedureRef

export type WorkbenchInvalidationScope = 'home' | 'automations' | 'automationCatalog' | 'runs' | 'connections' | 'credentials' | 'plugins'

export interface WorkbenchInvalidationEvent {
  scopes: WorkbenchInvalidationScope[]
}
