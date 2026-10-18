import { defineCapability, type CapabilityDefinition, type CapabilityProvider } from '@numenjs/core'
import { DataValueError, MAX_ARRAY_ITEMS, MAX_JSON_BYTES, stringifyNumenValue } from '@numenjs/integration-data/json'
import type { Context } from 'cordis'
import { parse } from 'csv-parse/sync'
import { stringify } from 'csv-stringify/sync'
import type Schema from 'schemastery'
import z from 'schemastery'

export const MAX_CSV_COLUMNS = 256
export type CsvDelimiter = ',' | ';' | '\t'
export type CsvCell = string | number | boolean | null
export interface CsvParseInput { text: string; delimiter?: CsvDelimiter }
export interface CsvParseOutput { rows: Record<string, string>[]; columns: string[] }
export interface CsvStringifyInput { rows: Record<string, CsvCell>[]; columns?: string[]; delimiter?: CsvDelimiter; escapeFormulas?: boolean }
export interface CsvStringifyOutput { text: string }
export type CsvErrorCode = 'CSV_INPUT_INVALID' | 'CSV_HEADERS_INVALID' | 'CSV_COLUMNS_LIMIT' | 'CSV_PARSE_INVALID' | 'CSV_CELL_INVALID'

const errorMessages: Record<CsvErrorCode, string> = {
  CSV_INPUT_INVALID: 'Expected CSV text or an array of plain row objects with valid options.',
  CSV_HEADERS_INVALID: 'CSV columns must be unique, nonblank strings without the reserved $resource name; nonempty rows require columns.',
  CSV_COLUMNS_LIMIT: 'CSV supports at most 256 columns.',
  CSV_PARSE_INVALID: 'CSV contains malformed quoting or inconsistent column counts.',
  CSV_CELL_INVALID: 'CSV cells must be strings, finite numbers, booleans or null.',
}

/** Safe errors omit parser excerpts, column names and cell contents. */
export class CsvError extends TypeError {
  override name = 'CsvError'
  constructor(public readonly code: CsvErrorCode) { super(errorMessages[code]) }
}

const semantics = { sideEffect: false, idempotent: true, retrySafe: true }
const delimiterSchema = () => z.union([',', ';', '\t']).default(',').description('Column separator: comma (,), semicolon (;), or tab. The default is comma.')

export const csvParseCapability = defineCapability<CsvParseInput, CsvParseOutput>({
  id: 'csv:parse', version: 1, kind: 'query', title: 'Parse CSV',
  description: 'Read CSV with a header row into string-valued rows. Supports BOM, quoted fields, CRLF and multiline values. Empty lines are skipped; malformed records fail.',
  input: z.object({
    text: z.string().role('numen/multiline').required().description('CSV text, for example name,score followed by Ada,42 on the next line. Empty text returns no rows or columns.'),
    delimiter: delimiterSchema(),
  }) as Schema<CsvParseInput>,
  // Avoid Schemastery dictionary normalization, which assigns arbitrary keys into {}.
  output: z.object({ rows: z.array(z.any()).required(), columns: z.array(z.string()).required() }) as Schema<CsvParseOutput>,
  semantics,
})

export const csvStringifyCapability = defineCapability<CsvStringifyInput, CsvStringifyOutput>({
  id: 'csv:stringify', version: 1, kind: 'query', title: 'Stringify CSV',
  description: 'Write a header row and CSV records. Columns follow first-seen keys unless supplied explicitly. Formula-like cells receive an apostrophe by default.',
  input: z.object({
    rows: z.array(z.any()).required().description('Array of objects with string, number, boolean or null cells. Missing cells and null become empty; nested values are rejected.'),
    columns: z.array(z.string()).description('Optional ordered column names, up to 256. Omit to use the union of row keys in first-seen order.'),
    delimiter: delimiterSchema(),
    escapeFormulas: z.boolean().default(true).description('Prefix formula-like headers and cells with an apostrophe. Disable only when the original values must be preserved for a trusted consumer.'),
  }) as Schema<CsvStringifyInput>,
  output: z.object({ text: z.string().required() }),
  semantics,
})

function checkedDelimiter(value: unknown): CsvDelimiter {
  if (value === undefined) return ','
  if (value !== ',' && value !== ';' && value !== '\t') throw new CsvError('CSV_INPUT_INVALID')
  return value
}

function checkColumns(value: unknown): asserts value is string[] {
  if (!Array.isArray(value)) throw new CsvError('CSV_HEADERS_INVALID')
  if (value.length > MAX_CSV_COLUMNS) throw new CsvError('CSV_COLUMNS_LIMIT')
  const names = new Set<string>()
  for (const column of value) {
    if (typeof column !== 'string' || !column.trim() || column === '$resource' || names.has(column)) throw new CsvError('CSV_HEADERS_INVALID')
    names.add(column)
  }
}

