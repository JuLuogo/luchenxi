/*!
 * tests/android-manifest.test.js — 用真实工程结构验证"放行明文流量"的修补脚本
 *   node tests/android-manifest.test.js
 *
 * 为什么单独测：这是**只有在 Android 真机上才会暴露**的坑（Android 9+ 默认禁止明文，
 * 学生端连的是 `ws://192.168.x.x:8080`），一旦脚本写错，CI 出包成功但学生装上去连不上教师机。
 *
 * 2026-10 修：**改法从"往清单塞属性"改成"改 Gradle 占位符"**。
 * 塞属性会与 Tauri 模板自带的 `${usesCleartextTraffic}` **同名重复**，
 * Android 清单合并器直接报 `ManifestMerger2$MergeFailureException`，APK 构建失败。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'patch-android-manifest.mjs');

let passed = 0;
const failures = [];
function ok(cond, label) { if (cond) passed++; else failures.push(label); }
function group(n) { console.log('\n== ' + n + ' =='); }
function eq(a, b, label) { ok(a === b, label + '  →  期望 ' + JSON.stringify(b) + '，实际 ' + JSON.stringify(a)); }

/** Tauri `android init` 生成的 build.gradle.kts（取真实结构的关键部分） */
const GRADLE_FIXTURE = `android {
    namespace = "top.peroe.luchenxi.student"
    compileSdk = 36
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "top.peroe.luchenxi.student"
        minSdk = 24
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
        }
    }
}
`;

/** 清单里用的是占位符（模板自带） */
const MANIFEST_FIXTURE = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <uses-permission android:name="android.permission.INTERNET" />
    <application
        android:icon="@mipmap/ic_launcher"
        android:label="@string/app_name"
        android:theme="@style/AppTheme"
        android:usesCleartextTraffic="\${usesCleartextTraffic}">
        <activity android:name=".MainActivity" android:exported="true" />
    </application>
