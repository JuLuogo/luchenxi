/*!
 * tests/audit-run-all.cjs — 审计第 2 步：逐个跑遍全部测试，记录逐项结果
 *
 *   同时回答一个问题：**哪些测试存在但 CI 不跑**（那等于没有）。
 *
 *   node tests/audit-run-all.cjs
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const ROOT = path.join(__dirname, '..');

/* ① CI 跑了哪些（从 ci-local.mjs 里抓） */
const ci = fs.readFileSync(path.join(ROOT, 'scripts/ci-local.mjs'), 'utf8');
const ciMentions = (name) => ci.includes(name);

/* ② tests/ 下的可独立运行测试 */
const testFiles = fs.readdirSync(path.join(ROOT, 'tests'))
  .filter((f) => /\.(js|mjs|cjs)$/.test(f) && !/^(shot|_|run-smoke|ci-status|probe|audit)/.test(f))
  .sort();

console.log('=== 逐个跑测试（' + testFiles.length + ' 个）===\n');
const rows = [];
for (const f of testFiles) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join('tests', f)], { cwd: ROOT, encoding: 'utf8', timeout: 600000 });
  const ms = Date.now() - t0;
  const out = ((r.stdout || '') + (r.stderr || ''));
  const ok = r.status === 0;
  // 抓一行结果摘要
  const m = out.match(/(全部通过[：:]\s*\d+[^\n]*|SMOKE RESULT[^\n]*|\d+ 项断言[^\n]*|通过 \d+ \/ 失败 \d+)/);
  rows.push({ f, ok, ms, summary: m ? m[1].trim().slice(0, 60) : (ok ? '（无摘要）' : '失败'), inCi: ciMentions(f) });
  console.log('  ' + (ok ? '✅' : '❌') + ' ' + f.padEnd(28) + String(ms).padStart(6) + 'ms  ' + rows[rows.length - 1].summary);
  if (!ok) {
    const bad = out.split('\n').filter((l) => /❌|失败|Error|error:|✘/.test(l)).slice(0, 3);
    bad.forEach((l) => console.log('        ' + l.trim().slice(0, 120)));
  }
}

/* ③ 汇总 */
const failed = rows.filter((r) => !r.ok);
const notInCi = rows.filter((r) => !r.inCi);
console.log('\n=== 汇总 ===');
console.log('  通过 ' + (rows.length - failed.length) + ' / ' + rows.length);
if (failed.length) {
  console.log('  ❌ 失败：' + failed.map((r) => r.f).join(', '));
}
if (notInCi.length) {
  console.log('\n  ⚠️  存在但 CI 里没提到的测试（' + notInCi.length + ' 个）—— 等于没有：');
  notInCi.forEach((r) => console.log('     · ' + r.f));
} else {
  console.log('  ✅ 所有测试都在 CI 里');
}
