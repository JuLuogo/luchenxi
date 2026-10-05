/*!
 * tests/feat-role-scoped-state.cjs — 按角色下发 state（隐私彻底版）
 *
 *   现状（审计）：广播给 team 的 state 里带**全班名单** ——
 *   一个学生打开控制台就能看到"这个班有哪些人、谁在哪个队"。
 *   docs/09 写着"个人成绩只发给学生自己的手机"，姓名虽然课上会念，
 *   但完整花名册不该发给每个学生。
 *
 *   做法：**在枢纽按角色裁剪** —— team 只看到本队成员，stage/host 看全量。
 *   · 为什么在枢纽而不是教师端：一份 state 要发给所有人，教师端发不出"每人不同"的版本
 *   · 为什么 stage 不裁：它是教室公共屏（且已经拿掉了个人分数），没有队伍身份可裁
 *
 *   node tests/feat-role-scoped-state.cjs
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
let n = 0;

const p = path.join(ROOT, 'crates/ci-hub/src/lib.rs');
const raw = fs.readFileSync(p, 'utf8');
if (raw.includes('fn state_for')) { console.log('  · 已实现'); process.exit(0); }
const EOL = raw.includes('\r\n') ? '\r\n' : '\n';
const lines = raw.split(/\r?\n/);

/* ① 在 broadcast 之后加 state_for + broadcast_state */
const i = lines.findIndex((l) => /^    pub fn broadcast\(&self, msg: Value, except: Option<u64>\) \{/.test(l));
if (i < 0) { console.log('  · 找不到 broadcast'); process.exit(0); }
let e = -1;
for (let k = i; k < i + 12; k++) { if (/^    \}$/.test(lines[k])) { e = k; break; } }
if (e < 0) { console.log('  · 找不到 broadcast 结尾'); process.exit(0); }

const block = [
  '',
  '    /// 按角色裁剪 state：**team 只看到本队成员**，stage / host 看全量。',
  '    ///',
  '    /// 为什么（审计发现）：广播给 team 的 state 里带**全班名单** ——',
  '    /// 一个学生打开控制台就能看到「这个班有哪些人、谁在哪个队」。',
  '    /// docs/09 写着「个人成绩只发给学生自己的手机」；姓名课上会念，',
  '    /// 但完整花名册不该发给每个学生。',
  '    ///',
  '    /// 为什么在枢纽裁而不是教师端：一份 state 要发给所有人，',
  '    /// 教师端发不出「每人不同」的版本。',
  '    /// 为什么 stage 不裁：它是教室公共屏（且已拿掉个人分数），没有队伍身份可裁。',
  '    pub fn state_for(&self, id: u64, payload: &Value) -> Value {',
  '        let c = match self.clients.get(&id) {',
  '            Some(c) => c,',
  '            None => return payload.clone(),',
  '        };',
  '        if c.role != "team" {',
  '            return payload.clone();',
  '        }',
  '        let team = match c.team_id.as_deref() {',
  '            Some(t) => t,',
  '            None => return payload.clone(),',
  '        };',
  '        let mut out = payload.clone();',
  '        if let Some(list) = out.get_mut("students").and_then(|v| v.as_array_mut()) {',
  '            list.retain(|s| s.get("teamId").and_then(|v| v.as_str()) == Some(team));',
  '        }',
  '        out',
  '    }',
  '',
  '    /// 按角色逐个发送 state（每条连接拿到的是**裁剪后**的版本）',
  '    pub fn broadcast_state(&self, room: &str, rev: i64, payload: &Value, except: Option<u64>) {',
  '        for (id, c) in self.clients.iter() {',
  '            if Some(*id) == except {',
  '                continue;',
  '            }',
  '            let p = self.state_for(*id, payload);',
  '            let _ = c.tx.send(json!({ "type": "state", "room": room, "rev": rev, "payload": p }));',
  '        }',
  '    }'
];
lines.splice(e + 1, 0, ...block);
n += 1;
console.log('  [ok] 加了 state_for + broadcast_state（第 ' + (e + 2) + ' 行起）');

/* ② 三个 broadcast 点改成 broadcast_state */
const bcast = [
  { from: 'r.broadcast(json!({ "type": "state", "room": room, "rev": rev, "payload": payload }), None);', to: 'r.broadcast_state(&room, rev, &payload, None);' },
  { from: 'r.broadcast(json!({ "type": "state", "room": room, "rev": rev, "payload": state }), None);', to: 'r.broadcast_state(&room, rev, &state, None);' },
  { from: 'r.broadcast(json!({ "type": "state", "room": room_id, "rev": rev, "payload": payload }), Some(client_id))', to: 'r.broadcast_state(room_id, rev, &payload, Some(client_id))' }
];
for (const b of bcast) {
  const k = lines.findIndex((l) => l.includes(b.from));
  if (k < 0) { console.log('  · 未匹配 broadcast：' + b.from.slice(0, 60)); continue; }
  lines[k] = lines[k].replace(b.from, b.to);
  n += 1;
  console.log('  [ok] broadcast → broadcast_state（第 ' + (k + 1) + ' 行）');
}

/* ③ 三个 send_to 点也裁一下 */
const sends = [
  'r.send_to(client_id, json!({ "type": "state", "room": room_id, "rev": rev, "payload": state }));',
  'r.send_to(client_id, json!({ "type": "state", "room": room_id, "rev": rev, "payload": p }));'
];
for (const s of sends) {
  let k = -1;
  while ((k = lines.findIndex((l, idx) => idx > k && l.includes(s))) >= 0) {
    const indent = (lines[k].match(/^\s*/) || [''])[0];
    lines[k] = indent + 'let scoped = r.state_for(client_id, &' + (s.includes('payload: state') ? 'state' : 'p') + ');';
    lines.splice(k + 1, 0, indent + s.replace('"payload": ' + (s.includes('payload: state') ? 'state' : 'p'), '"payload": scoped'));
    n += 1;
    console.log('  [ok] send_to 裁剪（第 ' + (k + 1) + ' 行）');
  }
}

fs.writeFileSync(p, lines.join(EOL), 'utf8');
console.log('  共改 ' + n + ' 处');
