/*!
 * sync-server.js — 教师机「本地枢纽」（不需要公网服务器）
 *
 * 职责：
 *   ① HTTP 静态托管：教师端 / 学生端 / 大屏 / 二维码图片
 *   ② WebSocket 房间与角色：host（教师端，唯一写入者）/ stage（大屏，只读）/ team（学生端，按队伍入座）
 *   ③ 权威状态缓存：host 推送的全量快照按房间缓存并落盘 rooms/<room>.json，新客户端/断线重连即补发
 *   ④ 命令转发：学生端的抢答 / 作答 / 入座命令转发给 host（教师端离线时排队，上线后补发）
 *   ⑤ 在线状态 presence：谁在线、哪支队伍已入座
 *
 * 路由：
 *   /            教师端 admin.html
 *   /join /s     学生端 student.html        （学生只需输入  http://<教师机IP>:8080/join）
 *   /stage /big  教室大屏 index.html
 *   /qr.png?text=… 二维码（装了 qrcode 依赖时可用，未装则 501，前端自动降级为文字地址）
 *   /health      存活探测（教师端用它判断"是否运行在本地枢纽上"）
 *
 * 环境变量：PORT（默认 8080）、HOST（默认 0.0.0.0）、NO_PERSIST=1、NO_HTTP=1、ROOM（默认 default）
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

let WebSocket = null;
try {
  WebSocket = require('ws');
} catch (e) {
  console.error('缺少依赖 ws：请在项目目录执行  npm install  后重试。');
  console.error('若已执行过 npm install，请确认当前目录就是项目目录（含 package.json）。');
  process.exit(1);
}

const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = __dirname;
const ROOM_DIR = path.join(ROOT, 'rooms');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const DB_FILE = process.env.DB_FILE || path.join(DATA_DIR, 'classroom.db');
const DEFAULT_ROOM = process.env.ROOM || 'default';
const PERSIST = process.env.NO_PERSIST !== '1';
const SERVE_STATIC = process.env.NO_HTTP !== '1';
const SERVE_TESTS = process.env.SERVE_TESTS === '1';   // 仅在跑自动化测试时开放 tests/ 与 docs/
const CMD_QUEUE_MAX = 60;

let qrcode = null;
try { qrcode = require('qrcode'); } catch (e) { qrcode = null; }

/* ------------------------------------------------------------------ *
 * 教师端本地数据库（SQLite，Node 22+ 内置 node:sqlite，零依赖）
 * · rooms 表：每房间一份 state（轻量快照）+ dump（教师端完整状态）
 * · 其余表：同一份状态的投影，用于查询/统计/导出
 * · 数据库不可用时自动退化到 v3 的 rooms/<房间>.json 文件缓存
 * ------------------------------------------------------------------ */
let db = null;
try {
  const hubdb = require(path.join(ROOT, 'packages', 'db', 'hub-db.js'));
  if (PERSIST && hubdb.available) {
    db = hubdb.createStore({ file: DB_FILE });
  } else if (!hubdb.available) {
    console.warn('提示：当前 Node 不支持 node:sqlite，本次运行退回文件缓存（rooms/*.json）');
  }
} catch (e) {
  console.warn('提示：SQLite 初始化失败（' + e.message + '），退回文件缓存');
  db = null;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon'
};

/* ------------------------------------------------------------------ *
 * 房间
 * ------------------------------------------------------------------ */

/** roomId -> { id, rev, updatedAt, payload, host, clients:Set, presence:Map, queue:[] } */
const rooms = new Map();

function safeRoom(id) {
  return String(id || DEFAULT_ROOM).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || DEFAULT_ROOM;
}

function roomFile(id) { return path.join(ROOM_DIR, safeRoom(id) + '.json'); }

