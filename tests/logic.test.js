/*!
 * tests/logic.test.js — 无头逻辑测试（Node 运行，不需要浏览器）
 *   node tests/logic.test.js
 * 覆盖：数据模型 / 迁移 / 加权计分 / 撤销 / 题库导入导出 / 学情统计 / 点名算法 /
 *       客观题自动判分 / 多端协同的学生命令处理
 */
'use strict';

const path = require('path');

/* ---------- 极简 localStorage 桩 ---------- */
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
globalThis.localStorage = fakeStorage();

/* ---------- 载入被测模块（浏览器端为普通脚本，Node 里挂到 globalThis.CI） ---------- */
require(path.join(__dirname, '..', 'assets', 'js', 'store.js'));
require(path.join(__dirname, '..', 'assets', 'js', 'analysis.js'));
require(path.join(__dirname, '..', 'assets', 'js', 'grade.js'));
require(path.join(__dirname, '..', 'assets', 'js', 'sync.js'));
require(path.join(__dirname, '..', 'assets', 'js', 'rollcall.js'));
require(path.join(__dirname, '..', 'assets', 'js', 'classroom.js'));
require(path.join(__dirname, '..', 'assets', 'js', 'bank.js'));

const CI = globalThis.CI;
const S = CI.store;

/* ---------- 断言 ---------- */
let passed = 0;
const failures = [];

function ok(cond, label) {
  if (cond) { passed++; } else { failures.push(label); }
}
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a === b) { passed++; } else { failures.push(label + '  →  期望 ' + b + '，实际 ' + a); }
}
function group(name) { console.log('\n== ' + name + ' =='); }
function reset() {
  globalThis.localStorage.clear();
  S.replaceState(S.defaultState());
}

/* ================= 1. 数据模型与迁移 ================= */
group('数据模型与迁移');

reset();
const st0 = S.get();
ok(st0.teams.length === 2, '默认两支队伍');
ok(st0.tiers.length === 4, '默认四个题型');
eq(st0.tiers.map((t) => t.weight), [3, 5, 8, 10], '默认权重 3/5/8/10');
ok(!!st0.rollcall && st0.rollcall.mode === 'even', '点名默认轮次池模式');

// v1 迁移
globalThis.localStorage.clear();
globalThis.localStorage.setItem('teams', JSON.stringify([
  { name: '红队', score: 12, icon: '🔴' }, { name: '蓝队', score: 7, icon: '🔵' }
]));
globalThis.localStorage.setItem('opLogs', JSON.stringify([{ ts: Date.now(), type: '修改积分', detail: '旧日志' }]));
const migrated = S.load();
eq(migrated.teams.length, 2, '迁移后保留两支队伍');
eq(migrated.students.length, 2, '迁移为每队生成 1 名代表学生');
eq(migrated.students.map((x) => x.name), ['红队', '蓝队'], '代表学生同名');
eq(migrated.students.map((x) => S.scoreOf(migrated, x.id)), [12, 7], 'v1 队伍分数迁移到学生积分');
ok(migrated.logs.some((l) => l.type === '数据迁移'), '写入迁移日志');
S.replaceState(migrated);

/* ================= 2. 队伍 / 学生 ================= */
group('队伍与学生管理');

reset();
const t1 = S.get().teams[0].id;
const t2 = S.get().teams[1].id;
const stuA = S.addStudent('张三', t1);
const stuB = S.addStudent('李四', t1);
const stuC = S.addStudent('王五', t2);
eq(S.get().students.length, 3, '新增 3 名学生');
eq(S.studentsOf(S.get(), t1).length, 2, '一队 2 人');

const bulk = S.addStudentsBulk('赵六、钱七 孙八\n周九', t2);
eq(bulk.length, 4, '批量添加识别多种分隔符');
eq(S.get().students.length, 7, '批量后共 7 人');

S.addManual(stuA.id, 5);
S.addManual(stuB.id, 3);
// 防通胀：手动加分单次上限 +2（settings.manualCapPlus），所以 +5 会收敛成 +2、+3 收敛成 +2
eq(S.scoreOf(S.get(), stuA.id), 2, '手动 +5 被上限收敛为 +2');
eq(S.teamScore(S.get(), t1), 4, '队伍分 = 成员分之和（2 + 2）');
eq(S.teamScore(S.get(), t2), 0, '二队 0 分');
// 上限内不受影响
S.addManual(stuA.id, 1);
eq(S.scoreOf(S.get(), stuA.id), 3, '上限内的 +1 正常记');
// 下限：单次扣分不低于 −1
S.addManual(stuA.id, -5);
eq(S.scoreOf(S.get(), stuA.id), 2, '手动 −5 被下限收敛为 −1');
// 上限可配置
S.updateSettings({ manualCapPlus: 10 });
S.addManual(stuA.id, 5);
eq(S.scoreOf(S.get(), stuA.id), 7, '把上限改成 10 后 +5 正常记');
S.updateSettings({ manualCapPlus: 2 });

S.updateStudent(stuC.id, { teamId: t1 });
eq(S.studentsOf(S.get(), t1).length, 3, '改换队伍生效');
S.removeStudent(stuC.id);
eq(S.get().students.length, 6, '删除学生');

const newTeam = S.addTeam('绿队');
S.removeTeam(newTeam.id);
ok(!S.get().teams.some((t) => t.id === newTeam.id), '删除队伍');

/* ================= 3. 加权计分引擎 ================= */
group('加权计分引擎');

reset();
const teamA = S.get().teams[0].id;
const s1 = S.addStudent('甲', teamA);
const q1 = S.addQuestion({ stem: '基础题：1+1=?', tier: 'basic', answer: '2' });
const q2 = S.addQuestion({ stem: '拔高题：求导', tier: 'advanced', answer: '2x' });
const q3 = S.addQuestion({ stem: '扩展题：自定义分值', tier: 'extended', points: 20, answer: '-' });

eq(S.questionPoints(S.get(), S.question(q1.id)), 3, '基础题基准 3 分');
eq(S.questionPoints(S.get(), S.question(q2.id)), 5, '拔高题基准 5 分');
eq(S.questionPoints(S.get(), S.question(q3.id)), 20, '自定义分值优先于题型权重');

S.recordResult({ sid: s1.id, qid: q1.id, result: 'correct' });
eq(S.scoreOf(S.get(), s1.id), 3, '基础题答对 +3');

S.recordResult({ sid: s1.id, qid: q2.id, result: 'correct' });
eq(S.scoreOf(S.get(), s1.id), 8, '拔高题答对再 +5（累计 8）');

S.recordResult({ sid: s1.id, qid: q2.id, result: 'half' });
eq(S.scoreOf(S.get(), s1.id), 10.5, '部分正确 = 基准 × 0.5（+2.5）');

S.recordResult({ sid: s1.id, qid: q2.id, result: 'wrong' });
eq(S.scoreOf(S.get(), s1.id), 10.5, '答错默认不扣分');

S.recordResult({ sid: s1.id, tier: 'improve', result: 'correct', source: 'quick' });
eq(S.scoreOf(S.get(), s1.id), 20.5, '快捷题型加分 +10');

S.updateSettings({ wrongPenalty: 2, fastBonus: 1, halfRatio: 0.4 });
S.recordResult({ sid: s1.id, qid: q1.id, result: 'wrong' });
eq(S.scoreOf(S.get(), s1.id), 18.5, '答错扣 2 分');
S.recordResult({ sid: s1.id, qid: q1.id, result: 'correct', fast: true });
eq(S.scoreOf(S.get(), s1.id), 22.5, '答对 +3 且抢答 +1');
S.recordResult({ sid: s1.id, qid: q1.id, result: 'half' });
eq(S.scoreOf(S.get(), s1.id), 23.7, 'halfRatio 改为 0.4 后 +1.2');

// 撤销
const undone = S.undoLastRecord();
eq(S.scoreOf(S.get(), s1.id), 22.5, '撤销最后一条后分数回退');
ok(undone && undone.result === 'half', '撤销返回被删流水');

// 归零保留历史
S.resetStudentScore(s1.id);
eq(S.scoreOf(S.get(), s1.id), 0, '归零后为 0');
ok(S.allRecords(S.get()).length > 0, '归零后历史流水保留');
eq(S.recordsOf(S.get(), { sid: s1.id, countable: true }).length, 7, '计入统计的流水为 7 条（不含手动/归零）');
S.updateSettings({ wrongPenalty: 0, fastBonus: 0, halfRatio: 0.5 });

// 题型权重改动不影响历史
reset();
const teamB = S.get().teams[0].id;
const s2 = S.addStudent('乙', teamB);
const qb = S.addQuestion({ stem: '基础题', tier: 'basic' });
S.recordResult({ sid: s2.id, qid: qb.id, result: 'correct' });
S.updateTier('basic', { weight: 9 });
eq(S.scoreOf(S.get(), s2.id), 3, '改权重后历史分不变（流水含基准快照）');
S.recordResult({ sid: s2.id, qid: qb.id, result: 'correct' });
eq(S.scoreOf(S.get(), s2.id), 12, '改权重后新记录按新分值 9 分');

/* ================= 4. 题库 ================= */
group('题库与导入导出');

reset();
const r1 = S.bulkImportQuestions([
  { stem: '题A', tier: 'basic', answer: 'a' },
  { stem: '题B', tierLabel: '拔高题', answer: 'b' },
  { stem: '题A', tier: 'basic' },
  { stem: '', tier: 'basic' }
], { dedupe: true });
eq(r1, { added: 2, skipped: 2 }, '导入去重：新增 2、跳过 2');
eq(S.get().bank.length, 2, '题库 2 题');
eq(S.get().bank[1].tier, 'advanced', '按中文题型名映射 tier');

const dump = S.exportBank();
eq(dump.type, 'ci-question-bank', '导出格式标记');
eq(dump.questions.length, 2, '导出题目数');
eq(dump.questions[0].tierLabel, '基础题', '导出含中文题型名');

const parsed = CI.bankUI.parseImport('基础题：集合A={1,2}，子集个数？ | 4\n函数 y=x² 对称轴？ | x=0');
eq(parsed.length, 2, '文本导入解析 2 行');
eq(parsed[0].tier, 'basic', '识别「基础题：」前缀');
eq(parsed[0].answer, '4', '识别 | 分隔的答案');
eq(CI.bankUI.parseImport('[{"stem":"JSON题","tier":"improve"}]').length, 1, 'JSON 数组导入');

