/*!
 * tests/rule-audit.test.js — 领域层分类守卫
 *
 *   目的：把"哪些是规则、哪些是客户端固有"这件事**钉成断言**，而不是靠记忆。
 *   规则模块（给定输入算输出）必须有 Rust 对应物；传输/适配模块天然属于客户端。
 *
 *   为什么需要它：迁移期最容易发生的倒退是"新规则又写回前端"。
 *   有了这张表 + 断言，往 assets/js 里加一个新的规则模块而不给它 Rust 实现，
 *   CI 就会红。
 *
 *   node tests/rule-audit.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
let passed = 0;
const failures = [];
const ok = (cond, label) => { if (cond) passed++; else failures.push(label); };
const group = (n) => console.log('\n== ' + n + ' ==');

/**
 * 分类表（就是文档本身）
 *   rule      —— 规则：给定输入算输出，**必须**有 Rust 对应物
 *   transport —— 传输：WS 连接、重连、命令队列（客户端固有）
 *   adapter   —— 适配：localStorage / SQLite / 内存三态（客户端固有）
 */
const CLASSIFY = {
  'grade.js': { kind: 'rule', rs: ['grade'], why: '判分规则' },
  'import.js': { kind: 'rule', rs: ['bank_import'], why: '批量导入解析规则' },
  'rollcall.js': { kind: 'rule', rs: ['rollcall'], why: '点名抽选规则' },
  'analysis.js': { kind: 'rule', rs: ['ability', 'stats', 'report', 'mistakes', 'question_stats', 'composite'], why: '统计与评价规则' },
  'classroom.js': { kind: 'rule', rs: ['classroom'], why: '课堂环节与计分' },
  'store.js': { kind: 'rule', rs: ['scoring', 'draw', 'state'], why: '计分引擎与状态模型' },
  'openclass.js': { kind: 'rule', rs: ['openclass'], why: '公开课现场评价量规' },
  'sync.js': { kind: 'transport', why: 'WS 客户端：连接/重连/命令队列' },
  'net.js': { kind: 'transport', why: '组网探测与 EasyTier 参数' },
  'storage.js': { kind: 'adapter', why: 'localStorage / SQLite / 内存三态适配' },
  'student.js': { kind: 'transport', why: '学生端连接状态机与本地草稿' }
};

const dir = path.join(ROOT, 'assets/js');
const DOMAIN = path.join(ROOT, 'crates/ci-domain/src');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort();

group('分类完整性');
ok(files.length > 0, 'assets/js 里有模块（' + files.length + ' 个）');
files.forEach((f) => ok(!!CLASSIFY[f], '模块已分类：' + f + (CLASSIFY[f] ? '' : '（新加的模块要登记到 rule-audit 的表里）')));
Object.keys(CLASSIFY).forEach((f) => ok(files.includes(f), '分类表里的文件仍存在：' + f));

group('规则模块必须有 Rust 对应物');
const rules = Object.entries(CLASSIFY).filter(([, c]) => c.kind === 'rule');
rules.forEach(([f, c]) => {
  c.rs.forEach((m) => {
    ok(fs.existsSync(path.join(DOMAIN, m + '.rs')), '规则 ' + f + ' 的 Rust 实现存在：crates/ci-domain/src/' + m + '.rs');
  });
});
console.log('   规则模块 ' + rules.length + ' 个，Rust 对应文件 ' + rules.reduce((n, [, c]) => n + c.rs.length, 0) + ' 个');

group('Rust 实现不能是空壳');
rules.forEach(([f, c]) => {
  c.rs.forEach((m) => {
    const src = fs.readFileSync(path.join(DOMAIN, m + '.rs'), 'utf8');
    ok(/mod tests/.test(src), 'crates/ci-domain/src/' + m + '.rs 自带测试（不是空壳）');
    ok(src.length > 1200, 'crates/ci-domain/src/' + m + '.rs 有实质内容（' + src.length + ' 字节）');
  });
});
// parity 基准必须覆盖规则模块（"有实现"与"与 JS 口径一致"是两件事）
const parityJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/parity.json'), 'utf8'));
const parityKeys = Object.keys(parityJson).filter((k) => !k.startsWith('_') && k !== 'generatedBy');
ok(parityKeys.length >= 10, 'parity 基准覆盖 ≥10 个用例集（当前 ' + parityKeys.length + '）');
console.log('   parity 用例集：' + parityKeys.join(', '));

group('客户端固有模块不应被要求迁到 Rust');
const others = Object.entries(CLASSIFY).filter(([, c]) => c.kind !== 'rule');
others.forEach(([f, c]) => {
  ok(!c.rs, '客户端固有模块没有 Rust 对应物（本就不该有）：' + f + ' —— ' + c.why);
});
console.log('   传输/适配模块 ' + others.length + ' 个：' + others.map(([f]) => f).join(', '));

group('规则模块必须登记在迁移进度表里');
const v5 = fs.readFileSync(path.join(ROOT, 'tests/v5-workspace.test.js'), 'utf8');
rules.forEach(([f]) => {
  ok(v5.includes("assets/js/" + f), '迁移进度表覆盖 ' + f);
});

group('规模统计（供删除决策参考）');
let ruleKb = 0, otherKb = 0;
Object.entries(CLASSIFY).forEach(([f, c]) => {
  const kb = fs.statSync(path.join(dir, f)).size / 1024;
  if (c.kind === 'rule') ruleKb += kb; else otherKb += kb;
});
console.log('   规则类 ' + ruleKb.toFixed(0) + ' KB（' + rules.length + ' 个模块）');
console.log('   客户端固有 ' + otherKb.toFixed(0) + ' KB（' + others.length + ' 个模块）');
console.log('   合计 ' + (ruleKb + otherKb).toFixed(0) + ' KB');
ok(ruleKb > 0 && otherKb > 0, '两类都非空（分类表没写歪）');

console.log('\n----------------------------------------');
if (failures.length) {
  console.log('❌ 失败 ' + failures.length + ' 项 / 通过 ' + passed + ' 项');
  failures.forEach((f, i) => console.log('  ' + (i + 1) + '. ' + f));
  process.exit(1);
}
console.log('✅ 全部通过：' + passed + ' 项断言（领域层分类守卫）');
