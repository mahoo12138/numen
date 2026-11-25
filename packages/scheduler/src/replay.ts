import '@numenjs/automation'
import '@numenjs/database'
import '@numenjs/resources'
import {
  clockOf,
  isSupportedAutomationVersion,
  nextId,
  resolveAutomationInputs,
  type AutomationRevision,
  type AutomationSource,
  type NumenValue,
  type ReplayPreview,
  type ReplayRejectionCode,
  type ReplayTarget,
  type Run,
  type StartReplayRequest,
} from '@numenjs/core'
import type { Context } from 'cordis'
import { createHash } from 'node:crypto'
import { collectRunResourceIds, collectSnapshotResourceIds, draftTestAcceptanceLimits } from './resource-references.js'

const reasons: Record<ReplayRejectionCode, string> = {
  SOURCE_NOT_FOUND: 'The source Run is no longer available.',
  FORMAL_RUN_REQUIRED: 'Only formal Runs can be replayed.',
  SOURCE_NOT_TERMINAL: 'Verify the external outcome and explicitly cancel the active Run before replaying.',
  SOURCE_NOT_REPLAYABLE: 'Only failed or cancelled Runs can be replayed.',
  AUTOMATION_ARCHIVED: 'Restore the archived Automation before replaying.',
  REVISION_UNAVAILABLE: 'The selected published Revision is unavailable or unsupported.',
  REVISION_CHANGED: 'The active Revision changed. Preview the replay again before submitting.',
  INPUT_INCOMPATIBLE: 'The original inputs do not match the selected Revision. Replay does not change or discard original inputs.',
  RESOURCE_UNAVAILABLE: 'A referenced resource is unavailable. No replay was accepted.',
  CONFIRMATION_REQUIRED: 'Confirm that previously successful steps may repeat their side effects before replaying.',
  REQUEST_CONFLICT: 'This replay request ID has already been used for a different request.',
}

export class ReplayError extends Error {
  constructor(public readonly code: ReplayRejectionCode) {
    super(reasons[code])
    this.name = 'ReplayError'
  }
}

export interface ReplayHost {
  getRun(id: string): Run | undefined
  freezeAdmission(runId: string, source: AutomationSource, trigger: NumenValue, input: Record<string, NumenValue>, namespace: 'formal' | 'test'): void
  appendEvent(runId: string, type: string, payload: NumenValue, occurredAt: string, notify: boolean): void
  onAccepted(runId: string): void
}

/** Scheduler acceptance adapter; all durable mutations share the Run acceptance transaction. */
export class ReplayService {
  constructor(private readonly ctx: Context, private readonly host: ReplayHost) {}

  previewReplay(sourceRunId: string, target: ReplayTarget = 'original'): ReplayPreview {
    this.assertTarget(target)
    const source = this.host.getRun(sourceRunId)
    if (!source) throw new ReplayError('SOURCE_NOT_FOUND')
    const automation = this.ctx.automations.get(source.automationId)
    const revisionId = target === 'original' ? source.revisionId : automation?.activeRevisionId
    const revision = revisionId ? this.ctx.automations.getRevision(revisionId) : undefined
    const preview: ReplayPreview = {
      sourceRunId, automationId: source.automationId, target,
      ...(revisionId ? { revisionId } : {}), ...(revision ? { revisionNumber: revision.number } : {}),
      requiresOutcomeConfirmation: this.hasUnknownOutcome(sourceRunId), canReplay: false,
    }
    try {
      const prepared = this.prepare(sourceRunId, target, revisionId)
      for (const resourceId of prepared.resourceIds) {
        try { this.ctx.resources.assertAcceptable(resourceId) } catch { throw new ReplayError('RESOURCE_UNAVAILABLE') }
      }
      preview.canReplay = true
    } catch (error) {
      if (!(error instanceof ReplayError)) throw error
      preview.reasonCode = error.code
      preview.reason = error.message
    }
    return preview
  }

