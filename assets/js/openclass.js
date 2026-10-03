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

  /** 四档文字（1–4） */
  var LEVELS = ['待改进', '合格', '良好', '优秀'];

  function levelOf(score) {
    var s = Math.max(1, Math.min(4, Number(score) || 1));
    return LEVELS[s - 1];
  }

  /** 一档 → 百分制（1→0 / 2→33.3 / 3→66.7 / 4→100） */
  function rateOf(score) {
    var s = Math.max(1, Math.min(4, Number(score) || 1));
    return Math.round(((s - 1) / 3) * 100 * 10) / 10;
  }

  function round1(x) { return Math.round(Number(x) * 10) / 10; }

  /**
   * 现场评价
   * @param {Array} scores `[{key, score}]`（档位 1–4）；**未给的维度会被剔除并重新归一**
   * @param {Array} dims 量规；省略用默认四维
   */
  function evaluate(scores, dims) {
    var list = dims || defaultDimensions();
    var parts = [];
    var weightUsed = 0;
    var weighted = 0;

    list.forEach(function (d) {
      var hit = null;
      (scores || []).forEach(function (s) { if (s && s.key === d.key) hit = s; });
      if (!hit) return;   // 没评的维度剔除，不按 0 分算
      var rate = rateOf(hit.score);
      weightUsed += d.weight;
      weighted += rate * d.weight;
      parts.push({
        key: d.key, label: d.label, weight: d.weight,
        score: Math.max(1, Math.min(4, Number(hit.score) || 1)),
        level: levelOf(hit.score), rate: rate,
        contribution: round1((rate * d.weight) / 100)
      });
    });

    var total = weightUsed > 0 ? Math.round(weighted / weightUsed) : 0;

    // 阈值与维度档位对齐（四维全"良好"= 67 → 总评也该是良好）
    var level = total >= 90 ? '优秀' : (total >= 65 ? '良好' : (total >= 30 ? '合格' : '待改进'));

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
  function showOnStage(level, policy) {
    if (policy === 'always') return true;
    if (policy === 'never') return false;
    return level === '优秀' || level === '良好';   // smart 与未知值都按安全默认
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
    levelOf: levelOf,
    rateOf: rateOf,
    evaluate: evaluate,
    comment: comment,
    showOnStage: showOnStage
  };
})(typeof window !== 'undefined' ? window : globalThis);