// 选择题的文本写法：题干 | 选项1 ; 选项2 ; 选项3 | 答案
const parsedChoice = CI.bankUI.parseImport('下列哪个是质数？ | 4 ; 6 ; 7 ; 9 | C');
eq(parsedChoice[0].options, ['4', '6', '7', '9'], '文本导入识别选择题选项');
eq(parsedChoice[0].answer, 'C', '文本导入识别选择题答案');

/* ---- 题目配图（数学图形题）---- */
reset();
const qImg = S.addQuestion({ stem: '如图，求阴影面积', tier: 'basic', answer: '6', imageUrl: './images/图1.png' });
eq(S.get().bank[0].imageUrl, './images/图1.png', 'addQuestion 保存图片地址');
S.updateQuestion(qImg.id, { imageUrl: 'https://example.com/a.png' });
eq(S.get().bank[0].imageUrl, 'https://example.com/a.png', 'updateQuestion 改图片地址');
S.updateQuestion(qImg.id, { imageUrl: '' });
eq(S.get().bank[0].imageUrl, '', '清空图片地址');
// 导入时三种写法都认（imageUrl / image_url / image）
const imgImport = S.bulkImportQuestions([
  { stem: '导入题一', tier: 'basic', imageUrl: 'a.png' },
  { stem: '导入题二', tier: 'basic', image_url: 'b.png' },
  { stem: '导入题三', tier: 'basic', image: 'c.png' },
  { stem: '导入题四', tier: 'basic' }
], { dedupe: false });
eq(imgImport.added, 4, '导入 4 道带图/不带图的题');
const bankNow = S.get().bank;
eq(bankNow[bankNow.length - 4].imageUrl, 'a.png', '导入认 imageUrl');
eq(bankNow[bankNow.length - 3].imageUrl, 'b.png', '导入认 image_url');
eq(bankNow[bankNow.length - 2].imageUrl, 'c.png', '导入认 image');
eq(bankNow[bankNow.length - 1].imageUrl, '', '没有图时为空串（不是 undefined）');
// 导出/导入往返不丢图
const imgDump = S.exportBank();
const withImg = imgDump.questions.filter((x) => x.imageUrl === 'a.png');
eq(withImg.length, 1, '导出带上图片地址');
reset();
S.bulkImportQuestions(imgDump.questions, { dedupe: false });
eq(S.get().bank.filter((x) => x.imageUrl === 'a.png').length, 1, '按导出内容重新导入后图片地址仍在');
eq(parsedChoice[0].stem, '下列哪个是质数？', '选择题题干正确');

const qx = S.addQuestion({ stem: '待改题', tier: 'basic' });
S.updateQuestion(qx.id, { tier: 'improve', points: 12, tags: ['函数'] });
eq(S.question(S.get(), qx.id).points, 12, '修改题目自定义分值');
S.updateQuestion(qx.id, { points: '' });
eq(S.question(S.get(), qx.id).points, null, '分值清空回归继承题型');
S.removeQuestion(qx.id);
ok(!S.question(S.get(), qx.id), '删除题目');

eq(S.removeTier('basic').ok, false, '题型被题目占用时禁止删除');
eq(S.addTier({ label: '综合题', weight: 6 }).weight, 6, '新增自定义题型');
eq(S.removeTier(S.get().tiers[4].key).ok, true, '空题型可删除');

// 选项字段（多端协同的客观题）
const qOpt = S.addQuestion({ stem: '选择题', tier: 'basic', options: ['甲', '乙'], answer: 'B' });
eq(S.question(S.get(), qOpt.id).options, ['甲', '乙'], '题目支持选项数组');
S.updateQuestion(qOpt.id, { options: ['甲', '乙', '丙'] });
eq(S.question(S.get(), qOpt.id).options.length, 3, '选项可修改');
eq(CI.grade.typeOf(S.question(S.get(), qOpt.id)), 'choice', '带选项的题被识别为选择题');

/* ================= 5. 试卷与流水 ================= */
group('试卷与答题流水');

reset();
const tm = S.get().teams[0].id;
const p1 = S.addStudent('甲', tm);
const p2 = S.addStudent('乙', tm);
const Q1 = S.addQuestion({ stem: '第一题', tier: 'basic' });
const Q2 = S.addQuestion({ stem: '第二题', tier: 'advanced' });
const quiz = S.createQuiz('第一次随堂测', [Q1.id, Q2.id], '');
eq(S.get().currentQuizId, quiz.id, '新建后成为当前试卷');
eq(S.get().runtime.qid, Q1.id, '自动选中第一题');

S.recordResult({ sid: p1.id, qid: Q1.id, result: 'correct', quizId: quiz.id, source: 'rollcall' });
S.recordResult({ sid: p2.id, qid: Q1.id, result: 'wrong', quizId: quiz.id, source: 'rollcall' });
S.recordResult({ sid: p2.id, qid: Q2.id, result: 'correct', quizId: quiz.id, source: 'quiz' });

eq(S.quiz(S.get(), quiz.id).records.length, 3, '试卷内 3 条流水');
eq(S.scoreOf(S.get(), p1.id), 3, '甲 3 分');
eq(S.scoreOf(S.get(), p2.id), 5, '乙 5 分');
ok(S.answeredAlready(S.get(), quiz.id, Q1.id, p1.id), '题目作答判定：甲已答第一题');
ok(!S.answeredAlready(S.get(), quiz.id, Q2.id, p1.id), '甲未答第二题');

S.addQuestionsToQuiz(quiz.id, [Q1.id, Q2.id]);
eq(S.quiz(S.get(), quiz.id).questionIds.length, 2, '重复加入不产生副本');
S.setQuizQuestions(quiz.id, [Q2.id, Q1.id]);
eq(S.quiz(S.get(), quiz.id).questionIds, [Q2.id, Q1.id], '题目顺序可调整');
S.closeQuiz(quiz.id);
eq(S.get().currentQuizId, null, '结束试卷后清除当前试卷');

S.recordResult({ sid: p1.id, tier: 'basic', result: 'correct', source: 'quick' });
const collector = S.get().quizzes.filter((q) => q.name.indexOf('快捷记分') === 0)[0];
ok(!!collector && collector.records.length === 1, '无试卷流水进入「快捷记分」收集器');
eq(S.scoreOf(S.get(), p1.id), 6, '快捷加分计入总分');

S.deleteQuiz(quiz.id);
eq(S.scoreOf(S.get(), p2.id), 0, '删除试卷后其流水一并移除');

/* ================= 6. 学情分析 ================= */
group('学情分析');

reset();
S.updateSettings({ minSample: 2, weakThreshold: 0.6, strongThreshold: 0.85, halfRatio: 0.5 });
const ta = S.get().teams[0].id;
const sa = S.addStudent('学生甲', ta);
const qBasic = S.addQuestion({ stem: '基础', tier: 'basic' });
const qAdv = S.addQuestion({ stem: '拔高', tier: 'advanced' });

// 基础题 2 对 0 错 → 100%；拔高题 0 对 2 错 → 0%
S.recordResult({ sid: sa.id, qid: qBasic.id, result: 'correct' });
S.recordResult({ sid: sa.id, qid: qBasic.id, result: 'correct' });
S.recordResult({ sid: sa.id, qid: qAdv.id, result: 'wrong' });
S.recordResult({ sid: sa.id, qid: qAdv.id, result: 'wrong' });

const stats = CI.analysis.studentStats(S.get(), sa.id);
eq(stats.total.attempts, 4, '统计作答 4 次');
eq(stats.total.correct, 2, '答对 2 次');
eq(stats.total.creditRate, 50, '整体加权得分率 50%');
const basicRow = stats.tiers.filter((t) => t.key === 'basic')[0];
const advRow = stats.tiers.filter((t) => t.key === 'advanced')[0];
eq(basicRow.creditRate, 100, '基础题得分率 100%');
eq(advRow.creditRate, 0, '拔高题得分率 0%');
eq(stats.weak, ['advanced'], '薄弱题型识别为拔高题');
eq(stats.strong, ['basic'], '优势题型识别为基础题');

const report = CI.analysis.summarizeStudent(S.get(), sa.id);
ok(report.text.indexOf('薄弱题型：拔高题') >= 0, '总结包含薄弱题型');
ok(report.text.indexOf('教学建议') >= 0, '总结包含教学建议');
ok(report.lines.length >= 5, '总结行数充足');

const cls = CI.analysis.summarizeClass(S.get(), null);
ok(cls.text.indexOf('学情小结') >= 0, '班级小结生成');
ok(cls.stats.tiers.some((t) => t.attempts > 0), '班级题型统计有数据');

const rank = CI.analysis.ranking(S.get(), null);
eq(rank[0].name, '学生甲', '排行榜含学生');
eq(rank[0].rank, 1, '排行榜名次');
const teamRank = CI.analysis.teamRanking(S.get());
eq(teamRank[0].score, 6, '队伍榜分 = 6（2×3）');

const csv = CI.analysis.classCSV(S.get(), null);
ok(csv.length >= 2 && csv[0].indexOf('加权得分率%') >= 0, 'CSV 导出表头正确');

/* ================= 7. 点名算法 ================= */
group('点名系统');

reset();
const teamX = S.get().teams[0].id;
const teamY = S.get().teams[1].id;
const names = ['甲', '乙', '丙', '丁'].map((n) => S.addStudent(n, teamX));
S.addStudent('戊', teamY);

eq(CI.rollcall.candidates(S.get(), { scope: teamX }).length, 4, '范围过滤：一队 4 人');
eq(CI.rollcall.candidates(S.get(), { scope: 'all' }).length, 5, '全班 5 人');

// 均匀模式：一轮内不重复
S.setRollSettings({ mode: 'even', scope: 'all', recentExclude: 0, excludeAnswered: false });
const picked = [];
for (let i = 0; i < 5; i++) {
  const r = CI.rollcall.pick(S.get(), { recentExclude: 0 });
  picked.push(r.sid);
  CI.rollcall.applyPick(r);
}
eq(new Set(picked).size, 5, '均匀模式一轮覆盖全部 5 人且不重复');
const round2 = CI.rollcall.pick(S.get(), { recentExclude: 0 });
ok(round2.note.indexOf('新一轮') >= 0 || round2.newRound === true, '第 6 次进入新一轮');

