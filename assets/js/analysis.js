/*!
 * analysis.js — 学情分析：按题型/知识点统计、薄弱点识别、文字总结生成、导出
 *
 * 纯计算模块（不触碰 DOM），所有函数接收 state，便于 Node 单测。
 * 统计口径（详见 docs/05-学情分析与总结.md）：
 *   attempts   计入统计的作答次数（含 skip，不含手动调整）
 *   correctRate 严格正确率 = 答对 / 作答次数
 *   creditRate  加权得分率 = (答对 + 部分对 × halfRatio) / 作答次数 —— 与加分口径一致，用于薄弱判定
 *   earnRate    实得分 / 满分基准（受抢答加分与答错扣分影响）
 */
(function (root) {
  'use strict';

  var CI = root.CI = root.CI || {};
  var U = CI.util;

  function settings(s) { return s.settings || {}; }

  /** 该流水是否计入统计 */
  function counts(s, r) {
    if (!CI.store.isCountable(r)) return false;
    if (r.source === 'quick' && settings(s).quickCountsAsAttempt === false) return false;
    return true;
  }

  function blankBucket() {
    return { attempts: 0, correct: 0, half: 0, wrong: 0, skip: 0, earned: 0, base: 0 };
  }

  function addToBucket(b, r) {
    b.attempts += 1;
    if (r.result === 'correct') b.correct += 1;
    else if (r.result === 'half') b.half += 1;
    else if (r.result === 'wrong') b.wrong += 1;
    else if (r.result === 'skip') b.skip += 1;
    b.earned += U.num(r.points, 0);
    b.base += U.num(r.base, 0);
  }

  function finalizeBucket(s, b, extra) {
    var halfRatio = U.num(settings(s).halfRatio, 0.5);
    var credit = b.correct + b.half * halfRatio;
    var out = Object.assign({
      attempts: b.attempts,
      correct: b.correct,
      half: b.half,
      wrong: b.wrong,
      skip: b.skip,
      earned: Math.round(b.earned * 100) / 100,
      base: Math.round(b.base * 100) / 100,
      correctRate: U.pct(b.correct, b.attempts),
      creditRate: U.pct(credit, b.attempts),
      earnRate: U.pct(b.earned, b.base)
    }, extra || {});
    return out;
  }

  /**
   * 学生学情统计
   * @returns {Object} {sid,name,teamId,teamName,score,total,tiers[],tags[],rolls,lastAt,weak[],strong[],level}
   */
  function studentStats(state, sid) {
    var s = state || CI.store.get();
    var stu = CI.store.student(s, sid);
    if (!stu) return null;
    var team = CI.store.team(s, stu.teamId);

    var recs = CI.store.recordsOf(s, { sid: sid }).filter(function (r) { return counts(s, r); });
    var total = blankBucket();
    var tierMap = {};
    var tagMap = {};

    (s.tiers || []).forEach(function (t) {
      tierMap[t.key] = { key: t.key, label: t.label, color: t.color, weight: t.weight, bucket: blankBucket() };
    });

    recs.forEach(function (r) {
      addToBucket(total, r);
      if (!tierMap[r.tier]) {
        var t = CI.store.tierOf(s, r.tier);
        tierMap[r.tier] = { key: t.key, label: t.label, color: t.color, weight: t.weight, bucket: blankBucket() };
      }
      addToBucket(tierMap[r.tier].bucket, r);

      var q = r.qid ? CI.store.question(s, r.qid) : null;
      var tags = q && q.tags && q.tags.length ? q.tags : ['未标注'];
      tags.forEach(function (tag) {
        if (!tagMap[tag]) tagMap[tag] = blankBucket();
        addToBucket(tagMap[tag], r);
      });
    });

    var tiers = Object.keys(tierMap).map(function (k) {
      return finalizeBucket(s, tierMap[k].bucket, {
        key: tierMap[k].key, label: tierMap[k].label,
        color: tierMap[k].color, weight: tierMap[k].weight
      });
    }).sort(function (a, b) { return tierOrder(s, a.key) - tierOrder(s, b.key); });

    var tags = Object.keys(tagMap).map(function (k) {
      return finalizeBucket(s, tagMap[k], { tag: k });
    }).sort(function (a, b) { return b.attempts - a.attempts; });

    var st = settings(s);
    var minSample = U.num(st.minSample, 2);
    var weakThreshold = U.num(st.weakThreshold, 0.6);
    var strongThreshold = U.num(st.strongThreshold, 0.85);

    var weak = [], strong = [];
    tiers.forEach(function (t) {
      if (t.attempts >= minSample) {
        if (t.creditRate < weakThreshold * 100) weak.push(t.key);
        else if (t.creditRate >= strongThreshold * 100) strong.push(t.key);
      }
    });
    weak.sort(function (a, b) { return rateOf(tiers, a) - rateOf(tiers, b); });

    var rolls = CI.store.calledCount(s, sid);
    var all = CI.store.recordsOf(s, { sid: sid });
    var lastAt = all.length ? all[all.length - 1].at : 0;

    return {
      sid: stu.id,
      name: stu.name,
      teamId: stu.teamId,
      teamName: team ? team.name : '未分组',
      score: CI.store.scoreOf(s, sid),
      total: finalizeBucket(s, total),
      tiers: tiers,
      tags: tags,
      rolls: rolls,
      lastAt: lastAt,
      weak: weak,
      strong: strong,
      level: levelOf(finalizeBucket(s, total), weak, strong, minSample)
    };
  }

  function tierOrder(s, key) {
    var i = (s.tiers || []).findIndex(function (t) { return t.key === key; });
    return i < 0 ? 999 : i;
  }

  function rateOf(tiers, key) {
    var hit = tiers.filter(function (t) { return t.key === key; })[0];
    return hit ? hit.creditRate : 0;
  }

  function levelOf(total, weak, strong, minSample) {    if (total.attempts < minSample) return { key: 'insufficient', label: '样本不足', color: '#90a4ae' };
    if (weak.length === 0 && total.creditRate >= 85) return { key: 'excellent', label: '优秀', color: '#43a047' };
    if (weak.length === 0) return { key: 'good', label: '良好', color: '#7cb342' };
    if (weak.length >= 2) return { key: 'warn', label: '需重点关注', color: '#ef6c00' };
    return { key: 'normal', label: '有待提升', color: '#fb8c00' };
  }

  /** 全班（或某队伍）统计 */
  function classStats(state, teamId) {
    var s = state || CI.store.get();
    var list = CI.store.studentsOf(s, teamId);
    var total = blankBucket();
    var tierMap = {};

    (s.tiers || []).forEach(function (t) { tierMap[t.key] = blankBucket(); });

    list.forEach(function (stu) {
      var stats = studentStats(s, stu.id);
      stats.total && addBucket(total, stats.total);
      stats.tiers.forEach(function (t) {
        if (!tierMap[t.key]) tierMap[t.key] = blankBucket();
        addBucket(tierMap[t.key], t);
      });
    });

    var tiers = Object.keys(tierMap).map(function (k) {
      var t = CI.store.tierOf(s, k);
      return finalizeBucket(s, tierMap[k], { key: k, label: t.label, color: t.color, weight: t.weight });
    }).sort(function (a, b) { return tierOrder(s, a.key) - tierOrder(s, b.key); });

    var st = settings(s);
    var minSample = U.num(st.minSample, 2);
    var weakThreshold = U.num(st.weakThreshold, 0.6) * 100;

    var ranked = ranking(s, teamId);
    var weakTiers = tiers.filter(function (t) { return t.attempts >= minSample && t.creditRate < weakThreshold; })
      .sort(function (a, b) { return a.creditRate - b.creditRate; });

    return {
      teamId: teamId || 'all',
      studentCount: list.length,
      activeCount: list.filter(function (x) { return x.active !== false; }).length,
      participants: ranked.filter(function (r) { return r.attempts > 0; }).length,
      total: finalizeBucket(s, total),
      tiers: tiers,
      weakTiers: weakTiers.map(function (t) { return t.key; }),
      ranking: ranked,
      needHelp: ranked.filter(function (r) { return r.weakCount > 0 || (r.attempts >= minSample && r.creditRate < weakThreshold); })
    };
  }

  function addBucket(target, src) {
    target.attempts += src.attempts; target.correct += src.correct;
    target.half += src.half; target.wrong += src.wrong; target.skip += src.skip;
    target.earned += src.earned; target.base += src.base;
    return target;
  }

  /** 排行榜：学生个人（可按队伍过滤） */
  function ranking(state, teamId) {
    var s = state || CI.store.get();
    var list = CI.store.studentsOf(s, teamId).map(function (stu) {
      var stats = studentStats(s, stu.id);
      return {
        sid: stu.id,
        name: stu.name,
        teamId: stu.teamId,
        teamName: stats.teamName,
        score: stats.score,
        attempts: stats.total.attempts,
        correct: stats.total.correct,
        creditRate: stats.total.creditRate,
        correctRate: stats.total.correctRate,
        rolls: stats.rolls,
        weakCount: stats.weak.length,
        level: stats.level,
        tiers: stats.tiers
      };
    });
    list.sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      if (b.creditRate !== a.creditRate) return b.creditRate - a.creditRate;
      return a.name.localeCompare(b.name, 'zh-Hans-CN');
    });
    list.forEach(function (r, i) { r.rank = i + 1; });
    return list;
  }

  /** 队伍榜：队伍分 = 成员分之和 */
  function teamRanking(state) {
    var s = state || CI.store.get();
    var list = (s.teams || []).map(function (t) {
      var members = CI.store.studentsOf(s, t.id);
      var st = classStats(s, t.id);
      return {
        teamId: t.id,
        name: t.name,
        icon: t.icon,
        color: t.color,
        score: CI.store.teamScore(s, t.id),
        memberCount: members.length,
        avg: members.length ? Math.round((CI.store.teamScore(s, t.id) / members.length) * 10) / 10 : 0,
        creditRate: st.total.creditRate,
        attempts: st.total.attempts,
        weakTiers: st.weakTiers
      };
    });
    list.sort(function (a, b) { return b.score - a.score; });
    list.forEach(function (r, i) { r.rank = i + 1; });
    return list;
  }

  /* ------------------------------------------------------------------ *
   * 文字总结
   * ------------------------------------------------------------------ */

  function tierLine(s, t) {
    if (!t.attempts) return '· ' + t.label + '：未作答';
    var tag = '';
    if (t.creditRate >= 85) tag = '，掌握扎实';
    else if (t.creditRate >= 70) tag = '，基本掌握';
    else if (t.creditRate >= 60) tag = '，仍需巩固';
    else tag = '，明显薄弱';
    return '· ' + t.label + '：作答 ' + t.attempts + ' 题，正确 ' + t.correct + ' 题' +
      (t.half ? '（部分正确 ' + t.half + '）' : '') +
      '，加权得分率 ' + t.creditRate + '%（+' + t.earned + ' 分）' + tag;
  }

  /**
   * 单个学生的文字总结
   * @returns {Object} {title, lines:[], text, stats}
   */
  function summarizeStudent(state, sid, opts) {
    opts = opts || {};
    var s = state || CI.store.get();
    var stats = studentStats(s, sid);
    if (!stats) return null;

    var lines = [];
    lines.push('【' + stats.name + ' · ' + stats.teamName + '】当前积分 ' + stats.score + ' 分，综合评定：' + stats.level.label);
    if (stats.total.attempts === 0) {
      lines.push('· 本阶段尚未作答记录，' + (stats.rolls ? ('被点名 ' + stats.rolls + ' 次') : '也未被点名') + '，建议优先安排基础题建立参与感。');
      return { title: stats.name, lines: lines, text: lines.join('\n'), stats: stats };
    }

    lines.push('· 共作答 ' + stats.total.attempts + ' 题：答对 ' + stats.total.correct +
      '、部分正确 ' + stats.total.half + '、答错 ' + stats.total.wrong + '、跳过 ' + stats.total.skip +
      '；严格正确率 ' + stats.total.correctRate + '%，加权得分率 ' + stats.total.creditRate + '%');

    stats.tiers.forEach(function (t) { if (t.attempts) lines.push(tierLine(s, t)); });

    var weakLabels = stats.weak.map(function (k) { return CI.store.tierOf(s, k).label; });
    var strongLabels = stats.strong.map(function (k) { return CI.store.tierOf(s, k).label; });

    if (strongLabels.length) lines.push('· 优势题型：' + strongLabels.join('、'));
    if (weakLabels.length) lines.push('· 薄弱题型：' + weakLabels.join('、'));
    else if (stats.total.attempts >= U.num(settings(s).minSample, 2)) lines.push('· 未发现明显薄弱题型');

    var tagWeak = stats.tags.filter(function (t) {
      return t.tag !== '未标注' && t.attempts >= 2 && t.creditRate < U.num(settings(s).weakThreshold, 0.6) * 100;
    }).slice(0, 3).map(function (t) { return t.tag + '(' + t.creditRate + '%)'; });
    if (tagWeak.length) lines.push('· 知识点短板：' + tagWeak.join('、'));

    lines.push('· 课堂参与：被点名 ' + stats.rolls + ' 次');

    if (opts.suggestion !== false) {
      var tips = [];
      if (weakLabels.length) {
        tips.push('建议按「' + weakLabels[0] + '」专项补练，先做 2～3 道同类题并及时讲评');
      }
      if (stats.total.wrong + stats.total.skip > 0) {
        tips.push('错题与跳过共 ' + (stats.total.wrong + stats.total.skip) + ' 题，建议课后复盘订正');
      }
      if (stats.rolls === 0) tips.push('尚未参与过点名，可在基础题环节优先安排');
      if (!tips.length) tips.push('保持当前节奏，可适当挑战更高难度题型');
      lines.push('· 教学建议：' + tips.join('；'));
    }

    return { title: stats.name, lines: lines, text: lines.join('\n'), stats: stats };
  }

  /** 班级/队伍整体总结 */
  function summarizeClass(state, teamId) {
    var s = state || CI.store.get();
    var cs = classStats(s, teamId);
    var scopeName = (!teamId || teamId === 'all') ? '全班' : ((CI.store.team(s, teamId) || {}).name || '该队伍');
    var lines = [];

    lines.push('【' + scopeName + '学情小结】' + U.fmtTime(Date.now()));
    lines.push('· 学生 ' + cs.studentCount + ' 人，其中 ' + cs.participants + ' 人有作答记录');

    if (cs.total.attempts === 0) {
      lines.push('· 本阶段尚无作答数据，建议先组一套题并开始答题记录');
      return { title: scopeName, lines: lines, text: lines.join('\n'), stats: cs };
    }

    lines.push('· 累计作答 ' + cs.total.attempts + ' 题次，答对 ' + cs.total.correct +
      '，整体加权得分率 ' + cs.total.creditRate + '%，累计得分 ' + cs.total.earned + ' 分');

    cs.tiers.forEach(function (t) {
      if (!t.attempts) return;
      lines.push('· ' + t.label + '：作答 ' + t.attempts + ' 题次，加权得分率 ' + t.creditRate + '%（平均每题 ' +
        (Math.round((t.earned / t.attempts) * 100) / 100) + ' 分）');
    });

    if (cs.weakTiers.length) {
      var weakNames = cs.weakTiers.map(function (k) { return CI.store.tierOf(s, k).label + '（' + rateOf(cs.tiers, k) + '%）'; });
      lines.push('· 整体薄弱题型：' + weakNames.join('、') + '，建议下节课安排专题讲评');
    } else {
      lines.push('· 各题型得分率均达标，可适度提高题目难度');
    }

    var top = cs.ranking.filter(function (r) { return r.attempts > 0; }).slice(0, 3);
    if (top.length) {
      lines.push('· 表现突出：' + top.map(function (r) { return r.name + '（' + r.score + ' 分，得分率 ' + r.creditRate + '%）'; }).join('、'));
    }
    if (cs.needHelp.length) {
      lines.push('· 需要关注：' + cs.needHelp.slice(0, 5).map(function (r) {
        return r.name + (r.attempts ? '（得分率 ' + r.creditRate + '%）' : '（未作答）');
      }).join('、') + (cs.needHelp.length > 5 ? (' 等 ' + cs.needHelp.length + ' 人') : ''));
    }

    // 题目维度：哪几道题全班都不会 —— 这是下节课讲评的直接依据
    var qStats = questionStats(s, null);
    var qLine = questionReviewLine(qStats);
    if (qLine) {
      lines.push('· ' + qLine);
      // 正确率最低的 3 道题单独列出来（带作答人数，便于判断是"都不会"还是"没人做"）
      var hardest = qStats.filter(function (x) { return x.attempts > 0; }).slice(0, 3);
      if (hardest.length > 1) {
        lines.push('· 讲评顺序建议：' + hardest.map(function (x, i) {
          return (i + 1) + '. ' + x.stem + '（' + x.correctRate + '%，' + x.attempts + ' 人作答）';
        }).join('；'));
      }
    }

    return { title: scopeName, lines: lines, text: lines.join('\n'), stats: cs, questionStats: qStats };
  }

  /** 单个学生的 CSV 明细行 */
  function studentCSV(state, sid) {
    var st = studentStats(state, sid);
    if (!st) return [];
    var header = ['姓名', '队伍', '积分', '题型', '作答次数', '答对', '部分正确', '答错', '跳过', '加权得分率%', '得分'];
    var rows = [header];
    st.tiers.forEach(function (t) {
      rows.push([st.name, st.teamName, st.score, t.label, t.attempts, t.correct, t.half, t.wrong, t.skip, t.creditRate, t.earned]);
    });
    rows.push([st.name, st.teamName, st.score, '合计', st.total.attempts, st.total.correct, st.total.half,
      st.total.wrong, st.total.skip, st.total.creditRate, st.total.earned]);
    return rows;
  }

  /** 全班汇总 CSV（每生一行） */
  function classCSV(state, teamId) {
    var s = state || CI.store.get();
    var rows = [['排名', '姓名', '队伍', '积分', '作答次数', '答对', '加权得分率%', '严格正确率%', '被点名次数', '薄弱题型', '综合评定']];
    ranking(s, teamId).forEach(function (r) {
      rows.push([r.rank, r.name, r.teamName, r.score, r.attempts, r.correct, r.creditRate, r.correctRate,
        r.rolls, r.weakCount ? r.tiers.filter(function (t) { return t.attempts && t.creditRate < U.num(settings(s).weakThreshold, 0.6) * 100; })
          .map(function (t) { return t.label; }).join('/') : '无', r.level.label]);
    });
    return rows;
  }

  /** 题目作答明细 CSV（题目维度：谁答对、谁答错） */
  function questionCSV(state, quizId) {
    var s = state || CI.store.get();
    var qz = CI.store.quiz(s, quizId);
    var rows = [['时间', '试卷', '学生', '队伍', '题型', '题目', '判定', '基准分', '得分', '计分方式']];
    if (!qz) return rows;
    qz.records.slice().sort(function (a, b) { return a.at - b.at; }).forEach(function (r) {
      var stu = CI.store.student(s, r.sid);
      var q = r.qid ? CI.store.question(s, r.qid) : null;
      rows.push([
        U.fmtTime(r.at), qz.name, stu ? stu.name : '', stu ? ((CI.store.team(s, stu.teamId) || {}).name || '') : '',
        r.tier ? CI.store.tierOf(s, r.tier).label : '—',
        q ? U.shortStem(q.stem) : '（快捷记分）',
        CI.store.RESULT_LABEL[r.result] || r.result,
        r.base, r.points, r.source
      ]);
    });
    return rows;
  }

  /* ------------------------------------------------------------------ *
   * 按题目的作答统计（课后讲评的依据：哪几道题全班都不会）
   *   口径与 Rust 侧 question_stats.rs 逐字段一致：
   *     · 只统计有题目归属的流水（快捷记分/手动加减没有 qid，不计入）
   *     · correctRate = 答对 / 作答；creditRate = (答对 + 半对×halfRatio) / 作答
   *     · avgPoints = 该题总分 / 作答次数（两位小数）
   *     · missers = 答错/跳过的人名（去重、首次出现顺序）
   *     · 排序：正确率升序（最需要讲评的在前），同率则作答多的在前
   * ------------------------------------------------------------------ */

  /**
   * @param {Object} state 状态（可省略）
   * @param {String} quizId 只看某套试卷；省略 = 全部流水
   */
  /** 百分比（四舍五入到整数；分母 0 → 0）—— 与 Rust question_stats.rs 的 pct 同口径 */
  function localPct(a, b) {
    if (!b) return 0;
    return Math.round((a / b) * 100);
  }

  function questionStats(state, quizId) {
    var s = state || CI.store.get();
    var records = [];
    if (quizId) {
      var qz = CI.store.quiz(s, quizId);
      records = (qz && qz.records) || [];
    } else {
      (s.quizzes || []).forEach(function (q) { records = records.concat(q.records || []); });
    }
    var half = U.num(settings(s).halfRatio, 0.5);
    var order = [];
    var map = {};
    records.forEach(function (r) {
      if (!r.qid) return;
      if (!map[r.qid]) {
        map[r.qid] = { qid: r.qid, attempts: 0, correct: 0, half: 0, wrong: 0, skip: 0, points: 0, missers: [] };
        order.push(r.qid);
      }
      var e = map[r.qid];
      e.attempts += 1;
      if (e[r.result] !== undefined && r.result !== 'attempts' && r.result !== 'points') e[r.result] = (e[r.result] || 0) + 1;
      e.points += U.num(r.points, 0);
      if (r.result === 'wrong' || r.result === 'skip') {
        var stu = r.sid ? CI.store.student(s, r.sid) : null;
        if (stu && e.missers.indexOf(stu.name) < 0) e.missers.push(stu.name);
      }
    });
    var out = order.map(function (qid) {
      var e = map[qid];
      var q = CI.store.question(s, qid);
      var tier = q ? q.tier : '';
      var t = tier ? CI.store.tierOf(s, tier) : null;
      return {
        qid: qid,
        stem: q ? U.shortStem(q.stem) : '（题目已删除）',
        tier: tier,
        tierLabel: t ? t.label : (tier || '—'),
        attempts: e.attempts,
        correct: e.correct,
        half: e.half,
        wrong: e.wrong,
        skip: e.skip,
        correctRate: localPct(e.correct, e.attempts),
        creditRate: localPct(e.correct + e.half * half, e.attempts),
        avgPoints: Math.round((e.points / (e.attempts || 1)) * 100) / 100,
        missers: e.missers
      };
    });
    out.sort(function (a, b) {
      return (a.correctRate - b.correctRate) || (b.attempts - a.attempts) || (a.qid < b.qid ? -1 : (a.qid > b.qid ? 1 : 0));
    });
    return out;
  }

  /** 题目维度的课后结论（一句话；没有作答返回 null） */
  function questionReviewLine(stats) {
    var answered = (stats || []).filter(function (x) { return x.attempts > 0; });
    if (!answered.length) return null;
    var worst = answered[0];
    var best = answered[answered.length - 1];
    var totalAttempts = answered.reduce(function (n, x) { return n + x.attempts; }, 0);
    var totalCorrect = answered.reduce(function (n, x) { return n + x.correct; }, 0);
    var line = '本套题共 ' + answered.length + ' 道有作答，整体正确率 ' + localPct(totalCorrect, totalAttempts) + '%。' +
      '最需要讲评的是「' + worst.stem + '」（正确率 ' + worst.correctRate + '%，' + worst.attempts + ' 人作答，' +
      (worst.wrong + worst.skip) + ' 人答错或跳过）；掌握最好的是「' + best.stem + '」（正确率 ' + best.correctRate + '%）。';
    var zero = answered.filter(function (x) { return x.correct === 0; });
    if (zero.length) line += '另有 ' + zero.length + ' 道题无人答对，建议课堂重讲。';
    return line;
  }

  /* ------------------------------------------------------------------ *
   * 能力评价：按题型画雷达（"六边形战士"式），给出综合能力与文字评价
   * ------------------------------------------------------------------ */

  /** 评级表：从最理想往下判定，第一个命中即采用 */
  var ABILITY_GRADES = [
    { key: 'hexagon', short: 'S', label: '六边形战士', color: '#7c3aed', tip: '每个题型都稳，没有明显短板' },
    { key: 'allround', short: 'A', label: '全面发展', color: '#16a34a', tip: '各题型都能拿下，个别题再加把劲就满格' },
    { key: 'strong', short: 'A-', label: '学有余力', color: '#0ea5e9', tip: '整体不错，继续拔高' },
    { key: 'specialist', short: 'B+', label: '偏科尖子', color: '#f59e0b', tip: '有强项，但存在明显短板' },
    { key: 'steady', short: 'B', label: '稳步提升', color: '#6366f1', tip: '基础还行，靠多练把正确率提上来' },
    { key: 'basic', short: 'C', label: '基础待巩固', color: '#fb923c', tip: '简单题先稳住，再挑战难题' },
    { key: 'weak', short: 'D', label: '需要重点辅导', color: '#ef4444', tip: '建议单独安排针对性练习' },
    { key: 'insufficient', short: '—', label: '样本不足', color: '#94a3b8', tip: '多给几次机会，数据才说明问题' }
  ];

  /**
   * 能力雷达（纯函数，便于测试）
   *   · 每条轴 = 一个题型的掌握度（creditRate：答对 100%、半对按 halfRatio 折算，与加分口径一致）
   *   · 综合能力按**题型权重**加权 —— 拔高题做对更值钱，和真实计分一致
   *   · 只在"有作答的题型"上取加权平均，另给覆盖率，避免"没做过"被当成"不会"
   * @param {Array}  tiers finalizeBucket 后的题型数组（classStats.tiers / studentStats.tiers）
   * @param {Object} total finalizeBucket 后的合计
   * @param {Object} opts  { minSample }
   */
  function abilityOfTiers(tiers, total, opts) {
    opts = opts || {};
    var minSample = U.num(opts.minSample, 2);
    var all = (tiers || []).slice().sort(function (a, b) { return U.num(a.weight, 0) - U.num(b.weight, 0); });
    var axes = all.map(function (t) {
      return {
        key: t.key, label: t.label, color: t.color, weight: U.num(t.weight, 0),
        attempts: U.num(t.attempts, 0), correct: U.num(t.correct, 0),
        rate: Math.round(U.num(t.creditRate, 0)), correctRate: U.num(t.correctRate, 0)
      };
    });
    var filled = axes.filter(function (a) { return a.attempts > 0; });
    var weightSum = filled.reduce(function (a, x) { return a + Math.max(0.0001, x.weight); }, 0);
    /** 掌握度：只按"已作答题型"加权平均（拔高题权重高，做对更值钱） */
    var mastery = weightSum
      ? Math.round(filled.reduce(function (a, x) { return a + x.rate * Math.max(0.0001, x.weight); }, 0) / weightSum)
      : 0;
    var rates = filled.map(function (a) { return a.rate; });
    var maxRate = rates.length ? Math.max.apply(null, rates) : 0;
    var minRate = rates.length ? Math.min.apply(null, rates) : 0;
    /** 均衡度：只有答过 2 个以上题型时才有意义 */
    var balance = filled.length >= 2 ? Math.round(100 - (maxRate - minRate)) : null;
    var coverage = axes.length ? Math.round((filled.length / axes.length) * 100) : 0;
    var attempts = U.num(total && total.attempts, 0);
    /**
     * 综合分：掌握度 × 覆盖系数（0.6 ~ 1.0）。
     * 不直接用 0 惩罚"没做过的题型"（一节课可能只考了两种题型），
     * 但也不能让"只答对 1 道基础题"显示成 100 分 —— 所以按覆盖率温和折算。
     */
    var overall = Math.round(mastery * (0.6 + 0.4 * (coverage / 100)));
    var byRate = filled.slice().sort(function (a, b) { return a.rate - b.rate; });
    var weakest = byRate.length ? byRate[0] : null;
    var strongest = byRate.length ? byRate[byRate.length - 1] : null;

    var grade;
    if (attempts < minSample) grade = ABILITY_GRADES[7];
    else if (coverage === 100 && filled.length >= 2 && minRate >= 80 && balance !== null && balance >= 10) grade = ABILITY_GRADES[0];
    else if (coverage >= 75 && minRate >= 60) grade = ABILITY_GRADES[1];
    else if (maxRate >= 85 && minRate < 50) grade = ABILITY_GRADES[3];
    else if (overall >= 80) grade = ABILITY_GRADES[2];
    else if (overall >= 60) grade = ABILITY_GRADES[4];
    else if (overall >= 40) grade = ABILITY_GRADES[5];
    else grade = ABILITY_GRADES[6];

    return {
      axes: axes, overall: overall, mastery: mastery, balance: balance, coverage: coverage,
      attempts: attempts, filled: filled.length,
      maxRate: Math.round(maxRate), minRate: Math.round(minRate),
      weakest: weakest, strongest: strongest, grade: grade,
      comment: abilityComment(grade, { weakest: weakest, strongest: strongest, coverage: coverage, filled: filled.length })
    };
  }

  /** 自动评语：说人话，指出强项与短板（老师可直接念或发班级群） */
  function abilityComment(grade, ctx) {
    if (grade.key === 'insufficient') return grade.tip + '（目前只有 ' + ctx.filled + ' 个题型有作答）';
    var parts = [];
    var spread = (ctx.strongest && ctx.weakest) ? ctx.strongest.rate - ctx.weakest.rate : 0;
    if (ctx.strongest && ctx.weakest && spread >= 5) {
      parts.push(ctx.strongest.label + ' 掌握最好（' + ctx.strongest.rate + '%）');
      parts.push(ctx.weakest.label + ' 是短板（' + ctx.weakest.rate + '%）');
    } else if (ctx.strongest) {
      // 各题型掌握度接近时不要硬凑"强项/短板"，否则会出现"X 最好、X 是短板"这种自相矛盾的话
      parts.push('已作答的题型掌握度接近（约 ' + ctx.strongest.rate + '%）');
    }
    var tail;
    if (grade.key === 'hexagon') tail = '六边形战士：各题型都稳，可以给更难的挑战。';
    else if (grade.key === 'allround') tail = '整体均衡，把最低那项再提 10% 就很亮眼。';
    else if (grade.key === 'specialist') tail = '强项很强，先把短板补到及格线，总分涨得最快。';
    else if (grade.key === 'strong') tail = '保持节奏，多练拔高题拉开差距。';
    else if (grade.key === 'steady') tail = '基础题优先保证全对，再逐步上难度。';
    else if (grade.key === 'basic') tail = '建议先把基础题正确率提到 80% 以上。';
    else tail = '建议课后单独安排针对性练习。';
    if (ctx.coverage < 100 && ctx.filled > 0) tail += '（还有题型没作答，数据会随课堂更新）';
    return parts.join('，') + '。' + tail;
  }

  /**
   * 取某个范围的能力评价
   * @param {Object} state
   * @param {Object} opts  { sid } 个人 / { teamId } 队伍 / 省略 = 全班
   */
  function ability(state, opts) {
    opts = opts || {};
    var s = state || CI.store.get();
    var minSample = U.num(settings(s).minSample, 2);

    if (opts.sid) {
      var stu = studentStats(s, opts.sid);
      if (!stu) return null;
      var a1 = abilityOfTiers(stu.tiers, stu.total, { minSample: minSample });
      a1.kind = 'student'; a1.id = stu.sid; a1.name = stu.name;
      a1.teamName = stu.teamName; a1.score = stu.score; a1.rolls = stu.rolls;
      return a1;
    }
    if (opts.teamId && opts.teamId !== 'all') {
      var cs1 = classStats(s, opts.teamId);
      var team = CI.store.team(s, opts.teamId) || { name: '该队伍' };
      var a2 = abilityOfTiers(cs1.tiers, cs1.total, { minSample: minSample });
      a2.kind = 'team'; a2.id = opts.teamId; a2.name = team.name;
      a2.memberCount = cs1.studentCount; a2.score = CI.store.teamScore(s, opts.teamId);
      return a2;
    }
    var cs = classStats(s, 'all');
    var a = abilityOfTiers(cs.tiers, cs.total, { minSample: minSample });
    a.kind = 'class'; a.id = 'all'; a.name = '全班'; a.memberCount = cs.studentCount;
    return a;
  }

  /** 评价榜：全班 + 每个人 + 每支队伍，供雷达切换与综合评价表 */
  function abilityBoard(state) {
    var s = state || CI.store.get();
    return {
      class: ability(s, {}),
      students: ranking(s).map(function (r) { return ability(s, { sid: r.sid }); }).filter(Boolean),
      teams: (s.teams || []).map(function (t) { return ability(s, { teamId: t.id }); }).filter(Boolean),
      grades: ABILITY_GRADES
    };
  }

  CI.analysis = {
    studentStats: studentStats,
    classStats: classStats,
    ranking: ranking,
    teamRanking: teamRanking,
    summarizeStudent: summarizeStudent,
    summarizeClass: summarizeClass,
    studentCSV: studentCSV,
    classCSV: classCSV,
    questionCSV: questionCSV,
    questionStats: questionStats,
    questionReviewLine: questionReviewLine,
    counts: counts,
    ability: ability,
    abilityOfTiers: abilityOfTiers,
    abilityBoard: abilityBoard,
    ABILITY_GRADES: ABILITY_GRADES
  };
})(typeof window !== 'undefined' ? window : globalThis);
