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
  // 2026-10：bank.js 已随旧界面删除；批量导入的解析器在 import.js（领域层）
  for (const f of ['store.js', 'analysis.js', 'grade.js', 'rollcall.js', 'classroom.js', 'import.js', 'openclass.js', 'polish.js']) {
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
    // ratio：部分得分系数（多答案题按命中比例算；Rust 侧必须逐字段一致）
    expect: r ? { result: r.result, ratio: Number(r.ratio || 0), expected: r.expected, got: r.got } : null,
    answerKey: G.answerKey(q),
    describe: G.describeSubmission(q, submission),
    validate: G.validateQuestion(q).warnings,
    type: G.typeOf(q),
    typeLabel: G.typeLabel(q)
  });
}

const Q_CHOICE = { stem: '选一选', options: ['甲', '乙', '丙', '丁'], answer: 'B' };
const Q_MULTI = { stem: '多选', options: ['甲', '乙', '丙', '丁'], answer: 'AC' };
const Q_MULTI4 = { stem: '四选多', options: ['甲', '乙', '丙', '丁'], answer: 'ABCD' };
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

/* ---------- 部分得分（多答案题按命中比例、扣减误选）----------
 * 规则：ratio = max(0, (命中 − 误选) / 正确选项总数)
 * 2026-10 改的：原来"是子集就给 50%、多选一律 0 分"——漏 3 个与漏 1 个同分、多选 1 个反而 0 分。 */
