import {
  clockOf,
  isResourceRef,
  nextId,
  isSupportedAutomationVersion,
  type AutomationExecutionSnapshot,
  type Attempt,
  type CancellationReason,
  type ControlSource,
  type CoreInstruction,
  type Execution,
  type NumenValue,
  type Run,
} from '@numenjs/core'
import type { ConnectionService } from '@numenjs/connections'
import type { Context } from 'cordis'
import { withLogContext } from '@numenjs/logging'
import { evaluateExpression, type EvaluationBindings } from './evaluator.js'
import { canonicalize, mapExecution, parseJson, type ExecutionRow, type GraphMemberRow } from './repository/rows.js'
import type { AttentionService } from './attention.js'
import type { RunInspectionRepository } from './repository/inspection.js'
import type { RunJournal } from './repository/journal.js'
import type { AdmissionRepository } from './repository/admissions.js'
import type { ScopeRepository } from './repository/scopes.js'
import type { SchedulerService } from './service.js'

/**
 * State and primitives shared by the Scheduler collaborators. Transaction
 * boundaries stay with the caller; this module only composes repository reads
 * and writes and fires change notifications.
 */

export type GraphScopeInstruction = Extract<CoreInstruction, { op: 'graph_scope' }>
export type GraphEdgeValue = { state: 'pending' | 'skipped' } | { state: 'completed'; value: NumenValue }

const structuredInstructionOps = new Set(['invoke', 'eval', 'branch', 'suspend', 'fork', 'iterate', 'scope_complete', 'join', 'complete', 'fail'])
const graphInstructionOps = new Set(['graph_scope', 'graph_condition', 'graph_merge', 'graph_iterate', 'graph_value'])

export function assertSupportedSnapshot(snapshot: AutomationExecutionSnapshot): void {
  if (!isSupportedAutomationVersion(snapshot.protocolVersion, snapshot.irVersion)
    || snapshot.compiledPlan.irVersion !== snapshot.irVersion) {
    throw new Error(`unsupported execution snapshot protocol/IR ${snapshot.protocolVersion}/${snapshot.irVersion}/${snapshot.compiledPlan.irVersion}`)
  }
  if (snapshot.purpose === 'draft-test' && snapshot.localTest
    && (snapshot.protocolVersion !== 2 || snapshot.irVersion !== 2 || snapshot.localTest.version !== 1)) {
    throw new Error('unsupported local test snapshot protocol or scope version')
  }
  for (const instruction of Object.values(snapshot.compiledPlan.instructions)) {
    if (!instruction || (!structuredInstructionOps.has(instruction.op)
      && !(snapshot.irVersion === 2 && graphInstructionOps.has(instruction.op)))) {
      throw new Error(`unsupported execution instruction ${instruction?.op} for IR ${snapshot.irVersion}`)
    }
    if (instruction.op === 'graph_value') {
      const sample = snapshot.purpose === 'draft-test' && snapshot.localTest?.version === 1
        ? snapshot.localTest.samples.find(item => item.id === instruction.sampleId && item.nodeId === instruction.id) : undefined
      if (snapshot.protocolVersion !== 2 || !sample || canonicalize(sample.value) !== canonicalize(instruction.value)) {
        throw new Error('sample substitutions require an explicit immutable local test snapshot')
      }
    }
  }
  if (snapshot.irVersion === 1) {
    const pending: ControlSource[] = [snapshot.source.flow]
    while (pending.length) {
      const control = pending.pop()!
      switch (control.type) {
        case 'graph': throw new Error('Graph source requires protocol/IR 2')
        case 'block': pending.push(...control.steps); break
        case 'if': pending.push(control.then); if (control.else) pending.push(control.else); break
        case 'parallel': case 'race': pending.push(...control.branches); break
        case 'foreach': pending.push(control.body); break
      }
    }
  }
}

declare module 'cordis' {
  interface Context {
    scheduler: SchedulerService
  }

  interface Events {
    'numen/run-change'(runId: string): void
  }
}

export function id(prefix: string): string {
  return nextId(prefix)
}

export function errorValue(error: unknown): NumenValue {
  if (error instanceof Error) {
    return { name: error.name, message: error.message }
  }
  return { name: 'Error', message: String(error) }
}

export class InvocationTimeoutError extends Error {
  override name = 'InvocationTimeoutError'
}

export class InvocationCancelledError extends Error {
  override name = 'InvocationCancelledError'

  constructor(public readonly reason: CancellationReason) {
    super(`invocation cancelled: ${reason}`)
  }
}

export interface ActiveInvocation {
  runId: string
  controller: AbortController
}

