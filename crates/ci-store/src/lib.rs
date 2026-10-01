/*!
 * 教师端 Rust 侧：本地 SQLite 持久层
 *
 *  与 Node 版（packages/db/hub-db.js）共用同一份建表脚本 schema.sql（构建前由 scripts/sync-ui.mjs 拷到 crate 根）。
 *  数据模型：rooms 表保存 state（轻量快照）/ dump（完整状态）两份 JSON，其余表是同一份 dump 的投影。
 *  P0 阶段先实现"能存能取 + 投影学生/流水"，与网页版 /api/state 语义一致；
 *  更细的统计下推（学情视图）已在 schema.sql 里备好视图，P2 再接。
 */
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::path::Path;

pub struct Store {
    conn: Connection,
}

pub struct RoomData {
    pub rev: i64,
    pub updated_at: i64,
    pub state: Option<Value>,
    pub dump: Option<Value>,
}

impl Store {
    /// 打开（或创建）数据库并保证表结构就绪
    pub fn open(file: &Path) -> rusqlite::Result<Self> {
        if let Some(dir) = file.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let conn = Connection::open(file)?;
        conn.execute_batch(include_str!("../schema.sql"))?;
        conn.execute(
            "INSERT OR IGNORE INTO meta(key, value) VALUES (?1, ?2)",
            params!["schema_version", "1"],
        )?;
        Ok(Self { conn })
    }

    pub fn load_room(&self, room: &str) -> rusqlite::Result<Option<RoomData>> {
        let row = self
            .conn
            .query_row(
                "SELECT rev, updated_at, state_json, dump_json FROM rooms WHERE room_id = ?1",
                params![room],
                |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, i64>(1)?,
                        r.get::<_, Option<String>>(2)?,
                        r.get::<_, Option<String>>(3)?,
                    ))
                },
            )
            .optional()?;

        Ok(row.map(|(rev, updated_at, state_json, dump_json)| RoomData {
            rev,
            updated_at,
            state: state_json.and_then(|s| serde_json::from_str(&s).ok()),
            dump: dump_json.and_then(|s| serde_json::from_str(&s).ok()),
        }))
    }

    /// 保存一次快照：state 与 dump 都可选（只传其一时保留另一份旧值）
    pub fn save_room(
        &mut self,
        room: &str,
        rev: i64,
        state: Option<&Value>,
        dump: Option<&Value>,
    ) -> rusqlite::Result<()> {
        let now = now_ms();
        let state_json = state.map(|v| v.to_string());
        let dump_json = dump.map(|v| v.to_string());
        let name = state
            .and_then(|s| s.get("courseName"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let tx = self.conn.transaction()?;
        tx.execute(
            "INSERT INTO rooms(room_id, rev, updated_at, state_json, dump_json, room_name)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(room_id) DO UPDATE SET
               rev        = excluded.rev,
               updated_at = excluded.updated_at,
               state_json = COALESCE(excluded.state_json, rooms.state_json),
               dump_json  = COALESCE(excluded.dump_json, rooms.dump_json),
               room_name  = COALESCE(excluded.room_name, rooms.room_name)",
            params![room, rev, now, state_json, dump_json, name],
        )?;

        if let Some(full) = dump {
            project(&tx, room, full)?;
        }
        tx.commit()?;
        Ok(())
    }

    /// 行数统计（教师端「数据」面板用）
    pub fn stats(&self, room: &str) -> rusqlite::Result<Vec<(String, i64)>> {
        let mut out = Vec::new();
        for table in ["students", "teams", "questions", "quizzes"] {
            let sql = format!("SELECT COUNT(*) FROM {} WHERE room_id = ?1", table);
            let n: i64 = self.conn.query_row(&sql, params![room], |r| r.get(0))?;
            out.push((table.to_string(), n));
        }
        let n: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM records WHERE room_id = ?1", params![room], |r| r.get(0))?;
        out.push(("records".to_string(), n));
        Ok(out)
    }

    /// 学生总分（含没有流水的新生，分数为 0）—— 与 Node 版 db.scores 同一条 SQL
    ///
    /// 为什么用 LEFT JOIN：刚入座还没答题的学生也要出现在榜单里（0 分），
    /// 否则"新生一到就消失"。
    pub fn scores(&self, room: &str) -> rusqlite::Result<Vec<Value>> {
        let mut stmt = self.conn.prepare(
            "SELECT s.room_id, s.id AS sid, s.name, s.team_id, COALESCE(v.score, 0) AS score
             FROM students s
             LEFT JOIN v_student_score v ON v.room_id = s.room_id AND v.sid = s.id
             WHERE s.room_id = ?1
             ORDER BY score DESC, s.name",
        )?;
        let rows = stmt.query_map(params![room], |r| {
            Ok(json!({
                "room_id": r.get::<_, String>(0)?,
                "sid": r.get::<_, String>(1)?,
                "name": r.get::<_, Option<String>>(2)?.unwrap_or_default(),
                "team_id": r.get::<_, Option<String>>(3)?,
                "score": r.get::<_, f64>(4)?,
            }))
        })?;
        rows.collect()
    }

    /// 房间列表（/api/stats 用；/health 里的 rooms 走内存态）
    pub fn list_rooms(&self) -> rusqlite::Result<Vec<Value>> {
        let mut stmt = self
            .conn
            .prepare("SELECT room_id, rev, updated_at FROM rooms ORDER BY updated_at DESC")?;
        let rows = stmt.query_map([], |r| {
            Ok(json!({
                "room_id": r.get::<_, String>(0)?,
                "rev": r.get::<_, i64>(1)?,
                "updated_at": r.get::<_, i64>(2)?,
            }))
        })?;
        rows.collect()
    }

    /// 学情：每生每题型（直接用 schema.sql 里的视图）
    pub fn student_tier(&self, room: &str) -> rusqlite::Result<Vec<(String, String, i64, i64, f64)>> {
        let mut stmt = self.conn.prepare(
            "SELECT sid, tier, attempts, correct, COALESCE(earned, 0) FROM v_student_tier
             WHERE room_id = ?1 ORDER BY sid, tier",
        )?;
        let rows = stmt.query_map(params![room], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
        })?;
        rows.collect()
    }
}

