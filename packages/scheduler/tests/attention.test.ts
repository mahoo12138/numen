import { AutomationService } from '@numenjs/automation'
import { CapabilityInvocationError, CapabilityRegistry, type AutomationSource, type CapabilityDefinition, type TriggerBinding } from '@numenjs/core'
import { DatabaseService } from '@numenjs/database'
import { ResourceService } from '@numenjs/resources'
import { Context } from 'cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import z from 'schemastery'
import { afterEach, describe, expect, it } from 'vitest'
import { SchedulerService } from '../src/index.js'

const directories: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})
const action = (retrySafe: boolean): CapabilityDefinition => ({
  id: 'test:attention-action', version: 1, kind: 'action', title: 'Action',
  input: z.object({}), output: z.object({}), semantics: { retrySafe, sideEffect: true, idempotent: retrySafe },
})
const attentionTrigger: CapabilityDefinition = {
  id: 'run:attention', version: 1, kind: 'trigger', title: 'Attention',
  input: z.object({ kinds: z.array(z.string()).default(['FAILED', 'OUTCOME_UNKNOWN']), automationIds: z.array(z.string()).default([]) }),
  output: z.any(), semantics: { retrySafe: true, sideEffect: false, idempotent: true },
}
async function create(path?: string, invoke: () => Promise<object> = async () => { throw new Error('private input and credential details') }, retrySafe = true): Promise<Context> {
  if (!path) { const dir = await mkdtemp(join(tmpdir(), 'numen-attention-')); directories.push(dir); path = join(dir, 'numen.db') }
  const ctx = new Context(); contexts.push(ctx)
  await ctx.plugin(DatabaseService, { path })
  await ctx.plugin(CapabilityRegistry)
  ctx.capabilities.define(ctx, action(retrySafe))
  ctx.capabilities.provide(ctx, action(retrySafe), { async invoke() { return await invoke() as {} } })
  ctx.capabilities.define(ctx, attentionTrigger)
  await ctx.plugin(AutomationService)
  await ctx.plugin(ResourceService, { path: join(dirname(path), 'resources') })
  await ctx.plugin(SchedulerService, { autoDispatch: false })
  return ctx
}
function publish(ctx: Context, source: AutomationSource = { triggers: [], flow: { type: 'capability', id: 'work', capability: action(true), input: {} } }): string {
  const item = ctx.automations.create({ name: 'Attention test', source })
  const revision = ctx.automations.publishDraft(item.automation.id, 1)
  ctx.automations.activateRevision(item.automation.id, revision.id)
  return item.automation.id
}
function sourceNotification(config: Record<string, any> = {}): AutomationSource {
  return { triggers: [{ id: 'attention', capability: attentionTrigger, config }], flow: { type: 'capability', id: 'notify', capability: action(true), input: {} } }
}
function binding(ctx: Context, id: string): TriggerBinding {
  const automation = ctx.automations.get(id)!
  const trigger = ctx.automations.getRevision(automation.activeRevisionId!)!.source.triggers[0]!
  return { automationId: id, revisionId: automation.activeRevisionId!, activationGeneration: automation.activationGeneration,
    triggerId: trigger.id, capability: trigger.capability, config: trigger.config, connectionIds: {} }
}
async function fail(ctx: Context, id: string) {
  const run = ctx.scheduler.startManual(id)
  await ctx.scheduler.dispatchUntilIdle()
  expect(ctx.scheduler.getRun(run.id)?.status).toBe('FAILED')
  return run
}

