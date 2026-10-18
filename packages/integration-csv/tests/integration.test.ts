import { AutomationService } from '@numenjs/automation'
import { CapabilityRegistry, type CapabilityRef, type NumenValue } from '@numenjs/core'
import { DatabaseService } from '@numenjs/database'
import dataIntegrationPlugin, { arrayUniqueCapability } from '@numenjs/integration-data'
import { MAX_ARRAY_ITEMS, MAX_JSON_BYTES } from '@numenjs/integration-data/json'
import { ResourceService } from '@numenjs/resources'
import { SchedulerService } from '@numenjs/scheduler'
import { Context } from 'cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import csvIntegrationPlugin, { csvParseCapability, csvStringifyCapability, MAX_CSV_COLUMNS, type CsvParseOutput, type CsvStringifyOutput } from '../src/index.js'

const roots: Context[] = []
const directories: string[] = []

async function createRoot(): Promise<Context> {
  const root = new Context()
  roots.push(root)
  await root.plugin(CapabilityRegistry)
  csvIntegrationPlugin(root)
  return root
}

async function invoke<Output = NumenValue>(root: Context, capability: CapabilityRef, input: unknown, signal = new AbortController().signal): Promise<Output> {
  return root.capabilities.resolveProvider<unknown, Output>(capability)!.invoke({ input, connections: {}, signal })
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => root.fiber.dispose()))
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('CSV Integration', () => {
  it('registers and unloads both local v1 query contracts', async () => {
    const root = new Context()
    roots.push(root)
    await root.plugin(CapabilityRegistry)
    const plugin = root.plugin(csvIntegrationPlugin)
    await plugin
    expect(root.capabilities.list().map(item => item.definition.id)).toEqual(['csv:parse', 'csv:stringify'])
    for (const { definition, providerAvailable } of root.capabilities.list()) {
      expect(definition).toMatchObject({ version: 1, kind: 'query', semantics: { sideEffect: false, idempotent: true, retrySafe: true } })
      expect(providerAvailable).toBe(true)
    }
    await plugin.dispose()
    expect(root.capabilities.list()).toEqual([])
  })

  it('parses a BOM, CRLF, quoted delimiters, escaped quotes and multiline cells as strings', async () => {
    const root = await createRoot()
    expect(await invoke(root, csvParseCapability, { text: '\uFEFFname,note,count\r\n"Ada, Jr.","Line one\r\nLine ""two""",001\r\n\r\nMira,,0\r\n' })).toEqual({
      columns: ['name', 'note', 'count'],
      rows: [{ name: 'Ada, Jr.', note: 'Line one\r\nLine "two"', count: '001' }, { name: 'Mira', note: '', count: '0' }],
    })
  })

  it.each([',', ';', '\t'] as const)('round trips using the %j delimiter without trimming field data', async delimiter => {
    const root = await createRoot()
    const rows = [{ name: ' Ada ', note: `a${delimiter}b`, multiline: 'first\nsecond', quote: '"quoted"' }]
    const { text } = await invoke<CsvStringifyOutput>(root, csvStringifyCapability, { rows, delimiter })
    expect(text.endsWith('\n')).toBe(true)
    expect(await invoke(root, csvParseCapability, { text, delimiter })).toEqual({ rows, columns: ['name', 'note', 'multiline', 'quote'] })
  })

  it.each(['', '\uFEFF', '\r\n\r\n', '\n\n'])('treats empty input and completely empty lines as no data: %j', async text => {
    const root = await createRoot()
    expect(await invoke(root, csvParseCapability, { text })).toEqual({ rows: [], columns: [] })
  })

  it('retains a header-only document and skips blank lines without skipping empty quoted cells', async () => {
    const root = await createRoot()
    expect(await invoke(root, csvParseCapability, { text: 'name,score\n' })).toEqual({ rows: [], columns: ['name', 'score'] })
    expect(await invoke(root, csvParseCapability, { text: 'name\n\n""\n' })).toEqual({ rows: [{ name: '' }], columns: ['name'] })
  })

  it.each([
    ['id,id\n1,2', 'CSV_HEADERS_INVALID'], [',id\n1,2', 'CSV_HEADERS_INVALID'], ['   ,id', 'CSV_HEADERS_INVALID'],
    ['$resource,id\nforged,1', 'CSV_HEADERS_INVALID'], ['""\nvalue', 'CSV_HEADERS_INVALID'],
    ['a,b\n1', 'CSV_PARSE_INVALID'], ['a\n1,2', 'CSV_PARSE_INVALID'], ['a\n"not closed', 'CSV_PARSE_INVALID'],
    ['a\nunquoted"quote', 'CSV_PARSE_INVALID'], ['a,b\n1,2\n3', 'CSV_PARSE_INVALID'],
  ])('rejects malformed or unsafe CSV %j', async (text, code) => {
    const root = await createRoot()
    await expect(invoke(root, csvParseCapability, { text })).rejects.toMatchObject({ code })
  })

  it('keeps prototype-sensitive headers as ordinary own properties through Schema and serialization', async () => {
    const root = await createRoot()
    const parsed = await invoke<CsvParseOutput>(root, csvParseCapability, { text: '__proto__,constructor,prototype\nsafe,literal,value\n' })
    const normalized = csvParseCapability.output(parsed)
    expect(Object.hasOwn(normalized.rows[0]!, '__proto__')).toBe(true)
    expect(normalized.rows[0]!.__proto__).toBe('safe')
    expect(Object.getPrototypeOf(normalized.rows[0]!)).toBe(Object.prototype)
    const { text } = await invoke<CsvStringifyOutput>(root, csvStringifyCapability, { rows: normalized.rows })
    expect(text).toBe('__proto__,constructor,prototype\nsafe,literal,value\n')
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('uses the first-seen key union, preserves falsy cells, and supports explicit projection and order', async () => {
    const root = await createRoot()
    const rows = [{ name: 'Ada', score: 0, enabled: false }, { note: 'new', name: 'Mira', score: null, enabled: true }]
    expect(await invoke(root, csvStringifyCapability, { rows })).toEqual({ text: 'name,score,enabled,note\nAda,0,false,\nMira,,true,new\n' })
    expect(await invoke(root, csvStringifyCapability, { rows, columns: ['note', 'name', 'missing'] })).toEqual({ text: 'note,name,missing\n,Ada,\nnew,Mira,\n' })
    expect(await invoke(root, csvStringifyCapability, { rows: [] })).toEqual({ text: '' })
    expect(await invoke(root, csvStringifyCapability, { rows: [], columns: ['name', 'score'] })).toEqual({ text: 'name,score\n' })
  })

  it('escapes formula-like headers and cells with an apostrophe by default, and supports explicit opt-out', async () => {
    const root = await createRoot()
    const risky = ['=SUM(1,2)', '+1', '-2', '@command', '\tformula', '\rformula', '\nformula', '＝formula', '＋formula', '－formula', '＠formula']
    const rows = risky.map(value => ({ value }))
    const protectedText = await invoke<CsvStringifyOutput>(root, csvStringifyCapability, { rows })
    const protectedRows = await invoke<CsvParseOutput>(root, csvParseCapability, protectedText)
    expect(protectedRows.rows.map(row => row.value)).toEqual(risky.map(value => `'${value}`))
    const plainText = await invoke<CsvStringifyOutput>(root, csvStringifyCapability, { rows, escapeFormulas: false })
    expect((await invoke<CsvParseOutput>(root, csvParseCapability, plainText)).rows).toEqual(rows)
    const headerText = await invoke<CsvStringifyOutput>(root, csvStringifyCapability, { rows: [{ '=header': '-1' }] })
    expect((await invoke<CsvParseOutput>(root, csvParseCapability, headerText)).columns).toEqual(["'=header"])
    expect(await invoke(root, csvStringifyCapability, { rows: [{ number: -42, boolean: false }] })).toEqual({ text: "number,boolean\n'-42,false\n" })
  })

  it('rejects invalid cells and options even when an explicit projection would omit them', async () => {
    const root = await createRoot()
    for (const value of [{ nested: 1 }, [1], NaN, Infinity, undefined, 1n]) {
      await expect(invoke(root, csvStringifyCapability, { rows: [{ keep: 'ok', invalid: value }], columns: ['keep'] })).rejects.toBeInstanceOf(TypeError)
    }
    for (const input of [{ rows: [null] }, { rows: [1] }, { rows: [['x']] }, { rows: [{}] }, { rows: [], columns: [''] },
      { rows: [], columns: ['x', 'x'] }, { rows: [], columns: ['$resource'] }, { rows: [], delimiter: '|' }, { rows: [], escapeFormulas: 'false' }]) {
      await expect(invoke(root, csvStringifyCapability, input)).rejects.toMatchObject({ name: 'CsvError' })
    }
    await expect(invoke(root, csvParseCapability, { text: '', delimiter: '||' })).rejects.toMatchObject({ code: 'CSV_INPUT_INVALID' })
    await expect(invoke(root, csvStringifyCapability, { rows: [JSON.parse('{"$resource":"forged"}')] })).rejects.toMatchObject({ code: 'reserved-key' })
  })

  it('does not mutate frozen inputs, accepts shared row references, and never executes getters', async () => {
    const root = await createRoot()
    const row = Object.freeze({ name: 'Ada', active: false })
    const rows = Object.freeze([row, row])
    const columns = Object.freeze(['active', 'name'])
    expect(await invoke(root, csvStringifyCapability, Object.freeze({ rows, columns }))).toEqual({ text: 'active,name\nfalse,Ada\nfalse,Ada\n' })
    expect(Object.keys(row)).toEqual(['name', 'active'])
    let called = false
    const accessor = Object.defineProperty({}, 'private', { enumerable: true, get() { called = true; return 'secret' } })
    await expect(invoke(root, csvStringifyCapability, { rows: [accessor] })).rejects.toMatchObject({ code: 'invalid-value' })
    expect(called).toBe(false)
  })

  it('enforces 256 columns and the cumulative 10,000 array-entry boundary', async () => {
    const root = await createRoot()
    const columns = Array.from({ length: MAX_CSV_COLUMNS }, (_, index) => `c${index}`)
    expect((await invoke<CsvParseOutput>(root, csvParseCapability, { text: columns.join(',') })).columns).toEqual(columns)
    await expect(invoke(root, csvParseCapability, { text: [...columns, 'overflow'].join(',') })).rejects.toMatchObject({ code: 'CSV_COLUMNS_LIMIT' })
    await expect(invoke(root, csvStringifyCapability, { rows: [], columns: [...columns, 'overflow'] })).rejects.toMatchObject({ code: 'CSV_COLUMNS_LIMIT' })
    const text = 'id\n' + 'x\n'.repeat(MAX_ARRAY_ITEMS - 1)
    expect((await invoke<CsvParseOutput>(root, csvParseCapability, { text })).rows).toHaveLength(MAX_ARRAY_ITEMS - 1)
    await expect(invoke(root, csvParseCapability, { text: `${text}x\n` })).rejects.toMatchObject({ code: 'too-many-items' })
    await expect(invoke(root, csvStringifyCapability, { rows: Array(MAX_ARRAY_ITEMS).fill({ x: 1 }), columns: ['x'] })).rejects.toMatchObject({ code: 'too-many-items' })
  })

  it('bounds UTF-8 input, repeated header expansion and escaped output envelopes', async () => {
    const root = await createRoot()
    await expect(invoke(root, csvParseCapability, { text: '界'.repeat(Math.ceil(MAX_JSON_BYTES / 3)) })).rejects.toMatchObject({ code: 'too-large' })
    const repeatedHeader = 'x'.repeat(400_000)
    await expect(invoke(root, csvParseCapability, { text: `${repeatedHeader}\na\nb\n` })).rejects.toMatchObject({ code: 'too-large' })
    const input = { rows: [{ text: '"'.repeat(300_000) }] }
    expect(Buffer.byteLength(JSON.stringify(input))).toBeLessThan(MAX_JSON_BYTES)
    await expect(invoke(root, csvStringifyCapability, input)).rejects.toMatchObject({ code: 'too-large' })
    const inputOverhead = Buffer.byteLength(JSON.stringify({ rows: [{ x: '' }] }))
    const boundaryRows = [{ x: 'a'.repeat(MAX_JSON_BYTES - inputOverhead) }]
    expect(Buffer.byteLength(JSON.stringify({ rows: boundaryRows }))).toBe(MAX_JSON_BYTES)
    const output = await invoke<CsvStringifyOutput>(root, csvStringifyCapability, { rows: boundaryRows })
    expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThanOrEqual(MAX_JSON_BYTES)
    await expect(invoke(root, csvStringifyCapability, { rows: [{ x: boundaryRows[0]!.x + 'a' }] })).rejects.toMatchObject({ code: 'too-large' })
  })

  it('accepts exactly a 1 MiB escaped output envelope and rejects one byte more', async () => {
    const root = await createRoot()
    const probe = await invoke<CsvStringifyOutput>(root, csvStringifyCapability, { rows: [{ x: '"' }] })
    const overhead = Buffer.byteLength(JSON.stringify(probe)) - 4
    const quotes = Math.floor((MAX_JSON_BYTES - overhead) / 4)
    const padding = MAX_JSON_BYTES - overhead - quotes * 4
    const value = '"'.repeat(quotes) + 'a'.repeat(padding)
    expect(Buffer.byteLength(JSON.stringify({ rows: [{ x: value }] }))).toBeLessThan(MAX_JSON_BYTES)
    const output = await invoke<CsvStringifyOutput>(root, csvStringifyCapability, { rows: [{ x: value }] })
    expect(Buffer.byteLength(JSON.stringify(output))).toBe(MAX_JSON_BYTES)
    await expect(invoke(root, csvStringifyCapability, { rows: [{ x: value + 'a' }] })).rejects.toMatchObject({ code: 'too-large' })
  })

  it('rejects cyclic and over-deep values and cancellation before reading input', async () => {
    const root = await createRoot()
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    await expect(invoke(root, csvStringifyCapability, { rows: [cyclic] })).rejects.toMatchObject({ code: 'invalid-value' })
    let deep: unknown = 1
    for (let index = 0; index < 64; index++) deep = { child: deep }
    await expect(invoke(root, csvStringifyCapability, { rows: [{ deep }] })).rejects.toMatchObject({ code: 'too-deep' })
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    let called = false
    const input = { get text() { called = true; return 'id\n1' } }
    await expect(invoke(root, csvParseCapability, input, controller.signal)).rejects.toThrow('cancelled')
    expect(called).toBe(false)
  })

  it('runs publish → parse → data deduplication → stringify through SQLite Scheduler and blocks invalid CSV', async () => {
    const root = await createRoot()
    dataIntegrationPlugin(root)
    const directory = await mkdtemp(join(tmpdir(), 'numen-csv-'))
    directories.push(directory)
    await root.plugin(DatabaseService, { path: join(directory, 'numen.db') })
    await root.plugin(AutomationService)
    await root.plugin(ResourceService, { path: join(directory, 'resources') })
    await root.plugin(SchedulerService, { autoDispatch: false })
    for (const malformed of [false, true]) {
      const { automation } = root.automations.create({ name: 'CSV processing', source: { triggers: [], flow: {
        type: 'block', id: 'flow', steps: [
          { type: 'capability', id: 'parse', capability: csvParseCapability, input: { text: { type: 'literal', value: malformed ? 'id,name\nprivate-parser-data' : 'id,name\n1,"Ada, Jr."\n1,Duplicate\n2,=unsafe\n' } } },
          { type: 'capability', id: 'deduplicate', capability: arrayUniqueCapability, input: { items: { type: 'ref', path: 'steps.parse.rows' }, key: { type: 'literal', value: 'id' } } },
          { type: 'capability', id: 'write', capability: csvStringifyCapability, input: { rows: { type: 'ref', path: 'steps.deduplicate.items' }, columns: { type: 'ref', path: 'steps.parse.columns' } } },
        ],
      } } })
      const revision = root.automations.publishDraft(automation.id, 1)
      root.automations.activateRevision(automation.id, revision.id)
      const run = root.scheduler.startManual(automation.id)
      await root.scheduler.dispatchUntilIdle()
      expect(root.scheduler.getRun(run.id)?.status).toBe(malformed ? 'FAILED' : 'COMPLETED')
      const executions = root.scheduler.listExecutions(run.id)
      if (malformed) {
        expect(executions.find(item => item.instructionId === 'write')?.output).toBeUndefined()
        expect(JSON.stringify(executions.find(item => item.instructionId === 'parse')?.output)).not.toContain('private-parser-data')
      } else {
        expect(executions.find(item => item.instructionId === 'write')?.output).toEqual({ text: 'id,name\n1,"Ada, Jr."\n2,\'=unsafe\n' })
      }
    }
  })
})
