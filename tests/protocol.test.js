/*!
 * tests/protocol.test.js — v3 报文契约的四端对照
 *   node tests/protocol.test.js
 *
 * 契约来源：packages/protocol/messages.js
 * 对照对象：Node 枢纽（sync-server.js）· Rust 枢纽（hub.rs）· 教师端（sync.js）
 *           · 学生端（student.js）· 大屏（index.html）· 文档（docs/07）
 *
 * 目的：任何一端少写/写错一个报文名或字段名，这里就会红 —— 而不是等到课堂上"连上了但不动"。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const P = require(path.join(ROOT, 'packages', 'protocol', 'messages.js'));

let passed = 0;
const failures = [];
function ok(cond, label) { if (cond) passed++; else failures.push(label); }
function eq(a, b, label) { if (JSON.stringify(a) === JSON.stringify(b)) passed++; else failures.push(label + '  →  期望 ' + JSON.stringify(b) + '，实际 ' + JSON.stringify(a)); }
function group(n) { console.log('\n== ' + n + ' =='); }

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/* ================= 1. 契约自身完整性 ================= */
group('契约自身');

const types = P.typeList();
ok(types.length >= 12, '契约声明了 ' + types.length + ' 种报文');
types.forEach((t) => {
  const def = P.ALL_TYPES[t];
  ok(Array.isArray(def.required) && def.required.indexOf('type') === 0, t + ' 必填字段以 type 开头');
  ok(!!def.direction, t + ' 声明了方向');
  ok(!!def.note, t + ' 有用途说明');
});
ok(P.version === 3, '协议版本为 3');
['choice', 'text', 'skip'].forEach((k) => ok(P.CMD_KINDS.answer.fields.join(' ').indexOf(k) >= 0, '作答命令支持 ' + k));

/* ================= 2. Node 枢纽（sync-server.js） ================= */
group('Node 枢纽');

const nodeHub = read('sync-server.js');

// 2a. 枢纽必须处理的入站报文
['hello', 'state', 'dump', 'request', 'request-dump', 'cmd'].forEach((t) => {
  const re = new RegExp("msg\\.type\\s*===\\s*'" + t.replace('-', '-') + "'");
  ok(re.test(nodeHub) || new RegExp("case '" + t + "'").test(nodeHub) || nodeHub.indexOf("'" + t + "'") >= 0,
    'Node 枢纽识别入站报文 ' + t);
});

// 2b. 枢纽必须发出的出站报文
['welcome', 'state', 'leaderboard', 'dump', 'cmd', 'cmd-backlog', 'ack', 'presence', 'error'].forEach((t) => {
  ok(new RegExp("type:\\s*'" + t + "'").test(nodeHub), 'Node 枢纽发送出站报文 ' + t);
});

// 2c. 关键字段名必须逐字出现
['hostOnline', 'hasState', 'hasDump', 'clientId', 'cmdId', 'reason', 'teacher-offline', 'payload', 'cmds'].forEach((f) => {
  ok(nodeHub.indexOf(f) >= 0, 'Node 枢纽含字段 ' + f);
});

// 2d. dump 通道不得广播（安全约束）
// 审计发现：原来用 indexOf("case 'dump'") 切片，而 sync-server.js 里是 `msg.type === 'dump'`
// → 两个 indexOf 都是 -1 → 切出空串 → `.indexOf("broadcast") < 0` 恒真（等于没断言）
const dumpStart = nodeHub.indexOf("msg.type === 'dump'");
const dumpEnd = nodeHub.indexOf("request-dump", dumpStart);
ok(dumpStart >= 0 && dumpEnd > dumpStart, "能定位到 dump 分支（切不出这一段说明断言失效）");
const dumpBlock = dumpStart >= 0 && dumpEnd > dumpStart ? nodeHub.slice(dumpStart, dumpEnd) : "";
ok(dumpBlock.length > 0, "dump 分支切片非空（长度 " + dumpBlock.length + "）");
ok(dumpBlock.indexOf("broadcast") < 0, "dump 分支不广播（只回教师端）");
// 反向确认：这一段里确实有 dump 的写入逻辑（否则切错地方也会"通过"）
ok(dumpBlock.indexOf("room.dump = msg.payload") >= 0, "切到的确实是 dump 写入分支");

/* ================= 3. Rust 枢纽（hub.rs） ================= */
group('Rust 枢纽（apps/teacher）');

const rustHub = read('crates/ci-hub/src/lib.rs');
types.forEach((t) => {
  ok(rustHub.indexOf('"' + t + '"') >= 0, 'hub.rs 提到报文 ' + t);
});
['payload', 'room', 'rev', 'hostOnline', 'clientId', 'teamId', 'label', 'role', 'hasState', 'hasDump'].forEach((f) => {
  ok(rustHub.indexOf(f) >= 0, 'hub.rs 含字段 ' + f);
});
ok(/async fn health/.test(rustHub) && /async fn api_get_state/.test(rustHub) && /async fn api_put_state/.test(rustHub),
  'hub.rs 提供 /health 与 /api/state（与 Node 枢纽同名同语义）');