gradeCase('部分得分：全对', Q_MULTI4, { choice: ['A', 'B', 'C', 'D'] });
gradeCase('部分得分：漏 1 个（3/4）', Q_MULTI4, { choice: ['A', 'B', 'C'] });
gradeCase('部分得分：漏 2 个（2/4）', Q_MULTI4, { choice: ['A', 'B'] });
gradeCase('部分得分：漏 3 个（1/4）', Q_MULTI4, { choice: ['A'] });
gradeCase('部分得分：多选 1 个（4 对 1 错 → 3/4）', Q_MULTI4, { choice: ['A', 'B', 'C', 'D', 'E'] });
gradeCase('部分得分：对 2 错 1（1/4）', Q_MULTI4, { choice: ['A', 'B', 'E'] });
gradeCase('部分得分：全错', Q_MULTI4, { choice: ['E'] });
gradeCase('部分得分：空答案算跳过', Q_MULTI4, { choice: [] });


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
      rank: step.rank || undefined,
      ratio: step.ratio === undefined ? undefined : step.ratio,
      source: step.source || 'quiz'
    });
    rec.steps.push({
      // 键名与 JS 的 settings 对象一致（驼峰）——Rust 侧 ScoringSettings 也按驼峰反序列化
      settings: {
        halfRatio: Number(before.halfRatio === undefined ? 0.5 : before.halfRatio),
        fastBonus: Number(before.fastBonus || 0),
        wrongPenalty: Number(before.wrongPenalty || 0),
        buzzRankBonuses: Array.isArray(before.buzzRankBonuses) ? before.buzzRankBonuses.map(Number) : []
      },
      hasQuestion: !!q,
      questionTier: q ? q.tier : null,
      customPoints: q ? (q.points === undefined || q.points === null ? null : Number(q.points)) : null,
      tier: step.tier || null,
      result: step.result,
      fast: !!step.fast,
      rank: step.rank || null,
      ratio: step.ratio === undefined ? null : step.ratio,
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
// 部分得分：显式 ratio（多答案题算出来的），不再固定 halfRatio
scoringCase('部分得分：显式 ratio（0.75 / 0.25）', [
  { q: 'basic', result: 'half', ratio: 0.75 },
  { q: 'basic', result: 'half', ratio: 0.25 }
]);
scoringCase('自定义分值 + 未知结果归一化', [
  { q: 'custom', result: 'correct' },
  { q: 'custom', result: 'half' },
  { q: 'custom', result: '不存在的类型' },
  { q: 'basic', result: 'skip' }
]);
// 抢答名次加分（学习通"不同名次的分数"经验）：开启 [2,1] 后按名次加分，
// 名次分替代扁平 fastBonus；只有答对才有名次分
scoringCase('抢答名次加分（buzzRankBonuses=[2,1]）', [
  { settings: { buzzRankBonuses: [2, 1] } },
  { q: 'basic', result: 'correct', rank: 1 },
  { q: 'adv', result: 'correct', rank: 2 },
  { q: 'adv', result: 'wrong', rank: 1 },
  { q: 'adv', result: 'half', rank: 1 },
  { q: 'basic', result: 'correct', rank: 9 }
]);


/* ---------- 用例集：课堂协同（classroom.js）---------- *
 * 两类步骤：
 *   setPhase —— 环节切换（含自动带题、接收开关、收起答案）
 *   cmd      —— 学生命令（入座/抢答/提交），比对"结果摘要 + 实时流首条文案" */
const classroom = [];

let NORM = (x) => x;
function normOutcome(r) {
  if (!r) return null;
  if (r.kind === 'hello') return { kind: 'hello', teamId: NORM(r.teamId) };
  if (r.kind === 'buzz') return { kind: 'buzz', dup: !!r.dup };
  if (r.kind === 'answer') {
    if (r.ok === false) return { kind: 'answer', ok: false, reason: r.reason };
    return { kind: 'answer', ok: true, result: r.result, sid: NORM(r.sid), points: r.result === 'pending' ? undefined : Number(r.points || 0) };
  }
  return { kind: r.kind };
}

function classCase(name, steps) {
  globalThis.localStorage.clear();
  S.replaceState(S.defaultState());
  const teams = S.get().teams;
  const t1 = teams[0], t2 = teams[1];
  const a = S.addStudent('甲', t1.id), b = S.addStudent('乙', t1.id);
  const c = S.addStudent('丙', t2.id), d = S.addStudent('丁', t2.id);
  const sid = (x) => (typeof x === 'string' ? x : x.id);
  // 可选：造一支没有任何成员的队伍，用于验证"队伍没有成员"的失败路径
  const emptyTeam = S.addTeam ? S.addTeam('空队') : null;
  const t3id = emptyTeam ? (typeof emptyTeam === 'string' ? emptyTeam : emptyTeam.id) : null;

  const q1 = S.addQuestion({ stem: '第一题', tier: 'basic', answer: 'A', options: ['甲', '乙'] });
  const q2 = S.addQuestion({ stem: '主观题', tier: 'advanced' });
  const qz = S.createQuiz('随堂测', [q1.id, q2.id], '');
  S.setCurrentQuiz(qz.id);

  // id 归一化：uid() 每次都不同，不归一化基准就不可复现（--check 会永远红）
  const idMap = new Map();
  S.get().teams.forEach((x, i) => idMap.set(x.id, 'tm' + (i + 1)));
  S.get().students.forEach((x, i) => idMap.set(x.id, 's' + (i + 1)));
  if (t3id) idMap.set(t3id, 'tm3');
  idMap.set(q1.id, 'q1');
  idMap.set(q2.id, 'q2');
  const N = (v) => (v === null || v === undefined ? null : (idMap.get(v) || v));

  NORM = (x) => N(x);

  const rec = {
    name,
    teams: S.get().teams.map((x) => ({
      id: N(x.id), name: x.name, color: x.color, icon: x.icon,
      memberIds: (S.get().students || []).filter((s) => s.teamId === x.id).map((s) => N(s.id))
    })),
    students: S.get().students.map((s) => ({ id: N(s.id), name: s.name, teamId: N(s.teamId), active: true })),
    q1: { id: 'q1', tier: q1.tier, options: q1.options, answer: q1.answer },
    q2: { id: 'q2', tier: q2.tier, options: [], answer: '' },
    quizFirstQid: N(qz.questionIds[0]),
    bankFirstQid: N(S.get().bank[0].id),
    steps: []
  };

  steps.forEach((step) => {
    if (step.kind === 'setPhase') {
      const got = CI.classroom.setPhase(step.phase);
      const st = S.get();
      rec.steps.push({
        type: 'setPhase',
        phase: step.phase,
        expect: { phase: got, accepting: !!st.runtime.accepting, qid: st.runtime.qid ? N(st.runtime.qid) : null, reveal: !!st.runtime.reveal }
      });
      return;
    }
    // 学生命令
    const cmd = Object.assign({}, step.cmd);
    if (cmd.team === 't1') cmd.teamId = t1.id;
    if (cmd.team === 't2') cmd.teamId = t2.id;
    if (cmd.team === 't3') cmd.teamId = t3id;
    if (cmd.student === 'a') cmd.sid = sid(a);
    if (cmd.student === 'b') cmd.sid = sid(b);
    if (cmd.student === 'c') cmd.sid = sid(c);
    if (cmd.student === 'd') cmd.sid = sid(d);
    if (cmd.q === 'q1') cmd.qid = q1.id;
    if (cmd.q === 'q2') cmd.qid = q2.id;
    delete cmd.team; delete cmd.student; delete cmd.q;

    if (step.prepare === 'answerByA') {
      // 让"甲"先答一次，用于制造重复提交
      S.recordResult({ sid: sid(a), qid: q1.id, tier: q1.tier, result: 'correct', quizId: qz.id, source: 'student' });
    }
    if (step.prepare === 'setQ1') S.setRuntime({ qid: q1.id });
    if (step.prepare === 'setQ2') S.setRuntime({ qid: q2.id });

    // 记录"该生是否已答过当前题"（与 handleCmd 内部同一套判断），Rust 侧据此复现
    const st0 = S.get();
    const qForCmd = cmd.qid ? S.question(st0, cmd.qid) : null;
    const resolvedSid = CI.classroom.pickAnswerer(st0, cmd.teamId, cmd.sid);
    const answeredAlready = (qForCmd && resolvedSid)
      ? (st0.runtime.quizId
        ? S.answeredAlready(st0, st0.runtime.quizId, qForCmd.id, resolvedSid)
        : S.recordsOf(st0, { sid: resolvedSid, qid: qForCmd.id }).length > 0)
      : false;

    const feedOf = () => ((S.get().classroom && S.get().classroom.feed) || []);
    const feedBefore = feedOf().length;
    const out = CI.classroom.handleCmd(cmd);
    const feedAfter = feedOf()[0] || null;
    // 抢答这类"不写实时流"的命令不该拿上一条文案来比对
    const feed = feedOf().length > feedBefore ? feedAfter : null;
    rec.steps.push({
      type: 'cmd',
      kind: cmd.kind,
      cmd: {
        kind: cmd.kind,
        teamId: N(cmd.teamId), sid: N(cmd.sid) || null, qid: N(cmd.qid) || null,
        choice: cmd.choice || [], text: cmd.text || '', skip: !!cmd.skip
      },
      answeredAlready: !!answeredAlready,
      questionRef: cmd.qid === q1.id ? 'q1' : (cmd.qid === q2.id ? 'q2' : null),
      currentQidRef: cmd.qid === q1.id ? 'q1' : (cmd.qid === q2.id ? 'q2' : null),
      expect: { outcome: normOutcome(out), feedText: feed ? feed.text : null, feedKind: feed ? feed.kind : null }
    });
  });

  classroom.push(rec);
}

classCase('环节切换序列', [
  { kind: 'setPhase', phase: 'question' },
  { kind: 'setPhase', phase: 'review' },
  { kind: 'setPhase', phase: 'rollcall' },
  { kind: 'setPhase', phase: 'nonsense' }
]);

classCase('学生命令：入座 / 抢答去重 / 客观题自动判分 / 主观题待确认 / 重复提交', [
  { kind: 'cmd', cmd: { kind: 'hello', team: 't1' } },
  { kind: 'cmd', cmd: { kind: 'buzz', team: 't1', student: 'a', q: 'q1' } },
  { kind: 'cmd', cmd: { kind: 'buzz', team: 't1', student: 'b', q: 'q1' } },
  { kind: 'cmd', cmd: { kind: 'buzz', team: 't2', student: 'c', q: 'q1' } },
  { prepare: 'setQ1', kind: 'cmd', cmd: { kind: 'answer', team: 't1', student: 'a', q: 'q1', choice: ['A'] } },
  { prepare: 'setQ2', kind: 'cmd', cmd: { kind: 'answer', team: 't1', student: 'b', q: 'q2', text: '我的证明' } },
  { prepare: 'answerByA', kind: 'cmd', cmd: { kind: 'answer', team: 't1', student: 'a', q: 'q1', choice: ['A'] } }
]);

classCase('学生命令：没有成员的队伍（应写失败提示）', [
  // 注意：不给 student —— pickAnswerer 会优先"命令指定的人"，给了 sid 就走不到空队路径
  { kind: 'cmd', cmd: { kind: 'answer', team: 't3', q: 'q1', choice: ['A'] } }
]);


/* ---------- 用例集：随机抽题（store.js::drawQuestions）---------- *
 * 与 rollcall 同一套路：把随机源换成**固定序列**，记录每一步抽到的题 id，
 * Rust 侧用同一序列重放，必须抽出同一批题（洗牌消耗次数也要一致）。 */
const drawCases = [];

/** 造一批题目（id 稳定，便于比对） */
function drawBank() {
  globalThis.localStorage.clear();
  S.replaceState(S.defaultState());
  const specs = [
    { stem: '基础题一', tier: 'basic', tags: ['集合与逻辑'] },
    { stem: '基础题二', tier: 'basic', tags: ['函数与导数'] },
    { stem: '基础题三', tier: 'basic', tags: ['概率统计'] },
    { stem: '拔高题一', tier: 'advanced', tags: ['函数与导数'] },
    { stem: '拔高题二', tier: 'advanced', tags: ['概率统计'] },
    { stem: '归档题', tier: 'basic', tags: ['集合与逻辑'], archived: true }
  ];
  return specs.map((sp) => {
    const q = S.addQuestion({ stem: sp.stem, tier: sp.tier, tags: sp.tags, answer: 'A' });
    if (sp.archived) S.updateQuestion(q.id, { archived: true });
    return q;
  });
}

function drawCase(name, opts) {
  const qs = drawBank();
  // id 归一化：q1..q6（uid 每次都不同）
  const idMap = new Map();
  const rawById = new Map();
  qs.forEach((q, i) => {
    idMap.set(q.id, 'q' + (i + 1));
    rawById.set('q' + (i + 1), q.id);
  });
  const N = (x) => (x === null || x === undefined ? null : (idMap.get(x) || x));
  /** 归一化名 → 原始 id（调 JS 时必须用原始 id，它比对的是 uid） */
  const R = (n) => rawById.get(n) || n;
  // 固定随机序列（与 Rust 侧 replay 用的完全一致）
  const seq = [0.1, 0.7, 0.3, 0.9, 0.2, 0.5, 0.4, 0.8, 0.6, 0.15, 0.35, 0.85];
  const state = { i: 0 };
  const rand = () => seq[state.i++ % seq.length];

  const optsNorm = {
    count: Number(opts.count || 0),
    tiers: opts.tiers || [],
    tags: opts.tags || [],
    excludeIds: (opts.excludeIds || []).map(N),
    includeArchived: !!opts.includeArchived
  };
  // 注意：调 JS 时 excludeIds 必须是**原始 id**（它比对的是题库里的 uid），
  // 记录到基准里才用归一化名 —— 否则"排除"会静默失效（这正是本轮抓到的问题）
  const optsForJs = Object.assign({}, optsNorm, {
    excludeIds: (opts.excludeIds || []).map(R)
  });
  const got = S.drawQuestions(S.get(), optsForJs, rand).map(N);

  drawCases.push({
    name,
    // 题库形状（Rust 侧据此建 BankQuestion）
    bank: qs.map((q, i) => ({ id: 'q' + (i + 1), tier: q.tier, tags: q.tags || [], archived: !!q.archived })),
    opts: optsNorm,
    seq,
    expect: { ids: got, drawsUsed: state.i }
  });
}

drawCase('不限条件抽 3 道（归档题不参与）', { count: 3 });
drawCase('限定基础题抽 2 道', { count: 2, tiers: ['basic'] });
drawCase('限定标签抽 2 道', { count: 2, tags: ['概率统计'] });
drawCase('题型 + 标签同时限定', { count: 3, tiers: ['advanced'], tags: ['函数与导数'] });
drawCase('排除已在试卷里的题', { count: 3, excludeIds: ['q1', 'q4'] });
drawCase('要的比候选多（全给）', { count: 99 });
drawCase('显式包含归档题', { count: 99, includeArchived: true });
drawCase('条件不匹配（空结果）', { count: 3, tiers: ['不存在'] });

/* ---------- 用例集：按题目的作答统计（analysis.js::questionStats）---------- *
 * 纯数据进、纯数据出：题库 + 学生 + 流水 → 每题的作答/正确率/掌握度/平均分/答错人名 */
const questionStats = [];

function qsCase(name, halfRatio) {
  globalThis.localStorage.clear();
  S.replaceState(S.defaultState());
  const teams = S.get().teams;
  const a = S.addStudent('甲', teams[0].id);
  const b = S.addStudent('乙', teams[0].id);
  const c = S.addStudent('丙', teams[1].id);
  const sid = (x) => (typeof x === 'string' ? x : x.id);
  if (halfRatio !== undefined) S.updateSettings({ halfRatio });

  const q1 = S.addQuestion({ stem: '第一题：1+1=?', tier: 'basic', answer: 'A' });
  const q2 = S.addQuestion({ stem: '第二题：全班都不会', tier: 'advanced', answer: 'B' });
  const q3 = S.addQuestion({ stem: '第三题：只有一人半对', tier: 'extended', answer: 'C' });
  const qz = S.createQuiz('随堂测', [q1.id, q2.id, q3.id]);

  // q1：2 对 1 错；q2：2 错 1 跳过；q3：1 半对；另有一条快捷记分（无题目归属）
  S.recordResult({ sid: sid(a), qid: q1.id, tier: 'basic', result: 'correct', quizId: qz.id, source: 'student' });
  S.recordResult({ sid: sid(b), qid: q1.id, tier: 'basic', result: 'correct', quizId: qz.id, source: 'student' });
  S.recordResult({ sid: sid(c), qid: q1.id, tier: 'basic', result: 'wrong', quizId: qz.id, source: 'student' });
  S.recordResult({ sid: sid(a), qid: q2.id, tier: 'advanced', result: 'wrong', quizId: qz.id, source: 'student' });
  S.recordResult({ sid: sid(b), qid: q2.id, tier: 'advanced', result: 'wrong', quizId: qz.id, source: 'student' });
  S.recordResult({ sid: sid(c), qid: q2.id, tier: 'advanced', result: 'skip', quizId: qz.id, source: 'student' });
  S.recordResult({ sid: sid(a), qid: q3.id, tier: 'extended', result: 'half', quizId: qz.id, source: 'student' });
  S.recordResult({ sid: sid(a), tier: 'improve', result: 'correct', source: 'quick' });

  const got = CI.analysis.questionStats(S.get(), null);
  questionStats.push({
    name,
    halfRatio: Number(S.get().settings.halfRatio),
    tiers: S.get().tiers.map((x) => ({ key: x.key, label: x.label })),
    students: S.get().students.map((s, i) => ({ id: 's' + (i + 1), name: s.name })),
    bank: [q1, q2, q3].map((q, i) => ({ id: 'q' + (i + 1), tier: q.tier, stem: q.stem })),
    records: S.get().quizzes
      .reduce((acc, qz2) => acc.concat(qz2.records || []), [])
      .map((r, i) => ({
        id: 'r' + (i + 1),
        sid: (() => {
          const idx = S.get().students.findIndex((s) => s.id === r.sid);
          return idx >= 0 ? 's' + (idx + 1) : null;
        })(),
        qid: r.qid ? 'q' + ([q1, q2, q3].findIndex((q) => q.id === r.qid) + 1) : null,
        tier: r.tier || '',
        result: r.result,
        points: Number(r.points)
      })),
    expect: got.map((x) => ({
      // qid 也要归一化：uid 每次都不同，不归一化基准就不可复现
      qid: 'q' + ([q1, q2, q3].findIndex((q) => q.id === x.qid) + 1),
      stem: x.stem,
      tier: x.tier,
      tierLabel: x.tierLabel,
      attempts: x.attempts,
      correct: x.correct,
      half: x.half,
      wrong: x.wrong,
      skip: x.skip,
      correctRate: x.correctRate,
      creditRate: x.creditRate,
      avgPoints: x.avgPoints,
      missers: x.missers
    }))
  });
}

qsCase('默认 halfRatio（0.5）');
qsCase('halfRatio 改为 0.4（掌握度跟着变）', 0.4);



/* ---------- 用例集：错题本（analysis.js::studentMistakes）---------- */
const mistakeCases = [];

function mkMistakeCase(name, halfRatio) {
  globalThis.localStorage.clear();
  S.replaceState(S.defaultState());
  const teams = S.get().teams;
  const a = S.addStudent('甲', teams[0].id);
  const b = S.addStudent('乙', teams[0].id);
  const c = S.addStudent('丙', teams[1].id);
  const sid = (x) => (typeof x === 'string' ? x : x.id);
  if (halfRatio !== undefined) S.updateSettings({ halfRatio });

  const q1 = S.addQuestion({ stem: '第一题：1+1=?', tier: 'basic', options: ['甲', '乙'], answer: 'A' });
  const q2 = S.addQuestion({ stem: '第二题：求导', tier: 'advanced', answer: '2x' });
  const qz = S.createQuiz('随堂测', [q1.id, q2.id]);

  // 甲：q1 错两次（最后一次 B）、q2 跳过；乙：q1 错一次；丙：q1 对、q2 半对
  S.recordResult({ sid: sid(a), qid: q1.id, tier: 'basic', result: 'wrong', quizId: qz.id, note: 'A. 甲' });
  S.recordResult({ sid: sid(a), qid: q1.id, tier: 'basic', result: 'wrong', quizId: qz.id, note: 'B. 乙' });
  S.recordResult({ sid: sid(a), qid: q2.id, tier: 'advanced', result: 'skip', quizId: qz.id, note: '跳过' });
  S.recordResult({ sid: sid(b), qid: q1.id, tier: 'basic', result: 'wrong', quizId: qz.id, note: 'B. 乙' });
  S.recordResult({ sid: sid(c), qid: q1.id, tier: 'basic', result: 'correct', quizId: qz.id, note: 'A. 甲' });
  S.recordResult({ sid: sid(c), qid: q2.id, tier: 'advanced', result: 'half', quizId: qz.id, note: 'x' });

  // 时间戳归一化：同一毫秒内的多条流水 at 相同，会让"最后一次"与映射都失真 ——
  // 直接改状态里的 at 为序号（输入与输出就都用这套稳定值了）
  CI.store.tx('normalize-at', function (s) {
    let k = 0;
    (s.quizzes || []).forEach((qz2) => (qz2.records || []).forEach((r) => { k += 1; r.at = k; }));
  }, {});

  const students = S.get().students;
  const idx = (idv) => students.findIndex((x) => x.id === idv);
  const qIdx = (idv) => [q1, q2].findIndex((x) => x.id === idv);

  // 只取"甲"的错题本（单人也测，全班榜也测）
  const one = CI.analysis.studentMistakes(S.get(), sid(a));
  const board = CI.analysis.mistakeBoard(S.get());
  const norm = (m) => ({
    sid: 's' + (idx(m.sid) + 1),
    name: m.name,
    teamName: m.teamName,
    tiers: m.tiers,
    items: m.items.map((it) => ({
      qid: 'q' + (qIdx(it.qid) + 1),
      stem: it.stem,
      tier: it.tier,
      tierLabel: it.tierLabel,
      result: it.result,
      answer: it.answer,
      expected: it.expected,
      at: it.at,
      count: it.count
    }))
  });

  mistakeCases.push({
    name,
    halfRatio: Number(S.get().settings.halfRatio),
    tiers: S.get().tiers.map((x) => ({ key: x.key, label: x.label })),
    students: students.map((s, i) => ({ id: 's' + (i + 1), name: s.name, teamId: 'tm' + (teams.findIndex((x) => x.id === s.teamId) + 1) })),
    teams: teams.map((x, i) => ({ id: 'tm' + (i + 1), name: x.name })),
    bank: [q1, q2].map((q, i) => ({ id: 'q' + (i + 1), tier: q.tier, stem: q.stem, answer: q.answer, options: q.options || [] })),
    records: S.get().quizzes
      .reduce((acc, q2x) => acc.concat(q2x.records || []), [])
      .map((r, i) => ({
        id: 'r' + (i + 1),
        sid: idx(r.sid) >= 0 ? 's' + (idx(r.sid) + 1) : null,
        qid: r.qid ? 'q' + (qIdx(r.qid) + 1) : null,
        tier: r.tier || '',
        result: r.result,
        points: Number(r.points),
        note: r.note || '',
        // 已在状态里归一化成序号（保持先后顺序，且互不相同）
        at: Number(r.at)
      })),
    who: 's1',
    expectOne: norm(one),
    expectBoard: board.map(norm)
  });
}

mkMistakeCase('错题本：甲（错两次 + 跳过）');
mkMistakeCase('错题本：halfRatio 0.4 时同样成立', 0.4);

/* ---------- 用例集：课后课堂报告（buildReport + toMarkdown）---------- *
 * 纯数据进 → Markdown 出，逐行比对（排版漂移也逃不掉） */
const reportCases = [];

function mkReportCase(name, opts) {
  opts = opts || {};
  globalThis.localStorage.clear();
  S.replaceState(S.defaultState());
  const teams = S.get().teams;
  const a = S.addStudent('甲', teams[0].id);
  const b = S.addStudent('乙', teams[0].id);
  const c = S.addStudent('丙', teams[1].id);
  const sid = (x) => (typeof x === 'string' ? x : x.id);
  S.updateSettings({ courseName: opts.courseName === undefined ? '24机械高考公开课' : opts.courseName });

  const q1 = S.addQuestion({ stem: '第一题：1+1=?', tier: 'basic', answer: 'A' });
  const q2 = S.addQuestion({ stem: '第二题：求导', tier: 'advanced', answer: '2x' });
  const qz = S.createQuiz('随堂测', [q1.id, q2.id]);
  S.recordResult({ sid: sid(a), qid: q1.id, tier: 'basic', result: 'correct', quizId: qz.id });
  S.recordResult({ sid: sid(a), qid: q2.id, tier: 'advanced', result: 'correct', quizId: qz.id });
  S.recordResult({ sid: sid(b), qid: q1.id, tier: 'basic', result: 'half', quizId: qz.id });
  S.recordResult({ sid: sid(c), qid: q2.id, tier: 'advanced', result: 'wrong', quizId: qz.id });

  const students = S.get().students;
  const idx = (idv) => students.findIndex((x) => x.id === idv);
  const qIdx = (idv) => [q1, q2].findIndex((x) => x.id === idv);
  const records = S.get().quizzes.reduce((acc, x) => acc.concat(x.records || []), []).map((r, i) => ({
    id: 'r' + (i + 1),
    sid: idx(r.sid) >= 0 ? 's' + (idx(r.sid) + 1) : null,
    qid: r.qid ? 'q' + (qIdx(r.qid) + 1) : null,
    tier: r.tier || '',
    result: r.result,
    points: Number(r.points)
  }));

  // 用 JS 的纯函数算（Rust 侧用同样入参重放）
  const cs = CI.analysis.classStats(S.get(), null);
  const questions = CI.analysis.questionStats(S.get(), null);
  const input = {
    courseName: opts.courseName === undefined ? '24机械高考公开课' : opts.courseName,
    room: 'default',
    generatedAt: 1700000000000,
    checkin: { seated: opts.seated === undefined ? 2 : opts.seated, total: 2, rate: opts.rate === undefined ? 100 : opts.rate },
    records: records.map((r) => ({ sid: r.sid, qid: r.qid, result: r.result, points: r.points })),
    students: students.map((s, i) => ({ id: 's' + (i + 1), name: s.name, teamId: 'tm' + (teams.findIndex((x) => x.id === s.teamId) + 1) })),
    teams: teams.map((x, i) => ({ id: 'tm' + (i + 1), name: x.name })),
    tiers: cs.tiers.map((x) => ({ key: x.key, label: x.label, attempts: x.attempts, correct: x.correct, creditRate: x.creditRate, correctRate: x.correctRate })),
    teamStats: (CI.classroom.teamStats(S.get()) || []).map((x) => ({
      // teamId 归一化（all 保持原样），否则基准不可复现
      teamId: x.teamId === 'all' ? 'all' : 'tm' + (teams.findIndex((tt) => tt.id === x.teamId) + 1),
      name: x.name, correct: x.correct, attempts: x.attempts,
      creditRate: x.creditRate, score: x.score === undefined ? null : x.score, memberCount: x.memberCount
    })),
    // 归一化后重排：questionStats 的最终 tie-break 用的是原始 uid（每次不同），
    // 这里按归一化 qid 排，保证基准可复现（Rust 侧按入参顺序用，不再重排）
    questions: questions.map((x) => ({
      qid: 'q' + (qIdx(x.qid) + 1), stem: x.stem, tier: x.tier, tierLabel: x.tierLabel,
      attempts: x.attempts, correct: x.correct, half: x.half, wrong: x.wrong, skip: x.skip,
      correctRate: x.correctRate, creditRate: x.creditRate, avgPoints: x.avgPoints, missers: x.missers
    })).sort((p1, p2) => (p1.correctRate - p2.correctRate) || (p2.attempts - p1.attempts) || (p1.qid < p2.qid ? -1 : 1)),
    comment: opts.comment === undefined ? '全班表现不错，继续保持' : opts.comment,
    reviewLine: CI.analysis.questionReviewLine(questions) || '',
    halfRatio: Number(S.get().settings.halfRatio),
    // 「需要关注」的判定阈值：跟随设置（原来硬编码 60）
    weakThreshold: Number(opts.weakThreshold === undefined ? S.get().settings.weakThreshold : opts.weakThreshold)
  };

  const data = CI.analysis.buildReport(input);
  reportCases.push({
    name,
    input,
    expect: {
      attempts: data.attempts, correct: data.correct, half: data.half, wrong: data.wrong, skip: data.skip,
      creditRate: data.creditRate, earned: data.earned,
      students: data.students.map((s) => ({ sid: s.sid, name: s.name, teamName: s.teamName, score: s.score, attempts: s.attempts, correct: s.correct, creditRate: s.creditRate })),
      markdown: CI.analysis.toMarkdown(data)
    }
  });
}

mkReportCase('报告：有作答、有队伍、有评语');
mkReportCase('报告：没有课程名（用默认标题）', { courseName: '' });
mkReportCase('报告：没有评语', { comment: '' });
mkReportCase('报告：签到不满（1/2）', { seated: 1, rate: 50 });
// 阈值非默认：掌握度 80% 的学生在 weakThreshold=0.9 时应进「需要关注」
mkReportCase('报告：薄弱阈值 0.9（阈值必须跟随设置）', { weakThreshold: 0.9 });



/* ---------- 用例集：多维度评价（analysis.js::evaluate 等）---------- *
 * 纯函数：参与度 / 进步 / 衰减平均掌握度 / 三维加权（含失效维度重归一） */
const compositeCases = { participation: [], growth: [], decayed: [], evaluate: [] };

// 参与度：答错也算参与，只看"答没答"
for (const [answered, total] of [[5, 5], [3, 5], [0, 5], [3, 0], [9, 5]]) {
  compositeCases.participation.push({
    name: '参与度 ' + answered + '/' + total,
    answered, total,
    expect: CI.analysis.participationRate(answered, total)
  });
}

// 进步：与自己前后半段比（50 = 持平）
for (const [early, late, enough] of [[50, 50, true], [40, 70, true], [70, 40, true], [0, 100, true], [100, 0, true], [40, 70, false]]) {
  compositeCases.growth.push({
    name: '进步 ' + early + '→' + late + (enough ? '' : '（样本不足）'),
    early, late, enough,
    expect: CI.analysis.growthScore(early, late, enough)
  });
}

// 衰减平均掌握度：同样的流水，decay 不同结果不同
{
  const mk = (results) => results.map((r, i) => ({ sid: 's1', qid: 'q1', result: r, at: i + 1, points: 0, tier: 'basic' }));
  const sets = [
    ['先错三次后答对', ['wrong', 'wrong', 'wrong', 'correct']],
    ['先对三次后答错', ['correct', 'correct', 'correct', 'wrong']],
    ['两次半对', ['half', 'half']],
    ['单条答对', ['correct']],
    ['含手动调整', ['correct', 'manual', 'wrong']],
    ['空', []]
  ];
  for (const [name, results] of sets) {
    for (const [halfRatio, decay] of [[0.5, 0.65], [0.4, 0.5], [0.5, 1], [0.5, 0]]) {
      compositeCases.decayed.push({
        name: name + '（半对系数 ' + halfRatio + '，衰减 ' + decay + '）',
        records: mk(results), halfRatio, decay,
        expect: CI.analysis.decayedRate(mk(results), halfRatio, decay)
      });
    }
  }
}

// 三维加权：含失效维度重归一与全 0 权重
{
  const w1 = { mastery: 60, participation: 25, growth: 15 };
  const w2 = { mastery: 20, participation: 60, growth: 20 };
  const w3 = { mastery: 0, participation: 0, growth: 0 };
  const rows = [
    ['默认权重', 80, 100, 60, true, w1],
    ['默认权重·全满', 100, 100, 100, true, w1],
    ['默认权重·全零', 0, 0, 0, true, w1],
    ['进步样本不足（应重归一）', 80, 100, 0, false, w1],
    ['参与为主的权重', 0, 100, 50, true, w2],
    ['全 0 权重（不能除零）', 50, 50, 50, true, w3]
  ];
  for (const [name, mastery, participation, growth, valid, w] of rows) {
    const r = CI.analysis.evaluate(mastery, participation, growth, valid, w);
    compositeCases.evaluate.push({
      name,
      mastery, participation, growth, growthValid: valid, weights: w,
      expect: {
        total: r.total,
        weightUsed: r.weightUsed,
        parts: r.parts.map((p) => ({ key: p.key, value: p.value, weight: p.weight, contribution: p.contribution, valid: p.valid }))
      }
    });
  }
}


/* ---------- 用例集：选项分布（analysis.js::optionDistribution）---------- *
 * "哪个干扰项最吸引人" —— 大屏点评环节显示"40% 的人选了 B"的依据 */
const optionDistCases = [];

function mkOptionDistCase(name, specs) {
  globalThis.localStorage.clear();
  S.replaceState(S.defaultState());
  const teams = S.get().teams;
  const a = S.addStudent('甲', teams[0].id);
  const b = S.addStudent('乙', teams[0].id);
  const c = S.addStudent('丙', teams[0].id);
  const sid = (x) => (typeof x === 'string' ? x : x.id);
  const q = S.addQuestion({ stem: '选一选', tier: 'basic', options: ['甲', '乙', '丙'], answer: 'A' });
  const qz = S.createQuiz('随堂测', [q.id]);
  // specs: [picked, result]
  specs.forEach(([picked, result], i) => {
    const who = [a, b, c][i % 3];
    S.recordResult({
      sid: sid(who), qid: q.id, tier: 'basic', result, quizId: qz.id,
      picked: picked, note: picked ? picked + '. …' : '跳过'
    });
  });
  const got = CI.analysis.optionDistribution(S.get(), q.id);
  optionDistCases.push({
    name,
    options: q.options,
    answer: q.answer,
    records: specs.map(([picked, result]) => ({ picked, result })),
    expect: got.map((o) => ({ key: o.key, text: o.text, count: o.count, rate: o.rate, correct: o.correct }))
  });
}

mkOptionDistCase('选项分布：1A 2B（B 是最吸引人的干扰项）', [['A', 'correct'], ['B', 'wrong'], ['B', 'wrong']]);
mkOptionDistCase('选项分布：含跳过（不进分母）', [['A', 'correct'], ['B', 'wrong'], ['', 'skip']]);
mkOptionDistCase('选项分布：全对', [['A', 'correct'], ['A', 'correct']]);
mkOptionDistCase('选项分布：无人作答', []);


/* ---------- 用例集：学情统计（analysis.js::studentStats / classStats / ranking / teamRanking）---------- *
 * 重点比"数据范围（quizId）是否贯穿"—— JS 版曾经漏传 opts，汇总说 1 次、榜上说 2 次 */
const statsCases = [];

function mkStatsCase(name, spec) {
  globalThis.localStorage.clear();
  S.replaceState(S.defaultState());
  const teams = S.get().teams;
  const t1 = teams[0].id, t2 = teams[1].id;
  const mk = (nm, tm) => { const x = S.addStudent(nm, tm); return typeof x === 'string' ? x : x.id; };
  const s1 = mk('甲', t1), s2 = mk('乙', t1), s3 = mk('丙', t2);
  const q1 = S.addQuestion({ stem: '第一节的题', tier: 'basic', answer: 'A' });
  const q2 = S.addQuestion({ stem: '第二节的题', tier: 'advanced', answer: 'B' });
  const z1 = S.createQuiz('第一节课', [q1.id]);
  const z2 = S.createQuiz('第二节课', [q2.id]);
  // spec: [sid, 'q1'|'q2', tier, result, 'z1'|'z2', points?]
  const QID = { q1: q1.id, q2: q2.id };
  const ZID = { z1: z1.id, z2: z2.id };
  spec.forEach(([sid, q, tier, result, quiz, points]) => {
    const rec = { sid: sid === 's1' ? s1 : sid === 's2' ? s2 : s3, qid: QID[q] || q, tier, result, quizId: ZID[quiz] || quiz };
    if (points !== undefined) rec.points = points;
    S.recordResult(rec);
  });
  const pick = (st) => st && ({
    sid: st.sid, name: st.name, teamName: st.teamName, score: st.score,
    attempts: st.total.attempts, correct: st.total.correct, half: st.total.half,
    creditRate: st.total.creditRate, correctRate: st.total.correctRate,
    rolls: st.rolls, lastAt: st.lastAt, weak: st.weak, strong: st.strong, level: st.level,
    tierKeys: st.tiers.map((x) => x.key)
  });
  const one = (sid, quizId) => pick(CI.analysis.studentStats(S.get(), sid, { quizId: quizId }));
  const rank = (teamId, quizId) => CI.analysis.ranking(S.get(), teamId, { quizId: quizId }).map((r) => ({
    sid: r.sid, name: r.name, score: r.score, attempts: r.attempts, correct: r.correct,
    creditRate: r.creditRate, rank: r.rank, level: r.level, weakCount: r.weakCount
  }));
  const cs = (teamId, quizId) => {
    const c = CI.analysis.classStats(S.get(), teamId, { quizId: quizId });
    return {
      teamId: c.teamId, studentCount: c.studentCount, participants: c.participants,
      attempts: c.total.attempts, correct: c.total.correct, creditRate: c.total.creditRate,
      weakTiers: c.weakTiers, needHelp: c.needHelp.map((r) => r.sid),
      rankAttempts: c.ranking.map((r) => r.attempts)
    };
  };
  // 归一化：uid → sN/tmN（随机 uid 不可复现），lastAt → 序号（时间戳不可复现）
  const SID = {}; [s1, s2, s3].forEach((id, i) => { SID[id] = 's' + (i + 1); });
  const QN = {}; S.get().bank.forEach((x, i) => { QN[x.id] = 'q' + (i + 1); });
  const TM = {}; S.get().teams.forEach((x, i) => { TM[x.id] = 'tm' + (i + 1); });
  const normStu = (x) => x && Object.assign({}, x, { sid: SID[x.sid] || x.sid, lastAt: x.lastAt ? 1 : 0,
    level: x.level && x.level.short });
  const normRank = (list) => list.map((r) => Object.assign({}, r, { sid: SID[r.sid] || r.sid, level: r.level && r.level.short }));
  const normClass = (c) => Object.assign({}, c, { needHelp: c.needHelp.map((x) => SID[x] || x) });

  statsCases.push({
    name,
    students: S.get().students.map((x) => ({ id: SID[x.id] || x.id, name: x.name, teamId: TM[x.teamId] || x.teamId, active: x.active })),
    teams: S.get().teams.map((x) => ({ id: TM[x.id] || x.id, name: x.name })),
    bank: S.get().bank.map((x, i) => ({ id: 'q' + (i + 1), tier: x.tier, tags: x.tags || [] })),
    quizzes: S.get().quizzes.map((q, qi) => ({
      id: 'z' + (qi + 1),
      records: q.records.map((r, ri) => ({
        sid: SID[r.sid] || r.sid,
        qid: QN[r.qid] || r.qid,
        tier: r.tier, result: r.result,
        quizId: 'z' + (qi + 1),
        points: r.points, base: r.base,
        // at 归一化成序号（时间戳不可复现）
        at: ri + 1,
        source: r.source
      }))
    })),
    settings: { halfRatio: S.get().settings.halfRatio, minSample: S.get().settings.minSample, weakThreshold: S.get().settings.weakThreshold, strongThreshold: S.get().settings.strongThreshold },
    expect: {
      // 注意：这里要用**真实的 uid**（s1/s2/s3 是 mk() 的返回值），不能用字面量 s1
      all: normStu(one(s1, null)), z1: normStu(one(s1, z1.id)), z2: normStu(one(s1, z2.id)),
      other: normStu(one(s2, z1.id)),
      rankAll: normRank(rank(null, null)), rankZ1: normRank(rank(null, z1.id)),
      classAll: normClass(cs(null, null)), classZ1: normClass(cs(null, z1.id)),
      team: CI.analysis.teamRanking(S.get()).map((x) => ({ teamId: TM[x.teamId] || x.teamId, score: x.score, memberCount: x.memberCount, avg: x.avg, attempts: x.attempts }))
    }
  });
}

mkStatsCase('统计：两节课（范围必须贯穿到榜）', [
  ['s1', 'q1', 'basic', 'wrong', 'z1'],
  ['s1', 'q2', 'advanced', 'correct', 'z2'],
  ['s2', 'q1', 'basic', 'correct', 'z1']
]);
mkStatsCase('统计：半对按 halfRatio 折算', [
  ['s1', 'q1', 'basic', 'half', 'z1'],
  ['s1', 'q2', 'advanced', 'correct', 'z2']
]);
mkStatsCase('统计：样本不足不判薄弱/优势', [
  ['s1', 'q1', 'basic', 'correct', 'z1']
]);


/* ---------- 用例集：学生可见视图（classroom.js::studentView）---------- *
 * 重点：**没公布答案就不下发 answerKey / explanation** —— 提前下发会泄题 */
const viewCases = [];

function mkViewCase(name, opts) {
  globalThis.localStorage.clear();
  S.replaceState(S.defaultState());
  const q = S.addQuestion({
    stem: opts.stem || '题干',
    tier: opts.tier || 'basic',
    answer: opts.answer === undefined ? 'A' : opts.answer,
    options: opts.options || ['甲', '乙', '丙'],
    tags: opts.tags || [],
    note: opts.note || '讲评要点'
  });
  S.setRuntime({ qid: q.id, quizId: null });
  if (opts.reveal) CI.classroom.setReveal(true);
  const v = CI.classroom.studentView(S.get(), S.get().bank.find((x) => x.id === q.id));
  viewCases.push({
    name,
    question: {
      // 归一化：随机 uid 会让基准不可复现（这个坑踩过好几次了）
      id: 'q1', tier: q.tier, stem: q.stem, answer: q.answer,
      options: q.options, tags: q.tags, note: q.note, imageUrl: q.imageUrl || ''
    },
    tierLabel: S.tierOf(S.get(), q.tier).label,
    points: S.questionPoints(S.get(), q),
    revealed: !!opts.reveal,
    expect: v && {
      id: 'q1', stem: v.stem, fullStem: v.fullStem, imageUrl: v.imageUrl,
      tier: v.tier, tierLabel: v.tierLabel, points: v.points,
      multiple: v.multiple, options: v.options, hasAnswer: v.hasAnswer,
      answerKey: v.answerKey, explanation: v.explanation, tags: v.tags
    }
  });
}

mkViewCase('视图：未公布（不能泄题）', { reveal: false, note: '这题的关键是…' });
mkViewCase('视图：已公布（带答案与讲评要点）', { reveal: true, note: '这题的关键是…' });
mkViewCase('视图：多选题', { reveal: true, answer: 'AB', options: ['甲', '乙', '丙'] });
mkViewCase('视图：主观题（没有标准答案）', { reveal: true, answer: '', options: [] });
mkViewCase('视图：超长题干要截断', { reveal: true, stem: '题'.repeat(200) });
mkViewCase('视图：带配图与标签', { reveal: true, tags: ['代数', '函数', '图像', '综合', '第五个会被丢掉'] });

/* ---------- 用例集：公开课现场评价量规（openclass.js）---------- *
 * 重点：**未评的维度要剔除并重新归一**（不能按 0 分算，那会凭空拉低总分） */
const openCases = [];

function mkOpenCase(name, scores) {
  const ev = CI.openclass.evaluate(scores);
  openCases.push({
    name,
    scores,
    expect: {
      total: ev.total, level: ev.level, weightUsed: ev.weightUsed,
      strongest: ev.strongest, weakest: ev.weakest, comment: ev.comment,
      parts: ev.parts.map((p) => ({
        key: p.key, label: p.label, weight: p.weight, score: p.score,
        level: p.level, rate: p.rate, contribution: p.contribution
      }))
    }
  });
}

mkOpenCase('公开课：四维全优秀', [{ key: 'basic', score: 4 }, { key: 'transfer', score: 4 }, { key: 'expression', score: 4 }, { key: 'attitude', score: 4 }]);
mkOpenCase('公开课：四维全良好', [{ key: 'basic', score: 3 }, { key: 'transfer', score: 3 }, { key: 'expression', score: 3 }, { key: 'attitude', score: 3 }]);
mkOpenCase('公开课：强基础弱迁移', [{ key: 'basic', score: 4 }, { key: 'transfer', score: 1 }, { key: 'expression', score: 3 }, { key: 'attitude', score: 3 }]);
mkOpenCase('公开课：只评两维（要重新归一）', [{ key: 'basic', score: 4 }, { key: 'transfer', score: 4 }]);
mkOpenCase('公开课：只评一维', [{ key: 'transfer', score: 3 }]);
mkOpenCase('公开课：全是最低档', [{ key: 'basic', score: 1 }, { key: 'transfer', score: 1 }, { key: 'expression', score: 1 }, { key: 'attitude', score: 1 }]);
mkOpenCase('公开课：一维都没评', []);

/* ---------- 用例集：AI 润色提示词（polish.js）---------- *
 * 提示词也是规则：它编码了"只润色不判断 / 不出现姓名 / 限长"三条硬约束 */
const polishCases = [];

function mkPolishCase(name, scores) {
  const ev = CI.openclass.evaluate(scores);
  polishCases.push({
    name,
    evaluation: JSON.parse(JSON.stringify(ev)),
    expect: {
      prompt: CI.polish.prompt(ev),
      sanitized: [
        CI.polish.sanitize('「他答得很好」'),
        CI.polish.sanitize('第一行\n第二行'),
        CI.polish.sanitize('字'.repeat(200))
      ]
    }
  });
}

mkPolishCase('润色：四维全优秀', [{ key: 'basic', score: 4 }, { key: 'transfer', score: 4 }, { key: 'expression', score: 4 }, { key: 'attitude', score: 4 }]);
mkPolishCase('润色：强基础弱迁移', [{ key: 'basic', score: 4 }, { key: 'transfer', score: 1 }, { key: 'expression', score: 3 }, { key: 'attitude', score: 3 }]);
mkPolishCase('润色：各维接近（不能硬编短板）', [{ key: 'basic', score: 3 }, { key: 'transfer', score: 3 }]);
mkPolishCase('润色：一维都没评', []);

/* ---------- 用例集：大屏公开展示策略（openclass.showOnStage）---------- *
 * 公开表扬、私下改进：默认只在良好/优秀时公开 */
const policyCases = [];

['优秀', '良好', '合格', '待改进'].forEach((level) => {
  ['smart', 'always', 'never', 'unknown'].forEach((policy) => {
    policyCases.push({ level, policy, expect: CI.openclass.showOnStage(level, policy) });
  });
});
/* ---------- 落盘 / 校验 ---------- */
const payload = {
  _comment: '由 scripts/gen-parity-fixtures.mjs 生成；Rust 侧 crates/ci-domain/tests/parity.rs 逐字段比对',
  generatedBy: 'JS 参考实现（assets/js/analysis.js + assets/js/grade.js）',
  ability: cases,
  grading,
  rollcall,
  scoring,
  classroom,
  draw: drawCases,
  questionStats,
  mistakes: mistakeCases,
  report: reportCases,
  composite: compositeCases,
  optionDist: optionDistCases,
  stats: statsCases,
  view: viewCases,
  openclass: openCases,
  polish: polishCases,
  stagePolicy: policyCases
};
const text = JSON.stringify(payload, null, 2) + '\n';
const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';

if (CHECK) {
  if (current === text) {
    console.log('[ok] parity.json 与 JS 参考实现一致（能力 ' + cases.length + ' + 判分 ' + grading.length +
    ' + 点名 ' + rollcall.length + ' + 计分 ' + scoring.length + ' + 课堂 ' + classroom.length + ' + 抽题 ' + drawCases.length + ' + 题目统计 ' + questionStats.length +
    ' + 错题本 ' + mistakeCases.length + ' + 报告 ' + reportCases.length +
    ' + 多维评价 ' + (compositeCases.participation.length + compositeCases.growth.length + compositeCases.decayed.length + compositeCases.evaluate.length) +
    ' + 选项分布 ' + optionDistCases.length + ' + 学情统计 ' + statsCases.length +
    ' + 学生视图 ' + viewCases.length + ' + 公开课量规 ' + openCases.length +
    ' + 润色提示词 ' + polishCases.length + ' + 大屏策略 ' + policyCases.length + ' 组）');
    process.exit(0);
  }
  console.error('[stale] parity.json 与 JS 参考实现不一致 —— 运行 node scripts/gen-parity-fixtures.mjs 重新生成');
  process.exit(1);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, text, 'utf8');
console.log('[ok] 已生成 ' + path.relative(ROOT, OUT) +
  '（能力 ' + cases.length + ' + 判分 ' + grading.length + ' + 点名 ' + rollcall.length + ' + 计分 ' + scoring.length + ' + 课堂 ' + classroom.length + ' 组用例）');
cases.forEach((c) => console.log('   · ' + c.name.padEnd(28) + c.expect.grade + '  overall=' + c.expect.overall));
grading.forEach((g) => console.log('   · ' + g.name.padEnd(28) + (g.expect ? g.expect.result : 'null（主观题）')));
rollcall.forEach((r) => console.log('   · ' + r.name.padEnd(34) + r.mode + '  ' + r.steps.length + ' 步'));
scoring.forEach((c) => console.log('   · ' + c.name.padEnd(34) + c.steps.length + ' 步'));
classroom.forEach((c) => console.log('   · ' + c.name.padEnd(34) + c.steps.length + ' 步'));
drawCases.forEach((c) => console.log('   · ' + c.name.padEnd(34) + '抽 ' + c.expect.ids.length + ' 道'));
questionStats.forEach((c) => console.log('   · ' + c.name.padEnd(34) + c.expect.length + ' 道题'));
mistakeCases.forEach((c) => console.log('   · ' + c.name.padEnd(34) + c.expectOne.items.length + ' 道错题 / 榜上 ' + c.expectBoard.length + ' 人'));
reportCases.forEach((c) => console.log('   · ' + c.name.padEnd(34) + c.expect.markdown.split('\n').length + ' 行 Markdown'));
console.log('   · 多维评价：参与度 ' + compositeCases.participation.length + ' + 进步 ' + compositeCases.growth.length +
  ' + 衰减平均 ' + compositeCases.decayed.length + ' + 加权 ' + compositeCases.evaluate.length + ' 组');
