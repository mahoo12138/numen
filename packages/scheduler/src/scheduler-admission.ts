import '@numenjs/automation'
import { AutomationArchivedError, AutomationNotFoundError, AutomationRevisionNotFoundError } from '@numenjs/automation'
import {
  clockOf,
  isNumenValue,
  resolveAutomationInputs,
  type AutomationSource,
  type LocalTestRequest,
  type NumenValue,
  type Run,
  type TriggerAcceptance,
  type TriggerBinding,
  type TriggerEmission,
} from '@numenjs/core'
import { createHash } from 'node:crypto'
import type { SchedulerKernel } from './scheduler-kernel.js'
import { assertSupportedSnapshot, errorValue, id } from './scheduler-kernel.js'
import type { SchedulerExecutionEngine } from './scheduler-engine.js'
import type { SchedulerRecovery } from './scheduler-recovery.js'
import {
  assertDraftTestRequestValues,
  collectRunResourceIds,
  collectSnapshotResourceIds,
  draftTestAcceptanceLimits,
} from './resource-references.js'
import { canonicalize, parseJson, type AdmissionRow } from './repository/rows.js'
import { evaluateExpression } from './evaluator.js'

/**
 * Run admission: idempotent manual/test acceptance, Trigger delivery
 * deduplication, and the durable concurrency policy frozen at acceptance time.
 */

export class ManualRunRevisionConflictError extends Error {
  constructor() { super('The active Revision changed. Reload the run form before submitting.'); this.name = 'ManualRunRevisionConflictError' }
}

export class ManualRunRequestConflictError extends Error {
  constructor() { super('The manual Run request ID was already used with different content.'); this.name = 'ManualRunRequestConflictError' }
}

export class DraftTestResourceUnavailableError extends Error {
  constructor(cause: unknown) { super('A referenced resource is unavailable.', { cause }); this.name = 'DraftTestResourceUnavailableError' }
}

export interface AdmissionHost {
  /** The first durable transition of a Run; the facade decides whether to dispatch. */
  kick(): void
}

export class SchedulerAdmission {
  constructor(
    private readonly kernel: SchedulerKernel,
    private readonly engine: SchedulerExecutionEngine,
    private readonly host: AdmissionHost,
  ) {}

  recovery!: SchedulerRecovery

  async startLocalTest(input: LocalTestRequest & { previewHash: string; requestId: string }): Promise<Run> {
    const { previewHash, requestId, ...request } = structuredClone(input)
    if (!/^[a-f0-9]{64}$/.test(previewHash)) throw new TypeError('A reviewed local test preview is required.')
    return this.startTest(request.automationId, request.expectedDraftVersion, request.input, request.trigger, requestId, { request, previewHash })
  }

