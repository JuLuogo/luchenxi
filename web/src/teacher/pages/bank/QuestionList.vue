<script setup lang="ts">
/**
 * 题库中心 · 题目列表
 * 只做"看与选"：筛选、批量选择、加入试卷、删除；新建/编辑走独立子页。
 */
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useClassStore } from '../../../shared/class-store';
import { CI } from '../../../shared/bridge';

const store = useClassStore();
const router = useRouter();

const keyword = ref('');
const tierFilter = ref('');
const typeFilter = ref('');
const tagFilter = ref('');
const selected = ref<any[]>([]);

const typeLabel = (q) => CI.grade.typeLabel(q);

const filtered = computed(() => store.bank.filter((q) => {
  if (tierFilter.value && q.tier !== tierFilter.value) return false;
  if (typeFilter.value && CI.grade.typeOf(q) !== typeFilter.value) return false;
  if (tagFilter.value && !(q.tags || []).includes(tagFilter.value)) return false;
  if (keyword.value) {
    const k = keyword.value;
    if (q.stem.indexOf(k) < 0 && (q.tags || []).join(' ').indexOf(k) < 0) return false;
  }
  return true;
}));

/** 保存前自检：把"会静默判错"的题目标红 */
const issues = computed(() => {
  const map = new Map();
  store.bank.forEach((q) => {
    const v = CI.grade.validateQuestion(q);
    if (!v.ok) map.set(q.id, v.warnings);
  });
  return map;
});

const tierOf = (key) => store.tiers.find((t) => t.key === key) || { label: key, color: 'var(--c-line-strong)', weight: 0 };

async function removeOne(q) {
  await ElMessageBox.confirm('删除这道题？已加入的试卷会同时移除它。', '删除题目', { type: 'warning' })
    .then(() => { store.removeQuestion(q.id); ElMessage.success('已删除'); }).catch(() => {});
}
function removeSelected() {
  if (!selected.value.length) { ElMessage.warning('请先勾选题'); return; }
  ElMessageBox.confirm(`删除勾选的 ${selected.value.length} 道题？`, '批量删除', { type: 'warning' })
    .then(() => {
      selected.value.slice().forEach((id) => store.removeQuestion(id));
      selected.value = [];
      ElMessage.success('已删除');
    }).catch(() => {});
}

/* ---------- 加入试卷 ---------- */
const addOpen = ref(false);
const targetQuiz = ref('');
function openAdd() {
  if (!selected.value.length) { ElMessage.warning('请先勾选题'); return; }
  targetQuiz.value = store.currentQuiz ? store.currentQuiz.id : (store.quizzes[0] ? store.quizzes[0].id : '');
  addOpen.value = true;
}
function confirmAdd() {
  if (!targetQuiz.value) { ElMessage.error('请选择试卷'); return; }
  // addQuestionsToQuiz 返回的是**数字**（实际追加了几题），不是 {added} 对象 ——
  // 按对象读会让提示恒等于勾选数量（重复加入也报"已加入 N 道"，审计发现）
  const added = Number(store.addQuestionsToQuiz(targetQuiz.value, selected.value.slice())) || 0;
  const picked = selected.value.length;
  addOpen.value = false;
  if (added === 0) ElMessage.warning(`这 ${picked} 道题都已在试卷中`);
  else if (added < picked) ElMessage.success(`已加入 ${added} 道（${picked - added} 道已在试卷中）`);
  else ElMessage.success(`已加入 ${added} 道题`);
}
function createAndAdd() {
  ElMessageBox.prompt('新试卷名称', '新建试卷并加入', { inputValue: '第 ' + (store.quizzes.length + 1) + ' 次随堂测' })
    .then(({ value }) => {
      const quiz = store.createQuiz(value || '随堂测', selected.value.slice());
      addOpen.value = false;
      selected.value = [];
      ElMessage.success('已新建试卷并加入 ' + (quiz.questionIds || []).length + ' 道题');
      router.push('/papers/' + quiz.id);
    }).catch(() => {});
}

