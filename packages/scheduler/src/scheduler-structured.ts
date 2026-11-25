import {
  capabilityKey,
  clockOf,
  isNumenValue,
  type AutomationExecutionSnapshot,
  type CoreInstruction,
  type Execution,
  type GraphEdge,
  type NumenValue,
} from '@numenjs/core'
import { evaluateExpression, type EvaluationBindings } from './evaluator.js'
import { parseJson } from './repository/rows.js'
import type { GraphMemberRow } from './repository/rows.js'
import { mapExecution } from './repository/rows.js'
import {
  InvocationCancelledError,
  type GraphEdgeValue,
  type GraphScopeInstruction,
  assertSupportedSnapshot,
  errorValue,
  type SchedulerKernel,
} from './scheduler-kernel.js'
import type { SchedulerExecutionEngine } from './scheduler-engine.js'

/**
 * Structured control scopes: fork/race joins, ForEach iteration, graph member
 * dispatch, and failure propagation from a child to its enclosing scope.
 */

export class StructuredScopes {
  constructor(
    private readonly kernel: SchedulerKernel,
    private readonly engine: SchedulerExecutionEngine,
  ) {}

  recoverStructuredScopes(): void {
    const rows = this.kernel.scopes.listWaitingStructuredScopes()
    const now = clockOf(this.kernel.ctx).nowIso()
    for (const row of rows) {
      const fork = mapExecution(row)
      const { revision, instruction } = this.kernel.getRevisionForExecution(fork)
      this.kernel.ctx.database.transaction(() => {
        if (instruction.op === 'iterate' || instruction.op === 'graph_iterate') {
          this.reconcileIterate(fork, instruction, now)
          return
        }
        if (instruction.op !== 'fork') return
        if (instruction.mode === 'all') {
          this.reconcileAllFork(row.id, now)
          return
        }
        const completed = this.kernel.scopes.listCompletedChildren(row.id)
        const winner = completed.find(candidate => (
          revision.compiledPlan.instructions[candidate.instruction_id]?.op === 'scope_complete'
        ))
        if (winner) this.reconcileRaceFork(row.id, mapExecution(winner), now)
      })
    }
  }

  graphMemberRows(scopeExecutionId: string): Map<string, GraphMemberRow> {
    return new Map(this.kernel.scopes.graphMemberRows(scopeExecutionId).map(row => [row.node_id, row]))
  }

  validateGraphScope(instruction: GraphScopeInstruction, revision: AutomationExecutionSnapshot): void {
    if (instruction.version !== 1) throw new Error('unsupported graph scope version')
    const members = new Set(instruction.members)
    if (members.size !== instruction.members.length || members.has(instruction.id)) throw new Error('invalid graph members')
    for (const member of members) {
      const node = revision.compiledPlan.instructions[member]
      if (!node || !['invoke', 'graph_condition', 'graph_merge', 'graph_iterate', 'graph_value'].includes(node.op)) throw new Error('invalid graph member instruction')
      if (node.op === 'invoke' && node.next !== undefined) throw new Error('graph member cannot have a sequential successor')
      if (node.op === 'graph_merge' && (new Set(node.inputs).size !== node.inputs.length || !node.inputs.length)) throw new Error('invalid graph merge inputs')
      if (node.op === 'graph_iterate') this.validateGraphIteration(node, revision)
    }
    const edgeIds = new Set<string>()
    const destinations = new Set<string>()
    for (const edge of instruction.edges) {
      if (edgeIds.has(edge.id)) throw new Error('duplicate graph edge')
      edgeIds.add(edge.id)
      const target = revision.compiledPlan.instructions[edge.to.nodeId]
      if (!members.has(edge.to.nodeId) || !target) throw new Error('invalid graph edge target')
      const source = revision.compiledPlan.instructions[edge.from.nodeId]
      const start = edge.from.nodeId === instruction.id && edge.from.port === 'start'
      if (!start && (!members.has(edge.from.nodeId) || !source
        || (source.op === 'graph_condition' ? !['true', 'false'].includes(edge.from.port) : edge.from.port !== 'out'))) throw new Error('invalid graph edge source')
      if (target.op === 'graph_merge') {
        const destination = JSON.stringify([edge.to.nodeId, edge.to.port])
        if (start || !target.inputs.includes(edge.to.port) || destinations.has(destination)) throw new Error('invalid graph merge edge')
        destinations.add(destination)
      } else if (edge.to.port !== 'in') throw new Error('invalid graph input port')
    }
    for (const member of members) {
      const incoming = instruction.edges.filter(edge => edge.to.nodeId === member)
      const node = revision.compiledPlan.instructions[member]!
      if (!incoming.length || (node.op === 'graph_merge' && incoming.length !== node.inputs.length)) throw new Error('graph member inputs are not connected')
    }
  }