  async startTest(
    automationId: string,
    expectedDraftVersion: number,
    input: Record<string, NumenValue>,
    trigger: NumenValue,
    requestId: string,
    localTest?: { request: LocalTestRequest; previewHash: string },
  ): Promise<Run> {
    if (!Number.isSafeInteger(expectedDraftVersion) || expectedDraftVersion < 1) throw new TypeError('invalid expected Draft version')
    if (!/^[a-zA-Z0-9_-]{16,80}$/.test(requestId)) throw new TypeError('invalid manual Run request id')
    assertDraftTestRequestValues(input, trigger)
    // Freeze the complete raw request across the asynchronous physical-resource preflight.
    const rawInput = structuredClone(input)
    const acceptedTrigger = structuredClone(trigger)
    const contentHash = createHash('sha256').update(canonicalize({
      mode: localTest ? 'local-test' : 'draft-test', automationId, expectedDraftVersion, input: rawInput, trigger: acceptedTrigger,
      ...(localTest ? { localTest } : {}),
    })).digest('hex')
    const recoverAccepted = (): Run | undefined => {
      const previous = this.kernel.admissions.findManualRequest(requestId)
      if (!previous) return
      if (previous.contentHash !== contentHash) throw new ManualRunRequestConflictError()
      const run = this.kernel.getRun(previous.runId)
      if (!run) throw new Error(`accepted Run is missing: ${previous.runId}`)
      return run
    }
    const previous = recoverAccepted()
    if (previous) return previous

    try {
      const prepared = localTest ? this.kernel.ctx.automations.prepareLocalTestSnapshot(localTest.request, localTest.previewHash)
        : this.kernel.ctx.automations.prepareDraftTestSnapshot(automationId, expectedDraftVersion)
      const resolvedInput = resolveAutomationInputs(prepared.source, rawInput)
      const snapshotResources = collectSnapshotResourceIds(prepared)
      const runResources = collectRunResourceIds(resolvedInput, acceptedTrigger)
      const allResources = new Set([...snapshotResources, ...runResources])
      if (allResources.size > draftTestAcceptanceLimits.maxResources) throw new TypeError('draft test references exceed the resource limit')
      for (const resourceId of allResources) {
        try { await this.kernel.ctx.resources.preflight(resourceId) } catch (cause) { throw new DraftTestResourceUnavailableError(cause) }
      }
      let created = false
      const run = this.kernel.ctx.database.transaction(() => {
        const duplicate = recoverAccepted()
        if (duplicate) return duplicate
        for (const resourceId of allResources) {
          try { this.kernel.ctx.resources.assertAcceptable(resourceId) } catch (cause) { throw new DraftTestResourceUnavailableError(cause) }
        }
        // This rechecks Draft version/archive inside the same immediate transaction.
        const snapshot = this.kernel.ctx.automations.createDraftTestSnapshot(prepared)
        const acceptedRunId = id('run')
        const now = clockOf(this.kernel.ctx).nowIso()
        for (const resourceId of snapshotResources) this.kernel.ctx.resources.commitOwner(resourceId, { type: 'snapshot', id: snapshot.id })
        for (const resourceId of runResources) this.kernel.ctx.resources.commitOwner(resourceId, { type: 'run', id: acceptedRunId })
        this.kernel.admissions.insertQueuedRun({ id: acceptedRunId, automationId, revisionId: snapshot.id, trigger: acceptedTrigger, input: resolvedInput, createdAt: now })
        this.freezeAdmission(acceptedRunId, snapshot.source, acceptedTrigger, resolvedInput, 'test')
        this.kernel.admissions.recordManualRequest(requestId, contentHash, acceptedRunId)
        this.kernel.appendEvent(acceptedRunId, 'RunAccepted', {
          source: localTest ? 'local-test' : 'draft-test', snapshotId: snapshot.id, revisionId: snapshot.id,
          sourceDraftVersion: snapshot.sourceDraftVersion, requestId, contentHash,
        }, now, false)
        created = true
        return this.kernel.getRun(acceptedRunId)!
      })
      if (created) {
        this.kernel.scheduleRunChange(run.id)
        if (this.kernel.autoDispatch) this.host.kick()
      }
      return run
    } catch (error) {
      // Another connection may have accepted this exact request while preflight awaited.
      const accepted = recoverAccepted()
      if (accepted) return accepted
      throw error
    }
  }

