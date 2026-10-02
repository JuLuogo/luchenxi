<script setup>
/**
 * 数据分析 · 学情分析
 * 数字全部来自 CI.analysis（与旧版同一口径）；图表用 ECharts，本页懒加载。
 */
import { computed, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { useClassStore } from '../../shared/class-store';
import { CI } from '../../shared/bridge';
import EChart from '../components/EChart.vue';
import AbilityPanel from '../components/AbilityPanel.vue';

const store = useClassStore();
const scope = ref('all');                 // all | teamId
const detailSid = ref('');

const classStats = computed(() => CI.analysis.classStats(store.state, scope.value));
const ranking = computed(() => CI.analysis.ranking(store.state, scope.value));

const scopeName = computed(() => (scope.value === 'all'
  ? '全班'
  : ((store.teams.find((t) => t.id === scope.value) || {}).name || '该队伍')));

/** 题型掌握：按题型统计 答对 / 半对 / 答错 / 跳过（口径来自 CI.analysis.classStats.tiers） */
const tierRows = computed(() => store.tiers.map((t) => {
  const b = (classStats.value.tiers || []).find((x) => x.key === t.key) || {};
  const attempts = b.attempts || 0;
  const correct = b.correct || 0;
  return {
    key: t.key,
    label: t.label,
    color: t.color,
    weight: t.weight,
    attempts,
    correct,
    half: b.half || 0,
    wrong: b.wrong || 0,
    skip: b.skip || 0,
    earned: b.earned || 0,
    rate: attempts ? Math.round((correct / attempts) * 100) : 0
  };
}));

const barOption = computed(() => ({
  tooltip: { trigger: 'axis' },
  legend: { data: ['答对', '半对', '答错', '跳过'] },
  grid: { left: 40, right: 20, top: 40, bottom: 30 },
  xAxis: { type: 'category', data: tierRows.value.map((t) => t.label) },
  yAxis: { type: 'value', name: '人次' },
  series: [
    { name: '答对', type: 'bar', stack: 'a', itemStyle: { color: '#10b981' }, data: tierRows.value.map((t) => t.correct) },
    { name: '半对', type: 'bar', stack: 'a', itemStyle: { color: '#f59e0b' }, data: tierRows.value.map((t) => t.half) },
    { name: '答错', type: 'bar', stack: 'a', itemStyle: { color: '#ef4444' }, data: tierRows.value.map((t) => t.wrong) },
    { name: '跳过', type: 'bar', stack: 'a', itemStyle: { color: '#cbd5e1' }, data: tierRows.value.map((t) => t.skip) }
  ]
}));

const rateOption = computed(() => ({
  tooltip: { trigger: 'axis', formatter: '{b}：正确率 {c}%' },
  grid: { left: 40, right: 20, top: 20, bottom: 30 },
  xAxis: { type: 'category', data: tierRows.value.map((t) => t.label) },
  yAxis: { type: 'value', max: 100, name: '%' },
  series: [{
    type: 'bar',
    barWidth: 34,
    label: { show: true, position: 'top', formatter: '{c}%' },
    itemStyle: {
      color: (p) => (p.value >= 80 ? '#10b981' : (p.value >= 50 ? '#f59e0b' : '#ef4444')),
      borderRadius: [6, 6, 0, 0]
    },
    data: tierRows.value.map((t) => t.rate)
  }]
}));

/** 学生明细表：每人每题型的得分与正确率 */
const detail = computed(() => {
  const sid = detailSid.value || (ranking.value[0] ? ranking.value[0].sid : '');
  if (!sid) return null;
  const stats = CI.analysis.studentStats(store.state, sid);
  if (!stats) return null;
  return { sid, stats, summary: CI.analysis.summarizeStudent(store.state, sid) };
});

const overall = computed(() => {
  const t = classStats.value.total || {};
  return {
    attempts: t.attempts || 0,
    correct: t.correct || 0,
    half: t.half || 0,
    wrong: t.wrong || 0,
    skip: t.skip || 0,
    earned: t.earned || 0,
    rate: t.attempts ? Math.round((t.correct / t.attempts) * 100) : 0
  };
});

/* ---------- 小结与导出 ---------- */
const summaryText = ref('');
function genClassSummary() {
  summaryText.value = CI.analysis.summarizeClass(store.state, scope.value).join('\n');
  ElMessage.success('已生成班级小结');
}
function genStudentSummary() {
  const sid = detailSid.value || (ranking.value[0] ? ranking.value[0].sid : '');
  if (!sid) { ElMessage.warning('还没有学生数据'); return; }
  const lines = CI.analysis.summarizeStudent(store.state, sid);
  summaryText.value = Array.isArray(lines) ? lines.join('\n') : String(lines);
  ElMessage.success('已生成个人小结');
}
async function copySummary() {
  if (!summaryText.value) { ElMessage.info('先生成小结'); return; }
  try { await navigator.clipboard.writeText(summaryText.value); ElMessage.success('已复制'); }
  catch (e) { ElMessage.warning('复制失败，请手动选中'); }
}
function download(name, text) {
  const blob = new Blob(['\ufeff' + text], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}
function exportCSV(kind) {
  if (kind === 'class') download('班级学情-' + scopeName.value + '.csv', CI.analysis.classCSV(store.state, scope.value));
  else if (kind === 'student') {
    const sid = detailSid.value || (ranking.value[0] ? ranking.value[0].sid : '');
    if (!sid) { ElMessage.warning('没有学生'); return; }
    const stu = store.students.find((s) => s.id === sid);
    download('学生学情-' + (stu ? stu.name : sid) + '.csv', CI.analysis.studentCSV(store.state, sid));
  } else {
    download('题目分析.csv', CI.analysis.questionCSV(store.state, store.runtime.quizId));
  }
}

/** 某个学生在某个题型上的正确率（CI.analysis.studentStats.tiers） */
function personalRate(tierKey) {
  if (!detail.value) return 0;
  const row = (detail.value.stats.tiers || []).find((x) => x.key === tierKey);
  if (!row || !row.attempts) return 0;
  return Math.round((row.correct / row.attempts) * 100);
}
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h2>学情分析</h2>
        <div class="desc">
          当前范围：<b>{{ scopeName }}</b> · 作答 {{ overall.attempts }} 人次 · 正确率 {{ overall.rate }}% · 累计得分 {{ overall.earned }}
        </div>
      </div>
      <div class="actions">
        <el-select v-model="scope" style="width: 150px">
          <el-option label="全班" value="all" />
          <el-option v-for="t in store.teams" :key="t.id" :label="t.name" :value="t.id" />
        </el-select>
        <el-button @click="genClassSummary">生成班级小结</el-button>
        <el-button @click="genStudentSummary">生成个人小结</el-button>
        <el-dropdown>
          <el-button>导出 CSV<el-icon><ArrowDown /></el-icon></el-button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item @click="exportCSV('class')">班级维度</el-dropdown-item>
              <el-dropdown-item @click="exportCSV('student')">学生维度</el-dropdown-item>
              <el-dropdown-item @click="exportCSV('question')">题目维度</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </div>
    </div>

    <!-- 能力评价：按题型雷达 + 综合评级 + 文字评价（个人 / 队伍 / 全班） -->
    <AbilityPanel />

    <el-row :gutter="14">
      <el-col :xs="24" :md="12">
        <div class="panel">
          <h3 class="panel-title">各题型作答分布<span class="sub">人次</span></h3>
          <EChart :option="barOption" height="300px" />
        </div>
      </el-col>
      <el-col :xs="24" :md="12">
        <div class="panel">
          <h3 class="panel-title">各题型正确率<span class="sub">≥80% 绿 · ≥50% 黄 · 其余红</span></h3>
          <EChart :option="rateOption" height="300px" />
        </div>
      </el-col>
    </el-row>

    <div class="panel">
      <h3 class="panel-title">题型明细<span class="sub">按题型查看整体掌握情况</span></h3>
      <el-table :data="tierRows" size="small">
        <el-table-column label="题型" min-width="130">
          <template #default="{ row }">
            <span class="tier-dot" :style="{ background: row.color }" />{{ row.label }}
          </template>
        </el-table-column>
        <el-table-column label="权重" width="70" align="right">
          <template #default="{ row }">{{ row.weight }}</template>
        </el-table-column>
        <el-table-column label="作答" width="70" align="right">
          <template #default="{ row }">{{ row.attempts }}</template>
        </el-table-column>
        <el-table-column label="答对" width="70" align="right">
          <template #default="{ row }">{{ row.correct }}</template>
        </el-table-column>
        <el-table-column label="半对" width="70" align="right">
          <template #default="{ row }">{{ row.half }}</template>
        </el-table-column>
        <el-table-column label="答错" width="70" align="right">
          <template #default="{ row }">{{ row.wrong }}</template>
        </el-table-column>
        <el-table-column label="正确率" width="120">
          <template #default="{ row }">
            <el-progress :percentage="row.rate" :stroke-width="10" />
          </template>
        </el-table-column>
        <el-table-column label="累计得分" width="100" align="right">
          <template #default="{ row }"><span class="score-num">{{ row.earned }}</span></template>
        </el-table-column>
      </el-table>
    </div>

    <el-row :gutter="14">
      <el-col :xs="24" :md="14">
        <div class="panel">
          <h3 class="panel-title">学生明细<span class="sub">点某一行看个人报告</span></h3>
          <el-table
            :data="ranking"
            size="small"
            max-height="360"
            highlight-current-row
            @current-change="(row) => (detailSid = row ? row.sid : '')"
          >
            <el-table-column type="index" width="46" label="#" />
            <el-table-column prop="name" label="姓名" min-width="110" />
            <el-table-column prop="teamName" label="队伍" width="110" />
            <el-table-column label="积分" width="80" align="right">
              <template #default="{ row }"><span class="score-num">{{ row.score }}</span></template>
            </el-table-column>
            <el-table-column label="作答/答对" width="110" align="right">
              <template #default="{ row }">{{ row.attempts }} / {{ row.correct }}</template>
            </el-table-column>
            <el-table-column label="综合评定" width="120">
              <template #default="{ row }">
                <el-tag size="small" effect="plain">{{ row.level && row.level.label }}</el-tag>
              </template>
            </el-table-column>
          </el-table>
        </div>
      </el-col>

      <el-col :xs="24" :md="10">
        <div class="panel">
          <h3 class="panel-title">个人报告<span class="sub">{{ detail ? detail.stats.name : '（选一名学生）' }}</span></h3>
          <template v-if="detail">
            <el-descriptions :column="2" border size="small">
              <el-descriptions-item label="积分">{{ detail.stats.score }}</el-descriptions-item>
              <el-descriptions-item label="队伍">{{ detail.stats.teamName }}</el-descriptions-item>
              <el-descriptions-item label="作答">{{ detail.stats.total.attempts }}</el-descriptions-item>
              <el-descriptions-item label="正确率">
                {{ detail.stats.total.attempts ? Math.round((detail.stats.total.correct / detail.stats.total.attempts) * 100) : 0 }}%
              </el-descriptions-item>
            </el-descriptions>
            <div class="tier-mini">
              <div v-for="t in store.tiers" :key="t.key" class="tm-row">
                <span class="tm-label"><span class="tier-dot" :style="{ background: t.color }" />{{ t.label }}</span>
                <el-progress :percentage="personalRate(t.key)" :stroke-width="8" />
              </div>
            </div>
          </template>
          <div v-else class="empty-hint">在左侧点一名学生</div>
        </div>
      </el-col>
    </el-row>

    <div class="panel">
      <h3 class="panel-title">
        课堂小结
        <span class="sub">
          <el-button size="small" text :disabled="!summaryText" @click="copySummary">复制</el-button>
          <el-button size="small" text :disabled="!summaryText" @click="download('课堂小结.txt', summaryText)">下载</el-button>
        </span>
      </h3>
      <el-input v-model="summaryText" type="textarea" :rows="10" placeholder="点上方「生成班级小结」或「生成个人小结」，结果会出现在这里，可直接复制发到班级群" />
    </div>
  </div>
</template>

<style scoped>
.tier-mini { margin-top: 14px; }
.tm-row { display: grid; grid-template-columns: 96px 1fr; align-items: center; gap: 10px; margin-bottom: 8px; font-size: 12px; }
.tm-label { color: var(--ci-text-weak); }
</style>
