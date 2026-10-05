/*!
 * tests/audit2-regression.cjs — 第二轮审计的验收清单（逐条回答"修的东西现在还在不在"）
 *
 *   与第一轮的 `audit-regression.cjs` 同样的思路：CI 只说明"现在的代码能过测试"，
 *   这个脚本逐条回答"**当初那个缺口现在真的补上了吗**"。
 *
 *   node tests/audit2-regression.cjs
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const has = (p) => fs.existsSync(path.join(ROOT, p));

let pass = 0;
const fails = [];
const check = (ok, label) => {
  if (ok) { pass += 1; console.log('  ✅ ' + label); }
  else { fails.push(label); console.log('  ❌ ' + label); }
};

console.log('=== A. 功能缺口 Top 8 ===');
{
  const stu = read('assets/js/student.js');
  check(/function sendOrQueue/.test(stu) && /function flushQueue/.test(stu), '① 学生端断网排队 + 重连补发');
  check(/if \(cmd\.id\) \{/.test(read('assets/js/classroom.js')), '① 教师端按 cmd.id 幂等去重');

  const stage = read('web/src/stage/App.vue');
  check(!/\{\{[^}]*missers[^}]*\}\}/.test(stage), '② 大屏不渲染"谁没答对"的姓名');
  check(/clamp\([^)]*vmin/.test(stage), '④ 大屏字号随视口缩（clamp + vmin）');

  check(/计分规则/.test(read('web/src/student/App.vue')) && /rulesInfo/.test(read('web/src/student/App.vue')), '③ 计分规则对学生可见');
  check(/口头回答/.test(read('web/src/teacher/pages/RollPage.vue')), '⑤ 口头作答显式入口');
  check(/样本不足/.test(read('web/src/teacher/pages/AnalysisPage.vue')), '⑥ 样本不足显式标注');
  check(/parseRoster/.test(read('assets/js/import.js')), '⑥ 名单文件导入（领域层解析）');
  check(/从文件导入/.test(read('web/src/teacher/pages/ClassPage.vue')), '⑥ 名单文件导入（界面入口）');
  check(/doBulkJudge/.test(read('web/src/teacher/pages/ClassPage.vue')), '⑥ 批量判分');
  check(/function trend/.test(read('assets/js/analysis.js')), '⑦ 趋势（JS）');
  check(has('crates/ci-domain/src/trend.rs'), '⑦ 趋势（Rust 孪生）');
  check(/trendOption/.test(read('web/src/teacher/pages/AnalysisPage.vue')), '⑦ 趋势接进学情页');
  check(/ci-archive/.test(read('assets/js/archive.js')), '⑦ 本课归档');
  check(has('web/src/shared/a11y.ts') && /a11y-reduce-motion/.test(read('web/src/styles/tokens.css')), '⑧ 无障碍最小集');
}

console.log('\n=== B. 隐私四层 ===');
{
  const hub = read('crates/ci-hub/src/lib.rs');
  const node = read('sync-server.js');
  const cls = read('assets/js/classroom.js');
  check(/function publicPayload/.test(cls), '① 定义"学生/大屏该看到什么"的公开投影');
  check(!/missers: x\.missers/.test(read('assets/js/sync.js')), '② 广播里不再带 missers 姓名');
  check(/function stateFor/.test(node) && /fn state_for/.test(hub), '③ 按角色下发（两个枢纽都有）');
  check(/function stripScores/.test(node) && /fn strip_scores/.test(hub), '④ 大屏拿不到个人成绩（两个枢纽都有）');
  check(/score: r\.score/.test(read('assets/js/sync.js')), '④ 成绩字段仍在广播里（学生端三处 UI 要用）');
}

console.log('\n=== C. UI 规范化（跑审计工具看数字）===');
{
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tests', 'ui-token-audit.cjs')], { cwd: ROOT, encoding: 'utf8' });
  const out = r.stdout || '';
  const m = out.match(/字号 (\d+) 种 \/ 间距 (\d+) 种 \/ 圆角 (\d+) 种 \/ 阴影 (\d+) 种 \/ 硬编码颜色 (\d+) 种/);
  if (m) {
    const [, fsN, spN, rN, shN, cN] = m.map(Number);
    check(fsN <= 10, '字号种类 ≤ 10（实际 ' + fsN + '）');
    check(spN <= 12, '间距种类 ≤ 12（实际 ' + spN + '）');
    check(rN <= 4, '圆角种类 ≤ 4（实际 ' + rN + '）');
    check(shN <= 8, '阴影种类 ≤ 8（实际 ' + shN + '）');
    check(cN <= 45, '硬编码颜色收敛（实际 ' + cN + '，原 53）');
  } else {
    check(false, 'ui-token-audit 输出可解析');
  }
  check(has('web/src/styles/token-value.ts'), 'canvas 用色有 token() 工具');
  check(has('tests/canvas-token-guard.test.js'), '图表颜色守卫存在');
}

console.log('\n=== D. API 规范（两版枢纽）===');
{
  const hub = read('crates/ci-hub/src/lib.rs');
  const node = read('sync-server.js');
  check(/DefaultBodyLimit::max\(16/.test(hub), '请求体上限对齐 16MB');
  check(/"qrcode": true/.test(hub), 'Rust /health 的 qrcode 说实话');
  check(/Object\.assign\(new Error\('请求体过大'\), \{ status: 413 \}\)/.test(node), 'Node 体过大 → 413');
  check(/Object\.assign\(new Error\('JSON 解析失败：' \+ e\.message\), \{ status: 400 \}\)/.test(node), 'Node 坏 JSON → 400');
  check(/Number\(e && e\.status\) \|\| 500/.test(node), 'Node 顶层 catch 用 e.status');
  check(/"at"\.to_string\(\)/.test(hub), 'Rust 转发命令补 at');
  const conf = read('crates/ci-hub/tests/hub_conformance.rs');
  check(/async fn http_put/.test(conf) && /409/.test(conf), 'Rust 一致性测试覆盖 PUT + 409');
  check(/GET \/api\/restore 被拒/.test(conf), 'Rust 一致性测试覆盖方法校验');
}

console.log('\n=== E. 守卫都在 CI 里 ===');
{
  const ci = read('scripts/ci-local.mjs');
  ['domain-load-check.cjs', 'canvas-token-guard.test.js', 'audit-regression.cjs', 'arity.test.js',
   'rule-audit.test.js', 'fix-hub-verify.cjs'].forEach((f) => check(ci.includes(f), 'CI 含 ' + f));
}

console.log('\n=== F. 文档同步 ===');
{
  const d16 = read('docs/16-审计记录.md');
  const d09 = read('docs/09-路线图与变更记录.md');
  check(/第二轮审计成果/.test(d16), 'docs/16 有第二轮成果一节');
  check(!/每个学生都能读到全班数据（待处理）/.test(d16), 'docs/16 的隐私问题已标记为已修复');
  check(/第二轮全面审计/.test(d09), 'docs/09 有第二轮变更记录');
  check(has('docs/17-UI设计规范调研.md'), 'UI 规范调研文档在');
  const dr = spawnSync(process.execPath, [path.join(ROOT, 'tests', 'doc-refs.js')], { cwd: ROOT, encoding: 'utf8' });
  check(dr.status === 0, 'doc-refs 通过（引用无越界）');
}

console.log('\n----------------------------------------');
if (fails.length) {
  console.log('❌ 第二轮验收失败 ' + fails.length + ' 项 / 通过 ' + pass + ' 项');
  fails.forEach((f, i) => console.log('  ' + (i + 1) + '. ' + f));
  process.exit(1);
}
console.log('✅ 第二轮验收全部通过：' + pass + ' 项（逐条回答"缺口真的补上了吗"）');
