import { AutomationService } from '@numenjs/automation'
import { CapabilityInvocationError, CapabilityRegistry, type AutomationSource, type NumenValue, type StartReplayRequest } from '@numenjs/core'
import { DatabaseService } from '@numenjs/database'
import { ResourceService } from '@numenjs/resources'
import { Context } from 'cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import z from 'schemastery'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SchedulerService } from '../src/service.js'

const directories: string[] = []
const contexts = new Set<Context>()
const releases = new Set<() => void>()
afterEach(async () => {
  for (const release of releases) release()
  releases.clear()
  vi.restoreAllMocks()
  for (const ctx of contexts) await ctx.fiber.dispose()
  contexts.clear()
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'numen-replay-')); directories.push(path); return path
}
const actionDefinition = {
  id: 'test:replay', version: 1, kind: 'action' as const, title: 'Replay', input: z.any(), output: z.any(),
  semantics: { sideEffect: true, idempotent: false, retrySafe: false },
}
async function context(path: string, options: { autoDispatch?: boolean; invoke?: (input: NumenValue) => Promise<NumenValue> } = {}) {
  const root = new Context(); contexts.add(root)
  await root.plugin(DatabaseService, { path: join(path, 'db') })
  await root.plugin(CapabilityRegistry)
  root.capabilities.define(root, actionDefinition)
  if (options.invoke) root.capabilities.provide(root, actionDefinition, { invoke: ({ input }) => options.invoke!(input) })
  await root.plugin(AutomationService)
  await root.plugin(ResourceService, { path: join(path, 'resources'), gcGraceMs: 0 })
  await root.plugin(SchedulerService, { autoDispatch: options.autoDispatch ?? false, sweepIntervalMs: 60_000 })
  return root
}
const empty: AutomationSource = { triggers: [], flow: { type: 'block', id: 'flow', steps: [] } }
function publish(root: Context, source: AutomationSource = empty) {
  const { automation } = root.automations.create({ name: 'Replay', source })
  const revision = root.automations.publishDraft(automation.id, 1)
  root.automations.activateRevision(automation.id, revision.id)
  return { automation, revision }
}
function revise(root: Context, automationId: string, source: AutomationSource) {
  const draft = root.automations.getDraft(automationId)!
  const saved = root.automations.saveDraft({ automationId, expectedVersion: draft.version, source })
  const revision = root.automations.publishDraft(automationId, saved.version)
  root.automations.activateRevision(automationId, revision.id)
  return revision
}
async function cancelled(root: Context, automationId: string, input: Record<string, NumenValue> = {}, trigger: NumenValue = null) {
  const run = root.scheduler.startManual(automationId, input, trigger)
  root.scheduler.cancelRun(run.id); await root.scheduler.dispatchUntilIdle()
  return root.scheduler.getRun(run.id)!
}
function request(root: Context, sourceRunId: string, requestId = 'replay-default-request-01', target: 'original' | 'active' = 'original'): StartReplayRequest {
  const preview = root.scheduler.previewReplay(sourceRunId, target)
  return { sourceRunId, target, revisionId: preview.revisionId!, requestId, confirmSideEffects: true }
}
function counts(root: Context) {
  return Object.fromEntries(['runs', 'run_admissions', 'run_events', 'run_origins', 'replay_requests', 'resource_owners'].map(table => [table,
    (root.database.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count,
  ]))
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done }); releases.add(resolve)
  return { promise, resolve }
}
async function eventually(test: () => boolean) {
  const deadline = Date.now() + 3000
  while (!test() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
  expect(test()).toBe(true)
}

describe('formal Run replay', () => {
  it('previews safe metadata and replays original immutable input/trigger from the beginning with formal admission and origin', async () => {
    const root = await context(await directory())
    const { automation, revision } = publish(root, { ...empty, inputs: { secret: { type: 'string', required: true } }, policy: { maxActive: 1 } })
    const source = await cancelled(root, automation.id, { secret: 'do-not-return' }, { private: 'trigger-private' })
    const events = root.scheduler.listEvents(source.id)
    const preview = root.scheduler.previewReplay(source.id)
    expect(preview).toEqual({ sourceRunId: source.id, automationId: automation.id, target: 'original', revisionId: revision.id,
      revisionNumber: 1, canReplay: true, requiresOutcomeConfirmation: false })
    expect(JSON.stringify(preview)).not.toContain('private')
    expect(JSON.stringify(preview)).not.toContain('do-not-return')
    const run = await root.scheduler.startReplay(request(root, source.id))
    expect(run).toMatchObject({ status: 'QUEUED', revisionId: revision.id, input: source.input, trigger: source.trigger })
    expect(run.id).not.toBe(source.id)
    expect(root.scheduler.getRun(source.id)).toEqual(source)
    expect(root.scheduler.listEvents(source.id)).toEqual(events)
    expect(root.database.db.prepare('SELECT namespace, max_active FROM run_admissions WHERE run_id = ?').get(run.id)).toEqual({ namespace: 'formal', max_active: 1 })
    expect(root.database.db.prepare('SELECT kind, source_run_id, source_run_identity, suppress_attention FROM run_origins WHERE run_id = ?').get(run.id))
      .toEqual({ kind: 'replay', source_run_id: source.id, source_run_identity: source.id, suppress_attention: 0 })
    await root.scheduler.dispatchUntilIdle()
    expect(root.scheduler.getRun(run.id)?.status).toBe('COMPLETED')
  })

  it('rejects test/completed/active sources and requires explicit side-effect confirmation', async () => {
    const root = await context(await directory())
    const { automation, revision } = publish(root)
    const active = root.scheduler.startManual(automation.id)
    expect(root.scheduler.previewReplay(active.id)).toMatchObject({ canReplay: false, reasonCode: 'SOURCE_NOT_TERMINAL' })
    const test = root.scheduler.startRevisionTest(automation.id, revision.id, {}, null, 'revision-test-not-replayable')
    await root.scheduler.dispatchUntilIdle()
    expect(root.scheduler.previewReplay(test.id)).toMatchObject({ canReplay: false, reasonCode: 'FORMAL_RUN_REQUIRED' })
    expect(root.scheduler.previewReplay(active.id)).toMatchObject({ canReplay: false, reasonCode: 'SOURCE_NOT_REPLAYABLE' })
    const source = await cancelled(root, automation.id), input = request(root, source.id)
    await expect(root.scheduler.startReplay({ ...input, confirmSideEffects: false } as unknown as StartReplayRequest)).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' })
    await expect(root.scheduler.startReplay({ ...input, target: 'invalid' } as unknown as StartReplayRequest)).rejects.toThrow('Invalid replay target')
    expect(root.scheduler.listRuns()).toHaveLength(3)
  })

  it('starts a failed Run from the entrypoint and leaves its original failed Attempt unchanged', async () => {
    let calls = 0
    const root = await context(await directory(), { invoke: async input => {
      if (++calls === 1) throw new Error('private provider failure')
      return input
    } })
    const { automation } = publish(root, { triggers: [], flow: { type: 'capability', id: 'action',
      capability: { id: actionDefinition.id, version: 1 }, input: { event: { type: 'ref', path: 'trigger.event' } } } })
    const source = root.scheduler.startManual(automation.id, {}, { event: 'same-event' })
    await root.scheduler.dispatchUntilIdle()
    expect(root.scheduler.getRun(source.id)?.status).toBe('FAILED')
    const attempts = root.scheduler.listAttempts(source.id)
    expect(attempts).toHaveLength(1)
    const replay = await root.scheduler.startReplay(request(root, source.id))
    await root.scheduler.dispatchUntilIdle()
    expect(root.scheduler.getRun(replay.id)?.status).toBe('COMPLETED')
    expect(calls).toBe(2)
    expect(root.scheduler.listAttempts(source.id)).toEqual(attempts)
    expect(root.scheduler.listAttempts(replay.id)).toMatchObject([{ number: 1, status: 'SUCCEEDED' }])
  })

  it('pins the previewed Revision, rejects undeclared/required inputs, and never adds a new default', async () => {
    const root = await context(await directory())
    const { automation, revision } = publish(root)
    const source = await cancelled(root, automation.id, { old: 'preserve' })
    const second = revise(root, automation.id, { ...empty, inputs: { old: { type: 'string' }, optional: { type: 'string', default: 'do-not-inject' } } })
    const original = request(root, source.id, 'replay-original-version-01')
    const current = request(root, source.id, 'replay-current-version-01', 'active')
    expect(original.revisionId).toBe(revision.id); expect(current.revisionId).toBe(second.id)
    const run = await root.scheduler.startReplay(current)
    expect(run.input).toEqual({ old: 'preserve' })
    revise(root, automation.id, { ...empty, inputs: { old: { type: 'string' }, new: { type: 'string', required: true, default: 'no-silent-default' } } })
    expect(root.scheduler.previewReplay(source.id, 'active')).toMatchObject({ canReplay: false, reasonCode: 'INPUT_INCOMPATIBLE' })
    await expect(root.scheduler.startReplay({ ...current, requestId: 'replay-stale-version-01' })).rejects.toMatchObject({ code: 'REVISION_CHANGED' })
    revise(root, automation.id, { ...empty, inputs: {} })
    expect(root.scheduler.previewReplay(source.id, 'active')).toMatchObject({ canReplay: false, reasonCode: 'INPUT_INCOMPATIBLE' })
    expect((await root.scheduler.startReplay(original)).revisionId).toBe(revision.id)
  })

  it('deduplicates racing connections and recovers receipts after restart, activation changes and archive', async () => {
    const path = await directory(), root = await context(path), peer = await context(path)
    const { automation } = publish(root)
    const resource = await root.resources.stage({ name: 'input', mediaType: 'text/plain', content: Buffer.from('shared') })
    const source = await cancelled(root, automation.id, { file: resource.ref })
    const input = request(root, source.id, 'replay-dedupe-request-01', 'active')
    const [first, second] = await Promise.all([root.scheduler.startReplay(input), peer.scheduler.startReplay(input)])
    expect(first.id).toBe(second.id)
    expect(counts(root)).toMatchObject({ runs: 2, replay_requests: 1, run_origins: 1, resource_owners: 1 })
    await expect(root.scheduler.startReplay({ ...input, target: 'original' })).rejects.toMatchObject({ code: 'REQUEST_CONFLICT' })
    revise(root, automation.id, empty)
    root.automations.archive(automation.id)
    await root.fiber.dispose(); contexts.delete(root); await peer.fiber.dispose(); contexts.delete(peer)
    const restarted = await context(path)
    expect((await restarted.scheduler.startReplay(input)).id).toBe(first.id)
    expect(restarted.scheduler.listRuns()).toHaveLength(2)
    expect(restarted.scheduler.listEvents(first.id).filter(event => event.type === 'RunAccepted')).toHaveLength(1)
  })

  it('retains resources in original input/trigger and target Source/IR without requiring old Run ownership', async () => {
    const root = await context(await directory())
    const files = await Promise.all(['input', 'trigger', 'source', 'ir'].map(name => root.resources.stage({ name, mediaType: 'text/plain', content: Buffer.from(name) })))
    const { automation, revision } = publish(root, { ...empty, flow: { type: 'capability', id: 'action',
      capability: { id: actionDefinition.id, version: 1 }, input: { file: { type: 'literal', value: files[2]!.ref } } } })
    // Contract snapshots are immutable; emulate a historical lowering with an IR-only static resource.
    const plan = { ...revision.compiledPlan, resources: [files[3]!.ref] }
    root.database.db.prepare('UPDATE automation_revisions SET compiled_plan_json = ? WHERE id = ?').run(JSON.stringify(plan), revision.id)
    const source = await cancelled(root, automation.id, { file: files[0]!.ref }, { file: files[1]!.ref })
    expect(files.map(file => root.resources.listOwners(file.id))).toEqual([[], [], [], []])
    const run = await root.scheduler.startReplay(request(root, source.id))
    expect(files.map(file => root.resources.listOwners(file.id))).toEqual(files.map(() => [{ type: 'run', id: run.id }]))
    await root.resources.collectGarbage(new Date(Date.now() + 100_000))
    expect(files.map(file => root.resources.get(file.id)?.state)).toEqual(files.map(() => 'COMMITTED'))
  })

  it.each(['activation', 'archive', 'gc', 'unlink'] as const)('rechecks %s after preflight and leaves no partial acceptance', async mode => {
    const root = await context(await directory())
    const { automation } = publish(root)
    const resource = await root.resources.stage({ name: 'race', mediaType: 'text/plain', content: Buffer.from('race'), stagingTtlMs: 0 })
    const source = await cancelled(root, automation.id, { file: resource.ref })
    const input = request(root, source.id, `replay-race-${mode}-0001`, 'active')
    const before = counts(root), entered = deferred(), release = deferred(), preflight = root.resources.preflight.bind(root.resources)
    vi.spyOn(root.resources, 'preflight').mockImplementation(async resourceId => { const result = await preflight(resourceId); entered.resolve(); await release.promise; return result })
    const accepting = root.scheduler.startReplay(input)
    await entered.promise
    if (mode === 'activation') revise(root, automation.id, empty)
    else if (mode === 'archive') root.automations.archive(automation.id)
    else if (mode === 'gc') await root.resources.collectGarbage(new Date(Date.now() + 10_000))
    else await root.resources.store.delete(resource.digest)
    release.resolve()
    await expect(accepting).rejects.toMatchObject({ code: mode === 'activation' ? 'REVISION_CHANGED' : mode === 'archive' ? 'AUTOMATION_ARCHIVED' : 'RESOURCE_UNAVAILABLE' })
    expect(counts(root)).toEqual(before)
  })

  it.each(['resource_owners', 'run_origins', 'replay_requests', 'run_events'] as const)('rolls back every record when %s insertion fails', async table => {
    const root = await context(await directory())
    const { automation } = publish(root)
    const resource = await root.resources.stage({ name: 'rollback', mediaType: 'text/plain', content: Buffer.from('atomic') })
    const source = await cancelled(root, automation.id, { file: resource.ref })
    const input = request(root, source.id), before = counts(root)
    root.database.db.exec(`CREATE TRIGGER fail_replay BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'injected replay failure'); END`)
    await expect(root.scheduler.startReplay(input)).rejects.toThrow('injected replay failure')
    expect(counts(root)).toEqual(before)
    expect(root.resources.get(resource.id)?.state).toBe('STAGED')
  })

  it('inherits trusted notification suppression through repeated replays and source deletion', async () => {
    const root = await context(await directory())
    const { automation } = publish(root)
    const source = await cancelled(root, automation.id)
    root.database.db.prepare("INSERT INTO run_origins (run_id, kind, source_run_id, source_run_identity, suppress_attention) VALUES (?, 'attention', NULL, 'deleted-origin', 1)").run(source.id)
    const first = await root.scheduler.startReplay(request(root, source.id))
    root.scheduler.cancelRun(first.id); await root.scheduler.dispatchUntilIdle()
    root.database.db.prepare('DELETE FROM runs WHERE id = ?').run(source.id)
    const origin = root.database.db.prepare('SELECT source_run_id, source_run_identity, suppress_attention FROM run_origins WHERE run_id = ?').get(first.id)
    expect(origin).toEqual({ source_run_id: null, source_run_identity: source.id, suppress_attention: 1 })
    const next = await root.scheduler.startReplay(request(root, first.id, 'replay-inherited-origin-01'))
    expect(root.database.db.prepare('SELECT suppress_attention FROM run_origins WHERE run_id = ?').get(next.id)).toEqual({ suppress_attention: 1 })
  })

  it('preserves unsafe timeout warnings after acknowledgement, cancellation and restart, including legacy journal-only history', async () => {
    const path = await directory(), gate = deferred()
    const root = await context(path, { invoke: async () => { await gate.promise; return null } })
    const { automation } = publish(root, { triggers: [], flow: { type: 'capability', id: 'action',
      capability: { id: actionDefinition.id, version: 1 }, input: {}, policy: { timeoutMs: 5 } } })
    const source = root.scheduler.startManual(automation.id)
    await root.scheduler.dispatchUntilIdle()
    expect(root.scheduler.listAttempts(source.id).map(attempt => attempt.status)).toEqual(['TIMED_OUT'])
    expect(root.scheduler.previewReplay(source.id)).toMatchObject({ canReplay: false, requiresOutcomeConfirmation: true })
    const attention = root.scheduler.listAttention({ runId: source.id }).items[0]!
    root.scheduler.acknowledgeAttention(attention.id)
    root.scheduler.cancelRun(source.id); await root.scheduler.dispatchUntilIdle()
    expect(root.scheduler.listExecutions(source.id)[0]).toMatchObject({ status: 'CANCELLED' })
    expect(root.scheduler.listExecutions(source.id)[0]?.blockedReason).toBeUndefined()
    expect(root.scheduler.previewReplay(source.id)).toMatchObject({ canReplay: true, requiresOutcomeConfirmation: true })
    // A pre-migration cancellation has a journal entry even if no attention was backfilled.
    root.database.db.prepare('DELETE FROM run_attentions WHERE run_id = ?').run(source.id)
    expect(root.scheduler.previewReplay(source.id)).toMatchObject({ canReplay: true, requiresOutcomeConfirmation: true })
    gate.resolve(); await root.fiber.dispose(); contexts.delete(root)
    const restarted = await context(path)
    expect(restarted.scheduler.previewReplay(source.id)).toMatchObject({ canReplay: true, requiresOutcomeConfirmation: true })
  })

  it('preserves a Provider-declared uncertain result after explicit cancellation', async () => {
    const root = await context(await directory(), { invoke: async () => { throw new CapabilityInvocationError('Transport closed after the external side effect.', 'unknown') } })
    const { automation } = publish(root, { triggers: [], flow: { type: 'capability', id: 'action',
      capability: { id: actionDefinition.id, version: 1 }, input: {} } })
    const source = root.scheduler.startManual(automation.id)
    await root.scheduler.dispatchUntilIdle()
    expect(root.scheduler.listAttempts(source.id).map(attempt => attempt.status)).toEqual(['OUTCOME_UNKNOWN'])
    expect(root.scheduler.previewReplay(source.id)).toMatchObject({ canReplay: false, requiresOutcomeConfirmation: true })
    root.scheduler.cancelRun(source.id); await root.scheduler.dispatchUntilIdle()
    expect(root.scheduler.previewReplay(source.id)).toMatchObject({ canReplay: true, requiresOutcomeConfirmation: true })
    expect(JSON.stringify(root.scheduler.previewReplay(source.id))).not.toContain('Transport closed')
  })

  it('requires explicit cancellation of unknown outcomes and keeps noncooperative Provider occupancy for replay', async () => {
    const gate = deferred(); let calls = 0
    const root = await context(await directory(), { autoDispatch: true, invoke: async input => { calls++; if (calls === 1) await gate.promise; return input } })
    const { automation } = publish(root, { triggers: [], policy: { maxActive: 1 }, flow: { type: 'capability', id: 'action',
      capability: { id: actionDefinition.id, version: 1 }, input: { value: { type: 'literal', value: 'same-input' } } } })
    const source = root.scheduler.startManual(automation.id)
    await eventually(() => calls === 1)
    // Seed the durable unknown state while the real noncooperative Provider is still outstanding.
    root.database.db.prepare("UPDATE attempts SET status = 'OUTCOME_UNKNOWN' WHERE execution_id IN (SELECT id FROM executions WHERE run_id = ?)").run(source.id)
    expect(root.scheduler.previewReplay(source.id)).toMatchObject({ canReplay: false, requiresOutcomeConfirmation: true, reasonCode: 'SOURCE_NOT_TERMINAL' })
    root.scheduler.cancelRun(source.id)
    await eventually(() => root.scheduler.getRun(source.id)?.status === 'CANCELLED')
    expect(root.scheduler.previewReplay(source.id)).toMatchObject({ canReplay: true, requiresOutcomeConfirmation: true })
    const replay = await root.scheduler.startReplay(request(root, source.id))
    await root.scheduler.dispatchUntilIdle()
    expect(root.scheduler.getRun(replay.id)?.status).toBe('QUEUED'); expect(calls).toBe(1)
    gate.resolve()
    await eventually(() => root.scheduler.getRun(replay.id)?.status === 'COMPLETED')
    expect(calls).toBe(2)
    expect(root.scheduler.getRun(source.id)?.status).toBe('CANCELLED')
  })
})
