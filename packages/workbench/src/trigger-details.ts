import type { CapabilityRef, TriggerSource } from '@numenjs/core'
import type { BrowserExtensionRegistry } from '@numenjs/webui/extensions'
import { h, inject, provide, shallowRef, watchEffect, type Component, type InjectionKey, type Ref } from 'vue'
import { defineSetupComponent } from './vue-component.js'

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
  const contributions = inject(registryKey, shallowRef<TriggerDetailsContribution[]>([]))
  return () => contributions.value.filter(item => item.capability.id === props.trigger.capability.id
    && item.capability.version === props.trigger.capability.version).map(item => h(item.component, props))
})
