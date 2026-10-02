<script setup lang="ts">
/**
 * 大屏能力雷达（浅色主题）：全班 + 各队叠加对比，一眼看出哪队"基础薄弱 / 拔高强"。
 * 参考 ClassDojo 的"技能矩阵"与希沃的多维度评价：不只给分数，而是给出维度画像与文案评价。
 * echarts 动态 import —— 只有点评环节才下载图表库。
 */
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';

const props = defineProps({ ability: { type: Object, required: true } });

const box = ref<any>(null);
const chart = shallowRef<any>(null);
let echarts: any = null;

function option() {
  const axes = props.ability.axes || [];
  const series: any[] = [];
  (props.ability.teams || []).forEach((t) => {
    series.push({
      name: t.name,
      value: t.axes.map((a) => a.rate),
      areaStyle: { opacity: 0.18 },
      lineStyle: { width: 2.5 },
      itemStyle: { color: t.grade.color }
    });
  });
  if (props.ability.class) {
    series.push({
      name: '全班平均',
      value: props.ability.class.axes.map((a) => a.rate),
      areaStyle: { opacity: 0.06 },
      lineStyle: { width: 2, type: 'dashed' },
      itemStyle: { color: '#8b93a1' }
    });
  }
  return {
    backgroundColor: 'transparent',
    tooltip: { trigger: 'item' },
    legend: { bottom: 0, textStyle: { color: '#5b6472', fontSize: 14 }, data: series.map((s) => s.name) },
    radar: {
      indicator: axes.map((a) => ({ name: a.label, max: 100 })),
      radius: '64%',
      splitNumber: 4,
      axisName: { color: '#1a1d24', fontSize: 16, fontWeight: 600 },
      axisLine: { lineStyle: { color: '#e6e8ec' } },
      splitLine: { lineStyle: { color: '#e6e8ec' } },
      splitArea: { areaStyle: { color: ['#ffffff', '#fbfcfd'] } }
    },
    series: [{ type: 'radar', data: series }]
  };
}

async function ensure() {
  if (!echarts) echarts = await import('echarts');
  if (!chart.value && box.value) chart.value = echarts.init(box.value, null, { renderer: 'canvas' });
  return chart.value;
}
function resize() { if (chart.value) chart.value.resize(); }

onMounted(async () => {
  const c = await ensure();
  if (c) c.setOption(option(), true);
  window.addEventListener('resize', resize);
});
watch(() => props.ability, async () => {
  const c = await ensure();
  if (c) c.setOption(option(), true);
}, { deep: true });
onBeforeUnmount(() => {
  window.removeEventListener('resize', resize);
  if (chart.value) { chart.value.dispose(); chart.value = null; }
});
</script>

<template>
  <div class="radar-wrap">
    <div ref="box" class="radar" />
    <div class="grades">
      <div v-for="t in (ability.teams || [])" :key="t.id" class="grade-row">
        <span class="badge" :style="{ background: t.grade.color }">{{ t.grade.short }}</span>
        <span class="gname">{{ t.name }}</span>
        <span class="glabel">{{ t.grade.label }}</span>
        <span class="gscore">{{ t.overall }}</span>
      </div>
      <div v-if="ability.class" class="grade-row class-row">
        <span class="badge" :style="{ background: ability.class.grade.color }">{{ ability.class.grade.short }}</span>
        <span class="gname">全班平均</span>
        <span class="glabel">{{ ability.class.grade.label }}</span>
        <span class="gscore">{{ ability.class.overall }}</span>
      </div>
      <div v-if="ability.class" class="comment">{{ ability.class.comment }}</div>
    </div>
  </div>
</template>

<style scoped>
.radar-wrap { display: grid; grid-template-columns: 1fr 380px; gap: 22px; height: 100%; }
.radar { min-height: 380px; }
.grades { display: flex; flex-direction: column; justify-content: center; gap: 12px; }
.grade-row {
  display: flex; align-items: center; gap: 12px; font-size: 21px;
  background: #fff; border: 1px solid var(--c-line); border-radius: var(--r-md);
  padding: 10px 14px; box-shadow: var(--sh-1);
}
.class-row { background: var(--c-surface-2); }
.badge {
  width: 38px; height: 38px; border-radius: 11px; color: #fff;
  display: grid; place-items: center; font-weight: 800; font-size: 16px; flex: none;
}
.gname { font-weight: 700; }
.glabel { color: var(--c-text-2); font-size: 15px; }
.gscore { margin-left: auto; font-weight: 800; font-variant-numeric: tabular-nums; }
.comment {
  color: var(--c-text-2); font-size: 15px; line-height: 1.9; margin-top: 4px;
  background: var(--c-brand-weak); border: 1px solid #dcdcfb; border-radius: var(--r-md); padding: 12px 14px;
}
</style>
