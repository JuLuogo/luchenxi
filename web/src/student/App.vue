<script setup lang="ts">
/**
 * 学生端（移动优先，Vant）
 *
 * 复用旧的学生端领域层 assets/js/student.js（连接、入座、提交、抢答、快照解析都在里面），
 * 这里只做界面：
 *   · 未入座 → 选小组入座（也可手输教师机地址）
 *   · 已入座 → 答题（选择/填空/主观）、抢答、以及"我答对多少 / 其他队答对多少"
 *   · ?view=board → 小组公屏（放大显示，适合平板挂墙上）
 */
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { showToast, showConfirmDialog } from 'vant';
import { CIStudent } from './bridge-student';

const ready = ref(false);
const boardMode = ref(false);
const st = ref<Record<string, any>>({});
const hostInput = ref('');
const textDraft = ref('');
const tab = ref('qa');          // qa | score

/** 公开课现场状态：被点到时弹「到你了」 */
const open = computed<any>(() => {
  void st.value;
  try { return (CIStudent as any).openState ? (CIStudent as any).openState() : null; } catch { return null; }
});

function refresh() {
  st.value = CIStudent.state();
  ready.value = true;
}

let off: (() => void) | null = null;
onMounted(() => {
  boardMode.value = CIStudent.boardMode();
  hostInput.value = CIStudent.state().host || '';
  CIStudent.init();                 // 连接 + 首次渲染（旧的 DOM 渲染会自动跳过）
  off = CIStudent.on(refresh);
  refresh();
});
onUnmounted(() => { if (off) off(); });

/* ---------- 读数据 ---------- */
const payload = computed(() => st.value.payload || null);
const meta = computed(() => (payload.value && payload.value.meta) || {});
const question = computed(() => meta.value.question || null);
const accepting = computed(() => !!meta.value.accepting);
const revealed = computed(() => !!meta.value.reveal);
const teams = computed(() => (payload.value && payload.value.teams) || []);
const students = computed(() => (payload.value && payload.value.students) || []);
const myTeam = computed(() => teams.value.find((t) => t.id === st.value.teamId) || null);
const myMembers = computed(() => students.value.filter((s) => s.teamId === st.value.teamId));
const meStudent = computed(() => {
  const list = myMembers.value;
  return list.find((s) => s.id === st.value.answererId) || list[0] || null;
});
const selected = computed(() => st.value.selected || []);
const submitted = computed(() => st.value.submitted);
const buzzed = computed(() => st.value.buzzed);
const phaseLabel = computed(() => meta.value.phaseLabel || '待机');

/** 其他队答对多少（教师端在快照 meta 里算好，学生端直接用） */
const otherTeams = computed(() => ((meta.value.teamStats) || [])
  .filter((t) => t.teamId !== 'all' && t.teamId !== st.value.teamId)
  .sort((a, b) => b.correct - a.correct));
const classStat = computed(() => ((meta.value.teamStats) || []).find((t) => t.teamId === 'all') || null);

/** 我答对了几道（本轮课堂） */
const myCorrect = computed(() => (meStudent.value ? meStudent.value.correct : 0));
const myAttempts = computed(() => (meStudent.value ? meStudent.value.attempts : 0));
const myScore = computed(() => (meStudent.value ? meStudent.value.score : 0));
const myGrade = computed(() => {
  const list = (meta.value.ability && meta.value.ability.students) || [];
  return list.find((s) => s.sid === (meStudent.value && meStudent.value.id)) || null;
});

/** 当前题是否已提交 */
const submittedThis = computed(() => !!(question.value && submitted.value && submitted.value.qid === question.value.id));
const buzzedThis = computed(() => !!(question.value && buzzed.value && buzzed.value.qid === question.value.id));

