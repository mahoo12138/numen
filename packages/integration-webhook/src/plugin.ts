import type { Context } from 'cordis'
import type {} from '@numenjs/console'
import webhookIntegrationPlugin from './index.js'

export * from './index.js'
export { webhookPath } from './path.js'

export default function webhookPlugin(ctx: Context): void {
  webhookIntegrationPlugin(ctx)
  // The browser bundle imports the shared runtime served by Workbench and
  // contributes to a slot Workbench registers, so it waits for the service by
  // name. Only the runtime dependency remains; there is no package dependency.
  ctx.inject(['consoleEntries', 'workbench'], child => {
    child.consoleEntries.addEntry(child, {
      id: 'numen:webhook-details',
      prod: new URL('./client.js', import.meta.url).href,
    })
  })
}
webhookPlugin.inject = ['capabilities', 'credentials', 'connections', 'server']
