/*!
 * tests/shot-stage.js — 大屏四个课堂环节逐屏截图（并顺带验证环节切换真的同步到大屏）
 *   node tests/shot-stage.js [base]
 *
 * 做法：同时打开教师端（控制环节）与大屏（展示），由脚本切环节 → 等大屏收到快照 → 截图。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const BASE = process.argv[2] || ('http://127.0.0.1:' + (process.env.PORT || 8080) + '/next');
const OUT = path.join(ROOT, 'docs', 'screenshots-next');
const CDP_PORT = 9477;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findBrowser() {
  const c = [process.env.CHROME_PATH || '',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].filter(Boolean);
  for (const p of c) if (fs.existsSync(p)) return p;
  throw new Error('未找到 Chrome/Edge');
}
async function waitJson(url, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.ok) return await r.json(); } catch (e) { /* */ }
    await sleep(300);
  }
  throw new Error('CDP 未就绪');
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.errors = []; }
  static async connect(url) {
    const ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
    await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
    const c = new CDP(ws);
    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.id && c.pending.has(m.id)) {
        const p = c.pending.get(m.id); c.pending.delete(m.id);
        m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
      } else if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        c.errors.push('EXCEPTION ' + ((d.exception && d.exception.description) || d.text));
      } else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
        c.errors.push('CONSOLE ' + m.params.entry.text);
      }
    });
    return c;
  }
  send(method, params, sid, timeout) {
    const id = ++this.id;
    const payload = { id, method, params: params || {} };
    if (sid) payload.sessionId = sid;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('超时 ' + method)); } }, timeout || 15000);
    });
  }
  async newPage(url, w, h) {
    const t = await this.send('Target.createTarget', { url: 'about:blank' });
    const a = await this.send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
    const sid = a.sessionId;
    await this.send('Runtime.enable', {}, sid);
    await this.send('Log.enable', {}, sid);
    await this.send('Page.enable', {}, sid);
    await this.send('Emulation.setDeviceMetricsOverride', { width: w || 1440, height: h || 900, deviceScaleFactor: 1, mobile: false }, sid);
    await this.send('Page.navigate', { url }, sid);
    return sid;
  }
  async eval(sid, expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true }, sid);
    if (r.exceptionDetails) throw new Error('页面异常：' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
    return r.result ? r.result.value : undefined;
  }
  async waitFor(sid, expr, label, ms) {
    const end = Date.now() + (ms || 12000);
    for (;;) {
      let v = false;
      try { v = await this.eval(sid, expr); } catch (e) { v = false; }
      if (v) return true;
      if (Date.now() > end) throw new Error('等待超时：' + (label || expr));
      await sleep(200);
    }
  }
  async shot(sid, file) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' }, sid, 30000);
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    console.log('  📷 ' + path.relative(ROOT, file) + '  (' + Math.round(fs.statSync(file).size / 1024) + ' KB)');
  }
}