/* ---------- 操作 ---------- */
function pickTeam(id) {
  CIStudent.pickTeam(id);
  refresh();
}
function chooseAnswerer(id) {
  CIStudent.setAnswerer(id);
  refresh();
}
function toggleOption(key) {
  CIStudent.toggleOption(key);
  refresh();
}
function onDraft(v) {
  textDraft.value = v;
  // 草稿同步给状态机（它负责发 cmd.text —— 原来读的是 Vue 页面里不存在的 DOM 元素）
  (CIStudent as any).setDraft ? (CIStudent as any).setDraft(v) : void 0;
  CIStudent.draft(v);
}
function submit(skip) {
  CIStudent.submit(!!skip);
  refresh();
}
function buzz() {
  CIStudent.buzz();
  refresh();
}
function saveHost() {
  CIStudent.saveHost(hostInput.value);
  showToast('已保存教师机地址，正在重连');
  refresh();
}
async function testHub() {
  try {
    const res = await CIStudent.testHub();
    showToast(res && res.ok ? '教师机在线' : '连不上，检查地址或让老师开大屏');
  } catch (e) {
    showToast('检测失败：' + (e && e.message ? e.message : e));
  }
}
async function showGuide() {
  const text = CIStudent.guidance();
  await showConfirmDialog({ title: '连不上教师机？', message: text, showCancelButton: false, confirmButtonText: '知道了' }).catch(() => {});
}
function switchTeam() {
  CIStudent.switchTeam();
  refresh();
}
</script>

