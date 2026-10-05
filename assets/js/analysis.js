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
  /**
   * 单个学生的统计
   * @param {Object} opts {quizId} —— 只看某套试卷（= 本节课）；省略/null 表示全部课次
   */
  function studentStats(state, sid, opts) {
    opts = opts || {};
    var s = state || CI.store.get();
    var stu = CI.store.student(s, sid);
    if (!stu) return null;
    var team = CI.store.team(s, stu.teamId);

    var recs = CI.store.recordsOf(s, { sid: sid, quizId: opts.quizId }).filter(function (r) { return counts(s, r); });
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
      // 综合评定：与雷达/大屏同一套等级（见 levelOf 的说明）
      level: levelOf(finalizeBucket(s, total), tiers, { minSample: minSample })
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

  /**
   * 综合评定 —— **单一口径：直接取能力等级**
   *
   * 为什么改：原来这里是另一套 4 档（优秀 / 良好 / 有待提升 / 需重点关注），
   * 与雷达的 8 档（S 六边形战士 … D 需要重点辅导）并存，同一个学生会拿到两个
   * 互相矛盾的结论 —— 实测「只做 3 道基础题全对」的学生，明细是"优秀"、雷达是"稳步提升"；
   * 偏科型学生明细"需重点关注"、雷达"偏科尖子"。
   *
   * 现在明细表 / 个人报告 / 大屏雷达 / 课后报告全用同一套等级，
   * 而"哪些题型薄弱"作为**独立信息**保留在 `weak` / `strong` 字段里（不再混进等级）。
   *
   * 等级会随数据自然升降（每次都用当前全部数据重算），评语里会点名强项与短板，
   * 相当于给了升降的原因。
   */
  function levelOf(total, tiers, opts) {
    return abilityOfTiers(tiers || [], total, opts || {}).grade;
  }

  /** 全班（或某队伍）统计 */
  /** 全班（或某队伍）统计；opts.quizId 见 studentStats */
  function classStats(state, teamId, opts) {
    opts = opts || {};
    var s = state || CI.store.get();
    var list = CI.store.activeStudentsOf(s, teamId);
    var total = blankBucket();
    var tierMap = {};

    (s.tiers || []).forEach(function (t) { tierMap[t.key] = blankBucket(); });

    list.forEach(function (stu) {
      var stats = studentStats(s, stu.id, opts);
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

    var ranked = ranking(s, teamId, opts);
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
  function ranking(state, teamId, opts) {
    opts = opts || {};
    var s = state || CI.store.get();
    var list = CI.store.activeStudentsOf(s, teamId).map(function (stu) {
      // 必须把 opts 透传下去 —— 否则「数据范围（本节课 / 全部课次）」只管得住汇总，管不住这张榜
      var stats = studentStats(s, stu.id, opts);
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
      var members = CI.store.activeStudentsOf(s, t.id);
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
    var stats = studentStats(s, sid, opts);
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
  function summarizeClass(state, teamId, opts) {
    opts = opts || {};
    var s = state || CI.store.get();
    var cs = classStats(s, teamId, opts);
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

  /**
   * 趋势：按"天"或"按测验（课次）"聚合，回答「这几周是进步还是退步」。
   *
   * 为什么需要：原来只有"本节课 / 全部课次"两档，看不出走向（审计 B7）。
   *
   * @param state 课堂状态
   * @param opts  { by: 'day'|'quiz', studentId?, teamId?, tzOffsetMin? }
   *   tzOffsetMin —— 与 `Date.prototype.getTimezoneOffset()` 同义（分钟，东八区是 -480）。
   *   **按天分桶必须传它**：否则 Rust 侧无法与浏览器算出同一天（默认取本机时区）。
   * @returns [{ key, label, attempts, correct, half, wrong, skip, points, rate }]（按时间升序）
   */
  function trend(state, opts) {
    var s = state || CI.store.get();
    var o = opts || {};
    var by = o.by === 'quiz' ? 'quiz' : 'day';
    var tz = (typeof o.tzOffsetMin === 'number') ? o.tzOffsetMin
      : (new Date().getTimezoneOffset());
    var map = {};
    var order = [];

    (s.quizzes || []).forEach(function (qz) {
      (qz.records || []).forEach(function (r) {
        if (!counts(s, r)) return;
        if (o.studentId && r.sid !== o.studentId) return;
        if (o.teamId) {
          var stu = r.sid ? CI.store.student(s, r.sid) : null;
          if (!stu || stu.teamId !== o.teamId) return;
        }
        var key, label;
        if (by === 'quiz') {
          key = qz.id;
          label = qz.name || '未命名测验';
        } else {
          key = dayKey(r.at, tz);
          label = key;
        }
        if (!key) return;
        if (!map[key]) {
          map[key] = { key: key, label: label, attempts: 0, correct: 0, half: 0, wrong: 0, skip: 0, points: 0 };
          order.push(key);
        }
        var e = map[key];
        e.attempts += 1;
        if (e[r.result] !== undefined && r.result !== 'attempts' && r.result !== 'points') e[r.result] += 1;
        e.points += U.num(r.points, 0);
      });
    });

    var out = order.map(function (k) { return map[k]; });
    if (by === 'day') out.sort(function (a, b) { return a.key < b.key ? -1 : (a.key > b.key ? 1 : 0); });
    return out.map(function (e) {
      return {
        key: e.key, label: e.label,
        attempts: e.attempts, correct: e.correct, half: e.half, wrong: e.wrong, skip: e.skip,
        points: Math.round(e.points * 100) / 100,
        // 严格正确率（与 docs/05 口径一致）：答对 / 作答次数
        rate: e.attempts ? Math.round((e.correct / e.attempts) * 100) : 0
      };
    });
  }

  /** 本地日期键 YYYY-MM-DD（tzOffsetMin 与 getTimezoneOffset 同义） */
  function dayKey(at, tzOffsetMin) {
    var t = U.num(at, 0);
    if (!t) return '';
    var d = new Date(t - U.num(tzOffsetMin, 0) * 60000);
    var m = d.getUTCMonth() + 1;
    var day = d.getUTCDate();
    return d.getUTCFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day);
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
    // 正确率升序 → 作答多的在前 → **题库顺序**（稳定且有意义；用 qid 会依赖随机 uid，基准不可复现）
    var bankIdx = function (qid) {
      var k = (s.bank || []).findIndex(function (q) { return q.id === qid; });
      return k < 0 ? 1e9 : k;
    };
    out.sort(function (a, b) {
      return (a.correctRate - b.correctRate) || (b.attempts - a.attempts) ||
        (bankIdx(a.qid) - bankIdx(b.qid)) || (a.qid < b.qid ? -1 : (a.qid > b.qid ? 1 : 0));
    });
    return out;
  }

  /**
   * 选项分布（错选分布）：每个选项有多少人选
   *
   * 为什么有用：老师最想知道的是"**哪个干扰项最吸引人**"——那直接指向错误概念，
   * 比"谁对谁错"更有讲评价值（Wayground 的 Questions 视图就是这个）。
   * 优先用流水的 picked 字段（新数据）；老数据从可读文本 note 里兜底解析。
   */
  function optionDistribution(state, qid) {
    var s = state || CI.store.get();
    var q = CI.store.question(s, qid);
    if (!q) return [];
    var letters = CI.grade.LETTERS;
    var correct = CI.grade.parseChoice(q.answer);
    var counts = (q.options || []).map(function () { return 0; });
    var answered = 0;
    CI.store.recordsOf(s, { qid: qid }).forEach(function (r) {
      var picked = r.picked
        ? String(r.picked).toUpperCase().replace(/[^A-Z]/g, '').split('')
        : String(r.note || '').split('/').map(function (seg) {
            var m = seg.trim().match(/^([A-Za-z])\./);
            return m ? m[1].toUpperCase() : '';
          }).filter(function (x) { return x; });
      if (!picked.length) return;   // 跳过 / 空答案不进分母
      answered += 1;
      picked.forEach(function (k) {
        var i = letters.indexOf(k);
        if (i >= 0 && i < counts.length) counts[i] += 1;
      });
    });
    return (q.options || []).map(function (text, i) {
      var key = letters[i] || '?';
      return {
        key: key,
        text: text,
        count: counts[i],
        rate: answered > 0 ? Math.round((counts[i] / answered) * 100) : 0,
        correct: correct.indexOf(key) >= 0
      };
    });
  }

  /**
   * 挑出"需要重测"的题（错题重做的入口）
   *
   * 口径照抄 Kahoot 报告的 Create：**答对率低于阈值**（默认 35%）的题；
   * 数量够多（默认 >3 道）才值得单独组一套，否则就当场讲评。
   * 依据：Roediger & Karpicke (2006) 的提取练习效应 —— 只做重测不给反馈，
   * 一周后回忆 61%，而重复阅读组读了 14 次也只有 40%。
   *
   * @param {Object} opts {quizId, threshold=0.35, minCount=4}
   */
  function retestQuestions(state, opts) {
    opts = opts || {};
    var s = state || CI.store.get();
    var threshold = U.num(opts.threshold, 0.35);
    var stats = questionStats(s, opts.quizId === undefined ? ((s.runtime && s.runtime.quizId) || null) : opts.quizId);
    return stats.filter(function (x) {
      return x.attempts > 0 && (x.correctRate / 100) < threshold;
    });
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
   * 错题本：按学生汇总答错/跳过的题（课后订正的依据）
   *   口径与 Rust mistakes.rs 逐字段一致：
   *     · 只收 wrong / skip（半对不算错题 —— 它是"部分会"）
   *     · 同一题错多次只占一条，count 记次数、at 取最后一次、answer 取最后一次提交
   *     · expected 从题库取标准答案；题被删了显示"（题目已删除）"
   *     · 排序：次数多的在前 → 时间新的在前 → qid
   * ------------------------------------------------------------------ */

  /** 单个学生的错题本（没有错题返回空 items，不返回 null —— 界面更好用） */
  function studentMistakes(state, sid, opts) {
    opts = opts || {};
    var s = state || CI.store.get();
    var stu = CI.store.student(s, sid);
    var team = stu && stu.teamId ? CI.store.team(s, stu.teamId) : null;
    // 只看某套试卷（= 本节课）；省略则统计全部课次
    var records = CI.store.recordsOf(s, { quizId: opts.quizId });
    var order = [];
    var map = {};
    records.forEach(function (r) {
      if (r.sid !== sid) return;
      if (r.result !== 'wrong' && r.result !== 'skip') return;
      if (!r.qid) return;
      var q = CI.store.question(s, r.qid);
      if (!map[r.qid]) {
        order.push(r.qid);
        map[r.qid] = {
          qid: r.qid,
          stem: q ? U.shortStem(q.stem) : '（题目已删除）',
          tier: q ? q.tier : '',
          tierLabel: q ? CI.store.tierOf(s, q.tier).label : '',
          result: r.result,
          answer: r.note || '',
          expected: q ? expectedOf(q) : '—',
          at: U.num(r.at, 0),
          count: 1
        };
        return;
      }
      var item = map[r.qid];
      item.count += 1;
      if (U.num(r.at, 0) >= item.at) {
        item.at = U.num(r.at, 0);
        item.result = r.result;
        item.answer = r.note || '';
      }
    });
    var items = order.map(function (q) { return map[q]; });
    items.sort(function (a, b) {
      return (b.count - a.count) || (b.at - a.at) || (a.qid < b.qid ? -1 : (a.qid > b.qid ? 1 : 0));
    });
    var tiers = [];
    items.forEach(function (it) {
      if (it.tierLabel && tiers.indexOf(it.tierLabel) < 0) tiers.push(it.tierLabel);
    });
    return {
      sid: sid,
      name: stu ? stu.name : '（未知学生）',
      teamName: team ? team.name : '',
      items: items,
      tiers: tiers
    };
  }

  /** 全班错题本：只保留有错题的学生，按错题次数降序 */
  function mistakeBoard(state, opts) {
    opts = opts || {};
    var s = state || CI.store.get();
    var out = CI.store.activeStudentsOf(s, 'all').map(function (stu) { return studentMistakes(s, stu.id, opts); })
      .filter(function (m) { return m.items.length > 0; });
    out.sort(function (a, b) {
      var ta = a.items.reduce(function (n, x) { return n + x.count; }, 0);
      var tb = b.items.reduce(function (n, x) { return n + x.count; }, 0);
      return (tb - ta) || (b.items.length - a.items.length) || (a.name < b.name ? -1 : (a.name > b.name ? 1 : 0));
    });
    return out;
  }

  /* ------------------------------------------------------------------ *
   * 课后课堂报告：把一节课汇总成一份可导出的 Markdown
   *   buildReport 只做数据汇总（纯函数），toMarkdown 负责排版 ——
   *   与 Rust report.rs 的 build_report / to_markdown 逐行 parity 比对。
   * ------------------------------------------------------------------ */

  /** 该题的标准答案（可读文本，如「A. 甲 / B. 乙」） */
  function expectedOf(q) {
    try { return CI.grade.answerKey(q) || '—'; } catch (e) { return q.answer || '—'; }
  }

  /** 全部试卷的流水 */
  function allRecords(s) {
    var out = [];
    (s.quizzes || []).forEach(function (q) { out = out.concat(q.records || []); });
    return out;
  }

  /** 时间显示：YYYY-MM-DD HH:MM（东八区，与 Rust 的 fmt_time 同口径） */
  function reportTime(ms) {
    ms = U.num(ms, 0);
    if (ms <= 0) return '—';
    var d = new Date(ms + 8 * 3600 * 1000);
    function p2(n) { return (n < 10 ? '0' : '') + n; }
    return d.getUTCFullYear() + '-' + p2(d.getUTCMonth() + 1) + '-' + p2(d.getUTCDate()) +
      ' ' + p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes());
  }

  /**
   * 汇总报告数据（纯函数：入参齐全 → 报告对象）
   * @param {Object} input {courseName, room, generatedAt, checkin, records, students, teams,
   *                        tiers, teamStats, questions, comment, reviewLine, halfRatio}
   */
  function buildReport(input) {
    var i = input || {};
    var half = U.num(i.halfRatio, 0.5);
    var records = i.records || [];
    var students = i.students || [];
    var teams = i.teams || [];

    var attempts = 0, correct = 0, halfN = 0, wrong = 0, skip = 0, earned = 0;
    records.forEach(function (r) {
      earned += U.num(r.points, 0);
      if (r.result === 'correct') { attempts++; correct++; }
      else if (r.result === 'half') { attempts++; halfN++; }
      else if (r.result === 'wrong') { attempts++; wrong++; }
      else if (r.result === 'skip') { attempts++; skip++; }
    });
    var creditRate = attempts > 0 ? Math.round(((correct + halfN * half) / attempts) * 100) : 0;

    var rows = students.map(function (stu) {
      var att = 0, cor = 0, hf = 0, score = 0;
      records.forEach(function (r) {
        if (r.sid !== stu.id) return;
        score += U.num(r.points, 0);
        if (r.result === 'correct') { att++; cor++; }
        else if (r.result === 'half') { att++; hf++; }
        else if (r.result === 'wrong' || r.result === 'skip') att++;
      });
      var team = stu.teamId ? teams.filter(function (x) { return x.id === stu.teamId; })[0] : null;
      return {
        sid: stu.id,
        name: stu.name,
        teamName: team ? team.name : '',
        score: Math.round(score * 100) / 100,
        attempts: att,
        correct: cor,
        creditRate: att > 0 ? Math.round(((cor + hf * half) / att) * 100) : 0
      };
    });
    rows.sort(function (a, b) {
      return (b.score - a.score) || (b.creditRate - a.creditRate) || (a.name < b.name ? -1 : (a.name > b.name ? 1 : 0));
    });

    return {
      courseName: i.courseName || '',
      generatedAt: U.num(i.generatedAt, 0),
      room: i.room || '',
      checkin: i.checkin || { seated: 0, total: 0, rate: 0 },
      attempts: attempts, correct: correct, half: halfN, wrong: wrong, skip: skip,
      creditRate: creditRate,
      earned: Math.round(earned * 100) / 100,
      teams: i.teamStats || [],
      tiers: i.tiers || [],
      questions: i.questions || [],
      students: rows,
      comment: i.comment || '',
      reviewLine: i.reviewLine || '',
      // 「需要关注」的阈值：跟随设置里的薄弱阈值（toMarkdown 要用）
      weakThreshold: U.num(i.weakThreshold, 0.6)
    };
  }

  /** 排版成 Markdown（与 Rust to_markdown 逐行一致） */
  function toMarkdown(r) {
    var out = [];
    out.push('# 课堂报告 · ' + (r.courseName || '课堂积分'));
    out.push('');
    out.push('> 房间 ' + r.room + ' ｜ 生成于 ' + reportTime(r.generatedAt));
    out.push('');

    out.push('## 一、出勤');
    out.push('');
    if (U.num(r.checkin.total, 0) > 0) {
      out.push('- 签到 **' + r.checkin.seated + ' / ' + r.checkin.total + ' 队**（' + r.checkin.rate + '%）');
    } else {
      out.push('- 还没有队伍数据');
    }
    out.push('');

    out.push('## 二、整体');
    out.push('');
    if (!r.attempts) {
      out.push('- 本节课没有作答数据');
    } else {
      out.push('- 作答 **' + r.attempts + ' 题次**：答对 ' + r.correct + '、部分正确 ' + r.half +
        '、答错 ' + r.wrong + '、跳过 ' + r.skip);
      out.push('- 整体掌握度 **' + r.creditRate + '%**，累计得分 **' + r.earned + ' 分**');
    }
    out.push('');
    if (r.comment) { out.push('> ' + r.comment); out.push(''); }

    if (r.teams.length > 1) {
      out.push('## 三、各队对比');
      out.push('');
      out.push('| 队伍 | 答对 | 作答 | 掌握度 | 得分 | 人数 |');
      out.push('| --- | --- | --- | --- | --- | --- |');
      r.teams.forEach(function (t) {
        var score = (t.score === null || t.score === undefined) ? '—' : String(t.score);
        out.push('| ' + t.name + ' | ' + t.correct + ' | ' + t.attempts + ' | ' +
          Math.round(U.num(t.creditRate, 0)) + '% | ' + score + ' | ' + t.memberCount + ' |');
      });
      out.push('');
    }

    var filled = r.tiers.filter(function (t) { return U.num(t.attempts, 0) > 0; });
    if (filled.length) {
      out.push('## 四、题型掌握');
      out.push('');
      out.push('| 题型 | 作答 | 答对 | 掌握度 | 正确率 |');
      out.push('| --- | --- | --- | --- | --- |');
      filled.forEach(function (t) {
        out.push('| ' + t.label + ' | ' + t.attempts + ' | ' + t.correct + ' | ' +
          Math.round(U.num(t.creditRate, 0)) + '% | ' + Math.round(U.num(t.correctRate, 0)) + '% |');
      });
      out.push('');
    }

    var answered = r.questions.filter(function (q) { return U.num(q.attempts, 0) > 0; });
    if (answered.length) {
      out.push('## 五、题目正确率（讲评顺序）');
      out.push('');
      out.push('| # | 题目 | 题型 | 作答 | 答对 | 正确率 | 未答对 |');
      out.push('| --- | --- | --- | --- | --- | --- | --- |');
      answered.forEach(function (q, i) {
        out.push('| ' + (i + 1) + ' | ' + q.stem + ' | ' + q.tierLabel + ' | ' + q.attempts + ' | ' +
          q.correct + ' | ' + q.correctRate + '% | ' + (q.wrong + q.skip) + ' |');
      });
      out.push('');
      if (r.reviewLine) { out.push('> ' + r.reviewLine); out.push(''); }
    }

    var active = r.students.filter(function (s) { return U.num(s.attempts, 0) > 0; });
    if (active.length) {
      out.push('## 六、学生表现');
      out.push('');
      out.push('| 名次 | 学生 | 队伍 | 积分 | 作答 | 答对 | 掌握度 |');
      out.push('| --- | --- | --- | --- | --- | --- | --- |');
      active.forEach(function (s, i) {
        out.push('| ' + (i + 1) + ' | ' + s.name + ' | ' + (s.teamName || '—') + ' | ' + s.score + ' | ' +
          s.attempts + ' | ' + s.correct + ' | ' + s.creditRate + '% |');
      });
      out.push('');
      out.push('- **表现突出**：' + active.slice(0, 3).map(function (s) {
        return s.name + '（' + s.score + ' 分，掌握度 ' + s.creditRate + '%）';
      }).join('、'));
      var weak = active.filter(function (s) { return s.creditRate < U.num(r.weakThreshold, 0.6) * 100; })
        .sort(function (a, b) { return a.creditRate - b.creditRate; });
      if (!weak.length) {
        out.push('- **需要关注**：无（掌握度均不低于 ' + Math.round(U.num(r.weakThreshold, 0.6) * 100) + '%）');
        out.push('');
      } else {
        out.push('- **需要关注**：' + weak.slice(0, 3).map(function (s) {
          return s.name + '（掌握度 ' + s.creditRate + '%）';
        }).join('、'));
        out.push('');
      }
    }

    out.push('---');
    out.push('');
    out.push('*由课堂积分系统生成（Rust 核心 ci-domain::report）*');
    return out.join('\n') + '\n';
  }

  /** 便捷封装：从当前状态取齐入参 → { data, markdown } */
  /**
   * 课后课堂报告
   * @param {Object} opts {quizId} —— 默认**只看本节课**（当前试卷）；传 null 表示全部课次。
   *   原来不区分课次，两节课的流水会混在一起、界面却写着"本节课"。
   */
  function classReport(state, opts) {
    opts = opts || {};
    var s = state || CI.store.get();
    var scopeQuizId = opts.quizId === undefined ? ((s.runtime && s.runtime.quizId) || null) : opts.quizId;
    var cs = classStats(s, null, { quizId: scopeQuizId });
    var ab = ability(s, {});
    var questions = questionStats(s, scopeQuizId);
    var checkin = opts.checkin || (CI.classroom && CI.classroom.checkinStats
      ? CI.classroom.checkinStats(s) : { seated: 0, total: 0, rate: 0 });
    var data = buildReport({
      courseName: U.str(s.settings && s.settings.courseName) || '',
      room: opts.room || (s.runtime && s.runtime.room) || 'default',
      generatedAt: U.num(opts.generatedAt, Date.now()),
      checkin: checkin,
      records: CI.store.recordsOf(s, { quizId: scopeQuizId }),
      students: CI.store.activeStudentsOf(s, 'all'),
      teams: s.teams || [],
      tiers: cs.tiers,
      teamStats: CI.classroom ? CI.classroom.teamStats(s) : [],
      questions: questions,
      comment: (ab && ab.comment) || '',
      reviewLine: questionReviewLine(questions) || '',
      halfRatio: U.num(s.settings && s.settings.halfRatio, 0.5),
      weakThreshold: U.num(s.settings && s.settings.weakThreshold, 0.6)
    });
    return { data: data, markdown: toMarkdown(data) };
  }


  /* ------------------------------------------------------------------ *
   * 多维度评价：正确性 / 参与度 / 进步（与 Rust composite.rs 同契约）
   *   为什么加：只奖励"答对"会变成"谁话多谁分高"，也看不出学生的变化；
   *   成熟做法是 3~4 个维度加权，且**权重必须可配置**（调研：没有任何研究给出"正确权重"）。
   * ------------------------------------------------------------------ */

  /** 参与度：作答过的题数 / 应作答的题数（**答错也算参与**） */
  function participationRate(answered, total) {
    if (!total) return 0;
    return Math.round((Math.min(U.num(answered, 0), total) / total) * 100);
  }

  /** 进步分：与自己前后半段比（50 = 持平；样本不足时 valid=false，不计入总分） */
  function growthScore(early, late, enough) {
    if (!enough) return 0;
    return Math.max(0, Math.min(100, 50 + (U.num(late, 0) - U.num(early, 0))));
  }

  /** 衰减平均掌握度：decay 给最近一次，其余给此前平均（默认 0.65/0.35，看重"现在会什么"） */
  function decayedRate(records, halfRatio, decay) {
    var scored = (records || []).filter(function (r) {
      return r.result === 'correct' || r.result === 'half' || r.result === 'wrong' || r.result === 'skip';
    }).map(function (r) {
      if (r.result === 'correct') return 1;
      if (r.result === 'half') return U.num(halfRatio, 0.5);
      return 0;
    });
    if (!scored.length) return 0;
    var last = scored[scored.length - 1];
    if (scored.length === 1) return Math.round(last * 100);
    var prior = scored.slice(0, -1).reduce(function (a, b) { return a + b; }, 0) / (scored.length - 1);
    var d = Math.max(0, Math.min(1, U.num(decay, 0.65)));
    return Math.round((last * d + prior * (1 - d)) * 100);
  }

  /** 评价权重（跟随设置，缺省 60/25/15） */
  function evalWeights(s) {
    var w = (s && s.settings && s.settings.evalWeights) || {};
    return {
      mastery: U.num(w.mastery, 60),
      participation: U.num(w.participation, 25),
      growth: U.num(w.growth, 15)
    };
  }

  /**
   * 综合表现：三维加权求和，**可下钻**
   *   失效维度（如进步样本不足）自动剔除，权重按有效维度重新归一 ——
   *   否则"数据不足"会被凭空扣掉那部分权重。
   */
  function evaluate(mastery, participation, growth, growthValid, weights) {
    var w = weights || { mastery: 60, participation: 25, growth: 15 };
    var clamp = function (x) { return Math.max(0, Math.min(100, U.num(x, 0))); };
    var parts = [
      { key: 'mastery', label: '正确性', value: clamp(mastery), weight: U.num(w.mastery, 0), contribution: 0, valid: true,
        hint: '掌握度（答对 + 半对按系数折算），用衰减平均更看重最近表现' },
      { key: 'participation', label: '参与度', value: clamp(participation), weight: U.num(w.participation, 0), contribution: 0, valid: true,
        hint: '本节课作答过的题数占比 —— 答错也算参与' },
      { key: 'growth', label: '进步', value: clamp(growth), weight: U.num(w.growth, 0), contribution: 0, valid: !!growthValid,
        hint: growthValid ? '与自己前半段比：50 = 持平，>50 进步，<50 退步' : '样本还太少，暂时不评进步（不作 0 分处理）' }
    ];
    var weightUsed = parts.filter(function (p) { return p.valid; })
      .reduce(function (a, p) { return a + Math.max(0, p.weight); }, 0);
    var total = 0;
    parts.forEach(function (p) {
      if (!p.valid || weightUsed <= 0) { p.contribution = 0; return; }
      var eff = Math.max(0, p.weight) / weightUsed * 100;   // 按有效维度重新归一
      p.contribution = Math.round(p.value * eff) / 100;
      total += p.contribution;
    });
    return { total: Math.round(total), parts: parts, weightUsed: Math.round(weightUsed * 100) / 100 };
  }

  /**
   * 单个学生的综合表现（把状态里的数据取齐后调 evaluate）
   * @param {Object} opts {quizId} —— 与其它统计一致：省略 = 本节课（当前试卷）
   */
  function studentEvaluation(state, sid, opts) {
    opts = opts || {};
    var s = state || CI.store.get();
    var quizId = opts.quizId === undefined ? ((s.runtime && s.runtime.quizId) || null) : opts.quizId;
    var stats = studentStats(s, sid, { quizId: quizId });
    if (!stats) return null;

    var recs = CI.store.recordsOf(s, { sid: sid, quizId: quizId }).filter(function (r) { return counts(s, r); });
    var halfRatio = U.num(settings(s).halfRatio, 0.5);
    var decay = U.num(settings(s).decayRatio, 0.65);

    // 参与度：本节课作答过的**题目数** / 试卷题数（同一题答多次只算一道）
    var qz = quizId ? CI.store.quiz(s, quizId) : null;
    var totalQ = qz ? (qz.questionIds || []).length : 0;
    var seen = {};
    recs.forEach(function (r) { if (r.qid) seen[r.qid] = true; });
    var answered = Object.keys(seen).length;

    // 进步：与自己前后半段比（每人至少 4 条流水才评，否则该维度失效）
    var enough = recs.length >= 4;
    var half = Math.floor(recs.length / 2);
    var rateOf = function (list) {
      if (!list.length) return 0;
      var sum = list.reduce(function (a, r) {
        return a + (r.result === 'correct' ? 1 : (r.result === 'half' ? halfRatio : 0));
      }, 0);
      return Math.round((sum / list.length) * 100);
    };
    var early = enough ? rateOf(recs.slice(0, half)) : 0;
    var late = enough ? rateOf(recs.slice(half)) : 0;

    var mastery = decayedRate(recs, halfRatio, decay);
    var participation = participationRate(answered, totalQ);
    var growth = growthScore(early, late, enough);
    var result = evaluate(mastery, participation, growth, enough, evalWeights(s));
    result.mastery = mastery;
    result.participation = participation;
    result.growth = growth;
    result.growthEarly = early;
    result.growthLate = late;
    result.answered = answered;
    result.totalQuestions = totalQ;
    return result;
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
    { key: 'insufficient', short: '—', label: '数据不足', color: '#94a3b8', tip: '作答次数还太少、分类不可靠 —— 多给几次机会（建议累计 ≥5 题）' }
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
    questionStats: questionStats, trend: trend, dayKey: dayKey, optionDistribution: optionDistribution, retestQuestions: retestQuestions,
    questionReviewLine: questionReviewLine,
    studentMistakes: studentMistakes, mistakeBoard: mistakeBoard,
    // 多维度评价（正确性 / 参与度 / 进步）
    participationRate: participationRate, growthScore: growthScore, decayedRate: decayedRate,
    evalWeights: evalWeights, evaluate: evaluate, studentEvaluation: studentEvaluation,
    buildReport: buildReport, toMarkdown: toMarkdown, classReport: classReport,
    counts: counts,
    ability: ability,
    abilityOfTiers: abilityOfTiers,
    abilityBoard: abilityBoard,
    ABILITY_GRADES: ABILITY_GRADES
  };
})(typeof window !== 'undefined' ? window : globalThis);
