/**
 * Version 1 builtin assembly metadata.
 *
 * This is the single place that spells out legacy builtin names. The Console
 * and Workbench plugins type their v1 maps against these keys, config
 * validation and migration derive from them, and the runtime composes its
 * builtin table from the same descriptors. Adding a builtin therefore changes
 * one list instead of five, and a missing plugin wiring fails typecheck.
 */
export interface LegacyBuiltinLeaf {
  /** Section of the version 2 product config this leaf maps onto, if any. */
  section?: string
  /** Fields the version 1 leaf accepted; anything else is rejected by migration. */
  fields: readonly string[]
}

export interface LegacyProductBuiltin {
  product: string
  packageName: string
  leaves: Readonly<Record<string, LegacyBuiltinLeaf>>
}

export const consoleBuiltin = {
  product: 'console',
  packageName: '@numenjs/console',
  leaves: {
    console: { fields: [] },
    consoleEntries: { fields: [] },
    consoleAuth: { section: 'auth', fields: ['token', 'ownerId'] },
    consoleSession: { section: 'session', fields: ['path', 'secureCookie'] },
    consoleAssets: { section: 'assets', fields: ['mode', 'manifestPath', 'assetPath'] },
    consoleHttp: { section: 'http', fields: ['path'] },
    consoleWs: { section: 'websocket', fields: ['path', 'maxMessageBytes', 'maxBufferedBytes'] },
  },
} as const satisfies LegacyProductBuiltin

export const workbenchBuiltin = {
  product: 'workbench',
  packageName: '@numenjs/workbench',
  leaves: {
    workbench: { fields: ['root', 'assetPath', 'entrySource'] },
    workbenchAutomationAuthoring: { fields: [] },
    workbenchAutomationActivation: { fields: [] },
    workbenchAutomationCatalog: { fields: [] },
    workbenchAutomations: { fields: [] },
    workbenchConnections: { fields: [] },
    workbenchCredentials: { fields: [] },
    workbenchHome: { fields: [] },
    workbenchLogs: { fields: [] },
    workbenchInvalidation: { fields: [] },
    workbenchRuns: { fields: [] },
  },
} as const satisfies LegacyProductBuiltin

export type LegacyConsoleName = keyof typeof consoleBuiltin.leaves
export type LegacyWorkbenchName = keyof typeof workbenchBuiltin.leaves

export const legacyConsoleNames: readonly LegacyConsoleName[] = Object.keys(consoleBuiltin.leaves) as LegacyConsoleName[]
export const legacyWorkbenchNames: readonly LegacyWorkbenchName[] = Object.keys(workbenchBuiltin.leaves) as LegacyWorkbenchName[]
export const legacyBuiltinNames: readonly (LegacyConsoleName | LegacyWorkbenchName)[] = [...legacyConsoleNames, ...legacyWorkbenchNames]

/** Product root name for a legacy leaf, or undefined when the name is not a builtin. */
export function legacyBuiltinFamily(name: string): 'console' | 'workbench' | undefined {
  if ((legacyConsoleNames as readonly string[]).includes(name)) return 'console'
  if ((legacyWorkbenchNames as readonly string[]).includes(name)) return 'workbench'
  return undefined
}
