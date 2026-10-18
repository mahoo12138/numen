import { AutomationService } from '@numenjs/automation'
import { CapabilityRegistry, isNumenValue, type CapabilityRef, type NumenValue } from '@numenjs/core'
import { DatabaseService } from '@numenjs/database'
import { ResourceService } from '@numenjs/resources'
import { SchedulerService } from '@numenjs/scheduler'
import { Context } from 'cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import dataIntegrationPlugin, {
  arrayUniqueCapability, jsonParseCapability, jsonStringifyCapability, objectMergeCapability,
} from '../src/index.js'
import {
  DataValueError, MAX_ARRAY_ITEMS, MAX_JSON_BYTES, MAX_JSON_DEPTH, parsePlainJson, stringifyNumenValue,
} from '../src/json.js'

const roots: Context[] = []
const directories: string[] = []

async function createRoot(): Promise<Context> {
  const root = new Context()
  roots.push(root)
  await root.plugin(CapabilityRegistry)
  dataIntegrationPlugin(root)
  return root
}

async function invoke(root: Context, capability: CapabilityRef, input: unknown, signal = new AbortController().signal): Promise<NumenValue> {
  return root.capabilities.resolveProvider<unknown, NumenValue>(capability)!.invoke({ input, connections: {}, signal })
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => root.fiber.dispose()))
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('bounded JSON boundary', () => {
  it.each(['null', 'true', 'false', '0', '-1.25', '""', '[]', '{}', '{"nested":[null,{},["文字"]]}'])(
    'parses and round trips %s', text => {
      expect(parsePlainJson(text)).toEqual(JSON.parse(text))
      expect(JSON.parse(stringifyNumenValue(parsePlainJson(text)))).toEqual(JSON.parse(text))
    },
  )

  it.each(['', 'undefined', '{"secret":"do-not-echo",}', 'NaN', '[1,]', '{'])('rejects invalid JSON without leaking parser input: %s', text => {
    expect(() => parsePlainJson(text)).toThrowError(new DataValueError('invalid-json', 'Text is not valid JSON.'))
    try { parsePlainJson(text) } catch (error) {
      expect(error).not.toHaveProperty('cause')
      expect(String(error)).not.toContain('do-not-echo')
    }
  })

  it.each(['{"$resource":"forged"}', '{"safe":[{"$resource":null}]}', '{"nested":{"$resource":"id","other":1}}'])(
    'rejects any external own reserved resource field', text => {
      expect(() => parsePlainJson(text)).toThrowError(expect.objectContaining({ code: 'reserved-key' }))
    },
  )

  it('retains dangerous-looking keys as own data without changing prototypes', () => {
    const value = parsePlainJson('{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"prototype":"literal"}') as Record<string, NumenValue>
    expect(Object.hasOwn(value, '__proto__')).toBe(true)
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(JSON.parse(stringifyNumenValue(value))).toEqual(value)
  })

  it('enforces exact UTF-8 byte bounds on encoded values and original JSON text', () => {
    const exact = `"${'a'.repeat(MAX_JSON_BYTES - 2)}"`
    expect(parsePlainJson(exact)).toHaveLength(MAX_JSON_BYTES - 2)
    expect(() => parsePlainJson(`${exact} `)).toThrowError(expect.objectContaining({ code: 'too-large' }))
    expect(() => stringifyNumenValue('界'.repeat(Math.ceil(MAX_JSON_BYTES / 3)))).toThrowError(expect.objectContaining({ code: 'too-large' }))
    expect(() => stringifyNumenValue('\n'.repeat(MAX_JSON_BYTES / 2))).toThrowError(expect.objectContaining({ code: 'too-large' }))
  })

  it('counts container levels and aggregate array entries at exact boundaries', () => {
    const nested = (levels: number): string => '['.repeat(levels) + 'null' + ']'.repeat(levels)
    expect(parsePlainJson(nested(MAX_JSON_DEPTH))).toBeDefined()
    expect(() => parsePlainJson(nested(MAX_JSON_DEPTH + 1))).toThrowError(expect.objectContaining({ code: 'too-deep' }))
    expect(parsePlainJson(JSON.stringify(Array(MAX_ARRAY_ITEMS).fill(null)))).toHaveLength(MAX_ARRAY_ITEMS)
    expect(() => parsePlainJson(JSON.stringify(Array(MAX_ARRAY_ITEMS + 1).fill(null)))).toThrowError(expect.objectContaining({ code: 'too-many-items' }))
    expect(() => parsePlainJson(JSON.stringify({ first: Array(6000).fill(0), second: Array(6000).fill(0) }))).toThrowError(expect.objectContaining({ code: 'too-many-items' }))
  })

  it('rejects non-finite parsed numbers and unsafe JavaScript objects without executing getters', () => {
    expect(() => parsePlainJson('1e999')).toThrowError(expect.objectContaining({ code: 'invalid-value' }))
    let accessed = false
    const accessor = Object.defineProperty({}, 'secret', { enumerable: true, get() { accessed = true; return 'secret' } })
    for (const value of [NaN, Infinity, -Infinity, undefined, 1n, () => 1, new Date(), new Map(), [undefined], Array(2), accessor, { [Symbol('key')]: 1 }]) {
      expect(() => stringifyNumenValue(value)).toThrowError(expect.objectContaining({ code: 'invalid-value' }))
    }
    expect(accessed).toBe(false)
  })

  it('accepts shared trees while rejecting direct and indirect cycles', () => {
    const shared = { value: 1 }
    expect(stringifyNumenValue({ a: shared, b: shared })).toBe('{"a":{"value":1},"b":{"value":1}}')
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    expect(() => stringifyNumenValue(cycle)).toThrowError(expect.objectContaining({ code: 'invalid-value' }))
    expect(() => stringifyNumenValue({ nested: [cycle] })).toThrowError(expect.objectContaining({ code: 'invalid-value' }))
  })
})

