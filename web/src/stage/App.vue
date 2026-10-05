<script setup lang="ts">
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

const state = ref<any>(null);
const status = ref('连接中…');
const connected = ref(false);
const tick = ref(0);
/** 定时器与连接：显式标注可空，避免 TS 把 null 推断成 never */
let timer: ReturnType<typeof setInterval> | null = null;
let ws: WebSocket | null = null;
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
  let sock: WebSocket;
  try { sock = new WebSocket('ws://' + HOST + '/?room=' + encodeURIComponent(ROOM) + '&role=stage'); }
  catch (e) { status.value = '地址无效：' + (e as Error).message; return; }
  ws = sock;
  sock.onopen = () => { connected.value = true; status.value = '已连接 ' + HOST; retry = 0; };
  sock.onclose = () => {
    connected.value = false;
    retry += 1;
    status.value = '已断开，' + Math.min(5, retry) + ' 秒后重连…';
    setTimeout(connect, Math.min(5000, 800 * retry));
  };
  sock.onerror = () => { status.value = '连接异常'; };
  sock.onmessage = (ev) => {
    let msg: any = null;
    try { msg = JSON.parse(String(ev.data)); } catch (e) { return; }
    if (!msg) return;
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
const teams = computed<any[]>(() => ((state.value && state.value.teams) || []).slice().sort((a, b) => b.score - a.score));
// 注：原来这里算了一份按积分排序的学生名单（光荣榜用）；2026-10 去掉个人排名后不再需要。
/**
 * 这次评价能不能公开
 *
 * **由教师端用领域层算好后随快照下发**（meta.openEvalPublic）—— 大屏不重写判断规则，
 * 否则换三档/五档时大屏会与教师端不一致。
 */
const evalPublic = computed<boolean>(() => !!meta.value.openEvalPublic);

const teamStats = computed<any[]>(() => (meta.value.teamStats || []).filter((t) => t.teamId !== 'all'));
const ability = computed(() => meta.value.ability || null);
const buzz = computed<any[]>(() => (meta.value.buzz || []).slice(0, 5));
const courseName = computed(() => (state.value && state.value.courseName) || '课堂积分');
const revealed = computed(() => !!meta.value.reveal);
const joinUrl = computed(() => 'http://' + HOST + '/join?room=' + encodeURIComponent(ROOM));
const qrUrl = computed(() => 'http://' + HOST + '/qr.png?text=' + encodeURIComponent(joinUrl.value));
const qrFailed = ref(false);

/* ---------- 课堂节奏：签到率 + 倒计时 ---------- */

/** 签到：已入座队伍 / 全部队伍（教师端在 meta 里算好） */
const checkin = computed<{ seated: number; total: number; rate: number }>(
  () => meta.value.checkin || { seated: 0, total: 0, rate: 0 }
);

/** 剩余毫秒：靠 tick 每秒重算；没在计时为 null */
const timerLeft = computed<number | null>(() => {
  void tick.value;
  const end = meta.value.timerEndsAt;
  if (!end) return null;
  return Math.max(0, end - Date.now());
});

function formatLeft(ms: number): string {
  const total = Math.ceil(Math.max(0, ms) / 1000);
  return Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0');
}

const timerText = computed(() => (timerLeft.value === null ? '' : formatLeft(timerLeft.value)));
/** 最后 10 秒变红，提醒学生收尾 */
const timerUrgent = computed(() => timerLeft.value !== null && timerLeft.value <= 10000);

/** 讲评建议：正确率最低的几道题（教师端在 meta 里算好，点评环节显示） */
const hardest = computed<any[]>(() => meta.value.hardestQuestions || []);

const phaseTitle = computed(() => ({
  idle: '等待上课', rollcall: '随机点名', question: '出题 · 作答', review: '点评总结'
}[phase.value] || '等待上课'));

/** Kahoot 式选项配色：A 红 / B 蓝 / C 黄 / D 绿，>4 个则循环 */
const OPT_COLORS = ['var(--opt-a)', 'var(--opt-b)', 'var(--opt-c)', 'var(--opt-d)'];
const OPT_SHAPES = ['▲', '◆', '●', '■'];
function optColor(i) { return OPT_COLORS[i % OPT_COLORS.length]; }
function optShape(i) { return OPT_SHAPES[i % OPT_SHAPES.length]; }

function timeText() { return new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }); }

