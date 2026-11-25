import {
  CapabilityInvocationError,
  capabilityKey,
  clockOf,
  isNumenValue,
  nextId,
  type CancellationReason,
  type ContractSnapshotCapability,
  type CoreInstruction,
  type Execution,
  type NumenValue,
} from '@numenjs/core'
import { ConnectionBindingError, ConnectionRuntimeUnavailableError } from '@numenjs/connections'
import { withLogContext } from '@numenjs/logging'
import { evaluateExpression, type EvaluationBindings } from './evaluator.js'
import { mapExecution } from './repository/rows.js'
import {
  InvocationCancelledError,
  InvocationTimeoutError,
  assertSupportedSnapshot,
  errorValue,
  id,
  type SchedulerKernel,
} from './scheduler-kernel.js'
import type { StructuredScopes } from './scheduler-structured.js'

/**
 * Runs one Execution at a time: instruction dispatch, Provider invocation with
 * timeout/abort guards, Attempt journaling, and the terminal transitions of an
 * Execution or its Run. Cross-cutting scope work is delegated.
 */

export interface ExecutionHost {
  /** A Provider settled locally; the Run's admission permit can be released. */
  providerSettled(): void
}

export class SchedulerExecutionEngine {
  constructor(
    private readonly kernel: SchedulerKernel,
    private readonly host: ExecutionHost,
  ) {}

  structured!: StructuredScopes

  async execute(execution: Execution): Promise<void> {
    try {
      const { run, revision, instruction } = this.kernel.getRevisionForExecution(execution)
      assertSupportedSnapshot(revision)
      const bindings = this.kernel.createBindings(run, execution)
      switch (instruction.op) {
        case 'invoke': {
          const contract = revision.contractSnapshot.capabilities.find(item => (
            capabilityKey(item) === capabilityKey(instruction.capability)
          ))
          if (!contract) throw new Error(`frozen capability contract not found: ${capabilityKey(instruction.capability)}`)
          await this.invokeCapability(execution, instruction, bindings, contract)
          break
        }
        case 'graph_scope':
          this.structured.beginGraphScope(execution, instruction)
          break
        case 'graph_condition': {
          const condition = evaluateExpression(instruction.condition, bindings)
          if (typeof condition !== 'boolean') throw new Error('graph condition must evaluate to boolean')
          this.completeInternal(execution, undefined, condition)
          break
        }
        case 'graph_merge':
          this.completeInternal(execution, undefined, this.structured.graphMergeOutput(execution, instruction))
          break
        case 'graph_value':
          this.completeSample(execution, instruction)
          break
        case 'branch': {
          const condition = evaluateExpression(instruction.condition, bindings)
          if (typeof condition !== 'boolean') throw new Error('branch condition must evaluate to boolean')
          this.completeInternal(execution, condition ? instruction.then : instruction.else, condition)
          break
        }
        case 'suspend':
          this.suspendTimer(execution, instruction, bindings)
          break
        case 'fork':
          this.structured.forkAll(execution, instruction)
          break
        case 'iterate':
        case 'graph_iterate':
          this.structured.beginIterate(execution, instruction, bindings)
          break
        case 'scope_complete':
          this.structured.completeScope(execution)
          break
        case 'join':
          this.completeInternal(execution, instruction.next, null)
          break
        case 'complete': {
          const output = instruction.output ? evaluateExpression(instruction.output, bindings) : null
          this.completeRun(execution, output)
          break
        }
        case 'fail':
          this.failExecution(execution, evaluateExpression(instruction.error, bindings))
          break
        case 'eval':
          this.failExecution(execution, { code: 'EVAL_ASSIGN_NOT_IMPLEMENTED', assign: instruction.assign })
          break
        default:
          this.failExecution(execution, { code: 'INSTRUCTION_NOT_SUPPORTED' })
      }
    } catch (error) {
      this.failExecution(execution, errorValue(error))
    }
  }

