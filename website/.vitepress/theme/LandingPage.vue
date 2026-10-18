<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue'
import { withBase } from 'vitepress'
import SiteIcon from './SiteIcon.vue'

const examples = [
  { name: 'Webhook 数据整理', label: 'incoming-event', link: '/integrations/webhook', nodes: [
    { title: '接收外部事件', icon: 'event', role: 'TRIGGER', capability: 'webhook:receive', detail: '请求持久化为事件和 Run 后响应，再交给下游处理。', output: { body: { date: '2024-01-31T12:00:00Z', customer: 'Alice' }, receivedAt: '2024-01-31T12:00:01Z' } },
    { title: '整理需要的字段', icon: 'data', role: 'QUERY', capability: 'data:object-merge', detail: '将输入对象与指定字段浅合并，保留原始输入。', output: { value: { date: '2024-01-31T12:00:00Z', customer: 'Alice', source: 'webhook' } } },
    { title: '计算下个月的日期', icon: 'clock', role: 'QUERY', capability: 'datetime:add', detail: '按指定时区执行日历运算：1 月 31 日加一个月，收敛到闰年 2 月的最后一天。', output: { iso: '2024-02-29T12:00:00.000Z', epochMs: 1709208000000, timezone: 'UTC' } },
    { title: '生成 JSON 文本', icon: 'terminal', role: 'QUERY', capability: 'data:json-stringify', detail: '把整理后的事件和计算的日期组合为对象，再序列化为 JSON 文本。', output: { text: JSON.stringify({ event: { date: '2024-01-31T12:00:00Z', customer: 'Alice', source: 'webhook' }, dueAt: '2024-02-29T12:00:00.000Z' }) } },
  ] },
  { name: 'MQTT 告警通知', label: 'message-report', link: '/integrations/messaging', nodes: [
    { title: '收到设备消息', icon: 'signal', role: 'TRIGGER', capability: 'mqtt:message', detail: '通过 MQTT 长连接订阅主题，将消息交给自动化流程。', output: { topic: 'numen/reports/demo', payload: { id: 'device-report-001', rows: [{ device: 'sensor-a', value: 21 }, { device: 'sensor-a', value: 21 }, { device: 'sensor-b', value: 18 }] } } },
    { title: '去除重复设备', icon: 'data', role: 'QUERY', capability: 'data:array-unique', detail: '按 device 字段去重，保留每台设备首次出现的数据。', output: { items: [{ device: 'sensor-a', value: 21 }, { device: 'sensor-b', value: 18 }] } },
    { title: '整理为 CSV 报告', icon: 'grid', role: 'QUERY', capability: 'csv:stringify', detail: '将去重后的数据行转换为 CSV 文本，作为邮件正文。', output: { text: 'device,value\nsensor-a,21\nsensor-b,18\n' } },
    { title: '通过邮件通知', icon: 'mail', role: 'ACTION', capability: 'smtp:send', detail: '使用已配置的 SMTP 连接发送邮件，并记录执行结果。', output: { accepted: ['operator@example.com'], rejected: [] } },
  ] },
]
const selectedExample = ref(0)
const selectedNode = ref(0)
const example = computed(() => examples[selectedExample.value]!)
const node = computed(() => example.value.nodes[selectedNode.value]!)
const output = computed(() => JSON.stringify(node.value.output, null, 2).replace(/\n\s*/g, ' '))
function selectExample(index: number) { selectedExample.value = index; selectedNode.value = 0 }
function tabKey(event: KeyboardEvent, index: number) {
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? examples.length - 1
    : event.key === 'ArrowRight' ? (index + 1) % examples.length
    : event.key === 'ArrowLeft' ? (index + examples.length - 1) % examples.length : undefined
  if (next === undefined) return
  event.preventDefault()
  selectExample(next)
  ;(event.currentTarget as HTMLElement).parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
}
const integrations = [
  { id: 'webhook', name: 'Webhook', text: '从 HTTP 请求启动', icon: 'event', trigger: true, action: false },
  { id: 'cron', name: 'Cron', text: '按计划定时运行', icon: 'clock', trigger: true, action: false },
  { id: 'mqtt', name: 'MQTT', text: '订阅与发布消息', icon: 'signal', trigger: true, action: true },
  { id: 'http', name: 'HTTP', text: '连接外部 API', icon: 'link', trigger: false, action: true },
  { id: 'data', name: 'Data', text: 'JSON、字段与数组', icon: 'data', trigger: false, action: true },
  { id: 'datetime', name: 'Date & Time', text: '时区与日历运算', icon: 'clock', trigger: false, action: true },
  { id: 'csv', name: 'CSV', text: '结构化数据与文本', icon: 'grid', trigger: false, action: true },
  { id: 'smtp', name: 'SMTP', text: '发送邮件通知', icon: 'mail', trigger: false, action: true },
  { id: 'echo', name: 'Echo', text: '本地验证与调试', icon: 'terminal', trigger: false, action: true },
]
const filter = ref('all')
const filteredIntegrations = computed(() => integrations.filter(item => filter.value === 'all' || (filter.value === 'trigger' ? item.trigger : item.action)))
const filters = [{ id: 'all', label: '全部', count: 9 }, { id: 'trigger', label: '事件触发', count: 3 }, { id: 'action', label: '查询与动作', count: 7 }]
const command = 'pnpm install\npnpm build\npnpm dev --print-launch-url'
const copied = ref('')
let copyTimer: ReturnType<typeof setTimeout> | undefined
async function copyCommand() {
  if (copyTimer) clearTimeout(copyTimer)
  try { await navigator.clipboard.writeText(command); copied.value = '已复制' }
  catch { copied.value = '请手动选择下方命令复制' }
  copyTimer = setTimeout(() => { copied.value = '' }, 3000)
}
onUnmounted(() => { if (copyTimer) clearTimeout(copyTimer) })
</script>

