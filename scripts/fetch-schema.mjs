/*!
 * scripts/fetch-schema.mjs — 下载官方 schema 并入库（供离线校验）
 *
 *  目前两份：
 *   ① packages/schema/tauri-config.schema.json      —— Tauri v2 客户端配置
 *   ② packages/schema/github-workflow.schema.json   —— GitHub Actions 工作流
 *
 *  为什么入库：配置/工作流写错一个键名，本地没感觉，CI 一跑就失败（甚至**静默失效**——
 *  例如 `continue-on-error` 拼错，iOS 任务就会开始阻断发布）。入库后测试可离线校验。
 *
 *  用法：
 *    node scripts/fetch-schema.mjs            # 下载/刷新全部
 *    node scripts/fetch-schema.mjs --check    # 只检查本地是否齐全
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const TARGETS = [
  {
    out: 'packages/schema/tauri-config.schema.json',
    urls: ['https://schema.tauri.app/config/2', 'https://unpkg.com/@tauri-apps/cli@2/config.schema.json'],
    check: (j) => !!(j && j.properties && j.properties.bundle)
  },
  {
    out: 'packages/schema/github-workflow.schema.json',
    urls: ['https://json.schemastore.org/github-workflow.json',
      'https://raw.githubusercontent.com/SchemaStore/schemastore/master/src/schemas/json/github-workflow.json'],
    check: (j) => !!(j && j.properties && j.properties.jobs)
  }
];

if (process.argv.includes('--check')) {
  const missing = TARGETS.filter((t) => !fs.existsSync(path.join(ROOT, t.out)));
  if (!missing.length) {
    TARGETS.forEach((t) => {
      const size = fs.statSync(path.join(ROOT, t.out)).size;
      console.log('[ok] ' + t.out + '（' + Math.round(size / 1024) + ' KB）');
    });
    process.exit(0);
  }
  missing.forEach((t) => console.error('[missing] ' + t.out));
  console.error('运行 node scripts/fetch-schema.mjs 重新下载');
  process.exit(1);
}

let failed = 0;
for (const target of TARGETS) {
  const out = path.join(ROOT, target.out);
  let done = false;
  for (const url of target.urls) {
    try {
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const text = await res.text();
      const json = JSON.parse(text);
      if (!target.check(json)) throw new Error('不是预期的 schema 结构');
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, text, 'utf8');
      console.log('[write] ' + target.out + '（' + Math.round(text.length / 1024) + ' KB，来源 ' + url + '）');
      if (target.out.indexOf('tauri') >= 0) {
        console.log('        顶层可配置项：' + Object.keys(json.properties).join(', '));
      }
      done = true;
      break;
    } catch (e) {
      console.log('[fail] ' + url + ' → ' + (e.cause && e.cause.message ? e.cause.message : e.message));
    }
  }
  if (!done) {
    failed++;
    console.error('[error] ' + target.out + ' 全部来源失败；离线环境可手动下载后放入该路径');
  }
}
process.exit(failed ? 1 : 0);
