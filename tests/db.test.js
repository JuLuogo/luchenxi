/*!
 * tests/db.test.js — 教师端本地 SQLite 持久层测试（Node 内置 node:sqlite）
 *   node tests/db.test.js
 * 覆盖：建库/建表、状态投影、流水与积分视图、备份导出/导入、房间隔离、性能抽样
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const hubdb = require(path.join(__dirname, '..', 'packages', 'db', 'hub-db.js'));

let passed = 0;
const failures = [];
function ok(cond, label) { if (cond) passed++; else failures.push(label); }
function eq(a, b, label) {
  const x = JSON.stringify(a), y = JSON.stringify(b);
  if (x === y) passed++; else failures.push(label + '  →  期望 ' + y + '，实际 ' + x);
}
function group(n) { console.log('\n== ' + n + ' =='); }

if (!hubdb.available) {
  // 审计发现：原来这里 exit 0 —— 整层 SQLite 持久化测试**静默跳过**，
  // "全部通过"是假的（CI 固定 Node 24，真不可用说明环境不对，应当红）。
  console.error('✘ 当前 Node 不支持 node:sqlite（需要 Node 22+）—— 持久化测试无法运行');
  process.exit(1);
}

/* ---------- 造一份与前端一致的 state ---------- */
function makeState(roomTag) {
  const now = Date.now();
  const t1 = { id: 'tm_1', name: '红队', icon: '🔴', color: '#e74c3c', order: 0 };
  const t2 = { id: 'tm_2', name: '蓝队', icon: '🔵', color: '#3498db', order: 1 };
  const s1 = { id: 'st_1', name: '张三', teamId: 'tm_1', active: true, joinedAt: now };
  const s2 = { id: 'st_2', name: '李四', teamId: 'tm_1', active: true, joinedAt: now };
  const s3 = { id: 'st_3', name: '王五', teamId: 'tm_2', active: false, joinedAt: now };
  const q1 = { id: 'q_1', tier: 'basic', points: null, stem: '1+1=?', answer: '2', options: [], tags: ['数与式'], source: '课本', note: '', archived: false, createdAt: now };
  const q2 = { id: 'q_2', tier: 'advanced', points: 6, stem: '选择题', answer: 'B', options: ['甲', '乙'], tags: [], source: '', note: '', archived: false, createdAt: now };
  const rec = (id, sid, qid, tier, result, points, base, source, at) => ({
    id, sid, qid, tier, quizId: 'qz_1', result, base, ratio: result === 'half' ? 0.5 : (result === 'correct' ? 1 : 0),
    points, source, note: '', at, by: source
  });
  return {
    version: 3, rev: 7, updatedAt: now,
    settings: { courseName: '24机械高考公开课' + roomTag, halfRatio: 0.5, wrongPenalty: 0, fastBonus: 0, weakThreshold: 0.6, strongThreshold: 0.85, minSample: 2 },
    tiers: [
      { key: 'basic', label: '基础题', weight: 3, color: '#66bb6a', desc: '基础' },
      { key: 'advanced', label: '拔高题', weight: 5, color: '#42a5f5', desc: '拔高' }
    ],
    tags: ['数与式'],
    teams: [t1, t2],
    students: [s1, s2, s3],
    bank: [q1, q2],
    quizzes: [
      { id: 'qz_1', name: '第一次随堂测', note: '', createdAt: now, closedAt: 0, questionIds: ['q_1', 'q_2'],
        records: [
          rec('rc_1', 'st_1', 'q_1', 'basic', 'correct', 3, 3, 'rollcall', now - 5000),
          rec('rc_2', 'st_1', 'q_2', 'advanced', 'half', 3, 6, 'student', now - 4000),
          rec('rc_3', 'st_2', 'q_1', 'basic', 'wrong', 0, 3, 'student', now - 3000),
          rec('rc_4', 'st_2', null, '', 'manual', -1, -1, 'manual', now - 2000)
        ] },
      { id: 'qz_c', name: '快捷记分（课堂零散加减）', note: '', createdAt: now, closedAt: 0, questionIds: [],
        records: [rec('rc_5', 'st_3', null, 'basic', 'correct', 3, 3, 'quick', now - 1000)] }
    ],
    currentQuizId: 'qz_1',
    rollcall: { mode: 'even', scope: 'all', excludeAnswered: true, recentExclude: 1,
      history: [{ id: 'rl_1', sid: 'st_1', at: now - 6000, quizId: 'qz_1', qid: 'q_1' }], roundPool: ['st_2'], round: 2 },
    logs: [{ ts: now - 7000, type: '记分', detail: '张三 +3' }],
    classroom: {
      pending: [{ id: 'pd_1', sid: 'st_1', teamId: 'tm_1', qid: 'q_2', quizId: 'qz_1', answer: '略', auto: false, at: now - 1500 }],
      buzz: [{ id: 'bz_1', teamId: 'tm_2', qid: 'q_2', sid: 'st_3', at: now - 1400, by: '学生端' }],
      feed: [{ id: 'fd_1', at: now - 1300, kind: 'answer', teamId: 'tm_1', sid: 'st_1', qid: 'q_2', result: 'half', answer: '略', expected: 'B', points: 3, auto: true, text: '张三 答对一半' }]
    },
    runtime: { quizId: 'qz_1', qid: 'q_1', sid: 'st_1', accepting: true, reveal: false, revealedQid: null }
  };
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-db-'));
const file = path.join(dir, 'classroom.db');
const store = hubdb.createStore({ file: file });

/* ================= 1. 建库与保存 ================= */
group('建库与状态投影');
ok(fs.existsSync(file), '数据库文件已创建');

const S1 = makeState('·A');
let saved = store.saveRoom('roomA', { rev: 7, state: S1, dump: S1 });
eq(saved.rev, 7, 'saveRoom 返回 rev');

const st = store.stats();
eq(st.rooms, 1, 'rooms 1 行');
eq(st.teams, 2, 'teams 投影 2 行');
eq(st.students, 3, 'students 投影 3 行');
eq(st.questions, 2, 'questions 投影 2 行');
eq(st.quizzes, 2, 'quizzes 投影 2 行');
eq(st.records, 5, 'records 投影 5 行');
ok(st.logs >= 1, 'logs 已写入');

/* ================= 2. 读回一致 ================= */
group('读回与前端 state 同构');
const back = store.loadRoom('roomA');
eq(back.rev, 7, '读回 rev');
eq(back.state.settings.courseName, '24机械高考公开课·A', 'state 读回内容一致');
eq(back.dump.students.length, 3, 'dump 读回学生数一致');
eq(back.dump.quizzes[0].records.length, 4, 'dump 读回流水一致');
eq(back.dump.rollcall.round, 2, 'rollcall 状态保留');
eq(back.dump.classroom.pending.length, 1, 'classroom.pending 保留');

/* ================= 3. 选项/题型等字段 ================= */
group('字段级校验');
const q = store.raw.prepare('SELECT * FROM questions WHERE room_id=? AND id=?').get('roomA', 'q_2');
eq(q.answer, 'B', '选择题答案落库');
eq(JSON.parse(q.options), ['甲', '乙'], '选项以 JSON 落库');
eq(q.points, 6, '自定义分值落库');
const stu3 = store.raw.prepare('SELECT active FROM students WHERE room_id=? AND id=?').get('roomA', 'st_3');
eq(stu3.active, 0, '停用学生 active=0');

/* ================= 4. 积分与学情视图 ================= */
group('积分与统计视图');
const scores = store.scores('roomA');
const m = {}; scores.forEach((r) => { m[r.sid] = r.score; });
eq(m.st_1, 6, '张三 3+3=6 分（含手动/快捷口径一致）');
eq(m.st_2, -1, '李四 0-1=-1 分');
eq(m.st_3, 3, '王五 快捷加分 3 分');
eq(scores[0].sid, 'st_1', '总分降序');

const tiers = store.studentTier('roomA');
const t1 = tiers.filter((r) => r.sid === 'st_1' && r.tier === 'basic')[0];
eq(t1.attempts, 1, '视图：张三基础题作答 1 次');
eq(t1.correct, 1, '视图：答对 1');
eq(t1.earned, 3, '视图：得分 3');
const t2 = tiers.filter((r) => r.sid === 'st_1' && r.tier === 'advanced')[0];
eq(t2.half, 1, '视图：拔高题部分正确 1');
ok(!tiers.some((r) => r.tier === ''), '视图排除手动分（tier 为空）');

/* ================= 5. 覆盖写与房间隔离 ================= */
group('覆盖写与房间隔离');
const S2 = makeState('·B');
S2.students = S2.students.slice(0, 1);
S2.quizzes[0].records = S2.quizzes[0].records.slice(0, 1);
S2.quizzes = [S2.quizzes[0]];
store.saveRoom('roomB', { rev: 1, state: S2, dump: S2 });

const stB = store.stats();
eq(stB.students, 4, '两个房间的学生各算各的（3+1）');
eq(stB.records, 6, '两个房间的流水合并计数（5+1）');
eq(store.loadRoom('roomA').dump.students.length, 3, 'roomA 数据未被 roomB 影响');

// 同房间覆盖写：旧的投影要被清掉，不能残留
const S1b = makeState('·A');
S1b.students = [S1b.students[0]];
S1b.quizzes = [S1b.quizzes[0]];
S1b.quizzes[0].records = S1b.quizzes[0].records.slice(0, 2);
store.saveRoom('roomA', { rev: 8, state: S1b, dump: S1b });
eq(store.raw.prepare('SELECT COUNT(*) c FROM students WHERE room_id=?').get('roomA').c, 1, '覆盖写后学生投影已重建');
eq(store.raw.prepare('SELECT COUNT(*) c FROM records WHERE room_id=?').get('roomA').c, 2, '覆盖写后流水投影已重建');
eq(store.loadRoom('roomA').rev, 8, 'rev 已更新');

/* ================= 6. 备份导出 / 导入 ================= */
group('备份导出与导入');
const backup = store.exportBackup('roomA');
eq(backup.type, 'ci-backup', '导出结构带 ci-backup 标记');
ok(backup.state && backup.state.students.length === 1, '备份内含完整状态');

const fresh = hubdb.createStore({ file: path.join(dir, 'restored.db') });
fresh.importBackup('roomX', JSON.parse(JSON.stringify(backup)));
const rBack = fresh.loadRoom('roomX');
eq(rBack.dump.students.length, 1, '导入到新库后学生数一致');
eq(rBack.dump.quizzes[0].records.length, 2, '导入后流水一致');
eq(fresh.stats().records, 2, '导入后投影已重建');

/* ================= 7. 只推 state（不带 dump）时的行为 ================= */
group('只推轻量快照');
store.saveRoom('roomC', { rev: 3, state: { courseName: '只看不回写' } });
const rc = store.loadRoom('roomC');
eq(rc.state.courseName, '只看不回写', '轻量快照可读');
eq(rc.dump, null, '没有 dump 时不会伪造完整数据');
// 之后再推 dump，投影才建立
store.saveRoom('roomC', { rev: 4, dump: S2 });
eq(store.raw.prepare('SELECT COUNT(*) c FROM students WHERE room_id=?').get('roomC').c, 1, '补推 dump 后投影建立');

/* ================= 8. 容量与性能抽样 ================= */
group('性能抽样（1000 名学生 × 20 条流水）');
const big = makeState('·BIG');
big.students = [];
big.quizzes = [{ id: 'qz_big', name: '压测', note: '', createdAt: Date.now(), closedAt: 0, questionIds: ['q_1'], records: [] }];
for (let i = 0; i < 1000; i++) {
  big.students.push({ id: 'st_b' + i, name: '学生' + i, teamId: i % 2 ? 'tm_1' : 'tm_2', active: true, joinedAt: Date.now() });
  for (let j = 0; j < 20; j++) {
    big.quizzes[0].records.push({
      id: 'rc_b' + i + '_' + j, sid: 'st_b' + i, qid: 'q_1', tier: 'basic', quizId: 'qz_big',
      result: j % 3 === 0 ? 'wrong' : 'correct', base: 3, ratio: 1, points: j % 3 === 0 ? 0 : 3,
      source: 'student', note: '', at: Date.now() + j, by: 'student'
    });
  }
}
const t0 = Date.now();
store.saveRoom('roomBig', { rev: 1, dump: big });
const dtSave = Date.now() - t0;
const t1s = Date.now();
const bigScores = store.scores('roomBig');
const dtQuery = Date.now() - t1s;
ok(dtSave < 5000, '写 2 万条流水耗时 ' + dtSave + 'ms（<5s）');
ok(dtQuery < 500, '总分视图查询耗时 ' + dtQuery + 'ms（<500ms）');
eq(bigScores.length, 1000, '压测：1000 名学生都有分数');
ok(fs.statSync(file).size > 500 * 1024, '数据库文件已写入数据（' + Math.round(fs.statSync(file).size / 1024) + ' KB）');
console.log('  · 写入 2 万条流水 ' + dtSave + 'ms，总分查询 ' + dtQuery + 'ms，库大小 ' + Math.round(fs.statSync(file).size / 1024) + ' KB');

/* ================= 9. 缺字段的"真实脏数据"也不能炸 ================= */
group('缺字段容错（node:sqlite 不接受 undefined）');
{
  const partial = {
    // 故意只给最少字段：新学生没分队伍、题目没选项/来源、流水没有 by、待确认没有 quizId …
    students: [{ id: 'st_x', name: '没队伍的学生' }, { id: 'st_y', name: '另一人', teamId: null }],
    bank: [{ id: 'q_x', stem: '没选项没答案' }],
    quizzes: [{ id: 'qz_x', questionIds: ['q_x'], records: [
      { id: 'rc_x', sid: 'st_x', tier: 'basic', result: 'correct', base: 3, points: 3, at: Date.now() }
    ] }],
    classroom: { pending: [{ id: 'pd_x', sid: 'st_x' }], buzz: [{ id: 'bz_x', teamId: 'tm_x' }], feed: [{ id: 'fd_x', kind: 'system' }] },
    rollcall: { history: [{ id: 'rl_x', sid: 'st_x' }] }
  };
  let err = null;
  try { store.saveRoom('roomPartial', { rev: 1, dump: partial }); } catch (e) { err = e; }
  ok(err === null, '缺字段的状态也能落库（' + (err ? err.message : '无异常') + '）');
  const saved = store.loadRoom('roomPartial');
  ok(saved && saved.dump && saved.dump.students.length === 2, '缺字段状态可读回');
  eq(store.raw.prepare('SELECT COUNT(*) c FROM students WHERE room_id=?').get('roomPartial').c, 2, '两名学生都落库（team_id 为空）');
  eq(store.raw.prepare('SELECT COUNT(*) c FROM records WHERE room_id=?').get('roomPartial').c, 1, '流水落库');
  eq(store.raw.prepare('SELECT COUNT(*) c FROM classroom_feed WHERE room_id=?').get('roomPartial').c, 1, '实时流落库');
  const q = store.raw.prepare('SELECT options, source, answer FROM questions WHERE room_id=? AND id=?').get('roomPartial', 'q_x');
  eq(JSON.parse(q.options), [], '缺 options 时存空数组');
  eq(q.answer, null, '缺 answer 时存 null（不伪造空串）');
  // 备份导出也应可用（之前因整笔事务失败而 404）
  const b2 = store.exportBackup('roomPartial');
  ok(!!b2 && b2.type === 'ci-backup', '缺字段状态的备份可导出（ci-backup）');
  store.raw.prepare('DELETE FROM rooms WHERE room_id=?').run('roomPartial');
}

/* ================= 收尾 ================= */
store.close();
fresh.close();
try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }

console.log('\n----------------------------------------');
if (failures.length) {
  console.log(`❌ 失败 ${failures.length} 项 / 通过 ${passed} 项`);
  failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
  process.exit(1);
} else {
  console.log(`✅ 全部通过：${passed} 项断言`);
}
