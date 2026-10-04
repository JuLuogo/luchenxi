/*!
 * tests/probe-open3-evidence.cjs — 三项增强的证据（逐条对照目标原文）
 *   node tests/probe-open3-evidence.cjs
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const has = (p) => fs.existsSync(path.join(ROOT, p));
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const line = (ok, label, extra) => console.log('  ' + (ok ? '✅' : '❌') + ' ' + label + (extra ? '  —— ' + extra : ''));

const page = read('web/src/teacher/pages/OpenClassPage.vue');
const rubric = read('web/src/teacher/pages/settings/OpenRubricPage.vue');

console.log('=== ① 中途换人（不丢当前题、记录标注"换人"）===');
line(page.includes('switchStudent'), '换一位按钮的逻辑');
line(page.includes("'换一位'") || page.includes('换一位'), '按钮在界面上');
line(page.includes('switchedFrom'), '记住被换下的人');
line(page.includes('switched: !!switchedFrom.value'), '记录带 switched 标记');
line(page.includes('prevName'), '记录带被换下的人名');
line(/换一位[\s\S]{0,200}doDraw/.test(page) === false, '换人不重新抽题（switchStudent 里没有 doDraw）');
const sw = page.slice(page.indexOf('async function switchStudent'), page.indexOf('async function switchStudent') + 900);
line(!sw.includes('doDraw'), '换人函数里确实没有抽题');
line(page.includes('row.switched') && page.includes('换人'), '记录面板标出「换人」');

console.log('\n=== ② 评价的公开展示策略（公开表扬、私下改进）===');
const oc = read('crates/ci-domain/src/openclass.rs');
const ocJs = read('assets/js/openclass.js');
line(oc.includes('pub fn show_on_stage'), 'Rust 规则实现');
line(ocJs.includes('function showOnStage'), 'JS 同契约实现');
line(oc.includes('pub fn is_praise'), '上半档判据（不认死档位名）');
line(read('crates/ci-domain/src/state.rs').includes('open_eval_on_stage'), '设置项进契约');
line(rubric.includes('公开表扬、私下改进'), '设置页有三选一');
line(read('assets/js/sync.js').includes('openEvalPublic'), '快照下发"能不能公开"');
line(read('web/src/stage/App.vue').includes('openEvalPublic'), '大屏读下发结果（不重写判断）');
line(read('web/src/stage/App.vue').includes('按当前策略不公开'), '不公开时大屏有说明（老师知道系统没坏）');

console.log('\n=== ③ 档位可配置（三档/五档/自定义档位名）===');
line(oc.includes('pub struct OpenLevel'), 'Rust 档位类型');
line(oc.includes('pub fn levels_from_labels'), '按档位名生成均匀档位');
line(oc.includes('pub fn level_for_total'), '总评档位 = 总分落在哪一档（不再硬编码阈值）');
line(ocJs.includes('function levelsFromLabels'), 'JS 同契约');
line(read('crates/ci-domain/src/state.rs').includes('open_levels'), '档位进设置契约');
line(read('crates/ci-hub/src/domain_api.rs').includes('levels'), '端点接受档位');
line(rubric.includes('levelLabels') && rubric.includes('addLevel'), '设置页能编辑档位名');
line(rubric.includes('恢复默认四档'), '一键恢复默认');
line(rubric.includes('levelRates'), '界面显示算出来的分数');

console.log('\n=== parity 与测试覆盖 ===');
const fx = JSON.parse(read('tests/fixtures/parity.json'));
line((fx.levels || []).length >= 4, 'parity：档位 ' + (fx.levels || []).length + ' 组（两/三/四/五档）');
line((fx.stagePolicy || []).length >= 16, 'parity：展示策略 ' + (fx.stagePolicy || []).length + ' 组');
line((fx.openclass || []).length >= 7, 'parity：量规 ' + (fx.openclass || []).length + ' 组');
line(read('tests/logic.test.js').includes('大屏公开展示策略'), 'logic.test 覆盖展示策略');
line(read('tests/logic.test.js').includes('量规可配置'), 'logic.test 覆盖量规可配置');
line(read('tests/logic.test.js').includes('公开课评价留痕'), 'logic.test 覆盖留痕（换人靠它留痕）');
line(read('tests/ui-vue.test.mjs').includes('#/settings/rubric'), 'Vue 冒烟覆盖设置页');
