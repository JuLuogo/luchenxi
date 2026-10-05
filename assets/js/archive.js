/*!
 * assets/js/archive.js — 本课归档包（审计 C8）
 *
 *   痛点（审计 C8）：教师机是主库，**换电脑 / 重装 / 清缓存就丢**；而且听课老师、
 *   家长要的是"一张纸"。现在只有"导出 JSON 备份"（纯数据）与"导出课堂报告"（纯文字），
 *   没有**一份带日期、能归档、能直接发出去**的东西。
 *
 *   做法：把"这节课"打成一个文件 —— 数据 + 报告 + 错题 + 学生小结，文件名带日期与课次。
 *   浏览器不允许一次下多个文件，所以**打成一个 JSON**（内容齐全，谁都能打开看）。
 *
 *   这是**输入输出**（客户端固有），不是计分规则 —— 所以不需要 Rust 孪生。
 */
(function (root) {
  'use strict';
  var CI = root.CI = root.CI || {};

  var LS_LAST = 'ci_last_archive_at';

  function pad(n) { return n < 10 ? '0' + n : String(n); }

  /** 日期戳：20261005-1930（文件名安全，且按时间排序自然有序） */
  function stamp(d) {
    var x = d || new Date();
    return String(x.getFullYear()) + pad(x.getMonth() + 1) + pad(x.getDate()) +
      '-' + pad(x.getHours()) + pad(x.getMinutes());
  }

  /** 中文日期：2026-10-05 19:30 */
  function human(d) {
    var x = d || new Date();
    return x.getFullYear() + '-' + pad(x.getMonth() + 1) + '-' + pad(x.getDate()) +
      ' ' + pad(x.getHours()) + ':' + pad(x.getMinutes());
  }

  /**
   * 打包一节课
   * @param {object} s 课堂状态（CI.store.get()）
   * @param {object} [opts] { now: Date }
   * @returns {{ name: string, json: string, summary: object }}
   */
  function build(s, opts) {
    var now = (opts && opts.now) || new Date();
    var course = (s.settings && s.settings.courseName) || '课堂积分';
    var recs = CI.store.allRecords(s);
    var report = null;
    try { report = CI.analysis.classReport ? CI.analysis.classReport(s) : null; } catch (e) { report = null; }

    /* 每人的小结（错题 + 评语）—— 归档后即使没有系统也能看懂 */
    var students = (s.students || []).map(function (stu) {
      var row = { id: stu.id, name: stu.name, team: (CI.store.team(s, stu.teamId) || {}).name || '' };
      try {
        var sum = CI.analysis.summarizeStudent(s, stu.id);
        row.summary = sum && (sum.text || (sum.lines || []).join('\n')) || '';
      } catch (e) { row.summary = ''; }
      try {
        row.mistakes = CI.analysis.studentMistakes(s, stu.id);
      } catch (e) { row.mistakes = []; }
      return row;
    });

    var payload = {
      format: 'ci-archive',
      version: 1,
      archivedAt: now.getTime(),
      archivedAtText: human(now),
      courseName: course,
      room: (s.room && s.room.id) || s.room || '',
      counts: {
        students: (s.students || []).length,
        teams: (s.teams || []).length,
        questions: (s.bank || []).length,
        quizzes: (s.quizzes || []).length,
        records: recs.length
      },
      /* ① 报告（Markdown）：直接能读、能打印 */
      report: report && report.markdown ? report.markdown : '',
      /* ② 数据：换电脑时能恢复 */
      state: s,
      /* ③ 学生小结与错题：老师/家长要的那"一张纸" */
      students: students
    };

    return {
      name: '课堂归档-' + course + '-' + stamp(now) + '.json',
      json: JSON.stringify(payload, null, 2),
      summary: payload.counts
    };
  }

  /** 记下这次归档时间（界面提示"上次归档 N 天前"） */
  function noteArchived(at) {
    try { root.localStorage.setItem(LS_LAST, String((at || Date.now()))); } catch (e) { /* 存不下就算了 */ }
  }

  /** 上次归档时间戳（没有则 null） */
  function lastArchivedAt() {
    try {
      var v = root.localStorage.getItem(LS_LAST);
      return v ? Number(v) : null;
    } catch (e) { return null; }
  }

  /** 距上次归档多少天（没归档过返回 null） */
  function daysSinceArchive(now) {
    var last = lastArchivedAt();
    if (!last) return null;
    var ms = (now || Date.now()) - last;
    return Math.floor(ms / 86400000);
  }

  CI.archive = {
    build: build,
    stamp: stamp,
    human: human,
    noteArchived: noteArchived,
    lastArchivedAt: lastArchivedAt,
    daysSinceArchive: daysSinceArchive
  };
})(typeof window !== 'undefined' ? window : globalThis);
