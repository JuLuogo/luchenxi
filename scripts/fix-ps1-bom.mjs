/*!
 * scripts/fix-ps1-bom.mjs — 给 .ps1 补 UTF-8 BOM
 *
 *   node scripts/fix-ps1-bom.mjs            # 检查并补 BOM（scripts/ 下所有 .ps1）
 *   node scripts/fix-ps1-bom.mjs --check    # 只检查，不写入（CI 用）
 *
 * 为什么需要：Windows PowerShell 5.1 读取**没有 BOM** 的 .ps1 时会按系统 ANSI（简体中文
 * 环境即 GBK）解码，脚本里的中文会变成乱码，甚至因为引号/括号被吃掉而报"意外的标记"。
 * 编辑器（含各种自动化改写）经常把 BOM 丢掉，所以这里做成可重复执行的小工具。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHECK = process.argv.includes('--check');
const dirs = ['scripts', 'tests', '.'];
const files = [];
for (const d of dirs) {
  const full = path.join(ROOT, d);
  if (!fs.existsSync(full)) continue;
  for (const e of fs.readdirSync(full, { withFileTypes: true })) {
    if (e.isFile() && e.name.toLowerCase().endsWith('.ps1')) files.push(path.join(full, e.name));
  }
}

let fixed = 0;
let bad = 0;
for (const f of [...new Set(files)]) {
  const buf = fs.readFileSync(f);
  const hasBom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  const text = buf.toString('utf8').replace(/^\uFEFF/, '');
  const hasNonAscii = /[^\x00-\x7F]/.test(text);
  const rel = path.relative(ROOT, f).replace(/\\/g, '/');
  if (hasBom) { console.log('  ✔ ' + rel + ' 已有 BOM'); continue; }
  if (!hasNonAscii) { console.log('  ○ ' + rel + ' 纯 ASCII，无需 BOM'); continue; }
  if (CHECK) { console.log('  ✘ ' + rel + ' 缺少 BOM（含中文，PowerShell 5.1 会乱码）'); bad++; continue; }
  fs.writeFileSync(f, '\uFEFF' + text, 'utf8');
  console.log('  ✎ ' + rel + ' 已补 BOM');
  fixed++;
}

if (CHECK) {
  console.log(bad ? '\n❌ ' + bad + ' 个 .ps1 缺 BOM' : '\n✅ 所有含中文的 .ps1 都有 BOM');
  process.exit(bad ? 1 : 0);
}
console.log('\n完成：补了 ' + fixed + ' 个文件。');
