/*!
 * tests/client.test.js — 客户端离线自洽性：套壳之后能否独立跑起来
 *   node tests/client.test.js
 *
 * 客户端（Tauri）不加载仓库根目录，只加载 `apps/<app>/ui/` 里被复制过去的那一份。
 * 所以"能不能跑起来"取决于三件事，本文件逐条钉住：
 *   ① 资源闭包：入口 HTML 引用的每个本地文件都存在、且都会被 sync-ui 复制进 ui/
 *   ② 运行环境：CSP 放行内联脚本/图片/WebSocket/HTTP；file:// 或 asset 协议下能连到内置枢纽
 *   ③ 不依赖"客户端里没有的东西"：例如 Rust 枢纽不提供 /qr.png，界面必须有文字降级
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let passed = 0;
const failures = [];
function ok(cond, label) { if (cond) passed++; else failures.push(label); }
function group(n) { console.log('\n== ' + n + ' =='); }

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));
const readJSON = (rel) => JSON.parse(read(rel));

const APPS = {
  teacher: { entry: ['admin.html', 'index.html'], conf: 'apps/teacher/src-tauri/tauri.conf.json' },
  student: { entry: ['student.html'], conf: 'apps/student/src-tauri/tauri.conf.json' }
};

/** 从 HTML 里收集本地资源引用（script src / link href / img src） */
function collectRefs(html) {
  const text = read(html);
  const out = new Set();
  const re = /(?:src|href)="([^"]+)"/g;
  let m;
  while ((m = re.exec(text))) {
    const u = m[1];
    if (/^(https?:|data:|mailto:|#)/.test(u)) continue;
    out.add(u);
  }
  return [...out];
}

/** CSS 里的 url(...)（排除 data:） */
function collectCssUrls(css) {
  const text = read(css);
  const out = [];
  const re = /url\(\s*['"]?([^'")]+)['"]?\s*\)/g;
  let m;
  while ((m = re.exec(text))) {
    if (/^data:/.test(m[1])) continue;
    out.push(m[1]);
  }
  return out;
}

/* ================= 1. 资源闭包 ================= */
group('资源闭包（客户端里能不能找到这些文件）');

Object.keys(APPS).forEach((app) => {
  APPS[app].entry.forEach((html) => {
    ok(exists(html), app + ' 入口页存在：' + html);
    const refs = collectRefs(html);
    ok(refs.length > 0 || app === 'teacher', app + '/' + html + ' 引用 ' + refs.length + ' 个本地资源');
    refs.forEach((r) => {
      // 不允许越出仓库根（客户端里没有仓库结构）
      ok(r.indexOf('../') < 0, app + ' 引用不得向上越界：' + r);
      ok(r[0] !== '/', app + ' 不得用绝对路径（asset 协议下会 404）：' + r);
      ok(exists(r), app + ' 引用的文件存在：' + r);
    });
  });
});

// CSS 里的图片/字体引用
group('CSS 资源');
['assets/css/app.css', 'assets/css/student.css'].forEach((css) => {
  const urls = collectCssUrls(css);
  urls.forEach((u) => {
    ok(u.indexOf('../') < 0 && u[0] !== '/', css + ' 里的 url() 用相对路径：' + u);
    ok(exists(path.join('assets/css', u)) || exists(u), css + ' 引用的资源存在：' + u);
  });
  console.log('  · ' + css + ' 外部 url() 数量：' + urls.length);
});

// sync-ui 必须把这些资源都复制过去
group('sync-ui 复制清单覆盖全部引用');
const syncUi = read('scripts/sync-ui.mjs');
Object.keys(APPS).forEach((app) => {
  APPS[app].entry.forEach((html) => {
    ok(syncUi.indexOf("'" + html + "'") >= 0, 'sync-ui 配置包含入口页 ' + html);
  });
});
ok(/web\/dist|DIST/.test(syncUi), 'sync-ui 的来源是 Vue 构建产物 web/dist（不再是旧版 assets/）');
ok(/favicon\.svg/.test(syncUi), 'sync-ui 带上 favicon');
ok(/没有引用 \.\/assets\//.test(syncUi), 'sync-ui 有入口自检：拷进来的 html 必须引用 ./assets/');
ok(!/assets\/css\/app\.css/.test(syncUi), 'sync-ui 不再拷旧版 app.css（界面已统一到 Vue）');
ok(!/assets\/css\/student\.css/.test(syncUi), 'sync-ui 不再拷旧版 student.css');
ok(/schema\.sql/.test(syncUi), 'sync-ui 同时把 SQLite schema 给 Rust 侧');

/* 关键契约：客户端打包的必须是 Vue 产物，而不是旧版零构建页面
   —— 否则又回到"网页版是新界面、客户端还是旧脸"的分裂状态 */
Object.keys(APPS).forEach((app) => {
  const uiDir = path.join(ROOT, 'apps', app, 'ui');
  if (!fs.existsSync(uiDir)) return;
  APPS[app].entry.forEach((html) => {
    const text = fs.readFileSync(path.join(uiDir, html), 'utf8');
    ok(text.includes('./assets/'), app + '/' + html + ' 引用 Vite 产物（./assets/）');
    ok(!/assets\/js\/store\.js/.test(text), app + '/' + html + ' 不再引用旧版 assets/js/store.js');
  });
});

// 生成后（若存在）再核对一遍实际闭包
Object.keys(APPS).forEach((app) => {
  const uiDir = path.join(ROOT, 'apps', app, 'ui');
  if (!fs.existsSync(uiDir)) return;
  APPS[app].entry.forEach((html) => {
    const refs = collectRefs('apps/' + app + '/ui/' + html);
    refs.forEach((r) => {
      ok(fs.existsSync(path.join(uiDir, r)), '生成后的 ui/ 里存在：' + app + '/' + r);
    });
  });
});

/* ================= 2. 运行环境（CSP 与连接回落） ================= */
group('客户端运行环境');

Object.keys(APPS).forEach((app) => {
  const conf = readJSON(APPS[app].conf);
  const csp = (conf.app.security && conf.app.security.csp) || '';
  ok(csp.indexOf("script-src 'self' 'unsafe-inline'") >= 0,
    app + ' CSP 放行内联脚本（页面用 inline onclick，必须）');
  ok(csp.indexOf('data:') >= 0, app + ' CSP 放行 data: 图片');
  ok(csp.indexOf('ws:') >= 0 && csp.indexOf('wss:') >= 0, app + ' CSP 放行 WebSocket');
  ok(csp.indexOf('http:') >= 0, app + ' CSP 放行 http（/health 与二维码）');
  ok(csp.indexOf('object-src') < 0 || csp.indexOf("object-src 'none'") >= 0, app + ' CSP 未放开 object-src');
});

// 客户端里页面不是由枢纽托管（asset 协议），sync.js 必须回落到本机默认端口
const syncJs = read('assets/js/sync.js');
ok(/servedOverHttp/.test(syncJs), 'sync.js 能识别"是否由枢纽托管"');
ok(/ws:\/\/localhost:' \+ DEFAULT_LOCAL_PORT/.test(syncJs), 'sync.js 在非 http 场景回落到 ws://localhost:8080（内置枢纽）');
// 常量必须**真的声明**过：曾经三处使用、零处定义 → 双击 admin.html 时抛 ReferenceError、整页初始化失败
ok(/var DEFAULT_LOCAL_PORT\s*=/.test(syncJs), 'DEFAULT_LOCAL_PORT 已声明（不是"用了但没定义"）');
ok(/var DEFAULT_LOCAL_PORT\s*=[\s\S]{0,80}?8080/.test(syncJs), 'DEFAULT_LOCAL_PORT 默认 8080');
ok(/CI_DEFAULT_PORT/.test(syncJs), 'DEFAULT_LOCAL_PORT 可被 window.CI_DEFAULT_PORT 覆盖（客户端注入）');
ok(/storage\.js/.test(read('admin.html')), '教师端加载 storage.js（客户端走 invoke 直连 SQLite）');
ok(/__TAURI/.test(read('assets/js/storage.js')), 'storage.js 识别 Tauri 环境');

// 客户端里进程可能随时被系统回收：必须在关页/切后台时立即落库，不能等防抖
const storageJs = read('assets/js/storage.js');
const adminJs = read('assets/js/admin.js');
ok(/flush: flush/.test(storageJs), 'storage.js 暴露 flush()');
ok(/addEventListener\('beforeunload', flushNow\)/.test(adminJs), '教师端在 beforeunload 时 flush');
ok(/visibilitychange/.test(adminJs), '教师端在切到后台时 flush');
ok(/retryTimer = setTimeout/.test(storageJs), '写入失败有退避重试');
ok(/MAX_RETRY/.test(storageJs), '重试有上限（不会无限重试）');
ok(/r\.json\(\)\.catch\(function \(\) \{ return null; \}\)/.test(storageJs),
  '409 过期写入也解析 JSON 正文（不能只看 r.ok）');
ok(/staleRejected/.test(storageJs), '过期写入被拒时单独标记（不是普通失败）');

/* ================= 3. 不依赖客户端里不存在的东西 ================= */
group('不依赖枢纽没提供的接口');

const classroomJs = read('assets/js/classroom.js');
// Rust 枢纽只实现 /health、/api/state、/api/stats、/api/backup、/api/restore（无 /qr.png）
ok(/\/qr\.png/.test(classroomJs) || /qrURL/.test(classroomJs), '教师端会尝试加载二维码图片');
ok(/onerror=/.test(classroomJs) && /classQrFallback/.test(classroomJs),
  '二维码加载失败时有文字降级（Rust 枢纽不提供 /qr.png）');
ok(/kQrFallback|二维码/.test(classroomJs), '界面上有二维码相关的提示文案');

// 学生端只依赖 WebSocket + 本地存储
const stuJs = read('assets/js/student.js');
ok(stuJs.indexOf('/health') >= 0, '学生端自检访问 /health（Rust 枢纽提供）');
ok(stuJs.indexOf('check_hub') >= 0, '客户端里自检走 invoke(check_hub)');
ok(!/\/api\//.test(stuJs), '学生端不依赖 /api/*（只发命令）');

// 教师端页面不得引用学生端专属脚本之外的东西
['assets/js/store.js', 'assets/js/storage.js', 'assets/js/sync.js', 'assets/js/classroom.js', 'assets/js/net.js']
  .forEach((f) => ok(read('admin.html').indexOf(f) >= 0, '教师端加载 ' + f));
ok(read('student.html').indexOf('assets/js/student.js') >= 0, '学生端只加载 student.js');
ok(read('student.html').indexOf('assets/js/admin.js') < 0, '学生端不加载教师端脚本');

/* ================= 4. 真机才会暴露的两件事 ================= */
group('真机安全策略（安全上下文 / Android 明文流量）');

// ① 窗口 origin 必须是 http://tauri.localhost（而不是 https://tauri.localhost），
//    否则 WebView 以"混合内容"为由禁止连 `ws://教师机IP:8080`，学生会一直连不上。
Object.keys(APPS).forEach((app) => {
  const conf = readJSON(APPS[app].conf);
  const win = (conf.app.windows || [])[0] || {};
  ok(win.useHttpsScheme === false,
    app + ' 显式 useHttpsScheme=false（保住 http:// 源，ws:// 才不会被混合内容策略拦下）');
});
// ② Android 9+ 默认禁止明文流量，而学生端连的就是局域网 ws://
ok(exists('scripts/patch-android-manifest.mjs'), '存在 Android 清单修补脚本（放行明文流量）');
const patchSrc = read('scripts/patch-android-manifest.mjs');
ok(/usesCleartextTraffic/.test(patchSrc), '修补脚本写入 usesCleartextTraffic');
ok(/--check/.test(patchSrc), '修补脚本支持 --check（CI 可只校验）');
ok(/--require/.test(patchSrc), '修补脚本支持 --require（构建时找不到清单要报错）');
ok(/tauri android init/.test(patchSrc), '脚本说明了前置条件（先 android init）');
const buildYml = read('.github/workflows/build.yml');
ok(/patch-android-manifest\.mjs --app student/.test(buildYml), 'build.yml 在 Android 打包前调用修补脚本');

/* ================= 收尾 ================= */
console.log('\n----------------------------------------');
if (failures.length) {
  console.log(`❌ 失败 ${failures.length} 项 / 通过 ${passed} 项`);
  failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
  process.exit(1);
} else {
  console.log(`✅ 全部通过：${passed} 项断言`);
}
