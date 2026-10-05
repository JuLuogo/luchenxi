<script setup lang="ts">
/**
 * 概览页：只放"现在该干什么"的信息，不放业务操作。
 * 统计口径全部来自 CI.analysis / CI.store，不在界面里重算。
 */
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { useClassStore } from '../../shared/class-store';
import { CI } from '../../shared/bridge';

const store = useClassStore();
const router = useRouter();

/**
 * 概览页的计数
 *
 * 注意：`CI.analysis.counts(s, r)` 是**逐条流水的判定函数**（"该流水是否计入统计"），不是汇总。
 * 这里原来误写成 `CI.analysis.counts(store.state)` —— r 成了 undefined，一进首页就抛
 * `Cannot read properties of undefined (reading 'tier')`。因为 Vue 界面此前**没有任何冒烟测试**，
 * 这个错一直没被发现（2026-10 补了 tests/ui-vue.test.mjs 作为守卫）。
 */
const counts = computed(() => ({
  students: store.students.length,
  records: CI.store.allRecords(store.state).length
}));
const ranking = computed(() => CI.analysis.ranking(store.state).slice(0, 5));
const teamRank = computed(() => CI.analysis.teamRanking(store.state).slice(0, 4));
const pendingCount = computed(() => {
  const box = CI.classroom.box(store.state);
  return (box.pending || []).length;
});
const buzzCount = computed(() => (CI.classroom.box(store.state).buzz || []).length);
const presence = computed(() => {
  const p = CI.classroom.presence();
  const teams = (p && p.teams) || [];
  return { online: teams.filter((t) => t.online).length, total: teams.length };
});

const steps = computed(() => ([
  { title: '建名单', desc: store.students.length ? `${store.students.length} 名学生 · ${store.teams.length} 支队伍` : '还没有学生', done: store.students.length > 0, to: '/class' },
  { title: '建题库', desc: store.bank.length ? `${store.bank.length} 道题 · ${store.tags.length} 个标签` : '题库为空', done: store.bank.length > 0, to: '/bank' },
  { title: '组一套题', desc: store.quizzes.length ? `${store.quizzes.length} 套试卷` : '还没有试卷', done: store.quizzes.length > 0, to: '/papers' },
  { title: '开始上课', desc: presence.value.online ? `${presence.value.online} 支队伍在线` : '学生端还未入座', done: presence.value.online > 0, to: '/classroom' }
]));
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h2>概览</h2>
        <div class="desc">今天这节课的进度一目了然；每一步都能直接点进去。</div>
      </div>
      <div class="actions">
        <el-button type="primary" @click="router.push('/class')">去记分</el-button>
        <el-button @click="router.push('/classroom')">课堂协同</el-button>
      </div>
    </div>

    <el-row :gutter="14">
      <el-col v-for="s in steps" :key="s.title" :xs="24" :sm="12" :md="6">
        <div class="panel step" :class="{ done: s.done }" @click="router.push(s.to)">
          <div class="step-title">
            <el-icon v-if="s.done" color="#10b981"><CircleCheckFilled /></el-icon>
            <el-icon v-else color="#cbd5e1"><CircleClose /></el-icon>
            <span>{{ s.title }}</span>
          </div>
          <div class="step-desc">{{ s.desc }}</div>
        </div>
      </el-col>
    </el-row>

    <el-row :gutter="14">
      <el-col :xs="24" :md="12">
        <div class="panel">
          <h3 class="panel-title">
            个人榜前 5
            <span class="sub">共 {{ counts.students }} 人 · 记录 {{ counts.records }} 条</span>
          </h3>
          <el-table :data="ranking" size="small" :show-header="true">
            <el-table-column type="index" label="#" width="46" />
            <el-table-column prop="name" label="学生" />
            <el-table-column prop="teamName" label="队伍" width="120" />
            <el-table-column label="积分" width="90" align="right">
              <template #default="{ row }">
                <span class="score-num">{{ row.score }}</span>
              </template>
            </el-table-column>
          </el-table>
          <div v-if="!ranking.length" class="empty-hint">还没有分数记录</div>
        </div>
      </el-col>

      <el-col :xs="24" :md="12">
        <div class="panel">
          <h3 class="panel-title">
            队伍榜
            <span class="sub">{{ presence.online }} / {{ presence.total }} 支在线</span>
          </h3>
          <div v-for="t in teamRank" :key="t.teamId" class="team-row">
            <span class="tname">{{ t.name }}</span>
            <el-progress
              :percentage="Math.min(100, Math.round((t.score / Math.max(1, teamRank[0].score)) * 100))"
              :show-text="false"
              :stroke-width="10"
            />
            <span class="score-num">{{ t.score }}</span>
          </div>
          <div v-if="!teamRank.length" class="empty-hint">还没有队伍</div>
        </div>
      </el-col>
    </el-row>

    <div class="panel">
      <h3 class="panel-title">课堂即时状态</h3>
      <el-descriptions :column="4" border size="small">
        <el-descriptions-item label="当前试卷">{{ store.currentQuiz ? store.currentQuiz.name : '未选择' }}</el-descriptions-item>
        <el-descriptions-item label="当前题">
          {{ store.currentQuestion ? store.currentQuestion.stem.slice(0, 16) : '未选择' }}
        </el-descriptions-item>
        <el-descriptions-item label="待确认提交">{{ pendingCount }}</el-descriptions-item>
        <el-descriptions-item label="抢答队列">{{ buzzCount }}</el-descriptions-item>
      </el-descriptions>
    </div>
  </div>
</template>

<style scoped>
.step { cursor: pointer; transition: box-shadow .15s, border-color .15s; }
.step:hover { border-color: var(--ci-brand); box-shadow: 0 2px 10px rgb(79 70 229 / 8%); }
.step.done { border-color: #bbf7d0; background: #f7fffb; }
.step-title { display: flex; align-items: center; gap: var(--sp-2); font-weight: 600; }
.step-desc { color: var(--ci-text-weak); font-size: var(--fs-xs); margin-top: var(--sp-2); }
.team-row { display: grid; grid-template-columns: 90px 1fr 48px; align-items: center; gap: var(--sp-2); margin-bottom: var(--sp-2); }
.tname { font-size: var(--fs-sm); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
