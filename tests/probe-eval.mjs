/*!
 * tests/probe-eval.mjs — 评价逻辑诊断探针（改判分/评价后一键复跑，核对语义是否还符合预期）
 *   node tests/probe-eval.mjs
 *
 * 为什么单独留一个：判分与评价的"边界语义"很难从代码一眼看出来
 * （多选题漏 3 个和漏 1 个各得几分？两次作答会不会就出等级？跨课次会不会混？），
 * 用具体例子跑一遍最直观。**它只打印现状，不做断言** —— 断言在 tests/logic.test.js。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

const map = new Map();
globalThis.localStorage = {
  getItem: (k) => (map.has(k) ? map.get(k) : null),
  setItem: (k, v) => map.set(k, String(v)),
  removeItem: (k) => map.delete(k),
  clear: () => map.clear(),
  get length() { return map.size; }
};
for (const f of ['store.js', 'analysis.js', 'grade.js', 'sync.js', 'classroom.js', 'net.js', 'rollcall.js', 'bank.js', 'quiz.js', 'analysis-ui.js']) {
  try { require(path.join(ROOT, 'assets', 'js', f)); } catch { /* 依赖浏览器的模块跳过 */ }
}
const CI = globalThis.CI;
const S = CI.store;
const A = CI.analysis;
const G = CI.grade;
const sid = (x) => (typeof x === 'string' ? x : x.id);

/* ================= 1. 选择题：部分得分规则的边界 ================= */
console.log('=== 1. 选择题部分得分（正确答案 ABCD，满分 10）===');
S.replaceState(S.defaultState());
const q = { id: 'q1', tier: 'basic', points: 10, stem: '多选题', answer: 'ABCD', options: ['甲', '乙', '丙', '丁'] };
for (const [label, choice] of [
  ['ABCD 全对', ['A', 'B', 'C', 'D']],
  ['ABC 漏 1 个', ['A', 'B', 'C']],
  ['AB 漏 2 个', ['A', 'B']],
  ['A 漏 3 个（只对 1/4）', ['A']],
  ['ABCDE 多选 1 个', ['A', 'B', 'C', 'D', 'E']],
  ['ABE 对 2 错 1', ['A', 'B', 'E']],
  ['E 全错', ['E']]
]) {
  const r = G.auto(q, { choice });
  const pts = S.computePoints({ result: r.result, base: 10 });
  console.log('  ' + label.padEnd(24) + ' → ' + String(r.result).padEnd(8) + ' 得分 ' + pts);
}

/* ================= 2. 填空题：有没有半对 ================= */
console.log('\n=== 2. 填空题（参考答案 x=1|x=2 视为等价写法）===');
const fq = { id: 'q2', tier: 'basic', points: 10, stem: '填空', answer: 'x=1|x=2', options: [] };
for (const [label, text] of [['x=1', 'x=1'], ['x=2', 'x=2'], ['x=3', 'x=3'], ['空着', '']]) {
  const r = G.auto(fq, { text });
  console.log('  ' + label.padEnd(24) + ' → ' + String(r.result).padEnd(8) + '（填空只有 correct / wrong / skip）');
}

/* ================= 3. 能力评价：不同表现对应什么等级与评语 ================= */
console.log('\n=== 3. 能力评价（等级 + 评语是怎么来的）===');
function evalOne(name, records) {
  S.replaceState(S.defaultState());
  const stu = S.addStudent(name, S.get().teams[0].id);
  for (const [tier, result] of records) S.recordResult({ sid: sid(stu), tier, result, source: 'quiz' });
  const ab = A.ability(S.get(), {});
  const st = A.studentStats(S.get(), sid(stu));
  console.log('  ' + name.padEnd(10) + ' 能力等级 ' + String(ab.grade.label).padEnd(8) +
    ' 综合 ' + String(ab.overall).padEnd(4) + ' 掌握度 ' + String(ab.mastery).padEnd(4) +
    ' 覆盖 ' + String(ab.coverage).padEnd(4) + ' ｜ 明细评定 ' + st.level.label);
  console.log('     评语：' + ab.comment);
}
evalOne('全对型', [['basic', 'correct'], ['basic', 'correct'], ['advanced', 'correct'], ['advanced', 'correct'], ['extended', 'correct'], ['extended', 'correct'], ['improve', 'correct'], ['improve', 'correct']]);
evalOne('只做基础', [['basic', 'correct'], ['basic', 'correct'], ['basic', 'correct']]);
evalOne('偏科型', [['basic', 'correct'], ['basic', 'correct'], ['advanced', 'correct'], ['advanced', 'correct'], ['extended', 'wrong'], ['extended', 'wrong'], ['improve', 'wrong'], ['improve', 'wrong']]);
evalOne('只答两次', [['basic', 'correct'], ['basic', 'wrong']]);
evalOne('全错型', [['basic', 'wrong'], ['basic', 'wrong'], ['advanced', 'wrong'], ['advanced', 'wrong']]);

