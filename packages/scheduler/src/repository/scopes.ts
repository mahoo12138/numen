import type { CancellationReason } from '@numenjs/core'
import type { DatabaseService } from '@numenjs/database'
import type { ExecutionRow, GraphMemberRow, IterationRow } from './rows.js'

/** A scope parent waits on children, iterations, or graph members under one blocked reason. */
export type ScopeWaitReason = 'CHILDREN' | 'ITERATIONS' | 'GRAPH_MEMBERS'

/**
 * Structured (fork/iterate) and graph scope state. Writes assume the caller holds
 * the immediate transaction; the Scheduler decides ordering and events.
 */
export class ScopeRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db
  }

  // Scope parents

  listWaitingStructuredScopes(): ExecutionRow[] {
    return this.db.prepare(`
      SELECT * FROM executions
      WHERE status = 'WAITING' AND blocked_reason IN ('CHILDREN', 'ITERATIONS')
      ORDER BY created_at, id
    `).all() as ExecutionRow[]
  }

  listWaitingGraphScopes(): ExecutionRow[] {
    return this.db.prepare(`
      SELECT executions.* FROM executions JOIN runs ON runs.id = executions.run_id
      WHERE executions.status = 'WAITING' AND executions.blocked_reason = 'GRAPH_MEMBERS' AND runs.status = 'RUNNING'
      ORDER BY executions.created_at, executions.id
    `).all() as ExecutionRow[]
  }

  waitForChildren(executionId: string, now: string): boolean {
    return this.db.prepare(`
      UPDATE executions
      SET status = 'WAITING', blocked_reason = 'CHILDREN', updated_at = ?
      WHERE id = ? AND status = 'RUNNABLE'
    `).run(now, executionId).changes > 0
  }

  /** Settle a waiting scope parent only if it is still waiting for the same reason. */
  settleWaitingScope(executionId: string, reason: ScopeWaitReason, status: 'COMPLETED' | 'FAILED', output: unknown, now: string): boolean {
    return this.db.prepare(`
      UPDATE executions
      SET status = ?, blocked_reason = NULL, output_json = ?, updated_at = ?
      WHERE id = ? AND status = 'WAITING' AND blocked_reason = ?
    `).run(status, JSON.stringify(output), now, executionId, reason).changes > 0
  }

  failOpenScope(executionId: string, error: unknown, now: string): boolean {
    return this.db.prepare(`
      UPDATE executions
      SET status = 'FAILED', blocked_reason = NULL, output_json = ?, updated_at = ?
      WHERE id = ? AND status IN ('RUNNABLE', 'RUNNING', 'WAITING', 'BLOCKED')
    `).run(JSON.stringify(error), now, executionId).changes > 0
  }

  // Children

  listCompletedChildren(scopeExecutionId: string): ExecutionRow[] {
    return this.db.prepare(`
      SELECT * FROM executions
      WHERE scope_execution_id = ? AND status = 'COMPLETED'
      ORDER BY updated_at, id
    `).all(scopeExecutionId) as ExecutionRow[]
  }

  remainingChildren(scopeExecutionId: string): number {
    return (this.db.prepare(`
      SELECT COUNT(*) AS remaining FROM executions
      WHERE scope_execution_id = ? AND status != 'COMPLETED'
    `).get(scopeExecutionId) as { remaining: number }).remaining
  }

  failedBranchCount(scopeExecutionId: string): number {
    return (this.db.prepare(`
      SELECT COUNT(DISTINCT scope_branch) AS failedBranches FROM executions
      WHERE scope_execution_id = ? AND status IN ('FAILED', 'TIMED_OUT')
    `).get(scopeExecutionId) as { failedBranches: number }).failedBranches
  }

  /** Every live descendant with the branch of the scope child it descends from. */
  listActiveDescendants(scopeExecutionId: string): Array<ExecutionRow & { root_branch: number | null }> {
    return this.db.prepare(`
      WITH RECURSIVE descendants(id, root_branch) AS (
        SELECT id, scope_branch FROM executions WHERE scope_execution_id = ?
        UNION ALL
        SELECT executions.id, descendants.root_branch FROM executions
        JOIN descendants ON executions.scope_execution_id = descendants.id
      )
      SELECT executions.*, descendants.root_branch FROM executions
      JOIN descendants ON descendants.id = executions.id
      WHERE executions.status IN ('RUNNABLE', 'RUNNING', 'WAITING', 'BLOCKED', 'CANCELLING')
    `).all(scopeExecutionId) as Array<ExecutionRow & { root_branch: number | null }>
  }

  abortRunningAttempts(executionId: string, reason: CancellationReason, now: string): void {
    this.db.prepare(`
      UPDATE attempts SET status = 'ABORTED', error_json = ?, finished_at = ?
      WHERE execution_id = ? AND status = 'RUNNING'
    `).run(JSON.stringify({ reason }), now, executionId)
  }

  // Iterations

  waitForIterations(executionId: string, items: unknown[], now: string): boolean {
    return this.db.prepare(`
      UPDATE executions
      SET status = 'WAITING', blocked_reason = 'ITERATIONS', resolved_input_json = ?, updated_at = ?
      WHERE id = ? AND status = 'RUNNABLE'
    `).run(JSON.stringify(items), now, executionId).changes > 0
  }

  insertIterations(executionId: string, items: unknown[], now: string): void {
    const insert = this.db.prepare(`
      INSERT INTO execution_iterations (
        iterate_execution_id, item_index, item_json, status, created_at, updated_at
      ) VALUES (?, ?, ?, 'PENDING', ?, ?)
    `)
    items.forEach((item, index) => insert.run(executionId, index, JSON.stringify(item), now, now))
  }

  runningIterationCount(iterateExecutionId: string): number {
    return (this.db.prepare(`
      SELECT COUNT(*) AS running FROM execution_iterations
      WHERE iterate_execution_id = ? AND status = 'RUNNING'
    `).get(iterateExecutionId) as { running: number }).running
  }

  pendingIterations(iterateExecutionId: string, limit: number): IterationRow[] {
    return this.db.prepare(`
      SELECT * FROM execution_iterations
      WHERE iterate_execution_id = ? AND status = 'PENDING'
      ORDER BY item_index LIMIT ?
    `).all(iterateExecutionId, limit) as IterationRow[]
  }

  claimIteration(iterateExecutionId: string, itemIndex: number, now: string): boolean {
    return this.db.prepare(`
      UPDATE execution_iterations SET status = 'RUNNING', updated_at = ?
      WHERE iterate_execution_id = ? AND item_index = ? AND status = 'PENDING'
    `).run(now, iterateExecutionId, itemIndex).changes > 0
  }

  setIterationRoot(iterateExecutionId: string, itemIndex: number, rootExecutionId: string, now: string): void {
    this.db.prepare(`
      UPDATE execution_iterations SET root_execution_id = ?, updated_at = ?
      WHERE iterate_execution_id = ? AND item_index = ?
    `).run(rootExecutionId, now, iterateExecutionId, itemIndex)
  }

  iterationCounts(iterateExecutionId: string): { pending: number | null; running: number | null; total: number } {
    return this.db.prepare(`
      SELECT
        SUM(CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN status = 'RUNNING' THEN 1 ELSE 0 END) AS running,
        COUNT(*) AS total
      FROM execution_iterations WHERE iterate_execution_id = ?
    `).get(iterateExecutionId) as { pending: number | null; running: number | null; total: number }
  }

  iterationResults(iterateExecutionId: string): Array<{
    item_index: number; status: string; instruction_id: string | null; scope_execution_id: string | null
    scope_branch: number | null; root_status: string | null; output_json: string | null
  }> {
    return this.db.prepare(`
      SELECT iteration.item_index, iteration.status, root.instruction_id, root.scope_execution_id, root.scope_branch,
        root.status AS root_status, root.output_json
      FROM execution_iterations AS iteration LEFT JOIN executions AS root ON root.id = iteration.root_execution_id
      WHERE iteration.iterate_execution_id = ? ORDER BY iteration.item_index
    `).all(iterateExecutionId) as ReturnType<ScopeRepository['iterationResults']>
  }

  completeIteration(iterateExecutionId: string, itemIndex: number, terminalExecutionId: string, now: string): boolean {
    return this.db.prepare(`
      UPDATE execution_iterations
      SET status = 'COMPLETED', terminal_execution_id = ?, updated_at = ?
      WHERE iterate_execution_id = ? AND item_index = ? AND status = 'RUNNING'
    `).run(terminalExecutionId, now, iterateExecutionId, itemIndex).changes > 0
  }

  failIteration(iterateExecutionId: string, itemIndex: number, error: unknown, now: string): void {
    this.db.prepare(`
      UPDATE execution_iterations
      SET status = 'FAILED', error_json = ?, updated_at = ?
      WHERE iterate_execution_id = ? AND item_index = ? AND status = 'RUNNING'
    `).run(JSON.stringify(error), now, iterateExecutionId, itemIndex)
  }

  cancelOpenIterations(iterateExecutionId: string, now: string): void {
    this.db.prepare(`
      UPDATE execution_iterations SET status = 'CANCELLED', updated_at = ?
      WHERE iterate_execution_id = ? AND status IN ('PENDING', 'RUNNING')
    `).run(now, iterateExecutionId)
  }

  // Graph members

  graphMemberRows(scopeExecutionId: string): GraphMemberRow[] {
    return this.db.prepare(`
      SELECT members.*, child.status, child.output_json, child.blocked_reason
      FROM graph_members AS members LEFT JOIN executions AS child ON child.id = members.execution_id
      WHERE members.scope_execution_id = ? ORDER BY members.node_id
    `).all(scopeExecutionId) as GraphMemberRow[]
  }

  /** Only a RUNNABLE scope of a still-RUNNING Run may start waiting on members. */
  waitForGraphMembers(executionId: string, runId: string, now: string): boolean {
    return this.db.prepare(`
      UPDATE executions SET status = 'WAITING', blocked_reason = 'GRAPH_MEMBERS', updated_at = ?
      WHERE id = ? AND status = 'RUNNABLE'
        AND EXISTS (SELECT 1 FROM runs WHERE id = ? AND status = 'RUNNING')
    `).run(now, executionId, runId).changes > 0
  }

  insertGraphMembers(scopeExecutionId: string, members: readonly string[], now: string): void {
    const insert = this.db.prepare(`
      INSERT INTO graph_members (scope_execution_id, node_id, created_at, updated_at) VALUES (?, ?, ?, ?)
    `)
    for (const member of members) insert.run(scopeExecutionId, member, now, now)
  }

  skipGraphMember(scopeExecutionId: string, nodeId: string, now: string): boolean {
    return this.db.prepare(`
      UPDATE graph_members SET skipped = 1, updated_at = ?
      WHERE scope_execution_id = ? AND node_id = ? AND skipped = 0 AND execution_id IS NULL
    `).run(now, scopeExecutionId, nodeId).changes > 0
  }

  assignGraphMember(scopeExecutionId: string, nodeId: string, executionId: string, now: string): boolean {
    return this.db.prepare(`
      UPDATE graph_members SET execution_id = ?, updated_at = ?
      WHERE scope_execution_id = ? AND node_id = ? AND skipped = 0 AND execution_id IS NULL
    `).run(executionId, now, scopeExecutionId, nodeId).changes > 0
  }
}
