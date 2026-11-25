import type { NumenValue } from '@numenjs/core'

export const MAX_JSON_BYTES = 1024 * 1024
export const MAX_JSON_DEPTH = 64
/** Total array entries across a value, including repeated shared subtrees. */
export const MAX_ARRAY_ITEMS = 10_000

export type DataValueErrorCode =
  | 'invalid-json'
  | 'invalid-value'
  | 'reserved-key'
  | 'too-large'
  | 'too-deep'
  | 'too-many-items'
  | 'missing-key'

/** Safe for HTTP responses and execution history: never contains input data. */
export class DataValueError extends TypeError {
  override name = 'DataValueError'

  constructor(public readonly code: DataValueErrorCode, message: string) {
    super(message)
  }
}

function invalid(): never {
  throw new DataValueError('invalid-value', 'Expected a finite, acyclic JSON value with plain data properties.')
}

interface SerializationOptions {
  rejectResources?: boolean
  sortKeys?: boolean
  signal?: AbortSignal | undefined
}

/**
 * Validate while encoding, before unbounded serialization or cloning can occur.
 * The ancestor set rejects cycles but permits ordinary shared input references.
 * Encoding each occurrence independently produces a tree safe for persistence.
 */
export function stringifyNumenValue(value: unknown, options: SerializationOptions = {}): string {
  const chunks: string[] = []
  const ancestors = new Set<object>()
  let bytes = 0
  let arrayItems = 0
  const append = (text: string): void => {
    bytes += Buffer.byteLength(text)
    if (bytes > MAX_JSON_BYTES) throw new DataValueError('too-large', 'JSON value exceeds 1 MiB.')
    chunks.push(text)
  }
  const quote = (text: string): void => {
    // Avoid allocating a large escaped string for an already oversized value.
    if (text.length > MAX_JSON_BYTES) throw new DataValueError('too-large', 'JSON value exceeds 1 MiB.')
    append(JSON.stringify(text))
  }
  const visit = (item: unknown, depth: number): void => {
    options.signal?.throwIfAborted()
    if (item === null) return append('null')
    if (typeof item === 'string') return quote(item)
    if (typeof item === 'boolean') return append(String(item))
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) invalid()
      return append(JSON.stringify(item))
    }
    if (!item || typeof item !== 'object') invalid()
    if (depth > MAX_JSON_DEPTH) throw new DataValueError('too-deep', 'JSON value exceeds 64 container levels.')
    if (ancestors.has(item)) invalid()
    ancestors.add(item)
    try {
      const keys = Reflect.ownKeys(item)
      if (Array.isArray(item)) {
        arrayItems += item.length
        if (arrayItems > MAX_ARRAY_ITEMS) throw new DataValueError('too-many-items', 'JSON value exceeds 10,000 array entries.')
        // JSON must not silently drop sparse entries, accessors, or array properties.
        if (keys.length !== item.length + 1) invalid()
        append('[')
        for (let index = 0; index < item.length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(item, String(index))
          if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalid()
          if (index) append(',')
          visit(descriptor.value, depth + 1)
        }
        append(']')
        return
      }
      const prototype = Object.getPrototypeOf(item)
      if (prototype !== null && prototype !== Object.prototype) invalid()
      if (keys.some(key => typeof key !== 'string')) invalid()
      const names = keys as string[]
      if (Object.hasOwn(item, '$resource')) {
        if (options.rejectResources) {
          throw new DataValueError('reserved-key', 'External JSON cannot contain the reserved $resource key.')
        }
        const descriptor = Object.getOwnPropertyDescriptor(item, '$resource')
        if (names.length !== 1 || !descriptor || typeof descriptor.value !== 'string') {
          throw new DataValueError('reserved-key', 'A resource reference must be an existing standalone reference.')
        }
      }
      if (options.sortKeys) names.sort()
      append('{')
      for (let index = 0; index < names.length; index++) {
        const key = names[index]!
        const descriptor = Object.getOwnPropertyDescriptor(item, key)!
        if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalid()
        if (index) append(',')
        quote(key)
        append(':')
        visit(descriptor.value, depth + 1)
      }
      append('}')
    } finally {
      ancestors.delete(item)
    }
  }
  visit(value, 1)
  return chunks.join('')
}

/** Strict external JSON boundary. Parser diagnostics deliberately omit raw text. */
export function parsePlainJson(text: string, signal?: AbortSignal): NumenValue {
  signal?.throwIfAborted()
  if (typeof text !== 'string') throw new DataValueError('invalid-json', 'Expected JSON text.')
  if (Buffer.byteLength(text) > MAX_JSON_BYTES) throw new DataValueError('too-large', 'JSON text exceeds 1 MiB.')
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new DataValueError('invalid-json', 'Text is not valid JSON.')
  }
  stringifyNumenValue(value, { rejectResources: true, signal })
  return value as NumenValue
}

/** Own-property JSON parsing also preserves literal __proto__ keys safely. */
export function snapshotNumenValue(value: unknown, signal?: AbortSignal): NumenValue {
  return JSON.parse(stringifyNumenValue(value, { signal })) as NumenValue
}
