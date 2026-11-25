import { legacyConsoleBuiltins } from '@numenjs/console'
import { legacyWorkbenchBuiltins } from '@numenjs/workbench/plugin'
import {
  consoleBuiltin, legacyBuiltinFamily, legacyBuiltinNames, legacyConsoleNames, legacyWorkbenchNames, workbenchBuiltin,
} from '@numenjs/config'
import { describe, expect, it } from 'vitest'
import { runtimeBuiltinNames } from '../src/app.js'

// Legacy builtin names are declared once in `@numenjs/config` metadata. Each
// product still spells its name -> plugin map because only it can import the
// implementations, so this suite keeps the two in lockstep. Adding a leaf to
// the descriptor without wiring a plugin (or the reverse) fails here instead
// of silently dropping the plugin at runtime.
describe('legacy builtin registry', () => {
  it('keeps the Console product map aligned with the shared descriptor', () => {
    expect(Object.keys(legacyConsoleBuiltins).sort()).toEqual([...legacyConsoleNames].sort())
  })

  it('keeps the Workbench product map aligned with the shared descriptor', () => {
    expect(Object.keys(legacyWorkbenchBuiltins).sort()).toEqual([...legacyWorkbenchNames].sort())
  })

  it('derives every runtime builtin name from the descriptors', () => {
    const expected = new Set<string>([
      ...Object.keys(consoleBuiltin.leaves),
      ...Object.keys(workbenchBuiltin.leaves),
      // Non-product host plugins are wired by the runtime itself.
      'i18n', 'clock', 'database', 'capabilities', 'controls', 'coreControls', 'credentials', 'resources',
      'connections', 'http', 'httpSocks', 'demo', 'httpIntegration', 'schedule', 'runEvents', 'data',
      'datetime', 'webhook', 'csv', 'mqtt', 'smtp', 'github', 'feishu', 'rss', 'automations', 'scheduler',
      'triggers', 'server', 'health', 'readiness',
    ])
    expect([...runtimeBuiltinNames].sort()).toEqual([...expected].sort())
  })

  it('maps each legacy leaf to exactly one product family', () => {
    for (const name of legacyBuiltinNames) {
      const family = legacyBuiltinFamily(name)
      expect(family, `${name} must belong to a product family`).toBeDefined()
    }
    expect(legacyBuiltinFamily('consoleHttp')).toBe('console')
    expect(legacyBuiltinFamily('workbenchRuns')).toBe('workbench')
    expect(legacyBuiltinFamily('notABuiltin')).toBeUndefined()
  })
})
