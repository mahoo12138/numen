import { Context } from 'cordis'
import { I18nService } from '@numenjs/i18n'
import { useTriggerDetailsLocale, type TriggerDetailsContribution } from '@numenjs/trigger-ui'
import { BrowserExtensionRegistry } from '@numenjs/webui/extensions'
import { BrowserLocaleService } from '@numenjs/webui/i18n'
import { describe, expect, it } from 'vitest'
import { defineComponent } from 'vue'
import { provideWorkbenchI18n, registerWorkbenchLocales } from '../src/i18n.js'
import { provideTriggerDetails, TriggerDetails, triggerDetailsSlot } from '../src/trigger-details.js'
import { renderToMarkup } from './render.js'

describe('Trigger details contributions', () => {
  it('renders contributions with the shell locale through the framework-neutral contract', async () => {
    const ctx = new Context()
    await ctx.plugin(I18nService)
    await ctx.plugin(BrowserLocaleService, { locale: 'zh-CN', storage: null })
    await ctx.plugin(BrowserExtensionRegistry)
    registerWorkbenchLocales(ctx)
    ctx.webuiExtensions.slot(ctx, triggerDetailsSlot)
    // A contribution only knows `@numenjs/trigger-ui`, never the Workbench i18n module.
    const Panel = defineComponent({ setup() {
      const locale = useTriggerDetailsLocale()
      return () => <p>locale={locale.value}</p>
    } })
    ctx.webuiExtensions.contribute<TriggerDetailsContribution>(ctx, {
      id: 'test:details', slot: triggerDetailsSlot,
      content: { capability: { id: 'test:trigger', version: 1 }, component: Panel },
    })
    const trigger = { id: 'incoming', capability: { id: 'test:trigger', version: 1 }, config: {} }
    const other = { ...trigger, capability: { id: 'test:other', version: 1 } }
    const App = defineComponent({ setup() {
      provideTriggerDetails(() => ctx.webuiExtensions)
      provideWorkbenchI18n(() => ctx.webuiLocale)
      return () => <div>
        <TriggerDetails automationId="automation" trigger={trigger} />
        <TriggerDetails automationId="automation" trigger={other} />
      </div>
    } })
    try {
      const markup = await renderToMarkup(<App />)
      expect(markup).toContain('locale=zh-CN')
      expect(markup.match(/locale=/g)).toHaveLength(1)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('falls back to the base locale outside a product shell', async () => {
    const Panel = defineComponent({ setup() {
      const locale = useTriggerDetailsLocale()
      return () => <p>locale={locale.value}</p>
    } })
    expect(await renderToMarkup(<Panel />)).toContain('locale=en-US')
  })
})
