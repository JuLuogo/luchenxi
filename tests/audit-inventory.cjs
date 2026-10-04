/*!
 * tests/audit-inventory.cjs — 审计第 1 步：盘点所有模块 + 建立"测试覆盖地图"
 *
 *   输出三张表：
 *     ① 源码文件清单（Rust / JS 领域层 / Vue / 脚本）
 *     ② 每个源文件是否被测试"提到"（粗粒度：测试里出现过文件名或其关键符号）
 *     ③ 没有任何测试覆盖的文件（要重点看）
 *
 *   node tests/audit-inventory.cjs
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

function walk(dir, filter, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', '.git', 'target', 'bindings'].includes(e.name)) continue;
    const q = path.join(dir, e.name);
    if (e.isDirectory()) walk(q, filter, acc);
    else if (filter(e.name)) acc.push(q);
  }
  return acc;
}
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');

/* ---------- ① 源码清单 ---------- */
const rust = walk(path.join(ROOT, 'crates'), (n) => n.endsWith('.rs'));
const jsDomain = walk(path.join(ROOT, 'assets/js'), (n) => n.endsWith('.js'));
const vue = walk(path.join(ROOT, 'web/src'), (n) => n.endsWith('.vue'));
const ts = walk(path.join(ROOT, 'web/src'), (n) => n.endsWith('.ts') || n.endsWith('.js'));
const scripts = walk(path.join(ROOT, 'scripts'), (n) => /\.(mjs|cjs|js)$/.test(n));
const tests = walk(path.join(ROOT, 'tests'), (n) => /\.(js|mjs|cjs|html|rs)$/.test(n));

console.log('=== ① 源码清单 ===');
console.log('  Rust      ' + rust.length + ' 个文件（crates/）');
console.log('  JS 领域层  ' + jsDomain.length + ' 个文件（assets/js/）');
console.log('  Vue       ' + vue.length + ' 个组件');
console.log('  TS/JS     ' + ts.length + ' 个（web/src/，含 Vue 之外的）');
console.log('  脚本      ' + scripts.length + ' 个（scripts/）');
console.log('  测试      ' + tests.length + ' 个（tests/）');

/* ---------- ② 覆盖地图 ---------- */
// 把所有测试/脚本的内容拼起来（含 Rust 测试），作为"被提到"的证据源
const corpus = [
  ...tests.map((f) => fs.readFileSync(f, 'utf8')),
  ...walk(path.join(ROOT, 'crates'), (n) => n.endsWith('.rs')).map((f) => fs.readFileSync(f, 'utf8')),
  ...walk(path.join(ROOT, 'scripts'), (n) => /\.(mjs|cjs|js)$/.test(n)).map((f) => fs.readFileSync(f, 'utf8')),
  fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')
].join('\n');

const targets = [
  ...rust.filter((f) => !/\/tests\//.test(rel(f))),
  ...jsDomain,
  ...vue,
  ...ts.filter((f) => !/\.vue$/.test(f)),
  ...scripts
];

console.log('\n=== ② 覆盖地图（测试里是否提到这个文件/它的关键符号）===');
const uncovered = [];
const rows = [];
for (const f of targets) {
  const r = rel(f);
  const base = path.basename(r);
  const stem = base.replace(/\.(rs|js|ts|vue|mjs|cjs)$/, '');
  // 命中判据：文件名、或去掉扩展名的名字（很多测试用 require/import 或 mod 名引用）
  const hit = corpus.includes(base) || corpus.includes(stem) ||
    (stem.length > 4 && corpus.includes("'" + stem + "'"));
  rows.push({ file: r, hit });
  if (!hit) uncovered.push(r);
}
const hitCount = rows.filter((x) => x.hit).length;
console.log('  被提到 ' + hitCount + ' / ' + rows.length);
if (uncovered.length) {
  console.log('\n  ❗ 没有任何测试提到的文件（' + uncovered.length + ' 个）：');
  uncovered.forEach((f) => console.log('     · ' + f));
} else {
  console.log('  ✅ 所有源码文件都被测试提到过（粗粒度判据）');
}

/* ---------- ③ 按目录汇总 ---------- */
console.log('\n=== ③ 未覆盖文件按目录汇总 ===');
const byDir = {};
uncovered.forEach((f) => {
  const d = f.split('/').slice(0, 3).join('/');
  byDir[d] = (byDir[d] || 0) + 1;
});
Object.entries(byDir).sort((a, b) => b[1] - a[1]).forEach(([d, c]) => console.log('  ' + String(c).padStart(3) + '  ' + d));

/* ---------- ④ 代码量 ---------- */
console.log('\n=== ④ 代码量（行）===');
const countLines = (files) => files.reduce((n, f) => n + fs.readFileSync(f, 'utf8').split('\n').length, 0);
console.log('  Rust      ' + countLines(rust));
console.log('  JS 领域层  ' + countLines(jsDomain));
console.log('  Vue       ' + countLines(vue));
console.log('  TS/JS     ' + countLines(ts.filter((f) => !/\.vue$/.test(f))));
console.log('  脚本      ' + countLines(scripts));
console.log('  测试      ' + countLines(tests));