function getRoom(id, create) {
  const key = safeRoom(id);
  let room = rooms.get(key);
  if (room) return room;
  if (!create) return null;
  room = { id: key, rev: 0, updatedAt: 0, payload: null, dump: null, host: null, clients: new Set(), presence: new Map(), queue: [] };

  // ① 优先从 SQLite 恢复（v4 起的主存储）
  if (db) {
    try {
      const saved = db.loadRoom(key);
      if (saved && (saved.state || saved.dump)) {
        room.payload = saved.state || null;
        room.dump = saved.dump || null;
        room.rev = Number(saved.rev) || 0;
        room.updatedAt = Number(saved.updatedAt) || 0;
      }
    } catch (e) { console.error('[db] 读取房间失败:', e.message); }
  }

  // ② 没有则回退到 v3 的 rooms/<房间>.json，并顺手迁移进库
  if (PERSIST && !room.payload && !room.dump) {
    try {
      const raw = JSON.parse(fs.readFileSync(roomFile(key), 'utf8'));
      if (raw && (raw.payload || raw.dump)) {
        room.payload = raw.payload || null;
        room.dump = raw.dump || null;
        room.rev = Number(raw.rev) || 0;
        room.updatedAt = Number(raw.updatedAt) || 0;
        db.saveRoom(room.id, { rev: room.rev, state: room.payload, dump: room.dump });
      }
    } catch (e) { /* 无历史快照 */ }
  }

  rooms.set(key, room);
  return room;
}

const saveTimers = new Map();

/** 防抖落盘：写 SQLite（主）；DB 不可用时退回 JSON 文件 */
function saveRoomSoon(room) {
  if (!PERSIST) return;
  if (saveTimers.has(room.id)) return;
  saveTimers.set(room.id, setTimeout(() => {
    saveTimers.delete(room.id);
    if (db) {
      try {
        db.saveRoom(room.id, { rev: room.rev, state: room.payload, dump: room.dump });
        return;
      } catch (e) { console.error('[db] 写入失败:', e.message); }
    }
    try {
      fs.mkdirSync(ROOM_DIR, { recursive: true });
      fs.writeFileSync(roomFile(room.id), JSON.stringify({ rev: room.rev, updatedAt: room.updatedAt, payload: room.payload, dump: room.dump }));
    } catch (e) { console.error('[room] 写入失败:', e.message); }
  }, 800));
}

/** 立即落盘（HTTP API 与进程退出时用） */
function saveRoomNow(room) {
  if (!PERSIST) return;
  if (saveTimers.has(room.id)) { clearTimeout(saveTimers.get(room.id)); saveTimers.delete(room.id); }
  if (db) {
    try { db.saveRoom(room.id, { rev: room.rev, state: room.payload, dump: room.dump }); return; } catch (e) { console.error('[db] 写入失败:', e.message); }
  }
  try {
    fs.mkdirSync(ROOM_DIR, { recursive: true });
    fs.writeFileSync(roomFile(room.id), JSON.stringify({ rev: room.rev, updatedAt: room.updatedAt, payload: room.payload, dump: room.dump }));
  } catch (e) { console.error('[room] 写入失败:', e.message); }
}

function send(ws, obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  try { ws.send(JSON.stringify(obj)); return true; } catch (e) { return false; }
}

function broadcast(room, obj, except) {
  const msg = JSON.stringify(obj);
  for (const ws of room.clients) {
    if (ws === except) continue;
    if (ws.readyState === WebSocket.OPEN) { try { ws.send(msg); } catch (e) { /* 忽略 */ } }
  }
}

function presenceList(room) {
  const teams = [];
  room.presence.forEach((info, teamId) => {
    teams.push({ teamId, label: info.label || '', online: info.online !== false, at: info.at || 0 });
  });
  teams.sort((a, b) => String(a.label).localeCompare(String(b.label), 'zh-Hans-CN'));
  return teams;
}

function pushPresence(room) {
  const msg = { type: 'presence', room: room.id, hostOnline: !!room.host, teams: presenceList(room) };
  broadcast(room, msg);
  return msg;
}

/**
 * 按角色裁剪 state：**team 只看到本队成员**，stage / host 看全量。
 *
 * 为什么（审计发现）：广播给 team 的 state 里带**全班名单** ——
 * 一个学生打开控制台就能看到「这个班有哪些人、谁在哪个队」。
 * docs/09 写着「个人成绩只发给学生自己的手机」；姓名课上会念，
 * 但完整花名册不该发给每个学生。
 *
 * 与 Rust 版（`Room::state_for`）**同口径** —— 两版必须一致，有黑盒测试盯着。
 */
