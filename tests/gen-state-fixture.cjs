/*!
 * tests/gen-state-fixture.cjs — 把 JS 侧的真实状态导出成 fixture
 *
 *   用途：Rust 侧要能吃下**前端真正发上来的那份状态**。
 *   领域端点（/api/domain/stats）收的是前端序列化的 ClassroomState ——
 *   只要有一个字段 Rust 要求、JS 不产出，整个请求就会被 serde 拒掉。
 *
 *   node tests/gen-state-fixture.cjs
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

globalThis.localStorage = (() => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear() };
})();
for (const f of ['store.js', 'analysis.js', 'grade.js', 'rollcall.js', 'classroom.js', 'import.js']) {
  require(path.join(ROOT, 'assets', 'js', f));
}
const CI = globalThis.CI;
const S = CI.store;

S.replaceState(S.defaultState());
const team = S.get().teams[0].id;
const a = S.addStudent('甲', team);
const sid = typeof a === 'string' ? a : a.id;
const q = S.addQuestion({
  stem: '示例题：1+1=?', tier: 'basic', answer: 'A',
  options: ['1', '2', '3'], tags: ['代数'], source: '课本', note: '讲评要点', imageUrl: 'data:image/png;base64,AA'
});
const qz = S.createQuiz('示例卷', [q.id]);
S.setCurrentQuiz(qz.id);
S.recordResult({ sid, qid: q.id, tier: 'basic', result: 'correct', quizId: qz.id, picked: 'A' });
S.setRuntime({ qid: q.id, quizId: qz.id });
CI.classroom.setPhase('question');
CI.classroom.setTimer(60, '随堂练习');
CI.rollcall.applyPick({ sid, at: Date.now() });

const state = S.get();
const out = path.join(ROOT, 'tests', 'fixtures', 'state-from-js.json');
fs.writeFileSync(out, JSON.stringify(state, null, 1), 'utf8');

const keys = (o) => (o && typeof o === 'object' ? Object.keys(o).join(', ') : '（' + String(o) + '）');
console.log('  ✔ 已写出 ' + path.relative(ROOT, out));
console.log('  顶层键: ' + keys(state));
console.log('  bank[0]: ' + keys(state.bank[0]));
console.log('  students[0]: ' + keys(state.students[0]));
console.log('  quizzes[0]: ' + keys(state.quizzes[0]));
console.log('  records[0]: ' + keys((state.quizzes[0] || {}).records?.[0]));
console.log('  settings: ' + keys(state.settings));
console.log('  rollcall: ' + keys(state.rollcall));
console.log('  classroom: ' + keys(state.classroom));
console.log('  runtime: ' + keys(state.runtime));
console.log('  tiers[0]: ' + keys(state.tiers[0]));
