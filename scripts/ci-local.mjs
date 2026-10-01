/*!
 * scripts/ci-local.mjs — 本地一条命令复现 CI（与 .github/workflows/test.yml 同源）
 *
 *   node scripts/ci-local.mjs            # 全量：8 组断言 + 2 条浏览器端到端 + 各类静态检查
 *   node scripts/ci-local.mjs --quick    # 只跑纯 Node 断言（跳过需要浏览器的部分）
 *
 *  为什么要有它：CI 里那一串 step 如果和本地命令各写一份，迟早漂移。
 *  这里把步骤集中成一个脚本，工作流直接调用 `node scripts/ci-local.mjs`，
 *  于是"本地绿 = CI 绿"有了共同来源。
 *
 *  它会自己起一个隔离枢纽（随机可用端口 + 临时 DATA_DIR），跑完自动清理。
 */
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const QUICK = process.argv.includes('--quick');
const results = [];
const t0 = Date.now();

const C = {
  ok: '\x1b[32m', bad: '\x1b[31m', dim: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m'
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function run(title, args, opts) {
  const started = Date.now();
  process.stdout.write(C.b + '▶ ' + title + C.x + C.dim + '  (' + args.join(' ') + ')' + C.x + '\n');
  const res = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit', env: Object.assign({}, process.env, (opts && opts.env) || {}) });
  const ms = Date.now() - started;
  const pass = res.status === 0;
  results.push({ title, pass, ms });
  console.log((pass ? C.ok + '✔ ' : C.bad + '✘ ') + title + C.x + C.dim + '  ' + (ms / 1000).toFixed(1) + 's' + C.x + '\n');
  return pass;
}

/** 找一个空闲端口（避免和老师正在用的 8080 冲突） */
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

async function withHub(fn) {
  const port = await freePort(8300 + Math.floor(Math.random() * 100));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-local-'));
  const hub = spawn(process.execPath, [path.join(ROOT, 'sync-server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(port), HOST: '127.0.0.1', SERVE_TESTS: '1', DATA_DIR: dataDir
    }),
    stdio: 'ignore'
  });
  let ready = false;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    try {
      const r = await fetch('http://127.0.0.1:' + port + '/health');
      if (r.ok) { ready = true; break; }
    } catch (e) { /* 还没起来 */ }
  }
  if (!ready) {
    hub.kill();
    throw new Error('枢纽未能在 10 秒内就绪（端口 ' + port + '）');
  }
  console.log(C.dim + '  · 测试枢纽已就绪：http://127.0.0.1:' + port + '（数据目录 ' + dataDir + '）' + C.x + '\n');
  try {
    return await fn(port);
  } finally {
    try { hub.kill(); } catch (e) { /* 忽略 */ }
    await sleep(300);
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
  }
}

/* ------------------------------------------------------------------ *
 * 步骤（与 .github/workflows/test.yml 一一对应）
 * ------------------------------------------------------------------ */

// 0) 前置产物：前端资源、图标、官方 schema、生成的 Rust 常量
run('生成客户端前端资源（sync-ui）', ['scripts/sync-ui.mjs']);
run('Tauri 官方 schema 已入库（离线校验用）', ['scripts/fetch-schema.mjs', '--check']);
run('契约 → Rust 常量是否为最新', ['scripts/gen-protocol.mjs', '--check']);
run('应用图标齐备（PNG/ICO/ICNS）', ['-e', `
  const fs=require('fs');
  const apps=['teacher','student'], need=['32x32.png','128x128.png','128x128@2x.png','icon.png','icon.ico','icon.icns'];
  for (const a of apps) for (const f of need) {
    const p='apps/'+a+'/src-tauri/icons/'+f;
    if(!fs.existsSync(p)) { console.error('缺少图标 '+p); process.exit(1); }
  }
  console.log('两套客户端图标齐备（各 6 个文件）');
`]);

// 1) 纯 Node 断言（八组）
const NODE_TESTS = [
  ['逻辑断言（教师端 + 多端协同）', 'tests/logic.test.js'],
  ['教师端本地 SQLite', 'tests/db.test.js'],
  ['持久化适配层（浏览器 / 枢纽 / Tauri）', 'tests/storage.test.js'],
  ['EasyTier 组网参数与 Rust 源码一致性', 'tests/net.test.js'],
  ['v3 报文契约四端对照 + 生成常量', 'tests/protocol.test.js'],
  ['枢纽行为规格（真实 WS 客户端）', 'tests/hub-spec.test.js'],
  ['客户端配置（官方 Tauri v2 schema 校验）', 'tests/tauri-config.test.js'],
  ['客户端离线自洽性（资源闭包 / CSP / 不依赖缺的接口）', 'tests/client.test.js'],
  ['Android 明文流量修补（真机连 ws:// 必需）', 'tests/android-manifest.test.js'],
  ['Rust 依赖体检（版本存在性 + 与代码 API 假设一致）', 'tests/crates.test.js'],
  ['客户端骨架与 CI 流水线自检', 'tests/ci.test.js'],
  ['静态接线自检', 'tests/dom-check.js'],
  ['文档行号引用审计', 'tests/doc-refs.js', ['--broken']]
];
let nodeOk = true;
for (const [title, file, extra] of NODE_TESTS) {
  nodeOk = run(title, [file].concat(extra || [])) && nodeOk;
}

