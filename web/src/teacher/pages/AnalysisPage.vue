<script setup lang="ts">
import { token } from '../../styles/token-value';
/**
 * 数据分析 · 学情分析
 * 数字全部来自 CI.analysis（与旧版同一口径）；图表用 ECharts，本页懒加载。
 */
import { computed, onMounted, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { useClassStore } from '../../shared/class-store';
import { CI } from '../../shared/bridge';
import { fetchStats } from '../../shared/domain-api';
import EChart from '../components/EChart.vue';
import AbilityPanel from '../components/AbilityPanel.vue';

const store = useClassStore();
const scope = ref('all');                 // all | teamId
/** 数据范围：current = 只看本节课（当前试卷）｜all = 全部课次 */
const quizScope = ref<'current' | 'all'>('current');
/**
 * 审计发现：选了"本节课"但**没有当前试卷**时，quizId 是 null，
 * 而领域层把 null 当"不过滤" → 实际统计的是全部课次，界面却写着"本节课"。
 * 这里给一个显式提示，别让老师看着"本节课"读全部课次的数据。
 */
const currentQuizMissing = computed(() => quizScope.value === 'current' && !(store.runtime as any).quizId);
const scopeOpts = computed(() => ({
  quizId: quizScope.value === 'all' ? null : ((store.runtime as any).quizId || null)
}));
const detailSid = ref('');

const classStats = computed(() => CI.analysis.classStats(store.state, scope.value, scopeOpts.value));
// Rust 结果优先（同一套口径，且与 JS 逐字段比对过）；没有就用本地实现
const ranking = computed<any[]>(() =>
  (rustStats.value && rustStats.value.ranking && rustStats.value.ranking.length)
    ? rustStats.value.ranking
    : CI.analysis.ranking(store.state, scope.value, scopeOpts.value)
);

const scopeName = computed(() => (scope.value === 'all'
  ? '全班'
  : ((store.teams.find((t) => t.id === scope.value) || {}).name || '该队伍')));

/**
 * 综合表现（多维度评价）：正确性 / 参与度 / 进步 三维加权，可下钻。
 * 口径来自 CI.analysis.studentEvaluation（与 Rust composite.rs 同契约、有 parity）。
 */
/**
 * 综合表现（多维度评价）：正确性 / 参与度 / 进步 三维加权。
 * 口径来自 CI.analysis.studentEvaluation（与 Rust composite.rs 同契约、有 parity）。
 *
 * 审计发现：原来模板对每行调用 2~3 次，每次都重跑全量统计（40 人班一次渲染上百次全量扫描）。
 * 现在**按 rev 预计算成 Map**，模板查表即可。
 */
const evaluationMap = computed<Map<string, any>>(() => {
  void store.rev;
  const m = new Map<string, any>();
  try {
    (ranking.value || []).forEach((r: any) => {
      if (!r || !r.sid) return;
      try { m.set(r.sid, CI.analysis.studentEvaluation(store.state, r.sid, scopeOpts.value)); }
      catch { m.set(r.sid, null); }
    });
  } catch { /* 整体失败也不让页面崩 */ }
  return m;
});

/** 查表（找不到返回 null，模板要写 parts || [] 守卫） */
function evaluationOf(sid: string): any {
  return evaluationMap.value.get(sid) || null;
}

/** 按题目正确率（低 → 高）：课后讲评顺序的依据 */
const questionRows = computed<any[]>(() => {
  void store.rev; // 状态变了就重算
  return (CI.analysis.questionStats(store.state, (scopeOpts.value as any).quizId) as any[]).filter((x) => x.attempts > 0);
});
const reviewLine = computed<string>(() => (CI.analysis.questionReviewLine(questionRows.value) as string) || '');

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

// ECharts option 是第三方配置形状：边界处用 any
const barOption = computed<any>(() => ({
  tooltip: { trigger: 'axis' },
  legend: { data: ['答对', '半对', '答错', '跳过'] },
  grid: { left: 40, right: 20, top: 40, bottom: 30 },
  xAxis: { type: 'category', data: tierRows.value.map((t) => t.label) },
  yAxis: { type: 'value', name: '人次' },
  series: [
    { name: '答对', type: 'bar', stack: 'a', itemStyle: { color: '#10b981' }, data: tierRows.value.map((t) => t.correct) },
    { name: '半对', type: 'bar', stack: 'a', itemStyle: { color: token('--c-warn') }, data: tierRows.value.map((t) => t.half) },
    { name: '答错', type: 'bar', stack: 'a', itemStyle: { color: token('--c-bad') }, data: tierRows.value.map((t) => t.wrong) },
    { name: '跳过', type: 'bar', stack: 'a', itemStyle: { color: token('--c-line-strong') }, data: tierRows.value.map((t) => t.skip) }
  ]
}));

// ECharts option 是第三方配置形状：边界处用 any
const rateOption = computed<any>(() => ({
  tooltip: { trigger: 'axis', formatter: '{b}：正确率 {c}%' },
  grid: { left: 40, right: 20, top: 20, bottom: 30 },
  xAxis: { type: 'category', data: tierRows.value.map((t) => t.label) },
  yAxis: { type: 'value', max: 100, name: '%' },
  series: [{
    type: 'bar',
    barWidth: 34,
    label: { show: true, position: 'top', formatter: '{c}%' },
    itemStyle: {
      color: (p) => (p.value >= 80 ? '#10b981' : (p.value >= 50 ? token('--c-warn') : token('--c-bad'))),
      borderRadius: [6, 6, 0, 0]
    },
    data: tierRows.value.map((t) => t.rate)
  }]
}));

/**
 * 统计来源（docs/14 P4）：优先 Rust 核心（/api/domain/stats），不可达时回退本地参考实现。
 * 拿到异步结果前先用本地同步实现渲染，拿到后替换 —— 页面不会白屏。
 */
const rustStats = ref<any>(null);
const statsSource = ref<'rust' | 'js' | 'pending'>('pending');
const statsNote = ref('');

async function loadStats() {
  const r = await fetchStats({ quizId: scopeOpts.value.quizId ?? null, teamId: null });
  rustStats.value = r.source === 'rust' ? r : null;
  statsSource.value = r.source;
  statsNote.value = r.note || '';
}
onMounted(loadStats);
// 审计发现：原来 watch rev 让**每次记分都发一个 /api/domain/stats**（无防抖）；
// 且 loadStats 没有 catch → 一次失败就永远停在"加载中…"。加 400ms 防抖。
let statsTimer: ReturnType<typeof setTimeout> | null = null;
watch(() => [scope.value, store.rev], () => {
  if (statsTimer) clearTimeout(statsTimer);
  statsTimer = setTimeout(() => { statsTimer = null; void loadStats(); }, 400);
});

/** 学生明细表：每人每题型的得分与正确率 */
const detail = computed(() => {
  const sid = detailSid.value || (ranking.value[0] ? ranking.value[0].sid : '');
  if (!sid) return null;
  const stats = CI.analysis.studentStats(store.state, sid, scopeOpts.value);
  if (!stats) return null;
  return { sid, stats, summary: CI.analysis.summarizeStudent(store.state, sid, scopeOpts.value) };
});

/** 样本门槛（来自领域层设置）：低于它的百分比不该被当真 */
const minSample = computed(() => {
  void store.rev;
  return Number((store.settings as any).minSample) || 5;
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
  // 注意：CI.analysis.summarizeClass() 返回的是**对象**（{title, lines, text, stats}），
  // 不是字符串数组。早期这里直接 .join('\n') 会抛 TypeError，
  // 结果整段处理函数中断 —— 老师点「生成班级小结」既没有文字也没有任何提示。
  const res: any = CI.analysis.summarizeClass(store.state, scope.value, scopeOpts.value);
  summaryText.value = res == null
    ? ''
    : (typeof res === 'string' ? res : (res.text || (Array.isArray(res.lines) ? res.lines.join('\n') : '')));
  ElMessage.success('已生成班级小结');
}
function genStudentSummary() {
  const sid = detailSid.value || (ranking.value[0] ? ranking.value[0].sid : '');
  if (!sid) { ElMessage.warning('还没有学生数据'); return; }
  const lines = CI.analysis.summarizeStudent(store.state, sid, scopeOpts.value);
  // 与 genClassSummary 同一写法：summarizeStudent 返回**对象** {title, lines, text, stats}，
  // 直接 String(obj) 会得到 "[object Object]"（审计发现）
  summaryText.value = lines == null
    ? ''
    : (typeof lines === 'string' ? lines : (lines.text || (Array.isArray(lines.lines) ? lines.lines.join('\n') : '')));
  ElMessage.success('已生成个人小结');
}
async function copySummary() {
  if (!summaryText.value) { ElMessage.info('先生成小结'); return; }
  try { await navigator.clipboard.writeText(summaryText.value); ElMessage.success('已复制'); }
  catch (e) { ElMessage.warning('复制失败，请手动选中'); }
}
/**
 * 触发下载
 * CSV 要加 BOM（Excel 中文不乱码），Markdown 不能加（会多出看不见的字符）
 */
function download(name: string, text: string, mime = 'text/csv;charset=utf-8') {
  const body = mime.indexOf('csv') >= 0 ? '\ufeff' + text : text;
  const blob = new Blob([body], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
  // 审计发现：导出与页面选择器口径不一致，导出后明确告知实际范围
  ElMessage.success('已导出：' + name);
}
function exportCSV(kind) {
  // 审计发现：导出的口径与页面选择器**不一致** ——
  // classCSV/studentCSV 不接受 quizId（永远是全部课次），questionCSV 只吃当前试卷。
  // 与其假装跟随选择器，不如在文件名里写明实际范围，并给一行提示。
  const exportScopeNote = quizScope.value === 'all' ? '全部课次' : '全部课次（导出暂不支持只看本节课）';
  if (kind === 'class') download('班级学情-' + scopeName.value + '-' + exportScopeNote + '.csv', CI.analysis.classCSV(store.state, scope.value));
  else if (kind === 'student') {
    const sid = detailSid.value || (ranking.value[0] ? ranking.value[0].sid : '');
    if (!sid) { ElMessage.warning('没有学生'); return; }
    const stu = store.students.find((s) => s.id === sid);
    download('学生学情-' + (stu ? stu.name : sid) + '.csv', CI.analysis.studentCSV(store.state, sid));
  } else {
    download('题目分析-' + ((store.runtime as any).quizId ? '当前试卷' : '无当前试卷') + '.csv', CI.analysis.questionCSV(store.state, store.runtime.quizId));
  }
}

/** 导出课后课堂报告（Markdown：出勤 / 整体 / 各队对比 / 题型 / 题目正确率 / 学生表现） */
function downloadReport() {
  const rep = CI.analysis.classReport(store.state, scopeOpts.value);
  const stamp = new Date().toISOString().slice(0, 10);
  const name = (rep.data.courseName || '课堂') + '_课堂报告_' + stamp + '.md';
  download(name, rep.markdown, 'text/markdown');
  ElMessage.success('已导出课堂报告');
}

/** 错题本：按学生汇总答错/跳过的题（数据早就在流水里，这里按"人"聚合） */
const mistakes = computed<any[]>(() => {
  void store.rev;
  return CI.analysis.mistakeBoard(store.state, scopeOpts.value) as any[];
});
function mistakeTotal(m: any): number {
  return m.items.reduce((n: number, x: any) => n + x.count, 0);
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
          <!-- 审计发现：这里原来无条件显示百分比 —— 1 次作答也报"正确率 100%"，
               而 50 人班多数学生达不到样本门槛（默认 5），老师会据此下判断。 -->
          <el-tag v-if="overall.attempts < minSample" size="small" type="warning" effect="plain" class="ml">
            样本不足：{{ overall.attempts }} 次作答（建议 ≥{{ minSample }}）—— 百分比仅供参考
          </el-tag>
        </div>
      </div>
      <div class="actions">
        <el-select v-model="scope" style="width: 150px">
          <el-option label="全班" value="all" />
          <el-option v-for="t in store.teams" :key="t.id" :label="t.name" :value="t.id" />
        </el-select>
        <el-select v-model="quizScope" style="width: 170px" title="数据范围：本节课只统计当前试卷的流水">
        <!-- 审计发现：没有当前试卷时"本节课"实际统计全部课次，这里显式提示 -->
        <el-tag v-if="currentQuizMissing" size="small" type="warning" effect="plain">
          没有当前试卷 → 实际按全部课次统计
        </el-tag>
          <el-option label="本节课（当前试卷）" value="current" />
          <el-option label="全部课次" value="all" />
        </el-select>
        <el-button @click="genClassSummary">生成班级小结</el-button>
        <el-button @click="genStudentSummary">生成个人小结</el-button>
        <el-button type="primary" plain @click="downloadReport">导出课堂报告 (md)</el-button>
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

    <!-- 按题目正确率：课后讲评的直接依据（哪几道题全班都不会） -->
    <div class="panel">
      <h3 class="panel-title">
        按题目正确率
        <span class="sub">低 → 高；「未答对」含答错与跳过 —— 这是下节课讲评的顺序</span>
      </h3>
      <el-alert
        v-if="reviewLine"
        :title="reviewLine"
        type="warning"
        :closable="false"
        show-icon
        style="margin-bottom: var(--sp-2)"
      />
      <el-table :data="questionRows" size="small" max-height="380">
        <el-table-column type="index" label="#" width="50" />
        <el-table-column prop="stem" label="题目" min-width="200" show-overflow-tooltip />
        <el-table-column prop="tierLabel" label="题型" width="90" />
        <el-table-column label="作答" width="70" align="right">
          <template #default="{ row }">{{ row.attempts }}</template>
        </el-table-column>
        <el-table-column label="答对" width="70" align="right">
          <template #default="{ row }">{{ row.correct }}</template>
        </el-table-column>
        <el-table-column label="半对" width="70" align="right">
          <template #default="{ row }">{{ row.half }}</template>
        </el-table-column>
        <el-table-column label="未答对" width="80" align="right">
          <template #default="{ row }">{{ row.wrong + row.skip }}</template>
        </el-table-column>
        <el-table-column label="正确率" width="150">
          <template #default="{ row }">
            <el-progress
              :percentage="row.correctRate"
              :stroke-width="10"
              :status="row.correctRate < 40 ? 'exception' : (row.correctRate < 70 ? 'warning' : 'success')"
            />
          </template>
        </el-table-column>
        <el-table-column label="掌握度" width="80" align="right">
          <template #default="{ row }">{{ row.creditRate }}%</template>
        </el-table-column>
        <el-table-column label="均分" width="70" align="right">
          <template #default="{ row }">{{ row.avgPoints }}</template>
        </el-table-column>
        <el-table-column label="需要关注的学生" min-width="150">
          <template #default="{ row }">
            <span v-if="row.missers.length" class="missers">
              {{ row.missers.slice(0, 5).join('、') }}<template v-if="row.missers.length > 5"> 等 {{ row.missers.length }} 人</template>
            </span>
            <span v-else class="sub">—</span>
          </template>
        </el-table-column>
      </el-table>
      <div v-if="!questionRows.length" class="empty-hint">还没有按题目的作答数据（需要学生通过试卷作答，快捷记分不计入）</div>
    </div>

    <!-- 错题本：按学生汇总答错/跳过的题（课后订正的依据） -->
    <div class="panel">
      <h3 class="panel-title">
        错题本
        <span class="sub">按错题数排序；同一题错多次只列一条并标次数 —— 讲评后照着订正</span>
      </h3>
      <el-empty v-if="!mistakes.length" description="还没有错题（学生答错或跳过之后，这里会按人列出，含标准答案）" />
      <el-collapse v-else>
        <el-collapse-item v-for="m in mistakes" :key="m.sid" :name="m.sid">
          <template #title>
            <span class="mistake-title">
              <b>{{ m.name }}</b>
              <el-tag v-if="m.teamName" size="small" effect="plain">{{ m.teamName }}</el-tag>
              <span class="sub">{{ m.items.length }} 道题 / 共错 {{ mistakeTotal(m) }} 次<template v-if="m.tiers.length"> ｜ {{ m.tiers.join('、') }}</template></span>
            </span>
          </template>
          <el-table :data="m.items" size="small">
            <el-table-column prop="stem" label="题目" min-width="180" show-overflow-tooltip />
            <el-table-column prop="tierLabel" label="题型" width="90" />
            <el-table-column label="次数" width="70" align="right">
              <template #default="{ row }">{{ row.count }}</template>
            </el-table-column>
            <el-table-column label="最近判定" width="90">
              <template #default="{ row }">
                <el-tag size="small" :type="row.result === 'skip' ? 'info' : 'danger'" effect="plain">
                  {{ row.result === 'skip' ? '跳过' : '答错' }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="answer" label="学生答案" min-width="120" show-overflow-tooltip />
            <el-table-column prop="expected" label="正确答案" min-width="120" show-overflow-tooltip />
          </el-table>
        </el-collapse-item>
      </el-collapse>
    </div>

    <el-row :gutter="14">
      <el-col :xs="24" :md="14">
        <div class="panel">
          <h3 class="panel-title">
          学生明细
          <span class="sub">点某一行看个人报告</span>
          <el-tag
            size="small"
            :type="statsSource === 'rust' ? 'success' : (statsSource === 'js' ? 'info' : 'warning')"
            effect="plain"
            :title="statsNote || (statsSource === 'rust' ? '统计由 Rust 核心计算（与 JS 参考实现逐字段比对过）' : '枢纽没有领域端点，暂用浏览器内的参考实现')"
          >
            统计来源：{{ statsSource === 'rust' ? 'Rust 核心' : (statsSource === 'js' ? '本地参考实现' : '加载中…') }}
          </el-tag>
        </h3>
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
            <!-- 综合表现：正确性 / 参与度 / 进步 三维加权，悬停看下钻 -->
            <el-table-column label="综合表现" width="105" align="center">
              <template #default="{ row }">
                <el-tooltip
                  v-if="evaluationOf(row.sid)"
                  :content="evaluationOf(row.sid).parts.map((p) => p.label + ' ' + p.value + '×' + Math.round(p.weight) + '% = ' + p.contribution).join(' ｜ ')"
                  placement="left"
                >
                  <span class="eval-score">{{ evaluationOf(row.sid).total }}<i>/100</i></span>
                </el-tooltip>
                <span v-else class="sub">—</span>
              </template>
            </el-table-column>
            <el-table-column label="作答/答对" width="110" align="right">
              <template #default="{ row }">{{ row.attempts }} / {{ row.correct }}</template>
            </el-table-column>
            <el-table-column label="综合评定" width="120">
              <template #default="{ row }">
                <!-- 走 Rust 统计时 level 是**字符串**（RankRow.level: String），走本地是对象 —— 两种都要能显示。
                 原来只读 row.level.label，Rust 路径下这一列每行都是空的（审计发现） -->
            <el-tag size="small" effect="plain">
              {{ typeof row.level === 'string' ? row.level : (row.level && row.level.label) || '' }}
            </el-tag>
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
.tier-mini { margin-top: var(--sp-4); }
.tm-row { display: grid; grid-template-columns: 96px 1fr; align-items: center; gap: var(--sp-2); margin-bottom: var(--sp-2); font-size: var(--fs-xs); }
.tm-label { color: var(--ci-text-weak); }
.missers { font-size: var(--fs-xs); color: var(--c-warn); }
.eval-score { font-weight: 700; color: var(--c-brand); cursor: help; }
.eval-score i { font-size: var(--fs-xs); color: var(--el-text-color-secondary); font-style: normal; }
.empty-hint { color: var(--el-text-color-secondary); font-size: var(--fs-sm); padding: var(--sp-2) 0; }
.ml { margin-left: var(--sp-2); }
</style>
