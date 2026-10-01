/*!
 * scripts/gen-parity-fixtures.mjs — 生成"JS ↔ Rust 一致性"基准数据
 *
 *   node scripts/gen-parity-fixtures.mjs           # 重新生成 tests/fixtures/parity.json
 *   node scripts/gen-parity-fixtures.mjs --check   # 只校验当前文件是否最新（CI 用）
 *
 * 为什么需要：v5 把领域规则迁到 Rust，**最大的风险是行为漂移**。
 * 做法是"两边并行 + 同一批输入逐字段比对"：这里用 JS 参考实现算出结果落成基准，
 * Rust 侧（crates/ci-domain/tests/parity.rs）用同样的输入跑自己的实现并逐字段断言相等。
 * 迁移完成后删掉 JS 实现时，这份基准就是回归依据。
 *
 * 当前覆盖：能力评价（analysis.js 的 abilityOfTiers / ABILITY_GRADES / abilityComment）。
 * 每迁完一个模块，就在下面加一个用例集。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const CHECK = process.argv.includes('--check');
const OUT = path.join(ROOT, 'tests', 'fixtures', 'parity.json');

/* ---------- 载入 JS 参考实现（浏览器脚本挂到 globalThis.CI） ---------- */
function fakeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
    get length() { return map.size; }
  };
}

function loadCI() {
  globalThis.localStorage = fakeStorage();
  for (const f of ['store.js', 'analysis.js', 'grade.js', 'rollcall.js', 'classroom.js', 'bank.js']) {
    require(path.join(ROOT, 'assets', 'js', f));
  }
  return globalThis.CI;
}

const CI = loadCI();
const S = CI.store;

/* ---------- 造状态：直接喂 recordResult，走真实计分口径 ---------- */
function stateWith(students) {
  globalThis.localStorage.clear();
  S.replaceState(S.defaultState());
  const teams = S.get().teams;
  const out = [];
  students.forEach((spec) => {
    // addStudent 返回的是学生对象（不是 id 字符串）—— 兼容两种形态，免得踩坑
    const added = S.addStudent(spec.name, teams[spec.team || 0].id);
    const sid = typeof added === 'string' ? added : added.id;
    (spec.records || []).forEach((r) => S.recordResult({ sid, tier: r[0], result: r[1] }));
    out.push({ sid, name: spec.name });
  });
  return out;
}

/** 把 JS 的评价结果压成"可逐字段比对"的形态 */
function snap(a) {
  if (!a) return null;
  return {
    overall: a.overall,
    mastery: a.mastery,
    balance: a.balance === null || a.balance === undefined ? null : a.balance,
    coverage: a.coverage,
    attempts: a.attempts,
    filled: a.filled,
    maxRate: a.maxRate,
    minRate: a.minRate,
    grade: a.grade.key,
    gradeShort: a.grade.short,
    gradeLabel: a.grade.label,
    comment: a.comment,
    weakest: a.weakest ? { key: a.weakest.key, rate: a.weakest.rate } : null,
    strongest: a.strongest ? { key: a.strongest.key, rate: a.strongest.rate } : null,
    axes: a.axes.map((x) => ({
      key: x.key, label: x.label, weight: x.weight, attempts: x.attempts, correct: x.correct,
      rate: x.rate, correctRate: x.correctRate
    }))
  };
}

const ALL = ['basic', 'advanced', 'extended', 'improve'];

/* ---------- 用例集 ---------- */
const cases = [];

function abilityCase(name, students, who) {
  const made = stateWith(students);
  const target = who === undefined ? 0 : who;
  const st = S.get();
  const a = CI.analysis.ability(st, { sid: made[target].sid });
  // 同时记下"喂给 Rust 的输入"：题型统计 + 合计作答 + minSample
  const stu = CI.analysis.studentStats(st, made[target].sid);
  cases.push({
    name,
    minSample: Number((st.settings || {}).minSample) || 2,
    totalAttempts: stu.total.attempts,
    tiers: stu.tiers.map((t) => ({
      key: t.key, label: t.label, color: t.color, weight: t.weight,
      attempts: t.attempts, correct: t.correct,
      credit_rate: t.creditRate, correct_rate: t.correctRate
    })),
    expect: snap(a)
  });
}

