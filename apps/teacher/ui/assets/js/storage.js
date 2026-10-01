/*!
 * storage.js — 教师端持久化适配层
 *
 *  两种后端，自动选择：
 *    · sqlite —— 教师机本地 SQLite（由枢纽 /api/state 提供读写；桌面 App 里是 Rust 直连同一个 .db）
 *    · local  —— 浏览器 localStorage（v3 行为；没有枢纽时兜底）
 *
 *  设计要点：
 *    1. 内存里的 state 始终是同步的（store.js 不动），持久化在后台异步完成；
 *    2. 启动时以「谁新用谁」为原则合并一次：远端没有就推本地，本地为空就拉远端；
 *    3. 每次 store.commit() 都会防抖落库，断电/崩溃最多丢 1 秒内的操作。
 */
(function (root) {
  'use strict';

  var CI = root.CI = root.CI || {};
  var U = CI.util;

  var LS_HOST = 'ci_ws_host';
  var LS_ROOM = 'ci_room';
  var PUSH_DEBOUNCE = 800;
  var MAX_RETRY = 4;          // 写入失败最多自动重试 4 次（退避 1s/2s/3s/4s）
  var RETRY_BASE = 1000;

  var state = {
    backend: 'local',        // local | sqlite | tauri
    base: '',                // '' = 与页面同源
    room: 'default',
    online: false,
    lastPushAt: 0,
    lastError: '',
    degraded: false,         // true = 本该用数据库，但命令失败退回了 localStorage
    staleRejected: false,    // true = 本次写入被枢纽以"你这份更旧"为由拒绝
    attempts: 0,             // 连续失败次数（成功后清零）
    counts: null,
    info: null
  };

  var pushTimer = null;
  var retryTimer = null;
  var dirty = false;

  /* ------------------------------------------------------------------ *
   * 环境探测
   * ------------------------------------------------------------------ */

  /** 是否跑在 Tauri 客户端里（桌面 App / Android App） */
  function inTauri() {
    return !!(root.__TAURI_INTERNALS__ || root.__TAURI__ || root.__TAURI_IPC__);
  }

  /** 调用 Rust 命令（Tauri v2：window.__TAURI_INTERNALS__.invoke） */
  function invoke(cmd, args) {
    var t = root.__TAURI__;
    if (t && t.core && typeof t.core.invoke === 'function') return t.core.invoke(cmd, args);
    if (t && typeof t.invoke === 'function') return t.invoke(cmd, args);
    var internals = root.__TAURI_INTERNALS__;
    if (internals && typeof internals.invoke === 'function') return internals.invoke(cmd, args);
    return Promise.reject(new Error('当前环境不支持 invoke'));
  }

  function servedOverHttp() {
    var loc = root.location;
    return !!(loc && loc.host && /^https?:$/.test(loc.protocol || ''));
  }

  function room() {
    try { return root.localStorage.getItem(LS_ROOM) || 'default'; } catch (e) { return 'default'; }
  }

  /** 枢纽 HTTP 基地址：显式配置 > 同源 > file:// 时用本机默认端口 */
  function base() {
    var h = '';
    try { h = root.localStorage.getItem(LS_HOST) || ''; } catch (e) { h = ''; }
    if (h) return /^wss?:\/\//i.test(h) ? h.replace(/^ws/, 'http') : 'http://' + h;
    if (servedOverHttp()) return '';
    return 'http://localhost:' + (root.CI_DEFAULT_PORT || 8080);
  }

  function api(path) { return base() + path + (path.indexOf('?') >= 0 ? '&' : '?') + 'room=' + encodeURIComponent(room()); }

  /** 探测运行环境与存储后端（客户端内 = Rust 直连 SQLite；浏览器 = 枢纽 HTTP；都没有 = localStorage） */
  function probe() {
    if (inTauri()) {
      state.online = true;
      state.backend = 'tauri';
      state.degraded = false;
      return invoke('db_file', {})
        .then(function (info) {
          state.info = info || null;
          return invoke('db_load', { room: room() })
            .then(function (res) {
              state.counts = res && res.counts ? res.counts : null;
              return state;
            });
        })
        .catch(function (e) {
          // 客户端里命令失败（旧版本未注册 / 数据库打不开）：退回 localStorage，
          // 但必须让界面能说清"数据没丢"，否则老师会以为记的分全没了。
          state.lastError = e && e.message ? e.message : String(e);
          state.backend = 'local';
          state.degraded = true;
          return state;
        });
    }
    if (!root.fetch) return Promise.resolve(state);
    return root.fetch(base() + '/health', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (info) {
        if (!info || !info.ok) throw new Error('no-hub');
        state.online = true;
        state.info = info;
        state.backend = info.storage === 'sqlite' ? 'sqlite' : 'local';
        state.counts = info.counts || null;
        return state;
      })
      .catch(function () {
        state.online = false;
        state.backend = 'local';
        return state;
      });
  }

  /** 客户端（Tauri）下的合并：库里有就用库，没有就把当前内存态写进去 */
  function bootstrapTauri() {
    return invoke('db_load', { room: room() }).then(function (remote) {
      var s = CI.store.get();
      var localHas = (s.students && s.students.length > 0) || CI.store.allRecords(s).length > 0;
      var remoteState = remote && remote.dump;
      var remoteHas = !!(remoteState && ((remoteState.students && remoteState.students.length) || (remoteState.quizzes && remoteState.quizzes.length)));
      // 同 sqlite 分支：以本机为准时先把 rev 抬到库里水位之上，否则写入会被判过期（409）
      var dbRev = U.num(remote && remote.rev, 0);
      function alignRev() { if (dbRev > 0) CI.store.bumpRev(dbRev); }

      if (!remoteHas && localHas) { alignRev(); push(CI.store.get(), true); return { action: 'seeded-remote' }; }
      if (remoteHas && !localHas) { CI.store.replaceState(remoteState); return { action: 'loaded-remote' }; }
      if (!remoteHas && !localHas) { alignRev(); return { action: 'both-empty', hubRev: dbRev }; }

      var remoteAt = U.num(remoteState.updatedAt, 0);
      var localAt = U.num(s.updatedAt, 0);
      if (remoteAt > localAt + 1000) { CI.store.replaceState(remoteState); return { action: 'loaded-remote' }; }
      if (localAt > remoteAt + 1000) { alignRev(); push(CI.store.get(), true); return { action: 'pushed-local' }; }
      alignRev();
      return { action: 'in-sync' };
    });
  }

  /**
   * 启动合并：
   *   远端无数据 → 把本地推上去（首次升级、换库）
   *   本地无数据 → 用远端（换设备、清缓存）
   *   两边都有   → 比 updatedAt，新的赢；本地赢则推送
   * @returns {Promise<{action:string}>}
   */
  function bootstrap() {
    return probe().then(function () {
      if (state.backend === 'tauri') return bootstrapTauri();
      if (state.backend !== 'sqlite') return { action: 'local-only' };
      return root.fetch(api('/api/state'), { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (remote) {
          var s = CI.store.get();
          var localHas = (s.students && s.students.length > 0) || CI.store.allRecords(s).length > 0;
          var remoteState = remote && remote.dump;
          var remoteHas = !!(remoteState && ((remoteState.students && remoteState.students.length) || (remoteState.quizzes && remoteState.quizzes.length)));
          /**
           * 枢纽房间的 rev 可能远高于本机（历史写入 / 别人用过这台教师机 / 本机清了缓存）。
           * 只要最终是"以本机为准"，就必须先把本机 rev 抬到枢纽水位之上，
           * 否则后续写入会被判过期（409），大屏与学生端永远收不到数据。
           */
          var hubRev = U.num(remote && remote.rev, 0);
          function alignRev() {
            if (hubRev > 0) CI.store.bumpRev(hubRev);
          }

          if (!remoteHas && localHas) { alignRev(); push(CI.store.get(), true); return { action: 'seeded-remote' }; }
          if (remoteHas && !localHas) { CI.store.replaceState(remoteState); return { action: 'loaded-remote' }; }
          if (!remoteHas && !localHas) { alignRev(); return { action: 'both-empty', hubRev: hubRev }; }

          var remoteAt = U.num(remoteState.updatedAt, 0);
          var localAt = U.num(s.updatedAt, 0);
          if (remoteAt > localAt + 1000) { CI.store.replaceState(remoteState); return { action: 'loaded-remote' }; }
          if (localAt > remoteAt + 1000) { alignRev(); push(CI.store.get(), true); return { action: 'pushed-local' }; }
          alignRev();
          return { action: 'in-sync' };
        });
    });
  }

  /** 落库（防抖）；force=true 立即写。后端不是数据库时直接跳过（纯 localStorage 模式） */
  function push(s, force) {
    if (state.backend !== 'sqlite' && state.backend !== 'tauri') return false;
    dirty = true;
    if (force) {
      if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; }
      return send(s || CI.store.get());
    }
    if (pushTimer) return true;
    pushTimer = setTimeout(function () {
      pushTimer = null;
      if (dirty) send(CI.store.get());
    }, PUSH_DEBOUNCE);
    return true;
  }

  function send(s) {
    if (state.backend === 'tauri') return sendTauri(s);
    if (!root.fetch) return false;
    var body = JSON.stringify({ dump: s, rev: U.num(s.rev, 0) });
    try {
      root.fetch(api('/api/state'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: body,
        keepalive: true
      })
        // 注意：409（过期写入）也带 JSON 正文，所以先解析再判断，不能只看 r.ok
        .then(function (r) { return r.json().catch(function () { return null; }); })
        .then(function (res) {
          if (res && res.ok) {
            dirty = false; state.lastPushAt = Date.now(); state.lastError = ''; state.staleRejected = false;
            state.counts = res.counts || state.counts;
            state.attempts = 0;
          } else if (res && res.stale) {
            // 枢纽认为我们这份比它旧（多写者场景）：不算失败，但要提示，避免"我改的没生效"说不清
            dirty = false; state.staleRejected = true; state.lastError = res.message || '枢纽上有更新的数据，本次未覆盖';
          } else {
            fail(res && res.message ? res.message : '写入失败');
          }
        })
        .catch(function (e) { fail(e.message); });
      return true;
    } catch (e) {
      fail(e.message);
      return false;
    }
  }

  /** 客户端（Tauri）落库：直接调 Rust 命令写 SQLite，不经过 HTTP */
  function sendTauri(s) {
    try {
      invoke('db_save', { room: room(), dump: s, rev: U.num(s.rev, 0) })
        .then(function (res) {
          if (res && res.ok) {
            dirty = false; state.lastPushAt = Date.now(); state.lastError = '';
            state.staleRejected = false; state.attempts = 0;
            if (res.counts) state.counts = res.counts;
          } else if (res && res.stale) {
            dirty = false; state.staleRejected = true; state.lastError = res.message || '库里有更新的数据，本次未覆盖';
          } else {
            fail(res && res.message ? res.message : '写入失败');
          }
        })
        .catch(function (e) { fail(e && e.message ? e.message : String(e)); });
      return true;
    } catch (e) {
      fail(e.message);
      return false;
    }
  }

  /**
   * 写入失败处理：**保留 dirty 并退避重试**（最多 MAX_RETRY 次）。
   * 为什么不能只在下次 commit 时顺带重试：老师可能连续记完分就不再操作，
   * 若此时恰逢写入失败（磁盘忙 / 命令异常），这份数据就永远停在浏览器里了。
   */
  function fail(message) {
    state.lastError = message;
    state.attempts = (state.attempts || 0) + 1;
    dirty = true;
    if (state.attempts > MAX_RETRY) return;                  // 放弃自动重试，但仍标记未落库
    var wait = RETRY_BASE * state.attempts;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(function () {
      retryTimer = null;
      if (dirty && (state.backend === 'tauri' || state.backend === 'sqlite')) send(CI.store.get());
    }, wait);
  }

  /** 立即落库（不等防抖）：关页/切后台/用户点「立即保存」时用 */
  function flush() {
    if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; }
    if (!dirty) return Promise.resolve(false);
    if (state.backend !== 'tauri' && state.backend !== 'sqlite') return Promise.resolve(false);
    send(CI.store.get());
    return Promise.resolve(true);
  }

  /** 从库中读回（教师端「恢复」按钮与排障用） */
  function pull() {
    if (state.backend === 'tauri') {
      return invoke('db_load', { room: room() }).catch(function () { return null; });
    }
    if (!root.fetch) return Promise.resolve(null);
    return root.fetch(api('/api/state'), { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; });
  }

  /** 后端可读描述（界面展示用） */
  function describe() {
    if (state.backend === 'tauri') {
      return '本地数据库 SQLite（客户端内置' +
        (state.info && state.info.path ? '：' + state.info.path : '') + '）' + writeNote();
    }
    if (state.backend === 'sqlite') {
      return '本地数据库 SQLite（' + (state.info && state.info.db ? state.info.db : 'classroom.db') + '）' + writeNote();
    }
    // 客户端里数据库不可用 → 明确安抚：数据没丢，只是存在浏览器本地
    if (state.degraded) {
      return '⚠️ 内置数据库不可用（' + (state.lastError || '未知原因') + '），已退回浏览器本地存储：' +
        '数据不会丢，但换设备或清缓存前请先「导出全部数据」';
    }
    if (state.online) return '枢纽在线，但未启用 SQLite（退回文件缓存）';
    return '本机存储 localStorage（未连接枢纽；桌面版请启动枢纽后重启应用）';
  }

  /** 写入状态后缀：待重试 / 被拒绝 都要能看见 */
  function writeNote() {
    if (state.staleRejected) return '· ⚠️ 有更新的数据，本次未覆盖';
    if (dirty && state.attempts) return '· ⚠️ 写入失败（第 ' + state.attempts + ' 次），重试中：' + state.lastError;
    if (dirty) return '· 写入中…';
    return state.lastError ? '· 最近写入异常：' + state.lastError : '';
  }

  /** 需要界面红字提示时用（客户端降级 / 写入失败） */
  function warning() {
    if (state.degraded) return describe();
    if (state.backend !== 'tauri' && state.backend !== 'sqlite') return '';
    if (state.staleRejected) return state.lastError;
    if (dirty && state.attempts) {
      return '数据尚未落库（第 ' + state.attempts + ' 次失败：' + state.lastError + '），已保留并自动重试；' +
        '数据仍在内存与本地存储中，可点「立即保存」或先导出备份';
    }
    return state.lastError ? '数据库写入异常：' + state.lastError + '（数据仍在内存与本地存储中）' : '';
  }

  CI.storage = {
    probe: probe, bootstrap: bootstrap, push: push, pull: pull, describe: describe, warning: warning,
    flush: flush,
    backend: function () { return state.backend; },
    isSqlite: function () { return state.backend === 'sqlite' || state.backend === 'tauri'; },
    isDegraded: function () { return !!state.degraded; },
    isDirty: function () { return !!dirty; },
    inTauri: inTauri, invoke: invoke,
    room: room, base: base,
    status: function () { return state; }
  };
})(typeof window !== 'undefined' ? window : globalThis);
