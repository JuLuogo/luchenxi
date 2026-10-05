/*!
 * tests/domain-load-check.cjs — 领域层模块加载自检（语法通过 ≠ 导出正常）
 *
 *   为什么需要它：我零散改了 `assets/js/student.js` 五处，结果模块**静默坏掉** ——
 *   `node --check` 通过、require 也不抛错，但 **`CIStudent` 一个导出都没有**，
 *   所有功能静默失效。只有"加载后数一数导出"才发现。
 *
 *   用法：`node tests/domain-load-check.cjs`（改完领域层模块后必跑）
 */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..');

/* 让领域层模块能在 Node 里加载（它们假设有 window/localStorage） */
globalThis.window = globalThis;
if (!globalThis.localStorage) {
  globalThis.localStorage = {
    _d: {},
    getItem(k) { return Object.prototype.hasOwnProperty.call(this._d, k) ? this._d[k] : null; },
    setItem(k, v) { this._d[k] = String(v); },
    removeItem(k) { delete this._d[k]; },
    clear() { this._d = {}; }
  };
}

/** 文件 → 命名空间 → 必须存在的导出（**显式映射**，不靠猜） */
const EXPECT = [
  ['assets/js/store.js', 'CI.store', ['get', 'tx', 'addStudent', 'recordResult', 'defaultState']],
  ['assets/js/analysis.js', 'CI.analysis', ['ranking', 'classStats', 'studentStats', 'abilityBoard']],
  ['assets/js/grade.js', 'CI.grade', ['auto', 'typeOf', 'parseChoice']],
  ['assets/js/rollcall.js', 'CI.rollcall', ['pick', 'candidates', 'judge', 'quickFor']],
  ['assets/js/classroom.js', 'CI.classroom', ['handleCmd', 'setPhase', 'studentView', 'setOpenState', 'pushOpenRecord']],
  ['assets/js/import.js', 'CI.bankImport', ['parse']],
  ['assets/js/openclass.js', 'CI.openclass', ['evaluate', 'comment', 'levelsAreValid']],
  ['assets/js/polish.js', 'CI.polish', ['prompt', 'sanitize']]
];

const pick = (dotted) => dotted.split('.').reduce((o, k) => (o ? o[k] : undefined), globalThis);

let bad = 0;
console.log('=== 领域层模块加载自检（语法通过 ≠ 导出正常）===');

for (const [file, nsPath, names] of EXPECT) {
  try {
    require(path.join(ROOT, file));
  } catch (e) {
    console.log('  ✘ ' + file + ' 加载抛错：' + e.message);
    bad += 1;
    continue;
  }
  const mod = pick(nsPath);
  if (!mod) {
    console.log('  ✘ ' + file + ' 没挂上 ' + nsPath + '（导出为空 —— 模块中途坏了）');
    bad += 1;
    continue;
  }
  const missing = names.filter((x) => typeof mod[x] !== 'function');
  if (missing.length) {
    console.log('  ✘ ' + nsPath + ' 缺导出：' + missing.join(', '));
    bad += 1;
  } else {
    console.log('  ✅ ' + file.padEnd(28) + ' → ' + nsPath + '（' + Object.keys(mod).length + ' 个导出）');
  }
}

/* student.js 挂的是 CIStudent（不是 CI.*），单独查 */
try {
  require(path.join(ROOT, 'assets/js/student.js'));
  const S = globalThis.CIStudent || {};
  const total = Object.keys(S).length;
  const need = ['submit', 'buzz', 'questionKind', 'setDraft', 'sendOrQueue', 'flushQueue', 'pendingCount'];
  const missing = need.filter((k) => typeof S[k] !== 'function');
  if (total === 0) {
    console.log('  ✘ student.js 导出为空（模块中途坏了）');
    bad += 1;
  } else if (missing.length) {
    console.log('  ✘ CIStudent 缺：' + missing.join(', '));
    bad += 1;
  } else {
    console.log('  ✅ assets/js/student.js'.padEnd(36) + ' → CIStudent（' + total + ' 个导出）');
  }
} catch (e) {
  console.log('  ✘ student.js 加载抛错：' + e.message);
  bad += 1;
}

console.log('');
console.log(bad ? '❌ ' + bad + ' 个模块有问题' : '✅ 全部模块导出正常（' + (EXPECT.length + 1) + ' 个）');
process.exit(bad ? 1 : 0);
