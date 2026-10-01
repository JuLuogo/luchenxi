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


/* ---------- 用例集：随机点名（rollcall.js）---------- *
 * 随机性靠"把 Math.random 钉成固定序列"来复现：两边都只消费一次随机数，
 * 下标算法也一致（floor(r × len)），所以抽选结果必须逐字段相同。 */
const rollcall = [];

function withRandom(vals, fn) {
  const old = Math.random;
  let i = 0;
  Math.random = () => vals[Math.min(i++, vals.length - 1)];
  try { return fn(); } finally { Math.random = old; }
}

function rollCase(name, setup, draws) {
  globalThis.localStorage.clear();
  S.replaceState(S.defaultState());
  const team = S.get().teams[0].id;
  const made = setup.students.map((n) => {
    const st = S.addStudent(n, team);
    return typeof st === 'string' ? st : st.id;
  });
  S.setRollSettings({
    mode: setup.mode, scope: 'all',
    excludeAnswered: !!setup.excludeAnswered,
    recentExclude: setup.recentExclude || 0
  });

  let answered = [];
  if (setup.answered && setup.answered.length) {
    const q = S.addQuestion({ stem: '点名用题', tier: 'basic' });
    const quiz = S.createQuiz('点名用卷', [q.id], '');
    S.setRuntime({ quizId: quiz.id, qid: q.id });
    setup.answered.forEach((i) => S.recordResult({ sid: made[i], qid: q.id, quizId: quiz.id, result: 'correct' }));
    answered = setup.answered.map((i) => made[i]);
  } else {
    S.setRuntime({ quizId: null, qid: null });
  }

  // id 归一化：uid() 基于时间戳，不归一化的话每次生成的基准都不同（--check 永远红）
  const idMap = new Map(made.map((id, i) => [id, 's' + (i + 1)]));
  const N = (id) => (idMap.has(id) ? idMap.get(id) : id);
  const normalizeRollIds = (rec) => {
    rec.steps.forEach((step) => {
      step.students.forEach((s) => { s.id = N(s.id); });
      step.answered = step.answered.map(N);
      step.settings_before.history = step.settings_before.history.map((h) => ({ sid: N(h.sid), at: 0 }));
      step.settings_before.round_pool = step.settings_before.round_pool.map(N);
      step.expect.sid = N(step.expect.sid);
      if (step.expect.pool) step.expect.pool = step.expect.pool.map(N);
      step.settings_after.round_pool = step.settings_after.round_pool.map(N);
      step.settings_after.history = step.settings_after.history.map(N);
    });
    return rec;
  };

  const rec = {
    name, mode: setup.mode,
    hasCurrentQuestion: !!(setup.answered && setup.answered.length),
    steps: []
  };

  draws.forEach((draw) => {
    const st = S.get();
    const students = st.students.map((s) => ({
      id: s.id, name: s.name, active: s.active !== false, called: S.calledCount(st, s.id)
    }));
    const settingsBefore = {
      mode: st.rollcall.mode,
      scope: 'all',
      exclude_answered: !!st.rollcall.excludeAnswered,
      recent_exclude: Number(st.rollcall.recentExclude) || 0,
      round: Number(st.rollcall.round) || 1,
      round_pool: (st.rollcall.roundPool || []).slice(),
      history: (st.rollcall.history || []).map((h) => ({ sid: h.sid, at: 0 }))
    };
    const pick = withRandom([draw], () => CI.rollcall.pick(S.get(), {
      scope: 'all', recentExclude: settingsBefore.recent_exclude, excludeAnswered: settingsBefore.exclude_answered
    }));
    withRandom([draw], () => CI.rollcall.applyPick(pick));
    const after = S.get();
    rec.steps.push({
      students,
      answered,
      settings_before: settingsBefore,
      draw,
      expect: {
        sid: pick.sid, name: pick.name, mode: pick.mode, note: pick.note,
        candidateCount: pick.candidateCount, newRound: !!pick.newRound,
        pool: pick.pool || null,
        round: pick.round === undefined || pick.round === null ? null : pick.round
      },
      settings_after: {
        round: Number(after.rollcall.round) || 1,
        round_pool: (after.rollcall.roundPool || []).slice(),
        history: (after.rollcall.history || []).map((h) => h.sid)
      }
    });
  });

  rollcall.push(normalizeRollIds(rec));
}

const R5 = ['甲', '乙', '丙', '丁', '戊'];
rollCase('均匀模式：5 人连点 6 次（一轮覆盖后开新一轮）', { students: R5, mode: 'even' },
  [0.0, 0.5, 0.25, 0.75, 0.99, 0.4]);
rollCase('最少被点优先：点 3 次', { students: R5, mode: 'least' }, [0.9, 0.9, 0.0]);
rollCase('纯随机：点 2 次', { students: R5, mode: 'random' }, [0.3, 0.6]);
rollCase('排除已答当前题（只剩 4 人）', { students: R5, mode: 'even', excludeAnswered: true, answered: [0] },
  [0.1, 0.2]);
rollCase('防连点：最近 1 次不重复', { students: R5, mode: 'even', recentExclude: 1 }, [0.7, 0.7, 0.7]);


/* ---------- 用例集：加权计分引擎（store.js）---------- *
 * 逐步复现 JS 的 recordResult 序列：记录每一步的输入与"算出来的基准/比例/得分"，
 * 以及累计分数。Rust 侧用同样的输入算一遍，逐字段比对（含两位小数舍入）。 */
