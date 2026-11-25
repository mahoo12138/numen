import '@numenjs/automation'
import { ReplayError } from '@numenjs/scheduler'
import { ConsoleProcedureError, type ConsoleActionDefinition, type ConsoleQueryDefinition } from '@numenjs/console'
import type { Context } from 'cordis'
import z from 'schemastery'
import {
  workbenchAttentionQueryRef, workbenchAcknowledgeAttentionActionRef,
  workbenchReplayPreviewQueryRef, workbenchStartReplayActionRef,
  type WorkbenchAttentionInput, type WorkbenchAttentionItem, type WorkbenchAttentionPage,
  type WorkbenchAcknowledgeAttentionInput, type WorkbenchReplayPreviewInput,
  type WorkbenchReplayPreview, type WorkbenchStartReplayInput, type WorkbenchStartReplayResult,
} from './attention-contracts.js'

const target = z.union(['original', 'active']).required()
const runStatus = z.union(['QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLING', 'CANCELLED']).required()
const item = z.object({
  id: z.string().required(), sequence: z.number().required(), kind: z.union(['FAILED', 'OUTCOME_UNKNOWN']).required(),
  runId: z.string().required(), automationId: z.string().required(), revisionId: z.string().required(),
  executionId: z.string(), attemptId: z.string(), occurredAt: z.string().required(), acknowledgedAt: z.string(),
  summary: z.string().required(), automationName: z.string().required(), runStatus,
  notifications: z.array(z.object({
    automationId: z.string().required(), automationName: z.string().required(), triggerId: z.string().required(),
    runId: z.string(), status: z.union(['QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLING', 'CANCELLED', 'OUTCOME_UNKNOWN', 'PENDING', 'SKIPPED', 'DELETED']).required(), summary: z.string(),
  })).required(),
})

export const workbenchAttentionQuery: ConsoleQueryDefinition<WorkbenchAttentionInput, WorkbenchAttentionPage> = {
  ...workbenchAttentionQueryRef, kind: 'query', title: 'Runs needing attention',
  input: z.object({ automationId: z.string(), runId: z.string(), kind: z.union(['FAILED', 'OUTCOME_UNKNOWN']), acknowledged: z.boolean(), limit: z.number().step(1).min(1).max(100).default(20), beforeSequence: z.number().step(1).min(1) }),
  output: z.object({ items: z.array(item).required(), total: z.number().required(), unacknowledged: z.number().required(), nextCursor: z.number(), automations: z.array(z.object({ id: z.string().required(), name: z.string().required() })).required() }),
}
export const workbenchAcknowledgeAttentionAction: ConsoleActionDefinition<WorkbenchAcknowledgeAttentionInput, WorkbenchAttentionItem> = {
  ...workbenchAcknowledgeAttentionActionRef, kind: 'action', title: 'Acknowledge a Run exception',
  input: z.object({ id: z.string().required(), acknowledged: z.boolean().required() }), output: item,
}
export const workbenchReplayPreviewQuery: ConsoleQueryDefinition<WorkbenchReplayPreviewInput, WorkbenchReplayPreview> = {
  ...workbenchReplayPreviewQueryRef, kind: 'query', title: 'Preview a Run replay',
  input: z.object({ sourceRunId: z.string().required(), target }),
  output: z.object({ sourceRunId: z.string().required(), automationId: z.string().required(), target, revisionId: z.string(), revisionNumber: z.number(), requiresOutcomeConfirmation: z.boolean().required(), canReplay: z.boolean().required(), reason: z.string(), reasonCode: z.union([
    'SOURCE_NOT_FOUND', 'FORMAL_RUN_REQUIRED', 'SOURCE_NOT_TERMINAL', 'SOURCE_NOT_REPLAYABLE',
    'AUTOMATION_ARCHIVED', 'REVISION_UNAVAILABLE', 'REVISION_CHANGED', 'INPUT_INCOMPATIBLE',
    'RESOURCE_UNAVAILABLE', 'CONFIRMATION_REQUIRED', 'REQUEST_CONFLICT',
  ]) }),
}
export const workbenchStartReplayAction: ConsoleActionDefinition<WorkbenchStartReplayInput, WorkbenchStartReplayResult> = {
  ...workbenchStartReplayActionRef, kind: 'action', title: 'Replay a Run from the beginning',
  input: z.object({ sourceRunId: z.string().required(), target, revisionId: z.string().required(), requestId: z.string().pattern(/^[a-zA-Z0-9_-]{16,80}$/).required(), confirmSideEffects: z.const(true).required() }),
  output: z.object({ runId: z.string().required() }),
}

export function workbenchAttentionProviderPlugin(ctx: Context): void {
  ctx.console.provideQuery(ctx, workbenchAttentionQueryRef, { query({ input }: { input: WorkbenchAttentionInput }): WorkbenchAttentionPage {
    return { ...ctx.scheduler.listAttention(input), automations: ctx.automations.list().map(({ id, name }) => ({ id, name })) }
  } })
  ctx.console.provideAction(ctx, workbenchAcknowledgeAttentionActionRef, { action({ input }: { input: WorkbenchAcknowledgeAttentionInput }): WorkbenchAttentionItem {
    const attention = ctx.scheduler.acknowledgeAttention(input.id, input.acknowledged)
    if (!attention) throw new ConsoleProcedureError(404, 'RUN_ATTENTION_NOT_FOUND', 'This exception no longer exists.')
    return attention
  } })
  ctx.console.provideQuery(ctx, workbenchReplayPreviewQueryRef, { query({ input }: { input: WorkbenchReplayPreviewInput }): WorkbenchReplayPreview {
    try { return ctx.scheduler.previewReplay(input.sourceRunId, input.target) } catch (error) { throw replayError(error) }
  } })
  ctx.console.provideAction(ctx, workbenchStartReplayActionRef, { async action({ input }: { input: WorkbenchStartReplayInput }): Promise<WorkbenchStartReplayResult> {
    try { return { runId: (await ctx.scheduler.startReplay(input)).id } } catch (error) { throw replayError(error) }
  } })
}

function replayError(error: unknown): unknown {
  // Only the scheduler's deliberate safe replay diagnostics cross this boundary.
  if (error instanceof ReplayError) {
    return new ConsoleProcedureError(409, `REPLAY_${error.code}`, error.message)
  }
  return error
}

workbenchAttentionProviderPlugin.inject = ['workbench', 'console', 'automations', 'scheduler']
