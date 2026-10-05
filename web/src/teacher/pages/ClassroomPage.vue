<script setup lang="ts">
/**
 * 教学管理 · 课堂协同（两栏：上方作答控制，下方在线小组 + 抢答/待确认/实时流）
 * 所有写入都走 CI.classroom，前端只负责展示与触发，保证与旧版、学生端、大屏行为一致。
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useClassStore } from '../../shared/class-store';
import { CI } from '../../shared/bridge';
import { fetchPick } from '../../shared/domain-api';

const store = useClassStore();
const tick = ref(0);
const timer = setInterval(() => { tick.value += 1; }, 2000);   // 让在线状态/相对时间保持新鲜

const box = computed(() => { void tick.value; return CI.classroom.box(store.state); });
const presence = computed(() => { void tick.value; return CI.classroom.presence() || { teams: [], hostOnline: false }; });
const revealed = computed(() => { void tick.value; return CI.classroom.isRevealed(store.state, store.currentQuestion); });
const accepting = computed(() => !!store.runtime.accepting);
const currentQ = computed(() => store.currentQuestion);
const progress = computed(() => {
  const quiz = store.currentQuiz;
  if (!quiz || !quiz.questionIds.length) return { index: 0, total: 0 };
  const i = quiz.questionIds.indexOf(store.runtime.qid);
  return { index: i < 0 ? 0 : i + 1, total: quiz.questionIds.length };
});

const joinUrl = computed(() => {
  try { return CI.sync.joinURL(window.location.origin); } catch (e) { return ''; }
});
const qrUrl = computed(() => {
  try { return CI.sync.qrURL(joinUrl.value); } catch (e) { return ''; }
});
const qrFailed = ref(false);
// 审计发现：qrFailed 一旦置 true 就再不复位 —— 换房间/换地址后即使二维码可用，
// 界面仍显示"二维码不可用"。地址变了就复位。
watch(qrUrl, () => { qrFailed.value = false; });

const onlineTeams = computed(() => (presence.value.teams || []).filter((t) => t.online));
const offlineTeams = computed(() => (presence.value.teams || []).filter((t) => !t.online));

/* ---------- 课堂环节：大屏按环节切换内容 ---------- */
const phase = computed(() => CI.classroom.phase(store.state));
const PHASES = [
  { key: 'idle', label: '待机', hint: '大屏显示房间号与二维码，等学生入座' },
  { key: 'rollcall', label: '随机点名', hint: '大屏放大显示被点到的同学' },
  { key: 'question', label: '出题答题', hint: '大屏显示题干与选项，学生端可作答' },
  { key: 'review', label: '点评总结', hint: '大屏显示各队答对情况 + 能力雷达与评价' }
];
async function gotoPhase(key: string) {
  if (key === 'rollcall') {
    // 点名环节顺手抽一位，大屏立刻有内容
    // 与点名页同一口径：优先 Rust 核心，回退本地实现
    const res = (await fetchPick()).pick;
    if (res) CI.rollcall.applyPick(res);
    else ElMessage.warning('没有可点名的学生');
  }
  const p = CI.classroom.setPhase(key);
  if (p !== key) ElMessage.warning('没有可用题目，已回到待机');
  else ElMessage.success('已切到「' + (PHASES.find((x) => x.key === p) || {}).label + '」，大屏同步切换');
}

/* ---------- 课堂节奏：计时器 + 签到（大屏/学生端经 meta 快照同步） ---------- */

/** 开始计时：大屏与学生端会显示同一个倒计时（按结束时刻本地渲染） */
function startTimer(seconds: number, label: string) {
  CI.classroom.setTimer(seconds, label);
  ElMessage.success(`已开始 ${seconds} 秒计时（${label}），大屏同步显示`);
}
function stopTimer() {
  CI.classroom.clearTimer();
  ElMessage.info('已停止计时');
}