// 最少被点优先
CI.store.resetRolls();
S.setRollSettings({ mode: 'least', scope: 'all', recentExclude: 0 });
const first = CI.rollcall.applyPick(CI.rollcall.pick(S.get(), { recentExclude: 0 }));
const second = CI.rollcall.pick(S.get(), { recentExclude: 0 });
ok(second.sid !== first.sid, '最少被点优先会避开刚点过的人');

// 排除当前题已作答
CI.store.resetRolls();
const rcQ = S.addQuestion({ stem: '点名用题', tier: 'basic' });
const quiz2 = S.createQuiz('点名用卷', [rcQ.id], '');
S.setRuntime({ quizId: quiz2.id, qid: rcQ.id });
S.recordResult({ sid: names[0].id, qid: rcQ.id, result: 'correct', quizId: quiz2.id });
const cands = CI.rollcall.candidates(S.get(), { scope: 'all', excludeAnswered: true, recentExclude: 0 });
eq(cands.length, 4, '排除已答当前题的学生');
ok(!cands.some((c) => c.id === names[0].id), '已答者不在候选中');

// 防连点
CI.store.resetRolls();
const r1st = CI.rollcall.applyPick(CI.rollcall.pick(S.get(), { recentExclude: 1, excludeAnswered: false,
  quizId: null, qid: null, scope: 'all' }));
const r2nd = CI.rollcall.pick(S.get(), { recentExclude: 1, excludeAnswered: false, quizId: null, qid: null, scope: 'all' });
ok(r2nd.sid !== r1st.sid, '防连点：第二次不点同一人');

eq(S.get().rollcall.history.length, 1, '点名历史已记录');
eq(S.calledCount(S.get(), r1st.sid), 1, '被点次数统计');
CI.store.resetRolls();
eq(S.get().rollcall.history.length, 0, '清空点名记录');

/* ================= 8. 客观题自动判分（grade.js） ================= */
group('客观题自动判分');

const G = CI.grade;

const qChoice = { stem: '选一选', options: ['甲', '乙', '丙', '丁'], answer: 'B' };
const qMulti = { stem: '多选', options: ['甲', '乙', '丙', '丁'], answer: 'AC' };
const qFill = { stem: '填空', answer: 'x=1|x = 1|1' };
const qSubj = { stem: '证明题', answer: '' };

eq(G.typeOf(qChoice), 'choice', '有选项 → 选择题');
eq(G.typeOf(qFill), 'fill', '有答案无选项 → 填空题');
eq(G.typeOf(qSubj), 'subjective', '无选项无答案 → 主观题（必须老师判定）');
eq(G.canAutoGrade(qSubj), false, '主观题不能自动判分');

eq(G.parseChoice('答案：A、C'), ['A', 'C'], '从各种写法中抽出选项字母');
eq(G.auto(qChoice, { choice: ['B'] }).result, 'correct', '单选答对');
eq(G.auto(qChoice, { choice: ['A'] }).result, 'wrong', '单选答错');
eq(G.auto(qChoice, { choice: [] }).result, 'skip', '空提交 → 跳过');
eq(G.auto(qMulti, { choice: ['A', 'C'] }).result, 'correct', '多选全对');
eq(G.auto(qMulti, { choice: ['A'] }).result, 'half', '多选漏选 → 部分正确');
eq(G.auto(qMulti, { choice: ['A', 'B'] }).result, 'wrong', '多选错选（扣到 0）→ 答错');

/* ---- 部分得分按命中比例、扣减误选（2026-10 改）----
 * 规则：ratio = max(0, (命中 − 误选) / 正确选项总数)
 * 改前的问题：是子集就给 50%（漏 1 个与漏 3 个同分）、多选 1 个（含全部正确项）反而 0 分。 */
const qMulti4 = { stem: '四选多', options: ['甲', '乙', '丙', '丁'], answer: 'ABCD' };
eq(G.auto(qMulti4, { choice: ['A', 'B', 'C', 'D'] }).ratio, 1, '全对 → ratio 1');
eq(G.auto(qMulti4, { choice: ['A', 'B', 'C'] }).ratio, 0.75, '漏 1 个 → 3/4');
eq(G.auto(qMulti4, { choice: ['A', 'B'] }).ratio, 0.5, '漏 2 个 → 2/4');
eq(G.auto(qMulti4, { choice: ['A'] }).ratio, 0.25, '漏 3 个 → 1/4（改前是 0.5，与漏 1 个同分）');
eq(G.auto(qMulti4, { choice: ['A', 'B', 'C', 'D', 'E'] }).ratio, 0.75, '多选 1 个错的 → 4 对 1 错 = 3/4（改前直接 0 分）');
eq(G.auto(qMulti4, { choice: ['A', 'B', 'E'] }).ratio, 0.25, '对 2 错 1 → 1/4');
eq(G.auto(qMulti4, { choice: ['E'] }).ratio, 0, '全错 → 0（不会出现负分）');
eq(G.auto(qMulti4, { choice: [] }).ratio, 0, '空提交 → 跳过，ratio 0');
eq(G.auto(qChoice, { choice: ['B'] }).ratio, 1, '单选答对 ratio 1');
eq(G.auto(qChoice, { choice: ['A'] }).ratio, 0, '单选答错 ratio 0');
eq(G.auto(qFill, { text: 'x=1' }).ratio, 1, '填空答对 ratio 1');
eq(G.auto(qFill, { text: 'x=9' }).ratio, 0, '填空答错 ratio 0');

// 部分得分真的进了积分：漏 1 个拿 3/4、漏 3 个拿 1/4（不再都是 50%）
eq(S.computePoints({ result: 'half', base: 8, ratio: 0.75 }), 6, '部分分 3/4 → 8×0.75 = 6');
eq(S.computePoints({ result: 'half', base: 8, ratio: 0.25 }), 2, '部分分 1/4 → 8×0.25 = 2');
eq(S.computePoints({ result: 'half', base: 8 }), 4, '没给 ratio 时仍回退 halfRatio(0.5) → 4');
eq(G.auto(qFill, { text: ' X = 1 ' }).result, 'correct', '填空忽略空格与大小写、支持多解');
eq(G.auto(qFill, { text: 'x=2' }).result, 'wrong', '填空答错');
eq(G.auto(qFill, { text: '' }).result, 'skip', '填空空提交 → 跳过');
eq(G.auto(qSubj, { text: '我的证明' }), null, '主观题返回 null（交老师确认）');
ok(G.answerKey(qChoice).indexOf('B. 乙') >= 0, '公布答案时展示选项内容');
ok(G.describeSubmission(qMulti, { choice: ['A'] }).indexOf('A. 甲') >= 0, '提交内容可读化');

/* ================= 9. 多端协同：学生命令处理（classroom.js） ================= */
group('多端协同：学生提交与判定');

reset();
const ct1 = S.get().teams[0].id;
const ct2 = S.get().teams[1].id;
const cStuA = S.addStudent('甲同学', ct1);
const cStuB = S.addStudent('乙同学', ct2);
const cq = S.addQuestion({ stem: '选择题：1+1=?', tier: 'basic', options: ['1', '2', '3'], answer: 'B' });
const sq = S.addQuestion({ stem: '主观题：证明勾股定理', tier: 'improve' });
const cquiz = S.createQuiz('协同测试卷', [cq.id, sq.id], '');
S.setRuntime({ quizId: cquiz.id, qid: cq.id, accepting: true });

const CLS = CI.classroom;

CLS.handleCmd({ kind: 'hello', teamId: ct1 });
ok(S.get().classroom.feed[0].text.indexOf('红队') >= 0, '入座写进实时流');

CLS.handleCmd({ kind: 'buzz', teamId: ct1, sid: cStuA.id });
CLS.handleCmd({ kind: 'buzz', teamId: ct2, sid: cStuB.id });
CLS.handleCmd({ kind: 'buzz', teamId: ct1, sid: cStuA.id });
eq(S.get().classroom.buzz.length, 2, '抢答榜去重（同一队同一题只记一次）');
eq(S.get().classroom.buzz[1].teamId, ct1, '先抢到的排在后面（倒序展示）');

const cr1 = CLS.handleCmd({ kind: 'answer', teamId: ct1, sid: cStuA.id, qid: cq.id, choice: ['B'] });
eq(cr1.result, 'correct', '选择题答对自动判分');
eq(S.scoreOf(S.get(), cStuA.id), 3, '自动加分 +3（基础题）');
eq(S.teamScore(S.get(), ct1), 3, '队伍分自动聚合');

const cr2 = CLS.handleCmd({ kind: 'answer', teamId: ct2, sid: cStuB.id, qid: cq.id, choice: ['A'] });
eq(cr2.result, 'wrong', '选择题答错自动判分');
eq(S.scoreOf(S.get(), cStuB.id), 0, '答错不加分');

const cr3 = CLS.handleCmd({ kind: 'answer', teamId: ct1, sid: cStuA.id, qid: cq.id, choice: ['B'] });
eq(cr3.reason, 'duplicate', '同一题重复提交被忽略');
eq(S.scoreOf(S.get(), cStuA.id), 3, '分数没有被重复累加');

S.setRuntime({ qid: sq.id });
const cr4 = CLS.handleCmd({ kind: 'answer', teamId: ct1, sid: cStuA.id, qid: sq.id, text: '用面积法证明' });
eq(cr4.result, 'pending', '主观题进入待确认队列');
eq(S.get().classroom.pending.length, 1, '待确认队列 1 条');
const pid = S.get().classroom.pending[0].id;
CLS.resolvePending(pid, 'correct');
eq(S.get().classroom.pending.length, 0, '判定后从队列移除');
eq(S.scoreOf(S.get(), cStuA.id), 13, '主观题判定答对 +10（提升题）');