ok(rustHub.indexOf('/api/stats') >= 0, 'hub.rs 提供 /api/stats');
ok(rustHub.indexOf('CorsLayer::permissive') >= 0, 'hub.rs 开放 CORS（客户端与 file:// 页面需要）');
ok(rustHub.indexOf('safe_room') >= 0, 'hub.rs 有房间号白名单清洗（与 Node 同规则）');

/* ================= 4. 教师端（sync.js） ================= */
group('教师端 sync.js');

const syncJs = read('assets/js/sync.js');
// 题目组装规则已下沉到 CI.classroom.studentView（classroom.js），所以两边都要看
const viewSrc = syncJs + read('assets/js/classroom.js');
['welcome', 'dump', 'state', 'cmd', 'cmd-backlog', 'presence', 'error'].forEach((t) => {
  ok(new RegExp("case '" + t + "'").test(syncJs), 'sync.js 处理出站报文 ' + t);
});
ok(syncJs.indexOf("type: 'state'") >= 0, 'sync.js 推送 state');
ok(syncJs.indexOf("type: 'dump'") >= 0, 'sync.js 推送 dump');
ok(syncJs.indexOf("type: 'request-dump'") >= 0, 'sync.js 请求 dump');
ok(syncJs.indexOf("type: 'request'") >= 0, 'sync.js 请求 state');
ok(syncJs.indexOf('role=host') >= 0, 'sync.js 以 host 角色连接');
// 快照字段必须与契约一致
Object.keys(P.SNAPSHOT_FIELDS).forEach((f) => {
  ok(syncJs.indexOf(f) >= 0, 'snapshot 含字段 ' + f);
});
['accepting', 'reveal', 'questionIndex', 'tierWeights', 'recent', 'answerKey', 'hasAnswer'].forEach((f) => {
  ok(viewSrc.indexOf(f) >= 0, 'snapshot.meta 含 ' + f);
});

/* ================= 5. 学生端（student.js） ================= */
group('学生端 student.js');

const stuJs = read('assets/js/student.js');
ok(/role=team/.test(stuJs), '学生端以 team 角色连接');
['state', 'leaderboard', 'presence', 'welcome', 'ack', 'error'].forEach((t) => {
  ok(new RegExp("msg\\.type === '" + t + "'").test(stuJs), 'student.js 处理 ' + t);
});
Object.keys(P.CMD_KINDS).forEach((k) => {
  ok(stuJs.indexOf("kind: '" + k + "'") >= 0, 'student.js 发送 ' + k + ' 命令');
});
ok(stuJs.indexOf('teacher-offline') >= 0, 'student.js 识别"老师端离线已排队"回执');
ok(/cmdId/.test(stuJs) || /reason === 'teacher-offline'/.test(stuJs), 'student.js 依据 ack 内容给出提示（cmdId 或 reason）');

/* ================= 6. 大屏（index.html） ================= */
group('大屏 index.html');

// 2026-10：大屏已是 Vue 应用 —— 消费快照的是 web/src/stage/App.vue（web/index.html 只是 Vite 模板）
const stage = read('web/src/stage/App.vue');
ok(/role=stage/.test(stage), '大屏以 stage 角色连接');
ok(stage.indexOf('state') >= 0, '大屏消费 state');
ok(stage.indexOf('meta') >= 0, '大屏消费 meta 快照');
['teams', 'meta'].forEach((f) => {
  ok(stage.indexOf(f) >= 0, '大屏使用快照字段 ' + f);
});
// 大屏不再显示个人排名（2026-10 按调研结论去掉光荣榜，改为选项分布）
ok(stage.indexOf('optionDist') >= 0, '大屏显示选项分布（替代个人排名）');

/* ================= 7. 文档一致（docs/07） ================= */
group('协议文档一致');

const docs07 = read('docs/07-通信协议与API.md');
types.forEach((t) => {
  ok(docs07.indexOf(t) >= 0, 'docs/07 记录了报文 ' + t);
});
['hostOnline', 'hasState', 'hasDump', 'clientId', 'cmdId', 'questionIndex', 'revealedQid'].forEach((f) => {
  ok(docs07.indexOf(f) >= 0, 'docs/07 记录了字段 ' + f);
});
ok(docs07.indexOf('packages/protocol/messages.js') >= 0 || docs07.indexOf('messages.js') >= 0,
  'docs/07 指向机器可读契约（packages/protocol/messages.js）');

/* ================= 8. Node 与 Rust 枢纽的 HTTP 面一致 ================= */
group('两版枢纽的 HTTP 接口一致');

['/health', '/api/state', '/api/stats', '/api/backup', '/api/restore', '/qr.png'].forEach((route) => {
  const inNode = nodeHub.indexOf("'" + route) >= 0 || nodeHub.indexOf('"' + route) >= 0 || nodeHub.indexOf(route) >= 0;
  ok(inNode, 'Node 枢纽提供 ' + route);
});
// 两版枢纽的 HTTP 面必须同名同语义（/qr.png 是 Node 版独有：Rust 版不需要，客户端自带二维码渲染）
['/health', '/api/state', '/api/stats', '/api/backup', '/api/restore'].forEach((route) => {
  ok(rustHub.indexOf(route) >= 0, 'Rust 枢纽已实现 ' + route);
});
ok(rustHub.indexOf('api_restore') >= 0 && nodeHub.indexOf("'/api/restore'") >= 0,
  '两版枢纽都实现 /api/restore（导入备份后同时替换 dump 与轻量快照）');

