/* 诊断：查 v4.1.4 build 运行的作业与失败步骤（无 token 时唯一可读的通道） */
'use strict';
const H = { 'User-Agent': 'x', 'Accept': 'application/vnd.github+json' };
(async () => {
  const BASE = 'https://api.github.com/repos/JuLuogo/luchenxi';
  const runs = await (await fetch(BASE + '/actions/runs?per_page=8', { headers: H })).json();
  const build = (runs.workflow_runs || []).find((w) => w.name === 'build' && w.head_branch === 'v4.1.4');
  if (!build) { console.log('  没找到 v4.1.4 的 build 运行'); return; }
  console.log('  run id: ' + build.id + '  结论: ' + build.conclusion);
  const jobs = await (await fetch(BASE + '/actions/runs/' + build.id + '/jobs', { headers: H })).json();
  for (const j of jobs.jobs || []) {
    const mark = j.conclusion === 'success' ? '✅' : '❌';
    console.log('  ' + mark + ' ' + j.name);
    if (j.conclusion === 'failure') {
      for (const s of j.steps || []) {
        if (s.conclusion === 'failure') console.log('       ✘ 失败步骤: ' + s.name);
      }
      const id = j.check_run_url.split('/').pop();
      const ann = await (await fetch(BASE + '/check-runs/' + id + '/annotations?per_page=100', { headers: H })).json();
      ann.slice(0, 14).forEach((x) => console.log('       · ' + String(x.message).slice(0, 190)));
    }
  }
})().catch((e) => { console.error('失败: ' + e.message); process.exit(1); });
