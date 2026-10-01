/*!
 * scripts/ci-summary.mjs — 把 CI 各步骤结论写进 GitHub Job Summary
 *
 *   node scripts/ci-summary.mjs        # 读取 ci-local.mjs 写下的 ci-result.json，输出 Markdown 摘要
 *
 * 为什么需要：Actions 的**作业日志**要授权才能读，而 Job Summary 在公开仓库的
 * 运行页面上直接可见；注解（::error::）只能带很短的文本，摘要可以写完整的失败输出。
 * ci-local.mjs 会把每一步的结论与失败输出落到 ci-result.json，这里负责渲染。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RESULT = path.join(ROOT, 'ci-result.json');
const OUT = process.env.GITHUB_STEP_SUMMARY;

function esc(s) {
  return String(s || '').replace(/\r/g, '').slice(0, 4000);
}

let md = '## CI 结果\n\n';
if (!fs.existsSync(RESULT)) {
  md += '> 没有找到 `ci-result.json`（可能 CI 在写它之前就中断了）。\n\n';
  md += '常见原因：依赖安装失败、Node 版本不对、脚本本身语法错误。\n';
} else {
  const r = JSON.parse(fs.readFileSync(RESULT, 'utf8'));
  const failed = r.steps.filter((s) => !s.pass);
  md += `共 ${r.steps.length} 步，**失败 ${failed.length} 步**（本地 Node ${r.node}，用时 ${(r.ms / 1000).toFixed(0)}s）\n\n`;
  md += '| 步骤 | 结论 | 用时 |\n| --- | --- | --- |\n';
  r.steps.forEach((s) => {
    md += `| ${s.title} | ${s.pass ? '✅' : '❌'} | ${(s.ms / 1000).toFixed(1)}s |\n`;
  });
  failed.forEach((s) => {
    md += `\n### ❌ ${s.title}\n\n\`\`\`\n${esc(s.tail || '（没有捕获到输出）')}\n\`\`\`\n`;
  });
  if (!failed.length) md += '\n全部通过 ✅\n';
}

if (OUT) {
  fs.appendFileSync(OUT, md + '\n', 'utf8');
  console.log('已写入 Job Summary（' + md.length + ' 字符）');
} else {
  console.log(md);
}
