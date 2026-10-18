<script setup lang="ts">
withDefaults(defineProps<{ name?: string; size?: number }>(), { name: 'arrow', size: 20 })
const paths: Record<string, string> = {
  arrow: 'M5 12h14m-6-6 6 6-6 6',
  event: 'M13 2 4 14h7l-1 8 10-13h-7l1-7',
  data: 'M8 3H6v6l-3 3 3 3v6h2m8-18h2v6l3 3-3 3v6h-2',
  clock: 'M12 8v4l3 2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
  mail: 'M3 6h18v12H3V6Zm0 1 9 6 9-6',
  grid: 'M3 4h18v16H3V4Zm0 5h18M8 4v16m7-16v16',
  link: 'm10 14 4-4m-6 6-2 2a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m2 1 2-2a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0',
  signal: 'M12 20h.01M8 16a6 6 0 0 1 8 0M4 12a12 12 0 0 1 16 0M1 8a17 17 0 0 1 22 0',
  terminal: 'm5 7 5 5-5 5m8 0h6M3 3h18v18H3V3Z',
  layers: 'm12 2 10 5-10 5L2 7l10-5ZM2 12l10 5 10-5M2 17l10 5 10-5',
  check: 'm5 12 4 4L19 6',
  copy: 'M8 8h12v12H8V8ZM4 16H3V3h13v1',
}
</script>

<template>
  <svg :width="size" :height="size" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="paths[name] ?? paths.arrow" /></svg>
</template>
