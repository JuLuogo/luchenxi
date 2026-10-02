<script setup>
/**
 * 题库中心 · 新建 / 编辑题目
 * 支持 ?id=xxx 进入编辑态。保存前调用 CI.grade.validateQuestion 做"判分风险"自检。
 */
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useClassStore } from '../../../shared/class-store';
import { CI } from '../../../shared/bridge';

const store = useClassStore();
const route = useRoute();
const router = useRouter();

const editingId = ref('');
const form = ref(blank());
const optionsText = ref('');

function blank() {
  return {
    stem: '',
    tier: store.tiers.length ? store.tiers[0].key : 'basic',
    kind: 'auto',            // auto | choice | fill | subjective
    answer: '',
    options: [],
    tags: [],
    points: null,
    source: '',
    note: ''
  };
}

function load(id) {
  const q = store.bank.find((x) => x.id === id);
  if (!q) { editingId.value = ''; form.value = blank(); optionsText.value = ''; return; }
  editingId.value = id;
  const type = CI.grade.typeOf(q);
  form.value = {
    stem: q.stem || '',
    tier: q.tier,
    kind: (q.options && q.options.length) ? 'choice' : (type === 'subjective' ? 'subjective' : 'fill'),
    answer: q.answer || '',
    options: (q.options || []).slice(),
    tags: (q.tags || []).slice(),
    points: q.points === undefined ? null : q.points,
    source: q.source || '',
    note: q.note || ''
  };
  optionsText.value = (q.options || []).join('\n');
}

watch(
  () => [route.query.id, store.bank.length],
  () => load(route.query.id || ''),
  { immediate: true }
);

/** 选项文本 → 数组（自动去掉 "A. " 前缀与空行） */
const parsedOptions = computed(() => optionsText.value
  .split(/\r?\n/)
  .map((x) => x.replace(/^\s*[A-Za-z][.、:：)）]\s*/, '').trim())
  .filter(Boolean));

const preview = computed(() => ({
  stem: form.value.stem,
  tier: form.value.tier,
  options: form.value.kind === 'choice' ? parsedOptions.value : [],
  answer: form.value.answer,
  tags: form.value.tags
}));

const check = computed(() => CI.grade.validateQuestion(preview.value));

function save() {
  if (!form.value.stem.trim()) { ElMessage.error('题干不能为空'); return; }
  if (form.value.kind === 'choice' && parsedOptions.value.length < 2) {
    ElMessage.error('选择题至少要有 2 个选项'); return;
  }
  if (!check.value.ok) {
    ElMessageBox.confirm(
      '这道题有 ' + check.value.warnings.length + ' 处会导致判分异常：\n\n' + check.value.warnings.join('\n'),
      '判分自检未通过',
      { confirmButtonText: '仍然保存', cancelButtonText: '返回修改', type: 'warning' }
    ).then(doSave).catch(() => {});
    return;
  }
  doSave();
}

function doSave() {
  const data = {
    stem: form.value.stem.trim(),
    tier: form.value.tier,
    options: form.value.kind === 'choice' ? parsedOptions.value : [],
    answer: form.value.kind === 'subjective' ? '' : form.value.answer,
    tags: form.value.tags,
    points: form.value.points === '' || form.value.points === null ? null : Number(form.value.points),
    source: form.value.source,
    note: form.value.note
  };
  if (editingId.value) {
    store.updateQuestion(editingId.value, data);
    ElMessage.success('已保存修改');
  } else {
    const q = store.addQuestion(data);
    ElMessage.success('已加入题库');
    editingId.value = q.id;
    router.replace('/bank/new?id=' + q.id);
  }
}

