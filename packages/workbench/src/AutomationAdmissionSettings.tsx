import { Button, NumberLiteralEditor, SelectMenu } from '@numenjs/components'
import type { AutomationSource, CompileDiagnostic } from '@numenjs/core'
import type { SchemaUIResolver } from '@numenjs/webui/schema-ui'
import { nextTick, ref, watch } from 'vue'
import { AutomationLiteralField } from './AutomationLiteralField.js'
import { ValueExpressionField } from './ValueExpressionEditor.js'
import { projectMagicVariables } from './automation-variable-catalog.js'
import { useAutomationInputSession } from './automation-input-session.js'
import type { WorkbenchAutomationInputField, WorkbenchAutomationVariableCatalog } from './contracts.js'
import { diagnosticText, t } from './i18n.js'
import { defineSetupComponent } from './vue-component.js'

interface AutomationAdmissionSettingsProps {
  source: AutomationSource
  canEdit: boolean
  problems: CompileDiagnostic[]
  schemaUI?: SchemaUIResolver
  variableCatalog?: WorkbenchAutomationVariableCatalog
  focusFieldPath?: string
  focusRequest?: number
  onChange(policy: AutomationSource['policy']): void
}

/** Admission happens before any step executes; the picker must not offer step or run context. */
export function admissionGroupVariables(source: AutomationSource, catalog: WorkbenchAutomationVariableCatalog, field: WorkbenchAutomationInputField) {
  return projectMagicVariables({ source, nodeId: source.flow.id, field, catalog, mode: 'reference' })
    .filter(variable => variable.group === 'input' || variable.group === 'trigger')
}

export function isAutomationPolicyProblem(source: { nodeId?: string; fieldPath?: string }): boolean {
  return source.nodeId === '__policy' || (!source.nodeId && (source.fieldPath === 'policy' || !!source.fieldPath?.startsWith('policy.')))
}

