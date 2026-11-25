import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vueJsx from '@vitejs/plugin-vue-jsx'
import { defineConfig } from 'vitest/config'

const fromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url))

/**
 * Aliases are derived from each workspace package's `exports` map so a new
 * package or subpath is picked up without editing this file. `packages/runtime/
 * tests/architecture.test.ts` asserts every package resolves from `src`.
 */
function workspacePackages(): Array<{ root: string; name: string; exports: Record<string, unknown> }> {
  const packages: Array<{ root: string; name: string; exports: Record<string, unknown> }> = []
  for (const category of ['packages', 'examples']) {
    for (const entry of readdirSync(join(fromRoot('.'), category))) {
      const manifestPath = join(fromRoot('.'), category, entry, 'package.json')
      if (!existsSync(manifestPath)) continue
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name: string; exports?: Record<string, unknown> }
      packages.push({ root: join(category, entry), name: manifest.name, exports: manifest.exports ?? { '.': undefined } })
    }
  }
  return packages
}

/** `./dist/plugin.js` -> `src/plugin.ts`, preferring the source file that exists. */
function sourceFile(root: string, subpath: string): string | undefined {
  if (subpath.endsWith('.css')) return `${root}/src/${subpath.split('/').pop()}`
  const stem = subpath.replace(/^\.\/dist\//, 'src/').replace(/\.js$/, '')
  for (const extension of ['.ts', '.tsx']) {
    if (existsSync(join(fromRoot('.'), `${root}/${stem}${extension}`))) return `${root}/${stem}${extension}`
  }
  return undefined
}

const aliases: Record<string, string> = {}
for (const workspacePackage of workspacePackages()) {
  for (const [key, value] of Object.entries(workspacePackage.exports)) {
    const target = typeof value === 'string' ? value : (value as { default?: string })?.default
    const specifier = key === '.' ? workspacePackage.name : `${workspacePackage.name}/${key.slice(2)}`
    const resolved = sourceFile(workspacePackage.root, target ?? './src/index.js')
    if (!resolved) continue
    aliases[specifier] = fromRoot(`./${resolved}`)
  }
}

// Longest specifier first so `@numenjs/components` cannot shadow
// `@numenjs/components/style.css`.
const alias = Object.entries(aliases)
  .sort(([left], [right]) => right.length - left.length)
  .map(([find, replacement]) => ({ find: new RegExp(`^${find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), replacement }))

export default defineConfig({
  plugins: [vueJsx()],
  resolve: { alias },
  test: {
    include: ['packages/*/tests/**/*.test.{ts,tsx}'],
    testTimeout: 15_000,
  },
})
