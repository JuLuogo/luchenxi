/*!
 * packages/db/hub-db.js — 教师端本地 SQLite 持久层（Node 内置 node:sqlite，零依赖）
 *
 *  设计：
 *   · rooms 表保存两份 JSON：state（同步给大屏/学生端的轻量快照）与 dump（教师端完整状态）
 *   · 其余表是同一份 dump 状态的"投影"，用于查询与统计（学情分析、导出、排查）
 *   · 所有写入都在一个事务里完成：JSON 与投影要么一起生效，要么都不生效
 *  Rust 侧（apps/teacher/src-tauri）将实现同样的表结构与语义，schema 见 packages/db/schema.sql
 */
'use strict';

const fs = require('fs');
const path = require('path');

function loadSqlite() {
  try { return require('node:sqlite'); } catch (e) { return null; }
}

const { DatabaseSync } = loadSqlite() || {};

/** 打开数据库并建表；返回 { db, file, close, ... } */
function open(file, schemaPath) {
  if (!DatabaseSync) throw new Error('当前 Node 不支持 node:sqlite（需要 Node 22+）');
  const dir = path.dirname(file);
  if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(file);
  const schema = fs.readFileSync(schemaPath || path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);
  db.prepare('INSERT OR IGNORE INTO meta(key, value) VALUES (?, ?)').run('schema_version', '1');
  return db;
}

const json = (v) => JSON.stringify(v === undefined ? null : v);
const parse = (v, dft) => { try { return v === null || v === undefined ? dft : JSON.parse(v); } catch (e) { return dft; } };
const bool = (v) => (v ? 1 : 0);
/**
 * node:sqlite 不接受 `undefined` 作为绑定值（与 better-sqlite3 不同，会整笔事务失败）。
 * 真实课堂数据里"学生没分队伍""题目没选项""流水没有 by"都很常见，
 * 所以所有可空字段一律经这里转成 null。
 */
const nn = (v) => (v === undefined ? null : v);

/* ------------------------------------------------------------------ *
 * 写入：把一份完整状态投影到各表
 * ------------------------------------------------------------------ */

