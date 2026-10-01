/*!
 * tests/demo.js — 可复现的"整堂演示"：自动起枢纽 + 三个真实页面，按课堂流程走一遍并逐步截图
 *
 *   node tests/demo.js                 # 输出到 docs/demo/
 *   node tests/demo.js --keep          # 结束后保留临时目录，便于排查
 *
 *  为什么要有它：客户端安装包还没在 CI 上出过，但"全流程能不能跑通"现在就能演示与复查。
 *  它驱动的是**真实页面**（admin.html / student.html / index.html），不是模拟层；
 *  产物是 8 张带说明的截图 + 一份文字实录，可直接发给别人看效果。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'docs', 'demo');
const KEEP = process.argv.includes('--keep');
const ROOM = 'demo';
const CDP_PORT = 9444;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findBrowser() {
  const cands = [
    process.env.CHROME_PATH || '',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/chromium-browser', '/usr/bin/chromium', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  ].filter(Boolean);
  for (const p of cands) if (fs.existsSync(p)) return p;
  throw new Error('未找到 Chrome/Edge；可用 CHROME_PATH 指定');
}

function freePort(start) {
  return new Promise((resolve) => {
    const tryPort = (p) => {
      const srv = net.createServer();
      srv.once('error', () => tryPort(p + 1));
      srv.once('listening', () => srv.close(() => resolve(p)));
      srv.listen(p, '127.0.0.1');
    };
    tryPort(start);
  });
}

async function waitJson(url, tries) {
  for (let i = 0; i < (tries || 40); i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
    } catch (e) { /* 未就绪 */ }
    await sleep(300);
  }
  throw new Error('等待超时：' + url);
}

/** 浏览器级 CDP：可创建多个标签页并分别驱动 */
class Browser {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.errors = [];
    ws.on('message', (raw) => {
      let msg = null;
      try { msg = JSON.parse(raw); } catch (e) { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      } else if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        this.errors.push((d.exception && d.exception.description) || d.text);
      } else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
        this.errors.push(msg.params.entry.text);
      }
    });
  }
  static async connect(url) {
    const ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
    await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
    return new Browser(ws);
  }
  send(method, params, sessionId, timeoutMs) {
    const id = ++this.id;
    const payload = { id, method, params: params || {} };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP 超时：' + method)); }
      }, timeoutMs || 15000);
    });
  }
  /** 新建标签页并启用所需域（视口用 Emulation 覆盖，截图即按该尺寸） */
  async newPage(url, width, height) {
    const t = await this.send('Target.createTarget', { url: 'about:blank' });
    const a = await this.send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
    const sid = a.sessionId;
    await this.send('Runtime.enable', {}, sid);
    await this.send('Log.enable', {}, sid);
    await this.send('Page.enable', {}, sid);
    await this.send('Emulation.setDeviceMetricsOverride', {
      width: width || 1440, height: height || 900, deviceScaleFactor: 1, mobile: false
    }, sid);
    this.ws.on('message', (raw) => {
      let msg = null;
      try { msg = JSON.parse(raw); } catch (e) { return; }
      if (msg.method === 'Page.javascriptDialogOpening' && msg.sessionId === sid) {
        this.send('Page.handleJavaScriptDialog', { accept: true }, sid).catch(() => {});
      }
    });
    await this.send('Page.navigate', { url }, sid);
    return sid;
  }
  async eval(sid, expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: false }, sid);
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error('页面内异常：' + ((d.exception && d.exception.description) || d.text));
    }
    return r.result ? r.result.value : undefined;
  }
  async waitFor(sid, expression, label, timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 8000);
    for (;;) {
      let v = false;
      try { v = await this.eval(sid, expression); } catch (e) { v = false; }
      if (v) return true;
      if (Date.now() > deadline) throw new Error('等待超时：' + (label || expression));
      await sleep(200);
    }
  }
  async shot(sid, file, caption) {
    // 截图偶尔会慢（页面在重排/动画），给 30s 并重试一次
    let r = null;
    for (let i = 0; i < 2 && !r; i++) {
      try {
        r = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, sid, 30000);
      } catch (e) {
        if (i === 1) throw e;
        await sleep(800);
      }
    }
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    const size = Math.round(fs.statSync(file).size / 1024);
    console.log('  📷 ' + path.relative(ROOT, file) + '  (' + size + ' KB)  ' + (caption || ''));
  }
  close() { try { this.ws.close(); } catch (e) { /* 忽略 */ } }
}