onMounted(() => { connect(); timer = setInterval(() => { tick.value += 1; }, 1000); });
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
        <!-- 课堂计时器：老师投的倒计时，本地按结束时刻渲染（断网照走） -->
        <span v-if="timerText" class="chip timer" :class="{ urgent: timerUrgent }">
          ⏱ {{ timerText }}<b v-if="meta.timerLabel"> · {{ meta.timerLabel }}</b>
        </span>
        <span v-if="checkin.total" class="chip">签到 <b>{{ checkin.seated }}/{{ checkin.total }}</b></span>
        <span class="chip">房间 <b>{{ ROOM }}</b></span>
        <span class="chip">{{ timeText() }}</span>
        <span class="dot" :class="{ ok: connected }" />
      </div>
    </header>

    <!-- ① 待机：超大二维码 + 已入座（Kahoot lobby 式） -->
        <!-- 公开课：被点到的同学放大显示 + 现场评价（大屏是公开课最该亮的地方） -->
        <div v-if="meta.open" class="open-block">
          <div class="open-who">
            <span class="open-tag">公开课</span>
            <span class="open-name">{{ meta.open.name || '—' }}</span>
            <span v-if="meta.open.verdict" class="open-verdict" :class="'v-' + meta.open.verdict">
              {{ meta.open.verdict === 'correct' ? '全对' : (meta.open.verdict === 'half' ? '对一半' : '不对') }}
            </span>
          </div>
          <!--
            公开表扬、私下改进：默认只在"良好/优秀"时把评价放到大屏；
            合格/待改进只发给学生自己的设备（调研：公开"待改进"会让垫底的学生抵触）。
            策略由 settings.openEvalOnStage 决定（smart / always / never）。
          -->
          <div v-if="meta.open.evaluation && evalPublic" class="open-eval">
            <span class="open-score">{{ meta.open.evaluation.total }} 分 · {{ meta.open.evaluation.level }}</span>
            <span class="open-comment">{{ meta.open.evaluation.comment }}</span>
          </div>
          <div v-else-if="meta.open.evaluation && !evalPublic" class="open-eval muted">
            评价已记录（按当前策略不公开；学生自己的设备上能看到）
          </div>
        </div>

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
        <img v-if="question && question.imageUrl" class="q-image" :src="question.imageUrl" alt="题目配图" />
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
        <div v-if="question && revealed" class="q-answer">
          正确答案：<b>{{ question.answerKey || '（见教师端）' }}</b>
          <!-- 讲评要点/易错点（题目 note）：公布答案后一并显示，老师照着讲 -->
          <div v-if="question.explanation" class="q-why">💡 {{ question.explanation }}</div>
        </div>
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

        <!--
          这里原来是「🏆 光荣榜」（个人积分前 6 名）。2026-10 按调研结论**去掉个人排名**：
          公开的个人排名有实证风险（国内教师反馈"垫底的学生每次抬头就看见自己名字在最后面，
          逐渐产生抵触心理"；国外 n=176 的真实课堂里 16% 学生因速度计分与公开排名退出评价）。
          个人成绩只发给学生自己的手机；大屏改为显示**全班分布**（见右侧选项分布与各队对比）。
        -->

        <div v-if="meta.optionDist && meta.optionDist.length" class="side-title mt">📊 本题选项分布</div>
        <div v-for="o in meta.optionDist" :key="o.key" class="opt-row">
          <span class="opt-key" :class="{ right: o.correct }">{{ o.key }}</span>
          <span class="opt-bar"><span class="opt-fill" :class="{ right: o.correct }" :style="{ width: o.rate + '%' }" /></span>
          <span class="opt-rate">{{ o.rate }}%</span>
          <span class="opt-text">{{ o.text }}</span>
        </div>
      </section>
      <section class="rev-right">
        <StageRadar v-if="ability" :ability="ability" />
      </section>
    </main>

    <!-- 点评环节的「讲评建议」：正确率最低的几道题（老师照着讲） -->
    <aside v-if="phase === 'review' && hardest.length" class="review-tips">
      <div class="tips-title">📌 讲评建议（按正确率从低到高）</div>
      <div v-for="(q, i) in hardest" :key="q.qid" class="tip-row">
        <span class="tip-rank">{{ i + 1 }}</span>
        <span class="tip-stem">{{ q.stem }}</span>
        <span class="tip-tier">{{ q.tierLabel }}</span>
        <span class="tip-rate" :class="{ bad: q.correctRate < 40, warn: q.correctRate < 70 }">
          {{ q.correctRate }}%
        </span>
        <span class="tip-detail">{{ q.attempts }} 人作答 · {{ q.missCount }} 人未答对</span>
        <!-- 审计发现：这里原来把"没答对的学生姓名"投在墙上（`q.missers.join`）——
             与本文件第 270 行的结论自相矛盾（公开点名比排名更伤人）。
             现在只显示人数；姓名留给教师机（学生看不到老师的屏幕）。 -->
      </div>
    </aside>

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
    radial-gradient(1200px 600px at 12% -10%, var(--c-brand-weak) 0%, transparent 60%),
    radial-gradient(900px 500px at 100% 0%, #f0fdf9 0%, transparent 55%),
    var(--c-bg);
  color: var(--c-text);
}