const scoring = [];

function scoringCase(name, steps, settingsPatch) {
  globalThis.localStorage.clear();
  S.replaceState(S.defaultState());
  const team = S.get().teams[0].id;
  const added = S.addStudent('甲', team);
  const sid = typeof added === 'string' ? added : added.id;
  const qBasic = S.addQuestion({ stem: '基础题：1+1=?', tier: 'basic', answer: '2' });
  const qAdv = S.addQuestion({ stem: '拔高题：求导', tier: 'advanced', answer: '2x' });
  const qCustom = S.addQuestion({ stem: '扩展题：自定义分值', tier: 'extended', points: 20, answer: '-' });

  // 题目 id 也会每次不同：这里只保留题型与自定义分值（Rust 侧根本不需要 id）
  const rec = {
    name,
    questions: [qBasic, qAdv, qCustom].map((q) => ({ tier: q.tier, points: q.points === undefined || q.points === null ? null : Number(q.points) })),
    steps: []
  };

  steps.forEach((step) => {
    if (step.settings) S.updateSettings(step.settings);
    // 只改设置的步骤（没有 result）不产生流水，仅影响后续步骤
    if (!step.result) return;
    const q = step.q === 'basic' ? qBasic : (step.q === 'adv' ? qAdv : (step.q === 'custom' ? qCustom : null));
    const before = (S.get().settings) || {};
    const r = S.recordResult({
      sid,
      qid: q ? q.id : null,
      tier: step.tier || undefined,
      result: step.result,
      fast: !!step.fast,
      source: step.source || 'quiz'
    });
    rec.steps.push({
      settings: {
        half_ratio: Number(before.halfRatio === undefined ? 0.5 : before.halfRatio),
        fast_bonus: Number(before.fastBonus || 0),
        wrong_penalty: Number(before.wrongPenalty || 0)
      },
      hasQuestion: !!q,
      questionTier: q ? q.tier : null,
      customPoints: q ? (q.points === undefined || q.points === null ? null : Number(q.points)) : null,
      tier: step.tier || null,
      result: step.result,
      fast: !!step.fast,
      source: step.source || 'quiz',
      expect: {
        base: Number(r.base),
        ratio: Number(r.ratio),
        points: Number(r.points),
        result: r.result,
        tier: r.tier,
        scoreAfter: Number(S.scoreOf(S.get(), sid))
      }
    });
  });

  scoring.push(rec);
}

// 与 tests/logic.test.js 第 3 组同样的一条流水线
scoringCase('基础分与累计（答对/半对/答错/快捷）', [
  { q: 'basic', result: 'correct' },
  { q: 'adv', result: 'correct' },
  { q: 'adv', result: 'half' },
  { q: 'adv', result: 'wrong' },
  { tier: 'improve', result: 'correct', source: 'quick' }
]);
scoringCase('扣分与抢答奖励（wrongPenalty=2 / fastBonus=1 / halfRatio=0.4）', [
  { q: 'basic', result: 'correct' },
  { q: 'adv', result: 'correct' },
  { q: 'adv', result: 'half' },
  { q: 'adv', result: 'wrong' },
  { tier: 'improve', result: 'correct', source: 'quick' },
  { settings: { wrongPenalty: 2, fastBonus: 1, halfRatio: 0.4 } },
  { q: 'basic', result: 'wrong' },
  { q: 'basic', result: 'correct', fast: true },
  { q: 'basic', result: 'half' }
]);
scoringCase('自定义分值 + 未知结果归一化', [
  { q: 'custom', result: 'correct' },
  { q: 'custom', result: 'half' },
  { q: 'custom', result: '不存在的类型' },
  { q: 'basic', result: 'skip' }
]);

/* ---------- 落盘 / 校验 ---------- */
const payload = {
  _comment: '由 scripts/gen-parity-fixtures.mjs 生成；Rust 侧 crates/ci-domain/tests/parity.rs 逐字段比对',
  generatedBy: 'JS 参考实现（assets/js/analysis.js + assets/js/grade.js）',
  ability: cases,
  grading,
  rollcall,
  scoring
};
const text = JSON.stringify(payload, null, 2) + '\n';
const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';

if (CHECK) {
  if (current === text) {
    console.log('[ok] parity.json 与 JS 参考实现一致（能力 ' + cases.length + ' + 判分 ' + grading.length +
    ' + 点名 ' + rollcall.length + ' + 计分 ' + scoring.length + ' 组）');
    process.exit(0);
  }
  console.error('[stale] parity.json 与 JS 参考实现不一致 —— 运行 node scripts/gen-parity-fixtures.mjs 重新生成');
  process.exit(1);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, text, 'utf8');
console.log('[ok] 已生成 ' + path.relative(ROOT, OUT) +
  '（能力 ' + cases.length + ' + 判分 ' + grading.length + ' + 点名 ' + rollcall.length + ' + 计分 ' + scoring.length + ' 组用例）');
cases.forEach((c) => console.log('   · ' + c.name.padEnd(28) + c.expect.grade + '  overall=' + c.expect.overall));
grading.forEach((g) => console.log('   · ' + g.name.padEnd(28) + (g.expect ? g.expect.result : 'null（主观题）')));
rollcall.forEach((r) => console.log('   · ' + r.name.padEnd(34) + r.mode + '  ' + r.steps.length + ' 步'));
scoring.forEach((c) => console.log('   · ' + c.name.padEnd(34) + c.steps.length + ' 步'));
