<script setup>
/**
 * ECharts 薄封装：option 变了就 setOption，容器尺寸变了就 resize，卸载时 dispose。
 * echarts 在本组件内动态 import —— 只有打开用到图表的页面才会加载（学情分析 / 排行榜），
 * 不影响教师端首包体积。
 */
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';

const props = defineProps({
  option: { type: Object, required: true },
  height: { type: String, default: '320px' }
});

const box = ref(null);
const chart = shallowRef(null);
let echarts = null;
let ro = null;

async function ensure() {
  if (!echarts) echarts = await import('echarts');
  if (!chart.value && box.value) chart.value = echarts.init(box.value, null, { renderer: 'canvas' });
  return chart.value;
}

onMounted(async () => {
  await ensure();
  if (!chart.value) return;
  chart.value.setOption(props.option, true);
  if (window.ResizeObserver) {
    ro = new ResizeObserver(() => { if (chart.value) chart.value.resize(); });
    ro.observe(box.value);
  }
});

watch(() => props.option, async (opt) => {
  const c = await ensure();
  if (c) c.setOption(opt, true);
}, { deep: true });

onBeforeUnmount(() => {
  if (ro) { ro.disconnect(); ro = null; }
  if (chart.value) { chart.value.dispose(); chart.value = null; }
});
</script>

<template>
  <div ref="box" class="chart" :style="{ height }" />
</template>

<style scoped>
.chart { width: 100%; }
</style>
