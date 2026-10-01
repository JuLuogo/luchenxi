/*!
 * tests/storage.test.js — 教师端持久化适配层测试（浏览器 localStorage / 枢纽 HTTP / Tauri 客户端 三种后端）
 *   node tests/storage.test.js
 *
 * 做法：在 Node 里伪造一个"浏览器窗口"（localStorage + fetch + __TAURI_INTERNALS__），
 * 加载真实的 assets/js/storage.js，验证后端判定、启动合并策略与落库调用参数。
 * 这样即使没有 Rust 工具链，客户端路径的 JS 侧逻辑也能被完整验证。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0;
const failures = [];
function ok(cond, label) { if (cond) passed++; else failures.push(label); }
function eq(a, b, label) { if (JSON.stringify(a) === JSON.stringify(b)) passed++; else failures.push(label + '  →  期望 ' + JSON.stringify(b) + '，实际 ' + JSON.stringify(a)); }
function group(n) { console.log('\n== ' + n + ' =='); }

const STORAGE_SRC = fs.readFileSync(path.join(__dirname, '..', 'assets', 'js', 'storage.js'), 'utf8');

/** 造一个最小可用的 state（与 store.js 的形状一致） */
function makeState(students, updatedAt) {
  return {
    version: 3, rev: 1, updatedAt: updatedAt,
    settings: { courseName: '测试课' },
    tiers: [{ key: 'basic', label: '基础题', weight: 3 }],
    teams: [{ id: 'tm_1', name: '红队' }],
    students: students,
    bank: [], quizzes: [], logs: [], classroom: { pending: [], buzz: [], feed: [] },
    rollcall: { history: [] }, runtime: {}
  };
}

/** 造一个运行环境：window 上挂 localStorage/fetch/__TAURI_INTERNALS__ 与最小 CI */
function makeEnv(opts) {
  opts = opts || {};
  const store = new Map();
  const calls = { invoke: [], fetch: [] };

  const win = {
    location: opts.location || { protocol: 'http:', host: 'localhost:8080', port: '8080', search: '' },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k)
    },
    setTimeout: setTimeout, clearTimeout: clearTimeout,
    fetch: opts.fetch === false ? undefined : function (url, init) {
      calls.invoke.push({ kind: 'fetch', url: url, init: init });
      return opts.fetch ? opts.fetch(url, init) : Promise.reject(new Error('no-fetch'));
    }
  };
  if (opts.tauri) {
    win.__TAURI_INTERNALS__ = {
      invoke: function (cmd, args) {
        calls.invoke.push({ kind: 'invoke', cmd: cmd, args: args });
        return opts.tauri(cmd, args);
      }
    };
  }

  const state = opts.state || makeState([], 0);
  const storeApi = {
    get: () => state,
    allRecords: (s) => (s.quizzes || []).reduce((n, q) => n + (q.records || []).length, 0),
    replaceState: (s) => { calls.replaced = s; Object.keys(state).forEach((k) => delete state[k]); Object.assign(state, s); }
  };

  const ctx = vm.createContext(Object.assign(win, {
    window: win,
    globalThis: win,
    CI: { util: { num: (v, d) => (typeof v === 'number' && isFinite(v) ? v : d) }, store: storeApi },
    console: console
  }));
  win.CI = ctx.CI;
  vm.runInContext(STORAGE_SRC, ctx);
  return { win: win, CI: ctx.CI, calls: calls, state: state, store: store };
}

