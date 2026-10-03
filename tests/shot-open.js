/*!
 * tests/shot-open.js — 给「公开课」出截图：四步 + 大屏 + 学生端
 *
 *   node tests/shot-open.js [base]        # 默认 http://127.0.0.1:8080
 *
 * 为什么要单独一个脚本：公开课的界面**依赖现场状态**（被点到的学生 / 当前题 / 判定 / 评价），
 * 空库截出来是空白页。这里先把状态造好，再逐屏截图。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const BASE = process.argv[2] || ('http://127.0.0.1:' + (process.env.PORT || 8080));
const OUT = path.join(ROOT, 'docs', 'screenshots-open');
const CDP_PORT = 9466;
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
      }
      if (m.method === 'Runtime.exceptionThrown') {
        c.errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
      }
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        c.errors.push((m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
      }
    });
    return c;
  }
  send(method, params, sid) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      const payload = { id, method, params: params || {} };
      if (sid) payload.sessionId = sid;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('timeout ' + method)); } }, 20000);
    });
  }
  async newPage(url, w, h) {
    const t = await this.send('Target.createTarget', { url: 'about:blank' });
    const a = await this.send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
    const sid = a.sessionId;
    await this.send('Runtime.enable', {}, sid);
    await this.send('Page.enable', {}, sid);
    await this.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false }, sid);
    await this.send('Page.navigate', { url }, sid);
    return sid;
  }
  async eval(sid, expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sid);
    if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
    return r.result?.value;
  }
  async waitFor(sid, expr, label, tries = 60) {
    for (let i = 0; i < tries; i++) {
      const v = await this.eval(sid, expr);
      if (v === true) return true;
      await sleep(250);
    }
    throw new Error('等待超时：' + label);
  }
  /** 关掉可能挡画面的弹窗（教师端连上枢纽后会问"发现远端数据，是否载入？"） */
  async dismissDialogs(sid) {
    await this.eval(sid, `(function(){
      var closed = 0;
      document.querySelectorAll('.el-message-box__btns button, .el-dialog__headerbtn').forEach(function(b){
        var txt = (b.textContent || '').trim();
        if (txt === '暂不' || txt === '' || b.classList.contains('el-dialog__headerbtn')) { b.click(); closed += 1; }
      });
      document.querySelectorAll('.el-overlay').forEach(function(o){ o.style.display = 'none'; });
      return closed;
    })()`);
    await new Promise((r) => setTimeout(r, 300));
  }

  async shot(sid, file) {
    await this.dismissDialogs(sid);
    const r = await this.send('Page.captureScreenshot', { format: 'png' }, sid);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  }
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-open-shot-'));
  const chrome = spawn(findBrowser(), [
    '--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars',
    '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + profile, 'about:blank'
  ], { stdio: 'ignore', detached: true });

  try {
    const v = await waitJson('http://127.0.0.1:' + CDP_PORT + '/json/version');
    const cdp = await CDP.connect(v.webSocketDebuggerUrl);

    /* ---------- 教师端：造数据 + 逐屏截图 ---------- */
    const page = await cdp.newPage(BASE + '/admin.html#/open', 1280, 900);
    await cdp.waitFor(page, '!!(window.CI && CI.store)', '教师端加载');
    await sleep(800);

    // 造一份公开课现场：两名学生 + 一道客观题 + 一道主观题
    const seeded = await cdp.eval(page, `(function(){
      try {
        var S = window.CI.store;
        S.replaceState(S.defaultState());
        var t1 = S.get().teams[0].id;
        var bulk = S.addStudentsBulk('张三\\n李四', t1);
        var q1 = S.addQuestion({ stem: '已知集合 A={1,2}，它的子集个数是多少？', tier: 'basic', answer: 'C',
          options: ['2 个', '3 个', '4 个', '无数个'], tags: ['集合'] });
        S.addQuestion({ stem: '请说明为什么 f(x)=x² 在 (0,+∞) 上单调递增。', tier: 'advanced', answer: '', tags: ['函数'] });
        S.createQuiz('公开课示例卷', [q1.id]);
        S.setCurrentQuiz(S.get().quizzes[0].id);
        window.__openSeed = { sid: bulk[0].id, name: bulk[0].name, qid: q1.id };
        return true;
      } catch (e) { return '抛错：' + e.message; }
    })()`);
    if (seeded !== true) throw new Error('造数据失败：' + JSON.stringify(seeded));
    await sleep(600);

    // ① 点名（页面初始态）
    await cdp.eval(page, 'location.hash = "#/open"');
    await sleep(900);
    await cdp.shot(page, path.join(OUT, '01-公开课-点名.png'));
    console.log('  ✔ 01 点名');

    // ② 抽题：直接调页面里的按钮太脆，这里用领域层把状态推进到"已抽题"
    await cdp.eval(page, `(function(){
      var S = window.CI.store, seed = window.__openSeed;
      window.CI.rollcall.applyPick({ sid: seed.sid, at: Date.now() });
      window.CI.classroom.setPhase('rollcall');
      window.CI.classroom.setOpenState({ step: 'rollcall', sid: seed.sid, name: seed.name, qid: null, verdict: '', evaluation: null });
      return true;
    })()`);
    await sleep(700);
    // 让页面自己进入第 2 步（点「随机抽一位」会重新抽人，这里改为直接点"下一步"不可行，
    // 所以用页面暴露的 doPick 会重抽 —— 选择：把当前学生写进页面状态由用户点"抽一道题"触发）
    await cdp.eval(page, 'document.querySelectorAll(".panel .el-button")[0] && document.querySelectorAll(".panel .el-button")[0].click()');
    await sleep(1200);
    await cdp.shot(page, path.join(OUT, '02-公开课-抽题.png'));
    console.log('  ✔ 02 抽题');

    // ③ 判定：抽一道题 + 展示判定按钮
    await cdp.eval(page, `(function(){
      var S = window.CI.store, seed = window.__openSeed;
      var q = S.question(S.get(), seed.qid);
      S.setRuntime({ qid: q.id, quizId: S.get().currentQuizId });
      window.CI.classroom.setPhase('question');
      window.CI.classroom.setOpenState({ step: 'question', qid: q.id });
      return true;
    })()`);
    await sleep(700);
    const stepBtns = await cdp.eval(page, 'document.querySelectorAll(".panel .el-button").length');
    if (typeof stepBtns === 'number' && stepBtns > 0) {
      await cdp.eval(page, 'document.querySelectorAll(".panel .el-button")[0].click()');
      await sleep(1200);
    }
    await cdp.shot(page, path.join(OUT, '03-公开课-判定.png'));
    console.log('  ✔ 03 判定');

    // ④ 评价：写一次现场评价，再进第 4 步
    await cdp.eval(page, `(function(){
      var seed = window.__openSeed;
      var ev = window.CI.openclass.evaluate([
        { key: 'basic', score: 4 }, { key: 'transfer', score: 3 },
        { key: 'expression', score: 4 }, { key: 'attitude', score: 4 }
      ]);
      window.__openEval = ev;
      window.CI.classroom.setOpenState({ step: 'eval', verdict: 'correct', evaluation: ev });
      return true;
    })()`);
    await sleep(700);
    // 切到第 4 步（页面的"完成"流程不便脚本化，直接点判定按钮 → 会进第 4 步）
    await cdp.eval(page, `(function(){
      var btns = Array.from(document.querySelectorAll('.panel .el-button'));
      var ok = btns.find(function(b){ return (b.textContent||'').indexOf('全对') >= 0; });
      if (ok) ok.click();
      return !!ok;
    })()`);
    await sleep(1500);
    // 点上四维档位，让评语显示出来
    await cdp.eval(page, `(function(){
      var groups = document.querySelectorAll('.dim .el-radio-group');
      var picks = [0, 1, 0, 0];   // 索引：0=优秀 1=良好 2=合格 3=待改进
      groups.forEach(function(g, i){
        var btns = g.querySelectorAll('.el-radio-button');
        var idx = picks[i] === undefined ? 1 : picks[i];
        if (btns[idx]) btns[idx].click();
      });
      return groups.length;
    })()`);
    await sleep(1500);
    await cdp.shot(page, path.join(OUT, '04-公开课-评价.png'));
    console.log('  ✔ 04 评价');

    /* ---------- 大屏 ---------- */
    const stage = await cdp.newPage(BASE + '/stage?room=default', 1440, 900);
    await cdp.waitFor(stage, 'document.querySelector(".stage") !== null', '大屏渲染');
    await sleep(1500);
    await cdp.shot(stage, path.join(OUT, '05-大屏-公开课.png'));
    console.log('  ✔ 05 大屏');

    /* ---------- 学生端 ---------- */
    const room = await cdp.eval(page, 'window.CI.sync.room()');
    const stu = await cdp.newPage(BASE + '/join?room=' + encodeURIComponent(String(room)) + '&team=' + encodeURIComponent(String(await cdp.eval(page, 'window.CI.store.get().teams[0].id'))), 400, 860);
    await cdp.waitFor(stu, 'document.querySelector(".van-nav-bar") !== null', '学生端渲染');
    await sleep(1800);
    await cdp.shot(stu, path.join(OUT, '06-学生端-到你了.png'));
    console.log('  ✔ 06 学生端');

    const errors = cdp.errors.filter((e) => !/favicon|ERR_UNSAFE_PORT/.test(e));
    console.log('\n页面错误：' + (errors.length ? errors.length + ' 条' : '无'));
    errors.slice(0, 5).forEach((e) => console.log('  · ' + String(e).slice(0, 160)));
    console.log('截图目录：' + path.relative(ROOT, OUT));
  } finally {
    try { spawnSync('taskkill', ['/pid', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) { /* 忽略 */ }
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 }); } catch (e) { /* 忽略 */ }
  }
})().catch((e) => { console.error('✘ ' + e.message); process.exit(1); });
