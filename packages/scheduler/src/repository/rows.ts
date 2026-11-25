import type {
  Attempt,
  CancellationReason,
  Execution,
  NumenValue,
  Run,
  RunEvent,
} from '@numenjs/core'

/**
 * Durable row shapes and their domain projections. Every Scheduler query and
 * mutation goes through these instead of re-declaring column names, so a schema
 * change has exactly one place to update.
 */

export interface RunRow {
  id: string
  automation_id: string
  revision_id: string
  status: Run['status']
  trigger_json: string
  input_json: string
  group_key: string | null
  cancel_reason: CancellationReason | null
  created_at: string
  started_at: string | null
  finished_at: string | null
}

export interface RunSummaryRow extends RunRow {
  execution_count: number
  attempt_count: number
}

export interface AdmissionRow extends RunRow {
  sequence: number
  max_active: number | null
  overflow: 'queue' | 'drop' | 'replace'
  namespace: 'formal' | 'test'
  replacement_requested: number
}

export interface ExecutionRow {
  id: string
  run_id: string
  instruction_id: string
  parent_execution_id: string | null
  scope_execution_id: string | null
  scope_branch: number | null
  loop_item_json: string | null
  loop_index: number | null
  status: Execution['status']
  resolved_input_json: string | null
  output_json: string | null
  sample_id: string | null
  wake_at: string | null
  blocked_reason: string | null
  generation: number
  created_at: string
  updated_at: string
}

export interface GraphMemberRow {
  scope_execution_id: string
  node_id: string
  execution_id: string | null
  skipped: number
  updated_at: string
  status: Execution['status'] | null
  output_json: string | null
  blocked_reason: string | null
}

export interface AttemptRow {
  id: string
  execution_id: string
  number: number
  status: Attempt['status']
  provider_ref: string
  error_json: string | null
  started_at: string
  finished_at: string | null
}

export interface EventRow {
  run_id: string
  sequence: number
  type: string
  payload_json: string
  occurred_at: string
}

export interface IterationRow {
  iterate_execution_id: string
  item_index: number
  item_json: string
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED'
  root_execution_id: string | null
  terminal_execution_id: string | null
  error_json: string | null
  created_at: string
  updated_at: string
}

export function parseJson<T>(source: string): T {
  return JSON.parse(source) as T
}

export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonicalize(object[key])}`).join(',')}}`
}

export function mapRun(row: RunRow): Run {
  return {
    id: row.id,
    automationId: row.automation_id,
    revisionId: row.revision_id,
    status: row.status,
    trigger: parseJson(row.trigger_json),
    input: parseJson(row.input_json),
    ...(row.group_key ? { groupKey: row.group_key } : {}),
    ...(row.cancel_reason ? { cancelReason: row.cancel_reason } : {}),
    createdAt: row.created_at,
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
  }
}

export function mapExecution(row: ExecutionRow): Execution {
  return {
    id: row.id,
    runId: row.run_id,
    instructionId: row.instruction_id,
    ...(row.parent_execution_id ? { parentExecutionId: row.parent_execution_id } : {}),
    ...(row.scope_execution_id ? { scopeExecutionId: row.scope_execution_id } : {}),
    ...(row.scope_branch === null ? {} : { scopeBranch: row.scope_branch }),
    ...(row.loop_item_json ? { loopItem: parseJson(row.loop_item_json) } : {}),
    ...(row.loop_index === null ? {} : { loopIndex: row.loop_index }),
    status: row.status,
    ...(row.resolved_input_json ? { resolvedInput: parseJson(row.resolved_input_json) } : {}),
    ...(row.output_json ? { output: parseJson(row.output_json) } : {}),
    ...(row.sample_id ? { sampleId: row.sample_id } : {}),
    ...(row.wake_at ? { wakeAt: row.wake_at } : {}),
    ...(row.blocked_reason ? { blockedReason: row.blocked_reason } : {}),
    generation: row.generation,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function mapAttempt(row: AttemptRow): Attempt {
  return {
    id: row.id,
    executionId: row.execution_id,
    number: row.number,
    status: row.status,
    providerRef: row.provider_ref,
    ...(row.error_json ? { error: parseJson(row.error_json) as NumenValue } : {}),
    startedAt: row.started_at,
    ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
  }
}

export function mapEvent(row: EventRow): RunEvent {
  return {
    runId: row.run_id,
    sequence: row.sequence,
    type: row.type,
    payload: parseJson(row.payload_json),
    occurredAt: row.occurred_at,
  }
}