  beginGraphScope(execution: Execution, instruction: GraphScopeInstruction): void {
    const { revision } = this.kernel.getRevisionForExecution(execution)
    this.validateGraphScope(instruction, revision)
    const now = clockOf(this.kernel.ctx).nowIso()
    this.kernel.ctx.database.transaction(() => {
      if (!this.kernel.scopes.waitForGraphMembers(execution.id, execution.runId, now)) return
      this.kernel.scopes.insertGraphMembers(execution.id, instruction.members, now)
      this.kernel.appendEvent(execution.runId, 'ExecutionGraphStarted', { executionId: execution.id, members: instruction.members }, now)
    })
  }

  graphEdgeValue(edge: GraphEdge, instruction: GraphScopeInstruction, members: Map<string, GraphMemberRow>, revision: AutomationExecutionSnapshot): GraphEdgeValue {
    if (edge.from.nodeId === instruction.id && edge.from.port === 'start') return { state: 'completed', value: null }
    const member = members.get(edge.from.nodeId)
    if (!member) throw new Error('graph source member is missing')
    if (member.skipped) return { state: 'skipped' }
    if (member.status !== 'COMPLETED') return { state: 'pending' }
    // SQL NULL means no result was persisted. JSON "null" is a completed value.
    if (member.output_json === null) throw new Error('completed graph member has no persisted output')
    const value = parseJson<NumenValue>(member.output_json)
    if (revision.compiledPlan.instructions[edge.from.nodeId]?.op === 'graph_condition') {
      if (typeof value !== 'boolean') throw new Error('persisted graph condition is not boolean')
      if (edge.from.port !== String(value)) return { state: 'skipped' }
    }
    return { state: 'completed', value }
  }

  graphMergeOutput(execution: Execution, instruction: Extract<CoreInstruction, { op: 'graph_merge' }>): NumenValue {
    if (!execution.scopeExecutionId) throw new Error('graph merge scope missing')
    const scopeRow = this.kernel.getExecutionRow(execution.scopeExecutionId)
    if (!scopeRow) throw new Error('graph merge scope missing')
    const { revision, instruction: scope } = this.kernel.getRevisionForExecution(mapExecution(scopeRow))
    if (scope.op !== 'graph_scope') throw new Error('graph merge parent is not a graph scope')
    const members = this.graphMemberRows(scopeRow.id)
    const values = scope.edges.filter(edge => edge.to.nodeId === instruction.id)
      .map(edge => ({ name: edge.to.port, result: this.graphEdgeValue(edge, scope, members, revision) }))
    if (values.length !== instruction.inputs.length || values.some(value => value.result.state === 'pending')) throw new Error('graph merge inputs are not ready')
    const completed = values.filter((value): value is { name: string; result: { state: 'completed'; value: NumenValue } } => value.result.state === 'completed')
    if (instruction.mode === 'selected') {
      if (completed.length !== 1) throw new Error('selected graph merge requires exactly one successful input')
      return completed[0]!.result.value
    }
    if (completed.length !== values.length || new Set(completed.map(value => value.name)).size !== values.length) throw new Error('graph merge inputs are not uniquely complete')
    return Object.fromEntries(completed.map(value => [value.name, value.result.value]))
  }

  reconcileGraphScopes(): number {
    const rows = this.kernel.scopes.listWaitingGraphScopes()
    let transitions = 0
    for (const row of rows) {
      const execution = mapExecution(row)
      try {
        const { revision, instruction } = this.kernel.getRevisionForExecution(execution)
        assertSupportedSnapshot(revision)
        if (instruction.op !== 'graph_scope') throw new Error('graph scope instruction missing')
        transitions += this.reconcileGraphScope(execution, instruction, revision)
      } catch (error) {
        this.failGraphScope(execution, errorValue(error))
        transitions += 1
      }
    }
    return transitions
  }