CLS.handleCmd({ kind: 'answer', teamId: ct2, sid: cStuB.id, qid: sq.id, text: '不会' });
const pid2 = S.get().classroom.pending[0].id;
CLS.dropPending(pid2);
eq(S.get().classroom.pending.length, 0, '丢弃后队列为空');
eq(S.scoreOf(S.get(), cStuB.id), 0, '丢弃不记分');

S.setRuntime({ qid: cq.id, reveal: true });
const meta = CLS.metaPayload();
ok(Array.isArray(meta.buzz) && meta.buzz.length === 2, '快照含抢答榜');
ok(meta.buzz[0].teamName && meta.buzz[0].sidName, '抢答榜带队伍与学生姓名');
eq(meta.accepting, true, '快照含作答开关');

eq(CLS.pickAnswerer(S.get(), ct2, null), cStuB.id, '未指定作答人时取该队成员');

// 无当前试卷时的去重（快捷记分模式）：同一题同一学生只能提交一次
S.setRuntime({ quizId: null, qid: cq.id });
S.recordResult({ sid: cStuB.id, qid: cq.id, tier: 'basic', result: 'correct', quizId: null, source: 'manual' });
const beforeNoQuiz = S.scoreOf(S.get(), cStuB.id);
const dupNoQuiz = CLS.handleCmd({ kind: 'answer', teamId: ct2, sid: cStuB.id, qid: cq.id, choice: ['B'] });
eq(dupNoQuiz.reason, 'duplicate', '没有当前试卷时也判重（快捷记分模式）');
eq(S.scoreOf(S.get(), cStuB.id), beforeNoQuiz, '重复提交没有重复加分');

// 选择题文本导入支持三个以上答案字母
const multi3 = CI.bankUI.parseImport('多选题：以下哪些是质数？ | 2 ; 3 ; 4 ; 5 | ABD');
eq(multi3[0].options.length, 4, '三答案选择题：选项解析');
eq(multi3[0].answer, 'ABD', '三答案选择题：答案字母 ABC 形式被识别');
eq(CI.grade.auto({ options: ['2', '3', '4', '5'], answer: 'ABD' }, { choice: ['A', 'B', 'D'] }).result, 'correct',
  '三答案多选题全对判 correct');

// 推送题目与"按题公布答案"（防止换题后答案泄露）
S.setRuntime({ quizId: cquiz.id, qid: cq.id, accepting: true, reveal: false });
CLS.setReveal(true);
ok(CLS.isRevealed(S.get(), S.question(S.get(), cq.id)), '公布答案后当前题处于已公布状态');
eq(CI.sync.snapshot().meta.question.answerKey !== null, true, '快照里带出答案');
eq(CI.sync.snapshot().meta.reveal, true, '快照 reveal 为真');

const moved = CLS.moveQuestion(1);
eq(moved.qid, sq.id, '「下一题」切到第二题');
eq(S.get().runtime.qid, sq.id, 'runtime 当前题已更新');
eq(S.get().runtime.reveal, false, '换题后自动收起答案');
eq(CI.sync.snapshot().meta.question.answerKey, null, '新题的答案不会泄露给学生端与大屏');
eq(CI.sync.snapshot().meta.reveal, false, '快照 reveal 随新题变为假');
eq(CI.sync.snapshot().meta.questionIndex, { index: 1, total: 2 }, '快照带出题目进度（第 2/2 题）');

const back = CLS.moveQuestion(-1);
eq(back.qid, cq.id, '「上一题」切回第一题');
eq(CLS.moveQuestion(-1).edge, true, '第一题再往前是边界（不越界）');
eq(S.get().runtime.qid, cq.id, '边界处当前题不变');

/* ================= 10. 题目保存前自检（防静默判错） ================= */
group('题目保存前自检（防静默判错）');

(function () {
  var v = G.validateQuestion;
  // 选择题答案写成选项原文 —— 真的会"所有提交都判错"，课堂上极难发现
  var bad = v({ stem: '子集个数', tier: 'basic', options: ['6', '8', '9'], answer: '8' });
  eq(bad.ok, false, '选择题答案填选项原文会被拦下');
  ok(bad.warnings.join(' ').indexOf('选项字母') >= 0, '提示要填字母：' + bad.warnings[0]);

  var good = v({ stem: '子集个数', tier: 'basic', options: ['6', '8', '9'], answer: 'B' });
  eq(good.ok, true, '正确答案的选择题通过校验');
  eq(good.warnings.length, 0, '无问题时没有告警');

  eq(v({ stem: '多选', options: ['甲', '乙', '丙'], answer: 'AC' }).ok, true, '多选题（AC）通过');
  eq(v({ stem: '越界', options: ['甲', '乙'], answer: 'D' }).ok, false, '答案字母超出选项个数会被拦下');
  eq(v({ stem: '空答案', options: ['甲', '乙'], answer: '' }).ok, false, '选择题空答案会被拦下');
  // 无选项且无答案 ⇒ 按题型推断规则就是"主观题"（由老师判定），不算配置错误
  eq(v({ stem: '无选项无答案', options: [], answer: '' }).ok, true, '无选项无答案 = 主观题，不报错');
  eq(v({ stem: '填空多解', options: [], answer: '8|八|eight' }).ok, true, '填空题 | 分隔的多解通过');
  eq(v({ stem: '填空逗号', options: [], answer: '8,八' }).ok, false, '填空题用逗号会被提示改用 |');
  eq(v({ stem: '说明思路', tier: 'improve', options: [], answer: '' }).ok, true, '主观题不需要答案');
  ok(v({ stem: '全选', options: ['甲', '乙'], answer: 'AB' }).warnings.join(' ').indexOf('全部选项') >= 0,
    '答案覆盖全部选项时给出确认提示');

  // 导入路径必须真的调用它（否则告警只是摆设）
  var bankSrc = require('fs').readFileSync(require('path').join(__dirname, '..', 'assets', 'js', 'bank.js'), 'utf8');
  ok(bankSrc.indexOf('CI.grade.validateQuestion') >= 0, '导入路径调用 validateQuestion');
  ok(/仍然导入吗/.test(bankSrc), '导入前给出"仍然导入吗"的确认');
})();

/* ================= 11. 能力评价（题型雷达 + 评级） ================= */
group('能力评价：按题型雷达与综合评级');

(function () {
  const KEY = S.get().tiers.map((t) => t.key);       // basic / advanced / extended / improve
  const A = CI.analysis;

  // 评级档位表
  eq(A.ABILITY_GRADES.length, 8, '评级共 8 档');
  eq(new Set(A.ABILITY_GRADES.map((g) => g.key)).size, 8, '评级 key 不重复');
  ok(A.ABILITY_GRADES[0].key === 'hexagon' && A.ABILITY_GRADES[0].label.indexOf('六边形') >= 0,
    '最高档是「六边形战士」');

  // 造一个"全才"：四个题型各答对两次
  S.replaceState(S.defaultState());
  const teams = S.get().teams;
  S.addStudentsBulk('全才 偏科 新手', teams[0].id);
  const st = S.get().students;
  KEY.forEach((k) => { S.recordResult({ sid: st[0].id, tier: k, result: 'correct' }); S.recordResult({ sid: st[0].id, tier: k, result: 'correct' }); });

  const all = A.ability(S.get(), { sid: st[0].id });
  eq(all.axes.length, KEY.length, '雷达轴数 = 题型数（' + KEY.length + '）');
  eq(all.axes.every((a) => typeof a.label === 'string' && a.label.length > 0), true, '每条轴都有名称');
  eq(all.axes.every((a) => a.attempts === 2), true, '每条轴都记录了作答次数');
  eq(all.overall, 100, '四题型全对 → 综合分 100');
  eq(all.mastery, 100, '掌握度 100');
  eq(all.coverage, 100, '覆盖率 100%');
  eq(all.balance, 100, '各轴齐平 → 均衡度 100');
  eq(all.grade.key, 'hexagon', '判定为六边形战士');
  ok(all.comment.indexOf('六边形战士') >= 0, '评语点出六边形战士：' + all.comment);

  // 偏科：基础/拔高全对，扩展/提升全错
  ['basic', 'advanced'].forEach((k) => { S.recordResult({ sid: st[1].id, tier: k, result: 'correct' }); S.recordResult({ sid: st[1].id, tier: k, result: 'correct' }); });
  ['extended', 'improve'].forEach((k) => { S.recordResult({ sid: st[1].id, tier: k, result: 'wrong' }); S.recordResult({ sid: st[1].id, tier: k, result: 'wrong' }); });
  const spike = A.ability(S.get(), { sid: st[1].id });
  eq(spike.grade.key, 'specialist', '强项强、短板明显 → 偏科尖子');
  eq(spike.balance, 0, '均衡度 0');
  ok(spike.comment.indexOf('短板') >= 0, '评语指出短板：' + spike.comment);
  ok(spike.weakest && spike.weakest.rate === 0, '最弱轴正确率为 0');
  ok(spike.strongest && spike.strongest.rate === 100, '最强轴正确率为 100');

  // 半对按 halfRatio 折算（与加分口径一致）
  S.replaceState(S.defaultState());
  S.addStudentsBulk('半对同学', S.get().teams[0].id);
  const half = S.get().students[0];
  S.recordResult({ sid: half.id, tier: 'basic', result: 'half' });
  S.recordResult({ sid: half.id, tier: 'basic', result: 'half' });
  const h = A.ability(S.get(), { sid: half.id });
  eq(h.axes.find((a) => a.key === 'basic').rate, 50, '半对两次 → 该轴 50%');

  // 样本不足 & 覆盖率折算：只答对 1 道基础题，不能显示成 100 分
  S.replaceState(S.defaultState());
  S.addStudentsBulk('新手', S.get().teams[0].id);
  const newbie = S.get().students[0];
  S.recordResult({ sid: newbie.id, tier: 'basic', result: 'correct' });
  const nb = A.ability(S.get(), { sid: newbie.id });
  eq(nb.grade.key, 'insufficient', '作答次数少于 minSample → 样本不足');
  eq(nb.coverage, Math.round(100 / KEY.length), '覆盖率 = 已作答题型占比');
  ok(nb.overall < 100 && nb.overall > 0, '综合分被覆盖率折算（' + nb.overall + '）');
  eq(nb.balance, null, '只答过 1 个题型时均衡度无意义（null）');
  eq(nb.axes.filter((a) => a.attempts === 0).length, KEY.length - 1, '未作答题型的作答次数为 0');

  // 权重：轴按题型权重升序，拔高题比基础题"值钱"
  const axes = A.ability(S.get(), {}).axes;
  const first = axes[0].weight;
  const last = axes[axes.length - 1].weight;
  ok(last >= first, '轴按权重升序排列（' + first + ' → ' + last + '）');

  // 评价榜：学生与队伍都要有
  S.replaceState(S.defaultState());
  const t2 = S.get().teams;
  S.addStudentsBulk('甲 乙', t2[0].id);
  S.addStudentsBulk('丙 丁', t2[1].id);
  const list = S.get().students;
  ['basic', 'advanced', 'extended', 'improve'].forEach((k) => S.recordResult({ sid: list[0].id, tier: k, result: 'correct' }));
  S.recordResult({ sid: list[2].id, tier: 'advanced', result: 'correct' });
  const board = A.abilityBoard(S.get());
  eq(board.students.length, 4, '评价榜覆盖全部学生');
  eq(board.teams.length, 2, '评价榜覆盖全部队伍');
  ok(!!board.class && board.class.kind === 'class', '含全班整体评价');
  const teamA = A.ability(S.get(), { teamId: t2[0].id });
  eq(teamA.kind, 'team', '队伍评价的 kind 正确');
  eq(teamA.memberCount, 2, '队伍评价带人数');
  eq(teamA.name, t2[0].name, '队伍评价带队名');
  ok(teamA.comment.length > 0, '队伍也有文字评价：' + teamA.comment);
})();