function parseCsv(input: CsvParseInput, signal: AbortSignal): CsvParseOutput {
  if (typeof input.text !== 'string') throw new CsvError('CSV_INPUT_INVALID')
  const delimiter = checkedDelimiter(input.delimiter)
  let columns: string[] | undefined
  let rowCount = 0
  let outputBytes = 0
  const rows: Record<string, string>[] = []
  try {
    parse(input.text, {
      bom: true, delimiter, skip_empty_lines: true, max_record_size: MAX_JSON_BYTES,
      relax_column_count: false, relax_quotes: false,
      cast(value, context) {
        signal.throwIfAborted()
        if (context.index >= MAX_CSV_COLUMNS) throw new CsvError('CSV_COLUMNS_LIMIT')
        return value
      },
      on_record(record: string[]) {
        signal.throwIfAborted()
        if (!columns) {
          checkColumns(record)
          columns = record
          outputBytes = Buffer.byteLength(stringifyNumenValue({ rows: [], columns }, { rejectResources: true, signal }))
          return null
        }
        if (record.length !== columns.length) throw new CsvError('CSV_PARSE_INVALID')
        if (++rowCount + columns.length > MAX_ARRAY_ITEMS) throw new DataValueError('too-many-items', 'JSON value exceeds 10,000 array entries.')
        // Object.fromEntries creates own data properties, including __proto__.
        const row = Object.fromEntries(columns.map((column, index) => [column, record[index]!]))
        outputBytes += Buffer.byteLength(stringifyNumenValue(row, { rejectResources: true, signal })) + (rowCount > 1 ? 1 : 0)
        if (outputBytes > MAX_JSON_BYTES) throw new DataValueError('too-large', 'JSON value exceeds 1 MiB.')
        rows.push(row)
        return null
      },
    })
    return { rows, columns: columns ?? [] }
  } catch (error) {
    signal.throwIfAborted()
    if (error instanceof CsvError || error instanceof DataValueError) throw error
    throw new CsvError('CSV_PARSE_INVALID')
  }
}

function stringifyCsv(input: CsvStringifyInput, signal: AbortSignal): CsvStringifyOutput {
  const delimiter = checkedDelimiter(input.delimiter)
  if (!Array.isArray(input.rows) || (input.escapeFormulas !== undefined && typeof input.escapeFormulas !== 'boolean')) throw new CsvError('CSV_INPUT_INVALID')
  const escapeFormulas = input.escapeFormulas ?? true
  if (input.columns !== undefined) checkColumns(input.columns)
  const inferred = new Set<string>()
  for (const row of input.rows) {
    signal.throwIfAborted()
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new CsvError('CSV_INPUT_INVALID')
    const keys = Object.keys(row)
    checkColumns(keys)
    for (const key of keys) {
      const value = row[key]
      if (value !== null && typeof value !== 'string' && typeof value !== 'boolean' && !(typeof value === 'number' && Number.isFinite(value))) {
        throw new CsvError('CSV_CELL_INVALID')
      }
      if (input.columns === undefined) {
        inferred.add(key)
        if (inferred.size > MAX_CSV_COLUMNS) throw new CsvError('CSV_COLUMNS_LIMIT')
      }
    }
  }
  const columns = input.columns ?? [...inferred]
  if (!columns.length) {
    if (input.rows.length) throw new CsvError('CSV_HEADERS_INVALID')
    return { text: '' }
  }
  // Serialize one bounded row at a time. Sparse projections must not allocate a
  // rows × columns matrix before the final output size can be checked.
  const chunks: string[] = []
  let bytes = Buffer.byteLength('{"text":""}')
  const append = (cells: string[]) => {
    signal.throwIfAborted()
    const text = stringify([cells], {
      delimiter, record_delimiter: '\n', escape_formulas: escapeFormulas,
      // The pinned library covers ASCII and full-width formula initiators;
      // also protect an initial LF, which its built-in option does not cover.
      cast: { string(value: string) { return escapeFormulas && value.startsWith('\n') ? `'${value}` : value } },
    })
    // Count JSON escaping, not just raw CSV bytes, for the {text} output envelope.
    bytes += Buffer.byteLength(JSON.stringify(text)) - 2
    if (bytes > MAX_JSON_BYTES) throw new DataValueError('too-large', 'JSON value exceeds 1 MiB.')
    chunks.push(text)
  }
  append(columns)
  for (const row of input.rows) {
    append(columns.map(column => Object.hasOwn(row, column) && row[column] !== null ? String(row[column]) : ''))
  }
  return { text: chunks.join('') }
}

function register<Input, Output>(ctx: Context, definition: CapabilityDefinition<Input, Output>, transform: (input: Input, signal: AbortSignal) => Output): void {
  ctx.capabilities.define(ctx, definition)
  ctx.capabilities.provide(ctx, definition, {
    async invoke({ input, signal }) {
      signal.throwIfAborted()
      const checked = JSON.parse(stringifyNumenValue(input, { rejectResources: true, signal })) as Input
      const output = transform(checked, signal)
      stringifyNumenValue(output, { rejectResources: true, signal })
      return output
    },
  } satisfies CapabilityProvider<Input, Output>)
}

export function csvIntegrationPlugin(ctx: Context): void {
  register(ctx, csvParseCapability, parseCsv)
  register(ctx, csvStringifyCapability, stringifyCsv)
}

csvIntegrationPlugin.inject = ['capabilities']
export default csvIntegrationPlugin
