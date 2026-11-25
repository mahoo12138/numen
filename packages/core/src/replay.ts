export type ReplayTarget = 'original' | 'active'

export type ReplayRejectionCode =
  | 'SOURCE_NOT_FOUND'
  | 'FORMAL_RUN_REQUIRED'
  | 'SOURCE_NOT_TERMINAL'
  | 'SOURCE_NOT_REPLAYABLE'
  | 'AUTOMATION_ARCHIVED'
  | 'REVISION_UNAVAILABLE'
  | 'REVISION_CHANGED'
  | 'INPUT_INCOMPATIBLE'
  | 'RESOURCE_UNAVAILABLE'
  | 'CONFIRMATION_REQUIRED'
  | 'REQUEST_CONFLICT'

/** A replay preview deliberately excludes the previous input, trigger and errors. */
export interface ReplayPreview {
  sourceRunId: string
  automationId: string
  target: ReplayTarget
  revisionId?: string
  revisionNumber?: number
  requiresOutcomeConfirmation: boolean
  canReplay: boolean
  reasonCode?: ReplayRejectionCode
  reason?: string
}

export interface StartReplayRequest {
  sourceRunId: string
  target: ReplayTarget
  /** The immutable Revision displayed by previewReplay. */
  revisionId: string
  requestId: string
  /** The caller has reviewed external outcomes and the duplicate side-effect warning. */
  confirmSideEffects: true
}
