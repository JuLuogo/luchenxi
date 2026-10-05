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
    if (!doc) return;   // 无 DOM 时直接返回（Node 逻辑测试里没有 document）
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

  /**
   * 学生手动填写教师机地址（手机 App / 扫码带入）；保存后立刻重连。
   *
   * v5：界面换成 Vue 后，输入框由组件持有，组件会把值**作为参数**传进来
   * （`CIStudent.saveHost(hostInput.value)`）。旧实现只会去读 `#hubInput`，
   * 而 Vue 界面里根本没有这个元素 —— 结果是"学生填了 IP、点保存、地址却存成空字符串"，
   * 手机 App 永远连不上教师机，且界面上看不出任何异常。所以这里必须优先用传入值。
   */
  function saveHost(value) {
    var v;
    if (value === undefined || value === null) {
      var input = $('hubInput');            // 兜底：旧入口仍然有真实 DOM 输入框
      v = input ? input.value : '';
    } else {
      v = String(value);
    }
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
  /**
   * 连通性自检：客户端里问 Rust，浏览器里直接打 /health
   *
   * **必须返回 Promise<{ok, text}>**：Vue 端会 await 它并读 .ok。
   * 原来只调 toast、不返回任何值 → `res && res.ok` 恒假 →
   * 教师机明明在线，学生端永远弹"连不上，检查地址或让老师开大屏"（审计实测发现）。
   */
  function testHub() {
    var input = $('hubInput');
    if (input) setHubHost(input.value);
    toast('正在测试连接…');
    return new Promise(function (resolve) {
      var done = function (okFlag, text) {
        toast((okFlag ? '✅ 连上了：' : '❌ 连不上：') + text);
        notify();
        resolve({ ok: !!okFlag, text: String(text == null ? '' : text) });
      };
      if (inTauri()) {
        invoke('check_hub', { host: hubHost() }).then(function (res) {
          done(res && res.ok, (res && res.message) || '客户端自检');
        }).catch(function (err) { done(false, String(err && err.message || err)); });
        return;
      }
      // 浏览器：直接打 /health
      fetch(hubURL() + '/health').then(function (r) {
        done(r.ok, 'HTTP ' + r.status);
      }).catch(function (err) { done(false, String(err && err.message || err)); });
    });
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
    // 连上就把断网期间排队的补发出去（幂等 id 保证不会被记两次）
    setTimeout(flushQueue, 300);
      retry = 0;
      setConn('on', '已连接');
      if (teamId) hello();
    };
    ws.onmessage = function (evt) {
      var msg = null;
      try { msg = JSON.parse(evt.data); } catch (e) { return; }
      if (msg.type === 'state' || msg.type === 'leaderboard') {
        payload = msg.payload;
        // 换题就清空本地作答状态（否则新题显示"已选中"、草稿留着上一题，学生会误交）
        syncQuestion();
        render();
      } else if (msg.type === 'presence') {
        presence = msg;
        // 旧 renderHeader() 已随旧界面删除（2026-10）；这里要的是"通知订阅者"，
        // 与 render() 走同一个出口，否则 presence 变化时 Vue 学生端不会重绘（控制台还会刷 ReferenceError）。
        notify();
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

  /* ------------------------------------------------------------------ *
   * 断网排队 + 重连补发（审计 Top 8 第 1 位）
   * ------------------------------------------------------------------ *
   * 网络抖一下，学生点提交就丢了 —— 界面只从已连接变成未连接，教师端没有待确认条目，
   * 学生以为交了。同行普遍如此（在线即断即失），而本地部署恰恰能吃这个红利。
   *
   * 每条命令带幂等 id：补发多次也只会被记一次。
   */
  var QUEUE_KEY = 'ci_student_queue';
  var pending = [];

  /** 从 localStorage 读回上次没发出去的（刷新页面也不丢） */
  function loadQueue() {
    try {
      var saved = root.localStorage.getItem(QUEUE_KEY);
      if (saved) pending = JSON.parse(saved) || [];
    } catch (err) { pending = []; }
    if (!Array.isArray(pending)) pending = [];
  }

  function saveQueue() {
    try { root.localStorage.setItem(QUEUE_KEY, JSON.stringify(pending.slice(-50))); } catch (err) { /* 存不下就算了 */ }
  }

  /** 给命令补一个幂等 id（没有才补） */
  function withId(obj) {
    if (obj && obj.type === 'cmd' && obj.cmd && !obj.cmd.id) {
      obj.cmd.id = 'c_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    }
    return obj;
  }

  /** 发得出去就发；发不出去就排队（sent=已送达，queued=已受理） */
  function sendOrQueue(obj) {
    withId(obj);
    if (send(obj)) return { sent: true, queued: false };
    pending.push(obj);
    saveQueue();
    notify();
    return { sent: false, queued: true };
  }

  /** 连上之后把排队的补发出去（幂等 id 保证不会被记两次） */
  function flushQueue() {
    if (!pending.length) return 0;
    var sent = 0;
    var rest = [];
    pending.forEach(function (obj) {
      if (send(obj)) sent += 1; else rest.push(obj);
    });
    pending = rest;
    saveQueue();
    notify();
    if (sent) toast('已自动补交 ' + sent + ' 条');
    return sent;
  }

  /** 待补交条数（界面显示用） */
  function pendingCount() { return pending.length; }

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

  /**
   * 公开课现场状态（大屏与教师端同步过来的）
   *
   * `mine` = 被点到的是不是"我们组的人"：公开课点名是按人点的，
   * 学生端据此弹"到你了"，不用老师再喊一遍。
   */
  function openState() {
    var o = meta().open || null;
    if (!o) return null;
    var list = myMembers();
    var mine = false;
    for (var i = 0; i < list.length; i++) if (list[i].id === o.sid) mine = true;
    return { step: o.step, name: o.name, sid: o.sid, verdict: o.verdict, evaluation: o.evaluation, mine: mine };
  }
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
    notify();     // 旧 renderJoin() 已删；渲染交给 Vue
  }

  function setAnswerer(id) {
    answererId = id;
    try { root.localStorage.setItem(LS_ANSWERER, id); } catch (e) { /* 忽略 */ }
    notify();     // 旧 renderTeam() 已删
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
    notify();     // 旧 renderQA() 已删；渲染交给 Vue
  }

  /** 输入框草稿：避免收到状态广播重渲染时把学生正在输入的内容清掉 */
  function draft(value) {
    draftText = String(value || '');
  }
  var draftText = '';

  /** 学生端草稿文本（由界面传进来 —— 原来读 DOM 元素，Vue 界面里那是空壳） */
  var draftText = '';

  /** 上一次看到的题目 id：换题时要清空本地作答状态（否则新题显示"已选中"、草稿留着上一题） */
  var lastQid = null;

  /** 收到快照后调用：题目变了就清空选择与草稿 */
  function syncQuestion() {
    var q = question();
    var id = q ? q.id : null;
    if (id !== lastQid) {
      lastQid = id;
      selected = [];
      draftText = '';
      submitted = null;
      buzzed = null;
    }
  }

  /** 界面调它同步草稿（填空题/主观题的输入内容） */
  function setDraft(text) { draftText = String(text == null ? '' : text); }

  /**
   * 这道题该按哪种题型提交
   *
   * **不只看 q.type**：契约字段万一缺失（历史上真缺过），用 options 兜底判断，
   * 否则选择题会被当成主观题 —— 学生选的选项根本发不出去，永远 0 分。
   */
  function questionKind(q) {
    if (!q) return 'subjective';
    if (q.type === 'choice' || q.type === 'fill' || q.type === 'subjective') return q.type;
    // 兜底：有选项就是选择题；有标准答案没选项当填空；其余当主观题
    if ((q.options || []).length >= 2) return 'choice';
    if (q.hasAnswer) return 'fill';
    return 'subjective';
  }

  function submit(skip) {
    var q = question();
    if (!q) { toast('老师还没有出题'); return; }
    if (!accepting()) { toast('老师还没开始接收作答'); return; }
    if (submitted && submitted.qid === q.id) { toast('本题已经提交过了'); return; }

    var cmd = { kind: 'answer', teamId: teamId, sid: answererId || (me() || {}).id || null, qid: q.id, skip: !!skip };
    if (!skip) {
      var kind = questionKind(q);
      if (kind === 'choice') {
        if (!selected.length) { toast('请先选择选项'); return; }
        cmd.choice = selected.slice();
      } else if (kind === 'fill') {
        var v = String(draftText || '').trim();
        if (!v) { toast('请先填写答案'); return; }
        cmd.text = v;
      } else {
        cmd.text = String(draftText || '').trim() || '（口头/纸面作答）';
      }
    }

    // **发送失败不能假装成功**：断线时界面照常显示"已提交"，学生不会重试、老师收不到（审计发现）
    // 发不出去就排队：断网也能交，联网后自动补交
    var r = sendOrQueue({ type: 'cmd', cmd: cmd });
    if (!r.sent && !r.queued) { toast('发送失败，请重试'); notify(); return; }
    submitted = { qid: q.id, at: Date.now(), text: cmd.text || null };
    toast(skip ? '已提交：跳过' : '已提交，等待判定');
    notify();     // 旧 renderQA() 已删
  }

  function buzz() {
    var q = question();
    if (!accepting()) { toast('抢答还没开放'); return; }
    // 记下"已抢答"：否则学生端没有反馈、按钮不禁用，会连续猛点（审计发现）
    buzzed = { qid: q && q.id, at: Date.now() };
    var sent = send({ type: 'cmd', cmd: { kind: 'buzz', teamId: teamId, sid: answererId || (me() || {}).id || null, qid: q ? q.id : null } });
    toast(sent ? '已抢答！' : '未连接，请重试');
    if (!sent) buzzed = null;      // 没发出去就不算抢到
    notify();
  }

    /* 新版（Vue）界面里没有旧 DOM：所有写入都过一层空值守卫，避免整页报错 */
  function setHTML(id, html) { var e = $(id); if (e) e.innerHTML = html; }
  function setText(id, text) { var e = $(id); if (e) e.textContent = text; }
  function addClass(id, cls) { var e = $(id); if (e && e.classList) e.classList.add(cls); }
  function removeClass(id, cls) { var e = $(id); if (e && e.classList) e.classList.remove(cls); }
function init() {
loadQueue();   // 刷新页面也不丢：把上次没发出去的读回来
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
  /**
   * 计分规则（只读，给学生看）—— 审计 Top 8 第 3 位。
   *
   * 为什么：学生只看到"我得了多少分"，不知道分怎么来；改权重后无法复核，
   * 任何主观分都会变成新的不信任源（课堂派已验证的做法是"发布考核标准"）。
   *
   * 数据来自学生端已经收到的快照，不需要新端点。
   */
  function rules() {
    var s = payload || {};
    var st = s.settings || {};
    var tiers = (s.tiers || []).map(function (t) {
      return { key: t.key, label: t.label, weight: t.weight };
    });
    return {
      tiers: tiers,
      halfRatio: typeof st.halfRatio === 'number' ? st.halfRatio : 0.5,
      wrongPenalty: Number(st.wrongPenalty) || 0,
      fastBonus: Number(st.fastBonus) || 0,
      buzzRankBonuses: (st.buzzRankBonuses || []).slice(),
      minSample: Number(st.minSample) || 5
    };
  }

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
  CIStudent.rules = rules;
  CIStudent.question = question;
  CIStudent.teams = teams;
  CIStudent.students = students;
  CIStudent.meta = meta;
  CIStudent.me = me;
  CIStudent.openState = openState;
  CIStudent.myTeam = myTeam;
  CIStudent.accepting = accepting;
  CIStudent.boardMode = function () { return !!boardMode; };
  CIStudent.pickTeam = pickTeam;
  CIStudent.switchTeam = switchTeam;
  CIStudent.setAnswerer = setAnswerer;
  CIStudent.toggleOption = toggleOption;
  CIStudent.draft = draft;
  CIStudent.submit = submit;
CIStudent.sendOrQueue = sendOrQueue;
CIStudent.flushQueue = flushQueue;
CIStudent.pendingCount = pendingCount;
  CIStudent.setDraft = setDraft;
  CIStudent.syncQuestion = syncQuestion;
  CIStudent.questionKind = questionKind;
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
