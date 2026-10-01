/*!
 * tests/shot-student.js — 学生端截图（入座 → 答题 → 抢答 → 我们组）
 *   node tests/shot-student.js [base]
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
const CDP_PORT = 9511;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const profile = path.join(os.tmpdir(), 'ci-stu-profile-' + Date.now());
  fs.mkdirSync(profile, { recursive: true });
  const chrome = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--window-size=420,900', '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + profile, 'about:blank'
  ], { stdio: 'ignore', detached: true });
  const cleanup = () => {
    try { spawnSync('taskkill', ['/pid', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) { /* */ }
    try { spawnSync(process.execPath, ['-e', 'setTimeout(function(){},1200)'], { stdio: 'ignore' }); } catch (e) { /* */ }
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 }); } catch (e) { /* */ }
  };
  process.on('exit', cleanup);

  let version = null;
  for (let i = 0; i < 30 && !version; i++) {
    try { const r = await fetch('http://127.0.0.1:' + CDP_PORT + '/json/version'); if (r.ok) version = await r.json(); } catch (e) { /* */ }
    if (!version) await sleep(300);
  }
  const ws = new WebSocket(version.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  let id = 0;
  const pending = new Map();
  const errors = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
    else if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      errors.push('EXCEPTION ' + ((d.exception && d.exception.description) || d.text));
    } else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
      errors.push('CONSOLE ' + m.params.entry.text);
    }
  });
  const send = (method, params, sid) => new Promise((resolve, reject) => {
    const i = ++id;
    const payload = { id: i, method, params: params || {} };
    if (sid) payload.sessionId = sid;
    pending.set(i, { resolve, reject });
    ws.send(JSON.stringify(payload));
    setTimeout(() => { if (pending.has(i)) { pending.delete(i); reject(new Error('timeout ' + method)); } }, 20000);
  });
  const newPage = async (url, w, h) => {
    const t = await send('Target.createTarget', { url: 'about:blank' });
    const a = await send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
    const sid = a.sessionId;
    await send('Runtime.enable', {}, sid);
    await send('Log.enable', {}, sid);
    await send('Page.enable', {}, sid);
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: true }, sid);
    await send('Page.navigate', { url }, sid);
    return sid;
  };
  const evalIn = async (sid, expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true }, sid);
    if (r.exceptionDetails) throw new Error('页面异常：' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
    return r.result ? r.result.value : undefined;
  };
  const waitFor = async (sid, expr, label, ms) => {
    const end = Date.now() + (ms || 15000);
    for (;;) {
      let v = false;
      try { v = await evalIn(sid, expr); } catch (e) { v = false; }
      if (v) return true;
      if (Date.now() > end) throw new Error('等待超时：' + (label || expr));
      await sleep(250);
    }
  };
  const shot = async (sid, file) => {
    const r = await send('Page.captureScreenshot', { format: 'png' }, sid, 30000);
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    console.log('  📷 ' + path.relative(ROOT, file) + '  (' + Math.round(fs.statSync(file).size / 1024) + ' KB)');
  };

  // 教师端：灌数据并进入"出题答题"环节
  const teacher = await newPage(BASE + '/admin.html#/classroom', 1440, 940);
  await waitFor(teacher, '!!(window.CI && CI.store)', '教师端就绪');
  await evalIn(teacher, `(function(){
    var S = CI.store;
    S.replaceState(S.defaultState());
    S.updateSettings({ courseName: '24机械高考公开课' });
    var teams = S.get().teams;
    S.addStudentsBulk('张三 李四', teams[0].id);
    S.addStudentsBulk('王五 赵六', teams[1].id);
    S.addQuestion({ stem: '集合 {1,2,3} 的子集个数是？', tier: 'basic', answer: 'B', options: ['6','8','9'] });
    S.addQuestion({ stem: '函数 f(x)=x³-3x 的极小值点', tier: 'advanced', answer: 'x=1' });
    var qs = S.get().bank.map(function(q){ return q.id; });
    var qz = S.createQuiz('第 1 次随堂测', qs, '');
    S.setCurrentQuiz(qz.id);
    var stu = S.get().students;
    S.recordResult({ sid: stu[0].id, tier: 'basic', result: 'correct' });
    S.recordResult({ sid: stu[2].id, tier: 'basic', result: 'wrong' });
    CI.classroom.setPhase('question');
    CI.sync.push(true);
    return true;
  })()`);
  await sleep(1200);

  // 学生端（手机视口）
  const stu = await newPage(BASE + '/join?room=default', 420, 900);
  await waitFor(stu, '!!(window.CIStudent && CIStudent.state)', '学生端领域层');
  await waitFor(stu, 'document.querySelector(".join-title") !== null', '入座页渲染');
  await sleep(1200);
  await shot(stu, path.join(OUT, '22-学生端-入座.png'));

  // 选第一个小组入座
  await evalIn(stu, '(function(){ var b = document.querySelectorAll(".team-btn"); if (b.length) b[0].click(); return b.length; })()');
  await sleep(1800);
  await shot(stu, path.join(OUT, '23-学生端-答题.png'));

  // 选一个选项再提交（走真实交互路径）
  const clicked = await evalIn(stu, `(function(){
    var o = document.querySelectorAll('.opt');
    if (o.length > 1) o[1].click();
    return { opts: o.length, selectedAfter: CIStudent.state().selected };
  })()`);
  console.log('  选项点击：' + JSON.stringify(clicked));
  await sleep(600);
  const submitResult = await evalIn(stu, `(function(){
    var btns = [].slice.call(document.querySelectorAll('.van-button'));
    var target = btns.filter(function (x) { return x.textContent.trim() === '提交答案'; })[0];
    if (target) target.click();
    return { found: !!target, disabled: target ? target.disabled : null, text: target ? target.textContent.trim() : null };
  })()`);
  console.log('  提交按钮：' + JSON.stringify(submitResult));
  await sleep(1800);
  const afterSubmit = await evalIn(stu, `JSON.stringify({
    submitted: CIStudent.state().submitted,
    selected: CIStudent.state().selected,
    accepting: CIStudent.accepting()
  })`);
  console.log('  提交后学生端状态：' + afterSubmit);
  const teacherFeed = await evalIn(teacher, `JSON.stringify((CI.classroom.box(CI.store.get()).feed || []).slice(0, 2).map(function(f){ return f.text; }))`);
  console.log('  教师端实时流：' + teacherFeed);
  await shot(stu, path.join(OUT, '24-学生端-已提交.png'));

  // 「我们组」标签
  await evalIn(stu, '(function(){ var t = [].slice.call(document.querySelectorAll(".van-tab")).filter(function(x){ return x.textContent.indexOf("我们组") >= 0; }); if (t[0]) t[0].click(); return !!t[0]; })()');
  await sleep(900);
  await shot(stu, path.join(OUT, '25-学生端-我们组.png'));

  const info = await evalIn(stu, `JSON.stringify({
    teamId: CIStudent.state().teamId,
    connected: CIStudent.state().connected,
    submitted: !!CIStudent.state().submitted,
    myTeam: (function(){ var t = CIStudent.myTeam(); return t ? t.name + ' ' + t.score + ' 分' : null; })()
  })`);
  console.log('\n学生端状态：' + info);

  const filtered = errors.filter((e) => !/favicon|ERR_UNSAFE_PORT/.test(e));
  console.log('页面错误：' + (filtered.length ? filtered.length + ' 条' : '无'));
  filtered.slice(0, 6).forEach((e) => console.log('  · ' + e.slice(0, 160)));
  ws.close();
  cleanup();
  process.exit(filtered.length ? 1 : 0);
})().catch((e) => {
  console.error('❌ 学生端截图失败：' + (e && e.stack ? e.stack.split('\n').slice(0, 5).join('\n') : e));
  process.exit(1);
});
