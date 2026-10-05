<script setup lang="ts">
/**
 * 设置 · 公开课量规
 *
 * 公开课现场评价的四维量规是**课程政策** —— 各校评课表不同，所以做成可配置的：
 * 维度名、权重、给老师的"看什么"锚点都能改。
 *
 * 默认是 基础掌握 30 / 拓展迁移 30 / 思维表达 25 / 参与态度 15
 * （按公开课评课表"目标达成 / 思维品质 / 参与度 / 表达"的学生侧投影设计，见 docs/15 §2）。
 *
 * 存在 `settings.openDimensions` 里（随课堂同步）—— 换台电脑上课不用重配。
 */
import { computed, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useClassStore } from '../../../shared/class-store';
import { CI } from '../../../shared/bridge';

const store = useClassStore();

type Dim = { key: string; label: string; weight: number; anchor: string };

const rows = ref<Dim[]>(JSON.parse(JSON.stringify(
  (store.settings as any).openDimensions || (CI as any).openclass.defaultDimensions()
)));

/**
 * 档位（档位名从低到高）
 *
 * 分数按档位**均匀映射**：第 k 档 → (k-1)/(N-1)×100（取整，与总分口径一致）。
 * 所以三档就是 0/50/100、四档 0/33/67/100、五档 0/25/50/75/100 —— 不用逐档填分数。
 */
const levelLabels = ref<string[]>(
  ((store.settings as any).openLevels || (CI as any).openclass.defaultLevels()).map((l: any) => l.label)
);

/**
 * 每档的分数（可手动改）
 *
 * 默认按档位**均匀映射**（三档 0/50/100）；但有些学校评课表是"优 90-100、良 80-89"，
 * 那就直接填自己的分数（优=95、良=85…）。
 * **必须严格递增且在 0–100** —— 总分是"落在不超过它的最高一档"，同分/递减会让判断失去意义。
 */
const levelRates = ref<number[]>(
  ((store.settings as any).openLevels || (CI as any).openclass.defaultLevels()).map((l: any) => Number(l.rate))
);

/** 当前档位（名 + 分数），预览与保存都用它 */
function currentLevels(): { label: string; rate: number }[] {
  return levelLabels.value
    .map((label, i) => ({ label: String(label).trim(), rate: Number(levelRates.value[i]) }))
    .filter((l) => !!l.label);
}

/** 按档位均匀映射填充分数（第 k 档 → (k-1)/(N-1)×100） */
function fillUniformRates() {
  const n = levelLabels.value.length;
  levelRates.value = levelLabels.value.map((_, i) =>
    n <= 1 ? 100 : Math.round((i / (n - 1)) * 100)
  );
  ElMessage.info('已按均匀映射填充（' + levelRates.value.join(' / ') + '）');
}

function addLevel() {
  levelLabels.value.push('');
  // 新档默认给个比最后一档更高的分数，省得立刻报"不是递增"
  const last = levelRates.value.length ? levelRates.value[levelRates.value.length - 1] : 0;
  levelRates.value.push(Math.min(100, Math.round(last + 5)));
}
function delLevel(i: number) {
  if (levelLabels.value.length <= 2) { ElMessage.warning('至少保留两档'); return; }
  levelLabels.value.splice(i, 1);
  levelRates.value.splice(i, 1);
}
function resetLevels() {
  const def = (CI as any).openclass.defaultLevels();
  levelLabels.value = def.map((l: any) => l.label);
  levelRates.value = def.map((l: any) => Number(l.rate));
  ElMessage.info('已恢复默认四档');
}

/** 大屏公开展示策略（smart / always / never） */
const policy = ref<string>((store.settings as any).openEvalOnStage || 'smart');

const total = computed(() => rows.value.reduce((n, d) => n + (Number(d.weight) || 0), 0));
const valid = computed(() =>
  rows.value.length >= 2 &&
  rows.value.every((d) => d.label.trim() && d.anchor.trim() && Number(d.weight) > 0)
);

