/* 一次性：读失败运行的注解（::error::），定位 test 工作流到底哪一步挂了 */
'use strict';
const H = { 'User-Agent': 'luchenxi-check', Accept: 'application/vnd.github+json' };
const API = 'https://api.github.com/repos/JuLuogo/luchenxi';

(async () => {
  const runs = await (await fetch(API + '/actions/runs?per_page=12', { headers: H })).json();
  const bad = (runs.workflow_runs || []).filter((r) => r.conclusion === 'failure' && r.name === 'test').slice(0, 2);
  if (!bad.length) { console.log('没有失败的 test 运行'); return; }
  for (const run of bad) {
    console.log('\n===== test @ ' + run.head_sha.slice(0, 7) + ' ' + run.created_at + ' =====');
    const jobs = await (await fetch(run.jobs_url, { headers: H })).json();
    jobs.jobs.forEach((j) => {
      const st = (j.steps || []).filter((s) => s.conclusion === 'failure').map((s) => s.name);
      console.log('  作业 ' + j.name + ' → ' + j.conclusion + (st.length ? '  失败步骤: ' + st.join(' / ') : ''));
    });
    const checks = await (await fetch(API + '/commits/' + run.head_sha + '/check-runs?per_page=50', { headers: H })).json();
    for (const cr of checks.check_runs || []) {
      if (cr.conclusion !== 'failure') continue;
      const ann = await (await fetch(cr.url + '/annotations', { headers: H })).json().catch(() => []);
      const errs = (ann || []).filter((a) => a.annotation_level === 'failure');
      if (!errs.length) continue;
      console.log('\n  ▶ ' + cr.name);
      errs.slice(0, 6).forEach((a) => console.log('     ' + String(a.message).replace(/\n/g, ' ').slice(0, 700)));
    }
  }
})().catch((e) => console.error('失败：' + e.message));
