<script setup lang="ts">
/**
 * 第二批页面的占位：这一批先交付「骨架 + 题库中心 + 班级与积分」，
 * 其余页面按同一套侧边栏结构补上，避免一次性大改导致不可用。
 */
interface Props {
  title: string;
  desc?: string;
  points?: string[];
}

defineProps<Props>();
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h2>{{ title }}</h2>
        <div class="desc">{{ desc }}</div>
      </div>
    </div>
    <div class="panel">
      <div class="todo-box">
        <strong>这一页正在重写中（第二批）</strong>
        新界面按「一页只做一件事」拆分，功能与旧版一一对应，不会丢。
        <ul v-if="points && points.length" class="points">
          <li v-for="(p, i) in points" :key="i">{{ p }}</li>
        </ul>
      </div>
    </div>
  </div>
</template>

<style scoped>
.points { text-align: left; max-width: 560px; margin: 14px auto 0; color: var(--ci-text-weak); line-height: 1.9; }
</style>
