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
  CI.store.updateSettings({ openDimensions: clean } as any);
  ElMessage.success('已保存（权重不必和为 100，会自动按有效维度归一）');
}

function reset() {
  rows.value = JSON.parse(JSON.stringify((CI as any).openclass.defaultDimensions()));
  ElMessage.info('已恢复默认四维');
}

function addRow() {
  rows.value.push({ key: 'd' + (rows.value.length + 1), label: '', weight: 10, anchor: '' });
}

function delRow(i: number) {
  if (rows.value.length <= 2) { ElMessage.warning('至少保留两维'); return; }
  rows.value.splice(i, 1);
}

function previewComment() {
  const ev = (CI as any).openclass.evaluate(
    rows.value.map((d, i) => ({ key: d.key, score: i === 0 ? 4 : 3 })),
    rows.value
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

    <div class="actions">
      <el-button @click="addRow">加一维</el-button>
      <el-button @click="reset">恢复默认</el-button>
      <el-button @click="previewComment">预览评语</el-button>
      <el-button type="primary" @click="save">保存</el-button>
      <span class="sum" :class="{ bad: total <= 0 }">当前权重合计：{{ total }}</span>
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
.sub { color: var(--el-text-color-secondary); font-size: 13px; line-height: 1.7; margin-bottom: 14px; }
.tbl { margin-bottom: 12px; }
.actions { display: flex; align-items: center; gap: 10px; margin-bottom: 16px; }
.sum { margin-left: auto; color: var(--el-text-color-secondary); font-size: 13px; }
.sum.bad { color: var(--el-color-danger); }
.note-body { font-size: 13px; line-height: 1.7; }
</style>
