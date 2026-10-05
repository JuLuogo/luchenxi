/*!
 * scripts/start.mjs — 一条命令把整套东西跑起来
 *
 *   node scripts/start.mjs            # 需要时先构建新版界面，再启动枢纽
 *   node scripts/start.mjs --no-build # 不自动构建（只想起枢纽）
 *
 * 为什么需要它：新版界面（web/）是**构建产物**，而 web/dist 按惯例不入库。
 * 以前 `npm start` 只起枢纽，新界面的 /next/ 会直接 404 —— 克隆下来的人会以为"跑不起来"。
 * 现在 start 会检查 web/dist，缺了就自动构建（约 10 秒），再启动枢纽。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'web');
const DIST_ENTRY = path.join(WEB, 'dist', 'admin.html');
const NO_BUILD = process.argv.includes('--no-build');

function has(p) { return fs.existsSync(p); }

function run(cmd, args, cwd, label) {
  console.log('\n▶ ' + (label || cmd + ' ' + args.join(' ')));
  const res = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  return res.status === 0;
}

/* ---------- 1. 依赖 ---------- */
if (!has(path.join(ROOT, 'node_modules'))) {
  console.log('首次运行：安装依赖（npm install）');
  if (!run('npm', ['install'], ROOT, '安装根依赖')) process.exit(1);
}
if (!has(path.join(WEB, 'node_modules'))) {
  console.log('首次运行：安装前端依赖（web/）');
  if (!run('npm', ['install'], WEB, '安装前端依赖')) process.exit(1);
}

/* ---------- 2. 新版界面（构建产物不入库，缺了就构建） ---------- */
if (!has(DIST_ENTRY) && !NO_BUILD) {
  console.log('新版界面还没有构建（web/dist 不在版本库里，这是正常的）→ 现在构建一次');
  if (!run('npm', ['run', 'build'], WEB, '构建新版界面（Vite）')) {
    console.error('\n❌ 界面构建失败（web/dist 没出来）：先排查上面的报错；旧版零构建界面已于 2026-10 删除。');
    // 审计发现：原来只打印错误就**继续起枢纽** → npm start 仍以 0 退出，
    // 用户拿到 404 的界面（正是这个脚本想消除的体验）。构建失败必须终止。
    process.exit(1);
  }
}

/* ---------- 3. 起枢纽 ---------- */
/**
 * 起枢纽：**优先 Rust 枢纽**（它才是要出货的那个，且实现了 /api/domain/*）。
 *
 * 审计发现：原来这里起的是 Node 枢纽，而它**没有领域端点** → 网页版每次都探测失败、
 * 静默回退 JS 参考实现 —— 等于 docs/14 禁止的"两份实现"在主路径上天天发生。
 * 拿不到 Rust 二进制时回退 Node，但要**明确提示**（否则又会静默降级）。
 */
const RUST_BIN = path.join(ROOT, 'target', process.env.CI_PROFILE || 'release', 'ci-hub-server' + (process.platform === 'win32' ? '.exe' : ''));
const RUST_BIN_DEBUG = path.join(ROOT, 'target', 'debug', 'ci-hub-server' + (process.platform === 'win32' ? '.exe' : ''));
let hubCmd = null;
let hubArgs = [];
let hubMode = '';
if (fs.existsSync(RUST_BIN)) { hubCmd = RUST_BIN; hubMode = 'Rust 核心'; }
else if (fs.existsSync(RUST_BIN_DEBUG)) { hubCmd = RUST_BIN_DEBUG; hubMode = 'Rust 核心（debug 构建）'; }
else {
  hubCmd = process.execPath;
  hubArgs = [path.join(ROOT, 'sync-server.js')];
  hubMode = 'Node 参考枢纽';
  console.log('');
  console.log('  ⚠ 没找到 Rust 枢纽二进制 → 回退 Node 参考枢纽。');
  console.log('     Node 枢纽**没有 /api/domain/* 领域端点**，界面会回退到 JS 参考实现（口径一致但不是出货路径）。');
  console.log('     想用 Rust 核心：npm run build:hub（或 cargo build -p ci-core --bin ci-hub-server）');
  console.log('');
}
console.log('  枢纽：' + hubMode + '  → ' + hubCmd);
const hub = spawn(hubCmd, hubArgs, { cwd: ROOT, stdio: 'inherit' });
process.on('SIGINT', () => { try { hub.kill(); } catch (e) { /* 忽略 */ } process.exit(0); });
hub.on('exit', (code) => process.exit(code == null ? 0 : code));
