import '@numenjs/automation'
import '@numenjs/database'
import '@numenjs/resources'
import {
  clockOf,
  type Attempt,
  type CancellationReason,
  type Execution,
  type LocalTestRequest,
  type NumenValue,
  type ReplayPreview,
  type ReplayTarget,
  type Run,
  type RunAttentionFilters,
  type RunAttentionItem,
  type RunAttentionPage,
  type RunEvent,
  type StartReplayRequest,
  type TriggerAcceptance,
  type TriggerBinding,
  type TriggerEmission,
} from '@numenjs/core'
import { Service, type Context } from 'cordis'
import type { EvaluationBindings } from './evaluator.js'
import { AttentionService } from './attention.js'
import { ReplayService } from './replay.js'
import {
  RunInspectionRepository,
  type ExecutionListCursor,
  type RunEventPage,
  type RunExecutionDiagnosticsPage,
  type RunGraphMemberSummary,
  type RunListCursor,
  type RunListFilters,
  type RunStatusCounts,
  type RunSummaryPage,
  type SchedulerCounts,
} from './repository/inspection.js'
import { RunJournal } from './repository/journal.js'
import { AdmissionRepository } from './repository/admissions.js'
import { ScopeRepository } from './repository/scopes.js'
import { SchedulerKernel } from './scheduler-kernel.js'
import { SchedulerAdmission } from './scheduler-admission.js'
import { SchedulerExecutionEngine } from './scheduler-engine.js'
import { SchedulerRecovery } from './scheduler-recovery.js'
import { StructuredScopes } from './scheduler-structured.js'

export {
  ManualRunRequestConflictError,
  ManualRunRevisionConflictError,
  DraftTestResourceUnavailableError,
} from './scheduler-admission.js'

export interface SchedulerConfig {
  autoDispatch?: boolean
  sweepIntervalMs?: number
  maxConcurrentExecutions?: number
}

export interface SchedulerHealth extends SchedulerCounts {
  ready: boolean
}

export type {
  ExecutionListCursor,
  RunEventPage,
  RunExecutionDiagnostic,
  RunExecutionDiagnosticsPage,
  RunGraphMemberSummary,
  RunListCursor,
  RunListFilters,
  RunStatusCounts,
  RunSummary,
  RunSummaryPage,
} from './repository/inspection.js'

export interface RunInstructionExecutionSummary {
  instructionId: string
  statusCounts: Record<Execution['status'], number>
  sampledExecutionCount?: number
  latestUpdatedAt: string
}

export interface RunInspection {
  context: EvaluationBindings
  instructionExecutions: RunInstructionExecutionSummary[]
  graphMembers: RunGraphMemberSummary[]
}

/**
 * Public Scheduler facade. Admission, execution, structured scopes and restart
 * recovery are separate collaborators; this class keeps the stable service
 * surface, the dispatch loop, and the event/notification fan-out.
 */
export class SchedulerService extends Service {
  static inject = ['database', 'capabilities', 'automations', 'resources']

  private readonly kernel: SchedulerKernel
  private readonly admission: SchedulerAdmission
  private readonly recovery: SchedulerRecovery
  private readonly engine: SchedulerExecutionEngine
  private readonly structured: StructuredScopes
  private readonly attention: AttentionService
  private readonly replay: ReplayService
  private dispatchTask: Promise<number> | undefined
  private readonly activeExecutionTasks = new Map<string, Promise<void>>()
  private readonly autoDispatch: boolean
  private readonly sweepIntervalMs: number
  private readonly maxConcurrentExecutions: number

