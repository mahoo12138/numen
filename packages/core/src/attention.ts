import type { Run } from './execution.js'

export type RunAttentionKind = 'FAILED' | 'OUTCOME_UNKNOWN'

export interface RunAttention {
  id: string
  sequence: number
  kind: RunAttentionKind
  runId: string
  automationId: string
  revisionId: string
  executionId?: string
  attemptId?: string
  occurredAt: string
  acknowledgedAt?: string
  /** A fixed, safe description; never contains a Provider's error or Run data. */
  summary: string
}

export interface RunAttentionNotification {
  automationId: string
  automationName: string
  triggerId: string
  runId?: string
  status: Run['status'] | 'OUTCOME_UNKNOWN' | 'PENDING' | 'SKIPPED' | 'DELETED'
  summary?: string
}

export interface RunAttentionItem extends RunAttention {
  automationName: string
  runStatus: Run['status']
  notifications: RunAttentionNotification[]
}

export interface RunAttentionFilters {
  automationId?: string
  runId?: string
  kind?: RunAttentionKind
  acknowledged?: boolean
  limit?: number
  beforeSequence?: number
}

export interface RunAttentionPage {
  items: RunAttentionItem[]
  total: number
  unacknowledged: number
  nextCursor?: number
}
