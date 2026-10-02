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

  function render() {
    notify();                                     // 新版（Vue）界面靠这个刷新
    if (boardMode) doc.body.className = 'board-mode';
    // 旧版 DOM 不存在时（Vue 学生端）只通知订阅者，不做任何 DOM 渲染
    if (!$('joinScreen')) return;
    doc.body.className = boardMode ? 'board-mode' : '';
    if (!teamId) { renderJoin(); return; }
    addClass('joinScreen', 'hidden');
    removeClass('mainScreen', 'hidden');
    renderHeader();
    if (boardMode) { renderBoard(); return; }
    renderQA();
    renderTeam();
    renderPersonal();
    renderBoardList();
    switchTab(activeTab);
  }

  function renderJoin() {
    addClass('mainScreen', 'hidden');
    var box = $('joinScreen');
    box.classList.remove('hidden');
    var list = teams();
    box.innerHTML =
      '<div class="card">' +
        '<div class="join-title">选择你的小组入座</div>' +
        '<div class="muted">房间：<b>' + esc(room) + '</b>　' +
          (list.length ? '共 ' + list.length + ' 个小组' : '等待老师端推送名单…') + '</div>' +
        '<div class="team-pick">' +
          (list.length
            ? list.map(function (t) {
                return '<button onclick="CIStudent.pickTeam(\'' + t.id + '\')">' +
                  esc((t.icon || '') + ' ' + t.name) +
                  '<span class="sub" style="display:block;font-size:.8rem;color:#6b7a8d;font-weight:400">' +
                  (t.memberCount || 0) + ' 人 · ' + (t.score || 0) + ' 分</span></button>';
              }).join('')
            : '<div class="muted">教师端还没开始上课，请稍候；或让老师确认已经连上枢纽。</div>') +
        '</div>' +
        '<div class="muted" style="margin-top:12px">' +
          '地址不对？确认手机与教师机在同一网络（或已加入 EasyTier 虚拟网），地址形如 ' +
          '<code>http://' + esc(connState.cls === 'ok' ? hubHost() : '教师机IP') + ':8080/join</code>' +
        '</div>' +
        (servedByHub() ? '' :
          '<div class="card-sub" style="margin-top:14px;border-top:1px dashed #d8dee9;padding-top:12px">' +
            '<div class="muted" style="margin-bottom:6px">当前不是由教师机打开的（手机 App / 本地文件），请填写<b>教师机地址</b>：</div>' +
            '<div style="display:flex;gap:8px">' +
              '<input id="hubInput" inputmode="url" placeholder="192.168.1.20:8080 或 http://ip:8080/join"' +
                ' value="' + esc(hubHostRaw()) + '" style="flex:1;padding:10px;border:1px solid #cfd8e3;border-radius:8px;font-size:1rem">' +
              '<button class="btn" onclick="CIStudent.saveHost()">连接</button>' +
            '</div>' +
            '<div class="muted" style="margin-top:8px">当前目标：<code>' + esc(hubURL()) + '</code>' +
              (connState.cls === 'ok' ? '　✅ 已连上教师机' : '　⚠️ 未连上（检查 IP、端口与防火墙）') + '</div>' +
            '<button class="mini-btn" style="margin-top:8px" onclick="CIStudent.testHub()">测试连接</button>' +
            '<button class="mini-btn" style="margin-top:8px;margin-left:8px" onclick="CIStudent.showGuide()">组网引导</button>' +
            '<div id="hubGuide" class="muted" style="display:none;white-space:pre-line;margin-top:8px;font-size:.85rem"></div>' +
          '</div>') +
      '</div>';
  }

  function renderHeader() {
    var t = myTeam();
    var rank = '';
    if (t) {
      var sorted = teams().slice().sort(function (a, b) { return (b.score || 0) - (a.score || 0); });
      for (var i = 0; i < sorted.length; i++) if (sorted[i].id === teamId) rank = '第 ' + (i + 1) + ' 名 / ' + sorted.length + ' 组';
    }
    setHTML('sHead',
      '<div>' +
        '<div class="course">' + esc((payload && payload.courseName) || '课堂积分') + '</div>' +
        '<div class="team">' + esc(t ? ((t.icon || '') + ' ' + t.name) : '未入座') + '</div>' +
        '<div class="muted" style="color:rgba(255,255,255,.85)">' +
          '<span class="s-dot ' + connState.cls + '" id="connDot"></span> <span id="connText">' + esc(connState.text) + '</span>' +
          '　<span id="hostState">' + (presence.hostOnline ? '老师在线' : '老师端未连接') + '</span></div>' +
      '</div>' +
      '<div class="score"><b>' + (t ? (t.score || 0) : '—') + '</b><span>' + esc(rank || '本组积分') + '</span></div>');
  }

  function resultTag(r) {
    if (r === 'correct') return '<span class="tag ok">答对</span>';
    if (r === 'half') return '<span class="tag warn">部分正确</span>';
    if (r === 'wrong') return '<span class="tag bad">答错</span>';
    if (r === 'skip') return '<span class="tag">跳过</span>';
    return '';
  }

  function renderQA() {
    var q = question();
    var m = meta();
    var box = $('qaPane');

    if (!q) {
      box.innerHTML = '<div class="card"><h2>等待老师出题</h2>' +
        '<div class="muted">老师选择题目并「开始接收作答」后，这里会出现题目。</div>' +
        (m.buzz && m.buzz.length ? '<div class="muted" style="margin-top:8px">抢答顺序：' +
          m.buzz.map(function (b, i) { return (i + 1) + '. ' + esc(b.teamName); }).join('　') + '</div>' : '') +
        '</div>';
      return;
    }

    if (lastQid !== q.id) { lastQid = q.id; selected = []; submitted = null; buzzed = null; }

    var answeredAlready = submitted && submitted.qid === q.id;
    var feedHit = (m.feed || []).filter(function (f) {
      return f.teamId === teamId && submitted && f.at >= submitted.at - 3000;
    })[0];

    var body = '';
    if (q.type === 'choice') {
      body = '<div class="opts">' + (q.options || []).map(function (o) {
        var on = selected.indexOf(o.key) >= 0;
        var isAnswer = m.reveal && q.answerKey && q.answerKey.indexOf(o.key + '.') >= 0;
        return '<button class="opt ' + (on ? 'on ' : '') + (isAnswer ? 'correct' : '') +
          '" onclick="CIStudent.toggleOption(\'' + o.key + '\')">' +
          '<span class="key">' + esc(o.key) + '</span><span>' + esc(o.text) + '</span></button>';
      }).join('') + '</div>';
    } else if (q.type === 'fill') {
      body = '<input class="answer" id="fillInput" placeholder="输入你的答案" oninput="CIStudent.draft(this.value)" ' +
        (answeredAlready ? 'disabled' : '') + ' value="' + esc(draftText || (submitted && submitted.text) || '') + '">';
      if (m.reveal && q.answerKey) body += '<div class="answer-box">参考答案：' + esc(q.answerKey) + '</div>';
    } else {
      body = '<div class="muted">主观题：小组讨论后在纸上/口头作答，完成后点下面的按钮告诉老师。</div>' +
        '<textarea class="answer" id="noteInput" rows="3" oninput="CIStudent.draft(this.value)" placeholder="可填写要点，便于老师记录（可留空）">' + esc(draftText) + '</textarea>';
    }

    var status = '';
    if (answeredAlready && feedHit) {
      var pending = feedHit.result ? false : true;
      status = '<div class="answer-box ' + (feedHit.result === 'correct' ? '' : (pending ? 'pending' : 'bad')) + '">' +
        (pending ? '已提交，等待老师确认…'
          : ('已提交：' + (feedHit.result === 'correct' ? '答对' : feedHit.result === 'half' ? '部分正确' : feedHit.result === 'wrong' ? '答错' : '跳过') +
             (feedHit.points ? ('　' + (feedHit.points > 0 ? '+' : '') + feedHit.points + ' 分') : ''))) +
        '</div>';
    } else if (answeredAlready) {
      status = '<div class="answer-box pending">已提交，等待判定…</div>';
    }

    var members = myMembers();
    var who = me();
    var whoPick = members.length > 1
      ? '<div class="row" style="margin-top:10px"><span class="muted">本题由谁作答：</span>' +
        '<select id="answererSel" onchange="CIStudent.setAnswerer(this.value)" style="padding:8px;border-radius:10px;border:1px solid #ccd">' +
        members.map(function (s) {
          return '<option value="' + s.id + '"' + (who && who.id === s.id ? ' selected' : '') + '>' + esc(s.name) + '</option>';
        }).join('') + '</select></div>'
      : '';

    var canSubmit = accepting() && !answeredAlready;
    var myBuzz = (m.buzz || []).filter(function (b) { return b.teamId === teamId; }).length > 0;

    box.innerHTML =
      '<div class="card">' +
        '<div class="q-head">' +
          '<span class="tag">' + esc(q.tierLabel) + '</span>' +
          '<span class="tag">' + esc(q.typeLabel) + '</span>' +
          '<span class="tag ok">答对 +' + q.points + ' 分</span>' +
          (accepting() ? '<span class="tag ok">正在接收作答</span>' : '<span class="tag warn">未开放作答</span>') +
        '</div>' +
        '<div class="q-stem">' + esc(q.fullStem || q.stem) + '</div>' +
        (q.imageUrl ? '<img class="q-image" src="' + esc(q.imageUrl) + '" alt="题目配图">' : '') +
        body +
        whoPick +
        (q.type === 'choice'
          ? '<button class="big" ' + (canSubmit ? '' : 'disabled') + ' onclick="CIStudent.submit(false)">提交答案</button>'
          : (q.type === 'fill'
            ? '<button class="big" ' + (canSubmit ? '' : 'disabled') + ' onclick="CIStudent.submit(false)">提交答案</button>'
            : '<button class="big" ' + (canSubmit ? '' : 'disabled') + ' onclick="CIStudent.submit(false)">我们组答完了</button>')) +
        '<button class="big buzz ' + (myBuzz ? 'on' : '') + '" ' + (accepting() && !myBuzz ? '' : 'disabled') +
          ' onclick="CIStudent.buzz()">' + (myBuzz ? '本组已抢答' : '⚡ 抢答') + '</button>' +
        '<button class="big ghost" ' + (canSubmit ? '' : 'disabled') + ' onclick="CIStudent.submit(true)">这题跳过</button>' +
        status +
      '</div>' +
      ((m.buzz && m.buzz.length)
        ? '<div class="card"><h2>抢答顺序</h2><div class="list">' + m.buzz.map(function (b, i) {
            return '<div class="item ' + (b.teamId === teamId ? 'me' : '') + '" style="border-left-color:' +
              (b.teamId === teamId ? '#4a5fc1' : '#cfd8dc') + '"><span class="rk">' + (i + 1) + '</span>' +
              '<span class="nm">' + esc(b.teamName) + '</span><span class="muted">' + clock(b.at) + '</span></div>';
          }).join('') + '</div></div>'
        : '');
  }

  function renderTeam() {
    var t = myTeam();
    var box = $('teamPane');
    if (!t) { box.innerHTML = '<div class="card">未入座</div>'; return; }
    var sorted = teams().slice().sort(function (a, b) { return (b.score || 0) - (a.score || 0); });
    var rank = 1;
    sorted.forEach(function (x, i) { if (x.id === teamId) rank = i + 1; });

    box.innerHTML =
      '<div class="card"><h2>本组概况</h2>' +
        '<div class="stat-grid">' +
          '<div class="stat"><b>' + (t.score || 0) + '</b><span>本组积分</span></div>' +
          '<div class="stat"><b>' + rank + '/' + sorted.length + '</b><span>当前排名</span></div>' +
          '<div class="stat"><b>' + (t.memberCount || 0) + '</b><span>组员人数</span></div>' +
          '<div class="stat"><b>' + (t.creditRate || 0) + '%</b><span>加权得分率</span></div>' +
        '</div>' +
      '</div>' +
      '<div class="card"><h2>组员积分</h2><div class="list">' +
        myMembers().slice().sort(function (a, b) { return (b.score || 0) - (a.score || 0); }).map(function (s) {
          return '<div class="item ' + (s.id === answererId ? 'me' : '') + '">' +
            '<span class="nm">' + esc(s.name) +
              '<span class="sub">作答 ' + (s.attempts || 0) + ' 题 · 得分率 ' + (s.creditRate || 0) + '% · 被点 ' + (s.rolls || 0) + ' 次</span></span>' +
            '<span class="sc">' + (s.score || 0) + '</span></div>';
        }).join('') +
      '</div></div>';
  }

  function renderPersonal() {
    var box = $('personalPane');
    var who = me();
    if (!who) { box.innerHTML = '<div class="card">还没有组员数据</div>'; return; }
    box.innerHTML =
      '<div class="card"><h2>我的学情 <span class="tag">' + esc(who.name) + '</span></h2>' +
        '<div class="stat-grid">' +
          '<div class="stat"><b>' + (who.score || 0) + '</b><span>我的积分</span></div>' +
          '<div class="stat"><b>' + (who.attempts || 0) + '</b><span>作答题数</span></div>' +
          '<div class="stat"><b>' + (who.correct || 0) + '</b><span>答对题数</span></div>' +
          '<div class="stat"><b>' + (who.creditRate || 0) + '%</b><span>加权得分率</span></div>' +
        '</div>' +
        '<div class="muted" style="margin-top:8px">综合评定：<b>' + esc(who.level || '—') + '</b>' +
          (who.weakTiers && who.weakTiers.length ? '　薄弱题型：<b>' + esc(who.weakTiers.join('、')) + '</b>' : '') +
        '</div>' +
      '</div>' +
      '<div class="card"><h2>本题之前的动态</h2><div class="feed">' +
        ((meta().feed || []).filter(function (f) { return f.teamId === teamId; }).slice(0, 12).map(function (f) {
          return '<div class="f">' + clock(f.at) + '　' + esc(f.text || '') +
            (f.points ? '　<b>' + (f.points > 0 ? '+' : '') + f.points + '</b>' : '') + '</div>';
        }).join('') || '<div class="muted">暂无记录</div>') +
      '</div></div>';
  }

  function renderBoardList() {
    var box = $('boardPane');
    var sorted = students().slice().sort(function (a, b) { return (b.score || 0) - (a.score || 0); });
    box.innerHTML =
      '<div class="card"><h2>个人榜 <span class="muted">（前 20）</span></h2><div class="list">' +
        (sorted.slice(0, 20).map(function (s, i) {
          return '<div class="item ' + (s.teamId === teamId ? 'me' : '') + '" style="border-left-color:' + esc(s.color || '#4a5fc1') + '">' +
            '<span class="rk">' + (i + 1) + '</span>' +
            '<span class="nm">' + esc(s.name) + '<span class="sub">' + esc(s.teamName) + '</span></span>' +
            '<span class="sc">' + (s.score || 0) + '</span></div>';
        }).join('') || '<div class="muted">暂无数据</div>') +
      '</div></div>' +
      '<div class="card"><h2>小组榜</h2><div class="list">' +
        teams().slice().sort(function (a, b) { return (b.score || 0) - (a.score || 0); }).map(function (t, i) {
          return '<div class="item ' + (t.id === teamId ? 'me' : '') + '" style="border-left-color:' + esc(t.color || '#4a5fc1') + '">' +
            '<span class="rk">' + (i + 1) + '</span>' +
            '<span class="nm">' + esc((t.icon || '') + ' ' + t.name) +
              '<span class="sub">' + (t.memberCount || 0) + ' 人 · 人均 ' + (t.avg || 0) + '</span></span>' +
            '<span class="sc">' + (t.score || 0) + '</span></div>';
        }).join('') +
      '</div></div>';
  }

  /** 展示模式：小组公屏 */
  function renderBoard() {
    var t = myTeam();
    var sorted = teams().slice().sort(function (a, b) { return (b.score || 0) - (a.score || 0); });
    var rank = 1;
    sorted.forEach(function (x, i) { if (x.id === teamId) rank = i + 1; });
    var q = question();

    setHTML('mainScreen',
      '<div class="board-hero">' +
        '<div class="tname">' + esc(t ? ((t.icon || '') + ' ' + t.name) : '未入座') + '</div>' +
        '<div class="tscore">' + (t ? (t.score || 0) : '—') + '</div>' +
        '<div class="trank">第 ' + rank + ' 名 / ' + sorted.length + ' 组　·　加权得分率 ' + (t ? (t.creditRate || 0) : 0) + '%</div>' +
      '</div>' +
      (q ? '<div class="card"><div class="q-head"><span class="tag">' + esc(q.tierLabel) + '</span>' +
        (accepting() ? '<span class="tag ok">正在作答</span>' : '<span class="tag warn">未开放作答</span>') + '</div>' +
        '<div class="q-stem">' + esc(q.fullStem || q.stem) + '</div>' +
        (q.imageUrl ? '<img class="q-image" src="' + esc(q.imageUrl) + '" alt="题目配图">' : '') + '</div>' : '') +
      '<div class="card"><h2>组员</h2><div class="list">' +
        myMembers().slice().sort(function (a, b) { return (b.score || 0) - (a.score || 0); }).map(function (s) {
          return '<div class="item"><span class="nm">' + esc(s.name) + '</span><span class="sc">' + (s.score || 0) + '</span></div>';
        }).join('') +
      '</div></div>');
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
