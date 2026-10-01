<script setup>
/**
 * 试卷中心 · 试卷列表
 * 一套试卷 = 一次随堂测的题目集合；「设为当前」后课堂协同页的上一题/下一题就在这套题里移动。
 */
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useClassStore } from '../../../shared/class-store.js';

const store = useClassStore();
const router = useRouter();
const newName = ref('');

const rows = computed(() => store.quizzes.map((q) => {
  const qs = (q.questionIds || []).map((id) => store.bank.find((x) => x.id === id)).filter(Boolean);
  const records = q.records || [];
  const total = qs.reduce((a, x) => a + store.questionPoints(x), 0);
  const answered = new Set(records.map((r) => r.sid)).size;
  return {
    id: q.id,
    name: q.name,
    note: q.note || '',
    count: qs.length,
    total,
    answered,
    records: records.length,
    closed: !!q.closedAt,
    createdAt: q.createdAt,
    isCurrent: store.runtime.quizId === q.id
  };
}));

function create() {
  const name = (newName.value || '').trim() || ('第 ' + (store.quizzes.length + 1) + ' 次随堂测');
  const quiz = store.createQuiz(name, [], '');
  newName.value = '';
  ElMessage.success('已新建试卷：' + name);
  router.push('/papers/' + quiz.id);
}

async function rename(row) {
  const { value } = await ElMessageBox.prompt('试卷名称', '重命名', { inputValue: row.name }).catch(() => ({}));
  if (value) store.updateQuiz(row.id, { name: value });
}
function duplicate(row) {
  const src = store.quizzes.find((q) => q.id === row.id);
  const quiz = store.createQuiz(row.name + '（副本）', (src.questionIds || []).slice(), src.note || '');
  ElMessage.success('已复制为：' + quiz.name);
}
function setCurrent(row) {
  store.setCurrentQuiz(row.id);
  ElMessage.success('已把「' + row.name + '」设为当前试卷');
}
async function remove(row) {
  await ElMessageBox.confirm(`删除试卷「${row.name}」？（题库不受影响）`, '删除试卷', { type: 'warning' })
    .then(() => { store.deleteQuiz(row.id); ElMessage.success('已删除'); }).catch(() => {});
}
async function toggleClose(row) {
  if (row.closed) { store.updateQuiz(row.id, { closedAt: 0 }); ElMessage.success('已重新打开'); }
  else {
    await ElMessageBox.confirm('关闭后本套试卷不再接收提交（可用于下课前收卷）。', '结束这套题', { type: 'warning' })
      .then(() => { store.closeQuiz(row.id); ElMessage.success('已结束'); }).catch(() => {});
  }
}
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h2>试卷列表</h2>
        <div class="desc">共 {{ rows.length }} 套；点「设为当前」后，课堂协同页按这套题的顺序推题。</div>
      </div>
      <div class="actions">
        <el-input v-model="newName" placeholder="新试卷名称（可留空）" style="width: 200px" />
        <el-button type="primary" @click="create">新建并组卷</el-button>
      </div>
    </div>

    <div class="panel">
      <el-table :data="rows" size="small">
        <el-table-column label="试卷" min-width="220">
          <template #default="{ row }">
            <b>{{ row.name }}</b>
            <el-tag v-if="row.isCurrent" size="small" type="success" effect="plain" style="margin-left: 8px">当前</el-tag>
            <el-tag v-if="row.closed" size="small" type="info" effect="plain" style="margin-left: 6px">已结束</el-tag>
            <div v-if="row.note" class="note">{{ row.note }}</div>
          </template>
        </el-table-column>
        <el-table-column label="题量" width="80" align="right">
          <template #default="{ row }">{{ row.count }}</template>
        </el-table-column>
        <el-table-column label="总分" width="80" align="right">
          <template #default="{ row }"><span class="score-num">{{ row.total }}</span></template>
        </el-table-column>
        <el-table-column label="已作答" width="110" align="right">
          <template #default="{ row }">{{ row.answered }} 人 / {{ row.records }} 条</template>
        </el-table-column>
        <el-table-column label="创建时间" width="170">
          <template #default="{ row }">{{ new Date(row.createdAt).toLocaleString('zh-CN') }}</template>
        </el-table-column>
        <el-table-column label="操作" width="300" fixed="right">
          <template #default="{ row }">
            <el-button size="small" text type="primary" @click="router.push('/papers/' + row.id)">组卷</el-button>
            <el-button size="small" text :disabled="row.isCurrent" @click="setCurrent(row)">设为当前</el-button>
            <el-button size="small" text @click="rename(row)">改名</el-button>
            <el-button size="small" text @click="duplicate(row)">复制</el-button>
            <el-button size="small" text @click="toggleClose(row)">{{ row.closed ? '重开' : '结束' }}</el-button>
            <el-button size="small" text type="danger" @click="remove(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
      <div v-if="!rows.length" class="empty-hint">
        还没有试卷。点右上「新建并组卷」，或在「题目列表」勾选题目后点「加入试卷」。
      </div>
    </div>
  </div>
</template>

<style scoped>
.note { color: var(--ci-text-weak); font-size: 12px; margin-top: 2px; }
</style>
