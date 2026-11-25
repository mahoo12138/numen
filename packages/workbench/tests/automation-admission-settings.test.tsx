import { describe, expect, it, vi } from 'vitest'
import type { AutomationSource } from '@numenjs/core'
import { AutomationAdmissionSettings, admissionGroupVariables, isAutomationPolicyProblem } from '../src/AutomationAdmissionSettings.js'
import type { WorkbenchAutomationInputField, WorkbenchAutomationVariableCatalog } from '../src/contracts.js'
import { renderToMarkup } from './render.js'

const source: AutomationSource = {
  inputs: { customerId: { type: 'string', required: true }, number: { type: 'number' } },
  triggers: [{ id: 'message', capability: { id: 'test:message', version: 1 }, config: {} }],
  flow: { type: 'graph', version: 1, id: 'flow', nodes: [{ type: 'capability', id: 'step', capability: { id: 'test:output', version: 1 }, input: {} }], edges: [] },
}
const catalog: WorkbenchAutomationVariableCatalog = { definitions: [
  { capability: { id: 'test:message', version: 1 }, capabilityKind: 'trigger', title: 'Message', outputFields: [{ path: ['customer'], label: 'Customer', valueType: 'string' }], outputSchemaSupported: true },
  { capability: { id: 'test:output', version: 1 }, capabilityKind: 'query', title: 'Output', outputFields: [{ path: ['value'], label: 'Value', valueType: 'string' }], outputSchemaSupported: true },
] }
const field: WorkbenchAutomationInputField = { name: 'groupBy', label: 'Group key', required: true, type: 'json', schemaType: 'any' }

describe('Automation admission settings', () => {
  it('offers only input and trigger variables with their original scalar types', () => {
    const variables = admissionGroupVariables(source, catalog, field)
    expect(variables.map(item => item.path)).toEqual(['input.customerId', 'input.number', 'trigger.customer'])
    expect(variables.find(item => item.path === 'input.number')).toMatchObject({ valueType: 'number', compatibility: 'direct' })
    expect(variables.every(item => !item.path.startsWith('run.') && !item.path.startsWith('steps.'))).toBe(true)
  })

  it('renders unlimited defaults and explains publication and test isolation', async () => {
    const markup = await renderToMarkup(<AutomationAdmissionSettings source={source} canEdit problems={[]} onChange={vi.fn()} />)
    expect(markup).toContain('Maximum active runs')
    expect(markup).toContain('Leave empty for no limit')
    expect(markup).toContain('Queue')
    expect(markup).toContain('This choice takes effect when a maximum is set')
    expect(markup).toContain('Add grouping')
    expect(markup).toContain('Test runs are isolated from production runs')
  })

  it('keeps a group independent of a limit and renders nested group errors alongside read-only controls', async () => {
    const markup = await renderToMarkup(<AutomationAdmissionSettings source={{ ...source, policy: { groupBy: { type: 'ref', path: 'run.id' } } }} canEdit={false}
      problems={[{ severity: 'error', code: 'POLICY_GROUP_BY_REFERENCE_INVALID', message: 'Only trigger and input are available.', source: { nodeId: '__policy', fieldPath: 'policy.groupBy.arguments.0' } }]} onChange={vi.fn()} />)
    expect(markup).toContain('Only trigger and input are available.')
    expect(markup).toContain('value="run.id"')
    expect(markup).toContain('trigger.body.customerId or input.customerId')
    expect(markup).not.toContain('steps.fetch.output')
    expect(markup).toContain('Remove grouping')
    expect(markup).toMatch(/<input[^>]*id="automation-policy-maxActive"[^>]*disabled|<input[^>]*disabled[^>]*id="automation-policy-maxActive"/)
  })

  it('routes source-level policy diagnostics without capturing node invocation policy diagnostics', () => {
    expect(isAutomationPolicyProblem({ fieldPath: 'policy.maxActive' })).toBe(true)
    expect(isAutomationPolicyProblem({ fieldPath: 'policy' })).toBe(true)
    expect(isAutomationPolicyProblem({ nodeId: '__policy', fieldPath: 'policy.groupBy.arguments.0' })).toBe(true)
    expect(isAutomationPolicyProblem({ nodeId: 'step', fieldPath: 'policy.timeoutMs' })).toBe(false)
    expect(isAutomationPolicyProblem({ nodeId: '__inputs', fieldPath: 'inputs.customer' })).toBe(false)
  })

  it('keeps the admission reference scope and help in nested grouping expressions', async () => {
    const markup = await renderToMarkup(<AutomationAdmissionSettings source={{ ...source, policy: { groupBy: { type: 'object', entries: {
      customer: { type: 'ref', path: 'input.customerId' },
      formatted: { type: 'call', function: 'core:to-string', arguments: [{ type: 'ref', path: 'input.number' }] },
    } } } }} canEdit problems={[]} variableCatalog={catalog} onChange={vi.fn()} />)
    expect(markup).toContain('input.customerId')
    expect(markup).toContain('input.number')
    expect(markup).not.toContain('steps.fetch.output')
  })
})
