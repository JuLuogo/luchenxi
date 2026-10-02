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
const IN_CI = !!process.env.GITHUB_ACTIONS || process.argv.includes('--annotate');
const results = [];
const t0 = Date.now();

const C = {
  ok: '\x1b[32m', bad: '\x1b[31m', dim: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m'
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 在 GitHub Actions 上把失败步骤写成注解（::error::）。
 *
 * 为什么需要：作业日志要凭据才能看，而注解是公开可读的。
 * 于是"哪一组断言挂了"能直接从 check-run 注解里看到，不必翻日志。
 */
function annotate(title, detail) {
  if (!IN_CI) return;
  const one = String(detail || '').replace(/\r?\n/g, ' ⏎ ').slice(0, 900);
  console.log('::error title=' + title.replace(/[%\n\r]/g, ' ') + '::' + one);
}

function run(title, args, opts) {
  const started = Date.now();
  process.stdout.write(C.b + '▶ ' + title + C.x + C.dim + '  (' + args.join(' ') + ')' + C.x + '\n');
  // CI 上把输出同时收进缓冲区：失败时好写成注解
  const res = spawnSync(process.execPath, args, {
    cwd: ROOT,
    stdio: IN_CI ? 'pipe' : 'inherit',
    encoding: 'utf8',
    env: Object.assign({}, process.env, (opts && opts.env) || {})
  });
  if (IN_CI && res.stdout) process.stdout.write(res.stdout);
  if (IN_CI && res.stderr) process.stderr.write(res.stderr);
  const ms = Date.now() - started;
  const pass = res.status === 0;
  results.push({ title, pass, ms });
  if (!pass) {
    const out = (res.stdout || '') + (res.stderr || '');
    const tail = out.split(/\r?\n/).filter((l) => l.trim() && !/^\s*▶/.test(l)).slice(-18).join('\n');
    results[results.length - 1].tail = tail;
    annotate('CI 步骤失败：' + title, tail || ('退出码 ' + res.status));
  }
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
    // 这条路径以前不产出注解，CI 上只会看到"exit code 1"，无从判断是枢纽起不来
    annotate('CI 失败：测试枢纽未就绪', '枢纽未能在 10 秒内就绪（端口 ' + port + '）——检查 sync-server.js 启动输出与端口占用');
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

/**
 * 用 **Rust 枢纽**跑端到端（P2 的验收方式）。
 *
 * 为什么要单独一套：Node 枢纽是参考实现，Rust 枢纽才是要出货的那个。
 * 两条 e2e 打 Rust 枢纽全绿，才说明"业务核心真的能在客户端里跑"。
 * 需要先 `cargo build -p ci-core --bin ci-hub-server`（本脚本自动做）。
 */
async function withRustHub(cargoBin, cargoEnv, fn) {
  const exe = path.join(
    ROOT, 'target', 'debug',
    process.platform === 'win32' ? 'ci-hub-server.exe' : 'ci-hub-server'
  );
  if (!fs.existsSync(exe)) {
    console.log(C.bad + '✘ 没有找到 ' + exe + '（先 cargo build -p ci-core --bin ci-hub-server）' + C.x);
    return false;
  }
  const port = await freePort(8500 + Math.floor(Math.random() * 100));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-rust-hub-'));
  const hub = spawn(exe, [], {
    cwd: ROOT,
    env: Object.assign({}, cargoEnv, {
      PORT: String(port), HOST: '127.0.0.1', SERVE_TESTS: '1',
      DATA_DIR: dataDir, STATIC_ROOT: ROOT
    }),
    stdio: 'ignore'
  });
  let ready = false;
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    try {
      const r = await fetch('http://127.0.0.1:' + port + '/health');
      if (r.ok) { const j = await r.json(); ready = !!j.ok && String(j.service || '').includes('rust'); break; }
    } catch (e) { /* 还没起来 */ }
  }
  if (!ready) {
    hub.kill();
    annotate('CI 失败：Rust 枢纽未就绪', '端口 ' + port + ' 上 10 秒内没等到 /health（service 应含 rust）');
    console.log(C.bad + '✘ Rust 枢纽未能在 10 秒内就绪（端口 ' + port + '）' + C.x);
    return false;
  }
  console.log(C.dim + '  · Rust 枢纽已就绪：http://127.0.0.1:' + port + '（数据目录 ' + dataDir + '）' + C.x + '\n');
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
  ['v5 工作区结构（crate 划分 / 依赖方向 / 迁移进度）', 'tests/v5-workspace.test.js'],
  // JS ↔ Rust 一致性基准：JS 规则改了却没重新生成基准时会在这里红，
  // 免得回头误以为是 Rust 实现漂移
  ['JS↔Rust 一致性基准（parity.json 是否最新）', 'scripts/gen-parity-fixtures.mjs', ['--check']],
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
    results.push({ title: '浏览器端到端（枢纽启动失败）', pass: false, ms: 0, tail: String(e && e.message || e) });
    console.error(C.bad + '✘ ' + e.message + C.x);
    annotate('CI 失败：浏览器端到端无法开始', String(e && e.message || e));
    e2eOk = false;
  }
} else {
  console.log(C.dim + '▶ 已跳过浏览器端到端（--quick）' + C.x + '\n');
}

