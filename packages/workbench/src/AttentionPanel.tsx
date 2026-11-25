import { Button, StatePanel } from '@numenjs/components'
import { computed, onScopeDispose, reactive, ref, watch } from 'vue'
import {
  workbenchAttentionQueryRef, workbenchAcknowledgeAttentionActionRef,
  type WorkbenchAttentionInput, type WorkbenchAttentionItem, type WorkbenchAttentionPage,
  type WorkbenchAcknowledgeAttentionInput,
} from './attention-contracts.js'
import { diagnosticText, formatDateTime, statusLabel, t } from './i18n.js'
import { coreWorkbenchRunFlowRoute } from './routes.js'
import type { WorkbenchPageProps } from './types.js'
import { useConsoleQuery } from './useConsoleQuery.js'
import { defineSetupComponent } from './vue-component.js'

interface AttentionPanelProps extends WorkbenchPageProps {
  runId?: string
  onExecution?(executionId: string): void
  onInspect?(executionId: string, attemptId?: string): void
}

export const AttentionPanel = defineSetupComponent<AttentionPanelProps>('AttentionPanel', ['consoleClient', 'schemaUI', 'navigation', 'runId', 'onExecution', 'onInspect'], props => {
  const kind = ref<WorkbenchAttentionInput['kind']>()
  const automationId = ref('')
  const acknowledgment = ref('unacknowledged')
  const cursor = ref<number>()
  const history = ref<Array<number | undefined>>([])
  const actions = reactive<Record<string, { pending: boolean; error?: { code?: string; message: string } }>>({})
  const lifecycle = new AbortController()
  onScopeDispose(() => lifecycle.abort())
  watch(() => [kind.value, automationId.value, acknowledgment.value, props.runId], () => { cursor.value = undefined; history.value = [] }, { flush: 'sync' })
  const input = computed<WorkbenchAttentionInput>(() => ({
    limit: 10,
    ...(cursor.value ? { beforeSequence: cursor.value } : {}),
    ...(props.runId ? { runId: props.runId } : {
      ...(kind.value ? { kind: kind.value } : {}),
      ...(automationId.value ? { automationId: automationId.value } : {}),
      ...(acknowledgment.value === 'all' ? {} : { acknowledged: acknowledgment.value === 'acknowledged' }),
    }),
  }))
  const [state, reload, refresh] = useConsoleQuery<WorkbenchAttentionInput, WorkbenchAttentionPage>(() => props.consoleClient, workbenchAttentionQueryRef, input, ['home', 'runs'])
  const openRun = (id: string) => props.navigation?.navigate(coreWorkbenchRunFlowRoute, { parameters: { id } })
  const acknowledge = async (item: WorkbenchAttentionItem) => {
    if (!props.consoleClient || actions[item.id]?.pending) return
    actions[item.id] = { pending: true }
    try {
      await props.consoleClient.action<WorkbenchAcknowledgeAttentionInput, WorkbenchAttentionItem>(workbenchAcknowledgeAttentionActionRef, { id: item.id, acknowledged: !item.acknowledgedAt }, lifecycle.signal)
      if (!lifecycle.signal.aborted) refresh()
    } catch (error) {
      if (!lifecycle.signal.aborted) actions[item.id] = { pending: false, error: attentionError(error) }
    } finally { if (actions[item.id]) actions[item.id]!.pending = false }
  }
  return () => {
    if (props.runId && (state.status === 'DISABLED' || state.status === 'READY' && !state.data.items.length)) return null
    return <section class={['core-page-section', 'attention-section', props.runId ? 'run-attention-section' : 'home-attention-section']} aria-label={t('workbench.attention.title')}>
      <div class="runs-section-heading"><h2>{t('workbench.attention.title')}</h2>{state.status === 'READY' ? <span>{t('workbench.attention.count', { count: state.data.unacknowledged })}</span> : null}</div>
      {!props.runId ? <div class="runs-filters attention-filters">
        <label><span>{t('workbench.attention.kind')}</span><select aria-label={t('workbench.attention.kind')} value={kind.value ?? ''} onChange={event => { kind.value = (event.target as HTMLSelectElement).value as WorkbenchAttentionInput['kind'] || undefined }}>
          <option value="">{t('workbench.attention.allKinds')}</option><option value="FAILED">{t('workbench.attention.FAILED')}</option><option value="OUTCOME_UNKNOWN">{t('workbench.attention.OUTCOME_UNKNOWN')}</option>
        </select></label>
        <label><span>{t('workbench.automation')}</span><select aria-label={t('workbench.attention.automationFilter')} value={automationId.value} onChange={event => { automationId.value = (event.target as HTMLSelectElement).value }}>
          <option value="">{t('workbench.attention.allAutomations')}</option>{state.status === 'READY' ? state.data.automations.map(automation => <option key={automation.id} value={automation.id}>{automation.name}</option>) : null}
        </select></label>
        <label><span>{t('workbench.attention.acknowledgment')}</span><select aria-label={t('workbench.attention.acknowledgment')} value={acknowledgment.value} onChange={event => { acknowledgment.value = (event.target as HTMLSelectElement).value }}>
          <option value="unacknowledged">{t('workbench.attention.unacknowledged')}</option><option value="acknowledged">{t('workbench.attention.acknowledged')}</option><option value="all">{t('workbench.attention.allAcknowledgments')}</option>
        </select></label>
      </div> : null}
      {state.status === 'LOADING' ? <StatePanel busy title={t('workbench.attention.loading')} message={t('workbench.attention.loadingHelp')} /> : null}
      {state.status === 'ERROR' ? <StatePanel tone="error" title={t('workbench.attention.unavailable')} message={diagnosticText(state)} action={t('workbench.tryAgain')} onAction={reload} /> : null}
      {state.status === 'READY' ? <>
        {!state.data.items.length ? <p class="home-empty">{t('workbench.attention.empty')}</p> : <ul class="attention-list">{state.data.items.map(item => <li key={item.id} data-attention-id={item.id}>
          <div class="attention-item-heading"><div>
            {!props.runId ? <button class="run-detail-link" type="button" disabled={!props.navigation} onClick={() => openRun(item.runId)}><strong>{item.automationName}</strong></button> : null}
            <strong class="attention-kind">{t(`workbench.attention.${item.kind}`)}</strong>
            <time datetime={item.occurredAt}>{formatDateTime(item.occurredAt)}</time>
          </div><Button variant="secondary" type="button" disabled={actions[item.id]?.pending} onClick={() => void acknowledge(item)}>{item.acknowledgedAt ? t('workbench.attention.markUnacknowledged') : t('workbench.attention.acknowledge')}</Button></div>
          <p>{t(item.kind === 'OUTCOME_UNKNOWN' ? 'workbench.attention.unknownHelp' : 'workbench.attention.failedHelp')}</p>
          {item.acknowledgedAt ? <p class="attention-acknowledged">{t('workbench.attention.acknowledgedAt', { time: formatDateTime(item.acknowledgedAt) })}</p> : null}
          <div class="attention-item-actions">
            {props.runId && item.executionId ? <><Button variant="ghost" type="button" onClick={() => props.onExecution?.(item.executionId!)}>{t('workbench.attention.inspectExecution')}</Button><Button variant="ghost" type="button" onClick={() => props.onInspect?.(item.executionId!, item.attemptId)}>{t('workbench.attention.inspectData')}</Button></> : null}
            {!props.runId ? <Button variant="ghost" type="button" disabled={!props.navigation} onClick={() => openRun(item.runId)}>{t('workbench.attention.openRun')}</Button> : null}
          </div>
          {item.notifications.length ? <div class="attention-notifications"><h3>{t('workbench.attention.notifications')}</h3><ul>{item.notifications.map(notification => <li key={`${notification.automationId}:${notification.triggerId}`}>
            {notification.runId ? <button class="run-detail-link" type="button" disabled={!props.navigation} onClick={() => openRun(notification.runId!)}><strong>{notification.automationName}</strong></button> : <span>{notification.automationName}</span>}
            <span>{notification.status === 'PENDING' || notification.status === 'SKIPPED' || notification.status === 'DELETED' ? t(`workbench.attention.notification.${notification.status}`) : statusLabel(notification.status)}</span>
          </li>)}</ul><p>{t('workbench.attention.deliveryHelp')}</p></div> : null}
          {actions[item.id]?.error ? <p role="alert" class="inspector-field-error">{diagnosticText(actions[item.id]!.error!)}</p> : null}
        </li>)}</ul>}
        <div class="runs-pagination"><Button variant="secondary" type="button" disabled={!history.value.length} onClick={() => { cursor.value = history.value.pop() }}>{t('workbench.attention.newer')}</Button><Button variant="secondary" type="button" disabled={!state.data.nextCursor} onClick={() => { history.value.push(cursor.value); cursor.value = state.data.nextCursor }}>{t('workbench.attention.older')}</Button></div>
      </> : null}
    </section>
  }
})

export function attentionError(error: unknown): { message: string; code?: string } {
  return { message: error instanceof Error ? error.message : t('workbench.attention.actionFailed'), ...(error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? { code: error.code } : {}) }
}