export const AutomationAdmissionSettings = defineSetupComponent<AutomationAdmissionSettingsProps>('AutomationAdmissionSettings', [
  'source', 'canEdit', 'problems', 'schemaUI', 'variableCatalog', 'focusFieldPath', 'focusRequest', 'onChange',
], props => {
  const root = ref<HTMLElement>()
  const session = useAutomationInputSession()
  const update = (policy: NonNullable<AutomationSource['policy']>) => {
    if (props.canEdit) props.onChange(Object.keys(policy).length ? policy : undefined)
  }
  const changeStructure = (change: () => void) => {
    if (props.canEdit && (!session || session.confirmDiscard())) change()
  }
  watch(() => props.focusRequest, async (request, _previous, onCleanup) => {
    if (request === undefined) return
    let current = true
    onCleanup(() => { current = false })
    await nextTick()
    if (!current || props.focusFieldPath?.startsWith('policy.groupBy')) return
    const selector = props.focusFieldPath === 'policy.overflow' ? '[data-admission-overflow] button' : '#automation-policy-maxActive'
    ;(root.value?.querySelector<HTMLElement>(selector) ?? root.value)?.focus()
  }, { immediate: true, flush: 'post' })
  return () => {
    const policy = props.source.policy
    const problems = props.problems.filter(problem => problem.source && isAutomationPolicyProblem(problem.source))
    const maxProblem = problems.find(problem => problem.source?.fieldPath === 'policy.maxActive')
    const overflowProblem = problems.find(problem => problem.source?.fieldPath === 'policy.overflow')
    const groupProblem = problems.find(problem => problem.source?.fieldPath?.startsWith('policy.groupBy'))
    const groupField: WorkbenchAutomationInputField = { name: 'groupBy', label: t('workbench.admission.groupKey'), type: 'json', schemaType: 'any', required: true }
    return <section class="automation-admission-settings" ref={root} tabindex={-1} aria-labelledby="automation-admission-title">
      <h2 id="automation-admission-title">{t('workbench.admission.title')}</h2>
      <p class="activation-help">{t('workbench.admission.introduction')}</p>
      <div class="schema-field" data-invalid={!!maxProblem}>
        <label class="schema-field-label" for="automation-policy-maxActive">{t('workbench.admission.maxActive')}</label>
        <AutomationLiteralField renderer={NumberLiteralEditor} fieldPath="policy.maxActive" controlId="__policy" canEdit={props.canEdit}
          inputId="automation-policy-maxActive" field={{ name: 'maxActive', label: t('workbench.admission.maxActive'), type: 'number', schemaType: 'number', required: false, min: 1, max: Number.MAX_SAFE_INTEGER, step: 1 }}
          invalid={!!maxProblem} {...(maxProblem ? { describedBy: 'automation-policy-maxActive-problem' } : {})}
          {...(policy?.maxActive !== undefined ? { value: policy.maxActive } : {})}
          onCommit={value => {
            const { maxActive: _maxActive, ...rest } = props.source.policy ?? {}
            update(typeof value === 'number' ? { ...rest, maxActive: value } : rest)
          }} />
        <p class="inspector-field-help">{t('workbench.admission.maxActiveHelp')}</p>
        {maxProblem ? <p id="automation-policy-maxActive-problem" class="inspector-field-error">{diagnosticText(maxProblem)}</p> : null}
      </div>
      <div class="schema-field" data-admission-overflow data-invalid={!!overflowProblem}>
        <span class="schema-field-label" id="automation-policy-overflow-label">{t('workbench.admission.overflow')}</span>
        <SelectMenu ariaLabel={t('workbench.admission.overflow')} aria-labelledby="automation-policy-overflow-label" disabled={!props.canEdit}
          value={policy?.overflow ?? 'queue'} options={(['queue', 'drop', 'replace'] as const).map(value => ({ value, label: t(`workbench.admission.${value}`) }))}
          onChange={value => changeStructure(() => update({ ...props.source.policy, overflow: value as 'queue' | 'drop' | 'replace' }))} />
        <p class="inspector-field-help">{t(`workbench.admission.${policy?.overflow ?? 'queue'}Help`)}</p>
        {policy?.maxActive === undefined ? <p class="inspector-field-help">{t('workbench.admission.limitRequired')}</p> : null}
        {overflowProblem ? <p class="inspector-field-error">{diagnosticText(overflowProblem)}</p> : null}
      </div>
      <div class="automation-admission-group">
        <h3>{t('workbench.admission.grouping')}</h3>
        <p class="inspector-field-help">{t(policy?.groupBy ? 'workbench.admission.groupHelp' : 'workbench.admission.noGroupHelp')}</p>
        {policy?.groupBy ? <>
          <ValueExpressionField nodeId="__policy" field={groupField} expression={policy.groupBy} canEdit={props.canEdit}
            referenceHelp={t('workbench.admission.referenceHelp')}
            variables={admissionGroupVariables(props.source, props.variableCatalog ?? { definitions: [] }, groupField)}
            {...(props.schemaUI ? { schemaUI: props.schemaUI } : {})} {...(groupProblem ? { problem: groupProblem } : {})}
            {...(props.focusFieldPath?.startsWith('policy.groupBy') && props.focusRequest !== undefined ? { focusRequest: props.focusRequest } : {})}
            onChange={groupBy => { if (groupBy) update({ ...props.source.policy, groupBy }) }} />
          <Button variant="secondary" disabled={!props.canEdit} onClick={() => changeStructure(() => {
            const { groupBy: _groupBy, ...rest } = props.source.policy ?? {}
            update(rest)
          })} type="button">{t('workbench.admission.removeGrouping')}</Button>
        </> : <Button variant="secondary" disabled={!props.canEdit} onClick={() => changeStructure(() => update({ ...props.source.policy, groupBy: { type: 'literal', value: null } }))} type="button">{t('workbench.admission.addGrouping')}</Button>}
      </div>
      <p class="activation-help">{t('workbench.admission.lifecycleHelp')}</p>
      {problems.filter(problem => ![maxProblem, overflowProblem, groupProblem].includes(problem)).map((problem, index) => <p class="inspector-field-error" key={index}>{diagnosticText(problem)}</p>)}
    </section>
  }
})
