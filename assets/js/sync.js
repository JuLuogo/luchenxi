/*!
 * sync.js — 教师端与「本地枢纽」的连接（v3：房间 + 角色 + 命令收发）
 *
 *  教师端角色固定为 host：
 *    · 上行：任何一次数据变更都会节流后推送全量快照 {type:'state', payload}
 *    · 下行：学生端的命令（入座/抢答/作答）→ 交给 CI.classroom 处理
 *    · 在线状态 presence、服务器 /health 探测（用于显示学生端地址与二维码）
 *  协议详见 docs/07-通信协议与API.md 与 docs/10-多端协同架构.md。
 */
(function (root) {
  'use strict';

  var CI = root.CI = root.CI || {};
  var U = CI.util;

  var LS_HOST = 'ci_ws_host';
  var LS_ROOM = 'ci_room';
  var DEFAULT_HOST = '';            // 空 = 与页面同源（教师机用 localhost 打开时最省事）
  var DEFAULT_ROOM = 'default';
  /**
   * 页面不是由枢纽托管时（双击 admin.html 的 file:// 场景、以及客户端 asset 协议）
   * 默认去连本机枢纽的这个端口。曾漏掉这个常量定义 → 双击打开时抛 ReferenceError、页面初始化失败。
   * 客户端可用 `window.CI_DEFAULT_PORT` 覆盖。
   */
  var DEFAULT_LOCAL_PORT = (function () {
    try { return Number(root.CI_DEFAULT_PORT) || 8080; } catch (e) { return 8080; }
  })();
  var ws = null;
  var timer = null;
  var pushTimer = null;
  var statusCb = null;
  var retry = 0;
  var lastStatus = '';
  var hooks = {};
  var serverInfo = null;            // /health 返回：本机 IP、是否支持二维码等
  var lastRev = 0;

  /**
   * 房间号优先级：URL 的 `?room=` > localStorage > 默认值。
   * URL 参数优先是为了让"扫码/书签进来就进这个房间"成立 —— 大屏（index.html:114）与学生端
   * （student.js）都是这么做的，教师端曾经只读 localStorage，导致同一台机器上
   * 三端可能进不同房间（表现为"学生端一直等待老师端推送名单"）。
   */
  function room() {
    try {
      var qs = new URLSearchParams(root.location.search);
      var fromUrl = qs.get('room');
      if (fromUrl) {
        var clean = String(fromUrl).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
        if (clean) {
          if (root.localStorage.getItem(LS_ROOM) !== clean) root.localStorage.setItem(LS_ROOM, clean);
          return clean;
        }
      }
    } catch (e) { /* 非浏览器或参数异常时退回 localStorage */ }
    try { return root.localStorage.getItem(LS_ROOM) || DEFAULT_ROOM; } catch (e) { return DEFAULT_ROOM; }
  }

  function setRoom(id) {
    var clean = String(id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || DEFAULT_ROOM;
    try { root.localStorage.setItem(LS_ROOM, clean); } catch (e) { /* 忽略 */ }
    reconnect();
    return clean;
  }

  function host() {
    try {
      var v = root.localStorage.getItem(LS_HOST);
      if (v !== null && v !== undefined && v !== '') return v;
    } catch (e) { /* 忽略 */ }
    return DEFAULT_HOST;
  }

  function setHost(h) {
    try { root.localStorage.setItem(LS_HOST, String(h || '').trim()); } catch (e) { /* 忽略 */ }
    reconnect();
  }

  /** 是否与页面同源（教师机用 http://localhost:8080/admin.html 打开时为真；file:// 不算同源） */
  function sameOrigin() { return !host() && !!(root.location && root.location.host); }

  /** 页面是否由 http(s) 提供（file:// 双击打开时为假） */
  function servedOverHttp() {
    var loc = root.location;
    return !!(loc && loc.host && /^https?:$/.test(loc.protocol || ''));
  }

  /** 枢纽的 HTTP 基地址（用于 /health 与 /qr.png）；返回空串表示同源 */
  function hubBase() {
    var h = host();
    if (h) return /^wss?:\/\//i.test(h) ? h.replace(/^ws/, 'http') : 'http://' + h;
    if (servedOverHttp()) return '';
    return 'http://localhost:' + DEFAULT_LOCAL_PORT;     // 双击 admin.html：默认找本机枢纽
  }

  /**
   * 组装连接地址。三种情况：
   *   ① 配置过地址（页签⑥或 ci_ws_host）→ 用它
   *   ② 页面由枢纽提供（http://localhost:8080/admin.html）→ 同源
   *   ③ file:// 双击打开 → 默认连本机 localhost:8080（枢纽在跑就能多端协同，没跑就退化为单机模式）
   */
  function url() {
    var h = host();
    var query = '/?room=' + encodeURIComponent(room()) + '&role=host';
    if (/^wss?:\/\//i.test(h)) return h + query;
    if (h) return (root.location && root.location.protocol === 'https:' ? 'wss://' : 'ws://') + h + query;
    if (servedOverHttp()) {
      var proto = root.location.protocol === 'https:' ? 'wss://' : 'ws://';
      return proto + root.location.host + query;
    }
    return 'ws://localhost:' + DEFAULT_LOCAL_PORT + query;
  }

  function status(text, cls) {
    lastStatus = text;
    if (statusCb) statusCb(text, cls);
  }

  function init(opts) {
    hooks = opts || {};
    statusCb = hooks.onStatus || null;
    connect();
    return { host: host, room: room, url: url(), push: push };
  }

  function connect() {
    if (!root.WebSocket) { status('当前浏览器不支持 WebSocket', 'chip-bad'); return; }
    var target = url();
    try { if (ws) { ws.onclose = null; ws.close(); } } catch (e) { /* 忽略 */ }

    try {
      ws = new root.WebSocket(target);
    } catch (e) {
      status('连接失败：' + e.message, 'chip-bad');
      scheduleReconnect();
      return;
    }

    ws.onopen = function () {
      retry = 0;
      status('已连接枢纽 ' + (sameOrigin() ? location.host : host()) + '（房间 ' + room() + '）', 'chip-ok');
      push(true);
      fetchServerInfo();
    };

    ws.onmessage = function (evt) {
      var msg = null;
      try { msg = JSON.parse(evt.data); } catch (e) { return; }
      if (!msg || !msg.type) return;

      switch (msg.type) {
        case 'welcome':
          lastRev = U.num(msg.rev, 0);
          status('已连接枢纽 · 房间 ' + msg.room + (msg.hasState ? '（服务端有课堂数据）' : ''), 'chip-ok');
          if (hooks.onWelcome) hooks.onWelcome(msg);
          if (msg.hasState) send({ type: 'request' });      // 拉取服务端缓存，供"恢复课堂"判断
          if (msg.hasDump) send({ type: 'request-dump' });  // 完整课堂数据（仅教师端可取）
          break;

        case 'dump':
          if (hooks.onDump) hooks.onDump(msg.payload, dumpForced);
          dumpForced = false;
          break;

        case 'state':
          lastRev = U.num(msg.rev, lastRev);
          if (hooks.onRemoteState) hooks.onRemoteState(msg.payload, msg.rev);   // 仅用于判断/展示，不自动覆盖本地
          else status('实时同步中 ' + U.fmtClock(Date.now()), 'chip-ok');
          break;

        case 'cmd':
          if (hooks.onCmd) hooks.onCmd(msg.cmd);
          break;

        case 'cmd-backlog':
          (msg.cmds || []).forEach(function (c) { if (hooks.onCmd) hooks.onCmd(c, true); });
          if (msg.cmds && msg.cmds.length) status('已补收 ' + msg.cmds.length + ' 条离线提交', 'chip-warn');
          break;

        case 'presence':
          if (hooks.onPresence) hooks.onPresence(msg);
          break;

        case 'request':
          push(true);
          break;

        case 'error':
          status('枢纽提示：' + msg.message, 'chip-warn');
          break;

        default:
          break;
      }
    };

    ws.onerror = function () { status('连接错误：' + url(), 'chip-bad'); };
    ws.onclose = function () {
      if (!servedOverHttp() && !host()) {
        // 双击 admin.html 且本机枢纽没起来：明确告诉老师怎么进入多端模式，同时说明本地功能不受影响
        status('单机模式（未连上本机枢纽，重试中…）：记分/点名/组卷/学情正常；需要学生端参与时请双击「启动课堂.cmd」', 'chip-warn');
      } else {
        status('与枢纽断开，重试中…（单机模式仍可继续记分）', 'chip-warn');
      }
      scheduleReconnect();
    };
  }

  function send(obj) {
    if (!ws || ws.readyState !== 1) return false;
    try { ws.send(JSON.stringify(obj)); return true; } catch (e) { return false; }
  }

  function scheduleReconnect() {
    if (timer) clearTimeout(timer);
    retry++;
    var wait = Math.min(15000, 1500 * retry);
    timer = setTimeout(connect, wait);
  }

  function reconnect() { retry = 0; if (timer) clearTimeout(timer); connect(); }

  /** 读取枢纽信息（局域网地址、二维码支持），用于「课堂协同」页签展示 */
  function fetchServerInfo() {
    if (!root.fetch) return;
    root.fetch(hubBase() + '/health', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (info) {
        if (!info || !info.ok) return;
        serverInfo = info;
        if (hooks.onServerInfo) hooks.onServerInfo(info);
      })
      .catch(function () { /* 无枢纽信息（单机模式） */ });
  }

  /** 当前学生端入口地址（供二维码/文字展示）；拿不到时返回空串，由界面给出提示 */
  function joinURL() {
    var roomId = room();
    var ip = serverInfo && serverInfo.ips && serverInfo.ips.length ? serverInfo.ips[0] : null;
    var port = serverInfo && serverInfo.port ? serverInfo.port : (servedOverHttp() ? root.location.port : DEFAULT_LOCAL_PORT);
    if (!ip) return servedOverHttp() ? ((root.location ? root.location.origin : '') + '/join?room=' + roomId) : '';
    return 'http://' + ip + ':' + port + '/join?room=' + roomId;
  }

  function qrURL(text) {
    var base = hubBase();
    if (!base && !servedOverHttp()) return '';
    return base + '/qr.png?text=' + encodeURIComponent(text || joinURL());
  }

  /** 组装给大屏与学生端的全量快照 */
  function snapshot() {
    var s = CI.store.get();
    var teamRows = CI.analysis.teamRanking(s);
    var stuRows = CI.analysis.ranking(s, 'all');
    var qz = s.runtime.quizId ? CI.store.quiz(s, s.runtime.quizId) : null;
    var q = s.runtime.qid ? CI.store.question(s, s.runtime.qid) : null;
    var all = CI.store.allRecords(s);
    var cls = CI.classroom;

    var question = null;
    var revealed = !!(CI.classroom && CI.classroom.isRevealed ? CI.classroom.isRevealed(s, q) : s.runtime.reveal);
    if (q) {
      var options = (q.options || []).map(function (text, i) {
        return { key: CI.grade.LETTERS[i], text: text };
      });
      question = {
        id: q.id,
        stem: U.shortStem(q.stem, 120),
        fullStem: q.stem,
        /* 题目配图（数学图形题）：大屏与学生端都据此显示 */
        imageUrl: q.imageUrl || '',
        tier: q.tier,
        tierLabel: CI.store.tierOf(s, q.tier).label,
        points: CI.store.questionPoints(s, q),
        type: CI.grade.typeOf(q),
        typeLabel: CI.grade.typeLabel(q),
        multiple: CI.grade.parseChoice(q.answer).length > 1,
        options: options,
        hasAnswer: !!String(q.answer || '').trim(),
        answerKey: (revealed && String(q.answer || '').trim()) ? CI.grade.answerKey(q) : null,
        /* 讲评要点 / 易错点（题目的 note 字段）：**公布答案后才下发** ——
           与学生端「你的答案 + 正确答案 + 为什么」三件套配套，提前下发会泄题。 */
        explanation: revealed ? String(q.note || '') : '',
        tags: (q.tags || []).slice(0, 4)
      };
    }

    return {
      courseName: s.settings.courseName || '课堂积分',
      room: room(),
      updatedAt: Date.now(),
      teams: teamRows.map(function (t) {
        return {
          id: t.teamId, name: t.name, icon: t.icon, color: t.color,
          score: t.score, memberCount: t.memberCount, avg: t.avg, creditRate: t.creditRate
        };
      }),
      students: stuRows.map(function (r) {
        var stats = null;
        try { stats = CI.analysis.studentStats(s, r.sid); } catch (e) { stats = null; }
        return {
          id: r.sid, name: r.name, teamId: r.teamId, teamName: r.teamName, color: teamColor(s, r.teamId),
          score: r.score, attempts: r.attempts, correct: r.correct,
          creditRate: r.creditRate, correctRate: r.correctRate,
          rank: r.rank, level: r.level.label, rolls: r.rolls,
          weakTiers: (stats && stats.weak ? stats.weak : []).map(function (k) { return CI.store.tierOf(s, k).label; })
        };
      }),
      meta: Object.assign({
        quizName: qz ? qz.name : null,
        accepting: !!s.runtime.accepting,
        reveal: revealed,
        questionIndex: (function () {
          var qz2 = s.runtime.quizId ? CI.store.quiz(s, s.runtime.quizId) : null;
          if (!qz2 || !q) return null;
          var i = qz2.questionIds.indexOf(q.id);
          return i < 0 ? null : { index: i, total: qz2.questionIds.length };
        })(),
        question: question,
        tierWeights: s.tiers.map(function (t) { return { key: t.key, label: t.label, weight: t.weight, color: t.color }; }),
        recent: all.slice(-8).reverse().map(function (r) {
          var stu = CI.store.student(s, r.sid);
          return {
            name: stu ? stu.name : '?',
            tier: r.tier ? CI.store.tierOf(s, r.tier).label : '',
            result: CI.store.RESULT_LABEL[r.result] || r.result,
            points: r.points,
            at: r.at
          };
        })
      }, cls && cls.metaPayload ? cls.metaPayload() : {})
    };
  }

  function teamColor(s, tid) {
    var t = CI.store.team(s, tid);
    return t ? t.color : '#90a4ae';
  }

  function sendNow() {
    if (!ws || ws.readyState !== 1) return false;
    try {
      ws.send(JSON.stringify({ type: 'state', payload: snapshot(), room: room(), rev: U.num(CI.store.get().rev, 0) }));
      sendDump();
      return true;
    } catch (e) { return false; }
  }

  var lastDumpAt = 0;
  var dumpDirty = false;
  var dumpTimer = null;
  var dumpForced = false;

  /** 教师端主动向枢纽索取最近一次完整课堂数据（换电脑/清缓存后恢复） */
  function requestDump(force) {
    dumpForced = !!force;
    return send({ type: 'request-dump' });
  }

  /**
   * 完整课堂数据（含全部流水）单独走 dump 通道：枢纽只缓存、不广播，
   * 这样教师端换设备/清缓存后能恢复，而学生端拿不到无关的大数据。
   * 被节流时预约一次补发，保证变更最终一定会落到枢纽（否则恢复出来的是旧数据）。
   */
  function sendDump(force) {
    if (!ws || ws.readyState !== 1) return false;
    var now = Date.now();
    if (!force && now - lastDumpAt < 15000) {
      dumpDirty = true;
      if (!dumpTimer) {
        dumpTimer = setTimeout(function () {
          dumpTimer = null;
          if (dumpDirty) sendDump(true);
        }, Math.max(1000, 15000 - (now - lastDumpAt)));
      }
      return false;
    }
    try {
      ws.send(JSON.stringify({
        type: 'dump',
        room: room(),
        payload: { updatedAt: CI.store.get().updatedAt, rev: CI.store.get().rev, state: CI.store.get() }
      }));
      lastDumpAt = now;
      dumpDirty = false;
      return true;
    } catch (e) { return false; }
  }

  /** 节流推送（默认 400ms 合并），force=true 立即发送 */
  function push(force) {
    if (pushTimer) { if (!force) return; clearTimeout(pushTimer); pushTimer = null; }
    if (force) return sendNow();
    pushTimer = setTimeout(function () { pushTimer = null; sendNow(); }, 400);
  }

  CI.sync = {
    init: init, push: push, snapshot: snapshot, pushDump: sendDump, requestDump: requestDump,
    host: host, setHost: setHost, room: room, setRoom: setRoom,
    joinURL: joinURL, qrURL: qrURL, serverInfo: function () { return serverInfo; },
    sameOrigin: sameOrigin, reconnect: reconnect, refreshServerInfo: fetchServerInfo,
    state: function () { return ws ? ws.readyState : -1; },
    connected: function () { return !!ws && ws.readyState === 1; },
    rev: function () { return lastRev; },
    lastStatus: function () { return lastStatus; }
  };
})(typeof window !== 'undefined' ? window : globalThis);
