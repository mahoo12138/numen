import type { ConsoleProcedureRef } from '@numenjs/console'
import type { AutomationSource, NumenValue } from '@numenjs/core'

export const workbenchAutomationsIndexQueryRef = {
  id: 'numen:automations-index',
  version: 1,
} as const satisfies ConsoleProcedureRef

export interface WorkbenchAutomationsIndexInput { archived?: boolean }

export interface WorkbenchAutomationIndexItem {
  id: string
  name: string
  enabled: boolean
  activeRevisionId?: string
  activationGeneration: number
  archivedAt?: string
  activeRunCount: number
  runCount: number
  draftVersion: number
  revisionCount: number
  latestRevisionNumber?: number
  createdAt: string
  updatedAt: string
}

export interface WorkbenchAutomationsIndex {
  summary: {
    total: number
    enabled: number
    published: number
  }
  items: WorkbenchAutomationIndexItem[]
}

export const workbenchCreateAutomationActionRef = {
  id: 'numen:automation-create',
  version: 1,
} as const satisfies ConsoleProcedureRef

export const workbenchArchiveAutomationActionRef = { id: 'numen:automation-archive', version: 1 } as const satisfies ConsoleProcedureRef
export const workbenchRestoreAutomationActionRef = { id: 'numen:automation-restore', version: 1 } as const satisfies ConsoleProcedureRef
export const workbenchRemoveArchivedAutomationActionRef = { id: 'numen:automation-remove-archived', version: 1 } as const satisfies ConsoleProcedureRef

export interface WorkbenchArchiveAutomationInput { automationId: string; expectedActivationGeneration: number }
export interface WorkbenchRestoreAutomationInput { automationId: string; expectedActivationGeneration: number }
export interface WorkbenchRemoveArchivedAutomationInput { automationId: string; expectedArchivedAt: string }
export interface WorkbenchAutomationMutationResult { automationId: string }
export interface WorkbenchRemoveArchivedAutomationResult { automationId: string; removedRuns: number }

export interface WorkbenchCreateAutomationInput {
  name: string
}

export interface WorkbenchCreateAutomationResult {
  automation: WorkbenchAutomationIdentity
  draft: WorkbenchAutomationDraft
}

export const workbenchAutomationDetailQueryRef = {
  id: 'numen:automation-detail',
  version: 1,
} as const satisfies ConsoleProcedureRef

export interface WorkbenchAutomationDetailQueryInput {
  automationId: string
}

export interface WorkbenchAutomationIdentity {
  id: string
  name: string
  enabled: boolean
  activeRevisionId?: string
  activationGeneration: number
  archivedAt?: string
  createdAt: string
  updatedAt: string
}

export interface WorkbenchAutomationDraft {
  baseRevisionId?: string
  source: AutomationSource
  presentation: Record<string, NumenValue>
  version: number
  updatedAt: string
}

export interface WorkbenchAutomationRevisionSummary {
  id: string
  number: number
  contentHash: string
  active: boolean
  createdAt: string
}

export interface WorkbenchAutomationDetail {
  automation: WorkbenchAutomationIdentity
  draft: WorkbenchAutomationDraft
  revisions: WorkbenchAutomationRevisionSummary[]
  triggerRuntime?: {
    status: 'DISABLED' | 'NO_REVISION' | 'NO_TRIGGERS' | 'UNAVAILABLE' | 'WAITING' | 'READY'
    activationGeneration: number
    revisionId?: string
    expected: number
    active: number
  } | undefined
}

export const workbenchActivateAutomationRevisionActionRef = {
  id: 'numen:automation-activate-revision', version: 1,
} as const satisfies ConsoleProcedureRef
export const workbenchSetAutomationEnabledActionRef = {
  id: 'numen:automation-set-enabled', version: 1,
} as const satisfies ConsoleProcedureRef

export interface WorkbenchActivateAutomationRevisionInput {
  automationId: string
  revisionId: string
  expectedActivationGeneration: number
}
export interface WorkbenchSetAutomationEnabledInput {
  automationId: string
  enabled: boolean
  expectedActivationGeneration: number
}
export interface WorkbenchAutomationActivationResult {
  automation: WorkbenchAutomationIdentity
}

export const workbenchManualRunFormQueryRef = { id: 'numen:manual-run-form', version: 1 } as const satisfies ConsoleProcedureRef
export const workbenchStartManualRunActionRef = { id: 'numen:manual-run-start', version: 1 } as const satisfies ConsoleProcedureRef
export type WorkbenchPublishedRunLaunchMode = 'manual' | 'revision-test'
export type WorkbenchRunLaunchMode = WorkbenchPublishedRunLaunchMode | 'draft-test'
export type WorkbenchManualRunFormInput = {
  automationId: string
  mode: WorkbenchPublishedRunLaunchMode
  revisionId?: string
} | { automationId: string; mode: 'draft-test'; expectedDraftVersion: number }
interface WorkbenchRunFormFields {
  automationId: string
  inputs?: NonNullable<AutomationSource['inputs']>
}
export type WorkbenchManualRunForm = WorkbenchRunFormFields & ({
  mode: WorkbenchPublishedRunLaunchMode
  revisions: Array<{ id: string; number: number; active: boolean }>
  revisionId: string
  revisionNumber: number
} | { mode: 'draft-test'; draftVersion: number })
export type WorkbenchStartManualRunInput = {
  automationId: string
  requestId: string
  input: Record<string, NumenValue>
  trigger: NumenValue
} & ({ mode: WorkbenchPublishedRunLaunchMode; revisionId: string } | { mode: 'draft-test'; expectedDraftVersion: number })
export interface WorkbenchStartManualRunResult { runId: string; snapshotId?: string; sourceDraftVersion?: number }
