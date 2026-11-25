import { AutomationService } from '@numenjs/automation'
import { CapabilityRegistry, type AutomationConcurrencyPolicy, type AutomationSource, type CapabilityDefinition, type LocalTestRequest, type NumenValue, type Run } from '@numenjs/core'
import { DatabaseService } from '@numenjs/database'
import { ResourceService } from '@numenjs/resources'
import { Context } from 'cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import z from 'schemastery'
import { afterEach, describe, expect, it } from 'vitest'
import { SchedulerService } from '../src/service.js'

const directories: string[] = []
const contexts = new Set<Context>()
const releases = new Set<() => void>()
afterEach(async () => {
  for (const release of releases) release()
  releases.clear()
  for (const root of contexts) await root.fiber.dispose()
  contexts.clear()
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'numen-admission-'))
  directories.push(path)
  return path
}
const definition: CapabilityDefinition = {
  id: 'test:admission', version: 1, kind: 'action', title: 'Admission action',
  input: z.object({ value: z.string().required() }), output: z.object({ value: z.string().required() }),
  semantics: { sideEffect: true, idempotent: false, retrySafe: false },
}
const triggerDefinition: CapabilityDefinition = {
  id: 'test:admission-event', version: 1, kind: 'trigger', title: 'Admission event',
  input: z.object({}), output: z.any(),
  semantics: { sideEffect: false, idempotent: true, retrySafe: true },
}
async function context(path: string, options: {
  invoke?: (input: NumenValue, signal: AbortSignal) => Promise<NumenValue>
  autoDispatch?: boolean
} = {}) {
  const root = new Context(); contexts.add(root)
  await root.plugin(DatabaseService, { path: join(path, 'db') })
  await root.plugin(CapabilityRegistry)
  root.capabilities.define(root, definition)
  root.capabilities.define(root, triggerDefinition)
  if (options.invoke) root.capabilities.provide(root, definition, { invoke: ({ input, signal }) => options.invoke!(input, signal) })
  await root.plugin(AutomationService)
  await root.plugin(ResourceService, { path: join(path, 'resources') })
  await root.plugin(SchedulerService, { autoDispatch: options.autoDispatch ?? false, sweepIntervalMs: 60_000 })
  return root
}
async function dispose(root: Context) { await root.fiber.dispose(); contexts.delete(root) }
function publish(root: Context, source: AutomationSource) {
  const { automation } = root.automations.create({ name: 'Admission test', source })
  const revision = root.automations.publishDraft(automation.id, 1)
  root.automations.activateRevision(automation.id, revision.id)
  return { automationId: automation.id, revisionId: revision.id }
}
function revise(root: Context, automationId: string, source: AutomationSource) {
  const draft = root.automations.getDraft(automationId)!
  const saved = root.automations.saveDraft({ automationId, expectedVersion: draft.version, source })
  const revision = root.automations.publishDraft(automationId, saved.version)
  root.automations.activateRevision(automationId, revision.id)
  return revision
}
function waiting(policy: AutomationConcurrencyPolicy = { maxActive: 1 }): AutomationSource {
  return { triggers: [], policy, flow: { type: 'wait', id: 'hold', durationMs: { type: 'literal', value: 86_400_000 } } }
}
function action(policy: AutomationConcurrencyPolicy = { maxActive: 1 }, graph = false): AutomationSource {
  const node = { type: 'capability' as const, id: 'action', capability: { id: definition.id, version: 1 }, input: { value: { type: 'ref' as const, path: 'input.value' } } }
  return { triggers: [], policy, flow: graph ? {
    type: 'graph', version: 1, id: 'flow', nodes: [node],
    edges: [{ id: 'start-action', from: { nodeId: 'flow', port: 'start' }, to: { nodeId: 'action', port: 'in' } }],
    output: { type: 'ref', path: 'steps.action' },
  } : node }
}
const statuses = (root: Context, ...runs: Run[]) => runs.map(run => root.scheduler.getRun(run.id)!.status)
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  releases.add(resolve)
  return { promise, resolve }
}
function eventBinding(root: Context, automationId: string) {
  const automation = root.automations.setEnabled(automationId, true)
  return { automationId, revisionId: automation.activeRevisionId!, activationGeneration: automation.activationGeneration,
    triggerId: 'event', capability: { id: triggerDefinition.id, version: 1 }, config: {}, connectionIds: {} }
}
function localRequest(automationId: string, value: string): LocalTestRequest {
  return { automationId, expectedDraftVersion: 1, targetNodeId: 'action', mode: 'only-node', sampleIds: [], input: { value }, trigger: null }
}
async function startLocal(root: Context, request: LocalTestRequest, requestId: string) {
  const preview = root.automations.previewLocalTest(request)
  return root.scheduler.startLocalTest({ ...request, previewHash: preview.previewHash, requestId })
}
function acceptanceCounts(root: Context) {
  return Object.fromEntries(['runs', 'run_admissions', 'run_events', 'manual_run_requests', 'trigger_events', 'automation_revisions'].map(table => [table,
    (root.database.db.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get() as { total: number }).total,
  ]))
}
async function eventually(predicate: () => boolean, message: string, timeout = 1500) {
  const deadline = Date.now() + timeout
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
  expect(predicate(), message).toBe(true)
}

