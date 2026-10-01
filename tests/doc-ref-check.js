/*!
 * tests/doc-ref-check.js — 对照代码复核文档里的行号引用（打印"引用 vs 真实代码行"）
 *   node tests/doc-ref-check.js                 # 复核全部（sync.js / classroom.js / store.js 等）
 *   node tests/doc-ref-check.js classroom.js    # 只看某个文件
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');
const only = process.argv[2] || '';
const cache = new Map();

function codeLines(rel) {
  if (!cache.has(rel)) {
    try { cache.set(rel, fs.readFileSync(path.join(ROOT, rel), 'utf8').split(/\r?\n/)); }
    catch (e) { cache.set(rel, null); }
  }
  return cache.get(rel);
}

let total = 0;
for (const f of fs.readdirSync(DOCS).filter((x) => x.endsWith('.md')).sort()) {
  const lines = fs.readFileSync(path.join(DOCS, f), 'utf8').split(/\r?\n/);
  lines.forEach((text, i) => {
    const re = /([A-Za-z0-9_\-./]+\.(?:js|html|css)):(\d+)(?:[-–](\d+))?/g;
    let m;
    const hits = [];
    while ((m = re.exec(text))) {
      if (only && m[1].indexOf(only) < 0) continue;
      let rel = m[1].replace(/^\.\//, '');
      if (!rel.includes('/')) {
        if (fs.existsSync(path.join(ROOT, 'assets', 'js', rel))) rel = 'assets/js/' + rel;
      }
      const arr = codeLines(rel);
      const start = Number(m[2]);
      total++;
      hits.push({
        ref: rel + ':' + m[2] + (m[3] ? '-' + m[3] : ''),
        code: arr ? ((arr[start - 1] || '(超出行数)').trim().slice(0, 78)) : '(文件不存在)'
      });
    }
    if (hits.length) {
      console.log('--- ' + f + ':' + (i + 1));
      console.log('    文档：' + text.trim().slice(0, 118));
      hits.forEach((h) => console.log('    ' + h.ref.padEnd(34) + ' => ' + h.code));
    }
  });
}
console.log('\n共检查 ' + total + ' 处引用');
