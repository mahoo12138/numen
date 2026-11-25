import type { Attempt, Execution, Run, RunEvent } from '@numenjs/core'
import type { DatabaseService } from '@numenjs/database'
import {
  mapAttempt,
  mapEvent,
  mapExecution,
  mapRun,
  type AttemptRow,
  type EventRow,
  type ExecutionRow,
  type GraphMemberRow,
  type RunSummaryRow,
} from './rows.js'

/**
 * Read-only Scheduler queries. No method here opens a transaction: callers that
 * need a consistent snapshot wrap their own reads, and write paths continue to
 * own the transaction boundary in SchedulerService.
 */

export interface RunListCursor {
  createdAt: string
  id: string
}

export interface RunListFilters {
  automationId?: string
  status?: Run['status']
}

export interface RunSummary extends Run {
  executionCount: number
  attemptCount: number
}

export interface RunSummaryPage {
  items: RunSummary[]
  nextCursor?: RunListCursor
}

export type RunStatusCounts = Record<Run['status'], number>

export interface ExecutionListCursor {
  createdAt: string
  id: string
}

export interface RunExecutionDiagnostic {
  execution: Execution
  attempts: Attempt[]
}

export interface RunExecutionDiagnosticsPage {
  items: RunExecutionDiagnostic[]
  statusCounts: Record<Execution['status'], number>
  attemptCount: number
  nextCursor?: ExecutionListCursor
}

export interface RunEventPage {
  items: RunEvent[]
  total: number
  nextCursor?: number
}

export interface RunGraphMemberSummary {
  scopeExecutionId: string
  nodeId: string
  executionId?: string
  status: Execution['status'] | 'SKIPPED' | 'PENDING'
  blockedReason?: string
  updatedAt: string
}

export interface SchedulerCounts {
  queuedRuns: number
  runningRuns: number
  cancellingRuns: number
  runnableExecutions: number
  waitingExecutions: number
  blockedExecutions: number
}

