/* 一次性：取 v4.1.2 的 release 作业注解（checkout 修复后报什么） */
'use strict';
const H = { 'User-Agent': 'x', 'Accept': 'application/vnd.github+json' };
(async () => {
  const BASE = 'https://api.github.com/repos/JuLuogo/luchenxi';
  const runs = await (await fetch(BASE + '/actions/runs?per_page=5', { headers: H })).json();
  const build = (runs.workflow_runs || []).find((w) => w.name === 'build' && w.head_branch === 'v4.1.2');
  const jobs = await (await fetch(BASE + '/actions/runs/' + build.id + '/jobs', { headers: H })).json();
  const rel = (jobs.jobs || []).find((j) => j.name === 'release');
  console.log('  release: ' + rel.conclusion + '  步骤：');
  (rel.steps || []).forEach((s) => console.log('    ' + (s.conclusion === 'success' ? '✅' : (s.conclusion === 'failure' ? '❌' : '⏭ ')) + ' ' + s.name));
  const id = rel.check_run_url.split('/').pop();
  const all = await (await fetch(BASE + '/check-runs/' + id + '/annotations?per_page=100', { headers: H })).json();
  console.log('  注解 ' + all.length + ' 条：');
  all.forEach((x) => console.log('   ' + String(x.message).slice(0, 220)));
})();