/* ================= 9. 生成的 Rust 常量必须是最新的 ================= */
group('Rust 协议常量（代码生成）');

const genPath = 'crates/ci-protocol/src/lib.rs';
ok(fs.existsSync(path.join(ROOT, genPath)), '存在生成的 ' + genPath);
const genSrc = read(genPath);
ok(genSrc.indexOf('@generated') >= 0, '生成文件带 @generated 标记（提示勿手改）');
types.forEach((t) => ok(genSrc.indexOf('"' + t + '"') >= 0, '生成文件含报文 ' + t));
Object.keys(P.CMD_KINDS).forEach((k) => ok(genSrc.indexOf('"' + k + '"') >= 0, '生成文件含命令种类 ' + k));
Object.keys(P.SNAPSHOT_FIELDS).forEach((f) => ok(genSrc.indexOf('"' + f + '"') >= 0, '生成文件含快照字段 ' + f));
// Rust 枢纽必须引用生成常量而不是手写一份
const hubUseGen = read('crates/ci-hub/src/lib.rs');
// v5：契约常量独立成 crate（ci-protocol），枢纽直接 use 它
ok(/use ci_protocol as proto;/.test(hubUseGen), 'ci-hub 引用生成的契约常量（ci-protocol）');
ok(hubUseGen.indexOf('proto::ALL_TYPES') >= 0, 'hub.rs 的 SUPPORTED_TYPES 来自生成文件');
const teacherLibSrc = read('apps/teacher/src-tauri/src/lib.rs');
ok(/pub mod protocol_gen\s*\{/.test(teacherLibSrc) || teacherLibSrc.indexOf('pub mod protocol_gen;') >= 0,
  'lib.rs 暴露 protocol_gen（v5 为对 ci-protocol 的再导出）');
ok(/pub use ci_protocol::\*;/.test(teacherLibSrc), 'lib.rs 的 protocol_gen 再导出 ci-protocol');

// 真正跑一次 --check：不一致（有人改了契约没重新生成）就会红
const { spawnSync } = require('child_process');
const gen = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'gen-protocol.mjs'), '--check'], { stdio: 'inherit' });
ok(gen.status === 0, 'node scripts/gen-protocol.mjs --check 通过（生成文件与契约一致）');

/* ================= 10. 场景清单 → 两版实现覆盖一致 ================= */
group('枢纽场景清单（同一份用例，两种实现）');

const scenarios = JSON.parse(read('packages/protocol/hub-scenarios.json'));
ok(scenarios.version === P.version, '场景清单版本与协议一致');
ok(Array.isArray(scenarios.scenarios) && scenarios.scenarios.length >= 13, '场景数量 ' + scenarios.scenarios.length);

const jsSpec = read('tests/hub-spec.test.js');
const rustTests = read('crates/ci-hub/tests/hub_conformance.rs');

scenarios.scenarios.forEach((s) => {
  ok(!!s.id && !!s.title, '场景 ' + s.id + ' 有 id 与 title');
  ok(jsSpec.indexOf(s.id) >= 0, 'Node 规格覆盖场景 ' + s.id);
  ok(rustTests.indexOf('async fn ' + s.id) >= 0, 'Rust 一致性测试覆盖场景 ' + s.id);
});

// 反向：Rust 里的每个 #[tokio::test] 都必须在清单里登记（防止有人加了用例却忘了登记）
const rustFns = [...rustTests.matchAll(/#\[tokio::test\][\s\S]{0,80}?async fn (\w+)/g)].map((m) => m[1]);
const ids = scenarios.scenarios.map((s) => s.id);
eq(rustFns.filter((f) => ids.indexOf(f) < 0), [], 'Rust 测试函数都在清单里登记');

// Rust 侧必须有本机可跑的单元测试（无 Tauri 运行时依赖）
const libRs = read('apps/teacher/src-tauri/src/lib.rs');
ok(/#\[cfg\(test\)\]/.test(libRs), 'lib.rs 含单元测试模块');
['db_roundtrip_without_tauri', 'protocol_constants_generated', 'safe_room_rules', 'easytier_args_match_js_rules']
  .forEach((t) => ok(libRs.indexOf('fn ' + t) >= 0, 'lib.rs 单测 ' + t));
ok(read('apps/teacher/src-tauri/src/main.rs').indexOf('luchenxi_teacher_lib::run()') >= 0,
  'main.rs 是薄壳，调用 lib 的 run()（移动端必需 lib target）');

/* ================= 收尾 ================= */
console.log('\n----------------------------------------');
if (failures.length) {
  console.log(`❌ 失败 ${failures.length} 项 / 通过 ${passed} 项`);
  failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
  process.exit(1);
} else {
  console.log(`✅ 全部通过：${passed} 项断言`);
}
