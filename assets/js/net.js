/*!
 * net.js — 组网（EasyTier）前端模块
 *
 *  桌面客户端（Tauri）里：调用 Rust 命令真正启停 easytier-core，并读取 easytier-cli 状态。
 *  浏览器里：不能起进程，但**照样能预览将要执行的完整命令**并复制，方便排障与"手动组网"，
 *            同时给出在客户端/官方 App 中组网的引导。
 *
 *  配置持久化在 localStorage['ci_net_cfg']，换页/重启不用重填。
 */
(function (root) {
  'use strict';

  var CI = root.CI = root.CI || {};
  var LS_CFG = 'ci_net_cfg';

  var DEFAULTS = {
    network_name: 'classroom-points',
    network_secret: '',
    virtual_ip: '',
    peers: ['tcp://public.easytier.cn:11010'],
    listen_port: '',
    config_server: '',
    username: '',
    no_tun: false
  };

  var runtime = { running: false, peers: '', routes: '', node: '', lastArgs: [], error: '', busy: false };
  /** 最近一次 /health 返回（自检时顺便拿到端口与房间，用于交叉核对学生端地址） */
  var netInfo = null;

  function cfg() {
    var saved = {};
    try { saved = JSON.parse(root.localStorage.getItem(LS_CFG) || '{}') || {}; } catch (e) { saved = {}; }
    var out = Object.assign({}, DEFAULTS, saved);
    if (!Array.isArray(out.peers)) out.peers = [String(out.peers || '')];
    return out;
  }

  function saveCfg(patch) {
    var next = Object.assign(cfg(), patch || {});
    try { root.localStorage.setItem(LS_CFG, JSON.stringify(next)); } catch (e) { /* 忽略 */ }
    return next;
  }

  function inClient() { return !!(CI.storage && CI.storage.inTauri && CI.storage.inTauri()); }

  /** 与 apps/teacher/src-tauri/src/net.rs 的 build_args 一一对应（改一处必须同步另一处） */
  function buildArgs(c) {
    c = c || cfg();
    var args = [];
    if (c.virtual_ip && String(c.virtual_ip).trim()) { args.push('-i'); args.push(String(c.virtual_ip).trim()); }
    else args.push('-d');

    args.push('--network-name'); args.push(c.network_name);
    args.push('--network-secret'); args.push(c.network_secret);

    (c.peers || []).forEach(function (p) {
      if (p && String(p).trim()) { args.push('-p'); args.push(String(p).trim()); }
    });
    if (c.listen_port) { args.push('-l'); args.push(String(c.listen_port)); }

    if (c.config_server && String(c.config_server).trim()) { args.push('--config-server'); args.push(String(c.config_server).trim()); }
    else if (c.username && String(c.username).trim()) { args.push('-w'); args.push(String(c.username).trim()); }

    if (c.no_tun) args.push('--no-tun');
    return args;
  }

  function cmdline(c) {
    return 'easytier-core ' + buildArgs(c).map(function (a) {
      return /\s/.test(a) ? '"' + a + '"' : a;
    }).join(' ');
  }

  /* ------------------------------------------------------------------ *
   * 客户端内：真正启停
   * ------------------------------------------------------------------ */

  function start() {
    var c = cfg();
    if (!c.network_name) { alert('请先填写网络名'); return Promise.resolve(null); }
    if (!inClient()) {
      alert('浏览器里不能直接组建虚拟网。\n\n' +
        '① 桌面客户端：安装后在本页一键组网；\n' +
        '② 现在就想用：把下面的命令复制到终端执行（需管理员/root）：\n\n' + cmdline(c));
      return Promise.resolve(null);
    }
    runtime.busy = true;
    render();
    return CI.storage.invoke('net_start', { cfg: c }).then(function (res) {
      runtime.busy = false;
      runtime.running = !!(res && res.ok);
      runtime.lastArgs = (res && res.args) || buildArgs(c);
      runtime.error = '';
      refresh();
      render();
      return res;
    }).catch(function (e) {
      runtime.busy = false;
      runtime.error = (e && e.message) || String(e);
      render();
      return null;
    });
  }

  function stop() {
    if (!inClient()) { alert('浏览器里没有可停止的 EasyTier 进程'); return Promise.resolve(null); }
    return CI.storage.invoke('net_stop', {}).then(function (res) {
      runtime.running = false;
      runtime.peers = runtime.routes = runtime.node = '';
      render();
      return res;
    }).catch(function () { return null; });
  }

  function refresh() {
    if (!inClient()) return Promise.resolve(null);
    return CI.storage.invoke('net_status', {}).then(function (res) {
      if (res) {
        runtime.running = !!res.running;
        runtime.peers = res.peers || '';
        runtime.routes = res.routes || '';
        runtime.node = res.node || '';
      }
      render();
      return res;
    }).catch(function (e) {
      runtime.error = (e && e.message) || String(e);
      render();
      return null;
    });
  }

  /* ------------------------------------------------------------------ *
   * 界面
   * ------------------------------------------------------------------ */

  function esc(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function field(id, label, value, placeholder) {
    return '<label class="fld"><span>' + label + '</span>' +
      '<input id="' + id + '" value="' + esc(value) + '" placeholder="' + esc(placeholder || '') + '"></label>';
  }

  function readForm() {
    var g = function (id) { var e = root.document.getElementById(id); return e ? e.value : ''; };
    var peers = g('netPeers').split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
    return saveCfg({
      network_name: g('netName').trim(),
      network_secret: g('netSecret'),
      virtual_ip: g('netVip').trim(),
      peers: peers,
      listen_port: g('netPort').trim(),
      config_server: g('netServer').trim(),
      username: g('netUser').trim(),
      no_tun: !!(root.document.getElementById('netNoTun') || {}).checked
    });
  }

  function render() {
    var box = root.document.getElementById('classNet');
    if (!box) return;
    var c = cfg();
    var args = buildArgs(c);
    var statusText = inClient()
      ? (runtime.running ? '已启动' : '未启动') + (runtime.error ? '（最近错误：' + esc(runtime.error) + '）' : '')
      : '浏览器模式：只能预览命令，实际组网请在桌面客户端或终端执行';

    box.innerHTML =
      '<div class="panel-head">组网（EasyTier）' +
        '<span class="hint-inline">内网直连不够时用它跨网络：教师机与手机加入同一虚拟网</span></div>' +
      '<div class="net-status chip ' + (runtime.running ? 'chip-ok' : 'chip-warn') + '">' + statusText + '</div>' +
      '<div class="fld-row">' +
        field('netName', '网络名（所有设备一致）', c.network_name, 'classroom-points') +
        field('netSecret', '网络密钥', c.network_secret, '建议每位老师自定') +
      '</div>' +
      '<div class="fld-row">' +
        field('netVip', '本机虚拟 IP（留空 = 自动分配）', c.virtual_ip, '10.144.144.1') +
        field('netPort', '监听端口（多开时区分）', c.listen_port, '11010') +
      '</div>' +
      '<label class="fld"><span>共享节点 / 对端地址（每行一个，可多个容灾）</span>' +
        '<textarea id="netPeers" rows="2" placeholder="tcp://public.easytier.cn:11010">' + esc((c.peers || []).join('\n')) + '</textarea></label>' +
      '<div class="fld-row">' +
        field('netServer', '配置服务器（第三方/自建，可空）', c.config_server, 'https://easytier.example.com') +
        field('netUser', '或 Web 控制台用户名', c.username, 'teacher01') +
      '</div>' +
      '<label class="chk"><input type="checkbox" id="netNoTun"' + (c.no_tun ? ' checked' : '') + '> ' +
        '无 TUN 模式（免管理员/免 root，仅代理流量）</label>' +
      '<div class="net-ops">' +
        '<button class="btn btn-plus" onclick="CI.net.start()">' + (runtime.running ? '重启组网' : '一键组网') + '</button>' +
        '<button class="btn" onclick="CI.net.stop()">停止组网</button>' +
        '<button class="btn" onclick="CI.net.refresh()">刷新状态</button>' +
        '<button class="btn" onclick="CI.net.copyCmd()">复制命令</button>' +
        '<button class="btn" onclick="CI.net.selfCheck()">上课前自检</button>' +
      '</div>' +
      checkHTML() +
      '<div class="net-args"><b>将执行的命令</b>（浏览器里可手动执行，需管理员/root）：<code id="netCmd">' + esc(cmdline(c)) + '</code></div>' +
      (runtime.peers || runtime.routes || runtime.node
        ? '<pre class="net-out">' + esc([runtime.node, runtime.peers, runtime.routes].filter(Boolean).join('\n---\n')) + '</pre>'
        : '') +
      '<div class="hint-inline">说明：官方 Android 只有 GUI 版、没有 CLI，手机端无法内置；' +
        '学生请先在同一局域网直连，或用 EasyTier 官方 App 加入本网络后，' +
        '在小组端填写教师机的虚拟 IP（形如 <code>10.144.144.1:8080</code>）。</div>';
  }

  function copyCmd() {
    var text = cmdline(readForm());
    var done = function () { if (root.CI.toast) root.CI.toast('命令已复制'); else alert(text); };
    if (root.navigator && root.navigator.clipboard) root.navigator.clipboard.writeText(text).then(done, function () { alert(text); });
    else alert(text);
  }

  /** 学生端组网引导文本（Android 客户端复用） */
  function guidance(host) {
    return [
      '① 首选：手机与教师机连同一个 WiFi（局域网直连，零配置）。',
      '② 跨网络：手机上安装 EasyTier 官方 App，加入教师机所在的网络（网络名/密钥问老师），',
      '   然后在小组端把地址填成教师机的虚拟 IP，例如 ' + (host || '10.144.144.1:8080') + '。',
      '③ 家校/校外：教师机若开了共享节点或配置服务器，学生端同样只需填虚拟 IP。'
    ].join('\n');
  }

  /* ------------------------------------------------------------------ *
   * 上课前自检：把"能不能上课"这件事逐条查清楚
   * ------------------------------------------------------------------ */

  var check = { items: [], at: 0, running: false };

  function addItem(name, pass, detail) {
    check.items.push({ name: name, pass: !!pass, detail: detail || '' });
  }

  function isPrivate(ip) {
    return /^192\.168\./.test(ip) || /^10\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
  }

  /**
   * 逐条自检：
   *   ① 存储后端是否落库  ② 枢纽 /health 是否可达  ③ 学生端地址是否为可用的局域网/组网 IP
   *   ④ 学生端地址端口是否与枢纽一致  ⑤ 客户端内额外查 EasyTier 进程
   */
  function selfCheck() {
    check = { items: [], at: 0, running: true };
    render();

    var tasks = [];

    // ① 存储
    var backend = CI.storage && CI.storage.describe ? CI.storage.describe() : '未知';
    addItem('数据存储', !!(CI.storage && CI.storage.isSqlite && CI.storage.isSqlite()), backend);

    // ② 枢纽 /health
    var base = (CI.storage && CI.storage.base) ? CI.storage.base() : '';
    var healthURL = (base || '') + '/health';
    if (root.fetch) {
      tasks.push(root.fetch(healthURL, { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); })
        .then(function (info) {
          addItem('教师机枢纽', !!info.ok, '房间 ' + ((info.rooms || []).join('、') || '暂无') +
            '· 存储 ' + (info.storage || '?') + '· 二维码 ' + (info.qrcode ? '可用' : '不可用（未装 qrcode）'));
          netInfo = info;
        })
        .catch(function (e) {
          addItem('教师机枢纽', false, '连不上 ' + healthURL + '（' + ((e && e.message) || e) + '）——' +
            '浏览器里请先 npm start；客户端里应显示内置枢纽状态');
        }));
    } else {
      addItem('教师机枢纽', false, '当前环境不支持网络请求');
    }

    // ③④ 学生端地址
    var url = CI.sync && CI.sync.joinURL ? CI.sync.joinURL() : '';
    if (!url) {
      addItem('学生端地址', false, '拿不到地址：' + (CI.sync && CI.sync.sameOrigin && CI.sync.sameOrigin()
        ? '请确认枢纽在运行' : '当前是单机模式（未连接枢纽）'));
    } else {
      var m = url.match(/^https?:\/\/([^:/]+)(?::(\d+))?/);
      var host = m ? m[1] : '';
      var port = m && m[2] ? m[2] : '80';
      addItem('学生端地址', isPrivate(host) || host === 'localhost',
        url + (isPrivate(host) ? '' : '　⚠️ 不是常见局域网/组网网段，学生手机可能连不上'));
      addItem('端口一致', !netInfo || String(netInfo.port) === String(port),
        '学生端地址端口 ' + port + (netInfo ? '，枢纽端口 ' + netInfo.port : ''));
    }

    // ⑤ 组网状态（仅客户端）
    if (inClient()) {
      tasks.push(refresh().then(function () {
        addItem('EasyTier 组网', !!runtime.running,
          runtime.running ? '已启动（' + (runtime.lastArgs || []).join(' ') + '）' : '未启动（同一局域网可不用）');
      }));
    } else {
      addItem('EasyTier 组网', true, '浏览器模式：不检测（需要跨网络时在客户端或终端执行上面的命令）');
    }

    return Promise.all(tasks).then(function () {
      check.running = false;
      check.at = Date.now();
      render();
      return check;
    });
  }

  function checkHTML() {
    if (!check.items.length) return '';
    var okCount = check.items.filter(function (i) { return i.pass; }).length;
    var head = check.running ? '自检中…' : (okCount === check.items.length
      ? '✅ 自检通过（' + okCount + '/' + check.items.length + '）'
      : '⚠️ ' + (check.items.length - okCount) + ' 项需要注意（' + okCount + '/' + check.items.length + ' 通过）');
    return '<div class="net-check"><b>' + head + '</b>' +
      '<ul>' + check.items.map(function (i) {
        return '<li class="' + (i.pass ? 'ok' : 'bad') + '">' + (i.pass ? '✅' : '⚠️') + ' ' +
          esc(i.name) + '：' + esc(i.detail) + '</li>';
      }).join('') + '</ul></div>';
  }

  CI.net = {
    render: render, start: start, stop: stop, refresh: refresh, copyCmd: copyCmd, readForm: readForm,
    selfCheck: selfCheck,
    cfg: cfg, saveCfg: saveCfg, buildArgs: buildArgs, cmdline: cmdline, inClient: inClient, guidance: guidance,
    status: function () { return runtime; },
    check: function () { return check; }
  };
})(typeof window !== 'undefined' ? window : globalThis);
