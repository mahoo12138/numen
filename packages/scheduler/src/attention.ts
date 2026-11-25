import type { Context } from 'cordis'
import { clockOf, nextId, type NumenValue, type Run, type RunAttentionFilters, type RunAttentionItem, type RunAttentionKind, type RunAttentionNotification, type RunAttentionPage, type TriggerAcceptance, type TriggerBinding, type TriggerEmission } from '@numenjs/core'

interface AttentionRow {
  id: string; sequence: number; kind: RunAttentionKind; run_id: string; automation_id: string; revision_id: string
  execution_id: string | null; attempt_id: string | null; occurred_at: string; acknowledged_at: string | null
  summary: string; automation_name: string; run_status: Run['status']
}

const summaries: Record<RunAttentionKind, string> = {
  FAILED: 'The Run failed. Inspect the execution details before running it again.',
  OUTCOME_UNKNOWN: 'An execution outcome is unknown. Verify the external result before cancelling or running it again.',
}

interface AttentionSubscription { triggerId: string; config: Record<string, NumenValue> }

/** Bounded so long-lived hosts with many historical Revisions do not grow without limit. */
const subscriptionCacheLimit = 1024

function matches(config: Record<string, NumenValue>, attention: { kind: RunAttentionKind; automation_id: string }): boolean {
  const kinds = config.kinds ?? ['FAILED', 'OUTCOME_UNKNOWN']
  const automationIds = config.automationIds ?? []
  return Array.isArray(kinds) && kinds.includes(attention.kind)
    && Array.isArray(automationIds) && (!automationIds.length || automationIds.includes(attention.automation_id))
}

/** All notification decisions use durable business state, even with the Trigger plugin unloaded. */
export class AttentionService {
  private notificationScheduled = false
  private readonly subscriptionCache = new Map<string, readonly AttentionSubscription[]>()

  constructor(private readonly ctx: Context, private readonly host: {
    acceptTrigger(binding: TriggerBinding, emission: TriggerEmission): TriggerAcceptance
    changed(runId: string): void
  }) {}

