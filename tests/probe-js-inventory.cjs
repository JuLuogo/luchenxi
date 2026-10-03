/*!
 * tests/probe-js-inventory.cjs — 清点 assets/js 下的脚本：各自是什么、谁在用、还需不需要
 *   node tests/probe-js-inventory.cjs
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const JS_DIR = path.join(ROOT, 'assets/js');
const files = fs.readdirSync(JS_DIR).filter((f) => f.endsWith('.js')).sort();

/** Vue 侧通过 bridge.ts 引入了哪些领域模块 */
const bridge = fs.readFileSync(path.join(ROOT, 'web/src/shared/bridge.ts'), 'utf8');
/** 旧版页面引用了哪些 */
const legacyHtml = ['admin.html', 'student.html', 'index.html']
  .map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
/** 测试里 require 了哪些 */
const testText = fs.readdirSync(path.join(ROOT, 'tests'))
  .filter((f) => /\.(js|cjs|mjs|html)$/.test(f))
  .map((f) => { try { return fs.readFileSync(path.join(ROOT, 'tests', f), 'utf8'); } catch { return ''; } }).join('\n');

const rows = [];
for (const f of files) {
  const p = path.join(JS_DIR, f);
  const size = (fs.statSync(p).size / 1024).toFixed(1);
  const name = f.replace(/\.js$/, '');
  const inBridge = bridge.includes(`'./${f}'`) || bridge.includes(`"./${f}"`) || bridge.includes(f.replace('.js', ''));
  const inLegacy = new RegExp('assets/js/' + f.replace('.', '\\.')).test(legacyHtml);
  const inTests = new RegExp(f.replace('.', '\\.')).test(testText);
  rows.push({ file: f, size, name, inBridge, inLegacy, inTests });
}

console.log('=== assets/js 清点（' + files.length + ' 个文件）===\n');
console.log('  ' + '文件'.padEnd(18) + '大小'.padEnd(9) + 'Vue 用'.padEnd(8) + '旧页面用'.padEnd(10) + '测试用');
for (const r of rows) {
  console.log('  ' + r.file.padEnd(18) + (r.size + ' KB').padEnd(9) +
    (r.inBridge ? '✓' : '—').padEnd(8) + (r.inLegacy ? '✓' : '—').padEnd(10) + (r.inTests ? '✓' : '—'));
}

console.log('\n=== 分类 ===');
const domain = rows.filter((r) => r.inBridge);
const legacyOnly = rows.filter((r) => !r.inBridge && r.inLegacy);
console.log('  领域层（Vue 也依赖，必须保留）：' + domain.map((r) => r.file).join('、'));
console.log('  旧版界面层（只有旧页面用）：' + legacyOnly.map((r) => r.file).join('、'));
const other = rows.filter((r) => !r.inBridge && !r.inLegacy);
if (other.length) console.log('  其它：' + other.map((r) => r.file).join('、'));

console.log('\n=== 旧版界面层的体积 ===');
let total = 0;
for (const r of legacyOnly) total += Number(r.size);
console.log('  合计 ' + total.toFixed(1) + ' KB（删掉后只剩领域层）');