/* ================= 12. 课堂环节（大屏按环节切换） ================= */
group('课堂环节与大屏数据');

(function () {
  const CLS2 = CI.classroom;
  S.replaceState(S.defaultState());
  const teams = S.get().teams;
  S.addStudentsBulk('甲 乙', teams[0].id);
  S.addStudentsBulk('丙 丁', teams[1].id);
  const q1 = S.addQuestion({ stem: '第一题', tier: 'basic', answer: 'A', options: ['甲', '乙'] });
  const q2 = S.addQuestion({ stem: '第二题', tier: 'advanced', answer: 'x=1' });
  const qz = S.createQuiz('随堂测', [q1.id, q2.id]);
  S.setCurrentQuiz(qz.id);

  eq(CLS2.phase(S.get()), 'idle', '默认处于待机环节');
  eq(CLS2.PHASES.join(','), 'idle,rollcall,question,review', '四个环节：待机 / 点名 / 出题 / 点评');

  // 出题环节：自动带上当前题并开始接收作答
  S.setRuntime({ qid: null, accepting: false });
  eq(CLS2.setPhase('question'), 'question', '切到出题环节');
  eq(S.get().runtime.accepting, true, '出题即开始接收作答');
  eq(!!S.get().runtime.qid, true, '出题环节自动带上第一题');

  // 点评环节：停止接收，便于讲评
  CLS2.setPhase('review');
  eq(S.get().runtime.accepting, false, '进入点评后停止接收作答');

  // 点名环节会收起答案
  CI.classroom.setReveal(true);
  CLS2.setPhase('rollcall');
  eq(S.get().runtime.reveal, false, '切到点名环节会收起答案');

  // 非法环节忽略；没有题时出题退回待机
  eq(CLS2.setPhase('nonsense'), 'rollcall', '非法环节值被忽略，保持原环节');
  const empty = S.defaultState();
  empty.bank = [];
  empty.quizzes = [];
  S.replaceState(empty);
  S.setRuntime({ qid: null });
  eq(CLS2.setPhase('question'), 'idle', '没有题目时出题环节退回待机');
  // 快照里要带够大屏所需的信息
  S.replaceState(S.defaultState());
  const t2 = S.get().teams;
  S.addStudentsBulk('甲 乙', t2[0].id);
  S.addStudentsBulk('丙 丁', t2[1].id);
  const qa = S.addQuestion({ stem: '题', tier: 'basic', answer: 'A' });
  const qb = S.addQuestion({ stem: '题2', tier: 'advanced', answer: 'B' });
  const qz2 = S.createQuiz('随堂测', [qa.id, qb.id]);
  S.setCurrentQuiz(qz2.id);
  S.setRuntime({ qid: qa.id });
  const st2 = S.get().students;
  S.recordResult({ sid: st2[0].id, qid: qa.id, result: 'correct' });
  S.recordResult({ sid: st2[1].id, qid: qa.id, result: 'correct' });
  S.recordResult({ sid: st2[2].id, qid: qb.id, result: 'half' });
  CLS2.setPhase('review');

  const meta = CLS2.metaPayload();
  eq(meta.phase, 'review', '快照带出当前环节');
  eq(meta.phaseLabel, '点评总结', '快照带出环节中文名');
  eq(Array.isArray(meta.teamStats), true, '快照带出各队答题情况');
  eq(meta.teamStats[0].teamId, 'all', 'teamStats 第一行是全班合计');
  ok(meta.teamStats.length === S.get().teams.length + 1, 'teamStats 覆盖全班 + 每支队伍');
  eq(meta.teamStats[0].correct >= 2, true, '全班答对数正确（' + meta.teamStats[0].correct + '）');
  eq(meta.teamStats.slice(1).every((t) => typeof t.correct === 'number' && typeof t.rate === 'undefined'), true,
    '每支队伍都有答对数');
  ok(meta.ability && meta.ability.class && meta.ability.teams.length === S.get().teams.length,
    '快照带出能力评价（全班 + 每队）');
  eq(meta.ability.axes.length, S.get().tiers.length, '能力评价的轴数与题型数一致');
  eq(meta.ability.class.grade.label.length > 0, true, '全班有评级文案');
  eq(meta.ability.students.length, S.get().students.length, '能力评价覆盖全部学生（供"个人画像"用）');
  ok(meta.ability.teams[0].comment.length > 0, '队伍评价带评语');
  eq(typeof meta.sidName, 'string', '快照带出当前被点学生姓名（点名环节大屏用）');

  // 点名：抽到谁，快照里就有谁
  const pick = CI.rollcall.pick(S.get(), {});
  CI.rollcall.applyPick(pick);
  const meta2 = CLS2.metaPayload();
  eq(meta2.sid, pick.sid, '点名后快照带出被点学生 id');
  ok(meta2.sidName.length > 0, '点名后快照带出被点学生姓名：' + meta2.sidName);
  ok(meta2.sidTeamName.length > 0, '点名后快照带出该生队伍');
})();

/* ================= 13. rev 单调性（否则满屏 409、数据落不了库） ================= */
group('rev 单调性（过期写入防护的配套约束）');

(function () {
  // 枢纽用 rev 判断"谁的更新"，本机 rev 一旦回退，之后所有写入都会被判过期
  S.replaceState(Object.assign(S.defaultState(), { rev: 300 }));
  const r1 = S.get().rev;
  ok(r1 > 300, '载入远端状态后 rev 递增（' + r1 + '）');

  S.replaceState(S.defaultState());          // 整份替换成自带 rev=1 的新数据
  const r2 = S.get().rev;
  ok(r2 > r1, 'replaceState 之后 rev 不回退（' + r1 + ' → ' + r2 + '）');

  S.importAll({ state: Object.assign(S.defaultState(), { rev: 5 }) });
  const r3 = S.get().rev;
  ok(r3 > r2, 'importAll 之后 rev 不回退（' + r2 + ' → ' + r3 + '）');

  S.factoryReset();
  const r4 = S.get().rev;
  ok(r4 > r3, 'factoryReset 之后 rev 不回退（' + r3 + ' → ' + r4 + '）');
  ok(r4 >= 300, '本机 rev 始终不低于枢纽曾达到的 rev（否则写入会被 409 拒绝）');
})();

/* ================= 13. 课堂节奏：计时器与签到 ================= */
group('课堂节奏（计时器 / 签到）');

(function () {
  const CLS3 = CI.classroom;
  S.replaceState(S.defaultState());

  /* ---- 计时器：只存结束时刻，各端本地渲染 ---- */
  eq(CLS3.timerLeft(), null, '没在计时时剩余时间为 null');

  const before = Date.now();
  const ends = CLS3.setTimer(90, '随堂练习');
  ok(ends > before, 'setTimer 返回结束时刻');
  eq(S.get().runtime.timerLabel, '随堂练习', '计时器带说明文字');
  const left = CLS3.timerLeft();
  ok(left > 88 * 1000 && left <= 90 * 1000, '剩余时间约 90 秒（实际 ' + left + 'ms）');

  // 显示口径：向上取整
  eq(CLS3.formatLeft(90 * 1000), '1:30', '90 秒显示 1:30');
  eq(CLS3.formatLeft(59 * 1000 + 400), '1:00', '59.4 秒向上取整显示 1:00');
  eq(CLS3.formatLeft(400), '0:01', '还剩 0.4 秒显示 0:01');
  eq(CLS3.formatLeft(0), '0:00', '到点显示 0:00');
  eq(CLS3.formatLeft(600 * 1000), '10:00', '10 分钟显示 10:00');

  // 快照要带上（大屏/学生端据此显示）
  const meta = CLS3.metaPayload();
  eq(meta.timerEndsAt, ends, '快照带出计时结束时刻');
  eq(meta.timerLabel, '随堂练习', '快照带出计时说明');

  // 停止：传 0 秒等价于停止
  CLS3.clearTimer();
  eq(CLS3.timerLeft(), null, 'clearTimer 之后没有剩余时间');
  eq(S.get().runtime.timerEndsAt, null, '停止后结束时刻被清空');
  eq(S.get().runtime.timerLabel, '', '停止后说明被清空');
  CLS3.setTimer(30, '讨论');
  CLS3.setTimer(0, '');
  eq(CLS3.timerLeft(), null, '传 0 秒 = 停止');

  /* ---- 签到统计：按 presence 里 online 的队伍数 ---- */
  const teams = S.get().teams;
  CLS3.setPresence({ hostOnline: true, teams: [] });
  let ck = CLS3.checkinStats(S.get());
  eq(ck.total, teams.length, '签到总数 = 队伍数（' + teams.length + '）');
  eq(ck.seated, 0, '没人入座时签到 0');
  eq(ck.rate, 0, '签到率 0%');

  CLS3.setPresence({ hostOnline: true, teams: [{ teamId: teams[0].id, online: true, label: teams[0].name, at: Date.now() }] });
  ck = CLS3.checkinStats(S.get());
  eq(ck.seated, 1, '一队在线时签到 1');
  eq(ck.rate, Math.round((1 / teams.length) * 100), '签到率按队伍数折算');

  CLS3.setPresence({ hostOnline: true, teams: teams.map((t) => ({ teamId: t.id, online: true, label: t.name, at: Date.now() })) });
  ck = CLS3.checkinStats(S.get());
  eq(ck.seated, teams.length, '全部在线时签到满');
  eq(ck.rate, 100, '签到率 100%');
  eq(CLS3.metaPayload().checkin.rate, 100, '快照带出签到统计');

  // 复位，避免影响后续用例
  CLS3.setPresence({ hostOnline: false, teams: [] });
  CLS3.clearTimer();
})();

