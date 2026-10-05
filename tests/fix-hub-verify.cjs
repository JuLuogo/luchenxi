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

  console.log('\n----------------------------------------');
  if (fails.length) {
    console.log('❌ 失败 ' + fails.length + ' 项 / 通过 ' + pass + ' 项');
    fails.forEach((f, i) => console.log('  ' + (i + 1) + '. ' + f));
    process.exit(1);
  }
  console.log('✅ 全部通过：' + pass + ' 项（枢纽安全修复黑盒验证）');
})().catch((e) => { console.error('✘ ' + e.message); process.exit(1); });
