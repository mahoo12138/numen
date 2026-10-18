import { AutomationService } from '@numenjs/automation'
import { CapabilityRegistry, type CapabilityDefinition } from '@numenjs/core'
import { DatabaseService } from '@numenjs/database'
import { ResourceService } from '@numenjs/resources'
import { SchedulerService } from '@numenjs/scheduler'
import { Context } from 'cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import dateTimeIntegrationPlugin, {
  dateTimeAddCapability,
  dateTimeDiffCapability,
  dateTimeFormatCapability,
  dateTimeNowCapability,
  type DateTimeIntegrationConfig,
} from '../src/index.js'

const roots: Context[] = []
const directories: string[] = []

async function createRoot(config: DateTimeIntegrationConfig = {}): Promise<Context> {
  const root = new Context()
  roots.push(root)
  await root.plugin(CapabilityRegistry)
  dateTimeIntegrationPlugin(root, config)
  return root
}

async function createScheduler(directory: string, config: DateTimeIntegrationConfig): Promise<Context> {
  const root = await createRoot(config)
  await root.plugin(DatabaseService, { path: join(directory, 'numen.db') })
  await root.plugin(AutomationService)
  await root.plugin(ResourceService, { path: join(directory, 'resources') })
  await root.plugin(SchedulerService, { autoDispatch: false })
  return root
}

