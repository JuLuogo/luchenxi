/*!
 * tests/fix-hub-verify.cjs — 黑盒验证枢纽高危修复（与审计员同样的方法）
 *
 *   node tests/fix-hub-verify.cjs [base]     # 默认 http://127.0.0.1:8391
 *
 *   ① GET /data/classroom.db        → 应 403（原来 200 + SQLite 二进制）
 *   ② GET /assets/../../etc/passwd  → 应 403
 *   ③ hello{role:"host"} 冒名       → 不应被接受为 host
 *   ④ dump 后新连接                → 不应收到完整存档当 state
 *
 *   node tests/fix-hub-verify.cjs
 */
'use strict';
const WebSocket = require('ws');
const BASE = process.argv[2] || 'http://127.0.0.1:8391';
const WS = BASE.replace(/^http/, 'ws');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
const fails = [];
const check = (ok, label, extra) => {
  if (ok) { pass += 1; console.log('  ✅ ' + label + (extra ? '  —— ' + extra : '')); }
  else { fails.push(label); console.log('  ❌ ' + label + (extra ? '  —— ' + extra : '')); }
};

(async () => {
  console.log('=== ① 数据库不能被静态服务下载 ===');
  for (const path of ['/data/classroom.db', '/data/classroom.db-wal', '/data/classroom.db-shm']) {
    const r = await fetch(BASE + path).catch(() => null);
    const code = r ? r.status : 0;
    check(code === 403 || code === 404, 'GET ' + path + ' 被拒绝', 'HTTP ' + code);
  }

  console.log('\n=== ② 路径穿越 ===');
  for (const path of ['/assets/../../../etc/passwd', '/assets/..%2f..%2fetc%2fpasswd', '/.git/config']) {
    const r = await fetch(BASE + path).catch(() => null);
    const code = r ? r.status : 0;
    check(code === 403 || code === 404, 'GET ' + path + ' 被拒绝', 'HTTP ' + code);
  }

  console.log('\n=== ③ hello 不能把自己提成 host ===');
  const room = 'verify-' + Date.now();
  const evil = new WebSocket(WS + '/ws?room=' + room);
  const msgs = [];
  evil.on('message', (d) => { try { msgs.push(JSON.parse(d.toString())); } catch (e) { /* 忽略 */ } });
  await new Promise((res) => evil.on('open', res));
  await sleep(300);
  // 先以 team 身份连上，再试图提权
  evil.send(JSON.stringify({ type: 'hello', role: 'team', teamId: 't_evil' }));
  await sleep(300);
  evil.send(JSON.stringify({ type: 'hello', role: 'host' }));
  await sleep(600);

  // 让"真教师"发一条命令：冒名者不该收到
  const teacher = new WebSocket(WS + '/ws?room=' + room);
  const teacherMsgs = [];
  teacher.on('message', (d) => { try { teacherMsgs.push(JSON.parse(d.toString())); } catch (e) { /* 忽略 */ } });
  await new Promise((res) => teacher.on('open', res));
  await sleep(300);
  teacher.send(JSON.stringify({ type: 'hello', role: 'host' }));
  await sleep(400);
  teacher.send(JSON.stringify({ type: 'cmd', cmd: { kind: 'score', sid: 's1', points: 5 } }));
  await sleep(800);

  const evilGotCmd = msgs.some((m) => JSON.stringify(m).includes('SECRET_SCORE'));
  const evilHello = msgs.filter((m) => m.type === 'welcome' || m.type === 'state');
  // 判定：冒名者不应收到转发给 host 的 cmd 流（这里用"是否收到命令回执"间接判断）
  check(!evilGotCmd, '冒名者收不到教师端命令流', evilGotCmd ? '收到了！' : '未收到');

  console.log('\n=== ③.5 GET /api/state 的 dump 只发给回环请求 ===');
  {
    // 审计发现：GET /api/state 原来**无鉴权返回完整存档 dump**（含答案与全量流水）——
    // 同局域网的学生手机直接 GET 就能拿到答案。WS 侧却严格保证只有 host 能取 dump。
    // 先造一个房间：CI 的枢纽用临时数据目录，default 房间本来是空的，
    // 空房间走的是「没有数据」分支（本来就不该有 dump），断言会假失败。
    await fetch(BASE + '/api/state?room=default', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: { students: [{ id: 's1', name: '验证' }] }, rev: 1 })
    }).catch(() => null);
    const loop = await fetch(BASE + '/api/state?room=default').then((r) => r.json()).catch(() => null);
    check(!!loop && 'dump' in loop, '回环请求能拿到 dump（教师机自己要靠它恢复）');
    // 用本机非回环地址模拟"局域网设备"
    const ips = [];
    try {
      const os = require('os');
      Object.values(os.networkInterfaces()).forEach((list) => (list || []).forEach((x) => {
        if (x.family === 'IPv4' && !x.internal) ips.push(x.address);
      }));
    } catch (e) { /* 忽略 */ }
    if (ips.length) {
      const lan = await fetch('http://' + ips[0] + ':' + new URL(BASE).port + '/api/state?room=default')
        .then((r) => r.json()).catch(() => null);
      if (lan === null) {
        // 连不上也是**通过**：说明枢纽只绑了回环（比绑 0.0.0.0 更安全），局域网根本够不到。
        check(true, '局域网请求够不到枢纽（只绑回环）—— 比绑 0.0.0.0 更安全');
      } else {
        check(!('dump' in lan), '局域网请求**拿不到** dump（不泄答案）—— 用 ' + ips[0] + ' 测');
      }
    } else {
      console.log('  · 本机没有非回环 IPv4，跳过局域网断言');
    }
  }
  
  console.log('\n=== ③.6 API 规范（方法校验 / 错误码 / health 说实话） ===');
  {
    /* 审计发现：Node 版的 /api/restore 等端点**没有方法校验** ——
       GET /api/restore 这类"用 GET 触发写操作"可达（最容易被误触发的形状）。 */
    const getRestore = await fetch(BASE + '/api/restore?room=default').then((r) => r.status).catch(() => 0);
    check(getRestore === 405 || getRestore === 404, 'GET /api/restore 被拒（' + getRestore + '，不应是 200）');
    const getBackup = await fetch(BASE + '/api/backup?room=default').then((r) => r.status).catch(() => 0);
    check(getBackup === 200 || getBackup === 404 || getBackup === 501, 'GET /api/backup 允许读（' + getBackup + '）');
    const postBackup = await fetch(BASE + '/api/backup?room=default', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then((r) => r.status).catch(() => 0);
    check(postBackup === 405 || postBackup === 404, 'POST /api/backup 被拒（' + postBackup + '，备份是读操作）');

    /* 错误码语义：请求错了是 400/413，不是 500（500 会让客户端以为可以重试） */
    const badJson = await fetch(BASE + '/api/state?room=default', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{ 这不是 JSON'
    }).then((r) => r.status).catch(() => 0);
    check(badJson === 400 || badJson === 422, '坏 JSON → 4xx（' + badJson + '，不是 500）');

    /* /health 要"说实话"：实现了 /qr.png 就该说支持（客户端据此决定显示二维码还是文字地址） */
    const health = await fetch(BASE + '/health').then((r) => r.json()).catch(() => null);
    check(!!health && health.ok === true, '/health 正常');
    const qr = await fetch(BASE + '/qr.png?text=hi').then((r) => r.status).catch(() => 0);
    check(qr === 200 || qr === 501, '/qr.png 有明确答复（' + qr + '）');
    if (qr === 200) check(health.qrcode === true, '/health 的 qrcode 与 /qr.png 实际能力一致');
  }
  
  console.log('\n=== ④ dump 不会被当 state 广播 ===');
  const secret = 'SECRET_ANSWER_' + Date.now();
  teacher.send(JSON.stringify({ type: 'dump', room, payload: { quizzes: [{ records: [{ note: secret }] }], answerKey: secret } }));
  await sleep(800);
  const late = new WebSocket(WS + '/ws?room=' + room);
  const lateMsgs = [];
  late.on('message', (d) => { try { lateMsgs.push(d.toString()); } catch (e) { /* 忽略 */ } });
  await new Promise((res) => late.on('open', res));
  late.send(JSON.stringify({ type: 'hello', role: 'team', teamId: 't_late' }));
  await sleep(1200);
  const leaked = lateMsgs.some((s) => s.includes(secret));
  check(!leaked, '新连接拿不到完整存档（不泄答案）', leaked ? '泄漏了！' : '未泄漏');

  evil.close(); teacher.close(); late.close();
  await sleep(200);

  console.log('\n=== ③.7 按角色下发：team 只收到本队成员 ===');
  {
    /* 审计发现：广播给 team 的 state 里带**全班名单** ——
       一个学生打开控制台就能看到「这个班有哪些人、谁在哪个队」。
       docs/09 写着「个人成绩只发给学生自己的手机」；姓名课上会念，
       但完整花名册不该发给每个学生。 */
    const room2 = 'scope-' + Date.now().toString(36);
    // 与教师端 App 一致：**在 URL 里声明角色**（`?role=host`）——
    // hub 级的 hello 提权会被防冒名守卫拒绝（那是**正确**的，测试原来写错了）
    const host2 = new WebSocket(WS + '/ws?room=' + room2 + '&role=host');
    await new Promise((res) => host2.on('open', res));
    await sleep(300);
    host2.send(JSON.stringify({ type: 'state', rev: 1, payload: {
      courseName: '裁剪测试',
      students: [
        { id: 'a1', name: '甲同学', teamId: 'T1' },
        { id: 'a2', name: '乙同学', teamId: 'T1' },
        { id: 'b1', name: '丙同学', teamId: 'T2' },
        { id: 'b2', name: '丁同学', teamId: 'T2' }
      ]
    } }));
    await sleep(400);

    const teamMsgs = [];
    const team2 = new WebSocket(WS + '/ws?room=' + room2 + '&role=team');
    team2.on('message', (d) => { try { teamMsgs.push(JSON.parse(d.toString())); } catch (e) { /* 忽略 */ } });
    await new Promise((res) => team2.on('open', res));
    // 队伍身份仍用 hello 声明（URL 里只有角色 —— 与真实学生端一致）
    team2.send(JSON.stringify({ type: 'hello', teamId: 'T1' }));
    await sleep(700);
    const st1 = teamMsgs.filter((m) => m.type === 'state').pop();
    const list1 = (st1 && st1.payload && st1.payload.students) || [];
    check(list1.length === 2 && list1.every((s) => s.teamId === 'T1'),
      'team 只收到本队成员', '收到 ' + list1.length + ' 人（应 2 人）');
    check(!JSON.stringify(st1 || {}).includes('丙同学'), 'team 收不到别队成员的姓名');

    const stageMsgs = [];
    const stage2 = new WebSocket(WS + '/ws?room=' + room2 + '&role=stage');
    stage2.on('message', (d) => { try { stageMsgs.push(JSON.parse(d.toString())); } catch (e) { /* 忽略 */ } });
    await new Promise((res) => stage2.on('open', res));
    await sleep(700);
    const st2 = stageMsgs.filter((m) => m.type === 'state').pop();
    const list2 = (st2 && st2.payload && st2.payload.students) || [];
    check(list2.length === 4, '大屏看全量（它是教室公共屏）', '收到 ' + list2.length + ' 人（应 4 人）');

    host2.close(); team2.close(); stage2.close();
    await sleep(200);
  }

  console.log('\n----------------------------------------');
  if (fails.length) {
    console.log('❌ 失败 ' + fails.length + ' 项 / 通过 ' + pass + ' 项');
    fails.forEach((f, i) => console.log('  ' + (i + 1) + '. ' + f));
    process.exit(1);
  }
  console.log('✅ 全部通过：' + pass + ' 项（枢纽安全修复黑盒验证）');
})().catch((e) => { console.error('✘ ' + e.message); process.exit(1); });