  startRequestedRun(
    automationId: string,
    target: { mode: 'manual'; revisionId?: string } | { mode: 'revision-test'; revisionId: string },
    input: Record<string, NumenValue>,
    trigger: NumenValue,
    requestId?: string,
  ): Run {
    if (!isNumenValue(input) || !isNumenValue(trigger)) throw new TypeError('run input and trigger must be Numen values')
    if (requestId !== undefined && !/^[a-zA-Z0-9_-]{16,80}$/.test(requestId)) throw new TypeError('invalid manual Run request id')
    const contentHash = requestId === undefined ? undefined : createHash('sha256').update(canonicalize({
      automationId,
      ...target,
      input,
      trigger,
    })).digest('hex')
    let created = false
    const runId = this.kernel.ctx.database.transaction(() => {
      if (requestId !== undefined) {
        const previous = this.kernel.admissions.findManualRequest(requestId)
        if (previous) {
          if (previous.contentHash !== contentHash) throw new ManualRunRequestConflictError()
          return previous.runId
        }
      }
      const automation = this.kernel.ctx.automations.get(automationId)
      if (!automation) throw new AutomationNotFoundError(`automation not found: ${automationId}`)
      if (automation.archivedAt) throw new AutomationArchivedError(`automation is archived: ${automationId}`)
      if (target.mode === 'manual') {
        if (!automation.activeRevisionId) throw new ManualRunRevisionConflictError()
        if (target.revisionId !== undefined && automation.activeRevisionId !== target.revisionId) throw new ManualRunRevisionConflictError()
      }
      const revisionId = target.mode === 'revision-test' ? target.revisionId : automation.activeRevisionId!
      const revision = this.kernel.ctx.automations.getRevision(revisionId)
      if (!revision || revision.automationId !== automationId) throw new AutomationRevisionNotFoundError(`revision not found for automation: ${revisionId}`)
      const resolvedInput = resolveAutomationInputs(revision.source, input)
      const acceptedRunId = id('run')
      const now = clockOf(this.kernel.ctx).nowIso()
      this.kernel.admissions.insertQueuedRun({ id: acceptedRunId, automationId, revisionId: revision.id, trigger, input: resolvedInput, createdAt: now })
      this.freezeAdmission(acceptedRunId, revision.source, trigger, resolvedInput, target.mode === 'manual' ? 'formal' : 'test')
      if (requestId !== undefined) this.kernel.admissions.recordManualRequest(requestId, contentHash, acceptedRunId)
      this.kernel.appendEvent(acceptedRunId, 'RunAccepted', { source: target.mode, revisionId: revision.id, ...(requestId ? { requestId } : {}) }, now)
      created = true
      return acceptedRunId
    })
    if (created && this.kernel.autoDispatch) this.host.kick()
    return this.kernel.getRun(runId)!
  }

  acceptTrigger(binding: TriggerBinding, emission: TriggerEmission): TriggerAcceptance {
    if (!isNumenValue(emission.data)) throw new TypeError('trigger data must be a Numen value')
    if (emission.checkpoint !== undefined && !isNumenValue(emission.checkpoint)) {
      throw new TypeError('trigger checkpoint must be a Numen value')
    }
    if (emission.eventId !== undefined && !emission.eventId.trim()) {
      throw new TypeError('trigger eventId must not be empty')
    }
    if (emission.subject !== undefined && !emission.subject.trim()) {
      throw new TypeError('trigger subject must not be empty')
    }
    const acceptedAt = clockOf(this.kernel.ctx).nowIso()
    const occurredAt = emission.occurredAt === undefined
      ? acceptedAt
      : new Date(emission.occurredAt).toISOString()
    let accepted = false
    const result = this.kernel.ctx.database.transaction((): TriggerAcceptance => {
      // Fence on the Automation's activation state inside the acceptance transaction.
      const automation = this.kernel.ctx.automations.get(binding.automationId)
      if (
        !automation?.enabled
        || automation.activeRevisionId !== binding.revisionId
        || automation.activationGeneration !== binding.activationGeneration
      ) {
        return { status: 'stale' }
      }

      if (emission.eventId !== undefined) {
        const duplicate = this.kernel.admissions.findTriggerDelivery(binding.revisionId, binding.triggerId, emission.eventId)
        if (duplicate) return { status: 'duplicate', runId: duplicate }
      }

      const revision = this.kernel.ctx.automations.getRevision(binding.revisionId)!
      const resolvedInput = resolveAutomationInputs(revision.source, {})
      const runId = id('run')
      const eventRowId = id('trigger')
      this.kernel.admissions.insertQueuedRun({ id: runId, automationId: binding.automationId, revisionId: binding.revisionId, trigger: emission.data, input: resolvedInput, createdAt: acceptedAt })
      this.freezeAdmission(runId, revision.source, emission.data, resolvedInput, 'formal')
      this.kernel.admissions.recordTriggerEvent({
        id: eventRowId,
        automationId: binding.automationId,
        revisionId: binding.revisionId,
        activationGeneration: binding.activationGeneration,
        triggerId: binding.triggerId,
        capabilityId: binding.capability.id,
        capabilityVersion: binding.capability.version,
        ...(emission.eventId === undefined ? {} : { eventId: emission.eventId }),
        ...(emission.subject === undefined ? {} : { subject: emission.subject }),
        data: emission.data,
        ...(emission.checkpoint === undefined ? {} : { checkpoint: emission.checkpoint }),
        occurredAt,
        acceptedAt,
        runId,
      })
      this.kernel.appendEvent(runId, 'RunAccepted', {
        source: 'trigger',
        triggerId: binding.triggerId,
        ...(emission.eventId === undefined ? {} : { eventId: emission.eventId }),
      }, acceptedAt)
      accepted = true
      return { status: 'accepted', runId }
    })
    if (accepted && this.kernel.autoDispatch) this.host.kick()
    return result
  }

