import { defineCapability, type CapabilityDefinition, type CapabilityProvider, type NumenValue } from '@numenjs/core'
import type { Context } from 'cordis'
import type Schema from 'schemastery'
import z from 'schemastery'
import { DataValueError, parsePlainJson, snapshotNumenValue, stringifyNumenValue } from './json.js'

export interface JsonParseInput { text: string }
export interface ValueOutput { value: NumenValue }
export interface JsonStringifyInput { value: NumenValue }
export interface JsonStringifyOutput { text: string }
export interface ObjectMergeInput { base: Record<string, NumenValue>; fields: Record<string, NumenValue> }
export interface ArrayUniqueInput { items: NumenValue[]; key?: string }
export interface ArrayUniqueOutput { items: NumenValue[] }

const semantics = { sideEffect: false, idempotent: true, retrySafe: true }
// Schemastery's required() also rejects null, which is a valid JSON value.
// The provider always returns the field and validates missing input explicitly.
const valueOutput = z.object({ value: z.any() }) as Schema<ValueOutput>

export const jsonParseCapability = defineCapability({
  id: 'data:json-parse', version: 1, kind: 'query', title: 'Parse JSON',
  description: 'Parse strict JSON text into a value. Rejects reserved resource keys; maximum 1 MiB, 64 levels and 10,000 array entries.',
  input: z.object({ text: z.string().required().description('JSON text, for example {"name":"Ada","active":true}.') }),
  output: valueOutput, semantics,
})

export const jsonStringifyCapability = defineCapability({
  id: 'data:json-stringify', version: 1, kind: 'query', title: 'Stringify JSON',
  description: 'Encode a finite JSON value as compact JSON text. Invalid or oversized values fail explicitly.',
  input: z.object({ value: z.any().description('Value to serialize, including null; usually a reference to a previous step output.') }) as Schema<JsonStringifyInput>,
  output: z.object({ text: z.string().required() }), semantics,
})

export const objectMergeCapability = defineCapability({
  id: 'data:object-merge', version: 1, kind: 'query', title: 'Merge Object Fields',
  description: 'Shallow merge two objects. Fields replace matching base fields; nested objects are replaced as a whole. Inputs are never changed.',
  input: z.object({
    // Keep arbitrary field names out of Schemastery's dictionary normalizer,
    // which assigns keys into {}. The provider validates these JSON objects.
    base: z.any().required().description('Original object, for example {"name":"Ada","role":"reader"}.'),
    fields: z.any().required().description('Fields to overwrite or add, for example {"role":"editor"}. Use expressions for mapping.'),
  }) as Schema<ObjectMergeInput>,
  output: valueOutput, semantics,
})

export const arrayUniqueCapability = defineCapability({
  id: 'data:array-unique', version: 1, kind: 'query', title: 'Remove Duplicate Items',
  description: 'Keep the first occurrence of each structural value, ignoring object key order. Optionally compare one required top-level field.',
  input: z.object({
    items: z.array(z.any()).required().description('Array to deduplicate; at most 10,000 total array entries.'),
    key: z.string().description('Optional top-level field, for example id. Every item must have this own field; dotted names are literal keys.'),
  }) as Schema<ArrayUniqueInput>,
  output: z.object({ items: z.array(z.any()).required() }) as Schema<ArrayUniqueOutput>, semantics,
})

function requireRecord(value: unknown): asserts value is Record<string, NumenValue> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.hasOwn(value, '$resource')) {
    throw new DataValueError('invalid-value', 'Expected an object containing ordinary fields, not a resource reference.')
  }
}

function register<Input, Output>(
  ctx: Context,
  capability: CapabilityDefinition<Input, Output>,
  transform: (input: Input, signal: AbortSignal) => Output,
): void {
  ctx.capabilities.define(ctx, capability)
  ctx.capabilities.provide(ctx, capability, {
    async invoke({ input, signal }) {
      signal.throwIfAborted()
      const checkedInput = snapshotNumenValue(input, signal) as Input
      const output = transform(checkedInput, signal)
      return snapshotNumenValue(output, signal) as Output
    },
  } satisfies CapabilityProvider<Input, Output>)
}

export function dataIntegrationPlugin(ctx: Context): void {
  register(ctx, jsonParseCapability, (input, signal) => ({ value: parsePlainJson(input.text, signal) }))
  register(ctx, jsonStringifyCapability, (input, signal) => ({ text: stringifyNumenValue(input.value, { signal }) }))
  register(ctx, objectMergeCapability, input => {
    requireRecord(input.base)
    requireRecord(input.fields)
    // Spread uses CreateDataProperty, so __proto__ remains inert own data.
    return { value: { ...input.base, ...input.fields } }
  })
  register(ctx, arrayUniqueCapability, (input, signal) => {
    if (!Array.isArray(input.items) || (input.key !== undefined && typeof input.key !== 'string')) {
      throw new DataValueError('invalid-value', 'Expected an array and an optional string field name.')
    }
    const seen = new Set<string>()
    const items: NumenValue[] = []
    for (const item of input.items) {
      signal.throwIfAborted()
      let value = item
      if (input.key !== undefined) {
        if (!item || typeof item !== 'object' || Array.isArray(item) || !Object.hasOwn(item, input.key)) {
          throw new DataValueError('missing-key', 'Every array item must contain the requested own top-level field.')
        }
        value = (item as Record<string, NumenValue>)[input.key]!
      }
      const key = stringifyNumenValue(value, { sortKeys: true, signal })
      if (!seen.has(key)) {
        seen.add(key)
        items.push(item)
      }
    }
    return { items }
  })
}

dataIntegrationPlugin.inject = ['capabilities']

export default dataIntegrationPlugin
