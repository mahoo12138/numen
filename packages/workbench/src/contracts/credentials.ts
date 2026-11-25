import type { ConsoleProcedureRef } from '@numenjs/console'
import type { NumenValue } from '@numenjs/core'

export const workbenchCredentialsIndexQueryRef = { id: 'numen:credentials-index', version: 1 } as const satisfies ConsoleProcedureRef
export const workbenchCreateCredentialActionRef = { id: 'numen:credential-create', version: 1 } as const satisfies ConsoleProcedureRef
export const workbenchRotateCredentialActionRef = { id: 'numen:credential-rotate', version: 1 } as const satisfies ConsoleProcedureRef
export const workbenchDeleteCredentialActionRef = { id: 'numen:credential-delete', version: 1 } as const satisfies ConsoleProcedureRef

export interface WorkbenchCredential {
  id: string
  name: string
  typeId: string
  typeVersion: number
  typeTitle: string
  typeAvailable: boolean
  secretVersion: number
  connectionCount: number
  createdAt: string
  updatedAt: string
}

export interface WorkbenchCredentialType {
  id: string
  version: number
  title: string
  secretSchemaSupported: boolean
  secretFields: Array<{
    name: string
    label: string
    type: 'string' | 'number' | 'boolean' | 'json'
    required: boolean
  }>
}

export interface WorkbenchCredentialsIndex {
  encryptionConfigured: boolean
  items: WorkbenchCredential[]
  types: WorkbenchCredentialType[]
}

export interface WorkbenchCreateCredentialInput {
  name: string
  typeId: string
  typeVersion: number
  secret: Record<string, NumenValue>
}

export interface WorkbenchRotateCredentialInput {
  credentialId: string
  expectedSecretVersion: number
  secret: Record<string, NumenValue>
}

export interface WorkbenchDeleteCredentialInput {
  credentialId: string
  expectedSecretVersion: number
}

export interface WorkbenchCredentialMutationResult { credential: WorkbenchCredential }
export interface WorkbenchDeleteCredentialResult { credentialId: string }
