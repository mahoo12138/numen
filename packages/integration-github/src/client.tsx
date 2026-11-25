import type { Context } from 'cordis'
import type {} from '@numenjs/webui'
import { Button, FormSection, Input } from '@numenjs/components'
import { defineComponent, ref, watch, type PropType } from 'vue'
import { triggerDetailsSlot, useTriggerDetailsLocale, type TriggerDetailsContribution, type TriggerDetailsProps } from '@numenjs/trigger-ui'
import { githubWebhookPath } from './path.js'

export const GitHubWebhookDetails = defineComponent({
  name: 'GitHubWebhookDetails',
  props: {
    automationId: { type: String, required: true },
    trigger: { type: Object as PropType<TriggerDetailsProps['trigger']>, required: true },
  },
  setup(props) {
    const language = useTriggerDetailsLocale()
    const copied = ref(false)
    const failed = ref(false)
    watch(() => [props.automationId, props.trigger.id], () => { copied.value = false; failed.value = false })
    return () => {
      const zh = language.value === 'zh-CN'
      const path = githubWebhookPath(props.automationId, props.trigger.id)
      return <FormSection title={zh ? 'GitHub Webhook 入口' : 'GitHub webhook endpoint'}>
        <label style={{ gridTemplateColumns: 'minmax(0, 1fr)', gap: '6px' }}><span>{zh ? '请求路径' : 'Request path'}</span><Input aria-label={zh ? 'GitHub Webhook 请求路径' : 'GitHub webhook request path'} readonly value={path} /></label>
        <p class="inspector-field-help" style={{ margin: 0 }}>{zh
          ? '在 GitHub Webhook 设置中，将公网 HTTPS 地址加上此路径填入 Payload URL，选择 application/json，并将 Credential 中的 Secret 填入同名字段。发布并启用流程后生效。'
          : 'In GitHub webhook settings, append this path to your public HTTPS address for the Payload URL. Select application/json and use the same Secret as the Credential. Publish and enable the workflow to receive deliveries.'}</p>
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

export default function githubFrontend(ctx: Context): void {
  ctx.webuiExtensions.contribute<TriggerDetailsContribution>(ctx, {
    id: 'github:webhook-endpoint-details', slot: triggerDetailsSlot,
    content: { capability: { id: 'github:webhook', version: 1 }, component: GitHubWebhookDetails },
  })
}
githubFrontend.inject = ['webuiExtensions']