  freezeAdmission(
    runId: string, source: AutomationSource, trigger: NumenValue,
    input: Record<string, NumenValue>, namespace: 'formal' | 'test',
  ): void {
    const policy = source.policy
    let groupKey = 'ungrouped'
    try {
      if (policy !== undefined && (!policy || typeof policy !== 'object' || Array.isArray(policy))) throw new Error()
      if (policy?.maxActive !== undefined && (!Number.isSafeInteger(policy.maxActive) || policy.maxActive < 1)) throw new Error()
      if (policy?.overflow !== undefined && !['queue', 'drop', 'replace'].includes(policy.overflow)) throw new Error()
      if (policy?.groupBy !== undefined) {
        // Published snapshots normally passed compilation. Validate reference roots
        // again here for pre-migration snapshots and do not fabricate run bindings.
        const check = (value: unknown): void => {
          if (!value || typeof value !== 'object') return
          const expression = value as Record<string, unknown>
          if (expression.type === 'ref' && (typeof expression.path !== 'string' || !/^(trigger|input)(\.|$)/.test(expression.path))) throw new Error()
          if (expression.type === 'template' && Array.isArray(expression.parts)) {
            for (const part of expression.parts) {
              if (typeof part !== 'string' && (!part || typeof part.ref !== 'string' || !/^(trigger|input)(\.|$)/.test(part.ref))) throw new Error()
            }
          }
          if (expression.type === 'array' && Array.isArray(expression.items)) expression.items.forEach(check)
          if (expression.type === 'object' && expression.entries && typeof expression.entries === 'object') Object.values(expression.entries).forEach(check)
          if (expression.type === 'call' && Array.isArray(expression.arguments)) expression.arguments.forEach(check)
        }
        check(policy.groupBy)
        const value = evaluateExpression(policy.groupBy, { trigger, input, run: {}, steps: {}, vars: {}, loop: {}, error: null })
        groupKey = `sha256:${createHash('sha256').update(canonicalize(value)).digest('hex')}`
      }
    } catch {
      // Neither the group value nor the input/trigger belongs in an error or log.
      throw new TypeError('Cannot resolve the Run admission policy from trigger and input.')
    }
    this.kernel.admissions.freeze(runId, groupKey, policy?.maxActive ?? null, policy?.overflow ?? 'queue', namespace)
  }

  recoverAdmissions(): void {
    // Freeze legacy active Runs in their surviving insertion order, once. The
    // durable sequence remains stable across future VACUUMs and restarts.
    this.kernel.ctx.database.transaction(() => {
      const rows = this.kernel.admissions.listUnfrozenActiveRuns()
      for (const row of rows) {
        const accepted = this.kernel.admissions.acceptedReceiptPayload(row.id)
        let source: string | undefined
        try { source = accepted ? parseJson<{ source?: string } | null>(accepted)?.source : undefined } catch { /* Legacy receipts may be unavailable. */ }
        const purpose = this.kernel.admissions.snapshotPurpose(row.revision_id)
        const namespace = purpose === 'draft-test' || source === 'draft-test' || source === 'local-test' || source === 'revision-test' ? 'test' : 'formal'
        try {
          const snapshot = this.kernel.ctx.automations.getExecutionSnapshot(row.revision_id)
          if (!snapshot) throw new Error()
          this.freezeAdmission(row.id, snapshot.source, parseJson(row.trigger_json), parseJson(row.input_json), namespace)
        } catch {
          if (row.status === 'QUEUED') {
            this.failQueuedRun(row.id, { code: 'ADMISSION_RECOVERY_FAILED', message: 'Cannot recover the Run admission policy.' })
          } else {
            // Unknown legacy groups must count against every group in this scope;
            // mapping them to the ordinary ungrouped key could bypass the limit.
            this.kernel.admissions.freeze(row.id, null, null, 'queue', namespace)
            this.kernel.appendEvent(row.id, 'AdmissionRecoveryFailed', { code: 'ADMISSION_RECOVERY_FAILED' })
          }
        }
      }
    })
  }