/** 剩余毫秒（靠 tick 每秒重算）；没在计时为 null */
const timerLeft = computed<number | null>(() => {
  void tick.value;
  const end = store.runtime.timerEndsAt;
  if (!end) return null;
  return Math.max(0, end - Date.now());
});
const timerRunning = computed(() => timerLeft.value !== null);
const timerLabel = computed(() => store.runtime.timerLabel || '');
const timerUrgent = computed(() => timerLeft.value !== null && timerLeft.value <= 10000);
const timerText = computed(() => {
  if (timerLeft.value === null) return '';
  const total = Math.ceil(Math.max(0, timerLeft.value) / 1000);
  return Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0');
});

/** 签到：已入座队伍 / 全部队伍 */
/** 签到：已入座队伍 / 全部队伍（**口径来自领域层**，不在界面重算） */
const checkin = computed<{ seated: number; total: number; rate: number }>(() => {
  void tick.value;
  // 审计发现：这里原来自己用 presence+teams 重算，而 CI.classroom.checkinStats(s)
  // 返回的就是同一个东西 → 命中"界面不重算规则/统计"的硬约定，将来必分叉
  return CI.classroom.checkinStats(store.state) as { seated: number; total: number; rate: number };
});

function toggleAccepting() {  const on = !accepting.value;
  CI.classroom.setAccepting(on);
  ElMessage.success(on ? '已开始接收学生作答' : '已停止接收学生作答');
}
function toggleReveal() {
  const on = !revealed.value;
  CI.classroom.setReveal(on);
  ElMessage.success(on ? '已公布答案' : '已收起答案');
}
function move(delta) {
  const res = CI.classroom.moveQuestion(delta);
  if (res && res.edge) ElMessage.info('已经是第一题/最后一题了');
}
function resolve(p, result) {
  CI.classroom.resolvePending(p.id, result);
  ElMessage.success('已判定');
}
function drop(p) {
  CI.classroom.dropPending(p.id);
  ElMessage.info('已丢弃该提交');
}
function focusBuzz(b) {
  CI.classroom.focusBuzz(b.id);
}
function clearBuzz() { CI.classroom.clearBuzz(); }
function clearFeed() { CI.classroom.clearFeed(); }
async function copyJoin() {
  try { await navigator.clipboard.writeText(joinUrl.value); ElMessage.success('学生端地址已复制'); }
  catch (e) { ElMessage.warning('复制失败，请手动选择'); }
}
function openStage() {
  window.open('/stage?room=' + encodeURIComponent(CI.sync.room()), '_blank');
}
function restore() {
  ElMessageBox.confirm(
    '会用枢纽上的存档**覆盖本机的名单与分数**，确定继续？',
    '从枢纽恢复数据',
    { type: 'warning', confirmButtonText: '恢复', cancelButtonText: '取消' }
  ).then(() => CI.classroom.restoreFromHub())
   .then(() => ElMessage.success('已从枢纽恢复'))
   .catch(() => {});
  ElMessage.success('已从枢纽恢复课堂数据');
}

function teamName(tid) {
  const t = store.teams.find((x) => x.id === tid);
  return t ? t.name : '未知队伍';
}
function studentName(sid) {
  const s = store.students.find((x) => x.id === sid);
  return s ? s.name : '未知学生';
}
function timeAgo(at) {
  const d = Math.max(0, Date.now() - (at || 0));
  if (d < 60000) return Math.round(d / 1000) + ' 秒前';
  return Math.round(d / 60000) + ' 分钟前';
}