<template>
  <div class="stu" :class="{ board: boardMode }">
    <!-- 顶部：状态 + 我们组 -->
    <van-nav-bar :title="boardMode ? '小组公屏' : '课堂小组端'" fixed placeholder>
      <template #right>
        <span class="conn" :class="{ on: st.connected }">{{ st.connected ? '已连接' : '未连接' }}</span>
      </template>
    </van-nav-bar>

    <!-- 公开课：被点到时最显眼的提示（学生不用猜老师叫的是谁） -->
    <div v-if="open && open.mine" class="open-me" :class="{ done: !!open.verdict }">
      <span class="open-me-title">{{ open.verdict ? '本轮结束' : '到你了！' }}</span>
      <span class="open-me-sub">{{ open.name }}{{ open.verdict ? ' · ' + (open.verdict === 'correct' ? '全对' : (open.verdict === 'half' ? '对一半' : '不对')) : '，请准备回答' }}</span>
      <div v-if="open.evaluation" class="open-me-eval">
        现场评价 {{ open.evaluation.total }} 分 · {{ open.evaluation.level }}
        <div class="open-me-comment">{{ open.evaluation.comment }}</div>
      </div>
    </div>

    <!-- ① 未入座：选小组 -->
    <div v-if="!st.teamId" class="join">
      <div class="join-title">选择你们的小组</div>
      <div class="join-sub">房间：{{ st.room }} · {{ st.connected ? '已连接教师机' : '正在连接教师机…' }}</div>

      <div class="team-grid">
        <button v-for="t in teams" :key="t.id" class="team-btn" :style="{ borderColor: t.color }" @click="pickTeam(t.id)">
          <span class="team-name">{{ t.name }}</span>
          <span class="team-meta">{{ t.memberCount }} 人 · {{ t.score }} 分</span>
        </button>
      </div>
      <div v-if="!teams.length" class="join-empty">还没有拿到小组名单：确认教师端已打开，或点下面「连不上教师机？」。</div>

      <van-cell-group inset class="host-box">
        <van-field v-model="hostInput" label="教师机" placeholder="例如 192.168.0.180:8080（只写 IP 也行）" />
      </van-cell-group>
      <div class="join-ops">
        <van-button size="small" type="primary" @click="saveHost">保存并重连</van-button>
        <van-button size="small" @click="testHub">测试连接</van-button>
        <van-button size="small" plain @click="showGuide">连不上教师机？</van-button>
      </div>
    </div>

    <!-- ② 已入座 -->
    <div v-else class="main">
      <!-- 我们组 & 我的成绩 -->
      <div class="score-card">
        <div class="sc-team" :style="{ borderColor: (myTeam && myTeam.color) || '#4f46e5' }">
          <div class="st-name">{{ myTeam ? myTeam.name : '未分组' }}</div>
          <div class="st-score num">{{ myTeam ? myTeam.score : 0 }}<span class="unit">分</span></div>
          <div class="st-members">{{ myMembers.length }} 人</div>
        </div>
        <div class="sc-me">
          <div class="me-row"><span>我答对</span><b class="num">{{ myCorrect }}</b><span class="muted">/ {{ myAttempts }} 次</span></div>
          <div class="me-row"><span>我得分</span><b class="num">{{ myScore }}</b></div>
          <div class="me-row" v-if="myGrade"><span>能力画像</span>
            <span class="grade" :style="{ background: myGrade.grade.color }">{{ myGrade.grade.short }} · {{ myGrade.grade.label }}</span>
          </div>
        </div>
      </div>

      <!-- 其他队答对多少 -->
      <div class="others">
        <div class="others-title">其他队答对情况</div>
        <div v-for="t in otherTeams" :key="t.teamId" class="other-row">
          <span class="dot" :style="{ background: t.color }" />
          <span class="oname">{{ t.name }}</span>
          <span class="ocorrect num">答对 {{ t.correct }}</span>
          <span class="orate num">{{ Math.round(t.creditRate) }}%</span>
        </div>
        <div v-if="classStat" class="class-row">
          全班合计：答对 <b class="num">{{ classStat.correct }}</b> / {{ classStat.attempts }} 次
        </div>
      </div>

      <van-tabs v-model:active="tab" sticky>
        <!-- 答题 -->
        <van-tab title="答题" name="qa">
          <div class="pane">
            <div class="phase-tip">当前环节：{{ phaseLabel }}</div>

            <div v-if="!question" class="waiting">
              <van-empty description="等待老师出题" />
            </div>

            <template v-else>
              <div class="q-card">
                <div class="q-meta">
                  <span class="q-tier">{{ question.tierLabel }}</span>
                  <span class="q-pts">{{ question.points }} 分</span>
                  <span class="q-type">{{ question.typeLabel }}</span>
                </div>
                <div class="q-stem">{{ question.fullStem }}</div>

                <!-- 选择题 -->
                <div v-if="question.options && question.options.length" class="opts">
                  <button
                    v-for="o in question.options"
                    :key="o.key"
                    class="opt"
                    :class="{ on: selected.includes(o.key) }"
                    :disabled="submittedThis || !accepting"
                    @click="toggleOption(o.key)"
                  >
                    <span class="okey">{{ o.key }}</span>{{ o.text }}
                  </button>
                </div>

                <!-- 填空 / 主观 -->
                <van-field
                  v-else-if="question.type === 'fill'"
                  v-model="textDraft"
                  label="答案"
                  placeholder="填写答案"
                  :disabled="submittedThis || !accepting"
                  @update:model-value="onDraft"
                />
                <van-field
                  v-else
                  v-model="textDraft"
                  type="textarea"
                  rows="3"
                  label="作答"
                  placeholder="写下你的思路（老师会判定）"
                  :disabled="submittedThis || !accepting"
                  @update:model-value="onDraft"
                />

                <div v-if="submittedThis" class="done">
                  <van-icon name="passed" /> 已提交，等待老师判定 / 自动判分
                </div>
                <div v-else-if="!accepting" class="closed">老师还没开始接收作答</div>

                <div class="q-ops">
                  <van-button type="primary" block :disabled="submittedThis || !accepting" @click="submit(false)">
                    提交答案
                  </van-button>
                  <div class="sub-ops">
                    <van-button size="small" type="warning" :disabled="buzzedThis || !accepting" @click="buzz">
                      ⚡ 抢答
                    </van-button>
                    <van-button size="small" :disabled="submittedThis || !accepting" @click="submit(true)">跳过这题</van-button>
                  </div>
                </div>

                <div v-if="revealed && question.answerKey" class="answer">
                  正确答案：<b>{{ question.answerKey }}</b>
                  <!-- 反馈三件套的第三件：为什么（题目讲评要点，公布答案后才下发） -->
                  <div v-if="question.explanation" class="why">💡 {{ question.explanation }}</div>
                </div>
              </div>
            </template>
          </div>
        </van-tab>

        <!-- 我们组 -->
        <van-tab title="我们组" name="team">
          <div class="pane">
            <div class="mini-title">选谁作答（老师点名时按这个报）</div>
            <div class="member-list">
              <button
                v-for="s in myMembers"
                :key="s.id"
                class="member"
                :class="{ on: s.id === (meStudent && meStudent.id) }"
                @click="chooseAnswerer(s.id)"
              >
                <span class="mname">{{ s.name }}</span>
                <span class="mcorrect">答对 {{ s.correct }} / {{ s.attempts }}</span>
                <span class="mscore num">{{ s.score }} 分</span>
              </button>
              <div v-if="!myMembers.length" class="muted">本组还没有学生（让老师在教师端加上）</div>
            </div>
            <van-button size="small" plain class="switch-btn" @click="switchTeam">重新选小组</van-button>
          </div>
        </van-tab>
      </van-tabs>
    </div>
  </div>
