<script setup lang="ts">
/**
 * 题库中心 · 标签管理
 * 标签是从题目里聚合出来的（store.tags），这里做重命名 / 合并 / 删除这类批量维护。
 */
import { computed, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useClassStore } from '../../../shared/class-store';

const store = useClassStore();
const keyword = ref('');
const selected = ref<any[]>([]);

const list = computed(() => store.tags.filter((t) => !keyword.value || t.name.indexOf(keyword.value) >= 0));

/** 某标签覆盖的题型分布 */
function tierOf(tag) {
  const map = new Map();
  store.bank.filter((q) => (q.tags || []).includes(tag)).forEach((q) => {
    const t = store.tiers.find((x) => x.key === q.tier);
    const label = t ? t.label : q.tier;
    map.set(label, (map.get(label) || 0) + 1);
  });
  return [...map.entries()].map(([k, v]) => k + '×' + v).join(' · ');
}

async function rename(tag) {
  const { value } = await ElMessageBox.prompt('新标签名（会更新所有用到它的题目）', '重命名标签', {
    inputValue: tag.name
  }).catch(() => ({ value: '' }));
  const next = (value || '').trim();
  if (!next || next === tag.name) return;
  let n = 0;
  store.bank.forEach((q) => {
    if ((q.tags || []).includes(tag.name)) {
      const tags = q.tags.map((x) => (x === tag.name ? next : x)).filter((x, i, arr) => arr.indexOf(x) === i);
      store.updateQuestion(q.id, { tags });
      n += 1;
    }
  });
  ElMessage.success(`已更新 ${n} 道题的标签`);
}

async function merge(tag) {
  const options = store.tags.filter((t) => t.name !== tag.name);
  if (!options.length) { ElMessage.info('没有其它标签可合并'); return; }
  const { value } = await ElMessageBox.prompt(
    '把「' + tag.name + '」合并到哪个标签？\n可选：' + options.map((t) => t.name).join('、'),
    '合并标签'
  ).catch(() => ({ value: '' }));
  const target = (value || '').trim();
  if (!target) return;
  let n = 0;
  store.bank.forEach((q) => {
    if ((q.tags || []).includes(tag.name)) {
      const tags = q.tags.map((x) => (x === tag.name ? target : x)).filter((x, i, arr) => arr.indexOf(x) === i);
      store.updateQuestion(q.id, { tags });
      n += 1;
    }
  });
  ElMessage.success(`已把 ${n} 道题合并到「${target}」`);
}

async function drop(tag) {
  await ElMessageBox.confirm(
    `从所有题目上移除标签「${tag.name}」？（题目本身保留）`, '删除标签', { type: 'warning' }
  ).then(() => {
    let n = 0;
    store.bank.forEach((q) => {
      if ((q.tags || []).includes(tag.name)) {
        store.updateQuestion(q.id, { tags: q.tags.filter((x) => x !== tag.name) });
        n += 1;
      }
    });
    ElMessage.success(`已从 ${n} 道题上移除`);
  }).catch(() => {});
}

function batchMerge() {
  if (selected.value.length < 2) { ElMessage.warning('至少勾选两个标签'); return; }
  ElMessageBox.prompt('把这些标签合并为（输入目标标签名）', '批量合并')
    .then(({ value }) => {
      const target = (value || '').trim();
      if (!target) return;
      const from = new Set(selected.value);
      let n = 0;
      store.bank.forEach((q) => {
        if ((q.tags || []).some((x) => from.has(x))) {
          const tags = q.tags.map((x) => (from.has(x) ? target : x)).filter((x, i, arr) => arr.indexOf(x) === i);
          store.updateQuestion(q.id, { tags });
          n += 1;
        }
      });
      selected.value = [];
      ElMessage.success(`已合并 ${from.size} 个标签，涉及 ${n} 道题`);
    }).catch(() => {});
}

/** 某标签下题目的平均难度（用权重近似） */
function avgWeight(tag) {
  const qs = store.bank.filter((q) => (q.tags || []).includes(tag));
  if (!qs.length) return 0;
  const sum = qs.reduce((a, q) => a + store.questionPoints(q), 0);
  return Math.round((sum / qs.length) * 10) / 10;
}
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h2>标签管理</h2>
        <div class="desc">
          标签用于按知识点组卷与做学情分析；{{ store.tags.length }} 个标签，覆盖 {{ store.bank.filter((q) => (q.tags || []).length).length }} 道题。
        </div>
      </div>
      <div class="actions">
        <el-button :disabled="selected.length < 2" @click="batchMerge">合并选中</el-button>
        <el-button @click="$router.push('/bank')">去题目列表打标签</el-button>
      </div>
    </div>

    <div class="panel">
      <div class="filters">
        <el-input v-model="keyword" placeholder="搜标签" clearable style="width: 200px" />
        <span class="count">{{ list.length }} 个</span>
      </div>

      <el-table :data="list" size="small" @selection-change="(rows) => (selected = rows.map((r) => r.name))">
        <el-table-column type="selection" width="42" />
        <el-table-column label="标签" min-width="180">
          <template #default="{ row }">
            <el-tag effect="plain">{{ row.name }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="题量" width="90" align="right">
          <template #default="{ row }">{{ row.count }}</template>
        </el-table-column>
        <el-table-column label="平均权重" width="110" align="right">
          <template #default="{ row }">{{ avgWeight(row.name) }}</template>
        </el-table-column>
        <el-table-column label="题型分布" min-width="200" show-overflow-tooltip>
          <template #default="{ row }">{{ tierOf(row.name) || '—' }}</template>
        </el-table-column>
        <el-table-column label="操作" width="200" fixed="right">
          <template #default="{ row }">
            <el-button size="small" text @click="rename(row)">重命名</el-button>
            <el-button size="small" text @click="merge(row)">合并</el-button>
            <el-button size="small" text type="danger" @click="drop(row)">移除</el-button>
          </template>
        </el-table-column>
      </el-table>

      <div v-if="!list.length" class="empty-hint">
        {{ store.tags.length ? '没有匹配的标签' : '还没有标签：在「新建题目」里给题目加标签即可' }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.filters { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.count { color: var(--ci-text-weak); font-size: 12px; }
</style>