/* 顶栏：细边框 + 中性色（现代后台观感） */
.bar {
  display: flex; align-items: center; justify-content: space-between;
  padding: var(--sp-3) var(--sp-6); background: rgb(255 255 255 / 88%);
  border-bottom: 1px solid var(--c-line); backdrop-filter: blur(8px);
}
.bar .left, .bar .right { display: flex; align-items: center; gap: var(--sp-4); }
.logo {
  width: 34px; height: 34px; border-radius: var(--radius); background: var(--c-brand); color: var(--c-surface);
  display: grid; place-items: center; font-weight: 800;
}
.course { font-size: clamp(18px, 2.6vmin, 24px); font-weight: 700; letter-spacing: .3px; }
.phase-pill {
  padding: var(--sp-1) var(--sp-4); border-radius: 999px; font-size: var(--fs-base); font-weight: 600;
  color: var(--c-brand); background: var(--c-brand-weak); border: 1px solid #dcdcfb;
}
.chip {
  font-size: var(--fs-sm); color: var(--c-text-2); background: var(--c-surface);
  border: 1px solid var(--c-line); border-radius: 999px; padding: var(--sp-1) var(--sp-3);
}
.chip b { color: var(--c-text); }
/* 课堂计时器：正常蓝色，最后 10 秒变红并轻微呼吸 */
.chip.timer {
  font-variant-numeric: tabular-nums; font-weight: 700; letter-spacing: .5px;
  color: #1d4ed8; background: var(--c-brand-weak); border-color: #c7d2fe;
}
.chip.timer.urgent { color: var(--c-surface); background: var(--c-bad); border-color: var(--c-bad); animation: pulse 1s ease-in-out infinite; }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .72; } }
.dot { width: 10px; height: 10px; border-radius: 50%; background: var(--c-bad); }
.dot.ok { background: var(--c-ok); }

.body { flex: 1; padding: var(--sp-5) var(--sp-6); overflow: hidden; }
.empty { color: var(--c-text-3); padding: var(--sp-3) 0; font-size: var(--fs-base); }
.mt { margin-top: var(--sp-4); }
.side-title { font-size: var(--fs-base); font-weight: 700; color: var(--c-text-2); margin-bottom: var(--sp-2); }
.seat-dot { width: 12px; height: 12px; border-radius: 50%; display: inline-block; flex: none; }
.kbd {
  padding: var(--sp-1) var(--sp-2); border: 1px solid var(--c-line-strong); border-bottom-width: 2px;
  border-radius: var(--radius); background: var(--c-surface); font-family: ui-monospace, monospace; font-size: var(--fs-sm);
}

