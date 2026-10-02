/*!
 * scripts/vue-type-boundary.mjs — 给转 TS 的组件按统一约定标注边界类型
 *
 *   node scripts/vue-type-boundary.mjs web/src/teacher/pages/Dashboard.vue [更多文件…]
 *
 * 约定：领域层（assets/js/*）还没类型，边界处一律 any；组件自己的逻辑照常受检查。
 * 等对应能力迁到 Rust 后，再把这些 any 收紧成 specta 生成的类型。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const files = process.argv.slice(2);
if (!files.length) {
  console.log('  用法: node scripts/vue-type-boundary.mjs <文件…>');
  process.exit(1);
}

/** 边界规则：左边是"未标注类型的写法"，右边是按约定补上类型的写法 */
const RULES = [
  [/\bref\(null\)/g, 'ref<any>(null)'],
  [/\bshallowRef\(null\)/g, 'shallowRef<any>(null)'],
  [/\bref\(\[\]\)/g, 'ref<any[]>([])'],
  [/\bref\(\{\}\)/g, 'ref<Record<string, any>>({})'],
  [/\bref\(\s*CI\.store\.get\(\)\s*\)/g, 'ref<any>(CI.store.get())'],
  // 连接类：显式可空标注（否则 TS 会把 null 推断成 never）
  [/\blet timer = null;/g, 'let timer: ReturnType<typeof setInterval> | null = null;'],
  [/\blet ws = null;/g, 'let ws: WebSocket | null = null;'],
  [/\blet off = null;/g, 'let off: (() => void) | null = null;'],
  [/\blet echarts = null;/g, 'let echarts: any = null;']
];

let total = 0;
for (const rel of files) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) {
    console.log('  · 不存在 ' + rel);
    continue;
  }
  const before = fs.readFileSync(p, 'utf8');
  let t = before;
  let n = 0;
  for (const [re, to] of RULES) {
    const m = t.match(re);
    if (m) {
      n += m.length;
      t = t.replace(re, to);
    }
  }
  if (t !== before) fs.writeFileSync(p, t, 'utf8');
  console.log('  [ok] ' + rel + '：' + n + ' 处边界标注');
  total += n;
}
console.log('  合计 ' + total + ' 处；下一步：npm run --prefix web typecheck');
