/*!
 * quiz.js — 组卷与答题（一套题 / 当前题 / 判定记分 / 本套题流水）
 * 渲染容器（admin.html 提供）：#quizToolbar #quizPicker #quizQuestions #quizCurrent #quizRecords #quizSummary
 */
(function (root) {
  'use strict';

  var CI = root.CI = root.CI || {};
  var U = CI.util;
  var doc = root.document || null;

  var pickerFilter = { keyword: '', tier: 'all', onlyUnused: false };
  var selectedStudent = '';

  function el(id) { return doc ? doc.getElementById(id) : null; }

  function currentQuiz() {
    var s = CI.store.get();
    return s.runtime.quizId ? CI.store.quiz(s, s.runtime.quizId) : null;
  }

  function quizList(s) {
    return s.quizzes.filter(function (qz) {
      return qz.name.indexOf('快捷记分') !== 0 && qz.name.indexOf('历史积分') !== 0;
    }).sort(function (a, b) { return b.createdAt - a.createdAt; });
  }

  /* ------------------------------------------------------------------ *
   * 顶部：试卷管理
   * ------------------------------------------------------------------ */

  function renderToolbar() {
    var s = CI.store.get();
    var box = el('quizToolbar');
    if (!box) return;
    var qz = currentQuiz();
    var opts = ['<option value="">— 未选择试卷（记入快捷记分）—</option>'].concat(
      quizList(s).map(function (q) {
        return '<option value="' + q.id + '"' + (qz && qz.id === q.id ? ' selected' : '') + '>' +
          U.escapeHTML(q.name) + '（' + q.questionIds.length + ' 题 / ' + q.records.length + ' 条）' +
          (q.closedAt ? ' · 已结束' : '') + '</option>';
      })
    ).join('');

    box.innerHTML =
      '<div class="quiz-toolbar-row">' +
        '<select id="quizSelect" onchange="CI.quizUI.selectQuiz(this.value)">' + opts + '</select>' +
        '<button class="btn btn-plus" onclick="CI.quizUI.newQuiz()">＋ 新建一套题</button>' +
        (qz ? '<button class="btn" onclick="CI.quizUI.drawQuestions()">🎲 随机抽题</button>' : '') +
        '<button class="btn" onclick="CI.quizUI.createRetest()">🔁 一键重测卷</button>' +
        (qz ? '<button class="btn" onclick="CI.quizUI.renameQuiz()">重命名</button>' : '') +
        (qz ? '<button class="btn" onclick="CI.quizUI.exportCSV()">导出本套流水</button>' : '') +
        (qz && !qz.closedAt ? '<button class="btn btn-minus" onclick="CI.quizUI.closeQuiz()">结束本套题</button>' : '') +
        (qz ? '<button class="btn btn-danger" onclick="CI.quizUI.deleteQuiz()">删除试卷</button>' : '') +
      '</div>' +
      (qz
        ? '<div class="quiz-info">当前试卷：<b>' + U.escapeHTML(qz.name) + '</b> · ' + qz.questionIds.length + ' 题 · 已记录 ' +
          qz.records.length + ' 条 · 累计得分 ' + sumPoints(qz) + ' 分' +
          (qz.note ? ' · ' + U.escapeHTML(qz.note) : '') + '</div>'
        : '<div class="quiz-info hint-inline">未选择试卷时，所有加减分与判定都会进入「快捷记分」，不计入任何一套题的统计。建议先新建一套题。</div>');
  }

  function sumPoints(qz) {
    return Math.round(qz.records.reduce(function (n, r) { return n + U.num(r.points, 0); }, 0) * 100) / 100;
  }

  function selectQuiz(id) { CI.store.setCurrentQuiz(id || null); }

  function newQuiz() {
    var name = prompt('这套题的名称', '第 ' + (quizList(CI.store.get()).length + 1) + ' 套题 · ' + new Date().toLocaleDateString('zh-CN'));
    if (name === null) return;
    CI.store.createQuiz(name, [], '');
    render();
  }

  function renameQuiz() {
    var qz = currentQuiz();
    if (!qz) return;
    var name = prompt('试卷名称', qz.name);
    if (name === null) return;
    var note = prompt('备注（可留空）', qz.note || '');
    CI.store.updateQuiz(qz.id, { name: name, note: note === null ? qz.note : note });
  }

  function closeQuiz() {
    var qz = currentQuiz();
    if (!qz) return;
    if (!confirm('结束「' + qz.name + '」？结束后仍可查看统计，但不再作为当前试卷。')) return;
    CI.store.closeQuiz(qz.id);
  }

  function deleteQuiz() {
    var qz = currentQuiz();
    if (!qz) return;
    if (!confirm('删除「' + qz.name + '」及其 ' + qz.records.length + ' 条积分流水？此操作不可恢复！')) return;
    CI.store.deleteQuiz(qz.id);
  }

  function exportCSV() {
    var qz = currentQuiz();
    if (!qz) return;
    var rows = CI.analysis.questionCSV(CI.store.get(), qz.id);
    U.download('试卷流水_' + qz.name.replace(/[\\/:*?"<>|]/g, '_') + '.csv', '\ufeff' + U.toCSV(rows), 'text/csv');
  }

  /* ------------------------------------------------------------------ *
   * 选题组卷
   * ------------------------------------------------------------------ */

  function renderPicker() {
    var s = CI.store.get();
    var box = el('quizPicker');
    if (!box) return;
    var qz = currentQuiz();

    var kw = pickerFilter.keyword.trim().toLowerCase();
    var list = s.bank.filter(function (q) {
      if (pickerFilter.tier !== 'all' && q.tier !== pickerFilter.tier) return false;
      if (pickerFilter.onlyUnused && qz && qz.questionIds.indexOf(q.id) >= 0) return false;
      if (kw && (q.stem + ' ' + q.tags.join(' ')).toLowerCase().indexOf(kw) < 0) return false;
      return true;
    });

    var grouped = s.tiers.map(function (t) {
      var items = list.filter(function (q) { return q.tier === t.key; });
      if (!items.length) return '';
      return '<div class="pick-group">' +
        '<div class="pick-group-title" style="color:' + t.color + '">' + U.escapeHTML(t.label) + '（' + t.weight + ' 分/题） · ' + items.length + ' 题' +
          '<button class="mini-btn" onclick="CI.quizUI.addAllTier(\'' + t.key + '\')">全部加入</button></div>' +
        items.map(function (q) {
          var inQuiz = qz && qz.questionIds.indexOf(q.id) >= 0;
          return '<label class="pick-item' + (inQuiz ? ' pick-item-in' : '') + '">' +
            '<input type="checkbox" value="' + q.id + '"' + (inQuiz ? ' disabled checked' : '') + '>' +
            '<span class="pick-stem">' + U.escapeHTML(q.stem || '（空题干）') + '</span>' +
            '<span class="pick-pts">' + CI.store.questionPoints(s, q) + ' 分</span>' +
          '</label>';
        }).join('') +
      '</div>';
    }).join('');

    box.innerHTML =
      '<div class="panel-title">从题库选题组卷 <span class="panel-sub">（勾选后点「加入试卷」；已在本套题中的题目不可重复勾选）</span></div>' +
      '<div class="pick-toolbar">' +
        '<input type="search" id="pickSearch" placeholder="搜索题干 / 知识点" value="' + U.escapeHTML(pickerFilter.keyword) + '">' +
        '<select id="pickTier">' +
          '<option value="all">全部题型</option>' +
          s.tiers.map(function (t) {
            return '<option value="' + t.key + '"' + (pickerFilter.tier === t.key ? ' selected' : '') + '>' + U.escapeHTML(t.label) + '</option>';
          }).join('') +
        '</select>' +
        '<label class="fld-check"><input type="checkbox" id="pickUnused"' + (pickerFilter.onlyUnused ? ' checked' : '') + '> 只看未加入本套题的</label>' +
        '<button class="btn btn-plus" onclick="CI.quizUI.addSelected()">加入试卷</button>' +
      '</div>' +
      '<div class="pick-list">' + (grouped || '<div class="empty">题库为空或没有符合条件的题目</div>') + '</div>';

    var ps = el('pickSearch');
    if (ps) ps.oninput = function () { pickerFilter.keyword = this.value; renderPicker(); };
    var pt = el('pickTier');
    if (pt) pt.onchange = function () { pickerFilter.tier = this.value; renderPicker(); };
    var pu = el('pickUnused');
    if (pu) pu.onchange = function () { pickerFilter.onlyUnused = this.checked; renderPicker(); };
  }

  function ensureQuiz() {
    var qz = currentQuiz();
    if (qz) return qz;
    var name = prompt('还没有当前试卷，先给这套题起个名字', '第 ' + (quizList(CI.store.get()).length + 1) + ' 套题 · ' + new Date().toLocaleDateString('zh-CN'));
    if (name === null) return null;
    return CI.store.createQuiz(name, [], '');
  }

  function addSelected() {
    var box = el('quizPicker');
    if (!box) return;
    var qz = ensureQuiz();
    if (!qz) return;
    var ids = [];
    box.querySelectorAll('input[type=checkbox][value]').forEach(function (cb) {
      if (cb.checked && !cb.disabled) ids.push(cb.value);
    });
    if (!ids.length) { alert('请先勾选要加入的题目'); return; }
    var n = CI.store.addQuestionsToQuiz(qz.id, ids);
    if (!CI.store.get().runtime.qid) {      var fresh = CI.store.quiz(CI.store.get(), qz.id);
      CI.store.setRuntime({ qid: fresh.questionIds[0] || null });
    }
    render();
  }

  function addAllTier(tierKey) {
    var s = CI.store.get();
    var qz = ensureQuiz();
    if (!qz) return;
    var ids = s.bank.filter(function (q) { return q.tier === tierKey; }).map(function (q) { return q.id; });
    if (!ids.length) { alert('该题型下没有题目'); return; }
    CI.store.addQuestionsToQuiz(qz.id, ids);
    render();
  }

  /**
   * 一键生成重测卷（错题重做）
   *
   * 把"答对率低于阈值"的题单独组一套新试卷，下一节课或课后直接用 ——
   * 提取练习是投产比最高的学习机制（Roediger & Karpicke 2006：只做重测不给反馈，
   * 一周后回忆 61%，重复阅读组读了 14 次也只有 40%）。
   * 阈值照抄 Kahoot 报告的 Create（答对率 < 35%）。
   */
  function createRetest() {
    var s = CI.store.get();
    var weak = CI.analysis.retestQuestions(s, {});
    if (!weak.length) {
      alert('本节课没有"答对率低于 35%"的题，暂时不需要重测卷（也可以先讲评）');
      return;
    }
    var stamp = new Date().toLocaleDateString('zh-CN');
    var qz = CI.store.createQuiz('重测 · ' + stamp, weak.map(function (x) { return x.qid; }));
    if (qz) {
      CI.store.setCurrentQuiz(qz.id);
      alert('已生成「' + qz.name + '」：' + weak.length + ' 道题\n' +
        weak.map(function (x, i) { return (i + 1) + '. ' + x.stem + '（正确率 ' + x.correctRate + '%）'; }).join('\n'));
    }
    render();
  }

  /**
   * 随机抽题：按题型/标签/数量从题库抽题加入当前试卷
   *
   * 用 prompt 收集条件（旧版界面风格：轻量、不打断上课节奏），
   * 抽题本身走 CI.store.drawQuestions（与 Rust 侧同一算法，见 docs/14 §2）。
   */
  function drawQuestions() {
    var s = CI.store.get();
    var qz = ensureQuiz();
    if (!qz) return;

    var tiers = s.tiers.map(function (t) { return t.key + '=' + t.label; }).join('、');
    var tierInput = prompt('限定题型（留空=不限）\n可选：' + tiers + '\n多个用逗号分隔，如：basic,advanced', '');
    if (tierInput === null) return; // 取消
    var tierKeys = tierInput.split(/[,，\s]+/).filter(function (x) { return x; });

    var tagInput = prompt('限定标签（留空=不限）\n题库里的标签：' + (s.tags || []).join('、'), '');
    if (tagInput === null) return;
    var tags = tagInput.split(/[,，\s]+/).filter(function (x) { return x; });

    var countInput = prompt('抽几道题？', '5');
    if (countInput === null) return;
    var count = Number(countInput) || 0;
    if (count <= 0) { alert('抽题数量要大于 0'); return; }

    // 已在试卷里的题不重复抽（否则等于白抽）
    var ids = CI.store.drawQuestions(s, {
      count: count,
      tiers: tierKeys,
      tags: tags,
      excludeIds: qz.questionIds.slice()
    });
    if (!ids.length) {
      alert('按这些条件没有抽到题目（可能题库为空、都被排除、或条件太窄）');
      return;
    }
    var added = CI.store.addQuestionsToQuiz(qz.id, ids);
    if (!s.runtime.qid) CI.store.setRuntime({ qid: ids[0] });
    alert('抽到 ' + ids.length + ' 道题，加入「' + qz.name + '」' + (added < ids.length ? '（' + (ids.length - added) + ' 道已在卷中）' : ''));
    render();
  }

  /** 从题库列表「加入试卷」按钮调用 */
  function addToCurrent(qid) {
    var qz = ensureQuiz();
    if (!qz) return;
    var n = CI.store.addQuestionsToQuiz(qz.id, [qid]);
    var s = CI.store.get();
    if (!s.runtime.qid) CI.store.setRuntime({ qid: qid });
    if (window.alert && n === 0) alert('该题已在本套试卷中');
    render();
  }

  /* ------------------------------------------------------------------ *
   * 试卷题目列表
   * ------------------------------------------------------------------ */

  function renderQuestions() {
    var s = CI.store.get();
    var box = el('quizQuestions');
    if (!box) return;
    var qz = currentQuiz();
    if (!qz) { box.innerHTML = '<div class="empty">未选择试卷</div>'; return; }
    if (!qz.questionIds.length) { box.innerHTML = '<div class="empty">本套题还没有题目，请在上方从题库勾选加入</div>'; return; }

    box.innerHTML = qz.questionIds.map(function (qid, i) {
      var q = CI.store.question(s, qid);
      if (!q) {
        return '<div class="quiz-q-item quiz-q-missing"><span class="quiz-q-idx">' + (i + 1) + '</span>' +
          '<span class="quiz-q-stem">（题目已从题库删除）</span>' +
          '<button class="mini-btn mini-danger" onclick="CI.quizUI.removeQuestion(\'' + qid + '\')">移除</button></div>';
      }
      var t = CI.store.tierOf(s, q.tier);
      var recs = qz.records.filter(function (r) { return r.qid === qid; });
      var done = recs.length;
      var active = s.runtime.qid === qid;
      return '<div class="quiz-q-item' + (active ? ' quiz-q-active' : '') + '" style="border-left-color:' + t.color + '">' +
        '<span class="quiz-q-idx">' + (i + 1) + '</span>' +
        '<span class="quiz-q-stem">' + U.escapeHTML(q.stem || '（空题干）') + '</span>' +
        '<span class="tag" style="background:' + t.color + '22;color:' + t.color + '">' + U.escapeHTML(t.label) + ' ' + CI.store.questionPoints(s, q) + '分</span>' +
        '<span class="quiz-q-done">' + (done ? ('已答 ' + done + ' 人次') : '未作答') + '</span>' +
        '<span class="quiz-q-actions">' +
          (active ? '<span class="tag tag-active">当前题</span>'
                  : '<button class="mini-btn" onclick="CI.quizUI.setQuestion(\'' + qid + '\')">设为当前题</button>') +
          '<button class="mini-btn" onclick="CI.quizUI.moveQuestion(\'' + qid + '\',-1)" title="上移">↑</button>' +
          '<button class="mini-btn" onclick="CI.quizUI.moveQuestion(\'' + qid + '\',1)" title="下移">↓</button>' +
          '<button class="mini-btn mini-danger" onclick="CI.quizUI.removeQuestion(\'' + qid + '\')">移除</button>' +
        '</span>' +
      '</div>';
    }).join('');
  }

  function setQuestion(qid) {
    CI.store.tx('quiz-current-q', function (s) { s.runtime.qid = qid; return qid; }, {});
    render();
  }

  function moveQuestion(qid, delta) {
    var qz = currentQuiz();
    if (!qz) return;
    var ids = qz.questionIds.slice();
    var i = ids.indexOf(qid);
    var j = i + delta;
    if (i < 0 || j < 0 || j >= ids.length) return;
    ids[i] = ids[j]; ids[j] = qid;
    CI.store.setQuizQuestions(qz.id, ids);
  }

  function removeQuestion(qid) {
    var qz = currentQuiz();
    if (!qz) return;
    CI.store.setQuizQuestions(qz.id, qz.questionIds.filter(function (x) { return x !== qid; }));
  }

  /* ------------------------------------------------------------------ *
   * 当前题 + 判定
   * ------------------------------------------------------------------ */

  function renderCurrent() {
    var s = CI.store.get();
    var box = el('quizCurrent');
    if (!box) return;
    var q = s.runtime.qid ? CI.store.question(s, s.runtime.qid) : null;
    var qz = currentQuiz();

    if (!q) {
      box.innerHTML = '<div class="empty">未选择当前题：可在上方题目列表点「设为当前题」。' +
        '此时点名判分会按第一个题型的权重记分，并进入快捷记分。</div>';
      return;
    }
    var t = CI.store.tierOf(s, q.tier);
    var base = CI.store.questionPoints(s, q);
    var recs = qz ? qz.records.filter(function (r) { return r.qid === q.id; }) : [];

    var studentOpts = ['<option value="">— 选择作答学生 —</option>'].concat(
      s.students.map(function (stu) {
        var team = CI.store.team(s, stu.teamId) || {};
        var answered = qz ? CI.store.answeredAlready(s, qz.id, q.id, stu.id) : false;
        return '<option value="' + stu.id + '"' + (selectedStudent === stu.id ? ' selected' : '') + '>' +
          U.escapeHTML(stu.name) + '（' + U.escapeHTML(team.name || '未分组') + '）' + (answered ? ' · 已答过' : '') + '</option>';
      })
    ).join('');

    function jbtn(result, label, cls) {
      var pts = CI.store.computePoints({ result: result, base: base });
      return '<button class="btn ' + cls + '" onclick="CI.quizUI.judge(\'' + result + '\')">' + label +
        ' <span class="rc-pts">' + (pts > 0 ? '+' : '') + pts + '</span></button>';
    }

    box.innerHTML =
      '<div class="cur-q-head" style="border-left-color:' + t.color + '">' +
        '<div class="cur-q-stem">' + U.escapeHTML(q.stem || '（空题干）') + '</div>' +
        (q.imageUrl ? '<img class="cur-q-image" src="' + U.escapeHTML(q.imageUrl) + '" alt="题目配图">' : '') +
        '<div class="cur-q-meta">' +
          '<span class="tag" style="background:' + t.color + '22;color:' + t.color + '">' + U.escapeHTML(t.label) + '</span>' +
          '<span class="tag tag-points">基准 ' + base + ' 分</span>' +
          q.tags.map(function (x) { return '<span class="tag tag-plain">' + U.escapeHTML(x) + '</span>'; }).join('') +
          (q.source ? '<span class="tag tag-plain">' + U.escapeHTML(q.source) + '</span>' : '') +
        '</div>' +
        (q.answer ? '<div class="cur-q-answer">参考答案：' + U.escapeHTML(q.answer) + '</div>' : '') +
        (q.note ? '<div class="cur-q-note">备注：' + U.escapeHTML(q.note) + '</div>' : '') +
      '</div>' +
      '<div class="cur-q-judge">' +
        '<label class="fld"><span>作答学生</span><select id="curStudent" onchange="CI.quizUI.setStudent(this.value)">' + studentOpts + '</select></label>' +
        '<div class="rc-judge-row">' +
          jbtn('correct', '答对', 'btn-plus') +
          jbtn('half', '部分正确', 'btn-half') +
          jbtn('wrong', '答错', 'btn-minus') +
          jbtn('skip', '跳过', 'btn-skip') +
        '</div>' +
        '<div class="cur-q-tools">' +
          '<button class="btn" onclick="CI.admin.gotoTab(\'tab-roll\')">去点名答这题</button>' +
          '<button class="btn" onclick="CI.quizUI.batchQuick()">按题型给全班加分</button>' +
        '</div>' +
      '</div>' +
      '<div class="cur-q-recs">' +
        '<div class="panel-title">本题作答记录 <span class="panel-sub">（' + recs.length + ' 条）</span></div>' +
        (recs.length ? '<div class="mini-recs">' + recs.map(function (r) {
          var stu = CI.store.student(s, r.sid);
          return '<span class="mini-rec" style="color:' + resultColor(r.result) + '">' +
            U.escapeHTML(stu ? stu.name : '?') + ' ' + (CI.store.RESULT_LABEL[r.result] || r.result) +
            ' ' + (r.points >= 0 ? '+' : '') + r.points + '</span>';
        }).join('') + '</div>' : '<div class="empty">本题还没有人作答</div>') +
      '</div>';
  }

  function resultColor(result) {
    return result === 'correct' ? '#2e7d32' : result === 'half' ? '#f9a825' : result === 'wrong' ? '#c62828' : '#78909c';
  }

  function setStudent(sid) {
    selectedStudent = sid || '';
    CI.store.setRuntime({ sid: sid || null });
    // 同步下拉框，避免「先选定学生再立即判分」时读到旧值而记错人
    var sel = el('curStudent');
    if (sel && sel.value !== selectedStudent) sel.value = selectedStudent;
  }

  function judge(result) {
    var s = CI.store.get();
    var sel = el('curStudent');
    var sid = (sel && sel.value) || selectedStudent || s.runtime.sid;
    if (!sid || !CI.store.student(s, sid)) sid = selectedStudent || s.runtime.sid;
    if (!sid || !CI.store.student(s, sid)) { alert('请先选择作答学生'); return null; }
    var stu = CI.store.student(s, sid);
    var q = s.runtime.qid ? CI.store.question(s, s.runtime.qid) : null;
    if (q && s.runtime.quizId && CI.store.answeredAlready(s, s.runtime.quizId, q.id, sid)) {
      if (!confirm(stu.name + ' 已答过本题，仍要再记一次分吗？')) return null;
    }
    var fast = false;
    if (result === 'correct' && U.num(s.settings.fastBonus, 0) > 0) {
      fast = confirm('是否抢答加分？（额外 +' + s.settings.fastBonus + ' 分）');
    }
    return CI.store.recordResult({
      sid: sid,
      qid: q ? q.id : null,
      tier: q ? q.tier : (s.tiers[0] ? s.tiers[0].key : 'basic'),
      result: result,
      quizId: s.runtime.quizId || null,
      source: 'quiz',
      fast: fast,
      by: 'quiz'
    });
  }

  /** 按题型给全班/某队批量加分（例如“基础题全班都答对了”） */
  function batchQuick() {
    var s = CI.store.get();
    var q = s.runtime.qid ? CI.store.question(s, s.runtime.qid) : null;
    var tierKey = q ? q.tier : (s.tiers[0] ? s.tiers[0].key : 'basic');
    var t = CI.store.tierOf(s, tierKey);
    var scope = prompt('给哪些学生加「' + t.label + '」' + t.weight + ' 分？\n输入队伍名称，或输入 all 表示全班', 'all');
    if (scope === null) return;
    scope = scope.trim();
    var teamId = 'all';
    if (scope && scope.toLowerCase() !== 'all') {
      var hit = s.teams.filter(function (x) { return x.name === scope; })[0];
      if (!hit) { alert('未找到队伍：' + scope); return; }
      teamId = hit.id;
    }
    var list = CI.store.studentsOf(s, teamId);
    if (!list.length) { alert('没有学生'); return; }
    if (!confirm('将为 ' + list.length + ' 名学生各记一次「' + t.label + '答对 +' + t.weight + ' 分」，确认？')) return;
    list.forEach(function (stu) {
      CI.store.recordResult({
        sid: stu.id, qid: q ? q.id : null, tier: tierKey, result: 'correct',
        quizId: s.runtime.quizId || null, source: 'quiz', by: 'quiz-batch'
      });
    });
  }

  /* ------------------------------------------------------------------ *
   * 本套题流水与小结
   * ------------------------------------------------------------------ */

  function renderRecords() {
    var s = CI.store.get();
    var box = el('quizRecords');
    if (!box) return;
    var qz = currentQuiz();
    if (!qz) { box.innerHTML = '<div class="empty">未选择试卷</div>'; return; }
    var recs = qz.records.slice().sort(function (a, b) { return b.at - a.at; }).slice(0, 100);
    if (!recs.length) { box.innerHTML = '<div class="empty">本套题还没有积分流水</div>'; return; }
    box.innerHTML = '<table class="data-table"><thead><tr>' +
      '<th>时间</th><th>学生</th><th>题目 / 题型</th><th>判定</th><th>得分</th><th></th>' +
      '</tr></thead><tbody>' +
      recs.map(function (r) {
        var stu = CI.store.student(s, r.sid);
        var q = r.qid ? CI.store.question(s, r.qid) : null;
        var t = r.tier ? CI.store.tierOf(s, r.tier) : null;
        return '<tr>' +
          '<td class="nowrap">' + U.fmtClock(r.at) + '</td>' +
          '<td>' + U.escapeHTML(stu ? stu.name : '（已删除）') + '</td>' +
          '<td>' + (t ? '<span class="tag" style="background:' + t.color + '22;color:' + t.color + '">' + U.escapeHTML(t.label) + '</span> ' : '') +
            U.escapeHTML(q ? U.shortStem(q.stem) : '（快捷记分）') + '</td>' +
          '<td style="color:' + resultColor(r.result) + '">' + (CI.store.RESULT_LABEL[r.result] || r.result) + '</td>' +
          '<td><b>' + (r.points >= 0 ? '+' : '') + r.points + '</b></td>' +
          '<td><button class="mini-btn mini-danger" onclick="CI.quizUI.removeRecord(\'' + r.id + '\')">撤销</button></td>' +
        '</tr>';
      }).join('') + '</tbody></table>' +
      (qz.records.length > 100 ? '<div class="hint-inline">仅显示最近 100 条，完整流水请点「导出本套流水」</div>' : '');
  }

  function removeRecord(id) {
    if (!confirm('撤销这条积分记录？分数会相应回退。')) return;
    CI.store.removeRecord(id);
  }

  function renderSummary() {
    var s = CI.store.get();
    var box = el('quizSummary');
    if (!box) return;
    var qz = currentQuiz();
    if (!qz) { box.innerHTML = ''; return; }
    var stats = {};
    qz.records.filter(function (r) { return r.sid; }).forEach(function (r) {
      if (!stats[r.sid]) stats[r.sid] = { sid: r.sid, n: 0, pts: 0, correct: 0 };
      stats[r.sid].n++;
      stats[r.sid].pts += U.num(r.points, 0);
      if (r.result === 'correct') stats[r.sid].correct++;
    });
    var rows = Object.keys(stats).map(function (k) { return stats[k]; })
      .sort(function (a, b) { return b.pts - a.pts; });
    if (!rows.length) { box.innerHTML = ''; return; }
    box.innerHTML = '<div class="panel-title">本套题学生小结 <span class="panel-sub">（按得分排序）</span></div>' +
      '<div class="chip-row">' + rows.map(function (r) {
        var stu = CI.store.student(s, r.sid);
        return '<span class="chip">' + U.escapeHTML(stu ? stu.name : '?') + '：' + r.n + ' 题 / 对 ' + r.correct +
          ' / <b>' + (r.pts >= 0 ? '+' : '') + Math.round(r.pts * 100) / 100 + '</b></span>';
      }).join('') + '</div>';
  }

  function render() {
    renderToolbar();
    renderPicker();
    renderQuestions();
    renderCurrent();
    renderSummary();
    renderRecords();
  }

  CI.quizUI = {
    render: render, renderToolbar: renderToolbar, renderPicker: renderPicker,
    renderQuestions: renderQuestions, renderCurrent: renderCurrent, renderRecords: renderRecords,
    selectQuiz: selectQuiz, newQuiz: newQuiz, renameQuiz: renameQuiz, closeQuiz: closeQuiz, deleteQuiz: deleteQuiz,
    addSelected: addSelected, addAllTier: addAllTier, addToCurrent: addToCurrent,
    drawQuestions: drawQuestions,
    createRetest: createRetest,
    setQuestion: setQuestion, moveQuestion: moveQuestion, removeQuestion: removeQuestion,
    setStudent: setStudent, judge: judge, batchQuick: batchQuick,
    removeRecord: removeRecord, exportCSV: exportCSV,
    currentQuiz: currentQuiz
  };
})(typeof window !== 'undefined' ? window : globalThis);