/* ① 待机 */
.idle { display: grid; grid-template-columns: 1fr 460px; gap: var(--sp-6); align-items: center; }
.lobby-title { font-size: clamp(28px, 5vmin, 48px); font-weight: 800; letter-spacing: 2px; }
.lobby-sub { color: var(--c-text-2); font-size: clamp(14px, 2vmin, 18px); margin: var(--sp-2) 0 var(--sp-4); }
.join-url {
  display: inline-block; font-family: ui-monospace, Consolas, monospace; font-size: clamp(18px, 2.6vmin, 24px);
  color: var(--c-brand); background: var(--c-surface); border: 1px solid #dcdcfb;
  border-radius: var(--r-md); padding: var(--sp-2) var(--sp-4); margin-bottom: var(--sp-5);
}
.seats { display: grid; gap: var(--sp-3); max-width: 720px; }
.seat {
  display: flex; align-items: center; gap: var(--sp-4); background: var(--c-surface);
  border: 1px solid var(--c-line); border-left: 6px solid var(--c-brand);
  border-radius: var(--r-md); padding: var(--sp-4) var(--sp-4); font-size: clamp(18px, 2.6vmin, 24px); box-shadow: var(--sh-1);
}
.seat-name { font-weight: 700; }
.seat-members { color: var(--c-text-3); font-size: var(--fs-base); }
.seat-score { margin-left: auto; font-size: clamp(20px, 3.2vmin, 30px); font-weight: 800; font-variant-numeric: tabular-nums; }
.seat-score i { font-size: var(--fs-sm); font-style: normal; color: var(--c-text-3); margin-left: var(--sp-1); }
.qr-box { display: grid; place-items: center; }
.qr { width: 100%; max-width: 420px; background: var(--c-surface); padding: var(--sp-4); border-radius: var(--r-lg); box-shadow: var(--sh-2); }
.qr-tip { color: var(--c-text-2); text-align: center; line-height: 1.9; }

/* ② 点名 */
.rollcall { display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; }
.roll-label { font-size: clamp(20px, 3.2vmin, 30px); color: var(--c-text-2); letter-spacing: 8px; }
.roll-name {
  font-size: clamp(56px, 13vmin, 150px); font-weight: 900; letter-spacing: 14px; line-height: 1.1; margin: var(--sp-2) 0 var(--sp-4);
  background: linear-gradient(180deg, var(--c-text) 0%, var(--c-brand) 120%);
  -webkit-background-clip: text; background-clip: text; color: transparent;
}
.roll-meta { display: flex; align-items: center; gap: var(--sp-4); font-size: clamp(18px, 2.6vmin, 24px); color: var(--c-text-2); }
.team-badge {
  padding: var(--sp-2) var(--sp-4); border-radius: 999px; background: var(--c-brand-weak);
  color: var(--c-brand); font-weight: 700; border: 1px solid #dcdcfb;
}
.roll-hint { margin-top: var(--sp-6); color: var(--c-text-3); font-size: clamp(14px, 2vmin, 18px); }

