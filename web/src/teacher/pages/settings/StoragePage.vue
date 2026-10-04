<script setup lang="ts">
/**
 * 系统设置 · 存储与备份
 * 客户端的落库是 Rust 直连 SQLite（invoke），网页版走枢纽 HTTP；这里把状态与兜底动作集中起来。
 */
import { computed, onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useClassStore } from '../../../shared/class-store';
import { CI } from '../../../shared/bridge';

const store = useClassStore();
const status = ref(CI.storage ? CI.storage.status() : {});
const busy = ref(false);

function refresh() {
  if (CI.storage) status.value = { ...CI.storage.status() };
}
onMounted(refresh);

const backendLabel = computed(() => ({
  tauri: '客户端内置 SQLite（invoke 直连）',
  sqlite: '枢纽本地 SQLite（HTTP /api/state）',
  local: '浏览器本地存储 localStorage'
}[status.value.backend] || status.value.backend));

const counts = computed(() => {
  const s = store.state;
  return {
    students: s.students.length,
    teams: s.teams.length,
    questions: s.bank.length,
    quizzes: s.quizzes.length,
    records: s.quizzes.reduce((a, z) => a + (z.records || []).length, 0)
  };
});

async function flushNow() {
  busy.value = true;
  try {
    if (CI.storage) await CI.storage.flush();
    ElMessage.success('已立即落库');
  } finally { busy.value = false; refresh(); }
}

function exportAll() {
  const data = store.exportAll();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = '课堂备份-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '') + '.json';
  a.click();
  URL.revokeObjectURL(a.href);
  ElMessage.success('已导出备份文件');
}

function importFile() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  input.onchange = () => {
    const f = input.files && input.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(String(reader.result || '{}'));
        ElMessageBox.confirm(
          '导入会用备份内容覆盖当前课堂数据（名单、题库、试卷、分数）。确定继续？',
          '导入备份', { type: 'warning', confirmButtonText: '覆盖导入' }
        ).then(() => {
          store.importAll(data);
          ElMessage.success('已导入备份');
        }).catch(() => {});
      } catch (e) {
        ElMessage.error('文件不是合法备份：' + e.message);
      }
    };
    reader.readAsText(f, 'utf-8');
  };
  input.click();
}

async function loadFromHub() {
  busy.value = true;
  try {
    const dump = await CI.sync.requestDump();
    if (dump) { CI.classroom.loadRemoteState(dump); ElMessage.success('已载入枢纽上的课堂数据'); }
    else ElMessage.info('枢纽上没有数据');
  } finally { busy.value = false; }
}

async function resetScores() {
  await ElMessageBox.confirm('清空全部分数（名单、题库、试卷保留）？', '清空分数', { type: 'warning' })
    .then(() => { store.resetAllScores(); ElMessage.success('已清空分数'); }).catch(() => {});
}

async function factory() {
  await ElMessageBox.confirm(
    '恢复到初始状态：名单、题库、试卷、分数全部清空（不可撤销，建议先导出备份）。',
    '恢复初始状态', { type: 'error', confirmButtonText: '我已备份，确认清空' }
  ).then(() => { store.factoryReset(); ElMessage.success('已恢复初始状态'); }).catch(() => {});
}
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h2>存储与备份</h2>
        <div class="desc">教师端的数据落在本机 SQLite；浏览器里则存在 localStorage。换设备请用「导出备份」。</div>
      </div>
      <div class="actions">
        <el-button @click="refresh">刷新状态</el-button>
        <el-button :loading="busy" @click="flushNow">立即落库</el-button>
        <el-button type="primary" @click="exportAll">导出备份</el-button>
      </div>
    </div>

    <div class="panel">
      <h3 class="panel-title">
        当前存储后端
        <el-tag v-if="status.degraded" type="danger" size="small">已降级</el-tag>
        <el-tag v-else-if="status.backend === 'local'" type="warning" size="small">未落库</el-tag>
        <el-tag v-else type="success" size="small">正常</el-tag>
      </h3>
      <el-descriptions :column="2" border size="small">
        <el-descriptions-item label="后端">{{ backendLabel }}</el-descriptions-item>
        <el-descriptions-item label="房间号">{{ status.room }}</el-descriptions-item>
        <el-descriptions-item label="数据库文件">{{ (status.info && status.info.path) || (status.info && status.info.db) || '—' }}</el-descriptions-item>
        <el-descriptions-item label="最近写入">
          {{ status.lastPushAt ? new Date(status.lastPushAt).toLocaleTimeString('zh-CN') : '—' }}
        </el-descriptions-item>
      </el-descriptions>

      <el-alert
        v-if="status.degraded || status.lastError"
        style="margin-top: 12px"
        type="warning"
        :closable="false"
        show-icon
        :title="CI.storage ? CI.storage.describe() : ''"
      >
        数据不会丢：仍在浏览器本地存储与内存中。请先「导出备份」，再重启应用或检查数据库文件权限。
      </el-alert>
    </div>

    <div class="panel">
      <h3 class="panel-title">数据量<span class="sub">这些数字来自当前课堂状态</span></h3>
      <el-descriptions :column="5" border size="small">
        <el-descriptions-item label="学生">{{ counts.students }}</el-descriptions-item>
        <el-descriptions-item label="队伍">{{ counts.teams }}</el-descriptions-item>
        <el-descriptions-item label="题目">{{ counts.questions }}</el-descriptions-item>
        <el-descriptions-item label="试卷">{{ counts.quizzes }}</el-descriptions-item>
        <el-descriptions-item label="记分记录">{{ counts.records }}</el-descriptions-item>
      </el-descriptions>
    </div>

    <div class="panel">
      <h3 class="panel-title">备份与恢复</h3>
      <el-space wrap>
        <el-button @click="importFile">导入备份（覆盖）</el-button>
        <el-button :loading="busy" @click="loadFromHub">从枢纽载入最新数据</el-button>
        <el-button @click="resetScores">清空分数</el-button>
        <el-button type="danger" plain @click="factory">恢复初始状态</el-button>
      </el-space>
      <div class="hint">
        导出的 JSON 与网页版 / 客户端完全互通：教室电脑用客户端上课、回家用浏览器接着看数据也可以。
      </div>
    </div>
  </div>
</template>

<style scoped>
.hint { color: var(--ci-text-weak); font-size: 12px; margin-top: 12px; }
</style>
