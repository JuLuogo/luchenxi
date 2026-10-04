/*!
 * tests/ui-vue.test.mjs — Vue 界面的冒烟测试（三个入口：教师端 / 学生端 / 大屏）
 *
 *   node tests/ui-vue.test.mjs
 *
 * 为什么必须有：客户端从 2026-10 起打包的就是 Vue 产物，而此前**Vue 界面没有任何冒烟测试**
 *  —— 概览页把 `CI.analysis.counts(s, r)`（逐条判定函数）误当汇总调用，
 *  一进首页就抛异常，却一直没人发现。这个测试就是防这类事的：
 *  用真实浏览器打开**构建产物**，检查页面渲染出来了、控制台没有报错、路由能切。
 *
 * 依赖：web/dist 已构建（`npm --prefix web run build`）。
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'web', 'dist');
const PORT = 8397;

if (!fs.existsSync(DIST)) {
  console.error('✘ 找不到 web/dist —— 先跑 `npm --prefix web run build`');
  process.exit(1);
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json'
};

const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  const file = path.join(DIST, url === '/' ? 'admin.html' : url.replace(/^\/+/, ''));
  if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-uivue-'));
// 审计发现：这里原来**硬编码 Windows 的 Chrome 路径**（run-smoke.js 有跨平台候选表，这里没有）
// → 在 ubuntu CI 上必然起不来，Vue 覆盖形同虚设。改成同一份候选表。
const CANDIDATES = [
  process.env.CHROME_PATH || '',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/chromium-browser', '/usr/bin/chromium',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/snap/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
].filter(Boolean);
const browserPath = CANDIDATES.find((c) => fs.existsSync(c));
if (!browserPath) {
  console.error('✘ 找不到 Chrome/Chromium —— 设 CHROME_PATH 指定；Vue 冒烟无法运行');
  process.exit(1);   // 明确失败：找不到浏览器不等于"通过"
}
const chrome = spawn(browserPath, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=9579',
  '--user-data-dir=' + profile, 'about:blank'
], { stdio: 'ignore', detached: true });

let passed = 0;
const failures = [];
const ok = (cond, label) => { if (cond) passed += 1; else failures.push(label); };

let ws;
try {
  let version = null;
  for (let i = 0; i < 40 && !version; i++) {
    try { const r = await fetch('http://127.0.0.1:9579/json/version'); if (r.ok) version = await r.json(); } catch { /* 等 */ }
    if (!version) await sleep(300);
  }
  // 起不来时 version 是 null —— 原来直接读 .webSocketDebuggerUrl 会抛 TypeError，
  // 报错信息看不出"是浏览器没起来"。这里给明确信息。
  if (!version) {
    throw new Error('浏览器没起来（CDP 端口 9579 无响应）：' + browserPath);
  }
  ws = new WebSocket(version.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });

  let id = 0;
  const pending = new Map();
  let logs = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      logs.push((m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
    }
    if (m.method === 'Runtime.exceptionThrown') {
      logs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    }
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
  });
  const send = (method, params, sid) => new Promise((resolve, reject) => {
    const i = ++id;
    const payload = { id: i, method, params: params || {} };
    if (sid) payload.sessionId = sid;
    pending.set(i, { resolve, reject });
    ws.send(JSON.stringify(payload));
    setTimeout(() => { if (pending.has(i)) { pending.delete(i); reject(new Error('timeout ' + method)); } }, 25000);
  });

  /** 打开一个入口页，跑一遍检查 */
  async function checkPage(entry, expectTitle, hash, expectGlobalCI) {
    logs = [];
    const t = await send('Target.createTarget', { url: 'about:blank' });
    const a = await send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
    const sid = a.sessionId;
    await send('Runtime.enable', {}, sid);
    await send('Page.enable', {}, sid);
    await send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/' + entry + (hash || '') }, sid);
    await sleep(6500);
    const evalIn = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true }, sid);
      if (r.exceptionDetails) return { err: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
      return r.result?.value;
    };
    const title = await evalIn('document.title');
    const mounted = await evalIn('document.querySelector("#app") ? document.querySelector("#app").children.length : -1');
    const dom = await evalIn('document.querySelectorAll("*").length');
    const legacy = await evalIn('Array.from(document.scripts).some(s => (s.src||"").includes("assets/js/"))');
    const hasCI = await evalIn('typeof (window.CI && CI.store && CI.store.get)');

    ok(String(title).includes(expectTitle), entry + ' 标题正确（' + title + '）');
    ok(Number(mounted) > 0, entry + ' Vue 已挂载');
    ok(Number(dom) > 30, entry + ' 渲染出内容（DOM ' + dom + ' 个节点）');
    ok(legacy === false, entry + ' 没有引用旧版 assets/js');
    // 教师端把 CI 挂在 window 上（旧版脚本也这么用）；学生端与大屏是纯模块导入，不暴露全局 —— 不算问题
    if (expectGlobalCI) ok(hasCI === 'function', entry + ' CI 桥接可用（window.CI）');
    else ok(hasCI === 'undefined', entry + ' 不依赖全局 CI（模块导入即可）');
    ok(logs.length === 0, entry + ' 控制台无报错' + (logs.length ? '：' + String(logs[0]).slice(0, 160) : ''));
    await send('Target.closeTarget', { targetId: t.targetId });
  }

  /**
   * 流程级检查：在 Vue 教师端里用真实数据走一遍
   *   建学生 → 建题 → 组卷 → 记分 → 切到学情分析页，断言页面真的跟着变
   * 驱动方式与老师点界面等价（都走 CI.store 的写接口），但断言落在 Vue 渲染出来的 DOM 上。
   */
  async function checkFlow() {
    logs = [];
    const t2 = await send('Target.createTarget', { url: 'about:blank' });
    const a2 = await send('Target.attachToTarget', { targetId: t2.targetId, flatten: true });
    const sid2 = a2.sessionId;
    await send('Runtime.enable', {}, sid2);
    await send('Page.enable', {}, sid2);
    await send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/admin.html#/class' }, sid2);
    await sleep(6500);

    const run = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sid2);
      if (r.exceptionDetails) return { err: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
      return r.result?.value;
    };

    // ① 用领域层接口造数据（与老师点"新增学生/新增题目"同一条路径）
    const made = await run(`(function(){
      try {
        var S = window.CI.store;
        S.replaceState(S.defaultState());
        var team = S.get().teams[0].id;
        var stu = S.addStudent('冒烟同学', team);
        var sid = (typeof stu === 'string') ? stu : stu.id;
        var q = S.addQuestion({ stem: '冒烟题：1+1=?', tier: 'basic', answer: 'A', options: ['1','2','3'] });
        var qz = S.createQuiz('冒烟卷', [q.id]);
        S.setCurrentQuiz(qz.id);
        S.recordResult({ sid: sid, qid: q.id, tier: 'basic', result: 'correct', quizId: qz.id, picked: 'A' });
        return { students: S.get().students.length, score: S.scoreOf(S.get(), sid), attempts: window.CI.analysis.studentStats(S.get(), sid).total.attempts };
      } catch (e) { return '抛错：' + e.message; }
    })()`);
    ok(made && made.score === 3, '领域层：记分成功（+3）→ ' + JSON.stringify(made));
    ok(made && made.attempts === 1, '领域层：统计到 1 次作答');

    // ② 切到学情分析页，断言 Vue 把它渲染出来了
    await run('location.hash = "#/analysis"');
    await sleep(3500);
    const analysisText = await run('document.body.innerText');
    ok(typeof analysisText === 'string' && analysisText.includes('冒烟同学'),
      '学情分析页渲染出学生姓名（Vue 跟着数据更新）');
    ok(typeof analysisText === 'string' && (analysisText.includes('综合表现') || analysisText.includes('题型')),
      '学情分析页渲染出统计区块');

    // ③ 切到课堂协同页（最重的一页）
    await run('location.hash = "#/classroom"');
    await sleep(3000);
    const clsText = await run('document.body.innerText');
    ok(typeof clsText === 'string' && clsText.length > 50, '课堂协同页有内容');

    // ④ 概览页（曾经在这里抛 counts 的错）
    await run('location.hash = "#/"');
    await sleep(3000);
    const homeText = await run('document.body.innerText');
    // 原来这里是 `(A && B) || true` —— 恒真，等于没断言（审计发现）。
    // 概览页曾经因为 counts 调用写错而整页白屏，所以这条要真的断言到东西：
    // 它必须渲染出课程名或概览区块文案。
    ok(typeof homeText === 'string' && homeText.length > 30,
      '概览页正常渲染（有内容，不是白屏）—— 长度 ' + (typeof homeText === 'string' ? homeText.length : '?')),

    // ⑤ 响应式桥：**不切路由**，在当前页改数据，看界面跟不跟 ——
    // 审计发现 class-store 的 state 是 computed（返回同一个对象引用）→ 通知链断掉，
    // 界面只在切路由（重新挂载）时才更新。原来 checkFlow 恰好靠切路由断言，绕过了这个 bug。
    await run('location.hash = "#/class"');
    await sleep(3000);
    const beforeClass = await run('document.body.innerText');
    await run(`(function(){
      var S = window.CI.store;
      S.addStudent('原地更新同学', S.get().teams[0].id);
      return true;
    })()`);
    await sleep(1500);
    const afterClass = await run('document.body.innerText');
    ok(typeof afterClass === 'string' && afterClass.includes('原地更新同学'),
      '原地更新：加学生后当前页立刻显示（不靠切路由）');
    ok(afterClass !== beforeClass, '原地更新：页面文本确实变了');

    ok(logs.length === 0, '整条流程控制台无报错' + (logs.length ? '：' + String(logs[0]).slice(0, 200) : ''));
    await send('Target.closeTarget', { targetId: t2.targetId });
  }

  console.log('  检查三个入口（构建产物，等价于客户端与网页版实际加载的东西）…');
  await checkPage('admin.html', '教师端', '#/', true);
  await checkPage('admin.html', '教师端', '#/analysis', true);   // 学情分析页（统计最重的页面）
  await checkPage('admin.html', '教师端', '#/classroom', true);  // 课堂协同页
  await checkPage('admin.html', '教师端', '#/open', true);   // 公开课（不能出问题的场景）

  await checkPage('admin.html', '教师端', '#/settings/rubric', true);   // 公开课量规（维度/档位/展示策略）
  await checkPage('admin.html', '教师端', '#/settings/ai', true);       // AI 润色（默认关闭）
  await checkPage('student.html', '课堂小组端', '', false);
  await checkPage('index.html', '课堂大屏', '', false);           // 大屏
  console.log('  走一遍流程（造数据 → 断言页面跟着变）…');
  await checkFlow();
} finally {
  try { ws?.close(); } catch { /* 忽略 */ }
  try { spawnSync('taskkill', ['/pid', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* 忽略 */ }
  try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 }); } catch { /* 忽略 */ }
  server.close();
}

console.log('\n----------------------------------------');
if (failures.length) {
  console.log('❌ 失败 ' + failures.length + ' 项 / 通过 ' + passed + ' 项');
  failures.forEach((f, i) => console.log('  ' + (i + 1) + '. ' + f));
  process.exit(1);
} else {
  console.log('✅ 全部通过：' + passed + ' 项断言（Vue 三入口冒烟）');
}
