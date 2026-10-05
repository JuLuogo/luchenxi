<script setup lang="ts">
import { token } from '../../styles/token-value';
/**
 * 能力评价面板：按题型画雷达 + 综合评级 + 文字评价（个人 / 队伍 / 全班）。
 *
 * 算法全在领域层 CI.analysis.ability / abilityBoard（已被 logic.test.js 覆盖），
 * 这里只负责画图与排版：
 *   · 雷达轴 = 各题型的掌握度（答对率，半对按 halfRatio 折算）
 *   · 综合分 = 掌握度 × 覆盖系数（没考过的题型不直接算 0，但要打折）
 *   · 评级 = 六边形战士 / 全面发展 / 学有余力 / 偏科尖子 / 稳步提升 / 基础待巩固 / 需要重点辅导 / 样本不足
 */
import { computed, onMounted, ref, watch, onUnmounted } from 'vue';
import { ElMessage } from 'element-plus';
import { useClassStore } from '../../shared/class-store';
import { CI } from '../../shared/bridge';
import { fetchAbilityBoard } from '../../shared/domain-api';
import EChart from './EChart.vue';

const store = useClassStore();

/** 当前查看对象：{ kind: 'class' } | { kind: 'team', id } | { kind: 'student', id } */
const target = ref({ kind: 'class', id: 'all' });

// Rust 优先（/api/domain/ability-board），拿到前先用本地实现渲染
const rustBoard = ref<any>(null);
async function loadBoard() {
  const r = await fetchAbilityBoard({ quizId: null });
  rustBoard.value = r.source === 'rust' ? r.board : null;
}
onMounted(loadBoard);
// 审计发现：原来每次记分（rev++）都发一个请求、无防抖 → 老师连点判分时持续打请求。
// 加 400ms 防抖 + 卸载时清掉；失败也由 loadBoard 内部标注来源。
let boardTimer: ReturnType<typeof setTimeout> | null = null;
watch(() => store.rev, () => {
  if (boardTimer) clearTimeout(boardTimer);
  boardTimer = setTimeout(() => { boardTimer = null; loadBoard(); }, 400);
});
onUnmounted(() => { if (boardTimer) clearTimeout(boardTimer); });
const board = computed<any>(() => rustBoard.value || CI.analysis.abilityBoard(store.state));

const current = computed(() => {
  const t = target.value;
  if (t.kind === 'student') return board.value.students.find((a) => a.id === t.id) || board.value.class;
  if (t.kind === 'team') return board.value.teams.find((a) => a.id === t.id) || board.value.class;
  return board.value.class;
});

const classAxes = computed(() => (board.value.class ? board.value.class.axes : []));

/** 雷达图：当前对象一条，全班平均一条做对比 */
// ECharts option 是第三方配置形状：边界处用 any
const radarOption = computed<any>(() => {
  const axes = classAxes.value;
  const cur = current.value;
  const series: any[] = [];
  if (cur && cur.id !== 'all') {
    series.push({
      value: cur.axes.map((a) => a.rate),
      name: cur.name,
      areaStyle: { opacity: 0.28 },
      lineStyle: { width: 3 },
      itemStyle: { color: cur.grade.color }
    });
  }
  series.push({
    value: axes.map((a) => a.rate),
    name: '全班平均',
    areaStyle: { opacity: cur && cur.id !== 'all' ? 0.06 : 0.28 },
    lineStyle: { width: cur && cur.id !== 'all' ? 1.5 : 3, type: cur && cur.id !== 'all' ? 'dashed' : 'solid' },
    itemStyle: { color: token('--c-brand-2') }
  });
  return {
    tooltip: { trigger: 'item' },
    legend: { bottom: 0, data: series.map((s) => s.name) },
    radar: {
      indicator: axes.map((a) => ({ name: a.label, max: 100 })),
      radius: '62%',
      splitNumber: 4,
      axisName: { color: token('--c-text-2'), fontSize: 12 },
      splitArea: { areaStyle: { color: [token('--c-surface'), '#f8fafc'] } }
    },
    series: [{ type: 'radar', data: series }]
  };
});