  constructor(ctx: Context, public config: SchedulerConfig = {}) {
    super(ctx, 'scheduler')
    this.autoDispatch = config.autoDispatch ?? true
    this.sweepIntervalMs = config.sweepIntervalMs ?? 1000
    this.maxConcurrentExecutions = config.maxConcurrentExecutions ?? 16
    if (!Number.isSafeInteger(this.maxConcurrentExecutions) || this.maxConcurrentExecutions < 1) {
      throw new TypeError('scheduler.maxConcurrentExecutions must be a positive integer')
    }

    this.kernel = new SchedulerKernel(
      ctx,
      new RunInspectionRepository(ctx.database),
      new RunJournal(ctx.database),
      new AdmissionRepository(ctx.database),
      new ScopeRepository(ctx.database),
      this.autoDispatch,
    )

    this.engine = new SchedulerExecutionEngine(this.kernel, {
      providerSettled: () => {
        this.kernel.wakeDispatch?.()
        if (this.autoDispatch) this.kick()
      },
    })
    this.structured = new StructuredScopes(this.kernel, this.engine)
    this.engine.structured = this.structured
    this.recovery = new SchedulerRecovery(this.kernel)
    this.admission = new SchedulerAdmission(this.kernel, this.engine, { kick: () => this.kick() })
    this.admission.recovery = this.recovery

    this.attention = new AttentionService(ctx, {
      acceptTrigger: (binding, emission) => this.acceptTrigger(binding, emission),
      changed: runId => this.kernel.scheduleRunChange(runId),
    })
    this.kernel.attention = this.attention
    this.replay = new ReplayService(ctx, {
      getRun: runId => this.getRun(runId),
      freezeAdmission: (...args) => this.admission.freezeAdmission(...args),
      appendEvent: (...args) => this.kernel.appendEvent(...args),
      onAccepted: runId => { this.kernel.scheduleRunChange(runId); if (this.autoDispatch) this.kick() },
    })
  }

  async *[Service.init]() {
    this.admission.recoverAdmissions()
    this.recovery.recoverCancellations()
    this.recovery.recoverInterruptedWork()
    this.structured.recoverStructuredScopes()
    this.structured.reconcileGraphScopes()
    this.kernel.ready = true
    let timer: NodeJS.Timeout | undefined
    if (this.autoDispatch) {
      this.ctx.on('numen/capability-change', () => this.kick())
      if (this.kernel.connectionService()) this.ctx.on('numen/connection-runtime-change', () => this.kick())
      timer = setInterval(() => this.kick(), this.sweepIntervalMs)
      timer.unref()
      queueMicrotask(() => this.kick())
    }
    yield () => {
      this.kernel.ready = false
      this.kernel.wakeDispatch?.()
      if (timer) clearInterval(timer)
    }
  }

  private get inspection(): RunInspectionRepository { return this.kernel.inspection }
  private get journal(): RunJournal { return this.kernel.journal }

  // Attention and Replay

  listAttention(filters: RunAttentionFilters = {}): RunAttentionPage { return this.attention.list(filters) }

  acknowledgeAttention(id: string, acknowledged = true): RunAttentionItem | undefined { return this.attention.acknowledge(id, acknowledged) }

  dispatchAttention(binding: TriggerBinding): number { return this.attention.dispatch(binding) }

  previewReplay(sourceRunId: string, target: ReplayTarget = 'original'): ReplayPreview { return this.replay.previewReplay(sourceRunId, target) }

  startReplay(request: StartReplayRequest): Promise<Run> { return this.replay.startReplay(request) }

  // Run acceptance

  startManual(
    automationId: string,
    input: Record<string, NumenValue> = {},
    trigger: NumenValue = { type: 'manual' },
    expectedRevisionId?: string,
    requestId?: string,
  ): Run {
    return this.admission.startRequestedRun(automationId, { mode: 'manual', ...(expectedRevisionId === undefined ? {} : { revisionId: expectedRevisionId }) }, input, trigger, requestId)
  }

  /** Runs an immutable published Revision without activating it or touching Trigger subscriptions. */
  startRevisionTest(
    automationId: string,
    revisionId: string,
    input: Record<string, NumenValue>,
    trigger: NumenValue,
    requestId: string,
  ): Run {
    return this.admission.startRequestedRun(automationId, { mode: 'revision-test', revisionId }, input, trigger, requestId)
  }

  /** Accepts a fixed saved Draft without publishing it or changing activation. */
  startDraftTest(
    automationId: string,
    expectedDraftVersion: number,
    input: Record<string, NumenValue>,
    trigger: NumenValue,
    requestId: string,
  ): Promise<Run> {
    return this.admission.startTest(automationId, expectedDraftVersion, input, trigger, requestId)
  }

  startLocalTest(input: LocalTestRequest & { previewHash: string; requestId: string }): Promise<Run> {
    return this.admission.startLocalTest(input)
  }

