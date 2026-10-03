/*!
 * tests/shots-docs.js — 为「客户端说明文档」批量产出截图（三套界面）
 *
 *   node tests/shots-docs.js                 # 三套界面全跑
 *   node tests/shots-docs.js --only=teacher  # 只跑教师端
 *   node tests/shots-docs.js --only=student
 *   node tests/shots-docs.js --only=stage
 *
 * 特点：
 *   · 自己起一个**隔离枢纽**（临时 DATA_DIR + 空闲端口），不碰仓库的 data/ 与 8080；
 *   · 灌入一整套模拟数据（4 支队 / 16 名学生 / 10 道题 / 1 套卷 / 若干作答记录）；
 *   · 尽量通过**真实点击**驱动界面（按按钮文字找元素），少用后门；
 *   · 输出 docs/clients/images/<group>/<name>.png，并写 manifest.json 供文档引用。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'clients', 'images');
const ROOM = 'docs';
const CDP_PORT = 9447;
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').replace('--only=', '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const manifest = [];
const problems = [];

function want(group) { return !ONLY || ONLY === group; }

/** 清单按 group/file 合并写回，这样分几次跑（--only=…）也不会互相覆盖 */
function saveManifest() {
  const file = path.join(OUT, 'manifest.json');
  let old = [];
  try { old = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { old = []; }
  const map = new Map();
  old.concat(manifest).forEach((m) => map.set(m.group + '/' + m.file, m));
  const out = [...map.values()].sort((a, b) =>
    a.group.localeCompare(b.group) || a.file.localeCompare(b.file, 'zh'));
  fs.writeFileSync(file, JSON.stringify(out, null, 2), 'utf8');
  return out.length;
}

/* ------------------------------------------------------------------ *
 * 浏览器（CDP）
 * ------------------------------------------------------------------ */
class Browser {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.errors = [];
    ws.on('message', (raw) => {
      let m = null;
      try { m = JSON.parse(raw); } catch (e) { return; }
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) reject(new Error(m.error.message)); else resolve(m.result);
      } else if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        this.errors.push((d.exception && d.exception.description) || d.text);
      } else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
        this.errors.push(m.params.entry.text);
      }
    });
  }
  static async connect(url) {
    const ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 128 * 1024 * 1024 });
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
      }, timeoutMs || 20000);
    });
  }
  async newPage(url, width, height, mobile) {
    const t = await this.send('Target.createTarget', { url: 'about:blank' });
    const a = await this.send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
    const sid = a.sessionId;
    await this.send('Runtime.enable', {}, sid);
    await this.send('Log.enable', {}, sid);
    await this.send('Page.enable', {}, sid);
    await this.send('Emulation.setDeviceMetricsOverride', {
      width: width || 1600, height: height || 1000, deviceScaleFactor: 1, mobile: !!mobile
    }, sid);
    this.ws.on('message', (raw) => {
      let m = null;
      try { m = JSON.parse(raw); } catch (e) { return; }
      if (m.method === 'Page.javascriptDialogOpening' && m.sessionId === sid) {
        this.send('Page.handleJavaScriptDialog', { accept: true }, sid).catch(() => {});
      }
    });
    await this.send('Page.navigate', { url }, sid);
    return sid;
  }
  async eval(sid, expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sid);
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error('页面内异常：' + ((d.exception && d.exception.description) || d.text));
    }
    return r.result ? r.result.value : undefined;
  }
  async waitFor(sid, expression, label, timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 15000);
    for (;;) {
      let v = false;
      try { v = await this.eval(sid, expression); } catch (e) { v = false; }
      if (v) return true;
      if (Date.now() > deadline) throw new Error('等待超时：' + (label || expression));
      await sleep(180);
    }
  }
  close() { try { this.ws.close(); } catch (e) { /* 忽略 */ } }
}

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */
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
  for (let i = 0; i < (tries || 60); i++) {
    try { const r = await fetch(url); if (r.ok) return await r.json(); } catch (e) { /* 等 */ }
    await sleep(300);
  }
  throw new Error('等待超时：' + url);
}

/** 点一个「文字里含 text」的元素（默认 button），模拟真人点击 */
async function clickText(b, sid, text, sel) {
  const ok = await b.eval(sid, `(function(){
    var els = document.querySelectorAll(${JSON.stringify(sel || 'button, .el-button, .van-button, .el-menu-item, .el-radio-button__inner, .el-tabs__item')});
    for (var i = 0; i < els.length; i++) {
      var t = (els[i].textContent || '').replace(/\\s+/g, '');
      if (t.indexOf(${JSON.stringify(text.replace(/\s+/g, ''))}) >= 0 && !els[i].disabled) { els[i].click(); return true; }
    }
    return false;
  })()`);
  if (!ok) problems.push('点不到「' + text + '」');
  await sleep(400);
  return ok;
}