function stateFor(ws, payload) {
  if (!ws || ws.role !== 'team' || !ws.teamId || !payload) return payload;
  if (!Array.isArray(payload.students)) return payload;
  return Object.assign({}, payload, {
    students: payload.students.filter((s) => s && s.teamId === ws.teamId)
  });
}

/** 按角色逐个广播 state（每条连接拿到的是裁剪后的版本） */
function broadcastState(room, except) {
  if (!room.payload) return;
  room.clients.forEach((c) => {
    if (c === except) return;
    send(c, { type: 'state', room: room.id, rev: room.rev, payload: stateFor(c, room.payload) });
  });
}

function pushState(ws, room) {
  if (!room.payload) return false;
  return send(ws, { type: 'state', room: room.id, rev: room.rev, payload: stateFor(ws, room.payload) });
}

/* ------------------------------------------------------------------ *
 * WebSocket
 * ------------------------------------------------------------------ */

const server = http.createServer(handleHttp);
const wss = new WebSocket.Server({ server, maxPayload: 8 * 1024 * 1024 });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url || '/', 'http://localhost');
  const q = url.searchParams;
  let roomId = safeRoom(q.get('room') || DEFAULT_ROOM);
  let role = ['host', 'stage', 'team'].indexOf(q.get('role')) >= 0 ? q.get('role') : 'stage';
  let teamId = q.get('team') || null;
  let label = q.get('label') || '';

  const room = getRoom(roomId, true);
  ws.roomId = room.id;
  ws.role = role;
  ws.teamId = teamId;
  ws.label = label;
  ws.isAlive = true;
  ws.clientId = 'c_' + Math.random().toString(36).slice(2, 9);

  room.clients.add(ws);
  if (role === 'host') room.host = ws;
  if (role === 'team' && teamId) {
    room.presence.set(teamId, { label: label || teamId, online: true, at: Date.now(), ws });
  }

  send(ws, {
    type: 'welcome',
    room: room.id, role: role, teamId: teamId, clientId: ws.clientId,
    serverTime: Date.now(), rev: room.rev, hasState: !!room.payload, hasDump: !!room.dump, hostOnline: !!room.host
  });
  if (role !== 'host') pushState(ws, room);

  // 教师端上线：补发排队命令 + 通知全体在线状态
  if (role === 'host') {
    if (room.queue.length) {
      send(ws, { type: 'cmd-backlog', cmds: room.queue.splice(0, room.queue.length) });
    }
    pushPresence(room);
  } else {
    pushPresence(room);
    if (room.host) send(room.host, { type: 'presence', room: room.id, hostOnline: true, teams: presenceList(room) });
  }

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (data) => {
    let msg = null;
    try { msg = JSON.parse(data); } catch (e) { return; }

    // 兼容 v2 的 {type:'leaderboard'} 裸推送（老版主控台/大屏）
    if (msg.type === 'leaderboard' && msg.payload) {
      room.payload = msg.payload;
      room.rev += 1;
      room.updatedAt = Date.now();
      saveRoomSoon(room);
      broadcastState(room, ws);
      broadcast(room, { type: 'leaderboard', room: room.id, rev: room.rev, payload: room.payload }, ws);
      return;
    }

    if (msg.type === 'state' && msg.payload) {
      if (ws.role !== 'host') { send(ws, { type: 'error', message: '只有教师端可以推送状态' }); return; }
      room.payload = msg.payload;
      /**
       * 教师端同一份数据有两条写入路径：WS 的 `state` 与 HTTP 的 PUT /api/state。
       * rev 规则必须一致，否则其中一条会被判"过期"：**客户端带了 rev 就采纳它**，
       * 没带才自增（兼容旧客户端）。
       */
      const clientRev = Number(msg.rev) || 0;
      room.rev = clientRev > 0 ? Math.max(room.rev, clientRev) : room.rev + 1;
      room.updatedAt = Date.now();
      saveRoomSoon(room);
      broadcastState(room, ws);
      // 学生端/大屏之外的订阅者：保留 leaderboard 兼容
      return;
    }

    if (msg.type === 'request') {
      if (!pushState(ws, room)) send(ws, { type: 'error', message: '暂无课堂数据（教师端还没推送）' });
      return;
    }

    // 完整课堂数据：只允许教师端写入与读取，永不广播给学生端
    if (msg.type === 'dump' && msg.payload) {
      if (ws.role !== 'host') { send(ws, { type: 'error', message: '只有教师端可以推送课堂数据' }); return; }
      room.dump = msg.payload;
      // **不要把 dump 当 state**：dump 是完整存档（含答案与全部名单），
      // 当成 state 后每个 team/stage 一连上就会拿到它 —— 等于泄题（审计实测过）。
      // 没有轻量快照时就不发 state，等教师端推。
      room.updatedAt = Date.now();
      saveRoomNow(room);        // 完整存档是"换设备恢复"的依据，立即落库（state 仍走防抖）
      return;
    }

    if (msg.type === 'request-dump') {
      if (ws.role !== 'host') { send(ws, { type: 'error', message: '只有教师端可以读取课堂数据' }); return; }
      if (room.dump) send(ws, { type: 'dump', room: room.id, rev: room.rev, payload: room.dump });
      else send(ws, { type: 'error', message: '枢纽上没有课堂数据存档' });
      return;
    }

    if (msg.type === 'cmd' && msg.cmd) {
      const cmd = Object.assign({}, msg.cmd, {
        id: msg.cmd.id || ('cmd_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)),
        at: msg.cmd.at || Date.now(),
        from: { role: ws.role, teamId: ws.teamId, label: ws.label, clientId: ws.clientId }
      });
      if (room.host && room.host.readyState === WebSocket.OPEN) {
        send(room.host, { type: 'cmd', cmd });
        send(ws, { type: 'ack', cmdId: cmd.id, ok: true });
      } else {
        room.queue.push(cmd);
        if (room.queue.length > CMD_QUEUE_MAX) room.queue.shift();
        send(ws, { type: 'ack', cmdId: cmd.id, ok: false, reason: 'teacher-offline' });
      }
      return;
    }

    if (msg.type === 'hello') {
      if (msg.role && ['host', 'stage', 'team'].indexOf(msg.role) >= 0) {
        ws.role = msg.role;
        if (msg.role === 'host') { room.host = ws; }
      }
      if (msg.teamId) {
        ws.teamId = msg.teamId;
        ws.label = msg.label || ws.label;
        room.presence.set(ws.teamId, { label: ws.label || ws.teamId, online: true, at: Date.now(), ws });
      }
      send(ws, { type: 'welcome', room: room.id, role: ws.role, teamId: ws.teamId, clientId: ws.clientId, serverTime: Date.now(), rev: room.rev, hasState: !!room.payload, hasDump: !!room.dump, hostOnline: !!room.host });
      pushState(ws, room);
      pushPresence(room);
      return;
    }
  });

  ws.on('close', () => {
    room.clients.delete(ws);
    if (room.host === ws) {
      room.host = null;
      pushPresence(room);
    }
    if (ws.role === 'team' && ws.teamId) {
      const info = room.presence.get(ws.teamId);
      if (info && info.ws === ws) {
        // 同一队伍可能开了多个设备：还有其它连接就保持在线
        let stillOnline = false;
        room.clients.forEach((other) => { if (other.teamId === ws.teamId && other.role === 'team') stillOnline = true; });
        if (!stillOnline) room.presence.set(ws.teamId, { label: info.label, online: false, at: Date.now() });
      }
      pushPresence(room);
    }
  });

  ws.on('error', () => { try { ws.close(); } catch (e) { /* 忽略 */ } });
});

