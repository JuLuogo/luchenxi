/*!
 * scripts/fetch-easytier.mjs — 下载 EasyTier 命令行版并按 Tauri sidecar 命名规则放到 apps/teacher/src-tauri/binaries/
 *
 *  Tauri 的 externalBin 约定：文件名必须是 <name>-<target-triple>[.exe]
 *  例如：binaries/easytier-core-x86_64-pc-windows-msvc.exe
 *
 *  用法：
 *    node scripts/fetch-easytier.mjs x86_64-pc-windows-msvc          # 从 GitHub 下载
 *    node scripts/fetch-easytier.mjs --from C:\tmp\easytier.zip      # 用已下载的压缩包（离线/代理环境）
 *    EASYTIER_MIRROR=https://ghfast.top/ node scripts/fetch-easytier.mjs   # 走加速镜像
 *
 *  说明：EasyTier 为 Apache-2.0 开源项目，这里只做"下载官方预编译产物并随包分发"，
 *        不修改其二进制；随包再分发时请在关于页标注来源与许可证（见 docs/11 §6）。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const VERSION = process.env.EASYTIER_VERSION || 'v2.2.2';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'apps', 'teacher', 'src-tauri', 'binaries');

/** target-triple → EasyTier Release 压缩包名（见 https://github.com/EasyTier/EasyTier/releases） */
const PACKAGES = {
  'x86_64-pc-windows-msvc': `easytier-windows-x86_64-${VERSION}.zip`,
  'aarch64-pc-windows-msvc': `easytier-windows-arm64-${VERSION}.zip`,
  'x86_64-apple-darwin': `easytier-macos-x86_64-${VERSION}.zip`,
  'aarch64-apple-darwin': `easytier-macos-aarch64-${VERSION}.zip`,
  'x86_64-unknown-linux-gnu': `easytier-linux-x86_64-${VERSION}.zip`,
  'aarch64-unknown-linux-gnu': `easytier-linux-aarch64-${VERSION}.zip`
};

const argv = process.argv.slice(2);
const fromIdx = argv.indexOf('--from');
const fromZip = fromIdx >= 0 ? argv[fromIdx + 1] : null;
const positional = argv.filter((a, i) => a !== '--from' && i !== fromIdx + 1 && !a.startsWith('--'));

const target = positional[0] || guessTarget();
function guessTarget() {
  const p = process.platform, a = process.arch;
  if (p === 'win32') return a === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
  if (p === 'darwin') return a === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
  return a === 'arm64' ? 'aarch64-unknown-linux-gnu' : 'x86_64-unknown-linux-gnu';
}

const pkg = PACKAGES[target];
if (!pkg) {
  console.error('不支持的 target：' + target + '\n可选：' + Object.keys(PACKAGES).join(', '));
  process.exit(1);
}

const mirror = process.env.EASYTIER_MIRROR || '';
const url = `${mirror}https://github.com/EasyTier/EasyTier/releases/download/${VERSION}/${pkg}`;
const isWin = target.includes('windows');
const ext = isWin ? '.exe' : '';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'easytier-'));

fs.mkdirSync(OUT_DIR, { recursive: true });

/** 用 Node 自带 fetch 下载，避免依赖外部 curl 的可用性 */
async function download(u, dest) {
  const res = await fetch(u, { redirect: 'follow' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
  return buf.length;
}

const zipPath = path.join(tmp, pkg);
if (fromZip) {
  if (!fs.existsSync(fromZip)) { console.error('找不到压缩包：' + fromZip); process.exit(1); }
  fs.copyFileSync(fromZip, zipPath);
  console.log('使用本地压缩包：' + fromZip);
} else {
  console.log('下载 ' + url);
  try {
    const size = await download(url, zipPath);
    console.log('已下载 ' + Math.round(size / 1024) + ' KB');
  } catch (e) {
    console.error('\n下载失败：' + (e.cause && e.cause.message ? e.cause.message : e.message));
    console.error('排查建议：');
    console.error('  1) 代理/自签证书环境：设置 NODE_EXTRA_CA_CERTS 指向企业根证书，或');
    console.error('     改用镜像：EASYTIER_MIRROR=https://ghfast.top/ node scripts/fetch-easytier.mjs ' + target);
    console.error('  2) 完全离线：先手动下载 ' + pkg);
    console.error('     然后 node scripts/fetch-easytier.mjs --from <压缩包路径> ' + target);
    console.error('  3) CI（GitHub Actions）里通常直连可用，无需任何额外配置。');
    fs.rmSync(tmp, { recursive: true, force: true });
    process.exit(1);
  }
}

function unzip(zipFile, dir) {
  if (process.platform === 'win32') {
    execFileSync('powershell', ['-NoProfile', '-Command',
      `Expand-Archive -LiteralPath '${zipFile}' -DestinationPath '${dir}' -Force`], { stdio: 'inherit' });
  } else {
    execFileSync('unzip', ['-o', zipFile, '-d', dir], { stdio: 'inherit' });
  }
}

console.log('解压中…');
unzip(zipPath, tmp);

// 压缩包里通常是 easytier-core / easytier-cli（可能在某层子目录）
function findBinary(name) {
  const stack = [tmp];
  while (stack.length) {
    const dir = stack.pop();
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { stack.push(full); continue; }
      if (e.name === name || e.name === name + '.exe') return full;
    }
  }
  return null;
}

let placed = 0;
for (const name of ['easytier-core', 'easytier-cli']) {
  const found = findBinary(name);
  if (!found) { console.warn('  ! 压缩包里没找到 ' + name); continue; }
  const dest = path.join(OUT_DIR, `${name}-${target}${ext}`);
  fs.copyFileSync(found, dest);
  if (!isWin) fs.chmodSync(dest, 0o755);
  console.log('  ✔ ' + path.relative(ROOT, dest));
  placed++;
}

fs.rmSync(tmp, { recursive: true, force: true });
if (!placed) {
  console.error('没有放置任何二进制：压缩包内容与预期不符（应含 easytier-core / easytier-cli）');
  process.exit(1);
}
console.log('完成：' + placed + ' 个 sidecar 已就位（target=' + target + '）');
