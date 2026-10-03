/*!
 * tests/shot-tauri.js — 截取 **Tauri 桌面应用的真实界面**（不是浏览器里的同一套页面）
 *
 * 原理：Tauri v2 在 Windows 上用 WebView2；给应用设环境变量
 *   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333
 * 启动后，WebView2 会开一个 CDP 端点，于是可以像驱动 Chrome 一样
 * 对**应用窗口内的真实渲染**截图（PrintWindow 对 GPU 合成的 WebView2 只能拿到黑屏）。
 *
 *   node tests/shot-tauri.js [port] [outDir]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.argv[2] || 9333);
const OUT = path.resolve(process.argv[3] || path.join(ROOT, 'docs', 'clients', 'images', 'shell-teacher'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 应用内的页面（v5 重构后：客户端也套 **Vue 构建产物**，与网页版同一套界面，
 * 用 hash 路由切换，不再是旧版的 data-tab 面板）。
 */
const ROUTES = [
  ['/', '01-桌面应用-概览', '概览：桌面应用与网页版同一套 Vue 界面'],
  ['/class', '02-桌面应用-班级与积分', '班级与积分：应用内直接建名单、记分'],
  ['/classroom', '03-桌面应用-课堂协同', '课堂协同：桌面应用内置 Rust 枢纽，学生端与大屏可直接连它'],
  ['/bank', '04-桌面应用-题库中心', '题库中心'],
  ['/analysis', '05-桌面应用-学情分析', '学情分析（统计来源标注为 Rust 核心时才真正走核心）'],
  ['/settings/storage', '06-桌面应用-存储与备份', '存储与备份：应用内直接读写本机 SQLite（%APPDATA%）'],
  ['/settings/network', '07-桌面应用-组网', '组网（EasyTier）：客户端独有能力，浏览器做不到'],
  ['/settings/about', '08-桌面应用-关于', '关于：外壳=Tauri，存储后端=SQLite']
];

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
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
    });
    return c;
  }
  send(method, params, timeout) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP 超时：' + method)); } }, timeout || 20000);
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('页面异常：' + (r.exceptionDetails.text || ''));
    return r.result ? r.result.value : undefined;
  }
  async waitFor(expr, label, ms) {
    const end = Date.now() + (ms || 20000);
    for (;;) {
      let v = false;
      try { v = await this.eval(expr); } catch (e) { v = false; }
      if (v) return true;
      if (Date.now() > end) throw new Error('等待超时：' + label);
      await sleep(250);
    }
  }
}

