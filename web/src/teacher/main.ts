import { createApp } from 'vue';
import { createPinia } from 'pinia';
import ElementPlus from 'element-plus';
import zhCn from 'element-plus/es/locale/lang/zh-cn';
import * as ElIcons from '@element-plus/icons-vue';
import 'element-plus/dist/index.css';

import '../styles/tokens.css';
import './styles/teacher.css';

import App from './App.vue';
import router from './router';

const app = createApp(App);
app.use(createPinia());
app.use(router);
app.use(ElementPlus, { locale: zhCn, size: 'default' });

/* 图标全局注册：<el-icon><School /></el-icon> / 菜单按名字动态取用 */
Object.entries(ElIcons).forEach(([name, comp]) => app.component(name, comp));

app.mount('#app');
