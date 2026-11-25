import type { ConsoleProcedureRef } from '@numenjs/console'
import type { AttemptStatus, CancellationReason, ExecutionStatus, NumenValue } from '@numenjs/core'
import type { WorkbenchHomeRun, WorkbenchRunStatus } from './home.js'

export const workbenchRunsIndexQueryRef = {
  id: 'numen:runs-index',
  version: 1,
} as const satisfies ConsoleProcedureRef

export type WorkbenchRunsCursor = string

export interface WorkbenchRunsQueryInput {
  automationId?: string
  status?: WorkbenchRunStatus
  limit: number
  cursor?: WorkbenchRunsCursor
}

export interface WorkbenchRunIndexItem extends WorkbenchHomeRun {
  revisionId: string
  snapshotPurpose?: 'published' | 'draft-test'
  sourceDraftVersion?: number
  startedAt?: string
  executionCount: number
  attemptCount: number
}

export interface WorkbenchRunsIndex {
  summary: {
    total: number
    queued: number
    active: number
    completed: number
    failed: number
    cancelled: number
  }
  items: WorkbenchRunIndexItem[]
  nextCursor?: WorkbenchRunsCursor
}

export const workbenchRunDetailQueryRef = {
  id: 'numen:run-detail',
  version: 1,
} as const satisfies ConsoleProcedureRef

export interface WorkbenchRunDetailQueryInput {
  runId: string
  /** Filter Execution diagnostics without changing the Flow overview. */
  sourceNodeId?: string
  /** Explicitly point-read a Source node in the immutable Flow. */
  flowNodeId?: string
  executionId?: string
  executionLimit: number
  executionCursor?: string
  eventLimit: number
  eventCursor?: number
}

export type WorkbenchRunFlowStatus =
  | 'IDLE'
  | 'PENDING'
  | 'SKIPPED'
  | 'QUEUED'
  | 'RUNNING'
  | 'WAITING'
  | 'BLOCKED'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLING'
  | 'CANCELLED'

export interface WorkbenchRunFlowNode {
  id: string
  type: 'extension' | 'block' | 'capability' | 'if' | 'wait' | 'parallel' | 'race' | 'foreach' | 'graph' | 'condition' | 'merge'
  title: string
  detail: string
  status: WorkbenchRunFlowStatus
  executionCount: number
  sampledExecutionCount?: number
  children: WorkbenchRunFlowNode[]
  blockedReason?: string
  /** Graph members are unordered. Edges, including ports, carry the actual control topology. */
  graph?: {
    nodes: WorkbenchRunFlowNode[]
    edges: Array<{ id: string; from: { nodeId: string; port: string }; to: { nodeId: string; port: string } }>
  }
}

export interface WorkbenchRunContextGroup {
  name: 'run' | 'trigger' | 'input' | 'steps' | 'vars' | 'loop' | 'error'
  value: NumenValue
  truncated: boolean
}

export interface WorkbenchRunExecutionAttempt {
  id: string
  number: number
  status: AttemptStatus
  providerRef: string
  errorSummary?: string
  startedAt: string
  finishedAt?: string
}

export interface WorkbenchRunExecution {
  id: string
  instructionId: string
  sourceNodeId?: string
  /** Present when a frozen sample supplied this result without a Provider invocation. */
  sampleId?: string
  title: string
  operation: string
  status: ExecutionStatus
  parentExecutionId?: string
  scopeExecutionId?: string
  scopeBranch?: number
  loopIndex?: number
  blockedReason?: string
  generation: number
  createdAt: string
  updatedAt: string
  attempts: WorkbenchRunExecutionAttempt[]
}

export interface WorkbenchRunTimelineEvent {
  sequence: number
  type: string
  title: string
  detail?: string
  executionId?: string
  attemptId?: string
  occurredAt: string
}

export interface WorkbenchRunDetail {
  run: {
    id: string
    automationId: string
    automationName: string
    revisionId: string
    revisionNumber?: number
    snapshotPurpose?: 'published' | 'draft-test'
    sourceDraftVersion?: number
    status: WorkbenchRunStatus
    groupKey?: string
    cancelReason?: CancellationReason
    createdAt: string
    startedAt?: string
    finishedAt?: string
  }
  executionSummary: {
    total: number
    attempts: number
    runnable: number
    running: number
    waiting: number
    blocked: number
    completed: number
    failed: number
    cancelling: number
    cancelled: number
    timedOut: number
  }
  flow: {
    root: WorkbenchRunFlowNode
    truncated: boolean
    focusedNodeId?: string
  }
  context: WorkbenchRunContextGroup[]
  executions: WorkbenchRunExecution[]
  nextExecutionCursor?: string
  timeline: {
    total: number
    items: WorkbenchRunTimelineEvent[]
    nextCursor?: number
  }
}

export const workbenchCancelRunActionRef = {
  id: 'numen:run-cancel',
  version: 1,
} as const satisfies ConsoleProcedureRef

export interface WorkbenchCancelRunInput {
  runId: string
}

export interface WorkbenchCancelRunResult {
  runId: string
  status: WorkbenchRunStatus
  cancelReason?: CancellationReason
  finishedAt?: string
}
