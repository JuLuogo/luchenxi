<script setup lang="ts">
/**
 * 班级与积分：队伍 + 学生名单 + 记分。
 * 页面内部再分三块（队伍 / 名单表格 / 分数流水），不再像旧版那样把所有控件平铺。
 */
import { computed, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useClassStore } from '../../shared/class-store';

const store = useClassStore();

const keyword = ref('');
const teamFilter = ref('');
const selected = ref<any[]>([]);          // 多选的学生 id，用于批量操作
const detailSid = ref('');         // 右侧抽屉：某个学生的分数明细

const filtered = computed(() => store.students.filter((s) => {
  if (teamFilter.value && s.teamId !== teamFilter.value) return false;
  if (keyword.value && s.name.indexOf(keyword.value) < 0) return false;
  return true;
}));

const teamName = (tid) => {
  const t = store.teams.find((x) => x.id === tid);
  return t ? t.name : '未分组';
};

const drawerStudent = computed(() => store.students.find((s) => s.id === detailSid.value) || null);
const drawerRecords = computed(() => (detailSid.value ? store.recordsOf(detailSid.value) : []));

/* ---------- 队伍 ---------- */
async function addTeam() {
  const { value } = await ElMessageBox.prompt('队伍名称', '新增队伍', { inputPlaceholder: '例如：第一组' }).catch(() => ({ value: '' }));
  if (value) { store.addTeam(value); ElMessage.success('已新增队伍'); }
}
async function renameTeam(t) {
  const { value } = await ElMessageBox.prompt('队伍名称', '重命名', { inputValue: t.name }).catch(() => ({ value: '' }));
  if (value) store.updateTeam(t.id, { name: value });
}
async function removeTeam(t) {
  const n = store.studentsOf(t.id).length;
  await ElMessageBox.confirm(
    n ? `「${t.name}」下还有 ${n} 名学生，删除后这些学生会变成"未分组"。确定删除？` : `确定删除「${t.name}」？`,
    '删除队伍', { type: 'warning' }
  ).then(() => { store.removeTeam(t.id); ElMessage.success('已删除'); }).catch(() => {});
}

/* ---------- 学生 ---------- */
const bulkOpen = ref(false);
const bulkText = ref('');
const bulkTeam = ref('');

function openBulk() {
  bulkText.value = '';
  bulkTeam.value = store.teams[0] ? store.teams[0].id : '';
  bulkOpen.value = true;
}
function doBulk() {
  const text = bulkText.value.trim();
  if (!text) { ElMessage.warning('请先粘贴名单'); return; }
  const res = store.addStudentsBulk(text, bulkTeam.value || '');
  bulkOpen.value = false;
  ElMessage.success(`已添加 ${(res && res.added) || 0} 名学生`);
}

async function renameStudent(s) {
  const { value } = await ElMessageBox.prompt('学生姓名', '重命名', { inputValue: s.name }).catch(() => ({ value: '' }));
  if (value) store.updateStudent(s.id, { name: value });
}
async function moveStudent(s) {
  const list = store.teams.map((t) => `${t.id}｜${t.name}`).join('\n');
  const { value } = await ElMessageBox.prompt(
    '输入要移入的队伍（复制前面的 id）\n' + list, '调整队伍', { inputPlaceholder: 'team id' }
  ).catch(() => ({ value: '' }));
  if (value && store.teams.some((t) => t.id === value.trim())) {
    store.updateStudent(s.id, { teamId: value.trim() });
    ElMessage.success('已调整');
  } else if (value) {
    ElMessage.error('没有这个队伍 id');
  }
}
async function removeStudent(s) {
  await ElMessageBox.confirm(`删除「${s.name}」？该生已有分数记录也会一并移除。`, '删除学生', { type: 'warning' })
    .then(() => { store.removeStudent(s.id); ElMessage.success('已删除'); }).catch(() => {});
}

