<script setup>
/**
 * 试卷中心 · 组卷编辑器（左库右卷 + 一键抽题）
 * 左侧从题库筛选勾选，右侧是当前试卷；支持上移/下移排序、移除、一键按题型抽题。
 */
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useClassStore } from '../../../shared/class-store.js';

const store = useClassStore();
const route = useRoute();
const router = useRouter();

const quizId = computed(() => String(route.params.id || ''));
const quiz = computed(() => store.quizzes.find((q) => q.id === quizId.value) || null);
const ids = computed(() => (quiz.value ? quiz.value.questionIds || [] : []));
const picked = computed(() => ids.value.map((id) => store.bank.find((q) => q.id === id)).filter(Boolean));

/* ---------- 左侧筛选 ---------- */
const keyword = ref('');
const tierFilter = ref('');
const tagFilter = ref('');
const onlyUnused = ref(true);

const available = computed(() => store.bank.filter((q) => {
  if (onlyUnused.value && ids.value.includes(q.id)) return false;
  if (tierFilter.value && q.tier !== tierFilter.value) return false;
  if (tagFilter.value && !(q.tags || []).includes(tagFilter.value)) return false;
  if (keyword.value && q.stem.indexOf(keyword.value) < 0) return false;
  return true;
}));

const checked = ref([]);
function addChecked() {
  if (!checked.value.length) { ElMessage.warning('先在左侧勾选题目'); return; }
  const res = store.addQuestionsToQuiz(quizId.value, checked.value.slice());
  ElMessage.success('已加入 ' + ((res && res.added) || checked.value.length) + ' 道题');
  checked.value = [];
}

/* ---------- 右侧排序与移除 ---------- */
function moveUp(i) {
  if (i <= 0) return;
  const list = ids.value.slice();
  const t = list[i - 1]; list[i - 1] = list[i]; list[i] = t;
  store.setQuizQuestions(quizId.value, list);
}
function moveDown(i) {
  const list = ids.value.slice();
  if (i >= list.length - 1) return;
  const t = list[i + 1]; list[i + 1] = list[i]; list[i] = t;
  store.setQuizQuestions(quizId.value, list);
}
function removeAt(i) {
  const list = ids.value.slice();
  list.splice(i, 1);
  store.setQuizQuestions(quizId.value, list);
}
function clearAll() {
  ElMessageBox.confirm('清空这套试卷的全部题目？（题库不受影响）', '清空试卷', { type: 'warning' })
    .then(() => { store.setQuizQuestions(quizId.value, []); ElMessage.success('已清空'); }).catch(() => {});
}

/* ---------- 一键抽题 ---------- */
const drawOpen = ref(false);
const drawCount = ref({});
function openDraw() {
  const init = {};
  store.tiers.forEach((t, i) => { init[t.key] = i < 2 ? 1 : 0; });
  drawCount.value = init;
  drawOpen.value = true;
}
function doDraw() {
  const list = ids.value.slice();
  let added = 0;
  store.tiers.forEach((t) => {
    const need = Number(drawCount.value[t.key] || 0);
    if (need <= 0) return;
    const pool = store.bank.filter((q) => q.tier === t.key && !list.includes(q.id));
    for (let i = pool.length - 1; i > 0; i--) {           // 洗牌，保证每次抽的略有不同
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp;
    }
    pool.slice(0, need).forEach((q) => { list.push(q.id); added += 1; });
  });
  store.setQuizQuestions(quizId.value, list);
  drawOpen.value = false;
  ElMessage.success('已抽入 ' + added + ' 道题');
}

/* ---------- 分值覆盖与统计 ---------- */
function overridePoints(q, value) {
  const num = value === '' || value === null ? null : Number(value);
  if (num !== null && (!isFinite(num) || num === 0)) { ElMessage.error('分值必须是非 0 数字'); return; }
  store.updateQuestion(q.id, { points: num });
}
const total = computed(() => picked.value.reduce((a, q) => a + store.questionPoints(q), 0));
const byTier = computed(() => store.tiers.map((t) => ({
  label: t.label,
  color: t.color,
  count: picked.value.filter((q) => q.tier === t.key).length
})).filter((x) => x.count > 0));

function rename() {
  ElMessageBox.prompt('试卷名称', '重命名', { inputValue: quiz.value.name })
    .then(({ value }) => { if (value) store.updateQuiz(quizId.value, { name: value }); }).catch(() => {});
}
function saveNote() {
  ElMessageBox.prompt('试卷说明（例如：覆盖集合与函数，含 2 道拔高）', '试卷说明', { inputValue: quiz.value.note || '' })
    .then(({ value }) => store.updateQuiz(quizId.value, { note: value || '' })).catch(() => {});
}
function setCurrent() {
  store.setCurrentQuiz(quizId.value);
  ElMessage.success('已设为当前试卷：课堂协同页将按这套题推题');
}
function tierName(key) {
  const t = store.tiers.find((x) => x.key === key);
  return t ? t.label : key;
}
function tierColor(key) {
  const t = store.tiers.find((x) => x.key === key);
  return t ? t.color : '#cbd5e1';
}
</script>