/// 把一份完整状态投影到各表（与学生端/大屏无关，纯派生数据）
fn project(tx: &rusqlite::Transaction, room: &str, state: &Value) -> rusqlite::Result<()> {
    for table in [
        "tiers", "tags", "teams", "students", "questions", "quizzes", "records",
        "classroom_pending", "classroom_buzz", "classroom_feed", "roll_history",
        "runtime", "settings", "roll_state",
    ] {
        tx.execute(&format!("DELETE FROM {} WHERE room_id = ?1", table), params![room])?;
    }

    if let Some(tiers) = state.get("tiers").and_then(|v| v.as_array()) {
        for (i, t) in tiers.iter().enumerate() {
            tx.execute(
                "INSERT INTO tiers(room_id,key,label,weight,color,descr,sort) VALUES (?1,?2,?3,?4,?5,?6,?7)",
                params![
                    room,
                    t.get("key").and_then(|v| v.as_str()).unwrap_or(""),
                    t.get("label").and_then(|v| v.as_str()).unwrap_or(""),
                    t.get("weight").and_then(|v| v.as_f64()).unwrap_or(0.0),
                    t.get("color").and_then(|v| v.as_str()).unwrap_or("#78909c"),
                    t.get("desc").and_then(|v| v.as_str()).unwrap_or(""),
                    i as i64
                ],
            )?;
        }
    }

    if let Some(teams) = state.get("teams").and_then(|v| v.as_array()) {
        for (i, t) in teams.iter().enumerate() {
            tx.execute(
                "INSERT INTO teams(room_id,id,name,icon,color,sort) VALUES (?1,?2,?3,?4,?5,?6)",
                params![
                    room,
                    t.get("id").and_then(|v| v.as_str()).unwrap_or(""),
                    t.get("name").and_then(|v| v.as_str()).unwrap_or(""),
                    t.get("icon").and_then(|v| v.as_str()).unwrap_or(""),
                    t.get("color").and_then(|v| v.as_str()).unwrap_or("#90a4ae"),
                    t.get("order").and_then(|v| v.as_i64()).unwrap_or(i as i64)
                ],
            )?;
        }
    }

    if let Some(students) = state.get("students").and_then(|v| v.as_array()) {
        for s in students {
            tx.execute(
                "INSERT INTO students(room_id,id,name,team_id,active,joined_at) VALUES (?1,?2,?3,?4,?5,?6)",
                params![
                    room,
                    s.get("id").and_then(|v| v.as_str()).unwrap_or(""),
                    s.get("name").and_then(|v| v.as_str()).unwrap_or(""),
                    s.get("teamId").and_then(|v| v.as_str()),
                    if s.get("active").and_then(|v| v.as_bool()).unwrap_or(true) { 1 } else { 0 },
                    s.get("joinedAt").and_then(|v| v.as_i64()).unwrap_or(0)
                ],
            )?;
        }
    }

    if let Some(bank) = state.get("bank").and_then(|v| v.as_array()) {
        let empty = Value::Array(Vec::new());
        for q in bank {
            let options = q.get("options").unwrap_or(&empty);
            let tags = q.get("tags").unwrap_or(&empty);
            tx.execute(
                "INSERT INTO questions(room_id,id,tier,points,stem,answer,options,tags,source,note,archived,created_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
                params![
                    room,
                    q.get("id").and_then(|v| v.as_str()).unwrap_or(""),
                    q.get("tier").and_then(|v| v.as_str()).unwrap_or("basic"),
                    q.get("points").and_then(|v| v.as_f64()),
                    q.get("stem").and_then(|v| v.as_str()).unwrap_or(""),
                    q.get("answer").and_then(|v| v.as_str()).unwrap_or(""),
                    options.to_string(),
                    tags.to_string(),
                    q.get("source").and_then(|v| v.as_str()).unwrap_or(""),
                    q.get("note").and_then(|v| v.as_str()).unwrap_or(""),
                    if q.get("archived").and_then(|v| v.as_bool()).unwrap_or(false) { 1 } else { 0 },
                    q.get("createdAt").and_then(|v| v.as_i64()).unwrap_or(0)
                ],
            )?;
        }
    }

    if let Some(quizzes) = state.get("quizzes").and_then(|v| v.as_array()) {
        let empty = Value::Array(Vec::new());
        for qz in quizzes {
            let name = qz.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let kind = if name.starts_with("快捷记分") { "collector" }
                else if name.starts_with("历史积分") { "legacy" } else { "normal" };
            let question_ids = qz.get("questionIds").unwrap_or(&empty);
            tx.execute(
                "INSERT INTO quizzes(room_id,id,name,note,kind,created_at,closed_at,question_ids)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
                params![
                    room,
                    qz.get("id").and_then(|v| v.as_str()).unwrap_or(""),
                    name,
                    qz.get("note").and_then(|v| v.as_str()).unwrap_or(""),
                    kind,
                    qz.get("createdAt").and_then(|v| v.as_i64()).unwrap_or(0),
                    qz.get("closedAt").and_then(|v| v.as_i64()).unwrap_or(0),
                    question_ids.to_string()
                ],
            )?;

            if let Some(records) = qz.get("records").and_then(|v| v.as_array()) {
                for r in records {
                    tx.execute(
                        "INSERT INTO records(room_id,id,sid,qid,tier,quiz_id,result,base,ratio,points,source,note,at,by_who)
                         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)",
                        params![
                            room,
                            r.get("id").and_then(|v| v.as_str()).unwrap_or(""),
                            r.get("sid").and_then(|v| v.as_str()),
                            r.get("qid").and_then(|v| v.as_str()),
                            r.get("tier").and_then(|v| v.as_str()).unwrap_or(""),
                            r.get("quizId").and_then(|v| v.as_str()),
                            r.get("result").and_then(|v| v.as_str()).unwrap_or("correct"),
                            r.get("base").and_then(|v| v.as_f64()).unwrap_or(0.0),
                            r.get("ratio").and_then(|v| v.as_f64()).unwrap_or(0.0),
                            r.get("points").and_then(|v| v.as_f64()).unwrap_or(0.0),
                            r.get("source").and_then(|v| v.as_str()).unwrap_or("quiz"),
                            r.get("note").and_then(|v| v.as_str()).unwrap_or(""),
                            r.get("at").and_then(|v| v.as_i64()).unwrap_or(0),
                            r.get("by").and_then(|v| v.as_str()).unwrap_or("")
                        ],
                    )?;
                }
            }
        }
    }

    Ok(())
}

pub fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}
