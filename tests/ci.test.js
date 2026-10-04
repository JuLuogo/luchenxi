/*!
 * tests/ci.test.js — 客户端骨架与 CI 流水线自检
 *   node tests/ci.test.js
 *
 * 覆盖（都是"不改代码就能发现"的低级错误）：
 *   1. 两个 Tauri 工程的 package.json / tauri.conf.json / Cargo.toml / capabilities 齐备且 JSON 可解析
 *   2. tauri.conf.json 的 frontendDist 指向真实存在的相对目录；externalBin 的 sidecar 命名符合 Tauri 约定
 *   3. Cargo.toml 声明的 crate 类型与 tauri v2 要求一致（lib + mobile 需要 staticlib/cdylib/rlib）
 *   4. GitHub Actions 工作流 YAML 合法、引用的脚本/路径确实存在、npm script 名真实存在
 *   5. 前端"套壳"链路自洽：sync-ui.mjs 的输入文件存在，ui 目录在 .gitignore 中
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
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));
const readJSON = (rel) => JSON.parse(read(rel));

/* ================= 1. Tauri 工程结构 ================= */
group('Tauri 工程结构');

const APPS = ['teacher', 'student'];
APPS.forEach((app) => {
  ['package.json', 'src-tauri/Cargo.toml', 'src-tauri/tauri.conf.json', 'src-tauri/build.rs', 'src-tauri/capabilities/default.json']
    .forEach((f) => ok(exists('apps/' + app + '/' + f), app + ' 缺少 ' + f));
});

APPS.forEach((app) => {
  const pkg = readJSON('apps/' + app + '/package.json');
  ok(/^4\./.test(pkg.version), app + ' 版本号为 4.x（实际 ' + pkg.version + '）');
  ok(!!pkg.devDependencies['@tauri-apps/cli'], app + ' 声明了 @tauri-apps/cli');
  ok(!!pkg.scripts.dev && !!pkg.scripts.build, app + ' 有 dev/build 脚本');

  const conf = readJSON('apps/' + app + '/src-tauri/tauri.conf.json');
  ok(!!conf.identifier && conf.identifier.indexOf('.') > 0, app + ' identifier 合法');
  ok(!!conf.build && !!conf.build.frontendDist, app + ' 配置了 frontendDist');
  ok(!!conf.bundle && !!conf.bundle.icon, app + ' 配置了图标列表');
  ok(!!conf.app && Array.isArray(conf.app.windows) && conf.app.windows.length > 0, app + ' 定义了窗口');
  const csp = (conf.app.security && conf.app.security.csp) || '';
  ok(csp.indexOf('ws:') >= 0, app + ' CSP 放行 WebSocket（多端协同必需）');
  ok(csp.indexOf("script-src 'self'") >= 0, app + ' CSP 限制脚本来源为 self');
});

/* ================= 2. frontendDist 与 sidecar ================= */
group('前端资源与 sidecar 约定');

const teacherConf = readJSON('apps/teacher/src-tauri/tauri.conf.json');
const distRel = path.join('apps/teacher/src-tauri', teacherConf.build.frontendDist);
ok(exists(distRel) || exists('apps/teacher/ui'), 'frontendDist 指向的目录存在或可由 sync-ui 生成（' + distRel + '）');

const bins = teacherConf.bundle.externalBin || [];
ok(bins.length >= 2, '教师端登记了 easytier-core / easytier-cli 两个 sidecar（' + bins.length + '）');
bins.forEach((b) => {
  // Tauri 约定：写基础路径，打包时自带 <name>-<target-triple>[.exe]
  const base = b.split('/').pop();
  ok(/^easytier-(core|cli)$/.test(base), 'sidecar 基础名合法（' + b + '）');
  ok(b.indexOf('binaries/') === 0, 'sidecar 放在 binaries/ 下：' + b);
});
ok(bins.some((b) => /easytier-core$/.test(b)), '教师端确实内置了 easytier-core（组网）');
ok(bins.some((b) => /easytier-cli$/.test(b)), '教师端确实内置了 easytier-cli（状态查询）');