</manifest>
`;

/** 历史遗留：清单里既保留占位符、又被塞了一个字面量属性（同名重复 → 合并失败） */
const MANIFEST_POLLUTED = MANIFEST_FIXTURE.replace(
  'android:usesCleartextTraffic="${usesCleartextTraffic}">',
  'android:usesCleartextTraffic="${usesCleartextTraffic}" \n        android:usesCleartextTraffic="true">'
);

function makeTree(gradleText, manifestText) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-android-'));
  const app = path.join(dir, 'app');
  const main = path.join(app, 'src', 'main');
  fs.mkdirSync(main, { recursive: true });
  if (gradleText !== null) fs.writeFileSync(path.join(app, 'build.gradle.kts'), gradleText, 'utf8');
  if (manifestText !== null) fs.writeFileSync(path.join(main, 'AndroidManifest.xml'), manifestText, 'utf8');
  return dir;
}

function run(dir, extra) {
  try {
    const out = execFileSync(process.execPath, [SCRIPT, '--dir', dir].concat(extra || []), { encoding: 'utf8' });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status === undefined ? 1 : e.status, out: (e.stdout || '') + (e.stderr || '') };
  }
}

const gradleOf = (dir) => fs.readFileSync(path.join(dir, 'app', 'build.gradle.kts'), 'utf8');
const manifestOf = (dir) => {
  const p = path.join(dir, 'app', 'src', 'main', 'AndroidManifest.xml');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
};

/* ================= 1. 改占位符（不是改清单） ================= */
group('把 defaultConfig 的占位符改成 true');
{
  const dir = makeTree(GRADLE_FIXTURE, MANIFEST_FIXTURE);
  const r = run(dir);
  const g = gradleOf(dir);
  eq(r.code, 0, '修补成功退出码 0');
  ok(/defaultConfig[\s\S]{0,120}usesCleartextTraffic"\]\s*=\s*"true"/.test(g), 'defaultConfig 里的占位符变成 true');
  ok(/getByName\("debug"\)[\s\S]{0,120}usesCleartextTraffic"\]\s*=\s*"true"/.test(g), 'debug 那处保持 true');
  eq((g.match(/usesCleartextTraffic"\]\s*=\s*"false"/g) || []).length, 0, '不再有 false');
  // 清单一个字都不能动（模板用占位符，改清单反而会坏）
  eq(manifestOf(dir), MANIFEST_FIXTURE, '清单保持原样（不塞属性）');
  ok(/namespace|applicationId/.test(g), 'Gradle 其它内容未被破坏');
  fs.rmSync(dir, { recursive: true, force: true });
}

/* ================= 2. 幂等 ================= */
group('重复执行必须幂等（CI 会跑多次）');
{
  const dir = makeTree(GRADLE_FIXTURE, MANIFEST_FIXTURE);
  run(dir);
  const once = gradleOf(dir);
  const r2 = run(dir);
  eq(r2.code, 0, '第二次也成功');
  eq(gradleOf(dir), once, '第二次没有改动文件内容');
  ok(/已放行/.test(r2.out), '第二次输出"已放行"');
  eq((gradleOf(dir).match(/usesCleartextTraffic"\]\s*=\s*"true"/g) || []).length, 2, '两处都是 true（不重复插入）');
  fs.rmSync(dir, { recursive: true, force: true });
}

/* ================= 3. 自愈：清掉历史上被写脏的清单 ================= */
group('清掉清单里重复的字面量属性（否则清单合并直接报错）');
{
  const dir = makeTree(GRADLE_FIXTURE, MANIFEST_POLLUTED);
  const r = run(dir);
  const m = manifestOf(dir);
  eq(r.code, 0, '修补成功');
  ok(/清掉清单里重复/.test(r.out), '明确报告做了自愈');
  eq((m.match(/android:usesCleartextTraffic\s*=/g) || []).length, 1, '清单里只剩占位符一处');
  ok(/\$\{usesCleartextTraffic\}/.test(m), '占位符保留（由 Gradle 决定取值）');
  ok(!/android:usesCleartextTraffic\s*=\s*"true"/.test(m), '不再有字面量 true');
  // 结构没坏
  eq((m.match(/<application/g) || []).length, 1, '<application 只有一个');
  eq((m.match(/<\/application>/g) || []).length, 1, '</application> 完好');
  ok(/android:icon="@mipmap\/ic_launcher"/.test(m), '原有属性保留');
  fs.rmSync(dir, { recursive: true, force: true });
}

/* ================= 4. --check：未修补要报错 ================= */
group('--check 只校验（供 CI 用）');
{
  const dir = makeTree(GRADLE_FIXTURE, MANIFEST_FIXTURE);
  const r = run(dir, ['--check']);
  eq(r.code, 1, '未修补时退出码 1');
  eq(gradleOf(dir), GRADLE_FIXTURE, '--check 不修改文件');
  ok(/未放行明文流量/.test(r.out), '给出可读原因');
  run(dir);
  const r2 = run(dir, ['--check']);
  eq(r2.code, 0, '修补后 --check 通过');
  fs.rmSync(dir, { recursive: true, force: true });
}

/* ================= 5. 还没 init：默认跳过，--require 报错 ================= */
group('工程不存在时的行为');
{
  const dir = makeTree(null, null);
  const r = run(dir);
  eq(r.code, 0, '默认静默跳过（还没 tauri android init）');
  ok(/未找到 Android 工程/.test(r.out), '给出说明');
  const r2 = run(dir, ['--require']);
  eq(r2.code, 1, '--require 时报错（构建流程里要早失败）');
  fs.rmSync(dir, { recursive: true, force: true });
}

/* ================= 6. 与真实工程衔接 ================= */
group('与真实工程衔接');
{
  const src = fs.readFileSync(SCRIPT, 'utf8');
  ok(/apps.*src-tauri.*gen.*android/.test(src) || /'gen', 'android'/.test(src),
    '默认路径指向 apps/<app>/src-tauri/gen/android');
  ok(/--app/.test(src), '支持 --app teacher|student');
  ok(/明文流量/.test(src), '脚本里说明了原因（明文流量）');
  ok(/manifestPlaceholders/.test(src), '走 Gradle 占位符（不是往清单塞属性）');
  const conf = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps/student/src-tauri/tauri.conf.json'), 'utf8'));
  ok(conf.bundle.android.minSdkVersion >= 24, '学生端 minSdkVersion >= 24（当前 ' + conf.bundle.android.minSdkVersion + '）');
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
