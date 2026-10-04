/*!
 * tests/run-smoke.js — 用 CDP 驱动无头 Chrome/Edge 执行 tests/smoke.html（真实浏览器端到端测试）
 *   node tests/run-smoke.js [url]
 * 依赖：ws（package.json 已有）。浏览器进程以 stdio:'ignore' 启动，通过 CDP 读取结果，
 *       避免管道输出在受限沙箱下被拒绝。
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const URL_TO_TEST = process.argv[2] || 'http://127.0.0.1:8123/tests/smoke.html';
const PORT = 9333;

const CANDIDATES = [
  process.env.CHROME_PATH || '',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  // Linux / CI（ubuntu：apt 装 chromium-browser 或 chromium，或预装的 google-chrome）
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/snap/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
].filter(Boolean);

function findBrowser() {
  // 1) 显式指定优先
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  // 2) 常见安装路径
  for (const p of CANDIDATES) if (fs.existsSync(p)) return p;
  // 3) PATH 里找（CI 上 apt 安装后通常在这里）
  const names = ['chromium-browser', 'chromium', 'google-chrome', 'google-chrome-stable', 'chrome'];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    for (const n of names) {
      const full = path.join(dir, n);
      try { if (fs.existsSync(full)) return full; } catch (e) { /* 忽略 */ }
    }
  }
  throw new Error('未找到 Chrome/Edge/Chromium 可执行文件；可用 CHROME_PATH 环境变量指定');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch (e) { /* 端口未就绪，继续等 */ }
    await sleep(400);
  }
  // 起不来时把浏览器日志带上：CI 上这是唯一的诊断线索
  throw new Error('CDP 未就绪：' + url + (BROWSER_LOG ? browserLogTail() : ''));
}

/** 浏览器 stderr 的尾部（CDP 失败时附在错误里，便于在 CI 注解里直接看到原因） */
let BROWSER_LOG = '';
function browserLogTail() {
  try {
    if (!BROWSER_LOG || !fs.existsSync(BROWSER_LOG)) return '';
    const txt = fs.readFileSync(BROWSER_LOG, 'utf8').trim();
    if (!txt) return '（浏览器没有任何输出 —— 可能进程根本没起来）';
    return '\n--- 浏览器日志 ---\n' + txt.split(/\r?\n/).slice(-12).join('\n');
  } catch (e) { return ''; }
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.events = []; }
  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
    await new Promise((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });
    const cdp = new CDP(ws);
    ws.on('message', (raw) => {
      let msg = null;
      try { msg = JSON.parse(raw); } catch (e) { return; }
      if (msg.id && cdp.pending.has(msg.id)) {
        const { resolve, reject } = cdp.pending.get(msg.id);
        cdp.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      } else if (msg.method) {
        cdp.events.push(msg);
      }
    });
    return cdp;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP 超时：' + method)); }
      }, 8000);
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: false });
    if (r.exceptionDetails) throw new Error('页面内异常：' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
    return r.result ? r.result.value : undefined;
  }
}