describe('durable Automation admission policies', () => {
  it('keeps waiting Runs within maxActive and admits queued Runs in acceptance order', async () => {
    const root = await context(await directory())
    const { automationId } = publish(root, waiting())
    const first = root.scheduler.startManual(automationId)
    const second = root.scheduler.startManual(automationId)
    const third = root.scheduler.startManual(automationId)
    await root.scheduler.dispatchUntilIdle()
    expect(statuses(root, first, second, third)).toEqual(['RUNNING', 'QUEUED', 'QUEUED'])
    expect(root.scheduler.listExecutions(second.id)).toEqual([])
    expect(root.scheduler.listExecutions(first.id)).toContainEqual(expect.objectContaining({ status: 'WAITING' }))
    root.scheduler.cancelRun(first.id)
    await root.scheduler.dispatchUntilIdle()
    expect(statuses(root, first, second, third)).toEqual(['CANCELLED', 'RUNNING', 'QUEUED'])
    root.scheduler.cancelRun(second.id)
    await root.scheduler.dispatchUntilIdle()
    expect(statuses(root, third)).toEqual(['RUNNING'])
  })

  it('uses structural group identity and skips a full group without starving other groups or Automations', async () => {
    const root = await context(await directory())
    const source = waiting({ maxActive: 1, groupBy: { type: 'ref', path: 'input.group' } })
    const firstAutomation = publish(root, source), otherAutomation = publish(root, source)
    const original = { group: { account: 'A', dimensions: [1, true] } }
    const first = root.scheduler.startManual(firstAutomation.automationId, original)
    const duplicateGroup = root.scheduler.startManual(firstAutomation.automationId, { group: { dimensions: [1, true], account: 'A' } })
    const anotherGroup = root.scheduler.startManual(firstAutomation.automationId, { group: { account: 'A', dimensions: ['1', true] } })
    const foreign = root.scheduler.startManual(otherAutomation.automationId, { group: original.group })
    original.group.account = 'mutated-after-acceptance'
    await root.scheduler.dispatchUntilIdle()
    expect(statuses(root, first, duplicateGroup, anotherGroup, foreign)).toEqual(['RUNNING', 'QUEUED', 'RUNNING', 'RUNNING'])
    expect(root.scheduler.getRun(first.id)?.groupKey).toEqual(root.scheduler.getRun(duplicateGroup.id)?.groupKey)
    expect(root.scheduler.getRun(first.id)?.groupKey).not.toEqual(root.scheduler.getRun(anotherGroup.id)?.groupKey)
    expect(root.scheduler.getRun(first.id)?.input.group).toEqual({ account: 'A', dimensions: [1, true] })
    root.scheduler.cancelRun(first.id)
    await root.scheduler.dispatchUntilIdle()
    expect(statuses(root, duplicateGroup)).toEqual(['RUNNING'])
  })

  it('shares capacity across published Revisions and freezes each accepted group and policy', async () => {
    const root = await context(await directory())
    const source = waiting({ maxActive: 1, groupBy: { type: 'ref', path: 'input.group' } })
    const { automationId, revisionId } = publish(root, source)
    const first = root.scheduler.startManual(automationId, { group: 'customer' })
    await root.scheduler.dispatchUntilIdle()
    const next = revise(root, automationId, { ...source, inputs: { group: { type: 'string', default: 'customer' } } })
    const second = root.scheduler.startManual(automationId)
    await root.scheduler.dispatchUntilIdle()
    expect(first.revisionId).toBe(revisionId)
    expect(second.revisionId).toBe(next.id)
    expect(statuses(root, first, second)).toEqual(['RUNNING', 'QUEUED'])
    const frozenKey = root.scheduler.getRun(second.id)?.groupKey
    revise(root, automationId, waiting({ maxActive: 5, groupBy: { type: 'literal', value: 'different-group' } }))
    await root.scheduler.dispatchUntilIdle()
    expect(root.scheduler.getRun(second.id)).toMatchObject({ status: 'QUEUED', groupKey: frozenKey, input: { group: 'customer' } })
    root.scheduler.cancelRun(first.id)
    await root.scheduler.dispatchUntilIdle()
    expect(statuses(root, second)).toEqual(['RUNNING'])
  })

  it.each(['queue', 'drop', 'replace'] as const)('keeps omitted maxActive unlimited even with %s and groupBy configured', async overflow => {
    const root = await context(await directory())
    const { automationId } = publish(root, waiting({ overflow, groupBy: { type: 'literal', value: null } }))
    const runs = Array.from({ length: 3 }, () => root.scheduler.startManual(automationId))
    await root.scheduler.dispatchUntilIdle()
    expect(statuses(root, ...runs)).toEqual(['RUNNING', 'RUNNING', 'RUNNING'])
    expect(runs.every(run => root.scheduler.listEvents(run.id).every(event => event.type !== 'RunCancelled'))).toBe(true)
  })

  it('drops overflowing manual submissions before creating Executions and retains the receipt through retry and restart', async () => {
    const path = await directory(), root = await context(path)
    const { automationId, revisionId } = publish(root, waiting({ maxActive: 1, overflow: 'drop' }))
    const first = root.scheduler.startManual(automationId)
    await root.scheduler.dispatchUntilIdle()
    const requestId = 'admission-drop-request-0001'
    const dropped = root.scheduler.startManual(automationId, {}, { type: 'manual' }, revisionId, requestId)
    await root.scheduler.dispatchUntilIdle()
    expect(root.scheduler.getRun(dropped.id)).toMatchObject({ status: 'CANCELLED', cancelReason: 'OVERFLOW' })
    expect(root.scheduler.listExecutions(dropped.id)).toEqual([])
    expect(root.scheduler.listAttempts(dropped.id)).toEqual([])
    expect(root.scheduler.listEvents(dropped.id).filter(event => event.type === 'RunStarted')).toEqual([])
    expect(root.scheduler.startManual(automationId, {}, { type: 'manual' }, revisionId, requestId).id).toBe(dropped.id)
    root.scheduler.cancelRun(first.id)
    await dispose(root)
    const restarted = await context(path)
    expect(restarted.scheduler.startManual(automationId, {}, { type: 'manual' }, revisionId, requestId)).toMatchObject({ id: dropped.id, status: 'CANCELLED', cancelReason: 'OVERFLOW' })
    await restarted.scheduler.dispatchUntilIdle()
    expect(restarted.scheduler.listRuns()).toHaveLength(2)
    expect(restarted.scheduler.listExecutions(dropped.id)).toEqual([])
  })

  it('retains accepted trigger event deduplication when overflow drops its Run', async () => {
    const path = await directory(), root = await context(path)
    const source = waiting({ maxActive: 1, overflow: 'drop' })
    source.triggers = [{ id: 'event', capability: { id: triggerDefinition.id, version: 1 }, config: {} }]
    const { automationId } = publish(root, source), binding = eventBinding(root, automationId)
    const first = root.scheduler.acceptTrigger(binding, { data: { value: 'first' }, eventId: 'first-event' })
    await root.scheduler.dispatchUntilIdle()
    const dropped = root.scheduler.acceptTrigger(binding, { data: { value: 'dropped' }, eventId: 'drop-event' })
    expect(dropped.status).toBe('accepted')
    await root.scheduler.dispatchUntilIdle()
    expect(root.scheduler.getRun(dropped.runId!)?.cancelReason).toBe('OVERFLOW')
    expect(root.scheduler.listExecutions(dropped.runId!)).toEqual([])
    root.scheduler.cancelRun(first.runId!)
    await dispose(root)
    const restarted = await context(path)
    expect(restarted.scheduler.acceptTrigger(binding, { data: { value: 'retry' }, eventId: 'drop-event' }))
      .toEqual({ status: 'duplicate', runId: dropped.runId })
    expect(restarted.scheduler.listRuns()).toHaveLength(2)
  })

  it('replaces only the oldest admitted Run needed for capacity and preserves the existing queue', async () => {
    const root = await context(await directory())
    const { automationId } = publish(root, waiting({ maxActive: 2, overflow: 'queue' }))
    const oldest = root.scheduler.startManual(automationId), other = root.scheduler.startManual(automationId)
    await root.scheduler.dispatchUntilIdle()
    const queuedFirst = root.scheduler.startManual(automationId), queuedSecond = root.scheduler.startManual(automationId)
    await root.scheduler.dispatchUntilIdle()
    revise(root, automationId, waiting({ maxActive: 2, overflow: 'replace' }))
    const replacement = root.scheduler.startManual(automationId)
    await root.scheduler.dispatchUntilIdle()
    expect(root.scheduler.getRun(oldest.id)).toMatchObject({ status: 'CANCELLED', cancelReason: 'REPLACED' })
    expect(statuses(root, other, queuedFirst, queuedSecond, replacement)).toEqual(['RUNNING', 'QUEUED', 'QUEUED', 'RUNNING'])
    expect(root.scheduler.listExecutions(queuedFirst.id)).toEqual([])
    root.scheduler.cancelRun(other.id)
    await root.scheduler.dispatchUntilIdle()
    expect(statuses(root, queuedFirst, queuedSecond, replacement)).toEqual(['RUNNING', 'QUEUED', 'RUNNING'])
  })

  it('isolates formal capacity from all three test entrypoints while sharing one test namespace', async () => {
    const root = await context(await directory())
    const { automationId, revisionId } = publish(root, action({ maxActive: 1 }, true))
    const formal = root.scheduler.startManual(automationId, { value: 'formal' })
    await root.scheduler.dispatchUntilIdle()
    const revisionTest = root.scheduler.startRevisionTest(automationId, revisionId, { value: 'revision' }, null, 'admission-revision-test-0001')
    const draftTest = await root.scheduler.startDraftTest(automationId, 1, { value: 'draft' }, null, 'admission-draft-test-0001')
    const localTest = await startLocal(root, localRequest(automationId, 'local'), 'admission-local-test-0001')
    const formalQueued = root.scheduler.startManual(automationId, { value: 'formal-queued' })
    await root.scheduler.dispatchUntilIdle()
    expect(statuses(root, formal, revisionTest, draftTest, localTest, formalQueued)).toEqual(['RUNNING', 'RUNNING', 'QUEUED', 'QUEUED', 'QUEUED'])
    root.scheduler.cancelRun(revisionTest.id)
    await root.scheduler.dispatchUntilIdle()
    expect(statuses(root, formal, draftTest, localTest, formalQueued)).toEqual(['RUNNING', 'RUNNING', 'QUEUED', 'QUEUED'])
    root.scheduler.cancelRun(draftTest.id)
    await root.scheduler.dispatchUntilIdle()
    expect(statuses(root, formal, localTest, formalQueued)).toEqual(['RUNNING', 'RUNNING', 'QUEUED'])
    root.scheduler.cancelRun(formal.id)
    await root.scheduler.dispatchUntilIdle()
    expect(statuses(root, localTest, formalQueued)).toEqual(['RUNNING', 'RUNNING'])
  })

  it('rejects missing group references atomically at every entrypoint before persisting a Run, receipt or Draft snapshot', async () => {
    const root = await context(await directory())
    const source = action({ maxActive: 1, groupBy: { type: 'ref', path: 'trigger.group' } }, true)
    source.triggers = [{ id: 'event', capability: { id: triggerDefinition.id, version: 1 }, config: {} }]
    const { automationId, revisionId } = publish(root, source), binding = eventBinding(root, automationId)
    const before = acceptanceCounts(root)
    expect(() => root.scheduler.startManual(automationId, { value: 'manual' }, {}, revisionId, 'admission-invalid-manual-01')).toThrow()
    expect(() => root.scheduler.startRevisionTest(automationId, revisionId, { value: 'revision' }, {}, 'admission-invalid-revision-01')).toThrow()
    await expect(root.scheduler.startDraftTest(automationId, 1, { value: 'draft' }, {}, 'admission-invalid-draft-01')).rejects.toThrow()
    await expect(startLocal(root, localRequest(automationId, 'local'), 'admission-invalid-local-01')).rejects.toThrow()
    expect(() => root.scheduler.acceptTrigger(binding, { data: {}, eventId: 'invalid-event' })).toThrow()
    expect(acceptanceCounts(root)).toEqual(before)
  })

  it('keeps provider-blocked Runs admitted until resolution or cancellation', async () => {
    const root = await context(await directory())
    const { automationId } = publish(root, action())
    const first = root.scheduler.startManual(automationId, { value: 'first' }), second = root.scheduler.startManual(automationId, { value: 'second' })
    await root.scheduler.dispatchUntilIdle()
    expect(statuses(root, first, second)).toEqual(['RUNNING', 'QUEUED'])
    expect(root.scheduler.listExecutions(first.id)).toContainEqual(expect.objectContaining({ status: 'BLOCKED', blockedReason: 'PROVIDER_UNAVAILABLE' }))
    const calls: string[] = []
    root.capabilities.provide(root, definition, { async invoke({ input }) { calls.push((input as { value: string }).value); return input } })
    await root.scheduler.dispatchUntilIdle()
    expect(calls).toEqual(['first', 'second'])
    expect(statuses(root, first, second)).toEqual(['COMPLETED', 'COMPLETED'])
  })

  it('continues holding capacity for an unsafe timeout with OUTCOME_UNKNOWN', async () => {
    const root = await context(await directory(), { invoke: async (_input, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    }) })
    const source = action()
    if (source.flow.type !== 'capability') throw Error('fixture')
    source.flow.policy = { timeoutMs: 10 }
    const { automationId } = publish(root, source)
    const first = root.scheduler.startManual(automationId, { value: 'unsafe' }), second = root.scheduler.startManual(automationId, { value: 'queued' })
    await root.scheduler.dispatchUntilIdle()
    expect(root.scheduler.listExecutions(first.id)).toContainEqual(expect.objectContaining({ status: 'BLOCKED', blockedReason: 'OUTCOME_UNKNOWN' }))
    expect(statuses(root, first, second)).toEqual(['RUNNING', 'QUEUED'])
    root.scheduler.cancelRun(first.id)
    await root.scheduler.dispatchUntilIdle()
    expect(statuses(root, second)).toEqual(['RUNNING'])
  })

  it('restores frozen waiting permits, FIFO order, and formal/test isolation after restart', async () => {
    const path = await directory(), root = await context(path)
    const source = waiting({ maxActive: 1, groupBy: { type: 'ref', path: 'input.group' } })
    const { automationId, revisionId } = publish(root, source)
    const first = root.scheduler.startManual(automationId, { group: 'A' })
    const second = root.scheduler.startManual(automationId, { group: 'A' })
    const third = root.scheduler.startManual(automationId, { group: 'A' })
    const test = root.scheduler.startRevisionTest(automationId, revisionId, { group: 'A' }, null, 'admission-restart-test-01')
    await root.scheduler.dispatchUntilIdle()
    const key = root.scheduler.getRun(first.id)?.groupKey
    await dispose(root)
    const restarted = await context(path)
    await restarted.scheduler.dispatchUntilIdle()
    expect(statuses(restarted, first, second, third, test)).toEqual(['RUNNING', 'QUEUED', 'QUEUED', 'RUNNING'])
    expect(restarted.scheduler.getRun(first.id)?.groupKey).toBe(key)
    restarted.scheduler.cancelRun(first.id)
    await restarted.scheduler.dispatchUntilIdle()
    expect(statuses(restarted, second, third, test)).toEqual(['RUNNING', 'QUEUED', 'RUNNING'])
    expect(restarted.scheduler.listEvents(first.id).filter(event => event.type === 'RunStarted')).toHaveLength(1)
  })

  it('backfills pre-admission Runs without losing permits, queue order or historical test namespace', async () => {
    const path = await directory(), root = await context(path)
    const { automationId, revisionId } = publish(root, waiting())
    const active = root.scheduler.startManual(automationId)
    const queuedFirst = root.scheduler.startManual(automationId), queuedSecond = root.scheduler.startManual(automationId)
    const test = root.scheduler.startRevisionTest(automationId, revisionId, {}, null, 'admission-legacy-test-01')
    await root.scheduler.dispatchUntilIdle()
    // This is the v17 durable shape: Runs and RunAccepted events, but no admission records.
    root.database.db.prepare('DELETE FROM run_admissions').run()
    root.database.db.prepare('UPDATE runs SET group_key = NULL').run()
    await dispose(root)
    const restarted = await context(path)
    await restarted.scheduler.dispatchUntilIdle()
    expect(statuses(restarted, active, queuedFirst, queuedSecond, test)).toEqual(['RUNNING', 'QUEUED', 'QUEUED', 'RUNNING'])
    expect(restarted.database.db.prepare('SELECT namespace FROM run_admissions WHERE run_id = ?').get(test.id)).toEqual({ namespace: 'test' })
    expect(acceptanceCounts(restarted).run_admissions).toBe(4)
    restarted.scheduler.cancelRun(active.id)
    await restarted.scheduler.dispatchUntilIdle()
    expect(statuses(restarted, queuedFirst, queuedSecond)).toEqual(['RUNNING', 'QUEUED'])
    await dispose(restarted)
    const twice = await context(path)
    expect(acceptanceCounts(twice).run_admissions).toBe(4)
  })

  it('counts an unrecoverable legacy active group against all formal groups and fails only unresolved queued Runs', async () => {
    const path = await directory(), root = await context(path)
    const source = waiting({ maxActive: 1, groupBy: { type: 'ref', path: 'input.group' } })
    const { automationId, revisionId } = publish(root, source)
    const legacy = root.scheduler.startManual(automationId, { group: 'old-group' })
    await root.scheduler.dispatchUntilIdle()
    const otherGroup = root.scheduler.startManual(automationId, { group: 'new-group' })
    const unresolvedQueued = root.scheduler.startManual(automationId, { group: 'missing-after-restart' })
    root.database.db.prepare('DELETE FROM run_admissions WHERE run_id IN (?, ?)').run(legacy.id, unresolvedQueued.id)
    root.database.db.prepare("UPDATE runs SET group_key = NULL, input_json = '{}' WHERE id IN (?, ?)").run(legacy.id, unresolvedQueued.id)
    await dispose(root)
    const restarted = await context(path)
    const independentTest = restarted.scheduler.startRevisionTest(automationId, revisionId, { group: 'new-group' }, null, 'admission-legacy-isolated-01')
    await restarted.scheduler.dispatchUntilIdle()
    expect(statuses(restarted, legacy, otherGroup, unresolvedQueued, independentTest)).toEqual(['RUNNING', 'QUEUED', 'FAILED', 'RUNNING'])
    expect(restarted.scheduler.getRun(legacy.id)?.groupKey).toBeUndefined()
    expect(restarted.scheduler.listEvents(legacy.id).filter(event => event.type === 'AdmissionRecoveryFailed')).toHaveLength(1)
    expect(restarted.scheduler.listExecutions(unresolvedQueued.id)).toEqual([])
    restarted.scheduler.cancelRun(legacy.id)
    await restarted.scheduler.dispatchUntilIdle()
    expect(statuses(restarted, otherGroup)).toEqual(['RUNNING'])
  })

  it('freezes duplicate submissions from two SQLite connections into one durable admission record', async () => {
    const path = await directory(), firstContext = await context(path), secondContext = await context(path)
    const { automationId, revisionId } = publish(firstContext, waiting())
    const requestId = 'admission-two-connections-01'
    const [first, duplicate] = await Promise.all([firstContext, secondContext].map(root => Promise.resolve().then(() =>
      root.scheduler.startManual(automationId, {}, null, revisionId, requestId))))
    expect(duplicate!.id).toBe(first!.id)
    expect(firstContext.database.db.prepare('SELECT run_id FROM run_admissions').all()).toEqual([{ run_id: first!.id }])
    const second = secondContext.scheduler.startManual(automationId)
    // One Scheduler owns execution; the second connection models concurrent API acceptance.
    await firstContext.scheduler.dispatchUntilIdle()
    expect(statuses(firstContext, first!, second)).toEqual(['RUNNING', 'QUEUED'])
    expect(firstContext.scheduler.listExecutions(first!.id)).toHaveLength(1)
    expect(firstContext.scheduler.listEvents(first!.id).filter(event => event.type === 'RunStarted')).toHaveLength(1)
    firstContext.scheduler.cancelRun(first!.id)
    await firstContext.scheduler.dispatchUntilIdle()
    expect(statuses(secondContext, second)).toEqual(['RUNNING'])
    expect(secondContext.scheduler.listExecutions(second.id)).toHaveLength(1)
  })

  it('admits newly accepted work while an earlier Provider remains pending without waiting for a consistency sweep', async () => {
    const firstGate = deferred(), secondGate = deferred(), calls: string[] = []
    const root = await context(await directory(), { autoDispatch: true, invoke: async input => {
      const value = (input as { value: string }).value
      calls.push(value)
      await (value === 'first' ? firstGate.promise : secondGate.promise)
      return input
    } })
    const { automationId } = publish(root, action({ maxActive: 2 }))
    const first = root.scheduler.startManual(automationId, { value: 'first' })
    await eventually(() => calls.includes('first'), 'first Provider must begin')
    const second = root.scheduler.startManual(automationId, { value: 'second' })
    await eventually(() => calls.includes('second'), 'new acceptance must wake the dispatcher while first Provider is pending')
    expect(statuses(root, first, second)).toEqual(['RUNNING', 'RUNNING'])
    secondGate.resolve()
    await eventually(() => root.scheduler.getRun(second.id)?.status === 'COMPLETED', 'second Provider must complete independently')
    expect(statuses(root, first)).toEqual(['RUNNING'])
    firstGate.resolve()
    await root.scheduler.dispatchUntilIdle()
    expect(statuses(root, first)).toEqual(['COMPLETED'])
  })

  it('reserves the replacement slot until an uncooperative Provider settles and fences its late result', async () => {
    const firstGate = deferred(), replacementGate = deferred(), calls: string[] = []
    let firstSignal: AbortSignal | undefined
    const root = await context(await directory(), { autoDispatch: true, invoke: async (input, signal) => {
      const value = (input as { value: string }).value
      calls.push(value)
      if (value === 'old') { firstSignal = signal; await firstGate.promise }
      if (value === 'replacement') await replacementGate.promise
      return input
    } })
    const { automationId } = publish(root, action({ maxActive: 1, overflow: 'queue' }))
    const oldest = root.scheduler.startManual(automationId, { value: 'old' })
    await eventually(() => calls.includes('old'), 'old Provider must start')
    const queued = root.scheduler.startManual(automationId, { value: 'queued' })
    revise(root, automationId, action({ maxActive: 1, overflow: 'replace' }))
    const replacement = root.scheduler.startManual(automationId, { value: 'replacement' })
    await eventually(() => firstSignal?.aborted === true, 'replacement must request cancellation of old Provider')
    await root.scheduler.dispatchUntilIdle()
    expect(calls).toEqual(['old'])
    expect(statuses(root, queued, replacement)).toEqual(['QUEUED', 'QUEUED'])
    expect(root.scheduler.listExecutions(replacement.id)).toEqual([])
    firstGate.resolve()
    await eventually(() => calls.includes('replacement'), 'replacement must receive the newly released permit before the older queue entry')
    expect(calls).toEqual(['old', 'replacement'])
    expect(statuses(root, queued, replacement)).toEqual(['QUEUED', 'RUNNING'])
    expect(root.scheduler.getRun(oldest.id)).toMatchObject({ status: 'CANCELLED', cancelReason: 'REPLACED' })
    expect(root.scheduler.listAttempts(oldest.id).map(attempt => attempt.status)).toEqual(['ABORTED'])
    expect(root.scheduler.listExecutions(oldest.id).every(execution => execution.output === undefined)).toBe(true)
    replacementGate.resolve()
    await root.scheduler.dispatchUntilIdle()
    expect(calls).toEqual(['old', 'replacement', 'queued'])
    expect(statuses(root, queued, replacement)).toEqual(['COMPLETED', 'COMPLETED'])
  })

  it('retains replacement priority across restart while preserving pre-existing queued work', async () => {
    const path = await directory(), gate = deferred()
    let started = false, signal: AbortSignal | undefined
    const root = await context(path, { invoke: async (input, invocationSignal) => {
      started = true; signal = invocationSignal
      await gate.promise
      return input
    } })
    const { automationId } = publish(root, action({ maxActive: 1, overflow: 'queue' }))
    const oldest = root.scheduler.startManual(automationId, { value: 'old' })
    const dispatch = root.scheduler.dispatchUntilIdle()
    await eventually(() => started, 'old Provider must start')
    const queued = root.scheduler.startManual(automationId, { value: 'queued' })
    revise(root, automationId, action({ maxActive: 1, overflow: 'replace' }))
    const replacement = root.scheduler.startManual(automationId, { value: 'replacement' })
    await root.scheduler.dispatchUntilIdle()
    expect(signal?.aborted).toBe(true)
    expect(statuses(root, queued, replacement)).toEqual(['QUEUED', 'QUEUED'])
    await dispatch
    await dispose(root)
    gate.resolve()
    const restarted = await context(path)
    await restarted.scheduler.dispatchUntilIdle()
    expect(statuses(restarted, oldest, queued, replacement)).toEqual(['CANCELLED', 'QUEUED', 'RUNNING'])
    expect(restarted.scheduler.listExecutions(replacement.id)).toContainEqual(expect.objectContaining({ status: 'BLOCKED' }))
    expect(restarted.scheduler.listEvents(oldest.id).filter(event => event.type === 'RunCancellationRequested')).toHaveLength(1)
    restarted.scheduler.cancelRun(replacement.id)
    await restarted.scheduler.dispatchUntilIdle()
    expect(statuses(restarted, queued)).toEqual(['RUNNING'])
  })

  it('drops arrivals behind a replacement reservation while allowing an explicitly unlimited Revision to run', async () => {
    const gate = deferred(), calls: string[] = []
    const root = await context(await directory(), { autoDispatch: true, invoke: async input => {
      const value = (input as { value: string }).value
      calls.push(value)
      if (value === 'old') await gate.promise
      return input
    } })
    const { automationId } = publish(root, action({ maxActive: 1, overflow: 'queue' }))
    root.scheduler.startManual(automationId, { value: 'old' })
    const dispatch = root.scheduler.dispatchUntilIdle()
    await eventually(() => calls.includes('old'), 'old Provider must start')
    const queued = root.scheduler.startManual(automationId, { value: 'queued' })
    revise(root, automationId, action({ maxActive: 1, overflow: 'replace' }))
    const replacement = root.scheduler.startManual(automationId, { value: 'replacement' })
    await root.scheduler.dispatchUntilIdle()
    expect(statuses(root, queued, replacement)).toEqual(['QUEUED', 'QUEUED'])
    revise(root, automationId, action({ maxActive: 1, overflow: 'drop' }))
    const dropped = root.scheduler.startManual(automationId, { value: 'must-not-send' })
    revise(root, automationId, action({ overflow: 'replace' }))
    const unlimited = root.scheduler.startManual(automationId, { value: 'unlimited' })
    await root.scheduler.dispatchUntilIdle()
    expect(root.scheduler.getRun(dropped.id)).toMatchObject({ status: 'CANCELLED', cancelReason: 'OVERFLOW' })
    expect(root.scheduler.listExecutions(dropped.id)).toEqual([])
    expect(statuses(root, queued, replacement, unlimited)).toEqual(['QUEUED', 'QUEUED', 'COMPLETED'])
    expect(calls).toEqual(['old', 'unlimited'])
    gate.resolve()
    await dispatch
    await eventually(() => root.scheduler.getRun(queued.id)?.status === 'COMPLETED', 'settlement must resume the replacement and preserved queue')
    await root.scheduler.dispatchUntilIdle()
    expect(calls).toEqual(['old', 'unlimited', 'replacement', 'queued'])
  })

  it('replaces only as many oldest Runs as required when a new Revision lowers the capacity', async () => {
    const root = await context(await directory())
    const { automationId } = publish(root, waiting({ maxActive: 3 }))
    const runs = Array.from({ length: 3 }, () => root.scheduler.startManual(automationId))
    await root.scheduler.dispatchUntilIdle()
    revise(root, automationId, waiting({ maxActive: 2, overflow: 'replace' }))
    const replacement = root.scheduler.startManual(automationId)
    await root.scheduler.dispatchUntilIdle()
    expect(statuses(root, ...runs, replacement)).toEqual(['CANCELLED', 'CANCELLED', 'RUNNING', 'RUNNING'])
    expect(runs.slice(0, 2).map(run => root.scheduler.getRun(run.id)?.cancelReason)).toEqual(['REPLACED', 'REPLACED'])
  })

  it('searches beyond multiple full queue pages without starving another group or changing FIFO order', async () => {
    const root = await context(await directory())
    const { automationId } = publish(root, waiting({ maxActive: 1, groupBy: { type: 'ref', path: 'input.group' } }))
    const crowded = Array.from({ length: 140 }, () => root.scheduler.startManual(automationId, { group: 'crowded' }))
    const independent = root.scheduler.startManual(automationId, { group: 'independent' })
    await root.scheduler.dispatchUntilIdle()
    expect(statuses(root, crowded[0]!, independent)).toEqual(['RUNNING', 'RUNNING'])
    expect(statuses(root, ...crowded.slice(1)).every(status => status === 'QUEUED')).toBe(true)
    root.scheduler.cancelRun(crowded[0]!.id)
    await root.scheduler.dispatchUntilIdle()
    expect(statuses(root, crowded[1]!, crowded[2]!, independent)).toEqual(['RUNNING', 'QUEUED', 'RUNNING'])
  })

  it('distinguishes empty, null, false, numeric, string, array, and object grouping values', async () => {
    const root = await context(await directory())
    const { automationId } = publish(root, waiting({ maxActive: 1, groupBy: { type: 'ref', path: 'input.group' } }))
    const values: NumenValue[] = ['', null, false, 0, '0', 'false', [], {}, [1, 2], [2, 1]]
    const unique = values.map(group => root.scheduler.startManual(automationId, { group }))
    const repeated = values.map(group => root.scheduler.startManual(automationId, { group }))
    await root.scheduler.dispatchUntilIdle()
    expect(statuses(root, ...unique).every(status => status === 'RUNNING')).toBe(true)
    expect(statuses(root, ...repeated).every(status => status === 'QUEUED')).toBe(true)
    expect(new Set(unique.map(run => root.scheduler.getRun(run.id)?.groupKey)).size).toBe(values.length)
    for (const [index, run] of unique.entries()) expect(root.scheduler.getRun(run.id)?.groupKey).toBe(root.scheduler.getRun(repeated[index]!.id)?.groupKey)
  })

  it('rejects inherited group references but permits explicitly owned JSON prototype-like fields', async () => {
    const root = await context(await directory())
    const { automationId } = publish(root, waiting({ maxActive: 1, groupBy: { type: 'ref', path: 'input.group.__proto__' } }))
    const before = acceptanceCounts(root)
    expect(() => root.scheduler.startManual(automationId, { group: {} })).toThrow('Cannot resolve the Run admission policy')
    expect(acceptanceCounts(root)).toEqual(before)
    const owned = JSON.parse('{"__proto__":"customer","constructor":"literal"}') as NumenValue
    const accepted = root.scheduler.startManual(automationId, { group: owned })
    await root.scheduler.dispatchUntilIdle()
    expect(statuses(root, accepted)).toEqual(['RUNNING'])
    expect(root.scheduler.getRun(accepted.id)?.input.group).toEqual(owned)
  })
})
