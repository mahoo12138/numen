import type { Context } from 'cordis'
import type {} from '@numenjs/console'
import type {} from '@numenjs/workbench/runtime'
import webhookIntegrationPlugin from './index.js'

export * from './index.js'
export { webhookPath } from './path.js'

export default function webhookPlugin(ctx: Context): void {
  webhookIntegrationPlugin(ctx)
  ctx.inject(['consoleEntries', 'workbench'], child => {
    child.consoleEntries.addEntry(child, {
      id: 'numen:webhook-details',
      prod: new URL('./client.js', import.meta.url).href,
    })
  })
}
webhookPlugin.inject = ['capabilities', 'credentials', 'connections', 'server']
