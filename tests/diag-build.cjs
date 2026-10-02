/* 诊断：取 android 注解的完整文本（不截断），找 "This means you..." 的完整解释 */
'use strict';
const H = { 'User-Agent': 'x', 'Accept': 'application/vnd.github+json' };
const BASE = 'https://api.github.com/repos/JuLuogo/luchenxi';
(async () => {
  const runs = await (await fetch(BASE + '/actions/runs?per_page=8', { headers: H })).json();
  const build = (runs.workflow_runs || []).find((w) => w.name === 'build' && w.head_branch === 'v4.1.5');
  const jobs = await (await fetch(BASE + '/actions/runs/' + build.id + '/jobs', { headers: H })).json();
  const andr = (jobs.jobs || []).find((j) => j.name === 'android');
  const id = andr.check_run_url.split('/').pop();
  const ann = await (await fetch(BASE + '/check-runs/' + id + '/annotations?per_page=100', { headers: H })).json();
  // 打印含 validate library 的完整消息
  ann.filter((x) => /validate library|runtime symbols/.test(String(x.message))).slice(0, 3).forEach((x) => {
    console.log('---- 完整注解 ----');
    console.log(String(x.message).replace(/\u001b\[[0-9;]*m/g, ''));
  });
  // 也看看有没有 cargo/ndk 相关的行
  console.log('\n---- 含 cargo/ndk/ABI 的行 ----');
  ann.filter((x) => /cargo|ndk|ABI|abi|target/i.test(String(x.message))).slice(0, 8).forEach((x) => {
    console.log('  · ' + String(x.message).replace(/\u001b\[[0-9;]*m/g, '').slice(0, 300));
  });
})().catch((e) => { console.error('失败: ' + e.message); process.exit(1); });
