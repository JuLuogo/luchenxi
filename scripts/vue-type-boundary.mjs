/*!
 * scripts/vue-type-boundary.mjs — 给转 TS 的组件按统一约定标注边界类型
 *
 *   node scripts/vue-type-boundary.mjs web/src/teacher/pages/Dashboard.vue
 *
 * 约定：领域层（assets/js/*）还没类型，边界处一律 any；组件自己的逻辑照常受检查。
 * 等对应能力迁到 Rust 后，再把这些 any 收紧成 specta 生成的类型。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = require('path').join(__dirname, '..');

const files = process.argv.slice(2);
let total = 0;

for (const rel of files) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) { console.log('  · 不存在 ' + rel); continue; }
  let t = fs.readFileSync(p, 'utf8');
  const before = t;
  let n = 0;

  // 边界约定：领域层（assets/js/*）没有类型，边界处一律用 any，
  // 组件自己的逻辑照常受类型检查。逐个收紧要等能力迁到 Rust 之后。
  const rules = [
    [/\bref\(null\)/g, 'ref<any>(null)'],
    [/\bshallowRef\(null\)/g, 'shallowRef<any>(null)'],
    [/\bref\(\[\]\)/g, 'ref<any[]>([])'],
    [/\bref\(\{\}\)/g, 'ref<Record<string, any>>({})'],
    [/\bref\(\s*CI\.store\.get\(\)\s*\)/g, 'ref<any>(CI.store.get())']
  ];
  for (const [re, to] of rules) {
    const m = t.match(re);
    if (m) { n += m.length; t = t.replace(re, to); }
  }

  if (t !== before) fs.writeFileSync(p, t, 'utf8');
  console.log('  [ok] ' + rel + '：' + n + ' 处边界标注');
  total += n;
}
console.log('  合计 ' + total + ' 处');