<template>
  <div v-if="quiz">
    <div class="page-head">
      <div>
        <h2>组卷：{{ quiz.name }}</h2>
        <div class="desc">
          {{ picked.length }} 道题 · 总分 <b>{{ total }}</b>
          <span v-for="t in byTier" :key="t.label" class="tier-chip">
            <span class="tier-dot" :style="{ background: t.color }" />{{ t.label }} ×{{ t.count }}
          </span>
        </div>
      </div>
      <div class="actions">
        <el-button @click="router.push('/papers')">返回列表</el-button>
        <el-button @click="rename">改名</el-button>
        <el-button @click="saveNote">说明</el-button>
        <el-button @click="openDraw">一键抽题</el-button>
        <el-button type="primary" @click="setCurrent">设为当前试卷</el-button>
      </div>
    </div>

    <el-row :gutter="14">
      <el-col :xs="24" :md="12">
        <div class="panel">
          <h3 class="panel-title">题库<span class="sub">筛选后勾选，右侧实时更新</span></h3>
          <div class="filters">
            <el-input v-model="keyword" placeholder="搜题干" clearable style="width: 140px" />
            <el-select v-model="tierFilter" placeholder="全部题型" clearable style="width: 120px">
              <el-option v-for="t in store.tiers" :key="t.key" :label="t.label" :value="t.key" />
            </el-select>
            <el-select v-model="tagFilter" placeholder="全部标签" clearable style="width: 130px">
              <el-option v-for="t in store.tags" :key="t.name" :label="t.name" :value="t.name" />
            </el-select>
            <el-checkbox v-model="onlyUnused">只看未入选</el-checkbox>
            <el-button type="primary" size="small" :disabled="!checked.length" @click="addChecked">
              加入试卷（{{ checked.length }}）
            </el-button>
          </div>

          <el-table
            :data="available"
            size="small"
            max-height="520"
            @selection-change="(rows) => (checked = rows.map((r) => r.id))"
          >
            <el-table-column type="selection" width="40" />
            <el-table-column label="题干" min-width="200">
              <template #default="{ row }">
                {{ row.stem }}
                <div class="mini">
                  <span class="tier-dot" :style="{ background: tierColor(row.tier) }" />
                  {{ tierName(row.tier) }} · {{ store.questionPoints(row) }} 分
                  <span v-for="t in row.tags" :key="t" class="tag">{{ t }}</span>
                </div>
              </template>
            </el-table-column>
          </el-table>
          <div v-if="!available.length" class="empty-hint">
            {{ store.bank.length ? '没有可加入的题目（试试关掉「只看未入选」）' : '题库还是空的，先去「新建题目」或「批量导入」' }}
          </div>
        </div>
      </el-col>

      <el-col :xs="24" :md="12">
        <div class="panel">
          <h3 class="panel-title">
            当前试卷（{{ picked.length }} 题）
            <span class="sub"><el-button size="small" text type="danger" @click="clearAll">清空</el-button></span>
          </h3>

          <div v-for="(q, i) in picked" :key="q.id" class="qrow">
            <div class="qno">{{ i + 1 }}</div>
            <div class="qbody">
              <div class="qstem">{{ q.stem }}</div>
              <div class="qmeta">
                <span class="tier-dot" :style="{ background: tierColor(q.tier) }" />{{ tierName(q.tier) }}
                <el-input
                  class="pt"
                  size="small"
                  :model-value="q.points === null || q.points === undefined ? '' : q.points"
                  placeholder="用题型权重"
                  @change="(v) => overridePoints(q, v)"
                />
                分
              </div>
            </div>
            <div class="qops">
              <el-button size="small" text :disabled="i === 0" @click="moveUp(i)">上移</el-button>
              <el-button size="small" text :disabled="i === picked.length - 1" @click="moveDown(i)">下移</el-button>
              <el-button size="small" text type="danger" @click="removeAt(i)">移除</el-button>
            </div>
          </div>

          <div v-if="!picked.length" class="empty-hint">
            试卷还是空的：在左边勾选题目后点「加入试卷」，或用右上「一键抽题」。
          </div>
        </div>
      </el-col>
    </el-row>

    <el-dialog v-model="drawOpen" title="一键抽题" width="440">
      <div class="tip">按题型从题库随机抽取（已在试卷里的不会重复抽）。</div>
      <el-form label-width="130" style="margin-top: 12px">
        <el-form-item v-for="t in store.tiers" :key="t.key" :label="t.label + '（' + t.weight + '分）'">
          <el-input-number v-model="drawCount[t.key]" :min="0" :max="30" size="small" />
          <span class="avail">可用 {{ store.bank.filter(q => q.tier === t.key && !ids.includes(q.id)).length }} 道</span>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="drawOpen = false">取消</el-button>
        <el-button type="primary" @click="doDraw">抽题并加入</el-button>
      </template>
    </el-dialog>
  </div>
  <div v-else class="panel">
    <div class="empty-hint">
      找不到这套试卷（可能已被删除）。
      <el-button text type="primary" @click="router.push('/papers')">返回列表</el-button>
    </div>
  </div>
</template>

<style scoped>
.filters { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 12px; }
.mini { color: var(--ci-text-weak); font-size: 12px; margin-top: 3px; }
.tag { margin-left: 6px; color: var(--ci-brand); }
.tier-chip { margin-left: 12px; font-size: 12px; }
.qrow { display: flex; gap: 10px; align-items: flex-start; padding: 10px 0; border-bottom: 1px dashed var(--ci-line); }
.qno {
  width: 24px; height: 24px; border-radius: 7px; background: var(--ci-brand-weak); color: var(--ci-brand);
  display: grid; place-items: center; font-size: 12px; font-weight: 700; flex: none;
}
.qbody { flex: 1; min-width: 0; }
.qstem { font-size: 13px; line-height: 1.6; }
.qmeta { display: flex; align-items: center; gap: 6px; color: var(--ci-text-weak); font-size: 12px; margin-top: 4px; }
.pt { width: 92px; }
.qops { display: flex; flex-direction: column; gap: 2px; }
.tip { color: var(--ci-text-weak); font-size: 12px; }
.avail { color: var(--ci-text-weak); font-size: 12px; margin-left: 10px; }
</style>
