/*!
 * openclass.js — 公开课模式的现场评价量规（领域层）
 *
 * 与 Rust `crates/ci-domain/src/openclass.rs` **同契约**（parity 逐字段比对）。
 *
 * 为什么公开课要另立一套量规：日常课的"综合表现"（正确性/参与度/进步）是**数据自动算**的，
 * 公开课要的是**老师现场观察判断** —— 四维、四档，点四下就完事，当众能念出来。
 *
 * 评语一律**规则生成**（离线可用、确定性强、不编造）；AI 只做可选润色，
 * 且只允许用这里给出的事实改写措辞。依据见 `docs/15-公开课模式设计.md` §3。
 *
 * 依赖：无（纯函数，不碰 store —— 与 Rust 侧一样）
 */
(function (root) {
  'use strict';

  var CI = root.CI = root.CI || {};

  /** 默认四维量规（权重 30/30/25/15） */
  function defaultDimensions() {
    return [
      { key: 'basic', label: '基础掌握', weight: 30, anchor: '概念、公式、常规运算是否准确' },
      { key: 'transfer', label: '拓展迁移', weight: 30, anchor: '能否举一反三、把方法用到新情境' },
      { key: 'expression', label: '思维表达', weight: 25, anchor: '思路是否清晰、表达是否有条理' },
      { key: 'attitude', label: '参与态度', weight: 15, anchor: '投入程度、回应质量、是否敢试' }
    ];
  }

  /**
   * 默认四档（档位**可配置**：各校评课表不同）
   *
   * 分数取整数，与总分的取整口径一致 —— 否则 2 档 = 33.3 而总分取整成 33，会错档。
   */
  var LEVELS = ['待改进', '合格', '良好', '优秀'];

  function defaultLevels() {
    return LEVELS.map(function (label, i) {
      return { label: label, rate: Math.round((i / (LEVELS.length - 1)) * 100) };
    });
  }

  /** 按档位名生成均匀档位（从低到高） */
  function levelsFromLabels(labels) {
    var list = labels || [];
    if (!list.length) return [];
    if (list.length === 1) return [{ label: list[0], rate: 100 }];
    return list.map(function (label, i) {
      return { label: label, rate: Math.round((i / (list.length - 1)) * 100) };
    });
  }

  function levelOf(score, levels) {
    var lv = (levels && levels.length) ? levels : defaultLevels();
    var i = Math.max(1, Number(score) || 1) - 1;
    return lv[Math.min(i, lv.length - 1)].label;
  }

  /** 一档 → 百分制（越界取两端） */
  function rateOf(score, levels) {
    var lv = (levels && levels.length) ? levels : defaultLevels();
    var i = Math.max(1, Number(score) || 1) - 1;
    return lv[Math.min(i, lv.length - 1)].rate;
  }

  /** 总分落在哪一档（不再硬编码阈值） */
  function levelForTotal(total, levels) {
    var lv = (levels && levels.length) ? levels : defaultLevels();
    var best = lv[0];
    lv.forEach(function (l) { if (Number(total) + 1e-9 >= l.rate) best = l; });
    return best.label;
  }

  /** 这一档算不算"表扬"（上半档）—— 供大屏公开展示策略用 */
  function isPraise(total, levels) {
    var lv = (levels && levels.length) ? levels : defaultLevels();
    var n = lv.length;
    if (!n) return false;
    var idx = (n % 2 === 0) ? (n / 2) : ((n + 1) / 2 - 1);
    return Number(total) + 1e-9 >= lv[idx].rate;
  }

  function round1(x) { return Math.round(Number(x) * 10) / 10; }

  /**
   * 现场评价
   * @param {Array} scores `[{key, score}]`（档位 1–4）；**未给的维度会被剔除并重新归一**
   * @param {Array} dims 量规；省略用默认四维
   */
  function evaluate(scores, dims, levels) {
    var list = dims || defaultDimensions();
    var lv = (levels && levels.length) ? levels : defaultLevels();
    var parts = [];
    var weightUsed = 0;
    var weighted = 0;

    list.forEach(function (d) {
      var hit = null;
      (scores || []).forEach(function (s) { if (s && s.key === d.key) hit = s; });
      if (!hit) return;   // 没评的维度剔除，不按 0 分算
      var rate = rateOf(hit.score, lv);
      weightUsed += d.weight;
      weighted += rate * d.weight;
      parts.push({
        key: d.key, label: d.label, weight: d.weight,
        score: Math.max(1, Math.min(4, Number(hit.score) || 1)),
        level: levelOf(hit.score, lv), rate: rate,
        contribution: round1((rate * d.weight) / 100)
      });
    });

    var total = weightUsed > 0 ? Math.round(weighted / weightUsed) : 0;

    // 总评档位 = 总分落在哪一档（不再硬编码阈值；换三档/五档自动跟着变）
    var level = levelForTotal(total, lv);

    // 最强 / 最弱：分差 <8 分就不指（避免"表达最好、表达是短板"式自相矛盾）
    var strongest = null, weakest = null;
    if (parts.length >= 2) {
      var sorted = parts.slice().sort(function (a, b) { return b.rate - a.rate; });
      if (sorted[0].rate - sorted[sorted.length - 1].rate >= 8) {
        strongest = sorted[0].key;
        weakest = sorted[sorted.length - 1].key;
      }
    }

    var ev = {
      total: total, level: level, parts: parts, weightUsed: round1(weightUsed),
      strongest: strongest, weakest: weakest, comment: ''
    };
    ev.comment = comment(ev);
    return ev;
  }

  /**
   * 现场评价要不要在大屏上公开（**公开表扬、私下改进**）
   *
   * 调研里公开"待改进"是有害的（"垫底的学生每次抬头就看见自己名字在最后面"）。
   * 默认只在"良好/优秀"时公开；policy 可为 smart / always / never。
   */
  function showOnStage(total, levels, policy) {
    if (policy === 'always') return true;
    if (policy === 'never') return false;
    // smart 与未知值都按"只公开表扬"（上半档）—— 换三档/五档也成立
    return isPraise(total, levels);
  }

  /**
   * 规则评语：说人话，指出强项与短板（老师可直接念）
   * **只用已经算出来的事实**，不新增判断 —— 这是"AI 只润色不判断"的前提。
   */
  function comment(ev) {
    if (!ev || !ev.parts || !ev.parts.length) return '还没有评价任何维度。';

    var find = function (key) {
      if (!key) return null;
      var hit = null;
      ev.parts.forEach(function (p) { if (p.key === key) hit = p; });
      return hit;
    };

    var head = [];
    var s = find(ev.strongest), w = find(ev.weakest);
    if (s && w) {
      head.push(s.label + ' 最突出（' + s.level + '）');
      head.push(w.label + ' 还有空间（' + w.level + '）');
    } else {
      var avg = Math.round(ev.parts.reduce(function (n, p) { return n + p.rate; }, 0) / ev.parts.length);
      head.push('各维度比较均衡（约 ' + avg + ' 分）');
    }

    var tail = ev.level === '优秀' ? '表现很完整，可以请他讲讲思路，给全班做个示范。'
      : ev.level === '良好' ? '整体不错，把刚才那一步再追问一句，就能看出他到底懂到哪。'
      : ev.level === '合格' ? '基本答到了，建议追问一个变式，看能不能迁移。'
      : '先肯定他愿意试，再从最基础的一步重新搭梯子。';

    var missing = 4 - ev.parts.length;
    if (missing > 0) tail += '（还有 ' + missing + ' 个维度没评）';

    return head.join('，') + '。' + tail;
  }

  CI.openclass = {
    defaultDimensions: defaultDimensions,
    LEVELS: LEVELS,
    defaultLevels: defaultLevels,
    levelsFromLabels: levelsFromLabels,
    levelOf: levelOf,
    rateOf: rateOf,
    levelForTotal: levelForTotal,
    isPraise: isPraise,
    evaluate: evaluate,
    comment: comment,
    showOnStage: showOnStage
  };
})(typeof window !== 'undefined' ? window : globalThis);
