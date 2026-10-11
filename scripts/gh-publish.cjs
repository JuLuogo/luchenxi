/*!
 * tests/gh-publish.cjs — 等 v4.2.1 构建完成，然后把它**发布为预览版**（GitHub Pre-release）
 *
 *   为什么需要脚本：工作流只创建 **Draft**，发布要额外一步；本机没有 gh CLI，
 *   所以用 git 凭据里的 token 直接调 REST API。（令牌只在内存里，不落盘、不打印。）
 *
 *   node tests/gh-publish.cjs [tag]
 */
'use strict';
const { spawnSync } = require('node:child_process');

const TAG = process.argv[2] || 'v4.2.1';
const REPO = 'JuLuogo/luchenxi';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const r = spawnSync('git', ['credential', 'fill'], {
  input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8', cwd: 'D:\\github\\luchenxi'
});
const m = ((r.stdout || '') + (r.stderr || '')).match(/password=(.+)/);
if (!m) { console.log('  ✗ 拿不到凭据'); process.exit(1); }
const H = { Authorization: 'Bearer ' + m[1].trim(), Accept: 'application/vnd.github+json', 'User-Agent': 'dsh', 'Content-Type': 'application/json' };
const api = 'https://api.github.com/repos/' + REPO;
const jget = async (p, init) => {
  const res = await fetch(api + p, Object.assign({ headers: H }, init || {}));
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch (e) { body = text; }
  return { status: res.status, body };
};

(async () => {
  console.log('▶ 等 ' + TAG + ' 的构建完成（最多 45 分钟）');
  let run = null;
  for (let i = 0; i < 90; i++) {
    const g = await jget('/actions/runs?per_page=15');
    if (g.status !== 200) { console.log('  查询失败 HTTP ' + g.status); process.exit(1); }
    run = (g.body.workflow_runs || []).find((x) => x.name === 'build' && x.head_branch === TAG);
    if (!run) { console.log('  还没看到 ' + TAG + ' 的 build 运行…'); await sleep(20000); continue; }
    console.log('  [' + new Date().toISOString().slice(11, 19) + '] build ' + run.status + '/' + (run.conclusion || '-') + '  id=' + run.id);
    if (run.status === 'completed') break;
    await sleep(30000);
  }
  if (!run || run.status !== 'completed') { console.log('  ✗ 超时仍未完成'); process.exit(1); }

  if (run.conclusion !== 'success') {
    console.log('  ✗ 构建结论：' + run.conclusion + ' —— 看失败作业');
    const j = await jget('/actions/runs/' + run.id + '/jobs');
    if (j.status === 200) {
      for (const job of j.body.jobs || []) {
        if (job.conclusion && job.conclusion !== 'success') {
          console.log('    · ' + job.name + ' → ' + job.conclusion);
          for (const s of job.steps || []) if (s.conclusion === 'failure') console.log('        ✗ 步骤：' + s.name);
        }
      }
    }
    process.exit(1);
  }
  console.log('  ✅ 构建成功');

  /* 找 Release（可能还是草稿） */
  console.log('\n▶ 找 ' + TAG + ' 的 Release');
  let rel = null;
  for (let i = 0; i < 12; i++) {
    const g = await jget('/releases?per_page=30');
    rel = (g.body || []).find((x) => x.tag_name === TAG);
    if (rel) break;
    console.log('  还没出现，等 15 秒…');
    await sleep(15000);
  }
  if (!rel) { console.log('  ✗ 没找到 Release（构建可能没跑到 release 作业）'); process.exit(1); }
  console.log('  当前：draft=' + rel.draft + ' prerelease=' + rel.prerelease + ' 资产 ' + rel.assets.length + ' 个');
  for (const a of rel.assets) console.log('    · ' + a.name + '  ' + Math.round(a.size / 1048576 * 10) / 10 + ' MB');

  if (!rel.draft && rel.prerelease) { console.log('\n  已经就是"已发布的预览版"，无需再改'); console.log('  ' + rel.html_url); process.exit(0); }

  /* 发布为预览版 */
  console.log('\n▶ 发布为预览版（draft=false, prerelease=true）');
  const patch = await jget('/releases/' + rel.id, {
    method: 'PATCH',
    body: JSON.stringify({
      draft: false,
      prerelease: true,
      name: TAG + '（预览版）',
      body: [
        '**预览版**：用于课堂实测，欢迎反馈问题。',
        '',
        '相对 v4.1.9（上一个正式发布）包含：',
        '',
        '- **教师端内置枢纽现在也服务网页** —— 学生端 `/join` 与大屏 `/stage` 打得开了',
        '  （以前这两条在客户端里是断的：装完教师端只能看到界面，学生连不上、大屏打不开）',
        '- **「打开大屏」桌面端改走系统浏览器** —— Tauri 会拦掉 `window.open` 的外部地址',
        '- **随机点名**：加"本轮加分统计"（累计/人均/判定分布）+ 点名顺序口径说明 + 每人 +N',
        '- **公开课**：写明"展示课专用、老师一台机器推进"，并讲清与「课堂协同」的区别',
        '- **设计规范**：字号 1 种 / 间距 0 种硬编码 / 圆角 2 种（越尺度值清零）',
        '- 第二轮全面审计：隐私四层（`team` 只收本队、大屏不投个人分数）、断网补发、批量判分、趋势、本课归档、无障碍',
        '- README 删除 ICP 备案段',
        '',
        '安装包：教师端 Windows `.msi` / `.exe`、macOS `.dmg`、Linux `.deb`；学生端 Android `.apk`、Windows `.exe`。'
      ].join('\n')
    })
  });
  if (patch.status !== 200) { console.log('  ✗ 发布失败 HTTP ' + patch.status + '：' + JSON.stringify(patch.body).slice(0, 300)); process.exit(1); }
  console.log('  ✅ 已发布为预览版');
  console.log('  ' + patch.body.html_url);
  console.log('  资产 ' + patch.body.assets.length + ' 个，prerelease=' + patch.body.prerelease + ' draft=' + patch.body.draft);
})().catch((e) => { console.log('  ✗ ' + e.message); process.exit(1); });
