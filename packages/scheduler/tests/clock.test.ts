import { AutomationService } from '@numenjs/automation'
import {
  CapabilityRegistry,
  type AutomationSource,
  type CapabilityDefinition,
} from '@numenjs/core'
import { DatabaseService } from '@numenjs/database'
import { ResourceService } from '@numenjs/resources'
import { Context, Service } from 'cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import z from 'schemastery'
import { afterEach, expect, it } from 'vitest'
import { SchedulerService } from '../src/index.js'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

/** Deterministic clock: durable timers must be driven by the injected service. */
class FakeClock extends Service {
  current = Date.parse('2030-01-01T00:00:00.000Z')

  constructor(ctx: Context) {
    super(ctx, 'clock')
  }

  now(): Date { return new Date(this.current) }
  nowIso(): string { return new Date(this.current).toISOString() }
  nowMs(): number { return this.current }

  advance(milliseconds: number): void { this.current += milliseconds }
}

const record: CapabilityDefinition = {
  id: 'test:record', version: 1, kind: 'action', title: 'Record',
  input: z.object({ value: z.string().required() }),
  output: z.object({ value: z.string().required() }),
  semantics: { sideEffect: true, idempotent: true, retrySafe: true },
}

const source: AutomationSource = {
  triggers: [],
  flow: {
    type: 'block',
    id: 'flow',
    steps: [
      { type: 'wait', id: 'hold', durationMs: { type: 'literal', value: 60_000 } },
      { type: 'capability', id: 'after', capability: { id: 'test:record', version: 1 }, input: { value: { type: 'literal', value: 'done' } } },
    ],
  },
}

it('schedules and resumes durable timers from the injected clock', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'numen-clock-'))
  directories.push(directory)
  const path = join(directory, 'numen.db')

  const ctx = new Context()
  await ctx.plugin(DatabaseService, { path })
  await ctx.plugin(FakeClock)
  await ctx.plugin(CapabilityRegistry)
  ctx.capabilities.define(ctx, record)
  ctx.capabilities.provide(ctx, record, { async invoke({ input }) { return input } })
  await ctx.plugin(AutomationService)
  await ctx.plugin(ResourceService, { path: join(dirname(path), 'resources') })
  await ctx.plugin(SchedulerService, { autoDispatch: false })

  const created = ctx.automations.create({ name: 'Clock test', source })
  const revision = ctx.automations.publishDraft(created.automation.id, 1)
  ctx.automations.activateRevision(created.automation.id, revision.id)
  const run = ctx.scheduler.startManual(created.automation.id)
  await ctx.scheduler.dispatchUntilIdle()

  const clock = ctx.get('clock') as FakeClock
  const waiting = ctx.scheduler.listEvents(run.id).find(event => event.type === 'ExecutionWaiting')
  expect(waiting?.occurredAt).toBe('2030-01-01T00:00:00.000Z')
  expect(waiting?.payload).toMatchObject({ wakeAt: '2030-01-01T00:01:00.000Z' })
  expect(ctx.scheduler.getRun(run.id)?.status).toBe('RUNNING')

  // Real time advancing must not resume the timer: only the injected clock counts.
  await new Promise(resolve => setTimeout(resolve, 10))
  await ctx.scheduler.dispatchUntilIdle()
  expect(ctx.scheduler.getRun(run.id)?.status).toBe('RUNNING')

  clock.advance(60_000)
  await ctx.scheduler.dispatchUntilIdle()
  expect(ctx.scheduler.getRun(run.id)?.status).toBe('COMPLETED')
  expect(ctx.scheduler.listEvents(run.id).map(event => event.type)).toContain('ExecutionResumed')
  await ctx.fiber.dispose()
})
