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
  throw new Error('CDP 未就绪：' + url);
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

  const child = spawn(bin, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + profile,
    'about:blank'
  ], { stdio: 'ignore', detached: true });

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
      .filter((e) => e.method === 'Log.entryAdded' && e.params.entry.level === 'error')
      .map((e) => e.params.entry.text);
    const exceptions = cdp.events
      .filter((e) => e.method === 'Runtime.exceptionThrown')
      .map((e) => (e.params.exceptionDetails.exception && e.params.exceptionDetails.exception.description) || e.params.exceptionDetails.text);

    console.log('\n================ 端到端冒烟结果 ================');
    console.log(text || '（未获取到测试输出）');
    if (consoleErrors.length) {
      console.log('\n-- 浏览器控制台错误 --');
      consoleErrors.slice(0, 20).forEach((t) => console.log('  ! ' + t));
    }
    if (exceptions.length) {
      console.log('\n-- 未捕获异常 --');
      exceptions.slice(0, 20).forEach((t) => console.log('  ! ' + String(t).split('\n')[0]));
    }

    const failed = /SMOKE FAILED/.test(text) || /FAIL ::/.test(text) || !/SMOKE DONE/.test(text);
    exitCode = failed ? 1 : 0;
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