/** 综合评价表：学生 + 队伍 */
const rows = computed(() => {
  const stu = board.value.students.map((a) => ({
    kind: 'student', id: a.id, name: a.name, group: a.teamName || '',
    overall: a.overall, grade: a.grade, coverage: a.coverage, balance: a.balance,
    strongest: a.strongest, weakest: a.weakest, comment: a.comment, attempts: a.attempts
  }));
  const team = board.value.teams.map((a) => ({
    kind: 'team', id: a.id, name: a.name, group: (a.memberCount || 0) + ' 人',
    overall: a.overall, grade: a.grade, coverage: a.coverage, balance: a.balance,
    strongest: a.strongest, weakest: a.weakest, comment: a.comment, attempts: a.attempts
  }));
  return team.concat(stu);
});

function pick(row) {
  target.value = { kind: row.kind, id: row.id };
}
function pickClass() {
  target.value = { kind: 'class', id: 'all' };
}
function balanceText(v) {
  return v === null || v === undefined ? '—' : v + '%';
}
async function copyComment() {
  const c = current.value;
  if (!c) return;
  const text = '【' + c.name + ' 能力评价】综合 ' + c.overall + ' 分 · ' + c.grade.label + '\n' + c.comment;
  try { await navigator.clipboard.writeText(text); ElMessage.success('评价已复制'); }
  catch (e) { ElMessage.warning('复制失败，请手动选中'); }
}
</script>