function save() {
  if (!valid.value) { ElMessage.warning('至少两维，且每维都要有名称、锚点与正权重'); return; }
  const clean = rows.value.map((d, i) => ({
    key: d.key || ('d' + (i + 1)),
    label: d.label.trim(),
    weight: Number(d.weight) || 0,
    anchor: d.anchor.trim()
  }));
  const levels = currentLevels();
  if (levels.length < 2) { ElMessage.warning('至少两档，且档位名不能为空'); return; }
  if (!(CI as any).openclass.levelsAreValid(levels)) {
    ElMessage.warning('档位分数必须严格递增且在 0–100（总分是按"落在不超过它的最高一档"算的）');
    return;
  }
  CI.store.updateSettings({ openDimensions: clean, openEvalOnStage: policy.value, openLevels: levels } as any);
  ElMessage.success('已保存（权重不必和为 100，会自动按有效维度归一）');
}

function reset() {
  rows.value = JSON.parse(JSON.stringify((CI as any).openclass.defaultDimensions()));
  ElMessage.info('已恢复默认四维');
}

function addRow() {
  // key 必须唯一：原来用 'd'+(length+1)，删掉中间一维再新增会撞上已存在的 key，
  // 而公开课评价以 key 为索引（scores[d.key] / parts[].key）→ 两个维度共用一份选择（审计发现）
  const used = new Set(rows.value.map((r) => r.key));
  let i = rows.value.length + 1;
  while (used.has('d' + i)) i += 1;
  rows.value.push({ key: 'd' + i, label: '', weight: 10, anchor: '' });
}

function delRow(i: number) {
  if (rows.value.length <= 2) { ElMessage.warning('至少保留两维'); return; }
  rows.value.splice(i, 1);
}

function previewComment() {
  const levels = currentLevels();
  if (!(CI as any).openclass.levelsAreValid(levels)) { ElMessage.warning('先把档位分数调成递增'); return; }
  const n = levels.length;
  const ev = (CI as any).openclass.evaluate(
    rows.value.map((d, i) => ({ key: d.key, score: i === 0 ? n : Math.max(1, n - 1) })),
    rows.value,
    levels
  );
  ElMessageBox.alert(
    '<b>' + ev.total + ' 分 · ' + ev.level + '</b><br/><br/>「' + ev.comment + '」',
    '评语预览（假设第一维优秀、其余良好）',
    { dangerouslyUseHTMLString: true, confirmButtonText: '好' }
  ).catch(() => {});
}
</script>