  /** Called by the scheduler inside the transaction that writes the originating event. */
  record(runId: string, kind: RunAttentionKind, occurredAt: string, executionId?: string, attemptId?: string): void {
    const run = this.ctx.database.db.prepare(`SELECT runs.*, run_admissions.namespace, automation_revisions.purpose,
      COALESCE(run_origins.suppress_attention, 0) AS suppressed
      FROM runs JOIN automation_revisions ON automation_revisions.id = runs.revision_id
      LEFT JOIN run_admissions ON run_admissions.run_id = runs.id LEFT JOIN run_origins ON run_origins.run_id = runs.id
      WHERE runs.id = ?`).get(runId) as { automation_id: string; revision_id: string; namespace: string | null; purpose: string; suppressed: number } | undefined
    if (!run || run.namespace === 'test' || run.purpose === 'draft-test') return
    // Legacy Runs that failed admission recovery may not yet have their admission row.
    if (!run.namespace) {
      const receipt = this.ctx.database.db.prepare(`SELECT payload_json FROM run_events WHERE run_id = ? AND type = 'RunAccepted' ORDER BY sequence LIMIT 1`).get(runId) as { payload_json: string } | undefined
      let source: unknown
      try { source = receipt ? JSON.parse(receipt.payload_json)?.source : undefined } catch { /* Preserve an inspectable failure. */ }
      if (['revision-test', 'draft-test', 'local-test'].includes(String(source))) return
    }
    const attentionId = nextId('attention')
    const inserted = this.ctx.database.db.prepare(`INSERT OR IGNORE INTO run_attentions
      (id, kind, run_id, automation_id, revision_id, execution_id, execution_identity, attempt_id, occurred_at, summary)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(attentionId, kind, runId, run.automation_id, run.revision_id, executionId ?? null,
        kind === 'FAILED' ? '' : executionId ?? '', attemptId ?? null, occurredAt, summaries[kind])
    if (!inserted.changes) return
    if (!run.suppressed) {
      // Runs inside the Scheduler's write transaction: avoid re-parsing every
      // subscriber Source on each failure. Only the narrow active-Revision index
      // is read here; Sources are parsed once per immutable Revision.
      for (const subscriber of this.ctx.automations.listActiveRevisions()) {
        for (const subscription of this.subscriptions(subscriber.revisionId)) {
          if (!matches(subscription.config, { kind, automation_id: run.automation_id })) continue
          this.ctx.database.db.prepare(`INSERT OR IGNORE INTO attention_deliveries
            (attention_id, automation_id, trigger_id, created_at) VALUES (?, ?, ?, ?)`)
            .run(attentionId, subscriber.automationId, subscription.triggerId, occurredAt)
        }
      }
    }
    this.notify(runId)
  }

  /** Revisions are immutable, so their notification subscriptions can be cached by id. */
  private subscriptions(revisionId: string): readonly AttentionSubscription[] {
    const cached = this.subscriptionCache.get(revisionId)
    if (cached) return cached
    const revision = this.ctx.automations.getRevision(revisionId)
    if (!revision) return []
    const subscriptions = revision.source.triggers
      .filter(trigger => trigger.capability.id === 'run:attention' && trigger.capability.version === 1)
      .map(trigger => ({ triggerId: trigger.id, config: trigger.config }))
    if (this.subscriptionCache.size >= subscriptionCacheLimit) this.subscriptionCache.delete(this.subscriptionCache.keys().next().value!)
    this.subscriptionCache.set(revisionId, subscriptions)
    return subscriptions
  }

  list(filters: RunAttentionFilters = {}): RunAttentionPage {
    if (filters.kind !== undefined && !['FAILED', 'OUTCOME_UNKNOWN'].includes(filters.kind)) throw new TypeError('Invalid attention kind.')
    if (filters.acknowledged !== undefined && typeof filters.acknowledged !== 'boolean') throw new TypeError('Invalid acknowledgement filter.')
    const limit = filters.limit ?? 25
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError('Attention limit must be between 1 and 100.')
    if (filters.beforeSequence !== undefined && (!Number.isSafeInteger(filters.beforeSequence) || filters.beforeSequence < 1)) throw new TypeError('Invalid attention cursor.')
    const conditions: string[] = []
    const args: (string | number)[] = []
    for (const [field, value] of [['a.automation_id', filters.automationId], ['a.run_id', filters.runId], ['a.kind', filters.kind]] as const) {
      if (value !== undefined) { conditions.push(`${field} = ?`); args.push(value) }
    }
    const baseWhere = conditions.length ? conditions.join(' AND ') : '1 = 1'
    const unacknowledged = (this.ctx.database.db.prepare(`SELECT COUNT(*) AS count FROM run_attentions a WHERE ${baseWhere} AND acknowledged_at IS NULL`).get(...args) as { count: number }).count
    if (filters.acknowledged !== undefined) conditions.push(`a.acknowledged_at IS ${filters.acknowledged ? 'NOT ' : ''}NULL`)
    const where = conditions.length ? conditions.join(' AND ') : '1 = 1'
    const total = (this.ctx.database.db.prepare(`SELECT COUNT(*) AS count FROM run_attentions a WHERE ${where}`).get(...args) as { count: number }).count
    const rows = this.ctx.database.db.prepare(`SELECT a.*, automations.name AS automation_name, runs.status AS run_status
      FROM run_attentions a JOIN runs ON runs.id = a.run_id JOIN automations ON automations.id = a.automation_id
      WHERE ${where} ${filters.beforeSequence === undefined ? '' : 'AND a.sequence < ?'} ORDER BY a.sequence DESC LIMIT ?`)
      .all(...args, ...(filters.beforeSequence === undefined ? [] : [filters.beforeSequence]), limit + 1) as AttentionRow[]
    const page = rows.slice(0, limit)
    return { items: page.map(row => this.map(row)), total, unacknowledged,
      ...(rows.length > limit ? { nextCursor: page.at(-1)!.sequence } : {}) }
  }

  acknowledge(id: string, acknowledged = true): RunAttentionItem | undefined {
    if (typeof acknowledged !== 'boolean') throw new TypeError('Invalid acknowledgement state.')
    const result = this.ctx.database.transaction(() => {
      this.ctx.database.db.prepare(`UPDATE run_attentions SET acknowledged_at = ${acknowledged ? 'COALESCE(acknowledged_at, ?)' : 'NULL'} WHERE id = ?`)
        .run(...(acknowledged ? [clockOf(this.ctx).nowIso(), id] : [id]))
      return this.get(id)
    })
    if (result) this.notify(result.runId)
    return result
  }

  /** A bounded scan. Acceptance, receipt, and trusted origin are committed atomically. */
  dispatch(binding: TriggerBinding): number {
    if (binding.capability.id !== 'run:attention' || binding.capability.version !== 1) return 0
    const pending = this.ctx.database.db.prepare(`SELECT attention_id FROM attention_deliveries
      WHERE automation_id = ? AND trigger_id = ? AND status = 'PENDING' ORDER BY created_at, attention_id LIMIT 50`)
      .all(binding.automationId, binding.triggerId) as Array<{ attention_id: string }>
    let accepted = 0
    for (const pendingRow of pending) {
      let changedRunId: string | undefined
      try {
        const delivered = this.ctx.database.transaction(() => {
          const automation = this.ctx.database.db.prepare(`SELECT enabled, active_revision_id, activation_generation, archived_at
            FROM automations WHERE id = ?`).get(binding.automationId) as { enabled: number; active_revision_id: string | null; activation_generation: number; archived_at: string | null } | undefined
          if (!automation?.enabled || automation.archived_at || automation.active_revision_id !== binding.revisionId
            || automation.activation_generation !== binding.activationGeneration) return false
          const delivery = this.ctx.database.db.prepare(`SELECT status FROM attention_deliveries WHERE automation_id = ? AND trigger_id = ? AND attention_id = ?`)
            .get(binding.automationId, binding.triggerId, pendingRow.attention_id) as { status: string } | undefined
          if (delivery?.status !== 'PENDING') return false
          const attention = this.get(pendingRow.attention_id)
          if (!attention) return false
          // Resolve persisted config, never trust a callback's stale config or forged capability.
          const revision = this.ctx.automations.getRevision(binding.revisionId)
          const trigger = revision?.source.triggers.find(item => item.id === binding.triggerId && item.capability.id === 'run:attention' && item.capability.version === 1)
          if (!trigger || !matches(trigger.config, { kind: attention.kind, automation_id: attention.automationId })) {
            changedRunId = attention.runId
            this.ctx.database.db.prepare(`UPDATE attention_deliveries SET status = 'SKIPPED', summary = ? WHERE automation_id = ? AND trigger_id = ? AND attention_id = ?`)
              .run('The current subscription no longer matches this attention.', binding.automationId, binding.triggerId, attention.id)
            return false
          }
          const result = this.host.acceptTrigger(binding, {
            eventId: attention.id, occurredAt: attention.occurredAt,
            data: { attentionId: attention.id, kind: attention.kind, automationId: attention.automationId,
              automationName: attention.automationName, runId: attention.runId, revisionId: attention.revisionId,
              ...(attention.executionId ? { executionId: attention.executionId } : {}),
              ...(attention.attemptId ? { attemptId: attention.attemptId } : {}),
              occurredAt: attention.occurredAt, summary: attention.summary, runPath: `/runs/${attention.runId}/flow` },
          })
          if (result.status === 'stale' || !result.runId) return false
          this.ctx.database.db.prepare(`INSERT INTO run_origins
            (run_id, kind, source_run_id, source_run_identity, attention_id, suppress_attention)
            VALUES (?, 'attention', ?, ?, ?, 1)`)
            .run(result.runId, attention.runId, attention.runId, attention.id)
          this.ctx.database.db.prepare(`UPDATE attention_deliveries SET status = 'ACCEPTED', run_id = ?, accepted_at = ?, summary = NULL
            WHERE automation_id = ? AND trigger_id = ? AND attention_id = ?`)
            .run(result.runId, clockOf(this.ctx).nowIso(), binding.automationId, binding.triggerId, attention.id)
          changedRunId = attention.runId
          return true
        })
        if (delivered) accepted += 1
      } catch {
        changedRunId = undefined
        // Keep an inspectable backlog; a repaired current Revision can accept it on the next scan.
        const updated = this.ctx.database.db.prepare(`UPDATE attention_deliveries SET summary = ?
          WHERE automation_id = ? AND trigger_id = ? AND attention_id = ? AND status = 'PENDING' AND summary IS NULL`)
          .run('Notification could not be accepted. Check the current notification workflow configuration.', binding.automationId, binding.triggerId, pendingRow.attention_id)
        if (updated.changes) changedRunId = this.get(pendingRow.attention_id)?.runId
      }
      if (changedRunId) this.notify(changedRunId)
    }
    return accepted
  }

  private get(id: string): RunAttentionItem | undefined {
    const row = this.ctx.database.db.prepare(`SELECT a.*, automations.name AS automation_name, runs.status AS run_status
      FROM run_attentions a JOIN runs ON runs.id = a.run_id JOIN automations ON automations.id = a.automation_id WHERE a.id = ?`).get(id) as AttentionRow | undefined
    return row ? this.map(row) : undefined
  }

  private map(row: AttentionRow): RunAttentionItem {
    const notifications = this.ctx.database.db.prepare(`SELECT d.automation_id, automations.name AS automation_name, d.trigger_id, d.run_id, d.status, d.summary, runs.status AS run_status,
      EXISTS(SELECT 1 FROM executions WHERE executions.run_id = d.run_id AND executions.status = 'BLOCKED' AND executions.blocked_reason = 'OUTCOME_UNKNOWN') AS unknown
      FROM attention_deliveries d JOIN automations ON automations.id = d.automation_id LEFT JOIN runs ON runs.id = d.run_id
      WHERE attention_id = ? ORDER BY d.created_at, d.automation_id, d.trigger_id`).all(row.id) as Array<{
        automation_id: string; automation_name: string; trigger_id: string; run_id: string | null; status: 'PENDING' | 'ACCEPTED' | 'SKIPPED'; summary: string | null; run_status: Run['status'] | null; unknown: number
      }>
    return { id: row.id, sequence: row.sequence, kind: row.kind, runId: row.run_id, automationId: row.automation_id,
      revisionId: row.revision_id, ...(row.execution_id ? { executionId: row.execution_id } : {}),
      ...(row.attempt_id ? { attemptId: row.attempt_id } : {}), occurredAt: row.occurred_at,
      ...(row.acknowledged_at ? { acknowledgedAt: row.acknowledged_at } : {}), summary: row.summary,
      automationName: row.automation_name, runStatus: row.run_status,
      notifications: notifications.map((item): RunAttentionNotification => ({ automationId: item.automation_id,
        automationName: item.automation_name, triggerId: item.trigger_id, ...(item.run_id ? { runId: item.run_id } : {}),
        status: item.status === 'ACCEPTED' ? (item.unknown && item.run_status === 'RUNNING' ? 'OUTCOME_UNKNOWN' : item.run_status ?? 'DELETED') : item.status,
        ...(item.summary ? { summary: item.summary } : {}),
      })),
    }
  }

  private notify(runId: string): void {
    this.host.changed(runId)
    if (this.notificationScheduled) return
    this.notificationScheduled = true
    queueMicrotask(() => {
      this.notificationScheduled = false
      this.ctx.emit('numen/run-attention-change', runId)
    })
  }
}

declare module 'cordis' {
  interface Events { 'numen/run-attention-change'(runId: string): void }
}