  async startReplay(input: StartReplayRequest): Promise<Run> {
    // Freeze primitive request fields before the asynchronous resource preflight.
    const request = { sourceRunId: input.sourceRunId, target: input.target, revisionId: input.revisionId,
      requestId: input.requestId, confirmSideEffects: input.confirmSideEffects }
    this.assertTarget(request.target)
    if (typeof request.sourceRunId !== 'string' || !request.sourceRunId || typeof request.revisionId !== 'string' || !request.revisionId) {
      throw new TypeError('A source Run and previewed Revision are required.')
    }
    if (!/^[a-zA-Z0-9_-]{16,80}$/.test(request.requestId)) throw new TypeError('Invalid replay request ID.')
    if (request.confirmSideEffects !== true) throw new ReplayError('CONFIRMATION_REQUIRED')
    const contentHash = createHash('sha256').update(JSON.stringify(request)).digest('hex')
    const recoverAccepted = (): Run | undefined => {
      const previous = this.ctx.database.db.prepare('SELECT content_hash, run_id FROM replay_requests WHERE request_id = ?')
        .get(request.requestId) as { content_hash: string; run_id: string } | undefined
      if (!previous) return
      if (previous.content_hash !== contentHash) throw new ReplayError('REQUEST_CONFLICT')
      const run = this.host.getRun(previous.run_id)
      if (!run) throw new ReplayError('SOURCE_NOT_FOUND')
      return run
    }
    const previous = recoverAccepted()
    if (previous) return previous
    try {
      const prepared = this.prepare(request.sourceRunId, request.target, request.revisionId)
      for (const resourceId of prepared.resourceIds) {
        try { await this.ctx.resources.preflight(resourceId) } catch { throw new ReplayError('RESOURCE_UNAVAILABLE') }
      }
      let created = false
      const result = this.ctx.database.transaction(() => {
        const duplicate = recoverAccepted()
        if (duplicate) return duplicate
        // Lifecycle, target Revision and bytes may have changed while preflight yielded.
        const current = this.prepare(request.sourceRunId, request.target, request.revisionId)
        for (const resourceId of current.resourceIds) {
          try { this.ctx.resources.assertAcceptable(resourceId) } catch { throw new ReplayError('RESOURCE_UNAVAILABLE') }
        }
        const runId = nextId('run')
        const now = clockOf(this.ctx).nowIso()
        this.ctx.database.db.prepare(`
          INSERT INTO runs (id, automation_id, revision_id, status, trigger_json, input_json, created_at)
          VALUES (?, ?, ?, 'QUEUED', ?, ?, ?)
        `).run(runId, current.source.automationId, current.revision.id, JSON.stringify(current.source.trigger), JSON.stringify(current.source.input), now)
        this.host.freezeAdmission(runId, current.revision.source, current.source.trigger, current.source.input, 'formal')
        for (const resourceId of current.resourceIds) this.ctx.resources.commitOwner(resourceId, { type: 'run', id: runId })
        const origin = this.ctx.database.db.prepare('SELECT suppress_attention FROM run_origins WHERE run_id = ?')
          .get(current.source.id) as { suppress_attention: number } | undefined
        this.ctx.database.db.prepare(`
          INSERT INTO run_origins (run_id, kind, source_run_id, source_run_identity, suppress_attention)
          VALUES (?, 'replay', ?, ?, ?)
        `).run(runId, current.source.id, current.source.id, origin?.suppress_attention ?? 0)
        this.ctx.database.db.prepare('INSERT INTO replay_requests (request_id, content_hash, run_id) VALUES (?, ?, ?)')
          .run(request.requestId, contentHash, runId)
        this.host.appendEvent(runId, 'RunAccepted', {
          source: 'replay', sourceRunId: current.source.id, revisionId: current.revision.id, replayTarget: request.target,
          requestId: request.requestId,
        }, now, false)
        created = true
        return this.host.getRun(runId)!
      })
      if (created) this.host.onAccepted(result.id)
      return result
    } catch (error) {
      // A concurrent identical request can finish while this one is awaiting resource IO.
      const accepted = recoverAccepted()
      if (accepted) return accepted
      throw error
    }
  }

  private assertTarget(target: ReplayTarget): void {
    if (target !== 'original' && target !== 'active') throw new TypeError('Invalid replay target.')
  }

