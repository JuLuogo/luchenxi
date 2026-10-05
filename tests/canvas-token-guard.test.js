/*!
 * tests/canvas-token-guard.test.js — 守卫：图表配置里不许出现 CSS 变量
 *
 *   背景（真实踩过）：颜色迁移时把 **ECharts 配置**里的颜色换成了 `var(--c-brand)`，
 *   而 ECharts 用 **canvas** 渲染，**解析不了 CSS 变量** → 雷达图渲染成黑白扭曲图形。
 *   靠截图才发现 —— 这个错误不会让任何测试变红。
 *
 *   守卫做法：扫 `.vue` 的 **script 段**，凡是出现在图表相关对象里的 `var(--…)` 就报错。
 *   （`:style` 绑定与 `<style>` 里的 var() 是**对的**，DOM 能解析，不查。）
 *
 *   node tests/canvas-token-guard.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
let passed = 0;
const failures = [];
const ok = (cond, label) => { if (cond) passed++; else failures.push(label); };

function walk(dir, filter, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', '.git'].includes(e.name)) continue;
    const q = path.join(dir, e.name);
    if (e.isDirectory()) walk(q, filter, acc);
    else if (filter(e.name)) acc.push(q);
  }
  return acc;
}

/** 图表库的配置关键字：出现这些说明这段是给 canvas 用的 */
const CHART_KEYS = [
  'itemStyle', 'lineStyle', 'areaStyle', 'axisName', 'axisLine', 'splitLine', 'splitArea',
  'textStyle', 'labelLine', 'axisLabel', 'emphasis', 'series', 'radar:', 'xAxis', 'yAxis',
  'legend:', 'tooltip:', 'grid:', 'dataZoom', 'markLine', 'markPoint'
];

const files = walk(path.join(ROOT, 'web/src'), (x) => x.endsWith('.vue'));
const hits = [];
for (const f of files) {
  const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
  const s = lines.findIndex((l) => /^<script/.test(l));
  const e = lines.findIndex((l) => /^<\/script>/.test(l));
  if (s < 0 || e < 0) continue;
  for (let i = s; i < e; i++) {
    const line = lines[i];
    if (/^\s*(\/\/|\*)/.test(line)) continue;          // 注释不算
    if (!/var\(--/.test(line)) continue;
    // 判断这一行是不是图表配置（本行或前 12 行里出现图表关键字）
    const ctx = lines.slice(Math.max(s, i - 12), i + 1).join('\n');
    const isChart = CHART_KEYS.some((k) => ctx.includes(k));
    // `:style` 绑定与 CSS 字符串不算（DOM 能解析）
    const isStyleBinding = /:style=|style=\{|\.style\./.test(line);
    if (isChart && !isStyleBinding) {
      hits.push({ f: f.replace(/\\/g, '/').replace(/.*web\/src\//, ''), line: i + 1, text: line.trim().slice(0, 90) });
    }
  }
}

ok(hits.length === 0, '图表配置里没有 CSS 变量（canvas 解析不了，会渲染成黑白）');
hits.forEach((h) => console.log('     · ' + h.f + ':' + h.line + '  ' + h.text));

/* 反向确认：守卫本身有效（拿一个已知错误写法试一下） */
{
  const probe = "itemStyle: { color: 'var(--c-brand)' },";
  const isChart = CHART_KEYS.some((k) => probe.includes(k));
  ok(isChart && /var\(--/.test(probe), '守卫对已知错误写法有效（itemStyle 里的 var() 会被抓到）');
}

console.log('\n----------------------------------------');
console.log('  扫描 ' + files.length + ' 个 .vue 的 script 段');
if (failures.length) {
  console.log('❌ 失败 ' + failures.length + ' 项 / 通过 ' + passed + ' 项');
  failures.forEach((f, i) => console.log('  ' + (i + 1) + '. ' + f));
  console.log('\n  修法：图表配置里用 token(\'--c-brand\')（见 web/src/styles/token-value.ts）');
  process.exit(1);
}
console.log('✅ 全部通过：' + passed + ' 项断言（图表颜色守卫）');
