import { defineCapability, type CapabilityDefinition, type CapabilityProvider } from '@numenjs/core'
import type { Context } from 'cordis'
import { DateTime, IANAZone } from 'luxon'
import type Schema from 'schemastery'
import z from 'schemastery'

export const dateTimeUnits = ['milliseconds', 'seconds', 'minutes', 'hours', 'days', 'weeks', 'months', 'years'] as const
export type DateTimeUnit = typeof dateTimeUnits[number]

export interface DateTimeNowInput { timezone?: string }
export interface DateTimeOutput { iso: string; epochMs: number; timezone: string }
export interface DateTimeFormatInput { date: string; format: string; timezone?: string }
export interface DateTimeFormatOutput { text: string }
export interface DateTimeAddInput { date: string; amount: number; unit: DateTimeUnit; timezone?: string }
export interface DateTimeDiffInput { start: string; end: string; unit: DateTimeUnit; timezone?: string }
export interface DateTimeDiffOutput { value: number; unit: DateTimeUnit }
export interface DateTimeIntegrationConfig { now?: () => number }

export type DateTimeErrorCode =
  | 'DATETIME_INPUT_INVALID'
  | 'DATETIME_TIMEZONE_INVALID'
  | 'DATETIME_LOCAL_TIME_NONEXISTENT'
  | 'DATETIME_LOCAL_TIME_AMBIGUOUS'
  | 'DATETIME_AMOUNT_INVALID'
  | 'DATETIME_OUT_OF_RANGE'
  | 'DATETIME_FORMAT_INVALID'

export class DateTimeError extends Error {
  override name = 'DateTimeError'

  constructor(public readonly code: DateTimeErrorCode, message: string) {
    super(`[${code}] ${message}`)
  }
}

const calendarUnits = new Set<DateTimeUnit>(['days', 'weeks', 'months', 'years'])
const elapsedUnitMilliseconds = { milliseconds: 1, seconds: 1_000, minutes: 60_000, hours: 3_600_000 } as const
// A complete calendar date prevents Luxon from filling omitted fields from the current clock.
const isoCalendarPattern = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})?)?$/
const maximumFormatLength = 256
const maximumFormattedLength = 4_096
const dateDescription = 'ISO calendar date YYYY-MM-DD, optionally followed by THH:mm[:ss[.SSS]] and Z or ±HH:mm. No offset means local time in timezone; nonexistent or ambiguous local times are rejected. Years 0001–9999.'
const timezoneSchema = () => z.string().default('UTC').description('IANA time zone, for example Asia/Shanghai or America/New_York. Defaults to UTC, never the host time zone. Used for offset-free input, formatting and calendar arithmetic. Historical offsets with second precision are unsupported.')
const dateSchema = () => z.string().required().description(dateDescription)
const unitSchema = () => z.union([...dateTimeUnits]).required().description('milliseconds/seconds/minutes/hours measure elapsed time; days/weeks/months/years use calendar arithmetic in timezone.')
const instantOutputSchema = () => z.object({
  iso: z.string().required().description('ISO date and time with an explicit UTC offset, at millisecond precision.'),
  epochMs: z.number().required().description('Integer milliseconds since 1970-01-01T00:00:00Z.'),
  timezone: z.string().required().description('The explicit time zone used for this result.'),
}) as Schema<DateTimeOutput>

export const dateTimeNowCapability = defineCapability<DateTimeNowInput, DateTimeOutput>({
  id: 'datetime:now', version: 1, kind: 'query', title: 'Current Date & Time',
  description: 'Capture the current instant once as a durable step output. Re-invocation can produce a different value.',
  input: z.object({ timezone: timezoneSchema() }) as Schema<DateTimeNowInput>,
  output: instantOutputSchema(),
  semantics: { sideEffect: false, idempotent: false, retrySafe: false },
})

export const dateTimeFormatCapability = defineCapability<DateTimeFormatInput, DateTimeFormatOutput>({
  id: 'datetime:format', version: 1, kind: 'query', title: 'Format Date & Time',
  description: 'Format an ISO date using Luxon format tokens and an explicit time zone. Locale is en-US with Latin digits and the Gregorian calendar.',
  input: z.object({
    date: dateSchema(),
    format: z.string().required().description('Luxon format tokens, for example yyyy-MM-dd HH:mm:ss ZZZ. Quote literal text with single quotes. Maximum 256 characters; output is limited to 4096 characters.'),
    timezone: timezoneSchema(),
  }) as Schema<DateTimeFormatInput>,
  output: z.object({ text: z.string().required().description('The formatted date and time.') }),
  semantics: { sideEffect: false, idempotent: true, retrySafe: true },
})

