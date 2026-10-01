/*!
 * tests/crates.test.js — Rust 依赖体检：版本存在性 + 与代码 API 假设的一致性
 *   node tests/crates.test.js
 *
 * 两类问题：
 *   ① 版本写了个不存在的号（cargo 一解析就失败）
 *   ② 版本**存在但 API 变了** —— 例如 axum 0.8 把 `Message::Text(String)` 改成 `Message::Text(Utf8Bytes)`，
 *      而 hub.rs 是按 0.7 写的；tauri 3 的 alpha 已经发布，写宽了就会拉到不兼容的大版本
 *
 * 有网络时向 crates.io 查询版本；无网络则跳过查询（只做本地一致性断言），不会误红。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let passed = 0;
const failures = [];
function ok(cond, label) { if (cond) passed++; else failures.push(label); }
function eq(a, b, label) { if (JSON.stringify(a) === JSON.stringify(b)) passed++; else failures.push(label + '  →  期望 ' + JSON.stringify(b) + '，实际 ' + JSON.stringify(a)); }
function group(n) { console.log('\n== ' + n + ' =='); }

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/* ------------------------------------------------------------------ *
 * 1. 极简 Cargo.toml 解析（只认我们实际用的写法）
 * ------------------------------------------------------------------ */

function parseCargo(rel) {
  const text = read(rel);
  const out = { dependencies: {}, devDependencies: {}, features: {} };
  let section = null;
  text.split(/\r?\n/).forEach((raw) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const sec = line.match(/^\[([^\]]+)\]$/);
    if (sec) { section = sec[1]; return; }
    if (!section || !/^(dependencies|dev-dependencies)$/.test(section)) return;
    const m = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
    if (!m) return;
    const name = m[1];
    const rest = m[2];
    let version = null, features = [];
    const simple = rest.match(/^"([^"]+)"$/);
    if (simple) version = simple[1];
    else {
      const v = rest.match(/version\s*=\s*"([^"]+)"/);
      if (v) version = v[1];
      const f = rest.match(/features\s*=\s*\[([^\]]*)\]/);
      if (f) features = f[1].split(',').map((s) => s.trim().replace(/"/g, '')).filter(Boolean);
    }
    const target = section === 'dependencies' ? out.dependencies : out.devDependencies;
    target[name] = { version: version, features: features, raw: rest };
  });
  return out;
}

/** Cargo 的 caret 语义（我们只用这一种写法）：0.x 锁小版本，>=1 锁大版本 */
function satisfies(version, req) {
  const v = version.split('.').map(Number);
  const r = req.replace(/^[\^~]/, '').split('.').map(Number);
  const major = r[0] || 0, minor = r[1] === undefined ? null : r[1];
  if (v[0] !== major) return false;
  if (major === 0) {
    if (minor === null) return true;                 // "0" → 任意 0.x
    if (v[1] !== minor) return false;                // "0.7" → 锁 0.7.x
    return true;
  }
  if (minor !== null && r[2] === undefined && req.split('.').length === 2) return true;  // "1.0" → 任意 1.0.x
  return true;                                        // "2" / "1" → 任意同大版本
}

const teacherCargo = parseCargo('apps/teacher/src-tauri/Cargo.toml');
const studentCargo = parseCargo('apps/student/src-tauri/Cargo.toml');

group('Cargo.toml 解析');
ok(Object.keys(teacherCargo.dependencies).length >= 8, '教师端解析出 ' + Object.keys(teacherCargo.dependencies).length + ' 个依赖');
ok(Object.keys(studentCargo.dependencies).length >= 4, '学生端解析出 ' + Object.keys(studentCargo.dependencies).length + ' 个依赖');
ok(teacherCargo.devDependencies['tokio-tungstenite'], '教师端 dev-dependencies 含 tokio-tungstenite（一致性测试用）');

/* ------------------------------------------------------------------ *
 * 2. 与代码 API 假设的一致性（离线也能查）
 * ------------------------------------------------------------------ */

group('版本与代码 API 假设一致');

