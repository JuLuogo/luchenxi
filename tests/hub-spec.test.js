/*!
 * tests/hub-spec.test.js — 枢纽行为一致性测试（可执行规格）
 *   node tests/hub-spec.test.js
 *
 * 做法：自己拉起一个真实枢纽进程（临时端口 + 临时数据目录），用真实 WebSocket 客户端
 * 按场景矩阵走一遍，逐条断言"谁应该收到什么、谁绝不该收到什么"。
 *
 * 为什么重要：这份规格就是 **Rust 内置枢纽必须满足的验收条件**（③ 的判据）。
 * 里面对"dump 永不广播""教师端离线命令排队与补发""presence 去重"等安全/容错行为做了硬断言，
 * 任何一版枢纽改坏都会被拦下。
 *
 * 注意：进程用 stdio:'ignore' 启动（沙箱下 piped stdio 会被拒绝），就绪靠轮询 /health。
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const PORT = 8231;
const ROOM = 'spec-' + Date.now().toString(36);
const DATA_DIR = path.join(os.tmpdir(), 'ci-hub-spec-' + Date.now().toString(36));

const SCENARIOS = require(path.join(ROOT, 'packages', 'protocol', 'hub-scenarios.json')).scenarios;
const executed = new Set();

/** 登记一个场景 id（并在最后校验：清单里的每个场景都被真正执行过） */
function scenario(id) {
  const s = SCENARIOS.filter((x) => x.id === id)[0];
  ok(!!s, '场景清单里有 ' + id);
  executed.add(id);
  return s ? s.title : id;
}

let passed = 0;
const failures = [];
function ok(cond, label) { if (cond) passed++; else failures.push(label); }
function eq(a, b, label) {
  const x = JSON.stringify(a), y = JSON.stringify(b);
  if (x === y) passed++; else failures.push(label + '  →  期望 ' + y + '，实际 ' + x);
}
function group(n) { console.log('\n== ' + n + ' =='); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ *
 * 测试用 WS 客户端
 * ------------------------------------------------------------------ */

function connect(opts) {
  const q = '?room=' + encodeURIComponent(opts.room || ROOM) + '&role=' + (opts.role || 'stage') +
    (opts.team ? '&team=' + encodeURIComponent(opts.team) : '') +
    (opts.label ? '&label=' + encodeURIComponent(opts.label) : '');
  const ws = new WebSocket('ws://127.0.0.1:' + PORT + '/' + q);
  const inbox = [];
  const waiters = [];

  ws.on('message', (raw) => {
    let msg = null;
    try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
    const idx = waiters.findIndex((w) => !w.type || w.type === msg.type);
    if (idx >= 0) {
      const w = waiters.splice(idx, 1)[0];
      clearTimeout(w.timer);
      w.resolve(msg);
    } else {
      inbox.push(msg);
    }
  });

  const client = {
    ws: ws,
    inbox: inbox,
    ready: new Promise((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
      setTimeout(() => reject(new Error('连接超时')), 5000);
    }),
    send(obj) { ws.send(JSON.stringify(obj)); },
    /** 等一条指定类型的报文（先看收件箱，再等新消息） */
    next(type, timeout) {
      const idx = inbox.findIndex((m) => !type || m.type === type);
      if (idx >= 0) return Promise.resolve(inbox.splice(idx, 1)[0]);
      return new Promise((resolve, reject) => {
        const w = { type: type, resolve: resolve };
        w.timer = setTimeout(() => {
          const i = waiters.indexOf(w);
          if (i >= 0) waiters.splice(i, 1);
          reject(new Error('等待 ' + type + ' 超时；已收到：' + inbox.map((m) => m.type).join(',')));
        }, timeout || 4000);
        waiters.push(w);
      });
    },
    /** 等一小会儿，然后返回期间收到的所有报文类型 */
    async settle(ms) {
      await sleep(ms || 400);
      const types = inbox.map((m) => m.type);
      inbox.length = 0;
      return types;
    },
    close() { try { ws.close(); } catch (e) { /* 忽略 */ } }
  };
  return client;
}

/** 起一个干净的测试枢纽，等 /health 就绪 */
async function startHub() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const child = spawn(process.execPath, [path.join(ROOT, 'sync-server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT),
      HOST: '127.0.0.1',
      DATA_DIR: DATA_DIR,
      NO_PERSIST: ''          // 用临时目录，别污染仓库
    }),
    stdio: 'ignore'
  });
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    try {
      const res = await fetch('http://127.0.0.1:' + PORT + '/health');
      if (res.ok) {
        const info = await res.json();
        if (info.ok) return { child: child, info: info };
      }
    } catch (e) { /* 还没起来 */ }
  }
  child.kill();
  throw new Error('枢纽未能在 10 秒内就绪');
}

