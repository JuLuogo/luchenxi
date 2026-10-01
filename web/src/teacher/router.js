import { createRouter, createWebHashHistory } from 'vue-router';

/**
 * 路由与侧边栏菜单同源：meta.group 决定分组，meta.title 显示标题，meta.icon 显示图标。
 * 用 hash 模式：Tauri 里页面来自自定义协议，history 模式刷新会 404。
 */
export const routes = [
  {
    path: '/',
    name: 'dashboard',
    component: () => import('./pages/Dashboard.vue'),
    meta: { title: '概览', icon: 'Odometer', group: null }
  },

  /* ---------- 教学管理 ---------- */
  {
    path: '/class',
    name: 'class',
    component: () => import('./pages/ClassPage.vue'),
    meta: { title: '班级与积分', icon: 'School', group: '教学管理' }
  },
  {
    path: '/roll',
    name: 'roll',
    component: () => import('./pages/RollPage.vue'),
    meta: { title: '随机点名', icon: 'Aim', group: '教学管理' }
  },
  {
    path: '/classroom',
    name: 'classroom',
    component: () => import('./pages/ClassroomPage.vue'),
    meta: { title: '课堂协同', icon: 'Connection', group: '教学管理' }
  },

  /* ---------- 题库中心 ---------- */
  {
    path: '/bank',
    name: 'bank-list',
    component: () => import('./pages/bank/QuestionList.vue'),
    meta: { title: '题目列表', icon: 'Tickets', group: '题库中心' }
  },
  {
    path: '/bank/new',
    name: 'bank-new',
    component: () => import('./pages/bank/QuestionEditor.vue'),
    meta: { title: '新建题目', icon: 'EditPen', group: '题库中心' }
  },
  {
    path: '/bank/import',
    name: 'bank-import',
    component: () => import('./pages/bank/ImportPage.vue'),
    meta: { title: '批量导入', icon: 'Upload', group: '题库中心' }
  },
  {
    path: '/bank/tiers',
    name: 'bank-tiers',
    component: () => import('./pages/bank/TierSettings.vue'),
    meta: { title: '题型与权重', icon: 'Histogram', group: '题库中心' }
  },
  {
    path: '/bank/tags',
    name: 'bank-tags',
    component: () => import('./pages/bank/TagManager.vue'),
    meta: { title: '标签管理', icon: 'CollectionTag', group: '题库中心' }
  },

  /* ---------- 试卷中心 ---------- */
  {
    path: '/papers',
    name: 'papers',
    component: () => import('./pages/quiz/PaperList.vue'),
    meta: { title: '试卷列表', icon: 'Notebook', group: '试卷中心' }
  },
  {
    path: '/papers/:id',
    name: 'paper-editor',
    component: () => import('./pages/quiz/PaperEditor.vue'),
    meta: { title: '组卷编辑器', icon: 'Operation', group: '试卷中心', hidden: true }
  },

  /* ---------- 数据分析 ---------- */
  {
    path: '/analysis',
    name: 'analysis',
    component: () => import('./pages/AnalysisPage.vue'),
    meta: { title: '学情分析', icon: 'TrendCharts', group: '数据分析' }
  },
  {
    path: '/board',
    name: 'board',
    component: () => import('./pages/BoardPage.vue'),
    meta: { title: '排行榜与导出', icon: 'Trophy', group: '数据分析' }
  },

  /* ---------- 系统设置 ---------- */
  {
    path: '/settings/storage',
    name: 'settings-storage',
    component: () => import('./pages/settings/StoragePage.vue'),
    meta: { title: '存储与备份', icon: 'Coin', group: '系统设置' }
  },
  {
    path: '/settings/network',
    name: 'settings-network',
    component: () => import('./pages/settings/NetworkPage.vue'),
    meta: { title: '组网（EasyTier）', icon: 'Share', group: '系统设置' }
  },
  {
    path: '/settings/room',
    name: 'settings-room',
    component: () => import('./pages/settings/RoomPage.vue'),
    meta: { title: '房间与大屏', icon: 'Monitor', group: '系统设置' }
  },
  {
    path: '/settings/about',
    name: 'settings-about',
    component: () => import('./pages/settings/AboutPage.vue'),
    meta: { title: '关于与文档', icon: 'InfoFilled', group: '系统设置' }
  },

  { path: '/:pathMatch(.*)*', redirect: '/' }
];

/** 侧边栏结构：按 group 聚合（保持 routes 里的出现顺序） */
export function buildMenu() {
  const groups = [];
  const index = new Map();
  routes.filter((r) => r.meta && r.meta.title && !r.meta.hidden).forEach((r) => {
    const key = r.meta.group || '总览';
    if (!index.has(key)) { index.set(key, { title: key, items: [] }); groups.push(index.get(key)); }
    index.get(key).items.push({ path: r.path, title: r.meta.title, icon: r.meta.icon });
  });
  return groups;
}

export default createRouter({
  history: createWebHashHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 })
});
