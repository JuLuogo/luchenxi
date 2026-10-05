/*!
 * tests/fix-smoke-conditional.cjs — e2e 按"打哪个枢纽"区分是否允许领域端点 404
 *
 *   背景：Node 枢纽是**参考实现**，它**没有 /api/domain/* 领域端点**（也不该有 ——
 *   在 JS 里再实现一遍领域正好是 docs/14 禁止的"两份实现"）。
 *   所以：
 *     · 打 **Rust 枢纽** → 领域端点必须在，404 = 失败（这是"Rust 优先真的生效"的证明）
 *     · 打 **Node 枢纽** → 领域端点必然 404，属于该配置下的**预期**，但要在日志里说明白
 *
 *   node tests/fix-smoke-conditional.cjs
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
let n = 0;

const p = path.join(ROOT, 'tests/run-smoke.js');
const raw = fs.readFileSync(p, 'utf8');
const EOL = raw.includes('\r\n') ? '\r\n' : '\n';
const lines = raw.split(/\r?\n/);

/* ① 在 BENIGN 前加开关与说明 */
const i = lines.findIndex((l) => /const BENIGN = \[/.test(l));
if (i < 0) { console.log('  · 找不到 BENIGN'); process.exit(0); }
if (lines.slice(Math.max(0, i - 6), i).join('\n').includes('EXPECT_NO_DOMAIN')) {
  console.log('  · 已有开关');
  process.exit(0);
}
const indent = (lines[i].match(/^\s*/) || [''])[0];
lines.splice(i, 0,
  indent + '/**',
  indent + ' * 目标枢纽**是不是 Node 参考枢纽**（它没有 /api/domain/* 领域端点）',
  indent + ' *',
  indent + ' * 用法：`EXPECT_NO_DOMAIN=1 node tests/run-smoke.js <url>`（CI 打 Node 枢纽时设上）。',
  indent + ' * 打 Rust 枢纽时**不要**设 —— 那时领域端点 404 就是失败（"Rust 优先真的生效"的证明）。',
  indent + ' *',
  indent + ' * 为什么不一刀切当良性：上一轮就是这么干的，结果把"Rust 优先在主部署路径上没生效"',
  indent + ' * 这个真问题盖了整整一轮（审计发现）。',
  indent + ' */',
  indent + "const EXPECT_NO_DOMAIN = process.env.EXPECT_NO_DOMAIN === '1';",
  indent + 'if (EXPECT_NO_DOMAIN) {',
  indent + "  console.log('  · 目标为 Node 参考枢纽：/api/domain/* 的 404 属预期（该枢纽不实现领域端点）');",
  indent + '}',
  indent + '');
n += 1;

/* ② BENIGN 里加一条"仅当目标是 Node 枢纽时才放行" */
const j = lines.findIndex((l) => /const BENIGN = \[/.test(l));
const k = lines.findIndex((l, x) => x > j && /^\s*\];\s*$/.test(l));
if (j > 0 && k > j) {
  lines.splice(k, 0,
    indent + '  // 仅当**明确知道**目标是 Node 参考枢纽时才放行（见上面 EXPECT_NO_DOMAIN 的说明）',
    indent + '  (c) => EXPECT_NO_DOMAIN && /404/.test(c.text) && /\\/api\\/domain\\//.test(c.url)');
  n += 1;
  console.log('  [ok] BENIGN 加了条件放行');
} else {
  console.log('  · 找不到 BENIGN 的收尾');
}

fs.writeFileSync(p, lines.join(EOL), 'utf8');
console.log('  共改 ' + n + ' 处');
try { new Function(fs.readFileSync(p, 'utf8')); console.log('  ✔ 语法 OK'); } catch (e) { console.log('  ✘ ' + e.message); }