/* ------------------------------------------------------------------ *
 * 场景矩阵
 * ------------------------------------------------------------------ */

(async function main() {
  const hub = await startHub();
  const stop = () => { try { hub.child.kill(); } catch (e) { /* 忽略 */ } };
  process.on('exit', stop);

  try {
    /* ================= 1. welcome ================= */
    scenario('welcome_fields');
    group('welcome 字段完整');
    const host = connect({ role: 'host' });
    await host.ready;
    const w1 = await host.next('welcome');
    ok(w1.room === ROOM, 'welcome.room = 请求的房间（' + w1.room + '）');
    eq(w1.role, 'host', 'welcome.role');
    ok(typeof w1.clientId !== 'undefined' && w1.clientId !== null, 'welcome.clientId 存在（' + w1.clientId + '）');
    eq(w1.hasState, false, '新房间 hasState=false');
    eq(w1.hasDump, false, '新房间 hasDump=false');
    eq(w1.hostOnline, true, 'host 连上后 hostOnline=true');
    ok(typeof w1.serverTime === 'number', 'welcome.serverTime 是数字');

    /* ================= 2. state 推送与广播 ================= */
    scenario('state_broadcast');
    group('state：host 推 → 其他端收，host 自己不再收');
    const team = connect({ role: 'team', team: 'tm_1', label: '第一组' });
    const stage = connect({ role: 'stage' });
    await team.ready; await stage.ready;
    await team.settle(300); await stage.settle(300); await host.settle(300);

    const snap = { courseName: '规格课', room: ROOM, updatedAt: Date.now(), teams: [{ id: 'tm_1', name: '第一组', score: 3 }], students: [], meta: { accepting: true } };
    host.send({ type: 'state', payload: snap });
    const sTeam = await team.next('state');
    const sStage = await stage.next('state');
    eq(sTeam.payload.courseName, '规格课', '学生端收到 state 内容正确');
    eq(sStage.payload.courseName, '规格课', '大屏收到 state 内容正确');
    ok(typeof sTeam.rev === 'number' && sTeam.rev > 0, 'state.rev 自增（' + sTeam.rev + '）');
    const hostGot = await host.settle(350);
    ok(hostGot.indexOf('state') < 0, 'host 不会收到自己推的 state（避免自我回环）');

    /* ================= 3. request ================= */
    scenario('request_backfill');
    group('request：拉取最近快照 / 无数据时报错');
    const fresh = connect({ role: 'stage' });
    await fresh.ready;
    const fw = await fresh.next('welcome');
    eq(fw.hasState, true, '已有数据后 hasState=true');
    const got = await fresh.next('state');           // 连上就补发
    eq(got.payload.courseName, '规格课', '新连接立刻拿到快照');
    fresh.send({ type: 'request' });
    const again = await fresh.next('state');
    eq(again.payload.courseName, '规格课', 'request 再取一次');

    const emptyRoom = connect({ role: 'stage', room: ROOM + '-empty' });
    await emptyRoom.ready;
    await emptyRoom.next('welcome');
    emptyRoom.send({ type: 'request' });
    const err = await emptyRoom.next('error');
    ok(/暂无课堂数据/.test(err.message), '空房间 request 返回 error（' + err.message + '）');

    /* ================= 4. dump 隐私（安全硬约束） ================= */
    scenario('dump_privacy');
    group('dump：只在 host 与枢纽之间往返');
    const dump = { courseName: '规格课', students: [{ id: 'st_1', name: '张三' }], quizzes: [], logs: [{ type: '记分' }] };
    host.send({ type: 'dump', payload: dump });
    await sleep(400);
    const teamSaw = await team.settle(0);
    const stageSaw = await stage.settle(0);
    ok(teamSaw.indexOf('dump') < 0, '学生端**绝不会**收到 dump（收到：' + teamSaw.join(',') + '）');
    ok(stageSaw.indexOf('dump') < 0, '大屏**绝不会**收到 dump');

    host.send({ type: 'request-dump' });
    const back = await host.next('dump');
    eq(back.payload.students.length, 1, 'host 可取回 dump');

    team.send({ type: 'request-dump' });
    const deny = await team.next('error');
    ok(/只有教师端/.test(deny.message), '学生端请求 dump 被拒（' + deny.message + '）');

    /* ================= 5. 权限：非 host 推 state ================= */
    scenario('permission_guard');
    group('权限校验');
    team.send({ type: 'state', payload: { courseName: '伪造' } });
    const deny2 = await team.next('error');
    ok(/只有教师端/.test(deny2.message), '学生端推 state 被拒');
    stage.send({ type: 'dump', payload: { x: 1 } });
    const deny3 = await stage.next('error');
    ok(/只有教师端/.test(deny3.message), '大屏推 dump 被拒');

    /* ================= 6. cmd 转发 + ack ================= */
    scenario('cmd_forward_ack');
    group('cmd：转发给教师端并回执');
    const cmd = { id: 'cm_1', kind: 'answer', teamId: 'tm_1', qid: 'q_1', choice: ['B'] };
    team.send({ type: 'cmd', cmd: cmd });
    const hostCmd = await host.next('cmd');
    eq(hostCmd.cmd.id, 'cm_1', 'host 收到 cmd（id 一致）');
    eq(hostCmd.cmd.choice, ['B'], 'host 收到 cmd 内容一致');
    const ack = await team.next('ack');
    eq(ack.ok, true, '学生端收到 ok=true 回执');
    eq(ack.cmdId, 'cm_1', 'ack.cmdId 对应命令');

    /* ================= 7. 教师端离线：排队 + 补发 ================= */
    scenario('offline_queue_backlog');
    group('教师端离线：命令排队，上线补发 cmd-backlog');
    host.close();
    await sleep(500);                                  // 等 host 注销 + presence 刷新
    const offlineCmd = { id: 'cm_2', kind: 'buzz', teamId: 'tm_1', qid: 'q_1' };
    team.send({ type: 'cmd', cmd: offlineCmd });
    const ack2 = await team.next('ack');
    eq(ack2.ok, false, '教师端离线时 ack.ok=false');
    eq(ack2.reason, 'teacher-offline', '理由为 teacher-offline（学生端据此提示"已排队"）');

    const host2 = connect({ role: 'host' });
    await host2.ready;
    await host2.next('welcome');
    const backlog = await host2.next('cmd-backlog');
    eq(backlog.cmds.length, 1, '补发 1 条离线命令');
    eq(backlog.cmds[0].id, 'cm_2', '补发的就是离线期间那条');

    /* ================= 8. presence ================= */
    scenario('presence_dedupe'); scenario('presence_disconnect_keeps_entry');
    group('presence：在线小组与 hostOnline');
    const p1 = await host2.next('presence');
    ok(typeof p1.hostOnline === 'boolean', 'presence.hostOnline 是布尔');
    ok(Array.isArray(p1.teams), 'presence.teams 是数组');
    const mine = p1.teams.filter((t) => t.teamId === 'tm_1');
    eq(mine.length, 1, '同一队只报一次（去重）');
    eq(mine[0].online, true, '该队在在线列表里');

    // 第二台同队设备：仍然只算一组
    const team2 = connect({ role: 'team', team: 'tm_1', label: '第一组-备用机' });
    await team2.ready;
    await team2.next('welcome');
    const p2 = await host2.next('presence');
    eq(p2.teams.filter((t) => t.teamId === 'tm_1').length, 1, '同队两台设备仍只占一条');

    // 换队/改 label：枢纽级 hello（扁平字段）后 presence 更新
    await host2.settle(300);                           // 先清掉之前的 presence，避免读到旧的那条
    team2.send({ type: 'hello', role: 'team', teamId: 'tm_2', label: '第二组' });
    const p3 = await host2.next('presence');
    ok(p3.teams.some((t) => t.teamId === 'tm_2'), '枢纽级 hello 后新队伍出现在在线列表');
    ok((p3.teams.filter((t) => t.teamId === 'tm_2')[0] || {}).online === true, '新加入的队伍 online=true');

    // 业务级 hello（{type:'cmd',cmd:{kind:'hello'}}）应当被转发给教师端，而不是被枢纽吞掉
    const helloCmd = { id: 'cm_hello', kind: 'hello', teamId: 'tm_1', label: '第一组' };
    team.send({ type: 'cmd', cmd: helloCmd });
    const fwd = await host2.next('cmd');
    eq(fwd.cmd.kind, 'hello', '业务级 hello 命令被转发给教师端（契约 CMD_KINDS.hello）');
    eq(fwd.cmd.id, 'cm_hello', '转发内容与发送一致');

    // 断开：**不移除条目**，只把 online 置 false（教师端据此区分"未入座"与"曾入座、当前离线"）
    await host2.settle(300);
    team2.close();
    const p4 = await host2.next('presence');
    const gone = p4.teams.filter((t) => t.teamId === 'tm_2');
    eq(gone.length, 1, '断开后仍保留该队条目（便于教师端显示"未入座"）');
    eq(gone[0].online, false, '该队 online=false');
    ok(gone[0].label === '第二组', '保留最后一次的 label（' + gone[0].label + '）');

    /* ================= 9. leaderboard 兼容 ================= */
    scenario('leaderboard_alias');
    group('leaderboard：v2 兼容别名');
    host2.send({ type: 'leaderboard', payload: { courseName: '兼容课' } });
    const s2 = await team.next('state');
    eq(s2.payload.courseName, '兼容课', '推 leaderboard 等价于推 state（老客户端可用）');

    /* ================= 10. 房间隔离 ================= */
    scenario('room_isolation');
    group('房间隔离');
    const other = connect({ role: 'stage', room: ROOM + '-other' });
    await other.ready;
    await other.next('welcome');
    const oTypes = await other.settle(600);
    ok(oTypes.indexOf('state') < 0, '另一个房间不会收到本房间的 state（收到：' + oTypes.join(',') + '）');
    host2.send({ type: 'state', payload: { courseName: '本房间' } });
    const oAfter = await other.settle(600);
    ok(oAfter.indexOf('state') < 0, '本房间继续推数据也不会串到别的房间');

    /* ================= 11. 房间号清洗 ================= */
    scenario('room_name_sanitize');
    group('房间号清洗（防越权/防路径穿越）');
    const evil = connect({ role: 'stage', room: '../../etc/passwd' });
    await evil.ready;
    const ew = await evil.next('welcome');
    ok(/^[A-Za-z0-9_-]{1,32}$/.test(ew.room), '非法房间号被清洗为安全字符集（' + ew.room + '）');
    const health = await (await fetch('http://127.0.0.1:' + PORT + '/health')).json();
    ok(health.rooms.every((r) => /^[A-Za-z0-9_-]+$/.test(r)), '枢纽房间列表里没有非法名（' + health.rooms.join(',') + '）');
    eq(health.storage, 'sqlite', '/health 报告使用 SQLite（' + health.storage + '）');

    /* ================= 12. HTTP 面 ================= */
    scenario('http_api');
    group('HTTP 接口（教师端/客户端共用）');
    const st = await (await fetch('http://127.0.0.1:' + PORT + '/api/state?room=' + ROOM)).json();
    ok(st.ok && st.dump && st.dump.students.length === 1, '/api/state 读回落库的完整数据');
    const stats = await (await fetch('http://127.0.0.1:' + PORT + '/api/stats?room=' + ROOM)).json();
    ok(stats.ok && typeof stats.counts === 'object', '/api/stats 返回行数统计');
    const backup = await (await fetch('http://127.0.0.1:' + PORT + '/api/backup?room=' + ROOM)).json();
    eq(backup.type, 'ci-backup', '/api/backup 返回 ci-backup');
    eq(backup.version, 3, '/api/backup 版本号 3');

    // 空房间导出 → 404 + 可读原因
    const emptyRes = await fetch('http://127.0.0.1:' + PORT + '/api/backup?room=' + ROOM + '-empty');
    eq(emptyRes.status, 404, '空房间 /api/backup 返回 404');
    const emptyBody = await emptyRes.json();
    ok(/还没有数据/.test(emptyBody.message || ''), '给出可读原因：' + emptyBody.message);

    // /api/restore：导入后内存态替换、广播 state、坏格式 400
    await host2.settle(200);
    await team.settle(300);                    // 清掉之前场景残留的 state，避免读到旧的那条
    const restoreRes = await fetch('http://127.0.0.1:' + PORT + '/api/restore?room=' + ROOM, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'ci-backup', version: 3, state: { courseName: '导入的课', students: [{ id: 'st_9', name: '李四' }], quizzes: [] } })
    });
    const restored = await restoreRes.json();
    ok(restoreRes.ok && restored.ok === true, '/api/restore 导入成功（rev=' + restored.rev + '）');
    const afterRestore = await (await fetch('http://127.0.0.1:' + PORT + '/api/state?room=' + ROOM)).json();
    eq(afterRestore.dump.students[0].id, 'st_9', '导入后内存态已替换');
    const broadcast = await team.next('state');
    eq(broadcast.payload.courseName, '导入的课', '导入后广播新状态给大屏/学生端');

    const badRes = await fetch('http://127.0.0.1:' + PORT + '/api/restore?room=' + ROOM, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '"just-a-string"'
    });
    eq(badRes.status, 400, '非对象备份体被拒（400）');

    const put = await (await fetch('http://127.0.0.1:' + PORT + '/api/state?room=' + ROOM, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dump: { courseName: 'PUT 覆盖', students: [] } })
    })).json();
    ok(put.ok && put.rev > 0, 'PUT /api/state 写入成功（rev=' + put.rev + '）');

    // rev 规则必须让两条写入路径（WS state / HTTP PUT）互不判过期：
    // 教师端页面同时走这两条，若各自 +1 就会刷出 409（曾经真发生过）
    const revBefore = await (await fetch('http://127.0.0.1:' + PORT + '/api/state?room=' + ROOM)).json();
    host2.send({ type: 'state', rev: revBefore.rev + 1, payload: { courseName: '同一份数据' } });
    await sleep(400);
    const afterWs = await (await fetch('http://127.0.0.1:' + PORT + '/api/state?room=' + ROOM)).json();
    eq(afterWs.rev, revBefore.rev + 1, 'WS 推 state 采纳客户端声明的 rev（不额外 +1）');
    const sameRevRes = await fetch('http://127.0.0.1:' + PORT + '/api/state?room=' + ROOM, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rev: afterWs.rev, dump: { courseName: '同一份数据', students: [] } })
    });
    eq(sameRevRes.status, 200, '同一 rev 经 HTTP 再写一次不会被判过期（两条路径共存）');
    const afterBoth = await (await fetch('http://127.0.0.1:' + PORT + '/api/state?room=' + ROOM)).json();
    eq(afterBoth.rev, revBefore.rev + 1, '两条路径共用同一套 rev，不会互相把对方顶成过期');

    // 过期写入防护：多写者场景下，老设备带着旧 rev 提交不能覆盖新数据
    const staleRes = await fetch('http://127.0.0.1:' + PORT + '/api/state?room=' + ROOM, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rev: 1, dump: { courseName: '老设备的数据', students: [] } })
    });
    eq(staleRes.status, 409, '带过期 rev 的写入被拒（409）');
    const staleBody = await staleRes.json();
    ok(staleBody.stale === true, '返回 stale 标记');
    ok(/已有更新的数据/.test(staleBody.message || ''), '给出可读原因：' + staleBody.message);
    const afterStale = await (await fetch('http://127.0.0.1:' + PORT + '/api/state?room=' + ROOM)).json();
    eq(afterStale.dump.courseName, '同一份数据', '被拒后数据没被旧版本覆盖');
    ok(afterStale.rev >= staleBody.rev, 'rev 未被回退');

    /* ================= 13. 契约覆盖 ================= */
    group('契约覆盖：本规格覆盖了契约里的全部报文');
    const P = require(path.join(ROOT, 'packages', 'protocol', 'messages.js'));
    const covered = ['welcome', 'state', 'dump', 'request', 'request-dump', 'cmd', 'cmd-backlog', 'ack', 'presence', 'error', 'leaderboard', 'hello'];
    P.typeList().forEach((t) => ok(covered.indexOf(t) >= 0, '规格覆盖报文 ' + t));

    [host, host2, team, stage, fresh, emptyRoom, other, evil].forEach((c) => c.close());
  } catch (e) {
    failures.push('运行异常：' + (e && e.stack ? e.stack.split('\n')[0] : e));
  } finally {
    stop();
    await sleep(200);
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
  }

  // 清单覆盖：Node 规格必须把 hub-scenarios.json 里的场景全部跑过
  group('场景清单覆盖');
  SCENARIOS.forEach((s) => ok(executed.has(s.id), 'Node 规格已执行场景 ' + s.id + '（' + s.title + '）'));
  eq(executed.size, SCENARIOS.length, '执行过的场景数与清单一致');

  console.log('\n----------------------------------------');
  if (failures.length) {
    console.log(`❌ 失败 ${failures.length} 项 / 通过 ${passed} 项`);
    failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
    process.exit(1);
  } else {
    console.log(`✅ 全部通过：${passed} 项断言`);
  }
})();