(async function main() {
  const bin = findBrowser();
  const profile = path.join(os.tmpdir(), 'ci-smoke-profile-' + Date.now());
  fs.mkdirSync(profile, { recursive: true });

  // 总看门狗：防止任何环节卡死
  const watchdog = setTimeout(() => {
    console.error('❌ 总超时（150s），强制结束');
    process.exit(3);
  }, 150000);

  // Chrome 的 stderr 收进文件：CDP 起不来时这就是唯一的线索
  //（以前是 stdio:'ignore'，CI 上只看到"CDP 未就绪"，完全猜不出原因）
  const chromeLog = path.join(os.tmpdir(), 'ci-smoke-chrome-' + Date.now() + '.log');
  const logFd = fs.openSync(chromeLog, 'a');
  BROWSER_LOG = chromeLog;

  const child = spawn(bin, [
    '--headless=new',
    '--disable-gpu',
    // CI（容器/受限环境）必需：/dev/shm 太小会让渲染进程直接崩，表现为 CDP 端口永不就绪
    '--disable-dev-shm-usage',
    // 以 root 运行时（部分容器镜像）沙箱会直接拒绝启动
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + profile,
    'about:blank'
  ], { stdio: ['ignore', logFd, logFd], detached: true });

  let exitCode = 1;
  try {
    const version = await getJson(`http://127.0.0.1:${PORT}/json/version`);
    console.log('浏览器：', version.Browser);

    const targets = await getJson(`http://127.0.0.1:${PORT}/json/list`);
    const page = targets.find((t) => t.type === 'page');
    if (!page) throw new Error('未找到页面目标');

    const cdp = await CDP.connect(page.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Page.enable');
    // 安全网：若页面弹出 confirm/alert/prompt，自动接受，避免渲染进程被阻塞
    cdp.ws.on('message', (raw) => {
      let msg = null;
      try { msg = JSON.parse(raw); } catch (e) { return; }
      if (msg.method === 'Page.javascriptDialogOpening') {
        console.log('  （自动处理对话框：' + msg.params.type + ' - ' + msg.params.message + '）');
        cdp.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
      }
    });
    await cdp.send('Page.navigate', { url: URL_TO_TEST });

    let text = '';
    let consecutiveErrors = 0;
    for (let i = 0; i < 60; i++) {
      await sleep(1000);
      try {
        text = await cdp.eval("(document.getElementById('out')||{}).textContent||''");
        consecutiveErrors = 0;
      } catch (e) {
        consecutiveErrors++;
        if (i % 5 === 0) console.log('  轮询 ' + i + ' 次：' + e.message);
        if (consecutiveErrors >= 5) throw new Error('连续 5 次无法读取页面状态，最后错误：' + e.message);
        continue;
      }
      if (i % 5 === 0 && !/SMOKE (DONE|FAILED)/.test(text)) {
        console.log('  等待测试完成… (' + i + 's) 当前输出长度 ' + text.length);
      }
      if (/SMOKE (DONE|FAILED)/.test(text)) break;
    }

const consoleErrors = cdp.events
  .filter((ev) => ev.method === 'Log.entryAdded' && ev.params.entry.level === 'error')
  .map((ev) => ({ text: ev.params.entry.text, url: ev.params.entry.url || '' }));
const exceptions = cdp.events
      .filter((e) => e.method === 'Runtime.exceptionThrown')
      .map((e) => (e.params.exceptionDetails.exception && e.params.exceptionDetails.exception.description) || e.params.exceptionDetails.text);


    console.log('\n================ 端到端冒烟结果 ================');
    console.log(text || '（未获取到测试输出）');
    if (consoleErrors.length) {
      console.log('\n-- 浏览器控制台错误 --');
  consoleErrors.slice(0, 20).forEach((c) => console.log('  ! ' + (c && c.text ? c.text : c) + (c && c.url ? '  ← ' + c.url : '')));
    }
    if (exceptions.length) {
      console.log('\n-- 未捕获异常 --');
      exceptions.slice(0, 20).forEach((t) => console.log('  ! ' + String(t).split('\n')[0]));
    }

    const failed = /SMOKE FAILED/.test(text) || /FAIL ::/.test(text) || !/SMOKE DONE/.test(text);

    // 审计发现：控制台错误与未捕获异常原来**只打印不参与判定** →
    // 应用里抛异常但用例走完照样绿（而 ui-vue.test.mjs 把控制台错误算失败，标准不一致）。
    // 注意要放在 failed 声明**之后**（放前面会踩 TDZ：Cannot access before initialization）。
    // 分类：只放行**已知良性**，其余一律计入失败（默认严格）。
    //   · favicon 404 —— 浏览器自动请求，页面里没放图标，无害
    //   · 409 Conflict —— 这两条 e2e **故意**测"过期 rev 被拒"那条路径（协议正确行为）
    const BENIGN = [
      (c) => /favicon/i.test(c.url),
      (c) => /409 \(Conflict\)/.test(c.text),
      // 探针探测"枢纽有没有领域端点"：打 Node 枢纽时必然 404（它不实现 /api/domain/*），
      // 这是**设计内的探测失败**，之后应用正确回退本地实现。浏览器会自动记这条错误，无法避免。
      (c) => /404/.test(c.text) && /\/api\/domain\//.test(c.url)
    ];
    const realErrors = consoleErrors.filter((c) => !BENIGN.some((f) => f(c)));
    const consoleBad = realErrors.length + exceptions.length;
    if (consoleBad > 0) {
      console.log('  · 控制台错误/异常 ' + consoleBad + ' 条（计入失败）');
      realErrors.slice(0, 10).forEach((c) => console.log('    ! ' + c.text + '  ← ' + c.url));
      exceptions.slice(0, 10).forEach((t) => console.log('    ! ' + String(t).split('\n')[0].slice(0, 160)));
    }
    exitCode = (failed || consoleBad > 0) ? 1 : 0;
    console.log('\n' + (failed ? '❌ 端到端冒烟未通过' : '✅ 端到端冒烟全部通过'));
  } catch (e) {
    console.error('运行失败：', e.message);
    exitCode = 1;
  } finally {
    clearTimeout(watchdog);
    try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { try { child.kill('SIGKILL'); } catch (e2) {} }
    await sleep(500);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
    process.exit(exitCode);
  }
})();
