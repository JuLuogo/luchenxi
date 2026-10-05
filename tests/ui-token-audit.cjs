/*!
 * tests/ui-token-audit.cjs — UI 机械化审计：把界面里实际用到的值数出来，对照尺度表
 *
 *   依据 `docs/17-UI设计规范调研.md`（Refactoring UI 的可执行化版本）：
 *     · 从尺度选值，不要临时拍 —— amateur UI 的头号成因是 17px 这种临时值
 *     · 字号只用 px/rem（**绝不用 em**）
 *     · 圆角选一个并保持一致
 *     · 阴影只有五个高度层
 *     · 间距取自 4/8/12/16/24/32/48/64/96/128/192/256
 *
 *   产出的是**数字**（"出现了 N 种字号，其中 M 种不在尺度上"），不是"我觉得丑"。
 *
 *   node tests/ui-token-audit.cjs [--detail]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const DETAIL = process.argv.includes('--detail');

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

/* 目标文件：三端界面 + 样式 */
const files = [
  ...walk(path.join(ROOT, 'web/src'), (n) => n.endsWith('.vue')),
  ...walk(path.join(ROOT, 'web/src'), (n) => n.endsWith('.css'))
];

/* ---------- 尺度 ---------- */
const SPACE = [4, 8, 12, 16, 24, 32, 48, 64, 96, 128, 192, 256];
const TYPE = [12, 14, 16, 18, 20, 24, 30, 36, 48, 60, 72];
const RADIUS_OK = [0, 2, 4, 6, 8, 12, 16, 999];   // 允许的圆角（999 = 胶囊）

const collect = (re, text) => {
  const out = [];
  let m;
  const r = new RegExp(re.source, 'g');
  while ((m = r.exec(text))) out.push({ value: m[1], raw: m[0] });
  return out;
};

const stats = {
  fontSize: new Map(),        // 值 → 次数
  fontSizeEm: [],             // 用 em 的字号（硬规则违反）
  spacing: new Map(),
  radius: new Map(),
  shadow: new Map(),
  hardcodedColor: new Map(),  // 非 var(--el-*) 的颜色
  transition: new Map()
};
const where = (map, key, file) => {
  if (!map.has(key)) map.set(key, { n: 0, files: new Set() });
  const e = map.get(key);
  e.n += 1;
  e.files.add(file);
};

