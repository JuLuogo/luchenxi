/* 诊断：查指定 tag 的 build 运行状态 */
'use strict';
const H = { 'User-Agent': 'x', 'Accept': 'application/vnd.github+json' };
const BASE = 'https://api.github.com/repos/JuLuogo/luchenxi';
const want = process.argv[2] || 'v4.1.6';
(async () => {
  const runs = await (await fetch(BASE + '/actions/runs?per_page=12', { headers: H })).json();
  const all = (runs.workflow_runs || []).filter((w) => w.name === 'build');
  console.log('  最近的 build 运行：');
  all.forEach((w) => console.log('    ' + String(w.head_branch).padEnd(8) + ' ' + w.status + ' ' + (w.conclusion || '')));
  const build = all.find((w) => w.head_branch === want);
  if (!build) { console.log('  没找到 ' + want); return; }
  console.log('\n  ' + want + ': ' + build.status + ' ' + (build.conclusion || ''));
  const jobs = await (await fetch(BASE + '/actions/runs/' + build.id + '/jobs', { headers: H })).json();
  for (const j of jobs.jobs || []) {
    const m = j.conclusion === 'success' ? '✅' : (j.conclusion === 'failure' ? '❌' : '⏳');
    console.log('  ' + m + ' ' + j.name);
    if (j.conclusion === 'failure') {
      for (const s of j.steps || []) if (s.conclusion === 'failure') console.log('       ✘ ' + s.name);
    }
  }
})().catch((e) => { console.error('失败: ' + e.message); process.exit(1); });
