/**
 * Structural form-field descriptions used by Procedure contracts.
 *
 * These mirror the shapes in `@numenjs/components` but are intentionally
 * declared here so the wire contract does not depend on the browser component
 * library. The two are structurally compatible, so callers may pass component
 * schema fields wherever a contract field is expected.
 */
export type WorkbenchSchemaValue =
  | string
  | number
  | boolean
  | null
  | { $resource: string }
  | WorkbenchSchemaValue[]
  | { [key: string]: WorkbenchSchemaValue }

export type WorkbenchSchemaFieldType = 'string' | 'number' | 'boolean' | 'enum' | 'json'

export interface WorkbenchSchemaOption {
  label: string
  value: WorkbenchSchemaValue
}

export interface WorkbenchSchemaField {
  name: string
  label: string
  type: WorkbenchSchemaFieldType
  schemaType: string
  required: boolean
  description?: string
  role?: string
  defaultValue?: WorkbenchSchemaValue
  options?: WorkbenchSchemaOption[]
  min?: number
  max?: number
  step?: number
}
