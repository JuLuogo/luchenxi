/*!
 * scripts/patch-android-manifest.mjs — 给 Android 客户端放行**明文流量**
 *
 *  为什么必须做：学生端在教室里连的是 `ws://192.168.x.x:8080`（教师机局域网地址 / EasyTier 虚拟 IP），
 *  这是**明文**连接。Android 9（API 28）起默认禁止明文流量，不放开的话真机上直接连不上教师机 ——
 *  而这个现象在桌面端完全看不到。
 *
 *  **正确改法是 Gradle 的 manifestPlaceholders**（不是往清单里塞属性）：
 *  Tauri 的 Android 模板已经写好占位符
 *      defaultConfig { manifestPlaceholders["usesCleartextTraffic"] = "false" }   // release 默认禁
 *      buildTypes { getByName("debug") { manifestPlaceholders[...] = "true" } }   // 只有 debug 放行
 *  清单里用的是 `${usesCleartextTraffic}`。我们只要把 defaultConfig 那个改成 "true"，
 *  release 包就放行了 —— 一行改动、幂等、且不会和模板打架。
 *
 *  ⚠️ 曾经的错误做法：往 AndroidManifest.xml 的 <application> 里插 `android:usesCleartextTraffic="true"`。
 *  那会与模板自带的 `${usesCleartextTraffic}` **同名重复**，Android 的清单合并器直接报
 *  `ManifestMerger2$MergeFailureException: Error parsing AndroidManifest.xml`，APK 构建失败。
 *  本脚本现在会把这种历史残留自动清掉（自愈）。
 *
 *  用法：
 *    node scripts/patch-android-manifest.mjs --app student          # 就地修补（幂等）
 *    node scripts/patch-android-manifest.mjs --app student --check  # 只检查，未修补则退出码 1
 *    node scripts/patch-android-manifest.mjs --dir <gen/android 路径>
 *
 *  说明：`gen/android` 由 `tauri android init` 生成，CI 里在 init 之后、build 之前调用。
 *  找不到工程时默认**静默成功**（还没 init），加 `--require` 可改成报错。
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
const gradle = path.join(base, 'app', 'build.gradle.kts');
const manifest = path.join(base, 'app', 'src', 'main', 'AndroidManifest.xml');

if (!fs.existsSync(gradle)) {
  const msg = '未找到 Android 工程（' + path.relative(ROOT, gradle) + '）：先跑 `npx tauri android init`';
  if (require_) { console.error('[fail] ' + msg); process.exit(1); }
  console.log('[skip] ' + msg);
  process.exit(0);
}

const src = fs.readFileSync(gradle, 'utf8');
const PLACEHOLDER = 'manifestPlaceholders["usesCleartextTraffic"]';
const esc = (s) => s.replace(/[[\](){}.*+?^$\\|]/g, '\\$&');

/**
 * 只看**第一处**（defaultConfig 里那处，模板里排在最前）：
 * buildTypes.debug 里还有一处 "true"，不能拿它当"已放行"的证据。
 */
function firstPlaceholderIsTrue(text) {
  const i = text.indexOf(PLACEHOLDER);
  if (i < 0) return false;
  return /^\s*=\s*"true"/.test(text.slice(i + PLACEHOLDER.length));
}

const alreadyOn = firstPlaceholderIsTrue(src);

if (checkOnly) {
  if (!alreadyOn) {
    console.error('[fail] release 包未放行明文流量（学生端在真机上会连不上教师机）：' + path.relative(ROOT, gradle));
    console.error('       运行 node scripts/patch-android-manifest.mjs --app ' + app);
    process.exit(1);
  }
  console.log('[ok] 已放行明文流量：' + path.relative(ROOT, gradle));
  process.exit(0);
}

let patched = src;
if (!alreadyOn) {
  // 只改第一处（defaultConfig）；String.replace 用非全局正则天然只替第一处
  const re = new RegExp('(' + esc(PLACEHOLDER) + '\\s*=\\s*)"false"');
  if (re.test(patched)) {
    patched = patched.replace(re, '$1"true"');
  } else {
    // 模板变了：退而求其次，往 defaultConfig 块里插一行
    patched = patched.replace(/defaultConfig\s*\{/, (m) => m + '\n        ' + PLACEHOLDER + ' = "true"');
  }
}

if (patched !== src) {
  fs.writeFileSync(gradle, patched, 'utf8');
  console.log('[write] 已放行明文流量：' + path.relative(ROOT, gradle));
  console.log('        原因：学生端连 `ws://<教师机IP>:8080`（局域网 / EasyTier 虚拟 IP），Android 9+ 默认禁止明文');
  console.log('        注意：仅放行明文，不涉及 TLS；课堂内网使用，公网暴露请加反代鉴权');
} else {
  console.log('[ok] 已放行明文流量：' + path.relative(ROOT, gradle));
}

/* ---- 自愈：清掉历史上被写脏的清单（同名属性重复会让清单合并器直接报错） ---- */
if (fs.existsSync(manifest)) {
  const mf = fs.readFileSync(manifest, 'utf8');
  const hasPlaceholder = /android:usesCleartextTraffic\s*=\s*"\$\{usesCleartextTraffic\}"/.test(mf);
  const literal = /android:usesCleartextTraffic\s*=\s*"true"/.test(mf);
  if (hasPlaceholder && literal) {
    // 以前插进去的字面量属性有两种形状：独立成行，或顶在 `<application ...>` 的收尾处
    const cleaned = mf
      .replace(/^[ \t]*android:usesCleartextTraffic\s*=\s*"true"[ \t]*\r?\n/gm, '')
      .replace(/android:usesCleartextTraffic\s*=\s*"true"\s*(?=>)/g, '');
    if (cleaned !== mf) {
      fs.writeFileSync(manifest, cleaned, 'utf8');
      console.log('[fix] 清掉清单里重复的 usesCleartextTraffic 字面量（会导致清单合并失败）');
    }
  }
}
