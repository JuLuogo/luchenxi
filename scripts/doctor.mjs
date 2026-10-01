/*!
 * scripts/doctor.mjs — 一条命令自检"到底哪一环跑不起来"
 *
 *   npm run doctor
 *
 * 逐项检查：Node 版本 / 依赖 / 新版界面是否已构建 / 枢纽能否启动 / 四个入口能否访问 /
 * 客户端工程是否齐备 / Rust 工具链（可选）。最后给出结论与下一步该跑什么命令。
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8080);
const rows = [];
const ok = (name, pass, detail) => { rows.push({ name, pass, detail: detail || '' }); };

function has(p) { return fs.existsSync(path.join(ROOT, p)); }
function cmdExists(cmd) {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore', shell: process.platform === 'win32' });
  return r.status === 0;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 1. 运行时 ---------- */
const nodeVer = process.versions.node;
const nodeMajor = Number(nodeVer.split('.')[0]);
ok('Node 版本', nodeMajor >= 24, nodeVer + (nodeMajor >= 24 ? '' : '（< 24：node:sqlite 需要 --experimental-sqlite，枢纽会退回文件缓存）'));

let sqlite = false;
try { await import('node:sqlite'); sqlite = true; } catch (e) { sqlite = false; }
ok('内置 SQLite（node:sqlite）', sqlite, sqlite ? '可用' : '不可用 → 用 Node 24，或加 --experimental-sqlite');

/* ---------- 2. 依赖与产物 ---------- */
ok('根依赖 node_modules', has('node_modules'), has('node_modules') ? '' : '运行 npm install');
const webDeps = has('web/node_modules');
ok('前端依赖 web/node_modules', webDeps, webDeps ? '' : '运行 npm --prefix web install');
const distReady = has('web/dist/admin.html');
ok('新版界面已构建（web/dist）', distReady, distReady ? '' : '运行 npm run web:build（或直接用 npm start，会自动构建）');

/* ---------- 3. 静态资源闭包 ---------- */
['admin.html', 'student.html', 'index.html'].forEach((f) => ok('旧界面文件 ' + f, has(f), ''));
['assets/js/store.js', 'assets/js/sync.js', 'sync-server.js'].forEach((f) => ok('核心脚本 ' + f, has(f), ''));
ok('客户端工程（apps/）', has('apps/teacher/src-tauri/Cargo.toml') && has('apps/student/src-tauri/Cargo.toml'),
  '两套 Tauri 工程；出包需要 Rust 工具链 + Android SDK');

/* ---------- 4. Rust 工具链（可选） ---------- */
const hasCargo = cmdExists('cargo');
ok('Rust 工具链 cargo', hasCargo, hasCargo ? '' : '本机没有 → 客户端只能靠 GitHub Actions 构建（rust.yml / build.yml）');

/* ---------- 5. 端口与枢纽 ---------- */
function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

const free = await portFree(PORT);
let hubStarted = null;
if (!free) {
  ok('端口 ' + PORT, true, '已被占用 —— 可能枢纽已在运行；下面直接探测入口');
} else {
  // 临时起一个枢纽（3 秒内探测完就关掉）
  hubStarted = spawn(process.execPath, [path.join(ROOT, 'sync-server.js')], { cwd: ROOT, stdio: 'ignore' });
  let up = false;
  for (let i = 0; i < 20 && !up; i++) {
    await sleep(250);
    try { const r = await fetch(`http://127.0.0.1:${PORT}/health`); up = r.ok; } catch (e) { /* 等 */ }
  }
  ok('枢纽能启动（/health）', up, up ? '' : '启动失败：单独运行 node sync-server.js 看报错');
}

/* ---------- 6. 四个入口 ---------- */
for (const p of ['/', '/admin.html', '/join', '/stage', '/next/admin.html', '/next/join', '/next/stage']) {
  let status = 0;
  try { status = (await fetch(`http://127.0.0.1:${PORT}${p}`)).status; } catch (e) { status = 0; }
  ok('入口 ' + p, status === 200, status === 200 ? '200' : ('返回 ' + status + (p.startsWith('/next') && !distReady ? '（新版界面还没构建）' : '')));
}

if (hubStarted) { try { hubStarted.kill(); } catch (e) { /* 忽略 */ } }

/* ---------- 输出 ---------- */
const bad = rows.filter((r) => !r.pass);
console.log('\n课堂积分系统 · 自检报告');
console.log('  ' + new Date().toLocaleString('zh-CN') + ' ｜ Node ' + nodeVer + ' ｜ ' + os.platform() + ' ' + os.arch());
console.log('  ' + '─'.repeat(72));
rows.forEach((r) => {
  console.log('  ' + (r.pass ? '✔' : '✘') + ' ' + r.name.padEnd(30) + (r.detail || ''));
});
console.log('  ' + '─'.repeat(72));
if (!bad.length) {
  console.log('  ✅ 全部通过：npm start 之后访问 http://localhost:' + PORT + '/next/admin.html');
} else {
  console.log('  ❌ ' + bad.length + ' 项需要处理：');
  bad.forEach((r) => console.log('     · ' + r.name + (r.detail ? '  →  ' + r.detail : '')));
  console.log('\n  按上面提示逐条处理后重跑：npm run doctor');
}
process.exit(bad.length ? 1 : 0);
