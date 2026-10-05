<script setup lang="ts">
/**
 * 题库中心 · 题型与权重
 * 这里定义"答对一道题加几分"；学生端的得分完全由题型权重驱动（题目本身不写分值）。
 */
import { ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useClassStore } from '../../../shared/class-store';
import { CI } from '../../../shared/bridge';

const store = useClassStore();
const dialog = ref(false);
const editing = ref('');
const form = ref({ label: '', weight: 3, color: '#4f46e5', desc: '' });

const COLORS = ['#10b981', '#3b82f6', '#f59e0b', '#ef4444', '#8b5cf6', '#14b8a6', '#ec4899', '#64748b'];

function openNew() {
  editing.value = '';
  form.value = { label: '', weight: 3, color: COLORS[store.tiers.length % COLORS.length], desc: '' };
  dialog.value = true;
}
function openEdit(t) {
  editing.value = t.key;
  form.value = { label: t.label, weight: t.weight, color: t.color, desc: t.desc || '' };
  dialog.value = true;
}
function save() {
  if (!form.value.label.trim()) { ElMessage.error('请填名称'); return; }
  const weight = Number(form.value.weight);
  if (!isFinite(weight) || weight === 0) { ElMessage.error('权重必须是非 0 数字（答错扣分用负数）'); return; }
  if (editing.value) {
    store.updateTier(editing.value, { label: form.value.label, weight, color: form.value.color, desc: form.value.desc });
    ElMessage.success('已保存');
  } else {
    store.addTier({ label: form.value.label, weight, color: form.value.color, desc: form.value.desc });
    ElMessage.success('已新增题型');
  }
  dialog.value = false;
}
function remove(t) {
  const used = store.bank.filter((q) => q.tier === t.key).length;
  ElMessageBox.confirm(
    used ? `「${t.label}」下还有 ${used} 道题，删除后这些题需要重新指定题型。确定删除？` : `确定删除题型「${t.label}」？`,
    '删除题型', { type: 'warning' }
  ).then(() => { store.removeTier(t.key); ElMessage.success('已删除'); }).catch(() => {});
}

/** 每种题型的题量与累计得分（口径来自领域层，不在界面重算） */
function stat(t: any) {
  const qs = store.bank.filter((q: any) => q.tier === t.key);
  // 审计发现：界面原来自己 flatMap 全部流水算"已判次数/累计得分"，与领域层口径不同
  // （CI.store.recordsOf 会按 isCountable 排除纯手动与无题型流水）→
  // 同一数字在"题型与权重"页与"学情分析"页会不一致。改用领域层口径。
  const recs = CI.store.recordsOf(store.state, { tier: t.key, countable: true }) as any[];
  return {
    questions: qs.length,
    records: recs.length,
    points: recs.reduce((a: number, r: any) => a + (r.points || 0), 0)
  };
}

const RESULTS = ['correct', 'half', 'wrong', 'skip'];
function ratioLabel(result) {
  const ratio = CI.store.RESULT_RATIO[result];
  return ratio === undefined ? '' : ratio * 100 + '%';
}
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h2>题型与权重</h2>
        <div class="desc">
          答对一道题加几分由这里决定；「半对」按 50% 计。当前 {{ store.tiers.length }} 种题型。
        </div>
      </div>
      <div class="actions">
        <el-button type="primary" @click="openNew">新增题型</el-button>
      </div>
    </div>

    <div class="panel">
      <el-table :data="store.tiers" size="small">
        <el-table-column label="题型" min-width="160">
          <template #default="{ row }">
            <span class="tier-dot" :style="{ background: row.color }" />{{ row.label }}
            <span class="key">{{ row.key }}</span>
          </template>
        </el-table-column>
        <el-table-column label="权重（分/题）" width="130" align="right">
          <template #default="{ row }">
            <span class="score-num" :class="row.weight < 0 ? 'score-neg' : 'score-pos'">{{ row.weight }}</span>
          </template>
        </el-table-column>
        <el-table-column label="题库题量" width="110" align="right">
          <template #default="{ row }">{{ stat(row).questions }}</template>
        </el-table-column>
        <el-table-column label="已判次数" width="110" align="right">
          <template #default="{ row }">{{ stat(row).records }}</template>
        </el-table-column>
        <el-table-column label="累计得分" width="110" align="right">
          <template #default="{ row }">
            <span class="score-num">{{ stat(row).points }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="desc" label="说明" min-width="160" show-overflow-tooltip />
        <el-table-column label="操作" width="120" fixed="right">
          <template #default="{ row }">
            <el-button size="small" text @click="openEdit(row)">编辑</el-button>
            <el-button size="small" text type="danger" @click="remove(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <div class="panel">
      <h3 class="panel-title">判定结果与折算<span class="sub">判定结果的口径对所有题型一致</span></h3>
      <el-descriptions :column="4" border size="small">
        <el-descriptions-item v-for="r in RESULTS" :key="r" :label="CI.store.RESULT_LABEL[r]">
          {{ ratioLabel(r) }}
        </el-descriptions-item>
      </el-descriptions>
    </div>

    <el-dialog v-model="dialog" :title="editing ? '编辑题型' : '新增题型'" width="440">
      <el-form label-width="90">
        <el-form-item label="名称" required>
          <el-input v-model="form.label" placeholder="基础题 / 拔高题 / 提升题" />
        </el-form-item>
        <el-form-item label="权重">
          <el-input v-model="form.weight" style="width: 140px" />
          <span class="hint">答对得分；负数表示答对也扣分（谨慎用）</span>
        </el-form-item>
        <el-form-item label="颜色">
          <el-color-picker v-model="form.color" :predefine="COLORS" />
        </el-form-item>
        <el-form-item label="说明">
          <el-input v-model="form.desc" placeholder="例如：面向全体，答对即得" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialog = false">取消</el-button>
        <el-button type="primary" @click="save">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.key { color: var(--ci-text-weak); font-size: var(--fs-xs); margin-left: var(--sp-2); }
.hint { color: var(--ci-text-weak); font-size: var(--fs-xs); margin-left: var(--sp-2); }
</style>
