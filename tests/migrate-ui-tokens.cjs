/*!
 * tests/migrate-ui-tokens.cjs — 把界面里的裸值迁到设计 token
 *
 *   依据 `docs/17-UI设计规范调研.md`：**从尺度选值，不要临时拍**。
 *   审计实测：21 种字号（14 种不在尺度上）、22 种间距、13 种圆角、53 种硬编码颜色。
 *
 *   映射规则（就近取整，平局向上 —— 宁可大一点也别小到看不清）：
 *     字号  11→12 13→14 15→16 17→18 19→20 21→20 22→24 26→24 28→30 46→48 56→60 64→60
 *     间距  1/2/3/5/6/7/9/10→4 或 8（就近）；14→16 18→16 20→16 22→24 26→24 28/30→32 36→32
 *     圆角  7→8 9→8 10→8 11→12 14→12 16→16 18→16
 *
 *   node tests/migrate-ui-tokens.cjs [--dry]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const DRY = process.argv.includes('--dry');

function walk(dir, filter, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', '.git', 'target'].includes(e.name)) continue;
    const q = path.join(dir, e.name);
    if (e.isDirectory()) walk(q, filter, acc);
    else if (filter(e.name)) acc.push(q);
  }
  return acc;
}
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');

/* ---------- 映射表 ---------- */
const FS_MAP = {
  11: '--fs-xs', 12: '--fs-xs', 13: '--fs-sm', 14: '--fs-sm', 15: '--fs-base', 16: '--fs-base',
  17: '--fs-lg', 18: '--fs-lg', 19: '--fs-xl', 20: '--fs-xl', 21: '--fs-xl', 22: '--fs-2xl',
  24: '--fs-2xl', 26: '--fs-2xl', 28: '--fs-3xl', 30: '--fs-3xl', 36: '--fs-4xl',
  46: '--fs-5xl', 48: '--fs-5xl', 56: '--fs-6xl', 60: '--fs-6xl', 64: '--fs-6xl', 72: '--fs-7xl'
};
const SP_MAP = {
  1: '--sp-1', 2: '--sp-1', 3: '--sp-1', 4: '--sp-1', 5: '--sp-1', 6: '--sp-2', 7: '--sp-2',
  8: '--sp-2', 9: '--sp-2', 10: '--sp-2', 12: '--sp-3', 14: '--sp-4', 16: '--sp-4', 18: '--sp-4',
  20: '--sp-4', 22: '--sp-5', 24: '--sp-5', 26: '--sp-5', 28: '--sp-6', 30: '--sp-6',
  32: '--sp-6', 36: '--sp-6', 48: '--sp-7', 64: '--sp-8'
};
const RADIUS_MAP = {
  2: '--radius-sm', 4: '--radius-sm', 6: '--radius', 7: '--radius', 8: '--radius',
  9: '--radius', 10: '--radius', 11: '--radius-lg', 12: '--radius-lg', 14: '--radius-lg',
  16: '--radius-lg', 18: '--radius-lg'
};

const files = [
  ...walk(path.join(ROOT, 'web/src'), (n) => n.endsWith('.vue')),
  ...walk(path.join(ROOT, 'web/src'), (n) => n.endsWith('.css') && n !== 'tokens.css')
];

let changedFiles = 0;
const stats = { fs: 0, sp: 0, radius: 0 };

for (const f of files) {
  const before = fs.readFileSync(f, 'utf8');
  let t = before;

  // 字号：font-size: 13px  →  font-size: var(--fs-sm)
  t = t.replace(/font-size:\s*(\d+(?:\.\d+)?)px/g, (m, n) => {
    const v = FS_MAP[Math.round(parseFloat(n))];
    if (!v) return m;
    stats.fs += 1;
    return 'font-size: var(' + v + ')';
  });

  // 间距：padding/margin/gap 的 px 值（逐段替换）
  t = t.replace(/((?:padding|margin|gap|row-gap|column-gap)(?:-[a-z]+)?:\s*)([^;{}\n]+)/g, (m, prop, val) => {
    const out = val.replace(/(\d+(?:\.\d+)?)px/g, (mm, n) => {
      const v = SP_MAP[Math.round(parseFloat(n))];
      if (!v) return mm;
      stats.sp += 1;
      return 'var(' + v + ')';
    });
    return prop + out;
  });

  // 圆角：border-radius: 10px → var(--radius)
  t = t.replace(/border-radius:\s*(\d+(?:\.\d+)?)px/g, (m, n) => {
    const v = RADIUS_MAP[Math.round(parseFloat(n))];
    if (!v) return m;
    stats.radius += 1;
    return 'border-radius: var(' + v + ')';
  });

  if (t !== before) {
    changedFiles += 1;
    if (!DRY) fs.writeFileSync(f, t, 'utf8');
  }
}

console.log('=== UI token 迁移' + (DRY ? '（试运行）' : '') + ' ===');
console.log('  文件 ' + changedFiles + ' / ' + files.length);
console.log('  字号替换 ' + stats.fs + ' 处、间距 ' + stats.sp + ' 处、圆角 ' + stats.radius + ' 处');
console.log('  合计 ' + (stats.fs + stats.sp + stats.radius) + ' 处裸值 → token');
