/*!
 * scripts/vue-to-ts.mjs — 把指定 .vue 的 <script setup> 转成 <script setup lang="ts">
 *
 *   node scripts/vue-to-ts.mjs web/src/teacher/pages/Dashboard.vue [更多文件…]
 *
 * 用法建议：一次转一两个文件，转完立刻跑
 *   npm run --prefix web typecheck
 * 有错误就用 scripts/vue-type-boundary.mjs 标边界，再手工收尾。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = require('path').join(__dirname, '..');

const files = process.argv.slice(2);
if (!files.length) {
  console.log('  用法: node scripts/vue-to-ts.mjs <文件…>');
  process.exit(1);
}

for (const rel of files) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) {
    console.log('  · 不存在 ' + rel);
    continue;
  }
  let t = fs.readFileSync(p, 'utf8');
  if (/<script setup lang="ts">/.test(t)) {
    console.log('  · 已是 TS：' + rel);
    continue;
  }
  const before = t;
  t = t.replace(/<script setup>/, '<script setup lang="ts">');
  if (t === before) {
    console.log('  · 没有 <script setup>：' + rel);
    continue;
  }
  fs.writeFileSync(p, t, 'utf8');
  console.log('  [ok] ' + rel);
}
