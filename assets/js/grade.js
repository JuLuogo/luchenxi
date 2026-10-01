/*!
 * grade.js — 题型推断与客观题自动判分（纯逻辑，可在 Node 中测试）
 *
 * 题型规则（不落库、按需推断，避免改动题库结构）：
 *   options 非空            → choice      选择题（选项自动编号 A、B、C…）
 *   否则 answer 非空        → fill        填空题（文本比对，支持多解）
 *   否则                    → subjective  主观题（必须由老师判定）
 *
 * 判分规则：
 *   选择题：选项集合完全一致 → correct；提交是答案的真子集（漏选但没错选）→ half；否则 wrong
 *   填空题：去掉空白、统一全半角、忽略大小写后比对；答案可用 | ； ; 或 分隔多个等价写法
 *   空提交  → skip（不计分、计入统计分母）
 */
(function (root) {
  'use strict';

  var CI = root.CI = root.CI || {};
  var U = CI.util;

  var LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

  function typeOf(q) {
    if (!q) return 'subjective';
    if (Array.isArray(q.options) && q.options.length) return 'choice';
    if (U.str(q.answer).trim()) return 'fill';
    return 'subjective';
  }

  function canAutoGrade(q) { return typeOf(q) !== 'subjective'; }

  function typeLabel(q) {
    var t = typeOf(q);
    return t === 'choice' ? '选择题' : (t === 'fill' ? '填空题' : '主观题');
  }

  /** 选项 → {A:'…', B:'…'} */
  function optionMap(q) {
    var out = {};
    (q && q.options ? q.options : []).forEach(function (text, i) {
      out[LETTERS[i]] = U.str(text);
    });
    return out;
  }

  /** 从任意写法里抽出选项字母：「A」「A,C」「A、C」「答案：AC」→ ['A','C'] */
  function parseChoice(value) {
    var s = U.str(value).toUpperCase();
    var out = [];
    for (var i = 0; i < s.length; i++) {
      var ch = s[i];
      if (LETTERS.indexOf(ch) >= 0 && out.indexOf(ch) < 0) out.push(ch);
    }
    return out.sort();  }

  /** 文本归一化：全角转半角、去空白、忽略大小写、去掉首尾标点 */
  function normalizeText(value) {
    var s = U.str(value);
    var out = '';
    for (var i = 0; i < s.length; i++) {
      var code = s.charCodeAt(i);
      if (code === 0x3000) out += ' ';                       // 全角空格
      else if (code >= 0xFF01 && code <= 0xFF5E) out += String.fromCharCode(code - 0xFEE0); // 全角 ASCII
      else out += s[i];
    }
    return out
      .replace(/\s+/g, '')
      .replace(/[。．.,，;；:：!！?？"'“”‘’()（）\[\]【】]/g, '')
      .toLowerCase();
  }

  /** 参考答案的多个等价写法 */
  function acceptedAnswers(q) {
    return U.str(q && q.answer)
      .split(/[|｜]|或|或者|;|；/)
      .map(function (x) { return x.trim(); })
      .filter(function (x) { return !!x; });
  }

  function sameSet(a, b) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  function isSubset(sub, full) {
    if (!sub.length) return false;
    for (var i = 0; i < sub.length; i++) if (full.indexOf(sub[i]) < 0) return false;
    return true;
  }

  /**
   * 判分
   * @param {Object} q          题目对象
   * @param {Object} submission { choice:['A'] | 'A', text:'…', skip:Boolean }
   * @returns {Object|null} { result, auto:true, expected, got } — 主观题返回 null（交由老师判定）
   */
  function auto(q, submission) {
    submission = submission || {};
    var type = typeOf(q);
    if (type === 'subjective') return null;

    if (submission.skip) {
      return { result: 'skip', auto: true, expected: answerKey(q), got: '跳过' };
    }

    if (type === 'choice') {
      var expected = parseChoice(q.answer);
      var got = parseChoice(Array.isArray(submission.choice) ? submission.choice.join('') : submission.choice);
      var result;
      if (!got.length) result = 'skip';
      else if (sameSet(got, expected)) result = 'correct';
      else if (isSubset(got, expected)) result = 'half';
      else result = 'wrong';
      return {
        result: result, auto: true,
        expected: expected.join(''),
        got: got.join('') || '（空）'
      };
    }

    // fill
    var answers = acceptedAnswers(q).map(normalizeText);
    var mine = normalizeText(submission.text);
    if (!mine) return { result: 'skip', auto: true, expected: answerKey(q), got: '（空）' };
    var ok = answers.some(function (a) { return a === mine; });
    return {
      result: ok ? 'correct' : 'wrong',
      auto: true,
      expected: answerKey(q),
      got: U.str(submission.text)
    };
  }

  /** 用于「公布答案」与教师端展示的答案串 */
  function answerKey(q) {
    var type = typeOf(q);
    if (type === 'choice') {
      var map = optionMap(q);
      var keys = parseChoice(q.answer);
      if (!keys.length) return '（未设置）';
      return keys.map(function (k) { return k + '. ' + (map[k] || ''); }).join('；');
    }
    return U.str(q.answer).trim() || '（未设置）';
  }

  /** 学生提交的可读描述（教师端实时流/待确认队列用） */
  function describeSubmission(q, submission) {
    submission = submission || {};
    if (submission.skip) return '跳过';
    var type = typeOf(q);
    if (type === 'choice') {
      var map = optionMap(q);
      var keys = parseChoice(Array.isArray(submission.choice) ? submission.choice.join('') : submission.choice);
      if (!keys.length) return '（空）';
      return keys.map(function (k) { return k + '. ' + (map[k] || ''); }).join(' / ');
    }
    var text = U.str(submission.text).trim();
    return text ? (text.length > 40 ? text.slice(0, 40) + '…' : text) : '（空）';
  }

  /**
   * 保存前自检：把"会静默判错"的题目拦在题库里。
   *   · 选择题答案必须是字母（写成选项原文如 `8` 会被解析成空集合 → 所有提交都判错，非常隐蔽）
   *   · 答案字母不能超出选项个数（选了不存在的 E）
   *   · 自动判分的题不能没有参考答案
   * @returns {{ok:boolean, warnings:string[]}}
   */
  function validateQuestion(q) {
    var warnings = [];
    var type = typeOf(q);
    var options = (q && q.options) ? q.options.filter(function (t) { return U.str(t).trim(); }) : [];
    var answer = U.str(q && q.answer).trim();

    if (type === 'choice') {
      if (!answer) {
        warnings.push('选择题没填答案：学生提交后一律判为答错');
      } else {
        var letters = parseChoice(answer);
        if (!letters.length) {
          warnings.push('选择题的答案要填**选项字母**（如 B 或 AC），当前是「' + answer + '」——' +
            '这样所有提交都会被判错。想按内容判分请把选项留空（作为填空题）');
        } else {
          letters.forEach(function (l) {
            if (LETTERS.indexOf(l) >= options.length) {
              warnings.push('答案字母 ' + l + ' 超出选项个数（只有 ' + options.length + ' 个选项）');
            }
          });
          if (letters.length > 1 && letters.length === options.length && options.length > 1) {
            warnings.push('答案包含了全部选项，确认这是多选题吗？');
          }
        }
      }
    } else if (type === 'fill') {
      if (!answer) warnings.push('填空题没有参考答案：无法自动判分，会一直判错');
      if (answer && answer.split(/[|;；]/).length === 1 && /[，,]/.test(answer)) {
        warnings.push('多个可接受答案建议用 | 分隔（如「8|八|eight」），当前用了逗号');
      }
    }
    return { ok: warnings.length === 0, warnings: warnings };
  }

  CI.grade = {
    LETTERS: LETTERS,
    typeOf: typeOf, typeLabel: typeLabel, canAutoGrade: canAutoGrade,
    optionMap: optionMap, parseChoice: parseChoice, normalizeText: normalizeText,
    acceptedAnswers: acceptedAnswers, auto: auto, answerKey: answerKey,
    describeSubmission: describeSubmission, validateQuestion: validateQuestion
  };
})(typeof window !== 'undefined' ? window : globalThis);
