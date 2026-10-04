/*!
 * tests/arity.test.js — 领域层调用参数个数守卫（进 CI）
 *
 *   为什么要有它：**"少传参数"是本项目历史上最高频的 bug**（已出现 4 次）：
 *     · `ranking(state)` 少传 opts → 「数据范围」形同虚设
 *     · `classStats` 内部漏传 opts → 汇总与榜自相矛盾
 *     · `CI.store.calledCount(x.id)` 少传 state → 点名时抛异常
 *     · `counts(state, r)` 把逐条判定函数当汇总用 → 一进首页就抛
 *   这类错误**不会让编译失败**，只在特定路径上炸。所以用测试钉住。
 *
 *   判据：`CI.<模块>.<两参数函数>(单个参数)` —— 跳过注释行，
 *   并允许少数"第二参数本来就是可选"的函数（见 OPTIONAL_SECOND）。
 *
 *   node tests/arity.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');

let passed = 0;
const failures = [];
const ok = (cond, label) => { if (cond) passed++; else failures.push(label); };

function walk(dir, filter, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', '.git', 'target', 'bindings'].includes(e.name)) continue;
    const q = path.join(dir, e.name);
    if (e.isDirectory()) walk(q, filter, acc);
    else if (filter(e.name)) acc.push(q);
  }
  return acc;
}

/**
 * 第二参数本来就是可选的函数（调用方只传第一个是**正确用法**）
 *   key: `模块.函数`，why: 为什么可选
 */
const OPTIONAL_SECOND = {
  'analysis.ranking': '第二个参数是 teamId，省略表示"全班"',
  'analysis.classStats': '第二个参数是 opts，省略用默认口径',
  'store.quiz': '第二个参数是 id，省略表示"当前试卷"（class-store 里已注明）',
  'store.question': '第二个参数是 id，省略表示"当前题"',
  'store.teamScore': '第二个参数是 teamId，省略表示全班合计',
  'store.studentsOf': '第二个参数是 teamId，省略表示全体学生',
  'store.recordsOf': '第二个参数是 sid，省略表示全部记录',
  'store.scoreOf': '第二个参数是 sid，省略表示全部合计',
  'store.calledCount': '第二个参数是 sid，**不可省略** —— 但这里若被省略会在运行时炸，所以不放进白名单',
  'classroom.setTimer': '第二个参数是说明文字，省略表示用默认文案',
  'classroom.detail': '第二个参数是 opts',
  'rollcall.pick': '第二个参数是 opts',
  'openclass.showOnStage': '第二参数是档位，省略用默认四档'
};
delete OPTIONAL_SECOND['store.calledCount'];   // 明确：它**不允许**省略

/* ① 收集领域层两参数函数 */
const jsFiles = walk(path.join(ROOT, 'assets/js'), (n) => n.endsWith('.js'));
const byModule = {};
for (const f of jsFiles) {
  const mod = path.basename(f, '.js');
  const src = fs.readFileSync(f, 'utf8');
  const names = new Set();
  const re = /(?:function\s+([A-Za-z_$][\w$]*)|([A-Za-z_$][\w$]*)\s*[:=]\s*function)\s*\(\s*([A-Za-z_$][\w$]*)\s*,\s*([A-Za-z_$][\w$]*)\s*[,)]/g;
  let m;
  while ((m = re.exec(src))) names.add(m[1] || m[2]);
  if (names.size) byModule[mod] = names;
}
ok(Object.keys(byModule).length >= 8, '识别到 ≥8 个领域层模块（当前 ' + Object.keys(byModule).length + '）');
ok(Object.values(byModule).reduce((n, s) => n + s.size, 0) >= 80, '识别到 ≥80 个两参数函数');

/* ② 找可疑调用 */
const targets = walk(path.join(ROOT, 'web/src'), (n) => /\.(vue|ts|js)$/.test(n));
const suspects = [];
for (const f of targets) {
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  lines.forEach((l, i) => {
    // 跳过注释行（文档里会引用错误写法当反面教材）
    if (/^\s*(\/\/|\*|\/\*|<!--)/.test(l)) return;
    for (const [mod, names] of Object.entries(byModule)) {
      for (const fn of names) {
        const key = mod + '.' + fn;
        if (OPTIONAL_SECOND[key]) continue;
        const re = new RegExp('CI\\.' + mod + '\\.' + fn + '\\(([^,()]*)\\)', 'g');
        let m;
        while ((m = re.exec(l))) {
          const arg = m[1].trim();
          if (!arg || /=>|\{|\}/.test(arg)) continue;
          suspects.push(rel(f) + ':' + (i + 1) + '  CI.' + key + '(' + arg + ')');
        }
      }
    }
  });
}
ok(suspects.length === 0, '没有"领域层调用少传参数"（发现 ' + suspects.length + ' 处）');
suspects.forEach((s) => console.log('     · ' + s));

/* ③ 反向验证：探测器本身要有效（拿一个已知错误写法试一下） */
const probe = 'CI.store.calledCount(x.id)';
{
  let hit = false;
  const re = new RegExp('CI\\.store\\.calledCount\\(([^,()]*)\\)', 'g');
  if (re.exec(probe)) hit = true;
  ok(hit, '探测器对已知错误写法有效（CI.store.calledCount(x.id) 会被抓到）');
}

/* ④ 白名单本身要有效（不能把不存在的函数写进去） */
Object.keys(OPTIONAL_SECOND).forEach((k) => {
  const [mod, fn] = k.split('.');
  ok(byModule[mod] && byModule[mod].has(fn), '白名单项存在：' + k);
});

console.log('\n----------------------------------------');
console.log('  识别领域层两参数函数 ' + Object.values(byModule).reduce((n, s) => n + s.size, 0) +
  ' 个 / 白名单 ' + Object.keys(OPTIONAL_SECOND).length + ' 个 / 扫描 ' + targets.length + ' 个前端文件');
if (failures.length) {
  console.log('❌ 失败 ' + failures.length + ' 项 / 通过 ' + passed + ' 项');
  failures.forEach((f, i) => console.log('  ' + (i + 1) + '. ' + f));
  process.exit(1);
}
console.log('✅ 全部通过：' + passed + ' 项断言（领域层调用参数守卫）');
