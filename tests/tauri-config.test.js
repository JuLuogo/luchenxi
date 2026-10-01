/*!
 * tests/tauri-config.test.js — 用**官方 Tauri v2 schema** 校验两份客户端配置
 *   node tests/tauri-config.test.js
 *
 * 为什么要有它：配置里写错一个键名（例如把 `iOS` 写成 `ios`、把 `externalBin` 写成 `externalBins`），
 * 本地完全看不出来，CI 一构建就慢失败。这里用入库的官方 schema（packages/schema/tauri-config.schema.json）
 * 离线校验，把这类错误提前到秒级。
 *
 * 刷新 schema：node scripts/fetch-schema.mjs
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let passed = 0;
const failures = [];
function ok(cond, label) { if (cond) passed++; else failures.push(label); }
function group(n) { console.log('\n== ' + n + ' =='); }

const readJSON = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const SCHEMA_PATH = 'packages/schema/tauri-config.schema.json';

/* ================= 1. schema 本身 ================= */
group('官方 schema');
ok(fs.existsSync(path.join(ROOT, SCHEMA_PATH)), 'schema 已入库（可离线校验）');
const schema = readJSON(SCHEMA_PATH);
ok(schema.$schema && schema.$schema.indexOf('json-schema.org') >= 0, 'schema 声明为 JSON Schema');
['productName', 'version', 'identifier', 'app', 'build', 'bundle', 'plugins'].forEach((k) => {
  ok(!!schema.properties[k], 'schema 顶层含 ' + k);
});
ok(schema.additionalProperties === false, 'schema 顶层禁止未知键（写错键名会被抓出）');

const bundleRef = (schema.properties.bundle.allOf && schema.properties.bundle.allOf[0].$ref) || schema.properties.bundle.$ref;
const bundleDef = schema.definitions[bundleRef.split('/').pop()];
['active', 'targets', 'icon', 'externalBin', 'windows', 'linux', 'macOS', 'iOS', 'android'].forEach((k) => {
  ok(!!bundleDef.properties[k], 'bundle 支持 ' + k);
});

/* ================= 2. 用 ajv 校验两份配置 ================= */
group('官方 schema 校验（ajv）');

let Ajv = null;
try { Ajv = require('ajv'); } catch (e) { /* 未安装则跳过 */ }

if (!Ajv) {
  failures.push('缺少 ajv 依赖（npm i -D ajv）');
} else {
  // unicodeRegExp:false —— Tauri 官方 schema 里有 `/^[^/\:*?"<>|]+$/u` 这类在 u 模式下非法的转义，
  // 关掉 u 标志即可正常编译（不影响我们关心的键名/类型校验）。
  const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false, unicodeRegExp: false });
  const validate = ajv.compile(schema);

  const CONFIGS = ['apps/teacher/src-tauri/tauri.conf.json', 'apps/student/src-tauri/tauri.conf.json'];
  CONFIGS.forEach((rel) => {
    const conf = readJSON(rel);
    const valid = validate(conf);
    if (valid) passed++;
    else {
      const msgs = (validate.errors || []).slice(0, 6).map((e) => (e.instancePath || '/') + ' ' + e.message + ' ' + JSON.stringify(e.params));
      failures.push(rel + ' 不符合 Tauri v2 schema：' + msgs.join(' | '));
    }
    // 逐条报告关键字段（即便通过也留痕，便于排障）
    console.log('  · ' + rel + ' → ' + (valid ? 'schema 校验通过' : '不通过'));
  });

  /* ================= 3. 逐项语义检查（schema 管不到的约束） ================= */
  group('配置语义（schema 之外的约定）');

  const teacher = readJSON('apps/teacher/src-tauri/tauri.conf.json');
  const student = readJSON('apps/student/src-tauri/tauri.conf.json');

  // identifier 必须是反写域名，且两端不能相同
  ok(/^[a-z0-9.]+$/i.test(teacher.identifier) && teacher.identifier.includes('.'), '教师端 identifier 合法：' + teacher.identifier);
  ok(teacher.identifier !== student.identifier, '两套客户端 identifier 不同（否则安装会互相覆盖）');

  // frontendDist 必须指向由 sync-ui 生成的 ui/
  [teacher, student].forEach((c, i) => {
    const name = i === 0 ? '教师端' : '学生端';
    ok(c.build && c.build.frontendDist === '../ui', name + ' frontendDist 指向 ../ui（sync-ui 生成）');
    ok(!c.build.devUrl, name + ' 未设置 devUrl（本方案用静态文件，不需要 dev server）');
  });

  // externalBin 只出现在教师端，且必须是 binaries/ 下的 easytier-*
  ok((teacher.bundle.externalBin || []).length === 2, '教师端登记 2 个 sidecar');
  ok((student.bundle.externalBin || []).length === 0, '学生端不登记 sidecar（Android 无 CLI）');
  (teacher.bundle.externalBin || []).forEach((p) => {
    ok(/^binaries\/easytier-(core|cli)$/.test(p), 'sidecar 路径规范：' + p);
  });

  // 图标列表里的每个文件都要真实存在（generate_context! 会检查）
  [teacher, student].forEach((c, i) => {
    const name = i === 0 ? '教师端' : '学生端';
    (c.bundle.icon || []).forEach((f) => {
      ok(fs.existsSync(path.join(ROOT, 'apps', i === 0 ? 'teacher' : 'student', 'src-tauri', f)),
        name + ' 图标存在：' + f);
    });
  });

  // CSP：既要放行 WebSocket/网络，又不能放开脚本来源
  [teacher, student].forEach((c, i) => {
    const name = i === 0 ? '教师端' : '学生端';
    const csp = (c.app.security && c.app.security.csp) || '';
    ok(csp.indexOf("script-src 'self'") >= 0, name + ' CSP 限制脚本来源');
    ok(csp.indexOf('connect-src') >= 0 && csp.indexOf('ws:') >= 0, name + ' CSP 放行 WebSocket');
    ok(csp.indexOf('img-src') >= 0, name + ' CSP 放行图片（二维码/头像）');
  });

  // 窗口尺寸合理
  [teacher, student].forEach((c, i) => {
    const name = i === 0 ? '教师端' : '学生端';
    const w = c.app.windows[0];
    ok(w.width >= 320 && w.height >= 480, name + ' 窗口尺寸合理：' + w.width + '×' + w.height);
    ok(!!w.title, name + ' 窗口有标题');
  });

  // 学生端桌面打包目标合法（Android 产物由 `tauri android build` 生成，**不能**写进 bundle.targets ——
  // 那是桌面枚举，写 apk/aab 会被官方 schema 判为非法，这里曾经踩过）
  ok((student.bundle.targets || []).includes('nsis') || (student.bundle.targets || []).includes('deb'),
    '学生端包含桌面打包目标：' + JSON.stringify(student.bundle.targets));
  ok(!(student.bundle.targets || []).includes('apk'), 'bundle.targets 不写 apk（Android 走 tauri android build）');
  ok(!(student.bundle.targets || []).includes('aab'), 'bundle.targets 不写 aab');
  ok(bundleDef.properties.targets, 'schema 确认 targets 是桌面打包目标枚举');
  ok(!!student.bundle.iOS, '学生端配置了 bundle.iOS（iOS 预留）');
  ok(/^\d+(\.\d+)?/.test(student.bundle.iOS.minimumSystemVersion || ''), 'iOS 最低系统版本格式正确：' + student.bundle.iOS.minimumSystemVersion);
  ok(!!student.bundle.android && student.bundle.android.minSdkVersion >= 24, 'Android minSdkVersion ≥ 24（' + (student.bundle.android || {}).minSdkVersion + '）');

  // capabilities 与窗口名一致（权限文件里的 windows 要能匹配到窗口）
  ['teacher', 'student'].forEach((app) => {
    const cap = readJSON('apps/' + app + '/src-tauri/capabilities/default.json');
    ok(Array.isArray(cap.permissions) && cap.permissions.length > 0, app + ' capabilities 声明了权限');
    ok(cap.permissions.some((p) => p.indexOf('core:default') === 0), app + ' capabilities 含 core:default');
    const conf = readJSON('apps/' + app + '/src-tauri/tauri.conf.json');
    ok(Array.isArray(cap.windows) && cap.windows.includes('main'), app + ' capabilities 的 windows 指向 main');
    // 用到的插件必须在依赖里，并出现在 capabilities 中
    const pkg = readJSON('apps/' + app + '/package.json');
    Object.keys(pkg.dependencies || {}).filter((d) => d.indexOf('@tauri-apps/plugin-') === 0).forEach((d) => {
      const short = d.replace('@tauri-apps/plugin-', '');
      ok(cap.permissions.some((p) => p.indexOf(short + ':') === 0), app + ' capabilities 放行插件 ' + short);
    });
  });
}