</template>

<style scoped>
/* 公开课「到你了」 */
.open-me { margin: var(--sp-2) var(--sp-3); padding: var(--sp-4) var(--sp-4); border-radius: var(--radius-lg); background: linear-gradient(135deg, #4f46e5, #7c3aed); color: #fff; }
.open-me.done { background: linear-gradient(135deg, #0ea5e9, #22c55e); }
.open-me-title { display: block; font-size: var(--fs-2xl); font-weight: 800; letter-spacing: 1px; }
.open-me-sub { display: block; margin-top: var(--sp-1); font-size: var(--fs-sm); opacity: .95; }
.open-me-eval { margin-top: var(--sp-2); font-size: var(--fs-base); font-weight: 700; }
.open-me-comment { margin-top: var(--sp-2); font-size: var(--fs-sm); font-weight: 400; line-height: 1.6; opacity: .95; }
.stu { min-height: 100vh; background: #f7f8fa; }
.conn { font-size: var(--fs-xs); color: #969799; }
.conn.on { color: #07c160; }

/* 入座 */
.join { padding: var(--sp-4); }
.join-title { font-size: var(--fs-xl); font-weight: 700; }
.join-sub { color: #969799; font-size: var(--fs-sm); margin: var(--sp-2) 0 var(--sp-4); }
.team-grid { display: grid; grid-template-columns: 1fr 1fr; gap: var(--sp-3); }
.team-btn {
  background: #fff; border: 2px solid #e5e7eb; border-radius: var(--radius-lg); padding: var(--sp-4) var(--sp-3);
  display: flex; flex-direction: column; gap: var(--sp-2); align-items: flex-start; text-align: left;
}
.team-btn:active { background: #f2f3f5; }
.team-name { font-size: var(--fs-lg); font-weight: 700; }
.team-meta { color: #969799; font-size: var(--fs-xs); }
.join-empty { color: #969799; font-size: var(--fs-sm); padding: var(--sp-4) 0; }
.host-box { margin: var(--sp-4) 0 var(--sp-2); }
.join-ops { display: flex; gap: var(--sp-2); flex-wrap: wrap; }

/* 成绩卡 */
.main { padding-bottom: var(--sp-5); }
.score-card { display: grid; grid-template-columns: 1fr 1fr; gap: var(--sp-2); padding: var(--sp-3); }
.sc-team { background: #fff; border: 2px solid #4f46e5; border-radius: var(--radius-lg); padding: var(--sp-3); }
.st-name { font-weight: 700; }
.st-score { font-size: var(--fs-3xl); font-weight: 800; line-height: 1.2; }
.st-score .unit { font-size: var(--fs-sm); font-weight: 400; color: #969799; margin-left: var(--sp-1); }
.st-members { color: #969799; font-size: var(--fs-xs); }
.sc-me { background: #fff; border-radius: var(--radius-lg); padding: var(--sp-2) var(--sp-3); display: flex; flex-direction: column; justify-content: center; gap: var(--sp-2); }
.me-row { display: flex; align-items: center; gap: var(--sp-2); font-size: var(--fs-sm); }
.me-row b { font-size: var(--fs-lg); }
.muted { color: #969799; font-size: var(--fs-xs); }
.grade { color: #fff; font-size: var(--fs-xs); padding: var(--sp-1) var(--sp-2); border-radius: 999px; }

/* 其他队 */
.others { margin: 0 var(--sp-3) var(--sp-3); background: #fff; border-radius: var(--radius-lg); padding: var(--sp-3); }
.others-title { color: #969799; font-size: var(--fs-xs); margin-bottom: var(--sp-2); }
.other-row { display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-2) 0; font-size: var(--fs-sm); }
.dot { width: 10px; height: 10px; border-radius: 50%; }
.oname { font-weight: 600; }
.ocorrect { margin-left: auto; color: #07c160; font-weight: 600; }
.orate { color: #969799; font-size: var(--fs-xs); }
.class-row { border-top: 1px dashed #eee; margin-top: var(--sp-2); padding-top: var(--sp-2); color: #646566; font-size: var(--fs-sm); }

/* 答题 */
.pane { padding: var(--sp-3); }
.phase-tip { color: #969799; font-size: var(--fs-xs); margin-bottom: var(--sp-2); }
.q-card { background: #fff; border-radius: var(--radius-lg); padding: var(--sp-4); }
.q-meta { display: flex; align-items: center; gap: var(--sp-2); }
.q-tier { background: #e8f7ee; color: #07c160; font-size: var(--fs-xs); padding: var(--sp-1) var(--sp-2); border-radius: 999px; }
.q-pts { color: #ff976a; font-weight: 700; font-size: var(--fs-sm); }
.q-type { color: #969799; font-size: var(--fs-xs); }
.q-stem { font-size: var(--fs-lg); line-height: 1.6; margin: var(--sp-2) 0 var(--sp-4); }
.opts { display: grid; gap: var(--sp-2); }
.opt {
  display: flex; align-items: center; gap: var(--sp-2); text-align: left;
  background: #f7f8fa; border: 2px solid transparent; border-radius: var(--radius-lg); padding: var(--sp-3);
  font-size: var(--fs-base);
}
.opt.on { border-color: #4f46e5; background: #eef2ff; }
.okey { width: 26px; height: 26px; border-radius: var(--radius); background: #e5e7eb; display: grid; place-items: center; font-weight: 700; font-size: var(--fs-sm); }
.opt.on .okey { background: #4f46e5; color: #fff; }
.done { color: #07c160; font-size: var(--fs-sm); margin-top: var(--sp-3); }
.closed { color: #ed6a0c; font-size: var(--fs-sm); margin-top: var(--sp-3); }
.q-ops { margin-top: var(--sp-4); }
.sub-ops { display: flex; gap: var(--sp-2); margin-top: var(--sp-2); }
.answer { margin-top: var(--sp-3); font-size: var(--fs-sm); color: #07c160; }

/* 我们组 */
.mini-title { color: #969799; font-size: var(--fs-xs); margin-bottom: var(--sp-2); }
.member-list { display: grid; gap: var(--sp-2); }
.member {
  display: flex; align-items: center; gap: var(--sp-2); background: #fff; border: 2px solid transparent;
  border-radius: var(--radius-lg); padding: var(--sp-3); font-size: var(--fs-base); text-align: left;
}
.member.on { border-color: #4f46e5; background: #eef2ff; }
.mname { font-weight: 600; }
.mcorrect { margin-left: auto; color: #07c160; font-size: var(--fs-sm); }
.mscore { color: #323233; font-weight: 700; }
.switch-btn { margin-top: var(--sp-4); }

/* 公屏模式：大字、无交互 */
.board .score-card { grid-template-columns: 1fr; }
.board .sc-team, .board .others, .board .q-card { border-radius: var(--radius-lg); }
.board .st-name { font-size: var(--fs-2xl); }
.board .st-score { font-size: var(--fs-6xl); }
.board .q-stem { font-size: var(--fs-3xl); }
.board .opt { font-size: var(--fs-2xl); }
.why { margin-top: var(--sp-2); font-size: var(--fs-sm); color: #92400e; background: #fffbeb; border-radius: var(--radius); padding: var(--sp-2) var(--sp-2); line-height: 1.6; }
</style>
