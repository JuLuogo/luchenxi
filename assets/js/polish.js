/*!
 * polish.js — AI 润色的**提示词构造**（公开课评语的可选增强）
 *
 * 与 Rust `crates/ci-domain/src/polish.rs` **同契约**（parity 逐字段比对）。
 *
 * 为什么提示词也算"规则"：它编码了本项目对 AI 的硬约束 ——
 *   1. **只润色措辞，不得新增判断**（事实全部来自 `CI.openclass.comment`）
 *   2. **不得出现学生姓名**（请求体里根本没有姓名）
 *   3. 输出不超过 60 字（评语要能当众念，不是作文）
 *
 * 依据见 `docs/15-公开课模式设计.md` §3。**默认关闭**：没配置 API 时界面不出现该按钮。
 */
(function (root) {
  'use strict';

  var CI = root.CI = root.CI || {};

  /** 硬约束（写进提示词，也用于测试断言） */
  var POLISH_RULES = [
    '只能改写措辞，不得新增任何判断、评价或建议',
    '只能使用下面给出的事实，不得推断学生的性格、态度或能力',
    '不得添加原文没有的数字、比较或因果',
    '输出一句话，不超过 60 字，不要引号、不要换行'
  ];

  var POLISH_MAX_CHARS = 60;

  /** 构造润色提示词：事实在前、约束在后 */
  function polishPrompt(ev) {
    if (!ev) return '';
    var facts = [];
    facts.push('总评：' + ev.total + ' 分（' + ev.level + '）');
    (ev.parts || []).forEach(function (p) { facts.push(p.label + '：' + p.level); });

    if (ev.strongest && ev.weakest) {
      var label = function (k) {
        var hit = null;
        (ev.parts || []).forEach(function (p) { if (p.key === k) hit = p; });
        return hit ? hit.label : k;
      };
      facts.push('最突出：' + label(ev.strongest));
      facts.push('还有空间：' + label(ev.weakest));
    } else {
      facts.push('各维度比较均衡');
    }
    facts.push('原始评语：' + ev.comment);

    var out = '你是课堂评语的润色助手。把下面这份评语改得更自然、更适合当众念出来。\n\n';
    out += '【事实】（只能用这些）\n';
    facts.forEach(function (f) { out += '- ' + f + '\n'; });
    out += '\n【硬约束】\n';
    POLISH_RULES.forEach(function (r, i) { out += (i + 1) + '. ' + r + '\n'; });
    out += '\n只输出润色后的那一句话。';
    return out;
  }

  /** 清理模型返回：去引号/换行、限长 */
  function sanitizePolish(text) {
    var cleaned = String(text == null ? '' : text).trim()
      .replace(/^["'“”「」]+/, '').replace(/["'“”「」]+$/, '')
      .replace(/[\r\n]+/g, ' ');
    var chars = Array.from(cleaned);
    if (chars.length <= POLISH_MAX_CHARS) return cleaned.trim();
    return chars.slice(0, POLISH_MAX_CHARS).join('') + '…';
  }

  CI.polish = {
    POLISH_RULES: POLISH_RULES,
    POLISH_MAX_CHARS: POLISH_MAX_CHARS,
    prompt: polishPrompt,
    sanitize: sanitizePolish
  };
})(typeof window !== 'undefined' ? window : globalThis);