  reconcileGraphScope(execution: Execution, instruction: GraphScopeInstruction, revision: AutomationExecutionSnapshot): number {
    return this.kernel.ctx.database.transaction(() => {
      const current = this.kernel.getExecutionRow(execution.id)
      if (current?.status !== 'WAITING' || current.blocked_reason !== 'GRAPH_MEMBERS' || this.kernel.getRun(execution.runId)?.status !== 'RUNNING') return 0
      this.validateGraphScope(instruction, revision)
      const members = this.graphMemberRows(execution.id)
      if (members.size !== instruction.members.length || instruction.members.some(member => !members.has(member))) throw new Error('persisted graph members do not match the immutable plan')
      if ([...members.values()].some(member => member.status && ['FAILED', 'TIMED_OUT', 'CANCELLED'].includes(member.status))) throw new Error('graph child terminated unsuccessfully')
      const now = clockOf(this.kernel.ctx).nowIso()
      let transitions = 0
      let changed = true
      while (changed) {
        changed = false
        for (const [nodeId, member] of members) {
          if (member.skipped || member.execution_id) continue
          const node = revision.compiledPlan.instructions[nodeId]!
          const incoming = instruction.edges.filter(edge => edge.to.nodeId === nodeId)
          const values = incoming.map(edge => this.graphEdgeValue(edge, instruction, members, revision))
          let skip: boolean
          if (node.op === 'graph_merge' && node.mode === 'selected') {
            if (values.some(value => value.state === 'pending')) continue
            const completed = values.filter(value => value.state === 'completed').length
            if (completed > 1) throw new Error('selected graph merge received multiple successful inputs')
            skip = completed === 0
          } else {
            skip = values.some(value => value.state === 'skipped')
            if (!skip && values.some(value => value.state === 'pending')) continue
          }
          if (skip) {
            if (!this.kernel.scopes.skipGraphMember(execution.id, nodeId, now)) continue
            member.skipped = 1
            this.kernel.appendEvent(execution.runId, 'GraphMemberSkipped', { scopeExecutionId: execution.id, nodeId }, now)
          } else {
            // Unique member identity and its Execution are committed in one immediate transaction.
            const childId = this.kernel.createExecution(execution.runId, nodeId, execution.id, execution.id, undefined, execution.loopItem, execution.loopIndex)
            if (!this.kernel.scopes.assignGraphMember(execution.id, nodeId, childId, now)) throw new Error('graph member was already dispatched')
            member.execution_id = childId
            member.status = 'RUNNABLE'
          }
          changed = true
          transitions += 1
        }
      }
      const remaining = [...members.values()].filter(member => !member.skipped && member.status !== 'COMPLETED')
      if (remaining.length) {
        if (remaining.every(member => member.execution_id === null)) throw new Error('graph dependencies cannot become ready')
        return transitions
      }
      const output = instruction.output ? evaluateExpression(instruction.output, this.kernel.createBindings(this.kernel.getRun(execution.runId)!, execution)) : null
      if (!this.kernel.scopes.settleWaitingScope(execution.id, 'GRAPH_MEMBERS', 'COMPLETED', output, now)) return transitions
      this.kernel.commitOutputResources(execution, output)
      this.kernel.appendEvent(execution.runId, 'ExecutionGraphCompleted', { executionId: execution.id, output }, now)
      if (instruction.next) this.kernel.createSuccessor(execution, instruction.next)
      else {
        this.kernel.journal.finishRunningRun(execution.runId, 'COMPLETED', now)
        this.kernel.appendEvent(execution.runId, 'RunCompleted', { output }, now)
      }
      return transitions + 1
    })
  }

  failGraphScope(execution: Execution, error: NumenValue): void {
    const now = clockOf(this.kernel.ctx).nowIso()
    this.kernel.ctx.database.transaction(() => {
      if (!this.kernel.scopes.settleWaitingScope(execution.id, 'GRAPH_MEMBERS', 'FAILED', error, now)) return
      this.cancelScopeExecutions(execution.id, execution.runId, 'PARENT', now)
      this.kernel.appendEvent(execution.runId, 'ExecutionGraphFailed', { executionId: execution.id, error }, now)
      if (this.handleStructuredFailure(execution, now, error)) {
        this.kernel.journal.finishRunningRun(execution.runId, 'FAILED', now)
        this.kernel.appendEvent(execution.runId, 'RunFailed', { executionId: execution.id, error }, now)
      }
    })
  }


