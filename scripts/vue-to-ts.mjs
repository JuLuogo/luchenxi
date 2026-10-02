/*!
 * scripts/vue-to-ts.mjs — 把指定 .vue 的 <script setup> 转成 <script setup lang="ts">
 *
 *   node scripts/vue-to-ts.mjs web/src/teacher/pages/Dashboard.vue [更多文件…]
 *
 * 用法建议：一次转一两个文件，转完立刻跑
 *   npm run --prefix web typecheck
 * 有错误就用 scripts/vue-type-boundary.mjs 标边界，再手工收尾。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const files = process.argv.slice(2);
if (!files.length) {
  console.log('  用法: node scripts/vue-to-ts.mjs <文件…>');
  process.exit(1);
}

let converted = 0;
for (const rel of files) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) {
    console.log('  · 不存在 ' + rel);
    continue;
  }
  const t = fs.readFileSync(p, 'utf8');
  if (/<script setup lang="ts">/.test(t)) {
    console.log('  · 已是 TS：' + rel);
    continue;
  }
  const next = t.replace(/<script setup>/, '<script setup lang="ts">');
  if (next === t) {
    console.log('  · 没有 <script setup>：' + rel);
    continue;
  }
  fs.writeFileSync(p, next, 'utf8');
  converted += 1;
  console.log('  [ok] ' + rel);
}
console.log('  转好 ' + converted + ' 个；下一步：npm run --prefix web typecheck');
