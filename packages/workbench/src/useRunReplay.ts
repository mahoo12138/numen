import type { ReplayTarget } from '@numenjs/core'
import { computed, onScopeDispose, ref, shallowRef, watch } from 'vue'
import { attentionError } from './AttentionPanel.js'
import { workbenchReplayPreviewQueryRef, workbenchStartReplayActionRef, type WorkbenchReplayPreview, type WorkbenchReplayPreviewInput, type WorkbenchStartReplayInput, type WorkbenchStartReplayResult } from './attention-contracts.js'
import type { WorkbenchConsoleClient } from './types.js'
import { useConsoleQuery } from './useConsoleQuery.js'

interface ReplayReceipt { request: WorkbenchStartReplayInput; runId?: string }
const receipts = new Map<string, ReplayReceipt>()
const storageKey = (sourceRunId: string) => `numen:run-replay:${sourceRunId}`
function readReceipt(sourceRunId: string): ReplayReceipt | undefined {
  try {
    const raw = globalThis.sessionStorage?.getItem(storageKey(sourceRunId))
    if (raw) {
      const value = JSON.parse(raw) as ReplayReceipt
      if (value.request?.sourceRunId === sourceRunId && ['original', 'active'].includes(value.request.target) && typeof value.request.revisionId === 'string' && /^[a-zA-Z0-9_-]{16,80}$/.test(value.request.requestId) && value.request.confirmSideEffects === true && (value.runId === undefined || typeof value.runId === 'string')) {
        receipts.set(sourceRunId, value)
      }
    }
  } catch { /* In-memory receipts still protect navigation when storage is unavailable. */ }
  return receipts.get(sourceRunId)
}
function saveReceipt(sourceRunId: string, receipt?: ReplayReceipt): void {
  if (receipt) receipts.set(sourceRunId, receipt)
  else receipts.delete(sourceRunId)
  try {
    if (receipt) globalThis.sessionStorage?.setItem(storageKey(sourceRunId), JSON.stringify(receipt))
    else globalThis.sessionStorage?.removeItem(storageKey(sourceRunId))
  } catch { /* Browser storage is optional; no input or trigger payload is retained. */ }
}

export function useRunReplay(options: { runId(): string; client(): WorkbenchConsoleClient | undefined }) {
  const target = ref<ReplayTarget>('original')
  const confirmed = ref(false)
  const outcomeConfirmed = ref(false)
  const pending = ref(false)
  const receipt = shallowRef<ReplayReceipt>()
  const error = shallowRef<{ code?: string; message: string }>()
  let disposed = false
  let controller: AbortController | undefined
  watch(options.runId, sourceRunId => {
    controller?.abort()
    receipt.value = readReceipt(sourceRunId)
    target.value = receipt.value?.request.target ?? 'original'
    pending.value = false; confirmed.value = false; outcomeConfirmed.value = false; error.value = undefined
  }, { immediate: true, flush: 'sync' })
  const input = computed<WorkbenchReplayPreviewInput>(() => ({ sourceRunId: options.runId(), target: target.value }))
  const [preview, reload] = useConsoleQuery<WorkbenchReplayPreviewInput, WorkbenchReplayPreview>(options.client, workbenchReplayPreviewQueryRef, input, 'runs')
  const uncertain = computed(() => !!receipt.value && !receipt.value.runId)
  const locked = computed(() => pending.value || !!receipt.value)
  watch(target, () => { confirmed.value = false; outcomeConfirmed.value = false; error.value = undefined })
  const choose = (value: ReplayTarget) => { if (!locked.value) target.value = value }
  const submit = async () => {
    const client = options.client()
    if (!client || pending.value || receipt.value?.runId) return false
    if (!receipt.value) {
      if (preview.status !== 'READY' || !preview.data.canReplay || !preview.data.revisionId || !confirmed.value || preview.data.requiresOutcomeConfirmation && !outcomeConfirmed.value) return false
      receipt.value = { request: { sourceRunId: options.runId(), target: target.value, revisionId: preview.data.revisionId, requestId: globalThis.crypto.randomUUID(), confirmSideEffects: true } }
      // Save before sending; navigation/reload retries must reuse the original accepted request.
      saveReceipt(options.runId(), receipt.value)
    }
    const current = receipt.value
    const request = controller = new AbortController()
    pending.value = true; error.value = undefined
    try {
      const result = await client.action<WorkbenchStartReplayInput, WorkbenchStartReplayResult>(workbenchStartReplayActionRef, current.request, request.signal)
      saveReceipt(current.request.sourceRunId, { ...current, runId: result.runId })
      if (disposed || request.signal.aborted) return false
      receipt.value = { ...current, runId: result.runId }
      return true
    } catch (failure) {
      if (disposed || request.signal.aborted) return false
      error.value = attentionError(failure)
      if (error.value.code?.startsWith('REPLAY_')) {
        // Explicit domain rejections are known not to have accepted a new Run.
        saveReceipt(current.request.sourceRunId)
        receipt.value = undefined
        confirmed.value = false; outcomeConfirmed.value = false
        reload()
      }
      return false
    } finally { if (!disposed && !request.signal.aborted) pending.value = false }
  }
  onScopeDispose(() => { disposed = true; controller?.abort() })
  return { target, confirmed, outcomeConfirmed, pending, preview, reload, error, receipt, uncertain, locked, choose, submit }
}
