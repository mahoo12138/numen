import type { ConsoleProcedureRef } from '@numenjs/console'
import type { NumenValue } from '@numenjs/core'
import type { WorkbenchSchemaField } from './schema.js'

export const workbenchConnectionsIndexQueryRef = {
  id: 'numen:connections-index',
  version: 1,
} as const satisfies ConsoleProcedureRef

export type WorkbenchConnectionStatus =
  | 'DISABLED'
  | 'UNAVAILABLE'
  | 'STOPPED'
  | 'STARTING'
  | 'READY'
  | 'ERROR'
  | 'STOPPING'

export interface WorkbenchConnectionIndexItem {
  id: string
  name: string
  adapterId: string
  adapterVersion: number
  adapterTitle: string
  enabled: boolean
  adapterAvailable: boolean
  credentialBound: boolean
  config: Record<string, NumenValue>
  credentialId?: string
  status: WorkbenchConnectionStatus
  statusDetail: string
  generation: number
  createdAt: string
  updatedAt: string
}

export interface WorkbenchConnectionsIndex {
  summary: {
    total: number
    enabled: number
    ready: number
    unavailable: number
    errors: number
  }
  items: WorkbenchConnectionIndexItem[]
  adapters: WorkbenchConnectionAdapter[]
}

export interface WorkbenchConnectionCredentialOption {
  id: string
  name: string
  secretVersion: number
  typeAvailable: boolean
}

export interface WorkbenchConnectionAdapter {
  id: string
  version: number
  title: string
  typeId: string
  typeVersion: number
  typeTitle: string
  providerAvailable: boolean
  configFields: WorkbenchSchemaField[]
  configSchemaSupported: boolean
  credentialType?: string
  credentials: WorkbenchConnectionCredentialOption[]
}

export const workbenchSetConnectionEnabledActionRef = {
  id: 'numen:connection-set-enabled',
  version: 1,
} as const satisfies ConsoleProcedureRef

export interface WorkbenchSetConnectionEnabledInput {
  connectionId: string
  expectedGeneration: number
  enabled: boolean
}

export interface WorkbenchSetConnectionEnabledResult {
  connection: WorkbenchConnectionIndexItem
}

export const workbenchCreateConnectionActionRef = {
  id: 'numen:connection-create',
  version: 1,
} as const satisfies ConsoleProcedureRef

export interface WorkbenchCreateConnectionInput {
  name: string
  adapterId: string
  adapterVersion: number
  config: Record<string, NumenValue>
  credentialId?: string
}

export interface WorkbenchCreateConnectionResult {
  connection: WorkbenchConnectionIndexItem
}

export const workbenchUpdateConnectionActionRef = {
  id: 'numen:connection-update',
  version: 1,
} as const satisfies ConsoleProcedureRef

export interface WorkbenchUpdateConnectionInput {
  connectionId: string
  expectedGeneration: number
  name: string
  config: Record<string, NumenValue>
  credentialId?: string
}

export interface WorkbenchUpdateConnectionResult {
  connection: WorkbenchConnectionIndexItem
}

export const workbenchDeleteConnectionActionRef = {
  id: 'numen:connection-delete',
  version: 1,
} as const satisfies ConsoleProcedureRef

export interface WorkbenchDeleteConnectionInput {
  connectionId: string
  expectedGeneration: number
}

export interface WorkbenchDeleteConnectionResult {
  connectionId: string
}
