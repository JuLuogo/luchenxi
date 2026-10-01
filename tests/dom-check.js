/*!
 * tests/dom-check.js — 静态接线自检（Node 运行，不需要浏览器）
 *   node tests/dom-check.js
 * 检查项：
 *   1. admin.html 引用的 css/js 文件都存在
 *   2. 所有 el('id') / getElementById('id') 的 id 都能在 admin.html 或 JS 动态模板中找到
 *   3. admin.html 中的 id 不重复
 *   4. 所有 onclick 等内联事件里的 CI.模块.方法 都真实存在
 *   5. 脚本加载顺序正确（store 最前、admin 最后）
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HTML = path.join(ROOT, 'admin.html');
const JS_DIR = path.join(ROOT, 'assets', 'js');

/* ---------- Node 环境下加载全部模块（document 不存在，UI 模块只注册不渲染） ---------- */
const map = new Map();
globalThis.localStorage = {
  getItem: (k) => (map.has(k) ? map.get(k) : null),
  setItem: (k, v) => map.set(k, String(v)),
  removeItem: (k) => map.delete(k)
};
const JS_FILES = fs.readdirSync(JS_DIR).filter((f) => f.endsWith('.js')).sort();
JS_FILES.forEach((f) => require(path.join(JS_DIR, f)));
const CI = globalThis.CI;

/* ---------- 读取文件 ---------- */
const html = fs.readFileSync(HTML, 'utf8');
const STUDENT_HTML = path.join(ROOT, 'student.html');
const studentHtml = fs.existsSync(STUDENT_HTML) ? fs.readFileSync(STUDENT_HTML, 'utf8') : '';
const jsSources = JS_FILES.map((f) => ({ file: f, code: fs.readFileSync(path.join(JS_DIR, f), 'utf8') }));
const allCode = html + '\n' + studentHtml + '\n' + jsSources.map((s) => s.code).join('\n');

const problems = [];
const notes = [];

/* ---------- 1. 资源引用 ---------- */
const refs = [];
html.replace(/<script[^>]+src=["']([^"']+)["']/g, (m, src) => { refs.push(src); return m; });
html.replace(/<link[^>]+href=["']([^"']+)["']/g, (m, href) => { refs.push(href); return m; });
refs.forEach((r) => {
  if (/^(https?:|data:|mailto:|tel:|#|\/\/)/i.test(r)) return;   // 外链与内联数据 URI 不检查
  const p = path.join(ROOT, r);
  if (!fs.existsSync(p)) problems.push(`资源文件不存在：${r}`);
});

/* ---------- 2. id 收集 ---------- */
const staticIds = new Set();
html.replace(/id=["']([A-Za-z0-9_-]+)["']/g, (m, id) => { staticIds.add(id); return m; });

// student.html 的静态 id 同样纳入检查（学生端用自己的 $() 取元素）
studentHtml.replace(/id=["']([A-Za-z0-9_-]+)["']/g, (m, id) => { staticIds.add(id); return m; });

const dynamicIds = new Set();
jsSources.forEach(({ code }) => {
  code.replace(/id=\\?["']([A-Za-z0-9_-]+)\\?["']/g, (m, id) => { dynamicIds.add(id); return m; });
});

const knownIds = new Set([...staticIds, ...dynamicIds]);

const usedIds = new Map();
jsSources.forEach(({ file, code }) => {
  const re = /(?:el|getElementById)\(\s*['"]([A-Za-z0-9_-]+)['"]/g;
  let m;
  while ((m = re.exec(code))) {
    if (!usedIds.has(m[1])) usedIds.set(m[1], file);
  }
});
usedIds.forEach((file, id) => {
  if (!knownIds.has(id)) problems.push(`脚本引用了不存在的元素 id="${id}"（${file}）`);
});

/* ---------- 3. 静态 id 重复 ---------- */
const seen = new Set();
html.replace(/id=["']([A-Za-z0-9_-]+)["']/g, (m, id) => {
  if (seen.has(id)) problems.push(`admin.html 中 id 重复：${id}`);
  seen.add(id);
  return m;
});

/* ---------- 4. CI 调用路径存在性 ---------- */
function resolve(pathStr) {
  const parts = pathStr.split('.');
  let cur = CI;
  for (const p of parts) {
    if (cur === undefined || cur === null) return undefined;
    cur = cur[p];
  }
  return cur;
}
const callRe = /CI\.([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)/g;
const checked = new Set();
let mm;
while ((mm = callRe.exec(allCode))) {
  const full = mm[1] + '.' + mm[2];
  if (checked.has(full)) continue;
  checked.add(full);
  const fn = resolve(full);
  if (fn === undefined) problems.push(`内联调用指向不存在的接口：CI.${full}`);
  else if (fn === null) problems.push(`CI.${full} 为 null`);
}

/* ---------- 4b. 学生端 CIStudent.* 调用 ---------- */
const studentPath = path.join(ROOT, 'student.html');
let studentChecked = 0;
if (fs.existsSync(studentPath)) {
  const studentCode = fs.readFileSync(studentPath, 'utf8') + '\n' + fs.readFileSync(path.join(JS_DIR, 'student.js'), 'utf8');
  const stuRe = /CIStudent\.([A-Za-z0-9_]+)/g;
  const seenStu = new Set();
  let sm;
  while ((sm = stuRe.exec(studentCode))) {
    if (seenStu.has(sm[1])) continue;
    seenStu.add(sm[1]);
    studentChecked++;
    if (globalThis.CIStudent === undefined || globalThis.CIStudent[sm[1]] === undefined) {
      problems.push(`student.html/student.js 调用了不存在的 CIStudent.${sm[1]}`);
    }
  }
}
notes.push(`学生端接口调用 ${studentChecked} 个`);

/* ---------- 5. 脚本顺序 ---------- */
const order = [];
html.replace(/<script[^>]+src=["'][^"']*\/js\/([^"']+)["']/g, (m, f) => { order.push(f); return m; });
if (order[0] !== 'store.js') problems.push('store.js 必须第一个加载，实际顺序：' + order.join(' → '));
if (order[order.length - 1] !== 'admin.js') problems.push('admin.js 必须最后加载，实际顺序：' + order.join(' → '));
if (order.indexOf('analysis.js') > order.indexOf('sync.js')) problems.push('analysis.js 应在 sync.js 之前加载（sync 依赖统计）');

/* ---------- 6. 覆盖率提示 ---------- */
notes.push(`admin.html 静态 id ${staticIds.size} 个，JS 动态 id ${dynamicIds.size} 个`);
notes.push(`脚本引用元素 ${usedIds.size} 个，内联接口调用 ${checked.size} 个`);
notes.push(`加载顺序：${order.join(' → ')}`);

/* ---------- 输出 ---------- */
console.log('== 静态接线自检 ==');
notes.forEach((n) => console.log('  · ' + n));
if (problems.length) {
  console.log(`\n❌ 发现 ${problems.length} 个问题：`);
  problems.forEach((p, i) => console.log(`  ${i + 1}. ${p}`));
  process.exit(1);
}
console.log('\n✅ 接线检查通过：资源引用、元素 id、接口调用、脚本顺序均正常');
