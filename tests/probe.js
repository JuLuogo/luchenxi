/*!
 * tests/probe.js — 调试探针：在无头浏览器里打开任意页面，检查渲染进程是否响应、有无脚本错误
 *   node tests/probe.js http://127.0.0.1:8123/admin.html
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const URL_TO_TEST = process.argv[2] || 'http://127.0.0.1:8123/admin.html';
const WAIT = Number(process.argv[3] || 4000);
const PORT = 9444;

const CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async function main() {
  const bin = CANDIDATES.find((p) => fs.existsSync(p));
  const profile = path.join(os.tmpdir(), 'ci-probe-' + Date.now());
  fs.mkdirSync(profile, { recursive: true });
  const child = spawn(bin, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile, 'about:blank'
  ], { stdio: 'ignore', detached: true });

  const watchdog = setTimeout(() => { console.error('总超时'); process.exit(3); }, 60000);

  try {
    let list = null;
    for (let i = 0; i < 30 && !list; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
        if (res.ok) list = await res.json();
      } catch (e) { await sleep(400); }
    }
    const page = list.find((t) => t.type === 'page');
    console.log('目标页面:', page.url);

    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
    let id = 0;
    const pending = new Map();
    const events = [];
    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
      else if (m.method) events.push(m);
    });
    const send = (method, params = {}, timeout = 6000) => new Promise((resolve, reject) => {
      const myId = ++id;
      pending.set(myId, resolve);
      ws.send(JSON.stringify({ id: myId, method, params }));
      setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); reject(new Error('超时: ' + method)); } }, timeout);
    });
    const evaluate = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
      if (r.error) throw new Error(JSON.stringify(r.error));
      if (r.result && r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.text);
      return r.result && r.result.result ? r.result.result.value : undefined;
    };

    await send('Runtime.enable');
    await send('Log.enable');
    await send('Page.enable');

    console.log('探针 A（登录前）:', await evaluate('1+1'));
    await send('Page.navigate', { url: URL_TO_TEST });
    console.log('已导航，等待 ' + WAIT + 'ms …');
    await sleep(WAIT);

    for (const expr of [
      'document.readyState',
      'document.title',
      'document.querySelectorAll("script").length',
      'typeof CI',
      'document.getElementById("errBar") ? document.getElementById("errBar").textContent : "no-errbar"',
      'document.querySelectorAll(".tab-btn").length',
      'document.querySelectorAll("#teamsContainer .team-card").length',
      'document.body.innerText.slice(0,300)'
    ]) {
      try {
        console.log('  ' + expr + '  =>  ' + JSON.stringify(await evaluate(expr)));
      } catch (e) {
        console.log('  ' + expr + '  =>  ⚠ ' + e.message);
      }
    }

    const errors = events.filter((e) => e.method === 'Log.entryAdded' && e.params.entry.level === 'error')
      .map((e) => e.params.entry.text + '  ← ' + (e.params.entry.url || '无 url'));
    const exceptions = events.filter((e) => e.method === 'Runtime.exceptionThrown')
      .map((e) => (e.params.exceptionDetails.exception && e.params.exceptionDetails.exception.description) || e.params.exceptionDetails.text);
    if (errors.length) { console.log('\n控制台错误:'); errors.slice(0, 10).forEach((t) => console.log('  ! ' + t)); }
    if (exceptions.length) { console.log('\n未捕获异常:'); exceptions.slice(0, 10).forEach((t) => console.log('  ! ' + String(t).split('\n')[0])); }
    if (!errors.length && !exceptions.length) console.log('\n无控制台错误');
  } catch (e) {
    console.error('探针失败：', e.message);
  } finally {
    clearTimeout(watchdog);
    try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { try { child.kill(); } catch (e2) {} }
    await sleep(300);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
    process.exit(0);
  }
})();
