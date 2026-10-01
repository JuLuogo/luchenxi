<script setup>
/**
 * 教室大屏（只读）· 浅色主题
 *
 * 设计参考（成熟案例）：
 *   · Kahoot：浅色底 + 超大题干 + **四色选项块**（投影可读性最好），待机页超大二维码
 *   · 班级优化大师/希沃：**置顶光荣榜实时刷新**、随机抽选、多维度评价
 *   · ClassDojo：大色块徽章、鼓励式文案
 *
 * 按课堂环节切换四屏：待机 / 随机点名 / 出题作答 / 点评总结
 */
import { computed, onMounted, onUnmounted, ref } from 'vue';
import StageRadar from './StageRadar.vue';

const state = ref(null);
const status = ref('连接中…');
const connected = ref(false);
const tick = ref(0);
let timer = null;
let ws = null;
let retry = 0;

const ROOM = (() => {
  try {
    const qs = new URLSearchParams(location.search);
    return qs.get('room') || localStorage.getItem('ci_room') || 'default';
  } catch (e) { return 'default'; }
})();
const HOST = (() => {
  try {
    const qs = new URLSearchParams(location.search);
    const h = qs.get('ws') || localStorage.getItem('ci_ws_host') || '';
    if (h) return h;
    if (location.protocol === 'http:' || location.protocol === 'https:') return location.host;
    return 'localhost:8080';
  } catch (e) { return 'localhost:8080'; }
})();

function connect() {
  try { ws = new WebSocket('ws://' + HOST + '/?room=' + encodeURIComponent(ROOM) + '&role=stage'); }
  catch (e) { status.value = '地址无效：' + e.message; return; }
  ws.onopen = () => { connected.value = true; status.value = '已连接 ' + HOST; retry = 0; };
  ws.onclose = () => {
    connected.value = false;
    retry += 1;
    status.value = '已断开，' + Math.min(5, retry) + ' 秒后重连…';
    setTimeout(connect, Math.min(5000, 800 * retry));
  };
  ws.onerror = () => { status.value = '连接异常'; };
  ws.onmessage = (ev) => {
    let msg = null;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (msg.type === 'welcome') status.value = '已连接 · 房间 ' + (msg.room || ROOM);
    if (msg.type === 'state' && msg.payload) state.value = msg.payload;
  };
}

const meta = computed(() => (state.value && state.value.meta) || {});
const phase = computed(() => meta.value.phase || 'idle');
/**
 * 题目在快照的 meta 里（sync.snapshot 的 meta.question），不在顶层。
 * 之前读 state.question 导致"出题作答"环节一直显示"还没有选择题目"——留顶层兜底以防旧数据。
 */
const question = computed(() => meta.value.question || (state.value && state.value.question) || null);
const teams = computed(() => ((state.value && state.value.teams) || []).slice().sort((a, b) => b.score - a.score));
const students = computed(() => ((state.value && state.value.students) || []).slice().sort((a, b) => b.score - a.score));
const teamStats = computed(() => (meta.value.teamStats || []).filter((t) => t.teamId !== 'all'));
const ability = computed(() => meta.value.ability || null);
const buzz = computed(() => (meta.value.buzz || []).slice(0, 5));
const courseName = computed(() => (state.value && state.value.courseName) || '课堂积分');
const revealed = computed(() => !!meta.value.reveal);
const joinUrl = computed(() => 'http://' + HOST + '/join?room=' + encodeURIComponent(ROOM));
const qrUrl = computed(() => 'http://' + HOST + '/qr.png?text=' + encodeURIComponent(joinUrl.value));
const qrFailed = ref(false);

const phaseTitle = computed(() => ({
  idle: '等待上课', rollcall: '随机点名', question: '出题 · 作答', review: '点评总结'
}[phase.value] || '等待上课'));

/** Kahoot 式选项配色：A 红 / B 蓝 / C 黄 / D 绿，>4 个则循环 */
const OPT_COLORS = ['var(--opt-a)', 'var(--opt-b)', 'var(--opt-c)', 'var(--opt-d)'];
const OPT_SHAPES = ['▲', '◆', '●', '■'];
function optColor(i) { return OPT_COLORS[i % OPT_COLORS.length]; }
function optShape(i) { return OPT_SHAPES[i % OPT_SHAPES.length]; }

function timeText() { return new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }); }

onMounted(() => { connect(); timer = setInterval(() => { tick.value += 1; }, 5000); });
onUnmounted(() => { if (timer) clearInterval(timer); if (ws) ws.close(); });
</script>

