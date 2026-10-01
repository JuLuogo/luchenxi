<script setup>
/**
 * 教师端外壳：左侧分级菜单 + 顶栏状态 + 路由内容区。
 * 顶栏把「课程名 / 同步状态 / 存储后端 / 房间号 / 学生端地址」这些"全局一眼要看到"的信息固定住，
 * 页面内部只关心自己的业务。
 */
import { computed, onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { buildMenu } from './router.js';
import { useClassStore } from '../shared/class-store.js';
import { createRuntime } from '../shared/runtime.js';
import { CI } from '../shared/bridge.js';

const route = useRoute();
const router = useRouter();
const store = useClassStore();
const menu = buildMenu();
const collapsed = ref(false);

const rt = reactive({
  statusText: '连接中…',
  statusKind: '',
  storageText: '',
  storageWarning: '',
  connected: false,
  room: '',
  studentUrl: ''
});
let runtime = null;

/** 顶栏状态点样式 */
const syncClass = computed(() => {
  const k = rt.statusKind || '';
  if (/bad/.test(k)) return 'dot-bad';
  if (/ok|live/.test(k)) return 'dot-ok';
  return 'dot-wait';
});

/** 分组图标：与 router.js 的分组名对应 */
const GROUP_ICONS = {
  教学管理: 'Reading',
  题库中心: 'Files',
  试卷中心: 'Notebook',
  数据分析: 'DataAnalysis',
  系统设置: 'Setting'
};
function groupIcon(title) {
  return GROUP_ICONS[title] || 'Menu';
}

function refreshStudentUrl() {
  try {
    rt.room = CI.sync.room();
    rt.studentUrl = CI.sync.joinURL(window.location.origin);
  } catch (e) { /* 未加载时忽略 */ }
}

async function copyStudentUrl() {
  try {
    await navigator.clipboard.writeText(rt.studentUrl);
    ElMessage.success('学生端地址已复制');
  } catch (e) {
    ElMessage.warning('复制失败，请手动选中地址复制');
  }
}

function openStage() {
  const url = window.location.origin + '/stage?room=' + encodeURIComponent(rt.room || 'default');
  window.open(url, '_blank');
}

onMounted(() => {
  runtime = createRuntime({
    onStatus: (info) => {
      rt.statusText = info.statusText;
      rt.statusKind = info.statusKind;
      rt.storageText = info.storageText || rt.storageText;
      rt.storageWarning = info.storageWarning || '';
      rt.connected = info.connected;
    },
    onRemoteDump: (dump) => {
      // 枢纽上有一份课堂数据：让老师决定是否载入（不静默覆盖本地）
      ElMessageBox.confirm(
        '枢纽上已有一份课堂数据，是否载入？（载入会覆盖本机当前的名单与分数）',
        '发现远端数据',
        { confirmButtonText: '载入', cancelButtonText: '暂不', type: 'warning' }
      ).then(() => {
        CI.classroom.loadRemoteState(dump);
        ElMessage.success('已载入枢纽上的课堂数据');
      }).catch(() => { /* 老师选择暂不 */ });
    }
  });
  const info = runtime.boot();
  rt.statusText = info.statusText;
  rt.storageText = info.storageText;
  refreshStudentUrl();
  bindShortcuts();
});

/* ---------- 全局快捷键（老师上课手不离键盘） ---------- */
const shortcutOpen = ref(false);
function bindShortcuts() {
  window.addEventListener('keydown', (e) => {
    const tag = (e.target && e.target.tagName) || '';
    if (/INPUT|TEXTAREA|SELECT/.test(tag) || (e.target && e.target.isContentEditable)) return;
    const key = e.key;

    // 点名页：1/2/3/4 判分（由 RollPage 内部处理），这里只做全局跳转与课堂控制
    if (key === '?' ) { shortcutOpen.value = !shortcutOpen.value; e.preventDefault(); return; }
    if (!e.altKey) return;
    const map = { '1': '/class', '2': '/roll', '3': '/classroom', '4': '/bank', '5': '/papers', '6': '/analysis' };
    if (map[key] && !e.shiftKey) { router.push(map[key]); e.preventDefault(); }
  });
}
</script>

<template>
  <el-container class="shell">
    <el-aside :width="collapsed ? '64px' : '232px'" class="side">
      <div class="brand" :class="{ mini: collapsed }">
        <div class="logo">课</div>
        <div v-if="!collapsed" class="brand-text">
          <div class="name">课堂积分系统</div>
          <div class="ver">v4 · 教师端</div>
        </div>
      </div>

      <el-scrollbar class="menu-scroll">
        <el-menu
          :default-active="route.path"
          :collapse="collapsed"
          :collapse-transition="false"
          router
          class="menu"
        >
          <template v-for="g in menu" :key="g.title">
            <el-menu-item v-if="g.title === '总览'" :index="g.items[0].path">
              <el-icon><component :is="g.items[0].icon" /></el-icon>
              <template #title>{{ g.items[0].title }}</template>
            </el-menu-item>
            <el-sub-menu v-else :index="g.title">
              <template #title>
                <el-icon><component :is="groupIcon(g.title)" /></el-icon>
                <span>{{ g.title }}</span>
              </template>
              <el-menu-item v-for="it in g.items" :key="it.path" :index="it.path">
                <el-icon><component :is="it.icon" /></el-icon>
                <template #title>{{ it.title }}</template>
              </el-menu-item>
            </el-sub-menu>
          </template>
        </el-menu>
      </el-scrollbar>
    </el-aside>

    <el-container>
      <el-header class="top">
        <div class="left">
          <el-button text :icon="collapsed ? 'Expand' : 'Fold'" @click="collapsed = !collapsed" />
          <span class="course">{{ store.settings.courseName || '课堂积分系统' }}</span>
          <el-tag v-if="rt.room" size="small" type="info" effect="plain">房间 {{ rt.room }}</el-tag>
        </div>
        <div class="right">
          <span class="chip"><i class="dot" :class="syncClass" />同步：{{ rt.statusText }}</span>
          <el-tooltip v-if="rt.storageWarning" :content="rt.storageWarning" placement="bottom">
            <span class="chip chip-bad">存储：{{ rt.storageText }}</span>
          </el-tooltip>
          <span v-else class="chip">存储：{{ rt.storageText || '本地存储' }}</span>
          <el-button size="small" @click="copyStudentUrl">复制学生端地址</el-button>
          <el-button size="small" @click="openStage">打开大屏</el-button>
          <el-button size="small" text @click="shortcutOpen = true">快捷键 ?</el-button>
        </div>
      </el-header>

      <el-main class="main">
        <router-view v-slot="{ Component }">
          <component :is="Component" />
        </router-view>
      </el-main>
    </el-container>

    <el-dialog v-model="shortcutOpen" title="键盘快捷键" width="440">
      <el-descriptions :column="1" border size="small">
        <el-descriptions-item label="Alt + 1">班级与积分</el-descriptions-item>
        <el-descriptions-item label="Alt + 2">随机点名</el-descriptions-item>
        <el-descriptions-item label="Alt + 3">课堂协同</el-descriptions-item>
        <el-descriptions-item label="Alt + 4">题库中心</el-descriptions-item>
        <el-descriptions-item label="Alt + 5">试卷中心</el-descriptions-item>
        <el-descriptions-item label="Alt + 6">学情分析</el-descriptions-item>
        <el-descriptions-item label="点名页 1 / 2 / 3 / 4">答对 / 半对 / 答错 / 跳过</el-descriptions-item>
        <el-descriptions-item label="课堂协同 空格">公布答案 / 收起</el-descriptions-item>
        <el-descriptions-item label="?">打开本面板</el-descriptions-item>
      </el-descriptions>
    </el-dialog>
  </el-container>
</template>

<style scoped>
.shell { height: 100vh; }

.side {
  background: #fff;
  border-right: 1px solid var(--ci-line);
  display: flex;
  flex-direction: column;
  transition: width .18s ease;
}
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--ci-line);
}
.brand.mini { justify-content: center; padding: 14px 0; }
.logo {
  width: 32px; height: 32px; border-radius: 9px;
  background: var(--ci-brand); color: #fff;
  display: grid; place-items: center;
  font-weight: 700;
}
.brand-text .name { font-weight: 600; font-size: 14px; }
.brand-text .ver { color: var(--ci-text-weak); font-size: 11px; }
.menu-scroll { flex: 1; }
.menu { border-right: none; }

.top {
  background: #fff;
  border-bottom: 1px solid var(--ci-line);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  height: 56px;
}
.top .left, .top .right { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.course { font-weight: 600; }

.chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--ci-text-weak);
  background: #f7f8fa;
  border: 1px solid var(--ci-line);
  border-radius: 999px;
  padding: 3px 10px;
  max-width: 380px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.chip-bad { color: var(--ci-bad); border-color: #fecaca; background: #fef2f2; }
.dot { width: 7px; height: 7px; border-radius: 50%; background: #cbd5e1; display: inline-block; }
.dot-ok { background: var(--ci-ok); }
.dot-bad { background: var(--ci-bad); }
.dot-wait { background: var(--ci-warn); }

.main { padding: 18px; overflow: auto; }
</style>
