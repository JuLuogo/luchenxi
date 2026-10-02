<script setup lang="ts">
/**
 * 题库中心 · 批量导入
 * 解析器直接用 CI.bankUI.parseImport（与旧版同一套规则，已被测试覆盖），
 * 导入前用 CI.grade.validateQuestion 列出判分风险并让老师确认。
 */
import { computed, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useClassStore } from '../../../shared/class-store';
import { CI } from '../../../shared/bridge';

const store = useClassStore();
const text = ref('');
const defTier = ref(store.tiers.length ? store.tiers[0].key : 'basic');
const dedupe = ref(true);
const fileInput = ref<any>(null);

const SAMPLE = [
  '集合 {1,2,3} 的子集个数是？ | 6 ; 8 ; 9 | B',
  '函数 f(x)=x³-3x 的极小值点 | x=1',
  '说明你的解题思路（主观题，留空答案） | '
].join('\n');

const parsed = computed(() => {
  if (!text.value.trim()) return [];
  try {
    return CI.bankUI.parseImport(text.value);
  } catch (e) {
    return [{ __error: e.message }];
  }
});

const issues = computed(() => parsed.value
  .map((q, i) => ({ q, i, v: q && !q.__error ? CI.grade.validateQuestion(q) : { ok: true, warnings: [] } }))
  .filter((x) => !x.v.ok));

const kindLabel = (q) => {
  if (!q) return '';
  return q.options && q.options.length ? '选择题' : (String(q.answer || '').trim() ? '填空题' : '主观题');
};

function doImport() {
  const list = parsed.value.filter((q) => q && !q.__error);
  if (!list.length) { ElMessage.warning('没有解析到题目'); return; }
  list.forEach((q) => { if (!q.tier) q.tier = defTier.value; });

  const run = () => {
    const res = store.bulkImportQuestions(list, { dedupe: dedupe.value });
    ElMessage.success(`导入完成：新增 ${res.added} 题，跳过 ${res.skipped} 题`);
    text.value = '';
  };

  if (issues.value.length) {
    ElMessageBox.confirm(
      '有 ' + issues.value.length + ' 处会导致判分异常：\n\n' +
      issues.value.slice(0, 5).map((x) => `第 ${x.i + 1} 题：${x.v.warnings[0]}`).join('\n') +
      (issues.value.length > 5 ? `\n…（共 ${issues.value.length} 题）` : '') +
      '\n\n仍然导入吗？',
      '导入前自检', { confirmButtonText: '仍然导入', cancelButtonText: '返回修改', type: 'warning' }
    ).then(run).catch(() => {});
    return;
  }
  run();
}

function pickFile() { if (fileInput.value) fileInput.value.click(); }

function onFile(e) {
  const f = e.target.files && e.target.files[0];
  if (!f) return;
  const reader = new FileReader();
  reader.onload = () => {
    text.value = String(reader.result || '');
    ElMessage.success('已读取文件：' + f.name);
  };
  reader.readAsText(f, 'utf-8');
  e.target.value = '';
}

function downloadTemplate() {
  const sample = store.tiers.map((t, i) => ({
    stem: `【${t.label}示例】请替换为真实题干${i + 1}`,
    tier: t.key,
    answer: t.key === 'improve' ? '' : '参考答案',
    options: [],
    tags: ['示例'],
    source: '',
    note: ''
  }));
  const blob = new Blob([JSON.stringify({ type: 'ci-question-bank', version: 2, questions: sample }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = '题库导入模板.json';
  a.click();
  URL.revokeObjectURL(a.href);
}
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h2>批量导入</h2>
        <div class="desc">
          支持两种格式：<b>竖线文本</b>（每行一题）与 <b>JSON</b>（题库导出文件）。
        </div>
      </div>
      <div class="actions">
        <el-button @click="downloadTemplate">下载模板</el-button>
        <el-button @click="pickFile">读取文件</el-button>
        <el-button type="primary" :disabled="!parsed.length" @click="doImport">
          导入 {{ parsed.filter((q) => !q.__error).length }} 道题
        </el-button>
        <input ref="fileInput" type="file" accept=".json,.txt,.csv" style="display: none" @change="onFile" />
      </div>
    </div>

    <el-row :gutter="14">
      <el-col :xs="24" :md="13">
        <div class="panel">
          <h3 class="panel-title">
            粘贴内容
            <el-button size="small" text @click="text = SAMPLE">填入示例</el-button>
          </h3>
          <el-input
            v-model="text"
            type="textarea"
            :rows="16"
            placeholder="填空题：题干 | 答案&#10;选择题：题干 | 选项1 ; 选项2 ; 选项3 | 答案字母&#10;主观题：题干 | （答案留空）"
          />
          <div class="opts-row">
            <span>默认题型</span>
            <el-select v-model="defTier" style="width: 160px" size="small">
              <el-option v-for="t in store.tiers" :key="t.key" :label="t.label" :value="t.key" />
            </el-select>
            <el-checkbox v-model="dedupe">自动去重（题干相同则跳过）</el-checkbox>
          </div>
        </div>
      </el-col>

      <el-col :xs="24" :md="11">
        <div class="panel">
          <h3 class="panel-title">
            解析预览
            <span class="sub">{{ parsed.length }} 行 / {{ parsed.filter((q) => !q.__error).length }} 道可导入</span>
          </h3>

          <el-alert
            v-for="(x, i) in issues"
            :key="i"
            type="warning"
            :closable="false"
            show-icon
            style="margin-bottom: 8px"
            :title="'第 ' + (x.i + 1) + ' 题：' + x.v.warnings[0]"
          />

          <div v-if="parsed.some((q) => q.__error)" class="parse-err">
            解析失败：{{ parsed.find((q) => q.__error).__error }}
          </div>

          <el-table :data="parsed.filter((q) => !q.__error)" size="small" max-height="380">
            <el-table-column type="index" width="46" label="#" />
            <el-table-column prop="stem" label="题干" show-overflow-tooltip min-width="180" />
            <el-table-column label="类型" width="86">
              <template #default="{ row }">{{ kindLabel(row) }}</template>
            </el-table-column>
            <el-table-column prop="answer" label="答案" width="110" show-overflow-tooltip />
          </el-table>
          <div v-if="!parsed.length" class="empty-hint">左边粘贴内容后这里会实时显示解析结果</div>
        </div>
      </el-col>
    </el-row>
  </div>
</template>

<style scoped>
.opts-row { display: flex; align-items: center; gap: 12px; margin-top: 12px; color: var(--ci-text-weak); font-size: 13px; }
.parse-err { color: var(--ci-bad); font-size: 13px; margin-bottom: 8px; }
</style>
