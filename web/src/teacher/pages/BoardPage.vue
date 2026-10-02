<script setup lang="ts">
/**
 * 数据分析 · 排行榜与导出
 * 榜单一律取 CI.analysis.ranking / teamRanking（口径与旧版一致）；
 * 危险操作集中在这里并二次确认。
 */
import { computed } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useClassStore } from '../../shared/class-store';
import { CI } from '../../shared/bridge';
import EChart from '../components/EChart.vue';

const store = useClassStore();

const ranking = computed(() => CI.analysis.ranking(store.state));
const teamRanking = computed(() => CI.analysis.teamRanking(store.state));

/** 能力评级：给榜单加"能力画像"徽章（口径来自领域层 CI.analysis.abilityBoard） */
const abilityOf = computed(() => {
  const map = new Map();
  CI.analysis.abilityBoard(store.state).students.forEach((a) => map.set(a.id, a));
  return map;
});
const teamAbilityOf = computed(() => {
  const map = new Map();
  CI.analysis.abilityBoard(store.state).teams.forEach((a) => map.set(a.id, a));
  return map;
});

// ECharts option 是第三方配置形状，逐字段标注收益低：边界处用 any
const personOption = computed<any>(() => {
  const top = ranking.value.slice(0, 12).slice().reverse();
  return {
    tooltip: { trigger: 'axis' },
    grid: { left: 80, right: 30, top: 20, bottom: 30 },
    xAxis: { type: 'value', name: '分' },
    yAxis: { type: 'category', data: top.map((r) => r.name) },
    series: [{
      type: 'bar',
      barWidth: 14,
      itemStyle: { color: '#6366f1', borderRadius: [0, 6, 6, 0] },
      label: { show: true, position: 'right' },
      data: top.map((r) => r.score)
    }]
  };
});

// ECharts option 是第三方配置形状（type 字段会被推成 string），逐字段标注收益低：边界处用 any
const teamOption = computed<any>(() => ({
  tooltip: { trigger: 'item', formatter: '{b}：{c} 分（{d}%）' },
  series: [{
    type: 'pie',
    radius: ['40%', '68%'],
    label: { formatter: '{b}\n{c} 分' },
    data: teamRanking.value.map((t) => ({ name: t.name, value: Math.max(0, t.score) }))
  }]
}));

/** 分数分布：把个人分档统计，方便看两极分化 */
// ECharts option 是第三方配置形状，逐字段标注收益低：边界处用 any
const distOption = computed<any>(() => {
  const buckets = [
    { label: '0 分', test: (v) => v <= 0 },
    { label: '1–5 分', test: (v) => v > 0 && v <= 5 },
    { label: '6–10 分', test: (v) => v > 5 && v <= 10 },
    { label: '11–20 分', test: (v) => v > 10 && v <= 20 },
    { label: '20 分以上', test: (v) => v > 20 }
  ];
  const scores = ranking.value.map((r) => r.score);
  return {
    tooltip: { trigger: 'axis' },
    grid: { left: 40, right: 20, top: 20, bottom: 30 },
    xAxis: { type: 'category', data: buckets.map((b) => b.label) },
    yAxis: { type: 'value', name: '人数' },
    series: [{
      type: 'bar',
      barWidth: 36,
      itemStyle: { color: '#0ea5e9', borderRadius: [6, 6, 0, 0] },
      label: { show: true, position: 'top' },
      data: buckets.map((b) => scores.filter(b.test).length)
    }]
  };
});