/* 空格：公布/收起答案（与旧版一致）；避免和按钮聚焦冲突 */
function onKey(e) {
  const tag = (e.target && e.target.tagName) || '';
  if (/INPUT|TEXTAREA|SELECT/.test(tag)) return;
  if (e.key === ' ') { toggleReveal(); e.preventDefault(); }
  if (e.key === 'ArrowRight' && e.altKey) move(1);
  if (e.key === 'ArrowLeft' && e.altKey) move(-1);
}
onMounted(() => window.addEventListener('keydown', onKey));
onUnmounted(() => { window.removeEventListener('keydown', onKey); clearInterval(timer); });
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h2>课堂协同</h2>
        <div class="desc">
          推题、收作答、抢答、主观题判定都在这一页；学生端与大屏实时同步。
        </div>
      </div>
      <div class="actions">
        <el-button @click="restore">从枢纽恢复数据</el-button>
      </div>
    </div>

    <!-- 上：课堂环节切换 + 当前题与作答控制 -->
    <div class="panel">
      <h3 class="panel-title">
        课堂环节
        <span class="sub">大屏会跟着这个环节切换画面（点评环节显示能力雷达）</span>
      </h3>
      <div class="phase-bar">
        <el-radio-group :model-value="phase" size="large" @change="gotoPhase">
          <el-radio-button v-for="p in PHASES" :key="p.key" :value="p.key">{{ p.label }}</el-radio-button>
        </el-radio-group>
        <span class="phase-hint">{{ (PHASES.find(x => x.key === phase) || {}).hint }}</span>
        <el-button size="small" @click="openStage">打开大屏</el-button>
      </div>
    </div>

    <div class="panel">
      <h3 class="panel-title">
        当前题
        <span class="sub">
          第 {{ progress.index }} / {{ progress.total }} 题 ·
          {{ store.currentQuiz ? store.currentQuiz.name : '未选择试卷' }}
        </span>
      </h3>

      <div class="qhead">
        <div class="qstem">
          <template v-if="currentQ">
            <span class="tier-dot" :style="{ background: (store.tiers.find(t => t.key === currentQ.tier) || {}).color }" />
            {{ currentQ.stem }}
            <span class="qmeta">
              {{ (store.tiers.find(t => t.key === currentQ.tier) || {}).label }} ·
              {{ store.questionPoints(currentQ) }} 分 ·
              {{ CI.grade.typeLabel(currentQ) }}
            </span>
          </template>
          <template v-else>
            <span class="muted">还没有选择题目：先到「试卷中心」组一套题，或从题库勾选加入当前试卷。</span>
          </template>
        </div>
        <div class="qbtns">
          <el-button @click="move(-1)">上一题</el-button>
          <el-button @click="move(1)">下一题</el-button>
          <el-button :type="accepting ? 'warning' : 'primary'" @click="toggleAccepting">
            {{ accepting ? '停止接收作答' : '开始接收作答' }}
          </el-button>
          <el-button :type="revealed ? 'info' : 'success'" @click="toggleReveal">
            {{ revealed ? '收起答案' : '公布答案（空格）' }}
          </el-button>
        </div>
      </div>

      <el-alert
        v-if="!accepting"
        type="info"
        :closable="false"
        show-icon
        style="margin-top: var(--sp-2)"
        title="现在不接收作答：学生端的提交按钮是禁用的。点「开始接收作答」后学生才能提交。"
      />
      <el-alert
        v-else
        type="success"
        :closable="false"
        show-icon
        style="margin-top: var(--sp-2)"
        title="正在接收作答：客观题自动判分并立即加分，主观题进入下方「待确认」。"
      />
    </div>

    <!-- 下：左在线小组，右抢答/待确认/实时流 -->
    <el-row :gutter="14">
      <el-col :xs="24" :md="9">
        <div class="panel">
          <h3 class="panel-title">
            房间与学生
            <el-tag size="small" :type="presence.hostOnline ? 'success' : 'info'" effect="plain">
              {{ presence.hostOnline ? '教师端在线' : '教师端离线' }}
            </el-tag>
          </h3>

          <el-space wrap style="margin-bottom: var(--sp-3)">
            <el-button size="small" @click="copyJoin">复制学生端地址</el-button>
            <el-button size="small" @click="openStage()">打开大屏</el-button>
          </el-space>

          <!-- 课堂节奏：计时器（大屏与学生端会同步显示倒计时） -->
          <div class="timer-row">
            <span class="timer-label">计时器</span>
            <el-space wrap>
              <el-button size="small" @click="startTimer(30, '思考')">30 秒</el-button>
              <el-button size="small" @click="startTimer(60, '随堂练习')">1 分钟</el-button>
              <el-button size="small" @click="startTimer(120, '小组讨论')">2 分钟</el-button>
              <el-button size="small" type="danger" plain :disabled="!timerRunning" @click="stopTimer()">停止</el-button>
            </el-space>
            <el-tag v-if="timerRunning" size="small" :type="timerUrgent ? 'danger' : 'primary'" effect="dark">
              ⏱ {{ timerText }}<template v-if="timerLabel"> · {{ timerLabel }}</template>
            </el-tag>
          </div>

          <!-- 签到：已入座队伍 / 全部队伍 -->
          <div class="checkin-row">
            <span class="timer-label">签到</span>
            <el-tag size="small" :type="checkin.rate >= 100 ? 'success' : (checkin.rate > 0 ? 'warning' : 'info')" effect="plain">
              {{ checkin.seated }} / {{ checkin.total }} 队已入座（{{ checkin.rate }}%）
            </el-tag>
          </div>
          <div class="join">{{ joinUrl }}</div>

          <div class="qr-wrap">
            <img v-if="qrUrl && !qrFailed" :src="qrUrl" class="qr" alt="学生端二维码" @error="qrFailed = true" />
            <div v-else class="qr-tip">
              客户端里没有二维码图片：请把上面的地址发到班级群，或让学生手输（只写 IP 也会自动补 8080）。
            </div>
          </div>

          <h4 class="sub-title">在线小组（{{ onlineTeams.length }} / {{ presence.teams.length || 0 }}）</h4>
          <div v-for="t in onlineTeams" :key="t.teamId" class="presence-row online">
            <span class="dot-ok" />{{ t.label }}
            <span class="ago">{{ timeAgo(t.at) }}</span>
          </div>
          <div v-for="t in offlineTeams" :key="t.teamId" class="presence-row">
            <span class="dot-off" />{{ t.label }}
            <span class="ago">未在线</span>
          </div>
          <div v-if="!presence.teams.length" class="empty-hint">还没有学生入座</div>
        </div>
      </el-col>

      <el-col :xs="24" :md="15">
        <div class="panel">
          <h3 class="panel-title">
            抢答榜
            <span class="sub">
              <el-button size="small" text @click="clearBuzz">清空抢答榜</el-button>
            </span>
          </h3>
          <div v-for="b in box.buzz.slice(0, 6)" :key="b.id" class="buzz-row">
            <span class="buzz-team">{{ teamName(b.teamId) }}</span>
            <span class="buzz-who">{{ studentName(b.sid) }}</span>
            <span class="ago">{{ timeAgo(b.at) }}</span>
            <el-button size="small" text @click="focusBuzz(b)">设为学生端当前</el-button>
          </div>
          <div v-if="!box.buzz.length" class="empty-hint">还没有人抢答</div>
        </div>

        <div class="panel">
          <h3 class="panel-title">
            待确认提交（主观题）
            <el-tag v-if="box.pending.length" type="warning" size="small">{{ box.pending.length }} 条待判</el-tag>
          </h3>
          <div v-for="p in box.pending" :key="p.id" class="pending-row">
            <div class="pend-main">
              <b>{{ studentName(p.sid) }}</b>
              <span class="team">{{ teamName(p.teamId) }}</span>
              <span class="ago">{{ timeAgo(p.at) }}</span>
            </div>
            <div class="pend-body">{{ p.submission && (p.submission.text || p.submission.choice) ? (p.submission.text || p.submission.choice) : '（空）' }}</div>
            <div class="pend-ops">
              <el-button size="small" type="success" @click="resolve(p, 'correct')">答对</el-button>
              <el-button size="small" type="warning" @click="resolve(p, 'half')">半对</el-button>
              <el-button size="small" type="danger" @click="resolve(p, 'wrong')">答错</el-button>
              <el-button size="small" @click="drop(p)">丢弃</el-button>
            </div>
          </div>
          <div v-if="!box.pending.length" class="empty-hint">没有待确认的提交</div>
        </div>

        <div class="panel">
          <h3 class="panel-title">
            实时流
            <span class="sub"><el-button size="small" text @click="clearFeed">清空</el-button></span>
          </h3>
          <div class="feed">
            <div v-for="f in box.feed.slice(0, 20)" :key="f.id" class="feed-row" :class="'k-' + (f.kind || '')">
              <span class="feed-text">{{ f.text }}</span>
              <span class="ago">{{ timeAgo(f.at) }}</span>
            </div>
          </div>
          <div v-if="!box.feed.length" class="empty-hint">还没有动态</div>
        </div>
      </el-col>
    </el-row>
  </div>
