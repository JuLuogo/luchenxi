/*!
 * scripts/sync-ui.mjs — 把仓库根目录的「网页版前端」同步到各客户端的 ui/ 目录
 *
 *  为什么这样做：网页版（admin.html / student.html / index.html + assets/）是零构建、可直接双击运行的
 *  单一来源；客户端（Tauri）只是把它"套壳"，因此构建前把同一份文件拷进 apps/<app>/ui/，
 *  由 tauri.conf.json 的 frontendDist 指向它。这样界面只有一份，改一次两边都生效。
 *
 * 用法：
 *   node scripts/sync-ui.mjs            # teacher + student
 *   node scripts/sync-ui.mjs teacher     # 只同步教师端
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 每个客户端需要哪些前端文件 */
const APPS = {
  teacher: {
    html: ['admin.html', 'index.html'],   // 教师端 + 内置大屏页
    assets: ['assets/css/app.css', 'assets/js'],
    out: 'apps/teacher/ui'
  },
  student: {
    html: ['student.html'],
    assets: ['assets/css/student.css', 'assets/js/student.js'],
    out: 'apps/student/ui'
  }
};

function copyFile(rel, destRoot) {
  const src = path.join(ROOT, rel);
  const dest = path.join(destRoot, rel);
  if (!fs.existsSync(src)) { console.warn('  ! 缺失 ' + rel); return 0; }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  return 1;
}

function copyDir(rel, destRoot) {
  const src = path.join(ROOT, rel);
  if (!fs.existsSync(src)) { console.warn('  ! 缺失目录 ' + rel); return 0; }
  let n = 0;
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const child = path.join(rel, entry.name);
    if (entry.isDirectory()) n += copyDir(child, destRoot);
    else n += copyFile(child, destRoot);
  }
  return n;
}

const want = process.argv[2];
const names = want ? [want] : Object.keys(APPS);
let total = 0;

for (const name of names) {
  const cfg = APPS[name];
  if (!cfg) { console.error('未知客户端：' + name); process.exit(1); }
  const out = path.join(ROOT, cfg.out);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  let n = 0;
  cfg.html.forEach((f) => { n += copyFile(f, out); });
  cfg.assets.forEach((a) => {
    const abs = path.join(ROOT, a);
    n += fs.statSync(abs).isDirectory() ? copyDir(a, out) : copyFile(a, out);
  });
  // Rust 侧需要同一份建表脚本（include_str! 只能引用 crate 目录内的文件）
  const rustSrc = path.join(ROOT, 'apps', name, 'src-tauri', 'src');
  if (fs.existsSync(rustSrc)) {
    fs.copyFileSync(path.join(ROOT, 'packages', 'db', 'schema.sql'), path.join(ROOT, 'apps', name, 'src-tauri', 'schema.sql'));
  // v5：建表脚本的消费方是 crates/ci-store（include_str! 相对 crate 根）
  fs.mkdirSync(path.join(ROOT, 'crates', 'ci-store'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'packages', 'db', 'schema.sql'), path.join(ROOT, 'crates', 'ci-store', 'schema.sql'));
    n++;
  }
  console.log('✔ ' + name + ' → ' + cfg.out + '（' + n + ' 个文件）');
  total += n;
}
console.log('共同步 ' + total + ' 个文件');
