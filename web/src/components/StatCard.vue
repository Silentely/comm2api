<script setup>
import { computed } from 'vue'

const props = defineProps({
  value: { type: [String, Number], default: '-' },
  label: { type: String, default: '' },
  tone: { type: String, default: 'blue' },
  sub: { type: String, default: '' },
  hint: { type: String, default: '' },
})

const isCompact = computed(() => String(props.value ?? '').length >= 11)
</script>

<template>
  <div class="card">
    <div class="num" :class="[tone, { 'num-compact': isCompact }]" :title="hint || String(value)">{{ value }}</div>
    <div class="label">{{ label }}</div>
    <div v-if="sub" class="sub" :title="sub">{{ sub }}</div>
  </div>
</template>