<template>
  <div class="stage" :class="'ph-' + phase">
    <header class="bar">
      <div class="left">
        <span class="logo">课</span>
        <span class="course">{{ courseName }}</span>
        <span class="phase-pill">{{ phaseTitle }}</span>
      </div>
      <div class="right">
        <span class="chip">房间 <b>{{ ROOM }}</b></span>
        <span class="chip">{{ timeText() }}</span>
        <span class="dot" :class="{ ok: connected }" />
      </div>
    </header>

    <!-- ① 待机：超大二维码 + 已入座（Kahoot lobby 式） -->
    <main v-if="phase === 'idle'" class="body idle">
      <section class="lobby">
        <div class="lobby-title">扫码入座</div>
        <div class="lobby-sub">学生手机浏览器打开，或扫右边二维码</div>
        <div class="join-url">{{ joinUrl }}</div>
        <div class="seats">
          <div v-for="t in teams" :key="t.id" class="seat" :style="{ borderColor: t.color }">
            <span class="seat-dot" :style="{ background: t.color }" />
            <span class="seat-name">{{ t.name }}</span>
            <span class="seat-members">{{ t.memberCount }} 人</span>
            <span class="seat-score">{{ t.score }}<i>分</i></span>
          </div>
          <div v-if="!teams.length" class="empty">教师端还没有建队伍</div>
        </div>
      </section>
      <aside class="qr-box">
        <img v-if="!qrFailed" class="qr" :src="qrUrl" alt="学生端二维码" @error="qrFailed = true" />
        <div v-else class="qr-tip">二维码不可用<br />请把左侧地址发到班级群</div>
      </aside>
    </main>

    <!-- ② 随机点名：超大姓名（教室最后一排也看得清） -->
    <main v-else-if="phase === 'rollcall'" class="body rollcall">
      <div class="roll-label">请这位同学回答</div>
      <div class="roll-name">{{ meta.sidName || '等待点名…' }}</div>
      <div class="roll-meta">
        <span v-if="meta.sidTeamName" class="team-badge">{{ meta.sidTeamName }}</span>
        <span v-if="meta.sidCalled" class="roll-called">今天已被点到 {{ meta.sidCalled }} 次</span>
      </div>
      <div class="roll-hint">教师端：<span class="kbd">1</span> 答对 · <span class="kbd">2</span> 半对 · <span class="kbd">3</span> 答错 · <span class="kbd">4</span> 跳过</div>
    </main>

    <!-- ③ 出题答题：Kahoot 式四色选项 -->
    <main v-else-if="phase === 'question'" class="body question">
      <section class="q-main">
        <div class="q-tier" v-if="question">
          <span class="tier-pill">{{ question.tierLabel }}</span>
          <span class="tier-pts">{{ question.points }} 分</span>
          <span class="tier-type">{{ question.typeLabel }}</span>
        </div>
        <div class="q-stem">{{ question ? question.fullStem : '教师端还没有选择题目' }}</div>
        <div v-if="question && question.options.length" class="q-options" :class="{ many: question.options.length > 4 }">
          <div
            v-for="(o, i) in question.options"
            :key="o.key"
            class="q-option"
            :style="{ background: optColor(i) }"
          >
            <span class="opt-shape">{{ optShape(i) }}</span>
            <span class="opt-key">{{ o.key }}</span>
            <span class="opt-text">{{ o.text }}</span>
          </div>
        </div>
        <div v-else-if="question" class="q-fill">
          {{ question.type === 'subjective' ? '主观题：请口头作答，老师判定' : '填空题：请写出答案' }}
        </div>
        <div v-if="question && revealed" class="q-answer">正确答案：<b>{{ question.answerKey || '（见教师端）' }}</b></div>
      </section>
      <aside class="q-side">
        <div class="side-title">⚡ 抢答榜</div>
        <div v-for="(b, i) in buzz" :key="b.id" class="buzz-row">
          <span class="buzz-rank">{{ i + 1 }}</span>
          <span class="buzz-team">{{ b.teamName }}</span>
          <span class="buzz-who">{{ b.sidName }}</span>
        </div>
        <div v-if="!buzz.length" class="empty">还没有人抢答</div>
        <div class="side-title mt">🏆 实时积分</div>
        <div v-for="t in teams.slice(0, 5)" :key="t.id" class="score-row">
          <span class="seat-dot" :style="{ background: t.color }" />
          <span class="score-name">{{ t.name }}</span>
          <span class="score-val">{{ t.score }}</span>
        </div>
      </aside>
    </main>

    <!-- ④ 点评总结：各队答对 + 能力雷达（浅色） -->
    <main v-else class="body review">
      <section class="rev-left">
        <div class="side-title">各队答题情况</div>
        <div v-for="t in teamStats" :key="t.teamId" class="rev-team">
          <span class="seat-dot" :style="{ background: t.color }" />
          <span class="rev-name">{{ t.name }}</span>
          <span class="rev-correct">答对 {{ t.correct }}</span>
          <span class="rev-attempts">/ {{ t.attempts }} 次</span>
          <span class="rev-rate">{{ Math.round(t.creditRate) }}%</span>
        </div>
        <div v-if="!teamStats.length" class="empty">还没有作答数据</div>

        <div class="side-title mt">🏆 光荣榜</div>
        <div v-for="(s, i) in students.slice(0, 6)" :key="s.id" class="stu-row">
          <span class="stu-rank" :class="'r' + (i + 1)">{{ i + 1 }}</span>
          <span class="stu-name">{{ s.name }}</span>
          <span class="stu-team">{{ s.teamName }}</span>
          <span class="stu-score">{{ s.score }}</span>
        </div>
      </section>
      <section class="rev-right">
        <StageRadar v-if="ability" :ability="ability" />
      </section>
    </main>

    <footer class="foot">
      <span>{{ status }}</span>
      <span v-if="state && state.updatedAt">最后更新 {{ new Date(state.updatedAt).toLocaleTimeString('zh-CN') }}</span>
    </footer>
  </div>
