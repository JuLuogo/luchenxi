<script setup lang="ts">
/**
 * 系统设置 · 关于与文档
 * 把"当前跑在什么环境里"讲清楚，减少排障时间（浏览器 / 客户端、协议版本、数据落点）。
 */
import { computed, onMounted, ref } from 'vue';
import { CI } from '../../../shared/bridge';

const info = ref<Record<string, any>>({});
const settings = computed(() => CI.store.get().settings || {});

onMounted(() => {
  info.value = {
    inTauri: CI.storage ? CI.storage.inTauri() : false,
    backend: CI.storage ? CI.storage.backend() : 'local',
    storage: CI.storage ? CI.storage.describe() : '',
    room: CI.sync.room(),
    host: CI.sync.host() || '（与页面同源）',
    server: CI.sync.serverInfo() || null,
    protocol: (CI.protocol && CI.protocol.VERSION) || 3,
    store: { version: CI.store.VERSION, rev: CI.store.get().rev }
  };
});
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h2>关于与文档</h2>
        <div class="desc">课堂积分系统 v4：网页版 / 桌面教师端 / Android 学生端共用同一份前端与协议。</div>
      </div>
    </div>

    <el-row :gutter="14">
      <el-col :xs="24" :md="12">
        <div class="panel">
          <h3 class="panel-title">运行环境</h3>
          <el-descriptions :column="1" border size="small">
            <el-descriptions-item label="外壳">
              {{ info.inTauri ? '桌面客户端（Tauri，内置枢纽）' : '浏览器（网页版，需本地枢纽）' }}
            </el-descriptions-item>
            <el-descriptions-item label="存储后端">{{ info.storage }}</el-descriptions-item>
            <el-descriptions-item label="房间号">{{ info.room }}</el-descriptions-item>
            <el-descriptions-item label="枢纽地址">{{ info.host }}</el-descriptions-item>
            <el-descriptions-item label="报文协议">v{{ info.protocol }}</el-descriptions-item>
            <el-descriptions-item label="本地数据版本">schema v{{ info.store && info.store.version }} · rev {{ info.store && info.store.rev }}</el-descriptions-item>
          </el-descriptions>
        </div>
      </el-col>

      <el-col :xs="24" :md="12">
        <div class="panel">
          <h3 class="panel-title">课程信息</h3>
          <el-descriptions :column="1" border size="small">
            <el-descriptions-item label="课程名">{{ settings.courseName }}</el-descriptions-item>
          </el-descriptions>
          <div class="hint">课程信息可在「班级与积分」页顶部修改（第二批开放内联编辑）。</div>
        </div>

        <div class="panel">
          <h3 class="panel-title">文档</h3>
          <ul class="links">
            <li><a href="/docs/README.md" target="_blank">文档索引（docs/README.md）</a></li>
            <li><a href="/docs/08-开发部署与测试.md" target="_blank">开发部署与测试</a></li>
            <li><a href="/docs/11-跨平台客户端与数据库方案.md" target="_blank">跨平台客户端与数据库方案</a></li>
            <li><a href="/docs/12-v4验收对照.md" target="_blank">v4 验收对照（完成度与外部条件）</a></li>
            <li><a href="/docs/demo/README.md" target="_blank">课堂演示实录（截图）</a></li>
          </ul>
          <div class="hint">链接在客户端里不可用（没有 docs 资源）；请在仓库里查看。</div>
        </div>
      </el-col>
    </el-row>
  </div>
</template>

<style scoped>
.hint { color: var(--ci-text-weak); font-size: 12px; margin-top: 10px; }
.links { margin: 0; padding-left: 18px; line-height: 2; }
.links a { color: var(--ci-brand); text-decoration: none; }
.links a:hover { text-decoration: underline; }
</style>