  private hasUnknownOutcome(runId: string): boolean {
    // Cancellation clears Execution.blockedReason, and unsafe timeouts retain
    // TIMED_OUT on their Attempt. Read durable history, never infer safety from
    // the current execution state or acknowledgement of the attention item.
    const result = this.ctx.database.db.prepare(`
      SELECT EXISTS (
        SELECT 1 FROM run_attentions WHERE run_id = ? AND kind = 'OUTCOME_UNKNOWN'
      ) OR EXISTS (
        SELECT 1 FROM run_events WHERE run_id = ? AND (
          type = 'AttemptOutcomeUnknown'
          OR (type = 'ExecutionBlocked' AND json_extract(payload_json, '$.reason') = 'OUTCOME_UNKNOWN')
        )
      ) OR EXISTS (
        SELECT 1 FROM attempts JOIN executions ON executions.id = attempts.execution_id
        WHERE executions.run_id = ? AND attempts.status = 'OUTCOME_UNKNOWN'
      ) AS unknown
    `).get(runId, runId, runId) as { unknown: number }
    return result.unknown === 1
  }

  private prepare(sourceRunId: string, target: ReplayTarget, expectedRevisionId: string | undefined): {
    source: Run; revision: AutomationRevision; resourceIds: Set<string>
  } {
    const source = this.host.getRun(sourceRunId)
    if (!source) throw new ReplayError('SOURCE_NOT_FOUND')
    const snapshot = this.ctx.automations.getExecutionSnapshot(source.revisionId)
    const admission = this.ctx.database.db.prepare('SELECT namespace FROM run_admissions WHERE run_id = ?')
      .get(source.id) as { namespace: string } | undefined
    const accepted = this.ctx.database.db.prepare("SELECT payload_json FROM run_events WHERE run_id = ? AND type = 'RunAccepted' ORDER BY sequence LIMIT 1")
      .get(source.id) as { payload_json: string } | undefined
    const mode = accepted ? (JSON.parse(accepted.payload_json) as { source?: string }).source : undefined
    if (snapshot?.purpose !== 'published' || admission?.namespace === 'test'
      || mode === 'revision-test' || mode === 'draft-test' || mode === 'local-test') throw new ReplayError('FORMAL_RUN_REQUIRED')
    if (source.status === 'QUEUED' || source.status === 'RUNNING' || source.status === 'CANCELLING') throw new ReplayError('SOURCE_NOT_TERMINAL')
    if (source.status !== 'FAILED' && source.status !== 'CANCELLED') throw new ReplayError('SOURCE_NOT_REPLAYABLE')
    const automation = this.ctx.automations.get(source.automationId)
    if (!automation) throw new ReplayError('SOURCE_NOT_FOUND')
    if (automation.archivedAt) throw new ReplayError('AUTOMATION_ARCHIVED')
    const revisionId = target === 'original' ? source.revisionId : automation.activeRevisionId
    if (!revisionId) throw new ReplayError('REVISION_UNAVAILABLE')
    if (revisionId !== expectedRevisionId) throw new ReplayError('REVISION_CHANGED')
    const revision = this.ctx.automations.getRevision(revisionId)
    if (!revision || revision.automationId !== source.automationId || !isSupportedAutomationVersion(revision.protocolVersion, revision.irVersion)) {
      throw new ReplayError('REVISION_UNAVAILABLE')
    }
    // Replay preserves the entire original object. New defaults cannot silently alter it.
    const declarations = revision.source.inputs === undefined ? undefined : Object.fromEntries(Object.entries(revision.source.inputs)
      .map(([name, declaration]) => { const { default: _default, ...validation } = declaration; return [name, validation] }))
    try { resolveAutomationInputs(declarations === undefined ? {} : { inputs: declarations }, source.input) } catch { throw new ReplayError('INPUT_INCOMPATIBLE') }
    const resourceIds = new Set([
      ...collectRunResourceIds(source.input, source.trigger),
      ...collectSnapshotResourceIds({ source: revision.source, compiledPlan: revision.compiledPlan, presentation: {} }),
    ])
    if (resourceIds.size > draftTestAcceptanceLimits.maxResources) throw new TypeError('Replay references exceed the resource limit.')
    return { source, revision, resourceIds }
  }
}