// 2) 浏览器端到端（两条）
let e2eOk = true;
if (!QUICK) {
  try {
    e2eOk = await withHub(async (port) => {
      const base = 'http://127.0.0.1:' + port;
      const a = run('教师端端到端（admin.html）', ['tests/run-smoke.js', base + '/tests/smoke.html']);
      const b = run('多端协同端到端（教师端+学生端+大屏）', ['tests/run-smoke.js', base + '/tests/smoke-class.html']);
      return a && b;
    });
  } catch (e) {
    results.push({ title: '浏览器端到端（枢纽启动失败）', pass: false, ms: 0 });
    console.error(C.bad + '✘ ' + e.message + C.x);
    e2eOk = false;
  }
} else {
  console.log(C.dim + '▶ 已跳过浏览器端到端（--quick）' + C.x + '\n');
}

// 3) Rust（只有本机装了 cargo 才跑；否则跳过并明确写在总结里）
function hasCargo() {
  if (process.env.SKIP_CARGO === '1') return false;
  // 不加 shell（避免 DEP0190）：Windows 上 Node 会按 PATHEXT 找到 cargo.exe
  const probe = spawnSync('cargo', ['--version'], { stdio: 'ignore' });
  return probe.status === 0;
}

const cargoAvailable = hasCargo();
if (cargoAvailable) {
  const teacherSrc = path.join('apps', 'teacher', 'src-tauri');
  const studentSrc = path.join('apps', 'student', 'src-tauri');

  const t0r = Date.now();
  process.stdout.write(C.b + '▶ Rust：教师端 cargo test（含枢纽一致性）' + C.x + '\n');
  const rt = spawnSync('cargo', ['test', '--all-targets'], { cwd: path.join(ROOT, teacherSrc), stdio: 'inherit' });
  results.push({ title: 'Rust：教师端 cargo test（含枢纽一致性）', pass: rt.status === 0, ms: Date.now() - t0r });
  console.log((rt.status === 0 ? C.ok + '✔ ' : C.bad + '✘ ') + 'Rust：教师端 cargo test' + C.x + '\n');

  const t0s = Date.now();
  process.stdout.write(C.b + '▶ Rust：学生端 cargo check' + C.x + '\n');
  const rs = spawnSync('cargo', ['check', '--all-targets'], { cwd: path.join(ROOT, studentSrc), stdio: 'inherit' });
  results.push({ title: 'Rust：学生端 cargo check', pass: rs.status === 0, ms: Date.now() - t0s });
  console.log((rs.status === 0 ? C.ok + '✔ ' : C.bad + '✘ ') + 'Rust：学生端 cargo check' + C.x + '\n');
} else {
  console.log(C.dim + '▶ 跳过 Rust（本机没有 cargo；装了 rustup 后本脚本会自动包含，CI 上见 .github/workflows/rust.yml）' + C.x + '\n');
}

/* ------------------------------------------------------------------ *
 * 汇总
 * ------------------------------------------------------------------ */

const failed = results.filter((r) => !r.pass);
const total = results.length;
console.log(C.b + '══════════════════════════════════════════════' + C.x);
console.log(C.b + ' CI 本地复现结果' + C.x + C.dim + '（耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's）' + C.x);
results.forEach((r) => {
  console.log(' ' + (r.pass ? C.ok + 'PASS' : C.bad + 'FAIL') + C.x + '  ' + r.title + C.dim + '  ' + (r.ms / 1000).toFixed(1) + 's' + C.x);
});
console.log(C.b + '══════════════════════════════════════════════' + C.x);
if (failed.length) {
  console.log(C.bad + '❌ ' + failed.length + '/' + total + ' 步失败：' + failed.map((f) => f.title).join('、') + C.x);
  console.log(C.dim + '提示：Rust 编译与 Android 出包不在本脚本范围（需 rustup / Android SDK，见 apps/README.md）' + C.x);
  process.exit(1);
}
console.log(C.ok + '✅ 全部通过：' + total + ' 步' + C.x);
console.log(C.dim + '未覆盖：Rust 编译（需 cargo）、tauri build/出包（需 rustup + Android SDK）、EasyTier 实机组网' + C.x);