</template>

<style scoped>
.phase-bar { display: flex; align-items: center; gap: var(--sp-4); flex-wrap: wrap; }
.phase-hint { color: var(--ci-text-weak); font-size: var(--fs-sm); }
.qhead { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--sp-4); flex-wrap: wrap; }
.qstem { font-size: var(--fs-base); line-height: 1.7; flex: 1; min-width: 280px; }
.qmeta { color: var(--ci-text-weak); font-size: var(--fs-xs); margin-left: var(--sp-2); }
.qbtns { display: flex; gap: var(--sp-2); flex-wrap: wrap; }
.muted { color: var(--ci-text-weak); }
.join { font-family: ui-monospace, Consolas, monospace; font-size: var(--fs-xs); color: #334155; word-break: break-all; margin-bottom: var(--sp-2); }
/* 课堂节奏：计时器与签到 */
.timer-row, .checkin-row { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; margin-bottom: var(--sp-2); }
.timer-label { font-size: var(--fs-xs); color: var(--el-text-color-secondary); flex: none; }
.qr-wrap { margin-bottom: var(--sp-3); }
.qr { width: 160px; height: 160px; image-rendering: pixelated; }
.qr-tip { color: var(--ci-text-weak); font-size: var(--fs-xs); line-height: 1.8; background: #fbfbfd; border: 1px dashed var(--ci-line); border-radius: var(--radius); padding: var(--sp-2); }
.sub-title { margin: var(--sp-3) 0 var(--sp-2); font-size: var(--fs-sm); color: var(--ci-text-weak); font-weight: 600; }
.presence-row { display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-2) 0; font-size: var(--fs-sm); border-bottom: 1px dashed var(--ci-line); }
.presence-row .ago { margin-left: auto; color: var(--ci-text-weak); font-size: var(--fs-xs); }
.dot-ok, .dot-off { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
.dot-ok { background: var(--ci-ok); }
.dot-off { background: #cbd5e1; }
.buzz-row { display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-2) 0; border-bottom: 1px dashed var(--ci-line); font-size: var(--fs-sm); }
.buzz-team { font-weight: 600; }
.buzz-who { color: var(--ci-text-weak); }
.buzz-row .ago, .pend-main .ago { margin-left: auto; color: var(--ci-text-weak); font-size: var(--fs-xs); }
.pending-row { padding: var(--sp-2) 0; border-bottom: 1px dashed var(--ci-line); }
.pend-main { display: flex; align-items: center; gap: var(--sp-2); font-size: var(--fs-sm); }
.pend-main .team { color: var(--ci-text-weak); }
.pend-body { margin: var(--sp-2) 0; font-size: var(--fs-sm); background: #f8fafc; border-radius: var(--radius); padding: var(--sp-2) var(--sp-2); white-space: pre-wrap; }
.pend-ops { display: flex; gap: var(--sp-2); flex-wrap: wrap; }
.feed { max-height: 320px; overflow: auto; }
.feed-row { display: flex; gap: var(--sp-2); padding: var(--sp-1) 0; font-size: var(--fs-sm); border-bottom: 1px dashed var(--ci-line); }
.feed-row .ago { margin-left: auto; color: var(--ci-text-weak); font-size: var(--fs-xs); white-space: nowrap; }
.k-answer .feed-text { color: #0f766e; }
.k-buzz .feed-text { color: #b45309; }
.k-system .feed-text { color: #6b7280; }
</style>
