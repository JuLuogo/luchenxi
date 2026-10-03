/*!
 * tests/fix-legacy-docrefs.cjs — 把文档里指向**已删除旧界面文件**的行号引用改到 Vue 侧或去掉
 *
 *   旧：`assets/js/admin.js:579` / `admin.js:579`（文件已删）
 *   新：`web/src/teacher/（Vue 教师端各页面）`（不带行号 —— Vue 单文件组件行号易变，写行号只会持续腐烂）
 *
 *   node tests/fix-legacy-docrefs.cjs [--dry]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const DRY = process.argv.includes('--dry');

/** 旧文件（含仅文件名的写法）→ Vue 侧替代（写文件名，不写行号） */
const MAP = [
  ['assets/js/admin.js', 'web/src/teacher/（Vue 教师端各页面）'],
  ['assets/js/bank.js', 'web/src/teacher/pages/bank/（Vue 题库页）'],
  ['assets/js/quiz.js', 'web/src/teacher/pages/quiz/（Vue 组卷页）'],
  ['assets/js/analysis-ui.js', 'web/src/teacher/pages/AnalysisPage.vue（Vue 学情页）'],
  ['assets/css/app.css', 'web/src/styles/（Vue 样式）'],
  ['assets/css/student.css', 'web/src/student/styles/student.css'],
  // 仅文件名（文档里常这么写）
  ['admin.js', 'web/src/teacher/（Vue 教师端各页面）'],
  ['bank.js', 'web/src/teacher/pages/bank/（Vue 题库页）'],
  ['quiz.js', 'web/src/teacher/pages/quiz/（Vue 组卷页）'],
  ['analysis-ui.js', 'web/src/teacher/pages/AnalysisPage.vue（Vue 学情页）'],
  // 三个 HTML：只在"页面文件"语境下才算旧文件（`admin.html` 也可能是 Vue 入口名，故只改带行号的）
  ['admin.html', 'web/admin.html（Vite 模板）'],
  ['student.html', 'web/student.html（Vite 模板）'],
  ['index.html', 'web/index.html（Vite 模板）'],
  ['app.css', 'web/src/styles/（Vue 样式）'],
  ['student.css', 'web/src/student/styles/student.css']
];

const DOCS = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const q = path.join(d, e.name);
    if (e.isDirectory()) walk(q);
    else if (e.name.endsWith('.md')) DOCS.push(path.relative(ROOT, q).replace(/\\/g, '/'));
  }
})(path.join(ROOT, 'docs'));
DOCS.push('README.md');

let files = 0, refs = 0;
for (const rel of DOCS) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) continue;
  let t = fs.readFileSync(p, 'utf8');
  const before = t;
  for (const [dead, repl] of MAP) {
    const esc = dead.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // `路径:123` 或 `路径:123-130`（反引号可有可无）
    const re = new RegExp('`?' + esc + ':(\\d+)(?:[-–](\\d+))?`?', 'g');
    t = t.replace(re, () => { refs += 1; return repl; });
  }
  if (t !== before) {
    files += 1;
    if (!DRY) fs.writeFileSync(p, t, 'utf8');
    console.log('  ' + (DRY ? '[dry] ' : '[ok] ') + rel);
  }
}
console.log('\n  改了 ' + refs + ' 处行号引用，涉及 ' + files + ' 个文档');