const studentConf = readJSON('apps/student/src-tauri/tauri.conf.json');
eq((studentConf.bundle.externalBin || []).length, 0, '学生端不内置 sidecar（Android 无 EasyTier CLI）');
ok((studentConf.bundle.targets || []).length > 0, '学生端声明了桌面打包目标（' + (studentConf.bundle.targets || []).join('/') + '）');
ok(!(studentConf.bundle.targets || []).includes('apk'), 'bundle.targets 不含 apk（Android 产物由 tauri android build 生成，写这里会被 schema 判非法）');
ok(/tauri android build/.test(read('apps/README.md')), '文档说明 Android 用 tauri android build');

/* ================= 3. Cargo.toml 与 Rust 源文件 ================= */
group('Rust crate 与源码');

APPS.forEach((app) => {
  const cargo = read('apps/' + app + '/src-tauri/Cargo.toml');
  ok(/tauri\s*=\s*\{\s*version\s*=\s*"2"/.test(cargo), app + ' 依赖 tauri v2');
  ok(/\[lib\]/.test(cargo), app + ' 声明了 [lib]（移动端必需）');
  ok(/crate-type\s*=\s*\[[^\]]*"cdylib"/.test(cargo), app + ' crate-type 含 cdylib（Android/iOS 必需）');
  ok(/crate-type\s*=\s*\[[^\]]*"staticlib"/.test(cargo), app + ' crate-type 含 staticlib');
  ok(exists('apps/' + app + '/src-tauri/src/main.rs'), app + ' 有 main.rs');
  ok(exists('apps/' + app + '/src-tauri/src/lib.rs'), app + ' 有 lib.rs（Tauri v2 移动端必需 lib target）');
});

const teacherMain = read('apps/teacher/src-tauri/src/lib.rs');   // 业务代码在 lib（移动端必需），main.rs 只是薄壳
['db_load', 'db_save', 'db_student_tier', 'db_file', 'net_start', 'net_stop', 'net_status'].forEach((cmd) => {
  ok(teacherMain.indexOf('fn ' + cmd) >= 0 || teacherMain.indexOf(cmd + ',') >= 0, '教师端注册了命令 ' + cmd);
});
ok(teacherMain.indexOf('tauri::generate_handler!') >= 0, '教师端使用 generate_handler 注册命令');
ok(teacherMain.indexOf('hub::serve') >= 0, '教师端启动内置枢纽');

const teacherDb = read('crates/ci-store/src/lib.rs');
ok(teacherDb.indexOf('include_str!("../schema.sql")') >= 0, 'db.rs 引用与 Node 共用的 schema.sql');
ok(teacherDb.indexOf('v_student_tier') >= 0, 'db.rs 使用统计视图做学情下推');

const teacherNet = read('crates/ci-core/src/net.rs');
['--network-name', '--network-secret', '-p', '-w', '--config-server', '--no-tun'].forEach((flag) => {
  ok(teacherNet.indexOf('"' + flag + '"') >= 0, 'net.rs 支持 EasyTier 参数 ' + flag);
});

/* ================= 4. 图标齐备（Tauri generate_context! 会检查） ================= */
group('应用图标（缺一个就编不过）');

const REQUIRED_ICONS = ['32x32.png', '128x128.png', '128x128@2x.png', 'icon.png', 'icon.ico', 'icon.icns'];
APPS.forEach((app) => {
  REQUIRED_ICONS.forEach((f) => {
    const rel = 'apps/' + app + '/src-tauri/icons/' + f;
    ok(exists(rel), app + ' 缺少图标 ' + f);
  });
  const conf = readJSON('apps/' + app + '/src-tauri/tauri.conf.json');
  (conf.bundle.icon || []).forEach((f) => {
    ok(exists('apps/' + app + '/src-tauri/' + f), app + ' tauri.conf 里声明的图标存在：' + f);
  });
  // 文件头校验：PNG / ICO / ICNS
  const head = fs.readFileSync(path.join(ROOT, 'apps', app, 'src-tauri', 'icons', '32x32.png')).subarray(0, 8);
  eq([...head].slice(0, 4), [0x89, 0x50, 0x4e, 0x47], app + ' 32x32.png 是合法 PNG');
  const ico = fs.readFileSync(path.join(ROOT, 'apps', app, 'src-tauri', 'icons', 'icon.ico')).subarray(0, 4);
  eq([...ico], [0x00, 0x00, 0x01, 0x00], app + ' icon.ico 头合法');
  const icns = fs.readFileSync(path.join(ROOT, 'apps', app, 'src-tauri', 'icons', 'icon.icns')).subarray(0, 4).toString('ascii');
  eq(icns, 'icns', app + ' icon.icns 头合法');
});

/* ================= 5. Rust 源码的编译风险点自查 ================= */
group('Rust 源码自查（易错点）');

const cargoTeacher = read('apps/teacher/src-tauri/Cargo.toml');
// v5：tokio 的 feature 统一声明在 workspace 根，各 crate 用 tokio = { workspace = true }
const cargoRoot = read('Cargo.toml');
const tokioDecl = (cargoRoot.match(/^tokio\s*=\s*\{[^}]*\}/m) || [''])[0];
ok(tokioDecl.length > 0, 'workspace 根声明 tokio');
ok(/"process"/.test(tokioDecl), 'tokio 启用 process（ci-core 的 net.rs 需要）');
ok(/"io-util"/.test(tokioDecl), 'tokio 启用 io-util');
ok(/tokio\s*=\s*\{\s*workspace\s*=\s*true\s*\}/.test(cargoTeacher), '教师端引用 workspace 的 tokio');
const teacherMainSrc = read('apps/teacher/src-tauri/src/lib.rs');
// 只看业务代码：`#[cfg(test)]` 里也有 Store::open，会干扰"只开一个连接"这类计数断言
const libProdSrc = teacherMainSrc.split('#[cfg(test)]')[0];
ok(libProdSrc.indexOf('Store::open') >= 0, 'lib.rs 打开数据库');
ok((libProdSrc.match(/Store::open/g) || []).length === 1, 'lib.rs 只打开一个数据库连接（与枢纽共用，避免锁冲突）');
ok(libProdSrc.indexOf('store.clone()') >= 0, '数据库连接以 Arc 共享给枢纽');
ok(libProdSrc.indexOf('.into()') >= 0, 'setup 里错误类型转换为 Box<dyn Error>（String 不能直接 ?）');
ok(libProdSrc.indexOf('generate_context!') >= 0, 'lib.rs 使用 generate_context!（需要 tauri.conf.json 与图标齐备）');
ok(libProdSrc.indexOf('tauri::async_runtime::spawn') >= 0, '枢纽跑在 Tauri 的 tokio 运行时里');

