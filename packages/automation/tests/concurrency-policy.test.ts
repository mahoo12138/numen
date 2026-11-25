import type { AutomationSource, ValueExpr } from '@numenjs/core'
import { describe, expect, it } from 'vitest'
import { AutomationCompileError, compileAutomation } from '../src/compiler.js'

const resolver = { get: () => undefined }
const ref = (path: string): ValueExpr => ({ type: 'ref', path })
const literal = (value: string | number | boolean | null): ValueExpr => ({ type: 'literal', value })
const source = (graph: boolean, policy?: unknown): AutomationSource => ({
  triggers: [],
  flow: graph ? { type: 'graph', version: 1, id: 'flow', nodes: [], edges: [] }
    : { type: 'block', id: 'flow', steps: [] },
  ...(policy === undefined ? {} : { policy: policy as AutomationSource['policy'] }),
})
function errors(candidate: AutomationSource) {
  try { compileAutomation(candidate, resolver) } catch (error) {
    expect(error).toBeInstanceOf(AutomationCompileError)
    return (error as AutomationCompileError).diagnostics
  }
  throw Error('Expected compilation to reject policy')
}

describe.each([false, true])('concurrency policy (graph=%s)', graph => {
  it.each([null, false, '', 3, []].map(value => [value] as const))('rejects a non-object policy: %j', policy => {
    expect(errors(source(graph, policy))).toContainEqual(expect.objectContaining({ code: 'POLICY_STRUCTURE_INVALID' }))
  })

  it.each([0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, '1', null])('rejects invalid maxActive: %j', maxActive => {
    expect(errors(source(graph, { maxActive }))).toContainEqual(expect.objectContaining({
      code: 'POLICY_MAX_ACTIVE_INVALID', source: { fieldPath: 'policy.maxActive' },
    }))
  })

  it.each(['', 'discard', 'QUEUE', 0, null, false, []].map(value => [value] as const))('rejects an unknown overflow mode: %j', overflow => {
    expect(errors(source(graph, { overflow }))).toContainEqual(expect.objectContaining({
      code: 'POLICY_OVERFLOW_INVALID', source: { fieldPath: 'policy.overflow' },
    }))
  })

  it.each([null, false, 0, '', {}, [], { type: 'array' }, { type: 'object' }, { type: 'template', parts: [null] }].map(value => [value] as const))('rejects malformed groupBy: %j', groupBy => {
    expect(errors(source(graph, { groupBy }))).toContainEqual(expect.objectContaining({ source: expect.objectContaining({ fieldPath: expect.stringMatching(/^policy\.groupBy/) }) }))
  })

  it.each(['run.id', 'vars.customer', 'error.code'])('rejects unavailable admission root %s', path => {
    expect(errors(source(graph, { groupBy: ref(path) }))).toContainEqual(expect.objectContaining({
      code: 'POLICY_GROUP_BY_REFERENCE_INVALID', source: { nodeId: '__policy', fieldPath: 'policy.groupBy' },
    }))
  })

  it('finds forbidden references nested in object, array, call and template expressions', () => {
    const groupBy: ValueExpr = { type: 'object', entries: {
      key: { type: 'array', items: [{ type: 'call', function: 'core:to-string', arguments: [ref('run.id')] }] },
      label: { type: 'template', parts: ['group-', { ref: 'vars.group' }] },
    } }
    expect(errors(source(graph, { groupBy })).filter(item => item.code === 'POLICY_GROUP_BY_REFERENCE_INVALID')
      .map(item => item.source?.fieldPath)).toEqual(['policy.groupBy.key.0.arguments.0', 'policy.groupBy.label.parts.1'])
  })

  it('keeps step and loop availability diagnostics for admission references', () => {
    expect(errors(source(graph, { groupBy: ref('steps.future.id') }))).toContainEqual(expect.objectContaining({ code: 'STEP_REFERENCE_NOT_READY' }))
    expect(errors(source(graph, { groupBy: ref('loop.item') }))).toContainEqual(expect.objectContaining({ code: 'LOOP_REFERENCE_OUT_OF_SCOPE' }))
  })

  it('accepts trigger and declared input expressions without treating literal content as references', () => {
    const candidate = source(graph, { maxActive: Number.MAX_SAFE_INTEGER, overflow: 'queue', groupBy: {
      type: 'object', entries: {
        key: { type: 'array', items: [ref('trigger.customer'), { type: 'call', function: 'core:to-string', arguments: [ref('input.account')] }] },
        label: { type: 'template', parts: ['account-', { ref: 'input.account' }] },
        opaque: { type: 'literal', value: { type: 'ref', path: 'run.id' } },
      },
    } })
    candidate.inputs = { account: { type: 'string' } }
    const original = structuredClone(candidate)
    expect(compileAutomation(candidate, resolver).plan).toEqual(compileAutomation(source(graph), resolver).plan)
    expect(candidate).toEqual(original)
  })

  it('checks declared input names inside groupBy', () => {
    const candidate = source(graph, { groupBy: { type: 'template', parts: [{ ref: 'input.missing' }] } })
    candidate.inputs = { account: { type: 'string' } }
    expect(errors(candidate)).toContainEqual(expect.objectContaining({
      code: 'INPUT_REFERENCE_MISSING', source: { nodeId: '__policy', fieldPath: 'policy.groupBy.parts.0' },
    }))
  })

  it('preserves omitted policy defaults, all modes, and literal grouping values', () => {
    for (const policy of [undefined, {}, ...(['queue', 'drop', 'replace'] as const).map(overflow => ({ maxActive: 1, overflow }))]) {
      expect(() => compileAutomation(source(graph, policy), resolver)).not.toThrow()
    }
    for (const value of [null, '', 0, false]) expect(() => compileAutomation(source(graph, { groupBy: literal(value) }), resolver)).not.toThrow()
  })
})