// 3) Rust（只有本机装了 cargo 才跑；否则跳过并明确写在总结里）
/**
 * 找 cargo：先看 PATH，再看常见安装位置。
 * 为什么：scripts/setup-toolchain.ps1 把 Rust 装到 D:\app\rust（portable，免 UAC），
 * 环境变量要新开终端才生效；本脚本不能因此就"以为没有 Rust"而跳过编译。
 */
function findCargo() {
  if (process.env.SKIP_CARGO === '1') return null;
  const candidates = [];
  if (process.env.CARGO_HOME) candidates.push(path.join(process.env.CARGO_HOME, 'bin', process.platform === 'win32' ? 'cargo.exe' : 'cargo'));
  candidates.push(path.join(process.env.USERPROFILE || process.env.HOME || '', '.cargo', 'bin', process.platform === 'win32' ? 'cargo.exe' : 'cargo'));
  const appRoot = process.env.CI_APP_ROOT || (process.platform === 'win32' ? 'D:\\app' : '/opt/app');
  candidates.push(path.join(appRoot, 'rust', 'cargo', 'bin', process.platform === 'win32' ? 'cargo.exe' : 'cargo'));
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  // 最后再试 PATH
  const probe = spawnSync('cargo', ['--version'], { stdio: 'ignore' });
  return probe.status === 0 ? 'cargo' : null;
}

const cargoBin = findCargo();
const cargoAvailable = !!cargoBin;
/**
 * rustup 装的 cargo 是个代理：它靠 RUSTUP_HOME/CARGO_HOME 找工具链。
 * portable 安装（D:\app\rust）时环境变量要新开终端才生效，这里显式补上，
 * 否则会以"error: rustup could not choose a version of cargo"在 0.1 秒内失败。
 */
