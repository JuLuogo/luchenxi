<script setup lang="ts">
/**
 * ECharts 薄封装：option 变了就 setOption，容器尺寸变了就 resize，卸载时 dispose。
 * echarts 在本组件内动态 import —— 只有打开用到图表的页面才会加载（学情分析 / 排行榜），
 * 不影响教师端首包体积。
 */
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import type { ECharts, EChartsOption } from 'echarts';

interface Props {
  /** ECharts 配置项（结构由调用方决定，这里不强约束） */
  option: EChartsOption;
  height?: string;
}

const props = withDefaults(defineProps<Props>(), { height: '320px' });

const box = ref<HTMLElement | null>(null);
const chart = shallowRef<ECharts | null>(null);
let echarts: typeof import('echarts') | null = null;
let ro: ResizeObserver | null = null;

async function ensure(): Promise<ECharts | null> {
  if (!echarts) echarts = await import('echarts');
  if (!chart.value && box.value) chart.value = echarts.init(box.value, null, { renderer: 'canvas' });
  return chart.value;
}

onMounted(async () => {
  await ensure();
  if (!chart.value) return;
  chart.value.setOption(props.option, true);
  if (window.ResizeObserver) {
    ro = new ResizeObserver(() => {
      if (chart.value) chart.value.resize();
    });
    if (box.value) ro.observe(box.value);
  }
});

watch(
  () => props.option,
  async (opt) => {
    const c = await ensure();
    if (c) c.setOption(opt, true);
  },
  { deep: true }
);

onBeforeUnmount(() => {
  if (ro) {
    ro.disconnect();
    ro = null;
  }
  if (chart.value) {
    chart.value.dispose();
    chart.value = null;
  }
});
</script>

<template>
  <div ref="box" class="chart" :style="{ height }" />
</template>

<style scoped>
.chart { width: 100%; }
</style>
