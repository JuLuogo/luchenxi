<script setup>
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
const st = ref({});
const hostInput = ref('');
const textDraft = ref('');
const tab = ref('qa');          // qa | score

function refresh() {
  st.value = CIStudent.state();
  ready.value = true;
}

let off = null;
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
const phase = computed(() => meta.value.phase || 'idle');
const phaseLabel = computed(() => meta.value.phaseLabel || '待机');

/** 其他队答对多少（教师端在快照 meta 里算好，学生端直接用） */
const otherTeams = computed(() => ((meta.value.teamStats) || [])
  .filter((t) => t.teamId !== 'all' && t.teamId !== st.value.teamId)
  .sort((a, b) => b.correct - a.correct));
const myTeamStat = computed(() => ((meta.value.teamStats) || []).find((t) => t.teamId === st.value.teamId) || null);
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
.stu { min-height: 100vh; background: #f7f8fa; }
.conn { font-size: 12px; color: #969799; }
.conn.on { color: #07c160; }

/* 入座 */
.join { padding: 16px; }
.join-title { font-size: 20px; font-weight: 700; }
.join-sub { color: #969799; font-size: 13px; margin: 6px 0 16px; }
.team-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.team-btn {
  background: #fff; border: 2px solid #e5e7eb; border-radius: 14px; padding: 16px 12px;
  display: flex; flex-direction: column; gap: 6px; align-items: flex-start; text-align: left;
}
.team-btn:active { background: #f2f3f5; }
.team-name { font-size: 18px; font-weight: 700; }
.team-meta { color: #969799; font-size: 12px; }
.join-empty { color: #969799; font-size: 13px; padding: 20px 0; }
.host-box { margin: 18px 0 10px; }
.join-ops { display: flex; gap: 8px; flex-wrap: wrap; }

/* 成绩卡 */
.main { padding-bottom: 24px; }
.score-card { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; padding: 12px; }
.sc-team { background: #fff; border: 2px solid #4f46e5; border-radius: 14px; padding: 12px; }
.st-name { font-weight: 700; }
.st-score { font-size: 30px; font-weight: 800; line-height: 1.2; }
.st-score .unit { font-size: 13px; font-weight: 400; color: #969799; margin-left: 4px; }
.st-members { color: #969799; font-size: 12px; }
.sc-me { background: #fff; border-radius: 14px; padding: 10px 12px; display: flex; flex-direction: column; justify-content: center; gap: 8px; }
.me-row { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.me-row b { font-size: 18px; }
.muted { color: #969799; font-size: 12px; }
.grade { color: #fff; font-size: 11px; padding: 2px 8px; border-radius: 999px; }

/* 其他队 */
.others { margin: 0 12px 12px; background: #fff; border-radius: 14px; padding: 12px; }
.others-title { color: #969799; font-size: 12px; margin-bottom: 8px; }
.other-row { display: flex; align-items: center; gap: 8px; padding: 6px 0; font-size: 14px; }
.dot { width: 10px; height: 10px; border-radius: 50%; }
.oname { font-weight: 600; }
.ocorrect { margin-left: auto; color: #07c160; font-weight: 600; }
.orate { color: #969799; font-size: 12px; }
.class-row { border-top: 1px dashed #eee; margin-top: 6px; padding-top: 8px; color: #646566; font-size: 13px; }

/* 答题 */
.pane { padding: 12px; }
.phase-tip { color: #969799; font-size: 12px; margin-bottom: 8px; }
.q-card { background: #fff; border-radius: 14px; padding: 14px; }
.q-meta { display: flex; align-items: center; gap: 8px; }
.q-tier { background: #e8f7ee; color: #07c160; font-size: 12px; padding: 2px 8px; border-radius: 999px; }
.q-pts { color: #ff976a; font-weight: 700; font-size: 13px; }
.q-type { color: #969799; font-size: 12px; }
.q-stem { font-size: 17px; line-height: 1.6; margin: 10px 0 14px; }
.opts { display: grid; gap: 10px; }
.opt {
  display: flex; align-items: center; gap: 10px; text-align: left;
  background: #f7f8fa; border: 2px solid transparent; border-radius: 12px; padding: 12px;
  font-size: 15px;
}
.opt.on { border-color: #4f46e5; background: #eef2ff; }
.okey { width: 26px; height: 26px; border-radius: 8px; background: #e5e7eb; display: grid; place-items: center; font-weight: 700; font-size: 13px; }
.opt.on .okey { background: #4f46e5; color: #fff; }
.done { color: #07c160; font-size: 13px; margin-top: 12px; }
.closed { color: #ed6a0c; font-size: 13px; margin-top: 12px; }
.q-ops { margin-top: 14px; }
.sub-ops { display: flex; gap: 10px; margin-top: 10px; }
.answer { margin-top: 12px; font-size: 14px; color: #07c160; }

/* 我们组 */
.mini-title { color: #969799; font-size: 12px; margin-bottom: 8px; }
.member-list { display: grid; gap: 10px; }
.member {
  display: flex; align-items: center; gap: 10px; background: #fff; border: 2px solid transparent;
  border-radius: 12px; padding: 12px; font-size: 15px; text-align: left;
}
.member.on { border-color: #4f46e5; background: #eef2ff; }
.mname { font-weight: 600; }
.mcorrect { margin-left: auto; color: #07c160; font-size: 13px; }
.mscore { color: #323233; font-weight: 700; }
.switch-btn { margin-top: 14px; }

/* 公屏模式：大字、无交互 */
.board .score-card { grid-template-columns: 1fr; }
.board .sc-team, .board .others, .board .q-card { border-radius: 18px; }
.board .st-name { font-size: 26px; }
.board .st-score { font-size: 56px; }
.board .q-stem { font-size: 30px; }
.board .opt { font-size: 22px; }
</style>