export const dateTimeAddCapability = defineCapability<DateTimeAddInput, DateTimeOutput>({
  id: 'datetime:add', version: 1, kind: 'query', title: 'Add to Date & Time',
  description: 'Add or subtract elapsed time or calendar units. Calendar arithmetic preserves local clock time and clamps month ends; DST gaps and overlaps are rejected.',
  input: z.object({
    date: dateSchema(),
    amount: z.number().required().description('Positive to add, negative to subtract. Calendar units require a safe integer; elapsed units may be fractional but must resolve to a safe integer number of milliseconds.'),
    unit: unitSchema(),
    timezone: timezoneSchema(),
  }) as Schema<DateTimeAddInput>,
  output: instantOutputSchema(),
  semantics: { sideEffect: false, idempotent: true, retrySafe: true },
})

export const dateTimeDiffCapability = defineCapability<DateTimeDiffInput, DateTimeDiffOutput>({
  id: 'datetime:diff', version: 1, kind: 'query', title: 'Difference Between Dates',
  description: 'Calculate end minus start in the requested unit without rounding. Calendar units follow the selected time zone; elapsed units measure actual elapsed time.',
  input: z.object({
    start: dateSchema().description(`Start of the interval. ${dateDescription}`),
    end: dateSchema().description(`End of the interval; earlier dates produce a negative difference. ${dateDescription}`),
    unit: unitSchema(),
    timezone: timezoneSchema(),
  }) as Schema<DateTimeDiffInput>,
  output: z.object({
    value: z.number().required().description('Signed difference, including a fractional remainder when present.'),
    unit: unitSchema(),
  }) as Schema<DateTimeDiffOutput>,
  semantics: { sideEffect: false, idempotent: true, retrySafe: true },
})

function checkedTimezone(value: string | undefined): string {
  const timezone = value === undefined ? 'UTC' : value
  if (typeof timezone !== 'string' || timezone.length > 100 || !IANAZone.isValidZone(timezone)) {
    throw new DateTimeError('DATETIME_TIMEZONE_INVALID', 'timezone must be UTC or a valid IANA time zone')
  }
  return timezone
}

function checkRange(value: DateTime): DateTime {
  if (!value.isValid || !Number.isSafeInteger(value.toMillis()) || value.year < 1 || value.year > 9999) {
    throw new DateTimeError('DATETIME_OUT_OF_RANGE', 'date must be within years 0001–9999 at millisecond precision')
  }
  // ISO output only carries minute-resolution offsets. Luxon would silently truncate historical seconds.
  if (!Number.isInteger(value.offset)) {
    throw new DateTimeError('DATETIME_OUT_OF_RANGE', 'historical time zone offsets with second precision are unsupported; use UTC')
  }
  return value
}

function sameLocalTime(left: DateTime, right: DateTime): boolean {
  return left.year === right.year && left.month === right.month && left.day === right.day
    && left.hour === right.hour && left.minute === right.minute && left.second === right.second
    && left.millisecond === right.millisecond
}

function resolveLocalTime(wallTime: DateTime, timezone: string): DateTime {
  const resolved = checkRange(wallTime.setZone(timezone, { keepLocalTime: true }))
  // Luxon normally advances a wall time across a DST gap. Reject that silent correction.
  if (!sameLocalTime(wallTime, resolved)) {
    throw new DateTimeError('DATETIME_LOCAL_TIME_NONEXISTENT', 'local time does not exist in timezone; specify an explicit offset or another time')
  }
  if (resolved.getPossibleOffsets().length !== 1) {
    throw new DateTimeError('DATETIME_LOCAL_TIME_AMBIGUOUS', 'local time occurs more than once in timezone; specify an explicit offset')
  }
  return resolved
}

function parseDate(source: string, timezone: string): DateTime {
  if (typeof source !== 'string' || source.length > 40) {
    throw new DateTimeError('DATETIME_INPUT_INVALID', 'date must be an ISO calendar date string')
  }
  const match = isoCalendarPattern.exec(source)
  if (!match) throw new DateTimeError('DATETIME_INPUT_INVALID', 'date must use YYYY-MM-DD with optional THH:mm[:ss[.SSS]] and Z or ±HH:mm')
  const [, year, month, day, hour, minute, second, millisecond, offset] = match
  const wallTime = DateTime.fromObject({
    year: Number(year), month: Number(month), day: Number(day),
    hour: Number(hour ?? 0), minute: Number(minute ?? 0), second: Number(second ?? 0),
    millisecond: Number((millisecond ?? '').padEnd(3, '0')),
  }, { zone: 'UTC', locale: 'en-US', numberingSystem: 'latn', outputCalendar: 'gregory' })
  if (!wallTime.isValid || Number(year) < 1 || Number(hour ?? 0) > 23) {
    throw new DateTimeError('DATETIME_INPUT_INVALID', 'date contains an invalid calendar date or clock time')
  }
  if (!offset) return resolveLocalTime(wallTime, timezone)
  if (offset !== 'Z' && (Number(offset.slice(1, 3)) > 23 || Number(offset.slice(4)) > 59)) {
    throw new DateTimeError('DATETIME_INPUT_INVALID', 'date contains an invalid UTC offset')
  }
  return checkRange(DateTime.fromISO(source, {
    setZone: true, locale: 'en-US', numberingSystem: 'latn', outputCalendar: 'gregory',
  }).setZone(timezone))
}