const teacherDbSrc = read('crates/ci-store/src/lib.rs');
ok(teacherDbSrc.indexOf('serde_json::to_string(q.get("options")') < 0, 'db.rs 不再对临时值取引用（改用预先绑定的 empty）');
ok(teacherDbSrc.indexOf('let empty = Value::Array(Vec::new())') >= 0, 'db.rs 用绑定变量承载默认空数组');

const hubSrc = read('crates/ci-hub/src/lib.rs');
ok(hubSrc.indexOf('routing::{get, put}') < 0, 'hub.rs 不再导入未使用的 put');
ok(hubSrc.indexOf('mpsc::unbounded_channel') >= 0, 'hub.rs 用每连接 mpsc 精确投递（cmd→host、ack→发起者）');
ok(hubSrc.indexOf('CMD_QUEUE_MAX') >= 0, 'hub.rs 有离线命令队列上限（与 Node 版一致）');
ok(hubSrc.indexOf('cmd-backlog') >= 0, 'hub.rs 支持教师端上线补发 cmd-backlog');
ok(hubSrc.indexOf('fn presence') >= 0 || hubSrc.indexOf('fn presence(') >= 0, 'hub.rs 计算在线小组状态');
ok(hubSrc.indexOf('SUPPORTED_TYPES') >= 0, 'hub.rs 声明支持的报文清单（供契约测试对照）');
ok(hubSrc.indexOf('serve(') >= 0 && hubSrc.indexOf('axum::serve') >= 0, 'hub.rs 用 axum 提供服务');
ok(teacherMainSrc.indexOf('HubState {') >= 0 && teacherMainSrc.indexOf('db: store.clone()') >= 0,
  'lib.rs 把同一个数据库句柄交给枢纽');

// 可测性：纯逻辑必须抽成 pub 方法，且**处理器真的调用它们**
// （否则"单测测的是没人用的辅助函数"，是最隐蔽的假绿）
['pub fn add_client', 'pub fn remove_client', 'pub fn enqueue', 'pub fn apply_restore', 'pub fn host_online', 'pub fn presence']
  .forEach((sig) => ok(hubSrc.indexOf(sig) >= 0, 'hub.rs 暴露可测方法 ' + sig));
