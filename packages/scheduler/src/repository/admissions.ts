import type { DatabaseService } from '@numenjs/database'
import type { AdmissionRow, RunRow } from './rows.js'

export interface AdmissionCandidateCursor {
  replacement: number
  sequence: number
}

/**
 * Run admission state: the frozen concurrency policy and the QUEUED -> RUNNING,
 * drop and replacement transitions. Writes assume the caller holds the
 * immediate transaction that decides admission.
 */
export class AdmissionRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db
  }

  /** `groupKey` null means an unknown legacy group that counts against every group. */
  freeze(runId: string, groupKey: string | null, maxActive: number | null, overflow: 'queue' | 'drop' | 'replace', namespace: 'formal' | 'test'): void {
    this.db.prepare('UPDATE runs SET group_key = ? WHERE id = ?').run(groupKey, runId)
    this.db.prepare(`
      INSERT INTO run_admissions (run_id, max_active, overflow, namespace) VALUES (?, ?, ?, ?)
    `).run(runId, maxActive, overflow, namespace)
  }

  /** Active Runs created before durable admission existed, in insertion order. */
  listUnfrozenActiveRuns(): RunRow[] {
    return this.db.prepare(`
      SELECT runs.* FROM runs LEFT JOIN run_admissions ON run_admissions.run_id = runs.id
      WHERE runs.status IN ('QUEUED', 'RUNNING', 'CANCELLING') AND run_admissions.run_id IS NULL
      ORDER BY runs.created_at, runs.rowid
    `).all() as RunRow[]
  }

  acceptedReceiptPayload(runId: string): string | undefined {
    return (this.db.prepare(`
      SELECT payload_json FROM run_events WHERE run_id = ? AND type = 'RunAccepted' ORDER BY sequence LIMIT 1
    `).get(runId) as { payload_json: string } | undefined)?.payload_json
  }

  /**
   * Cross-domain read of an Automation-owned table. Kept raw on purpose: legacy
   * recovery must tolerate rows that AutomationService's typed identity rejects.
   */
  snapshotPurpose(revisionId: string): string | undefined {
    return (this.db.prepare('SELECT purpose FROM automation_revisions WHERE id = ?').get(revisionId) as { purpose: string } | undefined)?.purpose
  }

  /** Replacement reservations first, then ordinary queue order. */
  queuedCandidates(cursor: AdmissionCandidateCursor): AdmissionRow[] {
    return this.db.prepare(`
      SELECT runs.*, run_admissions.* FROM runs JOIN run_admissions ON run_admissions.run_id = runs.id
      WHERE runs.status = 'QUEUED' AND (replacement_requested < ? OR (replacement_requested = ? AND sequence > ?))
      ORDER BY replacement_requested DESC, sequence LIMIT 64
    `).all(cursor.replacement, cursor.replacement, cursor.sequence) as AdmissionRow[]
  }

  /** Started Runs holding capacity in a scope, including locally pending Providers. */
  activeInScope(automationId: string, namespace: string, groupKey: string | null, pendingRunIds: readonly string[]): AdmissionRow[] {
    return this.db.prepare(`
      SELECT runs.*, run_admissions.* FROM runs JOIN run_admissions ON run_admissions.run_id = runs.id
      WHERE runs.automation_id = ? AND namespace = ? AND (group_key = ? OR group_key IS NULL)
        AND runs.started_at IS NOT NULL
        AND (runs.status IN ('RUNNING', 'CANCELLING') OR runs.id IN (SELECT value FROM json_each(?)))
      ORDER BY runs.started_at, sequence
    `).all(automationId, namespace, groupKey, JSON.stringify(pendingRunIds)) as AdmissionRow[]
  }

  drop(runId: string, now: string): void {
    this.db.prepare(`
      UPDATE runs SET status = 'CANCELLED', cancel_reason = 'OVERFLOW', finished_at = ? WHERE id = ? AND status = 'QUEUED'
    `).run(now, runId)
  }

  requestReplacement(runId: string): void {
    this.db.prepare('UPDATE run_admissions SET replacement_requested = 1 WHERE run_id = ?').run(runId)
  }

  markReplaced(runId: string): void {
    this.db.prepare(`UPDATE runs SET status = 'CANCELLING', cancel_reason = 'REPLACED' WHERE id = ? AND status = 'RUNNING'`).run(runId)
  }

  /** Returns false when another transition already moved the Run out of QUEUED. */
  start(runId: string, now: string): boolean {
    return this.db.prepare(`
      UPDATE runs SET status = 'RUNNING', started_at = ? WHERE id = ? AND status = 'QUEUED'
    `).run(now, runId).changes > 0
  }

  failQueued(runId: string, now: string): void {
    this.db.prepare(`
      UPDATE runs SET status = 'FAILED', finished_at = ? WHERE id = ? AND status = 'QUEUED'
    `).run(now, runId)
  }

  insertQueuedRun(run: { id: string; automationId: string; revisionId: string; trigger: unknown; input: unknown; createdAt: string }): void {
    this.db.prepare(`
      INSERT INTO runs (
        id, automation_id, revision_id, status, trigger_json, input_json, created_at
      ) VALUES (?, ?, ?, 'QUEUED', ?, ?, ?)
    `).run(run.id, run.automationId, run.revisionId, JSON.stringify(run.trigger), JSON.stringify(run.input), run.createdAt)
  }

  findManualRequest(requestId: string): { contentHash: string; runId: string } | undefined {
    const row = this.db.prepare(
      'SELECT content_hash, run_id FROM manual_run_requests WHERE request_id = ?',
    ).get(requestId) as { content_hash: string; run_id: string } | undefined
    return row ? { contentHash: row.content_hash, runId: row.run_id } : undefined
  }

  recordManualRequest(requestId: string, contentHash: string | undefined, runId: string): void {
    this.db.prepare(`
      INSERT INTO manual_run_requests (request_id, content_hash, run_id) VALUES (?, ?, ?)
    `).run(requestId, contentHash, runId)
  }

  /** Delivery deduplication is scoped to one Revision and Trigger. */
  findTriggerDelivery(revisionId: string, triggerId: string, eventId: string): string | undefined {
    return (this.db.prepare(`
      SELECT run_id FROM trigger_events
      WHERE revision_id = ? AND trigger_id = ? AND event_id = ?
    `).get(revisionId, triggerId, eventId) as { run_id: string } | undefined)?.run_id
  }

  recordTriggerEvent(event: {
    id: string
    automationId: string
    revisionId: string
    activationGeneration: number
    triggerId: string
    capabilityId: string
    capabilityVersion: number
    eventId?: string
    subject?: string
    data: unknown
    checkpoint?: unknown
    occurredAt: string
    acceptedAt: string
    runId: string
  }): void {
    this.db.prepare(`
      INSERT INTO trigger_events (
        id, automation_id, revision_id, activation_generation, trigger_id,
        capability_id, capability_version, event_id, subject, data_json,
        checkpoint_json, occurred_at, accepted_at, run_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.id,
      event.automationId,
      event.revisionId,
      event.activationGeneration,
      event.triggerId,
      event.capabilityId,
      event.capabilityVersion,
      event.eventId ?? null,
      event.subject ?? null,
      JSON.stringify(event.data),
      event.checkpoint === undefined ? null : JSON.stringify(event.checkpoint),
      event.occurredAt,
      event.acceptedAt,
      event.runId,
    )
  }
}
