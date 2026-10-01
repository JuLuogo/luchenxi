/*!
 * tests/fix-doc-refs.js — 按映射批量修正文档里的行号引用（UTF-8 安全，勿用 PowerShell 改写中文文件）
 *   node tests/fix-doc-refs.js            # 只演练，打印将要修改的内容
 *   node tests/fix-doc-refs.js --apply    # 真正写入
 *
 * 用法：改完代码后，先用 `node tests/anchors.js` 看关键函数的新行号，
 *       再把「旧引用 → 新引用」追加到下面的 FIXES 里执行。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const APPLY = process.argv.includes('--apply');

/** 每条：[文件, 旧引用, 新引用, 期望出现次数] */
const FIXES = [
  // sync.js 因新增 dump 分支 / requestDump / 按题公布答案 / 题目进度而整体位移
  ['01-项目现状与架构.md', 'sync.js:318', 'sync.js:333', 1],
  ['01-项目现状与架构.md', 'sync.js:292', 'sync.js:307', 1],
  ['01-项目现状与架构.md', 'sync.js:149', 'sync.js:150', 2],
  ['02-数据模型与存储.md', 'sync.js:318', 'sync.js:333', 1],
  ['02-数据模型与存储.md', 'sync.js:223', 'sync.js:225', 1],
  ['02-数据模型与存储.md', 'sync.js:197', 'sync.js:198', 1],
  ['03-加权积分规则.md', 'sync.js:229', 'sync.js:231', 1],
  ['04-题库与组卷答题.md', 'sync.js:208-221', 'sync.js:210-224', 1],
  ['04-题库与组卷答题.md', 'sync.js:121-128', 'sync.js:122-129', 1],
  ['05-学情分析与总结.md', 'sync.js:238-248', 'sync.js:240-250', 1],
  ['06-点名系统.md', 'sync.js:255-264', 'sync.js:262-271', 1],
  // classroom.js 因渲染控制区（上一题/下一题）与 setReveal/isRevealed/moveQuestion 而位移
  ['02-数据模型与存储.md', 'classroom.js:413', 'classroom.js:447', 1],
  ['02-数据模型与存储.md', 'classroom.js:497', 'classroom.js:543', 1],
  ['02-数据模型与存储.md', 'classroom.js:416', 'classroom.js:458', 1],
  ['02-数据模型与存储.md', 'classroom.js:508', 'classroom.js:554', 1],
  ['02-数据模型与存储.md', 'classroom.js:293', 'classroom.js:327', 1],
  ['02-数据模型与存储.md', 'classroom.js:280', 'classroom.js:315', 1],
  // 第二轮：新增「推送题目 / 上一题下一题」后的再次位移
  ['02-数据模型与存储.md', 'classroom.js:447', 'classroom.js:441', 1],
  ['02-数据模型与存储.md', 'classroom.js:297', 'classroom.js:295', 1],
  ['04-题库与组卷答题.md', 'classroom.js:423', 'classroom.js:468', 1],
  ['04-题库与组卷答题.md', 'classroom.js:270-278', 'classroom.js:305-313', 1],
  ['04-题库与组卷答题.md', 'classroom.js:447-473', 'classroom.js:493-519', 1],
  ['07-通信协议与API.md', 'classroom.js:533-549', 'classroom.js:587-602', 1],
  ['07-通信协议与API.md', 'classroom.js:280-299', 'classroom.js:315-330', 1],
  ['07-通信协议与API.md', 'classroom.js:551', 'classroom.js:605', 1],
  ['08-开发部署与测试.md', 'classroom.js:342-344', 'classroom.js:377-379', 1],
  // 第三轮：sync.js 命令分发 / reconnect / sendNow 与测试文件行号
  ['07-通信协议与API.md', 'sync.js:125-128', 'sync.js:126-129', 1],
  ['07-通信协议与API.md', 'sync.js:138-140', 'sync.js:139-141', 1],
  ['07-通信协议与API.md', 'sync.js:159-164', 'sync.js:160-165', 1],
  ['07-通信协议与API.md', 'sync.js:274-281', 'sync.js:282-295', 1],
  ['09-路线图与变更记录.md', 'sync.js:125-128', 'sync.js:126-129', 1],
  ['05-学情分析与总结.md', 'classroom.js:151-165', 'classroom.js:152-167', 1],
  ['06-点名系统.md', 'admin.js:579', 'admin.js:583', 1],
  ['07-通信协议与API.md', 'admin.js:589', 'admin.js:593', 1],
  ['04-题库与组卷答题.md', 'logic.test.js:156-165', 'logic.test.js:163-166', 1],
  ['04-题库与组卷答题.md', 'logic.test.js:353-380', 'logic.test.js:355-383', 1],
  ['04-题库与组卷答题.md', 'logic.test.js:382-440', 'logic.test.js:384-487', 1],
  ['06-点名系统.md', 'logic.test.js:312-322', 'logic.test.js:315-323', 2],
  ['06-点名系统.md', 'logic.test.js:324-329', 'logic.test.js:326-331', 1],
  // 第四轮：修 file:// 单机模式与启动器后（sync.js 地址/连接重构，classroom.js 提示与按钮位移）
  ['01-项目现状与架构.md', 'sync.js:333', 'sync.js:351', 1],
  ['01-项目现状与架构.md', 'classroom.js:344', 'classroom.js:379', 2],
  ['02-数据模型与存储.md', 'sync.js:333', 'sync.js:351', 1],
  ['02-数据模型与存储.md', 'sync.js:198', 'sync.js:216', 1],
  ['02-数据模型与存储.md', 'sync.js:225', 'sync.js:243', 1],
  ['02-数据模型与存储.md', 'classroom.js:458', 'classroom.js:467', 1],
  ['02-数据模型与存储.md', 'classroom.js:554', 'classroom.js:563', 1],
  ['02-数据模型与存储.md', 'sync.js:255', 'sync.js:273', 1],
  ['04-题库与组卷答题.md', 'sync.js:210-224', 'sync.js:228-242', 1],
  ['04-题库与组卷答题.md', 'sync.js:122-129', 'sync.js:140-147', 1],
  ['05-学情分析与总结.md', 'sync.js:240-250', 'sync.js:258-268', 1],
  ['06-点名系统.md', 'sync.js:262-271', 'sync.js:280-289', 1],
  ['07-通信协议与API.md', 'sync.js:126-129', 'sync.js:144-147', 1],
  ['07-通信协议与API.md', 'sync.js:139-141', 'sync.js:157-159', 1],
  ['07-通信协议与API.md', 'sync.js:160-165', 'sync.js:177-184', 1],
  ['07-通信协议与API.md', 'sync.js:282-295', 'sync.js:300-313', 1],
  ['07-通信协议与API.md', 'sync.js:287-315', 'sync.js:310-338', 1],
  ['07-通信协议与API.md', 'sync.js:318-322', 'sync.js:346-350', 1],
  ['07-通信协议与API.md', 'sync.js:169-180', 'sync.js:187-198', 1],
  ['07-通信协议与API.md', 'sync.js:183-194', 'sync.js:201-212', 1],
  ['07-通信协议与API.md', 'sync.js:103-109', 'sync.js:121-127', 2],
  ['07-通信协议与API.md', 'classroom.js:587-602', 'classroom.js:596-611', 1],
  ['09-路线图与变更记录.md', 'sync.js:126-129', 'sync.js:144-147', 1],
  ['09-路线图与变更记录.md', 'sync.js:287-315', 'sync.js:310-338', 1],
  ['09-路线图与变更记录.md', 'classroom.js:284', 'classroom.js:291', 1],
  ['09-路线图与变更记录.md', 'classroom.js:273', 'classroom.js:296', 1],
  ['09-路线图与变更记录.md', 'sync.js:225', 'sync.js:243', 1],
  ['09-路线图与变更记录.md', 'sync.js:255', 'sync.js:273', 1]
];

let changed = 0, missed = 0;
const byFile = new Map();
FIXES.forEach(([f, from, to, expect]) => {
  if (!byFile.has(f)) byFile.set(f, []);
  byFile.get(f).push([from, to, expect]);
});

for (const [file, list] of byFile) {
  const full = path.join(ROOT, 'docs', file);
  let text = fs.readFileSync(full, 'utf8');
  let touched = false;
  for (const [from, to, expect] of list) {
    const n = text.split(from).length - 1;
    if (n === 0) { console.log('· ' + file + ' 无 ' + from + '（可能已修正）'); missed++; continue; }
    if (expect && n !== expect) console.log('⚠ ' + file + ' ' + from + ' 出现 ' + n + ' 次（期望 ' + expect + '）');
    text = text.split(from).join(to);
    changed += n;
    touched = true;
    console.log((APPLY ? '✔ ' : '· ') + file + ': ' + from + ' → ' + to + '  ×' + n);
  }
  if (APPLY && touched) fs.writeFileSync(full, text, 'utf8');
}
console.log('\n' + (APPLY ? '已写入' : '演练') + '：修正 ' + changed + ' 处，未命中 ' + missed + ' 处');
if (!APPLY) console.log('加 --apply 才会真正写入');