/* ③ 出题：Kahoot 式四色选项块 */
.question { display: grid; grid-template-columns: 1fr 320px; gap: var(--sp-6); }
.q-tier { display: flex; align-items: center; gap: var(--sp-3); margin-bottom: var(--sp-3); }
.tier-pill {
  padding: var(--sp-1) var(--sp-4); border-radius: 999px; font-size: var(--fs-base); font-weight: 600;
  background: var(--c-ok-weak); color: var(--c-ok); border: 1px solid #bfe9d8;
}
.tier-pts { color: var(--c-warn); font-size: clamp(16px, 2.2vmin, 20px); font-weight: 800; }
.tier-type { color: var(--c-text-3); font-size: var(--fs-base); }
.q-stem { font-size: clamp(28px, 5vmin, 48px); font-weight: 800; line-height: 1.4; margin-bottom: var(--sp-5); }
.q-options { display: grid; grid-template-columns: repeat(2, 1fr); grid-auto-rows: minmax(112px, auto); gap: var(--sp-4); }
.q-options.many { grid-template-columns: repeat(3, 1fr); }
.q-option {
  display: flex; align-items: center; gap: var(--sp-4); color: var(--c-surface);
  border-radius: var(--r-xl); padding: var(--sp-4) var(--sp-5); font-size: clamp(20px, 3.2vmin, 30px); font-weight: 800;
  box-shadow: var(--sh-2); min-height: 112px;
}
.opt-shape { font-size: clamp(16px, 2.2vmin, 20px); opacity: .9; }
.opt-key {
  width: 40px; height: 40px; border-radius: var(--radius); background: rgb(255 255 255 / 22%);
  display: grid; place-items: center; font-weight: 900; flex: none;
}
.opt-text { line-height: 1.3; }
.q-fill { font-size: clamp(18px, 2.6vmin, 24px); color: var(--c-text-2); }
.q-answer { margin-top: var(--sp-5); font-size: clamp(20px, 3.2vmin, 30px); font-weight: 800; color: var(--c-ok); }
.q-side { border-left: 1px solid var(--c-line); padding-left: var(--sp-5); }
.buzz-row, .score-row { display: flex; align-items: center; gap: var(--sp-2); font-size: clamp(16px, 2.2vmin, 20px); padding: var(--sp-2) 0; }
.buzz-rank {
  width: 28px; height: 28px; border-radius: var(--radius); background: var(--c-warn-weak);
  color: var(--c-warn); display: grid; place-items: center; font-size: var(--fs-sm); font-weight: 700;
}
.buzz-team { font-weight: 700; }
.buzz-who { color: var(--c-text-3); font-size: var(--fs-base); }
.score-name { font-weight: 600; }
.score-val { margin-left: auto; font-weight: 800; font-variant-numeric: tabular-nums; }