for (const f of files) {
  const text = fs.readFileSync(f, 'utf8');
  const name = rel(f);

  // 字号
  for (const { value } of collect(/font-size:\s*([^;{}\n]+)/, text)) {
    const v = value.trim();
    if (/em\b/.test(v) && !/rem/.test(v)) { stats.fontSizeEm.push({ file: name, v }); continue; }
    // 只统计**字面 px 值**：var(--x) / clamp() 这类交给变量层管，别在这里拼出怪字符串
    const m2 = v.match(/^(\d+(?:\.\d+)?)px$/);
    if (m2) where(stats.fontSize, String(parseFloat(m2[1])), name);
    else if (/^var\(/.test(v) || /clamp\(|calc\(/.test(v)) where(stats.fontSize, '变量/表达式', name);
    else where(stats.fontSize, v, name);
  }
  // 间距（padding / margin / gap 里的 px）
  for (const { value } of collect(/(?:padding|margin|gap|row-gap|column-gap):\s*([^;{}\n]+)/, text)) {
    for (const part of value.split(/\s+/)) {
      const m = part.match(/^(\d+(?:\.\d+)?)px$/);
      if (m) where(stats.spacing, String(parseFloat(m[1])), name);
    }
  }
  // 圆角
  for (const { value } of collect(/border-radius:\s*([^;{}\n]+)/, text)) {
    const m = value.trim().match(/^(\d+(?:\.\d+)?)px/);
    if (m) where(stats.radius, String(parseFloat(m[1])), name);
    else if (/999|50%/.test(value)) where(stats.radius, '胶囊/圆形', name);
  }
  // 阴影
  for (const { value } of collect(/box-shadow:\s*([^;{}\n]+)/, text)) {
    if (/var\(/.test(value)) { where(stats.shadow, 'var(--el-*)', name); continue; }
    where(stats.shadow, value.trim().slice(0, 42), name);
  }
  // 硬编码颜色（hex / rgb，排除 var）
  for (const { value } of collect(/(?:color|background|background-color|border-color):\s*(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\))/, text)) {
    where(stats.hardcodedColor, value.trim(), name);
  }
  // 过渡
  for (const { value } of collect(/transition:\s*([^;{}\n]+)/, text)) {
    where(stats.transition, value.trim().slice(0, 40), name);
  }
}

/* ---------- 报告 ---------- */
const line = (s) => console.log(s);
const list = (map, okList, label) => {
  const entries = [...map.entries()].sort((a, b) => b[1].n - a[1].n);
  // 非数值键（变量/表达式/胶囊）不参与「是否在尺度上」的判定
  const off = entries.filter(([k]) => okList && /^[\d.]+$/.test(k) && !okList.includes(parseFloat(k)));
  line('  ' + label + '：' + entries.length + ' 种' + (okList ? '（不在尺度上 ' + off.length + ' 种）' : ''));
  line('    用到：' + entries.slice(0, 16).map(([k, v]) => k + '(' + v.n + ')').join(' '));
  if (okList && off.length) {
    line('    ❗ 不在尺度上：' + off.map(([k, v]) => k + 'px(' + v.n + '次)').join(' '));
    if (DETAIL) off.forEach(([k, v]) => line('       ' + k + 'px ← ' + [...v.files].slice(0, 4).join(', ')));
  }
  return { entries, off };
};

line('=== UI 值审计（' + files.length + ' 个文件：Vue + CSS）===');
line('');
line('【字号】推荐尺度 ' + TYPE.join('/'));
const fs1 = list(stats.fontSize, TYPE, 'font-size');
line('  ❗ 用 em 的字号（硬规则禁止，会随父级复合出 17.5px 这种值）：' + stats.fontSizeEm.length + ' 处');
if (stats.fontSizeEm.length) stats.fontSizeEm.slice(0, 8).forEach((x) => line('     ' + x.file + '  ' + x.v));
line('');
line('【间距】推荐尺度 ' + SPACE.join('/'));
list(stats.spacing, SPACE, 'padding/margin/gap 的 px');
line('');
line('【圆角】选一个并保持一致');
list(stats.radius, RADIUS_OK, 'border-radius');
line('');
line('【阴影】只有五个高度层');
list(stats.shadow, null, 'box-shadow');
line('');
line('【硬编码颜色】应尽量走 Element Plus 的 CSS 变量');
const colors = [...stats.hardcodedColor.entries()].sort((a, b) => b[1].n - a[1].n);
line('  ' + colors.length + ' 种：' + colors.slice(0, 14).map(([k, v]) => k + '(' + v.n + ')').join(' '));
if (DETAIL) colors.forEach(([k, v]) => line('     ' + k + ' ← ' + [...v.files].slice(0, 5).join(', ')));
line('');
line('【过渡】');
const tr = [...stats.transition.entries()].sort((a, b) => b[1].n - a[1].n);
line('  ' + tr.length + ' 种：' + tr.slice(0, 8).map(([k, v]) => k + '(' + v.n + ')').join(' '));
line('');
line('=== 结论 ===');
line('  字号 ' + fs1.entries.length + ' 种 / 间距 ' + stats.spacing.size + ' 种 / 圆角 ' + stats.radius.size +
  ' 种 / 阴影 ' + stats.shadow.size + ' 种 / 硬编码颜色 ' + colors.length + ' 种');
line('  规范目标：字号 ≤10 种且都在尺度上、间距 ≤12 种、圆角 1–2 种、阴影 ≤5 种、硬编码颜色趋近 0');