(async function main() {
  /* ================= 1. 浏览器 + 枢纽（sqlite 后端） ================= */
  group('浏览器 + 枢纽：识别 SQLite 后端');
  {
    const env = makeEnv({
      fetch: (url, init) => {
        if (url.indexOf('/health') >= 0) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, storage: 'sqlite', db: 'classroom.db', counts: { records: 3 } }) });
        }
        if (url.indexOf('/api/state') >= 0 && (!init || init.method !== 'PUT')) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, dump: null }) });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
      }
    });
    const st = await env.CI.storage.probe();
    eq(st.backend, 'sqlite', '探测到 sqlite 后端');
    ok(env.CI.storage.isSqlite(), 'isSqlite() 为真');
    ok(env.CI.storage.describe().indexOf('classroom.db') >= 0, 'describe 提到库文件名');

    // 本地有数据、远端为空 → 应把本地推上去
    env.state.students = [{ id: 'st_1', name: '张三' }];
    env.calls.invoke.length = 0;
    const res = await env.CI.storage.bootstrap();
    eq(res.action, 'seeded-remote', '远端为空时把本地推上去');
    const put = env.calls.invoke.filter((c) => c.kind === 'fetch' && c.init && c.init.method === 'PUT')[0];
    ok(!!put, '确实发出了 PUT /api/state');
    ok(put.url.indexOf('/api/state') >= 0 && put.url.indexOf('room=') >= 0, 'PUT 带上房间号');
    const body = JSON.parse(put.init.body);
    eq(body.dump.students.length, 1, 'PUT 体里带完整状态');
  }

  /* ================= 2. 浏览器 + 远端更新 → 载入远端 ================= */
  group('浏览器：远端更新时载入远端');
  {
    const remote = makeState([{ id: 'st_9', name: '远端学生' }], Date.now());
    const env = makeEnv({
      fetch: (url, init) => {
        if (url.indexOf('/health') >= 0) return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, storage: 'sqlite' }) });
        if (url.indexOf('/api/state') >= 0 && (!init || init.method !== 'PUT')) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, dump: remote, updatedAt: remote.updatedAt }) });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
      }
    });
    await env.CI.storage.probe();
    const res = await env.CI.storage.bootstrap();
    eq(res.action, 'loaded-remote', '远端更新时载入远端');
    eq(env.state.students[0].name, '远端学生', '内存态被远端数据替换');
  }

  /* ================= 3. 没有枢纽 → localStorage 兜底 ================= */
  group('无枢纽：localStorage 兜底');
  {
    const env = makeEnv({ fetch: () => Promise.reject(new Error('ECONNREFUSED')) });
    const st = await env.CI.storage.probe();
    eq(st.backend, 'local', '无枢纽时后端为 local');
    const res = await env.CI.storage.bootstrap();
    eq(res.action, 'local-only', '不阻塞启动');
    ok(env.CI.storage.describe().indexOf('localStorage') >= 0, 'describe 提示用 localStorage');
    ok(env.CI.storage.push(env.state, true) === false, 'local 后端不尝试落库');
  }

  /* ================= 4. Tauri 客户端：走 invoke 直连 SQLite ================= */
  group('Tauri 客户端：invoke 直连 SQLite');
  {
    const saved = makeState([{ id: 'st_1', name: '张三' }], Date.now());
    const env = makeEnv({
      location: { protocol: 'tauri:', host: 'localhost', port: '', search: '' },
      tauri: (cmd, args) => {
        if (cmd === 'db_file') return Promise.resolve({ path: 'C:/Users/x/AppData/Roaming/.../classroom.db', port: 8080 });
        if (cmd === 'db_load') return Promise.resolve({ ok: true, rev: 5, updatedAt: saved.updatedAt, state: saved, dump: saved });
        if (cmd === 'db_save') return Promise.resolve({ ok: true, room: args.room, counts: { records: 2, students: 1 } });
        return Promise.reject(new Error('未知命令 ' + cmd));
      }
    });

    ok(env.CI.storage.inTauri(), 'inTauri() 识别客户端环境');
    const st = await env.CI.storage.probe();
    eq(st.backend, 'tauri', '客户端后端 = tauri');
    ok(env.CI.storage.isSqlite(), '客户端也算 SQLite 后端');
    ok(env.CI.storage.describe().indexOf('classroom.db') >= 0, 'describe 显示数据库路径');

    // 库里已有数据、内存为空 → 载入
    env.calls.invoke.length = 0;
    const res = await env.CI.storage.bootstrap();
    eq(res.action, 'loaded-remote', '客户端启动时从 SQLite 载入');
    eq(env.state.students[0].name, '张三', '载入的数据进入内存态');
    ok(env.calls.invoke.some((c) => c.kind === 'invoke' && c.cmd === 'db_load'), '调用了 db_load');
    ok(env.calls.invoke.every((c) => c.kind === 'invoke'), '客户端路径完全不发 HTTP 请求');

    // 落库：应调用 db_save 并带上完整状态与 rev
    env.calls.invoke.length = 0;
    env.CI.storage.push(env.state, true);
    await new Promise((r) => setTimeout(r, 50));
    const save = env.calls.invoke.filter((c) => c.cmd === 'db_save')[0];
    ok(!!save, 'push 触发 db_save');
    eq(save.args.room, 'default', 'db_save 带房间号');
    ok(save.args.dump && save.args.dump.students.length === 1, 'db_save 带完整状态');
    ok(typeof save.args.rev === 'number', 'db_save 带 rev');
    eq(env.CI.storage.status().counts.records, 2, '写回后同步行数统计');

    // 命令失败时应退回 local，不阻塞界面，并且**明确告诉用户数据没丢**
    const broken = makeEnv({
      location: { protocol: 'tauri:', host: 'localhost', port: '', search: '' },
      tauri: () => Promise.reject(new Error('命令未注册'))
    });
    const st2 = await broken.CI.storage.probe();
    eq(st2.backend, 'local', '命令失败时退回 local（旧客户端仍可用）');
    eq(st2.degraded, true, '标记为已降级');
    ok(broken.CI.storage.isDegraded() === true, 'isDegraded() 为真');
    ok(broken.CI.storage.describe().indexOf('不会丢') >= 0,
      'describe() 明确说明数据不会丢：' + broken.CI.storage.describe().slice(0, 40) + '…');
    ok(broken.CI.storage.describe().indexOf('导出全部数据') >= 0, 'describe() 提示先导出备份');
    ok(broken.CI.storage.warning().indexOf('内置数据库不可用') >= 0, 'warning() 给出可展示的警示文案');
    // 正常客户端不该有警示
    ok(env.CI.storage.warning() === '', '正常客户端没有警示文案');
  }

  /* ================= 5. 房间号与地址解析 ================= */
  group('房间号与地址解析');
  {
    const env = makeEnv({ fetch: () => Promise.reject(new Error('x')) });
    eq(env.CI.storage.room(), 'default', '默认房间 default');
    env.store.set('ci_room', 'class-3');
    eq(env.CI.storage.room(), 'class-3', '读取 localStorage 里的房间号');

    eq(env.CI.storage.base(), '', '同源页面用相对地址');
    const fileEnv = makeEnv({ location: { protocol: 'file:', host: '', port: '', search: '' }, fetch: () => Promise.reject(new Error('x')) });
    eq(fileEnv.CI.storage.base(), 'http://localhost:8080', 'file:// 双击时指向本机枢纽');
    fileEnv.store.set('ci_ws_host', '192.168.1.9:9000');
    eq(fileEnv.CI.storage.base(), 'http://192.168.1.9:9000', '显式配置优先');
    fileEnv.store.set('ci_ws_host', 'ws://10.0.0.5:8080');
    eq(fileEnv.CI.storage.base(), 'http://10.0.0.5:8080', 'ws:// 地址自动转 http');
  }

  /* ================= 6. 写入失败重试与 flush（客户端可靠性） ================= */
  group('写入失败重试 / 立即 flush');
  {
    let attempts = 0;
    const env6 = makeEnv({
      location: { protocol: 'tauri:', host: 'localhost', port: '', search: '' },
      tauri: (cmd, args) => {
        if (cmd === 'db_file') return Promise.resolve({ path: 'x/classroom.db', port: 8080 });
        if (cmd === 'db_load') return Promise.resolve({ ok: true, dump: makeState([{ id: 'st_1', name: '张三' }], Date.now()) });
        if (cmd === 'db_save') {
          attempts++;
          if (attempts <= 2) return Promise.reject(new Error('磁盘忙'));
          return Promise.resolve({ ok: true, counts: { records: 1 } });
        }
        return Promise.reject(new Error('未知命令'));
      }
    });
    await env6.CI.storage.probe();
    await env6.CI.storage.bootstrap();

    env6.CI.storage.push(env6.state, true);                 // 第 1 次：失败
    await new Promise((r) => setTimeout(r, 60));
    ok(env6.CI.storage.isDirty() === true, '失败后仍标记为未落库（dirty）');
    ok(env6.CI.storage.status().attempts === 1, '记录失败次数（第 1 次）');
    ok(env6.CI.storage.warning().indexOf('尚未落库') >= 0,
      'warning() 明确提示"尚未落库、已保留并自动重试"：' + env6.CI.storage.warning().slice(0, 24) + '…');
    ok(env6.CI.storage.describe().indexOf('重试中') >= 0, 'describe() 显示重试中');

    // 退避 1s 后自动重试 → 第 2 次仍失败
    await new Promise((r) => setTimeout(r, 1300));
    ok(env6.CI.storage.status().attempts >= 2, '自动重试发生了（累计 ' + env6.CI.storage.status().attempts + ' 次）');
    ok(env6.CI.storage.isDirty() === true, '仍失败时保持 dirty');

    // 第 3 次成功（退避 2s 后）
    await new Promise((r) => setTimeout(r, 2400));
    eq(env6.CI.storage.isDirty(), false, '最终写入成功后 dirty 清除');
    eq(env6.CI.storage.status().attempts, 0, '成功后失败计数清零');
    eq(env6.CI.storage.warning(), '', '成功后不再有警示');
    eq(attempts >= 3, true, '至少尝试了 3 次（实际 ' + attempts + '）');

    // flush：不等防抖立即写
    const before = attempts;
    env6.CI.storage.push(env6.state);                       // 只调度防抖
    ok(env6.CI.storage.isDirty() === true, 'push 后处于待写状态');
    await env6.CI.storage.flush();
    await new Promise((r) => setTimeout(r, 60));
    ok(attempts > before, 'flush() 立即触发写入（' + before + ' → ' + attempts + '）');
  }

  /* ================= 7. 被枢纽拒绝的过期写入 ================= */
  group('过期写入被拒（多写者）');
  {
    const env7 = makeEnv({
      fetch: (url, init) => {
        if (url.indexOf('/health') >= 0) return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, storage: 'sqlite' }) });
        if (url.indexOf('/api/state') >= 0 && init && init.method === 'PUT') {
          return Promise.resolve({
            ok: false, status: 409,
            json: () => Promise.resolve({ ok: false, stale: true, rev: 9, message: '枢纽上已有更新的数据（rev 9 > 你的 1）' })
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, dump: null }) });
      }
    });
    await env7.CI.storage.probe();
    env7.state.students = [{ id: 'st_x', name: '旧数据' }];
    env7.CI.storage.push(env7.state, true);
    await new Promise((r) => setTimeout(r, 80));
    eq(env7.CI.storage.status().staleRejected, true, '被拒后标记 staleRejected');
    ok(env7.CI.storage.warning().indexOf('更新的数据') >= 0, 'warning() 说明原因：' + env7.CI.storage.warning().slice(0, 30) + '…');
    ok(env7.CI.storage.describe().indexOf('未覆盖') >= 0, 'describe() 也体现"本次未覆盖"');
    eq(env7.CI.storage.isDirty(), false, '被拒不算"待重试"（继续重试也不会成功）');
  }

  /* ================= 收尾 ================= */
  console.log('\n----------------------------------------');
  if (failures.length) {
    console.log(`❌ 失败 ${failures.length} 项 / 通过 ${passed} 项`);
    failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
    process.exit(1);
  } else {
    console.log(`✅ 全部通过：${passed} 项断言`);
  }
})();
