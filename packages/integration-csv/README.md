# @numenjs/integration-csv

Two local version 1 Query Capabilities for reading and writing CSV. They need no Connection, have no external side effects, and are safe to retry. Parsing uses [`csv-parse/sync`](https://csv.js.org/parse/api/sync/) **7.0.3**; writing uses [`csv-stringify/sync`](https://csv.js.org/stringify/api/sync/) **6.9.0**, both pinned.

| Capability | Input | Output |
| --- | --- | --- |
| `csv:parse` | `{ text, delimiter? }` | `{ rows: Record<string, string>[], columns: string[] }` |
| `csv:stringify` | `{ rows, columns?, delimiter?, escapeFormulas? }` | `{ text: string }` |

`delimiter` is comma (default), semicolon, or the actual tab character (`"\t"` in JSON). Schema fields support normal Numen expressions and references to previous step outputs.

## Parse CSV

The first nonempty record supplies column names. UTF-8 BOM, CRLF, LF, CR, quoted separators, escaped double quotes and quoted multiline values are supported. Completely empty lines are skipped; whitespace-only lines and quoted empty cells are data. Cell content and header whitespace are preserved, and every cell remains a string, so `001` stays `"001"`.

Empty text, a lone BOM, or only empty lines returns `{ rows: [], columns: [] }`. A header-only document returns its columns with no rows. Blank or whitespace-only column names, duplicate names, `$resource`, malformed quotes and inconsistent column counts fail explicitly. Error messages do not include CSV content or parser excerpts.

```ts
import type { CsvParseInput, CsvParseOutput } from '@numenjs/integration-csv'

const input: CsvParseInput = {
  text: '\uFEFFname,note\r\n"Ada, Jr.","first\nsecond"\r\n',
}
const output: CsvParseOutput = {
  columns: ['name', 'note'],
  rows: [{ name: 'Ada, Jr.', note: 'first\nsecond' }],
}
```

## Stringify CSV

Rows must be plain objects whose cells are strings, finite numbers, booleans or `null`. Numbers use their decimal string representation, booleans become `true`/`false`, and missing or null cells become empty cells. Nested objects and arrays are rejected, including in fields omitted by an explicit column projection.

Omitting `columns` uses the union of row keys in their first-seen order. Explicit columns control projection and order; absent fields produce empty cells. Empty rows without columns produce empty text; empty rows with columns produce only the header. Nonempty rows with no columns are rejected. Output uses LF line endings and a final newline.

```ts
import type { CsvStringifyInput, CsvStringifyOutput } from '@numenjs/integration-csv'

const input: CsvStringifyInput = {
  rows: [{ name: 'Ada', score: 0 }, { name: 'Mira', active: false }],
  columns: ['name', 'active', 'score'],
}
const output: CsvStringifyOutput = {
  text: 'name,active,score\nAda,,0\nMira,false,\n',
}
```

`escapeFormulas` defaults to `true`. Formula-like headers and cells beginning with `=`, `+`, `-`, `@`, tab, CR, LF, or their full-width formula symbol equivalents are prefixed with an apostrophe. For example, `=SUM(1,2)` becomes `'=SUM(1,2)` and a negative numeric cell `-42` becomes `'-42`. This intentionally changes text exported to spreadsheet applications; CSV quoting alone does not provide this protection. Set `escapeFormulas: false` explicitly when exact original cell text is required for a trusted consumer. See the library's [formula escaping documentation](https://csv.js.org/stringify/options/escape_formulas/).

## Limits and safety

- Complete serialized input and output envelopes each allow **1 MiB of UTF-8 JSON**, **64 container levels**, and **10,000 cumulative array entries**, using the shared `integration-data/json` boundary. CSV quoting and JSON escaping count toward the output limit.
- At most **256 columns** are allowed. Parse output counts both row entries and column names, so a one-column file permits at most 9,999 data rows. Explicit `columns` also count toward the stringify input limit.
- Repeated header names across rows can make parsed JSON larger than its source CSV; such expansion is checked during parsing. Writing checks each emitted row before accumulating the complete text.
- Inputs are not mutated. Shared references are copied into independent JSON subtrees; cycles, getters, sparse arrays and unsupported JavaScript objects are rejected.
- `$resource` cannot appear as a column or internal row key. Literal `__proto__`, `constructor` and `prototype` names are preserved safely as own data properties; no prototype-sensitive assignment is used.
- Cancellation is checked before processing and between records.

For a composed flow, use **Parse CSV → Remove Duplicate Items → Stringify CSV**. Bind the deduplication node's `items` to `steps.<parseId>.rows`, choose a key such as `id`, then bind stringify `rows` to `steps.<deduplicateId>.items` and `columns` to `steps.<parseId>.columns`.

From the repository root:

```sh
pnpm exec tsc -b packages/integration-csv --pretty
pnpm exec vitest run packages/integration-csv/tests/integration.test.ts
```
