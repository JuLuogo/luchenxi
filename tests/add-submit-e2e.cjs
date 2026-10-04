/*!
 * tests/add-submit-e2e.cjs — e2e 覆盖"学生端界面点提交"（原来只覆盖领域层）
 *
 *   审计发现：`student.js::submit()` 因为 `q.type` 缺失，把选择题当主观题，
 *   选项从没发出去 → 学生永远 0 分。**而两条 e2e 都没抓到** ——
 *   因为它们直接调领域层，没走学生端界面。
 *
 *   这一段补上：在学生端页面上**真的点选项、真的点提交**，然后断言教师端收到的命令。
 *
 *   node tests/add-submit-e2e.cjs
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const p = path.join(ROOT, 'tests/smoke-class.html');
let t = fs.readFileSync(p, 'utf8');
if (t.includes('学生端界面点提交')) {
  console.log('  · 已有该段');
  process.exit(0);
}
const EOL = t.includes('\r\n') ? '\r\n' : '\n';
const anchor = '    /* ---------- 9.5 公开课全链路（三端同步） ---------- */';
const block = [
  '    /* ---------- 9.4 学生端界面点提交（走真界面，不是直接调领域层） ---------- */',
  '    {',
  '      // 审计发现：学生端 submit() 因为 q.type 缺失把选择题当主观题，选项从没发出去。',
  '      // 这一段**真的点选项、真的点提交**，然后看教师端收到什么。',
  '      const qc = HS.addQuestion({ stem: \'界面提交题：2+2=?\', tier: \'basic\', answer: \'A\', options: [\'3\', \'4\', \'5\'] });',
  '      HS.setRuntime({ qid: qc.id, quizId: null });',
  '      HC.classroom.setPhase(\'question\');',
  '      await wait(1800);',
  '',
  '      // 学生端应看到这道题，且题型是选择题',
  '      const stuQ = await sw.eval2(\'CIStudent.question()\');',
  '      check(!!stuQ, \'学生端界面：拿到题目\');',
  '      check(stuQ && stuQ.type === \'choice\', \'学生端界面：题目带 type=choice（缺了会当成主观题）\');',
  '',
  '      // 在**页面上**点第二个选项（B = 4，正确答案）',
  '      const clicked = await sw.eval2(`(function(){',
  '        var btns = document.querySelectorAll(\'.q-opts button, .q-opts .opt, .opt-btn, button\');',
  '        for (var i = 0; i < btns.length; i++) {',
  '          if ((btns[i].textContent || \'\').indexOf(\'4\') >= 0) { btns[i].click(); return true; }',
  '        }',
  '        return false;',
  '      })()`);',
  '      check(clicked === true, \'学生端界面：点到了选项按钮\');',
  '      await wait(400);',
  '',
  '      // 在**页面上**点提交',
  '      const submitted = await sw.eval2(`(function(){',
  '        var all = document.querySelectorAll(\'button\');',
  '        for (var i = 0; i < all.length; i++) {',
  '          var txt = (all[i].textContent || \'\').trim();',
  '          if (txt.indexOf(\'提交\') >= 0 && txt.indexOf(\'跳过\') < 0) { all[i].click(); return txt; }',
  '        }',
  '        return null;',
  '      })()`);',
  '      check(!!submitted, \'学生端界面：点到了提交按钮（\' + submitted + \'）\');',
  '      await wait(1500);',
  '',
  '      // 教师端应收到带 choice 的作答（这是本轮修的核心）',
  '      const recs = HS.get().records.filter((r) => r.qid === qc.id);',
  '      check(recs.length > 0, \'教师端：收到了学生提交（\' + recs.length + \' 条）\');',
  '      const last = recs[recs.length - 1];',
  '      check(!!last, \'教师端：取到最近一条\');',
  '      if (last) {',
  '        check(last.result !== \'skip\', \'教师端：判定不是 skip（说明选项真的发出去了）—— 实际 \' + last.result);',
  '        check(last.choice === \'B\' || last.choice === \'["B"]\' || String(last.choice).indexOf(\'B\') >= 0,',
  '          \'教师端：收到的是选项 B（实际 \' + JSON.stringify(last.choice) + \'）\');',
  '      }',
  '    }',
  '',
  anchor
].join('\n');
if (t.includes(anchor)) {
  t = t.replace(anchor, block.split('\n').join(EOL));
  fs.writeFileSync(p, t, 'utf8');
  console.log('  [ok] 多端 e2e 加了"学生端界面点提交"');
} else {
  console.log('  · 未匹配锚点');
}
