/*!
 * scripts/collect-bundles.mjs — 把 tauri build 产出的安装包归集到 bundle-out/，
 * 并改成 **ASCII 文件名** 再上传 artifact。
 *
 *   node scripts/collect-bundles.mjs --app teacher --os windows-latest --target x86_64-pc-windows-msvc
 *
 * 两个关键点：
 *   1. v5 起 Cargo 工作区把 target 目录收在**仓库根**（`<root>/target/<triple>/release/bundle`），
 *      不再是每个客户端自己的 `src-tauri/target/...` —— 两条路径都要找。
 *   2. `actions/upload-artifact` 对非 ASCII 文件名（「课堂积分-教师端_...msi」）不可靠，
 *      所以拷进 bundle-out/ 时统一改成 `app-os-N.ext` 的稳定 ASCII 名。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(SCRIPT_DIR, '..');

const argv = process.argv.slice(2);
function arg(name, fallback) {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

const app = arg('app', 'teacher');
const osName = arg('os', 'unknown');
const target = arg('target', '');
const cwd = process.cwd();

const EXTENSIONS = ['.msi', '.exe', '.dmg', '.appimage', '.deb', '.apk'];

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

/** 候选目录：workspace 根的 target（v5 主路径）+ 客户端自己的 target（旧路径兜底）+ APK 产物 */
const bases = [
  path.join(ROOT, 'target', target, 'release', 'bundle'),
  path.join(cwd, 'src-tauri', 'target', target, 'release', 'bundle'),
  path.join(cwd, 'src-tauri', 'gen', 'android', 'app', 'build', 'outputs', 'apk'),
];

const found = [];
for (const b of bases) found.push(...findBundles(b, 0));

// workspace 根的 target 是所有客户端共享的，必须按本客户端的 productName 过滤，
// 否则学生端作业会把教师端的 MSI 也传上去
let productName = '';
try {
  const conf = JSON.parse(fs.readFileSync(path.join(cwd, 'src-tauri', 'tauri.conf.json'), 'utf8'));
  productName = conf.productName || '';
} catch { /* 读不到就不过滤（旧路径各自独立，不会混） */ }

let picked = found;
if (productName) {
  picked = found.filter((f) => path.basename(f).includes(productName));
  if (!picked.length) {
    console.error(`::error::找到了 ${found.length} 个安装包，但都不属于本客户端（productName=${productName}）`);
    process.exit(1);
  }
}

if (!found.length) {
  console.error('::error::没有找到任何安装包（找过：' + bases.join('，') + '）');
  console.error('::error::若也没有 workspace 根 target/，多半是 tauri build 没产出 bundle —— 看上一步日志');
  process.exit(1);
}

const outDir = path.join(cwd, 'bundle-out');
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

picked.forEach((f, i) => {
  const ext = path.extname(f);
  const name = `${app}-${osName}-${i}${ext}`;
  fs.copyFileSync(f, path.join(outDir, name));
  console.log(`  ${name}  ←  ${path.basename(f)}  (${(fs.statSync(f).size / 1048576).toFixed(1)} MB)`);
});

console.log(`[ok] 归集 ${found.length} 个安装包到 bundle-out/（ASCII 文件名）`);