ok(hubSrc.indexOf('.enqueue(cmd)') >= 0, 'cmd 处理器复用 Room::enqueue（队列上限逻辑被单测覆盖）');
ok(hubSrc.indexOf('.apply_restore(state.clone())') >= 0, 'api_restore 复用 Room::apply_restore（替换语义被单测覆盖）');
ok(hubSrc.indexOf('pub const CMD_QUEUE_MAX') >= 0, 'CMD_QUEUE_MAX 对外可见（单测要对齐上限）');
['presence_dedupe_and_disconnect', 'offline_queue_caps_at_limit', 'restore_replaces_both_snapshots',
  'safe_room_rules', 'easytier_args_match_js_rules', 'db_roundtrip_without_tauri', 'protocol_constants_generated']
  .forEach((t) => ok(teacherMainSrc.indexOf('fn ' + t) >= 0, '教师端 lib 单测 ' + t));

/* ================= 6. iOS 预留 ================= */
group('iOS 预留');

const studentConfForIos = readJSON('apps/student/src-tauri/tauri.conf.json');
ok(!!studentConfForIos.bundle.iOS, '学生端配置了 bundle.iOS');
ok(/^\d+\.\d+/.test((studentConfForIos.bundle.iOS || {}).minimumSystemVersion || ''), 'iOS 最低系统版本格式正确');
ok(/aarch64-apple-ios/.test(read('.github/workflows/build.yml')), 'CI 声明 iOS Rust target');
ok(/tauri ios build/.test(read('.github/workflows/build.yml')), 'CI 有 iOS 构建步骤');
ok(/continue-on-error: true/.test(read('.github/workflows/build.yml')), 'iOS 任务失败不阻断发布（尚未配证书）');

/* ================= 7. SQLite schema 两端共用 ================= */
group('SQLite schema 共用与关键表');

const schema = read('packages/db/schema.sql');
['rooms', 'tiers', 'teams', 'students', 'questions', 'quizzes', 'records',
  'classroom_pending', 'classroom_buzz', 'classroom_feed', 'roll_history', 'runtime', 'settings', 'logs',
  'v_student_tier', 'v_student_score'].forEach((t) => {
  ok(new RegExp('(TABLE|VIEW) IF NOT EXISTS ' + t + '\\b').test(schema), 'schema 含 ' + t);
});
ok(/PRAGMA journal_mode = WAL/.test(schema), 'schema 启用 WAL');
ok(/PRAGMA foreign_keys = ON/.test(schema), 'schema 启用外键');

/* ================= 8. GitHub Actions 工作流 ================= */
group('GitHub Actions 工作流');

let YAML = null;
try { YAML = require('yaml'); } catch (e) { /* 见下面的失败记录 */ }

let Ajv = null;
try { Ajv = require('ajv'); } catch (e) { /* 见下面的失败记录 */ }

// 审计发现：缺依赖时只写注释、**不记失败** → 后面所有 workflow 语义断言整体跳过，
// 而 CI 仍然全绿（约 20 条断言凭空消失）。缺依赖要显式失败，不能静默降级。
ok(!!YAML, '依赖 yaml 可用（缺了会让 workflow 解析校验整块跳过）');
ok(!!Ajv, '依赖 ajv 可用（缺了会让 workflow schema 校验整块跳过）');

const WORKFLOW_SCHEMA = 'packages/schema/github-workflow.schema.json';
let workflowValidator = null;
if (Ajv && exists(WORKFLOW_SCHEMA)) {
  // schemastore 的 schema 用了 $ref/oneOf 等，需要放宽 strict；
  // unicodeRegExp:false —— 与 Tauri schema 同理，避免个别非法转义导致编译失败
  const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false, unicodeRegExp: false, allowUnionTypes: true });
  try { workflowValidator = ajv.compile(readJSON(WORKFLOW_SCHEMA)); passed++; }
  catch (e) { failures.push('工作流 schema 编译失败：' + e.message); }
} else if (!exists(WORKFLOW_SCHEMA)) {
  failures.push('缺少 ' + WORKFLOW_SCHEMA + '（运行 node scripts/fetch-schema.mjs）');
}