function invoke<Input, Output>(root: Context, definition: CapabilityDefinition<Input, Output>, input: Input, signal = new AbortController().signal): Promise<Output> {
  return root.capabilities.resolveProvider<Input, Output>(definition)!.invoke({ input, connections: {}, signal })
}

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(roots.splice(0).map(root => root.fiber.dispose()))
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('Date & Time Integration', () => {
  it('uses UTC independently of the host zone, including offset-free input and the current instant', async () => {
    const previousTimezone = process.env.TZ
    const root = await createRoot({ now: () => Date.UTC(2024, 1, 29, 6, 7, 8, 9) })
    try {
      for (const timezone of ['Pacific/Honolulu', 'Asia/Shanghai']) {
        process.env.TZ = timezone
        expect(await invoke(root, dateTimeNowCapability, {})).toEqual({
          iso: '2024-02-29T06:07:08.009Z', epochMs: 1709186828009, timezone: 'UTC',
        })
        expect(await invoke(root, dateTimeFormatCapability, { date: '2024-02-29T06:07:08.009', format: 'yyyy-MM-dd HH:mm:ss.SSS ZZZ' }))
          .toEqual({ text: '2024-02-29 06:07:08.009 +0000' })
      }
    } finally {
      if (previousTimezone === undefined) delete process.env.TZ
      else process.env.TZ = previousTimezone
    }
    expect(dateTimeNowCapability.semantics).toEqual({ sideEffect: false, idempotent: false, retrySafe: false })
  })

  it('interprets an offset as an instant and an offset-free date in the requested zone', async () => {
    const root = await createRoot()
    expect(await invoke(root, dateTimeFormatCapability, {
      date: '2024-01-01T00:00:00Z', format: "yyyy-MM-dd HH:mm ZZZ", timezone: 'Asia/Shanghai',
    })).toEqual({ text: '2024-01-01 08:00 +0800' })
    const result = await invoke(root, dateTimeAddCapability, { date: '2024-01-01', amount: 0, unit: 'days', timezone: 'Asia/Shanghai' })
    expect(result).toEqual({ iso: '2024-01-01T00:00:00.000+08:00', epochMs: 1704038400000, timezone: 'Asia/Shanghai' })
  })

  it.each([
    ['2024-01-31', 1, 'months', '2024-02-29T00:00:00.000Z'],
    ['2023-01-31', 1, 'months', '2023-02-28T00:00:00.000Z'],
    ['2024-02-29', 1, 'years', '2025-02-28T00:00:00.000Z'],
    ['2024-03-31', -1, 'months', '2024-02-29T00:00:00.000Z'],
    ['2024-03-01', -1, 'days', '2024-02-29T00:00:00.000Z'],
    ['2024-01-01', 2, 'weeks', '2024-01-15T00:00:00.000Z'],
    ['2024-01-01T00:00:00Z', -1.5, 'seconds', '2023-12-31T23:59:58.500Z'],
  ] as const)('adds %s, %s %s with clamping and signed durations', async (date, amount, unit, expected) => {
    const root = await createRoot()
    expect((await invoke(root, dateTimeAddCapability, { date, amount, unit })).iso).toBe(expected)
  })

  it('distinguishes a calendar day from 24 elapsed hours across both DST transitions', async () => {
    const root = await createRoot()
    const timezone = 'America/New_York'
    const springDay = await invoke(root, dateTimeAddCapability, { date: '2024-03-09T12:00', amount: 1, unit: 'days', timezone })
    const springHours = await invoke(root, dateTimeAddCapability, { date: '2024-03-09T12:00', amount: 24, unit: 'hours', timezone })
    expect(springDay.iso).toBe('2024-03-10T12:00:00.000-04:00')
    expect(springHours.iso).toBe('2024-03-10T13:00:00.000-04:00')
    const autumnDay = await invoke(root, dateTimeAddCapability, { date: '2024-11-02T12:00', amount: 1, unit: 'days', timezone })
    const autumnHours = await invoke(root, dateTimeAddCapability, { date: '2024-11-02T12:00', amount: 24, unit: 'hours', timezone })
    expect(autumnDay.iso).toBe('2024-11-03T12:00:00.000-05:00')
    expect(autumnHours.iso).toBe('2024-11-03T11:00:00.000-05:00')
  })

  it.each([
    ['2024-03-10T02:30', 'America/New_York', 'DATETIME_LOCAL_TIME_NONEXISTENT'],
    ['2024-11-03T01:30', 'America/New_York', 'DATETIME_LOCAL_TIME_AMBIGUOUS'],
    ['2024-04-07T01:45', 'Australia/Lord_Howe', 'DATETIME_LOCAL_TIME_AMBIGUOUS'],
    ['2018-11-04', 'America/Sao_Paulo', 'DATETIME_LOCAL_TIME_NONEXISTENT'],
  ])('rejects an unresolved wall time %s in %s', async (date, timezone, code) => {
    const root = await createRoot()
    await expect(invoke(root, dateTimeFormatCapability, { date, timezone, format: 'yyyy-MM-dd HH:mm' })).rejects.toMatchObject({ code })
  })

  it('resolves repeated local times when the input supplies an offset, including zero calendar addition', async () => {
    const root = await createRoot()
    const first = await invoke(root, dateTimeAddCapability, { date: '2024-11-03T01:30:00-04:00', timezone: 'America/New_York', amount: 0, unit: 'days' })
    const second = await invoke(root, dateTimeAddCapability, { date: '2024-11-03T01:30:00-05:00', timezone: 'America/New_York', amount: 0, unit: 'days' })
    expect(second.epochMs - first.epochMs).toBe(3_600_000)
    expect(first.iso).toBe('2024-11-03T01:30:00.000-04:00')
    expect(second.iso).toBe('2024-11-03T01:30:00.000-05:00')
  })

  it('rejects calendar destinations in gaps or overlaps instead of silently shifting or picking an offset', async () => {
    const root = await createRoot()
    await expect(invoke(root, dateTimeAddCapability, { date: '2024-03-09T02:30', timezone: 'America/New_York', amount: 1, unit: 'days' }))
      .rejects.toMatchObject({ code: 'DATETIME_LOCAL_TIME_NONEXISTENT' })
    await expect(invoke(root, dateTimeAddCapability, { date: '2024-11-02T01:30', timezone: 'America/New_York', amount: 1, unit: 'days' }))
      .rejects.toMatchObject({ code: 'DATETIME_LOCAL_TIME_AMBIGUOUS' })
    // Elapsed arithmetic identifies an absolute instant even inside an overlap.
    expect((await invoke(root, dateTimeAddCapability, { date: '2024-11-03T00:30', timezone: 'America/New_York', amount: 2, unit: 'hours' })).iso)
      .toBe('2024-11-03T01:30:00.000-05:00')
  })

  it('computes signed differences without rounding and distinguishes calendar days from elapsed hours', async () => {
    const root = await createRoot()
    const interval = { start: '2024-03-09T12:00', end: '2024-03-10T12:00', timezone: 'America/New_York' }
    expect(await invoke(root, dateTimeDiffCapability, { ...interval, unit: 'days' })).toEqual({ value: 1, unit: 'days' })
    expect(await invoke(root, dateTimeDiffCapability, { ...interval, unit: 'hours' })).toEqual({ value: 23, unit: 'hours' })
    expect(await invoke(root, dateTimeDiffCapability, { start: '2024-01-01T01:30Z', end: '2024-01-01T00:00Z', unit: 'hours' }))
      .toEqual({ value: -1.5, unit: 'hours' })
    expect(await invoke(root, dateTimeDiffCapability, { start: '2024-01-31', end: '2024-02-29', unit: 'months' }))
      .toEqual({ value: 1, unit: 'months' })
    const fractional = await invoke(root, dateTimeDiffCapability, { start: '2024-01-01', end: '2024-01-16T12:00', unit: 'months' })
    expect(fractional.value).toBeCloseTo(0.5)
  })

  it.each(['2023-02-29', '2024-02-30', '2024-13-01', '2024-01-01T24:00', '2024-01-01T00:60', '2024-01-01T00:00:60Z',
    '2024-01-01T00:00+25:00', '2024-01-01T00:00+01:60', '2024', '12:30', '01/02/2024', '2024-01-01T00:00:00.0001Z', '0000-01-01', ''])
    ('rejects invalid, incomplete or imprecise date input %j', async date => {
      const root = await createRoot()
      await expect(invoke(root, dateTimeFormatCapability, { date, format: 'yyyy' })).rejects.toMatchObject({ code: 'DATETIME_INPUT_INVALID' })
    })

  it.each(['local', 'system', '', 'Mars/Olympus', 'x'.repeat(101)])('rejects an invalid or host-dependent timezone %j', async timezone => {
    const root = await createRoot()
    await expect(invoke(root, dateTimeNowCapability, { timezone })).rejects.toMatchObject({ code: 'DATETIME_TIMEZONE_INVALID' })
  })

  it.each(['Asia/Shanghai', 'Europe/Paris', 'America/New_York'])('rejects second-precision historical offsets in %s instead of emitting an ISO value that disagrees with epochMs', async timezone => {
    const root = await createRoot()
    await expect(invoke(root, dateTimeAddCapability, { date: '1800-01-01', timezone, unit: 'days', amount: 0 }))
      .rejects.toMatchObject({ code: 'DATETIME_OUT_OF_RANGE' })
    await expect(invoke(root, dateTimeFormatCapability, { date: '1800-01-01T00:00:00Z', timezone, format: 'yyyy-MM-dd HH:mm:ss ZZZ' }))
      .rejects.toMatchObject({ code: 'DATETIME_OUT_OF_RANGE' })
    const utc = await invoke(root, dateTimeAddCapability, { date: '1800-01-01', unit: 'days', amount: 0 })
    expect(utc.iso).toBe('1800-01-01T00:00:00.000Z')
    expect(Date.parse(utc.iso)).toBe(utc.epochMs)
  })

  it('rejects fractional calendar values, non-finite values, sub-millisecond precision and extreme results', async () => {
    const root = await createRoot()
    for (const amount of [NaN, Infinity, -Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(invoke(root, dateTimeAddCapability, { date: '2024-01-01', amount, unit: 'months' })).rejects.toMatchObject({ code: 'DATETIME_AMOUNT_INVALID' })
    }
    await expect(invoke(root, dateTimeAddCapability, { date: '2024-01-01', amount: 0.0001, unit: 'seconds' })).rejects.toMatchObject({ code: 'DATETIME_AMOUNT_INVALID' })
    await expect(invoke(root, dateTimeAddCapability, { date: '2024-01-01', amount: Number.MAX_SAFE_INTEGER, unit: 'years' })).rejects.toMatchObject({ code: 'DATETIME_OUT_OF_RANGE' })
    await expect(invoke(root, dateTimeAddCapability, { date: '9999-12-31', amount: 1, unit: 'days' })).rejects.toMatchObject({ code: 'DATETIME_OUT_OF_RANGE' })
    await expect(invoke(root, dateTimeAddCapability, { date: '0001-01-01', amount: -1, unit: 'days' })).rejects.toMatchObject({ code: 'DATETIME_OUT_OF_RANGE' })
    await expect(invoke(root, dateTimeFormatCapability, { date: '2024-01-01', format: 'y'.repeat(257) })).rejects.toMatchObject({ code: 'DATETIME_FORMAT_INVALID' })
  })

  it.each([
    [1.001, 'seconds', 1001],
    [1.003, 'seconds', 1003],
    [-1.001, 'seconds', -1001],
    [1048576.001, 'seconds', 1048576001],
    [1073741824.001, 'seconds', 1073741824001],
    [-1073741824.001, 'seconds', -1073741824001],
    [68719476736.001, 'seconds', 68719476736001],
    [0.0000025, 'hours', 9],
  ] as const)('corrects only floating-point representation error when adding %s %s', async (amount, unit, milliseconds) => {
    const root = await createRoot()
    const result = await invoke(root, dateTimeAddCapability, { date: '1970-01-01T00:00:00Z', amount, unit })
    expect(result.epochMs).toBe(milliseconds)
    expect(Date.parse(result.iso)).toBe(milliseconds)
  })

  it.each([
    [0.0001, 'seconds'],
    [0.0009999999999999998, 'seconds'],
    [1.00100000000001, 'seconds'],
    [100000000000.00002, 'seconds'],
    [-100000000000.00002, 'seconds'],
    [1073741824.0000002, 'hours'],
    [2147483648.0000005, 'hours'],
    [Number.MAX_SAFE_INTEGER + 1, 'milliseconds'],
    [9007199254740.992, 'seconds'],
  ] as const)('rejects actual fractional milliseconds or unsafe duration %s %s', async (amount, unit) => {
    const root = await createRoot()
    await expect(invoke(root, dateTimeAddCapability, { date: '1970-01-01T00:00:00Z', amount, unit }))
      .rejects.toMatchObject({ code: 'DATETIME_AMOUNT_INVALID' })
  })

  it('checks cancellation before reading the clock and before returning the result', async () => {
    const controller = new AbortController()
    const clock = vi.fn(() => {
      controller.abort(new Error('cancelled while capturing'))
      return 0
    })
    const root = await createRoot({ now: clock })
    const cancelled = new AbortController()
    cancelled.abort(new Error('already cancelled'))
    await expect(invoke(root, dateTimeNowCapability, {}, cancelled.signal)).rejects.toThrow('already cancelled')
    expect(clock).not.toHaveBeenCalled()
    await expect(invoke(root, dateTimeNowCapability, {}, controller.signal)).rejects.toThrow('cancelled while capturing')
    expect(clock).toHaveBeenCalledTimes(1)
  })

  it('resumes a published Scheduler Run using persisted now output without re-reading the clock', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2024-02-29T06:00:00.000Z'))
    const directory = await mkdtemp(join(tmpdir(), 'numen-datetime-'))
    directories.push(directory)
    const clock = vi.fn(() => Date.now())
    const root = await createScheduler(directory, { now: clock })
    const { automation } = root.automations.create({ name: 'Capture time then resume', source: {
      triggers: [],
      flow: { type: 'block', id: 'flow', steps: [
        { type: 'capability', id: 'capture', capability: dateTimeNowCapability, input: {} },
        { type: 'wait', id: 'pause', durationMs: { type: 'literal', value: 60_000 } },
        { type: 'capability', id: 'format', capability: dateTimeFormatCapability, input: {
          date: { type: 'ref', path: 'steps.capture.iso' },
          format: { type: 'literal', value: 'yyyy-MM-dd HH:mm:ss' },
        } },
      ] },
    } })
    const revision = root.automations.publishDraft(automation.id, 1)
    root.automations.activateRevision(automation.id, revision.id)
    const run = root.scheduler.startManual(automation.id)
    await root.scheduler.dispatchUntilIdle()
    expect(clock).toHaveBeenCalledTimes(1)
    const capture = root.scheduler.listExecutions(run.id).find(execution => execution.instructionId === 'capture')!
    expect(capture.output).toEqual({ iso: '2024-02-29T06:00:00.000Z', epochMs: 1709186400000, timezone: 'UTC' })
    expect(root.scheduler.listExecutions(run.id).find(execution => execution.instructionId === 'pause')?.status).toBe('WAITING')
    await root.fiber.dispose()
    roots.splice(roots.indexOf(root), 1)

    vi.setSystemTime(new Date('2024-02-29T08:00:00.000Z'))
    const secondClock = vi.fn(() => { throw new Error('completed now must not be executed again') })
    const restarted = await createScheduler(directory, { now: secondClock })
    await restarted.scheduler.dispatchUntilIdle()
    expect(restarted.scheduler.getRun(run.id)?.status).toBe('COMPLETED')
    expect(secondClock).not.toHaveBeenCalled()
    expect(restarted.scheduler.listExecutions(run.id).find(execution => execution.instructionId === 'capture')?.output).toEqual(capture.output)
    expect(restarted.scheduler.listExecutions(run.id).find(execution => execution.instructionId === 'format')?.output).toEqual({ text: '2024-02-29 06:00:00' })
    expect(restarted.scheduler.listAttempts(run.id).filter(attempt => attempt.executionId === capture.id)).toHaveLength(1)
  })
})
