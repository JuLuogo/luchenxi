/*!
 * student.js — 学生端（按小组入座）：答题提交 / 抢答 / 本组与个人看板 / 小组展示模式
 *
 *  与教师端的关系：学生端是纯客户端，不持有课堂数据，只做两件事
 *    ① 接收枢纽广播的课堂快照（state）并渲染自己的视图
 *    ② 通过 {type:'cmd'} 提交入座 / 抢答 / 作答
 *  协议见 docs/10-多端协同架构.md。
 */
(function (root) {
  'use strict';

  var doc = root.document;
  var CIStudent = root.CIStudent = root.CIStudent || {};
  var LS_TEAM = 'ci_team';
  var LS_ROOM = 'ci_room';
  var LS_ANSWERER = 'ci_answerer';
  var LS_HOST = 'ci_ws_host';          // 教师机地址（客户端/扫码/手输；浏览器同源打开时留空）

  var params = (function () {
    try { return new URLSearchParams(root.location.search); } catch (e) { return { get: function () { return null; } }; }
  })();

  var room = params.get('room') || (function () {
    try { return root.localStorage.getItem(LS_ROOM) || 'default'; } catch (e) { return 'default'; }
  })();
  var teamId = params.get('team') || (function () {
    try { return root.localStorage.getItem(LS_TEAM) || ''; } catch (e) { return ''; }
  })();
  var answererId = (function () {
    try { return root.localStorage.getItem(LS_ANSWERER) || ''; } catch (e) { return ''; }
  })();
  var boardMode = params.get('view') === 'board';

  var ws = null;
  var retry = 0;
  var payload = null;          // 最近一次课堂快照
  var presence = { hostOnline: false, teams: [] };
  var selected = [];           // 选择题已选选项
  var submitted = null;        // {qid, at, expectPending}
  var buzzed = null;           // {qid, at}
  var activeTab = 'qa';
  var lastQid = null;

  function $(id) { return doc.getElementById(id) || dummyEl(); }

  /**
   * 旧 DOM 不存在时（新版 Vue 学生端）返回一个"哑元素"：
   * 所有渲染写入都变成安全空操作，业务逻辑（提交/抢答/状态）不受影响。
   * 早先只给部分写入加守卫，仍有两段式写法（var box = $('qaPane'); box.innerHTML = …）
   * 会抛 "Cannot set properties of null"，把交互链路整条打断。
   */
  var dummyCache = null;
  function dummyEl() {
    if (dummyCache) return dummyCache;
    var noop = function () {};
    dummyCache = {
      innerHTML: '', textContent: '', value: '', disabled: false, className: '', id: '',
      style: {}, dataset: {}, children: [], childNodes: [], firstChild: null,
      classList: { add: noop, remove: noop, toggle: noop, contains: function () { return false; } },
      addEventListener: noop, removeEventListener: noop, appendChild: noop, removeChild: noop,
      remove: noop, focus: noop, click: noop, setAttribute: noop,
      getAttribute: function () { return null; },
      querySelector: function () { return null; },
      querySelectorAll: function () { return []; }
    };
    return dummyCache;
  }
  function esc(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function clock(ts) {
    var d = new Date(ts || Date.now());
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ':' + String(d.getSeconds()).padStart(2, '0');
  }
  var toastTimer = null;
  function toast(msg) {
    var t = $('toast');
    if (!t) return;
    t.textContent = msg;
    t.className = 'on';
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = ''; }, 2200);
  }

  /* ------------------------------------------------------------------ *
   * 连接
   * ------------------------------------------------------------------ */

  /** 教师机地址：显式配置（客户端/扫码/手输）优先；浏览器由枢纽托管时用同源地址 */
  function hubHostRaw() {
    try { return root.localStorage.getItem(LS_HOST) || ''; } catch (e) { return ''; }
  }
  function defaultPort() { return String(root.CI_DEFAULT_PORT || 8080); }
  function hubHost() {
    var h = hubHostRaw().trim();
    if (!h) return root.location.host;
    h = h.replace(/^wss?:\/\//i, '').replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
    // 只写 IP 时要补默认端口，否则会连到 80（与 Rust 侧 normalize() 同规则）
    if (h && h.indexOf(':') < 0) h += ':' + defaultPort();
    return h;
  }
  function setHubHost(v) {
    var clean = String(v || '').trim().replace(/^wss?:\/\//i, '').replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
    try { root.localStorage.setItem(LS_HOST, clean); } catch (e) { /* 忽略 */ }
    return clean;
  }
  function hubURL() {
    var proto = /^https:/.test(hubHostRaw()) ? 'https://' : 'http://';
    return proto + hubHost();
  }

  /** 页面是否由教师机枢纽托管（入座页据此决定要不要显示"填地址"输入框） */
  function servedByHub() {
    var loc = root.location;
    if (!loc || !loc.host || !/^https?:$/.test(loc.protocol || '')) return false;
    /**
     * Tauri v2 把打包好的前端挂在 `http://tauri.localhost` 下：协议是 http、host 也非空，
     * 但它**不是**教师机的枢纽 —— 真正的枢纽在教师机的 `IP:8080` 上。
     * 若按字面判成"由枢纽托管"，安卓 App 里就会**隐藏"填教师机地址"输入框**，
     * 学生既连不上、也没有任何入口去改地址，只能永远卡在"等待老师端推送名单…"。
     * 所以这里必须把客户端的伪源排除掉。
     */
    if (/^tauri\.localhost$/i.test(loc.host)) return false;
    return !hubHostRaw();
  }

  /** 学生手动填写教师机地址（手机 App / 扫码带入）；保存后立刻重连 */
  function saveHost() {
    var input = $('hubInput');
    var v = input ? input.value : '';
    setHubHost(v);
    toast('已保存教师机地址：' + hubHost());
    reconnectNow();
    render();
  }

  /** 客户端（Tauri）环境判定 + 调用 Rust 命令 */
  function inTauri() {
    return !!(root.__TAURI_INTERNALS__ || root.__TAURI__ || root.__TAURI_IPC__);
  }
  function invoke(cmd, args) {
    var t = root.__TAURI__;
    if (t && t.core && typeof t.core.invoke === 'function') return t.core.invoke(cmd, args);
    if (t && typeof t.invoke === 'function') return t.invoke(cmd, args);
    var i = root.__TAURI_INTERNALS__;
    if (i && typeof i.invoke === 'function') return i.invoke(cmd, args);
    return Promise.reject(new Error('当前环境不支持 invoke'));
  }

  /** 连通性自检：客户端里问 Rust，浏览器里直接打 /health */
  function testHub() {
    var input = $('hubInput');
    if (input) setHubHost(input.value);
    toast('正在测试连接…');
    var done = function (okFlag, text) {
      toast((okFlag ? '✅ 连上了：' : '❌ 连不上：') + text);
      render();
    };
    if (inTauri()) {
      invoke('check_hub', { host: hubHost() }).then(function (res) {
        done(res && res.ok, (res && (res.message || res.response || res.url)) || '无返回');
      }).catch(function (e) { done(false, (e && e.message) || String(e)); });
      return;
    }
    if (!root.fetch) { done(false, '当前环境不支持网络请求'); return; }
    root.fetch(hubURL() + '/health', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); })
      .then(function (info) { done(!!info.ok, '教师机枢纽在线（房间 ' + (info.rooms || []).join(',') + '）'); })
      .catch(function (e) { done(false, (e && e.message) || String(e)); });
  }

  /** EasyTier 组网引导（Android 无法内置 EasyTier CLI，只能引导） */
  function guidance() {
    return '① 首选：手机与教师机连同一个 WiFi（局域网直连，零配置）。\n' +
      '② 跨网络：手机装 EasyTier 官方 App，加入老师给的网络名/密钥，\n' +
      '   再把上面的地址填成教师机的虚拟 IP（例如 10.144.144.1:8080）。\n' +
      '③ 校内多网段：让老师在教师端「⑦ 课堂协同 → 组网」里开共享节点。';
  }

  function wsURL() {
    var proto = root.location.protocol === 'https:' ? 'wss://' : 'ws://';
    var url = proto + hubHost() + '/?room=' + encodeURIComponent(room) + '&role=team';
    if (teamId) url += '&team=' + encodeURIComponent(teamId) + '&label=' + encodeURIComponent(teamName() || teamId);
    return url;
  }

  function connect() {
    try { if (ws) { ws.onclose = null; ws.close(); } } catch (e) { /* 忽略 */ }
    try {
      ws = new WebSocket(wsURL());
    } catch (e) {
      setConn('off', '连接失败：' + e.message);
      return;
    }
    ws.onopen = function () {
      retry = 0;
      setConn('on', '已连接');
      if (teamId) hello();
    };
    ws.onmessage = function (evt) {
      var msg = null;
      try { msg = JSON.parse(evt.data); } catch (e) { return; }
      if (msg.type === 'state' || msg.type === 'leaderboard') {
        payload = msg.payload;
        render();
      } else if (msg.type === 'presence') {
        presence = msg;
        renderHeader();
      } else if (msg.type === 'welcome') {
        presence.hostOnline = !!msg.hostOnline;
        setConn('on', '已连接 ' + (msg.room || room));
      } else if (msg.type === 'ack') {
        if (msg.ok === false && msg.reason === 'teacher-offline') toast('老师端离线，已排队，稍后自动提交');
      } else if (msg.type === 'error') {
        toast(msg.message || '服务器提示');
      }
    };
    ws.onclose = function () {
      setConn('off', '已断开，重连中…');
      retry++;
      setTimeout(connect, Math.min(8000, 1000 * retry));
    };
    ws.onerror = function () { setConn('off', '连接异常'); };
  }

  function send(obj) {
    if (!ws || ws.readyState !== 1) { toast('还没连上老师端'); return false; }
    try { ws.send(JSON.stringify(obj)); return true; } catch (e) { return false; }
  }

  function hello() {
    send({ type: 'cmd', cmd: { kind: 'hello', teamId: teamId, label: teamName() } });
  }

  var connState = { cls: 'off', text: '连接中…' };

  function setConn(state, text) {
    connState = { cls: state, text: text };
    var dot = $('connDot');
    if (dot) dot.className = 's-dot ' + state;
    var t = $('connText');
    if (t) t.textContent = text;
    var h = $('hostState');
    if (h) h.textContent = presence.hostOnline ? '老师在线' : '老师端未连接';
  }

  /** 立即重连（改地址后不用等退避计时） */
  function reconnectNow() {
    retry = 0;
    connect();
  }

  /* ------------------------------------------------------------------ *
   * 数据提取
   * ------------------------------------------------------------------ */

  function teams() { return (payload && payload.teams) || []; }
  function students() { return (payload && payload.students) || []; }
  function meta() { return (payload && payload.meta) || {}; }
  function myTeam() {
    var list = teams();
    for (var i = 0; i < list.length; i++) if (list[i].id === teamId) return list[i];
    return null;
  }
  function teamName() {
    var t = myTeam();
    return t ? t.name : (params.get('label') || '');
  }
  function myMembers() {
    return students().filter(function (s) { return s.teamId === teamId; });
  }
  function question() { return meta().question || null; }
  function accepting() { return !!meta().accepting; }
  function me() {
    var list = myMembers();
    for (var i = 0; i < list.length; i++) if (list[i].id === answererId) return list[i];
    return list.length ? list[0] : null;
  }

  /* ------------------------------------------------------------------ *
   * 渲染
   * ------------------------------------------------------------------ */

  /**
   * 渲染入口：**已交给 Vue**（旧的 8 个 render 函数在 2026-10 随旧界面一起删除）。
   *
   * 保留空实现而不是删掉：状态机里有十几处"状态变了就 render()"的调用点，
   * 留着它那些地方一个字都不用改 —— 少改代码就少引入 bug。
   */
  function render() {
    // 旧的 DOM 渲染已删除，但**通知订阅者**这一步必须留着：
    // Vue 学生端就是靠 CIStudent.on(refresh) 收到状态变化后自己重绘的。
    // （删渲染函数时差点把这个出口一起删掉 —— e2e 立刻报"学生端渲染出题干"失败）
    notify();
  }
  function resultTag(r) {
    if (r === 'correct') return '<span class="tag ok">答对</span>';
    if (r === 'half') return '<span class="tag warn">部分正确</span>';
    if (r === 'wrong') return '<span class="tag bad">答错</span>';
    if (r === 'skip') return '<span class="tag">跳过</span>';
    return '';
  }

  function switchTab(tab) {
    activeTab = tab;
    ['qa', 'team', 'personal', 'board'].forEach(function (k) {
      var pane = $(k + 'Pane');
      if (pane) pane.classList.toggle('hidden', k !== tab);
      var btn = $('tab-' + k);
      if (btn) btn.classList.toggle('on', k === tab);
    });
  }

  /* ------------------------------------------------------------------ *
   * 交互
   * ------------------------------------------------------------------ */

  function pickTeam(id) {
    teamId = id;
    try { root.localStorage.setItem(LS_TEAM, id); } catch (e) { /* 忽略 */ }
    connect();
    toast('已入座：' + teamName());
  }

  function switchTeam() {
    teamId = '';
    try { root.localStorage.removeItem(LS_TEAM); } catch (e) { /* 忽略 */ }
    renderJoin();
  }

  function setAnswerer(id) {
    answererId = id;
    try { root.localStorage.setItem(LS_ANSWERER, id); } catch (e) { /* 忽略 */ }
    renderTeam();
  }

  function toggleOption(key) {
    var q = question();
    if (!q || (submitted && submitted.qid === q.id)) return;
    var multi = !!q.multiple;
    var i = selected.indexOf(key);
    if (i >= 0) selected.splice(i, 1);
    else {
      if (!multi) selected = [];     // 单选题：换选项即替换
      selected.push(key);
    }
    renderQA();
  }

  /** 输入框草稿：避免收到状态广播重渲染时把学生正在输入的内容清掉 */
  function draft(value) {
    draftText = String(value || '');
  }
  var draftText = '';

  function submit(skip) {
    var q = question();
    if (!q) { toast('老师还没有出题'); return; }
    if (!accepting()) { toast('老师还没开始接收作答'); return; }
    if (submitted && submitted.qid === q.id) { toast('本题已经提交过了'); return; }

    var cmd = { kind: 'answer', teamId: teamId, sid: answererId || (me() || {}).id || null, qid: q.id, skip: !!skip };
    if (!skip) {
      if (q.type === 'choice') {
        if (!selected.length) { toast('请先选择选项'); return; }
        cmd.choice = selected.slice();
      } else if (q.type === 'fill') {
        var input = $('fillInput');
        var v = input ? String(input.value || '').trim() : '';
        if (!v) { toast('请先填写答案'); return; }
        cmd.text = v;
      } else {
        var note = $('noteInput');
        cmd.text = note && String(note.value || '').trim() ? String(note.value).trim() : '（口头/纸面作答）';
      }
    }

    send({ type: 'cmd', cmd: cmd });
    submitted = { qid: q.id, at: Date.now(), text: cmd.text || null };
    toast(skip ? '已提交：跳过' : '已提交，等待判定');
    renderQA();
  }

  function buzz() {
    var q = question();
    if (!accepting()) { toast('抢答还没开放'); return; }
    send({ type: 'cmd', cmd: { kind: 'buzz', teamId: teamId, sid: answererId || (me() || {}).id || null, qid: q ? q.id : null } });
    toast('已抢答！');
  }

    /* 新版（Vue）界面里没有旧 DOM：所有写入都过一层空值守卫，避免整页报错 */
  function setHTML(id, html) { var e = $(id); if (e) e.innerHTML = html; }
  function setText(id, text) { var e = $(id); if (e) e.textContent = text; }
  function addClass(id, cls) { var e = $(id); if (e && e.classList) e.classList.add(cls); }
  function removeClass(id, cls) { var e = $(id); if (e && e.classList) e.classList.remove(cls); }
function init() {
    if (boardMode) doc.body.className = 'board-mode';
    connect();
    render();
    var head = $('sHead');
    if (head && head.addEventListener) head.addEventListener('dblclick', switchTeam);   // 新版界面没有这个元素
  }

  /* ------------------------------------------------------------------ *
   * 给新的 Vue 学生端用：可订阅状态变化，旧的 DOM 渲染可以不参与
   * ------------------------------------------------------------------ */
  var listeners = [];
  function on(fn) {
    if (typeof fn !== 'function') return function () {};
    listeners.push(fn);
    return function off() {
      var i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    };
  }
  function notify() {
    listeners.slice().forEach(function (fn) {
      try { fn(); } catch (e) { if (root.console) root.console.error('[student] listener error', e); }
    });
  }

  /** Vue 侧读取的完整状态（每次收快照 / 提交后都会变） */
  function stateSnapshot() {
    return {
      room: room,
      host: hubHost(),
      boardMode: !!boardMode,
      teamId: teamId,
      answererId: answererId,
      connected: connState.cls === 'on',
      connText: connState.text,
      payload: payload,
      presence: presence,
      selected: selected.slice(),
      submitted: submitted,
      buzzed: buzzed
    };
  }

  CIStudent.init = init;
  CIStudent.on = on;
  CIStudent.state = stateSnapshot;
  CIStudent.question = question;
  CIStudent.teams = teams;
  CIStudent.students = students;
  CIStudent.meta = meta;
  CIStudent.me = me;
  CIStudent.myTeam = myTeam;
  CIStudent.accepting = accepting;
  CIStudent.boardMode = function () { return !!boardMode; };
  CIStudent.pickTeam = pickTeam;
  CIStudent.switchTeam = switchTeam;
  CIStudent.setAnswerer = setAnswerer;
  CIStudent.toggleOption = toggleOption;
  CIStudent.draft = draft;
  CIStudent.submit = submit;
  CIStudent.buzz = buzz;
  CIStudent.switchTab = switchTab;
  CIStudent.saveHost = saveHost;
  CIStudent.testHub = testHub;
  CIStudent.showGuide = function () {
    var box = $('hubGuide');
    if (!box) return;
    if (box.style.display === 'none' || !box.style.display) {
      box.textContent = guidance();
      box.style.display = 'block';
    } else box.style.display = 'none';
  };
  CIStudent.guidance = guidance;
  CIStudent.hub = function () { return { host: hubHost(), url: hubURL(), configured: !!hubHostRaw(), servedByHub: servedByHub(), inTauri: inTauri() }; };
  CIStudent.data = function () { return { payload: payload, teamId: teamId, room: room, submitted: submitted }; };

  // 只有旧版 student.html 的结构存在时才自动初始化；
  // 新版（Vue）学生端会自己调用 CIStudent.init()，不需要旧的 DOM。
  if (doc && doc.getElementById && doc.getElementById('sHead')) {
    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', init);
    else init();
  }
})(typeof window !== 'undefined' ? window : globalThis);
