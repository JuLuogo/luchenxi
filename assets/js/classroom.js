/*!
 * classroom.js — 教师端「课堂协同」：接收学生端命令、自动/人工判定、在线状态与实时流
 *
 *  数据分区：
 *    state.classroom = { pending:[], buzz:[], feed:[] }   ← 随课堂数据一起持久化（刷新/换设备不丢）
 *    state.runtime.accepting / reveal                     ← 是否接收作答 / 是否已公布答案
 *    presence（在线小组）只在内存中，由枢纽推送
 *
 *  学生命令（由 sync.js 转发进来）：
 *    {kind:'hello',  teamId, label}                 入座报到
 *    {kind:'buzz',   teamId, sid?}                  抢答
 *    {kind:'answer', teamId, sid, qid, choice|text|skip}  提交作答
 */
(function (root) {
  'use strict';

  var CI = root.CI = root.CI || {};
  var U = CI.util;
  var doc = root.document || null;

  var presence = { hostOnline: false, teams: [] };
  var serverInfo = null;
  var lastAutoResult = null;

  function el(id) { return doc ? doc.getElementById(id) : null; }

  /* ------------------------------------------------------------------ *
   * 数据分区
   * ------------------------------------------------------------------ */

  function box(s) {
    s = s || CI.store.get();
    if (!s.classroom || typeof s.classroom !== 'object') s.classroom = { pending: [], buzz: [], feed: [] };
    var c = s.classroom;
    if (!Array.isArray(c.pending)) c.pending = [];
    if (!Array.isArray(c.buzz)) c.buzz = [];
    if (!Array.isArray(c.feed)) c.feed = [];
    return c;
  }

  function currentQuestion(s) {
    s = s || CI.store.get();
    return s.runtime.qid ? CI.store.question(s, s.runtime.qid) : null;
  }

  function studentName(s, sid) {
    var stu = CI.store.student(s, sid);
    return stu ? stu.name : '（未知学生）';
  }

  function teamName(s, tid) {
    var t = CI.store.team(s, tid);
    return t ? t.name : '（未知队伍）';
  }

  /** 从队伍里挑选作答人：优先命令指定 → 当前学生（若属于该队）→ 队伍第一个成员 */
  function pickAnswerer(s, teamId, sid) {
    if (sid && CI.store.student(s, sid)) return sid;
    if (s.runtime.sid) {
      var cur = CI.store.student(s, s.runtime.sid);
      if (cur && (!teamId || cur.teamId === teamId)) return cur.id;
    }
    var members = CI.store.studentsOf(s, teamId);
    return members.length ? members[0].id : null;
  }

  /* ------------------------------------------------------------------ *
   * 课堂环节：大屏与学生端按环节决定"现在该显示什么"
   *   idle      待机（还没有开始，显示房间号与入座情况）
   *   rollcall  随机点名（大屏放大显示被点到的同学）
   *   question  出题 / 答题（大屏显示题干与选项，学生端可作答）
   *   review    点评（大屏显示各队答对情况 + 能力雷达与评价）
   * ------------------------------------------------------------------ */
  var PHASES = ['idle', 'rollcall', 'question', 'review'];
  var PHASE_LABEL = { idle: '待机', rollcall: '随机点名', question: '出题答题', review: '点评总结' };

  function phase(s) {
    s = s || CI.store.get();
    var p = s.runtime && s.runtime.phase;
    return PHASES.indexOf(p) >= 0 ? p : 'idle';
  }

  /** 切换课堂环节；出题环节会自动带上当前题（没有题就退回待机） */
  function setPhase(p) {
    if (PHASES.indexOf(p) < 0) return phase();
    return CI.store.tx('class-phase', function (s) {
      s.runtime.phase = p;
      if (p === 'question' && !s.runtime.qid) {
        var qz = s.runtime.quizId ? CI.store.quiz(s, s.runtime.quizId) : null;
        var first = qz && qz.questionIds.length ? qz.questionIds[0] : (s.bank[0] ? s.bank[0].id : null);
        if (first) s.runtime.qid = first;
        else s.runtime.phase = 'idle';                     // 没题可出，回到待机
      }
      if (p === 'question') s.runtime.accepting = true;    // 出题即开始接收作答
      if (p === 'review') s.runtime.accepting = false;
      if (p === 'rollcall') s.runtime.reveal = false;
      return s.runtime.phase;
    }, { type: '课堂环节', detail: function (s, r) { return PHASE_LABEL[r] || r; } });
  }

  /** 各队 + 全班的答题情况（点评环节与"其他队答对多少"都用它） */
  function teamStats(s) {
    s = s || CI.store.get();
    var out = (s.teams || []).map(function (t) {
      var cs = CI.analysis.classStats(s, t.id);
      return {
        teamId: t.id, name: t.name, color: t.color, icon: t.icon,
        correct: cs.total.correct, attempts: cs.total.attempts,
        creditRate: cs.total.creditRate, score: CI.store.teamScore(s, t.id),
        memberCount: cs.studentCount
      };
    }).sort(function (a, b) { return b.correct - a.correct || b.creditRate - a.creditRate; });
    var all = CI.analysis.classStats(s, 'all');
    out.unshift({
      teamId: 'all', name: '全班', color: '#4f46e5', icon: '∑',
      correct: all.total.correct, attempts: all.total.attempts,
      creditRate: all.total.creditRate, score: null, memberCount: all.studentCount
    });
    return out;
  }

  /** 能力评价（点评环节的雷达）：全班 + 各队，含评级与评语 */
  function abilityPayload(s) {
    s = s || CI.store.get();
    var board = CI.analysis.abilityBoard(s);
    function pack(a) {
      if (!a) return null;
      return {
        id: a.id, name: a.name, kind: a.kind, overall: a.overall,
        coverage: a.coverage, balance: a.balance, attempts: a.attempts,
        grade: { key: a.grade.key, short: a.grade.short, label: a.grade.label, color: a.grade.color },
        axes: a.axes.map(function (x) { return { key: x.key, label: x.label, color: x.color, rate: x.rate, attempts: x.attempts }; }),
        weakest: a.weakest ? { label: a.weakest.label, rate: a.weakest.rate } : null,
        strongest: a.strongest ? { label: a.strongest.label, rate: a.strongest.rate } : null,
        comment: a.comment
      };
    }
    return {
      class: pack(board.class),
      teams: board.teams.map(pack),
      /* 学生只带"能力画像"，不带完整记录 */
      students: board.students.map(function (a) {
        return {
          sid: a.id, name: a.name, teamName: a.teamName, overall: a.overall,
          grade: { key: a.grade.key, short: a.grade.short, label: a.grade.label, color: a.grade.color },
          weakest: a.weakest ? a.weakest.label : null, comment: a.comment,
          axes: a.axes.map(function (x) { return x.rate; })
        };
      }),
      axes: (board.class ? board.class.axes.map(function (x) { return { key: x.key, label: x.label, color: x.color }; }) : [])
    };
  }

  /* ------------------------------------------------------------------ *
   * 课堂计时器（学习通「计时器」控件的做法）
   *   · 只存**结束时刻**，不存剩余秒数、也不广播 tick
   *   · 大屏/学生端各自按 endsAt - now 本地渲染，一秒刷新一次
   *   · 好处：断网倒计时照走，枢纽不必每秒发消息
   * ------------------------------------------------------------------ */

  /** 开始计时（seconds <= 0 等价于停止）；返回结束时刻或 null */
  function setTimer(seconds, label) {
    var secs = Number(seconds) || 0;
    return CI.store.tx('class-timer', function (s) {
      if (secs <= 0) {
        s.runtime.timerEndsAt = null;
        s.runtime.timerLabel = '';
        return null;
      }
      s.runtime.timerEndsAt = Date.now() + secs * 1000;
      s.runtime.timerLabel = label || '';
      return s.runtime.timerEndsAt;
    }, { type: '课堂计时', detail: function (s, r) { return r ? (secs + ' 秒' + (label ? '（' + label + '）' : '')) : '停止计时'; } });
  }

  /** 停止计时 */
  function clearTimer() { return setTimer(0, ''); }

  /** 剩余毫秒：没在计时 → null；到点/过点 → 0 */
  function timerLeft(now) {
    var end = CI.store.get().runtime.timerEndsAt;
    if (!end) return null;
    return Math.max(0, end - (now || Date.now()));
  }

  /** 剩余时间显示成 m:ss（向上取整：还剩 0.4 秒也显示 1 秒） */
  function formatLeft(ms) {
    var total = Math.ceil(Math.max(0, ms) / 1000);
    var m = Math.floor(total / 60);
    var sec = total % 60;
    return m + ':' + (sec < 10 ? '0' + sec : String(sec));
  }

  /** 签到统计：已入座队伍 / 全部队伍（presence.teams 里 online 的队算已到） */
  function checkinStats(s) {
    s = s || CI.store.get();
    var teams = s.teams || [];
    var online = {};
    ((presence && presence.teams) || []).forEach(function (t) { if (t.online) online[t.teamId] = true; });
    var seated = teams.filter(function (t) { return online[t.id]; }).length;
    return {
      seated: seated,
      total: teams.length,
      rate: teams.length ? Math.round((seated / teams.length) * 100) : 0
    };
  }

  function pushFeed(s, item) {
    var c = box(s);
    c.feed.unshift(Object.assign({ id: U.uid('fd'), at: Date.now() }, item));
    if (c.feed.length > 60) c.feed.length = 60;
  }

  function addBuzz(cmd) {
    return CI.store.tx('class-buzz', function (s) {
      var c = box(s);
      var q = currentQuestion(s);
      var qid = (cmd.qid || (q ? q.id : null));
      var dup = c.buzz.some(function (b) { return b.teamId === cmd.teamId && b.qid === qid; });
      if (dup) return { dup: true };
      c.buzz.unshift({
        id: U.uid('bz'), at: Date.now(), teamId: cmd.teamId, qid: qid,
        sid: pickAnswerer(s, cmd.teamId, cmd.sid),
        by: (cmd.from && cmd.from.label) || '学生端'
      });
      if (c.buzz.length > 40) c.buzz.length = 40;
      return { team: teamName(s, cmd.teamId) };
    }, {
      type: '抢答', detail: function (s, r) {
        return r && r.dup ? '（重复，已忽略）' : (r ? r.team : '');
      }
    });
  }

  function addPending(s, info) {
    var c = box(s);
    var item = Object.assign({ id: U.uid('pd'), at: Date.now() }, info);
    c.pending.unshift(item);
    if (c.pending.length > 60) c.pending.length = 60;
    return item;
  }

  /**
   * 处理学生端命令（由 sync.js 调用）
   * @returns {Object|null} 处理结果摘要，便于测试
   */
  /**
   * 处理一条学生命令
   *
   * @param cmd 命令
   * @param backlog 是否来自离线补发
   * @param pre **预算好的判定**（Rust 核心给的 result/ratio/points/expected）——
   *            有它就用它，没有再走本地判分（回退路径，也是测试里的路径）
   */
  function handleCmd(cmd, backlog, pre) {
    if (!cmd || !cmd.kind) return null;
    var s = CI.store.get();
    var q = currentQuestion(s);

    if (cmd.kind === 'hello') {
      CI.store.tx('class-hello', function (st) {
        pushFeed(st, { kind: 'hello', teamId: cmd.teamId, text: teamName(st, cmd.teamId) + ' 已入座' });
      }, { type: '学生入座', detail: function (st) { return teamName(st, cmd.teamId); } });
      return { kind: 'hello', teamId: cmd.teamId };
    }

    if (cmd.kind === 'buzz') {
      var r = addBuzz(cmd);
      return { kind: 'buzz', dup: !!(r && r.dup), teamId: cmd.teamId };
    }

    if (cmd.kind === 'answer') {
      var qid = cmd.qid || (q ? q.id : null);
      var question = qid ? CI.store.question(s, qid) : null;
      var sid = pickAnswerer(s, cmd.teamId, cmd.sid);
      if (!sid) {
        CI.store.tx('class-answer-orphan', function (st) {
          pushFeed(st, { kind: 'error', teamId: cmd.teamId, text: teamName(st, cmd.teamId) + ' 提交失败：队伍没有成员' });
        }, { type: '提交失败' });
        return { kind: 'answer', ok: false, reason: 'no-student' };
      }

      // 去重：有当前试卷时按该卷判重；没有试卷（快捷记分）时按该题历史流水判重，避免重复加分
      var already = question ? (s.runtime.quizId ? CI.store.answeredAlready(s, s.runtime.quizId, question.id, sid)
        : CI.store.recordsOf(s, { sid: sid, qid: question.id }).length > 0) : false;
      if (already) {
        CI.store.tx('class-answer-dup', function (st) {
          pushFeed(st, { kind: 'dup', teamId: cmd.teamId, sid: sid, text: studentName(st, sid) + ' 重复提交，已忽略' });
        }, { type: '重复提交', detail: function (st) { return studentName(st, sid); } });
        return { kind: 'answer', ok: false, reason: 'duplicate' };
      }

      var submission = { choice: cmd.choice, text: cmd.text, skip: !!cmd.skip };
      // Rust 核心预算好了就用它（判分口径唯一）；否则本地判分
      var graded = (pre && pre.result)
        ? { result: pre.result, ratio: pre.ratio, expected: pre.expected, points: pre.points }
        : (question ? CI.grade.auto(question, submission) : null);
      var desc = question ? CI.grade.describeSubmission(question, submission) : (cmd.text || '（空）');

      if (!graded) {
        // 主观题：进待确认队列，由老师判定
        var item = CI.store.tx('class-pending', function (st) {
          var it = addPending(st, {
            sid: sid, teamId: cmd.teamId, qid: question ? question.id : null,
            quizId: st.runtime.quizId || null,
            answer: desc, auto: false, backlog: !!backlog
          });
          pushFeed(st, {
            kind: 'pending', teamId: cmd.teamId, sid: sid, qid: question ? question.id : null,
            text: studentName(st, sid) + ' 提交：' + desc + '（待确认）'
          });
          return it;
        }, { type: '学生提交', detail: function (st) { return studentName(st, sid) + ' · ' + desc; } });
        return { kind: 'answer', ok: true, result: 'pending', sid: sid, pendingId: item.id };
      }

      // 客观题：自动判分并立即记分（先记分再补一条带分数的实时流）
      // 抢答名次：本队对该题在抢答榜里的位置（1 起）——前面抢到的排前面，
      // 答对时按名次加分（第1个+2/第2个+1，见 settings.buzzRankBonuses）；没抢过答就没有名次。
      var rank = (question && cmd.teamId)
        ? (function () {
            var pos = -1;
            (CI.store.get().classroom.buzz || []).forEach(function (b, i) {
              if (pos < 0 && b.teamId === cmd.teamId && b.qid === question.id) pos = i;
            });
            return pos < 0 ? null : (pos + 1);
          })()
        : null;
      var rec = CI.store.recordResult({
        sid: sid,
        qid: question ? question.id : null,
        tier: question ? question.tier : (s.tiers[0] ? s.tiers[0].key : 'basic'),
        result: graded.result,
        quizId: s.runtime.quizId || null,
        source: 'student',
        note: desc,
        by: 'student',
        rank: rank,
        // 学生选的选项字母（如 "AB"）：大屏据此画"错选分布"（哪个干扰项最吸引人）
        picked: Array.isArray(cmd.choice) ? cmd.choice.join('') : (cmd.choice || ''),
        // 多答案题的部分得分：按命中比例算出来的 ratio（见 grade.js::auto）
        ratio: graded.ratio,
        // 分数也由 Rust 给（没给就本地算）
        points: graded.points
      });

      CI.store.tx('class-answer-feed', function (st) {
        pushFeed(st, {
          kind: 'answer', teamId: cmd.teamId, sid: sid, qid: question ? question.id : null,
          result: graded.result, answer: desc, expected: graded.expected, auto: true,
          points: rec ? rec.points : 0,
          text: studentName(st, sid) + ' ' + desc + ' → ' +
            (CI.store.RESULT_LABEL[graded.result] || graded.result) +
            (rec && rec.points ? ('（' + (rec.points > 0 ? '+' : '') + rec.points + '）') : '')
        });
      }, {});

      lastAutoResult = { sid: sid, result: graded.result, points: rec ? rec.points : 0 };
      return { kind: 'answer', ok: true, result: graded.result, sid: sid, points: rec ? rec.points : 0 };
    }

    return null;
  }

  /** 教师确认一条待判提交 */
  function resolvePending(pendingId, result, opts) {
    opts = opts || {};
    var done = null;
    CI.store.tx('class-resolve', function (s) {
      var c = box(s);
      var idx = -1;
      c.pending.forEach(function (p, i) { if (p.id === pendingId) idx = i; });
      if (idx < 0) return;
      var item = c.pending[idx];
      c.pending.splice(idx, 1);
      var q = item.qid ? CI.store.question(s, item.qid) : currentQuestion(s);
      var rec = CI.store.recordResult({
        sid: item.sid,
        qid: q ? q.id : null,
        tier: q ? q.tier : (s.tiers[0] ? s.tiers[0].key : 'basic'),
        result: result,
        quizId: item.quizId || s.runtime.quizId || null,
        source: 'student',
        note: item.answer,
        by: 'classroom-confirm'
      });
      pushFeed(s, {
        kind: 'confirm', teamId: item.teamId, sid: item.sid, qid: q ? q.id : null,
        result: result, points: rec ? rec.points : 0, answer: item.answer,
        text: studentName(s, item.sid) + ' 教师判定：' + (CI.store.RESULT_LABEL[result] || result) +
          (rec && rec.points ? ('（' + (rec.points > 0 ? '+' : '') + rec.points + '）') : '')
      });
      done = { item: item, rec: rec };
    }, {
      type: '教师判定',
      detail: function (s, r0) {
        return done ? (studentName(s, done.item.sid) + ' · ' + (CI.store.RESULT_LABEL[result] || result)) : '';
      }
    });
    return done;
  }

  /** 丢弃一条待判提交（不记分） */
  function dropPending(pendingId) {
    return CI.store.tx('class-drop', function (s) {
      var c = box(s);
      var hit = null;
      c.pending = c.pending.filter(function (p) { if (p.id === pendingId) { hit = p; return false; } return true; });
      if (hit) pushFeed(s, { kind: 'drop', teamId: hit.teamId, sid: hit.sid, text: studentName(s, hit.sid) + ' 的提交已被丢弃' });
      return hit;
    }, { type: '丢弃提交' });
  }

  function clearBuzz() {
    return CI.store.tx('class-buzz-clear', function (s) { box(s).buzz = []; }, { type: '清空抢答榜' });
  }

  function clearFeed() {
    return CI.store.tx('class-feed-clear', function (s) { box(s).feed = []; box(s).pending = []; box(s).buzz = []; }, { type: '清空课堂实时流' });
  }

  function setAccepting(v) {
    return CI.store.tx('class-accepting', function (s) {
      s.runtime.accepting = !!v;
      pushFeed(s, { kind: 'system', text: v ? '已开始接收学生作答' : '已停止接收学生作答' });
    }, { type: v ? '开始作答' : '停止作答' });
  }

  function setReveal(v) {
    return CI.store.tx('class-reveal', function (s) {
      s.runtime.reveal = !!v;
      // 记住"公布的是哪一道题"：换题后自动失效，避免下一题的答案提前泄露给学生端与大屏
      s.runtime.revealedQid = v ? (s.runtime.qid || null) : null;
      pushFeed(s, { kind: 'system', text: v ? '已公布答案' : '已隐藏答案' });
    }, { type: v ? '公布答案' : '隐藏答案' });
  }

  /** 当前题是否处于"已公布答案"状态（按题判断，换题即失效） */
  /**
   * 学生端 / 大屏能看到的题目视图
   *
   * 与 Rust `question_stats::student_view` **同契约**（parity 逐字段比对）。
   * 这里的每一条都是规则，不是传输：
   *   · 没公布答案就不下发 answerKey / explanation —— 提前下发会泄题
   *   · multiple = 答案字母多于一个；hasAnswer = 题目有标准答案
   *   · 短题干截断（大屏一行放不下，120 字）
   */
  function studentView(s, q) {
    if (!q) return null;
    var letters = CI.grade.LETTERS;
    var revealed = isRevealed(s, q);
    var answer = String(q.answer || '').trim();
    return {
      id: q.id,
      stem: CI.util.shortStem(q.stem, 120),
      fullStem: q.stem,
      imageUrl: q.imageUrl || '',
      tier: q.tier,
      tierLabel: CI.store.tierOf(s, q.tier).label,
      points: CI.store.questionPoints(s, q),
      multiple: CI.grade.parseChoice(answer).length > 1,
      options: (q.options || []).map(function (text, i) {
        return { key: letters[i], text: text };
      }),
      hasAnswer: !!answer,
      answerKey: (revealed && answer) ? CI.grade.answerKey(q) : null,
      explanation: revealed ? String(q.note || '') : '',
      tags: (q.tags || []).slice(0, 4)
    };
  }

  function isRevealed(s, q) {
    s = s || CI.store.get();
    q = q || currentQuestion(s);
    return !!(s.runtime.reveal && q && s.runtime.revealedQid === q.id);
  }

  /**
   * 推送题目：在当前试卷内前后翻题（教师端「⑦ 课堂协同」不用切到②就能上课）
   * @param {Number} delta -1 上一题 / +1 下一题
   * @returns {Object|null} {qid, index, total}
   */
  function moveQuestion(delta) {
    var s = CI.store.get();
    var qz = s.runtime.quizId ? CI.store.quiz(s, s.runtime.quizId) : null;
    if (!qz || !qz.questionIds.length) return null;
    var ids = qz.questionIds;
    var idx = ids.indexOf(s.runtime.qid);
    if (idx < 0) idx = delta > 0 ? -1 : 0;
    var next = idx + (delta > 0 ? 1 : -1);
    if (next < 0) next = 0;
    if (next > ids.length - 1) next = ids.length - 1;
    if (ids[next] === s.runtime.qid) return { qid: s.runtime.qid, index: next, total: ids.length, edge: true };
    CI.store.tx('class-push-question', function (st) {
      st.runtime.qid = ids[next];
      st.runtime.reveal = false;          // 新题默认不公布答案
      st.runtime.revealedQid = null;
      pushFeed(st, { kind: 'system', text: '已推送第 ' + (next + 1) + ' 题给学生端与大屏' });
    }, { type: '推送题目', detail: function (st) { return '第 ' + (next + 1) + '/' + ids.length + ' 题'; } });
    return { qid: ids[next], index: next, total: ids.length };
  }

  /** 把抢答第一名的队伍设为当前学生（方便老师点名判分） */
  function focusBuzz(buzzId) {
    var s = CI.store.get();
    var hit = box(s).buzz.filter(function (b) { return b.id === buzzId; })[0];
    if (!hit) return null;
    var sid = hit.sid || pickAnswerer(s, hit.teamId, null);
    if (sid) CI.store.setRuntime({ sid: sid });
    return sid;
  }

  /** 手动恢复：确认后整体替换本机数据（教师换电脑/清了浏览器数据时用） */
  function loadRemoteState(payload) {
    if (!payload || !payload.state) { root.alert && root.alert('枢纽上没有课堂数据存档'); return false; }
    var ok = root.confirm
      ? root.confirm('用枢纽上的课堂数据覆盖本机？\n（枢纽存档更新于 ' + U.fmtTime(payload.updatedAt) + '）')
      : true;
    if (!ok) return false;
    var done = applyRemote(payload);
    if (done && root.alert) root.alert('已从枢纽恢复课堂数据');
    return done;
  }

  /** 把枢纽缓存的完整课堂数据写回本地（教师端换设备/重装浏览器后继续上课） */
  function applyRemote(payload) {
    if (!payload || !payload.state) return false;
    CI.store.importAll(payload.state);
    CI.store.tx('class-restore', function (s) {
      pushFeed(s, { kind: 'system', text: '已从枢纽恢复课堂数据（' + U.fmtTime(payload.updatedAt) + '）' });
    }, { type: '恢复课堂数据' });
    return true;
  }

  /* ------------------------------------------------------------------ *
   * 在线状态
   * ------------------------------------------------------------------ */

  function setPresence(msg) {
    presence = { hostOnline: !!msg.hostOnline, teams: msg.teams || [] };
    renderTeams();
    renderRoom();
  }

  function setServerInfo(info) {
    serverInfo = info;
    renderRoom();
  }

  function onlineTeamIds() {
    var out = {};
    (presence.teams || []).forEach(function (t) { if (t.online) out[t.teamId] = true; });
    return out;
  }

  /* ------------------------------------------------------------------ *
   * 渲染
   * ------------------------------------------------------------------ */

  function render() {
    renderRoom();
    renderTeams();
    renderControl();
    renderBuzz();
    renderPending();
    renderFeed();
    if (CI.net && CI.net.render) CI.net.render();      // 组网面板（EasyTier）
  }

  function renderRoom() {
    var s = CI.store.get();
    var boxEl = el('classRoom');
    if (!boxEl) return;
    var url = CI.sync.joinURL();
    var info = serverInfo || CI.sync.serverInfo();
    var qrOk = !!(info && info.qrcode && url);
    var connText = CI.sync.connected()
      ? ('已连接枢纽' + (CI.sync.sameOrigin() ? '（本机同源）' : '（' + CI.sync.host() + '）'))
      : '未连接枢纽（单机模式：学生端无法参与，教师端功能不受影响）';
    var allIPs = (info && info.ips) ? info.ips : [];
    var otherIPs = allIPs.slice(1).map(function (ip) { return 'http://' + ip + ':' + ((info && info.port) || 8080) + '/join?room=' + CI.sync.room(); });

    boxEl.innerHTML =
      '<div class="class-room-grid">' +
        '<div class="class-room-main">' +
          '<div class="fld-row">' +
            '<label class="fld"><span>房间号（学生端需一致）</span>' +
              '<input id="classRoomInput" value="' + U.escapeHTML(CI.sync.room()) + '"></label>' +
            '<button class="btn btn-plus" onclick="CI.classroom.saveRoom()">保存并重连</button>' +
          '</div>' +
          '<div class="class-join">' +
            '<div class="join-label">学生端地址（手机/平板浏览器输入，或用 EasyTier 虚拟 IP）</div>' +
            '<div class="join-url" id="classJoinUrl">' + U.escapeHTML(url || '（未连接枢纽）') + '</div>' +
            (url ? '' :
              '<div class="hint-inline" style="margin-bottom:8px">' +
              (CI.sync.sameOrigin() || CI.sync.connected()
                ? '暂时拿不到本机地址：请确认枢纽进程在运行（双击「启动课堂.cmd」或 npm start），然后刷新本页。'
                : '当前是<b>单机模式</b>（直接以文件方式打开了 admin.html，或枢纽没启动）：记分/点名/组卷/学情都能正常用，' +
                  '但学生端与大屏接不进来。需要多端协同时，请先运行「启动课堂.cmd」，再访问 ' +
                  '<b>http://localhost:8080/admin.html</b>。') +
              '</div>') +
            '<div class="class-join-ops">' +
              '<button class="mini-btn" onclick="CI.classroom.copyJoin()"' + (url ? '' : ' disabled') + '>复制地址</button>' +
              (url ? '<a class="mini-btn" href="' + U.escapeHTML(url) + '" target="_blank" rel="noopener">本机打开学生端 ↗</a>' : '') +
              '<a class="mini-btn" href="' + U.escapeHTML(CI.sync.sameOrigin() ? 'index.html' : 'stage') + '" target="_blank" rel="noopener">打开大屏 ↗</a>' +
              '<span class="hint-inline">' + U.escapeHTML(connText) + '</span>' +
            '</div>' +
            (otherIPs.length
              ? '<div class="hint-inline" style="margin-top:8px">本机还有其它地址（多网卡 / EasyTier 时学生端改用其一）：' +
                otherIPs.map(function (ip) { return U.escapeHTML(ip); }).join('、') + '</div>'
              : '') +
          '</div>' +
        '</div>' +
        '<div class="class-qr">' +
          (qrOk
            ? '<img alt="学生端二维码" src="' + U.escapeHTML(CI.sync.qrURL(url)) + '" onerror="this.style.display=\'none\';document.getElementById(\'classQrFallback\').style.display=\'block\'">'
            : '') +
          '<div id="classQrFallback" class="qr-fallback" style="' + (qrOk ? 'display:none' : '') + '">' +
            (qrOk ? '' : '未安装 qrcode 依赖（<code>npm i qrcode</code> 后可用二维码）<br>请让学生手动输入左侧地址') +
          '</div>' +
        '</div>' +
      '</div>';
  }

  function renderTeams() {
    var s = CI.store.get();
    var boxEl = el('classTeams');
    if (!boxEl) return;
    var online = onlineTeamIds();
    var teams = s.teams || [];
    var onlineCount = 0;
    var rows = teams.map(function (t) {
      var isOn = !!online[t.id];
      if (isOn) onlineCount++;
      var members = CI.store.studentsOf(s, t.id);
      return '<div class="online-team ' + (isOn ? 'is-online' : '') + '" style="border-left-color:' + t.color + '">' +
        '<span class="dot"></span>' +
        '<span class="ot-name">' + U.escapeHTML(t.icon + ' ' + t.name) + '</span>' +
        '<span class="ot-sub">' + members.length + ' 人 · ' + CI.store.teamScore(s, t.id) + ' 分</span>' +
        '<span class="ot-state">' + (isOn ? '在线' : '未入座') + '</span>' +
      '</div>';
    }).join('');
    boxEl.innerHTML =
      '<div class="panel-title">小组入座情况 <span class="panel-sub">（' + onlineCount + '/' + teams.length +
        ' 组在线；学生在 ' + U.escapeHTML(CI.sync.joinURL()) + ' 选自己的队伍即可）</span></div>' +
      '<div class="online-teams">' + (rows || '<div class="empty">还没有队伍，请先在「班级与积分」创建</div>') + '</div>';
  }

  function renderControl() {
    var s = CI.store.get();
    var boxEl = el('classControl');
    if (!boxEl) return;
    var q = currentQuestion(s);
    var qz = s.runtime.quizId ? CI.store.quiz(s, s.runtime.quizId) : null;
    var total = qz ? qz.questionIds.length : 0;
    var idx = (qz && q) ? qz.questionIds.indexOf(q.id) : -1;
    var revealed = isRevealed(s, q);

    boxEl.innerHTML =
      '<div class="class-ctl-row">' +
        '<button class="btn" onclick="CI.classroom.moveQuestion(-1)"' + (idx <= 0 ? ' disabled' : '') + '>← 上一题</button>' +
        '<button class="btn btn-plus" onclick="CI.classroom.moveQuestion(1)"' + (total === 0 || idx >= total - 1 ? ' disabled' : '') + '>下一题 →</button>' +
        '<span class="chip">' + (idx >= 0 ? ('第 ' + (idx + 1) + ' / ' + total + ' 题') : (total ? ('共 ' + total + ' 题，未选当前题') : '本套题还没有题目')) + '</span>' +
        '<button class="btn btn-plus" onclick="CI.classroom.toggleAccepting()">' +
          (s.runtime.accepting ? '⏸ 停止接收作答' : '▶ 开始接收作答') + '</button>' +
        '<button class="btn ' + (revealed ? 'btn-minus' : '') + '" onclick="CI.classroom.toggleReveal()">' +
          (revealed ? '隐藏答案' : '公布答案') + '</button>' +
        '<button class="btn" onclick="location.hash = \'#/papers\'">去组卷 / 选题</button>' +
        '<button class="btn" onclick="CI.classroom.clearBuzz()">清空抢答榜</button>' +
        '<button class="btn" onclick="CI.classroom.clearFeed()">清空实时流与待确认</button>' +
        '<button class="btn" onclick="CI.classroom.restoreFromHub()" title="教师端换了电脑/清了浏览器数据时，从枢纽拉回最近一次课堂数据">从枢纽恢复课堂数据</button>' +
      '</div>' +
      '<div class="class-ctl-row">' +
        '<span class="chip ' + (s.runtime.accepting ? 'chip-ok' : 'chip-warn') + '">' +
          (s.runtime.accepting ? '正在接收作答' : '未开放作答') + '</span>' +
        '<span class="chip">当前题：<b>' + (q ? U.escapeHTML(U.shortStem(q.stem, 28)) : '未选择') + '</b>' +
          (q ? '（' + U.escapeHTML(CI.grade.typeLabel(q)) + ' ' + CI.store.questionPoints(s, q) + ' 分）' : '') + '</span>' +
        (q && q.options && q.options.length ? '<span class="chip">选项 ' + q.options.length + ' 项</span>' : '') +
        (isRevealed(s, q) ? '<span class="chip chip-warn">答案已公布</span>' : '') +
      '</div>' +
      '<div class="hint-inline">「下一题」会立即把新题推给所有学生端与大屏，并自动收起上一题的答案；学生端只在「开始接收作答」后可以提交。客观题自动判分并立即加分，主观题进入下方「待确认」队列由你判定。</div>';
  }

  function renderBuzz() {
    var s = CI.store.get();
    var boxEl = el('classBuzz');
    if (!boxEl) return;
    var list = box(s).buzz;
    if (!list.length) { boxEl.innerHTML = '<div class="empty">暂无抢答</div>'; return; }
    boxEl.innerHTML = list.map(function (b, i) {
      return '<div class="buzz-row">' +
        '<span class="buzz-rank">' + (i + 1) + '</span>' +
        '<span class="buzz-team">' + U.escapeHTML(teamName(s, b.teamId)) + '</span>' +
        '<span class="buzz-sid">' + U.escapeHTML(b.sid ? studentName(s, b.sid) : '') + '</span>' +
        '<span class="buzz-time">' + U.fmtClock(b.at) + '</span>' +
        '<button class="mini-btn" onclick="CI.classroom.focusBuzz(\'' + b.id + '\')">设为当前学生</button>' +
      '</div>';
    }).join('');
  }

  function renderPending() {
    var s = CI.store.get();
    var boxEl = el('classPending');
    if (!boxEl) return;
    var list = box(s).pending;
    if (!list.length) { boxEl.innerHTML = '<div class="empty">没有待确认的提交</div>'; return; }
    boxEl.innerHTML = list.map(function (p) {
      var q = p.qid ? CI.store.question(s, p.qid) : null;
      return '<div class="pending-row">' +
        '<div class="pd-main">' +
          '<div class="pd-head"><b>' + U.escapeHTML(studentName(s, p.sid)) + '</b>' +
            '<span class="tag tag-plain">' + U.escapeHTML(teamName(s, p.teamId)) + '</span>' +
            '<span class="pd-time">' + U.fmtClock(p.at) + '</span></div>' +
          '<div class="pd-answer">' + U.escapeHTML(p.answer || '（空）') + '</div>' +
          '<div class="pd-q">' + U.escapeHTML(q ? U.shortStem(q.stem, 36) : '（无当前题）') +
            (q && q.answer ? '　参考答案：' + U.escapeHTML(CI.grade.answerKey(q)) : '') + '</div>' +
        '</div>' +
        '<div class="pd-ops">' +
          '<button class="mini-btn mini-ok" onclick="CI.classroom.resolve(\'' + p.id + '\',\'correct\')">答对</button>' +
          '<button class="mini-btn" onclick="CI.classroom.resolve(\'' + p.id + '\',\'half\')">部分对</button>' +
          '<button class="mini-btn mini-danger" onclick="CI.classroom.resolve(\'' + p.id + '\',\'wrong\')">答错</button>' +
          '<button class="mini-btn" onclick="CI.classroom.resolve(\'' + p.id + '\',\'skip\')">跳过</button>' +
          '<button class="mini-btn" onclick="CI.classroom.drop(\'' + p.id + '\')">丢弃</button>' +
        '</div>' +
      '</div>';
    }).join('');
  }

  function renderFeed() {
    var s = CI.store.get();
    var boxEl = el('classFeed');
    if (!boxEl) return;
    var list = box(s).feed.slice(0, 30);
    if (!list.length) { boxEl.innerHTML = '<div class="empty">暂无课堂动态</div>'; return; }
    boxEl.innerHTML = list.map(function (f) {
      var color = f.result === 'correct' ? '#2e7d32' : f.result === 'half' ? '#f9a825' : (f.result === 'wrong' ? '#c62828' : '#546e7a');
      return '<div class="feed-row">' +
        '<span class="feed-time">' + U.fmtClock(f.at) + '</span>' +
        '<span class="feed-team">' + U.escapeHTML(f.teamId ? teamName(s, f.teamId) : '系统') + '</span>' +
        '<span class="feed-text" style="color:' + (f.result ? color : 'inherit') + '">' + U.escapeHTML(f.text || '') + '</span>' +
        (f.auto ? '<span class="tag tag-plain">自动</span>' : '') +
        (f.points ? '<span class="feed-pts">' + (f.points > 0 ? '+' : '') + f.points + '</span>' : '') +
      '</div>';
    }).join('');
  }

  /* ------------------------------------------------------------------ *
   * 教师操作
   * ------------------------------------------------------------------ */

  function toggleAccepting() {
    var s = CI.store.get();
    if (!s.runtime.accepting && !currentQuestion(s)) {
      if (!root.confirm || root.confirm('还没有选择当前题，学生端会看到“等待老师出题”。仍要开始吗？')) {
        setAccepting(true);
      }
      return;
    }
    setAccepting(!s.runtime.accepting);
  }

  function toggleReveal() { setReveal(!isRevealed()); }

  function resolve(id, result) { resolvePending(id, result); }

  function drop(id) {
    if (root.confirm && !root.confirm('丢弃这条提交？不会记分。')) return;
    dropPending(id);
  }

  function saveRoom() {
    var input = el('classRoomInput');
    var v = input ? String(input.value || '').trim() : '';
    if (!v) { root.alert && root.alert('请输入房间号，例如 class1'); return; }
    var clean = CI.sync.setRoom(v);
    root.alert && root.alert('房间已切换为 ' + clean + '，学生端地址已更新');
    render();
  }

  function copyJoin() {
    var url = CI.sync.joinURL();
    if (!url) { root.alert && root.alert('当前没有可用的学生端地址：请先启动枢纽（「启动课堂.cmd」或 npm start），并用 http://localhost:8080/admin.html 打开本页'); return; }
    (U.copyText ? U.copyText(url) : Promise.reject()).then(function () {
      root.alert && root.alert('已复制：' + url);
    }, function () {
      root.prompt && root.prompt('复制下面的地址发给学生：', url);
    });
  }

  /** 手动从枢纽拉取最近一次课堂数据（换电脑/清了浏览器数据时用） */
  function restoreFromHub() {
    if (!CI.sync.connected()) { root.alert && root.alert('未连接枢纽，无法恢复'); return; }
    CI.sync.requestDump(true);
  }

  function metaPayload() {
    var s = CI.store.get();
    var c = box(s);
    var sid = s.runtime.sid || null;
    var stu = sid ? CI.store.student(s, sid) : null;
    return {
      /* 课堂环节：大屏/学生端据此决定"现在显示什么" */
      phase: phase(s),
      phaseLabel: PHASE_LABEL[phase(s)] || '待机',
      /* 课堂计时器：只广播"结束时刻"，各端本地渲染倒计时（断网也照走） */
      timerEndsAt: s.runtime.timerEndsAt || null,
      timerLabel: s.runtime.timerLabel || '',
      /* 签到统计：已入座的队伍 / 全部队伍（学习通的「签到」经验） */
      checkin: checkinStats(s),
      /* 选项分布（错选分布）：哪个干扰项最吸引人 —— 大屏据此显示"40% 的人选了 B"，
         比"谁对谁错"更有讲评价值（Wayground 的 Questions 视图就是这个） */
      optionDist: (function () {
        try { return CI.analysis.optionDistribution(s, s.runtime.qid || null); } catch (e) { return []; }
      })(),
      /* 讲评建议：正确率最低的几道题（点评环节大屏直接显示，老师照着讲） */
      hardestQuestions: (function () {
        try {
          var stats = CI.analysis.questionStats(s, s.runtime.quizId || null);
          return stats.filter(function (x) { return x.attempts > 0; }).slice(0, 3).map(function (x) {
            return {
              qid: x.qid, stem: x.stem, tierLabel: x.tierLabel,
              attempts: x.attempts, correctRate: x.correctRate,
              missCount: x.wrong + x.skip, missers: x.missers.slice(0, 4)
            };
          });
        } catch (e) { return []; }
      })(),
      /* 当前被点到的学生（点名环节大屏放大显示） */
      sid: sid,
      sidName: stu ? stu.name : '',
      sidTeamName: stu ? teamName(s, stu.teamId) : '',
      sidCalled: stu ? CI.store.calledCount(s, sid) : 0,
      /* 各队答题情况（点评环节 + 学生端"其他队答对多少"） */
      teamStats: teamStats(s),
      /* 能力评价：全班 + 各队（含评级与评语），用于点评环节的雷达 */
      ability: abilityPayload(s),
      accepting: !!s.runtime.accepting,
      reveal: !!s.runtime.reveal,
      buzz: c.buzz.slice(0, 20).map(function (b) {
        return { id: b.id, teamId: b.teamId, teamName: teamName(s, b.teamId), sid: b.sid, sidName: b.sid ? studentName(s, b.sid) : '', at: b.at };
      }),
      pending: c.pending.slice(0, 30).map(function (p) {
        return { id: p.id, teamId: p.teamId, teamName: teamName(s, p.teamId), sid: p.sid, sidName: studentName(s, p.sid), answer: p.answer, at: p.at };
      }),
      feed: c.feed.slice(0, 20).map(function (f) {
        return { id: f.id, at: f.at, teamId: f.teamId || null, teamName: f.teamId ? teamName(s, f.teamId) : '', text: f.text || '', result: f.result || null, points: f.points || 0, auto: !!f.auto };
      })
    };
  }

  CI.classroom = {
    handleCmd: handleCmd, metaPayload: metaPayload,
    PHASES: PHASES, PHASE_LABEL: PHASE_LABEL, phase: phase, setPhase: setPhase,
    teamStats: teamStats, abilityPayload: abilityPayload,
    setPresence: setPresence, setServerInfo: setServerInfo,
    resolvePending: resolvePending, dropPending: dropPending,
    addBuzz: addBuzz, clearBuzz: clearBuzz, clearFeed: clearFeed,
    setAccepting: setAccepting, setReveal: setReveal, isRevealed: isRevealed, moveQuestion: moveQuestion,
    /* 课堂节奏：计时器 + 签到统计 */
    setTimer: setTimer, clearTimer: clearTimer, timerLeft: timerLeft, formatLeft: formatLeft,
    studentView: studentView,
    checkinStats: checkinStats,
    focusBuzz: focusBuzz, loadRemoteState: loadRemoteState, applyRemote: applyRemote,
    pickAnswerer: pickAnswerer, currentQuestion: currentQuestion, box: box,
    lastAutoResult: function () { return lastAutoResult; },
    presence: function () { return presence; },
    // UI 包装
    render: render, toggleAccepting: toggleAccepting, toggleReveal: toggleReveal,
    resolve: resolve, drop: drop, saveRoom: saveRoom, copyJoin: copyJoin, restoreFromHub: restoreFromHub
  };
})(typeof window !== 'undefined' ? window : globalThis);