  acceptTrigger(binding: TriggerBinding, emission: TriggerEmission): TriggerAcceptance {
    return this.admission.acceptTrigger(binding, emission)
  }

  cancelRun(runId: string, reason: CancellationReason = 'USER'): Run {
    const existing = this.getRun(runId)
    if (!existing) throw new Error(`run not found: ${runId}`)
    if (existing.status === 'COMPLETED' || existing.status === 'FAILED' || existing.status === 'CANCELLED') {
      return existing
    }
    const now = clockOf(this.ctx).nowIso()
    this.ctx.database.transaction(() => {
      if (this.journal.requestRunCancellation(runId, reason)) this.kernel.appendEvent(runId, 'RunCancellationRequested', { reason }, now)
    })
    const cancellationReason = (this.getRun(runId)?.cancelReason as CancellationReason | undefined) ?? reason
    this.recovery.propagateCancellation(runId, cancellationReason)
    this.kernel.wakeDispatch?.()
    if (this.autoDispatch) this.kick()
    return this.getRun(runId)!
  }

  // Inspection

  getRun(runId: string): Run | undefined {
    return this.inspection.getRun(runId)
  }

  inspectRun(runId: string): RunInspection | undefined {
    const run = this.getRun(runId)
    if (!run) return
    const emptyCounts = (): Record<Execution['status'], number> => ({
      RUNNABLE: 0,
      RUNNING: 0,
      WAITING: 0,
      BLOCKED: 0,
      COMPLETED: 0,
      FAILED: 0,
      CANCELLING: 0,
      CANCELLED: 0,
      TIMED_OUT: 0,
    })
    const summaries = new Map<string, RunInstructionExecutionSummary>()
    const rows = this.inspection.instructionExecutionCounts(runId)
    for (const row of rows) {
      const summary = summaries.get(row.instruction_id) ?? {
        instructionId: row.instruction_id,
        statusCounts: emptyCounts(),
        latestUpdatedAt: row.latest_updated_at,
      }
      summary.statusCounts[row.status] = row.count
      if (row.sampled_count) summary.sampledExecutionCount = (summary.sampledExecutionCount ?? 0) + row.sampled_count
      if (row.latest_updated_at > summary.latestUpdatedAt) summary.latestUpdatedAt = row.latest_updated_at
      summaries.set(row.instruction_id, summary)
    }
    return {
      context: this.kernel.createBindings(run),
      instructionExecutions: [...summaries.values()],
      graphMembers: this.listGraphMembers(runId),
    }
  }

