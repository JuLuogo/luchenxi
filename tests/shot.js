/*!
 * tests/shot.js — 用无头浏览器给各页签与打开的大屏页截图（视觉回归/文档配图）
 *   node tests/shot.js                    # 默认截 admin.html 六个页签 + index.html
 *   node tests/shot.js http://host:port/admin.html docs/screenshots
 * 需要先启动服务：$env:PORT=8123; node sync-server.js
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const ADMIN_URL = process.argv[2] || 'http://127.0.0.1:8123/admin.html';
const OUT_DIR = path.resolve(process.argv[3] || path.join(__dirname, '..', 'docs', 'screenshots'));
const ROOM = 'shot';
const PORT = 9555;

const CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 在页面里注入一套演示数据（只影响该无头浏览器会话的 localStorage） */
const SEED = `
(function () {
  var CI = window.CI, S = CI.store;
  S.replaceState(S.defaultState());
  var st = S.get();
  S.updateSettings({ courseName: '24机械高考公开课 · 数学' });
  var t1 = st.teams[0].id, t2 = st.teams[1].id;
  S.addStudentsBulk('张伟 李娜 王强 刘洋 陈静', t1);
  S.addStudentsBulk('赵磊 孙悦 周涛 吴迪 郑爽', t2);
  var students = S.get().students;
  var bank = [
    ['basic',    '已知集合 A={1,2,3}，则 A 的子集个数为？', '8', ['集合与逻辑']],
    ['basic',    '函数 y=x²-2x+3 的对称轴方程是？', 'x=1', ['函数与导数']],
    ['advanced', '求函数 f(x)=x³-3x 在区间 [-2,2] 上的最大值与最小值。', 'max=2，min=-2', ['函数与导数']],
    ['advanced', '已知 sinα+cosα=1/5，α∈(0,π)，求 tanα。', '-4/3', ['三角函数']],
    ['extended', '某工厂要建造一个容积为 8m³ 的无盖长方体水池，求用料最省时的底面边长。', '2m', ['立体几何']],
    ['improve',  '设数列 {aₙ} 满足 a₁=1，aₙ₊₁=2aₙ+1，求通项公式并证明。', 'aₙ=2ⁿ-1', ['数列']]
  ].map(function (q) { return S.addQuestion({ stem: q[1], tier: q[0], answer: q[2], tags: q[3], source: '校本练习' }); });

  var quiz = S.createQuiz('第 3 次课 · 函数与集合随堂测', [bank[0].id, bank[1].id, bank[2].id, bank[3].id], '重点讲评拔高题');
  function rec(sid, q, result, src) {
    S.recordResult({ sid: sid, qid: q.id, result: result, quizId: quiz.id, source: src || 'rollcall' });
  }
  rec(students[0].id, bank[0], 'correct'); rec(students[0].id, bank[1], 'correct');
  rec(students[0].id, bank[2], 'half');    rec(students[0].id, bank[3], 'wrong');
  rec(students[1].id, bank[0], 'correct'); rec(students[1].id, bank[2], 'wrong');
  rec(students[2].id, bank[0], 'correct'); rec(students[2].id, bank[1], 'half'); rec(students[2].id, bank[2], 'correct');
  rec(students[5].id, bank[0], 'correct'); rec(students[5].id, bank[2], 'correct'); rec(students[5].id, bank[3], 'half');
  rec(students[6].id, bank[1], 'wrong');   rec(students[6].id, bank[0], 'correct');
  rec(students[8].id, bank[0], 'correct'); rec(students[8].id, bank[1], 'correct'); rec(students[8].id, bank[2], 'half');
  S.recordResult({ sid: students[3].id, tier: 'basic', result: 'correct', source: 'quick', quizId: quiz.id });
  S.addManual(students[4].id, 2, '课堂纪律加分');

  var rolled = CI.rollcall.applyPick(CI.rollcall.pick(S.get(), { scope: 'all', recentExclude: 0 }));
  S.setRuntime({ quizId: quiz.id, qid: bank[2].id, sid: rolled.sid });
  CI.admin.renderAll();
  return 'seeded';
})()
`;