  admitOneRun(): boolean {
    const victims: string[] = []
    const progressed = this.kernel.ctx.database.transaction(() => {
      // Replacement reservations precede ordinary queue entries so the freed slot
      // goes to the replacement, while existing queued Runs retain their order.
      const reservations = new Set<string>()
      const scopeKey = (row: AdmissionRow): string => JSON.stringify([row.automation_id, row.namespace, row.group_key])
      const pendingRunIds = new Set(this.kernel.pendingProviders.values())
      let cursor = { replacement: 1, sequence: 0 }
      for (;;) {
        const candidates = this.kernel.admissions.queuedCandidates(cursor)
        if (!candidates.length) return false
        for (const row of candidates) {
          cursor = { replacement: row.replacement_requested, sequence: row.sequence }
          const scope = scopeKey(row)
          const reserved = reservations.has(scope)
          // A finite drop must be decided now, not kept until a replacement ends.
          // An unlimited policy does not participate in capacity reservations.
          if (reserved && row.max_active !== null && row.overflow !== 'drop') continue
          if (row.replacement_requested) reservations.add(scope)
          const revision = this.kernel.ctx.automations.getExecutionSnapshot(row.revision_id)
          if (!revision) {
            this.failQueuedRun(row.id, { code: 'REVISION_MISSING', revisionId: row.revision_id })
            return true
          }
          try { assertSupportedSnapshot(revision) } catch (error) {
            this.failQueuedRun(row.id, errorValue(error))
            return true
          }
          const now = clockOf(this.kernel.ctx).nowIso()
          if (row.max_active !== null) {
            const active = this.kernel.admissions.activeInScope(row.automation_id, row.namespace, row.group_key, [...pendingRunIds])
            if (active.length >= row.max_active || reserved) {
              if (row.overflow === 'queue') continue
              if (row.overflow === 'drop') {
                this.kernel.admissions.drop(row.id, now)
                this.kernel.appendEvent(row.id, 'RunDropped', { reason: 'OVERFLOW', maxActive: row.max_active }, now)
                this.kernel.appendEvent(row.id, 'RunCancelled', { reason: 'OVERFLOW' }, now)
                return true
              }
              // Choose victims only once. A later unlimited Revision may enter
              // while cancellation drains; it must not become an extra victim.
              if (row.replacement_requested) continue
              // Cancellation already in progress will free capacity. Do not cancel
              // additional survivors while waiting for those Providers to settle.
              const closing = active.filter(run => run.status !== 'RUNNING').length
              const needed = Math.max(0, active.length - row.max_active + 1 - closing)
              victims.push(...active.filter(run => run.status === 'RUNNING').slice(0, needed).map(run => run.id))
              this.kernel.admissions.requestReplacement(row.id)
              this.kernel.appendEvent(row.id, 'RunReplacementRequested', { maxActive: row.max_active }, now)
              for (const runId of victims) {
                this.kernel.admissions.markReplaced(runId)
                this.kernel.appendEvent(runId, 'RunCancellationRequested', { reason: 'REPLACED', replacementRunId: row.id }, now)
              }
              return true
            }
          }
          if (!this.kernel.admissions.start(row.id, now)) continue
          this.kernel.appendEvent(row.id, 'RunStarted', { revisionId: row.revision_id }, now)
          this.kernel.createExecution(row.id, revision.compiledPlan.entry)
          return true
        }
      }
    })
    // Abort signals can invoke third-party listeners: never run them in the DB transaction.
    for (const runId of victims) this.recovery.propagateCancellation(runId, 'REPLACED')
    return progressed
  }

  failQueuedRun(runId: string, error: NumenValue): void {
    const now = clockOf(this.kernel.ctx).nowIso()
    this.kernel.ctx.database.transaction(() => {
      this.kernel.admissions.failQueued(runId, now)
      this.kernel.appendEvent(runId, 'RunFailed', { error }, now)
    })
  }

}
