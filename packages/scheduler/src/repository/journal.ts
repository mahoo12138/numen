import type { DatabaseService } from '@numenjs/database'
import type { CancellationReason, Execution } from '@numenjs/core'
import { mapExecution, type ExecutionRow } from './rows.js'

type OutputRow = { instruction_id: string; output_json: string }

/**
 * Durable execution-state writes. Every method assumes the caller already holds
 * the immediate transaction this write belongs to: the Scheduler, not the
 * repository, decides transaction boundaries and when change events fire.
 */
export class RunJournal {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db
  }

  appendEvent(runId: string, type: string, payload: unknown, occurredAt: string): void {
    const { sequence } = this.db.prepare(`
      SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM run_events WHERE run_id = ?
    `).get(runId) as { sequence: number }
    this.db.prepare(`
      INSERT INTO run_events (run_id, sequence, type, payload_json, occurred_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(runId, sequence, type, JSON.stringify(payload), occurredAt)
  }

  latestAttemptId(executionId: string): string | undefined {
    return (this.db.prepare('SELECT id FROM attempts WHERE execution_id = ? ORDER BY number DESC LIMIT 1').get(executionId) as { id: string } | undefined)?.id
  }

  insertExecution(row: {
    id: string
    runId: string
    instructionId: string
    parentExecutionId?: string
    scopeExecutionId?: string
    scopeBranch?: number
    loopItem?: unknown
    loopIndex?: number
    now: string
  }): void {
    this.db.prepare(`
      INSERT INTO executions (
        id, run_id, instruction_id, parent_execution_id, scope_execution_id, scope_branch,
        loop_item_json, loop_index,
        status, generation, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'RUNNABLE', 0, ?, ?)
    `).run(
      row.id,
      row.runId,
      row.instructionId,
      row.parentExecutionId ?? null,
      row.scopeExecutionId ?? null,
      row.scopeBranch ?? null,
      row.loopItem === undefined ? null : JSON.stringify(row.loopItem),
      row.loopIndex ?? null,
      row.now,
      row.now,
    )
  }

  // Run transitions

  requestRunCancellation(runId: string, reason: CancellationReason): boolean {
    return this.db.prepare(`
      UPDATE runs SET status = 'CANCELLING', cancel_reason = ?
      WHERE id = ? AND status IN ('QUEUED', 'RUNNING')
    `).run(reason, runId).changes > 0
  }

  finishRunningRun(runId: string, status: 'COMPLETED' | 'FAILED', now: string): void {
    this.db.prepare(`
      UPDATE runs SET status = ?, finished_at = ? WHERE id = ? AND status = 'RUNNING'
    `).run(status, now, runId)
  }

  // Dispatch reads

  nextRunnableExecutions(limit: number): Execution[] {
    return (this.db.prepare(`
      SELECT executions.* FROM executions
      JOIN runs ON runs.id = executions.run_id
      WHERE executions.status = 'RUNNABLE' AND runs.status = 'RUNNING'
      ORDER BY executions.created_at, executions.id
      LIMIT ?
    `).all(limit) as ExecutionRow[]).map(mapExecution)
  }

  getExecutionRow(executionId: string): ExecutionRow | undefined {
    return this.db.prepare('SELECT * FROM executions WHERE id = ?')
      .get(executionId) as ExecutionRow | undefined
  }

  /** The execution and every enclosing scope are still live, and the Run is RUNNING. */
  executionAcceptsWork(execution: Execution, status: 'RUNNABLE' | 'RUNNING' | 'WAITING'): boolean {
    return !!this.db.prepare(`
      WITH RECURSIVE scopes(id, scope_execution_id, status, run_id) AS (
        SELECT parent.id, parent.scope_execution_id, parent.status, parent.run_id
        FROM executions AS child JOIN executions AS parent ON parent.id = child.scope_execution_id
        WHERE child.id = ?
        UNION
        SELECT parent.id, parent.scope_execution_id, parent.status, parent.run_id
        FROM executions AS parent JOIN scopes ON parent.id = scopes.scope_execution_id
      )
      SELECT 1 FROM executions AS current JOIN runs ON runs.id = current.run_id
      WHERE current.id = ? AND current.run_id = ? AND current.status = ? AND current.generation = ?
        AND runs.status = 'RUNNING'
        AND NOT EXISTS (SELECT 1 FROM scopes WHERE run_id != current.run_id
          OR status NOT IN ('RUNNABLE', 'RUNNING', 'WAITING', 'BLOCKED'))
    `).get(execution.id, execution.id, execution.runId, status, execution.generation)
  }

  // Binding reads

  completedRunOutputs(runId: string): OutputRow[] {
    return this.db.prepare(`
      SELECT instruction_id, output_json FROM executions
      WHERE run_id = ? AND status = 'COMPLETED' AND output_json IS NOT NULL
      ORDER BY created_at, id
    `).all(runId) as OutputRow[]
  }

  completedGraphMemberOutputs(scopeExecutionId: string): OutputRow[] {
    return this.db.prepare(`
      SELECT child.instruction_id, child.output_json FROM graph_members AS member
      JOIN executions AS child ON child.id = member.execution_id
      WHERE member.scope_execution_id = ? AND child.status = 'COMPLETED' AND child.output_json IS NOT NULL
      ORDER BY child.created_at, child.id
    `).all(scopeExecutionId) as OutputRow[]
  }

  /** Completed outputs along the parent chain, outermost first. */
  completedAncestorOutputs(executionId: string): OutputRow[] {
    return this.db.prepare(`
      WITH RECURSIVE ancestors(id, parent_execution_id, instruction_id, output_json, status, depth) AS (
        SELECT id, parent_execution_id, instruction_id, output_json, status, 0
        FROM executions WHERE id = ?
        UNION ALL
        SELECT parent.id, parent.parent_execution_id, parent.instruction_id,
          parent.output_json, parent.status, ancestors.depth + 1
        FROM executions AS parent
        JOIN ancestors ON parent.id = ancestors.parent_execution_id
      )
      SELECT instruction_id, output_json FROM ancestors
      WHERE status = 'COMPLETED' AND output_json IS NOT NULL
      ORDER BY depth DESC
    `).all(executionId) as OutputRow[]
  }

  // Invocation and Attempts

  /** Returns the new generation, or undefined when the claim lost a race. */
  claimForInvocation(execution: Execution, resolvedInput: unknown, now: string): number | undefined {
    return (this.db.prepare(`
      UPDATE executions
      SET status = 'RUNNING', resolved_input_json = ?, blocked_reason = NULL,
          generation = generation + 1, updated_at = ?
      WHERE id = ? AND status = 'RUNNABLE' AND generation = ?
      RETURNING generation
    `).get(JSON.stringify(resolvedInput), now, execution.id, execution.generation) as { generation: number } | undefined)?.generation
  }

  nextAttemptNumber(executionId: string): number {
    return (this.db.prepare(`
      SELECT COALESCE(MAX(number), 0) + 1 AS number FROM attempts WHERE execution_id = ?
    `).get(executionId) as { number: number }).number
  }

  insertAttempt(attemptId: string, executionId: string, number: number, providerRef: string, now: string): void {
    this.db.prepare(`
      INSERT INTO attempts (
        id, execution_id, number, status, provider_ref, started_at
      ) VALUES (?, ?, ?, 'RUNNING', ?, ?)
    `).run(attemptId, executionId, number, providerRef, now)
  }

  isLatestRunningAttempt(executionId: string, attemptId: string): boolean {
    return !!this.db.prepare(`
      SELECT 1 FROM attempts
      WHERE id = ? AND execution_id = ? AND status = 'RUNNING'
        AND number = (SELECT MAX(number) FROM attempts WHERE execution_id = ?)
    `).get(attemptId, executionId, executionId)
  }

  succeedAttempt(executionId: string, attemptId: string, now: string): boolean {
    return this.db.prepare(`
      UPDATE attempts SET status = 'SUCCEEDED', finished_at = ?
      WHERE id = ? AND execution_id = ? AND status = 'RUNNING'
    `).run(now, attemptId, executionId).changes > 0
  }

  finishAttempt(executionId: string, attemptId: string, status: 'FAILED' | 'TIMED_OUT' | 'OUTCOME_UNKNOWN', error: unknown, now: string): boolean {
    return this.db.prepare(`
      UPDATE attempts SET status = ?, error_json = ?, finished_at = ?
      WHERE id = ? AND execution_id = ? AND status = 'RUNNING'
    `).run(status, JSON.stringify(error), now, attemptId, executionId).changes > 0
  }

  // Execution transitions guarded by status (and generation for invocations)

  completeRunningExecution(execution: Execution, output: unknown, now: string): boolean {
    return this.db.prepare(`
      UPDATE executions SET status = 'COMPLETED', output_json = ?, updated_at = ?
      WHERE id = ? AND status = 'RUNNING' AND generation = ?
    `).run(JSON.stringify(output), now, execution.id, execution.generation).changes > 0
  }

  blockUnknownOutcome(execution: Execution, error: unknown, now: string): boolean {
    return this.db.prepare(`
      UPDATE executions
      SET status = 'BLOCKED', blocked_reason = 'OUTCOME_UNKNOWN', output_json = ?, updated_at = ?
      WHERE id = ? AND status = 'RUNNING' AND generation = ?
    `).run(JSON.stringify(error), now, execution.id, execution.generation).changes > 0
  }

  scheduleRetry(execution: Execution, wakeAt: string, error: unknown, now: string): boolean {
    return this.db.prepare(`
      UPDATE executions
      SET status = 'WAITING', blocked_reason = 'RETRY_BACKOFF', wake_at = ?, output_json = ?, updated_at = ?
      WHERE id = ? AND status = 'RUNNING' AND generation = ?
    `).run(wakeAt, JSON.stringify(error), now, execution.id, execution.generation).changes > 0
  }

  failRunningExecution(execution: Execution, status: 'FAILED' | 'TIMED_OUT', error: unknown, now: string): boolean {
    return this.db.prepare(`
      UPDATE executions SET status = ?, output_json = ?, updated_at = ?
      WHERE id = ? AND status = 'RUNNING' AND generation = ?
    `).run(status, JSON.stringify(error), now, execution.id, execution.generation).changes > 0
  }

  completeRunnable(executionId: string, output: unknown, now: string): boolean {
    return this.db.prepare(`
      UPDATE executions SET status = 'COMPLETED', output_json = ?, updated_at = ?
      WHERE id = ? AND status = 'RUNNABLE'
    `).run(JSON.stringify(output), now, executionId).changes > 0
  }

  completeRunnableWithSample(executionId: string, value: unknown, sampleId: string, now: string): boolean {
    return this.db.prepare(`UPDATE executions SET status = 'COMPLETED', output_json = ?, sample_id = ?, updated_at = ? WHERE id = ? AND status = 'RUNNABLE'`)
      .run(JSON.stringify(value), sampleId, now, executionId).changes > 0
  }

  failActiveExecution(executionId: string, error: unknown, now: string): boolean {
    return this.db.prepare(`
      UPDATE executions SET status = 'FAILED', output_json = ?, updated_at = ?
      WHERE id = ? AND status IN ('RUNNABLE', 'RUNNING')
    `).run(JSON.stringify(error), now, executionId).changes > 0
  }

  blockRunnable(executionId: string, reason: string, now: string): boolean {
    return this.db.prepare(`
      UPDATE executions SET status = 'BLOCKED', blocked_reason = ?, updated_at = ?
      WHERE id = ? AND status = 'RUNNABLE'
    `).run(reason, now, executionId).changes > 0
  }

  suspendRunnable(executionId: string, wakeAt: string, now: string): boolean {
    return this.db.prepare(`
      UPDATE executions SET status = 'WAITING', wake_at = ?, updated_at = ?
      WHERE id = ? AND status = 'RUNNABLE'
    `).run(wakeAt, now, executionId).changes > 0
  }

  // Timers and blocked work

  dueWaitingExecutions(now: string): ExecutionRow[] {
    return this.db.prepare(`
      SELECT * FROM executions
      WHERE status = 'WAITING' AND wake_at IS NOT NULL AND wake_at <= ?
      ORDER BY wake_at, id
    `).all(now) as ExecutionRow[]
  }

  readyRetry(executionId: string, now: string): boolean {
    return this.db.prepare(`
      UPDATE executions
      SET status = 'RUNNABLE', blocked_reason = NULL, wake_at = NULL, updated_at = ?
      WHERE id = ? AND status = 'WAITING' AND blocked_reason = 'RETRY_BACKOFF'
    `).run(now, executionId).changes > 0
  }

  resumeWaiting(executionId: string, now: string): boolean {
    return this.db.prepare(`
      UPDATE executions SET status = 'COMPLETED', output_json = 'null', updated_at = ?
      WHERE id = ? AND status = 'WAITING'
    `).run(now, executionId).changes > 0
  }

  listUnavailableBlocked(): ExecutionRow[] {
    return this.db.prepare(`
      SELECT * FROM executions
      WHERE status = 'BLOCKED' AND blocked_reason IN ('PROVIDER_UNAVAILABLE', 'CONNECTION_UNAVAILABLE')
      ORDER BY updated_at, id
    `).all() as ExecutionRow[]
  }

  unblock(executionId: string, reason: string, now: string): boolean {
    return this.db.prepare(`
      UPDATE executions SET status = 'RUNNABLE', blocked_reason = NULL, updated_at = ?
      WHERE id = ? AND status = 'BLOCKED' AND blocked_reason = ?
    `).run(now, executionId, reason).changes > 0
  }

  // Cancellation

  listCancellableExecutions(runId: string): ExecutionRow[] {
    return this.db.prepare(`
      SELECT * FROM executions
      WHERE run_id = ? AND status IN ('RUNNABLE', 'RUNNING', 'WAITING', 'BLOCKED', 'CANCELLING')
      ORDER BY created_at, id
    `).all(runId) as ExecutionRow[]
  }

  abortRunningAttemptsOfRun(runId: string, reason: CancellationReason, now: string): void {
    this.db.prepare(`
      UPDATE attempts
      SET status = 'ABORTED', error_json = ?, finished_at = ?
      WHERE status = 'RUNNING' AND execution_id IN (
        SELECT id FROM executions WHERE run_id = ?
      )
    `).run(JSON.stringify({ reason }), now, runId)
  }

  cancelOpenIterationsOfRun(runId: string, now: string): void {
    this.db.prepare(`
      UPDATE execution_iterations SET status = 'CANCELLED', updated_at = ?
      WHERE status IN ('PENDING', 'RUNNING') AND iterate_execution_id IN (
        SELECT id FROM executions WHERE run_id = ?
      )
    `).run(now, runId)
  }

  cancelExecution(executionId: string, now: string): boolean {
    return this.db.prepare(`
      UPDATE executions
      SET status = 'CANCELLED', blocked_reason = NULL, wake_at = NULL, updated_at = ?
      WHERE id = ? AND status IN ('RUNNABLE', 'RUNNING', 'WAITING', 'BLOCKED', 'CANCELLING')
    `).run(now, executionId).changes > 0
  }

  finishCancellingRun(runId: string, reason: CancellationReason, now: string): boolean {
    return this.db.prepare(`
      UPDATE runs SET status = 'CANCELLED', cancel_reason = ?, finished_at = ?
      WHERE id = ? AND status = 'CANCELLING'
    `).run(reason, now, runId).changes > 0
  }

  listCancellingRuns(): Array<{ id: string; cancel_reason: CancellationReason | null }> {
    return this.db.prepare(`
      SELECT id, cancel_reason FROM runs WHERE status = 'CANCELLING' ORDER BY created_at, id
    `).all() as Array<{ id: string; cancel_reason: CancellationReason | null }>
  }

  // Restart recovery

  listInterruptedAttempts(): Array<{ id: string; execution_id: string; run_id: string; instruction_id: string }> {
    return this.db.prepare(`
      SELECT attempts.*, executions.run_id, executions.instruction_id
      FROM attempts
      JOIN executions ON executions.id = attempts.execution_id
      JOIN runs ON runs.id = executions.run_id
      WHERE attempts.status = 'RUNNING' AND executions.status = 'RUNNING' AND runs.status = 'RUNNING'
      ORDER BY attempts.started_at, attempts.id
    `).all() as Array<{ id: string; execution_id: string; run_id: string; instruction_id: string }>
  }

  /** Retry-safe work returns to RUNNABLE; anything else keeps an explicit unknown outcome. */
  settleInterruptedAttempt(attemptId: string, executionId: string, retrySafe: boolean, now: string): void {
    this.db.prepare(`
      UPDATE attempts SET status = ?, finished_at = ? WHERE id = ? AND status = 'RUNNING'
    `).run(retrySafe ? 'INTERRUPTED' : 'OUTCOME_UNKNOWN', now, attemptId)
    this.db.prepare(`
      UPDATE executions SET status = ?, blocked_reason = ?, updated_at = ?
      WHERE id = ? AND status = 'RUNNING'
    `).run(retrySafe ? 'RUNNABLE' : 'BLOCKED', retrySafe ? null : 'OUTCOME_UNKNOWN', now, executionId)
  }

  /** RUNNING internal steps without a live Attempt were cut off mid-transition. */
  listInterruptedInternalExecutions(): ExecutionRow[] {
    return this.db.prepare(`
      SELECT executions.* FROM executions
      JOIN runs ON runs.id = executions.run_id
      WHERE executions.status = 'RUNNING' AND runs.status = 'RUNNING'
        AND NOT EXISTS (
          SELECT 1 FROM attempts
          WHERE attempts.execution_id = executions.id AND attempts.status = 'RUNNING'
        )
    `).all() as ExecutionRow[]
  }

  requeueRunning(executionId: string, now: string): void {
    this.db.prepare(`
      UPDATE executions SET status = 'RUNNABLE', updated_at = ?
      WHERE id = ? AND status = 'RUNNING'
    `).run(now, executionId)
  }
}