const cargoEnv = (() => {
  const env = { ...process.env };
  if (!cargoBin || cargoBin === 'cargo') return env;
  const binDir = path.dirname(cargoBin);
  const home = path.dirname(binDir);                        // …/rust/cargo
  if (!env.CARGO_HOME) env.CARGO_HOME = home;
  if (!env.RUSTUP_HOME) {
    const guess = path.join(path.dirname(home), 'rustup');   // …/rust/rustup
    if (fs.existsSync(guess)) env.RUSTUP_HOME = guess;
  }
  return env;
})();
if (cargoAvailable) {
  const teacherSrc = path.join('apps', 'teacher', 'src-tauri');
  const studentSrc = path.join('apps', 'student', 'src-tauri');
  console.log(C.dim + '▶ 使用 cargo：' + cargoBin + C.x);

  // EasyTier sidecar：教师端 externalBin 声明了它，缺了 tauri-build 会直接失败
  const binDir = path.join(ROOT, teacherSrc, 'binaries');
  const hasSidecar = fs.existsSync(binDir) && fs.readdirSync(binDir).some((f) => /^easytier-core/.test(f) && f !== '.gitkeep');
  if (!hasSidecar) {
    console.log(C.b + '▶ 放置 EasyTier sidecar（教师端构建需要）' + C.x);
    const target = process.platform === 'win32' ? 'x86_64-pc-windows-msvc' : 'x86_64-unknown-linux-gnu';
    spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'fetch-easytier.mjs'), target], { cwd: ROOT, stdio: 'inherit' });
  }

  const t0r = Date.now();
  process.stdout.write(C.b + '▶ Rust：cargo test --workspace（五个 crate + 两套客户端）' + C.x + '\n');
  const rt = spawnSync(cargoBin, ['test', '--workspace'], { cwd: ROOT, stdio: 'inherit', env: cargoEnv });
  const rustOut = (rt.stdout || '') + (rt.stderr || '');
  results.push({
    title: 'Rust：cargo test --workspace（含枢纽一致性）',
    pass: rt.status === 0,
    ms: Date.now() - t0r,
    tail: rt.status === 0 ? '' : rustOut.split(/\r?\n/).filter((l) => /error|FAILED|panicked|not found|pkg-config/i.test(l)).slice(-10).join('\n')
  });
  if (rt.status !== 0) annotate('CI 步骤失败：cargo test --workspace', (results[results.length - 1].tail || '退出码 ' + rt.status));
  console.log((rt.status === 0 ? C.ok + '✔ ' : C.bad + '✘ ') + 'Rust：cargo test --workspace' + C.x + '\n');

  // ---- P3：前端类型检查 + 类型绑定一致性 ----
  {
    // vue-tsc：把前端类型错误拦在构建之前（构建脚本里也前置了它，这里再显式跑一遍，
    // 这样 CI 上"类型错"会有独立的一步与注解，而不是埋在构建输出里）
    const t0t = Date.now();
    process.stdout.write(C.b + '▶ 前端类型检查（vue-tsc）' + C.x + '\n');
    const vtsc = path.join(ROOT, 'web', 'node_modules', 'vue-tsc', 'bin', 'vue-tsc.js');
    let okTsc = false;
    if (!fs.existsSync(vtsc)) {
      console.log(C.dim + '  · 跳过：web/node_modules 里没有 vue-tsc（先 npm install --prefix web）' + C.x + '\n');
    } else {
      const rt2 = spawnSync(process.execPath, [vtsc, '--noEmit', '-p', path.join(ROOT, 'web', 'tsconfig.json')], {
        cwd: ROOT, stdio: 'inherit'
      });
      okTsc = rt2.status === 0;
      results.push({ title: '前端类型检查（vue-tsc）', pass: okTsc, ms: Date.now() - t0t });
      if (!okTsc) annotate('CI 步骤失败：前端类型检查', 'vue-tsc --noEmit 有类型错误，详见上方输出');
      console.log((okTsc ? C.ok + '✔ ' : C.bad + '✘ ') + '前端类型检查（vue-tsc）' + C.x + '\n');
    }

    // 绑定一致性：Rust 改了字段但没重新生成 → 前端会按老结构读（P2 里 scores/ips 就是这么翻车的）
    const t0c = Date.now();
    process.stdout.write(C.b + '▶ 前端类型绑定与 Rust 一致（specta）' + C.x + '\n');
    const rb2 = spawnSync(cargoBin, ['run', '-q', '-p', 'ci-core', '--bin', 'export-bindings', '--features', 'bindings', '--', '--check'], {
      cwd: ROOT, stdio: 'inherit', env: cargoEnv
    });
    const okBind = rb2.status === 0;
    results.push({ title: '前端类型绑定与 Rust 一致（specta）', pass: okBind, ms: Date.now() - t0c });
    if (!okBind) annotate('CI 步骤失败：类型绑定过期', '运行 cargo run -p ci-core --bin export-bindings --features bindings 重新生成');
    console.log((okBind ? C.ok + '✔ ' : C.bad + '✘ ') + '前端类型绑定与 Rust 一致（specta）' + C.x + '\n');
  }

  // ---- P2：两条端到端改打 **Rust 枢纽** ----
  {
    const t0b = Date.now();
    process.stdout.write(C.b + '▶ Rust：构建独立枢纽 ci-hub-server' + C.x + '\n');
    const rb = spawnSync(cargoBin, ['build', '-p', 'ci-core', '--bin', 'ci-hub-server'], {
      cwd: ROOT, stdio: 'inherit', env: cargoEnv
    });
    const okBuild = rb.status === 0;
    results.push({ title: 'Rust：构建独立枢纽 ci-hub-server', pass: okBuild, ms: Date.now() - t0b });
    console.log((okBuild ? C.ok + '✔ ' : C.bad + '✘ ') + 'Rust：构建 ci-hub-server' + C.x + '\n');

    if (okBuild) {
      const e2eRust = await withRustHub(cargoBin, cargoEnv, async (port) => {
        const base = 'http://127.0.0.1:' + port;
        const a = run('教师端端到端（Rust 枢纽）', ['tests/run-smoke.js', base + '/tests/smoke.html']);
        const b = run('多端协同端到端（Rust 枢纽）', ['tests/run-smoke.js', base + '/tests/smoke-class.html']);
        return a && b;
      });
      if (!e2eRust) {
        results.push({ title: '浏览器端到端（打 Rust 枢纽）', pass: false, ms: 0 });
      }
    }
  }

  const t0s = Date.now();
  process.stdout.write(C.b + '▶ Rust：cargo check --workspace' + C.x + '\n');
  const rs = spawnSync(cargoBin, ['check', '--workspace', '--all-targets'], { cwd: ROOT, stdio: 'inherit', env: cargoEnv });
  results.push({ title: 'Rust：cargo check --workspace', pass: rs.status === 0, ms: Date.now() - t0s });
  if (rs.status !== 0) annotate('CI 步骤失败：cargo check --workspace', '退出码 ' + rs.status);
  console.log((rs.status === 0 ? C.ok + '✔ ' : C.bad + '✘ ') + 'Rust：cargo check --workspace' + C.x + '\n');
} else {
  console.log(C.dim + (process.env.SKIP_CARGO === '1'
    ? '▶ 跳过 Rust（SKIP_CARGO=1；Rust 由 .github/workflows/rust.yml 负责，那边装了 Linux 依赖）'
    : '▶ 跳过 Rust（本机没有 cargo；装了 rustup 后本脚本会自动包含，CI 上见 .github/workflows/rust.yml）') + C.x + '\n');
}