  forkAll(
    execution: Execution,
    instruction: Extract<CoreInstruction, { op: 'fork' }>,
  ): void {
    const now = clockOf(this.kernel.ctx).nowIso()
    this.kernel.ctx.database.transaction(() => {
      if (!this.kernel.scopes.waitForChildren(execution.id, now)) return
      this.kernel.appendEvent(execution.runId, 'ExecutionForked', {
        executionId: execution.id,
        mode: instruction.mode,
        branches: instruction.branches,
      }, now)
      for (const [branchIndex, branch] of instruction.branches.entries()) {
        this.kernel.createExecution(
          execution.runId,
          branch,
          execution.id,
          execution.id,
          branchIndex,
          execution.loopItem,
          execution.loopIndex,
        )
      }
    })
  }

  validateGraphIteration(instruction: Extract<CoreInstruction, { op: 'graph_iterate' }>, revision: AutomationExecutionSnapshot): void {
    const body = revision.compiledPlan.instructions[instruction.body]
    if (!Number.isSafeInteger(instruction.concurrency) || instruction.concurrency < 1) throw new Error('invalid graph iteration concurrency')
    if (body?.op !== 'graph_scope' || body.output === undefined
      || !body.next || revision.compiledPlan.instructions[body.next]?.op !== 'scope_complete') throw new Error('graph iteration requires an explicit body output and scope completion')
  }

  beginIterate(
    execution: Execution,
    instruction: Extract<CoreInstruction, { op: 'iterate' | 'graph_iterate' }>,
    bindings: EvaluationBindings,
  ): void {
    if (instruction.op === 'graph_iterate') this.validateGraphIteration(instruction, this.kernel.getRevisionForExecution(execution).revision)
    const items = evaluateExpression(instruction.items, bindings)
    if (!Array.isArray(items)) throw new Error('ForEach items must evaluate to an array')
    const now = clockOf(this.kernel.ctx).nowIso()
    this.kernel.ctx.database.transaction(() => {
      if (instruction.op === 'graph_iterate' && !this.engine.executionAcceptsWork(execution, 'RUNNABLE')) return
      if (!this.kernel.scopes.waitForIterations(execution.id, items, now)) return
      this.kernel.scopes.insertIterations(execution.id, items, now)
      this.kernel.appendEvent(execution.runId, 'ExecutionIterationStarted', {
        executionId: execution.id,
        itemCount: items.length,
        concurrency: instruction.concurrency,
      }, now)
      this.reconcileIterate(execution, instruction, now)
    })
  }

  reconcileIterate(
    iterate: Execution,
    instruction: Extract<CoreInstruction, { op: 'iterate' | 'graph_iterate' }>,
    now: string,
  ): void {
    const current = this.kernel.getExecutionRow(iterate.id)
    if (!current || current.status !== 'WAITING' || current.blocked_reason !== 'ITERATIONS') return
    if (instruction.op === 'graph_iterate' && !this.engine.executionAcceptsWork(iterate, 'WAITING')) return
    const running = this.kernel.scopes.runningIterationCount(iterate.id)
    const capacity = Math.max(0, instruction.concurrency - running)
    if (capacity) {
      const pending = this.kernel.scopes.pendingIterations(iterate.id, capacity)
      for (const item of pending) {
        if (!this.kernel.scopes.claimIteration(iterate.id, item.item_index, now)) continue
        const value = parseJson<NumenValue>(item.item_json)
        const rootExecutionId = this.kernel.createExecution(
          iterate.runId,
          instruction.body,
          iterate.id,
          iterate.id,
          item.item_index,
          value,
          item.item_index,
        )
        this.kernel.scopes.setIterationRoot(iterate.id, item.item_index, rootExecutionId, now)
        this.kernel.appendEvent(iterate.runId, 'ExecutionIterationDispatched', {
          executionId: iterate.id,
          itemIndex: item.item_index,
          rootExecutionId,
        }, now)
      }
    }
    const counts = this.kernel.scopes.iterationCounts(iterate.id)
    if ((counts.pending ?? 0) || (counts.running ?? 0)) return
    const output: NumenValue = instruction.op === 'graph_iterate' ? this.collectGraphIterationResults(iterate, instruction, counts.total) : { count: counts.total }
    if (!this.kernel.scopes.settleWaitingScope(iterate.id, 'ITERATIONS', 'COMPLETED', output, now)) return
    if (instruction.op === 'graph_iterate') this.kernel.commitOutputResources(iterate, output)
    this.kernel.appendEvent(iterate.runId, 'ExecutionIterationCompleted', {
      executionId: iterate.id,
      itemCount: counts.total,
    }, now)
    if (instruction.op === 'graph_iterate') return
    this.kernel.createExecution(
      iterate.runId,
      instruction.join,
      iterate.id,
      iterate.scopeExecutionId,
      iterate.scopeBranch,
      iterate.loopItem,
      iterate.loopIndex,
    )
  }