  listRuns(limit = 20): Run[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new TypeError('run list limit must be an integer between 1 and 100')
    }
    return this.inspection.listRuns(limit)
  }

  listRunSummariesPage(limit = 20, cursor?: RunListCursor, filters: RunListFilters = {}): RunSummaryPage {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
      throw new TypeError('run summary page limit must be an integer between 1 and 50')
    }
    if (cursor && (!cursor.createdAt || !cursor.id)) throw new TypeError('run summary cursor is invalid')
    if (filters.automationId !== undefined && (typeof filters.automationId !== 'string' || !filters.automationId)) throw new TypeError('automation filter is invalid')
    if (filters.status !== undefined && !['QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLING', 'CANCELLED'].includes(filters.status)) throw new TypeError('run status filter is invalid')
    return this.inspection.listRunSummariesPage(limit, cursor, filters)
  }

  getRunStatusCounts(automationId?: string): RunStatusCounts {
    return this.inspection.runStatusCounts(automationId)
  }

  getRunIdentity(runId: string): Pick<Run, 'id' | 'revisionId'> | undefined {
    return this.inspection.runIdentity(runId)
  }

  inspectExecution(runId: string, executionId: string, maxValueBytes = 65_536): {
    execution: Execution; inputOmitted: boolean; outputOmitted: boolean
  } | undefined {
    if (!Number.isSafeInteger(maxValueBytes) || maxValueBytes < 1 || maxValueBytes > 65_536) throw new TypeError('invalid execution inspection limit')
    // Bound JSON before parsing it. Loop values and errors are not part of this inspection surface.
    return this.inspection.inspectExecution(runId, executionId, maxValueBytes)
  }

  getAttempt(runId: string, executionId: string, attemptId: string): Pick<Attempt, 'id' | 'executionId' | 'number' | 'status'> | undefined {
    return this.inspection.getAttempt(runId, executionId, attemptId)
  }

  listGraphMembers(runId: string): RunGraphMemberSummary[] {
    return this.inspection.listGraphMembers(runId)
  }

  listExecutions(runId: string): Execution[] {
    return this.inspection.listExecutions(runId)
  }

  listExecutionDiagnosticsPage(
    runId: string,
    limit = 25,
    cursor?: ExecutionListCursor,
    filter: { instructionIds?: string[]; executionId?: string } = {},
  ): RunExecutionDiagnosticsPage {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
      throw new TypeError('execution diagnostics page limit must be an integer between 1 and 50')
    }
    if (cursor && (!cursor.createdAt || !cursor.id)) {
      throw new TypeError('execution diagnostics cursor is invalid')
    }
    return this.inspection.executionDiagnosticsPage(runId, limit, cursor, filter)
  }

  listAttempts(runId: string): Attempt[] {
    return this.inspection.listAttempts(runId)
  }

  listEvents(runId: string): RunEvent[] {
    return this.inspection.listEvents(runId)
  }

  listRunEventsPage(runId: string, limit = 50, beforeSequence?: number): RunEventPage {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new TypeError('run event page limit must be an integer between 1 and 100')
    }
    if (beforeSequence !== undefined && (!Number.isSafeInteger(beforeSequence) || beforeSequence < 1)) {
      throw new TypeError('run event cursor must be a positive integer')
    }
    return this.inspection.runEventsPage(runId, limit, beforeSequence)
  }

  health(): SchedulerHealth {
    return { ready: this.kernel.ready, ...this.inspection.counts() }
  }

  // Dispatch

  dispatchUntilIdle(maxTransitions = 1000): Promise<number> {
    if (this.dispatchTask) {
      this.kernel.wakeDispatch?.()
      return this.dispatchTask
    }
    const task = this.runDispatchLoop(maxTransitions)
    this.dispatchTask = task.finally(() => {
      this.dispatchTask = undefined
    })
    return this.dispatchTask
  }

  private kick(): void {
    if (!this.kernel.ready) return
    this.kernel.wakeDispatch?.()
    queueMicrotask(() => {
      this.dispatchUntilIdle().catch(error => this.ctx.logger('scheduler').error(error))
    })
  }

  private async runDispatchLoop(maxTransitions: number): Promise<number> {
    let transitions = 0
    while (this.kernel.ready && transitions < maxTransitions) {
      let progressed = false
      const cancelled = this.recovery.reconcileCancellations()
      const resumed = this.engine.resumeDueTimers()
      const unblocked = this.engine.reconcileBlockedExecutions()
      const graphs = this.structured.reconcileGraphScopes()
      if (cancelled || resumed || unblocked || graphs) {
        transitions += cancelled + resumed + unblocked + graphs
        progressed = true
      }
      if (this.admission.admitOneRun()) {
        transitions += 1
        progressed = true
      }
      const availableSlots = this.maxConcurrentExecutions - this.activeExecutionTasks.size
      const executions = availableSlots > 0 ? this.journal.nextRunnableExecutions(availableSlots) : []
      if (executions.length) {
        for (const execution of executions) {
          const task = this.engine.execute(execution).finally(() => {
            this.activeExecutionTasks.delete(execution.id)
          })
          this.activeExecutionTasks.set(execution.id, task)
        }
        transitions += executions.length
        progressed = true
      }
      // Drain admissions and runnable work before awaiting a long invocation.
      // New accepted Runs can wake this same loop while a Provider is pending.
      if (progressed) continue
      if (!this.activeExecutionTasks.size) return transitions
      const wake = new Promise<void>(resolve => { this.kernel.wakeDispatch = resolve })
      try { await Promise.race([...this.activeExecutionTasks.values(), wake]) }
      finally { this.kernel.wakeDispatch = undefined }
    }
    if (!this.kernel.ready) return transitions
    throw new Error(`scheduler exceeded ${maxTransitions} transitions without becoming idle`)
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
