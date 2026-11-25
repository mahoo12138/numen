import { defineCapability, type TriggerProvider } from '@numenjs/core'
import '@numenjs/scheduler'
import type { Context } from 'cordis'
import z from 'schemastery'

export interface RunEventsIntegrationConfig {
  reconcileIntervalMs?: number
}

export const runAttentionTrigger = defineCapability({
  id: 'run:attention', version: 1, kind: 'trigger', title: 'Run Needs Attention',
  description: 'Notify when a formal Run fails or an external outcome is unknown. Notifications are durable; notification Runs never recursively notify.',
  input: z.object({
    kinds: z.array(z.union(['FAILED', 'OUTCOME_UNKNOWN'])).min(1).max(2).default(['FAILED', 'OUTCOME_UNKNOWN'])
      .description('Final failure, unknown external outcome, or both. Intermediate retry failures and test Runs are excluded.'),
    automationIds: z.array(z.string().pattern(/^auto_[a-f0-9]{32}$/)).max(100).default([])
      .description('Source Automation IDs. An empty list includes all formal Automations. Notification Runs remain excluded.'),
  }),
  output: z.object({
    attentionId: z.string().required(),
    kind: z.union(['FAILED', 'OUTCOME_UNKNOWN']).required(),
    automationId: z.string().required(),
    automationName: z.string().required(),
    runId: z.string().required(),
    revisionId: z.string().required(),
    executionId: z.string(),
    attemptId: z.string(),
    occurredAt: z.string().required(),
    summary: z.string().required().description('Safe classification text; no raw error message, input, output, or credentials.'),
    runPath: z.string().required().description('Relative Workbench path. Prefix it with your configured Workbench address when composing a notification.'),
  }),
  semantics: { sideEffect: false, idempotent: true, retrySafe: true },
})

export function runEventsIntegrationPlugin(ctx: Context, config: RunEventsIntegrationConfig = {}): void {
  const intervalMs = config.reconcileIntervalMs ?? 1000
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 100 || intervalMs > 60_000) {
    throw new TypeError('runEvents.reconcileIntervalMs must be an integer between 100 and 60000')
  }
  ctx.capabilities.define(ctx, runAttentionTrigger)
  ctx.capabilities.provideTrigger(ctx, runAttentionTrigger, {
    activate({ binding, signal, reportStatus }) {
      let disposed = false
      let scheduled = false
      let failed = false
      const drain = () => {
        scheduled = false
        if (disposed || signal.aborted) return
        try {
          // The Scheduler validates this exact binding and commits the delivery
          // receipt, trusted provenance and accepted Run in a single transaction.
          // Ordinary emit() cannot establish that atomic, cross-Revision receipt.
          ctx.scheduler.dispatchAttention(binding)
          failed = false
          reportStatus?.('READY')
        } catch {
          if (!failed) ctx.logger('run-events').warn('Run attention delivery is unavailable; pending deliveries remain durable.')
          failed = true
          reportStatus?.('ERROR')
        }
      }
      const wake = () => {
        if (scheduled || disposed || signal.aborted) return
        scheduled = true
        queueMicrotask(drain)
      }
      const disposeAttention = ctx.on('numen/run-attention-change', wake)
      const disposeAutomation = ctx.on('numen/automation-change', wake)
      const timer = setInterval(wake, intervalMs)
      timer.unref()
      const dispose = () => {
        if (disposed) return
        disposed = true
        clearInterval(timer)
        disposeAttention()
        disposeAutomation()
        signal.removeEventListener('abort', dispose)
      }
      signal.addEventListener('abort', dispose, { once: true })
      wake()
      return dispose
    },
  } satisfies TriggerProvider)
}

runEventsIntegrationPlugin.inject = ['capabilities', 'scheduler']
runEventsIntegrationPlugin.Config = z.object({
  reconcileIntervalMs: z.natural().min(100).max(60_000).default(1000)
    .description('Interval for recovering pending attention deliveries. Live events also wake delivery immediately.'),
})

export default runEventsIntegrationPlugin
