/*!
 * tests/probe-goal-evidence.cjs — 收集"目标是否达成"的证据（逐条对照目标原文）
 *   node tests/probe-goal-evidence.cjs
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const has = (p) => fs.existsSync(path.join(ROOT, p));
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const line = (ok, label, extra) => console.log('  ' + (ok ? '✅' : '❌') + ' ' + label + (extra ? '  —— ' + extra : ''));

console.log('=== 目标 ① 删除旧版零构建界面（三个 HTML + 三个 JS + /legacy 路由），e2e 改写到 Vue ===');
['admin.html', 'student.html', 'index.html',
 'assets/js/admin.js', 'assets/js/quiz.js', 'assets/js/analysis-ui.js', 'assets/js/bank.js',
 'assets/css/app.css', 'assets/css/student.css'].forEach((f) => line(!has(f), '已删除 ' + f));
line(!read('sync-server.js').includes('/legacy'), 'Node 枢纽无 /legacy 路由');
line(!read('crates/ci-core/src/server.rs').includes('/legacy'), 'Rust 枢纽无 /legacy 路由');
line(read('tests/smoke.html').includes('/admin.html'), '单端 e2e 打 Vue 教师端');
line(read('tests/smoke-class.html').includes('/join?room='), '多端 e2e 打 Vue 三端');

console.log('\n=== 目标 ② 纯逻辑下沉到 ci-domain（Rust + JS 双实现 + parity）===');
const domain = fs.readdirSync(path.join(ROOT, 'crates/ci-domain/src')).filter((f) => f.endsWith('.rs'));
line(domain.length >= 12, 'ci-domain 模块数 ' + domain.length);
line(has('assets/js/import.js') && has('crates/ci-domain/src/bank_import.rs'), 'parseImport 两侧都在');
line(read('crates/ci-domain/src/question_stats.rs').includes('pub fn student_view'), '学生可见视图有 Rust 实现');
const fx = JSON.parse(read('tests/fixtures/parity.json'));
const keys = Object.keys(fx).filter((k) => !k.startsWith('_') && k !== 'generatedBy');
const cases = keys.reduce((n, k) => n + (Array.isArray(fx[k]) ? fx[k].length : Object.values(fx[k]).reduce((m, a) => m + (Array.isArray(a) ? a.length : 0), 0)), 0);
line(keys.length >= 13, 'parity 用例集 ' + keys.length + ' 个 / ' + cases + ' 组');

console.log('\n=== 目标 ③ 界面通过 Rust 核心取数 ===');
const api = read('web/src/shared/domain-api.ts');
['fetchStats', 'fetchPick', 'fetchAbilityBoard', 'gradeWithRust'].forEach((f) => line(api.includes(f), '客户端有 ' + f));
const hub = read('crates/ci-hub/src/lib.rs');
['/api/domain/stats', '/api/domain/pick', '/api/domain/ability-board', '/api/domain/grade', '/api/domain/score']
  .forEach((r) => line(hub.includes(r), '枢纽挂载 ' + r));
line(read('tests/smoke.html').includes('Rust 核心'), 'e2e 断言界面标注并使用 Rust');
line(read('web/src/shared/runtime.ts').includes('gradeWithRust'), '课堂核心循环走 Rust');
line(read('docs/14-v5架构与迁移方案.md').includes('## 9. 决策记录'), '回退策略已写成决策（§9）');

console.log('\n=== 目标 ④ CI 全绿 + 文档同步 ===');
line(read('package.json').includes('rule-audit'), '分类守卫进 CI');
line(read('scripts/ci-local.mjs').includes('ui-vue.test.mjs'), 'Vue 冒烟进 CI');
const docs = fs.readdirSync(path.join(ROOT, 'docs')).filter((f) => f.endsWith('.md'));
line(docs.length >= 14, 'docs 文档 ' + docs.length + ' 篇');
line(read('docs/14-v5架构与迁移方案.md').includes('### 1.7 领域层分类'), 'docs/14 含分类表');
line(read('docs/13-新界面迁移方案.md').includes('界面已统一到 Vue'), 'docs/13 含界面统一说明');
