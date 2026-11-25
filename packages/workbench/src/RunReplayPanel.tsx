import { Button } from '@numenjs/components'
import type { ReplayTarget } from '@numenjs/core'
import { diagnosticText, t } from './i18n.js'
import { coreWorkbenchRunFlowRoute } from './routes.js'
import type { WorkbenchPageProps } from './types.js'
import { useRunReplay } from './useRunReplay.js'
import { defineSetupComponent } from './vue-component.js'

interface RunReplayPanelProps extends WorkbenchPageProps { runId: string }

export const RunReplayPanel = defineSetupComponent<RunReplayPanelProps>('RunReplayPanel', ['consoleClient', 'schemaUI', 'navigation', 'runId'], props => {
  const replay = useRunReplay({ runId: () => props.runId, client: () => props.consoleClient })
  return () => {
    const preview = replay.preview.status === 'READY' ? replay.preview.data : undefined
    if (!replay.receipt.value && (!preview || !preview.canReplay && !preview.requiresOutcomeConfirmation && ['FORMAL_RUN_REQUIRED', 'SOURCE_NOT_TERMINAL', 'SOURCE_NOT_REPLAYABLE'].includes(preview.reasonCode ?? ''))) {
      if (replay.preview.status !== 'ERROR') return null
    }
    const accepted = replay.receipt.value?.runId
    return <section class="core-page-section run-replay-section" aria-label={t('workbench.replay.title')}>
      <h2>{t('workbench.replay.title')}</h2>
      <p>{t('workbench.replay.help')}</p>
      {accepted ? <div class="attention-item-actions"><span role="status">{t('workbench.replay.accepted')}</span><Button variant="secondary" type="button" disabled={!props.navigation} onClick={() => props.navigation?.navigate(coreWorkbenchRunFlowRoute, { parameters: { id: accepted } })}>{t('workbench.replay.openRun')}</Button></div> : <>
        <div class="runs-filters"><label><span>{t('workbench.replay.version')}</span><select aria-label={t('workbench.replay.version')} value={replay.target.value} disabled={replay.locked.value} onChange={event => replay.choose((event.target as HTMLSelectElement).value as ReplayTarget)}>
          <option value="original">{t('workbench.replay.original')}</option><option value="active">{t('workbench.replay.active')}</option>
        </select></label></div>
        {replay.receipt.value || preview?.revisionId ? <p class="replay-version">{t('workbench.replay.fixedVersion', { number: preview?.revisionId === replay.receipt.value?.request.revisionId || !replay.receipt.value ? preview?.revisionNumber ?? '—' : '—' })}<code>{replay.receipt.value?.request.revisionId ?? preview?.revisionId}</code></p> : null}
        {replay.uncertain.value ? <p role="status">{t('workbench.replay.uncertain')}</p> : preview?.reason ? <p role="status">{diagnosticText({ code: `REPLAY_${preview.reasonCode}`, message: preview.reason })}</p> : null}
        {!replay.uncertain.value && preview?.canReplay ? <div class="replay-confirmations">
          {preview.requiresOutcomeConfirmation ? <label><input type="checkbox" checked={replay.outcomeConfirmed.value} disabled={replay.pending.value} onChange={event => { replay.outcomeConfirmed.value = (event.target as HTMLInputElement).checked }} /><span>{t('workbench.replay.confirmOutcome')}</span></label> : null}
          <label><input type="checkbox" checked={replay.confirmed.value} disabled={replay.pending.value} onChange={event => { replay.confirmed.value = (event.target as HTMLInputElement).checked }} /><span>{t('workbench.replay.confirmSideEffects')}</span></label>
        </div> : null}
        <div class="attention-item-actions"><Button variant="primary" type="button" disabled={replay.pending.value || !replay.uncertain.value && (!preview?.canReplay || !replay.confirmed.value || preview.requiresOutcomeConfirmation && !replay.outcomeConfirmed.value)} onClick={() => void replay.submit()}>{replay.pending.value ? t('workbench.replay.submitting') : replay.uncertain.value ? t('workbench.replay.recover') : t('workbench.replay.start')}</Button>
          <Button variant="ghost" type="button" disabled={replay.locked.value} onClick={replay.reload}>{t('workbench.replay.refresh')}</Button></div>
      </>}
      {replay.error.value ? <p class="inspector-field-error" role="alert">{diagnosticText(replay.error.value)}</p> : null}
      {replay.preview.status === 'ERROR' && !accepted && !replay.uncertain.value ? <p class="inspector-field-error" role="alert">{diagnosticText(replay.preview)}</p> : null}
    </section>
  }
})