(async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  let list = null;
  for (let i = 0; i < 60 && !list; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + PORT + '/json/list');
      if (r.ok) list = await r.json();
    } catch (e) { /* 还没起来 */ }
    if (!list) await sleep(500);
  }
  if (!list) throw new Error('WebView2 调试端口未就绪（应用启动时是否设了 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS？）');

  const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!page) throw new Error('没有找到页面目标：' + JSON.stringify(list.map((t) => t.type)));
  console.log('目标页面：' + page.url);

  const cdp = await CDP.connect(page.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  // 等应用界面挂载（v5：客户端也是 Vue + Element Plus）
  await cdp.waitFor('document.querySelector(".el-menu") !== null', '应用界面挂载');
  await cdp.waitFor('!!(window.CI && CI.store)', '领域层加载');
  await sleep(2500);
  console.log('已加载：' + await cdp.eval('document.title'));

  // 关掉可能弹出的确认框，保证截图确定性
  const dismiss = async () => {
    await cdp.eval(`(function(){
      var x = document.querySelector('.el-message-box__headerbtn'); if (x) { x.click(); return true; }
      return false;
    })()`).catch(() => {});
    await sleep(200);
  };

  // 灌入模拟数据（用户已授权用模拟数据做演示），让应用界面有真实内容可看
  const SEED = `
  (function () {
    var S = CI.store;
    S.replaceState(S.defaultState());
    S.updateSettings({ courseName: '24 机械高考班 · 数学公开课' });
    S.addTeam('绿队'); S.addTeam('黄队');
    var t = S.get().teams;
    ['张伟 李娜 王强 刘洋', '赵磊 孙悦 周涛 吴迪', '郑爽 冯超 陈曦 褚岩', '卫兰 蒋明 沈月 韩雪']
      .forEach(function (line, i) { if (t[i]) S.addStudentsBulk(line, t[i].id); });
    var QS = [
      ['basic', '已知集合 A = {1,2,3}，则 A 的子集个数是？', 'B', ['6','8','9'], ['集合与逻辑'], '课本 P12 例 3'],
      ['basic', '函数 y = x² − 2x + 3 的对称轴方程是？', 'A', ['x = 1','x = −1','x = 2'], ['函数与导数'], '同步练习 3-2'],
      ['advanced', '求函数 f(x) = x³ − 3x 在区间 [−2, 2] 上的最大值与最小值。', 'max = 2，min = −2', [], ['函数与导数'], '月考改编'],
      ['advanced', '已知 sinα + cosα = 1/5，α ∈ (0, π)，求 tanα 的值。', '−4/3', [], ['三角函数'], '校本练习'],
      ['extended', '某工厂要建造一个容积为 8 m³ 的无盖长方体水池，求用料最省时的底面边长。', '2 m', [], ['立体几何'], '建模作业'],
      ['improve', '设数列 {aₙ} 满足 a₁ = 1，aₙ₊₁ = 2aₙ + 1，求通项公式并证明。', 'aₙ = 2ⁿ − 1', [], ['数列'], '竞赛预热']
    ];
    var bank = QS.map(function (r) {
      return S.addQuestion({ tier: r[0], stem: r[1], answer: r[2], options: r[3], tags: r[4], source: r[5] });
    });
    var quiz = S.createQuiz('第 3 次课 · 函数与集合随堂测',
      [bank[0].id, bank[1].id, bank[2].id, bank[3].id, bank[4].id, bank[5].id], '重点讲评拔高题');
    S.setCurrentQuiz(quiz.id);
    var stu = S.get().students;
    function rec(i, qi, r) { S.recordResult({ sid: stu[i].id, qid: bank[qi].id, result: r, quizId: quiz.id, source: 'quiz' }); }
    rec(0,0,'correct'); rec(0,1,'correct'); rec(0,2,'correct'); rec(0,3,'half'); rec(0,4,'wrong');
    rec(1,0,'correct'); rec(1,1,'correct'); rec(1,2,'correct'); rec(1,3,'correct'); rec(1,4,'correct'); rec(1,5,'half');
    rec(2,0,'correct'); rec(2,1,'half'); rec(2,2,'wrong'); rec(2,3,'wrong'); rec(2,4,'wrong');
    rec(3,0,'correct'); rec(3,1,'correct'); rec(3,2,'half'); rec(3,3,'wrong'); rec(3,4,'half');
    rec(4,0,'correct'); rec(4,2,'correct'); rec(4,3,'half'); rec(4,4,'correct'); rec(4,5,'wrong');
    rec(5,1,'correct'); rec(5,3,'correct'); rec(5,4,'half'); rec(5,5,'wrong'); rec(5,0,'correct');
    rec(6,0,'half'); rec(6,1,'wrong'); rec(6,2,'correct'); rec(6,3,'half'); rec(6,4,'correct');
    rec(8,1,'correct'); rec(8,2,'correct'); rec(8,3,'correct'); rec(8,4,'half'); rec(8,5,'half');
    rec(12,0,'correct'); rec(12,1,'correct'); rec(12,2,'half'); rec(12,3,'half'); rec(12,4,'correct');
    S.setRuntime({ quizId: quiz.id, qid: bank[0].id });
    CI.classroom.setPhase('question');
    CI.classroom.setAccepting(true);
    return S.get().students.length;
  })()`;

  await cdp.eval(SEED);
  await sleep(1200);
  const before = await cdp.eval('JSON.stringify({course: (CI.store.get().settings||{}).courseName, students: CI.store.get().students.length, bank: CI.store.get().bank.length, quiz: (CI.store.get().currentQuizId||null) !== null})');
  console.log('应用内数据（模拟）：' + before);
  await dismiss();

  for (const [route, name, caption] of ROUTES) {
    await cdp.eval('location.hash = ' + JSON.stringify('#' + route));
    await sleep(1100);
    await dismiss();
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' }, 30000);
    const file = path.join(OUT, name + '.png');
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    console.log('  📷 ' + path.relative(ROOT, file) + '  (' + Math.round(fs.statSync(file).size / 1024) + ' KB)  ' + caption);
  }

  cdp.ws.close();
  console.log('\n完成 → ' + path.relative(ROOT, OUT));
  process.exit(0);
})().catch((e) => {
  console.error('❌ ' + (e && e.message ? e.message : e));
  process.exit(1);
});