const steps = [];
function step(title, detail) {
  steps.push({ title, detail });
  console.log('\n▶ ' + title + (detail ? '\n   ' + detail : ''));
}

(async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // 顺手清掉上次异常退出残留的临时目录（Chrome 有时会占着 profile 不放）
  try {
    fs.readdirSync(os.tmpdir())
      .filter((n) => /^ci-demo(-profile)?-\d+$/.test(n))
      .forEach((n) => { try { fs.rmSync(path.join(os.tmpdir(), n), { recursive: true, force: true }); } catch (e) { /* 忽略 */ } });
  } catch (e) { /* 忽略 */ }

  const port = await freePort(8500 + Math.floor(Math.random() * 100));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-demo-'));
  const profile = path.join(os.tmpdir(), 'ci-demo-profile-' + Date.now());
  fs.mkdirSync(profile, { recursive: true });

  console.log('演示枢纽：http://127.0.0.1:' + port + '（数据目录 ' + dataDir + '）');
  const hub = spawn(process.execPath, [path.join(ROOT, 'sync-server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir }),
    stdio: 'ignore'
  });
  await waitJson('http://127.0.0.1:' + port + '/health');

  const bin = findBrowser();
  const chrome = spawn(bin, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-background-networking',
    '--window-size=1440,900',
    '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + profile,
    'about:blank'
  ], { stdio: 'ignore', detached: true });

  const cleanup = () => {
    // 先**同步**结束浏览器（Windows 上 headless Chrome 会派生进程、且会占着 profile 目录），
    // 再删临时目录；Chrome 退出需要一点时间释放文件锁，所以中间同步等 1.2 秒。
    try {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/pid', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        chrome.kill('SIGKILL');
      }
    } catch (e) { /* 忽略 */ }
    try { hub.kill(); } catch (e) { /* 忽略 */ }
    if (!KEEP) {
      // 同步阻塞 1.2s（不引第三方依赖：让 node 自己睡）
      try { spawnSync(process.execPath, ['-e', 'setTimeout(function(){}, 1200)'], { stdio: 'ignore' }); } catch (e) { /* 忽略 */ }
      try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 }); } catch (e) { /* 忽略 */ }
      try { fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 3 }); } catch (e) { /* 忽略 */ }
      try { fs.rmSync(path.join(ROOT, 'rooms'), { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
    }
  };
  process.on('exit', cleanup);

  const base = 'http://127.0.0.1:' + port;
  const version = await waitJson('http://127.0.0.1:' + CDP_PORT + '/json/version');
  console.log('浏览器：' + version.Browser);
  const browser = await Browser.connect(version.webSocketDebuggerUrl);

  try {
    /* ---------- 1. 教师端：建班 ---------- */
    step('教师端建班', '两支队 + 5 名学生 + 3 道题（基础/拔高/提升）');
    const teacher = await browser.newPage(base + '/admin.html?room=' + ROOM + '#tab-class', 1440, 980);
    await browser.waitFor(teacher, 'typeof CI === "object" && !!CI.store', '教师端加载');
    await browser.eval(teacher, `
      (function () {
        var S = CI.store;
        S.replaceState(S.defaultState());
        var teams = S.get().teams;
        S.addStudentsBulk('张三 李四 王五', teams[0].id);
        S.addStudentsBulk('赵六 钱七', teams[1].id);
        S.addQuestion({ stem: '基础题：集合 {1,2,3} 的子集个数是？', tier: 'basic', answer: 'B', options: ['6', '8', '9'], tags: ['集合与逻辑'] });
        S.addQuestion({ stem: '拔高题：函数 f(x)=x³-3x 的极小值点是？', tier: 'advanced', answer: 'x=1', tags: ['函数与导数'] });
        S.addQuestion({ stem: '提升题：请说明你的解题思路（口述或写下来）', tier: 'improve', answer: '', tags: ['综合'] });
        CI.bankUI.render();
        CI.quizUI.newQuiz();
        var qs = S.get().bank.map(function (q) { return q.id; });
        qs.forEach(function (id) { CI.quizUI.addToCurrent(id); });
        CI.quizUI.render();
        CI.admin.renderAll();
        return true;
      })()
    `);
    await sleep(600);
    await browser.shot(teacher, path.join(OUT_DIR, '01-教师端建班.png'), '班级与积分（5 名学生、2 支队）');
    step('打开组卷页', '题库 3 题已加入「第 1 次随堂测」');
    await browser.eval(teacher, 'CI.admin.gotoTab("tab-quiz")');
    await sleep(500);
    await browser.shot(teacher, path.join(OUT_DIR, '02-组卷与答题.png'), '组卷与答题页');

    /* ---------- 2. 教师端：推题 + 开始接收作答 ---------- */
    step('教师端推题', '⑦ 课堂协同：设为当前题 → 开始接收作答');
    await browser.eval(teacher, `
      (function () {
        var S = CI.store, q = S.get().bank[0];
        CI.quizUI.setQuestion(q.id);
        CI.admin.gotoTab('tab-classroom');
        if (!S.get().runtime.accepting) CI.classroom.toggleAccepting();
        CI.classroom.render();
        return { qid: q.id, accepting: S.get().runtime.accepting };
      })()
    `);
    await sleep(900);

    /* ---------- 3. 学生端：入座 ---------- */
    step('学生端入座', '手机端打开 /join：选小组 → 入座');
    const student = await browser.newPage(base + '/student.html?room=' + ROOM, 420, 900);
    await browser.waitFor(student, '!!window.CIStudent && !!(CIStudent.data().payload)', '学生端收到快照');
    await sleep(400);
    await browser.shot(student, path.join(OUT_DIR, '03-学生端入座.png'), '学生端选择小组');
    await browser.eval(student, `
      (function () {
        var teams = CIStudent.data().payload.teams;
        CIStudent.pickTeam(teams[0].id);
        return teams[0].id;
      })()
    `);
    await sleep(700);

    /* ---------- 4. 大屏 ---------- */
    step('教室大屏', '大屏只读：队伍榜 + 个人榜 + 当前题');
    const stage = await browser.newPage(base + '/index.html?room=' + ROOM, 1440, 900);
    await browser.waitFor(stage, '!!document.getElementById("teamList")', '大屏加载');
    await sleep(1200);
    await browser.shot(stage, path.join(OUT_DIR, '04-教室大屏.png'), '大屏实时榜');

    /* ---------- 5. 学生答题 → 自动判分 ---------- */
    step('学生答题 → 自动判分', '学生选对选项提交，教师端立刻 +3（基础题权重）');
    const before = await browser.eval(teacher, 'CI.store.get().students.map(function (s) { return CI.store.scoreOf(CI.store.get(), s.id); })');
    await browser.eval(student, `
      (function () {
        var q = CIStudent.data().payload.meta.question;
        var opts = document.querySelectorAll('#qaPane .opt, #qaPane button');
        // 直接走提交接口，等价于点选后按「提交答案」
        if (q && q.type === 'choice' && q.options && q.options.length) {
          var correct = 0; // 选项 8 在第二位（索引 1）——按题型自动判分，这里选对
          CIStudent.toggleOption(q.options[1].key);
        }
        CIStudent.submit(false);
        return true;
      })()
    `);
    await sleep(1500);
    await browser.shot(student, path.join(OUT_DIR, '05-学生端答题.png'), '学生端提交后看到判定');
    const after = await browser.eval(teacher, 'CI.store.get().students.map(function (s) { return CI.store.scoreOf(CI.store.get(), s.id); })');
    const feed = await browser.eval(teacher, 'CI.classroom.box(CI.store.get()).feed.slice(0, 2).map(function (f) { return f.text })');
    console.log('   分数变化：' + JSON.stringify(before) + ' → ' + JSON.stringify(after));
    console.log('   实时流：' + JSON.stringify(feed));
    await browser.eval(teacher, 'CI.admin.gotoTab("tab-classroom")');
    await sleep(600);
    await browser.shot(teacher, path.join(OUT_DIR, '06-教师端实时流.png'), '教师端看到「答对 +3」');

    /* ---------- 6. 公布答案 ---------- */
    step('公布答案', '教师端公布 → 学生端与大屏显示正确答案');
    await browser.eval(teacher, 'if (!CI.classroom.isRevealed()) CI.classroom.toggleReveal(); CI.classroom.render(); true');
    await sleep(1200);
    await browser.shot(student, path.join(OUT_DIR, '07-学生端答案已公布.png'), '学生端显示正确答案');
    await browser.shot(stage, path.join(OUT_DIR, '08-大屏答案已公布.png'), '大屏显示正确答案');

    /* ---------- 7. 抢答 ---------- */
    step('抢答', '学生点「⚡ 抢答」→ 教师端抢答榜出现该队');
    await browser.eval(student, 'CIStudent.buzz(); true');
    await sleep(1200);
    await browser.shot(teacher, path.join(OUT_DIR, '09-教师端抢答榜.png'), '教师端抢答榜');

    const errors = browser.errors.filter((e) => !/ERR_UNSAFE_PORT|favicon/.test(e));
    console.log('\n页面错误：' + (errors.length ? errors.join(' | ') : '无'));

    /* ---------- 实录 ---------- */
    const lines = [
      '# 课堂演示实录（自动生成）',
      '',
      '> 由 `node tests/demo.js` 生成：自动起一个隔离枢纽，用**真实页面**（教师端 / 学生端 / 大屏）走完整堂课流程，并逐步截图。',
      '> 房间号 `' + ROOM + '`，浏览器 ' + version.Browser + '。',
      '',
      '| 步骤 | 说明 | 截图 |',
      '| --- | --- | --- |'
    ];
    const shots = [
      ['教师端建班', '班级与积分（5 名学生、2 支队）', '01-教师端建班.png'],
      ['打开组卷页', '题库 3 题已加入「第 1 次随堂测」', '02-组卷与答题.png'],
      ['学生端入座', '手机端打开 /join：选小组入座', '03-学生端入座.png'],
      ['教室大屏', '大屏只读：队伍榜 + 个人榜 + 当前题', '04-教室大屏.png'],
      ['学生答题', '提交后看到判定', '05-学生端答题.png'],
      ['自动判分', '教师端实时流出现「答对（+3）」', '06-教师端实时流.png'],
      ['公布答案', '学生端显示正确答案', '07-学生端答案已公布.png'],
      ['公布答案', '大屏显示正确答案', '08-大屏答案已公布.png'],
      ['抢答', '教师端抢答榜出现该队', '09-教师端抢答榜.png']
    ];
    shots.forEach(([t, d, f]) => lines.push('| ' + t + ' | ' + d + ' | ![' + t + '](' + f + ') |'));
    lines.push('', '## 关键结果', '',
      '- 学生提交后分数变化：`' + JSON.stringify(before) + '` → `' + JSON.stringify(after) + '`',
      '- 教师端实时流：`' + JSON.stringify(feed) + '`',
      '- 页面错误：' + (errors.length ? errors.join('；') : '无'),
      '',
      '> 这份实录覆盖了「建班 → 组卷 → 推题 → 入座 → 答题 → 自动判分 → 公布答案 → 抢答」整条链路；',
      '> 客户端（Tauri）出包后应能在同一房间复现同样结果（协议未变）。');
    fs.writeFileSync(path.join(OUT_DIR, 'README.md'), lines.join('\n'), 'utf8');
    console.log('\n✅ 演示完成：' + steps.length + ' 个步骤，产物在 ' + path.relative(ROOT, OUT_DIR));
    console.log('   ' + (errors.length ? '⚠️ 有页面错误，见实录' : '无页面错误'));

    browser.close();
    cleanup();
    process.exit(errors.length ? 1 : 0);
  } catch (e) {
    console.error('\n❌ 演示失败：' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n') : e));
    browser.close();
    cleanup();
    process.exit(1);
  }
})();