/* ================= 4. 边界：停用学生 / 课次边界 / 阈值是否跟随设置 ================= */
console.log('\n=== 4. 三个边界（现状）===');

// 4.1 停用学生
S.replaceState(S.defaultState());
const t1 = S.get().teams[0].id;
const stay = S.addStudent('在读甲', t1);
const gone = S.addStudent('已转走乙', t1);
S.recordResult({ sid: sid(stay), tier: 'basic', result: 'correct' });
S.recordResult({ sid: sid(gone), tier: 'basic', result: 'wrong' });
S.updateStudent(sid(gone), { active: false });
const cs = A.classStats(S.get(), null);
console.log('  4.1 停用学生：班级作答 ' + cs.total.attempts + ' 次 / 掌握度 ' + cs.total.creditRate + '% / 参与 ' +
  cs.participants + ' 人（activeCount ' + cs.activeCount + '）；报告学生表含：' +
  A.classReport(S.get(), {}).data.students.map((x) => x.name).join('、'));
console.log('      点名候选人：' + (CI.rollcall.candidates(S.get(), {}) || []).map((x) => x.name || x).join('、') + '（点名已排除停用）');

// 4.2 课次边界
S.replaceState(S.defaultState());
const d = S.addStudent('甲', S.get().teams[0].id);
const qa = S.addQuestion({ stem: '第一节课的题', tier: 'basic', answer: 'A' });
const qb = S.addQuestion({ stem: '第二节课的题', tier: 'advanced', answer: 'B' });
const quiz1 = S.createQuiz('第一节课', [qa.id]);
S.recordResult({ sid: sid(d), qid: qa.id, tier: 'basic', result: 'correct', quizId: quiz1.id });
const quiz2 = S.createQuiz('第二节课', [qb.id]);
S.recordResult({ sid: sid(d), qid: qb.id, tier: 'advanced', result: 'wrong', quizId: quiz2.id });
S.setCurrentQuiz(quiz2.id);
console.log('  4.2 课次边界（第一节课全对 + 第二节课全错，当前试卷=第二节课）：');
console.log('      报告整体：作答 ' + A.classReport(S.get(), {}).data.attempts + ' 次 / 掌握度 ' +
  A.classReport(S.get(), {}).data.creditRate + '%');
console.log('      题目正确率（全部）：' + A.questionStats(S.get(), null).map((x) => x.stem + ' ' + x.correctRate + '%').join('、'));
console.log('      题目正确率（仅当前试卷）：' + A.questionStats(S.get(), quiz2.id).map((x) => x.stem + ' ' + x.correctRate + '%').join('、'));

// 4.3 报告阈值是否跟随 weakThreshold
S.replaceState(S.defaultState());
S.updateSettings({ weakThreshold: 0.9 });
const e = S.addStudent('掌握度 80%', S.get().teams[0].id);
for (const r of ['correct', 'correct', 'correct', 'correct', 'wrong']) S.recordResult({ sid: sid(e), tier: 'basic', result: r });
const rep = A.classReport(S.get(), {});
console.log('  4.3 薄弱阈值设为 90%，该生掌握度 ' + rep.data.students[0].creditRate + '%：');
console.log('      ' + (rep.markdown.split('\n').filter((l) => l.indexOf('需要关注') >= 0)[0] || '（无）'));