  collectGraphIterationResults(iterate: Execution, instruction: Extract<CoreInstruction, { op: 'graph_iterate' }>, total: number): NumenValue[] {
    const rows = this.kernel.scopes.iterationResults(iterate.id)
    if (rows.length !== total || rows.some((row, index) => row.item_index !== index || row.status !== 'COMPLETED'
      || row.instruction_id !== instruction.body || row.scope_execution_id !== iterate.id || row.scope_branch !== index
      || row.root_status !== 'COMPLETED' || row.output_json === null)) throw new Error('graph iteration results are incomplete or belong to another scope')
    return rows.map(row => parseJson<NumenValue>(row.output_json!))
  }

  completeScope(execution: Execution): void {
    if (!execution.scopeExecutionId) {
      this.engine.failExecution(execution, { code: 'SCOPE_PARENT_MISSING' })
      return
    }
    const now = clockOf(this.kernel.ctx).nowIso()
    this.kernel.ctx.database.transaction(() => {
      if (!this.kernel.journal.completeRunnable(execution.id, null, now)) return
      this.kernel.appendEvent(execution.runId, 'ExecutionScopeCompleted', {
        executionId: execution.id,
        scopeExecutionId: execution.scopeExecutionId!,
      }, now)
      const forkRow = this.kernel.getExecutionRow(execution.scopeExecutionId!)
      if (!forkRow) return
      const { instruction } = this.kernel.getRevisionForExecution(mapExecution(forkRow))
      if (instruction.op === 'fork') {
        if (instruction.mode === 'all') this.reconcileAllFork(execution.scopeExecutionId!, now)
        else this.reconcileRaceFork(execution.scopeExecutionId!, execution, now)
        return
      }
      if (instruction.op === 'iterate' || instruction.op === 'graph_iterate') {
        if (execution.scopeBranch === undefined) return
        if (!this.kernel.scopes.completeIteration(execution.scopeExecutionId!, execution.scopeBranch, execution.id, now)) return
        this.kernel.appendEvent(execution.runId, 'ExecutionIterationItemCompleted', {
          executionId: execution.scopeExecutionId!,
          itemIndex: execution.scopeBranch,
          terminalExecutionId: execution.id,
        }, now)
        this.reconcileIterate(mapExecution(forkRow), instruction, now)
      }
    })
  }

  reconcileAllFork(forkExecutionId: string, now: string): void {
    const forkRow = this.kernel.getExecutionRow(forkExecutionId)
    if (!forkRow || forkRow.status !== 'WAITING' || forkRow.blocked_reason !== 'CHILDREN') return
    if (this.kernel.scopes.remainingChildren(forkExecutionId)) return
    const fork = mapExecution(forkRow)
    const { instruction } = this.kernel.getRevisionForExecution(fork)
    if (instruction.op !== 'fork' || instruction.mode !== 'all') return
    if (!this.kernel.scopes.settleWaitingScope(forkExecutionId, 'CHILDREN', 'COMPLETED', null, now)) return
    this.kernel.appendEvent(fork.runId, 'ExecutionJoined', {
      executionId: fork.id,
      mode: 'all',
    }, now)
    this.kernel.createExecution(
      fork.runId,
      instruction.join,
      fork.id,
      fork.scopeExecutionId,
      fork.scopeBranch,
      fork.loopItem,
      fork.loopIndex,
    )
  }

  reconcileRaceFork(forkExecutionId: string, winner: Execution, now: string): void {
    if (winner.scopeBranch === undefined) return
    const forkRow = this.kernel.getExecutionRow(forkExecutionId)
    if (!forkRow || forkRow.status !== 'WAITING' || forkRow.blocked_reason !== 'CHILDREN') return
    const fork = mapExecution(forkRow)
    const { instruction } = this.kernel.getRevisionForExecution(fork)
    if (instruction.op !== 'fork' || instruction.mode !== 'first_success') return
    const output = { winnerBranch: winner.scopeBranch, winnerExecutionId: winner.id }
    if (!this.kernel.scopes.settleWaitingScope(forkExecutionId, 'CHILDREN', 'COMPLETED', output, now)) return
    this.cancelScopeExecutions(forkExecutionId, fork.runId, 'RACE', now, {
      excludeBranch: winner.scopeBranch,
    })
    this.kernel.appendEvent(fork.runId, 'ExecutionRaceWon', {
      executionId: fork.id,
      winnerBranch: winner.scopeBranch,
      winnerExecutionId: winner.id,
    }, now)
    this.kernel.appendEvent(fork.runId, 'ExecutionJoined', { executionId: fork.id, mode: 'first_success' }, now)
    this.kernel.createExecution(
      fork.runId,
      instruction.join,
      fork.id,
      fork.scopeExecutionId,
      fork.scopeBranch,
      fork.loopItem,
      fork.loopIndex,
    )
  }

