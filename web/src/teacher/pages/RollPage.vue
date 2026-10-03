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
const history = ref<any[]>([]);            // 本次课堂的点名顺序
const settings = ref({ ...store.state.rollcall });

/** 候选池预览（让学生知道还有多少人没被点到） */
const pool = computed(() => CI.rollcall.candidates(store.state, { scope: settings.value.scope || 'all' }));
const roundInfo = computed(() => ({
  total: store.students.length,
  called: store.students.filter((s) => store.calledCount(s.id) > 0).length,
  pool: pool.value.length
}));

async function doPick() {
  // 点名优先走 Rust 核心（/api/domain/pick，与 parity 基准同一套算法），不可达时回退本地实现
  const r = await fetchPick();
  const res = r.pick;
  if (!res) { ElMessage.warning('没有可点名的学生（检查候选池设置或名单）'); return; }
  CI.rollcall.applyPick(res);
  // 顺带把课堂环节切到"随机点名"，大屏立刻放大显示这位同学
  CI.classroom.setPhase('rollcall');
  const stu = store.students.find((x) => x.id === res.sid);
  current.value = stu ? { sid: stu.id, name: stu.name, teamName: teamName(stu.teamId) } : null;
  history.value.unshift({ sid: res.sid, name: stu ? stu.name : '?', at: Date.now() });
  refresh();
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
  ElMessage.success(`${current.value.name} ${CI.store.RESULT_LABEL[result]}${delta ? '（' + (delta > 0 ? '+' : '') + delta + '）' : ''}`);
  doPick();                       // 判分后立刻抽下一位
}

function quick(tierKey, result) {
  if (!current.value) { ElMessage.info('先点一次名'); return; }
  CI.rollcall.quickFor(current.value.sid, tierKey, result || 'correct');
  ElMessage.success(`${current.value.name} 已按题型记分`);
  refresh();
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

function refresh() { /* computed 会自动更新，这里只是显式表达依赖 */ }

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
          空格抽下一位；抽到后按 <b>1</b> 答对 / <b>2</b> 半对 / <b>3</b> 答错 / <b>4</b> 跳过，判分后自动抽下一位。
        </div>
      </div>
      <div class="actions">
        <el-button @click="resetRound">重置点名池</el-button>
        <el-button type="primary" size="large" @click="doPick">抽一位（空格）</el-button>
      </div>
    </div>

    <el-row :gutter="14">
      <el-col :xs="24" :md="16">
        <div class="panel pick-panel">
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
          </div>

          <div class="judge-row">
            <el-button size="large" type="success" :disabled="!current" @click="judge('correct')">答对 1</el-button>
            <el-button size="large" type="warning" :disabled="!current" @click="judge('half')">半对 2</el-button>
            <el-button size="large" type="danger" :disabled="!current" @click="judge('wrong')">答错 3</el-button>
            <el-button size="large" :disabled="!current" @click="judge('skip')">跳过 4</el-button>
          </div>

          <div class="quick-row">
            <span class="label">按题型加分：</span>
            <el-button v-for="t in store.tiers" :key="t.key" :disabled="!current" @click="quick(t.key, 'correct')">
              <span class="tier-dot" :style="{ background: t.color }" />{{ t.label }} {{ t.weight }}
            </el-button>
          </div>
        </div>

        <div class="panel">
          <h3 class="panel-title">本轮点名顺序<span class="sub">共 {{ history.length }} 人</span></h3>
          <div v-if="history.length" class="history">
            <el-tag v-for="(h, i) in history" :key="h.sid + '-' + i" size="small" effect="plain" class="h-tag">
              {{ history.length - i }}. {{ h.name }}
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

          <el-descriptions :column="1" border size="small" style="margin-top: 14px">
            <el-descriptions-item label="学生总数">{{ roundInfo.total }}</el-descriptions-item>
            <el-descriptions-item label="已被点过">{{ roundInfo.called }}</el-descriptions-item>
            <el-descriptions-item label="当前候选">{{ roundInfo.pool }}</el-descriptions-item>
          </el-descriptions>
        </div>
      </el-col>
    </el-row>
  </div>
</template>

<style scoped>
.pick-panel { text-align: center; padding: 28px 16px; }
.picked .who { font-size: 64px; font-weight: 800; letter-spacing: 4px; line-height: 1.2; }
.picked .meta { display: flex; align-items: center; justify-content: center; gap: 16px; margin-top: 10px; color: var(--ci-text-weak); }
.picked .meta b { color: var(--ci-text); }
.unpicked .hint-big { font-size: 24px; color: var(--ci-text-weak); }
.unpicked .hint-small { margin-top: 8px; color: var(--ci-text-weak); font-size: 13px; }
.judge-row { display: flex; justify-content: center; gap: 10px; margin-top: 24px; flex-wrap: wrap; }
.quick-row { display: flex; align-items: center; justify-content: center; gap: 8px; margin-top: 16px; flex-wrap: wrap; }
.quick-row .label { color: var(--ci-text-weak); font-size: 13px; }
.history { display: flex; flex-wrap: wrap; gap: 6px; }
.hint { color: var(--ci-text-weak); font-size: 12px; margin-left: 8px; }
</style>
