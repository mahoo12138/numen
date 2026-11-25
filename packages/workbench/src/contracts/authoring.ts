import type { ConsoleProcedureRef } from '@numenjs/console'
import type { AutomationSource, CapabilityRef, NumenValue } from '@numenjs/core'
import type { WorkbenchConnectionStatus } from './connections.js'
import type { WorkbenchAutomationDraft, WorkbenchAutomationRevisionSummary } from './automations.js'
import type { WorkbenchSchemaField, WorkbenchSchemaFieldType, WorkbenchSchemaOption } from './schema.js'

export const workbenchAutomationInsertCatalogQueryRef = {
  id: 'numen:automation-insert-catalog',
  version: 1,
} as const satisfies ConsoleProcedureRef

export type WorkbenchAutomationControlKind = 'wait' | 'if' | 'parallel' | 'race' | 'foreach'

export type WorkbenchAutomationInputFieldType = WorkbenchSchemaFieldType
export type WorkbenchAutomationInputOption = WorkbenchSchemaOption
export interface WorkbenchAutomationInputField extends WorkbenchSchemaField {}

export interface WorkbenchAutomationConnectionSlot {
  name: string
  required: boolean
  accepts: string[]
}

export interface WorkbenchAutomationConnectionOption {
  id: string
  name: string
  typeId: string
  typeVersion: number
  adapterId: string
  adapterVersion: number
  enabled: boolean
  adapterAvailable: boolean
  status: WorkbenchConnectionStatus
}

export type WorkbenchAutomationInsertItem =
  | {
    kind: 'extension'
    control: { id: string; version: number }
    title: string
    description: string
    inputFields: WorkbenchAutomationInputField[]
    inputSchemaSupported: boolean
  }
  | {
    kind: 'control'
    control: WorkbenchAutomationControlKind
    title: string
    description: string
  }
  | {
    kind: 'trigger'
    capability: CapabilityRef
    title: string
    description?: string
    providerAvailable: boolean
    connectionSlots: string[]
    connectionRequirements: WorkbenchAutomationConnectionSlot[]
    inputFields: WorkbenchAutomationInputField[]
    inputSchemaSupported: boolean
  }
  | {
    kind: 'capability'
    capability: CapabilityRef
    capabilityKind: 'query' | 'action'
    semantics: { retrySafe: boolean; defaultTimeoutMs?: number }
    title: string
    description?: string
    providerAvailable: boolean
    connectionSlots: string[]
    connectionRequirements: WorkbenchAutomationConnectionSlot[]
    inputFields: WorkbenchAutomationInputField[]
    inputSchemaSupported: boolean
  }

export interface WorkbenchAutomationInsertCatalog {
  items: WorkbenchAutomationInsertItem[]
  connections: WorkbenchAutomationConnectionOption[]
}

export const workbenchAutomationVariableCatalogQueryRef = {
  id: 'numen:automation-variable-catalog',
  version: 1,
} as const satisfies ConsoleProcedureRef

export type WorkbenchAutomationVariableValueType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'object'
  | 'array'
  | 'null'
  | 'unknown'

export interface WorkbenchAutomationVariableField {
  /** Path segments relative to a Trigger payload or Capability output. Empty means the whole output. */
  path: string[]
  label: string
  valueType: WorkbenchAutomationVariableValueType
  schemaType: string
  description?: string
}

export interface WorkbenchAutomationVariableDefinition {
  capability: CapabilityRef
  capabilityKind: 'trigger' | 'query' | 'action'
  title: string
  outputFields: WorkbenchAutomationVariableField[]
  outputSchemaSupported: boolean
}

export interface WorkbenchAutomationVariableCatalog {
  definitions: WorkbenchAutomationVariableDefinition[]
}

export const workbenchSaveAutomationDraftActionRef = {
  id: 'numen:automation-save-draft',
  version: 1,
} as const satisfies ConsoleProcedureRef

export interface WorkbenchSaveAutomationDraftInput {
  automationId: string
  expectedVersion: number
  source: AutomationSource
  presentation: Record<string, NumenValue>
}

export interface WorkbenchSaveAutomationDraftResult {
  draft: WorkbenchAutomationDraft
}

export const workbenchSaveAutomationDraftCopyActionRef = {
  id: 'numen:automation-save-draft-copy',
  version: 1,
} as const satisfies ConsoleProcedureRef

export interface WorkbenchSaveAutomationDraftCopyInput {
  automationId: string
  requestId: string
  name: string
  source: AutomationSource
  presentation: Record<string, NumenValue>
}

export interface WorkbenchSaveAutomationDraftCopyResult {
  automationId: string
  name: string
}

export const workbenchPublishAutomationDraftActionRef = {
  id: 'numen:automation-publish-draft',
  version: 1,
} as const satisfies ConsoleProcedureRef

export interface WorkbenchPublishAutomationDraftInput {
  automationId: string
  expectedVersion: number
}

export interface WorkbenchPublishAutomationDraftResult {
  draft: WorkbenchAutomationDraft
  revision: WorkbenchAutomationRevisionSummary
}
