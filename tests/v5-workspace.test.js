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
// ci-hub 多了 ci-domain：领域端点（/api/domain/*）让网页版能直接调用 Rust 核心，
// 而不是在浏览器里再实现一份规则（docs/14 §2 的硬规矩）
eq(deps('crates/ci-hub/Cargo.toml').sort(), ['ci-domain', 'ci-protocol', 'ci-store'],
  'ci-hub 依赖 protocol + store + domain（领域端点需要 domain）');
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
  { js: 'assets/js/store.js', rs: 'crates/ci-domain/src/scoring.rs', name: '题型权重与计分引擎', migrated: true, parity: 'scoring', minParity: 3 },
  // 2026-10 补齐：下面这些其实早就迁了，只是进度表没跟上
  { js: 'assets/js/store.js', rs: 'crates/ci-domain/src/draw.rs', name: '随机抽题', migrated: true, parity: 'draw' },
  { js: 'assets/js/analysis.js', rs: 'crates/ci-domain/src/question_stats.rs', name: '题目统计与选项分布', migrated: true, parity: 'questionStats', minParity: 2 },
  { js: 'assets/js/analysis.js', rs: 'crates/ci-domain/src/mistakes.rs', name: '错题本', migrated: true, parity: 'mistakes', minParity: 2 },
  { js: 'assets/js/analysis.js', rs: 'crates/ci-domain/src/report.rs', name: '课堂报告', migrated: true, parity: 'report' },
  // composite 在 parity.json 里是**对象**（participation/growth/decayed/evaluate 四个子数组），
  // 形状与其它用例集不同，所以不按数组长度校验；它自己的 41 组在 parity.rs 里逐字段比
  { js: 'assets/js/analysis.js', rs: 'crates/ci-domain/src/composite.rs', name: '多维度评价', migrated: true },
  { js: 'assets/js/import.js', rs: 'crates/ci-domain/src/bank_import.rs', name: '批量导入解析', migrated: true },
  { js: 'assets/js/analysis.js', rs: 'crates/ci-domain/src/stats.rs', name: '学情统计聚合', migrated: true, parity: 'stats', minParity: 3 },
  { js: 'assets/js/openclass.js', rs: 'crates/ci-domain/src/openclass.rs', name: '公开课现场评价量规', migrated: true, parity: 'openclass', minParity: 3 },
  { js: 'assets/js/polish.js', rs: 'crates/ci-domain/src/polish.rs', name: 'AI 润色提示词', migrated: true, parity: 'polish', minParity: 3 }
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
/* ================= 7. P3：前端 TS 与类型绑定 ================= */

console.log('\n== 前端 TS 与类型绑定（P3） ==');

const tsconfigPath = path.join(ROOT, 'web', 'tsconfig.json');
ok(has('web/tsconfig.json'), '存在 web/tsconfig.json（TS 工程配置）');
if (fs.existsSync(tsconfigPath)) {
  // tsconfig 是 JSON5（带注释），不做 JSON.parse —— 直接按文本断言，
  // 免得为了读一个配置项再引一套 JSON5 解析器
  const tsc = fs.readFileSync(tsconfigPath, 'utf8');
  ok(/"allowJs"\s*:\s*true/.test(tsc), '允许 JS/TS 混跑（分阶段迁移：老模块不拖进度）');
  ok(/"strictNullChecks"\s*:\s*true/.test(tsc), '打开了 strictNullChecks（最容易藏 bug 的一项）');
  ok(/"noEmit"\s*:\s*true/.test(tsc), 'noEmit：类型检查交给 vue-tsc，不产出文件');
  ok(/"@bindings\/\*"/.test(tsc), '配置了 @bindings/* 别名（指向生成类型）');
}

/* 生成类型：必须存在、必须有 key 类型、必须标明"勿手改" */
const genPath = path.join(ROOT, 'web', 'src', 'bindings', 'generated.ts');
ok(fs.existsSync(genPath), '存在 specta 生成的 web/src/bindings/generated.ts');
if (fs.existsSync(genPath)) {
  const g = fs.readFileSync(genPath, 'utf8');
  ok(/请勿手改|Do not edit/.test(g), '生成文件带"勿手改"提示');
  const need = ['Ability', 'TeamStat', 'CmdOutcome', 'Runtime', 'Question', 'Tier'];
  const missing = need.filter((n) => !g.includes('export type ' + n));
  ok(missing.length === 0, '生成类型覆盖前端要用的关键类型（缺：' + (missing.join('、') || '无') + '）');
  // i64 字段必须导成 number：早期用 f64 override 时是全可空的 number | null
  const abilityBlock = (g.split('export type Ability =')[1] || '').split('export type')[0];
  ok(/overall: number,/.test(abilityBlock), 'i64 字段导出为 number（不是 number | null）');
}

