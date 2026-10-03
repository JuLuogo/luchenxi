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
// 2026-10：界面已统一到 Vue —— 旧版零构建页面必须**已删除**（见 docs/13 §1）
['admin.html', 'student.html', 'index.html', 'assets/js/admin.js', 'assets/js/bank.js'].forEach((f) =>
  ok('旧界面文件已删除 ' + f, !has(f), '若又出现了，说明有人把旧界面加回来了'));
['assets/js/store.js', 'assets/js/sync.js', 'sync-server.js'].forEach((f) => ok('核心脚本 ' + f, has(f), ''));
ok('客户端工程（apps/）', has('apps/teacher/src-tauri/Cargo.toml') && has('apps/student/src-tauri/Cargo.toml'),
  '两套 Tauri 工程；出包需要 Rust 工具链 + Android SDK');

/* ---------- 4. 本机构建工具链（出安装包要用） ---------- */
// 这些可以整体 portable 安装到 D:\app（scripts/setup-toolchain.ps1，免 UAC）
const APP = process.env.CI_APP_ROOT || 'D:\\app';
function firstExisting(list) { return list.find((p) => p && fs.existsSync(p)) || null; }

const cargoHome = process.env.CARGO_HOME || path.join(APP, 'rust', 'cargo');
const cargo = firstExisting([path.join(cargoHome, 'bin', 'cargo.exe'), path.join(cargoHome, 'bin', 'cargo')]);
let cargoVer = '';
if (cargo) {
  const r = spawnSync(cargo, ['--version'], { encoding: 'utf8', env: { ...process.env, CARGO_HOME: cargoHome, RUSTUP_HOME: process.env.RUSTUP_HOME || path.join(APP, 'rust', 'rustup') } });
  cargoVer = (r.stdout || '').trim() || (r.stderr || '').trim().slice(0, 60);
}
ok('Rust 工具链（cargo）', !!cargo, cargo ? cargoVer : '运行 scripts/setup-toolchain.ps1 -Only rust（约 20 秒，会自动用国内镜像）');

const mirrorCfg = firstExisting([path.join(cargoHome, 'config.toml'), path.join(cargoHome, 'config')]);
ok('cargo 镜像配置', !!mirrorCfg, mirrorCfg ? '已配置（直连 crates.io 在部分网络会超时）' : '未配置 → 拉依赖可能很慢');

const jdk = firstExisting([process.env.JAVA_HOME && path.join(process.env.JAVA_HOME, 'bin', 'java.exe'),
  path.join(APP, 'jdk17', 'bin', 'java.exe')]);
let jdkVer = '';
if (jdk) {
  const r = spawnSync(jdk, ['-version'], { encoding: 'utf8' });
  jdkVer = ((r.stderr || '') + (r.stdout || '')).split('\n')[0].trim();
}
ok('JDK 17（Android 构建用）', !!jdk, jdk ? jdkVer : '运行 scripts/setup-toolchain.ps1 -Only jdk');

const sdkRoot = process.env.ANDROID_SDK_ROOT || process.env.ANDROID_HOME || path.join(APP, 'android-sdk');
const sdkmanager = firstExisting([path.join(sdkRoot, 'cmdline-tools', 'latest', 'bin', 'sdkmanager.bat')]);
const ndk = firstExisting([process.env.NDK_HOME, path.join(sdkRoot, 'ndk', '26.1.10909125')]);
ok('Android SDK（cmdline-tools）', !!sdkmanager, sdkmanager ? sdkRoot : '运行 scripts/setup-toolchain.ps1 -Only android');
ok('Android NDK 26.1', !!ndk, ndk || '运行 scripts/setup-toolchain.ps1 -Only android（约 700MB）');

if (process.platform === 'win32') {
  const vswhere = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe';
  let msvc = null;
  if (fs.existsSync(vswhere)) {
    const r = spawnSync(vswhere, ['-latest', '-products', '*', '-property', 'installationPath'], { encoding: 'utf8' });
    const vsPath = (r.stdout || '').trim();
    if (vsPath) {
      const base = path.join(vsPath, 'VC', 'Tools', 'MSVC');
      if (fs.existsSync(base)) {
        const ver = fs.readdirSync(base)[0];
        msvc = firstExisting([path.join(base, ver, 'bin', 'Hostx64', 'x64', 'cl.exe')]);
      }
    }
  }
  ok('MSVC 编译器（cl.exe）', !!msvc, msvc ? path.dirname(msvc) : '需要 Visual Studio 生成工具 + C++ 工作负载');
  const sdkLib = 'C:\\Program Files (x86)\\Windows Kits\\10\\Lib';
  ok('Windows SDK', fs.existsSync(sdkLib), fs.existsSync(sdkLib) ? fs.readdirSync(sdkLib).join(', ') : '随 VS 生成工具一起装');
}

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
  console.log('  ✅ 全部通过：npm start 之后访问 http://localhost:' + PORT + '/（教师端）、/join（学生端）、/stage（大屏）');
} else {
  console.log('  ❌ ' + bad.length + ' 项需要处理：');
  bad.forEach((r) => console.log('     · ' + r.name + (r.detail ? '  →  ' + r.detail : '')));
  console.log('\n  按上面提示逐条处理后重跑：npm run doctor');
}
process.exit(bad.length ? 1 : 0);