(async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const profile = path.join(os.tmpdir(), 'ci-stage-profile-' + Date.now());
  fs.mkdirSync(profile, { recursive: true });
  const chrome = spawn(findBrowser(), [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--window-size=1600,900',
    '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + profile, 'about:blank'
  ], { stdio: 'ignore', detached: true });
  const cleanup = () => {
    try { spawnSync('taskkill', ['/pid', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) { /* */ }
    try { spawnSync(process.execPath, ['-e', 'setTimeout(function(){},1200)'], { stdio: 'ignore' }); } catch (e) { /* */ }
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 }); } catch (e) { /* */ }
  };
  process.on('exit', cleanup);

  const v = await waitJson('http://127.0.0.1:' + CDP_PORT + '/json/version');
  console.log('浏览器：' + v.Browser);
  const cdp = await CDP.connect(v.webSocketDebuggerUrl);

  // 教师端（控制环节）：先灌数据
  const teacher = await cdp.newPage(BASE + '/admin.html#/classroom', 1440, 940);
  await cdp.waitFor(teacher, '!!(window.CI && CI.store)', '教师端领域层');
  await cdp.eval(teacher, `(function(){
    var S = CI.store;
    S.replaceState(S.defaultState());
    S.updateSettings({ courseName: '24机械高考公开课' });
    var teams = S.get().teams;
    S.addStudentsBulk('张三 李四 王五', teams[0].id);
    S.addStudentsBulk('赵六 钱七 孙八', teams[1].id);
    S.addQuestion({ stem: '集合 {1,2,3} 的子集个数是？', tier: 'basic', answer: 'B', options: ['6','8','9'], tags: ['集合与逻辑'] });
    S.addQuestion({ stem: '函数 f(x)=x³-3x 的极小值点', tier: 'advanced', answer: 'x=1' });
    S.addQuestion({ stem: '请说明你的解题思路', tier: 'improve', answer: '' });
    S.addQuestion({ stem: '等差数列通项公式', tier: 'basic', answer: 'an=a1+(n-1)d' });
    var qs = S.get().bank.map(function(q){ return q.id; });
    var qz = S.createQuiz('第 1 次随堂测', qs.slice(0,4), '');
    S.setCurrentQuiz(qz.id);
    var stu = S.get().students;
    var KEY = ['basic','advanced','extended','improve'];
    KEY.forEach(function(k){ S.recordResult({ sid: stu[0].id, tier: k, result: 'correct' }); S.recordResult({ sid: stu[0].id, tier: k, result: 'correct' }); });
    ['basic','advanced'].forEach(function(k){ S.recordResult({ sid: stu[1].id, tier: k, result: 'correct' }); });
    ['extended','improve'].forEach(function(k){ S.recordResult({ sid: stu[1].id, tier: k, result: 'wrong' }); });
    KEY.forEach(function(k){ S.recordResult({ sid: stu[2].id, tier: k, result: (k === 'basic' ? 'correct' : 'half') }); });
    S.recordResult({ sid: stu[3].id, tier: 'basic', result: 'correct' });
    S.recordResult({ sid: stu[4].id, tier: 'advanced', result: 'correct' });
    CI.sync.push(true);
    return true;
  })()`);
  await sleep(600);

  // 大屏（展示）
  const stage = await cdp.newPage(BASE + '/stage?room=default', 1600, 900);
  await cdp.waitFor(stage, 'document.querySelector(".stage") !== null', '大屏渲染');
  await cdp.waitFor(stage, '!!document.querySelector(".bar")', '大屏外壳');
  await sleep(1500);

  const steps = [
    ['idle', '18-大屏-待机（扫码入座）'],
    ['rollcall', '19-大屏-随机点名'],
    ['question', '20-大屏-出题答题'],
    ['review', '21-大屏-点评（能力雷达）']
  ];
  for (const [phase, name] of steps) {
    const snap = await cdp.eval(teacher, `(function(){
      if (${JSON.stringify(phase)} === 'rollcall') { var r = CI.rollcall.pick(CI.store.get(), {}); if (r) CI.rollcall.applyPick(r); }
      CI.classroom.setPhase(${JSON.stringify(phase)});
      CI.sync.push(true);
      var s = CI.sync.snapshot();
      var st = CI.store.get();
      return JSON.stringify({
        phase: CI.classroom.phase(st),
        qid: st.runtime.qid,
        bankCount: st.bank.length,
        hasQid: st.bank.some(function (q) { return q.id === st.runtime.qid; }),
        byId: !!CI.store.question(st, st.runtime.qid),
        quizIds: (st.quizzes.find(function (z) { return z.id === st.runtime.quizId; }) || {}).questionIds,
        snapshotQuestion: s.question ? s.question.stem.slice(0, 14) : null
      });
    })()`);
    console.log('  教师端快照：' + snap);
    await sleep(1600);
    const shown = await cdp.eval(stage, '(function(){ var m = document.querySelector(".phase-pill"); return m ? m.textContent : "（未连接）"; })()');
    console.log('  环节 ' + phase.padEnd(9) + '→ 大屏显示：' + shown);
    await cdp.shot(stage, path.join(OUT, name + '.png'));
  }

  const errors = cdp.errors.filter((e) => !/favicon|ERR_UNSAFE_PORT/.test(e));
  console.log('\n页面错误：' + (errors.length ? errors.length + ' 条' : '无'));
  errors.slice(0, 6).forEach((e) => console.log('  · ' + e.slice(0, 160)));
  cdp.ws.close();
  cleanup();
  process.exit(errors.length ? 1 : 0);
})().catch((e) => {
  console.error('❌ 大屏截图失败：' + (e && e.stack ? e.stack.split('\n').slice(0, 5).join('\n') : e));
  process.exit(1);
});
