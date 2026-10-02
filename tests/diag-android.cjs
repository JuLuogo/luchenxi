/* 诊断：v4.1.6 的 android 注解（看 mobile_entry_point 修复是否生效） */
'use strict';
const H = { 'User-Agent': 'x', 'Accept': 'application/vnd.github+json' };
const BASE = 'https://api.github.com/repos/JuLuogo/luchenxi';
const want = process.argv[2] || 'v4.1.6';
(async () => {
  const runs = await (await fetch(BASE + '/actions/runs?per_page=12', { headers: H })).json();
  const build = (runs.workflow_runs || []).find((w) => w.name === 'build' && w.head_branch === want);
  const jobs = await (await fetch(BASE + '/actions/runs/' + build.id + '/jobs', { headers: H })).json();
  const andr = (jobs.jobs || []).find((j) => j.name === 'android');
  const id = andr.check_run_url.split('/').pop();
  const ann = await (await fetch(BASE + '/check-runs/' + id + '/annotations?per_page=100', { headers: H })).json();
  console.log('  android 注解 ' + ann.length + ' 条（去掉 ANSI 色码）：');
  ann.forEach((x, i) => {
    const m = String(x.message).replace(/\u001b\[[0-9;]*m/g, '').trim();
    if (m) console.log('   [' + (i + 1) + '] ' + m.slice(0, 240));
  });
})().catch((e) => { console.error('失败: ' + e.message); process.exit(1); });