  async invokeCapability(
    execution: Execution,
    instruction: Extract<CoreInstruction, { op: 'invoke' }>,
    bindings: EvaluationBindings,
    contract: ContractSnapshotCapability,
  ): Promise<void> {
    const status = this.kernel.ctx.capabilities.get(instruction.capability)
    const provider = this.kernel.ctx.capabilities.resolveProvider<NumenValue, NumenValue>(instruction.capability)
    if (!status || !provider) {
      this.blockExecution(execution, 'PROVIDER_UNAVAILABLE', { capability: capabilityKey(instruction.capability) })
      return
    }
    const evaluatedInput = evaluateExpression(instruction.input, bindings)
    const resolvedInput = status.definition.input(evaluatedInput)
    if (!isNumenValue(resolvedInput)) throw new Error('capability input normalized to a non-Numen value')
    const connectionIds = instruction.connections ?? (instruction.connection ? { default: instruction.connection } : {})
    let connections: Record<string, unknown>
    try {
      const connectionService = this.kernel.connectionService()
      if (!connectionService && Object.keys(connectionIds).length) throw new ConnectionBindingError('ConnectionService is unavailable')
      connections = connectionService?.resolveRuntimes(connectionIds, contract.connections ?? []) ?? {}
    } catch (error) {
      if (error instanceof ConnectionRuntimeUnavailableError || error instanceof ConnectionBindingError) {
        this.blockExecution(execution, 'CONNECTION_UNAVAILABLE', {
          capability: capabilityKey(instruction.capability),
          error: error.message,
        })
        return
      }
      throw error
    }

    const attemptId = id('attempt')
    let attemptNumber = 0
    const now = clockOf(this.kernel.ctx).nowIso()
    const claimedGeneration = this.kernel.ctx.database.transaction(() => {
      if (!this.executionAcceptsWork(execution, 'RUNNABLE')) return
      const generation = this.kernel.journal.claimForInvocation(execution, resolvedInput, now)
      if (generation === undefined) return
      const number = this.kernel.journal.nextAttemptNumber(execution.id)
      attemptNumber = number
      this.kernel.journal.insertAttempt(attemptId, execution.id, number, capabilityKey(instruction.capability), now)
      this.kernel.appendEvent(execution.runId, 'AttemptStarted', { attemptId, executionId: execution.id, number }, now)
      return generation
    })
    if (claimedGeneration === undefined) return
    const invocation = { ...execution, generation: claimedGeneration }

    const run = this.kernel.getRun(execution.runId)
    const logMetadata = {
      ...(run ? { automationId: run.automationId } : {}), runId: execution.runId,
      executionId: execution.id, attemptId, traceId: execution.runId,
      ...(Object.keys(connectionIds).length === 1 ? { connectionId: Object.values(connectionIds)[0]! } : {}),
    }
    withLogContext(logMetadata, () => this.kernel.ctx.logger('scheduler').info('Attempt started'))
    const controller = new AbortController()
    this.kernel.activeInvocations.set(execution.id, { runId: execution.runId, controller })
    const timeoutMs = instruction.policy?.timeoutMs ?? contract.semantics.defaultTimeoutMs
    try {
      const output = await this.invokeWithGuards(() => withLogContext(logMetadata, () => provider.invoke({
          input: resolvedInput,
          connections,
          signal: controller.signal,
          idempotencyKey: attemptId,
        })), controller, timeoutMs, execution.runId)
      const validatedOutput = status.definition.output(output)
      if (!isNumenValue(validatedOutput)) throw new Error('capability output is not a Numen value')
      if (this.completeInvocation(invocation, attemptId, instruction.next, validatedOutput)) {
        withLogContext(logMetadata, () => this.kernel.ctx.logger('scheduler').info('Attempt completed'))
      }
    } catch (error) {
      if (error instanceof InvocationCancelledError) return
      const timedOut = error instanceof InvocationTimeoutError
      const accepted = this.settleFailedInvocation(
        invocation,
        attemptId,
        attemptNumber,
        instruction,
        contract.semantics.retrySafe,
        timedOut ? 'TIMED_OUT' : error instanceof CapabilityInvocationError && error.outcome === 'unknown' && !contract.semantics.retrySafe ? 'OUTCOME_UNKNOWN' : 'FAILED',
        errorValue(error),
      )
      if (accepted) withLogContext(logMetadata, () => this.kernel.ctx.logger('scheduler').warn(timedOut ? 'Attempt timed out' : 'Attempt failed'))
    } finally {
      this.kernel.activeInvocations.delete(execution.id)
    }
  }