</template>

<style scoped>
.stage {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  background:
    radial-gradient(1200px 600px at 12% -10%, #eef2ff 0%, transparent 60%),
    radial-gradient(900px 500px at 100% 0%, #f0fdf9 0%, transparent 55%),
    var(--c-bg);
  color: var(--c-text);
}

/* 顶栏：细边框 + 中性色（现代后台观感） */
.bar {
  display: flex; align-items: center; justify-content: space-between;
  padding: 12px 32px; background: rgb(255 255 255 / 88%);
  border-bottom: 1px solid var(--c-line); backdrop-filter: blur(8px);
}
.bar .left, .bar .right { display: flex; align-items: center; gap: 14px; }
.logo {
  width: 34px; height: 34px; border-radius: 10px; background: var(--c-brand); color: #fff;
  display: grid; place-items: center; font-weight: 800;
}
.course { font-size: 22px; font-weight: 700; letter-spacing: .3px; }
.phase-pill {
  padding: 4px 14px; border-radius: 999px; font-size: 15px; font-weight: 600;
  color: var(--c-brand); background: var(--c-brand-weak); border: 1px solid #dcdcfb;
}
.chip {
  font-size: 14px; color: var(--c-text-2); background: #fff;
  border: 1px solid var(--c-line); border-radius: 999px; padding: 4px 12px;
}
.chip b { color: var(--c-text); }
.dot { width: 10px; height: 10px; border-radius: 50%; background: var(--c-bad); }
.dot.ok { background: var(--c-ok); }

.body { flex: 1; padding: 26px 32px; overflow: hidden; }
.empty { color: var(--c-text-3); padding: 12px 0; font-size: 16px; }
.mt { margin-top: 20px; }
.side-title { font-size: 15px; font-weight: 700; color: var(--c-text-2); margin-bottom: 10px; }
.seat-dot { width: 12px; height: 12px; border-radius: 50%; display: inline-block; flex: none; }
.kbd {
  padding: 1px 7px; border: 1px solid var(--c-line-strong); border-bottom-width: 2px;
  border-radius: 6px; background: #fff; font-family: ui-monospace, monospace; font-size: 14px;
}

/* ① 待机 */
.idle { display: grid; grid-template-columns: 1fr 460px; gap: 36px; align-items: center; }
.lobby-title { font-size: 46px; font-weight: 800; letter-spacing: 2px; }
.lobby-sub { color: var(--c-text-2); font-size: 17px; margin: 8px 0 18px; }
.join-url {
  display: inline-block; font-family: ui-monospace, Consolas, monospace; font-size: 26px;
  color: var(--c-brand); background: #fff; border: 1px solid #dcdcfb;
  border-radius: var(--r-md); padding: 10px 18px; margin-bottom: 24px;
}
.seats { display: grid; gap: 12px; max-width: 720px; }
.seat {
  display: flex; align-items: center; gap: 14px; background: #fff;
  border: 1px solid var(--c-line); border-left: 6px solid var(--c-brand);
  border-radius: var(--r-md); padding: 14px 18px; font-size: 22px; box-shadow: var(--sh-1);
}
.seat-name { font-weight: 700; }
.seat-members { color: var(--c-text-3); font-size: 15px; }
.seat-score { margin-left: auto; font-size: 28px; font-weight: 800; font-variant-numeric: tabular-nums; }
.seat-score i { font-size: 13px; font-style: normal; color: var(--c-text-3); margin-left: 4px; }
.qr-box { display: grid; place-items: center; }
.qr { width: 100%; max-width: 420px; background: #fff; padding: 14px; border-radius: var(--r-lg); box-shadow: var(--sh-2); }
.qr-tip { color: var(--c-text-2); text-align: center; line-height: 1.9; }

/* ② 点名 */
.rollcall { display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; }
.roll-label { font-size: 28px; color: var(--c-text-2); letter-spacing: 8px; }
.roll-name {
  font-size: 150px; font-weight: 900; letter-spacing: 14px; line-height: 1.1; margin: 10px 0 20px;
  background: linear-gradient(180deg, #1a1d24 0%, #4f46e5 120%);
  -webkit-background-clip: text; background-clip: text; color: transparent;
}
.roll-meta { display: flex; align-items: center; gap: 18px; font-size: 24px; color: var(--c-text-2); }
.team-badge {
  padding: 6px 20px; border-radius: 999px; background: var(--c-brand-weak);
  color: var(--c-brand); font-weight: 700; border: 1px solid #dcdcfb;
}
.roll-hint { margin-top: 36px; color: var(--c-text-3); font-size: 18px; }

/* ③ 出题：Kahoot 式四色选项块 */
.question { display: grid; grid-template-columns: 1fr 320px; gap: 30px; }
.q-tier { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
.tier-pill {
  padding: 4px 14px; border-radius: 999px; font-size: 16px; font-weight: 600;
  background: var(--c-ok-weak); color: var(--c-ok); border: 1px solid #bfe9d8;
}
.tier-pts { color: var(--c-warn); font-size: 19px; font-weight: 800; }
.tier-type { color: var(--c-text-3); font-size: 15px; }
.q-stem { font-size: 46px; font-weight: 800; line-height: 1.4; margin-bottom: 26px; }
.q-options { display: grid; grid-template-columns: repeat(2, 1fr); grid-auto-rows: minmax(112px, auto); gap: 18px; }
.q-options.many { grid-template-columns: repeat(3, 1fr); }
.q-option {
  display: flex; align-items: center; gap: 16px; color: #fff;
  border-radius: var(--r-xl); padding: 20px 24px; font-size: 30px; font-weight: 800;
  box-shadow: var(--sh-2); min-height: 112px;
}
.opt-shape { font-size: 20px; opacity: .9; }
.opt-key {
  width: 40px; height: 40px; border-radius: 10px; background: rgb(255 255 255 / 22%);
  display: grid; place-items: center; font-weight: 900; flex: none;
}
.opt-text { line-height: 1.3; }
.q-fill { font-size: 26px; color: var(--c-text-2); }
.q-answer { margin-top: 22px; font-size: 30px; font-weight: 800; color: var(--c-ok); }
.q-side { border-left: 1px solid var(--c-line); padding-left: 24px; }
.buzz-row, .score-row { display: flex; align-items: center; gap: 10px; font-size: 19px; padding: 8px 0; }
.buzz-rank {
  width: 28px; height: 28px; border-radius: 9px; background: var(--c-warn-weak);
  color: var(--c-warn); display: grid; place-items: center; font-size: 14px; font-weight: 700;
}
.buzz-team { font-weight: 700; }
.buzz-who { color: var(--c-text-3); font-size: 16px; }
.score-name { font-weight: 600; }
.score-val { margin-left: auto; font-weight: 800; font-variant-numeric: tabular-nums; }

/* ④ 点评 */
.review { display: grid; grid-template-columns: 400px 1fr; gap: 30px; }
.rev-team {
  display: flex; align-items: center; gap: 12px; background: #fff; border: 1px solid var(--c-line);
  border-radius: var(--r-md); padding: 12px 16px; margin-bottom: 10px; font-size: 21px; box-shadow: var(--sh-1);
}
.rev-name { font-weight: 700; }
.rev-correct { margin-left: auto; color: var(--c-ok); font-weight: 800; }
.rev-attempts { color: var(--c-text-3); font-size: 16px; }
.rev-rate { width: 64px; text-align: right; color: var(--c-text-2); font-variant-numeric: tabular-nums; }
.stu-row { display: flex; align-items: center; gap: 12px; font-size: 20px; padding: 9px 0; }
.stu-rank {
  width: 28px; height: 28px; border-radius: 9px; background: var(--c-surface-2);
  color: var(--c-text-2); display: grid; place-items: center; font-size: 14px; font-weight: 700;
}
.stu-rank.r1 { background: #fff4d6; color: #a16207; }
.stu-rank.r2 { background: #eef2f7; color: #475569; }
.stu-rank.r3 { background: #fdeee2; color: #b45309; }
.stu-team { color: var(--c-text-3); font-size: 15px; }
.stu-score { margin-left: auto; font-weight: 800; font-variant-numeric: tabular-nums; }
.rev-right { min-width: 0; display: flex; flex-direction: column; }

.foot {
  display: flex; justify-content: space-between; padding: 8px 32px;
  border-top: 1px solid var(--c-line); color: var(--c-text-3); font-size: 13px; background: #fff;
}
</style>
