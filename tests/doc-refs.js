/*!
 * tests/doc-refs.js — 文档行号引用审计工具
 *   node tests/doc-refs.js            列出所有 文件:行号 引用及其对应的真实代码行
 *   node tests/doc-refs.js --broken   只列出"该行看起来不像被引用的东西"的可疑项（启发式）
 *
 * 用途：代码改动后快速定位文档里失效的行号引用（docs/*.md 中的 `path:123` 写法）。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');
const onlyBroken = process.argv.includes('--broken');

const cache = new Map();
function lines(rel) {
  if (cache.has(rel)) return cache.get(rel);
  const abs = path.join(ROOT, rel);
  let arr = null;
  try { arr = fs.readFileSync(abs, 'utf8').split(/\r?\n/); } catch (e) { arr = null; }
  cache.set(rel, arr);
  return arr;
}

const files = fs.readdirSync(DOCS).filter((f) => f.endsWith('.md')).sort();
let total = 0, broken = 0, outOfRange = 0;
const rows = [];

for (const f of files) {
  const text = fs.readFileSync(path.join(DOCS, f), 'utf8');
  const textLines = text.split(/\r?\n/);
  // 形如 assets/js/store.js:123  或  store.js:123（简写：同篇内可能只写文件名）
  const re = /([A-Za-z0-9_\-./]+\.(?:js|html|css|json|cmd))(?::(\d+))(?:[-–](\d+))?/g;
  textLines.forEach((lineText, idx) => {
    let m;
    while ((m = re.exec(lineText))) {
      const rawPath = m[1];
      const start = Number(m[2]);
      const end = m[3] ? Number(m[3]) : start;
      let rel = rawPath.replace(/^\.\//, '');
      if (!rel.includes('/')) {
        if (fs.existsSync(path.join(ROOT, 'assets', 'js', rel))) rel = 'assets/js/' + rel;
        else if (fs.existsSync(path.join(ROOT, rel))) rel = rel;
      }
      total++;
      const arr = lines(rel);
      if (!arr) {
        broken++;
        rows.push({ doc: f, docLine: idx + 1, ref: rawPath + ':' + start, code: '(文件不存在)', bad: true });
        continue;
      }
      if (start > arr.length) {
        outOfRange++;
        rows.push({ doc: f, docLine: idx + 1, ref: rel + ':' + start, code: '(超出文件行数 ' + arr.length + ')', bad: true });
        continue;
      }
      const code = arr.slice(start - 1, Math.min(end, arr.length)).join(' ⏎ ').trim();
      rows.push({ doc: f, docLine: idx + 1, ref: rel + ':' + start + (end !== start ? ('-' + end) : ''), code: code, bad: false });
    }
  });
}

const list = onlyBroken ? rows.filter((r) => r.bad) : rows;
list.forEach((r) => {
  console.log((r.bad ? '✗ ' : '  ') + r.doc + ':' + r.docLine + '  →  ' + r.ref + '   ' + r.code.slice(0, 120));
});
console.log('\n共 ' + total + ' 处行号引用（越界/缺文件 ' + outOfRange + ' + ' + broken + '）');
if (onlyBroken && !list.length) console.log('✅ 所有引用的文件与行号都存在（语义是否正确仍需人工/子代理核对）');