const workflows = fs.readdirSync(path.join(ROOT, '.github', 'workflows')).filter((f) => /\.ya?ml$/.test(f));
ok(workflows.length >= 3, '至少有三个工作流（实际 ' + workflows.length + '）');

const docs = {};
workflows.forEach((f) => {
  const text = read('.github/workflows/' + f);
  if (YAML) {
    try { docs[f] = YAML.parse(text); passed++; }
    catch (e) { failures.push(f + ' YAML 解析失败：' + e.message); }
  }
  if (workflowValidator) {
    const parsed = docs[f] || (YAML ? YAML.parse(text) : null);
    if (parsed) {
      const valid = workflowValidator(parsed);
      if (valid) passed++;
      else {
        const msgs = (workflowValidator.errors || []).slice(0, 5)
          .map((e) => (e.instancePath || '/') + ' ' + e.message + ' ' + JSON.stringify(e.params).slice(0, 60));
        failures.push(f + ' 不符合 GitHub 工作流 schema：' + msgs.join(' | '));
      }
    }
  }
  ok(/runs-on:/.test(text), f + ' 指定 runs-on');
  // 动作版本：只要求"有检出、有配 Node"，且**大版本号不能太旧**（旧版仍跑 Node 20，
  // 在新运行器上会被强制切到 Node 24 而失败——android 的 setup-android 就是这么挂的）
  const co = text.match(/actions\/checkout@v(\d+)/);
  const sn = text.match(/actions\/setup-node@v(\d+)/);
  ok(!!co, f + ' 检出代码（actions/checkout）');
  ok(!!sn, f + ' 配置 Node（actions/setup-node）');
  ok(!!co && Number(co[1]) >= 5, f + ' checkout 大版本 >= 5（当前 ' + (co ? 'v' + co[1] : '无') + '，v4 仍基于 Node 20）');
  ok(!!sn && Number(sn[1]) >= 5, f + ' setup-node 大版本 >= 5（当前 ' + (sn ? 'v' + sn[1] : '无') + '）');
  // Node 24：node:sqlite 在 Node 22 仍要 --experimental-sqlite，用 22 会让数据库断言全挂
  ok(/node-version:\s*'?24'?/.test(text), f + ' 使用 Node 24（node:sqlite 在 22 需要实验开关）');
  // 不再使用仍在 Node 20 的动作
  ok(!/setup-android@v3/.test(text), f + ' 不再用 android-actions/setup-android@v3（Node 20，新运行器上会失败）');
});

// 语义检查：这些键写错**不会报错**，只会静默失效
if (docs['build.yml']) {
  const b = docs['build.yml'];
  ok(b.jobs.ios && b.jobs.ios['continue-on-error'] === true,
    'build.yml 的 iOS 任务确实带 continue-on-error: true（拼错就会开始阻断发布）');
  ok(b.jobs.desktop && b.jobs.desktop.strategy && b.jobs.desktop.strategy.matrix,
    'build.yml 的 desktop 任务使用 matrix');
  ok(b.jobs.android && b.jobs.android.needs, 'build.yml 的 android 任务声明 needs（依赖 prepare-ui）');
}
if (docs['rust.yml']) {
  const r = docs['rust.yml'];
  const steps = (r.jobs['cargo-test'] || {}).steps || [];
  ok(steps.some((s) => /cargo test/.test(s.run || '')), 'rust.yml 有 cargo test 步骤');
  ok(steps.some((s) => /cargo check/.test(s.run || '')), 'rust.yml 有学生端 cargo check 步骤');
}
if (docs['test.yml']) {
  const t = docs['test.yml'];
  const steps = (t.jobs.ci || {}).steps || [];
  ok(steps.some((s) => /ci-local\.mjs/.test(s.run || '')), 'test.yml 调用本地 CI 脚本');
  ok(/push/.test(JSON.stringify(t.on)) && /pull_request/.test(JSON.stringify(t.on)), 'test.yml 在 push 与 PR 上触发');
}
// 触发条件语法：tag 通配
if (docs['build.yml']) {
  const on = docs['build.yml'].on || docs['build.yml'][true];
  ok(JSON.stringify(on).indexOf('v*') >= 0, 'build.yml 由 v* tag 触发');
}
// 演示工作流：只手动触发，且必须上传截图产物（否则跑完什么都拿不到）
if (docs['demo.yml']) {
  const d = docs['demo.yml'];
  const on = d.on || d[true];
  ok(!!on && ('workflow_dispatch' in on), 'demo.yml 支持手动触发');
  ok(!on.push && !on.pull_request, 'demo.yml 不挂在 push/PR 上（跑浏览器慢，不进推送门禁）');
  const steps = (d.jobs.demo || {}).steps || [];
  ok(steps.some((s) => /tests\/shot-next\.js/.test(s.run || '')), 'demo.yml 运行 tests/shot-next.js（Vue 界面截图，2026-10 起）');
  const up = steps.find((s) => s.uses && /upload-artifact/.test(s.uses));
  ok(!!up, 'demo.yml 上传产物');
  ok(!!up && up.with && String(up.with.path).indexOf('docs/demo') >= 0, 'demo.yml 上传 docs/demo');
} else {
  failures.push('缺少 .github/workflows/demo.yml（手动生成演示截图用）');
}

