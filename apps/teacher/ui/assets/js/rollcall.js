/*!
 * rollcall.js — 点名系统
 *
 *  纯算法部分（可在 Node 中测试）：
 *    candidates(state, opts)  计算候选池
 *    pick(state, opts)        按模式抽选一人（不写状态）
 *    applyPick(state, res)    把抽选结果写入轮次池 + 点名历史
 *  UI 部分（仅在浏览器中调用）：
 *    CI.rollUI.render() / spin() / judge(result) / clear()
 */
(function (root) {
  'use strict';

  var CI = root.CI = root.CI || {};
  var U = CI.util;
  var doc = root.document || null;

  /* ------------------------------------------------------------------ *
   * 纯算法
   * ------------------------------------------------------------------ */

  function rand(list) { return list[Math.floor(Math.random() * list.length)]; }

  function option(opts, key, dft) {
    return (opts && opts[key] !== undefined && opts[key] !== null) ? opts[key] : dft;
  }

  function recentIds(rc, n) {
    return rc.history.slice(-n).map(function (h) { return h.sid; });
  }

  /**
   * 计算候选学生
   * @param {Object} state
   * @param {Object} [opts]
   *   scope             'all' | 队伍 id（默认取 state.rollcall.scope）
   *   excludeAnswered   是否排除“当前题已作答”的学生（默认取设置）
   *   recentExclude     不重复最近 N 次被点到的学生（默认取设置）
   *   qid / quizId      指定题目与试卷（默认取 state.runtime）
   */
  function candidates(state, opts) {
    var s = state || CI.store.get();
    var rc = s.rollcall;
    var scope = option(opts, 'scope', rc.scope || 'all');
    var list = CI.store.studentsOf(s, scope).filter(function (stu) { return stu.active !== false; });

    var excludeAnswered = option(opts, 'excludeAnswered', rc.excludeAnswered);
    var quizId = option(opts, 'quizId', s.runtime.quizId);
    var qid = option(opts, 'qid', s.runtime.qid);
    if (excludeAnswered && quizId && qid) {
      list = list.filter(function (stu) {
        return !CI.store.answeredAlready(s, quizId, qid, stu.id);
      });
    }

    var recent = U.num(option(opts, 'recentExclude', rc.recentExclude), 0);
    if (recent > 0) {
      var skip = recentIds(rc, recent);
      var filtered = list.filter(function (stu) { return skip.indexOf(stu.id) < 0; });
      if (filtered.length) list = filtered;   // 若排除后无人可选则放弃该约束
    }
    return list;
  }

  /**
   * 抽选一人（纯函数，不修改 state）
   * @returns {Object|null} {sid, name, mode, note, candidateCount, newRound, pool}
   */
  function pick(state, opts) {
    var s = state || CI.store.get();
    var rc = s.rollcall;
    var mode = option(opts, 'mode', rc.mode || 'even');
    var list = candidates(s, opts);
    if (!list.length) return null;

    var chosen = null, note = '', newRound = false, pool = null, round = null;

    if (mode === 'least') {
      var min = Math.min.apply(null, list.map(function (st) { return CI.store.calledCount(s, st.id); }));
      var least = list.filter(function (st) { return CI.store.calledCount(s, st.id) === min; });
      chosen = rand(least);
      note = '最少被点优先（本轮候选最少 ' + min + ' 次）';
    } else if (mode === 'even') {
      var poolIds = rc.roundPool || [];
      var inPool = list.filter(function (st) { return poolIds.indexOf(st.id) >= 0; });
      if (!inPool.length) {
        // 轮次池为空：要么是首次开始，要么上一轮已全部点到
        newRound = rc.history.length > 0 && poolIds.length === 0;
        inPool = list;
        note = newRound ? '本轮已全部点到，开启新一轮' : '新一轮开始';
        if (newRound) round = U.num(rc.round, 1) + 1;
      }
      chosen = rand(inPool);
      // 本轮剩余候选：不放回，点完为止（下一轮自动重置）
      pool = inPool.filter(function (st) { return st.id !== chosen.id; }).map(function (st) { return st.id; });
    } else {
      chosen = rand(list);
      note = '纯随机模式';
    }

    return {
      sid: chosen.id,
      name: chosen.name,
      mode: mode,
      note: note,
      candidateCount: list.length,
      newRound: newRound,
      pool: pool,
      round: round
    };
  }

  /** 把抽选结果写入状态（轮次池 + 点名历史） */
  function applyPick(result) {
    var s = CI.store.get();
    if (!result) return null;
    if (result.pool) CI.store.setRoundPool(result.pool, result.round);
    CI.store.addRoll(result.sid, { quizId: s.runtime.quizId, qid: s.runtime.qid });
    CI.store.setRuntime({ sid: result.sid });
    return result;
  }

  /* ------------------------------------------------------------------ *
   * UI
   * ------------------------------------------------------------------ */

  var spinning = false;
  var spinTimer = null;

  function el(id) { return doc ? doc.getElementById(id) : null; }

  function currentStudent() {
    var s = CI.store.get();
    return s.runtime.sid ? CI.store.student(s, s.runtime.sid) : null;
  }

  function renderSettings() {
    var s = CI.store.get();
    var box = el('rcSetup');
    if (!box) return;
    var rc = s.rollcall;
    var teamOptions = ['<option value="all"' + (rc.scope === 'all' ? ' selected' : '') + '>全班</option>'].concat(
      s.teams.map(function (t) {
        return '<option value="' + t.id + '"' + (rc.scope === t.id ? ' selected' : '') + '>' + U.escapeHTML(t.name) + '</option>';
      })
    ).join('');

    box.innerHTML =
      '<div class="rc-set-row">' +
        '<label>范围</label>' +
        '<select onchange="CI.store.setRollSettings({scope:this.value})">' + teamOptions + '</select>' +
        '<label>模式</label>' +
        '<select onchange="CI.store.setRollSettings({mode:this.value})">' +
          '<option value="even"' + (rc.mode === 'even' ? ' selected' : '') + '>轮次池·均匀点名</option>' +
          '<option value="random"' + (rc.mode === 'random' ? ' selected' : '') + '>纯随机</option>' +
          '<option value="least"' + (rc.mode === 'least' ? ' selected' : '') + '>最少被点优先</option>' +
        '</select>' +
        '<label>防连点</label>' +
        '<select onchange="CI.store.setRollSettings({recentExclude:Number(this.value)})">' +
          [0, 1, 2, 3].map(function (n) {
            return '<option value="' + n + '"' + (U.num(rc.recentExclude, 1) === n ? ' selected' : '') + '>最近 ' + n + ' 次</option>';
          }).join('') +
        '</select>' +
        '<label class="rc-check"><input type="checkbox" ' + (rc.excludeAnswered ? 'checked' : '') +
          ' onchange="CI.store.setRollSettings({excludeAnswered:this.checked})"> 排除当前题已作答</label>' +
      '</div>';
  }

  function renderStage() {
    var s = CI.store.get();
    var stage = el('rcStage');
    if (!stage) return;

    if (spinning) return; // 滚动动画期间不覆盖

    var stu = currentStudent();
    if (!stu) {
      stage.innerHTML = '<div class="rc-name rc-name-empty">准备就绪</div>' +
        '<div class="rc-sub">点击「开始点名」，或按空格键</div>';
      return;
    }
    var stats = CI.analysis ? CI.analysis.studentStats(s, stu.id) : null;
    var team = CI.store.team(s, stu.teamId) || {};
    stage.innerHTML =
      '<div class="rc-name">' + U.escapeHTML(stu.name) + '</div>' +
      '<div class="rc-sub">' + U.escapeHTML(team.name || '未分组') +
        ' · 积分 ' + CI.store.scoreOf(s, stu.id) +
        ' · 已被点 ' + CI.store.calledCount(s, stu.id) + ' 次' +
        (stats && stats.total.attempts ? ' · 加权得分率 ' + stats.total.creditRate + '%' : '') +
      '</div>';
  }

  function renderJudge() {
    var s = CI.store.get();
    var box = el('rcJudge');
    if (!box) return;
    var stu = currentStudent();
    if (!stu) { box.innerHTML = '<div class="rc-hint">先点名，再判定</div>'; return; }

    var qz = s.runtime.quizId ? CI.store.quiz(s, s.runtime.quizId) : null;
    var q = s.runtime.qid ? CI.store.question(s, s.runtime.qid) : null;
    var base = q ? CI.store.questionPoints(s, q) : 0;
    var tierKey = q ? q.tier : (s.tiers[0] ? s.tiers[0].key : 'basic');
    var tier = CI.store.tierOf(s, tierKey);
    if (!q) base = U.num(tier.weight, 0);

    var head = q
      ? '<div class="rc-qhead">当前题目：<b>' + U.escapeHTML(tier.label) + '</b> · ' + U.escapeHTML(U.shortStem(q.stem)) + '（基准 ' + base + ' 分）</div>'
      : '<div class="rc-qhead">未选择题目：判定将按 <b>' + U.escapeHTML(tier.label) + '</b> 记分（基准 ' + base + ' 分）</div>';

    function btn(result, label, cls) {
      var pts = CI.store.computePoints({ result: result, base: base });
      return '<button class="btn ' + cls + '" onclick="CI.rollUI.judge(\'' + result + '\')">' +
        label + (pts !== 0 ? ' <span class="rc-pts">' + (pts > 0 ? '+' : '') + pts + '</span>' : ' <span class="rc-pts">+0</span>') +
        '</button>';
    }

    var quick = s.tiers.map(function (t) {
      return '<button class="btn btn-quick" style="border-color:' + t.color + '" onclick="CI.rollUI.quick(\'' + t.key + '\')">' +
        U.escapeHTML(t.label) + ' +' + t.weight + '</button>';
    }).join('');

    box.innerHTML = head +
      '<div class="rc-judge-row">' +
        btn('correct', '答对', 'btn-plus') +
        btn('half', '部分正确', 'btn-half') +
        btn('wrong', '答错', 'btn-minus') +
        btn('skip', '跳过', 'btn-skip') +
      '</div>' +
      '<div class="rc-judge-row rc-quick-row">' + quick + '</div>' +
      '<div class="rc-hint">' +
        (qz ? '记入试卷：' + U.escapeHTML(qz.name) : '未选择试卷，将记入「快捷记分」') +
        '　·　快捷键 1 答对 / 2 部分 / 3 答错 / 4 跳过 / 空格 点名' +
      '</div>';
  }

  function renderStats() {
    var s = CI.store.get();
    var box = el('rcStats');
    if (!box) return;
    var list = CI.store.studentsOf(s, s.rollcall.scope || 'all');
    var called = list.filter(function (st) { return CI.store.calledCount(s, st.id) > 0; }).length;
    var pool = (s.rollcall.roundPool || []).filter(function (id) {
      return list.some(function (st) { return st.id === id; });
    }).length;
    box.innerHTML =
      '<span class="chip">本轮剩余 <b>' + pool + '</b> 人</span>' +
      '<span class="chip">第 <b>' + s.rollcall.round + '</b> 轮</span>' +
      '<span class="chip">已覆盖 <b>' + called + '/' + list.length + '</b> 人</span>' +
      '<span class="chip">累计点名 <b>' + s.rollcall.history.length + '</b> 次</span>';
  }

  function renderHistory() {
    var s = CI.store.get();
    var box = el('rcHistory');
    if (!box) return;
    var hist = s.rollcall.history.slice(-40).reverse();
    if (!hist.length) { box.innerHTML = '<div class="empty">暂无点名记录</div>'; return; }

    box.innerHTML = hist.map(function (h) {
      var stu = CI.store.student(s, h.sid);
      var team = stu ? (CI.store.team(s, stu.teamId) || {}) : {};
      // 该次点名之后（5 分钟内）该学生的第一条流水，视为本次判定结果
      var rec = CI.store.recordsOf(s, { sid: h.sid }).filter(function (r) {
        return r.at >= h.at && r.at - h.at < 300000;
      })[0];
      var judge = rec ? ('<span class="rc-res" style="color:' + resultColor(rec.result) + '">' +
        (CI.store.RESULT_LABEL[rec.result] || rec.result) + ' ' + (rec.points >= 0 ? '+' : '') + rec.points + '</span>') : '<span class="rc-res rc-res-none">未判定</span>';
      return '<li class="rc-hist-item">' +
        '<span class="rc-time">' + U.fmtClock(h.at) + '</span>' +
        '<span class="rc-hist-name">' + U.escapeHTML(stu ? stu.name : '（已删除）') + '</span>' +
        '<span class="rc-hist-team">' + U.escapeHTML(team.name || '') + '</span>' +
        judge +
        '<button class="mini-btn" onclick="CI.store.removeRoll(\'' + h.id + '\')" title="撤销这条点名">✕</button>' +
        '</li>';
    }).join('');
  }

  function resultColor(result) {
    return result === 'correct' ? '#2e7d32' : result === 'half' ? '#f9a825' : result === 'wrong' ? '#c62828' : '#78909c';
  }

  function render() {
    renderSettings();
    renderStage();
    renderJudge();
    renderStats();
    renderHistory();
  }

  /** 滚动动画 → 定格 */
  function spin() {
    if (spinning) return;
    var s = CI.store.get();
    var result = pick(s, {});
    if (!result) {
      var stage = el('rcStage');
      if (stage) stage.innerHTML = '<div class="rc-name rc-name-empty">无可点名学生</div>' +
        '<div class="rc-sub">请检查名单、范围或“排除当前题已作答”设置</div>';
      return;
    }

    var list = candidates(s, {});
    spinning = true;
    var stageEl = el('rcStage');
    var ticks = 0;
    var total = 16;
    if (spinTimer) clearInterval(spinTimer);
    spinTimer = setInterval(function () {
      ticks++;
      var temp = rand(list);
      if (stageEl) {
        stageEl.innerHTML = '<div class="rc-name rc-rolling">' + U.escapeHTML(temp.name) + '</div>' +
          '<div class="rc-sub">抽取中…</div>';
      }
      if (ticks >= total) {
        clearInterval(spinTimer);
        spinTimer = null;
        spinning = false;
        applyPick(result);
        var st = el('rcStage');
        if (st) st.classList.add('rc-flash');
        setTimeout(function () { if (st) st.classList.remove('rc-flash'); }, 600);
        render();
      }
    }, 70);
  }

  /** 对当前被点学生判定，并立即记分 */
  function judge(result) {
    var s = CI.store.get();
    var stu = currentStudent();
    if (spinning || !stu) { alert(spinning ? '点名动画进行中，请等定格后再判分' : '请先点名'); return null; }
    var q = s.runtime.qid ? CI.store.question(s, s.runtime.qid) : null;
    if (q && s.runtime.quizId && CI.store.answeredAlready(s, s.runtime.quizId, q.id, stu.id)) {
      if (!confirm(stu.name + ' 已答过本题，仍要再记一次分吗？')) return null;
    }
    var rec = CI.store.recordResult({
      sid: stu.id,
      qid: q ? q.id : null,
      tier: q ? q.tier : (s.tiers[0] ? s.tiers[0].key : 'basic'),
      result: result,
      quizId: s.runtime.quizId || null,
      source: 'rollcall',
      by: 'rollcall'
    });
    return rec;
  }

  /** 指名快捷题型加分（不经过点名，直接给当前学生） */
  function quick(tierKey) {
    var s = CI.store.get();
    var stu = currentStudent();
    if (spinning || !stu) { alert(spinning ? '点名动画进行中，请等定格后再使用题型按钮' : '请先点名'); return null; }
    return CI.store.recordResult({
      sid: stu.id, qid: null, tier: tierKey, result: 'correct',
      quizId: s.runtime.quizId || null, source: 'quick', by: 'rollcall'
    });
  }

  /** 给指定学生快捷加分（学生卡片上的题型按钮使用） */
  function quickFor(sid, tierKey, result) {
    var s = CI.store.get();
    return CI.store.recordResult({
      sid: sid, qid: null, tier: tierKey, result: result || 'correct',
      quizId: s.runtime.quizId || null, source: 'quick', by: 'class'
    });
  }

  function bindKeys() {
    if (!doc) return;
    doc.addEventListener('keydown', function (e) {
      var tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      var tab = doc.querySelector('.tab-panel.active');
      if (!tab || tab.id !== 'tab-roll') return;
      if (e.code === 'Space') { e.preventDefault(); spin(); }
      else if (e.key === '1') judge('correct');
      else if (e.key === '2') judge('half');
      else if (e.key === '3') judge('wrong');
      else if (e.key === '4') judge('skip');
    });
  }

  CI.rollcall = { candidates: candidates, pick: pick, applyPick: applyPick };
  CI.rollUI = {
    render: render, spin: spin, judge: judge, quick: quick, quickFor: quickFor,
    bindKeys: bindKeys, currentStudent: currentStudent,
    isSpinning: function () { return spinning; }
  };
})(typeof window !== 'undefined' ? window : globalThis);
