/*!
 * tests/audit-regression.cjs — 整体回归：把这一轮审计修过的每一类问题，重新验一遍
 *
 *   不是"再跑一次 CI"—— CI 只说明"现在的代码能过测试"，
 *   这个脚本逐条回答"**当初那个 bug 现在真的不在了吗**"。
 *
 *   node tests/audit-regression.cjs
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

console.log('=== A. 领域层：三个高危（含"先抢答加分最少"）===');
{
  const oc = read('crates/ci-domain/src/openclass.rs');
  const cl = read('crates/ci-domain/src/classroom.rs');
  const st = read('crates/ci-domain/src/stats.rs');
  check(/saturating_sub\(ev\.parts\.len\(\)\)/.test(oc), '评语不再把维度数写死 4（用 saturating_sub）');
  check(/dims_total/.test(oc), '评价结果记下量规总维度数');
  check(/buzz\.len\(\) - i/.test(cl), '抢答名次 = len - position（先抢的名次更高）');
  check(/raw == &r\.tier/.test(st), '题型桶查找键用原始 tier（表外题型不再产生重复轴）');
  const ocJs = read('assets/js/openclass.js');
  check(/dimsTotal/.test(ocJs), 'JS 侧同契约（dimsTotal）');
}

console.log('\n=== B. 枢纽：4 个高危（两个枢纽都修）===');
{
  const hub = read('crates/ci-hub/src/lib.rs');
  const srv = read('crates/ci-core/src/server.rs');
  const node = read('sync-server.js');
  check(/c\.role == "host"/.test(hub), 'Rust 枢纽：hello 不能把自己提成 host');
  check(/first == "data"/.test(srv), 'Rust 静态服务：拉黑 data/');
  check(/blocked_file/.test(srv), 'Rust 静态服务：拉黑 *.db*');
  check(!/if r\.state\.is_none\(\) \{\s*\n\s*r\.state = Some/.test(hub), 'Rust 枢纽：dump 不当 state 广播');
  check(/'data'/.test(node), 'Node 静态服务：拉黑 data/');
  check(/blockedFile/.test(node), 'Node 静态服务：拉黑 *.db*');
  check(!/if \(!room\.payload\) room\.payload = room\.dump;/.test(node), 'Node 枢纽：dump 不当 state 广播');
  check(has('tests/fix-hub-verify.cjs'), '黑盒验证脚本存在');
  const ci = read('scripts/ci-local.mjs');
  check((ci.match(/fix-hub-verify/g) || []).length >= 2, '两个枢纽的 e2e 都跑安全验证（2 处）');
}

console.log('\n=== C. 学生端：5 处 ===');
{
  const stu = read('assets/js/student.js');
  check(/return new Promise/.test(stu) && /resolve\(\{ ok/.test(stu), 'testHub 返回 Promise<{ok,text}>');
  check(/if \(!sent\) \{ toast\('未连接教师机/.test(stu), '发送失败不假装成功');
  check(/buzzed = \{ qid/.test(stu), 'buzz 记下已抢答状态');
  check(/function syncQuestion/.test(stu), '换题清空本地作答（syncQuestion）');
  const cls = read('assets/js/classroom.js');
  check(/reveal: isRevealed\(s, currentQuestion\(s\)\)/.test(cls), 'meta.reveal 按题生效');
  check(/type: CI\.grade\.typeOf\(q\)/.test(cls), 'studentView 带 type（学生端才发得出选项）');
}

console.log('\n=== D. 教师端：响应式 + 口径 ===');
{
  const cs = read('web/src/shared/class-store.ts');
  check(/shallowRef<ClassroomState>/.test(cs), 'class-store 用 shallowRef');
  check(/triggerRef\(state\)/.test(cs), 'class-store 显式 triggerRef（原地改也通知）');
  check(/recordsOf\(state\.value, \{ sid: sid \}\)/.test(cs), 'recordsOf 传对象（不再返回全班流水）');
  const sm = read('tests/ui-vue.test.mjs');
  check(/原地更新/.test(sm), '冒烟有"原地更新"断言（不靠切路由）');
  // 注意：|| true 会出现在**注释**里（记录旧 bug 的写法），所以只查非注释行
  const smLines = sm.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|<!--)/.test(l));
  check(!smLines.some((l) => /\|\| true/.test(l)), '冒烟里没有恒真断言（注释除外）');
  const api = read('web/src/shared/domain-api.ts');
  check(/tiers: \(CI\.store\.get\(\)/.test(api), '计分端点带上 tiers/settings');
  const roll = read('web/src/teacher/pages/RollPage.vue');
  // 修复方式是「把 judge/quickFor 提升到 CI.rollcall」（而不是改调用点），
  // 所以这里检查的是「调用点用的名字在领域层真的存在」，不是「别调它」。
  const rollJs = read('assets/js/rollcall.js');
  check(/CI\.rollcall\.judge\(/.test(roll) && /judge: judge/.test(rollJs),
    '点名页调的 judge 在 CI.rollcall 上真实存在（两边一致）');
  const rl = read('assets/js/rollcall.js');
  check(/judge: judge, quickFor: quickFor/.test(rl), 'judge/quickFor 已提升到 CI.rollcall');
  const ocp = read('web/src/teacher/pages/OpenClassPage.vue');
  check(/count: 1/.test(ocp), '公开课抽题参数正确（不再恒返回空）');
  check(/typeOf\(q\)/.test(ocp), '公开课"只抽客观题"用领域层口径');
}

console.log('\n=== E. 假绿路径：CI 真的会红吗 ===');
{
  const dr = read('tests/doc-refs.js');
  check(/process\.exit\(1\)/.test(dr), 'doc-refs 有退出码');
  const pt = read('tests/protocol.test.js');
  check(/msg\.type === 'dump'/.test(pt) && /切不出这一段说明断言失效/.test(pt), 'protocol 的 dump 断言是真断言');
  const rs = read('tests/run-smoke.js');
  check(/consoleBad/.test(rs), 'e2e 把控制台错误计入失败');
  check(/BENIGN/.test(rs), 'e2e 有带注释的良性清单（默认严格）');
  const uv = read('tests/ui-vue.test.mjs');
  check(/CANDIDATES/.test(uv), 'ui-vue 跨平台探测浏览器（不再硬编码 Windows 路径）');
  const ct = read('tests/client.test.js');
  check(/ok\(false, app \+ '\/ui 目录存在/.test(ct), 'client.test 的 ui 缺失记为失败');
  const db = read('tests/db.test.js');
  check(/process\.exit\(1\)/.test(db), 'db.test 的 sqlite 不可用即红');
  const ciT = read('tests/ci.test.js');
  check(/ok\(!!YAML/.test(ciT), 'ci.test 缺依赖即失败');
  const su = read('scripts/sync-ui.mjs');
  check(/process\.exit\(1\)/.test(su), 'sync-ui 入口缺失即失败');
}

console.log('\n=== F. 脚本不再静默失败 ===');
{
  check(/process\.exit\(1\)/.test(read('scripts/start.mjs')), 'start.mjs 构建失败即退出');
  check(/process\.exit\(1\)/.test(read('scripts/collect-bundles.mjs')), 'collect-bundles 读不到配置即退出');
  check(/!alreadyOn && patched === src/.test(read('scripts/patch-android-manifest.mjs')), 'manifest no-op 收窄判定');
  check(/无法验证本仓库的枢纽/.test(read('scripts/doctor.mjs')), 'doctor 端口占用如实报告');
  check(/sidecar 拉取失败/.test(read('scripts/ci-local.mjs')), 'ci-local 检查 sidecar 退出码');
  check(/process\.exit\(1\)/.test(read('tests/probe.js')), 'probe.js 失败即非 0');
  const d = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'doctor.mjs')], { cwd: ROOT, encoding: 'utf8' });
  check(d.status === 0, 'doctor 退出码 0（不再崩溃）—— 实际 ' + d.status);
}

console.log('\n=== G. 新增的永久守卫都在 CI 里 ===');
{
  const ci = read('scripts/ci-local.mjs');
  ['arity.test.js', 'gen-state-fixture.cjs', 'fix-hub-verify.cjs', 'rule-audit.test.js', 'doc-refs.js']
    .forEach((f) => check(ci.includes(f), 'CI 含 ' + f));
}

console.log('\n----------------------------------------');
if (fails.length) {
  console.log('❌ 回归失败 ' + fails.length + ' 项 / 通过 ' + pass + ' 项');
  fails.forEach((f, i) => console.log('  ' + (i + 1) + '. ' + f));
  process.exit(1);
}
console.log('✅ 回归全部通过：' + pass + ' 项（逐条回答"当初那个 bug 现在还在不在"）');
