import type { ConsoleProcedureRef } from '@numenjs/console'
import type { AutomationSource, CapabilityRef, NumenValue } from '@numenjs/core'
import type { WorkbenchRunFlowNode } from './runs.js'

/** Values are fetched explicitly and retained only by the current data panel. */
export const workbenchExecutionDataQueryRef = { id: 'numen:execution-data', version: 1 } as const satisfies ConsoleProcedureRef

export interface WorkbenchExecutionDataInput {
  runId: string
  executionId: string
  attemptId?: string
}

export interface WorkbenchInspectedValue {
  value: NumenValue
  hidden: number
  truncated: boolean
  available: boolean
}

export interface WorkbenchExecutionData {
  runId: string
  executionId: string
  sourceNodeId?: string
  /** A sample result has no Provider Attempt; values still belong to this durable Execution. */
  sampleId?: string
  /** Attempts do not persist separate values; these are the Execution's current durable values. */
  provenance: 'execution-current'
  attempt?: { id: string; number: number }
  input: WorkbenchInspectedValue
  output: WorkbenchInspectedValue
}

export const workbenchAutomationSnapshotQueryRef = { id: 'numen:automation-snapshot', version: 1 } as const satisfies ConsoleProcedureRef

export interface WorkbenchAutomationSnapshotQueryInput { automationId: string; snapshotId: string; sourceNodeId?: string }

export const workbenchAutomationRestoreContentQueryRef = { id: 'numen:automation-restore-content', version: 1 } as const satisfies ConsoleProcedureRef
export interface WorkbenchAutomationRestoreContentQueryInput { automationId: string; snapshotId: string; expectedDraftVersion: number }
export interface WorkbenchAutomationRestoreContent {
  automationId: string
  identity: WorkbenchAutomationSnapshotDetail['identity']
  expectedDraftVersion: number
  source: AutomationSource
  presentation: Record<string, NumenValue>
}

export type WorkbenchAutomationComparisonTarget = { kind: 'draft'; version: number } | { kind: 'snapshot'; snapshotId: string }
export const workbenchAutomationComparisonQueryRef = { id: 'numen:automation-comparison', version: 1 } as const satisfies ConsoleProcedureRef
export const workbenchAutomationComparisonStateQueryRef = { id: 'numen:automation-comparison-state', version: 1 } as const satisfies ConsoleProcedureRef
export interface WorkbenchAutomationComparisonQueryInput {
  automationId: string
  left: WorkbenchAutomationComparisonTarget
  right: WorkbenchAutomationComparisonTarget
  changeOffset?: number
  changeLimit?: number
}
export interface WorkbenchAutomationComparisonState {
  automationId: string
  automationName: string
  draftVersion: number
  revisions: { id: string; number: number; createdAt: string }[]
  revisionsTruncated: boolean
}
export type WorkbenchAutomationChangeCategory = 'structure' | 'parameters' | 'bindings' | 'policies' | 'triggers' | 'inputs' | 'presentation' | 'extensions'
export interface WorkbenchAutomationChange {
  category: WorkbenchAutomationChangeCategory
  kind: 'added' | 'removed' | 'moved' | 'changed'
  nodeId?: string
  field?: 'node' | 'type' | 'capability' | 'control' | 'input' | 'output' | 'condition' | 'until' | 'durationMs' | 'items' | 'concurrency' | 'invocationPolicy' | 'connections' | 'automationPolicy' | 'triggers' | 'triggerConfig' | 'triggerCapability' | 'inputDeclarations' | 'presentation' | 'extensionFields' | 'graphEdges' | 'mergeInputs' | 'mergeMode'
}
export type WorkbenchAutomationComparisonIdentity =
  | { kind: 'draft'; version: number; updatedAt: string }
  | { kind: 'snapshot'; snapshotId: string; purpose: 'published' | 'draft-test'; number?: number; sourceDraftVersion?: number; createdAt: string }
export interface WorkbenchAutomationComparison {
  automationId: string
  automationName: string
  left: WorkbenchAutomationComparisonIdentity
  right: WorkbenchAutomationComparisonIdentity
  changes: WorkbenchAutomationChange[]
  totalChanges?: number
  nextChangeOffset?: number
}

export interface WorkbenchAutomationSnapshotSourceNode {
  nodeId: string
  type: WorkbenchRunFlowNode['type']
  capability?: CapabilityRef
  control?: CapabilityRef
  input: WorkbenchInspectedValue
  /** Expression kinds only: paths, template text and function arguments remain opaque. */
  expressionFields: Array<{ field: string; type: string }>
  connectionBindingCount: number
  policy?: { timeoutMs?: number; retry?: { maxAttempts: number; backoffMs?: number } }
}

export interface WorkbenchAutomationSnapshotDetail {
  automationName: string
  identity: {
    id: string
    automationId: string
    purpose: 'published' | 'draft-test'
    number?: number
    sourceDraftVersion?: number
    protocolVersion: number
    irVersion: number
    contentHash: string
    createdAt: string
  }
  compatibility: 'supported' | 'unsupported-protocol'
  flow: {
    root: WorkbenchRunFlowNode
    truncated: boolean
    focusedNodeId?: string
  }
  source: {
    nodes: WorkbenchAutomationSnapshotSourceNode[]
    triggers: Array<{ id: string; capability: CapabilityRef; config: WorkbenchInspectedValue; connectionBindingCount: number }>
    policy: { maxActive?: number; overflow?: 'queue' | 'drop' | 'replace'; hasGroupBy: boolean }
    truncated: boolean
  }
  /** Only this editor's known collapsed-node presentation field is inspectable. */
  presentation: { collapsedNodes: string[]; hiddenFields: number; truncated: boolean }
  inputs: Array<{ name: string; type: 'string' | 'number' | 'boolean' | 'object' | 'array'; required: boolean; hasDefault: boolean }>
  inputsTruncated: boolean
}