describe('Data Integration', () => {
  it('registers four local v1 query capabilities and removes them on unload', async () => {
    const root = new Context()
    roots.push(root)
    await root.plugin(CapabilityRegistry)
    const plugin = root.plugin(dataIntegrationPlugin)
    await plugin
    expect(root.capabilities.list()).toHaveLength(4)
    for (const { definition, providerAvailable } of root.capabilities.list()) {
      expect(definition).toMatchObject({ version: 1, kind: 'query', semantics: { sideEffect: false, idempotent: true, retrySafe: true } })
      expect(providerAvailable).toBe(true)
    }
    await plugin.dispose()
    expect(root.capabilities.list()).toEqual([])
  })

  it('round trips null and nested values, and rejects absent values', async () => {
    const root = await createRoot()
    for (const value of [null, [], {}, { a: [0, false, '', { b: null }] }]) {
      const encoded = await invoke(root, jsonStringifyCapability, { value }) as { text: string }
      expect(await invoke(root, jsonParseCapability, { text: encoded.text })).toEqual({ value })
    }
    await expect(invoke(root, jsonStringifyCapability, {})).rejects.toMatchObject({ code: 'invalid-value' })
    await expect(invoke(root, jsonParseCapability, {})).rejects.toMatchObject({ code: 'invalid-json' })
  })

  it('merges shallowly without mutating frozen inputs and preserves dangerous keys through Schema validation', async () => {
    const root = await createRoot()
    const base = Object.freeze({ nested: Object.freeze({ keep: 1 }), plain: 1 })
    const fields = Object.freeze({ nested: Object.freeze({ replacement: true }), added: 'yes' })
    expect(await invoke(root, objectMergeCapability, { base, fields })).toEqual({ value: { nested: { replacement: true }, plain: 1, added: 'yes' } })
    expect(base.nested).toEqual({ keep: 1 })
    const dangerous = JSON.parse('{"__proto__":{"polluted":true},"constructor":"literal"}')
    const normalized = objectMergeCapability.input({ base: {}, fields: dangerous })
    const output = await invoke(root, objectMergeCapability, normalized) as { value: Record<string, NumenValue> }
    expect(Object.hasOwn(output.value, '__proto__')).toBe(true)
    expect(output.value.constructor).toBe('literal')
    expect(Object.getPrototypeOf(output.value)).toBe(Object.prototype)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('preserves existing resource atoms but cannot construct a reference through merge or parsing', async () => {
    const root = await createRoot()
    const reference = { $resource: 'res_existing' }
    expect(await invoke(root, objectMergeCapability, { base: { attachment: reference }, fields: { approved: true } })).toEqual({ value: { attachment: reference, approved: true } })
    expect(await invoke(root, arrayUniqueCapability, { items: [reference, { $resource: 'res_existing' }] })).toEqual({ items: [reference] })
    for (const input of [{ base: {}, fields: reference }, { base: reference, fields: {} }, { base: {}, fields: { $resource: 'id', other: true } }]) {
      await expect(invoke(root, objectMergeCapability, input)).rejects.toBeInstanceOf(DataValueError)
    }
    await expect(invoke(root, jsonParseCapability, { text: JSON.stringify(reference) })).rejects.toMatchObject({ code: 'reserved-key' })
  })

  it('deduplicates structure with stable ordering, correct type distinction and shared references', async () => {
    const root = await createRoot()
    const shared = { x: 1 }
    const first = { b: [1, { y: true }], a: null }
    const items = [first, { a: null, b: [1, { y: true }] }, '1', 1, null, null, [1, 2], [2, 1], shared, shared, { x: 1 }]
    const output = await invoke(root, arrayUniqueCapability, { items })
    expect(output).toEqual({ items: [first, '1', 1, null, [1, 2], [2, 1], shared] })
    expect(isNumenValue(output)).toBe(true)
    expect(items).toHaveLength(11)
    expect(await invoke(root, arrayUniqueCapability, { items: [] })).toEqual({ items: [] })
  })

  it('compares own top-level fields structurally, including null and empty-string keys', async () => {
    const root = await createRoot()
    const first = { id: { a: 1, b: 2 }, other: 'first' }
    expect(await invoke(root, arrayUniqueCapability, { items: [first, { id: { b: 2, a: 1 }, other: 'second' }, { id: null }], key: 'id' })).toEqual({ items: [first, { id: null }] })
    expect(await invoke(root, arrayUniqueCapability, { items: [{ '': false }, { '': false }, { '': 0 }], key: '' })).toEqual({ items: [{ '': false }, { '': 0 }] })
    for (const items of [[{ id: 1 }, {}], [null], [1], [[{ id: 1 }]], [{ nested: { id: 1 } }]]) {
      await expect(invoke(root, arrayUniqueCapability, { items, key: 'id' })).rejects.toMatchObject({ code: 'missing-key' })
    }
  })

  it('rejects input and expanded output limits, cycles, and cancellation before accessing input', async () => {
    const root = await createRoot()
    await expect(invoke(root, jsonStringifyCapability, { value: 'a'.repeat(MAX_JSON_BYTES) })).rejects.toMatchObject({ code: 'too-large' })
    // Input JSON fits, but nested string escaping makes the output exceed 1 MiB.
    await expect(invoke(root, jsonStringifyCapability, { value: '\n'.repeat(400_000) })).rejects.toMatchObject({ code: 'too-large' })
    await expect(invoke(root, arrayUniqueCapability, { items: Array(MAX_ARRAY_ITEMS + 1).fill(1) })).rejects.toMatchObject({ code: 'too-many-items' })
    const cycle: unknown[] = []
    cycle.push(cycle)
    await expect(invoke(root, arrayUniqueCapability, { items: cycle })).rejects.toMatchObject({ code: 'invalid-value' })
    const controller = new AbortController()
    const reason = new Error('cancelled')
    controller.abort(reason)
    let accessed = false
    const input = { get text() { accessed = true; return 'null' } }
    for (const capability of [jsonParseCapability, jsonStringifyCapability, objectMergeCapability, arrayUniqueCapability]) {
      await expect(invoke(root, capability, input, controller.signal)).rejects.toBe(reason)
    }
    expect(accessed).toBe(false)
  })

  it('runs a real persisted parse, merge, deduplicate and stringify workflow and stops malformed external input', async () => {
    const root = await createRoot()
    const directory = await mkdtemp(join(tmpdir(), 'numen-data-'))
    directories.push(directory)
    await root.plugin(DatabaseService, { path: join(directory, 'numen.db') })
    await root.plugin(AutomationService)
    await root.plugin(ResourceService, { path: join(directory, 'resources') })
    await root.plugin(SchedulerService, { autoDispatch: false })

    // Null must survive both Schemastery validation and persisted step binding.
    const nullWorkflow = root.automations.create({ name: 'Null JSON round trip', source: {
      triggers: [],
      flow: { type: 'block', id: 'flow', steps: [
        { type: 'capability', id: 'parse', capability: jsonParseCapability, input: { text: { type: 'literal', value: 'null' } } },
        { type: 'capability', id: 'stringify', capability: jsonStringifyCapability, input: { value: { type: 'ref', path: 'steps.parse.value' } } },
      ] },
    } })
    const nullRevision = root.automations.publishDraft(nullWorkflow.automation.id, 1)
    root.automations.activateRevision(nullWorkflow.automation.id, nullRevision.id)
    const nullRun = root.scheduler.startManual(nullWorkflow.automation.id)
    await root.scheduler.dispatchUntilIdle()
    expect(root.scheduler.getRun(nullRun.id)?.status).toBe('COMPLETED')
    expect(root.scheduler.listExecutions(nullRun.id).find(item => item.instructionId === 'stringify')?.output).toEqual({ text: 'null' })

    for (const valid of [true, false]) {
      const { automation } = root.automations.create({ name: `Data workflow ${valid}`, source: {
        triggers: [],
        flow: { type: 'block', id: 'flow', steps: [
          { type: 'capability', id: 'parse', capability: jsonParseCapability, input: { text: { type: 'literal', value: valid ? '{"items":[{"id":1,"keep":true},{"id":1,"keep":false},{"id":2}]}' : '{"$resource":"forged"}' } } },
          { type: 'capability', id: 'merge', capability: objectMergeCapability, input: { base: { type: 'ref', path: 'steps.parse.value' }, fields: { type: 'literal', value: { source: 'integration-test' } } } },
          { type: 'capability', id: 'unique', capability: arrayUniqueCapability, input: { items: { type: 'ref', path: 'steps.merge.value.items' }, key: { type: 'literal', value: 'id' } } },
          { type: 'capability', id: 'stringify', capability: jsonStringifyCapability, input: { value: { type: 'ref', path: 'steps.unique.items' } } },
        ] },
      } })
      const revision = root.automations.publishDraft(automation.id, 1)
      root.automations.activateRevision(automation.id, revision.id)
      const run = root.scheduler.startManual(automation.id)
      await root.scheduler.dispatchUntilIdle()
      expect(root.scheduler.getRun(run.id)?.status).toBe(valid ? 'COMPLETED' : 'FAILED')
      const executions = root.scheduler.listExecutions(run.id)
      if (valid) {
        expect(executions.find(item => item.instructionId === 'stringify')?.output).toEqual({ text: '[{"id":1,"keep":true},{"id":2}]' })
      } else {
        expect(executions.find(item => item.instructionId === 'stringify')?.output).toBeUndefined()
        expect(executions.find(item => item.instructionId === 'parse')).toMatchObject({ status: 'FAILED', output: { name: 'DataValueError' } })
        expect(JSON.stringify(executions.find(item => item.instructionId === 'parse')?.output)).not.toContain('forged')
      }
    }
  })
})
