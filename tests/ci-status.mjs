/*!
 * tests/ci-status.mjs — 查看 GitHub Actions 最新运行结果（含失败注解）
 *   node tests/ci-status.mjs            # 打印最近 6 次运行与失败的注解
 *   node tests/ci-status.mjs --wait     # 等到有结论为止（最多 25 分钟）
 *
 * 为什么需要：Actions 的**作业日志**要凭据才能读，而 check-run 的**注解**是公开可读的；
 * 所以工作流里把编译错误写成了 ::error:: 注解，这个脚本就是用来看它们的。
 */
const API = 'https://api.github.com/repos/JuLuogo/luchenxi';
const H = { 'User-Agent': 'luchenxi-ci-status', Accept: 'application/vnd.github+json' };
const WAIT = process.argv.includes('--wait');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(url) {
  const r = await fetch(url, { headers: H });
  if (!r.ok) throw new Error(url + ' → HTTP ' + r.status);
  return r.json();
}

async function snapshot() {
  const runs = await api(API + '/actions/runs?per_page=6');
  return runs.workflow_runs;
}

(async () => {
  let runs = await snapshot();
  if (WAIT) {
    const deadline = Date.now() + 25 * 60 * 1000;
    for (;;) {
      const pending = runs.filter((r) => r.status !== 'completed');
      if (!pending.length) break;
      if (Date.now() > deadline) { console.log('（等待超时，仍有未完成的运行）'); break; }
      console.log('等待中… 未完成 ' + pending.length + ' 个：' + pending.map((r) => r.name).join('、'));
      await sleep(30000);
      runs = await snapshot();
    }
  }

  console.log('\n=== 最近运行 ===');
  runs.forEach((r) => {
    const icon = r.conclusion === 'success' ? '✅' : (r.conclusion === 'failure' ? '❌' : '⏳');
    console.log('  ' + icon + ' ' + String(r.name).padEnd(7) + ' ' + String(r.head_branch || '').padEnd(8) +
      ' ' + String(r.status).padEnd(12) + String(r.conclusion || '-') + '  ' + r.created_at);
  });

  // 失败运行的注解（含工作流里 ::error:: 输出的真实错误）
  for (const run of runs.filter((r) => r.conclusion === 'failure')) {
    const jobs = await api(run.jobs_url);
    const failed = jobs.jobs.filter((j) => j.conclusion === 'failure');
    console.log('\n--- ' + run.name + '（' + (run.head_branch || '') + '）失败作业 ' + failed.length + ' 个 ---');
    for (const job of failed) {
      const steps = (job.steps || []).filter((s) => s.conclusion === 'failure').map((s) => s.name);
      console.log('  • ' + job.name + '  失败步骤: ' + (steps.join(' / ') || '-'));
    }
    const sha = run.head_sha;
    const checks = await api(API + '/commits/' + sha + '/check-runs?per_page=50').catch(() => null);
    if (checks) {
      for (const cr of checks.check_runs) {
        if (cr.conclusion !== 'failure') continue;
        const ann = await api(cr.url + '/annotations').catch(() => []);
        const errs = (ann || []).filter((a) => a.annotation_level === 'failure');
        if (!errs.length) continue;
        console.log('\n  ▶ ' + cr.name + ' 的错误注解：');
        errs.slice(0, 14).forEach((a) => console.log('     ' + String(a.message).replace(/\n/g, ' ').slice(0, 300)));
      }
    }
  }
})().catch((e) => { console.error('查询失败：' + e.message); process.exit(1); });
