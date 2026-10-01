/*!
 * scripts/patch-android-manifest.mjs — 给 Android 客户端放行**明文流量**
 *
 *  为什么必须做：学生端在教室里连的是 `ws://192.168.x.x:8080`（教师机局域网地址 / EasyTier 虚拟 IP），
 *  这是**明文**连接。Android 9（API 28）起默认禁止明文流量，不放开的话真机上会直接连不上教师机——
 *  而这个现象在桌面端完全看不到。Tauri 的配置里没有对应开关
 *  （`bundle.android` 只有 minSdkVersion/versionCode 等），只能改生成的 AndroidManifest.xml。
 *
 *  用法：
 *    node scripts/patch-android-manifest.mjs --app student          # 就地修补（幂等）
 *    node scripts/patch-android-manifest.mjs --app student --check  # 只检查，未修补则退出码 1
 *    node scripts/patch-android-manifest.mjs --dir <gen/android 路径>
 *
 *  说明：`gen/android` 由 `tauri android init` 生成且通常不入库，所以 CI 里要在 init 之后、build 之前调用。
 *  找不到清单时默认**静默成功**（还没 init），加 `--require` 可改成报错。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return fallback;
  const next = process.argv[i + 1];
  return next && next[0] !== '-' ? next : true;
}

const app = arg('app', 'student');
const dir = arg('dir', null);
const checkOnly = !!arg('check', false);
const require_ = !!arg('require', false);

const base = dir
  ? path.resolve(String(dir))
  : path.join(ROOT, 'apps', String(app), 'src-tauri', 'gen', 'android');
const manifest = path.join(base, 'app', 'src', 'main', 'AndroidManifest.xml');

if (!fs.existsSync(manifest)) {
  const msg = '未找到 Android 清单（' + path.relative(ROOT, manifest) + '）：先跑 `npx tauri android init`';
  if (require_) { console.error('[fail] ' + msg); process.exit(1); }
  console.log('[skip] ' + msg);
  process.exit(0);
}

const original = fs.readFileSync(manifest, 'utf8');
const ATTR = 'android:usesCleartextTraffic="true"';
const already = /android:usesCleartextTraffic\s*=\s*"true"/.test(original);
const wrongValue = /android:usesCleartextTraffic\s*=\s*"false"/.test(original);

if (already) {
  console.log('[ok] 已放行明文流量：' + path.relative(ROOT, manifest));
  process.exit(0);
}

if (checkOnly) {
  console.error('[fail] 未放行明文流量（学生端在真机上会连不上教师机）：' + path.relative(ROOT, manifest));
  console.error('       运行 node scripts/patch-android-manifest.mjs --app ' + app);
  process.exit(1);
}

let patched;
if (wrongValue) {
  patched = original.replace(/android:usesCleartextTraffic\s*=\s*"false"/, ATTR);
} else {
  // 插到 <application 标签的其它属性之后（保持单行可读）
  patched = original.replace(/<application\b([^>]*?)>/, (all, attrs) => {
    const sep = /\n\s*$/.test(attrs) ? '' : ' ';
    return '<application' + attrs + sep + '\n        ' + ATTR + '>';
  });
}

if (patched === original) {
  console.error('[fail] 没能插入属性：<application 标签结构异常，请手工添加 ' + ATTR);
  process.exit(1);
}

fs.writeFileSync(manifest, patched, 'utf8');
console.log('[write] 已放行明文流量：' + path.relative(ROOT, manifest));
console.log('        原因：学生端连 `ws://<教师机IP>:8080`（局域网 / EasyTier 虚拟 IP），Android 9+ 默认禁止明文');
console.log('        注意：仅放行明文，不涉及 TLS；课堂内网使用，公网暴露请加反代鉴权');
