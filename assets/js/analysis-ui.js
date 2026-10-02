/*!
 * analysis-ui.js — 学情分析界面：班级/队伍概览、题型矩阵、学生明细、文字总结与导出
 * 渲染容器（admin.html 提供）：#analysisScope #analysisOverview #analysisMatrix #analysisStudents #analysisModal
 */
(function (root) {
  'use strict';

  var CI = root.CI = root.CI || {};
  var U = CI.util;
  var doc = root.document || null;

  var scope = 'all';
  var lastSummary = { class: null, students: [] };

  function el(id) { return doc ? doc.getElementById(id) : null; }

  function studentOptions() {
    var s = CI.store.get();
    return CI.store.studentsOf(s, scope === 'all' ? 'all' : scope).map(function (stu) {
      return '<option value="' + stu.id + '">' + U.escapeHTML(stu.name) + '</option>';
    }).join('');
  }

  function renderScope() {
    var s = CI.store.get();
    var box = el('analysisScope');
    if (!box) return;
    box.innerHTML =
      '<label class="fld"><span>统计范围</span><select id="anaScope" onchange="CI.analysisUI.setScope(this.value)">' +
        '<option value="all"' + (scope === 'all' ? ' selected' : '') + '>全班</option>' +
        s.teams.map(function (t) {
          return '<option value="' + t.id + '"' + (scope === t.id ? ' selected' : '') + '>' + U.escapeHTML(t.name) + '</option>';
        }).join('') +
      '</select></label>' +
      '<label class="fld"><span>查看单个学生</span><select id="anaStudent" onchange="CI.analysisUI.showStudentReport(this.value)">' +
        '<option value="">— 选择学生 —</option>' + studentOptions() + '</select></label>' +
      '<button class="btn btn-plus" onclick="CI.analysisUI.generate()">生成学情总结</button>' +
      '<button class="btn" onclick="CI.analysisUI.copySummary()">复制总结</button>' +
      '<button class="btn" onclick="CI.analysisUI.downloadSummary()">下载总结 (txt)</button>' +
      '<button class="btn" onclick="CI.analysisUI.exportCSV()">导出明细 (csv)</button>';
  }

  function renderOverview() {
    var s = CI.store.get();
    var box = el('analysisOverview');
    if (!box) return;
    var cs = CI.analysis.classStats(s, scope === 'all' ? null : scope);
    var weakNames = cs.weakTiers.map(function (k) {
      var t = cs.tiers.filter(function (x) { return x.key === k; })[0];
      return U.escapeHTML(CI.store.tierOf(s, k).label) + '（' + (t ? t.creditRate : 0) + '%）';
    }).join('、');

    box.innerHTML =
      '<div class="stat-grid">' +
        statCard('学生人数', cs.studentCount + ' 人', '参与作答 ' + cs.participants + ' 人') +
        statCard('累计作答', cs.total.attempts + ' 题次', '答对 ' + cs.total.correct + ' · 部分 ' + cs.total.half + ' · 错 ' + cs.total.wrong + ' · 跳过 ' + cs.total.skip) +
        statCard('整体加权得分率', cs.total.creditRate + '%', '严格正确率 ' + cs.total.correctRate + '%') +
        statCard('累计得分', cs.total.earned + ' 分', '平均每题 ' + (cs.total.attempts ? Math.round((cs.total.earned / cs.total.attempts) * 100) / 100 : 0) + ' 分') +
      '</div>' +
      '<div class="weak-line">' + (weakNames
        ? '⚠ 整体薄弱题型：<b>' + weakNames + '</b>，建议安排专题讲评'
        : '✅ 各题型得分率均在阈值之上' + (cs.total.attempts ? '' : '（暂无数据）')) + '</div>';
  }

  function statCard(title, value, sub) {
    return '<div class="stat-card"><div class="stat-title">' + title + '</div>' +
      '<div class="stat-value">' + value + '</div>' +
      '<div class="stat-sub">' + sub + '</div></div>';
  }

  function renderMatrix() {
    var s = CI.store.get();
    var box = el('analysisMatrix');
    if (!box) return;
    var cs = CI.analysis.classStats(s, scope === 'all' ? null : scope);
    box.innerHTML = '<div class="panel-title">题型掌握情况</div>' +
      '<table class="data-table"><thead><tr>' +
        '<th>题型</th><th>权重</th><th>作答题次</th><th>答对</th><th>部分正确</th><th>答错</th><th>加权得分率</th><th>均分/题</th><th>判定</th>' +
      '</tr></thead><tbody>' +
      cs.tiers.map(function (t) {
        var judge = t.attempts < U.num(s.settings.minSample, 2)
          ? '<span class="tag tag-plain">样本不足</span>'
          : (t.creditRate < U.num(s.settings.weakThreshold, 0.6) * 100
            ? '<span class="tag tag-warn">薄弱</span>'
            : (t.creditRate >= U.num(s.settings.strongThreshold, 0.85) * 100
              ? '<span class="tag tag-good">优势</span>' : '<span class="tag tag-plain">达标</span>'));
        return '<tr>' +
          '<td><span class="tag" style="background:' + t.color + '22;color:' + t.color + '">' + U.escapeHTML(t.label) + '</span></td>' +
          '<td>' + t.weight + ' 分</td>' +
          '<td>' + t.attempts + '</td><td>' + t.correct + '</td><td>' + t.half + '</td><td>' + t.wrong + '</td>' +
          '<td><b>' + t.creditRate + '%</b></td>' +
          '<td>' + (t.attempts ? Math.round((t.earned / t.attempts) * 100) / 100 : 0) + '</td>' +
          '<td>' + judge + '</td>' +
        '</tr>';
      }).join('') + '</tbody></table>';
    renderQuestions();
  }

  /**
   * 按题目正确率（低 → 高）：课后讲评的直接依据
   *
   * 渲染到**独立容器** `#analysisQuestions`（不塞进题型矩阵那个 panel）——
   * 塞进去会让"题型矩阵 4 行"这类既有断言失效，两种维度的表格也会混在一起。
   */
  function renderQuestions() {
    var s = CI.store.get();
    var box = el('analysisQuestions');
    if (!box) return;
    var stats = CI.analysis.questionStats(s, null).filter(function (x) { return x.attempts > 0; });
    if (!stats.length) {
      box.innerHTML = '<div class="panel-title">按题目正确率</div>' +
        '<div class="empty">还没有按题目的作答数据（学生通过试卷作答后，这里会按正确率从低到高列出）</div>';
      return;
    }
    var line = CI.analysis.questionReviewLine(stats);

    box.innerHTML =
      '<div class="panel-title">按题目正确率 <span class="panel-sub">（低 → 高；「未答对」含答错与跳过 —— 这是讲评顺序）</span></div>' +
      (line ? '<div class="hint-inline">' + U.escapeHTML(line) + '</div>' : '') +
      '<div class="table-scroll"><table class="data-table"><thead><tr>' +
        '<th>#</th><th>题目</th><th>题型</th><th>作答</th><th>答对</th><th>部分正确</th><th>未答对</th>' +
        '<th>正确率</th><th>掌握度</th><th>均分</th><th>需要关注的学生</th>' +
      '</tr></thead><tbody>' +
      stats.map(function (x, i) {
        var rateCls = x.correctRate < 40 ? 'tag tag-bad' : (x.correctRate < 70 ? 'tag tag-warn' : 'tag tag-good');
        return '<tr>' +
          '<td>' + (i + 1) + '</td>' +
          '<td>' + U.escapeHTML(x.stem) + '</td>' +
          '<td>' + U.escapeHTML(x.tierLabel) + '</td>' +
          '<td>' + x.attempts + '</td><td>' + x.correct + '</td><td>' + x.half + '</td>' +
          '<td>' + (x.wrong + x.skip) + '</td>' +
          '<td><span class="' + rateCls + '">' + x.correctRate + '%</span></td>' +
          '<td>' + x.creditRate + '%</td>' +
          '<td>' + x.avgPoints + '</td>' +
          '<td>' + (x.missers.length ? U.escapeHTML(x.missers.slice(0, 6).join('、')) + (x.missers.length > 6 ? ' 等 ' + x.missers.length + ' 人' : '') : '—') + '</td>' +
        '</tr>';
      }).join('') + '</tbody></table></div>';
  }

  function renderStudents() {
    var s = CI.store.get();
    var box = el('analysisStudents');
    if (!box) return;
    var rows = CI.analysis.ranking(s, scope === 'all' ? null : scope);

    box.innerHTML = '<div class="panel-title">学生明细 <span class="panel-sub">（按积分排序，得分率低于阈值且样本足够的题型标红）</span></div>' +
      (rows.length ? '<div class="table-scroll"><table class="data-table"><thead><tr>' +
        '<th>名次</th><th>姓名</th><th>队伍</th><th>积分</th><th>作答</th><th>整体得分率</th>' +
        s.tiers.map(function (t) { return '<th>' + U.escapeHTML(t.label) + '</th>'; }).join('') +
        '<th>被点</th><th>评定</th><th></th>' +
        '</tr></thead><tbody>' +
        rows.map(function (r) {
          var cells = s.tiers.map(function (t) {
            var hit = r.tiers.filter(function (x) { return x.key === t.key; })[0];
            if (!hit || !hit.attempts) return '<td class="cell-empty">—</td>';
            var weak = hit.attempts >= U.num(s.settings.minSample, 2) && hit.creditRate < U.num(s.settings.weakThreshold, 0.6) * 100;
            return '<td class="' + (weak ? 'cell-weak' : '') + '">' + hit.creditRate + '%<span class="cell-sub">(' + hit.attempts + '题)</span></td>';
          }).join('');
          return '<tr>' +
            '<td>' + r.rank + '</td>' +
            '<td><b>' + U.escapeHTML(r.name) + '</b></td>' +
            '<td>' + U.escapeHTML(r.teamName) + '</td>' +
            '<td><b>' + r.score + '</b></td>' +
            '<td>' + r.attempts + '</td>' +
            '<td>' + r.creditRate + '%</td>' +
            cells +
            '<td>' + r.rolls + '</td>' +
            '<td><span class="tag" style="background:' + r.level.color + '22;color:' + r.level.color + '">' + r.level.label + '</span></td>' +
            '<td><button class="mini-btn" onclick="CI.analysisUI.showStudentReport(\'' + r.sid + '\')">详情</button></td>' +
          '</tr>';
        }).join('') + '</tbody></table></div>'
        : '<div class="empty">还没有学生</div>');
  }

  function renderSummary() {
    var box = el('analysisSummary');
    if (!box) return;
    if (!lastSummary.class) { box.innerHTML = '<div class="empty">点上方「生成学情总结」，自动为本次课堂生成文字小结</div>'; return; }
    box.innerHTML = '<div class="panel-title">课堂小结</div>' +
      '<pre class="summary-pre">' + U.escapeHTML(lastSummary.class) + '</pre>' +
      (lastSummary.students.length
        ? '<div class="panel-title">个人总结 <span class="panel-sub">（' + lastSummary.students.length + ' 人）</span></div>' +
          '<pre class="summary-pre">' + U.escapeHTML(lastSummary.students.join('\n\n')) + '</pre>'
        : '');
  }

  function render() {
    renderScope();
    renderOverview();
    renderMatrix();
    renderStudents();
    renderSummary();
  }

  function setScope(v) { scope = v || 'all'; render(); }

  function generate() {
    var s = CI.store.get();
    var teamId = scope === 'all' ? null : scope;
    var cls = CI.analysis.summarizeClass(s, teamId);
    var students = CI.store.studentsOf(s, scope === 'all' ? 'all' : scope).map(function (stu) {
      var one = CI.analysis.summarizeStudent(s, stu.id);
      return one ? one.text : '';
    }).filter(Boolean);
    lastSummary = { class: cls.text, students: students };
    renderSummary();
    return lastSummary;
  }

  function showStudentReport(sid) {
    if (!sid) return;
    var s = CI.store.get();
    var rep = CI.analysis.summarizeStudent(s, sid);
    if (!rep) return;
    var st = rep.stats;
    var box = el('analysisModal');
    if (!box) return;

    var tierBars = st.tiers.map(function (t) {
      var w = Math.max(0, Math.min(100, t.creditRate));
      return '<div class="bar-row">' +
        '<span class="bar-label">' + U.escapeHTML(t.label) + '</span>' +
        '<span class="bar-track"><span class="bar-fill" style="width:' + w + '%;background:' + t.color + '"></span></span>' +
        '<span class="bar-val">' + (t.attempts ? (t.creditRate + '%（' + t.correct + '/' + t.attempts + '）') : '未作答') + '</span>' +
      '</div>';
    }).join('');

    box.innerHTML =
      '<div class="modal-mask" onclick="CI.analysisUI.closeReport()"></div>' +
      '<div class="modal-box modal-wide">' +
        '<div class="modal-head"><b>' + U.escapeHTML(st.name) + ' · 学情报告</b>' +
          '<button class="mini-btn" onclick="CI.analysisUI.closeReport()">✕</button></div>' +
        '<div class="modal-body">' +
          '<div class="stat-grid">' +
            statCard('当前积分', st.score + ' 分', st.teamName) +
            statCard('作答题次', st.total.attempts + '', '答对 ' + st.total.correct + ' · 部分 ' + st.total.half + ' · 错 ' + st.total.wrong + ' · 跳过 ' + st.total.skip) +
            statCard('加权得分率', st.total.creditRate + '%', '严格正确率 ' + st.total.correctRate + '%') +
            statCard('被点名', st.rolls + ' 次', '综合评定：' + st.level.label) +
          '</div>' +
          '<div class="panel-title">题型得分率</div>' + (tierBars || '<div class="empty">暂无数据</div>') +
          '<div class="panel-title">文字总结</div>' +
          '<pre class="summary-pre">' + U.escapeHTML(rep.text) + '</pre>' +
        '</div>' +
        '<div class="modal-foot">' +
          '<button class="btn" onclick="CI.analysisUI.copyStudent(\'' + sid + '\')">复制该生总结</button>' +
          '<button class="btn" onclick="CI.analysisUI.closeReport()">关闭</button>' +
        '</div>' +
      '</div>';
    box.style.display = 'flex';
  }

  function closeReport() {
    var box = el('analysisModal');
    if (box) { box.style.display = 'none'; box.innerHTML = ''; }
  }

  function copyStudent(sid) {
    var rep = CI.analysis.summarizeStudent(CI.store.get(), sid);
    if (!rep) return;
    U.copyText(rep.text).then(function () { alert('已复制到剪贴板'); }, function () { alert('复制失败，请手动选择文本'); });
  }

  function currentText() {
    if (!lastSummary.class) generate();
    return lastSummary.class + (lastSummary.students.length ? '\n\n' + lastSummary.students.join('\n\n') : '');
  }

  function copySummary() {
    U.copyText(currentText()).then(function () { alert('已复制到剪贴板'); }, function () { alert('复制失败'); });
  }

  function downloadSummary() {
    var stamp = new Date().toISOString().slice(0, 10);
    U.download('学情总结_' + stamp + '.txt', currentText(), 'text/plain');
  }

  function exportCSV() {
    var s = CI.store.get();
    var rows = CI.analysis.classCSV(s, scope === 'all' ? null : scope);
    U.download('学情明细_' + new Date().toISOString().slice(0, 10) + '.csv', '\ufeff' + U.toCSV(rows), 'text/csv');
  }

  CI.analysisUI = {
    render: render, setScope: setScope, generate: generate,
    showStudentReport: showStudentReport, closeReport: closeReport, copyStudent: copyStudent,
    copySummary: copySummary, downloadSummary: downloadSummary, exportCSV: exportCSV,
    getScope: function () { return scope; },
    getSummary: function () { return lastSummary; }
  };
})(typeof window !== 'undefined' ? window : globalThis);
