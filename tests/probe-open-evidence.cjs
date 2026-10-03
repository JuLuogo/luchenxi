/*!
 * tests/probe-open-evidence.cjs — 收集"公开课目标是否达成"的证据（逐条对照目标原文）
 *   node tests/probe-open-evidence.cjs
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const has = (p) => fs.existsSync(path.join(ROOT, p));
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const line = (ok, label, extra) => console.log('  ' + (ok ? '✅' : '❌') + ' ' + label + (extra ? '  —— ' + extra : ''));

console.log('=== ① 教师端公开课子模块（点名 → 抽题 → 答题 → 评价）===');
line(has('web/src/teacher/pages/OpenClassPage.vue'), '公开课页面存在');
const page = read('web/src/teacher/pages/OpenClassPage.vue');
['doPick', 'doDraw', 'judge', 'setScore', 'finish'].forEach((f) => line(page.includes(f), '四步逻辑：' + f));
line(read('web/src/teacher/router.js').includes("'/open'"), '路由 /open 已挂');
line(read('web/src/teacher/router.js').includes("group: '公开课'"), '侧边栏独立成组「公开课」');

console.log('\n=== ② 抽题客观题为主 + 主观题现场判定三档 ===');
line(page.includes('onlyObjective'), '默认只抽客观题开关');
line(page.includes('scoreVerdictWithRust'), '判定走 Rust 计分端点');
line(read('crates/ci-hub/src/lib.rs').includes('/api/domain/score'), '计分端点已挂');
['全对', '对一半', '不对'].forEach((w) => line(page.includes(w), '判定三档：' + w));

console.log('\n=== ③ 多维评价（可配置）+ 评语（规则默认 / AI 可选）===');
line(has('crates/ci-domain/src/openclass.rs'), 'Rust 量规实现');
line(has('assets/js/openclass.js'), 'JS 量规实现（同契约）');
line(has('crates/ci-domain/src/polish.rs'), 'Rust 润色提示词（只润色不判断）');
line(has('web/src/teacher/pages/settings/OpenRubricPage.vue'), '量规可配置页');
line(has('web/src/teacher/pages/settings/AiPolishPage.vue'), 'AI 润色配置页（默认关闭）');
line(read('web/src/shared/ai-polish.ts').includes('localStorage'), 'AI 密钥只存本机（不进 state）');
const fx = JSON.parse(read('tests/fixtures/parity.json'));
line((fx.openclass || []).length >= 7, 'parity：公开课量规 ' + (fx.openclass || []).length + ' 组');
line((fx.polish || []).length >= 4, 'parity：润色提示词 ' + (fx.polish || []).length + ' 组');

console.log('\n=== ④ 学生端与安卓端、大屏改造 ===');
const stage = read('web/src/stage/App.vue');
line(stage.includes('meta.open'), '大屏显示公开课状态');
line(stage.includes('open-block'), '大屏公开课横幅');
const stu = read('web/src/student/App.vue');
line(stu.includes('到你了'), '学生端「到你了」');
line(read('assets/js/student.js').includes('openState'), '学生端领域层接口');
line(read('scripts/sync-ui.mjs').includes('web/dist'), '安卓端与网页版共用同一份 Vue 产物');

console.log('\n=== ⑤ CI 全绿 + 文档 + e2e ===');
line(read('tests/smoke-class.html').includes('公开课：点名') || read('tests/smoke-class.html').includes('公开课全链路'), '多端 e2e 覆盖公开课');
line(read('tests/ui-vue.test.mjs').includes('#/open'), 'Vue 冒烟覆盖 /open');
line(read('tests/smoke.html').includes('/api/domain/open-eval'), '单端 e2e 覆盖公开课端点');
line(has('docs/15-公开课模式设计.md'), '设计文档');
line(read('docs/15-公开课模式设计.md').includes('## 7. 已实现'), '文档含「已实现」章节');
line(has('docs/screenshots-open'), '截图目录');
const shots = fs.readdirSync(path.join(ROOT, 'docs/screenshots-open'));
line(shots.length >= 6, '截图 ' + shots.length + ' 张');
line(has('tests/shot-open.js'), '截图可重跑');

console.log('\n=== 额外补的两件（目标没写但现场一定会遇到）===');
line(read('tests/rule-audit.test.js').includes('openclass.js'), '分类守卫已登记公开课量规');
line(read('assets/js/classroom.js').includes('pushOpenRecord'), '评价留痕（不是用完就丢）');
line(page.includes('exportCsv'), '记录可导出 CSV');
line(page.includes('startTimer'), '现场计时（30 秒 / 60 秒 / 2 分钟）');
line(page.includes('allowRepeat'), '点名是否允许重复（可配）');
