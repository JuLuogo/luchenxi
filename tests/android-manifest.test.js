/*!
 * tests/android-manifest.test.js — 用真实清单样本验证"放行明文流量"的修补脚本
 *   node tests/android-manifest.test.js
 *
 *  为什么单独测：这是**只有在 Android 真机上才会暴露**的坑（Android 9+ 默认禁止明文，
 *  学生端连的是 `ws://192.168.x.x:8080`），一旦脚本写错，CI 出包成功但学生装上去连不上教师机。
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

/** Tauri `android init` 生成出来的清单大致长这样（取真实结构的最小样本） */
const FIXTURE = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <uses-permission android:name="android.permission.INTERNET" />
    <application
        android:allowBackup="true"
        android:icon="@mipmap/ic_launcher"
        android:label="@string/app_name"
        android:theme="@style/AppTheme">
        <activity
            android:name=".MainActivity"
            android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>
</manifest>
`;

function makeTree(manifestText) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-android-'));
  const main = path.join(dir, 'app', 'src', 'main');
  fs.mkdirSync(main, { recursive: true });
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

function manifestOf(dir) {
  const p = path.join(dir, 'app', 'src', 'main', 'AndroidManifest.xml');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
}

/* ================= 1. 缺属性 → 补上 ================= */
group('缺属性时补上明文放行');
{
  const dir = makeTree(FIXTURE);
  const r = run(dir);
  const text = manifestOf(dir);
  eq(r.code, 0, '修补成功退出码 0');
  ok(/android:usesCleartextTraffic="true"/.test(text), '清单里出现了 usesCleartextTraffic="true"');
  ok(/<application[\s\S]{0,200}android:usesCleartextTraffic="true"/.test(text), '属性挂在 <application 上（不是别的标签）');
  // XML 结构没被破坏
  eq((text.match(/<application/g) || []).length, 1, '<application 标签仍然只有一个');
  eq((text.match(/<\/application>/g) || []).length, 1, '</application> 未被破坏');
  eq((text.match(/<activity/g) || []).length, 1, 'activity 未被破坏');
  ok(/android:allowBackup="true"/.test(text), '原有属性保留（allowBackup）');
  ok(/android:label="@string\/app_name"/.test(text), '原有属性保留（label）');
  ok(/<uses-permission android:name="android.permission.INTERNET"/.test(text), '权限声明保留');
  fs.rmSync(dir, { recursive: true, force: true });
}

/* ================= 2. 幂等 ================= */
group('重复执行必须幂等（CI 会跑多次）');
{
  const dir = makeTree(FIXTURE);
  run(dir);
  const once = manifestOf(dir);
  const r2 = run(dir);
  const twice = manifestOf(dir);
  eq(r2.code, 0, '第二次也成功');
  eq(twice, once, '第二次没有改动文件内容');
  eq((twice.match(/usesCleartextTraffic/g) || []).length, 1, '属性只出现一次');
  ok(/已放行/.test(r2.out), '第二次输出提示"已放行"');
  fs.rmSync(dir, { recursive: true, force: true });
}

/* ================= 3. 已存在 false → 改成 true ================= */
group('已存在错误取值时纠正');
{
  const dir = makeTree(FIXTURE.replace('android:allowBackup="true"', 'android:allowBackup="true"\n        android:usesCleartextTraffic="false"'));
  const r = run(dir);
  const text = manifestOf(dir);
  eq(r.code, 0, '纠正成功');
  ok(/android:usesCleartextTraffic="true"/.test(text), '值被改成 true');
  ok(!/usesCleartextTraffic="false"/.test(text), '不再有 false');
  eq((text.match(/usesCleartextTraffic/g) || []).length, 1, '没有重复属性');
  fs.rmSync(dir, { recursive: true, force: true });
}

/* ================= 4. --check：未修补要报错 ================= */
group('--check 只校验（供 CI 用）');
{
  const dir = makeTree(FIXTURE);
  const r = run(dir, ['--check']);
  eq(r.code, 1, '未修补时退出码 1');
  eq(manifestOf(dir), FIXTURE, '--check 不修改文件');
  ok(/未放行明文流量/.test(r.out), '给出可读原因');
  run(dir);
  const r2 = run(dir, ['--check']);
  eq(r2.code, 0, '修补后 --check 通过');
  fs.rmSync(dir, { recursive: true, force: true });
}

/* ================= 5. 还没 init：默认跳过，--require 报错 ================= */
group('清单不存在时的行为');
{
  const dir = makeTree(null);
  const r = run(dir);
  eq(r.code, 0, '默认静默跳过（还没 tauri android init）');
  ok(/未找到 Android 清单/.test(r.out), '给出说明');
  const r2 = run(dir, ['--require']);
  eq(r2.code, 1, '--require 时报错（构建流程里要早失败）');
  fs.rmSync(dir, { recursive: true, force: true });
}

/* ================= 6. 真实工程路径可用 ================= */
group('与真实工程衔接');
{
  const src = fs.readFileSync(SCRIPT, 'utf8');
  ok(/apps.*src-tauri.*gen.*android/.test(src) || /'gen', 'android'/.test(src),
    '默认路径指向 apps/<app>/src-tauri/gen/android');
  ok(/--app/.test(src), '支持 --app teacher|student');
  ok(/INTERNET|明文流量/.test(src), '脚本里说明了原因（明文流量）');
  // 学生端的 minSdk 必须 >= 24（Android 7），否则连 WebView 版本都不够新
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
