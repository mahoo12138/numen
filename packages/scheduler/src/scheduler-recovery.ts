import { capabilityKey, clockOf, type CancellationReason } from '@numenjs/core'
import { InvocationCancelledError, type SchedulerKernel } from './scheduler-kernel.js'

/**
 * Restart recovery and cancellation reconciliation. These run at init and on
 * every dispatch sweep; they only act on already-durable state.
 */

export class SchedulerRecovery {
  constructor(private readonly kernel: SchedulerKernel) {}

  propagateCancellation(runId: string, reason: CancellationReason): boolean {
    for (const active of this.kernel.activeInvocations.values()) {
      if (active.runId === runId && !active.controller.signal.aborted) {
        active.controller.abort(new InvocationCancelledError(reason))
      }
    }
    const rows = this.kernel.journal.listCancellableExecutions(runId)
    const now = clockOf(this.kernel.ctx).nowIso()
    return this.kernel.ctx.database.transaction(() => {
      this.kernel.journal.abortRunningAttemptsOfRun(runId, reason, now)
      this.kernel.journal.cancelOpenIterationsOfRun(runId, now)
      for (const row of rows) {
        if (this.kernel.journal.cancelExecution(row.id, now)) {
          this.kernel.appendEvent(runId, 'ExecutionCancelled', { executionId: row.id, reason }, now)
        }
      }
      if (!this.kernel.journal.finishCancellingRun(runId, reason, now)) return false
      this.kernel.appendEvent(runId, 'RunCancelled', { reason }, now)
      return true
    })
  }

  reconcileCancellations(): number {
    const rows = this.kernel.journal.listCancellingRuns()
    let count = 0
    for (const row of rows) {
      if (this.propagateCancellation(row.id, row.cancel_reason ?? 'USER')) count += 1
    }
    return count
  }

  recoverCancellations(): void {
    this.reconcileCancellations()
  }

  recoverInterruptedWork(): void {
    const attempts = this.kernel.journal.listInterruptedAttempts()

    for (const attempt of attempts) {
      const run = this.kernel.getRun(attempt.run_id)
      const revision = run ? this.kernel.ctx.automations.getExecutionSnapshot(run.revisionId) : undefined
      const instruction = revision?.compiledPlan.instructions[attempt.instruction_id]
      const contract = instruction?.op === 'invoke'
        ? revision?.contractSnapshot.capabilities.find(item => capabilityKey(item) === capabilityKey(instruction.capability))
        : undefined
      const retrySafe = contract?.semantics.retrySafe ?? false
      const now = clockOf(this.kernel.ctx).nowIso()
      this.kernel.ctx.database.transaction(() => {
        this.kernel.journal.settleInterruptedAttempt(attempt.id, attempt.execution_id, retrySafe, now)
        this.kernel.appendEvent(attempt.run_id, retrySafe ? 'AttemptInterrupted' : 'AttemptOutcomeUnknown', {
          attemptId: attempt.id,
          executionId: attempt.execution_id,
          retrySafe,
        }, now)
      })
    }


    const internal = this.kernel.journal.listInterruptedInternalExecutions()
    for (const row of internal) {
      const now = clockOf(this.kernel.ctx).nowIso()
      this.kernel.ctx.database.transaction(() => {
        this.kernel.journal.requeueRunning(row.id, now)
        this.kernel.appendEvent(row.run_id, 'ExecutionRecovered', { executionId: row.id }, now)
      })
    }
  }

}