export class RunInspectionRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db
  }

  listRuns(limit: number): Run[] {
    return (this.db.prepare(`
      SELECT * FROM runs ORDER BY created_at DESC, id DESC LIMIT ?
    `).all(limit) as Parameters<typeof mapRun>[0][]).map(mapRun)
  }

  getRun(runId: string): Run | undefined {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(runId) as Parameters<typeof mapRun>[0] | undefined
    return row ? mapRun(row) : undefined
  }

  instructionExecutionCounts(runId: string): Array<{
    instruction_id: string
    status: Execution['status']
    count: number
    sampled_count: number
    latest_updated_at: string
  }> {
    return this.db.prepare(`
      SELECT instruction_id, status, COUNT(*) AS count, MAX(updated_at) AS latest_updated_at,
        SUM(CASE WHEN sample_id IS NOT NULL THEN 1 ELSE 0 END) AS sampled_count
      FROM executions WHERE run_id = ?
      GROUP BY instruction_id, status
      ORDER BY instruction_id, status
    `).all(runId) as ReturnType<RunInspectionRepository['instructionExecutionCounts']>
  }

  listRunSummariesPage(limit: number, cursor: RunListCursor | undefined, filters: RunListFilters): RunSummaryPage {
    const conditions: string[] = []
    const parameters: Array<string | number> = []
    if (filters.automationId) { conditions.push('automation_id = ?'); parameters.push(filters.automationId) }
    if (filters.status) { conditions.push('status = ?'); parameters.push(filters.status) }
    if (cursor) { conditions.push('(created_at < ? OR (created_at = ? AND id < ?))'); parameters.push(cursor.createdAt, cursor.createdAt, cursor.id) }
    // Select the bounded page before aggregating potentially large Execution and Attempt histories.
    const rows = this.db.prepare(`
      WITH page AS (
        SELECT * FROM runs ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
        ORDER BY created_at DESC, id DESC LIMIT ?
      )
      SELECT page.*, COUNT(DISTINCT executions.id) AS execution_count,
        COUNT(attempts.id) AS attempt_count
      FROM page
      LEFT JOIN executions ON executions.run_id = page.id
      LEFT JOIN attempts ON attempts.execution_id = executions.id
      GROUP BY page.id
      ORDER BY page.created_at DESC, page.id DESC
    `).all(...parameters, limit + 1) as RunSummaryRow[]
    const hasMore = rows.length > limit
    const items = rows.slice(0, limit).map(row => ({
      ...mapRun(row),
      executionCount: row.execution_count,
      attemptCount: row.attempt_count,
    }))
    const last = items.at(-1)
    return {
      items,
      ...(hasMore && last ? { nextCursor: { createdAt: last.createdAt, id: last.id } } : {}),
    }
  }

  runStatusCounts(automationId?: string): RunStatusCounts {
    const counts: RunStatusCounts = {
      QUEUED: 0,
      RUNNING: 0,
      COMPLETED: 0,
      FAILED: 0,
      CANCELLING: 0,
      CANCELLED: 0,
    }
    const rows = this.db.prepare(`
      SELECT status, COUNT(*) AS count FROM runs ${automationId ? 'WHERE automation_id = ?' : ''} GROUP BY status
    `).all(...(automationId ? [automationId] : [])) as Array<{ status: Run['status']; count: number }>
    for (const row of rows) counts[row.status] = row.count
    return counts
  }

  runIdentity(runId: string): Pick<Run, 'id' | 'revisionId'> | undefined {
    const row = this.db.prepare('SELECT id, revision_id FROM runs WHERE id = ?').get(runId) as
      { id: string; revision_id: string } | undefined
    return row ? { id: row.id, revisionId: row.revision_id } : undefined
  }

  listExecutions(runId: string): Execution[] {
    return (this.db.prepare(`
      SELECT * FROM executions WHERE run_id = ? ORDER BY created_at, id
    `).all(runId) as ExecutionRow[]).map(mapExecution)
  }

  inspectExecution(runId: string, executionId: string, maxValueBytes: number): {
    execution: Execution; inputOmitted: boolean; outputOmitted: boolean
  } | undefined {
    const row = this.db.prepare(`
      SELECT id, run_id, instruction_id, parent_execution_id, scope_execution_id, scope_branch,
        NULL AS loop_item_json, loop_index, status, wake_at, blocked_reason, generation, sample_id, created_at, updated_at,
        CASE WHEN length(CAST(resolved_input_json AS BLOB)) <= ? THEN resolved_input_json ELSE NULL END AS resolved_input_json,
        CASE WHEN length(CAST(output_json AS BLOB)) <= ? THEN output_json ELSE NULL END AS output_json,
        length(CAST(resolved_input_json AS BLOB)) > ? AS input_omitted,
        length(CAST(output_json AS BLOB)) > ? AS output_omitted
      FROM executions WHERE run_id = ? AND id = ?
    `).get(maxValueBytes, maxValueBytes, maxValueBytes, maxValueBytes, runId, executionId) as
      (ExecutionRow & { input_omitted: number; output_omitted: number }) | undefined
    return row ? { execution: mapExecution(row), inputOmitted: !!row.input_omitted, outputOmitted: !!row.output_omitted } : undefined
  }

  getAttempt(runId: string, executionId: string, attemptId: string): Pick<Attempt, 'id' | 'executionId' | 'number' | 'status'> | undefined {
    const row = this.db.prepare(`
      SELECT attempts.id, attempts.execution_id, attempts.number, attempts.status FROM attempts JOIN executions ON executions.id = attempts.execution_id
      WHERE executions.run_id = ? AND executions.id = ? AND attempts.id = ?
    `).get(runId, executionId, attemptId) as AttemptRow | undefined
    return row ? { id: row.id, executionId: row.execution_id, number: row.number, status: row.status } : undefined
  }

  executionDiagnosticsPage(
    runId: string,
    limit: number,
    cursor?: ExecutionListCursor,
    filter: { instructionIds?: string[]; executionId?: string } = {},
  ): RunExecutionDiagnosticsPage {
    const instructionFilter = filter.instructionIds
      ? `AND instruction_id IN (${filter.instructionIds.map(() => '?').join(', ') || 'NULL'})` : ''
    const rows = this.db.prepare(`
      SELECT * FROM executions
      WHERE run_id = ?
      ${instructionFilter}
      ${filter.executionId ? 'AND id = ?' : ''}
      ${cursor ? 'AND (created_at < ? OR (created_at = ? AND id < ?))' : ''}
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(runId, ...(filter.instructionIds ?? []), ...(filter.executionId ? [filter.executionId] : []), ...(cursor
      ? [cursor.createdAt, cursor.createdAt, cursor.id, limit + 1]
      : [limit + 1])) as ExecutionRow[]
    const hasMore = rows.length > limit
    const executions = rows.slice(0, limit).map(mapExecution)
    const attemptsByExecution = new Map<string, Attempt[]>()
    if (executions.length) {
      const placeholders = executions.map(() => '?').join(', ')
      const attempts = (this.db.prepare(`
        SELECT * FROM attempts
        WHERE execution_id IN (${placeholders})
        ORDER BY execution_id, number
      `).all(...executions.map(execution => execution.id)) as AttemptRow[]).map(mapAttempt)
      for (const attempt of attempts) {
        const items = attemptsByExecution.get(attempt.executionId) ?? []
        items.push(attempt)
        attemptsByExecution.set(attempt.executionId, items)
      }
    }
    const statusCounts: Record<Execution['status'], number> = {
      RUNNABLE: 0,
      RUNNING: 0,
      WAITING: 0,
      BLOCKED: 0,
      COMPLETED: 0,
      FAILED: 0,
      CANCELLING: 0,
      CANCELLED: 0,
      TIMED_OUT: 0,
    }
    const statusRows = this.db.prepare(`
      SELECT status, COUNT(*) AS count FROM executions WHERE run_id = ? GROUP BY status
    `).all(runId) as Array<{ status: Execution['status']; count: number }>
    for (const row of statusRows) statusCounts[row.status] = row.count
    const attemptCount = (this.db.prepare(`
      SELECT COUNT(*) AS count FROM attempts
      JOIN executions ON executions.id = attempts.execution_id
      WHERE executions.run_id = ?
    `).get(runId) as { count: number }).count
    const last = executions.at(-1)
    return {
      items: executions.map(execution => ({
        execution,
        attempts: attemptsByExecution.get(execution.id) ?? [],
      })),
      statusCounts,
      attemptCount,
      ...(hasMore && last ? { nextCursor: { createdAt: last.createdAt, id: last.id } } : {}),
    }
  }

  listAttempts(runId: string): Attempt[] {
    return (this.db.prepare(`
      SELECT attempts.* FROM attempts
      JOIN executions ON executions.id = attempts.execution_id
      WHERE executions.run_id = ? ORDER BY executions.created_at, attempts.number
    `).all(runId) as AttemptRow[]).map(mapAttempt)
  }

  listEvents(runId: string): RunEvent[] {
    return (this.db.prepare(`
      SELECT * FROM run_events WHERE run_id = ? ORDER BY sequence
    `).all(runId) as EventRow[]).map(mapEvent)
  }

  runEventsPage(runId: string, limit: number, beforeSequence?: number): RunEventPage {
    const rows = this.db.prepare(`
      SELECT * FROM run_events
      WHERE run_id = ? ${beforeSequence === undefined ? '' : 'AND sequence < ?'}
      ORDER BY sequence DESC
      LIMIT ?
    `).all(runId, ...(beforeSequence === undefined ? [limit + 1] : [beforeSequence, limit + 1])) as EventRow[]
    const hasMore = rows.length > limit
    const items = rows.slice(0, limit).map(mapEvent)
    const total = (this.db.prepare(`
      SELECT COUNT(*) AS count FROM run_events WHERE run_id = ?
    `).get(runId) as { count: number }).count
    const last = items.at(-1)
    return {
      items,
      total,
      ...(hasMore && last ? { nextCursor: last.sequence } : {}),
    }
  }

  listGraphMembers(runId: string): RunGraphMemberSummary[] {
    const rows = this.db.prepare(`
      SELECT members.*, child.status, child.blocked_reason,
        child.updated_at AS execution_updated_at, scope.status AS scope_status,
        scope.updated_at AS scope_updated_at
      FROM graph_members AS members
      JOIN executions AS scope ON scope.id = members.scope_execution_id
      LEFT JOIN executions AS child ON child.id = members.execution_id
      WHERE scope.run_id = ? ORDER BY scope.created_at, scope.id, members.node_id
    `).all(runId) as Array<GraphMemberRow & { execution_updated_at: string | null; scope_status: Execution['status']; scope_updated_at: string }>
    return rows.map(row => ({
      scopeExecutionId: row.scope_execution_id,
      nodeId: row.node_id,
      ...(row.execution_id ? { executionId: row.execution_id } : {}),
      status: row.skipped ? 'SKIPPED' : row.status ?? (['CANCELLED', 'FAILED', 'TIMED_OUT'].includes(row.scope_status) ? 'CANCELLED' : 'PENDING'),
      ...(row.blocked_reason ? { blockedReason: row.blocked_reason } : {}),
      updatedAt: row.execution_updated_at ?? (row.skipped ? row.updated_at : row.scope_updated_at),
    }))
  }

  counts(): SchedulerCounts {
    const count = (status: string, table = 'executions') => {
      return (this.db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE status = ?`).get(status) as { count: number }).count
    }
    return {
      queuedRuns: count('QUEUED', 'runs'),
      runningRuns: count('RUNNING', 'runs'),
      cancellingRuns: count('CANCELLING', 'runs'),
      runnableExecutions: count('RUNNABLE'),
      waitingExecutions: count('WAITING'),
      blockedExecutions: count('BLOCKED'),
    }
  }
}