// 工作流里 node xxx.js 引用的脚本必须存在
workflows.forEach((f) => {
  const text = read('.github/workflows/' + f);
  const refs = [...text.matchAll(/node\s+(scripts|tests)\/[\w.-]+\.js/g)].map((m) => m[0].replace(/^node\s+/, ''));
  eq(refs.filter((r) => !exists(r)), [], f + ' 引用的 Node 脚本全部存在');
});

// 工作流里 npm run xxx 引用的脚本必须在 package.json 中定义。
// 判定方式：对每个 `npm run X`，向上找最近的 working-directory 决定用哪个 package.json；
// 目录里含 matrix 模板（apps/${{ matrix.app }}）时，任一客户端定义了该脚本即通过。
const rootPkg = readJSON('package.json');
const appPkgs = fs.readdirSync(path.join(ROOT, 'apps'))
  .filter((d) => fs.existsSync(path.join(ROOT, 'apps', d, 'package.json')))
  .map((d) => readJSON('apps/' + d + '/package.json').scripts || {});

function pkgScriptsFor(dir) {
  let d = String(dir || '').replace(/\/$/, '');
  while (d && d.indexOf('/') > 0) {
    if (fs.existsSync(path.join(ROOT, d, 'package.json'))) return readJSON(d + '/package.json').scripts || {};
    d = d.slice(0, d.lastIndexOf('/'));
  }
  return null;
}

workflows.forEach((f) => {
  // 去掉注释行：否则注释里提到的命令会被当成真实命令（本轮就踩到过）
  const text = workflowCode(read('.github/workflows/' + f));
  const missing = [];
  [...text.matchAll(/npm run ([\w:.-]+)/g)].forEach((m) => {
    const script = m[1];
    const before = text.slice(0, m.index);
    const dirMatch = [...before.matchAll(/working-directory:\s*([^\s]+)/g)].pop();
    const dir = dirMatch ? dirMatch[1] : '';
    if (dir.indexOf('${{') >= 0) {
      if (!appPkgs.some((s) => s[script])) missing.push(dir + ' → ' + script);
      return;
    }
    const scripts = dir ? pkgScriptsFor(dir) : rootPkg.scripts;
    if (!scripts || !scripts[script]) missing.push((dir ? dir + ' → ' : '') + script);
  });
  eq(missing, [], f + ' 引用的 npm script 全部存在');
});

