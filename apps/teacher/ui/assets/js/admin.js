/*!
 * admin.js — 主控台装配：页签路由、队伍与学生管理、排行榜、日志、备份、WebSocket 同步接线
 * 依赖：store.js → sync.js → analysis.js → rollcall.js → bank.js → quiz.js → admin.js（顺序加载）
 */
(function (root) {
  'use strict';

  var CI = root.CI = root.CI || {};
  var U = CI.util;
  var doc = root.document || null;

  var activeTab = 'tab-class';
  var studentFilter = { keyword: '', teamId: 'all', sortBy: 'score' };

  function el(id) { return doc ? doc.getElementById(id) : null; }

  /* ------------------------------------------------------------------ *
   * 页签
   * ------------------------------------------------------------------ */

  function gotoTab(id) {
    activeTab = id;
    var tabs = doc.querySelectorAll('.tab-btn');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].classList.toggle('active', tabs[i].getAttribute('data-tab') === id);
    }
    var panels = doc.querySelectorAll('.tab-panel');
    for (var j = 0; j < panels.length; j++) {
      panels[j].classList.toggle('active', panels[j].id === id);
    }
    try { root.localStorage.setItem('ci_active_tab', id); } catch (e) { /* 忽略 */ }
    renderAll();
  }

  /* ------------------------------------------------------------------ *
   * 顶部状态条
   * ------------------------------------------------------------------ */

  function renderTopBar() {
    var s = CI.store.get();
    var box = el('classBar');
    if (!box) return;
    var qz = s.runtime.quizId ? CI.store.quiz(s, s.runtime.quizId) : null;
    var q = s.runtime.qid ? CI.store.question(s, s.runtime.qid) : null;
    var t = q ? CI.store.tierOf(s, q.tier) : null;
    var stu = s.runtime.sid ? CI.store.student(s, s.runtime.sid) : null;

    box.innerHTML =
      '<span class="chip">课程：<b>' + U.escapeHTML(s.settings.courseName || '课堂积分') + '</b></span>' +
      '<span class="chip">试卷：<b>' + (qz ? U.escapeHTML(qz.name) : '未选择') + '</b></span>' +
      '<span class="chip">当前题：<b>' + (q ? U.escapeHTML(U.shortStem(q.stem)) : '未选择') + '</b>' +
        (t ? '（' + U.escapeHTML(t.label) + ' ' + CI.store.questionPoints(s, q) + '分）' : '') + '</span>' +
      '<span class="chip">当前学生：<b>' + (stu ? U.escapeHTML(stu.name) : '未指定') + '</b></span>' +
      '<span class="chip chip-sync ' + syncStatus.cls + '" id="syncChip">同步：' + U.escapeHTML(syncStatus.text) + '</span>' +
      (function () {
        // 客户端里内置数据库不可用 → 红字提示，并明确"数据没丢"
        var degraded = CI.storage && CI.storage.isDegraded && CI.storage.isDegraded();
        var text = CI.storage ? CI.storage.describe() : 'localStorage';
        return '<span class="chip ' + (degraded ? 'chip-bad' : '') + '" id="storageChip" title="' +
          U.escapeHTML(degraded ? '数据仍在浏览器本地存储中，导出备份后重启应用即可恢复落库' : text) + '">存储：' +
          U.escapeHTML(text) + '</span>';
      })() +
      '<span class="chip">学生 <b>' + s.students.length + '</b> 人 · 队伍 <b>' + s.teams.length + '</b> 支</span>';
  }

  var syncStatus = { text: '连接中…', cls: '' };

  function setSyncStatus(text, cls) {
    syncStatus = { text: text, cls: cls || '' };
    var chip = el('syncChip');
    if (chip) { chip.textContent = '同步：' + text; chip.className = 'chip chip-sync ' + syncStatus.cls; }
    var st = el('status');
    if (st) st.textContent = text;
  }

  /* ------------------------------------------------------------------ *
   * 队伍管理
   * ------------------------------------------------------------------ */

  function renderTeams() {
    var s = CI.store.get();
    var box = el('teamsContainer');
    if (!box) return;
    if (!s.teams.length) {
      box.innerHTML = '<div class="empty">还没有队伍，点下方「添加队伍」开始</div>';
      return;
    }
    box.innerHTML = s.teams.map(function (t) {
      var members = CI.store.studentsOf(s, t.id);
      var ts = CI.store.teamScore(s, t.id);
      return '<div class="team-card" style="border-top:4px solid ' + t.color + '">' +
        '<div class="team-header">' +
          '<div class="team-icon" style="color:' + t.color + '">' + U.escapeHTML(t.icon) + '</div>' +
          '<input type="text" class="team-name" value="' + U.escapeHTML(t.name) + '" onchange="CI.admin.renameTeam(\'' + t.id + '\', this.value)">' +
        '</div>' +
        '<div class="team-score-row">' +
          '<span class="team-score">' + ts + '</span><span class="team-score-label">队伍总分</span>' +
          '<span class="team-members">' + members.length + ' 人</span>' +
        '</div>' +
        '<div class="team-ops">' +
          '<button class="mini-btn" onclick="CI.admin.addStudentTo(\'' + t.id + '\')">＋ 加学生</button>' +
          '<button class="mini-btn" onclick="CI.admin.bulkAddTo(\'' + t.id + '\')">批量加人</button>' +
          '<button class="mini-btn" onclick="CI.admin.pickIcon(\'' + t.id + '\')">换图标</button>' +
          '<button class="mini-btn mini-danger" onclick="CI.admin.removeTeam(\'' + t.id + '\')">删除</button>' +
        '</div>' +
        '<div class="team-members-list">' + (members.length
          ? members.map(function (m) {
              return '<span class="member-chip">' + U.escapeHTML(m.name) + ' <b>' + CI.store.scoreOf(s, m.id) + '</b></span>';
            }).join('')
          : '<span class="hint-inline">暂无学生</span>') + '</div>' +
      '</div>';
    }).join('');
  }

  function renameTeam(tid, name) { CI.store.updateTeam(tid, { name: name }); }

  function pickIcon(tid) {
    var s = CI.store.get();
    var t = CI.store.team(s, tid);
    var icons = CI.store.ICONS.join(' ');
    var v = prompt('输入或粘贴一个图标（可选：' + icons + '）', t.icon);
    if (v === null) return;
    CI.store.updateTeam(tid, { icon: v || '⭐' });
  }

  function removeTeam(tid) {
    var s = CI.store.get();
    var t = CI.store.team(s, tid);
    if (!s.teams.length || s.teams.length <= 1) { alert('至少保留一支队伍'); return; }
    if (!confirm('删除队伍「' + t.name + '」？其成员会转入第一支队伍，积分不丢失。')) return;
    CI.store.removeTeam(tid);
  }

  function addTeam() {
    var name = prompt('新队伍名称', '队伍' + (CI.store.get().teams.length + 1));
    if (name === null) return;
    CI.store.addTeam(name);
  }

  /* ------------------------------------------------------------------ *
   * 学生管理
   * ------------------------------------------------------------------ */

  function visibleStudents() {
    var s = CI.store.get();
    var kw = studentFilter.keyword.trim().toLowerCase();
    var list = CI.store.studentsOf(s, studentFilter.teamId).filter(function (stu) {
      return !kw || stu.name.toLowerCase().indexOf(kw) >= 0;
    });
    if (studentFilter.sortBy === 'score') {
      list.sort(function (a, b) { return CI.store.scoreOf(s, b.id) - CI.store.scoreOf(s, a.id); });
    } else if (studentFilter.sortBy === 'name') {
      list.sort(function (a, b) { return a.name.localeCompare(b.name, 'zh-Hans-CN'); });
    } else if (studentFilter.sortBy === 'rolls') {
      list.sort(function (a, b) { return CI.store.calledCount(s, b.id) - CI.store.calledCount(s, a.id); });
    }
    return list;
  }

  function renderStudentToolbar() {
    var s = CI.store.get();
    var box = el('studentToolbar');
    if (!box) return;
    var teamOpts = ['<option value="all">全部队伍</option>'].concat(s.teams.map(function (t) {
      return '<option value="' + t.id + '"' + (studentFilter.teamId === t.id ? ' selected' : '') + '>' + U.escapeHTML(t.name) + '</option>';
    })).join('');

    box.innerHTML =
      '<input type="search" id="stuSearch" placeholder="搜索学生姓名" value="' + U.escapeHTML(studentFilter.keyword) + '">' +
      '<select id="stuTeam">' + teamOpts + '</select>' +
      '<select id="stuSort">' +
        '<option value="score"' + (studentFilter.sortBy === 'score' ? ' selected' : '') + '>按积分</option>' +
        '<option value="name"' + (studentFilter.sortBy === 'name' ? ' selected' : '') + '>按姓名</option>' +
        '<option value="rolls"' + (studentFilter.sortBy === 'rolls' ? ' selected' : '') + '>按被点次数</option>' +
      '</select>' +
      '<button class="btn btn-plus" onclick="CI.admin.addStudent()">＋ 添加学生</button>' +
      '<button class="btn" onclick="CI.admin.bulkAdd()">批量添加</button>' +
      '<button class="btn" onclick="CI.admin.undoLast()">撤销上一步</button>' +
      '<button class="btn btn-danger" onclick="CI.admin.resetAllScores()">全班归零</button>';

    var search = el('stuSearch');
    if (search) search.oninput = function () { studentFilter.keyword = this.value; renderStudents(); };
    var team = el('stuTeam');
    if (team) team.onchange = function () { studentFilter.teamId = this.value; renderStudents(); };
    var sort = el('stuSort');
    if (sort) sort.onchange = function () { studentFilter.sortBy = this.value; renderStudents(); };
  }

  function renderStudents() {
    var s = CI.store.get();
    var box = el('studentsContainer');
    if (!box) return;
    var list = visibleStudents();
    if (!list.length) {
      box.innerHTML = '<div class="empty">' + (s.students.length ? '没有符合条件的学生' : '还没有学生，点「添加学生」或「批量添加」录入名单') + '</div>';
      return;
    }
    var tierBtns = s.tiers.map(function (t) {
      return { key: t.key, label: t.label, weight: U.num(t.weight, 0), color: t.color };
    });

    box.innerHTML = list.map(function (stu) {
      var team = CI.store.team(s, stu.teamId) || {};
      var score = CI.store.scoreOf(s, stu.id);
      var called = CI.store.calledCount(s, stu.id);
      var stats = CI.analysis.studentStats(s, stu.id);
      var isCurrent = s.runtime.sid === stu.id;
      var teamOpts = s.teams.map(function (t) {
        return '<option value="' + t.id + '"' + (stu.teamId === t.id ? ' selected' : '') + '>' + U.escapeHTML(t.name) + '</option>';
      }).join('');

      return '<div class="student-card' + (isCurrent ? ' student-current' : '') + '" style="border-top:4px solid ' + (team.color || '#90a4ae') + '">' +
        '<div class="student-head">' +
          '<input class="student-name" value="' + U.escapeHTML(stu.name) + '" onchange="CI.admin.renameStudent(\'' + stu.id + '\', this.value)">' +
          '<span class="student-score" id="score-' + stu.id + '">' + score + '</span>' +
        '</div>' +
        '<div class="student-meta">' +
          '<select class="mini-select" onchange="CI.admin.moveStudent(\'' + stu.id + '\', this.value)">' + teamOpts + '</select>' +
          '<span class="tag tag-plain">被点 ' + called + ' 次</span>' +
          (stats && stats.total.attempts
            ? '<span class="tag tag-plain">作答 ' + stats.total.attempts + ' 题·得分率 ' + stats.total.creditRate + '%</span>'
            : '<span class="tag tag-plain">暂无作答</span>') +
          (stats && stats.weak.length ? '<span class="tag tag-warn">薄弱：' + stats.weak.map(function (k) { return CI.store.tierOf(s, k).label; }).join('/') + '</span>' : '') +
        '</div>' +
        '<div class="tier-btns">' + tierBtns.map(function (t) {
          return '<button class="btn btn-tier" style="border-color:' + t.color + ';color:' + t.color + '" ' +
            'onclick="CI.admin.quickTier(\'' + stu.id + '\',\'' + t.key + '\')" title="' + U.escapeHTML(t.label) + '答对 +' + t.weight + '">' +
            U.escapeHTML(t.label) + ' +' + t.weight + '</button>';
        }).join('') + '</div>' +
        '<div class="manual-btns">' +
          '<button class="btn" onclick="CI.admin.changeScore(\'' + stu.id + '\',-1)">-1</button>' +
          '<button class="btn" onclick="CI.admin.changeScore(\'' + stu.id + '\',-2)">-2</button>' +
          '<button class="btn" onclick="CI.admin.changeScore(\'' + stu.id + '\',1)">+1</button>' +
          '<button class="btn" onclick="CI.admin.changeScore(\'' + stu.id + '\',2)">+2</button>' +
          '<button class="btn" onclick="CI.admin.customScore(\'' + stu.id + '\')">自定义</button>' +
          '<button class="btn btn-minus" onclick="CI.admin.zeroStudent(\'' + stu.id + '\')">归零</button>' +
        '</div>' +
        '<div class="student-foot">' +
          '<button class="mini-btn" onclick="CI.admin.setCurrentStudent(\'' + stu.id + '\')">' + (isCurrent ? '✓ 当前学生' : '设为当前') + '</button>' +
          '<button class="mini-btn" onclick="CI.admin.showStudentReport(\'' + stu.id + '\')">学情总结</button>' +
          '<button class="mini-btn mini-danger" onclick="CI.admin.removeStudent(\'' + stu.id + '\')">删除</button>' +
        '</div>' +
      '</div>';
    }).join('');
  }

  function addStudent() {
    var s = CI.store.get();
    var name = prompt('学生姓名');
    if (!name) return;
    var teamId = s.teams[0] ? s.teams[0].id : null;
    if (s.teams.length > 1) {
      var teamName = prompt('所属队伍（' + s.teams.map(function (t) { return t.name; }).join(' / ') + '）', (CI.store.team(s, teamId) || {}).name);
      if (teamName !== null) {
        var hit = s.teams.filter(function (t) { return t.name === teamName; })[0];
        if (hit) teamId = hit.id;
      }
    }
    CI.store.addStudent(name, teamId);
  }

  function addStudentTo(teamId) {
    var name = prompt('学生姓名（加入 ' + (CI.store.team(CI.store.get(), teamId) || {}).name + '）');
    if (!name) return;
    CI.store.addStudent(name, teamId);
  }

  function bulkAdd() { openBulkModal(studentFilter.teamId === 'all' ? (CI.store.get().teams[0] || {}).id : studentFilter.teamId); }
  function bulkAddTo(teamId) { openBulkModal(teamId); }

  function openBulkModal(teamId) {
    var s = CI.store.get();
    var box = el('bulkModal');
    if (!box) return;
    box.innerHTML =
      '<div class="modal-mask" onclick="CI.admin.closeBulk()"></div>' +
      '<div class="modal-box">' +
        '<div class="modal-head"><b>批量添加学生</b><button class="mini-btn" onclick="CI.admin.closeBulk()">✕</button></div>' +
        '<div class="modal-body">' +
          '<label class="fld"><span>姓名（每行一个，或用空格 / 逗号 / 顿号分隔）</span>' +
            '<textarea id="bulkNames" rows="8" placeholder="张三&#10;李四&#10;王五"></textarea></label>' +
          '<label class="fld"><span>加入队伍</span><select id="bulkTeam">' +
            s.teams.map(function (t) {
              return '<option value="' + t.id + '"' + (t.id === teamId ? ' selected' : '') + '>' + U.escapeHTML(t.name) + '</option>';
            }).join('') + '</select></label>' +
        '</div>' +
        '<div class="modal-foot">' +
          '<button class="btn" onclick="CI.admin.closeBulk()">取消</button>' +
          '<button class="btn btn-plus" onclick="CI.admin.doBulkAdd()">导入名单</button>' +
        '</div>' +
      '</div>';
    box.style.display = 'flex';
  }

  function closeBulk() {
    var box = el('bulkModal');
    if (box) { box.style.display = 'none'; box.innerHTML = ''; }
  }

  function doBulkAdd() {
    var names = (el('bulkNames') || {}).value || '';
    var teamId = (el('bulkTeam') || {}).value;
    var added = CI.store.addStudentsBulk(names, teamId);
    closeBulk();
    alert('已添加 ' + added.length + ' 名学生');
  }

  function renameStudent(sid, name) { CI.store.updateStudent(sid, { name: name }); }
  function moveStudent(sid, teamId) { CI.store.updateStudent(sid, { teamId: teamId }); }

  function removeStudent(sid) {
    var s = CI.store.get();
    var stu = CI.store.student(s, sid);
    if (!confirm('删除学生「' + stu.name + '」？其积分流水会一并从统计中移除（题库不受影响）。')) return;
    CI.store.removeStudent(sid);
  }

  function setCurrentStudent(sid) {
    CI.store.setRuntime({ sid: sid });
    renderAll();
  }

  function changeScore(sid, delta) {
    CI.store.addManual(sid, delta);
    flashScore(sid);
  }

  function customScore(sid) {
    var v = prompt('输入要增加的分数（可为负数，例如 -2）', '5');
    if (v === null) return;
    var n = Number(v);
    if (!isFinite(n) || n === 0) { alert('请输入非零数字'); return; }
    CI.store.addManual(sid, n);
    flashScore(sid);
  }

  function quickTier(sid, tierKey) {
    var s = CI.store.get();
    var t = CI.store.tierOf(s, tierKey);
    CI.store.recordResult({
      sid: sid, qid: null, tier: tierKey, result: 'correct',
      quizId: s.runtime.quizId || null, source: 'quick', by: 'class'
    });
    flashScore(sid);
  }

  function zeroStudent(sid) {
    var s = CI.store.get();
    var stu = CI.store.student(s, sid);
    if (!confirm('将「' + stu.name + '」的积分归零？历史流水会保留（可撤销）。')) return;
    CI.store.resetStudentScore(sid);
  }

  function flashScore(sid) {
    var e = el('score-' + sid);
    if (!e) return;
    e.classList.remove('score-change');
    void e.offsetWidth;
    e.classList.add('score-change');
  }

  function undoLast() {
    var last = CI.store.lastRecord(CI.store.get());
    if (!last) { alert('没有可撤销的记录'); return; }
    var s = CI.store.get();
    var stu = CI.store.student(s, last.sid);
    if (!confirm('撤销最近一条：' + (stu ? stu.name : '') + ' · ' + CI.store.describeRecord(s, last) +
      '（' + (last.points >= 0 ? '+' : '') + last.points + ' 分）？')) return;
    CI.store.undoLastRecord();
  }

  function resetAllScores() {
    if (!confirm('清空所有积分流水（名单、题库、试卷保留）？此操作不可撤销！')) return;
    CI.store.resetAllScores();
  }

  function clearRolls() {
    if (!confirm('清空点名记录与轮次进度？（已记的积分不受影响）')) return;
    CI.store.resetRolls();
  }

  function saveWsHost() {
    var input = el('wsHostInput');
    var v = input ? String(input.value || '').trim() : '';
    if (!v) { alert('请填写 WebSocket 地址，例如 ws.peroe.top 或 192.168.1.100:8080'); return; }
    CI.sync.setHost(v);
    alert('已保存并重新连接：' + v);
  }

  function factoryReset() {
    if (!confirm('恢复初始状态：清空试卷、全部积分流水与点名历史（学生名单与题库保留）？')) return;
    CI.store.factoryReset();
  }

  /* ------------------------------------------------------------------ *
   * 排行榜 / 日志 / 备份
   * ------------------------------------------------------------------ */

  function renderBoard() {
    var s = CI.store.get();
    var box = el('boardContainer');
    if (!box) return;
    var teamRows = CI.analysis.teamRanking(s);
    var stuRows = CI.analysis.ranking(s, 'all').slice(0, 30);

    box.innerHTML =
      '<div class="board-col">' +
        '<div class="panel-title">队伍榜 <span class="panel-sub">（队伍分 = 成员积分之和）</span></div>' +
        (teamRows.length ? teamRows.map(function (t) {
          return '<div class="item item-team">' +
            '<span class="rank">' + U.pad2(t.rank) + '</span>' +
            '<span class="name" style="color:' + t.color + '">' + U.escapeHTML(t.icon + ' ' + t.name) +
              '<span class="board-sub">' + t.memberCount + ' 人 · 人均 ' + t.avg + ' · 得分率 ' + t.creditRate + '%</span></span>' +
            '<span class="score">' + t.score + '</span>' +
          '</div>';
        }).join('') : '<div class="empty">暂无队伍</div>') +
      '</div>' +
      '<div class="board-col">' +
        '<div class="panel-title">学生榜（前 30）</div>' +
        (stuRows.length ? stuRows.map(function (r) {
          return '<div class="item">' +
            '<span class="rank">' + U.pad2(r.rank) + '</span>' +
            '<span class="name">' + U.escapeHTML(r.name) +
              '<span class="board-sub">' + U.escapeHTML(r.teamName) + ' · 作答 ' + r.attempts + ' · 得分率 ' + r.creditRate + '%</span></span>' +
            '<span class="score">' + r.score + '</span>' +
          '</div>';
        }).join('') : '<div class="empty">暂无学生</div>') +
      '</div>';
  }

  function renderLogs() {
    var s = CI.store.get();
    var list = el('logsList');
    if (!list) return;
    var logs = s.logs.slice(-200).reverse();
    if (!logs.length) { list.innerHTML = '<div class="empty">暂无操作日志</div>'; return; }
    list.innerHTML = logs.map(function (l) {
      return '<li class="log-item"><span class="log-time">' + U.fmtTime(l.ts) + '</span>' +
        '<span class="log-type">' + U.escapeHTML(l.type) + '</span>' +
        '<span class="log-detail">' + U.escapeHTML(l.detail) + '</span></li>';
    }).join('');
  }

  function openLogs() {
    renderLogs();
    var m = el('logsModal');
    if (m) m.style.display = 'flex';
  }

  function closeLogs() {
    var m = el('logsModal');
    if (m) m.style.display = 'none';
  }

  function clearLogs() {
    if (!confirm('清空操作日志？')) return;
    CI.store.tx('logs-clear', function (s) { s.logs = []; }, {});
    renderLogs();
  }

  function exportBackup() {
    var data = CI.store.exportAll();
    var stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    U.download('课堂积分备份_' + stamp + '.json', JSON.stringify(data, null, 2));
  }

  function exportClassCSV() {
    var rows = CI.analysis.classCSV(CI.store.get(), studentFilter.teamId);
    U.download('学情汇总_' + new Date().toISOString().slice(0, 10) + '.csv', '\ufeff' + U.toCSV(rows), 'text/csv');
  }

  function importBackup() {
    var box = el('bulkModal');
    if (!box) return;
    box.innerHTML =
      '<div class="modal-mask" onclick="CI.admin.closeBulk()"></div>' +
      '<div class="modal-box">' +
        '<div class="modal-head"><b>导入备份 / 数据</b><button class="mini-btn" onclick="CI.admin.closeBulk()">✕</button></div>' +
        '<div class="modal-body">' +
          '<label class="fld"><span>选择备份文件（.json，由「导出全部数据」生成）</span><input type="file" id="impBackupFile" accept=".json"></label>' +
          '<div class="hint-inline">导入会覆盖当前全部数据（名单、题库、试卷、流水）。建议先导出一次备份。</div>' +
        '</div>' +
        '<div class="modal-foot"><button class="btn" onclick="CI.admin.closeBulk()">取消</button></div>' +
      '</div>';
    box.style.display = 'flex';
    var f = el('impBackupFile');
    if (f) f.onchange = function () {
      var file = this.files && this.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        try {
          var data = JSON.parse(String(reader.result || '{}'));
          CI.store.importAll(data);
          closeBulk();
          alert('导入完成');
        } catch (e) {
          alert('导入失败：' + e.message);
        }
      };
      reader.readAsText(file, 'utf-8');
    };
  }

  /* ------------------------------------------------------------------ *
   * 渲染总入口
   * ------------------------------------------------------------------ */

  var renderTimer = null;
  function renderAll() {
    if (!doc) return;
    renderTopBar();
    if (activeTab === 'tab-class') { renderStudentToolbar(); renderTeams(); renderStudents(); }
    else if (activeTab === 'tab-quiz') CI.quizUI.render();
    else if (activeTab === 'tab-bank') CI.bankUI.render();
    else if (activeTab === 'tab-roll') CI.rollUI.render();
    else if (activeTab === 'tab-analysis') CI.analysisUI.render();
    else if (activeTab === 'tab-classroom') CI.classroom.render();
    else if (activeTab === 'tab-board') {
      renderBoard();
      renderLogs();
      var wi = el('wsHostInput');
      if (wi && doc.activeElement !== wi) wi.value = CI.sync ? CI.sync.host() : '';
    }
  }

  function scheduleRender() {
    if (renderTimer) return;
    renderTimer = setTimeout(function () { renderTimer = null; renderAll(); }, 30);
  }

  /** 枢纽上存有课堂数据（例如老师换了电脑/清了缓存）：提示一键恢复 */
  var pendingDump = null;
  function maybeOfferRestore() {
    if (!pendingDump) return;
    var s = CI.store.get();
    var localEmpty = s.students.length === 0 && CI.store.allRecords(s).length === 0;
    if (!localEmpty) return;
    if (!confirm('枢纽上有一份课堂数据（' + U.fmtTime(pendingDump.updatedAt) + '），是否载入？\n\n选「取消」则从空白开始，枢纽会在你开始记分后被覆盖。')) return;
    CI.classroom.applyRemote(pendingDump);
    renderAll();
  }

  /* ------------------------------------------------------------------ *
   * 初始化
   * ------------------------------------------------------------------ */

  function init() {
    CI.store.init();

    try {
      var savedTab = root.localStorage.getItem('ci_active_tab');
      if (savedTab && el(savedTab)) activeTab = savedTab;
    } catch (e) { /* 忽略 */ }

    if (doc) {
      var tabs = doc.querySelectorAll('.tab-btn');
      for (var i = 0; i < tabs.length; i++) {
        tabs[i].addEventListener('click', function () { gotoTab(this.getAttribute('data-tab')); });
      }
      var title = el('courseTitle');
      if (title) title.textContent = CI.store.get().settings.courseName || '课堂积分系统';
    }

    if (CI.storage) {
      // 教师端本地数据库（SQLite）自动接管持久化：远端新→载入；本地新→推上去；两边都没有→先用本地
      CI.storage.bootstrap().then(function (res) {
        if (!res) return;
        if (res.action === 'loaded-remote') {
          renderAll();
          if (CI.sync) CI.sync.push(true);
        }
        var chip = el('storageChip');
        if (chip) chip.textContent = '存储：' + CI.storage.describe();
      }).catch(function () { /* 无枢纽时静默用 localStorage */ });

      // 关页/切到后台时立刻落库：客户端里进程随时可能被系统回收，不能等 800ms 防抖
      var flushNow = function () {
        try { CI.storage.flush(); } catch (e) { /* 忽略 */ }
      };
      if (root.addEventListener) {
        root.addEventListener('beforeunload', flushNow);
        root.addEventListener('pagehide', flushNow);
        root.addEventListener('visibilitychange', function () {
          if (doc && doc.visibilityState === 'hidden') flushNow();
        });
      }
    }

    CI.store.on('change', function (e) {
      if (e && e.state) {
        var t = el('courseTitle');
        if (t) t.textContent = e.state.settings.courseName || '课堂积分系统';
      }
      scheduleRender();
      if (CI.sync) CI.sync.push();
    });

    if (CI.sync) {
      CI.sync.init({
        onStatus: setSyncStatus,
        onCmd: function (cmd) { if (CI.classroom) CI.classroom.handleCmd(cmd); },
        onPresence: function (msg) { if (CI.classroom) CI.classroom.setPresence(msg); },
        onServerInfo: function (info) { if (CI.classroom) CI.classroom.setServerInfo(info); },
        onDump: function (dump, force) {
          if (force) { if (CI.classroom) CI.classroom.loadRemoteState(dump); return; }   // 教师手动点「从枢纽恢复」
          pendingDump = dump;
          maybeOfferRestore();
        }
      });
    }

    gotoTab(activeTab);
    renderAll();

    if (CI.rollUI) CI.rollUI.bindKeys();

    root.onerror = function (msg, src, line, col) {
      var bar = el('errBar');
      if (bar) { bar.style.display = 'block'; bar.textContent = '⚠ 页面脚本错误：' + msg + ' @' + line + ':' + col; }
      return false;
    };
    root.addEventListener('beforeunload', function () { if (CI.sync) CI.sync.push(true); });
  }

  CI.admin = {
    init: init, gotoTab: gotoTab, renderAll: renderAll, setSyncStatus: setSyncStatus,
    addTeam: addTeam, renameTeam: renameTeam, removeTeam: removeTeam, pickIcon: pickIcon,
    addStudent: addStudent, addStudentTo: addStudentTo, bulkAdd: bulkAdd, bulkAddTo: bulkAddTo,
    openBulkModal: openBulkModal, closeBulk: closeBulk, doBulkAdd: doBulkAdd,
    renameStudent: renameStudent, moveStudent: moveStudent, removeStudent: removeStudent,
    setCurrentStudent: setCurrentStudent, changeScore: changeScore, customScore: customScore,
    quickTier: quickTier, zeroStudent: zeroStudent, undoLast: undoLast,
    resetAllScores: resetAllScores, factoryReset: factoryReset,
    clearRolls: clearRolls, saveWsHost: saveWsHost,
    renderBoard: renderBoard, renderLogs: renderLogs, openLogs: openLogs, closeLogs: closeLogs,
    clearLogs: clearLogs, exportBackup: exportBackup, importBackup: importBackup, exportClassCSV: exportClassCSV,
    showStudentReport: function (sid) { CI.analysisUI.showStudentReport(sid); }
  };

  if (doc) {
    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', init);
    else init();
  }
})(typeof window !== 'undefined' ? window : globalThis);
