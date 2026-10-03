<script setup lang="ts">
/**
 * 公开课（不能出问题的场景）
 *
 * 设计原则（`docs/15-公开课模式设计.md`）：
 *   · **一步一屏**：公开课最怕"找不到按钮"，所以四步各占一屏，每屏只有一个主操作
 *   · **口头作答也走得通**：抽题答题常见形态是学生口头回答，老师听完整点一下
 *     「全对 / 对一半 / 不对」—— 不依赖学生设备
 *   · **评语规则生成**：离线可用、确定性强、不编造；老师可直接念
 *   · 逻辑全部走领域层（`CI.rollcall` / `CI.store` / `CI.openclass`）与 Rust 核心端点，
 *     界面里不重算任何规则
 */
import { computed, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { useClassStore } from '../../shared/class-store';
import { CI } from '../../shared/bridge';
import { fetchPick, scoreVerdictWithRust, fetchOpenEval } from '../../shared/domain-api';

const store = useClassStore();

type Step = 1 | 2 | 3 | 4;
const step = ref<Step>(1);

const picked = ref<any>(null);        // { sid, name, teamName }
const question = ref<any>(null);      // 抽到的题
const onlyObjective = ref(true);      // 抽题默认只抽客观题（公开课以客观题为主）
const tierFilter = ref<string>('');   // 可选：限定题型
const verdict = ref<'' | 'correct' | 'half' | 'wrong'>('');
const scores = ref<Record<string, number>>({});
const evaluation = ref<any>(null);
const evalSource = ref<'rust' | 'js' | ''>('');
const busy = ref(false);

const dims = computed<any[]>(() => (CI as any).openclass.defaultDimensions());

/** 客观题：有标准答案且选项 >= 2 */
function isObjective(q: any) {
  return !!(q && String(q.answer || '').trim() && (q.options || []).length >= 2);
}

/* ---------------- ① 点名 ---------------- */
async function doPick() {
  busy.value = true;
  try {
    const r = await fetchPick();
    if (!r.pick) { ElMessage.warning('没有可点名的学生（检查名单或候选池设置）'); return; }
    CI.rollcall.applyPick(r.pick);
    CI.classroom.setPhase('rollcall');
    const stu = store.students.find((x) => x.id === r.pick!.sid);
    picked.value = stu
      ? { sid: stu.id, name: stu.name, teamName: teamName(stu.teamId) }
      : { sid: r.pick.sid, name: r.pick.name || '?', teamName: '' };
    verdict.value = '';
    question.value = null;
    scores.value = {};
    evaluation.value = null;
    step.value = 2;
  } finally {
    busy.value = false;
  }
}

function teamName(tid: string | null) {
  const t = (store.teams as any[]).find((x) => x.id === tid);
  return t ? t.name : '未分组';
}

/* ---------------- ② 抽题 ---------------- */
function doDraw() {
  const bank = (store.bank as any[]).filter((q) => {
    if (onlyObjective.value && !isObjective(q)) return false;
    if (tierFilter.value && q.tier !== tierFilter.value) return false;
    return true;
  });
  if (!bank.length) {
    ElMessage.warning(onlyObjective.value ? '题库里没有符合条件的客观题（可关掉"只抽客观题"）' : '题库为空');
    return;
  }
  // 用领域层的抽题（与 Rust draw.rs 同一算法、有 parity 基准）
  const drawn = (CI.store as any).drawQuestions(store.state, { tiers: [], counts: {}, pool: bank.map((q) => q.id) });
  const id = Array.isArray(drawn) && drawn.length ? (drawn[0].id || drawn[0]) : bank[0].id;
  const q = bank.find((x) => x.id === id) || bank[0];
  question.value = q;
  // 把当前题切到这道（大屏/学生端据此显示）
  CI.store.setRuntime({ qid: q.id, quizId: store.state.currentQuizId || null });
  CI.classroom.setPhase('question');
  verdict.value = '';
  step.value = 3;
}

/* ---------------- ③ 现场判定 ---------------- */
async function judge(v: 'correct' | 'half' | 'wrong') {
  if (!picked.value || !question.value) return;
  verdict.value = v;
  busy.value = true;
  try {
    // 计分走 Rust 核心（与课堂核心循环同一套），拿不到就用本地口径
    const scored = await scoreVerdictWithRust({
      result: v,
      tier: question.value.tier,
      customPoints: question.value.points ?? null
    });
    const rec = CI.store.recordResult({
      sid: picked.value.sid,
      qid: question.value.id,
      tier: question.value.tier,
      result: v,
      quizId: store.state.currentQuizId || null,
      source: 'quiz',
      by: 'open',
      note: '公开课现场判定',
      picked: '',
      points: scored.score ? scored.score.points : undefined
    } as any);
    ElMessage.success(
      '已记录：' + (v === 'correct' ? '全对' : v === 'half' ? '对一半' : '不对') +
      (rec ? '（' + (rec.points >= 0 ? '+' : '') + rec.points + ' 分）' : '')
    );
    step.value = 4;
  } finally {
    busy.value = false;
  }
}

/* ---------------- ④ 现场评价 ---------------- */
function setScore(key: string, s: number) {
  scores.value = { ...scores.value, [key]: s };
  void refreshEval();
}

async function refreshEval() {
  const list = Object.keys(scores.value).map((k) => ({ key: k, score: scores.value[k] }));
  const r = await fetchOpenEval(list);
  evaluation.value = r.evaluation;
  evalSource.value = r.source;
}

async function finish() {
  if (!evaluation.value) { ElMessage.warning('至少评一个维度再完成'); return; }
  CI.store.log?.('公开课评价', (picked.value?.name || '') + ' · ' + evaluation.value.total + ' 分 ' + evaluation.value.level);
  ElMessage.success('已记录评价，可以请下一位同学了');
  // 进入下一位：保留量规，清空本轮
  picked.value = null;
  question.value = null;
  verdict.value = '';
  scores.value = {};
  evaluation.value = null;
  step.value = 1;
}

function back() {
  if (step.value > 1) step.value = (step.value - 1) as Step;
}
</script>

<template>
  <div class="open-page">
    <div class="head">
      <h2>公开课</h2>
      <span class="sub">点名 → 抽题 → 现场判定 → 现场评价，一步一屏</span>
    </div>

    <el-steps :active="step - 1" simple class="steps">
      <el-step title="① 点名" />
      <el-step title="② 抽题" />
      <el-step title="③ 判定" />
      <el-step title="④ 评价" />
    </el-steps>

    <!-- ① 点名 -->
    <el-card v-if="step === 1" class="panel">
      <div class="big-hint">请一位同学回答</div>
      <el-button type="primary" size="large" :loading="busy" @click="doPick">随机抽一位</el-button>
      <div class="tip">抽到的同学会同时在大屏上放大显示</div>
    </el-card>

    <!-- ② 抽题 -->
    <el-card v-else-if="step === 2" class="panel">
      <div class="who">请 <b>{{ picked?.name }}</b> 回答</div>
      <div class="row">
        <el-checkbox v-model="onlyObjective">只抽客观题（公开课以客观题为主）</el-checkbox>
        <el-select v-model="tierFilter" placeholder="不限题型" clearable style="width: 160px">
          <el-option v-for="t in store.tiers" :key="t.key" :label="t.label" :value="t.key" />
        </el-select>
      </div>
      <el-button type="primary" size="large" @click="doDraw">抽一道题</el-button>
      <div class="tip">抽到主观题也不慌：听学生说完，下一步点「全对 / 对一半 / 不对」</div>
    </el-card>

    <!-- ③ 判定 -->
    <el-card v-else-if="step === 3" class="panel">
      <div class="who">请 <b>{{ picked?.name }}</b> 回答</div>
      <div class="stem">{{ question?.stem }}</div>
      <div v-if="(question?.options || []).length" class="opts">
        <div v-for="(o, i) in question.options" :key="i" class="opt">
          <span class="k">{{ 'ABCDEFGH'[i] }}</span><span>{{ o }}</span>
        </div>
      </div>
      <div class="answer">
        正确答案：<b>{{ (question?.answer || '（主观题，无标准答案）') }}</b>
        <span v-if="question?.note" class="why">讲评要点：{{ question.note }}</span>
      </div>
      <div class="verdict-row">
        <el-button type="success" size="large" :loading="busy" @click="judge('correct')">全对</el-button>
        <el-button type="warning" size="large" :loading="busy" @click="judge('half')">对一半</el-button>
        <el-button type="danger" size="large" :loading="busy" @click="judge('wrong')">不对</el-button>
      </div>
      <div class="tip">判定即记分（走 Rust 核心的计分口径），不需要学生动设备</div>
    </el-card>

    <!-- ④ 评价 -->
    <el-card v-else class="panel">
      <div class="who">现场评价：<b>{{ picked?.name }}</b></div>
      <div class="dims">
        <div v-for="d in dims" :key="d.key" class="dim">
          <div class="dim-head">
            <b>{{ d.label }}</b>
            <span class="anchor">{{ d.anchor }}</span>
          </div>
          <el-radio-group
            :model-value="scores[d.key]"
            @update:model-value="(v: any) => setScore(d.key, Number(v))"
          >
            <el-radio-button :value="4">优秀</el-radio-button>
            <el-radio-button :value="3">良好</el-radio-button>
            <el-radio-button :value="2">合格</el-radio-button>
            <el-radio-button :value="1">待改进</el-radio-button>
          </el-radio-group>
        </div>
      </div>

      <div v-if="evaluation" class="result">
        <div class="total">
          {{ evaluation.total }} 分 · <b>{{ evaluation.level }}</b>
          <el-tag size="small" effect="plain" :type="evalSource === 'rust' ? 'success' : 'info'">
            {{ evalSource === 'rust' ? 'Rust 核心' : '本地口径' }}
          </el-tag>
        </div>
        <div class="comment">「{{ evaluation.comment }}」</div>
        <div class="tip">评语由规则生成（离线可用、不会编造），可直接当众念</div>
      </div>

      <div class="actions">
        <el-button size="large" @click="back">上一步</el-button>
        <el-button type="primary" size="large" @click="finish">完成，请下一位</el-button>
      </div>
    </el-card>
  </div>
</template>

<style scoped>
.open-page { max-width: 900px; }
.head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 12px; }
.head h2 { margin: 0; }
.sub { color: var(--el-text-color-secondary); font-size: 13px; }
.steps { margin-bottom: 16px; }
.panel { padding: 8px 4px; }
.big-hint { font-size: 20px; font-weight: 700; margin-bottom: 16px; }
.who { font-size: 18px; margin-bottom: 12px; }
.who b { color: var(--el-color-primary); font-size: 22px; }
.row { display: flex; align-items: center; gap: 16px; margin-bottom: 16px; }
.tip { color: var(--el-text-color-secondary); font-size: 13px; margin-top: 10px; }
.stem { font-size: 20px; line-height: 1.6; margin: 8px 0 12px; }
.opts { display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 12px; }
.opt { display: flex; gap: 6px; align-items: center; font-size: 16px; }
.opt .k { font-weight: 700; color: var(--el-color-primary); }
.answer { background: var(--el-fill-color-light); padding: 10px 12px; border-radius: 6px; margin-bottom: 16px; }
.why { margin-left: 16px; color: var(--el-text-color-secondary); }
.verdict-row { display: flex; gap: 16px; }
.dims { display: flex; flex-direction: column; gap: 14px; margin-bottom: 16px; }
.dim-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 6px; }
.anchor { color: var(--el-text-color-secondary); font-size: 12px; }
.result { border-top: 1px dashed var(--el-border-color); padding-top: 12px; margin-bottom: 12px; }
.total { font-size: 20px; margin-bottom: 6px; }
.comment { font-size: 17px; line-height: 1.7; color: var(--el-color-primary); }
.actions { display: flex; gap: 12px; }
</style>
