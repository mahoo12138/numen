import type { BrowserExtensionRegistry } from '@numenjs/webui/extensions'
import {
  provideTriggerDetailsLocale,
  triggerDetailsSlot,
  type TriggerDetailsContribution,
  type TriggerDetailsProps,
} from '@numenjs/trigger-ui'
import { h, inject, provide, shallowRef, watchEffect, type InjectionKey, type Ref } from 'vue'
import { useWorkbenchI18n } from './i18n.js'
import { defineSetupComponent } from './vue-component.js'

// The slot contract lives in `@numenjs/trigger-ui` so integrations do not
// depend on the Workbench product. Re-export it to keep the historical
// `@numenjs/workbench/trigger-details` import path working for existing plugins.
export { triggerDetailsSlot, type TriggerDetailsContribution, type TriggerDetailsProps }

const registryKey = Symbol.for('numen.workbench.trigger-details') as InjectionKey<Ref<TriggerDetailsContribution[]>>

export function provideTriggerDetails(getRegistry: () => BrowserExtensionRegistry | undefined): void {
  const contributions = shallowRef<TriggerDetailsContribution[]>([])
  watchEffect(onCleanup => {
    const registry = getRegistry()
    const refresh = () => {
      contributions.value = registry?.listContributions<TriggerDetailsContribution>(triggerDetailsSlot).map(item => item.content) ?? []
    }
    if (registry) onCleanup(registry.subscribe(refresh))
    refresh()
  })
  provide(registryKey, contributions)
}

export const TriggerDetails = defineSetupComponent<TriggerDetailsProps>('TriggerDetails', ['automationId', 'trigger'], props => {
  // Contributions translate their own copy; the shell only supplies the locale.
  provideTriggerDetailsLocale(useWorkbenchI18n().locale)
  const contributions = inject(registryKey, shallowRef<TriggerDetailsContribution[]>([]))
  return () => contributions.value.filter(item => item.capability.id === props.trigger.capability.id
    && item.capability.version === props.trigger.capability.version).map(item => h(item.component, props))
})