// Tauri 2.x：代码用的是 v2 的 Manager::path()/generate_context!/WebviewWindow 语义
['teacher', 'student'].forEach((app) => {
  const cargo = app === 'teacher' ? teacherCargo : studentCargo;
  const tauri = cargo.dependencies.tauri;
  ok(!!tauri, app + ' 依赖 tauri');
  ok(/^2(\.|$)/.test(tauri.version), app + ' tauri 锁在 2.x（当前 ' + tauri.version + '；3.0.0-alpha 已发布，不能写宽）');
  ok(/^2(\.|$)/.test(cargo.dependencies['tauri-plugin-dialog'].version), app + ' tauri-plugin-dialog 锁在 2.x');
  ok(/^2(\.|$)/.test(cargo.dependencies['tauri-plugin-shell'].version), app + ' tauri-plugin-shell 锁在 2.x');
  ok(!!cargo.dependencies.serde, app + ' 依赖 serde');
  ok(!!cargo.dependencies.serde_json, app + ' 依赖 serde_json');
});

// axum 0.7 与 hub.rs 的 Message::Text(String) 是配套的；0.8 改成了 Utf8Bytes
const hubRs = read('apps/teacher/src-tauri/src/hub.rs');
const axumVer = teacherCargo.dependencies.axum.version;
ok(/^0\.7(\.|$)/.test(axumVer), 'axum 锁在 0.7.x（当前 ' + axumVer + '）');
ok(/Message::Text\(\s*\n?\s*json!/.test(hubRs) || /Message::Text\(json!/.test(hubRs) || /Message::Text\(/ .test(hubRs),
  'hub.rs 使用 Message::Text(...)');
ok(hubRs.indexOf('.to_string(),') >= 0 || /\.to_string\(\)\s*\)/.test(hubRs),
  'hub.rs 给 Message::Text 传 String（与 axum 0.7 API 对应；升级 0.8 需同时改这里与 dev 依赖）');
ok(/Message::Text\(t\)/.test(hubRs), 'hub.rs 用 Message::Text(t) 匹配入站文本');

// rusqlite 必须带 bundled（目标机器不装 sqlite3）
const rusqlite = teacherCargo.dependencies.rusqlite;
ok(!!rusqlite && rusqlite.features.indexOf('bundled') >= 0, 'rusqlite 启用 bundled 特性（自带 SQLite 源码）');

// tokio 特性：net/sync（枢纽）+ process/io-util（EasyTier sidecar）
const tokio = teacherCargo.dependencies.tokio;
ok(!!tokio, '教师端依赖 tokio');
['rt-multi-thread', 'macros', 'net', 'sync'].forEach((f) => {
  ok(tokio.features.indexOf(f) >= 0, 'tokio 启用 ' + f);
});
ok(/tokio\s*=\s*\{[^}]*"process"/.test(read('apps/teacher/src-tauri/Cargo.toml')), 'tokio 启用 process（net.rs 需要）');

// dev 依赖 tokio-tungstenite 关闭默认特性（免 openssl），且与测试用法对应
const tts = teacherCargo.devDependencies['tokio-tungstenite'];
ok(/default-features\s*=\s*false/.test(tts.raw), 'tokio-tungstenite 关闭默认特性（不引入 TLS/openssl）');
ok(tts.features.indexOf('connect') >= 0 && tts.features.indexOf('handshake') >= 0,
  'tokio-tungstenite 启用 connect + handshake');
const conformance = read('apps/teacher/src-tauri/tests/hub_conformance.rs');
ok(conformance.indexOf('connect_async') >= 0, '一致性测试用 connect_async');
ok(conformance.indexOf('MaybeTlsStream') >= 0, '一致性测试引用 MaybeTlsStream（关闭 TLS 后仍是该类型）');
// lib crate-type：移动端必需
['teacher', 'student'].forEach((app) => {
  const cargo = read('apps/' + app + '/src-tauri/Cargo.toml');
  ok(/crate-type\s*=\s*\[[^\]]*"staticlib"/.test(cargo) && /crate-type\s*=\s*\[[^\]]*"cdylib"/.test(cargo),
    app + ' crate-type 含 staticlib + cdylib（Android/iOS 必需）');
});

/* ------------------------------------------------------------------ *
 * 3. 在线核对：crate 是否存在、是否有满足要求的版本、与 axum 的传递依赖是否配套
 * ------------------------------------------------------------------ */

group('crates.io 版本核对');

const UA = 'luchenxi-ci-check (https://github.com/JuLuogo/luchenxi)';

async function lookup(name) {
  const res = await fetch('https://crates.io/api/v1/crates/' + encodeURIComponent(name), {
    headers: { 'User-Agent': UA }
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

(async function online() {
  const wanted = [];
  ['teacher', 'student'].forEach((app) => {
    const cargo = app === 'teacher' ? teacherCargo : studentCargo;
    Object.keys(cargo.dependencies).forEach((n) => wanted.push([n, cargo.dependencies[n].version, app]));
    Object.keys(cargo.devDependencies).forEach((n) => wanted.push([n, cargo.devDependencies[n].version, app]));
  });

  let online = true;
  const seen = new Set();
  for (const [name, ver, app] of wanted) {
    if (seen.has(name)) continue;
    seen.add(name);
    try {
      const d = await lookup(name);
      const versions = (d.versions || []).filter((v) => !v.yanked).map((v) => v.num);
      const matched = versions.filter((v) => satisfies(v, ver));
      ok(matched.length > 0, name + ' ' + ver + ' 有可解析版本（最新匹配 ' + (matched[0] || '无') + '）');
      const latest = d.crate && d.crate.max_stable_version;
      if (latest && !satisfies(latest, ver)) {
        console.log('  · ' + name.padEnd(22) + ' 固定 ' + ver + '，最新 ' + latest + '（升级请同步检查 API）');
      }
    } catch (e) {
      online = false;
      console.log('  · ' + name + ' 查询失败（' + (e.cause && e.cause.message ? e.cause.message : e.message) + '），跳过在线核对');
      break;
    }
  }
  if (!online) console.log('  （离线：只做了本地一致性断言）');

  /* ------------------------------------------------------------------ *
   * 4. 与 axum 的传递依赖配套（避免同 crate 编两份 / trait 不匹配）
   * ------------------------------------------------------------------ */
  group('与 axum 的传递依赖配套');
  if (online) {
    try {
      // 取 axum 已发布的最新 0.7.x 看它声明了哪些配套版本
      const axumInfo = await lookup('axum');
      const v07 = (axumInfo.versions || []).map((v) => v.num).filter((v) => /^0\.7\./.test(v))[0];
      const depRes = await fetch('https://crates.io/api/v1/crates/axum/' + v07 + '/dependencies', {
        headers: { 'User-Agent': UA }
      });
      const depJson = await depRes.json();
      const deps = depJson.dependencies || [];
      const find = (name) => deps.filter((d) => d.crate_id === name && d.kind !== 'dev').map((d) => d.req)[0]
        || deps.filter((d) => d.crate_id === name).map((d) => d.req)[0];
      console.log('  · axum ' + v07 + ' 声明：tokio-tungstenite ' + (find('tokio-tungstenite') || '?') +
        '，tower-http ' + (find('tower-http') || '?') + '，tower ' + (find('tower') || '?'));

      // 我们的 tokio-tungstenite（dev）必须与 axum 用同一个 0.x，否则会编两份、且类型不互通
      const axumTts = find('tokio-tungstenite') || '';
      const myTtsMinor = tts.version.split('.').slice(0, 2).join('.');
      ok(axumTts.indexOf(myTtsMinor) >= 0,
        'dev 依赖 tokio-tungstenite ' + tts.version + ' 与 axum 声明的 ' + axumTts + ' 对齐');
      // tower-http 同理（CorsLayer 要在同一个 http/tower 版本体系里）
      const axumTh = find('tower-http') || '';
      const myThMinor = teacherCargo.dependencies['tower-http'].version.split('.').slice(0, 2).join('.');
      ok(axumTh.indexOf(myThMinor) >= 0,
        'tower-http ' + teacherCargo.dependencies['tower-http'].version + ' 与 axum 声明的 ' + axumTh + ' 对齐');
    } catch (e) {
      console.log('  · 查询 axum 依赖失败（' + (e.message || e) + '），跳过配套核对');
    }
  } else {
    console.log('  （离线：跳过）');
  }

  /* ================= 汇总 ================= */
  console.log('\n----------------------------------------');
  if (failures.length) {
    console.log(`❌ 失败 ${failures.length} 项 / 通过 ${passed} 项`);
    failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
    process.exit(1);
  } else {
    console.log(`✅ 全部通过：${passed} 项断言${online ? '' : '（离线模式）'}`);
  }
})();
