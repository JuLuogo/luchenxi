/*!
 * tests/_shot-next.js — 给新版（Vue）界面截图并顺带自检：有没有报错、路由是否可达
 *   node tests/_shot-next.js [base]
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
// 默认跟着枢纽的默认端口（8080）；也可用参数或 PORT 环境变量覆盖
// 2026-10：界面已统一到 Vue，主路径（/、/join、/stage）就是新界面，/next 只是兼容别名
const BASE = process.argv[2] || ('http://127.0.0.1:' + (process.env.PORT || 8080));
const OUT = path.join(ROOT, 'docs', 'screenshots-next');
const CDP_PORT = 9455;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findBrowser() {
  const c = [
    process.env.CHROME_PATH || '',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
  ].filter(Boolean);
  for (const p of c) if (fs.existsSync(p)) return p;
  throw new Error('未找到 Chrome/Edge');
}

async function waitJson(url, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.ok) return await r.json(); } catch (e) { /* 等 */ }
    await sleep(300);
  }
  throw new Error('CDP 未就绪：' + url);
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.errors = []; }
  static async connect(url) {
    const ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
    await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
    const c = new CDP(ws);
    ws.on('message', (raw) => {
      let m = null; try { m = JSON.parse(raw); } catch (e) { return; }
      if (m.id && c.pending.has(m.id)) {
        const { resolve, reject } = c.pending.get(m.id); c.pending.delete(m.id);
        if (m.error) reject(new Error(m.error.message)); else resolve(m.result);
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
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: false }, sid);
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
  const profile = path.join(os.tmpdir(), 'ci-next-profile-' + Date.now());
  fs.mkdirSync(profile, { recursive: true });
  const bin = findBrowser();
  const chrome = spawn(bin, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--window-size=1440,940',
    '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + profile, 'about:blank'
  ], { stdio: 'ignore', detached: true });

  const cleanup = () => {
    try { spawnSync('taskkill', ['/pid', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) { /* 忽略 */ }
    try { spawnSync(process.execPath, ['-e', 'setTimeout(function(){},1200)'], { stdio: 'ignore' }); } catch (e) { /* 忽略 */ }
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 }); } catch (e) { /* 忽略 */ }
  };
  process.on('exit', cleanup);

  const v = await waitJson('http://127.0.0.1:' + CDP_PORT + '/json/version');
  console.log('浏览器：' + v.Browser);
  const cdp = await CDP.connect(v.webSocketDebuggerUrl);

  const page = await cdp.newPage(BASE + '/admin.html#/', 1440, 940);
  await cdp.waitFor(page, 'document.querySelector(".el-menu") !== null', '侧边栏渲染');
  await cdp.waitFor(page, '!!(window.CI && CI.store)', '领域层加载');

  // 关掉可能弹出的「发现远端数据」确认框（截图需要确定性）
  async function dismissDialogs() {
    await cdp.eval(page, `(function(){
      var btns = document.querySelectorAll('.el-message-box__headerbtn, .el-dialog__headerbtn');
      for (var i = 0; i < btns.length; i++) btns[i].click();
      return true;
    })()`).catch(() => {});
    await sleep(200);
  }

  // 灌入演示数据（与 tests/demo.js 同一套口径；额外造出不同"能力画像"以便看雷达）
  await cdp.eval(page, `(function(){
    var S = CI.store;
    S.replaceState(S.defaultState());
    S.updateSettings({ courseName: '24机械高考公开课', className: '24机械', teacher: '陆老师' });
    var teams = S.get().teams;
    S.addStudentsBulk('张三 李四 王五', teams[0].id);
    S.addStudentsBulk('赵六 钱七 孙八', teams[1].id);
    S.addQuestion({ stem: '集合 {1,2,3} 的子集个数是？', tier: 'basic', answer: 'B', options: ['6','8','9'], tags: ['集合与逻辑'] });
    S.addQuestion({ stem: '函数 f(x)=x³-3x 的极小值点', tier: 'advanced', answer: 'x=1', tags: ['函数与导数'] });
    S.addQuestion({ stem: '请说明你的解题思路', tier: 'improve', answer: '', tags: ['综合'] });
    S.addQuestion({ stem: '等差数列通项公式', tier: 'basic', answer: 'an=a1+(n-1)d', tags: ['数列'] });
    S.addQuestion({ stem: '数列极限的ε-N 定义', tier: 'extended', answer: '略', tags: ['数列'] });
    var qs = S.get().bank.map(function(q){ return q.id; });
    var quiz = S.createQuiz('第 1 次随堂测', qs.slice(0,4), '');
    S.setCurrentQuiz(quiz.id);
    var stu = S.get().students;
    var KEY = ['basic','advanced','extended','improve'];
    // 张三：四个题型全对 → 六边形战士
    KEY.forEach(function(k){ S.recordResult({ sid: stu[0].id, tier: k, result: 'correct' }); S.recordResult({ sid: stu[0].id, tier: k, result: 'correct' }); });
    // 李四：基础/拔高对，扩展/提升错 → 偏科尖子
    ['basic','advanced'].forEach(function(k){ S.recordResult({ sid: stu[1].id, tier: k, result: 'correct' }); S.recordResult({ sid: stu[1].id, tier: k, result: 'correct' }); });
    ['extended','improve'].forEach(function(k){ S.recordResult({ sid: stu[1].id, tier: k, result: 'wrong' }); S.recordResult({ sid: stu[1].id, tier: k, result: 'wrong' }); });
    // 王五：半对为主 → 稳步提升
    KEY.forEach(function(k){ S.recordResult({ sid: stu[2].id, tier: k, result: (k==='basic'?'correct':'half') }); S.recordResult({ sid: stu[2].id, tier: k, result: 'half' }); });
    // 赵六：只答了一次 → 样本不足
    S.recordResult({ sid: stu[3].id, tier: 'basic', result: 'correct' });
    return true;
  })()`);
  await sleep(900);

  const shots = [
    ['/', '01-概览'],
    ['/class', '02-班级与积分'],
    ['/bank', '03-题库-题目列表'],
    ['/bank/new', '04-题库-新建题目'],
    ['/bank/import', '05-题库-批量导入'],
    ['/bank/tiers', '06-题库-题型与权重'],
    ['/bank/tags', '07-题库-标签管理'],
    ['/roll', '08-随机点名'],
    ['/classroom', '09-课堂协同'],
    ['/papers', '10-试卷列表'],
    ['/analysis', '11-学情分析'],
    ['/board', '12-排行榜与导出'],
    ['/settings/storage', '13-设置-存储与备份'],
    ['/settings/network', '14-设置-组网'],
    ['/settings/room', '15-设置-房间与大屏']
  ];
  for (const [route, name] of shots) {
    await cdp.eval(page, 'location.hash = "#" + ' + JSON.stringify(route));
    await sleep(650);
    await dismissDialogs();
    const title = await cdp.eval(page, '(document.querySelector(".page-head h2")||{}).textContent || ""');
    console.log('  ' + route.padEnd(20) + '→ ' + title);
    await cdp.shot(page, path.join(OUT, name + '.png'));
  }

  // 找出 404 的具体资源（方便修）
  const missing = await cdp.eval(page, `(performance.getEntriesByType('resource')||[])
    .filter(function(e){ return e.responseStatus >= 400; })
    .map(function(e){ return e.responseStatus + ' ' + e.name; })`);
  if (missing && missing.length) {
    console.log('\n资源加载失败：');
    missing.slice(0, 10).forEach((m) => console.log('  · ' + m));
  }

  // 学生端与大屏（第二批，确认入口可用）
  const stu = await cdp.newPage(BASE + '/join?room=demo', 400, 820);
  await cdp.waitFor(stu, 'document.querySelector(".van-nav-bar") !== null', '学生端渲染');
  await sleep(500);
  await cdp.shot(stu, path.join(OUT, '16-学生端-占位.png'));

  const stage = await cdp.newPage(BASE + '/stage?room=demo', 1440, 900);
  await cdp.waitFor(stage, 'document.querySelector(".stage") !== null', '大屏渲染');
  await sleep(500);
  await cdp.shot(stage, path.join(OUT, '17-大屏-占位.png'));

  const errors = cdp.errors.filter((e) => !/favicon|ERR_UNSAFE_PORT/.test(e));
  console.log('\n页面错误：' + (errors.length ? errors.length + ' 条' : '无'));
  errors.slice(0, 8).forEach((e) => console.log('  · ' + e.slice(0, 160)));
  cdp.ws.close();
  cleanup();
  process.exit(errors.length ? 1 : 0);
})().catch((e) => {
  console.error('❌ 截图失败：' + (e && e.stack ? e.stack.split('\n').slice(0, 5).join('\n') : e));
  process.exit(1);
});