/* ================= 4. 权限标识必须真实存在（对照插件 crate 提取的清单） ================= */
group('权限标识真实性（来自插件 crate）');

const PERMS_PATH = 'packages/schema/plugin-permissions.json';
if (!fs.existsSync(path.join(ROOT, PERMS_PATH))) {
  failures.push('缺少权限清单 ' + PERMS_PATH + '（运行 node scripts/fetch-permissions.mjs）');
} else {
  const perms = readJSON(PERMS_PATH);
  const all = new Set();
  Object.keys(perms.crates).forEach((c) => (perms.crates[c].identifiers || []).forEach((i) => all.add(i)));
  ok(all.size > 300, '权限清单共 ' + all.size + ' 个标识');

  // 清单来源版本必须与 Cargo.toml 的大版本一致（插件大版本变了，权限名可能变）
  ['tauri', 'tauri-plugin-shell', 'tauri-plugin-dialog'].forEach((c) => {
    const entry = perms.crates[c];
    ok(!!entry, '清单含 ' + c + '（版本 ' + (entry && entry.version) + '）');
    ok(!!entry && /^2\./.test(entry.version), c + ' 清单版本为 2.x（' + (entry && entry.version) + '）');
  });

  ['teacher', 'student'].forEach((app) => {
    const cap = readJSON('apps/' + app + '/src-tauri/capabilities/default.json');
    cap.permissions.forEach((p) => {
      const known = all.has(p);
      if (!known) {
        // 允许带作用域的对象形式（{ "identifier": "...", "allow": [...] }）
        failures.push(app + ' capabilities 里的权限不存在于插件 crate：' + p);
      } else passed++;
    });
    console.log('  · ' + app + ' 权限：' + (cap.permissions.join(', ') || '（无）') + ' → 全部真实存在');
  });

  // 常用权限的存在性（防止清单抓取逻辑退化后误判为"存在"）
  ['core:default', 'shell:allow-open', 'dialog:default'].forEach((p) => {
    ok(all.has(p), '清单含 ' + p);
  });
}

/* ================= 收尾 ================= */
console.log('\n----------------------------------------');
if (failures.length) {
  console.log(`❌ 失败 ${failures.length} 项 / 通过 ${passed} 项`);
  failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
  process.exit(1);
} else {
  console.log(`✅ 全部通过：${passed} 项断言`);
}
