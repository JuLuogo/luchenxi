/*! 一次性：加"大屏不点名"断言 + 出 1024×768 大屏截图 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
let n = 0;

/* ① 断言：大屏源码里不许把 missers 的姓名渲染出来 */
{
  const p = path.join(ROOT, 'tests/logic.test.js');
  let t = fs.readFileSync(p, 'utf8');
  if (t.includes('大屏不点名')) { console.log('  · 已有断言'); }
  else {
    const EOL = t.includes('\r\n') ? '\r\n' : '\n';
    const anchor = '/* ================= 汇总 ================= */';
    const block = [
      "/* ================= 32. 大屏的隐私与适配（审计 Top 8 第 2 位） ================= */",
      "group('大屏不点名 + 投屏适配');",
      '',
      '/* 大屏是投在墙上的公共屏：个人排名与"谁没答对"都不该出现（实证研究：公开点名伤学生）。 */',
      'const stageSrc = fs.readFileSync(path.join(ROOT, \'web/src/stage/App.vue\'), \'utf8\');',
      "ok(!/q\\.missers\\.join/.test(stageSrc), '大屏不显示「谁没答对」的姓名（只显示人数）');",
      "ok(!/stu-rank|medal|前三名/.test(stageSrc) || !/v-for.*rank/.test(stageSrc), '大屏没有公开的个人排名榜');",
      "ok(/missers\\.length/.test(stageSrc), '但保留「未答对人数」（老师需要知道有多少人没会）');",
      '',
      '/* 投屏适配：大屏字号要随视口缩，否则老教室 1024×768 / 4:3 会溢出 */',
      "ok(/clamp\\([^)]*vmin/.test(stageSrc), '大屏字号用 clamp + vmin（随视口缩）');",
      "ok(!/font-size:\\s*150px/.test(stageSrc), '点名姓名不再硬编码 150px');",
      '',
      anchor
    ].join('\n');
    if (t.includes(anchor)) {
      t = t.replace(anchor, block);
      // 需要 fs/path/ROOT
      if (!/const ROOT =/.test(t)) {
        console.log('  ⚠ logic.test 里没有 ROOT 常量，断言里用的是 path.join(ROOT,...)');
      }
      fs.writeFileSync(p, t, 'utf8');
      n += 1;
      console.log('  [ok] 加了大屏断言');
    } else {
      console.log('  · 找不到汇总锚点');
    }
  }
}

console.log('  共改 ' + n + ' 处');