/* ---------- 记分 ---------- */
function quick(sid, tierKey) {
  const rec = store.quickTier(sid, tierKey);
  if (rec) {
    const stu = store.students.find((x) => x.id === sid);
    ElMessage.success(`${stu ? stu.name : ''} ${rec.result === 'wrong' ? '扣分' : '加分'} ${rec.points}`);
  } else {
    ElMessage.error('记分失败');
  }
}
async function manual(sid) {
  const { value } = await ElMessageBox.prompt('加多少分？（负数为扣分）', '手动调整', { inputValue: '1' }).catch(() => ({ value: '' }));
  if (value === undefined || value === '') return;
  const delta = Number(value);
  if (!isFinite(delta) || delta === 0) { ElMessage.error('请输入非 0 数字'); return; }
  store.addManual(sid, delta, '手动调整');
  ElMessage.success(`已调整 ${delta > 0 ? '+' : ''}${delta}`);
}
async function zero(s) {
  await ElMessageBox.confirm(`把「${s.name}」的分数清零？（记录会保留为一条清零操作）`, '清零', { type: 'warning' })
    .then(() => { store.resetStudentScore(s.id); ElMessage.success('已清零'); }).catch(() => {});
}
async function undo() {
  const rec = store.undoLast();
  if (rec) ElMessage.success('已撤销上一条记录');
  else ElMessage.info('没有可撤销的记录');
}
async function clearAll() {
  await ElMessageBox.confirm('清空全部记分（名单、题库、试卷保留）？此操作不可撤销。', '清空分数', { type: 'warning' })
    .then(() => { store.clearRecords({}); ElMessage.success('已清空'); }).catch(() => {});
}

/* ---------- 批量操作 ---------- */
function bulkTeamMove() {
  if (!selected.value.length) { ElMessage.warning('请先勾选学生'); return; }
  const list = store.teams.map((t) => `${t.id}｜${t.name}`).join('\n');
  ElMessageBox.prompt('把勾选的 ' + selected.value.length + ' 名学生移到哪个队伍？\n' + list, '批量调整队伍')
    .then(({ value }) => {
      const tid = (value || '').trim();
      if (!store.teams.some((t) => t.id === tid)) { ElMessage.error('没有这个队伍 id'); return; }
      selected.value.forEach((sid) => store.updateStudent(sid, { teamId: tid }));
      ElMessage.success('已调整 ' + selected.value.length + ' 名学生');
      selected.value = [];
    }).catch(() => {});
}
function bulkDelete() {
  if (!selected.value.length) { ElMessage.warning('请先勾选学生'); return; }
  ElMessageBox.confirm(`删除勾选的 ${selected.value.length} 名学生？`, '批量删除', { type: 'warning' })
    .then(() => {
      const ids = selected.value.slice();
      ids.forEach((sid) => store.removeStudent(sid));
      selected.value = [];
      ElMessage.success('已删除');
    }).catch(() => {});
}
/** 删除一条流水前先确认（点一下就改分太危险 —— 审计发现） */
function askRemoveRecord(rid: string) {
  ElMessageBox.confirm('删除这条记录会改分，确定？', '删除记录', { type: 'warning' })
    .then(() => { store.removeRecord(rid); ElMessage.success('已删除'); })
    .catch(() => {});
}


/** 课程名（顶栏与导出文件名都用它）—— 内联编辑，改完立即生效 */
const courseName = ref<string>((store.settings as any).courseName || '');
function saveCourseName(v: string) {
  store.updateSettings({ courseName: String(v || '').trim() || '课堂积分' });
  ElMessage.success('课程名已更新');
}
</script>

