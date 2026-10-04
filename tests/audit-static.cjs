/*!
 * tests/audit-static.cjs — 审计第 3 步：静态扫描
 *
 *   ① clippy 警告（带位置）
 *   ② TODO / FIXME / XXX / HACK
 *   ③ unwrap / expect / panic! 分布（会崩的地方）
 *   ④ 疑似"少传参数"的两参数函数调用（本项目历史最高频 bug）
 *   ⑤ 界面里硬编码的领域规则嫌疑（"界面不重算规则"是本项目硬约定）
 *
 *   node tests/audit-static.cjs [clippy.log]
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

const rustFiles = walk(path.join(ROOT, 'crates'), (n) => n.endsWith('.rs'));
const jsFiles = walk(path.join(ROOT, 'assets/js'), (n) => n.endsWith('.js'));
const vueFiles = walk(path.join(ROOT, 'web/src'), (n) => n.endsWith('.vue'));
const tsFiles = walk(path.join(ROOT, 'web/src'), (n) => /\.(ts|js)$/.test(n));
const scriptFiles = walk(path.join(ROOT, 'scripts'), (n) => /\.(mjs|cjs|js)$/.test(n));
const allCode = [...rustFiles, ...jsFiles, ...vueFiles, ...tsFiles, ...scriptFiles];

/* ---------- ① clippy ---------- */
console.log('=== ① clippy 警告 ===');
const logPath = process.argv[2] || path.join(ROOT, 'clippy.log');
if (fs.existsSync(logPath)) {
  const lines = fs.readFileSync(logPath, 'utf8').split('\n');
  const items = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(warning|error)(\[[^\]]+\])?: (.+)$/);
    if (m && !/generated \d+ warning/.test(m[3])) {
      const loc = (lines[i + 1] || '').match(/-->\s*(.+)$/);
      items.push({ level: m[1], msg: m[3], loc: loc ? loc[1].trim() : '' });
    }
  }
  const byMsg = {};
  items.forEach((it) => {
    const k = it.msg.slice(0, 70);
    byMsg[k] = byMsg[k] || { n: 0, locs: [] };
    byMsg[k].n += 1;
    if (byMsg[k].locs.length < 3) byMsg[k].locs.push(it.loc);
  });
  Object.entries(byMsg).sort((a, b) => b[1].n - a[1].n).forEach(([k, v]) => {
    console.log('  ' + String(v.n).padStart(2) + '×  ' + k);
    v.locs.forEach((l) => console.log('        ' + l));
  });
  console.log('  合计 ' + items.length + ' 条');
} else {
  console.log('  （没有 clippy.log，跳过 —— 用 cargo clippy > clippy.log 生成）');
}

/* ---------- ② TODO 等 ---------- */
console.log('\n=== ② TODO / FIXME / XXX / HACK ===');
let todo = 0;
allCode.forEach((f) => {
  fs.readFileSync(f, 'utf8').split('\n').forEach((l, i) => {
    if (/\b(TODO|FIXME|XXX|HACK)\b/.test(l)) {
      todo += 1;
      console.log('  ' + rel(f) + ':' + (i + 1) + '  ' + l.trim().slice(0, 100));
    }
  });
});
if (!todo) console.log('  ✅ 没有遗留标记');

/* ---------- ③ unwrap / expect / panic ---------- */
console.log('\n=== ③ Rust 里会崩的地方（unwrap / expect / panic! / 下标）===');
const risky = [];
rustFiles.forEach((f) => {
  const src = fs.readFileSync(f, 'utf8');
  const isTest = /#\[cfg\(test\)\]/.test(src) || /\/tests\//.test(rel(f));
  const lines = src.split('\n');
  let inTest = false;
  lines.forEach((l, i) => {
    if (/#\[cfg\(test\)\]/.test(l)) inTest = true;
    if (inTest || isTest) return;              // 测试里 unwrap 是正常的
    if (/\.unwrap\(\)|\.expect\(|panic!\(|unreachable!\(/.test(l) && !/^\s*\/\//.test(l)) {
      risky.push({ f: rel(f), line: i + 1, text: l.trim().slice(0, 90) });
    }
  });
});
console.log('  非测试代码里的 ' + risky.length + ' 处：');
risky.slice(0, 25).forEach((r) => console.log('  ' + r.f + ':' + r.line + '  ' + r.text));
if (risky.length > 25) console.log('  …还有 ' + (risky.length - 25) + ' 处');

/* ---------- ④ 两参数函数少传 ---------- */
console.log('\n=== ④ 疑似"少传参数"（本项目历史最高频 bug）===');
// 收集 JS 领域层里的两参数函数名
const twoArg = [];
jsFiles.forEach((f) => {
  fs.readFileSync(f, 'utf8').split('\n').forEach((l) => {
    const m = l.match(/function\s+([A-Za-z_$][\w$]*)\s*\(\s*([A-Za-z_$][\w$]*)\s*,\s*([A-Za-z_$][\w$]*)\s*\)/);
    if (m) twoArg.push({ name: m[1], file: rel(f) });
  });
});
const names = [...new Set(twoArg.map((x) => x.name))].filter((n) => n.length > 3);
console.log('  两参数函数 ' + names.length + ' 个：' + names.slice(0, 12).join(', ') + (names.length > 12 ? ' …' : ''));
// 在 web/src 里找 `X.foo(a)` 这种只传一个参数的调用
let suspects = 0;
const callRe = new RegExp('\\.(' + names.join('|') + ')\\(([^,()]*)\\)', 'g');
[...vueFiles, ...tsFiles].forEach((f) => {
  fs.readFileSync(f, 'utf8').split('\n').forEach((l, i) => {
    let m;
    callRe.lastIndex = 0;
    while ((m = callRe.exec(l))) {
      const arg = m[2].trim();
      if (arg && !/=>|\{|\}/.test(arg)) {
        suspects += 1;
        console.log('  ' + rel(f) + ':' + (i + 1) + '  .' + m[1] + '(' + arg + ')   ← 只传了一个参数');
      }
    }
  });
});
if (!suspects) console.log('  ✅ 没发现可疑的单参数调用');

/* ---------- ⑤ 界面里硬编码规则 ---------- */
console.log('\n=== ⑤ 界面里硬编码领域规则的嫌疑（"界面不重算规则"是硬约定）===');
let hard = 0;
[...vueFiles, ...tsFiles].forEach((f) => {
  fs.readFileSync(f, 'utf8').split('\n').forEach((l, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(l)) return;
    // 嫌疑：在界面里做加权/百分比/等级判断
    if (/(\*\s*0\.[0-9]|\/\s*total\s*\*|>= *90|>= *60|Math\.round\(.*\/.*\* *100)/.test(l) && !/style|width|height|opacity|font/.test(l)) {
      hard += 1;
      console.log('  ' + rel(f) + ':' + (i + 1) + '  ' + l.trim().slice(0, 95));
    }
  });
});
if (!hard) console.log('  ✅ 没发现');