  handleStructuredFailure(execution: Execution, now: string, error: NumenValue): boolean {
    if (!execution.scopeExecutionId) return true
    const forkRow = this.kernel.getExecutionRow(execution.scopeExecutionId)
    if (!forkRow) return true
    const fork = mapExecution(forkRow)
    const { instruction } = this.kernel.getRevisionForExecution(fork)
    if (instruction.op === 'iterate' || instruction.op === 'graph_iterate') {
      if (execution.scopeBranch === undefined) return true
      this.kernel.scopes.failIteration(fork.id, execution.scopeBranch, error, now)
      this.cancelScopeExecutions(fork.id, execution.runId, 'PARENT', now)
      this.kernel.scopes.cancelOpenIterations(fork.id, now)
      if (this.kernel.scopes.settleWaitingScope(fork.id, 'ITERATIONS', 'FAILED', error, now)) {
        this.kernel.appendEvent(execution.runId, 'ExecutionIterationFailed', {
          executionId: fork.id,
          itemIndex: execution.scopeBranch,
          failedExecutionId: execution.id,
          error,
        }, now)
      }
      return this.handleStructuredFailure(fork, now, error)
    }
    if (instruction.op === 'graph_scope') {
      this.cancelScopeExecutions(fork.id, execution.runId, 'PARENT', now)
      this.kernel.scopes.failOpenScope(fork.id, error, now)
      this.kernel.appendEvent(execution.runId, 'ExecutionGraphFailed', { executionId: fork.id, failedExecutionId: execution.id, error }, now)
      return this.handleStructuredFailure(fork, now, error)
    }
    if (instruction.op !== 'fork') return true

    if (instruction.mode === 'first_success') {
      if (execution.scopeBranch === undefined) return true
      this.cancelScopeExecutions(fork.id, execution.runId, 'PARENT', now, {
        includeBranch: execution.scopeBranch,
      })
      this.kernel.appendEvent(execution.runId, 'ExecutionRaceBranchFailed', {
        executionId: fork.id,
        branch: execution.scopeBranch ?? -1,
        failedExecutionId: execution.id,
        error,
      }, now)
      if (this.kernel.scopes.failedBranchCount(fork.id) < instruction.branches.length) return false
    } else {
      this.cancelScopeExecutions(fork.id, execution.runId, 'PARENT', now)
    }

    if (this.kernel.scopes.failOpenScope(fork.id, error, now)) {
      this.kernel.appendEvent(execution.runId, 'ExecutionScopeFailed', {
        executionId: fork.id,
        failedExecutionId: execution.id,
        error,
      }, now)
    }
    return this.handleStructuredFailure(fork, now, error)
  }

  cancelScopeExecutions(
    scopeExecutionId: string,
    runId: string,
    reason: 'PARENT' | 'RACE',
    now: string,
    filter: { includeBranch?: number; excludeBranch?: number } = {},
  ): void {
    const rows = this.kernel.scopes.listActiveDescendants(scopeExecutionId)
    for (const row of rows) {
      if (filter.includeBranch !== undefined && row.root_branch !== filter.includeBranch) continue
      if (filter.excludeBranch !== undefined && row.root_branch === filter.excludeBranch) continue
      const active = this.kernel.activeInvocations.get(row.id)
      if (active && !active.controller.signal.aborted) {
        active.controller.abort(new InvocationCancelledError(reason))
      }
      this.kernel.scopes.abortRunningAttempts(row.id, reason, now)
      const cancelled = this.kernel.journal.cancelExecution(row.id, now)
      this.kernel.scopes.cancelOpenIterations(row.id, now)
      if (cancelled) {
        this.kernel.appendEvent(runId, 'ExecutionCancelled', { executionId: row.id, reason }, now)
      }
    }
  }
}
