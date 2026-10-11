<script setup lang="ts">
/**
 * 教学管理 · 随机点名（简洁模式）
 * 只显示姓名的大字号区域 + 快捷判分；判分后自动进入下一人，课堂节奏最紧。
 * 逻辑走 CI.rollcall（候选池 / 避免重复 / 记一次点名），不在界面里重算。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { useClassStore } from '../../shared/class-store';
import { CI } from '../../shared/bridge';
import { fetchPick } from '../../shared/domain-api';

const store = useClassStore();
const current = ref<any>(null);          // { sid, name, teamName }

/* ---- 抽人动画（用户要求：不要生硬，要有"随意跳动"的感觉） ----
 * 真正的结果仍来自领域层 fetchPick；这里只负责"看得见的期待感"。
 * 遵守无障碍：开了「减少动效」就直接出结果（设计规范硬规则）。
 */
const rolling = ref(false);
const rollName = ref('');

/** 当前是否要求减少动效（a11y 设置写在 html 上） */
function reduceMotion() {
  return typeof document !== 'undefined' && document.documentElement.classList.contains('a11y-reduce-motion');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 在候选池里跳名字，约 1.1 秒后停手（前快后慢，像老虎机落定） */
async function rollAnimation() {
  const names = pool.value.map((s: any) => s.name).filter(Boolean);
  if (!names.length || reduceMotion()) return;
  rolling.value = true;
  const total = 1100;
  const t0 = Date.now();
  while (Date.now() - t0 < total) {
    rollName.value = names[Math.floor(Math.random() * names.length)];
    const t = (Date.now() - t0) / total;
    await sleep(45 + t * t * 220);   // 越接近结束，间隔越大
  }
  rolling.value = false;
}
const history = ref<any[]>([]);            // 本次课堂的点名顺序
const settings = ref({ ...store.state.rollcall });

/** 候选池预览（让学生知道还有多少人没被点到） */
// 审计发现：settings 是一次性快照 → 未点"保存设置"时，这里的"当前候选"按**未保存的**范围预览，
// 而真正抽人（fetchPick）读的是已保存的 state.rollcall → 预览与实际抽取不一致。
// 这里改成用已保存的设置算候选，并在下面提示"改完要保存"。
const savedRollcall = computed(() => { void store.rev; return store.state.rollcall; });
const pool = computed(() => CI.rollcall.candidates(store.state, { scope: (savedRollcall.value as any).scope || 'all' }));
const roundInfo = computed(() => ({
  total: store.students.length,
  called: store.students.filter((s) => store.calledCount(s.id) > 0).length,
  pool: pool.value.length
}));

/**
 * 本轮点名统计（用户反馈：只有"学生总数/被点过"，看不到"加了多少分"）
 *
 * `history` 里每条 = 一次点名；判分后把 delta 写回去，于是能算出本轮累计加分。
 */
const rollStats = computed(() => {
  const judged = history.value.filter((h) => h.delta !== undefined);
  const gained = Math.round(judged.reduce((a, h) => a + (h.delta || 0), 0) * 100) / 100;
  const byResult: any = { correct: 0, half: 0, wrong: 0, skip: 0 };
  judged.forEach((h) => { if (h.result && byResult[h.result] !== undefined) byResult[h.result] += 1; });
  return {
    picked: history.value.length,
    judged: judged.length,
    gained,
    avg: judged.length ? Math.round((gained / judged.length) * 10) / 10 : 0,
    byResult
  };
});

/**
 * 把"这次点名加了多少分"记回点名顺序里
 *
 * 为什么：原来 judge() 只弹了个 toast，历史列表里只有名字 ——
 * 老师下课后想复盘"这轮点了谁、加了多少分"就无从查起。
 */
function recordScore(sid: string, delta: number, result: string) {
  const hit = history.value.find((h) => h.sid === sid && h.delta === undefined);
  if (hit) { hit.delta = delta; hit.result = result; return; }
  // 兜底：判的是历史里的某一位（不是刚抽到的），累加到最新一条上
  if (history.value.length) {
    const h = history.value[0];
    h.delta = Math.round(((h.delta || 0) + delta) * 100) / 100;
    h.result = result;
  }
}

/** 判定结果 → 标签文字（列表里显示"+3 答对"这样的短标记） */
function resultShort(r: string) {
  return ({ correct: '答对', half: '半对', wrong: '答错', skip: '跳过' } as any)[r] || '';
}

async function doPick() {
  // 用户要求：判完**不要**自动换人 —— 先给这位判分，再按一次空格抽下一位
  if (current.value && !current.value.judged) {
    ElMessage.info('先给 ' + current.value.name + ' 判分（1/2/3/4），或点「跳过 4」');
    return;
  }
  // 点名优先走 Rust 核心（/api/domain/pick，与 parity 基准同一套算法），不可达时回退本地实现
  const r = await fetchPick();
  const res = r.pick;
  if (!res) { ElMessage.warning('没有可点名的学生（检查候选池设置或名单）'); return; }
  await rollAnimation();   // 先跳一会儿，再落到结果上
  CI.rollcall.applyPick(res);
  // 顺带把课堂环节切到"随机点名"，大屏立刻放大显示这位同学
  CI.classroom.setPhase('rollcall');
  const stu = store.students.find((x) => x.id === res.sid);
  current.value = stu ? { sid: stu.id, name: stu.name, teamName: teamName(stu.teamId), judged: false } : null;
  history.value.unshift({ sid: res.sid, name: stu ? stu.name : '?', at: Date.now() });
}

function teamName(tid) {
  const t = store.teams.find((x) => x.id === tid);
  return t ? t.name : '未分组';
}

/** 判分：走同一口径（correct/half/wrong/skip） */
function judge(result) {
  if (!current.value) { ElMessage.info('先点一次名'); return; }
  const before = store.scoreOf(current.value.sid);
  CI.rollcall.judge(result);
  const after = store.scoreOf(current.value.sid);
  const delta = Math.round((after - before) * 100) / 100;
  recordScore(current.value.sid, delta, result);   // 记回点名顺序，供统计与复盘
  // 用户要求：**不自动抽下一位** —— 停在这位同学，等老师再按一次空格
  current.value.judged = true;
  current.value.delta = delta;
  current.value.result = result;
  ElMessage.success(`${current.value.name} ${CI.store.RESULT_LABEL[result]}${delta ? '（' + (delta > 0 ? '+' : '') + delta + '）' : ''}`);
}

function quick(tierKey, result) {
  if (!current.value) { ElMessage.info('先点一次名'); return; }
  const before = store.scoreOf(current.value.sid);
  CI.rollcall.quickFor(current.value.sid, tierKey, result || 'correct');
  const after = store.scoreOf(current.value.sid);
  recordScore(current.value.sid, Math.round((after - before) * 100) / 100, result || 'correct');
  current.value.judged = true;
  current.value.result = result || 'correct';
  ElMessage.success(`${current.value.name} 已按题型记分`);
}

function saveSettings() {
  CI.store.setRollSettings({ ...settings.value });
  ElMessage.success('已保存点名设置');
}

function resetRound() {
  CI.store.resetRolls();
  history.value = [];
  ElMessage.success('已重置点名池（所有人重新进入候选）');
}


/* 快捷键：1 答对 / 2 半对 / 3 答错 / 4 跳过；空格 = 点名 */
function onKey(e) {
  const tag = (e.target && e.target.tagName) || '';
  if (/INPUT|TEXTAREA|SELECT/.test(tag)) return;
  if (!current.value && e.key !== ' ') return;
  const map = { 1: 'correct', 2: 'half', 3: 'wrong', 4: 'skip' };
  if (map[e.key]) { judge(map[e.key]); e.preventDefault(); }
  else if (e.key === ' ') { doPick(); e.preventDefault(); }
}
onMounted(() => window.addEventListener('keydown', onKey));
onUnmounted(() => window.removeEventListener('keydown', onKey));
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h2>随机点名</h2>
        <div class="desc">
          抽到后按 <b>1</b> 答对 / <b>2</b> 半对 / <b>3</b> 答错 / <b>4</b> 跳过；<b>判完停在原位</b>，再按一次 <b>空格</b> 才抽下一位。
        </div>
      </div>
      <div class="actions">
        <el-button @click="resetRound">重置点名池</el-button>
        <el-button :disabled="rolling" type="primary" size="large" @click="doPick">{{ rolling ? '正在抽…' : (current ? '抽下一位（空格）' : '抽一位（空格）') }}</el-button>
      </div>
    </div>

    <el-row :gutter="14">
      <el-col :xs="24" :md="16">
        <div class="panel pick-panel">
          <!-- 用户要求：判完停在原位，提示"再按一次空格抽下一位" -->
          <div v-if="current && current.judged" class="judged-bar">
            <span class="jb-main">
              已判分：{{ current.name }}
              <b>{{ current.delta > 0 ? '+' : '' }}{{ current.delta }}</b>
              分（{{ resultShort(current.result) }}）
            </span>
            <span class="jb-next">再按一次 <b>空格</b> 抽下一位</span>
          </div>
          <!-- 抽人中：名字快速跳动 -->
          <div v-if="rolling" class="picked rolling">
            <div class="who roll-who">{{ rollName || '…' }}</div>
            <div class="meta"><span class="score">正在抽…</span></div>
          </div>
          <div v-if="current" class="picked">
            <div class="who">{{ current.name }}</div>
            <div class="meta">
              <el-tag effect="plain">{{ current.teamName }}</el-tag>
              <span class="score">当前积分 <b>{{ store.scoreOf(current.sid) }}</b></span>
              <span class="score">已被点 <b>{{ store.calledCount(current.sid) }}</b> 次</span>
            </div>
          </div>
          <div v-else class="unpicked">
            <div class="hint-big">按「抽一位」或空格开始</div>
            <div class="hint-small">候选池里还有 {{ roundInfo.pool }} 人</div>
            <!-- 审计发现：未点"保存设置"时预览与真正抽取不一致（抽取读的是已保存设置） -->
            <span class="hint">（按已保存的设置算；改了范围请先保存）</span>
          </div>

          <div class="judge-row">
            <el-button size="large" type="success" :disabled="!current" @click="judge('correct')">答对 1</el-button>
            <el-button size="large" type="warning" :disabled="!current" @click="judge('half')">半对 2</el-button>
            <el-button size="large" type="danger" :disabled="!current" @click="judge('wrong')">答错 3</el-button>
            <el-button size="large" :disabled="!current" @click="judge('skip')">跳过 4</el-button>
            <!-- 审计发现：这四个按钮没说"学生没设备也能用" —— 老师会以为必须先有学生端提交。
                 一个班只有几台设备时，这一步直接决定能不能用。 -->
            <div class="hint oral-hint">学生没带设备时：让他口头回答，听完直接点上面四个按钮判分（不依赖学生端提交）</div>
          </div>

          <div class="quick-row">
            <span class="label">按题型加分：</span>
            <el-button v-for="t in store.tiers" :key="t.key" :disabled="!current" @click="quick(t.key, 'correct')">
              <span class="tier-dot" :style="{ background: t.color }" />{{ t.label }} {{ t.weight }}
            </el-button>
          </div>
        </div>

        <div class="panel">
          <h3 class="panel-title">
            本轮点名顺序
            <span class="sub">共 {{ history.length }} 人 · 已判分 {{ rollStats.judged }} 人</span>
          </h3>
          <!-- 用户反馈："这个点名顺序我不明白是什么" —— 把口径写在脸上 -->
          <div class="hint order-hint">
            名字按<b>被点到的先后</b>排列（新点的在最上面）；后面的 <b>+N</b> 是这次点名给他加的分。
            抽人规则由右边「点名策略」决定，「重置点名池」会清空这份顺序。
          </div>
          
          <!-- 本轮统计（用户反馈：应该有"回答的学生加了多少分"的统计） -->
          <div v-if="rollStats.picked" class="roll-stats">
            <div class="st-item"><span class="k">本轮点名</span><b class="num">{{ rollStats.picked }}</b><span class="u">人</span></div>
            <div class="st-item"><span class="k">已判分</span><b class="num">{{ rollStats.judged }}</b><span class="u">人</span></div>
            <div class="st-item gain"><span class="k">累计加分</span><b class="num">{{ rollStats.gained > 0 ? '+' : '' }}{{ rollStats.gained }}</b><span class="u">分</span></div>
            <div class="st-item"><span class="k">人均</span><b class="num">{{ rollStats.avg > 0 ? '+' : '' }}{{ rollStats.avg }}</b><span class="u">分</span></div>
            <div class="st-dist">
              <el-tag v-if="rollStats.byResult.correct" size="small" type="success" effect="plain">答对 {{ rollStats.byResult.correct }}</el-tag>
              <el-tag v-if="rollStats.byResult.half" size="small" type="warning" effect="plain">半对 {{ rollStats.byResult.half }}</el-tag>
              <el-tag v-if="rollStats.byResult.wrong" size="small" type="danger" effect="plain">答错 {{ rollStats.byResult.wrong }}</el-tag>
              <el-tag v-if="rollStats.byResult.skip" size="small" effect="plain">跳过 {{ rollStats.byResult.skip }}</el-tag>
            </div>
          </div>
          
          <div v-if="history.length" class="history">
            <el-tag
              v-for="(h, i) in history"
              :key="h.sid + '-' + i"
              size="small"
              effect="plain"
              class="h-tag"
              :type="h.result === 'correct' ? 'success' : h.result === 'half' ? 'warning' : h.result === 'wrong' ? 'danger' : 'info'"
            >
              {{ history.length - i }}. {{ h.name }}
              <b v-if="h.delta !== undefined" class="h-delta">{{ h.delta > 0 ? '+' : '' }}{{ h.delta }}</b>
              <span v-if="h.result" class="h-res">{{ resultShort(h.result) }}</span>
            </el-tag>
          </div>
          <div v-else class="empty-hint">还没有点过名</div>
        </div>
      </el-col>

      <el-col :xs="24" :md="8">
        <div class="panel">
          <h3 class="panel-title">点名设置</h3>
          <el-form label-width="96" size="small">
            <el-form-item label="候选范围">
              <el-select v-model="settings.scope" style="width: 100%">
                <el-option label="全班" value="all" />
                <el-option v-for="t in store.teams" :key="t.id" :label="t.name" :value="t.id" />
              </el-select>
            </el-form-item>
            <el-form-item label="抽取策略">
              <el-radio-group v-model="settings.mode">
                <el-radio value="even">均匀（未点过的优先）</el-radio>
                <el-radio value="least">最少被点优先</el-radio>
                <el-radio value="random">纯随机</el-radio>
              </el-radio-group>
            </el-form-item>
            <el-form-item label="避免重复">
              <el-switch v-model="settings.excludeAnswered" />
              <span class="hint">跳过当前题已作答的学生</span>
            </el-form-item>
            <el-button type="primary" size="small" @click="saveSettings">保存设置</el-button>
          </el-form>

          <el-descriptions :column="1" border size="small" style="margin-top: var(--sp-4)">
            <el-descriptions-item label="学生总数">{{ roundInfo.total }}</el-descriptions-item>
            <el-descriptions-item label="已被点过">{{ roundInfo.called }}</el-descriptions-item>
            <el-descriptions-item label="当前候选">{{ roundInfo.pool }}</el-descriptions-item>
            <el-descriptions-item label="本轮累计加分">
              <b>{{ rollStats.gained > 0 ? '+' : '' }}{{ rollStats.gained }}</b> 分（人均 {{ rollStats.avg }}）
            </el-descriptions-item>
          </el-descriptions>
        </div>
      </el-col>
    </el-row>
  </div>
</template>

<style scoped>
.pick-panel { text-align: center; padding: var(--sp-6) var(--sp-4); }
.picked .who { font-size: var(--fs-6xl); font-weight: 800; letter-spacing: 4px; line-height: 1.2; }

/* 抽人时的跳动（克制：只做轻微缩放+位移，不旋转不闪烁） */
.roll-who { animation: roll-jump .16s ease-in-out infinite alternate; }
@keyframes roll-jump {
  from { transform: translateY(-4px) scale(.985); opacity: .82; }
  to   { transform: translateY(4px) scale(1.015); opacity: 1; }
}
.picked.rolling .who { color: var(--ci-text-weak); }
/* 减少动效：静态呈现（a11y 设置由 html 类控制） */
:global(html.a11y-reduce-motion) .roll-who { animation: none; }

.picked .meta { display: flex; align-items: center; justify-content: center; gap: var(--sp-4); margin-top: var(--sp-2); color: var(--ci-text-weak); }
.picked .meta b { color: var(--ci-text); }
.unpicked .hint-big { font-size: var(--fs-2xl); color: var(--ci-text-weak); }
.unpicked .hint-small { margin-top: var(--sp-2); color: var(--ci-text-weak); font-size: var(--fs-sm); }
.judge-row { display: flex; justify-content: center; gap: var(--sp-2); margin-top: var(--sp-5); flex-wrap: wrap; }
.quick-row { display: flex; align-items: center; justify-content: center; gap: var(--sp-2); margin-top: var(--sp-4); flex-wrap: wrap; }
.quick-row .label { color: var(--ci-text-weak); font-size: var(--fs-sm); }
.history { display: flex; flex-wrap: wrap; gap: var(--sp-2); }
.hint { color: var(--ci-text-weak); font-size: var(--fs-xs); margin-left: var(--sp-2); }
.oral-hint { margin-top: var(--sp-2); }

/* ---- 点名顺序说明 + 本轮统计（用户反馈：顺序看不懂、没有加分统计） ---- */
.order-hint { display: block; margin: 0 0 var(--sp-3); line-height: var(--lh-relaxed); }
.order-hint b { color: var(--ci-text); }

/* 已判分提示条（判完停在原位） */
.judged-bar {
  display: flex; align-items: center; justify-content: center; gap: var(--sp-4);
  flex-wrap: wrap; margin-bottom: var(--sp-3); padding: var(--sp-2) var(--sp-4);
  background: var(--ci-fill); border-radius: var(--radius-md);
}
.judged-bar .jb-main { font-size: var(--fs-lg); }
.judged-bar .jb-main b { color: var(--c-success); font-size: var(--fs-xl); }
.judged-bar .jb-next { color: var(--ci-text-weak); font-size: var(--fs-sm); }
.judged-bar .jb-next b { color: var(--ci-text); }

.roll-stats {
  display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-5);
  padding: var(--sp-3) var(--sp-4); margin-bottom: var(--sp-3);
  background: var(--ci-fill); border-radius: var(--radius-md);
}
.roll-stats .st-item { display: flex; align-items: baseline; gap: var(--sp-1); }
.roll-stats .k { color: var(--ci-text-weak); font-size: var(--fs-sm); }
.roll-stats .num { font-size: var(--fs-xl); font-weight: var(--fw-bold); color: var(--ci-text); }
.roll-stats .u { color: var(--ci-text-weak); font-size: var(--fs-xs); }
.roll-stats .gain .num { color: var(--c-success); }
.roll-stats .st-dist { display: flex; flex-wrap: wrap; gap: var(--sp-1); margin-left: auto; }

.history .h-delta { margin-left: var(--sp-1); }
.history .h-res { margin-left: var(--sp-1); opacity: .75; font-size: var(--fs-xs); }

</style>
