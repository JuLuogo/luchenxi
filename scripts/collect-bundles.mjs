/*!
 * scripts/collect-bundles.mjs — 把 tauri build 产出的安装包归集到 bundle-out/，
 * 并改成 **ASCII 文件名** 再上传 artifact。
 *
 *   node scripts/collect-bundles.mjs --app teacher --os windows-latest --target x86_64-pc-windows-msvc
 *
 * 为什么必须改名：`actions/upload-artifact` / `download-artifact` 对非 ASCII 文件名
 * （我们的包名是「课堂积分-教师端_4.0.0_x64_zh-CN.msi」）历史上不可靠 ——
 * v4.1.3 的 Release 作业在 dist 里一个安装包都没找到，这是当前最可疑的环节。
 * 改名后 Release 资产名也变成稳定的 ASCII（如 teacher-windows-latest-0.msi）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
function arg(name, fallback) {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

const app = arg('app', 'teacher');
const osName = arg('os', 'unknown');
const target = arg('target', '');

const EXTENSIONS = ['.msi', '.exe', '.dmg', '.appimage', '.deb', '.apk'];

/** 在客户端目录里找 bundle 产物（移动端与桌面端路径不同） */
function findBundles(dir, depth) {
  if (depth > 6 || !fs.existsSync(dir)) return [];
  let out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const q = path.join(dir, e.name);
    if (e.isDirectory()) out = out.concat(findBundles(q, depth + 1));
    else if (EXTENSIONS.some((x) => e.name.endsWith(x))) out.push(q);
  }
  return out;
}

const cwd = process.cwd();
const bases = target
  ? [
      path.join(cwd, 'src-tauri', 'target', target, 'release', 'bundle'),
      path.join(cwd, 'src-tauri', 'gen', 'android', 'app', 'build', 'outputs', 'apk')
    ]
  : [path.join(cwd, 'src-tauri', 'target', 'release', 'bundle')];

const found = [];
for (const b of bases) found.push(...findBundles(b, 0));

if (!found.length) {
  console.error('::error::没有找到任何安装包（找过：' + bases.join('，') + '）');
  process.exit(1);
}

const outDir = path.join(cwd, 'bundle-out');
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

found.forEach((f, i) => {
  const ext = path.extname(f);
  const name = `${app}-${osName}-${i}${ext}`;
  fs.copyFileSync(f, path.join(outDir, name));
  console.log(`  ${name}  ←  ${path.basename(f)}  (${(fs.statSync(f).size / 1048576).toFixed(1)} MB)`);
});

console.log(`[ok] 归集 ${found.length} 个安装包到 bundle-out/（ASCII 文件名）`);