function project(db, roomId, state) {
  const run = (sql, ...args) => db.prepare(sql).run(...args);

  // 清掉旧的投影（JSON 是权威，投影只是派生数据）
  ['tiers', 'tags', 'teams', 'students', 'questions', 'quizzes', 'records',
    'classroom_pending', 'classroom_buzz', 'classroom_feed', 'roll_history',
    'runtime', 'settings', 'roll_state', 'logs'].forEach((t) => {
    if (t === 'logs') return;                     // 日志是追加型，不随快照重建
    run(`DELETE FROM ${t} WHERE room_id = ?`, roomId);
  });

  (state.tiers || []).forEach((t, i) => {
    run('INSERT INTO tiers(room_id,key,label,weight,color,descr,sort) VALUES (?,?,?,?,?,?,?)',
      roomId, nn(t.key), nn(t.label), nn(t.weight), nn(t.color), nn(t.desc), i);
  });
  (state.tags || []).forEach((name, i) => {
    run('INSERT OR REPLACE INTO tags(room_id,name,sort) VALUES (?,?,?)', roomId, nn(name), i);
  });
  (state.teams || []).forEach((t, i) => {
    run('INSERT INTO teams(room_id,id,name,icon,color,sort) VALUES (?,?,?,?,?,?)',
      roomId, nn(t.id), nn(t.name), nn(t.icon), nn(t.color), nn(t.order === undefined ? i : t.order));
  });
  (state.students || []).forEach((s) => {
    run('INSERT INTO students(room_id,id,name,team_id,active,joined_at) VALUES (?,?,?,?,?,?)',
      roomId, nn(s.id), nn(s.name), nn(s.teamId), bool(s.active !== false), nn(s.joinedAt) || 0);
  });
  (state.bank || []).forEach((q) => {
    run(`INSERT INTO questions(room_id,id,tier,points,stem,answer,options,tags,source,note,archived,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      roomId, nn(q.id), nn(q.tier), q.points === null || q.points === undefined ? null : q.points,
      nn(q.stem), nn(q.answer), json(q.options || []), json(q.tags || []), nn(q.source), nn(q.note), bool(q.archived), nn(q.createdAt) || 0);
  });

  let recCount = 0;
  (state.quizzes || []).forEach((qz) => {
    const kind = qz.name && qz.name.indexOf('快捷记分') === 0 ? 'collector'
      : (qz.name && qz.name.indexOf('历史积分') === 0 ? 'legacy' : 'normal');
    run('INSERT INTO quizzes(room_id,id,name,note,kind,created_at,closed_at,question_ids) VALUES (?,?,?,?,?,?,?,?)',
      roomId, nn(qz.id), nn(qz.name), nn(qz.note), kind, nn(qz.createdAt) || 0, nn(qz.closedAt) || 0, json(qz.questionIds || []));
    (qz.records || []).forEach((r) => {
      recCount++;
      run(`INSERT INTO records(room_id,id,sid,qid,tier,quiz_id,result,base,ratio,points,source,note,at,by_who)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        roomId, nn(r.id), nn(r.sid), nn(r.qid), nn(r.tier), nn(r.quizId), nn(r.result), nn(r.base), nn(r.ratio),
        nn(r.points), nn(r.source), nn(r.note), nn(r.at) || 0, nn(r.by));
    });
  });

  const cls = state.classroom || {};
  (cls.pending || []).forEach((p) => {
    run('INSERT INTO classroom_pending(room_id,id,sid,team_id,qid,quiz_id,answer,auto,at) VALUES (?,?,?,?,?,?,?,?,?)',
      roomId, nn(p.id), nn(p.sid), nn(p.teamId), nn(p.qid), nn(p.quizId), nn(p.answer), bool(p.auto), nn(p.at) || 0);
  });
  (cls.buzz || []).forEach((b) => {
    run('INSERT INTO classroom_buzz(room_id,id,team_id,qid,sid,at,by_who) VALUES (?,?,?,?,?,?,?)',
      roomId, nn(b.id), nn(b.teamId), nn(b.qid), nn(b.sid), nn(b.at) || 0, nn(b.by));
  });
  (cls.feed || []).forEach((f) => {
    run('INSERT INTO classroom_feed(room_id,id,at,kind,team_id,sid,qid,result,answer,points,auto,text) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      roomId, nn(f.id), nn(f.at) || 0, nn(f.kind), nn(f.teamId), nn(f.sid), nn(f.qid), nn(f.result),
      nn(f.answer), nn(f.points), bool(f.auto), nn(f.text));
  });

  ((state.rollcall && state.rollcall.history) || []).forEach((h) => {
    run('INSERT INTO roll_history(room_id,id,sid,at,quiz_id,qid) VALUES (?,?,?,?,?,?)',
      roomId, nn(h.id), nn(h.sid), nn(h.at) || 0, nn(h.quizId), nn(h.qid));
  });
  if (state.rollcall) {
    const rc = Object.assign({}, state.rollcall);
    delete rc.history;
    run('INSERT OR REPLACE INTO roll_state(room_id,json) VALUES (?,?)', roomId, json(rc));
  }

  Object.keys(state.runtime || {}).forEach((k) => {
    run('INSERT OR REPLACE INTO runtime(room_id,key,value) VALUES (?,?,?)', roomId, k, json(state.runtime[k]));
  });
  Object.keys(state.settings || {}).forEach((k) => {
    run('INSERT OR REPLACE INTO settings(room_id,key,value) VALUES (?,?,?)', roomId, k, json(state.settings[k]));
  });

  return { students: (state.students || []).length, questions: (state.bank || []).length, records: recCount };
}

/** 追加日志（不重建，保留历史） */
function appendLogs(db, roomId, logs) {
  const ins = db.prepare('INSERT INTO logs(room_id, ts, type, detail) VALUES (?,?,?,?)');
  (logs || []).forEach((l) => ins.run(roomId, l.ts || Date.now(), l.type || '', l.detail || ''));
}

/* ------------------------------------------------------------------ *
 * 对外 API
 * ------------------------------------------------------------------ */

