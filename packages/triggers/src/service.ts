import { withLogContext } from '@numenjs/logging'
import '@numenjs/automation'
import '@numenjs/connections'
import {
  capabilityKey,
  isNumenValue,
  isResourceRef,
  type CapabilityDefinition,
  type TriggerBinding,
  type TriggerEmission,
  type TriggerProvider,
} from '@numenjs/core'
import '@numenjs/scheduler'
import { Service, type Context } from 'cordis'

export interface TriggerServiceHealth {
  ready: boolean
  desiredSubscriptions: number
  /** Live subscriptions, including providers retrying after a reported ERROR. */
  activeSubscriptions: number
  /** Missing or failed activations plus live subscriptions reporting ERROR. */
  unavailableSubscriptions: number
}

export interface AutomationTriggerHealth {
  status: 'DISABLED' | 'NO_REVISION' | 'NO_TRIGGERS' | 'UNAVAILABLE' | 'WAITING' | 'READY'
  activationGeneration: number
  revisionId?: string
  expected: number
  /** Only live subscriptions currently reporting READY. */
  active: number
}

interface DesiredSubscription {
  key: string
  binding: TriggerBinding
  definition: CapabilityDefinition
  provider?: TriggerProvider
}

interface ActiveSubscription extends DesiredSubscription {
  provider: TriggerProvider
  controller: AbortController
  status: 'READY' | 'ERROR'
  dispose?: () => void
}

declare module 'cordis' {
  interface Context {
    triggers: TriggerService
  }
  interface Events {
    'numen/trigger-runtime-change'(): void
  }
}

function subscriptionKey(automationId: string, triggerId: string): string {
  return `${automationId}:${triggerId}`
}

export class TriggerService extends Service {
  static inject = ['automations', 'capabilities', 'connections', 'scheduler']

  private ready = false
  private desiredSubscriptions = 0
  private unavailableSubscriptions = 0
  private readonly active = new Map<string, ActiveSubscription>()
  private readonly invalidatedConnections = new Set<string>()
  private flushing = false
  private reconcilePending = false
  private notificationPending = false

  constructor(ctx: Context) {
    super(ctx, 'triggers')
  }

  async *[Service.init]() {
    this.ctx.on('numen/automation-change', () => this.reconcile())
    this.ctx.on('numen/capability-change', () => this.reconcile())
    this.ctx.on('numen/connection-runtime-change', connectionId => {
      this.invalidatedConnections.add(connectionId)
      this.reconcile()
    })
    this.ready = true
    this.reconcile()
    yield () => {
      this.ready = false
      const subscriptions = [...this.active.values()]
      this.active.clear()
      for (const subscription of subscriptions) this.disposeSubscription(subscription)
      this.reconcilePending = this.notificationPending = false
      this.invalidatedConnections.clear()
      this.ctx.emit('numen/trigger-runtime-change')
    }
  }

  health(): TriggerServiceHealth {
    return {
      ready: this.ready,
      desiredSubscriptions: this.desiredSubscriptions,
      activeSubscriptions: this.active.size,
      unavailableSubscriptions: this.unavailableSubscriptions
        + [...this.active.values()].filter(subscription => subscription.status === 'ERROR').length,
    }
  }

  automationHealth(automationId: string): AutomationTriggerHealth | undefined {
    const automation = this.ctx.automations.get(automationId)
    if (!automation) return
    const revision = automation.activeRevisionId ? this.ctx.automations.getRevision(automation.activeRevisionId) : undefined
    const enabled = automation.enabled && !automation.archivedAt
    const expected = enabled ? revision?.source.triggers.length ?? 0 : 0
    const active = [...this.active.values()].filter(subscription =>
      subscription.binding.automationId === automationId
      && subscription.binding.activationGeneration === automation.activationGeneration
      && subscription.binding.revisionId === automation.activeRevisionId
      && subscription.status === 'READY'
      && !subscription.controller.signal.aborted).length
    const status = !enabled ? 'DISABLED' : !automation.activeRevisionId ? 'NO_REVISION'
      : !this.ready || !revision ? 'UNAVAILABLE' : !expected ? 'NO_TRIGGERS' : active === expected ? 'READY' : 'WAITING'
    return { status, expected, active, activationGeneration: automation.activationGeneration,
      ...(automation.activeRevisionId ? { revisionId: automation.activeRevisionId } : {}) }
  }

  reconcile(): void {
    if (!this.ready) return
    this.reconcilePending = true
    this.flush()
  }

  private notifyRuntimeChange(): void {
    this.notificationPending = true
    this.flush()
  }

  private flush(): void {
    if (this.flushing) return
    this.flushing = true
    try {
      while (this.ready && (this.reconcilePending || this.notificationPending)) {
        if (this.reconcilePending) {
          this.reconcilePending = false
          this.reconcileOnce()
        }
        // Provider callbacks can change the desired generation synchronously.
        // Recompute it before notifying observers about a transient snapshot.
        if (this.reconcilePending) continue
        if (this.notificationPending) {
          this.notificationPending = false
          this.ctx.emit('numen/trigger-runtime-change')
        }
      }
    } finally {
      this.flushing = false
    }
  }