function exportBank() {
  const data = store.exportBank();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = '题库导出-' + new Date().toISOString().slice(0, 10) + '.json';
  a.click();
  URL.revokeObjectURL(a.href);
  ElMessage.success('题库已导出');
}
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h2>题目列表</h2>
        <div class="desc">
          共 {{ store.bank.length }} 道题；按题型加权记分，题目本身不写分值。
          <template v-if="issues.size">
            <el-tag type="danger" size="small" effect="plain" style="margin-left: var(--sp-2)">
              {{ issues.size }} 道题有判分风险
            </el-tag>
          </template>
        </div>
      </div>
      <div class="actions">
        <el-button @click="exportBank">导出题库</el-button>
        <el-button type="danger" plain :disabled="!selected.length" @click="removeSelected">批量删除</el-button>
        <el-button type="primary" :disabled="!selected.length" @click="openAdd">加入试卷</el-button>
        <el-button type="primary" plain @click="router.push('/bank/new')">新建题目</el-button>
      </div>
    </div>

    <div class="panel">
      <div class="filters">
        <el-input v-model="keyword" placeholder="搜题干或标签" clearable style="width: 220px" />
        <el-select v-model="tierFilter" placeholder="全部题型" clearable style="width: 150px">
          <el-option v-for="t in store.tiers" :key="t.key" :label="t.label + '（' + t.weight + ' 分）'" :value="t.key" />
        </el-select>
        <el-select v-model="typeFilter" placeholder="全部作答方式" clearable style="width: 150px">
          <el-option label="选择题" value="choice" />
          <el-option label="填空题" value="fill" />
          <el-option label="主观题" value="subjective" />
        </el-select>
        <el-select v-model="tagFilter" placeholder="全部标签" clearable filterable style="width: 170px">
          <el-option v-for="t in store.tags" :key="t.name" :label="t.name + '（' + t.count + '）'" :value="t.name" />
        </el-select>
        <span class="count">筛选出 {{ filtered.length }} 道</span>
      </div>

      <el-table
        :data="filtered"
        size="small"
        style="width: 100%"
        @selection-change="(rows) => (selected = rows.map((r) => r.id))"
      >
        <el-table-column type="selection" width="42" />
        <el-table-column label="题干" min-width="300">
          <template #default="{ row }">
            <div class="stem">
              <el-icon v-if="issues.has(row.id)" color="var(--c-bad)" :title="issues.get(row.id).join('；')">
                <WarningFilled />
              </el-icon>
              {{ row.stem }}
            </div>
            <div v-if="row.options && row.options.length" class="opts">
              <span v-for="(o, i) in row.options" :key="i" class="opt">
                {{ CI.grade.LETTERS[i] }}. {{ o }}
              </span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="题型" width="120">
          <template #default="{ row }">
            <span class="tier-dot" :style="{ background: tierOf(row.tier).color }" />{{ tierOf(row.tier).label }}
          </template>
        </el-table-column>
        <el-table-column label="分值" width="70" align="right">
          <template #default="{ row }">{{ store.questionPoints(row) }}</template>
        </el-table-column>
        <el-table-column label="作答方式" width="100">
          <template #default="{ row }">
            <el-tag size="small" effect="plain" :type="CI.grade.canAutoGrade(row) ? 'success' : 'info'">
              {{ typeLabel(row) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="答案" width="130">
          <template #default="{ row }">
            <span class="ans">{{ CI.grade.answerKey(row) || '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="标签" min-width="140">
          <template #default="{ row }">
            <el-tag v-for="t in row.tags" :key="t" size="small" effect="plain" class="tag">{{ t }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="130" fixed="right">
          <template #default="{ row }">
            <el-button size="small" text @click="router.push('/bank/new?id=' + row.id)">编辑</el-button>
            <el-button size="small" text type="danger" @click="removeOne(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>

      <div v-if="!filtered.length" class="empty-hint">
        {{ store.bank.length ? '没有匹配的题目' : '题库还是空的：点「新建题目」或「批量导入」开始建库' }}
      </div>
    </div>

    <el-dialog v-model="addOpen" title="加入试卷" width="420">
      <el-form label-width="90">
        <el-form-item label="选择试卷">
          <el-select v-model="targetQuiz" placeholder="选择一套试卷" style="width: 100%">
            <el-option v-for="q in store.quizzes" :key="q.id" :label="q.name" :value="q.id" />
          </el-select>
        </el-form-item>
        <div class="tip">将加入 {{ selected.length }} 道题；也可以直接新建一套。</div>
      </el-form>
      <template #footer>
        <el-button @click="addOpen = false">取消</el-button>
        <el-button @click="createAndAdd">新建试卷并加入</el-button>
        <el-button type="primary" :disabled="!store.quizzes.length" @click="confirmAdd">加入</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.filters { display: flex; gap: var(--sp-2); align-items: center; margin-bottom: var(--sp-3); flex-wrap: wrap; }
.count { color: var(--ci-text-weak); font-size: var(--fs-xs); }
.stem { display: flex; align-items: flex-start; gap: var(--sp-2); }
.opts { margin-top: var(--sp-1); display: flex; gap: var(--sp-3); flex-wrap: wrap; color: var(--ci-text-weak); font-size: var(--fs-xs); }
.ans { color: var(--ci-text-weak); }
.tag { margin-right: var(--sp-1); }
.tip { color: var(--ci-text-weak); font-size: var(--fs-xs); }
</style>