<template>
  <div>
    <div class="page-head">
      <!-- 课程名：AboutPage 早就说「可在这里改」，但控件一直不存在（审计发现） -->
      <div class="course-row">
        <span class="course-label">课程名</span>
        <el-input
          v-model="courseName"
          class="course-input"
          maxlength="40"
          show-word-limit
          placeholder="如：24机械高考公开课"
          @change="saveCourseName"
        />
        <span class="hint">顶栏与导出的报告文件名都用它</span>
      </div>
      <div>
        <h2>班级与积分</h2>
        <div class="desc">
          {{ store.students.length }} 名学生 · {{ store.teams.length }} 支队伍；
          队伍是学生端的"入座身份"，一人一分。
        </div>
      </div>
      <div class="actions">
        <el-button @click="undo">撤销上一条</el-button>
        <el-button @click="clearAll">清空全部记分</el-button>
        <el-button type="primary" @click="openBulk">批量添加学生</el-button>
      </div>
    </div>

    <!-- ① 队伍 -->
    <div class="panel">
      <h3 class="panel-title">
        队伍
        <el-button size="small" @click="addTeam">新增队伍</el-button>
      </h3>
      <div class="team-grid">
        <el-card v-for="t in store.teams" :key="t.id" shadow="never" class="team-card">
          <div class="team-head">
            <span class="tname">{{ t.name }}</span>
            <el-tag size="small" effect="plain">{{ store.studentsOf(t.id).length }} 人</el-tag>
          </div>
          <div class="team-score">
            <span class="score-num" :class="store.teamScore(t.id) < 0 ? 'score-neg' : 'score-pos'">
              {{ store.teamScore(t.id) }}
            </span>
            <span class="unit">分</span>
          </div>
          <div class="team-ops">
            <el-button size="small" text @click="renameTeam(t)">改名</el-button>
            <el-button size="small" text type="danger" @click="removeTeam(t)">删除</el-button>
          </div>
        </el-card>
        <div v-if="!store.teams.length" class="empty-hint">还没有队伍，先点「新增队伍」</div>
      </div>
    </div>

    <!-- ② 名单 -->
    <div class="panel">
      <h3 class="panel-title">
        学生名单
        <span class="sub">选中多人可批量调队 / 删除</span>
      </h3>

      <div class="filters">
        <el-input v-model="keyword" placeholder="搜姓名" clearable style="width: 180px" />
        <el-select v-model="teamFilter" placeholder="全部队伍" clearable style="width: 160px">
          <el-option v-for="t in store.teams" :key="t.id" :label="t.name" :value="t.id" />
        </el-select>
        <el-button :disabled="!selected.length" @click="bulkTeamMove">批量调队</el-button>
        <el-button :disabled="!selected.length" type="danger" plain @click="bulkDelete">批量删除</el-button>
      </div>

      <el-table
        :data="filtered"
        size="small"
        style="width: 100%"
        @selection-change="(rows) => (selected = rows.map((r) => r.id))"
      >
        <el-table-column type="selection" width="42" />
        <el-table-column prop="name" label="姓名" min-width="120" />
        <el-table-column label="队伍" min-width="110">
          <template #default="{ row }">
            <el-tag size="small" effect="plain">{{ teamName(row.teamId) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="积分" width="90" align="right">
          <template #default="{ row }">
            <span class="score-num" :class="store.scoreOf(row.id) < 0 ? 'score-neg' : ''">{{ store.scoreOf(row.id) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="被点" width="70" align="center">
          <template #default="{ row }">{{ store.calledCount(row.id) }}</template>
        </el-table-column>
        <el-table-column label="快捷加分" min-width="260">
          <template #default="{ row }">
            <el-button
              v-for="t in store.tiers"
              :key="t.key"
              size="small"
              @click="quick(row.id, t.key)"
            >
              <span class="tier-dot" :style="{ background: t.color }" />{{ t.label }} {{ t.weight }}
            </el-button>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="268" fixed="right">
          <template #default="{ row }">
            <div class="ops">
              <el-button size="small" text @click="manual(row.id)">调整</el-button>
              <el-button size="small" text @click="zero(row)">清零</el-button>
              <el-button size="small" text @click="detailSid = row.id">明细</el-button>
              <el-button size="small" text @click="renameStudent(row)">改名</el-button>
              <el-button size="small" text @click="moveStudent(row)">调队</el-button>
              <el-button size="small" text type="danger" @click="removeStudent(row)">删除</el-button>
            </div>
          </template>
        </el-table-column>
      </el-table>
      <div v-if="!filtered.length" class="empty-hint">
        {{ store.students.length ? '没有匹配的学生' : '还没有学生，点右上角「批量添加学生」粘贴名单' }}
      </div>
    </div>

    <!-- ③ 批量添加 -->
    <el-dialog v-model="bulkOpen" title="批量添加学生" width="520">
      <el-form label-width="80">
        <el-form-item label="加入队伍">
          <el-select v-model="bulkTeam" placeholder="不选则先不分组" clearable style="width: 100%">
            <el-option v-for="t in store.teams" :key="t.id" :label="t.name" :value="t.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="名单">
          <el-input
            v-model="bulkText"
            type="textarea"
            :rows="8"
            placeholder="每行一个姓名，或用空格/逗号分隔，例如：&#10;张三 李四 王五&#10;赵六"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="bulkOpen = false">取消</el-button>
        <el-button type="primary" @click="doBulk">添加</el-button>
      </template>
    </el-dialog>

    <!-- ④ 学生分数明细 -->
    <el-drawer v-model="detailSid" size="420" :title="drawerStudent ? drawerStudent.name + ' · 分数明细' : ''">
      <div v-if="drawerStudent">
        <el-descriptions :column="2" border size="small" style="margin-bottom: var(--sp-3)">
          <el-descriptions-item label="队伍">{{ teamName(drawerStudent.teamId) }}</el-descriptions-item>
          <el-descriptions-item label="当前积分">{{ store.scoreOf(drawerStudent.id) }}</el-descriptions-item>
          <el-descriptions-item label="被点次数">{{ store.calledCount(drawerStudent.id) }}</el-descriptions-item>
          <el-descriptions-item label="记录条数">{{ drawerRecords.length }}</el-descriptions-item>
        </el-descriptions>

        <el-timeline>
          <el-timeline-item
            v-for="r in drawerRecords"
            :key="r.id"
            :timestamp="new Date(r.at).toLocaleString('zh-CN')"
            :type="r.points >= 0 ? 'success' : 'danger'"
          >
            <div class="rec">
              <span>{{ store.describeRecord(r) }}</span>
              <span class="score-num" :class="r.points < 0 ? 'score-neg' : 'score-pos'">
                {{ r.points > 0 ? '+' : '' }}{{ r.points }}
              </span>
            </div>
            <el-button size="small" text type="danger" @click="askRemoveRecord(r.id)">删除这条</el-button>
          </el-timeline-item>
        </el-timeline>
        <div v-if="!drawerRecords.length" class="empty-hint">还没有记录</div>
      </div>
    </el-drawer>
  </div>
</template>

<style scoped>
.team-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: var(--sp-3); }
.team-card :deep(.el-card__body) { padding: var(--sp-3); }
.team-head { display: flex; align-items: center; justify-content: space-between; }
.tname { font-weight: 600; font-size: var(--fs-sm); }
.team-score { margin: var(--sp-2) 0 var(--sp-1); }
.team-score .score-num { font-size: var(--fs-2xl); }
.team-score .unit { color: var(--ci-text-weak); font-size: var(--fs-xs); margin-left: var(--sp-1); }
.team-ops { display: flex; justify-content: flex-end; }
.filters { display: flex; gap: var(--sp-2); margin-bottom: var(--sp-3); flex-wrap: wrap; }
.ops { display: flex; flex-wrap: wrap; gap: 0 var(--sp-1); white-space: nowrap; }
.rec { display: flex; justify-content: space-between; gap: var(--sp-2); }
.course-row { display: flex; align-items: center; gap: var(--sp-2); margin-bottom: var(--sp-3); }
.course-label { color: var(--el-text-color-secondary); font-size: var(--fs-sm); }
.course-input { max-width: 320px; }
</style>