  private reconcileOnce(): void {
    const previousActive = new Map(this.active)
    const previousDesired = this.desiredSubscriptions
    const previousUnavailable = this.unavailableSubscriptions
    const desired = this.collectDesiredSubscriptions()
    const invalidatedConnections = new Set(this.invalidatedConnections)
    this.invalidatedConnections.clear()
    this.desiredSubscriptions = desired.size

    for (const [key, subscription] of this.active) {
      const next = desired.get(key)
      if (
        !next?.provider
        || next.provider !== subscription.provider
        || next.binding.revisionId !== subscription.binding.revisionId
        || next.binding.activationGeneration !== subscription.binding.activationGeneration
        || Object.values(subscription.binding.connectionIds).some(id => invalidatedConnections.has(id))
      ) {
        // Detach before abort/dispose: either can synchronously request a new
        // generation and must never see or dispose this subscription again.
        this.active.delete(key)
        this.disposeSubscription(subscription)
      }
    }

    let unavailable = 0
    for (const subscription of desired.values()) {
      if (this.reconcilePending || !this.ready) break
      if (!subscription.provider) {
        unavailable += 1
        continue
      }
      if (this.active.has(subscription.key)) continue
      try {
        const active = this.activateSubscription({
          ...subscription,
          provider: subscription.provider,
        })
        if (this.ready) this.active.set(subscription.key, active)
        else this.disposeSubscription(active)
      } catch {
        unavailable += 1
        withLogContext({ automationId: subscription.binding.automationId, triggerId: subscription.binding.triggerId }, () => {
          this.ctx.logger('triggers').error('Trigger activation failed')
        })
      }
    }
    this.unavailableSubscriptions = unavailable
    if (previousDesired !== this.desiredSubscriptions || previousUnavailable !== unavailable
      || previousActive.size !== this.active.size
      || [...this.active].some(([key, subscription]) => previousActive.get(key) !== subscription)) {
      this.notificationPending = true
    }
  }

  private collectDesiredSubscriptions(): Map<string, DesiredSubscription> {
    const desired = new Map<string, DesiredSubscription>()
    for (const automation of this.ctx.automations.list()) {
      if (automation.archivedAt || !automation.enabled || !automation.activeRevisionId) continue
      const revision = this.ctx.automations.getRevision(automation.activeRevisionId)
      if (!revision) continue
      for (const trigger of revision.source.triggers) {
        const status = this.ctx.capabilities.get(trigger.capability)
        if (!status || status.definition.kind !== 'trigger') continue
        const config = status.definition.input(trigger.config)
        if (
          !isNumenValue(config)
          || !config
          || typeof config !== 'object'
          || Array.isArray(config)
          || isResourceRef(config)
        ) continue
        const binding: TriggerBinding = {
          automationId: automation.id,
          revisionId: revision.id,
          activationGeneration: automation.activationGeneration,
          triggerId: trigger.id,
          capability: trigger.capability,
          config,
          connectionIds: trigger.connections ?? (trigger.connection ? { default: trigger.connection } : {}),
        }
        const provider = this.ctx.capabilities.resolveTriggerProvider(trigger.capability)
        desired.set(subscriptionKey(automation.id, trigger.id), {
          key: subscriptionKey(automation.id, trigger.id),
          binding,
          definition: status.definition,
          ...(provider ? { provider } : {}),
        })
      }
    }
    return desired
  }

  private activateSubscription(subscription: DesiredSubscription & { provider: TriggerProvider }): ActiveSubscription {
    const controller = new AbortController()
    const connections = this.ctx.connections.resolveRuntimes(
      subscription.binding.connectionIds,
      subscription.definition.connections ?? [],
    )
    const metadata = { automationId: subscription.binding.automationId, triggerId: subscription.binding.triggerId, traceId: subscription.binding.automationId }
    const active: ActiveSubscription = {
      ...subscription,
      provider: subscription.provider,
      controller,
      status: 'READY',
    }
    let activating = true
    try {
      const dispose = withLogContext(metadata, () => subscription.provider.activate({
        binding: subscription.binding,
        connections,
        signal: controller.signal,
        reportStatus: status => {
          if (controller.signal.aborted || (!activating && this.active.get(subscription.key) !== active)) return
          if (status !== 'READY' && status !== 'ERROR') throw new TypeError('trigger status must be READY or ERROR')
          if (active.status === status) return
          active.status = status
          // Synchronous activation reports become part of reconcile's initial
          // snapshot; later changes notify observers without replacing timers.
          if (!activating) this.notifyRuntimeChange()
        },
        emit: async (emission: TriggerEmission) => {
          if (controller.signal.aborted) return { status: 'stale' }
          const data = subscription.definition.output(emission.data)
          if (!isNumenValue(data)) {
            throw new TypeError(`${capabilityKey(subscription.binding.capability)} emitted a non-Numen value`)
          }
          const result = this.ctx.scheduler.acceptTrigger(subscription.binding, { ...emission, data })
          withLogContext({ ...metadata, ...(result.runId ? { runId: result.runId } : {}) }, () => this.ctx.logger('triggers').debug('Trigger emission %s', result.status))
          return result
        },
      }))
      if (dispose) active.dispose = dispose
    } catch (error) {
      // A failed activate() can already have started asynchronous work. Fence
      // both its health callback and emissions before a replacement is tried.
      controller.abort()
      throw error
    } finally {
      activating = false
    }
    withLogContext(metadata, () => this.ctx.logger('triggers').info('Trigger activated'))
    return active
  }

  private disposeSubscription(subscription: ActiveSubscription): void {
    if (!subscription.controller.signal.aborted) subscription.controller.abort()
    withLogContext({ automationId: subscription.binding.automationId, triggerId: subscription.binding.triggerId }, () => {
      subscription.dispose?.()
      this.ctx.logger('triggers').info('Trigger disposed')
    })
  }
}

export default TriggerService
