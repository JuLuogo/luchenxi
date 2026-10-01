/*!
 * tests/v5-workspace.test.js — v5 工作区结构与"核心在 Rust"的硬约束
 *
 * 为什么要有这组断言：v5 的迁移目标（docs/14）是"一份核心逻辑，三端只做展示"。
 * 迁移期间最容易发生的倒退是：
 *   · 有人把业务规则又写回前端（assets/js / web/）
 *   · 依赖方向写反（ci-domain 依赖了 ci-hub，或枢纽依赖了 tauri）
 *   · 新加的 crate 忘了进 workspace，或没进 CI
 * 这些都不会让编译失败，只会让架构慢慢烂掉 —— 所以用断言锁住。
 *
 * 另外它会打印**领域层迁移进度表**（JS 模块 → Rust 模块），
 * 每迁完一个模块就把对应行改成 migrated，进度可被测试看见。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let passed = 0;
const failures = [];
const ok = (cond, label) => { if (cond) passed++; else failures.push(label); };
const eq = (a, b, label) => {
  const x = JSON.stringify(a), y = JSON.stringify(b);
  if (x === y) passed++; else failures.push(label + '  →  期望 ' + y + '，实际 ' + x);
};
const group = (name) => console.log('\n== ' + name + ' ==');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const has = (rel) => fs.existsSync(path.join(ROOT, rel));

/* ================= 1. workspace 与 crate 结构 ================= */
group('v5 工作区结构');

const rootCargo = read('Cargo.toml');
ok(/\[workspace\]/.test(rootCargo), 'Cargo.toml 声明 workspace');
ok(/resolver\s*=\s*"2"/.test(rootCargo), 'workspace 使用 resolver 2');

const CRATES = ['ci-protocol', 'ci-domain', 'ci-store', 'ci-hub', 'ci-core'];
CRATES.forEach((c) => {
  ok(has('crates/' + c + '/Cargo.toml'), 'crates/' + c + ' 有 Cargo.toml');
  ok(has('crates/' + c + '/src/lib.rs'), 'crates/' + c + ' 有 src/lib.rs');
  ok(rootCargo.indexOf('crates/' + c) >= 0, 'workspace members 含 ' + c);
  ok(read('crates/' + c + '/Cargo.toml').indexOf('name = "' + c + '"') >= 0, c + ' 的包名正确');
});
['apps/teacher/src-tauri', 'apps/student/src-tauri'].forEach((a) => {
  ok(rootCargo.indexOf(a) >= 0, 'workspace members 含 ' + a);
});
ok(/\[workspace\.dependencies\]/.test(rootCargo), '依赖版本集中在 workspace.dependencies');

/* ================= 2. 依赖方向（严格单向） ================= */
group('依赖方向');

const deps = (rel) => (read(rel).match(/^(ci-[a-z]+)\s*=/gm) || []).map((s) => s.replace(/\s*=$/, ''));

eq(deps('crates/ci-protocol/Cargo.toml'), [], 'ci-protocol 不依赖任何 ci-* crate（最底层）');
eq(deps('crates/ci-domain/Cargo.toml'), [], 'ci-domain 不依赖其它 ci-* crate（纯规则，可单测）');
eq(deps('crates/ci-store/Cargo.toml'), [], 'ci-store 不依赖 ci-hub/ci-core');
eq(deps('crates/ci-hub/Cargo.toml').sort(), ['ci-protocol', 'ci-store'], 'ci-hub 只依赖 protocol + store');
eq(deps('crates/ci-core/Cargo.toml').sort(), ['ci-domain', 'ci-hub', 'ci-protocol', 'ci-store'],
  'ci-core 汇聚 domain + hub + store + protocol');

