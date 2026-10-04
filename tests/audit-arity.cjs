/*!
 * tests/audit-arity.cjs — 精确版"少传参数"探测器
 *
 *   只查真领域层调用：CI.store.X(a) / CI.analysis.X(a) / CI.rollcall.X(a) / CI.grade.X(a) …
 *   其中 X 是**两参数**函数 —— 少传一个参数会把字符串当 state 用（本项目历史最高频 bug，已出现 4 次）。
 *
 *   注意区分：`store.calledCount(sid)`（class-store 的包装，一参数正确）
 *            与 `CI.store.calledCount(sid)`（原始两参数，少传就炸）
 *
 *   node tests/audit-arity.cjs
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');

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

/* ① 收集 JS 领域层里的两参数函数（按模块） */
const jsFiles = walk(path.join(ROOT, 'assets/js'), (n) => n.endsWith('.js'));
const byModule = {};   // module → Set(函数名)
const modules = ['store', 'analysis', 'grade', 'rollcall', 'classroom', 'import', 'openclass', 'polish', 'util'];
for (const f of jsFiles) {
  const mod = path.basename(f, '.js');
  const src = fs.readFileSync(f, 'utf8');
  const names = new Set();
  // 两参数函数：function x(a, b)  或  var x = function (a, b)  或  x: function (a, b)
  const re = /(?:function\s+([A-Za-z_$][\w$]*)|([A-Za-z_$][\w$]*)\s*[:=]\s*function)\s*\(\s*([A-Za-z_$][\w$]*)\s*,\s*([A-Za-z_$][\w$]*)\s*[,)]/g;
  let m;
  while ((m = re.exec(src))) names.add(m[1] || m[2]);
  byModule[mod] = names;
}
const total = Object.values(byModule).reduce((n, s) => n + s.size, 0);
console.log('=== 领域层两参数函数（按模块）===');
Object.entries(byModule).forEach(([mod, set]) => {
  if (set.size) console.log('  ' + mod.padEnd(12) + set.size + ' 个：' + [...set].slice(0, 10).join(', ') + (set.size > 10 ? ' …' : ''));
});
console.log('  合计 ' + total + ' 个');

/* ② 在 web/src 里找 CI.<mod>.<fn>(单个参数) */
console.log('\n=== 可疑调用（只传一个参数）===');
const targets = [...walk(path.join(ROOT, 'web/src'), (n) => /\.(vue|ts|js)$/.test(n))];
let found = 0;
for (const f of targets) {
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  lines.forEach((l, i) => {
    for (const [mod, names] of Object.entries(byModule)) {
      for (const fn of names) {
        // CI.<mod>.<fn>(  后跟一个不含逗号的参数
        const re = new RegExp('CI\\.' + mod + '\\.' + fn + '\\(([^,()]*)\\)', 'g');
        let m;
        while ((m = re.exec(l))) {
          const arg = m[1].trim();
          if (!arg) continue;                    // 零参数可能是合法的可选参数
          if (/=>|\{|\}/.test(arg)) continue;    // 回调/对象字面量不算
          found += 1;
          console.log('  ' + rel(f) + ':' + (i + 1) + '  CI.' + mod + '.' + fn + '(' + arg + ')');
          console.log('        ' + l.trim().slice(0, 110));
        }
      }
    }
  });
}
console.log(found ? '  共 ' + found + ' 处可疑' : '  ✅ 没发现（所有领域层调用都传够了参数）');

/* ③ 反向核对：两参数函数在 web/src 里被调用时是否都传了两个 */
console.log('\n=== 领域层调用总览（前 20 个高频函数）===');
const counts = {};
for (const f of targets) {
  const src = fs.readFileSync(f, 'utf8');
  for (const [mod, names] of Object.entries(byModule)) {
    for (const fn of names) {
      const re = new RegExp('CI\\.' + mod + '\\.' + fn + '\\(', 'g');
      const n = (src.match(re) || []).length;
      if (n) counts[mod + '.' + fn] = (counts[mod + '.' + fn] || 0) + n;
    }
  }
}
Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 20).forEach(([k, n]) => console.log('  ' + String(n).padStart(3) + '×  CI.' + k + '(...)'));