(async function main() {
  const bin = CANDIDATES.find((p) => fs.existsSync(p));
  if (!bin) throw new Error('未找到 Chrome/Edge');
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const profile = path.join(os.tmpdir(), 'ci-shot-' + Date.now());
  fs.mkdirSync(profile, { recursive: true });
  const child = spawn(bin, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars', '--force-device-scale-factor=1',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile, 'about:blank'
  ], { stdio: 'ignore', detached: true });

  const watchdog = setTimeout(() => { console.error('总超时'); process.exit(3); }, 180000);

  try {
    let list = null;
    for (let i = 0; i < 40 && !list; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
        if (res.ok) list = await res.json();
      } catch (e) { await sleep(400); }
    }
    const page = list.find((t) => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });

    let id = 0;
    const pending = new Map();
    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
      else if (m.method === 'Page.javascriptDialogOpening') {
        send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
      }
    });
    function send(method, params = {}, timeout = 15000) {
      const myId = ++id;
      return new Promise((resolve, reject) => {
        pending.set(myId, resolve);
        ws.send(JSON.stringify({ id: myId, method, params }));
        setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); reject(new Error('超时: ' + method)); } }, timeout);
      });
    }
    async function evaluate(expr) {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.result && r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.text);
      return r.result && r.result.result ? r.result.result.value : undefined;
    }
    async function shot(name, fullPage) {
      const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: !!fullPage }, 30000);
      const file = path.join(OUT_DIR, name + '.png');
      fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'));
      const kb = Math.round(fs.statSync(file).size / 1024);
      console.log('  ✔ ' + path.basename(file) + '  (' + kb + ' KB)');
    }

    await send('Runtime.enable');
    await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false });

    /* ---- 主控台各页签 ---- */
    await send('Page.navigate', { url: ADMIN_URL });
    await sleep(3500);
    await evaluate("window.alert=function(){};window.confirm=function(){return true};window.prompt=function(m,d){return d===undefined?'截图演示':d};");
    // 让主控台把快照推给本机服务端，这样大屏页与学生端能取到同一份数据
    console.log('同步地址 ->', await evaluate("(function(){var h=location.host;localStorage.setItem('ci_ws_host',h);localStorage.setItem('ci_room','" + ROOM + "');CI.sync.setRoom('" + ROOM + "');CI.sync.setHost(h);return h+' / 房间 " + ROOM + "';})()"));
    console.log('注入演示数据…', await evaluate(SEED));
    await sleep(1200);
    // 记录第一支队伍 id，供学生端截图带参进入
    try {
      const teamId = await evaluate("CI.store.get().teams[0].id");
      fs.writeFileSync(path.join(OUT_DIR, '.teamid'), String(teamId || ''));
      // 打开作答，让学生端截图能看到选项
      await evaluate("CI.store.setRuntime({accepting:true}); CI.admin.renderAll();");
    } catch (e) { /* 忽略 */ }

    const tabs = [
      ['tab-class', '01-班级与积分'],
      ['tab-quiz', '02-组卷与答题'],
      ['tab-roll', '03-点名'],
      ['tab-bank', '04-题库与题型'],
      ['tab-analysis', '05-学情分析'],
      ['tab-board', '06-排行与数据'],
      ['tab-classroom', '10-课堂协同']
    ];
    for (const [tabId, name] of tabs) {
      await evaluate(`CI.admin.gotoTab('${tabId}')`);
      await sleep(700);
      await shot(name, true);
    }

    /* ---- 个人学情报告弹窗 ---- */
    await evaluate("CI.admin.gotoTab('tab-analysis'); CI.analysisUI.generate();");
    await sleep(700);
    await shot('07-学情总结与报告', true);
    await evaluate("CI.analysisUI.showStudentReport(CI.store.get().students[0].id)");
    await sleep(500);
    await shot('08-个人学情报告');
    await evaluate('CI.analysisUI.closeReport()');

    /* ---- 大屏页：直接连本机服务端，读取主控台推送过的快照 ---- */
    const origin = ADMIN_URL.replace(/admin\.html.*$/, '');
    await send('Page.navigate', { url: origin + 'index.html?ws=' + origin.replace(/^https?:\/\//, '').replace(/\/$/, '') });
    await sleep(4000);
    await shot('09-教室大屏', false);

    /* ---- 学生端（小组答题 + 小组公屏）：枢纽已缓存教师端推送的课堂数据 ---- */
    await send('Emulation.setDeviceMetricsOverride', { width: 430, height: 932, deviceScaleFactor: 1, mobile: true });
    const teamId = fs.existsSync(path.join(OUT_DIR, '.teamid')) ? fs.readFileSync(path.join(OUT_DIR, '.teamid'), 'utf8').trim() : '';
    const studentURL = origin + 'student.html?room=' + ROOM + (teamId ? ('&team=' + teamId) : '');
    await send('Page.navigate', { url: studentURL });
    await sleep(3500);
    await shot('11-学生端答题', false);
    await send('Page.navigate', { url: studentURL + '&view=board' });
    await sleep(3000);
    await shot('12-学生端小组公屏', false);

    console.log('\n截图已输出到：' + OUT_DIR);
  } catch (e) {
    console.error('截图失败：', e.message);
    process.exitCode = 1;
  } finally {
    clearTimeout(watchdog);
    try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { try { child.kill(); } catch (e2) {} }
    await sleep(400);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
    process.exit(process.exitCode || 0);
  }
})();