/* ================= 14. 随机抽题（组卷） ================= */
group('随机抽题');

(function () {
  S.replaceState(S.defaultState());
  const team = S.get().teams[0].id;
  S.addStudent('甲', team);

  // 造 6 道题：3 基础 / 2 拔高 / 1 归档
  const qs = [];
  ['集合与逻辑', '函数与导数', '概率统计'].forEach((tag, i) => {
    qs.push(S.addQuestion({ stem: '基础' + (i + 1), tier: 'basic', tags: [tag], answer: 'A' }));
  });
  qs.push(S.addQuestion({ stem: '拔高1', tier: 'advanced', tags: ['函数与导数'], answer: 'B' }));
  qs.push(S.addQuestion({ stem: '拔高2', tier: 'advanced', tags: ['概率统计'], answer: 'C' }));
  const archived = S.addQuestion({ stem: '归档题', tier: 'basic', tags: ['集合与逻辑'], answer: 'D' });
  S.updateQuestion(archived.id, { archived: true });

  // 固定随机序列（可复现）
  const seq = [0.1, 0.7, 0.3, 0.9, 0.2, 0.5, 0.4, 0.8, 0.6, 0.15];
  const fixed = () => { seq.push(seq.shift()); return seq[0]; };

  const all = S.drawQuestions(S.get(), { count: 99 }, fixed);
  eq(all.length, 5, '归档题默认不参与抽题（6 道里只有 5 道可选）');
  ok(all.indexOf(archived.id) < 0, '归档题确实没被抽到');

  const basics = S.drawQuestions(S.get(), { count: 99, tiers: ['basic'] }, fixed);
  eq(basics.length, 3, '限定题型：基础题 3 道');

  const tagged = S.drawQuestions(S.get(), { count: 99, tags: ['概率统计'] }, fixed);
  eq(tagged.length, 2, '限定标签：概率统计 2 道（基础+拔高）');

  const both = S.drawQuestions(S.get(), { count: 99, tiers: ['advanced'], tags: ['函数与导数'] }, fixed);
  eq(both.length, 1, '题型 + 标签同时限定 → 1 道');

  const excluded = S.drawQuestions(S.get(), { count: 99, excludeIds: [qs[0].id, qs[3].id] }, fixed);
  eq(excluded.length, 3, '排除已在试卷里的题');
  ok(excluded.indexOf(qs[0].id) < 0 && excluded.indexOf(qs[3].id) < 0, '被排除的题没出现');

  // 数量与去重
  const two = S.drawQuestions(S.get(), { count: 2 }, fixed);
  eq(two.length, 2, '抽 2 道就返回 2 道');
  eq(new Set(two).size, 2, '不会抽出重复题');
  eq(S.drawQuestions(S.get(), { count: 0 }, fixed).length, 0, '抽 0 道 → 空');

  // 可复现：同一固定序列 → 同一结果
  const mk = () => { const s = [0.1, 0.7, 0.3, 0.9, 0.2]; return () => { s.push(s.shift()); return s[0]; }; };
  const a = S.drawQuestions(S.get(), { count: 3 }, mk());
  const b = S.drawQuestions(S.get(), { count: 3 }, mk());
  eq(JSON.stringify(a), JSON.stringify(b), '同一随机序列 → 抽到同一批题（可复现）');

  // 空题库 / 条件不匹配
  const empty = S.defaultState();
  empty.bank = [];
  eq(S.drawQuestions(empty, { count: 3 }, fixed).length, 0, '空题库 → 空结果（不报错）');
  eq(S.drawQuestions(S.get(), { count: 3, tiers: ['不存在'] }, fixed).length, 0, '条件不匹配 → 空结果');
})();

/* ================= 15. 按题目的正确率与课后评价 ================= */
group('按题目正确率 / 课后评价');

(function () {
  const A = CI.analysis;
  S.replaceState(S.defaultState());
  const teams = S.get().teams;
  const s1 = S.addStudent('甲', teams[0].id);
  const s2 = S.addStudent('乙', teams[0].id);
  const s3 = S.addStudent('丙', teams[1].id);
  const id = (x) => (typeof x === 'string' ? x : x.id);

  const q1 = S.addQuestion({ stem: '第一题：1+1=?', tier: 'basic', answer: 'A' });
  const q2 = S.addQuestion({ stem: '第二题：全班都不会', tier: 'advanced', answer: 'B' });
  const qz = S.createQuiz('随堂测', [q1.id, q2.id]);

  // q1：2 对 1 错；q2：3 人全错
  S.recordResult({ sid: id(s1), qid: q1.id, tier: 'basic', result: 'correct', quizId: qz.id });
  S.recordResult({ sid: id(s2), qid: q1.id, tier: 'basic', result: 'correct', quizId: qz.id });
  S.recordResult({ sid: id(s3), qid: q1.id, tier: 'basic', result: 'wrong', quizId: qz.id });
  S.recordResult({ sid: id(s1), qid: q2.id, tier: 'advanced', result: 'wrong', quizId: qz.id });
  S.recordResult({ sid: id(s2), qid: q2.id, tier: 'advanced', result: 'wrong', quizId: qz.id });
  S.recordResult({ sid: id(s3), qid: q2.id, tier: 'advanced', result: 'skip', quizId: qz.id });
  // 快捷记分（无题目归属）不该计入题目统计
  S.recordResult({ sid: id(s1), tier: 'improve', result: 'correct', source: 'quick' });

  const stats = A.questionStats(S.get(), qz.id);
  eq(stats.length, 2, '只统计有题目归属的流水（快捷记分不算）');
  // 排序：正确率升序 → q2（0%）在前
  eq(stats[0].qid, q2.id, '最需要讲评的排最前');
  eq(stats[0].correctRate, 0, 'q2 正确率 0%');
  eq(stats[0].attempts, 3, 'q2 三人作答');
  eq(stats[0].wrong, 2, 'q2 两人答错');
  eq(stats[0].skip, 1, 'q2 一人跳过');
  eq(stats[0].tierLabel, '拔高题', '带题型中文名');
  eq(stats[0].stem.indexOf('全班都不会') >= 0, true, '带题干（截断后仍可辨识）');
  eq(stats[0].missers.length, 3, '三人都在 missers 里（含跳过的）');
  eq(stats[0].avgPoints, 0, 'q2 平均得分 0');

  eq(stats[1].qid, q1.id, 'q1 正确率更高，排在后面');
  eq(stats[1].correctRate, 67, 'q1 正确率 2/3 → 67%');
  eq(stats[1].correct, 2, 'q1 答对 2 人');
  eq(stats[1].missers.length, 1, 'q1 只有丙答错');

  // 半对折算（掌握度）
  S.recordResult({ sid: id(s1), qid: q2.id, tier: 'advanced', result: 'half', quizId: qz.id, by: 'teacher' });
  const stats2 = A.questionStats(S.get(), qz.id);
  const q2b = stats2.find((x) => x.qid === q2.id);
  eq(q2b.attempts, 4, '补一条半对后 q2 作答 4 次');
  eq(q2b.creditRate, 13, '半对按 0.5 折算：0.5/4 → 13%');

  // 课后结论
  const line = A.questionReviewLine(stats);
  ok(line && line.indexOf('共 2 道有作答') >= 0, '结论含题目数：' + line);
  ok(line.indexOf('全班都不会') >= 0, '结论点名最需要讲评的题');
  ok(line.indexOf('无人答对') >= 0, '全班没人对的题单独点出');
  eq(A.questionReviewLine([]), null, '没有作答 → 不给结论');

  // 学情总结里要带上题目维度与讲评顺序
  const sum = A.summarizeClass(S.get(), 'all');
  const joined = sum.lines.join('\n');
  ok(joined.indexOf('最需要讲评的是') >= 0, '学情总结含题目维度结论');
  ok(joined.indexOf('讲评顺序建议') >= 0, '学情总结给出讲评顺序');
  ok(Array.isArray(sum.questionStats), '总结里带回题目统计（供界面直接用）');

  // 全部流水（不限定试卷）也要能统计
  const allStats = A.questionStats(S.get(), null);
  eq(allStats.length, 2, '不限定试卷时统计全部流水里的题');
})();

/* ================= 16. 错题本 ================= */
group('错题本（按学生汇总答错/跳过）');