export class SchedulerKernel {
  ready = false
  attention!: AttentionService
  readonly activeInvocations = new Map<string, ActiveInvocation>()
  // An abort ends the guarded execution, but an uncooperative Provider may still be
  // running. Keep its Run permit until the actual invocation settles locally.
  readonly pendingProviders = new Map<Promise<unknown>, string>()
  wakeDispatch: (() => void) | undefined
  readonly pendingRunChanges = new Set<string>()
  runChangeScheduled = false

  constructor(
    readonly ctx: Context,
    readonly inspection: RunInspectionRepository,
    readonly journal: RunJournal,
    readonly admissions: AdmissionRepository,
    readonly scopes: ScopeRepository,
    /** When false, tests drive the loop explicitly through dispatchUntilIdle(). */
    readonly autoDispatch: boolean,
  ) {}

  appendEvent(runId: string, type: string, payload: NumenValue, occurredAt = clockOf(this.ctx).nowIso(), notify = true): void {
    this.journal.appendEvent(runId, type, payload, occurredAt)
    if (type === 'RunFailed' || type === 'AttemptOutcomeUnknown' || type === 'ExecutionBlocked') {
      const details = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, NumenValue> : {}
      if (type !== 'ExecutionBlocked' || details.reason === 'OUTCOME_UNKNOWN') {
        const executionId = typeof details.executionId === 'string' ? details.executionId : undefined
        const nested = details.details && typeof details.details === 'object' && !Array.isArray(details.details) ? details.details as Record<string, NumenValue> : {}
        let attemptId = typeof details.attemptId === 'string' ? details.attemptId : typeof nested.attemptId === 'string' ? nested.attemptId : undefined
        if (!attemptId && executionId) attemptId = this.journal.latestAttemptId(executionId)
        this.attention.record(runId, type === 'RunFailed' ? 'FAILED' : 'OUTCOME_UNKNOWN', occurredAt, executionId, attemptId)
      }
    }
    if (notify) this.scheduleRunChange(runId)
  }

  readonly loggedRunStates = new Map<string, string>()

  scheduleRunChange(runId: string): void {
    this.pendingRunChanges.add(runId)
    if (this.runChangeScheduled) return
    this.runChangeScheduled = true
    queueMicrotask(() => {
      this.runChangeScheduled = false
      const runIds = [...this.pendingRunChanges]
      this.pendingRunChanges.clear()
      if (!this.ready) return
      for (const changedRunId of runIds) {
        const run = this.getRun(changedRunId)
        if (run && this.loggedRunStates.get(run.id) !== run.status) {
          this.loggedRunStates.set(run.id, run.status)
          if (this.loggedRunStates.size > 2000) this.loggedRunStates.delete(this.loggedRunStates.keys().next().value!)
          withLogContext({ runId: run.id, automationId: run.automationId, traceId: run.id }, () => {
            this.ctx.logger('scheduler')[run.status === 'FAILED' ? 'warn' : 'info']('Run %s', run.status)
          })
        }
        this.ctx.emit('numen/run-change', changedRunId)
        this.ctx.emit('numen/run-attention-change', changedRunId)
      }
    })
  }

  createExecution(
    runId: string,
    instructionId: string,
    parentExecutionId?: string,
    scopeExecutionId?: string,
    scopeBranch?: number,
    loopItem?: NumenValue,
    loopIndex?: number,
  ): string {
    const executionId = id('exec')
    const now = clockOf(this.ctx).nowIso()
    this.journal.insertExecution({
      id: executionId,
      runId,
      instructionId,
      ...(parentExecutionId === undefined ? {} : { parentExecutionId }),
      ...(scopeExecutionId === undefined ? {} : { scopeExecutionId }),
      ...(scopeBranch === undefined ? {} : { scopeBranch }),
      ...(loopItem === undefined ? {} : { loopItem }),
      ...(loopIndex === undefined ? {} : { loopIndex }),
      now,
    })
    this.appendEvent(runId, 'ExecutionCreated', { executionId, instructionId }, now)
    return executionId
  }

  nextRunnableExecutions(limit: number): Execution[] {
    return this.journal.nextRunnableExecutions(limit)
  }

  getExecutionRow(executionId: string): ExecutionRow | undefined {
    return this.journal.getExecutionRow(executionId)
  }

  getRevisionForExecution(execution: Execution): { run: Run; revision: AutomationExecutionSnapshot; instruction: CoreInstruction } {
    const run = this.getRun(execution.runId)
    if (!run) throw new Error(`run not found: ${execution.runId}`)
    const revision = this.ctx.automations.getExecutionSnapshot(run.revisionId)
    if (!revision) throw new Error(`revision not found: ${run.revisionId}`)
    const instruction = revision.compiledPlan.instructions[execution.instructionId]
    if (!instruction) throw new Error(`instruction not found: ${execution.instructionId}`)
    return { run, revision, instruction }
  }