/** 去掉注释行后的工作流正文（断言包名/动作时不受注释里提到的名字干扰） */
function workflowCode(text) {
  return text.split(/\r?\n/).filter((l) => !/^\s*#/.test(l) && !/\s#\s/.test(l)).join('\n');
}

const buildYml = read('.github/workflows/build.yml');
const buildCode = workflowCode(buildYml);
// 显式在客户端目录跑 `npm run build`（= tauri build），而不是 tauri-action：
// 前者失败时能 tee 日志并把 error[..] 写成注解。注意客户端 package.json 里的脚本名是 build，
// 不是 tauri（写成 npm run tauri 会直接 "Missing script" 失败）。
ok(/npm run build -- --target/.test(buildYml), 'build.yml 在客户端目录执行 npm run build（= tauri build）');
ok(!/npm run tauri\b/.test(buildCode), 'build.yml 不写 npm run tauri（客户端没有这个脚本）');
ok(/::error/.test(buildYml), 'build.yml 失败时把编译错误写成 GitHub 注解');
['windows-latest', 'macos-14', 'ubuntu-22.04'].forEach((os) => ok(buildYml.indexOf(os) >= 0, 'build.yml 覆盖 ' + os));
ok(/setup-java@v(\d+)/.test(buildYml) && Number(buildYml.match(/setup-java@v(\d+)/)[1]) >= 5, 'build.yml 为 Android 准备 JDK（setup-java >= v5）');
ok(!/uses:\s*android-actions\/setup-android/.test(buildYml), '不再依赖 setup-android（运行器已预装 SDK，且该 action 仍是 Node 20）');
ok(/sdkmanager/.test(buildCode), 'build.yml 直接用 sdkmanager 装 NDK');
ok(/aarch64-linux-android/.test(buildYml), 'build.yml 声明 Android Rust target');
ok(/fetch-easytier\.mjs/.test(buildYml), 'build.yml 会放置 EasyTier sidecar');
// Linux 依赖包名：libappindicator3-dev 在 22.04 不存在，会导致 apt exit 100
// （只检查 apt 安装行，避免被注释里提到的包名误导）
const aptLines = (t) => workflowCode(t).split(/\r?\n/).filter((l) => /apt-get install|libwebkit|librsvg|patchelf/.test(l)).join('\n');
ok(!/libappindicator3-dev/.test(aptLines(buildYml)), 'build.yml 不再装 22.04 里不存在的 libappindicator3-dev');
ok(/libwebkit2gtk-4\.1-dev/.test(aptLines(buildYml)), 'build.yml 装 webkit2gtk-4.1（Tauri v2 需要）');
const rustYml = read('.github/workflows/rust.yml');
ok(!/libappindicator3-dev/.test(aptLines(rustYml)), 'rust.yml 不再装 22.04 里不存在的 libappindicator3-dev');
ok(/::error/.test(rustYml), 'rust.yml 失败时把编译错误写成注解');

/* ================= 9. 套壳链路自洽 ================= */group('套壳链路（sync-ui / 忽略规则）');

const syncUi = read('scripts/sync-ui.mjs');
ok(syncUi.indexOf('admin.html') >= 0 && syncUi.indexOf('student.html') >= 0, 'sync-ui 覆盖两套客户端入口页');
ok(syncUi.indexOf('schema.sql') >= 0, 'sync-ui 复制 SQLite schema 给 Rust 侧');
// 2026-10：源已从"仓库根的零构建页面"改成 **Vue 构建产物**（web/dist）
ok(/web['"],\s*['"]dist/.test(syncUi) || /const DIST/.test(syncUi), 'sync-ui 的来源是 Vue 构建产物 web/dist');
ok(!/assets\/css/.test(syncUi), 'sync-ui 不再拷旧版 CSS');
// 旧版零构建界面必须已经删除（否则又会出现"网页版新界面、客户端旧脸"的分裂）
['admin.html', 'student.html', 'index.html',
  'assets/js/admin.js', 'assets/js/bank.js', 'assets/js/quiz.js', 'assets/js/analysis-ui.js',
  'assets/css/app.css', 'assets/css/student.css']
  .forEach((f) => ok(!exists(f), '旧版界面文件已删除：' + f));
// 领域层仍必须在（Vue 通过 bridge 复用它们；等 Rust 端口完成才会删）
['assets/js/store.js', 'assets/js/analysis.js', 'assets/js/classroom.js', 'assets/js/sync.js',
  'assets/js/grade.js', 'assets/js/rollcall.js', 'assets/js/storage.js', 'assets/js/net.js',
  'assets/js/import.js', 'assets/js/student.js']
  .forEach((f) => ok(exists(f), '领域层文件仍在：' + f));

const gi = read('.gitignore');
['apps/*/ui/', 'apps/*/src-tauri/target/', 'apps/*/src-tauri/gen/', 'data/', '*.db'].forEach((rule) => {
  ok(gi.indexOf(rule) >= 0, '.gitignore 含规则 ' + rule);
});

const testYmlForCi = read('.github/workflows/test.yml');
ok(/node scripts\/ci-local\.mjs/.test(testYmlForCi), 'test.yml 调用本地 CI 脚本（本地与 CI 同源，避免漂移）');
ok(!!rootPkg.scripts.ci && /ci-local\.mjs/.test(rootPkg.scripts.ci), 'package.json 提供 npm run ci');
ok(/CHROME_PATH/.test(testYmlForCi), 'CI 里指定浏览器路径（run-smoke.js 支持 CHROME_PATH）');
ok(!!rootPkg.scripts['gen:protocol'], 'package.json 提供 npm run gen:protocol');
ok(!!rootPkg.scripts['test:hub'] && !!rootPkg.scripts['test:protocol'], 'package.json 提供分组测试脚本');

// Rust 只能在 CI 上编译验证，所以必须有一个专门的工作流
const rustYmlPath = '.github/workflows/rust.yml';
ok(exists(rustYmlPath), '存在 rust.yml（Rust 侧唯一的编译验证入口）');
if (exists(rustYmlPath)) {
  const rustYml = read(rustYmlPath);
  ok(/cargo test/.test(rustYml), 'rust.yml 运行 cargo test');
  ok(/sync-ui\.mjs/.test(rustYml), 'rust.yml 先生成 ui/ 资源');
  ok(/gen-protocol\.mjs --check/.test(rustYml), 'rust.yml 校验生成的契约常量');
  ok(/libwebkit2gtk/.test(rustYml), 'rust.yml 安装 Linux 上的 Tauri 依赖');
  if (YAML) {
    try { YAML.parse(rustYml); passed++; } catch (e) { failures.push('rust.yml YAML 解析失败：' + e.message); }
  }
}

// 脚本里列出的步骤必须都真实存在
// 2026-10：tests/dom-check.js 已删（它只校验旧版页面；Vue 的同类检查由 tests/ui-vue.test.mjs 承担）
const ciLocal = read('scripts/ci-local.mjs');
['tests/logic.test.js', 'tests/db.test.js', 'tests/storage.test.js', 'tests/net.test.js',
  'tests/protocol.test.js', 'tests/hub-spec.test.js', 'tests/ci.test.js', 'tests/ui-vue.test.mjs',
  'tests/doc-refs.js', 'tests/run-smoke.js', 'scripts/sync-ui.mjs', 'scripts/gen-protocol.mjs'].forEach((f) => {
  ok(ciLocal.indexOf(f) >= 0, 'ci-local.mjs 覆盖 ' + f);
  ok(exists(f), 'ci-local 引用的文件存在：' + f);
});

/* ================= 10. 存储适配层与 Tauri 对接 ================= */
group('存储适配层契约');

const storage = read('assets/js/storage.js');
['probe', 'bootstrap', 'push', 'pull', 'describe', 'backend', 'isSqlite'].forEach((fn) => {
  ok(storage.indexOf(fn + ':') >= 0 || storage.indexOf(fn + ' ') >= 0, 'storage.js 暴露 ' + fn);
});
ok(storage.indexOf('__TAURI') >= 0, 'storage.js 能识别 Tauri 环境');
ok(/invoke\(/.test(storage), 'storage.js 在 Tauri 下走 invoke 调用命令');

const studentMainSrc = read('apps/student/src-tauri/src/lib.rs');
ok(studentMainSrc.indexOf('spawn_blocking') >= 0, '学生端自检放到阻塞线程池（不卡异步运行时）');
ok(studentMainSrc.indexOf('pub fn normalize') >= 0, '学生端能把 /join 链接规范化成主机地址');
ok(studentMainSrc.indexOf('fn check_hub') >= 0, '学生端注册 check_hub 命令');
ok(/fn normalize_matches_js_rules/.test(studentMainSrc), '学生端地址规范化有单测（与 JS 同规则）');
ok(read('apps/student/src-tauri/src/main.rs').indexOf('luchenxi_student_lib::run()') >= 0,
  '学生端 main.rs 是薄壳（移动端必需 lib target）');

const studentJs = read('assets/js/student.js');
ok(studentJs.indexOf('ci_ws_host') >= 0, '学生端保存教师机地址（客户端与浏览器通用）');

/* ================= 收尾 ================= */
console.log('\n----------------------------------------');
if (failures.length) {
  console.log(`❌ 失败 ${failures.length} 项 / 通过 ${passed} 项`);
  failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
  process.exit(1);
} else {
  console.log(`✅ 全部通过：${passed} 项断言`);
}
