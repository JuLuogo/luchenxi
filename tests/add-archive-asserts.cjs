/*! 一次性：加本课归档断言 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const p = path.join(ROOT, 'tests/logic.test.js');
let t = fs.readFileSync(p, 'utf8');
if (t.includes('本课归档')) { console.log('  · 已有'); process.exit(0); }
const EOL = t.includes('\r\n') ? '\r\n' : '\n';
const lines = t.split(/\r?\n/);
const i = lines.findIndex((l) => /================= 汇总 =================/.test(l));
const block = [
  '/* ================= 38. 本课归档（审计 C8） ================= */',
  "group('本课归档');",
  '',
  '(function () {',
  '  /* 痛点：教师机是主库，换电脑/重装/清缓存就丢；听课老师与家长要的是"一份能发出去的东西"。 */',
  "  ok(CI.archive && typeof CI.archive.build === 'function', '有 archive.build');",
  '',
  '  S.replaceState(S.defaultState());',
  '  const st = S.get();',
  '  const t1 = st.teams[0].id;',
  "  S.addStudentsBulk('甲\\n乙', t1);",
  "  S.addQuestion({ stem: '归档题', tier: 'basic', answer: 'A', options: ['x', 'y'], note: '解析' });",
  '  const q = S.get().bank[0];',
  '  S.setRuntime({ qid: q.id });',
  "  CI.classroom.handleCmd({ kind: 'answer', id: 'ar1', teamId: t1, sid: S.get().students[0].id, qid: q.id, choice: ['A'] }, false, null);",
  '',
  "  const pack = CI.archive.build(S.get(), { now: new Date('2026-10-05T19:30:00') });",
  "  ok(!!pack.name && !!pack.json, 'build 返回文件名与内容');",
  "  ok(/^课堂归档-.*-20261005-1930\\.json$/.test(pack.name), '文件名带日期戳（可直接归档/排序）：' + pack.name);",
  '',
  '  const data = JSON.parse(pack.json);',
  "  eq(data.format, 'ci-archive', '有格式标记（将来可识别/迁移）');",
  "  eq(data.counts.students, 2, '统计到 2 名学生');",
  "  eq(data.counts.records, 1, '统计到 1 条流水');",
  "  ok(!!data.state && Array.isArray(data.state.students), '含完整 state（换电脑能恢复）');",
  "  ok(typeof data.report === 'string', '含课堂报告（Markdown，直接能读/打印）');",
  "  ok(Array.isArray(data.students) && data.students.length === 2, '含每人的小结与错题');",
  "  ok('summary' in data.students[0] && 'mistakes' in data.students[0], '每人条目有小结与错题字段');",
  "  ok(!!data.archivedAtText, '含人类可读的归档时间：' + data.archivedAtText);",
  '',
  '  /* 上次归档提示（老师最容易忘这件事） */',
  '  CI.archive.noteArchived(new Date(\'2026-10-01T10:00:00\').getTime());',
  "  eq(CI.archive.daysSinceArchive(new Date('2026-10-05T10:00:00').getTime()), 4, '能算出「上次归档 4 天前」');",
  "  ok(CI.archive.stamp(new Date('2026-01-02T03:04:00')) === '20260102-0304', '日期戳补零正确');",
  '})();',
  ''
];
lines.splice(i, 0, ...block);
fs.writeFileSync(p, lines.join(EOL), 'utf8');
console.log('  [ok] 插入归档断言（第 ' + (i + 1) + ' 行前）');
