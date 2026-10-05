/*!
 * import.js — 批量导入题目的**解析规则**（领域层）
 *
 * **迁移来源**：`assets/js/bank.js::parseImport`。它是纯逻辑，却一直住在"旧界面渲染层"里 ——
 * Vue 的批量导入页要 import 整个 bank.js 才能用它，删旧界面也就删不掉。
 * 2026-10 下沉到这里，并在 Rust 侧有同契约实现（`crates/ci-domain/src/bank_import.rs`），
 * parity 基准逐字段比对。
 *
 * 支持的写法（与 Rust 实现逐条一致）：
 *   · JSON：`[{...}]` / `{"questions":[...]}` / 单个 `{"stem":"..."}`
 *   · 管道分隔：`题干 | 答案`
 *   · 选择题：`题干 | 选项1 ; 选项2 ; 选项3 | C`（选项可带 `A.` / `A、` / `A:` 前缀）
 *   · 逗号兜底：`题干，答案`（只在只有一个逗号时切）
 *   · 题型前缀：`基础题：题干 | 答案`（基础/拔高/扩展/提升，可省"题"字）
 *
 * 依赖：`CI.store`（只用于缺省取题型表；传了 tiers 就不碰 store）
 */
(function (root) {
  'use strict';

  var CI = root.CI = root.CI || {};

  /** 题型前缀（`基础` → `基础题`） */
  var TIER_PREFIXES = ['基础', '拔高', '扩展', '提升', '基础题', '拔高题', '扩展题', '提升题'];

  /** 是不是"选项字母"写法（A–H 的组合，允许逗号/顿号/空格） */
  function isOptionLetters(s) {
    var t = String(s || '').trim();
    if (!t) return false;
    return /^[A-Ha-h][A-Ha-h,，、\s]*$/.test(t);
  }

  /** 去掉选项前的 `A.` / `A、` / `A:` / `A：` / `A)` / `A）` 前缀 */
  function stripOptionPrefix(s) {
    return String(s || '').replace(/^\s*[A-Ha-h][.、:：)）]\s*/, '').trim();
  }

  /**
   * 解析文本 → 题目数组
   * @param {String} text 原始文本
   * @param {Array} tiers 题型表（`[{key,label}]`）；省略则取当前状态的
   * @returns {Array} `[{stem, answer, options, tier}]`
   */
  function parse(text, tiers) {
    var raw = String(text === undefined || text === null ? '' : text).trim();
    if (!raw) return [];

    var table = tiers || (CI.store && CI.store.get ? CI.store.get().tiers : []) || [];

    /* ---------- JSON 写法 ---------- */
    if (raw[0] === '[' || raw[0] === '{') {
      var data = JSON.parse(raw);          // 坏 JSON 直接抛错（与 Rust 侧返回 Err 对应）
      var list = [];
      if (Array.isArray(data)) list = data;
      else if (data && Array.isArray(data.questions)) list = data.questions;
      else if (data && data.stem) list = [data];
      return list.map(function (item) {
        return {
          stem: String((item && item.stem) || '').trim(),
          answer: String((item && item.answer) || '').trim(),
          options: (item && Array.isArray(item.options)) ? item.options.map(function (o) { return String(o); }) : [],
          tier: (item && item.tier) ? String(item.tier) : undefined
        };
      });
    }

    /* ---------- 逐行文本 ---------- */
    return raw.split(/\r?\n/).map(function (line) {
      var t = line.trim();
      if (!t) return null;

      var parts = t.split(/\s*[|｜]\s*/);
      if (parts.length < 2) parts = t.split(/\t+/).map(function (x) { return x.trim(); });

      // 选择题写法：题干 | 选项1 ; 选项2 | 答案字母
      if (parts.length >= 3) {
        var last = String(parts[parts.length - 1]).trim();
        if (isOptionLetters(last)) {
          var opts = parts.slice(1, parts.length - 1).join(' ; ')
            .split(/\s*[;；]\s*/)
            .map(stripOptionPrefix)
            .filter(function (x) { return !!x; });
          if (opts.length >= 2) {
            return { stem: String(parts[0]).trim(), options: opts, answer: last.toUpperCase(), tier: undefined };
          }
        }
      }

      // 逗号兜底：只在只有一个逗号时切（避免把题干里的逗号当分隔符）
      if (parts.length < 2) {
        var m = t.match(/^(.+?)[,，]\s*([^,，]*)$/);
        if (m) parts = [m[1], m[2]];
      }

      var stem = String(parts[0] || '');
      var answer = parts.length > 1 ? parts.slice(1).join(' / ') : '';

      // 题型前缀：基础题：题干 | 答案
      var tierKey;
      for (var i = 0; i < TIER_PREFIXES.length && tierKey === undefined; i++) {
        var prefix = TIER_PREFIXES[i];
        var m2 = stem.match(new RegExp('^' + prefix + '\\s*[:：]\\s*(.+)$'));
        if (m2) {
          var label = prefix.indexOf('题') < 0 ? (prefix + '题') : prefix;
          var hit = table.filter(function (x) { return x.label === label; })[0];
          if (hit) { tierKey = hit.key; stem = m2[1]; }
        }
      }

      return { stem: stem.trim(), answer: String(answer || '').trim(), options: [], tier: tierKey };
    }).filter(Boolean);
  }


  /* ------------------------------------------------------------------ *
   * 名单解析（文件导入用）
   * ------------------------------------------------------------------ *
   * 为什么单独写：`store.addStudentsBulk` 按**任意空白/逗号**切分，
   * 所以 "张三,红队" 会变成两个学生。名单文件是**成对**的，必须按行解析。
   *
   * 支持：`姓名,队伍` / `姓名\t队伍` / `姓名 队伍` / 只有姓名；
   * 自动跳过表头（姓名/学生/名字/队伍/组别/分组…）、BOM、空行、首尾引号。
   * 这是**输入规范化**，不是计分规则 —— 不需要 Rust 孪生。
   */
  var HEADER_WORDS = ['姓名', '名字', '学生', '队员', '队伍', '组别', '分组', '小组', 'name', 'team', 'group'];

  function looksLikeHeader(name, team) {
    var a = String(name || '').trim().toLowerCase();
    var b = String(team || '').trim().toLowerCase();
    return HEADER_WORDS.indexOf(a) >= 0 && (!b || HEADER_WORDS.indexOf(b) >= 0);
  }

  /** 去掉 BOM 与首尾引号 */
  function cleanCell(x) {
    return String(x == null ? '' : x)
      .replace(/^\uFEFF/, '')
      .replace(/^["\']+|["\']+$/g, '')
      .trim();
  }

  /**
   * 解析名单文本 → [{ name, team }]（team 为空串表示"未指定，用默认队"）
   * @param {string} text 文件内容或粘贴的文本
   */
  function parseRoster(text) {
    var out = [];
    var seen = {};
    String(text == null ? '' : text).split(/\r?\n/).forEach(function (line) {
      // 按"逗号/制表/分号/竖线"切；只有一列时再按空格切一次（最多两列）
      var cells = line.split(/[,\uFF0C\t;\uFF1B|]/).map(cleanCell).filter(function (x) { return x !== ''; });
      if (cells.length === 1) {
        var bySpace = cleanCell(line).split(/\s+/).filter(Boolean);
        if (bySpace.length === 2) cells = bySpace;
      }
      if (!cells.length) return;                       // 空行
      if (looksLikeHeader(cells[0], cells[1])) return;  // 表头
      var name = cleanCell(cells[0]);
      var team = cells.length > 1 ? cleanCell(cells[1]) : '';
      if (!name) return;
      // 同名去重（同一份文件里重复粘贴很常见）
      var key = name + '|' + team;
      if (seen[key]) return;
      seen[key] = true;
      out.push({ name: name, team: team });
    });
    return out;
  }

  /** 把解析结果按队伍分组（界面显示"将新增 3 队 12 人"） */
  function groupByTeam(rows) {
    var map = {};
    (rows || []).forEach(function (r) {
      var k = r.team || '';
      map[k] = (map[k] || 0) + 1;
    });
    return Object.keys(map).map(function (k) { return { team: k, count: map[k] }; });
  }

  CI.bankImport = { parse: parse, TIER_PREFIXES: TIER_PREFIXES };
  CI.rosterImport = { parse: parseRoster, groupByTeam: groupByTeam };
})(typeof window !== 'undefined' ? window : globalThis);