<template>
  <div class="rubric-page">
    <h2>公开课量规</h2>
    <div class="sub">
      现场评价用哪几个维度、各占多少权重，由你们学校的评课表决定 —— 这里改完，
      公开课评价页与大屏都跟着变。权重不必和为 100（会自动按有效维度归一）。
    </div>

    <el-table :data="rows" class="tbl">
      <el-table-column label="维度名" width="150">
        <template #default="{ row }"><el-input v-model="row.label" placeholder="如 基础掌握" /></template>
      </el-table-column>
      <el-table-column label="看什么（给老师的锚点）" min-width="260">
        <template #default="{ row }"><el-input v-model="row.anchor" placeholder="如 概念、公式、常规运算是否准确" /></template>
      </el-table-column>
      <el-table-column label="权重" width="110">
        <template #default="{ row }"><el-input-number v-model="row.weight" :min="1" :max="100" controls-position="right" /></template>
      </el-table-column>
      <el-table-column label="" width="70">
        <template #default="{ $index }">
          <el-button text type="danger" @click="delRow($index)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <div class="levels">
      <div class="levels-head">
        <b>档位</b>
        <span class="sub">从低到高；分数按档位均匀映射（三档 0/50/100，四档 0/33/67/100，五档 0/25/50/75/100）</span>
        <div class="levels-actions">
          <el-button size="small" @click="addLevel">加一档</el-button>
          <el-button size="small" @click="fillUniformRates">按均匀映射填充</el-button>
          <el-button size="small" @click="resetLevels">恢复默认四档</el-button>
        </div>
      </div>
      <div class="levels-row">
        <div v-for="(_, i) in levelLabels" :key="i" class="level-item">
          <el-input v-model="levelLabels[i]" :placeholder="'第 ' + (i + 1) + ' 档名称'" style="width: 120px" />
          <el-input-number v-model="levelRates[i]" :min="0" :max="100" :step="5" controls-position="right" style="width: 110px" />
          <span class="level-rate">分</span>
          <el-button text type="danger" size="small" @click="delLevel(i)">删</el-button>
        </div>
      </div>
      <div class="levels-hint">
        例：三档填「待改进 / 合格 / 优秀」（分数 0 / 50 / 100）；五档填「差 / 中 / 良 / 优 / 特优」。
        也可以按评课表直接填分数（如「优 95、良 85、中 75、差 60」）。
        <b>分数必须严格递增</b> —— 总分是按「落在不超过它的最高一档」算的。
        <br />
        <b>档位名与分数会出现在公开课评价页、大屏、学生端与导出的 CSV 里。</b>
      </div>
    </div>

    <div class="actions">
      <el-button @click="addRow">加一维</el-button>
      <el-button @click="reset">恢复默认</el-button>
      <el-button @click="previewComment">预览评语</el-button>
      <el-button type="primary" @click="save">保存</el-button>
      <span class="sum" :class="{ bad: total <= 0 }">当前权重合计：{{ total }}</span>
    </div>

    <div class="policy">
      <b>现场评价要不要在大屏公开</b>
      <el-radio-group v-model="policy" class="policy-group">
        <el-radio-button value="smart">公开表扬、私下改进（默认）</el-radio-button>
        <el-radio-button value="always">一律公开</el-radio-button>
        <el-radio-button value="never">一律不公开</el-radio-button>
      </el-radio-group>
      <div class="policy-hint">
        选「公开表扬、私下改进」时：<b>良好/优秀</b>的评价会显示在大屏上；
        <b>合格/待改进</b>只发给学生自己的设备。
        依据：公开"待改进"会让垫底的学生抵触（国内教师反馈"每次抬头就看见自己名字在最后面"），
        而公开表扬是有效的。
      </div>
    </div>

    <el-alert type="info" :closable="false" show-icon class="note">
      <template #title>默认四维是怎么来的</template>
      <div class="note-body">
        公开课评课表普遍看「目标达成 / 思维品质 / 参与度 / 表达」——
        默认四维是它的<b>学生侧投影</b>：听课老师看教师，现场被点评的是学生，两侧口径要能对上。
        如果你们学校有固定评课表，把维度名与权重照抄进来即可。
      </div>
    </el-alert>
  </div>
</template>

<style scoped>
.rubric-page { max-width: 900px; }
.sub { color: var(--el-text-color-secondary); font-size: var(--fs-sm); line-height: 1.7; margin-bottom: var(--sp-4); }
.tbl { margin-bottom: var(--sp-3); }
.actions { display: flex; align-items: center; gap: var(--sp-2); margin-bottom: var(--sp-4); }
.sum { margin-left: auto; color: var(--el-text-color-secondary); font-size: var(--fs-sm); }
.sum.bad { color: var(--el-color-danger); }
.note-body { font-size: var(--fs-sm); line-height: 1.7; }
.levels { margin-bottom: var(--sp-4); }
.levels-head { display: flex; align-items: baseline; gap: var(--sp-2); margin-bottom: var(--sp-2); }
.levels-head .sub { color: var(--el-text-color-secondary); font-size: var(--fs-xs); }
.levels-row { row-gap: var(--sp-2); }
.levels-actions { margin-left: auto; }
.levels-row { display: flex; flex-wrap: wrap; gap: var(--sp-2); }
.level-item { display: flex; align-items: center; gap: var(--sp-2); }
.level-rate { color: var(--el-text-color-secondary); font-size: var(--fs-xs); width: 44px; }
.levels-hint { color: var(--el-text-color-secondary); font-size: var(--fs-xs); margin-top: var(--sp-2); line-height: 1.7; }
.policy { margin-bottom: var(--sp-4); }
.policy-group { margin: var(--sp-2) 0; }
.policy-hint { color: var(--el-text-color-secondary); font-size: var(--fs-sm); line-height: 1.7; }
</style>