/* 生成器：Rust 侧必须有导出 bin，且默认构建不引入 specta */
ok(has('crates/ci-core/src/bin/export-bindings.rs'), '存在类型绑定生成器（ci-core --bin export-bindings）');
const coreToml = read('crates/ci-core/Cargo.toml');
ok(/required-features\s*=\s*\["bindings"\]/.test(coreToml), '生成器带 required-features（默认构建不编译它）');
const domainToml = read('crates/ci-domain/Cargo.toml');
ok(/bindings\s*=\s*\["dep:specta"/.test(domainToml), 'ci-domain 的 specta 是可选依赖（纯 crate 默认零重依赖）');

/* 派生必须是门控的：否则默认构建会去要 specta */
const domainSrc = ['ability.rs', 'classroom.rs', 'grade.rs', 'scoring.rs']
  .map((f) => read('crates/ci-domain/src/' + f)).join('\n');
const plainDerive = domainSrc.match(/#\[derive\([^)]*specta::Type[^)]*\)\]/g) || [];
ok(plainDerive.length === 0, '没有裸的 specta::Type 派生（都要 cfg_attr 门控，当前 ' + plainDerive.length + ' 处）');
const plainField = (domainSrc.match(/#\[specta\(type = /g) || []).length;
ok(plainField === 0, '没有裸的 #[specta(type = …)] 字段属性（都要 cfg_attr 门控，当前 ' + plainField + ' 处）');
const gated = (domainSrc.match(/cfg_attr\(feature = "bindings"/g) || []).length;
ok(gated >= 40, '门控派生/属性数量足够（当前 ' + gated + ' 处）');

/* npm 脚本与 CI 步骤：绑定过期必须能让 CI 红 */
const webPkg = JSON.parse(read('web/package.json'));
ok(!!webPkg.scripts.typecheck, 'web 有 typecheck 脚本');
ok(!!webPkg.scripts['bindings:check'], 'web 有 bindings:check 脚本（防止契约漂移）');
ok(/typecheck/.test(webPkg.scripts.build || ''), '构建前置 typecheck（类型错就别出包）');
const ciLocalP3 = read('scripts/ci-local.mjs');
ok(/前端类型检查（vue-tsc）/.test(ciLocalP3), 'CI 有「前端类型检查」步骤');
ok(/export-bindings/.test(ciLocalP3) && /--check/.test(ciLocalP3), 'CI 有「类型绑定一致性」步骤');


/* 组件 TS 化棘轮：已转的不能退回 JS（迁移只能前进） */
function walkVue(dir) {
  let out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const q = path.join(dir, e.name);
    if (e.isDirectory()) out = out.concat(walkVue(q));
    else if (e.name.endsWith('.vue')) out.push(q);
  }
  return out;
}
const vueFiles = walkVue(path.join(ROOT, 'web', 'src'));
const vueTs = vueFiles.filter((f) => /lang\s*=\s*["']ts["']/.test(fs.readFileSync(f, 'utf8')));
const VUE_TS_FLOOR = 24;   // 棘轮已拉满：全部组件都必须是 TS，只许保持
ok(vueTs.length >= VUE_TS_FLOOR,
  '组件 TS 化棘轮：' + VUE_TS_FLOOR + ' 个组件全部是 <script setup lang="ts">（当前 ' + vueTs.length + '/' + vueFiles.length + '）');
ok(vueTs.length === vueFiles.length, '没有漏网的 JS 组件（共 ' + vueFiles.length + ' 个）');
ok(fs.existsSync(path.join(ROOT, 'web', 'src', 'shared', 'class-store.ts')), 'Pinia store 已是 TS');
ok(!fs.existsSync(path.join(ROOT, 'web', 'src', 'shared', 'class-store.js')), '旧的 class-store.js 已删除（不留双份）');


/* ================= 8. P4：网页版由 Rust 核心驱动（领域端点） ================= */

console.log('\n== 领域端点（网页版调 Rust 核心的入口） ==');

ok(has('crates/ci-hub/src/domain_api.rs'), '存在领域端点模块（ci-hub/src/domain_api.rs）');
const hubLib = read('crates/ci-hub/src/lib.rs');
['/api/domain/grade', '/api/domain/score', '/api/domain/ability', '/api/domain/pick'].forEach((ep) => {
  ok(hubLib.includes(ep), '枢纽挂了 ' + ep + '（网页版据此调用 Rust 核心，而不是在前端重写规则）');
});
const hubToml = read('crates/ci-hub/Cargo.toml');
ok(/^ci-domain\s*=/m.test(hubToml), 'ci-hub 依赖 ci-domain（领域端点直接调 Rust 实现，不复制规则）');
ok(has('crates/ci-hub/tests/domain_api.rs'), '领域端点有集成测试（起真枢纽 + 真 HTTP）');

// 点名的随机源必须是可注入种子的（否则测试断言不了具体结果）
const domainApi = read('crates/ci-hub/src/domain_api.rs');
ok(/XorShift64::seed/.test(domainApi), '点名端点用可传入的种子（同种子 → 同一个人，可复现）');

// 出包链路：Android 必须装 cargo-ndk（Tauri 的 Android 交叉编译依赖它）
const buildYml = read('.github/workflows/build.yml');
ok(/cargo-ndk/.test(buildYml), 'build 工作流安装 cargo-ndk（Tauri Android 交叉编译必需）');
ok(!/name: 创建 Draft Release\n\s+continue-on-error/.test(buildYml), 'Release 失败不再被 continue-on-error 掩盖');
ok(/gh release view/.test(buildYml), 'Release 创建后有"确认资产"的一步（给安装包在不在一个明确结论）');

console.log('\n' + '-'.repeat(44));
if (failures.length) {
  console.log('❌ 失败 ' + failures.length + ' 项 / 通过 ' + passed + ' 项');
  failures.forEach((f, i) => console.log('  ' + (i + 1) + '. ' + f));
  process.exit(1);
}
console.log('✅ 全部通过：' + passed + ' 项断言');
