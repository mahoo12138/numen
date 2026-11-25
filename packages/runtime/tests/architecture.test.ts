import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// This suite freezes the package dependency graph so an accidental cross-layer
// import fails in CI instead of surfacing as a runtime load order problem.
// Adding an edge is a deliberate act: declare it in package.json, then record
// it here in the same change.

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url))
const sourceRoots = ['packages', 'examples']

interface PackageManifest {
  name: string
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

interface PackageGraph {
  directory: string
  manifest: PackageManifest
  /** Internal package names imported from `src/`. */
  sourceImports: Set<string>
  /** Internal package names imported from `tests/`. */
  testImports: Set<string>
}

/** Every internal edge allowed from `src/`. Anything else is a layering regression. */
const allowedSourceEdges: Record<string, readonly string[]> = {
  '@numenjs/automation': ['@numenjs/core', '@numenjs/database'],
  '@numenjs/cli': ['@numenjs/config', '@numenjs/runtime'],
  '@numenjs/components': [],
  '@numenjs/config': ['@numenjs/logging'],
  '@numenjs/connections': ['@numenjs/core', '@numenjs/credentials', '@numenjs/database', '@numenjs/logging'],
  '@numenjs/console': ['@numenjs/logging'],
  '@numenjs/core': [],
  '@numenjs/credentials': ['@numenjs/core', '@numenjs/database'],
  '@numenjs/database': [],
  '@numenjs/http': [],
  '@numenjs/i18n': [],
  '@numenjs/integration-csv': ['@numenjs/core', '@numenjs/integration-data'],
  '@numenjs/integration-data': ['@numenjs/core'],
  '@numenjs/integration-datetime': ['@numenjs/core'],
  '@numenjs/integration-demo': ['@numenjs/core'],
  '@numenjs/integration-feishu': ['@numenjs/connections', '@numenjs/core', '@numenjs/credentials', '@numenjs/http', '@numenjs/logging'],
  '@numenjs/integration-github': [
    '@numenjs/components', '@numenjs/connections', '@numenjs/console', '@numenjs/core',
    '@numenjs/credentials', '@numenjs/http', '@numenjs/integration-data', '@numenjs/logging',
    '@numenjs/trigger-ui', '@numenjs/webui',
  ],
  '@numenjs/integration-http': ['@numenjs/core', '@numenjs/http'],
  '@numenjs/integration-mqtt': ['@numenjs/connections', '@numenjs/core', '@numenjs/credentials', '@numenjs/integration-data'],
  '@numenjs/integration-rss': ['@numenjs/core', '@numenjs/http', '@numenjs/logging'],
  // Context augmentation only: the plugin reacts to Scheduler events without calling into it.
  '@numenjs/integration-run-events': ['@numenjs/core', '@numenjs/scheduler'],
  '@numenjs/integration-schedule': ['@numenjs/core'],
  '@numenjs/integration-smtp': ['@numenjs/connections', '@numenjs/core', '@numenjs/credentials'],
  '@numenjs/integration-webhook': [
    '@numenjs/components', '@numenjs/connections', '@numenjs/console', '@numenjs/core',
    '@numenjs/credentials', '@numenjs/integration-data', '@numenjs/trigger-ui', '@numenjs/webui',
  ],
  '@numenjs/logging': [],
  '@numenjs/resources': ['@numenjs/core', '@numenjs/database'],
  '@numenjs/runtime': [
    '@numenjs/automation', '@numenjs/config', '@numenjs/connections', '@numenjs/console',
    '@numenjs/core', '@numenjs/credentials', '@numenjs/database', '@numenjs/http',
    '@numenjs/i18n', '@numenjs/integration-csv', '@numenjs/integration-data',
    '@numenjs/integration-datetime', '@numenjs/integration-demo', '@numenjs/integration-feishu',
    '@numenjs/integration-github', '@numenjs/integration-http', '@numenjs/integration-mqtt',
    '@numenjs/integration-rss', '@numenjs/integration-run-events', '@numenjs/integration-schedule',
    '@numenjs/integration-smtp', '@numenjs/integration-webhook', '@numenjs/logging',
    '@numenjs/resources', '@numenjs/scheduler', '@numenjs/triggers', '@numenjs/workbench',
  ],
  '@numenjs/scheduler': [
    '@numenjs/automation', '@numenjs/connections', '@numenjs/core',
    '@numenjs/database', '@numenjs/logging', '@numenjs/resources',
  ],
  // Browser-facing slot contract: integrations import this instead of Workbench.
  '@numenjs/trigger-ui': ['@numenjs/core'],
  '@numenjs/triggers': [
    '@numenjs/automation', '@numenjs/connections', '@numenjs/core',
    '@numenjs/logging', '@numenjs/scheduler',
  ],
  '@numenjs/webui': ['@numenjs/console', '@numenjs/i18n'],
  '@numenjs/workbench': [
    '@numenjs/automation', '@numenjs/components', '@numenjs/config', '@numenjs/connections',
    '@numenjs/console', '@numenjs/core', '@numenjs/credentials', '@numenjs/database',
    '@numenjs/i18n', '@numenjs/logging', '@numenjs/scheduler', '@numenjs/scheduler',
    '@numenjs/trigger-ui', '@numenjs/triggers', '@numenjs/webui',
  ],
  '@numenjs/example-components-plugin': ['@numenjs/components', '@numenjs/console', '@numenjs/webui'],
}

const importPattern = /(?:from|import)\s*\(?\s*['"](@numenjs\/[a-z0-9-]+)(?:\/[^'"]*)?['"]/g

async function collectImports(directory: string): Promise<Set<string>> {
  const found = new Set<string>()
  let entries: string[]
  try {
    entries = await readdir(directory)
  } catch {
    return found
  }
  for (const entry of entries) {
    const path = join(directory, entry)
    if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
      const text = await readFile(path, 'utf8')
      for (const match of text.matchAll(importPattern)) found.add(match[1]!)
      continue
    }
    if (entry.includes('.')) continue
    for (const nested of await collectImports(path)) found.add(nested)
  }
  return found
}

async function readGraph(): Promise<PackageGraph[]> {
  const graphs: PackageGraph[] = []
  for (const root of sourceRoots) {
    for (const entry of await readdir(join(repositoryRoot, root))) {
      const directory = join(repositoryRoot, root, entry)
      let manifest: PackageManifest
      try {
        manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as PackageManifest
      } catch {
        continue
      }
      graphs.push({
        directory: `${root}/${entry}`,
        manifest,
        sourceImports: await collectImports(join(directory, 'src')),
        testImports: await collectImports(join(directory, 'tests')),
      })
    }
  }
  return graphs.sort((left, right) => left.manifest.name.localeCompare(right.manifest.name))
}

const declared = (manifest: PackageManifest) => new Set([
  ...Object.keys(manifest.dependencies ?? {}),
  ...Object.keys(manifest.peerDependencies ?? {}),
])

const declaredForTests = (manifest: PackageManifest) => new Set([
  ...declared(manifest),
  ...Object.keys(manifest.devDependencies ?? {}),
])

describe('package dependency graph', () => {
  it('keeps @numenjs/core free of internal dependencies', async () => {
    const core = (await readGraph()).find(graph => graph.manifest.name === '@numenjs/core')
    expect(core).toBeDefined()
    expect([...core!.sourceImports]).toEqual([])
    expect([...declared(core!.manifest)].filter(name => name.startsWith('@numenjs/'))).toEqual([])
    expect([...declaredForTests(core!.manifest)].filter(name => name.startsWith('@numenjs/'))).toEqual([])
  })

  it('keeps @numenjs/core browser-safe because the Workbench bundle imports it', async () => {
    const root = join(repositoryRoot, 'packages/core/src')
    const violations: string[] = []
    for (const entry of await readdir(root)) {
      if (!entry.endsWith('.ts')) continue
      if (/from\s+['"]node:|require\(['"]node:/.test(await readFile(join(root, entry), 'utf8'))) violations.push(entry)
    }
    expect(violations).toEqual([])
  })

  it('declares every internal package imported from src and tests', async () => {
    const violations: string[] = []
    for (const graph of await readGraph()) {
      for (const dependency of graph.sourceImports) {
        if (!declared(graph.manifest).has(dependency)) violations.push(`${graph.directory} imports ${dependency} from src/ without declaring it`)
      }
      for (const dependency of graph.testImports) {
        if (!declaredForTests(graph.manifest).has(dependency)) violations.push(`${graph.directory} imports ${dependency} from tests/ without declaring it`)
      }
    }
    expect(violations).toEqual([])
  })

  it('matches the recorded source edges exactly', async () => {
    const violations: string[] = []
    for (const graph of await readGraph()) {
      const allowed = new Set(allowedSourceEdges[graph.manifest.name])
      expect(allowedSourceEdges[graph.manifest.name], `${graph.manifest.name} is missing from allowedSourceEdges`).toBeDefined()
      for (const dependency of graph.sourceImports) {
        if (!allowed.has(dependency)) violations.push(`${graph.manifest.name} must not import ${dependency} from src/`)
      }
      for (const dependency of allowed) {
        if (!graph.sourceImports.has(dependency)) violations.push(`${graph.manifest.name} no longer imports ${dependency}; remove the stale allowlist entry`)
      }
    }
    expect(violations).toEqual([])
  })

  it('has no cycles in the production dependency graph', async () => {
    const graphs = await readGraph()
    const byName = new Map(graphs.map(graph => [graph.manifest.name, graph]))
    const visiting = new Set<string>()
    const visited = new Set<string>()
    const cycles: string[] = []
    const walk = (name: string, path: string[]): void => {
      if (visiting.has(name)) {
        cycles.push([...path.slice(path.indexOf(name)), name].join(' -> '))
        return
      }
      if (visited.has(name)) return
      visiting.add(name)
      for (const dependency of byName.get(name)?.sourceImports ?? []) walk(dependency, [...path, name])
      visiting.delete(name)
      visited.add(name)
    }
    for (const graph of graphs) walk(graph.manifest.name, [])
    expect(cycles).toEqual([])
  })

  it('records every package, so a new package cannot skip the guard', async () => {
    const graphs = await readGraph()
    const recorded = new Set(Object.keys(allowedSourceEdges))
    const missing = graphs.map(graph => graph.manifest.name).filter(name => !recorded.has(name))
    const stale = [...recorded].filter(name => !graphs.some(graph => graph.manifest.name === name))
    expect({ missing, stale }).toEqual({ missing: [], stale: [] })
  })
})

describe('Scheduler persistence boundary', () => {
  // TODO(P3-3): attention and replay still read Automation-owned tables directly.
  const legacySqlModules = new Set(['attention.ts', 'replay.ts'])

  it('keeps Scheduler SQL inside its repository modules', async () => {
    const root = join(repositoryRoot, 'packages/scheduler/src')
    const violations: string[] = []
    for (const entry of await readdir(root)) {
      if (!entry.endsWith('.ts') || legacySqlModules.has(entry)) continue
      if ((await readFile(join(root, entry), 'utf8')).includes('.prepare(')) violations.push(entry)
    }
    expect(violations).toEqual([])
  })
})