<template>
  <div class="panel">
    <h3 class="panel-title">
      能力评价（按题型雷达）
      <span class="sub">
        <el-button size="small" :type="target.kind === 'class' ? 'primary' : ''" @click="pickClass">全班</el-button>
        <el-button
          v-for="t in board.teams"
          :key="t.id"
          size="small"
          :type="target.kind === 'team' && target.id === t.id ? 'primary' : ''"
          @click="pick({ kind: 'team', id: t.id })"
        >{{ t.name }}</el-button>
      </span>
    </h3>

    <el-row :gutter="14">
      <el-col :xs="24" :md="11">
        <EChart :option="radarOption" height="360px" />
      </el-col>

      <el-col :xs="24" :md="13">
        <div v-if="current" class="grade-card" :style="{ borderColor: current.grade.color + '55' }">
          <div class="grade-badge" :style="{ background: current.grade.color }">{{ current.grade.short }}</div>
          <div class="grade-main">
            <div class="grade-title">
              {{ current.name }}
              <span class="grade-label" :style="{ color: current.grade.color }">{{ current.grade.label }}</span>
            </div>
            <div class="grade-nums">
              <div class="num-item">
                <div class="num">{{ current.overall }}</div>
                <div class="cap">综合分</div>
              </div>
              <div class="num-item">
                <div class="num">{{ current.coverage }}%</div>
                <div class="cap">覆盖率</div>
              </div>
              <div class="num-item">
                <div class="num">{{ balanceText(current.balance) }}</div>
                <div class="cap">均衡度</div>
              </div>
              <div class="num-item">
                <div class="num">{{ current.attempts }}</div>
                <div class="cap">作答次数</div>
              </div>
            </div>
          </div>
        </div>

        <el-alert type="info" :closable="false" style="margin: var(--sp-3) 0">
          <template #title>
            <span class="comment">{{ current ? current.comment : '还没有数据' }}</span>
          </template>
        </el-alert>

        <div class="axis-list">
          <div v-for="a in (current ? current.axes : [])" :key="a.key" class="axis-row">
            <span class="axis-name"><span class="tier-dot" :style="{ background: a.color }" />{{ a.label }}</span>
            <el-progress
              :percentage="a.rate"
              :stroke-width="12"
              :color="a.rate >= 80 ? '#10b981' : (a.rate >= 50 ? 'var(--c-warn)' : 'var(--c-bad)')"
            />
            <span class="axis-meta">{{ a.correct }}/{{ a.attempts }} 次</span>
          </div>
        </div>

        <div class="card-ops">
          <el-button size="small" @click="copyComment">复制这条评价</el-button>
          <span class="tip">点下方表格任意一行可切换雷达</span>
        </div>
      </el-col>
    </el-row>

    <h4 class="sub-title">综合评价总览（队伍在前，学生按综合分排序）</h4>
    <el-table :data="rows" size="small" max-height="420" @row-click="pick" style="cursor: pointer">
      <el-table-column label="对象" min-width="130">
        <template #default="{ row }">
          <el-tag v-if="row.kind === 'team'" size="small" type="warning" effect="plain">队伍</el-tag>
          <b>{{ row.name }}</b>
          <span class="group">{{ row.group }}</span>
        </template>
      </el-table-column>
      <el-table-column label="综合分" width="90" align="right">
        <template #default="{ row }"><span class="score-num">{{ row.overall }}</span></template>
      </el-table-column>
      <el-table-column label="评级" width="130">
        <template #default="{ row }">
          <el-tag size="small" :style="{ background: row.grade.color, color: 'var(--c-surface)', border: 'none' }">
            <template v-if="row.grade.short">{{ row.grade.short }} · </template>{{ row.grade.label }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="覆盖率" width="90" align="right">
        <template #default="{ row }">{{ row.coverage }}%</template>
      </el-table-column>
      <el-table-column label="均衡度" width="90" align="right">
        <template #default="{ row }">{{ balanceText(row.balance) }}</template>
      </el-table-column>
      <el-table-column label="最强" width="110">
        <template #default="{ row }">
          <span v-if="row.strongest && row.balance !== 100">{{ row.strongest.label }} {{ row.strongest.rate }}%</span>
          <span v-else-if="row.strongest">各题型持平</span>
          <span v-else>—</span>
        </template>
      </el-table-column>
      <el-table-column label="最弱" width="110">
        <template #default="{ row }">
          <span v-if="row.weakest && row.balance !== 100">{{ row.weakest.label }} {{ row.weakest.rate }}%</span>
          <span v-else-if="row.weakest">各题型持平</span>
          <span v-else>—</span>
        </template>
      </el-table-column>
      <el-table-column label="评价" min-width="260" show-overflow-tooltip>
        <template #default="{ row }">{{ row.comment }}</template>
      </el-table-column>
    </el-table>
  </div>
</template>

<style scoped>
.grade-card { display: flex; gap: var(--sp-4); align-items: center; border: 1px solid var(--ci-line); border-radius: var(--radius-lg); padding: var(--sp-4); }
.grade-badge {
  width: 64px; height: 64px; border-radius: var(--radius-lg); color: var(--c-surface);
  display: grid; place-items: center; font-size: var(--fs-2xl); font-weight: 800; flex: none;
}
.grade-main { flex: 1; min-width: 0; }
.grade-title { font-size: var(--fs-base); font-weight: 700; display: flex; align-items: center; gap: var(--sp-2); }
.grade-label { font-size: var(--fs-sm); font-weight: 600; }
.grade-nums { display: flex; gap: var(--sp-5); margin-top: var(--sp-2); }
.num-item .num { font-size: var(--fs-xl); font-weight: 700; font-variant-numeric: tabular-nums; }
.num-item .cap { color: var(--ci-text-weak); font-size: var(--fs-xs); }
.comment { white-space: normal; line-height: 1.7; color: var(--ci-text); }
.axis-list { margin-top: var(--sp-2); }
.axis-row { display: grid; grid-template-columns: 92px 1fr 76px; align-items: center; gap: var(--sp-2); margin-bottom: var(--sp-2); font-size: var(--fs-xs); }
.axis-name { color: var(--ci-text); }
.axis-meta { color: var(--ci-text-weak); text-align: right; }
.card-ops { display: flex; align-items: center; gap: var(--sp-2); margin-top: var(--sp-3); }
.tip { color: var(--ci-text-weak); font-size: var(--fs-xs); }
.sub-title { margin: var(--sp-4) 0 var(--sp-2); font-size: var(--fs-sm); }
.group { color: var(--ci-text-weak); font-size: var(--fs-xs); margin-left: var(--sp-2); }
</style>
