/*! 一次性：查 v4.2.3 构建是否结束；若已生成就直接发布为预览版 */
'use strict';
const { spawnSync } = require('node:child_process');
const TAG = 'v4.2.3';
const r = spawnSync('git', ['credential', 'fill'], { input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8', cwd: 'D:\\github\\luchenxi' });
const m = ((r.stdout || '') + (r.stderr || '')).match(/password=(.+)/);
if (!m) { console.log('  ✗ 拿不到凭据'); process.exit(1); }
const H = { Authorization: 'Bearer ' + m[1].trim(), Accept: 'application/vnd.github+json', 'User-Agent': 'dsh', 'Content-Type': 'application/json' };
const api = 'https://api.github.com/repos/JuLuogo/luchenxi';

async function tryFetch(url, init) {
  for (let i = 0; i < 4; i++) {
    try { return await fetch(url, Object.assign({ headers: H }, init || {})); }
    catch (e) { console.log('    网络抖动，重试 ' + (i + 1) + '/4 …'); await new Promise((s) => setTimeout(s, 4000)); }
  }
  return null;
}

(async () => {
  const rr = await tryFetch(api + '/actions/runs?per_page=10');
  if (!rr) { console.log('  ✗ 网络不通，稍后再试'); process.exit(1); }
  const runs = (await rr.json()).workflow_runs || [];
  const run = runs.find((x) => x.name === 'build' && x.head_branch === TAG);
  console.log('  build ' + TAG + ': ' + (run ? run.status + '/' + (run.conclusion || '-') : '还没出现'));
  if (!run || run.status !== 'completed') { console.log('  → 构建还没结束，等它跑完再发布'); process.exit(0); }
  if (run.conclusion !== 'success') {
    console.log('  ✗ 构建结论 ' + run.conclusion + ' —— 列出失败作业');
    const j = await tryFetch(api + '/actions/runs/' + run.id + '/jobs');
    if (j) {
      const jobs = (await j.json()).jobs || [];
      for (const job of jobs) if (job.conclusion && job.conclusion !== 'success') {
        console.log('    · ' + job.name + ' → ' + job.conclusion);
        for (const s of job.steps || []) if (s.conclusion === 'failure') console.log('        ✗ ' + s.name);
      }
    }
    process.exit(1);
  }

  const relRes = await tryFetch(api + '/releases?per_page=30');
  const rel = relRes ? ((await relRes.json()) || []).find((x) => x.tag_name === TAG) : null;
  if (!rel) { console.log('  ✗ 构建成功但没找到 Release（release 作业可能没跑）'); process.exit(1); }
  console.log('  Release: draft=' + rel.draft + ' pre=' + rel.prerelease + ' 资产=' + rel.assets.length + ' 个');
  if (!rel.draft && rel.prerelease) { console.log('  ✅ 已经是已发布的预览版：' + rel.html_url); process.exit(0); }
  const patch = await tryFetch(api + '/releases/' + rel.id, {
    method: 'PATCH',
    body: JSON.stringify({
      draft: false,
      prerelease: true,
      name: TAG + '（预览版）',
      body: '**预览版**：用于课堂实测。\n\n- 点名：判完停在原位，**再按一次空格**才抽下一位；抽人时有**跳动动画**（开「减少动效」则直接出结果）\n- 大屏「点评总结」：班级概览 KPI + 各队正确率/得分对比条 + 每队「最强/最弱」题型标签（与雷达同一份数据）\n- 教师端内置枢纽服务网页：学生端 `/join` 与大屏 `/stage` 打得开；「打开大屏」桌面端走系统浏览器\n- 公开课：写明"展示课专用、老师一台机器推进"及与「课堂协同」的区别\n- 设计规范：字号 1 种 / 间距 0 种硬编码 / 圆角 2 种；README 删除 ICP 备案段'
    })
  });
  if (!patch || patch.status !== 200) { console.log('  ✗ 发布失败 HTTP ' + (patch ? patch.status : '网络')); process.exit(1); }
  const j = await patch.json();
  console.log('  ✅ 已发布为预览版：' + j.html_url + '（资产 ' + j.assets.length + ' 个）');
})().catch((e) => { console.log('  ✗ ' + e.message); process.exit(1); });