describe('durable run attention', () => {
  it('records only final formal failures, keeps safe summaries, and acknowledges independently from Run state', async () => {
    let succeed = false, calls = 0
    const ctx = await create(undefined, async () => { calls += 1; if (succeed && calls % 2 === 0) return {}; throw new Error('private input and credential details') })
    const id = publish(ctx, { triggers: [], flow: { type: 'capability', id: 'work', capability: action(true), input: {}, policy: { retry: { maxAttempts: 2, backoffMs: 0 } } } })
    succeed = true
    const success = ctx.scheduler.startManual(id)
    await ctx.scheduler.dispatchUntilIdle()
    expect(ctx.scheduler.getRun(success.id)?.status).toBe('COMPLETED')
    expect(ctx.scheduler.listAttention().items).toEqual([])
    succeed = false
    const failed = await fail(ctx, id)
    const page = ctx.scheduler.listAttention()
    expect(page.total).toBe(1)
    expect(page.items[0]).toMatchObject({ kind: 'FAILED', runId: failed.id, runStatus: 'FAILED', notifications: [] })
    expect(JSON.stringify(page)).not.toContain('credential')
    expect(page.items[0]!.attemptId).toBe(ctx.scheduler.listAttempts(failed.id).at(-1)!.id)
    expect(ctx.scheduler.acknowledgeAttention(page.items[0]!.id)?.acknowledgedAt).toBeTruthy()
    expect(ctx.scheduler.getRun(failed.id)?.status).toBe('FAILED')
    expect(ctx.scheduler.listAttention({ acknowledged: false }).total).toBe(0)
    expect(ctx.scheduler.listAttention({ acknowledged: true }).total).toBe(1)
    ctx.scheduler.startRevisionTest(id, failed.revisionId, {}, {}, 'revision-test-request-01')
    await ctx.scheduler.dispatchUntilIdle()
    expect(ctx.scheduler.listAttention().total).toBe(1)
    ctx.scheduler.acknowledgeAttention(page.items[0]!.id, false)
    expect(ctx.scheduler.listAttention().unacknowledged).toBe(1)
  })

  it('rolls back final state with attention insert failure and retries settlement without duplicate records', async () => {
    const ctx = await create()
    const id = publish(ctx)
    ctx.database.db.exec(`CREATE TRIGGER prevent_attention BEFORE INSERT ON run_attentions BEGIN SELECT RAISE(ABORT, 'attention failpoint'); END`)
    const run = ctx.scheduler.startManual(id)
    await expect(ctx.scheduler.dispatchUntilIdle()).rejects.toThrow('attention failpoint')
    expect(ctx.scheduler.getRun(run.id)?.status).toBe('RUNNING')
    expect(ctx.scheduler.listAttention().total).toBe(0)
    expect(ctx.scheduler.listEvents(run.id).some(event => event.type === 'RunFailed')).toBe(false)
    ctx.database.db.exec('DROP TRIGGER prevent_attention')
  })

  it('keeps pending work across disabled windows, rejects stale bindings and deduplicates across revision switches', async () => {
    const ctx = await create()
    const source = publish(ctx)
    const target = publish(ctx, sourceNotification())
    await fail(ctx, source) // Before first enable: no catch-up notification.
    ctx.automations.setEnabled(target, true)
    const oldBinding = binding(ctx, target)
    const failed = await fail(ctx, source)
    expect(ctx.scheduler.listAttention({ runId: failed.id }).items[0]!.notifications[0]!.status).toBe('PENDING')
    ctx.automations.setEnabled(target, false)
    expect(ctx.scheduler.dispatchAttention(oldBinding)).toBe(0)
    const disabledFailure = await fail(ctx, source)
    expect(ctx.scheduler.listAttention({ runId: disabledFailure.id }).items[0]!.notifications).toEqual([])
    ctx.automations.setEnabled(target, true)
    expect(ctx.scheduler.dispatchAttention(oldBinding)).toBe(0)
    const current = binding(ctx, target)
    expect(ctx.scheduler.dispatchAttention(current)).toBe(1)
    expect(ctx.scheduler.dispatchAttention(current)).toBe(0)
    const item = ctx.scheduler.listAttention({ runId: failed.id }).items[0]!
    expect(item.notifications[0]!.status).toBe('QUEUED')
    const notification = ctx.scheduler.getRun(item.notifications[0]!.runId!)!
    expect(notification.trigger).toMatchObject({ attentionId: item.id, runId: failed.id, kind: 'FAILED' })
    expect(JSON.stringify(notification.trigger)).not.toContain('private input')
    const draft = ctx.automations.getDraft(target)!
    ctx.automations.saveDraft({ automationId: target, source: sourceNotification({ kinds: ['FAILED'] }), expectedVersion: draft.version })
    const changed = ctx.automations.publishDraft(target, draft.version + 1)
    ctx.automations.activateRevision(target, changed.id)
    expect(ctx.scheduler.dispatchAttention(binding(ctx, target))).toBe(0)
    await ctx.scheduler.dispatchUntilIdle()
    expect(ctx.scheduler.listAttention({ runId: failed.id }).items[0]!.notifications[0]!.status).toBe('FAILED')
    const notificationFailure = ctx.scheduler.listAttention({ runId: notification.id }).items[0]!
    expect(notificationFailure.notifications).toEqual([])
    expect(ctx.scheduler.dispatchAttention(binding(ctx, target))).toBe(0)
  })

  it('atomically commits notification acceptance and receipt, recovers pending delivery after restart and preserves suppression after source purge', async () => {
    const ctx = await create()
    const path = ctx.database.path
    const source = publish(ctx)
    const target = publish(ctx, sourceNotification())
    ctx.automations.setEnabled(target, true)
    const failed = await fail(ctx, source)
    ctx.database.db.exec(`CREATE TRIGGER prevent_receipt BEFORE UPDATE ON attention_deliveries WHEN NEW.status = 'ACCEPTED' BEGIN SELECT RAISE(ABORT, 'receipt failpoint'); END`)
    expect(ctx.scheduler.dispatchAttention(binding(ctx, target))).toBe(0)
    expect(ctx.scheduler.listRuns().filter(run => run.automationId === target)).toEqual([])
    expect(ctx.database.db.prepare('SELECT COUNT(*) AS count FROM run_origins').get()).toEqual({ count: 0 })
    ctx.database.db.exec('DROP TRIGGER prevent_receipt')
    await ctx.fiber.dispose(); contexts.splice(contexts.indexOf(ctx), 1)
    const restarted = await create(path)
    expect(restarted.scheduler.dispatchAttention(binding(restarted, target))).toBe(1)
    const original = restarted.scheduler.listAttention({ runId: failed.id }).items[0]!
    const notificationId = original.notifications[0]!.runId!
    const archived = restarted.automations.archive(source)
    restarted.automations.removeArchived(source, archived.archivedAt!)
    expect(restarted.scheduler.getRun(notificationId)?.status).toBe('QUEUED')
    expect(restarted.database.db.prepare('SELECT source_run_id, attention_id, suppress_attention FROM run_origins WHERE run_id = ?').get(notificationId))
      .toEqual({ source_run_id: null, attention_id: null, suppress_attention: 1 })
    await restarted.scheduler.dispatchUntilIdle()
    expect(restarted.scheduler.listAttention({ runId: notificationId }).items[0]!.notifications).toEqual([])
  })

  it('records unsafe timeout once and acknowledges without cancelling or freeing admission', async () => {
    const ctx = await create(undefined, () => new Promise(() => {}), false)
    const id = publish(ctx, { triggers: [], flow: { type: 'capability', id: 'work', capability: action(false), input: {}, policy: { timeoutMs: 5 } } })
    const run = ctx.scheduler.startManual(id)
    await ctx.scheduler.dispatchUntilIdle()
    const attention = ctx.scheduler.listAttention().items[0]!
    expect(attention).toMatchObject({ kind: 'OUTCOME_UNKNOWN', runId: run.id, runStatus: 'RUNNING' })
    expect(attention.attemptId).toBe(ctx.scheduler.listAttempts(run.id)[0]!.id)
    ctx.scheduler.acknowledgeAttention(attention.id)
    await ctx.scheduler.dispatchUntilIdle()
    expect(ctx.scheduler.listAttention().total).toBe(1)
    expect(ctx.scheduler.getRun(run.id)?.status).toBe('RUNNING')
    expect(ctx.scheduler.listExecutions(run.id)[0]!.blockedReason).toBe('OUTCOME_UNKNOWN')
  })

  it('persists unknown outcome during restart recovery and preserves acknowledgement over further restarts', async () => {
    const ctx = await create(undefined, undefined, false)
    const id = publish(ctx)
    const run = ctx.scheduler.startManual(id)
    const now = new Date().toISOString()
    ctx.database.db.prepare(`UPDATE runs SET status = 'RUNNING', started_at = ? WHERE id = ?`).run(now, run.id)
    ctx.database.db.prepare(`INSERT INTO executions (id, run_id, instruction_id, status, generation, created_at, updated_at) VALUES ('exec_crashed', ?, 'work', 'RUNNING', 1, ?, ?)`).run(run.id, now, now)
    ctx.database.db.prepare(`INSERT INTO attempts (id, execution_id, number, status, provider_ref, started_at) VALUES ('attempt_crashed', 'exec_crashed', 1, 'RUNNING', 'test:attention-action@1', ?)`).run(now)
    const path = ctx.database.path
    await ctx.fiber.dispose(); contexts.splice(contexts.indexOf(ctx), 1)
    const restarted = await create(path, undefined, false)
    const attention = restarted.scheduler.listAttention().items[0]!
    expect(attention).toMatchObject({ kind: 'OUTCOME_UNKNOWN', executionId: 'exec_crashed', attemptId: 'attempt_crashed' })
    restarted.scheduler.acknowledgeAttention(attention.id)
    await restarted.fiber.dispose(); contexts.splice(contexts.indexOf(restarted), 1)
    const again = await create(path, undefined, false)
    expect(again.scheduler.listAttention().total).toBe(1)
    expect(again.scheduler.listAttention().items[0]!.acknowledgedAt).toBeTruthy()
  })

  it('pages attention independently of recent successes and applies source/type/acknowledgement filters', async () => {
    const ctx = await create()
    const a = publish(ctx), b = publish(ctx)
    const first = await fail(ctx, a)
    await fail(ctx, a); await fail(ctx, b)
    const page = ctx.scheduler.listAttention({ limit: 2 })
    expect(page.items).toHaveLength(2)
    expect(page.total).toBe(3)
    expect(ctx.scheduler.listAttention({ limit: 2, beforeSequence: page.nextCursor! }).items[0]!.runId).toBe(first.id)
    expect(ctx.scheduler.listAttention({ automationId: a, kind: 'FAILED' }).total).toBe(2)
    expect(ctx.scheduler.listAttention({ kind: 'OUTCOME_UNKNOWN' }).total).toBe(0)
  })
  it('treats a Provider-declared unknown unsafe outcome as unknown and never retries or exposes its error in notifications', async () => {
    let calls = 0
    const ctx = await create(undefined, async () => { calls += 1; throw new CapabilityInvocationError('secret SMTP payload', 'unknown') }, false)
    // A non-retry-safe Capability cannot declare retries (compiler RETRY_UNSAFE);
    // the Provider still reports an unknown outcome, which must never be retried.
    const id = publish(ctx, { triggers: [], flow: { type: 'capability', id: 'work', capability: action(false), input: {} } })
    const target = publish(ctx, sourceNotification())
    ctx.automations.setEnabled(target, true)
    const run = ctx.scheduler.startManual(id)
    await ctx.scheduler.dispatchUntilIdle()
    expect(calls).toBe(1)
    expect(ctx.scheduler.getRun(run.id)?.status).toBe('RUNNING')
    expect(ctx.scheduler.listAttempts(run.id)[0]!.status).toBe('OUTCOME_UNKNOWN')
    expect(ctx.scheduler.listAttention({ runId: run.id }).items).toHaveLength(1)
    expect(ctx.scheduler.dispatchAttention(binding(ctx, target))).toBe(1)
    const notificationId = ctx.scheduler.listAttention({ runId: run.id }).items[0]!.notifications[0]!.runId!
    expect(JSON.stringify(ctx.scheduler.getRun(notificationId)!.trigger)).not.toContain('secret SMTP')
    await ctx.scheduler.dispatchUntilIdle()
    expect(ctx.scheduler.listAttention({ runId: run.id }).items[0]!.notifications[0]!.status).toBe('OUTCOME_UNKNOWN')
  })

  it('prevents mutual notification loops and inherits suppression when manually replaying a failed notification', async () => {
    const ctx = await create()
    const source = publish(ctx)
    const targets = [publish(ctx, sourceNotification()), publish(ctx, sourceNotification())]
    targets.forEach(id => ctx.automations.setEnabled(id, true))
    const failed = await fail(ctx, source)
    expect(targets.map(id => ctx.scheduler.dispatchAttention(binding(ctx, id)))).toEqual([1, 1])
    await ctx.scheduler.dispatchUntilIdle()
    const notificationId = ctx.scheduler.listAttention({ runId: failed.id }).items[0]!.notifications[0]!.runId!
    const preview = ctx.scheduler.previewReplay(notificationId)
    expect(preview.canReplay).toBe(true)
    const replay = await ctx.scheduler.startReplay({ sourceRunId: notificationId, target: 'original', revisionId: preview.revisionId!, requestId: 'attention-notification-replay-01', confirmSideEffects: true })
    await ctx.scheduler.dispatchUntilIdle()
    expect(ctx.scheduler.listAttention({ runId: replay.id }).items[0]!.notifications).toEqual([])
    expect(targets.map(id => ctx.scheduler.dispatchAttention(binding(ctx, id)))).toEqual([0, 0])
    expect(ctx.scheduler.listAttention().total).toBe(4)
  })

  it('uses current subscription filters for an existing backlog and keeps dispatch bounded', async () => {
    const ctx = await create()
    const source = publish(ctx)
    const target = publish(ctx, sourceNotification())
    ctx.automations.setEnabled(target, true)
    const failed = await fail(ctx, source)
    const draft = ctx.automations.getDraft(target)!
    ctx.automations.saveDraft({ automationId: target, source: sourceNotification({ kinds: ['OUTCOME_UNKNOWN'] }), expectedVersion: draft.version })
    const changed = ctx.automations.publishDraft(target, draft.version + 1)
    ctx.automations.activateRevision(target, changed.id)
    expect(ctx.scheduler.dispatchAttention(binding(ctx, target))).toBe(0)
    expect(ctx.scheduler.listAttention({ runId: failed.id }).items[0]!.notifications[0]!.status).toBe('SKIPPED')
    const nextDraft = ctx.automations.getDraft(target)!
    ctx.automations.saveDraft({ automationId: target, source: sourceNotification(), expectedVersion: nextDraft.version })
    ctx.automations.activateRevision(target, ctx.automations.publishDraft(target, nextDraft.version + 1).id)
    for (let i = 0; i < 51; i++) ctx.scheduler.startManual(source)
    await ctx.scheduler.dispatchUntilIdle()
    expect(ctx.scheduler.dispatchAttention(binding(ctx, target))).toBe(50)
    expect(ctx.scheduler.dispatchAttention(binding(ctx, target))).toBe(1)
    expect(ctx.scheduler.dispatchAttention(binding(ctx, target))).toBe(0)
  })

  it('resolves record-time subscribers from the current active Revision without restart', async () => {
    const ctx = await create()
    const source = publish(ctx)
    const bystander = publish(ctx)
    ctx.automations.setEnabled(bystander, true)
    const target = publish(ctx, sourceNotification({ kinds: ['OUTCOME_UNKNOWN'] }))
    ctx.automations.setEnabled(target, true)
    const unknownOnly = ctx.automations.get(target)!.activeRevisionId!
    const deliveries = async () => {
      const failed = await fail(ctx, source)
      return ctx.scheduler.listAttention({ runId: failed.id }).items[0]!.notifications
    }

    // Neither the filtered subscriber nor an enabled non-notification Automation receives it.
    expect(await deliveries()).toEqual([])
    const draft = ctx.automations.getDraft(target)!
    ctx.automations.saveDraft({ automationId: target, source: sourceNotification({ kinds: ['FAILED'] }), expectedVersion: draft.version })
    ctx.automations.activateRevision(target, ctx.automations.publishDraft(target, draft.version + 1).id)
    expect(await deliveries()).toEqual([expect.objectContaining({ automationId: target, triggerId: 'attention', status: 'PENDING' })])
    // Switching back to an already-seen Revision must use that Revision's own filters.
    ctx.automations.activateRevision(target, unknownOnly)
    expect(await deliveries()).toEqual([])
  })

})