function checkedUnit(unit: DateTimeUnit): DateTimeUnit {
  if (!dateTimeUnits.includes(unit)) throw new DateTimeError('DATETIME_INPUT_INVALID', 'unit must be a supported date and time unit')
  return unit
}

function instantOutput(value: DateTime, timezone: string): DateTimeOutput {
  const checked = checkRange(value)
  return { iso: checked.toISO()!, epochMs: checked.toMillis(), timezone }
}

function formatDate(input: DateTimeFormatInput): DateTimeFormatOutput {
  if (typeof input.format !== 'string' || !input.format.length || input.format.length > maximumFormatLength) {
    throw new DateTimeError('DATETIME_FORMAT_INVALID', 'format must contain between 1 and 256 characters')
  }
  const date = parseDate(input.date, checkedTimezone(input.timezone))
  const text = date.toFormat(input.format)
  if (text.length > maximumFormattedLength) throw new DateTimeError('DATETIME_FORMAT_INVALID', 'formatted output exceeds 4096 characters')
  return { text }
}

function elapsedMilliseconds(amount: number, scale: number): number {
  const invalid = () => new DateTimeError('DATETIME_AMOUNT_INVALID', 'elapsed amount must resolve to a safe integer number of milliseconds')
  // Gate rounding on exact decimal integrality. A relative epsilon alone would
  // accept real sub-ms values at large magnitudes (for example 100000000000.00002 s).
  const [coefficient, exponent = '0'] = amount.toString().split('e')
  const fractionDigits = coefficient!.split('.')[1]?.length ?? 0
  const power = Number(exponent) - fractionDigits
  let exact = BigInt(coefficient!.replace('.', '')) * BigInt(scale)
  if (power >= 0) exact *= 10n ** BigInt(power)
  else {
    const divisor = 10n ** BigInt(-power)
    if (exact % divisor !== 0n) throw invalid()
    exact /= divisor
  }
  const milliseconds = Number(exact)
  const product = amount * scale
  if (!Number.isSafeInteger(milliseconds)
    || Math.abs(product - milliseconds) > Number.EPSILON * Math.abs(milliseconds)) throw invalid()
  return milliseconds
}

function addDate(input: DateTimeAddInput): DateTimeOutput {
  const timezone = checkedTimezone(input.timezone)
  const date = parseDate(input.date, timezone)
  const unit = checkedUnit(input.unit)
  if (!Number.isFinite(input.amount)) throw new DateTimeError('DATETIME_AMOUNT_INVALID', 'amount must be a finite number')
  if (calendarUnits.has(unit)) {
    if (!Number.isSafeInteger(input.amount)) throw new DateTimeError('DATETIME_AMOUNT_INVALID', 'calendar amount must be a safe integer')
    if (input.amount === 0) return instantOutput(date, timezone)
    // Compute the desired wall date in UTC, where month-end clamping cannot hide a DST correction.
    const wallTime = checkRange(date.setZone('UTC', { keepLocalTime: true }).plus({ [unit]: input.amount }))
    return instantOutput(resolveLocalTime(wallTime, timezone), timezone)
  }
  const durationMs = elapsedMilliseconds(input.amount, elapsedUnitMilliseconds[unit as keyof typeof elapsedUnitMilliseconds])
  return instantOutput(date.plus({ milliseconds: durationMs }), timezone)
}

function difference(input: DateTimeDiffInput): DateTimeDiffOutput {
  const timezone = checkedTimezone(input.timezone)
  const unit = checkedUnit(input.unit)
  const start = parseDate(input.start, timezone)
  const end = parseDate(input.end, timezone)
  const value = end.diff(start, unit).get(unit)
  if (!Number.isFinite(value)) throw new DateTimeError('DATETIME_OUT_OF_RANGE', 'date difference is outside the supported range')
  return { value, unit }
}

export function dateTimeIntegrationPlugin(ctx: Context, config: DateTimeIntegrationConfig = {}): void {
  const now = config.now ?? Date.now
  const register = <Input, Output>(definition: CapabilityDefinition<Input, Output>, operation: (input: Input) => Output) => {
    ctx.capabilities.define(ctx, definition)
    ctx.capabilities.provide(ctx, definition, {
      async invoke({ input, signal }) {
        signal.throwIfAborted()
        const output = operation(input)
        signal.throwIfAborted()
        return output
      },
    } satisfies CapabilityProvider<Input, Output>)
  }
  register(dateTimeNowCapability, input => {
    const timezone = checkedTimezone(input.timezone)
    return instantOutput(DateTime.fromMillis(now(), {
      zone: timezone, locale: 'en-US', numberingSystem: 'latn', outputCalendar: 'gregory',
    }), timezone)
  })
  register(dateTimeFormatCapability, formatDate)
  register(dateTimeAddCapability, addDate)
  register(dateTimeDiffCapability, difference)
}

dateTimeIntegrationPlugin.inject = ['capabilities']
export default dateTimeIntegrationPlugin