/* ④ 点评 */
.review { display: grid; grid-template-columns: 400px 1fr; gap: var(--sp-6); }
.rev-team {
  display: flex; align-items: center; gap: var(--sp-3); background: var(--c-surface); border: 1px solid var(--c-line);
  border-radius: var(--r-md); padding: var(--sp-3) var(--sp-4); margin-bottom: var(--sp-2); font-size: clamp(16px, 2.2vmin, 20px); box-shadow: var(--sh-1);
}
.rev-name { font-weight: 700; }
.rev-correct { margin-left: auto; color: var(--c-ok); font-weight: 800; }
.rev-attempts { color: var(--c-text-3); font-size: var(--fs-base); }
.rev-rate { width: 64px; text-align: right; color: var(--c-text-2); font-variant-numeric: tabular-nums; }
.stu-row { display: flex; align-items: center; gap: var(--sp-3); font-size: clamp(16px, 2.2vmin, 20px); padding: var(--sp-2) 0; }
.stu-rank {
  width: 28px; height: 28px; border-radius: var(--radius); background: var(--c-surface-2);
  color: var(--c-text-2); display: grid; place-items: center; font-size: var(--fs-sm); font-weight: 700;
}
.stu-rank.r1 { background: #fff4d6; color: #a16207; }
.stu-rank.r2 { background: #eef2f7; color: var(--c-text-2); }
.stu-rank.r3 { background: #fdeee2; color: var(--c-warn); }
.stu-team { color: var(--c-text-3); font-size: var(--fs-base); }
.stu-score { margin-left: auto; font-weight: 800; font-variant-numeric: tabular-nums; }
.rev-right { min-width: 0; display: flex; flex-direction: column; }

.foot {
  display: flex; justify-content: space-between; padding: var(--sp-2) var(--sp-6);
  border-top: 1px solid var(--c-line); color: var(--c-text-3); font-size: var(--fs-sm); background: var(--c-surface);
}

/* 公开课：被点到的同学 + 现场评价 */
.open-block { background: linear-gradient(135deg, var(--c-brand) 0%, var(--c-brand-2) 100%); color: var(--c-surface); border-radius: var(--radius-lg); padding: var(--sp-4) var(--sp-4); margin-bottom: var(--sp-4); }
.open-who { display: flex; align-items: baseline; gap: var(--sp-3); }
.open-tag { font-size: var(--fs-xs); background: rgba(255, 255, 255, .25); padding: var(--sp-1) var(--sp-2); border-radius: 999px; }
.open-name { font-size: clamp(20px, 3.2vmin, 30px); font-weight: 800; letter-spacing: 1px; }
.open-verdict { font-size: var(--fs-base); font-weight: 700; padding: var(--sp-1) var(--sp-2); border-radius: 999px; background: rgba(255, 255, 255, .2); }
.open-verdict.v-correct { background: var(--c-ok); }
.open-verdict.v-half { background: var(--c-warn); }
.open-verdict.v-wrong { background: var(--c-bad); }
.open-eval { margin-top: var(--sp-2); }
.open-eval.muted { font-size: var(--fs-sm); opacity: .85; }
.open-score { font-size: clamp(18px, 2.6vmin, 24px); font-weight: 800; margin-right: var(--sp-3); }
.open-comment { font-size: var(--fs-base); opacity: .95; line-height: 1.6; }

/* 选项分布：正确项绿色、干扰项灰色；条宽 = 选择比例 */
.opt-row { display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-1) 0; font-size: var(--fs-sm); }
.opt-key {
  width: 22px; height: 22px; flex: none; border-radius: var(--radius); background: var(--c-line); color: var(--c-text-2);
  font-size: var(--fs-xs); font-weight: 700; text-align: center; line-height: 22px;
}
.opt-key.right { background: #dcfce7; color: #15803d; }
.opt-bar { flex: 1; min-width: 40px; height: 10px; border-radius: 999px; background: var(--c-bg); overflow: hidden; }
.opt-fill { display: block; height: 100%; background: #94a3b8; }
.opt-fill.right { background: var(--c-ok); }
.opt-rate { flex: none; width: 42px; text-align: right; font-variant-numeric: tabular-nums; font-weight: 700; color: var(--c-text-2); }
.opt-text { flex: none; max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--c-text-3); font-size: var(--fs-xs); }

/* 点评环节的讲评建议（正确率最低的几道题） */
.review-tips {
  margin: 0 var(--sp-6) var(--sp-4); padding: var(--sp-3) var(--sp-4); background: var(--c-surface);
  border: 1px solid var(--c-line); border-left: 4px solid var(--c-warn); border-radius: var(--radius-lg);
}
.tips-title { font-size: var(--fs-sm); font-weight: 700; color: var(--c-text-2); margin-bottom: var(--sp-2); }
.tip-row { display: flex; align-items: center; gap: var(--sp-3); padding: var(--sp-1) 0; font-size: var(--fs-sm); }
.tip-rank {
  width: 20px; height: 20px; flex: none; border-radius: 50%; background: var(--c-bg);
  color: var(--c-text-2); font-size: var(--fs-xs); font-weight: 700; text-align: center; line-height: 20px;
}
.tip-stem { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tip-tier { flex: none; font-size: var(--fs-xs); color: var(--c-text-3); }
.tip-rate { flex: none; font-weight: 800; font-variant-numeric: tabular-nums; color: var(--c-ok); }
.tip-rate.warn { color: var(--c-warn); }
.tip-rate.bad { color: var(--c-bad); }
.tip-detail { flex: none; font-size: var(--fs-xs); color: var(--c-text-3); }
.tip-who { flex: none; font-size: var(--fs-xs); color: var(--c-text-3); max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.q-image { display: block; max-width: 100%; max-height: 300px; margin: var(--sp-3) 0 0; border-radius: var(--radius); border: 1px solid var(--c-line); }
.q-why { margin-top: var(--sp-2); font-size: var(--fs-base); font-weight: 500; color: var(--c-warn); line-height: 1.5; }
</style>