  async invokeWithGuards<T>(
    invoke: () => Promise<T>,
    controller: AbortController,
    timeoutMs?: number,
    runId?: string,
  ): Promise<T> {
    let timer: NodeJS.Timeout | undefined
    let onAbort: (() => void) | undefined
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => {
        const reason = controller.signal.reason
        reject(reason instanceof Error ? reason : new InvocationCancelledError('USER'))
      }
      if (controller.signal.aborted) {
        onAbort()
      } else {
        controller.signal.addEventListener('abort', onAbort, { once: true })
      }
    })
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        controller.abort(new InvocationTimeoutError(`capability timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      timer.unref()
    }
    try {
      const invocation = Promise.resolve().then(() => {
        if (controller.signal.aborted) throw controller.signal.reason
        return invoke()
      })
      if (runId) {
        this.kernel.pendingProviders.set(invocation, runId)
        const settled = () => {
          this.kernel.pendingProviders.delete(invocation)
          this.host.providerSettled()
        }
        void invocation.then(settled, settled)
      }
      return await Promise.race([invocation, aborted])
    } finally {
      if (timer) clearTimeout(timer)
      if (onAbort) controller.signal.removeEventListener('abort', onAbort)
    }
  }

  /** Called under an immediate transaction before claiming or accepting an invocation. */
  executionAcceptsWork(execution: Execution, status: 'RUNNABLE' | 'RUNNING' | 'WAITING'): boolean {
    return this.kernel.journal.executionAcceptsWork(execution, status)
  }

  invocationAcceptsResult(execution: Execution, attemptId: string): boolean {
    if (!this.executionAcceptsWork(execution, 'RUNNING')) return false
    return this.kernel.journal.isLatestRunningAttempt(execution.id, attemptId)
  }


  completeInvocation(execution: Execution, attemptId: string, next: string | undefined, output: NumenValue): boolean {
    const now = clockOf(this.kernel.ctx).nowIso()
    return this.kernel.ctx.database.transaction(() => {
      if (!this.invocationAcceptsResult(execution, attemptId)) return false
      if (!this.kernel.journal.succeedAttempt(execution.id, attemptId, now)) return false
      // A missed Execution CAS must also roll back the Attempt transition.
      if (!this.kernel.journal.completeRunningExecution(execution, output, now)) throw new Error('invocation generation changed during completion')
      this.kernel.commitOutputResources(execution, output)
      this.kernel.appendEvent(execution.runId, 'ExecutionCompleted', { executionId: execution.id, output }, now)
      if (next) this.kernel.createSuccessor(execution, next)
      return true
    })
  }

  settleFailedInvocation(
    execution: Execution,
    attemptId: string,
    attemptNumber: number,
    instruction: Extract<CoreInstruction, { op: 'invoke' }>,
    retrySafe: boolean,
    attemptStatus: 'FAILED' | 'TIMED_OUT' | 'OUTCOME_UNKNOWN',
    error: NumenValue,
  ): boolean {
    const now = clockOf(this.kernel.ctx).nowIso()
    const retry = instruction.policy?.retry
    const canRetry = retrySafe && attemptNumber < (retry?.maxAttempts ?? 1)
    const outcomeUnknown = (attemptStatus === 'TIMED_OUT' || attemptStatus === 'OUTCOME_UNKNOWN') && !retrySafe
    const attemptEvent = attemptStatus === 'TIMED_OUT' ? 'AttemptTimedOut' : attemptStatus === 'OUTCOME_UNKNOWN' ? 'AttemptOutcomeUnknown' : 'AttemptFailed'
    return this.kernel.ctx.database.transaction(() => {
      if (!this.invocationAcceptsResult(execution, attemptId)) return false
      if (!this.kernel.journal.finishAttempt(execution.id, attemptId, attemptStatus, error, now)) return false
      this.kernel.appendEvent(execution.runId, attemptEvent, { attemptId, executionId: execution.id, error }, now)

      if (outcomeUnknown) {
        if (!this.kernel.journal.blockUnknownOutcome(execution, error, now)) throw new Error('invocation generation changed during failure settlement')
        this.kernel.appendEvent(execution.runId, 'ExecutionBlocked', {
          executionId: execution.id,
          reason: 'OUTCOME_UNKNOWN',
          details: { attemptId, error },
        }, now)
        return true
      }

      if (canRetry) {
        const backoffMs = (retry?.backoffMs ?? 0) * (2 ** (attemptNumber - 1))
        const wakeAt = new Date(clockOf(this.kernel.ctx).nowMs() + backoffMs).toISOString()
        if (!this.kernel.journal.scheduleRetry(execution, wakeAt, error, now)) throw new Error('invocation generation changed during failure settlement')
        this.kernel.appendEvent(execution.runId, 'ExecutionRetryScheduled', {
          executionId: execution.id,
          attemptId,
          nextAttempt: attemptNumber + 1,
          wakeAt,
        }, now)
        return true
      }

      const executionStatus = attemptStatus === 'TIMED_OUT' ? 'TIMED_OUT' : 'FAILED'
      if (!this.kernel.journal.failRunningExecution(execution, executionStatus, error, now)) throw new Error('invocation generation changed during failure settlement')
      const runFailed = this.structured.handleStructuredFailure(execution, now, error)
      if (runFailed) this.kernel.journal.finishRunningRun(execution.runId, 'FAILED', now)
      this.kernel.appendEvent(execution.runId, 'ExecutionFailed', {
        executionId: execution.id,
        status: executionStatus,
        error,
      }, now)
      if (runFailed) this.kernel.appendEvent(execution.runId, 'RunFailed', { executionId: execution.id, error }, now)
      return true
    })
  }

  completeInternal(execution: Execution, next: string | undefined, output: NumenValue): void {
    const now = clockOf(this.kernel.ctx).nowIso()
    this.kernel.ctx.database.transaction(() => {
      if (!this.kernel.journal.completeRunnable(execution.id, output, now)) return
      this.kernel.commitOutputResources(execution, output)
      this.kernel.appendEvent(execution.runId, 'ExecutionCompleted', { executionId: execution.id, output }, now)
      if (next) this.kernel.createSuccessor(execution, next)
    })
  }

  completeSample(execution: Execution, instruction: Extract<CoreInstruction, { op: 'graph_value' }>): void {
    const now = clockOf(this.kernel.ctx).nowIso()
    this.kernel.ctx.database.transaction(() => {
      if (!this.executionAcceptsWork(execution, 'RUNNABLE')) return
      if (!this.kernel.journal.completeRunnableWithSample(execution.id, instruction.value, instruction.sampleId, now)) return
      this.kernel.appendEvent(execution.runId, 'ExecutionSampled', { executionId: execution.id, nodeId: instruction.id, sampleId: instruction.sampleId }, now)
    })
  }

  completeRun(execution: Execution, output: NumenValue): void {
    const now = clockOf(this.kernel.ctx).nowIso()
    this.kernel.ctx.database.transaction(() => {
      if (!this.kernel.journal.completeRunnable(execution.id, output, now)) return
      this.kernel.commitOutputResources(execution, output)
      this.kernel.journal.finishRunningRun(execution.runId, 'COMPLETED', now)
      this.kernel.appendEvent(execution.runId, 'ExecutionCompleted', { executionId: execution.id, output }, now)
      this.kernel.appendEvent(execution.runId, 'RunCompleted', { output }, now)
    })
  }

  failExecution(execution: Execution, error: NumenValue): void {
    const now = clockOf(this.kernel.ctx).nowIso()
    this.kernel.ctx.database.transaction(() => {
      if (!this.kernel.journal.failActiveExecution(execution.id, error, now)) return
      const runFailed = this.structured.handleStructuredFailure(execution, now, error)
      if (runFailed) this.kernel.journal.finishRunningRun(execution.runId, 'FAILED', now)
      this.kernel.appendEvent(execution.runId, 'ExecutionFailed', { executionId: execution.id, error }, now)
      if (runFailed) this.kernel.appendEvent(execution.runId, 'RunFailed', { executionId: execution.id, error }, now)
    })
  }

  blockExecution(execution: Execution, reason: string, details: NumenValue): void {
    const now = clockOf(this.kernel.ctx).nowIso()
    this.kernel.ctx.database.transaction(() => {
      if (!this.kernel.journal.blockRunnable(execution.id, reason, now)) return
      this.kernel.appendEvent(execution.runId, 'ExecutionBlocked', { executionId: execution.id, reason, details }, now)
    })
  }

  suspendTimer(
    execution: Execution,
    instruction: Extract<CoreInstruction, { op: 'suspend' }>,
    bindings: EvaluationBindings,
  ): void {
    const nowMs = clockOf(this.kernel.ctx).nowMs()
    let wakeAtMs: number
    if (instruction.config.durationMs) {
      const duration = evaluateExpression(instruction.config.durationMs, bindings)
      if (typeof duration !== 'number' || duration < 0) throw new Error('timer duration must be a non-negative number')
      wakeAtMs = nowMs + duration
    } else if (instruction.config.until) {
      const until = evaluateExpression(instruction.config.until, bindings)
      if (typeof until !== 'string') throw new Error('timer until must evaluate to an ISO date string')
      wakeAtMs = Date.parse(until)
      if (!Number.isFinite(wakeAtMs)) throw new Error('timer until is not a valid date')
    } else {
      throw new Error('timer has no wake source')
    }
    const wakeAt = new Date(wakeAtMs).toISOString()
    const now = new Date(nowMs).toISOString()
    this.kernel.ctx.database.transaction(() => {
      if (!this.kernel.journal.suspendRunnable(execution.id, wakeAt, now)) return
      this.kernel.appendEvent(execution.runId, 'ExecutionWaiting', { executionId: execution.id, wakeAt }, now)
    })
  }


  resumeDueTimers(): number {
    const now = clockOf(this.kernel.ctx).nowIso()
    const rows = this.kernel.journal.dueWaitingExecutions(now)
    let count = 0
    for (const row of rows) {
      const execution = mapExecution(row)
      if (row.blocked_reason === 'RETRY_BACKOFF') {
        const changed = this.kernel.ctx.database.transaction(() => {
          if (!this.kernel.journal.readyRetry(execution.id, now)) return false
          this.kernel.appendEvent(execution.runId, 'ExecutionRetryReady', { executionId: execution.id }, now)
          return true
        })
        if (changed) count += 1
        continue
      }
      const { instruction } = this.kernel.getRevisionForExecution(execution)
      if (instruction.op !== 'suspend') continue
      const changed = this.kernel.ctx.database.transaction(() => {
        if (!this.kernel.journal.resumeWaiting(execution.id, now)) return false
        this.kernel.appendEvent(execution.runId, 'ExecutionResumed', { executionId: execution.id }, now)
        if (instruction.next) this.kernel.createSuccessor(execution, instruction.next)
        return true
      })
      if (changed) count += 1
    }
    return count
  }

  reconcileBlockedExecutions(): number {
    const rows = this.kernel.journal.listUnavailableBlocked()
    let count = 0
    for (const row of rows) {
      const execution = mapExecution(row)
      const { revision, instruction } = this.kernel.getRevisionForExecution(execution)
      if (instruction.op !== 'invoke' || !this.kernel.ctx.capabilities.resolveProvider(instruction.capability)) continue
      if (row.blocked_reason === 'CONNECTION_UNAVAILABLE') {
        const contract = revision.contractSnapshot.capabilities.find(item => capabilityKey(item) === capabilityKey(instruction.capability))
        if (!contract) continue
        try {
          const connectionService = this.kernel.connectionService()
          if (!connectionService) continue
          connectionService.resolveRuntimes(
            instruction.connections ?? (instruction.connection ? { default: instruction.connection } : {}),
            contract.connections ?? [],
          )
        } catch {
          continue
        }
      }
      const now = clockOf(this.kernel.ctx).nowIso()
      const changed = this.kernel.ctx.database.transaction(() => {
        if (!this.kernel.journal.unblock(execution.id, row.blocked_reason!, now)) return false
        this.kernel.appendEvent(execution.runId, 'ExecutionUnblocked', { executionId: execution.id }, now)
        return true
      })
      if (changed) count += 1
    }
    return count
  }

}