function createStore(opts) {
  opts = opts || {};
  const file = opts.file || path.join(process.cwd(), 'data', 'classroom.db');
  const db = open(file, opts.schemaPath);

  return {
    kind: 'sqlite',
    file: file,
    raw: db,

    /** 保存房间快照：state（轻量）/ dump（完整，可选） */
    saveRoom(roomId, payload) {
      const rev = Number(payload && payload.rev) || 0;
      const now = Date.now();
      const stateJson = payload && payload.state ? json(payload.state) : json(null);
      const dumpJson = payload && payload.dump ? json(payload.dump) : null;

      db.exec('BEGIN');
      try {
        db.prepare(`INSERT INTO rooms(room_id, rev, updated_at, state_json, dump_json, room_name)
                    VALUES (?,?,?,?,?,?)
                    ON CONFLICT(room_id) DO UPDATE SET
                      rev = excluded.rev,
                      updated_at = excluded.updated_at,
                      state_json = COALESCE(excluded.state_json, rooms.state_json),
                      dump_json  = COALESCE(excluded.dump_json, rooms.dump_json),
                      room_name  = COALESCE(excluded.room_name, rooms.room_name)`)
          .run(roomId, rev, now, stateJson, dumpJson, (payload && payload.state && payload.state.courseName) || null);

        const full = payload && payload.dump;
        if (full) {
          project(db, roomId, full);
          if (full.logs && full.logs.length) appendLogs(db, roomId, full.logs.slice(-50));
        }
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      return { rev: rev, updatedAt: now };
    },

    loadRoom(roomId) {
      const row = db.prepare('SELECT * FROM rooms WHERE room_id = ?').get(roomId);
      if (!row) return null;
      return {
        rev: row.rev,
        updatedAt: row.updated_at,
        state: parse(row.state_json, null),
        dump: parse(row.dump_json, null)
      };
    },

    listRooms() {
      return db.prepare('SELECT room_id, rev, updated_at FROM rooms ORDER BY updated_at DESC').all();
    },

    /** 学情下推：每生每题型统计（等价于 v_student_tier 视图） */
    studentTier(roomId) {
      return db.prepare('SELECT * FROM v_student_tier WHERE room_id = ? ORDER BY sid, tier').all(roomId);
    },

    /** 学生总分（含没有流水的新生，分数为 0） */
    scores(roomId) {
      return db.prepare(`
        SELECT s.room_id, s.id AS sid, s.name, s.team_id, COALESCE(v.score, 0) AS score
        FROM students s
        LEFT JOIN v_student_score v ON v.room_id = s.room_id AND v.sid = s.id
        WHERE s.room_id = ?
        ORDER BY score DESC, s.name`).all(roomId);
    },

    /** 导出与网页版一致的备份结构 */
    exportBackup(roomId) {
      const room = this.loadRoom(roomId);
      if (!room || !room.dump) return null;
      return { type: 'ci-backup', version: 3, exportedAt: new Date().toISOString(), state: room.dump };
    },

    importBackup(roomId, backup) {
      const state = backup && backup.state ? backup.state : backup;
      if (!state || typeof state !== 'object') throw new Error('备份格式不正确');
      return this.saveRoom(roomId, { rev: Date.now(), state: state, dump: state });
    },

    stats() {
      const one = (sql, ...a) => { const r = db.prepare(sql).get(...a); return r ? Object.values(r)[0] : 0; };
      return {
        rooms: one('SELECT COUNT(*) FROM rooms'),
        students: one('SELECT COUNT(*) FROM students'),
        teams: one('SELECT COUNT(*) FROM teams'),
        questions: one('SELECT COUNT(*) FROM questions'),
        quizzes: one('SELECT COUNT(*) FROM quizzes'),
        records: one('SELECT COUNT(*) FROM records'),
        logs: one('SELECT COUNT(*) FROM logs')
      };
    },

    close() { try { db.close(); } catch (e) { /* 忽略 */ } }
  };
}

module.exports = { createStore, open, project, available: !!DatabaseSync };