function saveAndNew() {
  doSave();
  editingId.value = '';
  form.value = blank();
  optionsText.value = '';
  router.replace('/bank/new');
}
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h2>{{ editingId ? '编辑题目' : '新建题目' }}</h2>
        <div class="desc">
          题型决定分值权重；选择题答案必须填<b>选项字母</b>（如 B / AC），否则学生提交会全部判错。
        </div>
      </div>
      <div class="actions">
        <el-button @click="router.push('/bank')">返回列表</el-button>
        <el-button v-if="!editingId" @click="saveAndNew">保存并继续新建</el-button>
        <el-button type="primary" @click="save">{{ editingId ? '保存修改' : '保存' }}</el-button>
      </div>
    </div>

    <el-row :gutter="14">
      <el-col :xs="24" :md="16">
        <div class="panel">
          <el-form label-width="96" label-position="right">
            <el-form-item label="题干" required>
              <el-input v-model="form.stem" type="textarea" :rows="3" placeholder="例如：函数 f(x)=x³-3x 的极小值点是？" />
            </el-form-item>

            <el-form-item label="题型">
              <el-select v-model="form.tier" style="width: 220px">
                <el-option
                  v-for="t in store.tiers"
                  :key="t.key"
                  :label="t.label + '（' + t.weight + ' 分/题）'"
                  :value="t.key"
                />
              </el-select>
              <span class="hint">题型与权重在「题型与权重」页维护</span>
            </el-form-item>

            <el-form-item label="作答方式">
              <el-radio-group v-model="form.kind">
                <el-radio-button value="auto">自动</el-radio-button>
                <el-radio-button value="choice">选择题</el-radio-button>
                <el-radio-button value="fill">填空题</el-radio-button>
                <el-radio-button value="subjective">主观题（人工判）</el-radio-button>
              </el-radio-group>
            </el-form-item>

            <el-form-item v-if="form.kind === 'choice' || (form.kind === 'auto' && parsedOptions.length)" label="选项">
              <el-input
                v-model="optionsText"
                type="textarea"
                :rows="4"
                placeholder="每行一个选项，可写 A. xxx 或直接写内容"
              />
            </el-form-item>

            <el-form-item v-if="form.kind !== 'subjective'" label="参考答案">
              <el-input v-model="form.answer" :placeholder="form.kind === 'choice' ? '选项字母，例如 B 或 AC' : '多个可接受答案用 | 分隔，例如 8|八'" />
            </el-form-item>

            <el-form-item label="标签">
              <el-select
                v-model="form.tags"
                multiple
                filterable
                allow-create
                default-first-option
                placeholder="选择或新建标签（如：集合与逻辑）"
                style="width: 100%"
              >
                <el-option v-for="t in store.tags" :key="t.name" :label="t.name" :value="t.name" />
              </el-select>
            </el-form-item>

            <el-form-item label="单独分值">
              <el-input v-model="form.points" placeholder="留空 = 用题型权重" style="width: 200px" />
              <span class="hint">仅这道题特殊时填</span>
            </el-form-item>

            <el-form-item label="来源">
              <el-input v-model="form.source" placeholder="如：2024 真题 / 自编" style="width: 260px" />
            </el-form-item>

            <el-form-item label="备注">
              <el-input v-model="form.note" placeholder="讲评要点等" />
            </el-form-item>
          </el-form>
        </div>
      </el-col>

      <el-col :xs="24" :md="8">
        <div class="panel">
          <h3 class="panel-title">判分自检</h3>
          <el-alert
            v-if="check.ok"
            type="success"
            :closable="false"
            title="这道题可以正常自动判分"
            show-icon
          />
          <el-alert
            v-else
            type="error"
            :closable="false"
            title="保存前请确认"
            show-icon
          >
            <ul class="warns">
              <li v-for="(w, i) in check.warnings" :key="i">{{ w }}</li>
            </ul>
          </el-alert>

          <h3 class="panel-title" style="margin-top: 18px">学生端预览</h3>
          <div class="preview">
            <div class="p-stem">{{ preview.stem || '（题干为空）' }}</div>
            <div v-if="parsedOptions.length" class="p-opts">
              <div v-for="(o, i) in parsedOptions" :key="i" class="p-opt">
                <span class="p-key">{{ CI.grade.LETTERS[i] }}</span>{{ o }}
              </div>
            </div>
            <div v-else-if="form.kind !== 'subjective'" class="p-opt p-fill">
              <span class="p-key">答</span>填空输入框
            </div>
            <div v-else class="p-opt p-fill">
              <span class="p-key">答</span>文字作答（由老师判定）
            </div>
            <div class="p-ans">参考答案：{{ CI.grade.answerKey(preview) || '—（主观题无需）' }}</div>
          </div>
        </div>
      </el-col>
    </el-row>
  </div>
</template>

<style scoped>
.hint { color: var(--ci-text-weak); font-size: 12px; margin-left: 10px; }
.warns { margin: 6px 0 0; padding-left: 18px; }
.preview { border: 1px solid var(--ci-line); border-radius: 10px; padding: 12px; background: #fcfcfd; }
.p-stem { font-size: 14px; line-height: 1.6; margin-bottom: 10px; }
.p-opts { display: grid; gap: 6px; }
.p-opt { display: flex; gap: 8px; align-items: center; font-size: 13px; }
.p-key {
  width: 20px; height: 20px; border-radius: 6px; background: var(--ci-brand-weak);
  color: var(--ci-brand); display: grid; place-items: center; font-size: 12px; font-weight: 600;
}
.p-fill { color: var(--ci-text-weak); }
.p-ans { margin-top: 12px; font-size: 12px; color: var(--ci-text-weak); }
</style>