/* ------------------------------------------------------------------ *
 * 汇总
 * ------------------------------------------------------------------ */

const failed = results.filter((r) => !r.pass);
const total = results.length;

/* ------------------------------------------------------------------ *
 * 落盘结果：给 scripts/ci-summary.mjs 生成 Job Summary 用
 * （Actions 的作业日志要授权才能读，Summary 与注解是公开可见的两个出口）
 * ------------------------------------------------------------------ */
try {
  fs.writeFileSync(path.join(ROOT, 'ci-result.json'), JSON.stringify({
    ok: failed.length === 0,
    node: process.version,
    ms: Date.now() - t0,
    steps: results.map((r) => ({
      title: r.title,
      pass: r.pass,
      ms: r.ms,
      tail: (r.tail || '').split(/\r?\n/).filter((l) => l.trim()).slice(-18).join('\n')
    }))
  }, null, 2), 'utf8');
} catch (e) { /* 写不了也不影响 CI 结论 */ }

console.log(C.b + '══════════════════════════════════════════════' + C.x);
console.log(C.b + ' CI 本地复现结果' + C.x + C.dim + '（耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's）' + C.x);
results.forEach((r) => {
  console.log(' ' + (r.pass ? C.ok + 'PASS' : C.bad + 'FAIL') + C.x + '  ' + r.title + C.dim + '  ' + (r.ms / 1000).toFixed(1) + 's' + C.x);
});
console.log(C.b + '══════════════════════════════════════════════' + C.x);
if (failed.length) {
  // 兜底注解：不管失败发生在哪条路径，至少把"哪几步挂了 + 各自输出尾部"写进 check-run 注解
  annotate('CI 失败步骤（共 ' + failed.length + '/' + total + '）',
    failed.map((f) => '• ' + f.title + (f.tail ? '\n' + f.tail.split(/\r?\n/).slice(-6).join('\n') : '')).join('\n\n'));
  console.log(C.bad + '❌ ' + failed.length + '/' + total + ' 步失败：' + failed.map((f) => f.title).join('、') + C.x);
  console.log(C.dim + '提示：Rust 编译与 Android 出包不在本脚本范围（需 rustup / Android SDK，见 apps/README.md）' + C.x);
  process.exit(1);
}
console.log(C.ok + '✅ 全部通过：' + total + ' 步' + C.x);
console.log(C.dim + '未覆盖：Rust 编译（需 cargo）、tauri build/出包（需 rustup + Android SDK）、EasyTier 实机组网' + C.x);