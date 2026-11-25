/**
 * Trigger details slot contract.
 *
 * Integrations render small, optional presentation panels next to a Trigger in
 * any product shell. That contract lives here rather than in the Workbench
 * package so an integration can be installed, tested and loaded headlessly
 * without pulling the entire Workbench UI product into its dependency closure.
 *
 * Product shells provide the active locale, so a contribution can translate its
 * own copy without importing the shell's i18n module.
 */
import type { CapabilityRef, TriggerSource } from '@numenjs/core'
import { inject, provide, shallowRef, type Component, type InjectionKey, type Ref } from 'vue'

/** Stable slot identity. Keep the historical id so existing contributions still resolve. */
export const triggerDetailsSlot = { id: 'workbench:trigger-details', version: 1 } as const

export interface TriggerDetailsProps {
  automationId: string
  trigger: TriggerSource
}

/** Optional presentation only: execution never depends on this contribution. */
export interface TriggerDetailsContribution {
  capability: CapabilityRef
  component: Component<TriggerDetailsProps>
}

const localeKey = Symbol.for('numen.trigger-details.locale') as InjectionKey<Readonly<Ref<string>>>
const fallbackLocale: Readonly<Ref<string>> = shallowRef('en-US')

/** Called by a product shell so contributions can render localized copy. */
export function provideTriggerDetailsLocale(locale: Readonly<Ref<string>>): void {
  provide(localeKey, locale)
}

/** Contributions render inside a shell; outside one they fall back to the base locale. */
export function useTriggerDetailsLocale(): Readonly<Ref<string>> {
  return inject(localeKey, fallbackLocale)
}