(function () {
  const A = CI.analysis;
  S.replaceState(S.defaultState());
  const teams = S.get().teams;
  const a = S.addStudent('甲', teams[0].id);
  const b = S.addStudent('乙', teams[0].id);
  const c = S.addStudent('丙', teams[1].id);
  const id = (x) => (typeof x === 'string' ? x : x.id);

  const q1 = S.addQuestion({ stem: '第一题', tier: 'basic', options: ['甲', '乙'], answer: 'A' });
  const q2 = S.addQuestion({ stem: '第二题', tier: 'advanced', answer: '2x' });
  const qz = S.createQuiz('随堂测', [q1.id, q2.id]);

  // 甲：q1 错两次（最后一次选了 B）、q2 跳过；乙：q1 错一次；丙：全对
  S.recordResult({ sid: id(a), qid: q1.id, tier: 'basic', result: 'wrong', quizId: qz.id, note: 'A. 甲' });
  S.recordResult({ sid: id(a), qid: q1.id, tier: 'basic', result: 'wrong', quizId: qz.id, note: 'B. 乙' });
  S.recordResult({ sid: id(a), qid: q2.id, tier: 'advanced', result: 'skip', quizId: qz.id, note: '跳过' });
  S.recordResult({ sid: id(b), qid: q1.id, tier: 'basic', result: 'wrong', quizId: qz.id, note: 'B. 乙' });
  S.recordResult({ sid: id(c), qid: q1.id, tier: 'basic', result: 'correct', quizId: qz.id, note: 'A. 甲' });
  S.recordResult({ sid: id(c), qid: q2.id, tier: 'advanced', result: 'half', quizId: qz.id, note: 'x' });

  const mine = A.studentMistakes(S.get(), id(a));
  eq(mine.name, '甲', '错题本带姓名');
  eq(mine.teamName, teams[0].name, '错题本带队伍');
  eq(mine.items.length, 2, '甲有两道错题（q1 错两次只占一条）');
  eq(mine.items[0].qid, q1.id, '错两次的排前面');
  eq(mine.items[0].count, 2, 'q1 错了两次');
  eq(mine.items[0].answer, 'B. 乙', '取最后一次提交的内容');
  eq(mine.items[0].tierLabel, '基础题', '带题型中文名');
  eq(mine.items[0].expected.length > 0, true, '带标准答案：' + mine.items[0].expected);
  eq(mine.items[1].qid, q2.id, '跳过的那题也在错题本里');
  eq(mine.items[1].result, 'skip', '记下是跳过');
  eq(mine.tiers.length, 2, '错题涉及两个题型');

  // 全对的学生没有错题
  const cMine = A.studentMistakes(S.get(), id(c));
  eq(cMine.items.length, 0, '半对不算错题，丙没有错题');

  // 全班错题榜：错题多的在前
  const board = A.mistakeBoard(S.get());
  eq(board.length, 2, '只有甲、乙有错题');
  eq(board[0].name, '甲', '甲错 3 次排第一');
  eq(board[1].name, '乙', '乙错 1 次排第二');

  // 题被删了也要能列（流水还在）
  S.removeQuestion(q2.id);
  const afterDelete = A.studentMistakes(S.get(), id(a));
  const gone = afterDelete.items.find((x) => x.qid === q2.id);
  ok(gone && gone.stem.indexOf('题目已删除') >= 0, '题删了仍列出并标注：' + (gone && gone.stem));
})();

/* ================= 17. 课后课堂报告 ================= */
group('课后课堂报告（Markdown 汇总）');

(function () {
  const A = CI.analysis;
  S.replaceState(S.defaultState());
  const teams = S.get().teams;
  const a = S.addStudent('甲', teams[0].id);
  const b = S.addStudent('乙', teams[0].id);
  const id = (x) => (typeof x === 'string' ? x : x.id);
  S.updateSettings({ courseName: '24机械高考公开课' });

  const q1 = S.addQuestion({ stem: '第一题：1+1=?', tier: 'basic', answer: 'A' });
  const qz = S.createQuiz('随堂测', [q1.id]);
  S.recordResult({ sid: id(a), qid: q1.id, tier: 'basic', result: 'correct', quizId: qz.id });
  S.recordResult({ sid: id(b), qid: q1.id, tier: 'basic', result: 'half', quizId: qz.id });

  const rep = A.classReport(S.get(), {
    generatedAt: 1700000000000,
    room: 'default',
    checkin: { seated: 1, total: 2, rate: 50 }
  });
  const d = rep.data;
  eq(d.courseName, '24机械高考公开课', '报告带课程名');
  eq(d.attempts, 2, '两次作答');
  eq(d.correct, 1, '一次答对');
  eq(d.half, 1, '一次半对');
  eq(d.creditRate, 75, '(1 + 0.5) / 2 = 75%');
  eq(d.checkin.rate, 50, '签到率来自入参');
  eq(d.students.length, 2, '两个学生');
  eq(d.students[0].name, '甲', '按积分降序');

  const md = rep.markdown;
  ok(md.startsWith('# 课堂报告 · 24机械高考公开课'), '标题带课程名');
  ok(md.indexOf('## 一、出勤') >= 0, '有出勤节');
  ok(md.indexOf('签到 **1 / 2 队**（50%）') >= 0, '出勤行：' + md.split('\n').slice(5, 8).join(' / '));
  ok(md.indexOf('## 二、整体') >= 0, '有整体节');
  ok(md.indexOf('作答 **2 题次**') >= 0, '整体行含作答数');
  ok(md.indexOf('整体掌握度 **75%**') >= 0, '整体行含掌握度');
  ok(md.indexOf('## 四、题型掌握') >= 0, '有题型节');
  ok(md.indexOf('## 五、题目正确率（讲评顺序）') >= 0, '有题目节');
  ok(md.indexOf('## 六、学生表现') >= 0, '有学生节');
  ok(md.indexOf('| 1 | 甲 |') >= 0, '学生表格有甲');
  ok(md.indexOf('生成于 2023-11-15 06:13') >= 0, '时间按东八区格式化：' + (md.match(/生成于 [^\n]*/) || [])[0]);
  ok(md.endsWith('由课堂积分系统生成（Rust 核心 ci-domain::report）*\n'), '结尾署名');

  // 空课堂也要能出报告（不能崩）
  const empty = A.classReport(S.defaultState(), { generatedAt: 0 });
  ok(empty.markdown.indexOf('本节课没有作答数据') >= 0, '没有数据时给出说明');
  ok(empty.markdown.indexOf('## 五、题目正确率') < 0, '没有题目数据就不出该节');
  // 连队伍都没有时（签到总数 0）走另一条分支
  const noTeams = S.defaultState();
  noTeams.teams = [];
  noTeams.students = [];
  const bare = A.classReport(noTeams, { generatedAt: 0 });
  ok(bare.markdown.indexOf('还没有队伍数据') >= 0, '没有队伍时给出说明');
  eq(bare.data.checkin.total, 0, '没有队伍时签到总数为 0');

  // 各队对比：有两个队时才出这一节
  S.recordResult({ sid: id(a), qid: q1.id, tier: 'basic', result: 'correct', quizId: qz.id });
  const withTeams = A.classReport(S.get(), { generatedAt: 1 });
  ok(withTeams.markdown.indexOf('## 三、各队对比') >= 0, '有队伍数据时出对比节');
})();

/* ================= 18. 评价口径（等级统一 / 样本量 / 课次边界 / 反馈三件套） ================= */
group('评价口径：等级统一 · 样本量 · 课次边界');

(function () {
  const A = CI.analysis;
  S.replaceState(S.defaultState());
  const team = S.get().teams[0].id;
  const sid = (x) => (typeof x === 'string' ? x : x.id);

  /* ---- ① 等级统一：明细评定与能力等级必须是同一个 ---- */
  const mk = (name, records) => {
    const stu = S.addStudent(name, team);
    records.forEach(([tier, result]) => S.recordResult({ sid: sid(stu), tier, result }));
    return sid(stu);
  };
  const idAll = mk('全对型', [['basic', 'correct'], ['basic', 'correct'], ['advanced', 'correct'], ['advanced', 'correct'], ['extended', 'correct'], ['extended', 'correct'], ['improve', 'correct'], ['improve', 'correct']]);
  const idSome = mk('只做基础', [['basic', 'correct'], ['basic', 'correct'], ['basic', 'correct'], ['basic', 'correct'], ['basic', 'correct']]);
  const idOne = mk('偏科型', [['basic', 'correct'], ['basic', 'correct'], ['advanced', 'correct'], ['advanced', 'correct'], ['extended', 'wrong'], ['extended', 'wrong'], ['improve', 'wrong'], ['improve', 'wrong']]);

  const lvAll = A.studentStats(S.get(), idAll).level;
  eq(lvAll.label, '六边形战士', '全对型学生：明细评定就是自己的能力等级（不再另搞一套 4 档）');
  eq(lvAll.key, 'hexagon', '等级 key 与雷达同一套');
  // 逐个学生比对（同一状态里各人的等级由各自数据决定，这里直接看"同一口径"这件事）
  const lvSome = A.studentStats(S.get(), idSome).level;
  ok(lvSome.label !== '优秀' && lvSome.label !== '良好',
    '只做基础题的学生不会再被判「优秀」（旧口径会，与雷达的「稳步提升」自相矛盾）→ 现在：' + lvSome.label);
  const lvOne = A.studentStats(S.get(), idOne).level;
  ok(lvOne.label !== '需重点关注',
    '偏科型学生不会再被判「需重点关注」（旧口径会，与雷达的「偏科尖子」矛盾）→ 现在：' + lvOne.label);
  ok(!!lvOne.short && lvOne.short.length <= 2, '等级带短标签（S/A/B+…）：' + lvOne.short);

  /* ---- ② 样本量下限：minSample 默认 5 ---- */
  eq(S.get().settings.minSample, 5, '默认最少样本量已从 2 提到 5');
  S.replaceState(S.defaultState());
  const few = S.addStudent('只答两题', S.get().teams[0].id);
  S.recordResult({ sid: sid(few), tier: 'basic', result: 'wrong' });
  S.recordResult({ sid: sid(few), tier: 'basic', result: 'wrong' });
  eq(A.studentStats(S.get(), sid(few)).level.label, '数据不足', '只答 2 题 → 数据不足（旧口径会给「需要重点辅导」）');
  eq(A.ability(S.get(), {}).grade.key, 'insufficient', '能力等级同样是 insufficient');

  /* ---- ③ 课次边界：报告/错题本默认只看本节课 ---- */
  S.replaceState(S.defaultState());
  const stu = S.addStudent('甲', S.get().teams[0].id);
  const q1 = S.addQuestion({ stem: '第一节课的题', tier: 'basic', answer: 'A' });
  const q2 = S.addQuestion({ stem: '第二节课的题', tier: 'advanced', answer: 'B' });
  const quiz1 = S.createQuiz('第一节课', [q1.id]);
  S.recordResult({ sid: sid(stu), qid: q1.id, tier: 'basic', result: 'correct', quizId: quiz1.id });
  const quiz2 = S.createQuiz('第二节课', [q2.id]);
  S.recordResult({ sid: sid(stu), qid: q2.id, tier: 'advanced', result: 'wrong', quizId: quiz2.id });
  S.setCurrentQuiz(quiz2.id);

  const repNow = A.classReport(S.get(), {});
  eq(repNow.data.attempts, 1, '报告默认只看本节课（当前试卷）→ 只统计 1 次作答');
  eq(repNow.data.creditRate, 0, '本节课只答错一题 → 掌握度 0%');
  ok(repNow.markdown.indexOf('第二节课的题') >= 0, '题目表只有本节课的题');
  ok(repNow.markdown.indexOf('第一节课的题') < 0, '不含上一节课的题');
  const repAll = A.classReport(S.get(), { quizId: null });
  eq(repAll.data.attempts, 2, '显式传 quizId:null → 统计全部课次');
  eq(repAll.data.creditRate, 50, '全部课次：1 对 1 错 → 50%');

  // 错题本同理
  const mkNow = A.mistakeBoard(S.get());
  eq(mkNow.length, 1, '错题本默认只看本节课');
  eq(mkNow[0].items.length, 1, '本节课只有一道错题');
  eq(mkNow[0].items[0].stem.indexOf('第二节课') >= 0, true, '错的是第二节课那道题');
  const mkAll = A.mistakeBoard(S.get(), { quizId: null });
  eq(mkAll[0].items.length, 1, '全部课次也只有那一道错题（第一节课答对了）');

  // 学生统计也支持范围
  eq(A.studentStats(S.get(), sid(stu), { quizId: quiz2.id }).total.attempts, 1, '学生统计按试卷过滤');
  eq(A.studentStats(S.get(), sid(stu)).total.attempts, 2, '不给范围时统计全部课次');

  /* ---- ④ 反馈三件套：快照在公布答案后才下发"为什么" ---- */
  S.replaceState(S.defaultState());
  const q3 = S.addQuestion({ stem: '带解析的题', tier: 'basic', answer: 'A', note: '易错点：别忘了先通分' });
  const qz3 = S.createQuiz('本节课', [q3.id]);
  S.setCurrentQuiz(qz3.id);
  S.setRuntime({ qid: q3.id, quizId: qz3.id });   // 快照按 runtime 里的"当前题"取题
  const payloadBefore = CI.sync.snapshot().meta;
  eq(payloadBefore.question.explanation, '', '没公布答案时不下发解析（否则等于泄题）');
  eq(payloadBefore.question.answerKey, null, '没公布答案时也不下发答案');
  CI.classroom.setReveal(true);   // 公布答案（用课堂模块的接口，与教师端点按钮同一条路径）
  const payloadAfter = CI.sync.snapshot().meta;
  ok(payloadAfter.question.explanation.indexOf('先通分') >= 0, '公布答案后下发解析：' + payloadAfter.question.explanation);
  ok(!!payloadAfter.question.answerKey, '公布答案后同时下发正确答案');
})();