abilityCase('全才：四题型各答对两次', [
  { name: '全才', records: ALL.flatMap((k) => [[k, 'correct'], [k, 'correct']]) }
]);
abilityCase('偏科：基础拔高全对，扩展提升全错', [
  { name: '偏科', records: [['basic', 'correct'], ['basic', 'correct'], ['advanced', 'correct'], ['advanced', 'correct'],
    ['extended', 'wrong'], ['extended', 'wrong'], ['improve', 'wrong'], ['improve', 'wrong']] }
]);
abilityCase('半对：基础题两次半对', [
  { name: '半对', records: [['basic', 'half'], ['basic', 'half']] }
]);
abilityCase('新手：只答对一道基础题', [
  { name: '新手', records: [['basic', 'correct']] }
]);
abilityCase('混合：基础全对 + 提升全错（权重差异）', [
  { name: '混合', records: [['basic', 'correct'], ['basic', 'correct'], ['improve', 'wrong'], ['improve', 'wrong']] }
]);
abilityCase('三题型满分（覆盖率 75%）', [
  { name: '三科', records: [['basic', 'correct'], ['basic', 'correct'], ['advanced', 'correct'], ['advanced', 'correct'],
    ['extended', 'correct'], ['extended', 'correct']] }
]);
abilityCase('接近但不相等（评语不能自相矛盾）', [
  { name: '接近', records: ALL.flatMap((k) => [[k, 'correct'], [k, 'wrong']]) }
]);
abilityCase('全部答错（最低档）', [
  { name: '全错', records: ALL.flatMap((k) => [[k, 'wrong'], [k, 'wrong']]) }
]);
abilityCase('跳过的题也算作答次数（skip）', [
  { name: '跳过', records: [['basic', 'skip'], ['basic', 'correct'], ['advanced', 'skip'], ['advanced', 'skip']] }
]);

// ---------- 用例集：判分（grade.js） ----------
const grading = [];
function gradeCase(name, q, submission) {
  const G = CI.grade;
  const r = G.auto(q, submission);
  grading.push({
    name,
    question: { options: q.options || [], answer: q.answer || '' },
    submission: {
      choice: Array.isArray(submission.choice) ? submission.choice : (submission.choice ? [submission.choice] : []),
      text: submission.text || '',
      skip: !!submission.skip
    },
    // auto 返回 null（主观题）时记 null，Rust 侧同样返回 None
    expect: r ? { result: r.result, expected: r.expected, got: r.got } : null,
    answerKey: G.answerKey(q),
    describe: G.describeSubmission(q, submission),
    validate: G.validateQuestion(q).warnings,
    type: G.typeOf(q),
    typeLabel: G.typeLabel(q)
  });
}

const Q_CHOICE = { stem: '选一选', options: ['甲', '乙', '丙', '丁'], answer: 'B' };
const Q_MULTI = { stem: '多选', options: ['甲', '乙', '丙', '丁'], answer: 'AC' };
const Q_FILL = { stem: '填空', options: [], answer: 'x=1|x = 1|1' };
const Q_SUBJ = { stem: '证明题', options: [], answer: '' };
const Q_BADLETTER = { stem: '越界', options: ['甲', '乙'], answer: 'D' };
const Q_NOLETTER = { stem: '写成了原文', options: ['6', '8', '9'], answer: '8' };
const Q_COMMA = { stem: '逗号多解', options: [], answer: '8,八' };

gradeCase('单选答对', Q_CHOICE, { choice: ['B'] });
gradeCase('单选答错', Q_CHOICE, { choice: ['A'] });
gradeCase('单选空提交', Q_CHOICE, { choice: [] });
gradeCase('多选全对（乱序）', Q_MULTI, { choice: ['C', 'A'] });
gradeCase('多选漏选', Q_MULTI, { choice: ['A'] });
gradeCase('多选错选', Q_MULTI, { choice: ['A', 'B'] });
gradeCase('多选跳过', Q_MULTI, { choice: ['A'], skip: true });
gradeCase('填空忽略空格大小写', Q_FILL, { text: ' X = 1 ' });
gradeCase('填空全角数字', Q_FILL, { text: '１' });
gradeCase('填空答错', Q_FILL, { text: 'x=2' });
gradeCase('填空空提交', Q_FILL, { text: '' });
gradeCase('主观题（交老师判定）', Q_SUBJ, { text: '我的证明' });
gradeCase('选择题答案字母越界', Q_BADLETTER, { choice: ['D'] });
gradeCase('选择题答案写成选项原文', Q_NOLETTER, { choice: ['B'] });
gradeCase('填空题用逗号分隔多解', Q_COMMA, { text: '八' });

/* ---------- 落盘 / 校验 ---------- */
const payload = {
  _comment: '由 scripts/gen-parity-fixtures.mjs 生成；Rust 侧 crates/ci-domain/tests/parity.rs 逐字段比对',
  generatedBy: 'JS 参考实现（assets/js/analysis.js + assets/js/grade.js）',
  ability: cases,
  grading
};
const text = JSON.stringify(payload, null, 2) + '\n';
const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';

if (CHECK) {
  if (current === text) {
    console.log('[ok] parity.json 与 JS 参考实现一致（' + cases.length + ' 组用例）');
    process.exit(0);
  }
  console.error('[stale] parity.json 与 JS 参考实现不一致 —— 运行 node scripts/gen-parity-fixtures.mjs 重新生成');
  process.exit(1);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, text, 'utf8');
console.log('[ok] 已生成 ' + path.relative(ROOT, OUT) +
  '（能力 ' + cases.length + ' + 判分 ' + grading.length + ' 组用例）');
cases.forEach((c) => console.log('   · ' + c.name.padEnd(28) + c.expect.grade + '  overall=' + c.expect.overall));
grading.forEach((g) => console.log('   · ' + g.name.padEnd(28) + (g.expect ? g.expect.result : 'null（主观题）')));