async function shot(b, sid, group, name, caption) {
  const dir = path.join(OUT, group);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name + '.png');
  let r = null;
  for (let i = 0; i < 2 && !r; i++) {
    try {
      r = await b.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, sid, 30000);
    } catch (e) { if (i === 1) throw e; await sleep(800); }
  }
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  const kb = Math.round(fs.statSync(file).size / 1024);
  manifest.push({ group, file: name + '.png', caption });
  console.log('  📷 ' + group + '/' + name + '.png  (' + kb + ' KB)  ' + caption);
}

/* ------------------------------------------------------------------ *
 * 模拟数据
 * ------------------------------------------------------------------ */
const SEED = `
(function () {
  var S = CI.store;
  S.replaceState(S.defaultState());
  S.updateSettings({
    courseName: '24 机械高考班 · 数学公开课',
    halfRatio: 0.5, wrongPenalty: 0, fastBonus: 1,
    weakThreshold: 0.6, strongThreshold: 0.85, minSample: 5
  });

  /* 四支队（默认只有红/蓝，补绿/黄） */
  S.addTeam('绿队');
  S.addTeam('黄队');
  var teams = S.get().teams;

  /* 16 名学生，每队 4 人 */
  var NAMES = [
    '张伟 李娜 王强 刘洋',
    '赵磊 孙悦 周涛 吴迪',
    '郑爽 冯超 陈曦 褚岩',
    '卫兰 蒋明 沈月 韩雪'
  ];
  NAMES.forEach(function (line, i) { if (teams[i]) S.addStudentsBulk(line, teams[i].id); });

  /* 题库 10 题 */
  var QS = [
    ['basic','已知集合 A = {1,2,3}，则 A 的子集个数是？','B',['6','8','9'],['集合与逻辑'],'课本 P12 例 3',''],
    ['basic','函数 y = x² − 2x + 3 的对称轴方程是？','A',['x = 1','x = −1','x = 2'],['函数与导数'],'同步练习 3-2',''],
    ['basic','等差数列 {aₙ} 中 a₁ = 2，d = 3，则 a₅ 等于？','B',['11','14','17'],['数列'],'课本 P38 练习 1',''],
    ['advanced','求函数 f(x) = x³ − 3x 在区间 [−2, 2] 上的最大值与最小值。','max = 2，min = −2',[],['函数与导数'],'月考改编','先求导找驻点，再比较端点值'],
    ['advanced','已知 sinα + cosα = 1/5，α ∈ (0, π)，求 tanα 的值。','−4/3',[],['三角函数'],'校本练习','两边平方求出 sinαcosα，再联立求解'],
    ['advanced','在 △ABC 中，a = 3，b = 4，∠C = 60°，则 c 等于？','A',['√13','√37','5'],['三角函数'],'课本 P52 例 2','余弦定理 c² = a² + b² − 2ab·cosC'],
    ['extended','某工厂要建造一个容积为 8 m³ 的无盖长方体水池，求用料最省时的底面边长。','2 m',[],['立体几何'],'建模作业','设底边边长 x，表面积 S = x² + 32/x，用均值不等式'],
    ['extended','已知圆 x² + y² = 4 与直线 y = x + b 相交，求 b 的取值范围。','−2√2 < b < 2√2',[],['解析几何'],'单元测验','圆心到直线距离小于半径'],
    ['improve','设数列 {aₙ} 满足 a₁ = 1，aₙ₊₁ = 2aₙ + 1，求通项公式并证明。','aₙ = 2ⁿ − 1',[],['数列'],'竞赛预热','构造等比数列 aₙ + 1'],
    ['improve','请说明你解决本题的完整思路（口述或写下关键步骤）。','',[],['综合'],'课堂口述','主观题，教师端待确认后判定']
  ];
  var bank = QS.map(function (r) {
    return S.addQuestion({ tier: r[0], stem: r[1], answer: r[2], options: r[3], tags: r[4], source: r[5], note: r[6] });
  });

  /* 一套试卷：6 题 */
  var quiz = S.createQuiz('第 3 次课 · 函数与集合随堂测',
    [bank[0].id, bank[1].id, bank[3].id, bank[4].id, bank[6].id, bank[8].id], '重点讲评拔高题与扩展题');
  S.setCurrentQuiz(quiz.id);

  /* 作答记录：造出不同"能力画像"，让学情分析/雷达图有内容；
     选择题额外补上「学生选了什么」，供大屏的「本题选项分布」与学生端错选分析使用 */
  function rec(i, qi, result) {
    var stu = S.get().students[i];
    var pick = '';
    if (qi === 0) pick = ['B', 'B', 'B', 'A', 'C', 'B', 'C', 'B', 'A', 'B', 'B', 'C', 'B', 'A', 'B', 'C'][i % 16];
    else if (qi === 1) pick = ['A', 'A', 'B', 'A', 'C', 'A', 'B', 'A', 'A', 'C', 'A', 'B', 'A', 'A', 'C', 'B'][i % 16];
    else if (qi === 2) pick = ['B', 'B', 'A', 'B', 'C', 'B', 'A', 'B', 'B', 'C', 'B', 'A', 'B', 'B', 'C', 'A'][i % 16];
    else if (qi === 5) pick = ['A', 'A', 'B', 'A', 'C', 'A', 'A', 'B', 'A', 'C', 'A', 'B', 'A', 'A', 'C', 'B'][i % 16];
    S.recordResult({ sid: stu.id, qid: bank[qi].id, result: result, quizId: quiz.id, source: 'quiz', picked: pick });
  }
  // 张伟（0）：四题型都碰，整体不错
  rec(0,0,'correct'); rec(0,1,'correct'); rec(0,3,'correct'); rec(0,4,'half'); rec(0,6,'correct'); rec(0,8,'wrong');
  // 李娜（1）：几乎全对 → 六边形
  rec(1,0,'correct'); rec(1,1,'correct'); rec(1,2,'correct'); rec(1,3,'correct'); rec(1,4,'correct'); rec(1,6,'correct'); rec(1,8,'half');
  // 王强（2）：基础尚可、拔高以上偏弱 → 需要关注
  rec(2,0,'correct'); rec(2,1,'half'); rec(2,3,'wrong'); rec(2,4,'wrong'); rec(2,6,'wrong'); rec(2,8,'wrong');
  // 刘洋（3）：中等
  rec(3,0,'correct'); rec(3,1,'correct'); rec(3,3,'half'); rec(3,4,'wrong'); rec(3,6,'half');
  // 赵磊（4）
  rec(4,0,'correct'); rec(4,2,'correct'); rec(4,3,'half'); rec(4,4,'correct'); rec(4,6,'wrong');
  // 孙悦（5）
  rec(5,1,'correct'); rec(5,2,'correct'); rec(5,4,'correct'); rec(5,6,'half'); rec(5,8,'wrong');
  // 周涛（6）
  rec(6,0,'half'); rec(6,1,'wrong'); rec(6,3,'correct'); rec(6,4,'half'); rec(6,6,'correct');
  // 吴迪（7）
  rec(7,0,'correct'); rec(7,2,'correct'); rec(7,4,'half'); rec(7,6,'wrong'); rec(7,8,'wrong');
  // 郑爽（8）
  rec(8,1,'correct'); rec(8,3,'correct'); rec(8,4,'correct'); rec(8,6,'half'); rec(8,8,'half');
  // 冯超（9）
  rec(9,0,'correct'); rec(9,1,'half'); rec(9,2,'correct'); rec(9,6,'half'); rec(9,8,'wrong');
  // 陈曦（10）
  rec(10,3,'correct'); rec(10,4,'correct'); rec(10,6,'correct'); rec(10,8,'half'); rec(10,0,'correct');
  // 褚岩（11）：样本不足（只有 2 条）
  rec(11,0,'correct'); rec(11,1,'half');
  // 卫兰（12）
  rec(12,0,'correct'); rec(12,1,'correct'); rec(12,3,'half'); rec(12,4,'half'); rec(12,6,'correct'); rec(12,8,'wrong');
  // 蒋明（13）：基础很稳、难题碰不动 → 偏科
  rec(13,0,'correct'); rec(13,1,'correct'); rec(13,2,'correct'); rec(13,3,'wrong'); rec(13,4,'wrong'); rec(13,8,'wrong');
  // 沈月（14）
  rec(14,0,'half'); rec(14,1,'wrong'); rec(14,3,'wrong'); rec(14,4,'half'); rec(14,6,'half');
  // 韩雪（15）只答一次 → 样本不足
  rec(15,0,'correct');

  /* 一次手动加分（体现"课堂纪律加分"这类非答题记分） */
  S.addManual(S.get().students[4].id, 2, '课堂纪律加分');

  /* 当前题设为第一题 */
  S.setRuntime({ quizId: quiz.id, qid: bank[0].id });
  return { teams: teams.length, students: S.get().students.length, bank: bank.length, quiz: quiz.id };
})()
`;

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */
(async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  console.log('输出目录：' + path.relative(ROOT, OUT) + '\n');

  const port = await freePort(8600 + Math.floor(Math.random() * 200));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-docs-'));
  const profile = path.join(os.tmpdir(), 'ci-docs-profile-' + Date.now());
  fs.mkdirSync(profile, { recursive: true });

  const base = 'http://127.0.0.1:' + port;
  /* v5：枢纽以 **Rust 核心**为准（ci-hub-server）。截图必须走它 ——
     否则界面上的「统计来源」会退回「本地参考实现」，拍出来的就不是 v5 的真实形态。
     找不到 Rust 枢纽时退回 Node 版（功能可用，只是领域端点缺失）。*/
  const rustName = process.platform === 'win32' ? 'ci-hub-server.exe' : 'ci-hub-server';
  const rustHub = ['debug', 'release']
    .map((p) => path.join(ROOT, 'target', p, rustName))
    .find((p) => fs.existsSync(p));
  const hub = rustHub
    ? spawn(rustHub, [], {
        cwd: ROOT,
        env: Object.assign({}, process.env, {
          PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, STATIC_ROOT: ROOT
        }),
        stdio: 'ignore'
      })
    : spawn(process.execPath, [path.join(ROOT, 'sync-server.js')], {
        cwd: ROOT,
        env: Object.assign({}, process.env, { PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir }),
        stdio: 'ignore'
      });
  await waitJson(base + '/health');
  console.log('隔离枢纽：' + base + '（' + (rustHub ? 'Rust 核心 ci-hub-server' : 'Node sync-server.js') +
    '，数据目录 ' + dataDir + '）\n');

  const bin = [
    process.env.CHROME_PATH || '',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
  ].filter(Boolean).find((p) => fs.existsSync(p));
  if (!bin) throw new Error('未找到 Chrome/Edge');

  const chrome = spawn(bin, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-background-networking', '--hide-scrollbars',
    '--force-device-scale-factor=1', '--window-size=1600,1000',
    '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + profile, 'about:blank'
  ], { stdio: 'ignore', detached: true });

  const cleanup = () => {
    try {
      if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' });
      else chrome.kill('SIGKILL');
    } catch (e) { /* 忽略 */ }
    try { hub.kill(); } catch (e) { /* 忽略 */ }
    try { spawnSync(process.execPath, ['-e', 'setTimeout(function(){},1200)'], { stdio: 'ignore' }); } catch (e) { /* 忽略 */ }
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 }); } catch (e) { /* 忽略 */ }
    try { fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 3 }); } catch (e) { /* 忽略 */ }
  };
  process.on('exit', cleanup);

  const version = await waitJson('http://127.0.0.1:' + CDP_PORT + '/json/version');
  console.log('浏览器：' + version.Browser + '\n');
  const b = await Browser.connect(version.webSocketDebuggerUrl);

  // v5 重构后：四个入口统一为 Vue 构建产物，直接挂在根路径
  // （/admin.html 教师端、/join 学生端、/stage 大屏；/next/* 仍作为别名保留）
  const T = base + '/admin.html?room=' + ROOM + '#/';
  const S = base + '/join?room=' + ROOM;
  const G = base + '/stage?room=' + ROOM;

  try {
    /* ============================================================ *
     * 教师端
     * ============================================================ */
    let teacher = null;
    let teamIds = [];
    if (want('teacher') || want('student') || want('stage')) {
      console.log('▶ 教师端：加载 + 灌数据');
      teacher = await b.newPage(T, 1600, 1000);
      await b.waitFor(teacher, 'document.querySelector(".el-menu") !== null', '教师端侧边栏');
      await b.waitFor(teacher, '!!(window.CI && CI.store && CI.classroom)', '领域层');
      await sleep(2600);   // 等 storage.bootstrap 落定，避免它反过来覆盖种子
      const seeded = await b.eval(teacher, SEED);
      console.log('  种子：' + JSON.stringify(seeded));
      await sleep(900);
      // 强制推一份给枢纽，学生端/大屏才有数据
      await b.eval(teacher, 'CI.sync.push(true); true');
      await sleep(900);
      teamIds = await b.eval(teacher, 'CI.store.get().teams.map(function(t){return t.id;})');

      const goto = async (hash, ms) => {
        await b.eval(teacher, 'location.hash = ' + JSON.stringify(hash));
        await sleep(ms || 800);
        await b.eval(teacher, `(function(){
          document.querySelectorAll('.el-message-box__headerbtn, .el-dialog__headerbtn').forEach(function(x){});
          return true;
        })()`).catch(() => {});
      };
      const dismiss = async () => {
        await b.eval(teacher, `(function(){
          var x = document.querySelector('.el-message-box__headerbtn'); if (x) x.click();
          return true;
        })()`).catch(() => {});
        await sleep(250);
      };

      if (want('teacher')) {
        console.log('\n▶ 教师端界面截图');
        await dismiss();
        await shot(b, teacher, 'teacher', '01-概览', '概览：课程总览、快捷入口、课堂状态');

        await goto('/class');
        await shot(b, teacher, 'teacher', '02-班级与积分', '班级与积分：队伍卡片 + 学生名单 + 快捷加分');

        await clickText(b, teacher, '批量添加学生');
        await sleep(500);
        await b.eval(teacher, `(function(){
          var ta = document.querySelector('.el-dialog textarea');
          if (ta) {
            var setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
            setter.call(ta, '林小雨 何俊 罗芷若 谢天成');
            ta.dispatchEvent(new Event('input', { bubbles: true }));
          }
          return !!ta;
        })()`);
        await sleep(400);
        await shot(b, teacher, 'teacher', '03-班级-批量添加学生', '批量添加学生：粘贴名单（空格/逗号/换行分隔）并选队伍');
        await clickText(b, teacher, '取消');
        await sleep(400);

        await clickText(b, teacher, '明细', '.el-button');
        await sleep(700);
        await shot(b, teacher, 'teacher', '04-班级-学生明细', '点「明细」查看某个学生的逐条记分流水');
        await b.eval(teacher, `(function(){
          var x = document.querySelector('.el-drawer__close-btn'); if (x) x.click();
          var y = document.querySelector('.el-overlay'); 
          return true;
        })()`).catch(() => {});
        await sleep(600);

        await goto('/roll');
        await clickText(b, teacher, '抽一位');
        await sleep(2600);
        await shot(b, teacher, 'teacher', '05-随机点名', '随机点名：姓名滚动后定人，右侧直接判分（1/2/3/4）');
        await b.eval(teacher, 'CI.rollcall && CI.rollcall.render && CI.rollcall.render(); true').catch(() => {});

        await goto('/bank');
        await shot(b, teacher, 'teacher', '06-题库-题目列表', '题库中心 · 题目列表：搜索、筛选、题型与标签');

        await goto('/bank/new');
        await b.eval(teacher, `(function(){
          var inputs = document.querySelectorAll('.el-main input, .el-main textarea');
          return inputs.length;
        })()`);
        await sleep(400);
        await shot(b, teacher, 'teacher', '07-题库-新建题目', '新建题目：题干、题型、作答方式、选项、答案、标签');

        await goto('/bank/import');
        await clickText(b, teacher, '填入示例');
        await sleep(900);
        await shot(b, teacher, 'teacher', '08-题库-批量导入', '批量导入：粘贴文本（题干 | 选项 ; 选项 | 答案）→ 实时预览 → 导入');

        await goto('/bank/tiers');
        await shot(b, teacher, 'teacher', '09-题库-题型与权重', '题型与权重：基础 +3 / 拔高 +5 / 扩展 +8 / 提升 +10，可改可增');

        await goto('/bank/tags');
        await shot(b, teacher, 'teacher', '10-题库-标签管理', '标签管理：知识点标签与题量统计');

        await goto('/papers');
        await shot(b, teacher, 'teacher', '11-试卷列表', '试卷中心：套卷列表、题量、总分、设为当前');

        const quizId = await b.eval(teacher, 'CI.store.get().currentQuizId');
        await goto('/papers/' + quizId, 1200);
        await shot(b, teacher, 'teacher', '12-组卷编辑器', '组卷编辑器：左侧题库勾选加入，右侧试卷题目可排序/移除');

        // v5 新增：一键重测卷（错题重做）—— 阈值 35%，依据提取练习效应
        await clickText(b, teacher, '一键重测卷');
        await sleep(1400);
        await shot(b, teacher, 'teacher', '13-组卷编辑器-一键重测卷', '一键重测卷（错题重做）：把答对率低于 35% 的题单独组一套新卷');
        await b.eval(teacher, `(function(){
          var x = document.querySelector('.el-message-box__headerbtn'); if (x) x.click();
          return true;
        })()`);
        await sleep(700);
        // 一键重测卷会把"当前试卷"切到新建的空卷上；后续要拍学情分析/大屏，
        // 必须切回原来那套有数据的卷，否则统计全是 0（这不是 bug，是它的正常行为）。
        await b.eval(teacher, `(function(){
          var S = CI.store;
          S.setCurrentQuiz(${JSON.stringify(quizId)});
          S.setRuntime({ quizId: ${JSON.stringify(quizId)}, qid: S.get().bank[0].id });
          return S.get().currentQuizId;
        })()`);
        await sleep(700);

        await goto('/analysis', 1400);
        await shot(b, teacher, 'teacher', '14-学情分析', '学情分析：能力评价雷达 + 综合分/覆盖率/均衡度 + 分题型掌握度');

        // 往下滚，露出「综合评价总览」与「统计来源」标注
        await b.eval(teacher, `(function(){
          var m = document.querySelector('.el-main'); if (m) m.scrollTop = 640;
          return true;
        })()`);
        await sleep(1000);
        await shot(b, teacher, 'teacher', '15-学情分析-综合评价总览', '综合评价总览：队伍在前、学生按综合分排序；下方是各题型作答分布与正确率');
        await b.eval(teacher, `(function(){
          var m = document.querySelector('.el-main'); if (m) m.scrollTop = 0;
          return true;
        })()`);
        await sleep(600);

        await clickText(b, teacher, '生成班级小结');
        await sleep(1200);
        // 小结文本在页面下方，视口截图前先滚过去，否则两张图会一模一样
        await b.eval(teacher, `(function(){
          var m = document.querySelector('.el-main');
          if (m) m.scrollTop = m.scrollHeight;
          window.scrollTo(0, document.body.scrollHeight);
          return true;
        })()`);
        await sleep(800);
        await shot(b, teacher, 'teacher', '16-学情分析-学生明细与班级小结', '「统计来源：Rust 核心」+ 学生明细（含综合表现分）+ 个人报告 + 一键生成的班级小结');
        await b.eval(teacher, `(function(){
          var m = document.querySelector('.el-main'); if (m) m.scrollTop = 0; return true;
        })()`);
        await sleep(500);

        await goto('/board', 1000);
        await shot(b, teacher, 'teacher', '17-排行榜与导出', '排行榜与导出：个人榜 + 队伍榜 + CSV/JSON 导出');

        await goto('/settings/storage', 1200);
        await shot(b, teacher, 'teacher', '18-设置-存储与备份', '存储与备份：显示 SQLite 后端、库文件位置、记录数，可导出/导入');

        await goto('/settings/network', 1000);
        await shot(b, teacher, 'teacher', '19-设置-组网', '组网（EasyTier）：跨网段上课用，含「上课前自检」');

        await goto('/settings/room', 1000);
        await shot(b, teacher, 'teacher', '20-设置-房间与大屏', '房间与大屏：房间号、大屏地址、学生端地址与二维码');

        await goto('/settings/about', 900);
        await shot(b, teacher, 'teacher', '21-设置-关于与文档', '关于与文档：外壳/存储后端/协议版本/数据版本');

        // 快捷键面板（按 ? 打开）
        await b.eval(teacher, `(function(){
          window.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true }));
          return true;
        })()`);
        await sleep(700);
        await shot(b, teacher, 'teacher', '22-快捷键面板', '按 ? 呼出快捷键面板（Alt+1~6 跳页，点名页 1/2/3/4 判分）');
        await b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', windowsVirtualKeyCode: 27 }, teacher).catch(() => {});
        await sleep(500);
      }
    }

    /* ============================================================ *
     * 学生端（先开三页，让「在线小组」有内容）
     * ============================================================ */
    let stu = null;
    if (want('student') || want('stage')) {
      console.log('\n▶ 学生端：三支队入座（供在线状态）');
      const pages = [];
      for (let i = 0; i < 3; i++) {
        const p = await b.newPage(S + '&team=' + teamIds[i], 414, 896, true);
        await b.waitFor(p, 'document.querySelector(".van-nav-bar") !== null', '学生端 ' + i);
        pages.push(p);
      }
      stu = pages[0];
      await sleep(1500);
      console.log('  已开 ' + pages.length + ' 个学生端页签');
    }

    /* ============================================================ *
     * 教师端 · 课堂协同（此时有在线队伍）
     * ============================================================ */
    if (want('teacher') && teacher) {
      console.log('\n▶ 教师端：课堂协同（含在线小组）');
      await b.eval(teacher, 'location.hash = "#/classroom"; true');
      await sleep(1200);
      await shot(b, teacher, 'teacher', '23-课堂协同', '课堂协同：环节切换、接收作答、二维码入座、在线小组、实时流');

      // 出题 + 开始接收 + 计时
      await b.eval(teacher, `(function(){
        var S = CI.store, q = S.get().bank[0];
        S.setRuntime({ qid: q.id });
        CI.classroom.setPhase('question');
        CI.classroom.setAccepting(true);
        CI.classroom.setTimer(120, '随堂练习');
        return true;
      })()`);
      await sleep(1400);
      await shot(b, teacher, 'teacher', '24-课堂协同-出题与倒计时', '设为当前题并「开始接收作答」，可一键发起 30 秒 / 1 分钟 / 2 分钟倒计时');
    }

    /* ============================================================ *
     * 学生端截图
     * ============================================================ */
    if (want('student') && stu) {
      console.log('\n▶ 学生端界面截图');
      // 先把课堂状态摆正（出题 + 接收作答），这样单独跑 --only=student 也能复现
      await b.eval(teacher, `(function(){
        var S = CI.store;
        S.setRuntime({ qid: S.get().bank[0].id });
        CI.classroom.setPhase('question');
        CI.classroom.setAccepting(true);
        CI.classroom.setReveal(false);
        CI.classroom.clearTimer();
        return true;
      })()`);
      await sleep(1500);
      // 重新开一个"干净"的页签做流程截图（不带 team，先看入座页）
      // 注意：student.js 会把已入座的队伍写进 localStorage（ci_team），只清空 URL 参数不够，
      // 必须先把 localStorage 里的队伍清掉，否则新页签会"自动入座"。
      await b.eval(teacher, `(function(){ localStorage.removeItem('ci_team'); return true; })()`);
      const s2 = await b.newPage(S, 414, 896, true);
      await b.waitFor(s2, 'document.querySelector(".van-nav-bar") !== null', '学生端入座页');
      await sleep(1600);
      await shot(b, s2, 'student', '01-入座选组', '学生用手机打开教师机地址 → 选择自己小组入座（无需注册登录）');

      await b.eval(s2, 'CIStudent.pickTeam(' + JSON.stringify(teamIds[0]) + '); true');
      await sleep(1200);
      await shot(b, s2, 'student', '02-已入座-答题页', '入座后进入答题页：本组积分、其他队答对情况、当前题与选项');

      // 已提交 + 公布答案 + 抢答
      // 用**真实点击选项**（而不是直接调 CIStudent.toggleOption）：
      // 后者只改领域层状态、不触发 Vue 的 refresh，界面不会重绘，截图会与上一张完全相同。
      const picked = await b.eval(s2, `(function(){
        var opts = document.querySelectorAll('.opt');
        if (opts.length > 1) { opts[1].click(); return opts.length; }
        return 0;
      })()`);
      if (!picked) problems.push('学生端没有可点的选项');
      await sleep(700);
      await shot(b, s2, 'student', '03-答题-已选选项', '点选项即选中（选择题），确认后点「提交答案」');

      await clickText(b, s2, '提交答案', '.van-button');
      await sleep(1600);
      await shot(b, s2, 'student', '04-已提交', '提交后显示「已提交」，同一题重复提交会被忽略（防重复计分）');

      // 抢答：新版界面里**没有任何视觉反馈**（toast 写的是旧版 DOM #toast，此处不存在），
      // 所以这张截图与「已提交」看起来一样 —— 这正是本轮要记录的体验缺口。
      await b.eval(s2, 'CIStudent.buzz(); true');
      await sleep(900);
      await shot(b, s2, 'student', '05-抢答-界面无变化', '点「⚡ 抢答」后学生端界面没有任何变化（本轮发现：既不置灰也无提示）');
      // 反证：教师端抢答榜确实收到了
      await b.eval(teacher, 'location.hash = "#/classroom"; true');
      await sleep(1300);
      await shot(b, teacher, 'teacher', '25-课堂协同-抢答榜', '反证：学生点抢答后，教师端抢答榜立刻出现该队');
      await b.eval(teacher, `(function(){
        var S = CI.store, q = S.get().bank[0];
        S.setRuntime({ qid: q.id });
        CI.classroom.setPhase('question');
        CI.classroom.setAccepting(true);
        CI.classroom.setReveal(false);
        return true;
      })()`);
      await sleep(1200);

      if (teacher) {
        await b.eval(teacher, 'CI.classroom.setReveal(true); true');
        await sleep(1500);
      }
      await shot(b, s2, 'student', '06-答案已公布', '老师公布答案后，学生端显示正确答案（主观题还会给讲评要点）');

      // 我们组
      await b.eval(s2, `(function(){
        var t = document.querySelectorAll('.van-tab');
        for (var i = 0; i < t.length; i++) if ((t[i].textContent || '').indexOf('我们组') >= 0) { t[i].click(); return true; }
        return false;
      })()`);
      await sleep(900);
      await shot(b, s2, 'student', '07-我们组', '「我们组」页：选谁作答（老师点名时按这个报）+ 组内每人得分');

      // 小组公屏
      const sb = await b.newPage(S + '&team=' + teamIds[0] + '&view=board', 414, 896, true);
      await b.waitFor(sb, 'document.querySelector(".van-nav-bar") !== null', '小组公屏');
      await sleep(1800);
      await shot(b, sb, 'student', '08-小组公屏', '?view=board 小组公屏：放大显示，适合平板挂在墙上');

      // 主观题（切到第 10 题）
      if (teacher) {
        await b.eval(teacher, `(function(){
          var S = CI.store;
          S.setRuntime({ qid: S.get().bank[9].id });
          CI.classroom.setAccepting(true);
          CI.classroom.setReveal(false);
          return true;
        })()`);
        await sleep(1800);
        const s3 = await b.newPage(S + '&team=' + teamIds[1], 414, 896, true);
        await b.waitFor(s3, 'document.querySelector(".van-nav-bar") !== null', '学生端主观题');
        await sleep(1600);
        await shot(b, s3, 'student', '09-主观题作答', '主观题（口述/书写）在手机端录入，提交后进入教师端「待确认」由老师判定');

        // 填空题
        await b.eval(teacher, `(function(){
          var S = CI.store;
          S.setRuntime({ qid: S.get().bank[3].id });
          CI.classroom.setAccepting(true);
          return true;
        })()`);
        await sleep(1500);
        const s4 = await b.newPage(S + '&team=' + teamIds[2], 414, 896, true);
        await b.waitFor(s4, 'document.querySelector(".van-nav-bar") !== null', '学生端填空题');
        await sleep(1600);
        await shot(b, s4, 'student', '10-填空题作答', '填空题：归一化比对，答对自动加分');
      }

      // 连不上教师机 → 引导（必须用**未入座**的页签，按钮只在入座页上）
      await b.eval(teacher, `(function(){ localStorage.removeItem('ci_team'); return true; })()`);
      const s5 = await b.newPage(S, 414, 896, true);
      await b.waitFor(s5, 'document.querySelector(".van-nav-bar") !== null', '学生端引导');
      await sleep(1600);
      // 把地址填进去，让这张图和「入座选组」区分开（否则两张一模一样）
      await b.eval(s5, `(function(){
        var i = document.querySelector('.van-field__control');
        if (!i) return false;
        var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(i, '192.168.0.180');
        i.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`);
      await sleep(500);
      await shot(b, s5, 'student', '12-未入座-填教师机地址', '未入座时也能手输教师机地址（只写 IP 会自动补 :8080）；下面三个按钮用于保存 / 测试 / 排障');
      await clickText(b, s5, '连不上教师机？', '.van-button');
      await sleep(900);
      await shot(b, s5, 'student', '11-连不上教师机-引导', '连不上时的自助指引：同一 WiFi、地址写法、防火墙、组网');
      await b.eval(s5, `(function(){ var b = document.querySelector('.van-dialog__confirm'); if (b) b.click(); return true; })()`).catch(() => {});
      await sleep(600);
    }

    /* ============================================================ *
     * 大屏
     * ============================================================ */
    if (want('stage') && teacher) {
      console.log('\n▶ 大屏截图');
      const stage = await b.newPage(G, 1600, 900);
      await b.waitFor(stage, 'document.querySelector(".stage") !== null', '大屏渲染');
      await sleep(2000);

      // ① 待机
      await b.eval(teacher, `(function(){ CI.classroom.setPhase('idle'); CI.classroom.setReveal(false); CI.classroom.clearTimer(); return true; })()`);
      await sleep(1800);
      await shot(b, stage, 'stage', '01-待机-扫码入座', '待机：超大二维码 + 房间号，学生扫码直接进班');

      // ② 随机点名（抽一位并切环节；大屏要等推送到达才切屏，所以多等一会儿）
      const rollres = await b.eval(teacher, `(function(){
        var res = CI.rollcall.pick(CI.store.get(), {});
        if (res) CI.rollcall.applyPick(res);
        var p = CI.classroom.setPhase('rollcall');
        return JSON.stringify({ phase: p, sid: CI.store.get().runtime.sid });
      })()`);
      console.log('  点名结果：' + rollres);
      await sleep(2600);
      const stagePhase = await b.eval(stage, `(document.querySelector('.phase-pill') || {}).textContent || ''`);
      if (String(stagePhase).indexOf('点名') < 0) problems.push('大屏没有切到随机点名（当前：' + stagePhase + '）');
      await shot(b, stage, 'stage', '02-随机点名', '随机点名：大屏放大显示被点到的同学与所属队伍');

      // ③ 出题作答
      await b.eval(teacher, `(function(){
        var S = CI.store;
        S.setRuntime({ qid: S.get().bank[0].id });
        CI.classroom.setPhase('question');
        CI.classroom.setAccepting(true);
        CI.classroom.setReveal(false);
        return true;
      })()`);
      await sleep(1800);
      await shot(b, stage, 'stage', '03-出题作答', '出题作答：超大题干 + Kahoot 式四色选项块，投影可读');

      // 排序（队伍榜按分排序，让榜有区分度）
      await b.eval(teacher, 'CI.sync.push(true); true');
      await sleep(1200);
      await shot(b, stage, 'stage', '04-队伍实时榜', '出题环节右栏：抢答榜 + 各队实时积分（队伍榜按分排序，1 秒内同步）');

      // ④ 公布答案
      await b.eval(teacher, 'CI.classroom.setReveal(true); true');
      await sleep(1600);
      await shot(b, stage, 'stage', '05-答案已公布', '公布答案后大屏高亮正确选项');

      // ⑤ 倒计时
      await b.eval(teacher, `(function(){ CI.classroom.setReveal(false); CI.classroom.setTimer(60, '随堂练习'); return true; })()`);
      await sleep(1500);
      await shot(b, stage, 'stage', '06-倒计时', '课堂节奏：老师发起后大屏显示倒计时，最后 10 秒变红');

      // ⑥ 点评总结
      await b.eval(teacher, `(function(){ CI.classroom.clearTimer(); CI.classroom.setPhase('review'); return true; })()`);
      await sleep(2000);
      await shot(b, stage, 'stage', '07-点评总结-选项分布与能力雷达', '点评总结：各队答对情况 + 本题选项分布（哪个干扰项最吸引人）+ 能力雷达 + 讲评建议');
    }

    /* ---------- 清单 ---------- */
    const total = saveManifest();
    const errs = b.errors.filter((e) => !/ERR_UNSAFE_PORT|favicon/.test(e));
    console.log('\n本次 ' + manifest.length + ' 张；清单累计 ' + total + ' 张 → ' + path.relative(ROOT, OUT));
    console.log('页面错误：' + (errs.length ? errs.length + ' 条' : '无'));
    errs.slice(0, 6).forEach((e) => console.log('  · ' + String(e).slice(0, 150)));
    if (problems.length) {
      console.log('交互告警 ' + problems.length + ' 条：');
      [...new Set(problems)].slice(0, 12).forEach((p) => console.log('  · ' + p));
    }
    b.close();
    cleanup();
    process.exit(0);
  } catch (e) {
    console.error('\n❌ 失败：' + (e && e.stack ? e.stack.split('\n').slice(0, 5).join('\n') : e));
    saveManifest();
    b.close();
    cleanup();
    process.exit(1);
  }
})();
