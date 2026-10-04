/*!
 * scripts/sync-ui.mjs — 把 **Vue 构建产物**（web/dist）同步到各客户端的 ui/ 目录
 *
 *  为什么改（2026-10）：客户端原来拷的是仓库根目录那套**零构建旧界面**
 *  （admin.html / student.html / index.html + assets/），于是"新界面只在网页版生效、
 *  客户端还是旧脸" —— 这正是要消除的双界面分裂。
 *
 *  现在唯一来源是 `web/dist`（Vue 3 + Vite 构建），它有三个入口，**文件名与旧约定一致**
 *  （admin.html / student.html / index.html），且 Vite 的 `base: './'` 让资源引用是相对路径
 *  —— Tauri 的自定义协议（tauri://localhost）下也能直接加载，不需要改任何配置。
 *
 *  用法：
 *    node scripts/sync-ui.mjs            # teacher + student
 *    node scripts/sync-ui.mjs teacher     # 只同步教师端
 *    node scripts/sync-ui.mjs --build     # 先构建 Vue 再同步（CI 用这个）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'web', 'dist');

/** 每个客户端需要哪些前端文件（都来自 web/dist） */
const APPS = {
  teacher: {
    // 教师端 + 内置大屏页（index.html 就是大屏）
    html: ['admin.html', 'index.html'],
    out: 'apps/teacher/ui'
  },
  student: {
    html: ['student.html'],
    out: 'apps/student/ui'
  }
};

const args = process.argv.slice(2);
const doBuild = args.includes('--build');
const want = args.find((a) => !a.startsWith('-'));

/* ---------- 可选：先构建 Vue ---------- */
if (doBuild) {
  console.log('▶ 构建 Vue 界面（npm --prefix web run build）');
  const r = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['--prefix', 'web', 'run', 'build'], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32'
  });
  if (r.status !== 0) {
    console.error('✘ Vue 构建失败，未同步');
    process.exit(1);
  }
}

/* ---------- 构建产物必须在；不在就自动构建 ----------
 * 为什么自动构建：CI 的 test / rust 工作流只跑 `npm test` 与 `cargo test`，
 * 不会先跑前端构建 —— 而客户端资源（apps 下的 ui 目录，已 gitignore）与 crates/ci-store/schema.sql
 * 都由本脚本产出。让"少跑一步"变成硬失败没有意义，这里直接补上。
 * 前端依赖也没装时（CI 的干净环境）先装依赖，再构建。 */
const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const runNpm = (args, label) => {
  console.log('▶ ' + label);
  return spawnSync(npmBin, args, { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' }).status === 0;
};

if (!fs.existsSync(DIST)) {
  if (!fs.existsSync(path.join(ROOT, 'web', 'node_modules'))) {
    if (!runNpm(['install', '--prefix', 'web', '--no-audit', '--no-fund'], '前端依赖未安装，先 npm install --prefix web')) {
      console.error('✘ 前端依赖安装失败，未同步（手动排查：npm install --prefix web）');
      process.exit(1);
    }
  }
  if (!runNpm(['--prefix', 'web', 'run', 'build'], '构建 Vue 界面（npm --prefix web run build）') || !fs.existsSync(DIST)) {
    console.error('✘ Vue 构建失败，未同步（手动排查：npm --prefix web run build）');
    process.exit(1);
  }
}

function copyFile(rel, destRoot) {
  const src = path.join(DIST, rel);
  const dest = path.join(destRoot, rel);
  if (!fs.existsSync(src)) { console.warn('  ! 缺失 ' + rel); return 0; }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  return 1;
}

function copyDir(rel, destRoot) {
  const src = path.join(DIST, rel);
  if (!fs.existsSync(src)) { console.warn('  ! 缺失目录 ' + rel); return 0; }
  let n = 0;
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const child = path.join(rel, entry.name);
    if (entry.isDirectory()) n += copyDir(child, destRoot);
    else n += copyFile(child, destRoot);
  }
  return n;
}

const names = want ? [want] : Object.keys(APPS);
let total = 0;

for (const name of names) {
  const cfg = APPS[name];
  if (!cfg) { console.error('未知客户端：' + name); process.exit(1); }
  const out = path.join(ROOT, cfg.out);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });

  let n = 0;
  // 入口 html
  cfg.html.forEach((f) => { n += copyFile(f, out); });
  // 资源（Vite 产物：assets/ 目录 + favicon）
  n += copyDir('assets', out);
  n += copyFile('favicon.svg', out);

  // 入口自检：确认拷进来的 html 真的引用了 assets（否则说明构建产物不对）
  for (const f of cfg.html) {
    const p = path.join(out, f);
    if (!fs.existsSync(p)) { console.error('✘ 缺少入口 ' + p + '（web/dist 不完整）—— 客户端会打包出缺入口的空壳'); process.exit(1); }
    const html = fs.readFileSync(p, 'utf8');
    if (!html.includes('./assets/')) {
      console.error('✘ ' + cfg.out + '/' + f + ' 没有引用 ./assets/ —— 构建产物不对');
      process.exit(1);
    }
  }

  // Rust 侧需要同一份建表脚本（include_str! 只能引用 crate 目录内的文件）
  const rustSrc = path.join(ROOT, 'apps', name, 'src-tauri', 'src');
  if (fs.existsSync(rustSrc)) {
    fs.copyFileSync(path.join(ROOT, 'packages', 'db', 'schema.sql'), path.join(ROOT, 'apps', name, 'src-tauri', 'schema.sql'));
    // v5：建表脚本的消费方是 crates/ci-store（include_str! 相对 crate 根）
    fs.mkdirSync(path.join(ROOT, 'crates', 'ci-store'), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'packages', 'db', 'schema.sql'), path.join(ROOT, 'crates', 'ci-store', 'schema.sql'));
    n++;
  }
  console.log('✔ ' + name + ' → ' + cfg.out + '（' + n + ' 个文件，来源 web/dist）');
  total += n;
}
console.log('共同步 ' + total + ' 个文件');
