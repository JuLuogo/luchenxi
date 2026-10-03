/*!
 * store.js — 数据模型 / 本地持久化 / 旧数据迁移 / 加权计分引擎 / 派生选择器
 *
 * 设计原则：
 *  1. 纯逻辑，不依赖 DOM，可在 Node 环境中直接测试（见 tests/logic.test.js）。
 *  2. 学生（students）是计分主体；队伍（teams）只是分组视图，队伍分由成员分实时求和得出。
 *  3. 积分不落库为“数字”，而是由 records（积分流水）派生；撤销 = 删除流水，天然可回溯。
 *  4. 所有写操作统一走 commit()：刷新 rev/updatedAt → 落 localStorage → 触发 change 事件。
 */
(function (root) {
  'use strict';

  var CI = root.CI = root.CI || {};

  /* ------------------------------------------------------------------ *
   * 常量
   * ------------------------------------------------------------------ */

  var LS_KEY = 'ci_data_v2';          // v2 主数据键
  var LS_LEGACY_TEAMS = 'teams';      // v1 队伍数组
  var LS_LEGACY_LOGS = 'opLogs';      // v1 操作日志
  var MAX_LOGS = 800;
  var VERSION = 2;

  var RESULT_RATIO = { correct: 1, half: 0.5, wrong: 0, skip: 0 };
  var RESULT_LABEL = { correct: '答对', half: '部分正确', wrong: '答错', skip: '跳过', manual: '手动调整' };

  var DEFAULT_TIERS = [
    { key: 'basic', label: '基础题', weight: 3, color: '#66bb6a', desc: '课本概念与常规运算，面向全体' },
    { key: 'advanced', label: '拔高题', weight: 5, color: '#42a5f5', desc: '综合应用，需要两步以上推理' },
    { key: 'extended', label: '扩展题', weight: 8, color: '#ab47bc', desc: '跨章节综合或建模，考查迁移能力' },
    { key: 'improve', label: '提升题', weight: 10, color: '#ef6c00', desc: '压轴/竞赛级，挑战思维上限' }
  ];

  var ICONS = ['⭐', '📚', '✏️', '📝', '🧠', '🏆', '🔴', '🔵', '🟢', '🟡', '🟣', '🟠'];
  var TEAM_COLORS = ['#e74c3c', '#3498db', '#27ae60', '#f39c12', '#9b59b6', '#16a085', '#e67e22', '#2c3e50'];

  /* ------------------------------------------------------------------ *
   * 工具
   * ------------------------------------------------------------------ */

  function uid(prefix) {
    return (prefix || 'id') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function clone(v) { return JSON.parse(JSON.stringify(v)); }

  function num(v, dft) {
    var n = Number(v);
    return isFinite(n) ? n : (dft === undefined ? 0 : dft);
  }

  function str(v) { return v === undefined || v === null ? '' : String(v); }

  function escapeHTML(s) {
    return str(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function pad2(n) { return String(n).padStart(2, '0'); }

  function fmtTime(ts) {
    var d = new Date(num(ts, Date.now()));
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' +
      pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }

  function fmtClock(ts) {
    var d = new Date(num(ts, Date.now()));
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }

  function round1(n) { return Math.round(num(n) * 10) / 10; }

  function pct(a, b) { return b > 0 ? Math.round((a / b) * 1000) / 10 : 0; }

  function shortStem(stem, max) {
    var t = str(stem).replace(/\s+/g, ' ').trim(); var n = num(max, 16);
    return t.length > n ? t.slice(0, n) + '…' : (t || '未命名题目');
  }

  function download(filename, text, mime) {
    var blob = new Blob([text], { type: (mime || 'application/json') + ';charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 0);
  }

  function copyText(text) {
    if (root.navigator && root.navigator.clipboard && root.navigator.clipboard.writeText) {
      return root.navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        resolve();
      } catch (e) { reject(e); }
    });
  }

  function toCSV(rows) {
    return rows.map(function (row) {
      return row.map(function (cell) {
        var s = str(cell);
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      }).join(',');
    }).join('\r\n');
  }

  /* ------------------------------------------------------------------ *
   * 默认状态 / 归一化 / 迁移
   * ------------------------------------------------------------------ */

  function defaultState() {
    var now = Date.now();
    return {
      version: VERSION,
      rev: 1,
      updatedAt: now,
      settings: {
        courseName: '24机械高考公开课',
        halfRatio: 0.5,        // 部分正确计分系数
        wrongPenalty: 0,       // 答错扣分（正数表示扣多少分）
        fastBonus: 0,          // 抢答额外加分（仅“答对”时生效；传了名次则改用名次分）
        buzzRankBonuses: [],   // 抢答名次加分（默认关闭）：设为 [2,1] 表示第1个抢答的队+2、第2个+1
        weakThreshold: 0.6,    // 正确率低于该值 → 薄弱
        strongThreshold: 0.85, // 正确率高于该值 → 优势
        minSample: 5,          // 判定等级/薄弱所需最少作答次数（调研：少于 5 题的分类极不稳定）
        // 多维度评价权重（百分比；调研：权重没有实证最优值，属课程政策 → 可配置）
        evalWeights: { mastery: 60, participation: 25, growth: 15 },
        decayRatio: 0.65,      // 掌握度衰减平均：最近一次占 65%（Otus 默认，看重「现在会什么」）
        // 手动加减分的上下限（防通胀：调研建议单次 +2 封顶、−1 下限，照抄同行已验参数）
        manualCapPlus: 2,
        manualCapMinus: -1
      },
      tiers: clone(DEFAULT_TIERS),
      tags: ['集合与逻辑', '函数与导数', '三角函数', '数列', '立体几何', '解析几何', '概率统计'],
      teams: [
        { id: uid('tm'), name: '红队', icon: '🔴', color: TEAM_COLORS[0], order: 0 },
        { id: uid('tm'), name: '蓝队', icon: '🔵', color: TEAM_COLORS[1], order: 1 }
      ],
      students: [],
      bank: [],
      quizzes: [],
      currentQuizId: null,
      rollcall: {
        mode: 'even',          // even=轮次池均匀 / random=纯随机 / least=最少被点优先
        scope: 'all',          // 'all' 或队伍 id
        excludeAnswered: true, // 排除本套题中已作答的学生
        recentExclude: 1,      // 不重复最近 N 次被点到的学生
        history: [],           // {id, sid, at, quizId, qid}
        roundPool: [],         // 本轮尚未被点到的学生 id
        round: 1
      },
      logs: [],
      /* 运行时上下文（本地记忆，不参与同步）：当前正在进行的试卷与题目 */
      // 字段必须写全：Rust 的 Runtime 是**非可选**形状契约（specta 生成的 TS 也是必填），
      // 少一个字段就会让「把状态发给 Rust 领域端点」被拒
      runtime: {
        quizId: null, qid: null, sid: null,
        phase: 'idle', accepting: false, reveal: false, timerEndsAt: 0, timerLabel: ''
      },
      // classroom 同理：契约的一部分，懒创建会让请求缺字段
      classroom: { buzz: [], pending: [], feed: [] }
    };
  }

  function normalizeTier(t, i) {
    return {
      key: str(t.key) || ('tier' + i),
      label: str(t.label) || ('第' + (i + 1) + '类'),
      weight: num(t.weight, 1),
      color: t.color || '#78909c',
      desc: str(t.desc)
    };
  }

  function normalizeQuestion(q, tiers) {
    var keys = tiers.map(function (t) { return t.key; });
    var tier = str(q.tier);
    if (keys.indexOf(tier) < 0) tier = keys[0] || 'basic';
    var pts = (q.points === null || q.points === undefined || q.points === '') ? null : num(q.points, null);
    return {
      id: q.id || uid('q'),
      tier: tier,
      points: pts,
      stem: str(q.stem),
      answer: str(q.answer), options: Array.isArray(q.options) ? q.options.map(str).filter(function (o) { return o !== ''; }) : [],
      tags: Array.isArray(q.tags) ? q.tags.map(str) : (q.tag ? [str(q.tag)] : []),
      source: str(q.source),
      note: str(q.note),
      // 题目配图：图片 URL 或 data:URI（导入时也认 image_url / image 两种写法）
      imageUrl: str(q.imageUrl || q.image_url || q.image),
      archived: !!q.archived,
      createdAt: num(q.createdAt, Date.now())
    };
  }

  function normalizeRecord(r) {
    var result = RESULT_LABEL[r.result] ? r.result : 'correct';
    return {
      id: r.id || uid('rc'),
      sid: r.sid || null,          // 学生 id
      qid: r.qid || null,          // 题目 id（手动/快捷加分为 null）
      tier: str(r.tier),           // 计分时的题型快照（题干/权重改动不影响历史）
      quizId: r.quizId || null,
      result: result,
      base: num(r.base, 0),        // 该题基准分
      ratio: num(r.ratio, RESULT_RATIO[result] || 0),
      points: num(r.points, 0),    // 实际记入积分（可为负）
      source: r.source || 'quiz',  // quiz | quick | rollcall | manual | reset | student
      note: str(r.note),
      // 学生具体选了哪些选项（如 "AB"）—— 用于"错选分布"（哪个干扰项最吸引人）
      picked: str(r.picked),
      at: num(r.at, Date.now()),
      by: str(r.by)                // 操作来源页签，便于排查
    };
  }

  /** 补齐缺失字段，保证结构完整（读取旧数据 / 导入备份后调用） */
  function normalize(state) {
    var dft = defaultState();
    if (!state || typeof state !== 'object') return dft;

    state.version = VERSION;
    state.rev = num(state.rev, 1) + 1;
    state.updatedAt = num(state.updatedAt, Date.now());

    state.settings = Object.assign({}, dft.settings, state.settings || {});
    state.rollcall = Object.assign({}, dft.rollcall, state.rollcall || {});
    state.runtime = Object.assign({}, dft.runtime, state.runtime || {});

    if (!Array.isArray(state.tiers) || !state.tiers.length) state.tiers = clone(DEFAULT_TIERS);
    state.tiers = state.tiers.map(normalizeTier);

    if (!Array.isArray(state.tags)) state.tags = dft.tags.slice();
    state.tags = state.tags.map(str).filter(function (t) { return !!t; });

    if (!Array.isArray(state.teams)) state.teams = [];
    if (!Array.isArray(state.students)) state.students = [];
    if (!Array.isArray(state.bank)) state.bank = [];
    if (!Array.isArray(state.quizzes)) state.quizzes = [];
    if (!Array.isArray(state.logs)) state.logs = [];
    if (!Array.isArray(state.rollcall.history)) state.rollcall.history = [];
    if (!Array.isArray(state.rollcall.roundPool)) state.rollcall.roundPool = [];

    state.teams = state.teams.map(function (t, i) {
      return {
        id: t.id || uid('tm'),
        name: str(t.name) || ('队伍' + (i + 1)),
        icon: t.icon || ICONS[i % ICONS.length],
        color: t.color || TEAM_COLORS[i % TEAM_COLORS.length],
        order: num(t.order, i)
      };
    }).sort(function (a, b) { return a.order - b.order; });

    var teamIds = {};
    state.teams.forEach(function (t) { teamIds[t.id] = true; });

    state.students = state.students.map(function (s) {
      return {
        id: s.id || uid('st'),
        name: str(s.name) || '未命名',
        teamId: teamIds[s.teamId] ? s.teamId : (state.teams[0] ? state.teams[0].id : null),
        active: s.active === false ? false : true,
        joinedAt: num(s.joinedAt, Date.now())
      };
    });

    state.bank = state.bank.map(function (q) { return normalizeQuestion(q, state.tiers); });

    state.quizzes = state.quizzes.map(function (qz) {
      return {
        id: qz.id || uid('qz'),
        name: str(qz.name) || '未命名试题',
        note: str(qz.note),
        createdAt: num(qz.createdAt, Date.now()),
        closedAt: num(qz.closedAt, 0),
        questionIds: Array.isArray(qz.questionIds) ? qz.questionIds.slice() : [],
        records: Array.isArray(qz.records) ? qz.records.map(normalizeRecord) : []
      };
    });

    if (state.currentQuizId && !state.quizzes.some(function (q) { return q.id === state.currentQuizId; })) {
      state.currentQuizId = null;
    }
    if (state.runtime.quizId && !state.quizzes.some(function (q) { return q.id === state.runtime.quizId; })) {
      state.runtime.quizId = null;
      state.runtime.qid = null;
    }
    state.rollcall.roundPool = state.rollcall.roundPool.filter(function (id) {
      return state.students.some(function (s) { return s.id === id; });
    });
    state.rollcall.round = num(state.rollcall.round, 1);
    return state;
  }

  /**
   * v1 → v2 迁移。v1 只有 teams[{name,score,icon}] 与 opLogs，没有“学生”概念。
   * 策略：队伍保留；为每个 v1 队伍建一个同名“队伍代表”学生，把 v1 分数写成一条
   * manual 流水挂到该学生名下，保证历史分数不丢（老师可改名或删除）。
   */
  function migrateFromV1(legacyTeams, legacyLogs) {
    var state = defaultState();
    state.teams = [];
    state.students = [];
    state.logs = [];
    var now = Date.now();

    (legacyTeams || []).forEach(function (t, i) {
      var team = {
        id: uid('tm'),
        name: str(t.name) || ('队伍' + (i + 1)),
        icon: t.icon || ICONS[i % ICONS.length],
        color: TEAM_COLORS[i % TEAM_COLORS.length],
        order: i
      };
      state.teams.push(team);
      var stu = { id: uid('st'), name: team.name, teamId: team.id, active: true, joinedAt: now };
      state.students.push(stu);
      var score = num(t.score, 0);
      if (score !== 0) {
        state.quizzes.push({
          id: uid('qz'),
          name: '历史积分（v1 迁移）',
          note: '由旧版本队伍分数自动迁移生成，可删除',
          createdAt: now,
          closedAt: now,
          questionIds: [],
          records: [normalizeRecord({
            sid: stu.id, qid: null, tier: '', quizId: null, result: 'manual',
            base: score, ratio: 1, points: score, source: 'manual',
            note: 'v1 队伍历史分', at: now
          })]
        });
      }
    });

    if (!state.teams.length) state.teams = defaultState().teams;

    var legacy = [];
    try { legacy = JSON.parse(legacyLogs || '[]'); } catch (e) { legacy = []; }
    if (Array.isArray(legacy) && legacy.length) {
      state.logs = legacy.slice(-200).map(function (l) {
        return { ts: num(l.ts, now), type: str(l.type) || '历史记录', detail: str(l.detail) };
      });
    }
    state.logs.push({ ts: now, type: '数据迁移', detail: '已从 v1 迁移，原队伍分数保存为“队伍代表”学生的历史积分' });
    return state;
  }

  /* ------------------------------------------------------------------ *
   * 持久化
   * ------------------------------------------------------------------ */

  function storage() {
    try { return root.localStorage || null; } catch (e) { return null; }
  }

  function save(state) {
    var ls = storage();
    if (!ls) return false;
    try {
      ls.setItem(LS_KEY, JSON.stringify(state));
      return true;
    } catch (e) {
      try {                       // 容量超限：裁剪日志与历史后重试
        state.logs = state.logs.slice(-100);
        ls.setItem(LS_KEY, JSON.stringify(state));
        return true;
      } catch (e2) { return false; }
    }
  }

  function load() {
    var ls = storage();
    if (ls) {
      var raw = null;
      try { raw = JSON.parse(ls.getItem(LS_KEY) || 'null'); } catch (e) { raw = null; }
      if (raw) return normalize(raw);

      var legacyTeams = null;
      try { legacyTeams = JSON.parse(ls.getItem(LS_LEGACY_TEAMS) || 'null'); } catch (e) { legacyTeams = null; }
      if (Array.isArray(legacyTeams) && legacyTeams.length) {
        var legacyLogs = null;
        try { legacyLogs = ls.getItem(LS_LEGACY_LOGS); } catch (e) { legacyLogs = null; }
        var migrated = normalize(migrateFromV1(legacyTeams, legacyLogs));
        save(migrated);
        return migrated;
      }
    }
    return defaultState();
  }

  /* ------------------------------------------------------------------ *
   * 状态容器 + 事件
   * ------------------------------------------------------------------ */

  var state = null;
  var listeners = { change: [] };

  function on(evt, fn) {
    if (!listeners[evt]) listeners[evt] = [];
    listeners[evt].push(fn);
  }

  function emit(evt, payload) {
    (listeners[evt] || []).forEach(function (fn) {
      try { fn(payload); } catch (e) { if (root.console) root.console.error('[store] listener error', e); }
    });
  }

  function init() { if (!state) state = load(); return state; }
  function get() { return init(); }

  function log(type, detail) {
    var s = get();
    // id 是状态契约的一部分（Rust 的 LogItem 有它）—— 缺了会让「把状态发给 Rust 端点」整个被拒
    s.logs.push({
      id: uid('lg'), ts: Date.now(), type: str(type), detail: str(detail) });
    if (s.logs.length > MAX_LOGS) s.logs = s.logs.slice(s.logs.length - MAX_LOGS);
  }

  /** 统一提交：rev++ → 落盘 → 通知订阅者 */
  function commit(reason, opts) {
    var s = get();
    s.rev = num(s.rev, 1) + 1;
    s.updatedAt = Date.now();
    save(s);                                        // ① localStorage（即时、离线兜底）
    if (CI.storage && CI.storage.push) {            // ② 教师端本地 SQLite（异步、防抖）
      try { CI.storage.push(s); } catch (e) { /* 落库失败不影响本地可用 */ }
    }
    emit('change', { reason: reason || 'update', state: s, silent: !!(opts && opts.silent) });
    return s;
  }

  /**
   * 事务式写操作（唯一推荐写入口）
   * @param {String} reason  变更原因，传给 change 事件
   * @param {Function} mutator  (state) => result
   * @param {Object} [opts]   {type: 日志标题, detail: 字符串或 (state,result)=>字符串, silent: 不改动日志}
   */
  function tx(reason, mutator, opts) {
    opts = opts || {};
    var s = get();
    var res = mutator ? mutator(s) : undefined;
    if (opts.type) {
      var detail = typeof opts.detail === 'function' ? opts.detail(s, res) : opts.detail;
      log(opts.type, detail === undefined || detail === null ? '' : detail);
    }
    commit(reason, opts);
    return res;
  }

  /* ------------------------------------------------------------------ *
   * 选择器
   * ------------------------------------------------------------------ */

  function tierOf(s, key) {
    var tiers = (s || get()).tiers;
    for (var i = 0; i < tiers.length; i++) if (tiers[i].key === key) return tiers[i];
    return tiers[0] || DEFAULT_TIERS[0];
  }

  function byId(list, id) {
    if (!Array.isArray(list)) return null;
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  /* 选择器统一支持两种调用：xxx(state, id) 或 xxx(id)（使用当前状态） */
  function pick2(s, id) {
    if (typeof s === 'string') return { s: get(), id: s };
    return { s: s || get(), id: id };
  }

  function question(s, qid) { var a = pick2(s, qid); return byId(a.s.bank, a.id); }
  function quiz(s, qid) { var a = pick2(s, qid); return byId(a.s.quizzes, a.id); }
  function student(s, sid) { var a = pick2(s, sid); return byId(a.s.students, a.id); }
  function team(s, tid) { var a = pick2(s, tid); return byId(a.s.teams, a.id); }

  /** 该题的实际基准分：题目自定义 points 优先，否则取题型权重 */
  function questionPoints(s, q) {
    if (!q) return 0;
    if (q.points !== null && q.points !== undefined && q.points !== '') return num(q.points, 0);
    return num(tierOf(s, q.tier).weight, 0);
  }

  /** 全部积分流水（跨试卷 + 手动调整 + 快捷加分），按时间升序 */
  function allRecords(s) {
    s = s || get();
    var out = [];
    s.quizzes.forEach(function (qz) {
      qz.records.forEach(function (r) { out.push(r); });
    });
    out.sort(function (a, b) { return a.at - b.at; });
    return out;
  }

  /** 计入题型统计的流水：带题型快照且非纯手动调整 */
  function isCountable(r) { return !!r.tier && r.result !== 'manual'; }

  function recordsOf(s, filter) {
    filter = filter || {};
    return allRecords(s).filter(function (r) {
      if (filter.sid && r.sid !== filter.sid) return false;
      if (filter.qid && r.qid !== filter.qid) return false;
      if (filter.quizId && r.quizId !== filter.quizId) return false;
      if (filter.tier && r.tier !== filter.tier) return false;
      if (filter.countable && !isCountable(r)) return false;
      return true;
    });
  }

  var scoreCache = { key: '', map: null };

  /** 学生当前积分（由流水派生，带 rev 级缓存） */
  function scoreOf(s, sid) {
    s = s || get();
    var key = s.rev + '|' + s.quizzes.length;
    if (scoreCache.key !== key || !scoreCache.map) {
      var map = {};
      allRecords(s).forEach(function (r) {
        if (!r.sid) return;
        map[r.sid] = (map[r.sid] || 0) + num(r.points, 0);
      });
      for (var k in map) map[k] = Math.round(map[k] * 100) / 100;
      scoreCache = { key: key, map: map };
    }
    return num(scoreCache.map[sid], 0);
  }

  function teamScore(s, tid) {
    s = s || get();
    return Math.round(s.students.reduce(function (sum, stu) {
      return stu.teamId === tid ? sum + scoreOf(s, stu.id) : sum;
    }, 0) * 100) / 100;
  }

  function studentsOf(s, tid) {
    s = s || get();
    return s.students.filter(function (stu) { return !tid || tid === 'all' || stu.teamId === tid; });
  }

  /**
   * 在册学生（排除 active === false 的停用学生）
   *
   * 为什么统计要用它：停用 = 已转走/已退出，他不该再拉低班级平均、也不该出现在报告里。
   * 点名早就排除了停用学生（rollcall.js），统计口径必须与之一致。
   * 注意：**历史流水不会删**（那是账），只是不再计入"班级/个人"的统计口径。
   */
  function activeStudentsOf(s, tid) {
    return studentsOf(s, tid).filter(function (stu) { return stu.active !== false; });
  }

  function calledCount(s, sid) {
    s = s || get();
    return s.rollcall.history.filter(function (h) { return h.sid === sid; }).length;
  }

  function lastRecord(s) {
    var all = allRecords(s);
    return all.length ? all[all.length - 1] : null;
  }

  function answeredAlready(s, quizId, qid, sid) {
    var qz = quiz(s, quizId);
    if (!qz) return false;
    return qz.records.some(function (r) { return r.qid === qid && r.sid === sid; });
  }

  /* ------------------------------------------------------------------ *
   * 计分引擎
   * ------------------------------------------------------------------ */

  /**
   * 计算一次判定的得分
   * @param {Object} opt {result, base, ratio?, fast?, rank?}
   *   rank —— 抢答名次（1 起）：答对且给了名次 → 用名次加分（不同名次不同分），
   *           不再叠加扁平 fastBonus；不传名次时 fastBonus 照旧（老行为）。
   * @returns {Number} 实际得分
   */
  function computePoints(opt) {
    var st = get().settings;
    var ratio;
    if (opt.ratio !== undefined && opt.ratio !== null) ratio = num(opt.ratio, 0);
    else if (opt.result === 'half') ratio = num(st.halfRatio, 0.5);
    else ratio = RESULT_RATIO[opt.result] !== undefined ? RESULT_RATIO[opt.result] : 0;

    var pts = num(opt.base, 0) * ratio;
    if (opt.result === 'correct') {
      if (opt.rank) {
        var bonuses = Array.isArray(st.buzzRankBonuses) ? st.buzzRankBonuses : [2, 1];
        pts += num(bonuses[opt.rank - 1], 0);
      } else {
        pts += num(opt.fast ? st.fastBonus : 0, 0);
      }
    }
    if (opt.result === 'wrong') pts -= num(st.wrongPenalty, 0);
    return Math.round(pts * 100) / 100;
  }

  /* ------------------------------------------------------------------ *
   * 随机抽题（组卷用）
   *   候选先过滤（题型 / 标签 / 排除 id / 归档），再 Fisher-Yates 洗牌取前 N。
   *   洗牌每步**恰好消耗一次随机数**、下标 = floor(r × i)：与 Rust 侧 draw.rs 逐位一致，
   *   这样传固定序列就能比对同一次抽题（parity 基准的命门）。
   * ------------------------------------------------------------------ */

  /**
   * 从题库抽题
   * @param {Object} s 状态（可省略）
   * @param {Object} opts {count, tiers?, tags?, excludeIds?, includeArchived?}
   * @param {Function} rand 返回 [0,1) 的函数（默认 Math.random；传固定序列即可复现）
   * @returns {String[]} 抽中的题目 id
   */
  function drawQuestions(s, opts, rand) {
    s = s || get();
    opts = opts || {};
    var count = num(opts.count, 0);
    var tiers = opts.tiers || [];
    var tags = opts.tags || [];
    var exclude = opts.excludeIds || [];
    var list = (s.bank || []).filter(function (q) {
      if (!opts.includeArchived && q.archived) return false;
      if (exclude.indexOf(q.id) >= 0) return false;
      if (tiers.length && tiers.indexOf(q.tier) < 0) return false;
      if (tags.length && !(q.tags || []).some(function (x) { return tags.indexOf(x) >= 0; })) return false;
      return true;
    });
    if (!count || !list.length) return [];
    var rnd = typeof rand === 'function' ? rand : Math.random;
    for (var i = list.length; i > 1; i--) {
      var j = Math.min(i - 1, Math.floor(rnd() * i));
      var tmp = list[i - 1]; list[i - 1] = list[j]; list[j] = tmp;
    }
    return list.slice(0, count).map(function (q) { return q.id; });
  }

  /** 第 n 个抢答应得的加分（1 起；名单外为 0） */
  function buzzRankBonus(rank) {
    var st = get().settings;
    var bonuses = Array.isArray(st.buzzRankBonuses) ? st.buzzRankBonuses : [2, 1];
    return rank >= 1 ? num(bonuses[rank - 1], 0) : 0;
  }

  /** 无归属试卷的流水统一放进“快捷记分”收集器，避免污染正式试卷 */
  function collectorQuiz(s) {
    var name = '快捷记分（课堂零散加减）';
    var found = s.quizzes.filter(function (q) { return q.name === name; })[0];
    if (found) return found;
    var qz = {
      id: uid('qz'), name: name, note: '课堂随手加减分与题型快捷加分自动归集于此',
      createdAt: Date.now(), closedAt: 0, questionIds: [], records: []
    };
    s.quizzes.push(qz);
    return qz;
  }

  function describeRecord(s, rec) {
    var q = rec.qid ? question(s, rec.qid) : null;
    var tier = rec.tier ? tierOf(s, rec.tier).label : '';
    var label = RESULT_LABEL[rec.result] || rec.result;
    if (rec.source === 'manual' || rec.source === 'reset' || rec.result === 'manual') {
      return '手动调整 ' + (rec.points >= 0 ? '+' : '') + rec.points;
    }
    if (q) return (tier ? tier + '·' : '') + shortStem(q.stem) + ' ' + label;
    return (tier ? tier + ' ' : '') + label;
  }

  /**
   * 记录一次答题结果（核心写入）
   * @param {Object} opt
   *   sid    学生 id（必填）      qid  题目 id（快捷加分可空）
   *   tier   题型 key（可省略，自动从题目取）
   *   result correct | half | wrong | skip
   *   quizId 所属试卷（可空 → 进“快捷记分”）
   *   source quiz | quick | rollcall | manual
   *   fast   是否抢答加分         by  操作页签
   */
  function recordResult(opt) {
    var s = get();
    var stu = student(s, opt.sid);
    if (!stu) return null;
    var q = opt.qid ? question(s, opt.qid) : null;
    var tierKey = opt.tier || (q ? q.tier : '');
    var base = (opt.base !== undefined && opt.base !== null && opt.base !== '')
      ? num(opt.base, 0)
      : (q ? questionPoints(s, q) : num(tierOf(s, tierKey).weight, 0));
    var result = RESULT_RATIO[opt.result] === undefined ? 'correct' : opt.result;
    var rec = normalizeRecord({
      sid: stu.id,
      qid: q ? q.id : null,
      tier: tierKey,
      quizId: opt.quizId || null,
      result: result,
      base: base,
      ratio: (opt.ratio !== undefined && opt.ratio !== null)
        ? num(opt.ratio, 0)
        : (result === 'half' ? num(s.settings.halfRatio, 0.5) : RESULT_RATIO[result]),
      points: computePoints({ result: result, base: base, ratio: opt.ratio, fast: opt.fast, rank: opt.rank }),
      source: opt.source || 'quiz',
      note: opt.note || '',
      picked: opt.picked || '',
      at: Date.now(),
      by: opt.by || ''
    });

    var target = opt.quizId ? quiz(s, opt.quizId) : null;
    if (!target) target = collectorQuiz(s);
    target.records.push(rec);

    log('记分', stu.name + ' · ' + describeRecord(s, rec) + ' → ' + (rec.points >= 0 ? '+' : '') + rec.points);
    commit('record');
    return rec;
  }

  /**
   * 手动加减分
   *
   * **防通胀**（调研结论，照抄同行已验参数）：单次加分不超过 `manualCapPlus`（默认 +2）、
   * 单次扣分不低于 `manualCapMinus`（默认 −1）。课堂积分靠"次数多"累积才合理，
   * 单次给 10 分会让积分迅速通胀、失去区分度（"谁话多谁分高"的成因之一）。
   * 注意：这只约束**手动加减**，不约束答题得分（那是按题型权重算出来的）。
   */
  function addManual(sid, delta, note) {
    var s = get();
    var stu = student(s, sid);
    if (!stu) return null;
    var raw = num(delta, 0);
    var capPlus = num(s.settings.manualCapPlus, 2);
    var capMinus = num(s.settings.manualCapMinus, -1);
    var capped = raw > capPlus ? capPlus : (raw < capMinus ? capMinus : raw);
    var rec = normalizeRecord({
      sid: sid, qid: null, tier: '', quizId: null, result: 'manual',
      base: capped, ratio: 1, points: capped, source: 'manual',
      note: (capped === raw ? '' : ('（已按上限 ' + (raw > 0 ? '+' + capPlus : capMinus) + ' 收敛）')) + (note || ''),
      at: Date.now(), by: 'manual'
    });
    collectorQuiz(s).records.push(rec);
    log('手动调整', stu.name + ' ' + (capped >= 0 ? '+' : '') + capped +
      (capped === raw ? '' : '（原 ' + raw + '，按上限收敛）') + ' → ' + scoreOf(s, sid));
    commit('manual');
    return rec;
  }

  /** 归零：写一条抵冲流水，保留历史 */
  function resetStudentScore(sid) {
    var s = get();
    var stu = student(s, sid);
    if (!stu) return null;
    var cur = scoreOf(s, sid);
    if (cur === 0) return null;
    var rec = normalizeRecord({
      sid: sid, qid: null, tier: '', quizId: null, result: 'manual',
      base: -cur, ratio: 1, points: -cur, source: 'reset',
      note: '归零抵冲', at: Date.now(), by: 'manual'
    });
    collectorQuiz(s).records.push(rec);
    log('归零', stu.name + ' 由 ' + cur + ' 归零（保留历史流水）');
    commit('reset-student');
    return rec;
  }

  /** 撤销最近一条流水 */
  function undoLastRecord() {
    var s = get();
    var last = null, holder = null, idx = -1;
    s.quizzes.forEach(function (qz) {
      qz.records.forEach(function (r, i) {
        if (!last || r.at >= last.at) { last = r; holder = qz; idx = i; }
      });
    });
    if (!last) return null;
    holder.records.splice(idx, 1);
    var stu = student(s, last.sid);
    log('撤销', (stu ? stu.name : '未知学生') + ' · ' + describeRecord(s, last) + '（-' + last.points + '）');
    commit('undo');
    return last;
  }

  function removeRecord(recordId) {
    var s = get();
    var removed = null;
    s.quizzes.forEach(function (qz) {
      qz.records = qz.records.filter(function (r) {
        if (r.id === recordId) { removed = r; return false; }
        return true;
      });
    });
    if (removed) {
      var stu = student(s, removed.sid);
      log('删除流水', (stu ? stu.name : '未知学生') + ' · ' + describeRecord(s, removed));
      commit('remove-record');
    }
    return removed;
  }

  function clearRecords(filter) {
    filter = filter || {};
    var s = get();
    var n = 0;
    s.quizzes.forEach(function (qz) {
      if (filter.quizId && qz.id !== filter.quizId) return;
      var keep = [];
      qz.records.forEach(function (r) {
        var hit = (!filter.sid || r.sid === filter.sid) && (!filter.tier || r.tier === filter.tier);
        if (hit) n++; else keep.push(r);
      });
      qz.records = keep;
    });
    if (n) { log('清空流水', '共清空 ' + n + ' 条积分流水'); commit('clear-records'); }
    return n;
  }

  /* ------------------------------------------------------------------ *
   * 队伍 / 学生管理
   * ------------------------------------------------------------------ */

  function addTeam(name) {
    return tx('team-add', function (s) {
      var t = {
        id: uid('tm'),
        name: str(name) || ('队伍' + (s.teams.length + 1)),
        icon: ICONS[s.teams.length % ICONS.length],
        color: TEAM_COLORS[s.teams.length % TEAM_COLORS.length],
        order: s.teams.length
      };
      s.teams.push(t);
      return t;
    }, { type: '添加队伍', detail: function (s, t) { return t.name; } });
  }

  function updateTeam(tid, patch) {
    return tx('team-update', function (s) {
      var t = team(s, tid);
      if (!t) return null;
      if (patch.name !== undefined) t.name = str(patch.name);
      if (patch.icon !== undefined) t.icon = str(patch.icon);
      if (patch.color !== undefined) t.color = str(patch.color);
      return t;
    }, { type: patch.name !== undefined ? '队伍改名' : '修改队伍', detail: function (s, t) { return t ? t.name : ''; } });
  }

  function removeTeam(tid) {
    return tx('team-remove', function (s) {
      var t = team(s, tid);
      if (!t) return null;
      s.teams = s.teams.filter(function (x) { return x.id !== tid; });
      s.teams.forEach(function (x, i) { x.order = i; });
      var fallback = s.teams[0] ? s.teams[0].id : null;
      var moved = 0;
      s.students.forEach(function (stu) { if (stu.teamId === tid) { stu.teamId = fallback; moved++; } });
      return { name: t.name, moved: moved, fallback: s.teams[0] ? s.teams[0].name : '未分组' };
    }, {
      type: '删除队伍',
      detail: function (s, r) { return r ? (r.name + '（' + r.moved + ' 名学生转入 ' + r.fallback + '）') : '未找到队伍'; }
    });
  }

  function addStudent(name, teamId, quiet) {
    return tx('student-add', function (s) {
      var stu = {
        id: uid('st'),
        name: str(name) || ('学生' + (s.students.length + 1)),
        teamId: teamId || (s.teams[0] ? s.teams[0].id : null),
        active: true,
        called: 0,        // 状态契约的一部分（Rust 的 Student 有它）
        joinedAt: Date.now()
      };
      s.students.push(stu);
      return stu;
    }, quiet ? {} : {
      type: '添加学生',
      detail: function (s, stu) { return stu.name + ' → ' + ((team(s, stu.teamId) || {}).name || '未分组'); }
    });
  }

  /** 批量添加：支持“张三 李四 王五”、顿号/逗号分隔或每行一个 */
  function addStudentsBulk(text, teamId) {
    var names = str(text).split(/[\s,，、;；\n\r\t]+/).map(function (x) { return x.trim(); })
      .filter(function (x) { return !!x; });
    if (!names.length) return [];
    var s = get();
    var added = [];
    names.forEach(function (n) {
      var stu = {
        id: uid('st'), name: n, teamId: teamId || (s.teams[0] ? s.teams[0].id : null),
        active: true, joinedAt: Date.now()
      };
      s.students.push(stu);
      added.push(stu);
    });
    log('批量添加学生', '共 ' + added.length + ' 人 → ' + ((team(s, teamId) || {}).name || '未分组'));
    commit('students-bulk');
    return added;
  }

  function updateStudent(sid, patch) {
    return tx('student-update', function (s) {
      var stu = student(s, sid);
      if (!stu) return null;
      if (patch.name !== undefined) stu.name = str(patch.name);
      if (patch.teamId !== undefined) stu.teamId = patch.teamId;
      if (patch.active !== undefined) stu.active = !!patch.active;
      return stu;
    }, { type: '修改学生', detail: function (s, stu) { return stu ? stu.name : ''; } });
  }

  function removeStudent(sid) {
    return tx('student-remove', function (s) {
      var stu = student(s, sid);
      if (!stu) return null;
      s.students = s.students.filter(function (x) { return x.id !== sid; });
      s.rollcall.roundPool = s.rollcall.roundPool.filter(function (id) { return id !== sid; });
      s.rollcall.history = s.rollcall.history.filter(function (h) { return h.sid !== sid; });
      return stu;
    }, { type: '删除学生', detail: function (s, stu) { return stu ? stu.name : ''; } });
  }

  /* ------------------------------------------------------------------ *
   * 题库 / 题型 / 试卷
   * ------------------------------------------------------------------ */

  function addQuestion(data) {
    return tx('question-add', function (s) {
      var q = normalizeQuestion(Object.assign({ createdAt: Date.now() }, data), s.tiers);
      s.bank.push(q);
      return q;
    }, { type: '新增题目', detail: function (s, q) { return tierOf(s, q.tier).label + ' · ' + shortStem(q.stem); } });
  }

  function updateQuestion(qid, patch) {
    return tx('question-update', function (s) {
      var q = question(s, qid);
      if (!q) return null;
      Object.assign(q, patch);
      q = normalizeQuestion(q, s.tiers);
      var i = s.bank.findIndex(function (x) { return x.id === qid; });
      if (i >= 0) s.bank[i] = q;
      return q;
    }, { type: '修改题目', detail: function (s, q) { return q ? (tierOf(s, q.tier).label + ' · ' + shortStem(q.stem)) : ''; } });
  }

  function removeQuestion(qid) {
    return tx('question-remove', function (s) {
      var q = question(s, qid);
      if (!q) return null;
      s.bank = s.bank.filter(function (x) { return x.id !== qid; });
      s.quizzes.forEach(function (qz) {
        qz.questionIds = qz.questionIds.filter(function (id) { return id !== qid; });
      });
      return q;
    }, { type: '删除题目', detail: function (s, q) { return q ? shortStem(q.stem) : ''; } });
  }

  /**
   * 批量导入题目
   * @param {Array} list  [{tier|tierLabel, points, stem, answer, tags, source, note}]
   * @param {Object} opts {dedupe:Boolean=true}
   */
  function bulkImportQuestions(list, opts) {
    opts = opts || {};
    var s = get();
    var added = 0, skipped = 0;
    (list || []).forEach(function (raw) {
      var stem = str(raw.stem || raw.question || raw.title).trim();
      if (!stem) { skipped++; return; }
      var tierKey = str(raw.tier);
      if (tierKey && !s.tiers.some(function (t) { return t.key === tierKey; })) {
        var byLabel = s.tiers.filter(function (t) { return t.label === tierKey || t.label === str(raw.tierLabel); })[0];
        tierKey = byLabel ? byLabel.key : '';
      }
      if (!tierKey && raw.tierLabel) {
        var hit = s.tiers.filter(function (t) { return t.label === str(raw.tierLabel); })[0];
        tierKey = hit ? hit.key : '';
      }
      if (!tierKey) tierKey = s.tiers[0] ? s.tiers[0].key : 'basic';
      if (opts.dedupe !== false && s.bank.some(function (q) { return q.stem === stem; })) { skipped++; return; }
      s.bank.push(normalizeQuestion({
        tier: tierKey,
        points: (raw.points === '' || raw.points === undefined || raw.points === null) ? null : num(raw.points, null),
        stem: stem,
        answer: raw.answer,
        options: Array.isArray(raw.options) ? raw.options : [],
        tags: Array.isArray(raw.tags) ? raw.tags : (raw.tag ? [raw.tag] : []),
        source: raw.source,
        note: raw.note,
        // 题目配图：三种写法都认（导出用 imageUrl，手写 JSON 常见 image_url / image）
        imageUrl: raw.imageUrl || raw.image_url || raw.image,
        createdAt: Date.now()
      }, s.tiers));
      added++;
    });
    log('导入题库', '新增 ' + added + ' 题，跳过 ' + skipped + ' 题');
    commit('bank-import');
    return { added: added, skipped: skipped };
  }

  function exportBank() {
    var s = get();
    return {
      type: 'ci-question-bank',
      version: VERSION,
      exportedAt: new Date().toISOString(),
      tiers: clone(s.tiers),
      tags: s.tags.slice(),
      questions: s.bank.map(function (q) {
        return {
          tier: q.tier,
          tierLabel: tierOf(s, q.tier).label,
          points: q.points,
          stem: q.stem,
          answer: q.answer,
          options: q.options.slice(),
          tags: q.tags.slice(),
          source: q.source,
          note: q.note,
          imageUrl: q.imageUrl || ''
        };
      })
    };
  }

  function addTier(data) {
    return tx('tier-add', function (s) {
      var t = {
        key: 'tier_' + Math.random().toString(36).slice(2, 6),
        label: str(data.label) || '新题型',
        weight: num(data.weight, 1),
        color: data.color || '#78909c',
        desc: str(data.desc)
      };
      s.tiers.push(t);
      return t;
    }, { type: '新增题型', detail: function (s, t) { return t.label + '（' + t.weight + ' 分）'; } });
  }

  function updateTier(key, patch) {
    return tx('tier-update', function (s) {
      var t = tierOf(s, key);
      if (!t) return null;
      if (patch.label !== undefined) t.label = str(patch.label);
      if (patch.weight !== undefined) t.weight = num(patch.weight, t.weight);
      if (patch.color !== undefined) t.color = str(patch.color);
      if (patch.desc !== undefined) t.desc = str(patch.desc);
      return t;
    }, { type: '修改题型', detail: function (s, t) { return t ? (t.label + ' 权重 ' + t.weight + ' 分') : ''; } });
  }

  function removeTier(key) {
    return tx('tier-remove', function (s) {
      if (s.tiers.length <= 1) return { ok: false, reason: '至少保留一个题型' };
      var used = s.bank.filter(function (q) { return q.tier === key; }).length;
      if (used) return { ok: false, reason: '仍有 ' + used + ' 道题使用该题型' };
      var t = tierOf(s, key);
      s.tiers = s.tiers.filter(function (x) { return x.key !== key; });
      return { ok: true, label: t.label };
    }, {
      type: '删除题型',
      detail: function (s, r) { return r.ok ? r.label : ('删除失败：' + r.reason); }
    });
  }

  /** 更新全局设置（计分口径 / 薄弱阈值 / 课程名等） */
  function updateSettings(patch) {
    return tx('settings-update', function (s) {
      Object.assign(s.settings, patch || {});
      return s.settings;
    }, {
      type: '修改设置',
      detail: function (s, st) {
        return Object.keys(patch || {}).map(function (k) { return k + '=' + st[k]; }).join('，');
      }
    });
  }

  function countRealQuizzes(s) {
    return s.quizzes.filter(function (q) {
      return q.closedAt === 0 && q.name.indexOf('快捷记分') !== 0 && q.name.indexOf('历史积分') !== 0;
    }).length;
  }

  function createQuiz(name, questionIds, note) {
    return tx('quiz-create', function (s) {
      var qz = {
        id: uid('qz'),
        name: str(name) || ('第 ' + (countRealQuizzes(s) + 1) + ' 套题'),
        note: str(note),
        createdAt: Date.now(),
        closedAt: 0,
        questionIds: (questionIds || []).slice(),
        records: []
      };
      s.quizzes.push(qz);
      s.currentQuizId = qz.id;
      s.runtime.quizId = qz.id;
      s.runtime.qid = qz.questionIds[0] || null;
      return qz;
    }, { type: '新建试卷', detail: function (s, qz) { return qz.name + '（' + qz.questionIds.length + ' 题）'; } });
  }

  function setCurrentQuiz(quizId) {
    return tx('quiz-current', function (s) {
      s.currentQuizId = quizId;
      s.runtime.quizId = quizId;
      var qz = quiz(s, quizId);
      if (!qz || !qz.questionIds.length) s.runtime.qid = null;
      else if (qz.questionIds.indexOf(s.runtime.qid) < 0) s.runtime.qid = qz.questionIds[0];
      return qz;
    }, { type: '切换试卷', detail: function (s, qz) { return qz ? qz.name : '已退出试卷'; } });
  }

  function updateQuiz(quizId, patch) {
    return tx('quiz-update', function (s) {
      var qz = quiz(s, quizId);
      if (!qz) return null;
      if (patch.name !== undefined) qz.name = str(patch.name);
      if (patch.note !== undefined) qz.note = str(patch.note);
      return qz;
    }, { type: '修改试卷', detail: function (s, qz) { return qz ? qz.name : ''; } });
  }

  function setQuizQuestions(quizId, questionIds) {
    return tx('quiz-questions', function (s) {
      var qz = quiz(s, quizId);
      if (!qz) return null;
      qz.questionIds = (questionIds || []).slice();
      if (s.runtime.quizId === quizId && qz.questionIds.indexOf(s.runtime.qid) < 0) {
        s.runtime.qid = qz.questionIds[0] || null;
      }
      return qz;
    }, { type: '调整试卷题目', detail: function (s, qz) { return qz ? (qz.name + ' → ' + qz.questionIds.length + ' 题') : ''; } });
  }

  function addQuestionsToQuiz(quizId, questionIds) {
    return tx('quiz-add-questions', function (s) {
      var qz = quiz(s, quizId);
      if (!qz) return 0;
      var added = 0;
      (questionIds || []).forEach(function (id) {
        if (qz.questionIds.indexOf(id) < 0) { qz.questionIds.push(id); added++; }
      });
      return added;
    }, { type: '组卷', detail: function (s, n) { return '追加 ' + n + ' 题'; } });
  }

  function closeQuiz(quizId) {
    return tx('quiz-close', function (s) {
      var qz = quiz(s, quizId);
      if (!qz) return null;
      qz.closedAt = Date.now();
      if (s.currentQuizId === quizId) {
        s.currentQuizId = null;
        s.runtime.quizId = null;
        s.runtime.qid = null;
      }
      return qz;
    }, { type: '结束试卷', detail: function (s, qz) { return qz ? (qz.name + '（' + qz.records.length + ' 条流水）') : ''; } });
  }

  function deleteQuiz(quizId) {
    return tx('quiz-delete', function (s) {
      var qz = quiz(s, quizId);
      if (!qz) return null;
      s.quizzes = s.quizzes.filter(function (x) { return x.id !== quizId; });
      if (s.currentQuizId === quizId) { s.currentQuizId = null; s.runtime.quizId = null; s.runtime.qid = null; }
      s.rollcall.history = s.rollcall.history.filter(function (h) { return h.quizId !== quizId; });
      return qz;
    }, { type: '删除试卷', detail: function (s, qz) { return qz ? (qz.name + '（含 ' + qz.records.length + ' 条流水）') : ''; } });
  }

  /* ------------------------------------------------------------------ *
   * 点名记录
   * ------------------------------------------------------------------ */

  /** 追加一条点名记录 */
  function addRoll(sid, opts) {
    return tx('roll-add', function (s) {
      var stu = student(s, sid);
      if (!stu) return null;
      var e = {
        id: uid('rl'), sid: sid, at: Date.now(),
        quizId: (opts && opts.quizId) || null,
        qid: (opts && opts.qid) || null
      };
      s.rollcall.history.push(e);
      if (s.rollcall.history.length > 2000) s.rollcall.history.splice(0, s.rollcall.history.length - 2000);
      return e;
    }, { type: '点名', detail: function (s, e) { return e ? ((student(s, e.sid) || {}).name || '') : ''; } });
  }

  /** 更新点名设置（模式/范围/排除项） */
  function setRollSettings(patch) {
    return tx('roll-settings', function (s) {
      Object.assign(s.rollcall, patch || {});
      s.rollcall.roundPool = [];
      return s.rollcall;
    }, {
      type: '点名设置',
      detail: function (s, r) { return '模式=' + r.mode + '，范围=' + r.scope; }
    });
  }

  /** 维护轮次池（不写日志，避免刷屏） */
  function setRoundPool(pool, round) {
    return tx('roll-pool', function (s) {
      s.rollcall.roundPool = (pool || []).slice();
      if (round !== undefined && round !== null) s.rollcall.round = round;
      return s.rollcall;
    }, { silent: true });
  }

  function resetRolls() {
    return tx('roll-reset', function (s) {
      var n = s.rollcall.history.length;
      s.rollcall.history = [];
      s.rollcall.roundPool = [];
      s.rollcall.round = 1;
      return n;
    }, { type: '清空点名记录', detail: function (s, n) { return n + ' 条'; } });
  }

  function removeRoll(rollId) {
    return tx('roll-remove', function (s) {
      var hit = null;
      s.rollcall.history = s.rollcall.history.filter(function (h) {
        if (h.id === rollId) { hit = h; return false; }
        return true;
      });
      return hit;
    }, { type: '撤销点名', detail: function (s, h) { return h ? ((student(s, h.sid) || {}).name || '') : ''; } });
  }

  /** 运行时上下文只本地记忆，silent 时不影响 rev，避免无意义同步 */  function setRuntime(patch) {
    var s = get();
    Object.assign(s.runtime, patch);
    save(s);
    emit('change', { reason: 'runtime', state: s, silent: true });
    return s;
  }

  function resetAllScores() {
    return tx('reset-all', function (s) {
      var n = 0;
      s.quizzes.forEach(function (qz) {
        if (qz.name.indexOf('历史积分') === 0) return;
        n += qz.records.length;
        qz.records = [];
      });
      s.rollcall.history = [];
      s.rollcall.roundPool = [];
      s.rollcall.round = 1;
      return n;
    }, { type: '重置所有积分', detail: function (s, n) { return '清空 ' + n + ' 条积分流水（名单与题库保留）'; } });
  }

  function factoryReset() {
    var s = get();
    var keep = {
      teams: s.teams, students: s.students, bank: s.bank,
      tiers: s.tiers, tags: s.tags, settings: s.settings
    };
    var fresh = defaultState();
    Object.assign(fresh, keep);
    // rev 保持单调：否则"恢复初始"会被枢纽判成过期写入，学生端与大屏还停留在旧数据上
    var prevRev = s ? num(s.rev, 0) : 0;
    state = normalize(fresh);
    state.rev = Math.max(num(state.rev, 1), prevRev + 1);
    log('恢复初始', '已清空试卷、积分流水、点名历史（名单与题库保留）');
    return commit('factory-reset');
  }

  /* ------------------------------------------------------------------ *
   * 全量备份
   * ------------------------------------------------------------------ */

  function exportAll() {
    return {
      type: 'ci-backup',
      version: VERSION,
      exportedAt: new Date().toISOString(),
      state: clone(get())
    };
  }

  function importAll(payload) {
    var data = payload && payload.state ? payload.state : payload;
    if (!data || typeof data !== 'object') throw new Error('备份格式不正确');
    // rev 保持单调：导入的备份 rev 可能比枢纽小，直接用会被判过期（409）而写不进去
    var prevRev = state ? num(state.rev, 0) : 0;
    state = normalize(data);
    state.rev = Math.max(num(state.rev, 1), prevRev + 1);
    log('导入备份', '于 ' + fmtTime(Date.now()) + ' 恢复');
    return commit('import-all');
  }

  /* ------------------------------------------------------------------ *
   * 导出
   * ------------------------------------------------------------------ */

  /**
   * 用外部数据整份替换当前状态。
   *
   * rev 必须**保持单调递增**：枢纽用 rev 判断"谁的更新"（过期写入会返回 409）。
   * 早期实现直接 `state = normalize(s)`，会把 rev 拉回到新数据自身的 rev（如 2），
   * 于是本机之后所有写入都被枢纽判为过期、数据永远落不了库（表现为满屏 409）。
   */
  function replaceState(s) {
    var prevRev = state ? num(state.rev, 0) : 0;
    var next = normalize(s);
    next.rev = Math.max(num(next.rev, 1), prevRev + 1);
    state = next;
    return commit('replace');
  }

  /**
   * 把本机 rev 抬到不低于 min（+1）。
   *
   * 场景：枢纽房间的 rev 来自历史（例如用过一段时间、或被脚本跑过很多次），而本机是
   * 全新安装 / 清了缓存 —— 两边数据都为空，但本机 rev 只有 1。此时本机任何写入都会被
   * 枢纽判为"过期"（409）而写不进去，表现为"老师记了分，大屏毫无反应"。
   * 启动时把 rev 对齐到枢纽水位，写入才能被接受。
   *
   * 不发落库推送（只更新本机版本号并广播 change），避免启动时产生无意义写入。
   */
  function bumpRev(min) {
    var s = get();
    var target = num(min, 0) + 1;
    if (num(s.rev, 1) >= target) return s.rev;
    s.rev = target;
    s.updatedAt = Date.now();
    save(s);
    emit('change', { reason: 'bump-rev', state: s, silent: false });
    return s.rev;
  }

  CI.store = {
    LS_KEY: LS_KEY, VERSION: VERSION, DEFAULT_TIERS: DEFAULT_TIERS,
    ICONS: ICONS, TEAM_COLORS: TEAM_COLORS,
    RESULT_RATIO: RESULT_RATIO, RESULT_LABEL: RESULT_LABEL,

    defaultState: defaultState, normalize: normalize, migrateFromV1: migrateFromV1,
    init: init, get: get, commit: commit, on: on, save: save, load: load,
    replaceState: replaceState, bumpRev: bumpRev,
    log: log, tx: tx,

    tierOf: tierOf, question: question, quiz: quiz, student: student, team: team,
    questionPoints: questionPoints, allRecords: allRecords, recordsOf: recordsOf,
    isCountable: isCountable, scoreOf: scoreOf, teamScore: teamScore, studentsOf: studentsOf,
    calledCount: calledCount, activeStudentsOf: activeStudentsOf, lastRecord: lastRecord, answeredAlready: answeredAlready,
    describeRecord: describeRecord, computePoints: computePoints, collectorQuiz: collectorQuiz,
    drawQuestions: drawQuestions,
    buzzRankBonus: buzzRankBonus,

    recordResult: recordResult, addManual: addManual, resetStudentScore: resetStudentScore,
    undoLastRecord: undoLastRecord, removeRecord: removeRecord, clearRecords: clearRecords,

    addTeam: addTeam, updateTeam: updateTeam, removeTeam: removeTeam,
    addStudent: addStudent, addStudentsBulk: addStudentsBulk, updateStudent: updateStudent, removeStudent: removeStudent,

    addQuestion: addQuestion, updateQuestion: updateQuestion, removeQuestion: removeQuestion,
    bulkImportQuestions: bulkImportQuestions, exportBank: exportBank,

    addTier: addTier, updateTier: updateTier, removeTier: removeTier, updateSettings: updateSettings,

    addRoll: addRoll, setRollSettings: setRollSettings, setRoundPool: setRoundPool,
    resetRolls: resetRolls, removeRoll: removeRoll,

    createQuiz: createQuiz, setCurrentQuiz: setCurrentQuiz, updateQuiz: updateQuiz,
    setQuizQuestions: setQuizQuestions, addQuestionsToQuiz: addQuestionsToQuiz,
    closeQuiz: closeQuiz, deleteQuiz: deleteQuiz, setRuntime: setRuntime,
    resetAllScores: resetAllScores, factoryReset: factoryReset,
    exportAll: exportAll, importAll: importAll
  };

  CI.util = {
    uid: uid, clone: clone, num: num, str: str, escapeHTML: escapeHTML,
    fmtTime: fmtTime, fmtClock: fmtClock, round1: round1, pct: pct,
    download: download, copyText: copyText, toCSV: toCSV, pad2: pad2, shortStem: shortStem
  };
})(typeof window !== 'undefined' ? window : globalThis);