function exportJSON() {
  const data = store.exportAll();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = '课堂数据-' + new Date().toISOString().slice(0, 10) + '.json';
  a.click();
  URL.revokeObjectURL(a.href);
  ElMessage.success('已导出 JSON 备份');
}
function csv(name, text) {
  const blob = new Blob(['\ufeff' + text], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}
async function clearScores() {
  await ElMessageBox.confirm('清空全部记分（名单、题库、试卷保留）？', '清空分数', { type: 'warning' })
    .then(() => { store.resetAllScores(); ElMessage.success('已清空分数'); }).catch(() => {});
}
async function factoryReset() {
  await ElMessageBox.confirm(
    '恢复初始状态：名单、题库、试卷、分数全部清空（不可撤销）。建议先导出备份。',
    '恢复初始状态', { type: 'error', confirmButtonText: '我已备份，确认清空' }
  ).then(() => { store.factoryReset(); ElMessage.success('已恢复初始状态'); }).catch(() => {});
}
function teamNameOf(tid) {
  const t = store.teams.find((x) => x.id === tid);
  return t ? t.name : '未分组';
}
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h2>排行榜与导出</h2>
        <div class="desc">
          {{ store.students.length }} 名学生 · {{ store.teams.length }} 支队伍 ·
          记录 {{ store.state.quizzes.reduce((a, z) => a + (z.records || []).length, 0) }} 条
        </div>
      </div>
      <div class="actions">
        <el-button @click="csv('个人榜.csv', CI.analysis.classCSV(store.state, 'all'))">导出班级 CSV</el-button>
        <el-button @click="exportJSON">导出 JSON 备份</el-button>
      </div>
    </div>

    <el-row :gutter="14">
      <el-col :xs="24" :md="14">
        <div class="panel">
          <h3 class="panel-title">个人榜前 12<span class="sub">柱越长分越高</span></h3>
          <EChart :option="personOption" height="360px" />
        </div>
      </el-col>
      <el-col :xs="24" :md="10">
        <div class="panel">
          <h3 class="panel-title">队伍占比</h3>
          <EChart :option="teamOption" height="360px" />
        </div>
      </el-col>
    </el-row>

    <div class="panel">
      <h3 class="panel-title">分数分布<span class="sub">看两极分化</span></h3>
      <EChart :option="distOption" height="260px" />
    </div>

    <el-row :gutter="14">
      <el-col :xs="24" :md="12">
        <div class="panel">
          <h3 class="panel-title">个人榜</h3>
          <el-table :data="ranking" size="small" max-height="360">
            <el-table-column type="index" label="#" width="46" />
            <el-table-column prop="name" label="姓名" />
            <el-table-column label="队伍" width="110">
              <template #default="{ row }">{{ row.teamName || teamNameOf(row.teamId) }}</template>
            </el-table-column>
            <el-table-column label="积分" width="80" align="right">
              <template #default="{ row }"><span class="score-num">{{ row.score }}</span></template>
            </el-table-column>
            <el-table-column label="能力画像" width="150">
              <template #default="{ row }">
                <el-tag
                  v-if="abilityOf.get(row.sid)"
                  size="small"
                  :style="{ background: abilityOf.get(row.sid).grade.color, color: '#fff', border: 'none' }"
                >{{ abilityOf.get(row.sid).grade.short }} · {{ abilityOf.get(row.sid).grade.label }}</el-tag>
                <span v-else>—</span>
              </template>
            </el-table-column>
          </el-table>
        </div>
      </el-col>
      <el-col :xs="24" :md="12">
        <div class="panel">
          <h3 class="panel-title">队伍榜</h3>
          <el-table :data="teamRanking" size="small" max-height="360">
            <el-table-column type="index" label="#" width="46" />
            <el-table-column prop="name" label="队伍" />
            <el-table-column label="人数" width="80" align="right">
              <template #default="{ row }">{{ row.memberCount }}</template>
            </el-table-column>
            <el-table-column label="总分" width="90" align="right">
              <template #default="{ row }"><span class="score-num">{{ row.score }}</span></template>
            </el-table-column>
            <el-table-column label="人均" width="90" align="right">
              <template #default="{ row }">{{ row.avg }}</template>
            </el-table-column>
            <el-table-column label="能力画像" min-width="150">
              <template #default="{ row }">
                <el-tag
                  v-if="teamAbilityOf.get(row.teamId)"
                  size="small"
                  :style="{ background: teamAbilityOf.get(row.teamId).grade.color, color: '#fff', border: 'none' }"
                >{{ teamAbilityOf.get(row.teamId).grade.short }} · {{ teamAbilityOf.get(row.teamId).grade.label }}</el-tag>
                <span v-else>—</span>
              </template>
            </el-table-column>
          </el-table>
        </div>
      </el-col>
    </el-row>

    <div class="panel">
      <h3 class="panel-title">危险操作<span class="sub">都会二次确认</span></h3>
      <el-space wrap>
        <el-button @click="clearScores">清空分数</el-button>
        <el-button type="danger" plain @click="factoryReset">恢复初始状态</el-button>
        <el-button @click="$router.push('/settings/storage')">存储与备份</el-button>
      </el-space>
    </div>
  </div>
</template>
