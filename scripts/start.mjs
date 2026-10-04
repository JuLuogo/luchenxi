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
const hub = spawn(process.execPath, [path.join(ROOT, 'sync-server.js')], { cwd: ROOT, stdio: 'inherit' });
process.on('SIGINT', () => { try { hub.kill(); } catch (e) { /* 忽略 */ } process.exit(0); });
hub.on('exit', (code) => process.exit(code == null ? 0 : code));