// 心跳：清理假连接
setInterval(() => {
  for (const room of rooms.values()) {
    for (const ws of room.clients) {
      if (ws.isAlive === false) { room.clients.delete(ws); try { ws.terminate(); } catch (e) {} continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch (e) { /* 忽略 */ }
    }
  }
}, 30000);

/* ------------------------------------------------------------------ *
 * HTTP
 * ------------------------------------------------------------------ */

function sendFile(res, filePath, status) {
  const ext = path.extname(filePath).toLowerCase();
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found: ' + path.basename(filePath));
      return;
    }
    res.writeHead(status || 200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=60'
    });
    res.end(buf);
  });
}

function sendJSON(res, obj, status) {
  const body = JSON.stringify(obj);
  res.writeHead(status || 200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS'
  });
  res.end(body);
}

function safeStats() {
  try { return db.stats(); } catch (e) { return null; }
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > (limit || 16 * 1024 * 1024)) { reject(Object.assign(new Error('请求体过大'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve(null);
      try { resolve(JSON.parse(text)); } catch (e) { reject(Object.assign(new Error('JSON 解析失败：' + e.message), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

/**
 * 教师端本地数据接口（桌面 App 与网页版共用）
 *   GET  /api/state?room=default          → {rev, updatedAt, state, dump}
 *   PUT  /api/state?room=default          ← {rev?, state?, dump?}   写入并广播
 *   GET  /api/backup?room=default         → ci-backup JSON
 *   POST /api/restore?room=default        ← ci-backup（或裸 state）
 *   GET  /api/stats?room=default          → 行数统计 + 学情视图
 */
async function handleApi(req, res, urlPath, query) {
  if (req.method === 'OPTIONS') return sendJSON(res, { ok: true });

  const roomId = safeRoom(query.get('room') || DEFAULT_ROOM);
  const room = getRoom(roomId, true);

  try {
    if (urlPath === '/api/state') {
      if (req.method === 'GET') {
        // **dump 只发给回环请求**：它是完整存档（含答案与全量流水）。教师机自己就是枢纽，
        // 它的请求来自 127.0.0.1；学生/大屏/别的设备在局域网里，只给轻量 state。
        // 与 WS 侧「只有 host 能取 dump」同一思路（审计发现 HTTP 侧漏了）。
        const loopback = /^(127\.|::1$|::ffff:127\.)/.test(String(req.socket.remoteAddress || ""));
        return sendJSON(res, {
          ok: true, room: roomId, rev: room.rev, updatedAt: room.updatedAt,
          storage: db ? 'sqlite' : 'memory',
          state: room.payload,
          ...(loopback ? { dump: room.dump } : {})
        });
      }
      if (req.method === 'PUT' || req.method === 'POST') {
        const body = await readBody(req);
        if (!body || typeof body !== 'object') return sendJSON(res, { ok: false, message: '缺少请求体' }, 400);

        // 过期写入防护（多写者：教师端页面 + 客户端 + 换设备后的另一台机器）
        // 客户端带上自己的 rev，若比枢纽当前的小，说明它基于旧数据，直接拒绝而不是覆盖，
        // 否则"老设备一提交就把新数据抹掉"。
        const clientRev = Number(body.rev) || 0;
        if (clientRev && clientRev < room.rev) {
          return sendJSON(res, {
            ok: false,
            stale: true,
            room: roomId,
            rev: room.rev,
            updatedAt: room.updatedAt,
            message: '枢纽上已有更新的数据（rev ' + room.rev + ' > 你的 ' + clientRev + '），本次未覆盖；请先拉取最新状态'
          }, 409);
        }

        if (body.state !== undefined && body.state !== null) room.payload = body.state;
        if (body.dump !== undefined && body.dump !== null) room.dump = body.dump;
        // 与 WS 路径同一套 rev 规则：带 rev 就采纳，没带才自增
        room.rev = clientRev > 0 ? Math.max(room.rev, clientRev) : room.rev + 1;
        room.updatedAt = Date.now();
        saveRoomNow(room);
        // 让已连接的大屏/学生端立刻看到新数据
        broadcastState(room, undefined);
        return sendJSON(res, { ok: true, room: roomId, rev: room.rev, updatedAt: room.updatedAt, counts: safeStats() });
      }
      return sendJSON(res, { ok: false, message: '不支持的方法' }, 405);
    }

    if (urlPath === '/api/backup') {
      // 方法校验（审计发现：原来没有 —— GET /api/restore 这类「用 GET 触发写操作」可达）
      if (!(req.method === 'GET')) {
        return sendJSON(res, { ok: false, message: '备份（读）只支持 GET' }, 405);
      }
      if (!db) return sendJSON(res, { ok: false, message: '当前未启用 SQLite' }, 501);
      const backup = db.exportBackup(roomId);
      if (!backup) return sendJSON(res, { ok: false, message: '该房间还没有数据' }, 404);
      return sendJSON(res, backup);
    }

    if (urlPath === '/api/restore') {
      // 方法校验（审计发现：原来没有 —— GET /api/restore 这类「用 GET 触发写操作」可达）
      if (!(req.method === 'POST')) {
        return sendJSON(res, { ok: false, message: '恢复（写）只支持 POST' }, 405);
      }
      const body = await readBody(req);
      const state = body && body.state ? body.state : body;
      if (!state || typeof state !== 'object') return sendJSON(res, { ok: false, message: '备份格式不正确' }, 400);
      // 导入的是"整份课堂数据"：dump 与轻量快照都要替换，
      // 否则大屏/学生端会继续显示导入前的旧数据，直到教师端下次推送（换设备恢复时尤其明显）
      room.dump = state;
      room.payload = state;
      room.rev += 1;
      room.updatedAt = Date.now();
      saveRoomNow(room);
      broadcastState(room, undefined);
      return sendJSON(res, { ok: true, room: roomId, rev: room.rev, counts: safeStats() });
    }

    if (urlPath === '/api/stats') {
      // 方法校验（审计发现：原来没有 —— GET /api/restore 这类「用 GET 触发写操作」可达）
      if (!(req.method === 'GET')) {
        return sendJSON(res, { ok: false, message: '统计（读）只支持 GET' }, 405);
      }
      if (!db) return sendJSON(res, { ok: false, message: '当前未启用 SQLite' }, 501);
      return sendJSON(res, {
        ok: true, room: roomId,
        counts: safeStats(),
        scores: db.scores(roomId).slice(0, 100),
        studentTier: db.studentTier(roomId),
        rooms: db.listRooms()
      });
    }

    return sendJSON(res, { ok: false, message: '未知接口：' + urlPath }, 404);
  } catch (e) {
    // 审计发现：原来一律 500 —— 但"JSON 解析失败"是请求错了（400），
    // "请求体过大"是 413。500 会让客户端以为可以重试，而重试永远不会成功。
    return sendJSON(res, { ok: false, message: e.message }, Number(e && e.status) || 500);
  }
}

function localIPs() {
  const out = [];
  const ifaces = os.networkInterfaces();
  const isPrivate = (ip) => /^192\.168\./.test(ip) || /^10\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
  Object.keys(ifaces).forEach((name) => {
    (ifaces[name] || []).forEach((info) => {
      if (info.family === 'IPv4' && !info.internal) out.push({ name, address: info.address, private: isPrivate(info.address) });
    });
  });
  // 常见局域网/组网地址优先（教室里的学生大概率走这些网段）
  out.sort((a, b) => (b.private ? 1 : 0) - (a.private ? 1 : 0));
  return out;
}

function handleHttp(req, res) {
  let urlPath;
  let query = null;
  try {
    const u = new URL(req.url || '/', 'http://localhost');
    urlPath = decodeURIComponent(u.pathname);
    query = u.searchParams;
  } catch (e) { urlPath = '/'; query = new URLSearchParams(); }

  // 本地客户端（教师端 App / 网页版）读写 SQLite 的接口。桌面 App 与 file:// 页面需要跨源，故开放 CORS。
  if (urlPath.indexOf('/api/') === 0) return handleApi(req, res, urlPath, query);

  if (urlPath === '/health') {
    return sendJSON(res, {
      ok: true, service: 'classroom-hub', port: PORT,
      rooms: [...rooms.keys()], ips: localIPs().map((x) => x.address),
      qrcode: !!qrcode, uptime: Math.round(process.uptime()),
      storage: db ? 'sqlite' : (PERSIST ? 'json-file' : 'memory'),
      db: db ? path.basename(db.file) : null,
      counts: db ? safeStats() : null
    });
  }

  if (urlPath === '/qr.png') {
    if (!qrcode) return sendJSON(res, { ok: false, message: '未安装 qrcode 依赖，请用文字地址访问' }, 501);
    let text = DEFAULT_ROOM;
    try { text = new URL(req.url, 'http://localhost').searchParams.get('text') || DEFAULT_ROOM; } catch (e) { /* 用默认 */ }
    return qrcode.toBuffer(text, { type: 'png', width: 260, margin: 1 }, (err, buf) => {
      if (err) return sendJSON(res, { ok: false, message: err.message }, 500);
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
      res.end(buf);
    });
  }

  if (!SERVE_STATIC) {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('课堂枢纽运行中（静态托管已关闭）。WebSocket 端口：' + PORT);
    return;
  }

  /* ------------------------------------------------------------------ *
   * 主路径 → **Vue 构建产物**（2026-10 起界面已统一到 Vue）
   *
   * 入口文件名沿用旧约定（admin.html / student.html / index.html），
   * 所以 URL 一个都没变：/ 、/join 、/stage 与以前完全一样。
   * ------------------------------------------------------------------ */
  const DIST_DIR = path.join(ROOT, 'web', 'dist');
  const distFile = (name) => path.join(DIST_DIR, name);
  const hasDistRoot = fs.existsSync(distFile('admin.html'));

  if (urlPath === '/' || urlPath === '/admin' || urlPath === '/admin.html') {
    return sendFile(res, hasDistRoot ? distFile('admin.html') : path.join(ROOT, 'admin.html'));
  }
  if (urlPath === '/join' || urlPath === '/s' || urlPath === '/student') {
    return sendFile(res, hasDistRoot ? distFile('student.html') : path.join(ROOT, 'student.html'));
  }
  if (urlPath === '/stage' || urlPath === '/big' || urlPath === '/screen') {
    return sendFile(res, hasDistRoot ? distFile('index.html') : path.join(ROOT, 'index.html'));
  }
  // Vite 产物里的静态资源（相对路径引用，落在同目录）
  if (urlPath === '/favicon.svg' && hasDistRoot) return sendFile(res, distFile('favicon.svg'));
  if (urlPath.startsWith('/assets/') && hasDistRoot) return sendFile(res, path.join(DIST_DIR, urlPath.replace(/^\/+/, '')));

  /**
   * v4 新版界面（Vue 3 + Element Plus / Vant）构建产物。
   * 迁移期挂在 /next/ 下与旧页面并存：
   *   /next/        → 教师端（新版）
   *   /next/join    → 学生端（新版）
   *   /next/stage   → 大屏（新版）
   * 全部迁移完成后把这里改名为根路径，并删除旧的三个 HTML 与 assets/js 里的旧渲染层。
   */
  const DIST = path.join(ROOT, 'web', 'dist');
  const hasDist = fs.existsSync(path.join(DIST, 'admin.html'));

  /**
   * 新版界面还没构建时，别丢一个光秃秃的 404 —— 那是"克隆下来以为跑不起来"的头号原因。
   * 这里给一页说明：怎么构建、旧界面在哪。
   */
  if (!hasDist && (urlPath === '/next' || urlPath.startsWith('/next/'))) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end([
      '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">',
      '<title>新版界面还没构建</title>',
      '<style>body{font-family:system-ui,-apple-system,"Microsoft YaHei",sans-serif;max-width:640px;margin:64px auto;padding:0 20px;color:#1a1d24;line-height:1.9}',
      'code{background:#f1f5f9;padding:2px 6px;border-radius:6px}',
      'pre{background:#0f172a;color:#e2e8f0;padding:14px;border-radius:10px;overflow:auto}',
      'a{color:#4f46e5}</style></head><body>',
      '<h2>新版界面还没有构建</h2>',
      '<p>新版（Vue 3）界面是<strong>构建产物</strong>，<code>web/dist</code> 按惯例不入版本库，' +
      '所以克隆下来第一次访问 <code>/next/</code> 会是空的。</p>',
      '<p>构建一次即可（约 10 秒）：</p>',
      '<pre>npm run web:build</pre>',
      '<p>或者直接用 <code>npm start</code> 启动 —— 它会检测到缺失并自动构建。</p>',
      '<hr><p>现在就可以用的旧界面：' +
      '<a href="/admin.html">教师端 /admin.html</a> · ' +
      '<a href="/join">学生端 /join</a> · ' +
      '<a href="/stage">大屏 /stage</a></p>',
      '</body></html>'
    ].join('\n'));
    return;
  }

  if (hasDist && (urlPath === '/next' || urlPath.startsWith('/next/'))) {
    const rest = urlPath.slice('/next'.length) || '/';
    if (rest === '/' || rest === '/admin' || rest === '/admin.html') return sendFile(res, path.join(DIST, 'admin.html'));
    if (rest === '/join' || rest === '/student' || rest === '/student.html') return sendFile(res, path.join(DIST, 'student.html'));
    if (rest === '/stage' || rest === '/screen' || rest === '/index.html') return sendFile(res, path.join(DIST, 'index.html'));
    const sub = path.resolve(DIST, '.' + rest);
    if (sub.startsWith(DIST + path.sep)) return sendFile(res, sub);
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 Forbidden');
    return;
  }

  const target = path.resolve(ROOT, '.' + urlPath);
  const insideRoot = target === ROOT || target.startsWith(ROOT + path.sep);
  const hasDotSegment = urlPath.split('/').some((seg) => seg.startsWith('.') && seg !== '.');
  // data/ 放的是**实时课堂数据库**（classroom.db + -wal），绝不能当静态资源发出去
  // （审计实测：GET /data/classroom.db 能下到 344KB 的 SQLite —— Rust 侧同源问题已修）
  const blockedDirs = SERVE_TESTS
    ? ['rooms', 'node_modules', 'data']
    : ['rooms', 'node_modules', 'data', 'tests', 'docs'];
  // 数据库文件一律不发（不论在哪个目录）
  const lowPath = urlPath.toLowerCase();
  const blockedFile = lowPath.endsWith('.db') || lowPath.endsWith('.db-wal')
    || lowPath.endsWith('.db-shm') || lowPath.endsWith('.sqlite');
  const blocked = blockedDirs.some((dir) => target.startsWith(path.join(ROOT, dir)));

  if (!insideRoot || hasDotSegment || blocked || blockedFile) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 Forbidden');
    return;
  }
  fs.stat(target, (err, stat) => {
    if (!err && stat.isDirectory()) return sendFile(res, path.join(target, 'index.html'));
    sendFile(res, target);
  });
}

function handleFatal(err) {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用：请关闭占用该端口的程序，或换端口启动，例如  $env:PORT=8090; npm start`);
  } else {
    console.error('服务启动失败：', err && err.message ? err.message : err);
  }
  process.exit(1);
}
server.on('error', handleFatal);
wss.on('error', handleFatal);

server.listen(PORT, HOST, () => {
  const ips = localIPs();
  const lan = ips.length ? ips[0].address : '127.0.0.1';
  console.log('课堂枢纽已启动（教师机本地，无需公网服务器）');
  console.log(`  教师端 : http://localhost:${PORT}/admin.html`);
  console.log(`  学生端 : http://${lan}:${PORT}/join    ← 学生手机/平板输入这个地址（或用 EasyTier 虚拟 IP）`);
  console.log(`  大屏   : http://localhost:${PORT}/stage`);
  // 新版（Vue 3）界面是构建产物，克隆后可能还没构建 —— 启动时直接说清楚，别让人以为跑不起来
  const distReady = fs.existsSync(path.join(ROOT, 'web', 'dist', 'admin.html'));
  console.log('  新版   : ' + (distReady
    ? `http://localhost:${PORT}/next/admin.html   ← Vue 3 新版界面（教师端）`
    : '未构建 → 运行 npm run web:build，或下次直接用 npm start 启动（会自动构建）'));
  console.log(`  房间   : ${DEFAULT_ROOM}（教师端可改；学生端用 ?room=xxx 进入指定房间）`);
  console.log(`  二维码 : ${qrcode ? '可用（/qr.png?text=…）' : '不可用（npm i qrcode 后启用，界面会降级显示文字地址）'}`);
  if (ips.length > 1) console.log('  其它网卡: ' + ips.map((x) => x.address).join(', ') + '  ← 多网卡/EasyTier 时学生端改用其一');
  console.log(`  快照   : ${PERSIST ? path.join(ROOM_DIR, '<房间>.json') : '已关闭（NO_PERSIST=1）'}`);
});
