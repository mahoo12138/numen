import { evaluateExpression, ExpressionEvaluationError, type EvaluationBindings, type NumenValue } from '../src/index.js'
import { describe, expect, it } from 'vitest'

const bindings = (input: Record<string, NumenValue>): EvaluationBindings => ({
  run: {}, trigger: {}, input, steps: {}, vars: {}, loop: {}, error: null,
})

describe('own-property expression references', () => {
  it('rejects inherited values at every reference segment, including prototype-like names', () => {
    const input = Object.assign(Object.create({ inherited: 'not-user-data' }), { nested: {} }) as Record<string, NumenValue>
    for (const path of ['input.inherited', 'input.__proto__', 'input.nested.__proto__', 'trigger.__proto__', 'input.constructor']) {
      expect(() => evaluateExpression({ type: 'ref', path }, bindings(input))).toThrow(`reference not found: ${path}`)
    }
    expect(() => evaluateExpression({ type: 'template', parts: [{ ref: 'input.inherited' }] }, bindings(input)))
      .toThrow(ExpressionEvaluationError)
  })

  it('preserves legitimate own JSON fields named __proto__ and constructor without mutating prototypes', () => {
    const input = JSON.parse('{"__proto__":{"customer":"owned"},"constructor":"literal"}') as Record<string, NumenValue>
    expect(evaluateExpression({ type: 'ref', path: 'input.__proto__.customer' }, bindings(input))).toBe('owned')
    expect(evaluateExpression({ type: 'ref', path: 'input.constructor' }, bindings(input))).toBe('literal')
    expect(Object.getPrototypeOf(input)).toBe(Object.prototype)
    expect(Object.hasOwn({}, 'customer')).toBe(false)
  })

  it('reads own properties from null-prototype records and preserves false, zero and null', () => {
    const input = Object.assign(Object.create(null), { falseValue: false, zero: 0, nil: null }) as Record<string, NumenValue>
    for (const [name, value] of Object.entries(input)) {
      expect(evaluateExpression({ type: 'ref', path: `input.${name}` }, bindings(input))).toBe(value)
    }
  })
})
