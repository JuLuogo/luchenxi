/*!
 * tests/probe-dead-refs.cjs — 找出所有"还在读已删除文件"的地方（一次性排查）
 *   node tests/probe-dead-refs.cjs
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const DEAD = ['admin.html', 'student.html', 'index.html',
  'assets/js/admin.js', 'assets/js/bank.js', 'assets/js/quiz.js', 'assets/js/analysis-ui.js',
  'assets/css/app.css', 'assets/css/student.css',
  'tests/demo.js', 'tests/shot.js', 'tests/shot-stage.js', 'tests/shot-student.js'];

function walk(dir, acc) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'target', 'dist', '.git', 'ui', 'bundle-out'].includes(e.name)) continue;
    const q = path.join(dir, e.name);
    if (e.isDirectory()) walk(q, acc);
    else if (/\.(js|cjs|mjs|ts|vue|html|json|rs|yml)$/.test(e.name)) acc.push(q);
  }
  return acc;
}

const files = walk(ROOT, []);
const skipSelf = path.relative(ROOT, __filename).replace(/\\/g, '/');
console.log('=== 仍引用已删除文件的地方（文档除外）===\n');
for (const dead of DEAD) {
  const base = path.basename(dead);
  const hits = [];
  for (const f of files) {
    const rel = path.relative(ROOT, f).replace(/\\/g, '/');
    if (rel === dead || rel === skipSelf || rel.endsWith('.md')) continue;
    let t;
    try { t = fs.readFileSync(f, 'utf8'); } catch { continue; }
    // 精确匹配：完整路径、或读文件/脚本引用
    if (t.includes(dead) ||
        new RegExp('(read|readFileSync|src|href|require)\\(?[^\\n]{0,60}' + base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(t)) {
      hits.push(rel);
    }
  }
  if (hits.length) console.log('  ' + dead + '\n     ← ' + hits.join('\n     ← '));
}
console.log('\n（没列出的就是已清干净）');
