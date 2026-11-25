import { triggerDetailsSlot } from './trigger-details.js'
import type { Context } from 'cordis'
import { coreWorkbenchPages } from './pages.js'
import { coreWorkbenchSchemaRenderers } from './SchemaRenderers.js'
import { registerWorkbenchLocales } from './i18n.js'

export function coreWorkbenchFrontend(ctx: Context): void {
  ctx.webuiExtensions.slot(ctx, triggerDetailsSlot)
  registerWorkbenchLocales(ctx)
  coreWorkbenchPages(ctx)
  coreWorkbenchSchemaRenderers(ctx)
}

coreWorkbenchFrontend.inject = ['webuiExtensions', 'schemaUI', 'i18n']

export default coreWorkbenchFrontend