<template>
  <main class="numen-home">
    <section class="home-hero home-container" aria-labelledby="home-heading">
      <div class="hero-copy">
        <div class="eyebrow"><span class="eyebrow-line"></span> AUTOMATION, ON YOUR TERMS</div>
        <h1 id="home-heading">把重复的事，<br><span>交给自己的工作流。</span></h1>
        <p class="hero-description">从一条事件开始，连接数据与行动。<br class="desktop-break">用 Numen 编排自动化，让每次运行都有迹可循。</p>
        <div class="hero-actions">
          <a class="home-button primary" :href="withBase('/guide/getting-started')">开始使用 <SiteIcon name="arrow" :size="18" /></a>
          <a class="home-button secondary" :href="withBase('/integrations/')">浏览官方集成</a>
        </div>
        <div class="hero-facts"><span>自托管</span><span>持久执行</span><span>插件优先</span></div>
        <p class="version-note"><span class="version-tag">v0.1.0</span> 持续开发中 · 从本地源码开始</p>
      </div>
      <div class="demo-shell">
        <div class="demo-tabs" role="tablist" aria-label="示例流程">
          <button v-for="(item, index) in examples" :id="'example-tab-' + index" :key="item.label" type="button" role="tab" :aria-selected="selectedExample === index" aria-controls="example-panel" :tabindex="selectedExample === index ? 0 : -1" @click="selectExample(index)" @keydown="tabKey($event, index)">{{ item.name }}</button>
        </div>
        <div id="example-panel" role="tabpanel" :aria-labelledby="'example-tab-' + selectedExample" class="workflow-demo">
          <div class="demo-caption"><span>{{ example.label }}<span class="caption-extension">.flow</span></span><span class="demo-label">交互示意</span></div>
          <ol class="workflow-nodes">
            <li v-for="(item, index) in example.nodes" :key="item.capability">
              <span class="node-number">{{ String(index + 1).padStart(2, '0') }}</span>
              <button class="workflow-node" type="button" :data-capability="item.capability" :aria-pressed="selectedNode === index" aria-controls="node-preview" @click="selectedNode = index">
                <span class="node-icon"><SiteIcon :name="item.icon" /></span>
                <span class="node-copy"><strong>{{ item.title }}</strong><code>{{ item.capability }}@1</code></span>
                <span class="node-role">{{ item.role }}</span>
              </button>
            </li>
          </ol>
          <div id="node-preview" class="node-preview" aria-live="polite" aria-atomic="true">
            <div class="preview-caption"><span>节点说明</span><span>输出节选</span></div>
            <p>{{ node.detail }}</p>
            <pre><code>{{ output }}</code></pre>
          </div>
        </div>
        <a class="demo-guide" :href="withBase(example.link)">查看完整配置步骤 <SiteIcon name="arrow" :size="16" /></a>
      </div>
    </section>

    <section class="principles home-container" aria-label="Numen 的三个基础">
      <article><span class="section-index">01 / COMPOSE</span><h2>按自己的方式编排</h2><p>可视化编辑，表达式连接字段。先测试，再将确定的版本发布为流程。</p><a :href="withBase('/guide/workflows')">了解工作流 <SiteIcon name="arrow" :size="16" /></a></article>
      <article><span class="section-index">02 / OBSERVE</span><h2>每次运行，有迹可循</h2><p>从 Run 到节点执行，查看输入、输出和失败原因。等待、排队与恢复都有记录。</p><a :href="withBase('/guide/concepts')">理解运行模型 <SiteIcon name="arrow" :size="16" /></a></article>
      <article><span class="section-index">03 / EXTEND</span><h2>需要什么，就扩展什么</h2><p>用独立 Capability 定义能力，通过 Schema 配置。连接和界面扩展沿用同一套插件机制。</p><a :href="withBase('/development/')">编写第一个插件 <SiteIcon name="arrow" :size="16" /></a></article>
    </section>

    <section class="ecosystem home-container" aria-labelledby="ecosystem-title">
      <div class="section-heading"><div><p class="eyebrow">BUILT TO CONNECT</p><h2 id="ecosystem-title">从第一条事件，<br>到下一项集成。</h2></div><p>从官方基础能力开始，<br>逐步搭起适合自己的自动化。</p></div>
      <div class="integration-toolbar"><div class="integration-filters" role="group" aria-label="筛选官方集成"><button v-for="item in filters" :key="item.id" type="button" :aria-pressed="filter === item.id" @click="filter = item.id">{{ item.label }} <span>{{ item.count }}</span></button></div><span class="integration-count" aria-live="polite">{{ filteredIntegrations.length }} 项集成</span></div>
      <div class="integration-list">
        <a v-for="item in filteredIntegrations" :key="item.id" :href="withBase('/integrations/#' + item.id)" class="integration-item"><span class="integration-icon"><SiteIcon :name="item.icon" :size="22" /></span><span><strong>{{ item.name }}</strong><small>{{ item.text }}</small></span><SiteIcon name="arrow" :size="18" /></a>
      </div>
      <p class="ecosystem-note">每项能力独立配置、独立执行。<a :href="withBase('/integrations/')">查看能力目录与使用边界 <span aria-hidden="true">→</span></a></p>
    </section>

    <section class="start-section home-container" aria-labelledby="start-title">
      <div class="start-copy"><p class="eyebrow">YOUR FIRST WORKFLOW</p><h2 id="start-title">先让第一条流程<br>跑起来。</h2><p>从不需要外部账号的 Cron → Echo 开始，<br>完成一次编排、发布和运行检查。</p><a class="home-button primary" :href="withBase('/guide/getting-started')">打开快速开始 <SiteIcon name="arrow" :size="18" /></a></div>
      <div class="start-terminal"><div class="terminal-heading"><span><SiteIcon name="terminal" :size="16" /> 在项目源码根目录运行</span><button type="button" @click="copyCommand" aria-label="复制启动命令"><SiteIcon name="copy" :size="16" /><span>复制</span></button></div><pre><code><span class="terminal-prompt">$ </span>pnpm install
<span class="terminal-prompt">$ </span>pnpm build
<span class="terminal-prompt">$ </span>pnpm dev --print-launch-url</code></pre><div class="terminal-foot"><span>Node.js 22+ · pnpm 10+</span><span class="copy-feedback" role="status">{{ copied }}</span></div></div>
    </section>
  </main>
</template>