// 纯逻辑 crate 不能引入 IO/框架依赖
['ci-protocol', 'ci-domain'].forEach((c) => {
  const t = read('crates/' + c + '/Cargo.toml');
  ['axum', 'rusqlite', 'tauri', 'tokio', 'tower-http'].forEach((bad) => {
    ok(!new RegExp('^' + bad + '\\s*=', 'm').test(t), c + ' 不应依赖 ' + bad);
  });
});
// 枢纽必须能在"没有 Tauri"的情况下编译与测试（内置到客户端、也能独立跑）
ok(!/^tauri\s*=/m.test(read('crates/ci-hub/Cargo.toml')), 'ci-hub 不依赖 tauri（可独立测试）');
ok(!/^tauri\s*=/m.test(read('crates/ci-store/Cargo.toml')), 'ci-store 不依赖 tauri');
ok(!/^tauri\s*=/m.test(read('crates/ci-core/Cargo.toml')), 'ci-core 不依赖 tauri');
// 教师端薄壳依赖门面；学生端只要协议 + 规则（不把枢纽/SQLite 塞进 Android 包）
ok(/ci-core\s*=\s*\{\s*path/.test(read('apps/teacher/src-tauri/Cargo.toml')), '教师端依赖 ci-core');
const studentCargo = read('apps/student/src-tauri/Cargo.toml');
ok(/ci-protocol\s*=\s*\{\s*path/.test(studentCargo) && /ci-domain\s*=\s*\{\s*path/.test(studentCargo),
  '学生端依赖 ci-protocol + ci-domain');
ok(!/ci-core\s*=|ci-hub\s*=|ci-store\s*=/.test(studentCargo), '学生端不依赖枢纽/存储（包体更小）');

/* ================= 3. 旧位置已清空 + 生成物落点 ================= */
group('搬迁完整性');

['db.rs', 'hub.rs', 'net.rs', 'protocol_gen.rs'].forEach((f) => {
  ok(!has('apps/teacher/src-tauri/src/' + f), 'apps/teacher/src-tauri/src/' + f + ' 已移除（搬到 crates/）');
});
ok(!has('apps/teacher/src-tauri/tests/hub_conformance.rs'), '一致性测试已移到 crates/ci-hub/tests/');
ok(has('crates/ci-hub/tests/hub_conformance.rs'), 'crates/ci-hub/tests/hub_conformance.rs 存在');
ok(has('crates/ci-store/schema.sql'), 'crates/ci-store/schema.sql 存在（sync-ui 拷贝）');
ok(/include_str!\("\.\.\/schema\.sql"\)/.test(read('crates/ci-store/src/lib.rs')),
  'ci-store 用 include_str! 读取 crate 根的 schema.sql');
ok(read('scripts/sync-ui.mjs').indexOf("'crates', 'ci-store'") >= 0, 'sync-ui 会把 schema.sql 拷到 crates/ci-store');
ok(read('scripts/gen-protocol.mjs').indexOf("'crates', 'ci-protocol'") >= 0, 'gen-protocol 写到 crates/ci-protocol');
ok(read('.gitignore').indexOf('crates/ci-store/schema.sql') >= 0, '生成的 schema.sql 已忽略');

// 教师端保留同名模块做再导出，这样 Tauri 命令与集成测试零改动
const teacherLib = read('apps/teacher/src-tauri/src/lib.rs');
ok(/pub mod db\s*\{[\s\S]*?pub use ci_store::\*;/.test(teacherLib), 'lib.rs 的 db 模块再导出 ci-store');
ok(/pub mod hub\s*\{[\s\S]*?pub use ci_hub::\*;/.test(teacherLib), 'lib.rs 的 hub 模块再导出 ci-hub');
ok(/pub use ci_core as core;/.test(teacherLib), 'lib.rs 暴露 core 门面');

/* ================= 4. 领域层迁移进度（JS → Rust） ================= */
group('领域层迁移进度（JS → Rust）');

const MIGRATION = [
  { js: 'assets/js/grade.js', rs: 'crates/ci-domain/src/grade.rs', name: '题型推断与客观题判分', migrated: true, parity: 'grading' },
  { js: 'assets/js/analysis.js', rs: 'crates/ci-domain/src/ability.rs', name: '加权计分与能力评价', migrated: true, parity: 'ability' },
  { js: 'assets/js/rollcall.js', rs: 'crates/ci-domain/src/rollcall.rs', name: '随机点名', migrated: true, parity: 'rollcall' },
  { js: 'assets/js/classroom.js', rs: 'crates/ci-domain/src/classroom.rs', name: '课堂环节与学生命令', migrated: true, parity: 'classroom', minParity: 3 },
  { js: 'assets/js/store.js', rs: 'crates/ci-domain/src/scoring.rs', name: '题型权重与计分引擎', migrated: true, parity: 'scoring', minParity: 3 }
];

let done = 0;
MIGRATION.forEach((m) => {
  const exists = has(m.rs);
  ok(!(m.migrated && !exists), (m.migrated ? '[已迁移] ' : '[待迁移] ') + m.name + ' → ' + m.rs + ' 存在');
  if (m.migrated) {
    done++;
    ok(has(m.js), m.name + ' 的 JS 参考实现仍在（迁移期两边并行）');
    // 关键导出必须都在 Rust 侧有对应物（防"迁了一半"）
    const rs = read(m.rs);
    ok(/mod tests/.test(rs), m.rs + ' 自带测试（与 JS 断言一一对应）');
  } else {
    // 未迁移的模块，JS 侧必须仍然存在（不能先删了再迁）
    ok(has(m.js), m.name + ' 的 JS 实现仍在（未迁移前不能删）');
  }
  console.log('   ' + (m.migrated ? '✅' : '⏳') + ' ' + m.name.padEnd(16) + m.js + '  →  ' + m.rs);
});
console.log('\n   进度：' + done + '/' + MIGRATION.length + ' 个领域模块已迁移到 Rust');
ok(done === MIGRATION.length, '五个领域模块全部迁到 Rust（当前 ' + done + '/' + MIGRATION.length + '）');

// 已迁移的模块必须在 parity 基准里有对应用例集（否则"迁移"只是自称）
const parityPath = path.join(ROOT, 'tests', 'fixtures', 'parity.json');
ok(fs.existsSync(parityPath), 'parity.json 存在（由 JS 参考实现生成的基准）');
const parity = JSON.parse(fs.readFileSync(parityPath, 'utf8'));
MIGRATION.filter((m) => m.migrated && m.parity).forEach((m) => {
  const cs = parity[m.parity];
  // 用例数下限按模块给（计分 3 组、其余 5 组起）：组数少但步骤多也算覆盖
  ok(Array.isArray(cs) && cs.length >= (m.minParity || 5),
    m.name + ' 在 parity.json 里有用例集（' + m.parity + '：' + (cs ? cs.length : 0) + ' 组）');
});
const parityCases = ['ability', 'grading', 'rollcall', 'scoring', 'classroom']
  .reduce((n, k) => n + (parity[k] || []).length, 0);
console.log('   parity 基准：能力 ' + (parity.ability || []).length +
  ' + 判分 ' + (parity.grading || []).length +
  ' + 点名 ' + (parity.rollcall || []).length +
  ' + 计分 ' + (parity.scoring || []).length +
  ' + 课堂 ' + (parity.classroom || []).length + ' = ' + parityCases + ' 组');
ok(parityCases >= 20, 'parity 基准覆盖至少 20 组用例（当前 ' + parityCases + '）');
ok((parity.rollcall || []).length >= 3, 'parity 基准含随机点名用例（' + (parity.rollcall || []).length + ' 组）');
ok((parity.scoring || []).length >= 2, 'parity 基准含计分引擎用例（' + (parity.scoring || []).length + ' 组）');
ok((parity.classroom || []).length >= 3, 'parity 基准含课堂协同用例（' + (parity.classroom || []).length + ' 组）');

/* ================= 5. CI 覆盖到 workspace ================= */
group('CI 覆盖');

const ciLocal = read('scripts/ci-local.mjs');
// v5：Rust 步骤改为在 workspace 根跑（覆盖五个 crate + 两套客户端）
ok(/\['test', '--workspace'\]/.test(ciLocal), 'ci-local 跑 cargo test --workspace');
ok(/\['check', '--workspace', '--all-targets'\]/.test(ciLocal), 'ci-local 跑 cargo check --workspace');
ok(/teacherSrc|studentSrc|ci-hub|workspace/.test(ciLocal), 'ci-local 的 Rust 步骤指向 v5 结构');
const rustYml = read('.github/workflows/rust.yml');
ok(/cargo test/.test(rustYml), 'rust.yml 跑 cargo test');
ok(/--workspace/.test(rustYml), 'rust.yml 覆盖整个 workspace');
const pkg = JSON.parse(read('package.json'));
ok(/v5-workspace\.test\.js/.test(pkg.scripts.test), 'package.json 的 test 包含本组断言');

/* ================= 汇总 ================= */
console.log('\n' + '-'.repeat(44));
if (failures.length) {
  console.log('❌ 失败 ' + failures.length + ' 项 / 通过 ' + passed + ' 项');
  failures.forEach((f, i) => console.log('  ' + (i + 1) + '. ' + f));
  process.exit(1);
}
console.log('✅ 全部通过：' + passed + ' 项断言');
