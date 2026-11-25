import type { ConsoleProcedureRef } from '@numenjs/console'
import type { RunAttentionFilters, RunAttentionItem, RunAttentionPage, ReplayPreview, ReplayTarget, StartReplayRequest } from '@numenjs/core'

export const workbenchAttentionQueryRef = { id: 'numen:run-attention', version: 1 } as const satisfies ConsoleProcedureRef
export const workbenchAcknowledgeAttentionActionRef = { id: 'numen:acknowledge-run-attention', version: 1 } as const satisfies ConsoleProcedureRef
export const workbenchReplayPreviewQueryRef = { id: 'numen:run-replay-preview', version: 1 } as const satisfies ConsoleProcedureRef
export const workbenchStartReplayActionRef = { id: 'numen:start-run-replay', version: 1 } as const satisfies ConsoleProcedureRef

export type WorkbenchAttentionInput = RunAttentionFilters
export interface WorkbenchAttentionPage extends RunAttentionPage {
  automations: Array<{ id: string; name: string }>
}
export type WorkbenchAttentionItem = RunAttentionItem
export interface WorkbenchAcknowledgeAttentionInput { id: string; acknowledged: boolean }
export interface WorkbenchReplayPreviewInput { sourceRunId: string; target: ReplayTarget }
export type WorkbenchReplayPreview = ReplayPreview
export type WorkbenchStartReplayInput = StartReplayRequest
export interface WorkbenchStartReplayResult { runId: string }
