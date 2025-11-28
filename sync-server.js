const WebSocket = require('ws');
const port = process.env.PORT ? Number(process.env.PORT) : 8080;
const wss = new WebSocket.Server({ port });
const clients = new Set();
let lastLeaderboard = null;

wss.on('connection', (ws) => {
  clients.add(ws);
  // 新连接若已有快照，主动推送
  if (lastLeaderboard) {
    try { ws.send(JSON.stringify({ type: 'leaderboard', payload: lastLeaderboard })); } catch {}
  }
  ws.on('message', (data) => {
    let msg = null;
    try { msg = JSON.parse(data); } catch {}
    if (msg && msg.type === 'leaderboard' && msg.payload) {
      lastLeaderboard = msg.payload; // 记录最新快照
    } else if (msg && msg.type === 'request') {
      // 单独响应请求方，若有快照
      if (lastLeaderboard) {
        try { ws.send(JSON.stringify({ type: 'leaderboard', payload: lastLeaderboard })); } catch {}
      }
    }
    // 广播给其他客户端
    for (const c of clients) {
      if (c !== ws && c.readyState === WebSocket.OPEN) c.send(data);
    }
  });
  ws.on('close', () => clients.delete(ws));
});
// 周期性广播快照，保证客户端持续刷新
setInterval(() => {
  if (!lastLeaderboard) return;
  const msg = JSON.stringify({ type: 'leaderboard', payload: lastLeaderboard });
  for (const c of clients) {
    if (c.readyState === WebSocket.OPEN) {
      try { c.send(msg); } catch {}
    }
  }
}, 1000);
console.log(`ws://0.0.0.0:${port}`);
