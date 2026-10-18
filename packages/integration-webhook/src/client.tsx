import type { Context } from 'cordis'
import type {} from '@numenjs/webui'
import { Button, FormSection, Input } from '@numenjs/components'
import { defineComponent, ref, watch, type PropType } from 'vue'
import { triggerDetailsSlot, type TriggerDetailsContribution, type TriggerDetailsProps } from '@numenjs/workbench/trigger-details'
import { useWorkbenchI18n } from '@numenjs/workbench/i18n'
import { webhookPath } from './path.js'

export const WebhookDetails = defineComponent({
  name: 'WebhookDetails',
  props: {
    automationId: { type: String, required: true },
    trigger: { type: Object as PropType<TriggerDetailsProps['trigger']>, required: true },
  },
  setup(props) {
    const language = useWorkbenchI18n()
    const copied = ref(false)
    const failed = ref(false)
    watch(() => [props.automationId, props.trigger.id], () => { copied.value = false; failed.value = false })
    return () => {
      const zh = language.locale.value === 'zh-CN'
      const path = webhookPath(props.automationId, props.trigger.id)
      return <FormSection title={zh ? 'Webhook 入口' : 'Webhook endpoint'}>
        <label style={{ gridTemplateColumns: 'minmax(0, 1fr)', gap: '6px' }}><span>{zh ? '请求路径' : 'Request path'}</span><Input aria-label={zh ? 'Webhook 请求路径' : 'Webhook request path'} readonly value={path} /></label>
        <p class="inspector-field-help" style={{ margin: 0 }}>{zh ? 'POST JSON 到此路径。发布并启用流程后生效，结果在运行记录中查看。' : 'POST JSON to this path after publishing and enabling the workflow. Inspect results in Runs.'}</p>
        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
        <Button type="button" onClick={async () => {
          copied.value = false; failed.value = false
          try { await navigator.clipboard.writeText(path); copied.value = true } catch { failed.value = true }
        }}>{zh ? '复制路径' : 'Copy path'}</Button>
        <span role="status" style={{ fontSize: '11px' }}>{copied.value ? (zh ? '已复制' : 'Copied') : failed.value ? (zh ? '无法访问剪贴板，请选择上方路径复制。' : 'Clipboard unavailable. Select and copy the path above.') : ''}</span>
        </div>
      </FormSection>
    }
  },
})

export default function webhookFrontend(ctx: Context): void {
  ctx.webuiExtensions.contribute<TriggerDetailsContribution>(ctx, {
    id: 'webhook:endpoint-details', slot: triggerDetailsSlot,
    content: { capability: { id: 'webhook:receive', version: 1 }, component: WebhookDetails },
  })
}
webhookFrontend.inject = ['webuiExtensions']