/* ================= 19. 多维度评价（正确性 / 参与度 / 进步） ================= */
group('多维度评价');

(function () {
  const A = CI.analysis;

  /* ---- 参与度：答错也算参与 ---- */
  eq(A.participationRate(5, 5), 100, '全答了 → 100%');
  eq(A.participationRate(3, 5), 60, '答了 3/5 → 60%');
  eq(A.participationRate(0, 5), 0, '一道没答 → 0%');
  eq(A.participationRate(3, 0), 0, '没有题时不给分（也不崩）');
  eq(A.participationRate(9, 5), 100, '答多了不超过 100%');

  /* ---- 进步：与自己比 ---- */
  eq(A.growthScore(50, 50, true), 50, '持平 = 50 分');
  eq(A.growthScore(40, 70, true), 80, '进步 30 个点 → 80 分');
  eq(A.growthScore(70, 40, true), 20, '退步 30 个点 → 20 分（不是 0 分，它是相对自己的信号）');
  eq(A.growthScore(0, 100, true), 100, '封顶 100');
  eq(A.growthScore(100, 0, true), 0, '下限 0');
  eq(A.growthScore(40, 70, false), 0, '样本不足 → 0（由 valid=false 决定不计入）');

  /* ---- 衰减平均掌握度：看重"现在会什么" ---- */
  const recs = (list) => list.map((r, i) => ({ sid: 's1', qid: 'q1', result: r, at: i + 1, tier: 'basic' }));
  eq(A.decayedRate(recs(['wrong', 'wrong', 'wrong', 'correct']), 0.5, 0.65), 65,
    '先错三次后答对 → 65（累计平均只有 25，这就是"看重最近"的意义）');
  eq(A.decayedRate(recs(['wrong', 'wrong', 'wrong', 'correct']), 0.5, 1), 100, 'decay=1 → 完全看最近一次');
  eq(A.decayedRate(recs(['wrong', 'wrong', 'wrong', 'correct']), 0.5, 0), 0, 'decay=0 → 完全看此前平均');
  eq(A.decayedRate(recs(['correct', 'correct', 'correct', 'wrong']), 0.5, 0.65), 35,
    '反过来：先对三次后答错 → 35（最近一次 0×0.65 + 此前平均 1×0.35）');
  eq(A.decayedRate(recs(['half', 'half']), 0.5, 0.65), 50, '两次半对 → 50');
  eq(A.decayedRate(recs(['half', 'half']), 0.4, 0.65), 40, '半对系数 0.4 → 40');
  eq(A.decayedRate(recs(['correct']), 0.5, 0.65), 100, '只有一条流水');
  eq(A.decayedRate([], 0.5, 0.65), 0, '没有流水 → 0');
  eq(A.decayedRate(recs(['correct', 'manual', 'wrong']), 0.5, 0.65), 35,
    '手动加减不进分子分母（剩下 对→错 两条：0×0.65 + 1×0.35）');

  /* ---- 三维加权与下钻 ---- */
  const w = { mastery: 60, participation: 25, growth: 15 };
  const e = A.evaluate(80, 100, 60, true, w);
  eq(e.total, 82, '80×0.6 + 100×0.25 + 60×0.15 = 82');
  eq(e.parts.length, 3, '三个维度可下钻');
  eq(e.parts[0].contribution, 48, '正确性贡献 48');
  eq(e.parts[1].contribution, 25, '参与度贡献 25');
  eq(e.parts[2].contribution, 9, '进步贡献 9');
  eq(e.weightUsed, 100, '三个维度都有效时权重和 100');

  // 失效维度要重归一，否则"数据不足"会被凭空扣掉 15 分
  const e2 = A.evaluate(80, 100, 0, false, w);
  eq(e2.weightUsed, 85, '进步维度失效 → 有效权重 85');
  eq(e2.parts[2].valid, false, '进步维度标为无效');
  eq(e2.parts[2].contribution, 0, '无效维度贡献 0');
  ok(e2.total > 80, '剔除后重新归一，总分不会被压到 80 以下（实际 ' + e2.total + '）');
  eq(e2.total, Math.round(80 * 60 / 85 + 100 * 25 / 85), '重归一算法：按有效权重比例分摊');

  // 权重可配置（调研：权重没有实证最优值，属课程政策）
  const e3 = A.evaluate(0, 100, 50, true, { mastery: 20, participation: 60, growth: 20 });
  eq(e3.total, 70, '改成"参与为主"的权重 → 0×0.2 + 100×0.6 + 50×0.2 = 70');
  const e4 = A.evaluate(50, 50, 50, true, { mastery: 0, participation: 0, growth: 0 });
  eq(e4.total, 0, '全 0 权重不能除零');
  eq(e4.weightUsed, 0, '全 0 权重时有效权重为 0');

  /* ---- 整链路：从状态里算一个学生的综合表现 ---- */
  S.replaceState(S.defaultState());
  const team = S.get().teams[0].id;
  const sid = (x) => (typeof x === 'string' ? x : x.id);
  const stu = S.addStudent('小明', team);
  const qs = [];
  for (let i = 0; i < 4; i++) qs.push(S.addQuestion({ stem: '第' + (i + 1) + '题', tier: 'basic', answer: 'A' }));
  const qz = S.createQuiz('本节课', qs.map((q) => q.id));
  S.setCurrentQuiz(qz.id);
  // 前两题错、后两题对（"越学越好"）
  S.recordResult({ sid: sid(stu), qid: qs[0].id, tier: 'basic', result: 'wrong', quizId: qz.id });
  S.recordResult({ sid: sid(stu), qid: qs[1].id, tier: 'basic', result: 'wrong', quizId: qz.id });
  S.recordResult({ sid: sid(stu), qid: qs[2].id, tier: 'basic', result: 'correct', quizId: qz.id });
  S.recordResult({ sid: sid(stu), qid: qs[3].id, tier: 'basic', result: 'correct', quizId: qz.id });

  const ev = A.studentEvaluation(S.get(), sid(stu), { quizId: qz.id });
  eq(ev.answered, 4, '答了 4 道题');
  eq(ev.totalQuestions, 4, '本节课共 4 道题');
  eq(ev.participation, 100, '参与度 100%');
  eq(ev.growthEarly, 0, '前半段掌握度 0（两题都错）');
  eq(ev.growthLate, 100, '后半段掌握度 100（两题都对）');
  eq(ev.growth, 100, '进步分 100（从 0 到 100）');
  eq(ev.mastery, 77, '衰减平均 77（最近一次 1×0.65 + 此前三次均值 0.33×0.35），累计口径只有 50');
  ok(ev.total > 50, '综合表现高于"累计掌握度"，体现"越学越好"：' + ev.total);
  eq(ev.parts[2].value, 100, '下钻能看到进步维度 100');

  // 只答一半的参与度
  S.recordResult({ sid: sid(stu), qid: qs[0].id, tier: 'basic', result: 'correct', quizId: qz.id });
  const ev2 = A.studentEvaluation(S.get(), sid(stu), { quizId: qz.id });
  eq(ev2.participation, 100, '重复作答同一题不增加参与度（按题目去重）');
})();

/* ================= 汇总 ================= */
console.log('\n----------------------------------------');
if (failures.length) {
  console.log(`❌ 失败 ${failures.length} 项 / 通过 ${passed} 项`);
  failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
  process.exit(1);
} else {
  console.log(`✅ 全部通过：${passed} 项断言`);
}