  appendGraphBindings(
    scope: Execution,
    graph: GraphScopeInstruction,
    revision: AutomationExecutionSnapshot,
    steps: Record<string, NumenValue>,
    consumer?: string,
    visited = new Set<string>(),
  ): void {
    if (visited.has(scope.id)) throw new Error('cyclic graph scope ancestry')
    visited.add(scope.id)
    const enclosing = scope.scopeExecutionId ? this.getExecutionRow(scope.scopeExecutionId) : undefined
    if (enclosing && revision.compiledPlan.instructions[enclosing.instruction_id]?.op === 'graph_iterate') {
      const outer = enclosing.scope_execution_id ? this.getExecutionRow(enclosing.scope_execution_id) : undefined
      const outerGraph = outer ? revision.compiledPlan.instructions[outer.instruction_id] : undefined
      if (!outer || outerGraph?.op !== 'graph_scope' || outer.run_id !== scope.runId) throw new Error('graph iteration enclosing scope missing')
      // Only the hosting iteration's dependency ancestors are visible in its body, from this exact outer instance.
      this.appendGraphBindings(mapExecution(outer), outerGraph, revision, steps, enclosing.instruction_id, visited)
    }
    const allowed = consumer === undefined ? undefined : new Set<string>()
    if (allowed && consumer) {
      const pending = [consumer]
      for (let index = 0; index < pending.length; index++) {
        for (const edge of graph.edges) {
          if (edge.to.nodeId !== pending[index] || edge.from.nodeId === graph.id || allowed.has(edge.from.nodeId)) continue
          allowed.add(edge.from.nodeId)
          pending.push(edge.from.nodeId)
        }
      }
    }
    const rows = this.journal.completedGraphMemberOutputs(scope.id)
    for (const row of rows) {
      if (!row.instruction_id.startsWith('__') && (!allowed || allowed.has(row.instruction_id))) steps[row.instruction_id] = parseJson(row.output_json)
    }
  }

  createBindings(run: Run, execution?: Execution): EvaluationBindings {
    const steps: Record<string, NumenValue> = Object.create(null)
    const revision = execution ? this.ctx.automations.getExecutionSnapshot(run.revisionId) : undefined
    const parent = execution?.scopeExecutionId ? this.getExecutionRow(execution.scopeExecutionId) : undefined
    const ownInstruction = execution ? revision?.compiledPlan.instructions[execution.instructionId] : undefined
    const parentInstruction = parent ? revision?.compiledPlan.instructions[parent.instruction_id] : undefined
    const graph = ownInstruction?.op === 'graph_scope' ? ownInstruction
      : parentInstruction?.op === 'graph_scope' ? parentInstruction : undefined
    if (graph && execution && revision) {
      const scope = ownInstruction?.op === 'graph_scope' ? execution : mapExecution(parent!)
      this.appendGraphBindings(scope, graph, revision, steps, ownInstruction?.op === 'graph_scope' ? undefined : execution.instructionId)
    } else {
      const rows = this.journal.completedRunOutputs(run.id)
      for (const row of rows) if (!row.instruction_id.startsWith('__')) steps[row.instruction_id] = parseJson(row.output_json)
    }

    if (execution && !graph) {
      const ancestors = this.journal.completedAncestorOutputs(execution.id)
      for (const row of ancestors) {
        if (!row.instruction_id.startsWith('__')) steps[row.instruction_id] = parseJson(row.output_json)
      }
    }
    return {
      run: {
        id: run.id,
        automationId: run.automationId,
        revisionId: run.revisionId,
      },
      trigger: run.trigger,
      input: run.input,
      steps,
      vars: {},
      loop: execution?.loopIndex === undefined
        ? {}
        : { item: execution.loopItem ?? null, index: execution.loopIndex },
      error: null,
    }
  }


  getRun(runId: string): Run | undefined {
    return this.inspection.getRun(runId)
  }

  connectionService(): ConnectionService | undefined {
    return this.ctx.get('connections') as ConnectionService | undefined
  }

  createSuccessor(execution: Execution, instructionId: string): string {
    return this.createExecution(
      execution.runId,
      instructionId,
      execution.id,
      execution.scopeExecutionId,
      execution.scopeBranch,
      execution.loopItem,
      execution.loopIndex,
    )
  }

commitOutputResources(execution: Execution, output: NumenValue): void {
    const resourceIds = new Set<string>()
    const visit = (value: NumenValue): void => {
      if (isResourceRef(value)) {
        resourceIds.add(value.$resource)
        return
      }
      if (Array.isArray(value)) {
        for (const item of value) visit(item)
        return
      }
      if (value && typeof value === 'object') {
        for (const item of Object.values(value)) visit(item)
      }
    }
    visit(output)
    for (const resourceId of resourceIds) {
      this.ctx.resources.commitOwner(resourceId, { type: 'execution', id: execution.id })
    }
  }
}