# @numenjs/integration-data

Four local, version 1 Query Capabilities for JSON and object processing. They require no Connection, have no external side effects, and are safe to retry.

| Capability | Input | Output |
| --- | --- | --- |
| `data:json-parse` | `{ text: string }` | `{ value: NumenValue }` |
| `data:json-stringify` | `{ value: NumenValue }` | `{ text: string }` |
| `data:object-merge` | `{ base: object, fields: object }` | `{ value: NumenValue }` |
| `data:array-unique` | `{ items: NumenValue[], key?: string }` | `{ items: NumenValue[] }` |

## Operations

Parsing is strict: invalid JSON fails without returning a default or exposing parser excerpts. `null` is valid. Stringify produces compact JSON and rejects non-finite numbers, `undefined`, sparse arrays, cycles, getters, and non-plain objects instead of silently dropping or coercing them.

Merge is shallow: `fields` replaces matching `base` fields, including entire nested objects. Use the normal workflow expressions to map fields from earlier steps. Neither input is modified. Literal `__proto__`, `constructor`, and `prototype` keys remain own data properties and cannot change an output object's prototype.

Unique preserves the first occurrence and its order. Without `key`, comparison uses the complete value, ignoring object key order and preserving array order and value types. With `key`, every item must be an object containing that own top-level field. `null` is a valid field value; missing fields fail. Dotted field names are literal keys, not paths.

```ts
import type {
  ArrayUniqueInput,
  JsonParseInput,
  JsonStringifyInput,
  ObjectMergeInput,
} from '@numenjs/integration-data'

const parse: JsonParseInput = { text: '{"name":"Ada","roles":["reader"]}' }
// Output: { value: { name: 'Ada', roles: ['reader'] } }

const merge: ObjectMergeInput = {
  base: { name: 'Ada', settings: { theme: 'light', language: 'en' } },
  fields: { settings: { theme: 'dark' } },
}
// Output: { value: { name: 'Ada', settings: { theme: 'dark' } } }

const unique: ArrayUniqueInput = {
  items: [{ id: 1, name: 'First' }, { id: 1, name: 'Second' }, { id: 2 }],
  key: 'id',
}
// Output: { items: [{ id: 1, name: 'First' }, { id: 2 }] }

const stringify: JsonStringifyInput = { value: [null, { ready: true }] }
// Output: { text: '[null,{"ready":true}]' }
```

## Limits and resource references

- Each complete serialized Capability input and output, including its wrapper fields, is limited to **1 MiB of UTF-8 JSON**. String escaping counts toward the limit; stringify can therefore reject an input whose resulting text wrapper is larger than the input.
- A value may contain at most **64 container levels** and **10,000 total array entries**, counting all nested arrays. Wrapper objects count as container levels.
- Shared input references are accepted and copied into independent JSON subtrees; cyclic references are rejected. Cancellation is checked before and during processing.
- External JSON recursively rejects every own `$resource` key. It cannot create an internal resource reference, even when the ID names a real resource.
- Existing standalone `ResourceRef` values may pass through internal operations as values. Merge does not accept a resource reference as either object operand or construct a new one from fields. Normal Scheduler resource ownership checks still apply.

## Shared external JSON boundary

The Webhook integration uses the same parser through the public `./json` subpath. Its limit applies to the original JSON text and parsed value, without a Capability wrapper. It checks structure after parsing and never includes raw input in errors.

```ts
import type { NumenValue } from '@numenjs/core'
import {
  DataValueError,
  MAX_ARRAY_ITEMS,
  MAX_JSON_BYTES,
  MAX_JSON_DEPTH,
  parsePlainJson,
} from '@numenjs/integration-data/json'

function decodeExternalJson(text: string): NumenValue {
  try {
    return parsePlainJson(text)
  } catch (error) {
    if (error instanceof DataValueError) {
      // error.code identifies invalid-json, reserved-key, too-large,
      // too-deep, too-many-items, or invalid-value without exposing input.
      throw error
    }
    throw error
  }
}
```

Run the scoped checks from the repository root:

```sh
pnpm exec tsc -b packages/integration-data --pretty
pnpm exec vitest run packages/integration-data/tests/integration.test.ts
```
