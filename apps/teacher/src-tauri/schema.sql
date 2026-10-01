-- ============================================================================
-- 课堂积分系统 · 教师端本地数据库（SQLite）
--   - 单一事实来源：积分由 records 派生（学生积分 = SUM(records.points)）
--   - state_json 保存一份与 v3 localStorage 完全同构的快照，保证前后端零漂移与备份兼容
--   - 其余表是同一份状态的"投影"，用于查询/统计（学情分析可下推到 SQL）
--   - Rust（rusqlite）与 Node（node:sqlite）两端共用本文件，改结构请同步 docs/11
-- ============================================================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- 房间：一份完整课堂状态 + 教师端完整存档（dump）+ 版本号
CREATE TABLE IF NOT EXISTS rooms (
  room_id    TEXT PRIMARY KEY,
  rev        INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0,
  state_json TEXT,              -- 与大屏/学生端同步的快照（轻量）
  dump_json  TEXT,              -- 教师端完整状态（含全部流水），仅教师端可读写
  room_name  TEXT
);

CREATE TABLE IF NOT EXISTS tiers (
  room_id TEXT NOT NULL,
  key     TEXT NOT NULL,
  label   TEXT,
  weight  REAL,
  color   TEXT,
  descr   TEXT,
  sort    INTEGER,
  PRIMARY KEY (room_id, key)
);

CREATE TABLE IF NOT EXISTS tags (
  room_id TEXT NOT NULL,
  name    TEXT NOT NULL,
  sort    INTEGER,
  PRIMARY KEY (room_id, name)
);

CREATE TABLE IF NOT EXISTS teams (
  room_id TEXT NOT NULL,
  id      TEXT NOT NULL,
  name    TEXT,
  icon    TEXT,
  color   TEXT,
  sort    INTEGER,
  PRIMARY KEY (room_id, id)
);

CREATE TABLE IF NOT EXISTS students (
  room_id   TEXT NOT NULL,
  id        TEXT NOT NULL,
  name      TEXT,
  team_id   TEXT,
  active    INTEGER DEFAULT 1,
  joined_at INTEGER,
  PRIMARY KEY (room_id, id)
);

CREATE TABLE IF NOT EXISTS questions (
  room_id    TEXT NOT NULL,
  id         TEXT NOT NULL,
  tier       TEXT,
  points     REAL,
  stem       TEXT,
  answer     TEXT,
  options    TEXT,          -- JSON 数组
  tags       TEXT,          -- JSON 数组
  source     TEXT,
  note       TEXT,
  archived   INTEGER DEFAULT 0,
  created_at INTEGER,
  PRIMARY KEY (room_id, id)
);

CREATE TABLE IF NOT EXISTS quizzes (
  room_id      TEXT NOT NULL,
  id           TEXT NOT NULL,
  name         TEXT,
  note         TEXT,
  kind         TEXT DEFAULT 'normal',   -- normal | collector（快捷记分） | legacy（v1 迁移）
  created_at   INTEGER,
  closed_at    INTEGER DEFAULT 0,
  question_ids TEXT,                     -- JSON 数组，顺序即答题顺序
  PRIMARY KEY (room_id, id)
);

-- 积分流水：唯一事实来源
CREATE TABLE IF NOT EXISTS records (
  room_id TEXT NOT NULL,
  id      TEXT NOT NULL,
  sid     TEXT,
  qid     TEXT,
  tier    TEXT,
  quiz_id TEXT,
  result  TEXT,
  base    REAL,
  ratio   REAL,
  points  REAL,
  source  TEXT,          -- quiz | quick | rollcall | manual | reset | student
  note    TEXT,
  at      INTEGER,
  by_who  TEXT,
  PRIMARY KEY (room_id, id)
);
CREATE INDEX IF NOT EXISTS idx_records_sid  ON records(room_id, sid);
CREATE INDEX IF NOT EXISTS idx_records_quiz ON records(room_id, quiz_id, at);
CREATE INDEX IF NOT EXISTS idx_records_qid  ON records(room_id, qid, sid);
CREATE INDEX IF NOT EXISTS idx_records_at   ON records(room_id, at);

-- 课堂过程数据（v3 的 state.classroom）
CREATE TABLE IF NOT EXISTS classroom_pending (
  room_id TEXT NOT NULL, id TEXT NOT NULL, sid TEXT, team_id TEXT, qid TEXT, quiz_id TEXT,
  answer TEXT, auto INTEGER DEFAULT 0, at INTEGER,
  PRIMARY KEY (room_id, id)
);
CREATE TABLE IF NOT EXISTS classroom_buzz (
  room_id TEXT NOT NULL, id TEXT NOT NULL, team_id TEXT, qid TEXT, sid TEXT, at INTEGER, by_who TEXT,
  PRIMARY KEY (room_id, id)
);
CREATE TABLE IF NOT EXISTS classroom_feed (
  room_id TEXT NOT NULL, id TEXT NOT NULL, at INTEGER, kind TEXT, team_id TEXT, sid TEXT, qid TEXT,
  result TEXT, answer TEXT, points REAL, auto INTEGER, text TEXT,
  PRIMARY KEY (room_id, id)
);

CREATE TABLE IF NOT EXISTS roll_history (
  room_id TEXT NOT NULL, id TEXT NOT NULL, sid TEXT, at INTEGER, quiz_id TEXT, qid TEXT,
  PRIMARY KEY (room_id, id)
);
CREATE INDEX IF NOT EXISTS idx_roll_sid ON roll_history(room_id, sid);

CREATE TABLE IF NOT EXISTS runtime (
  room_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT,
  PRIMARY KEY (room_id, key)
);

CREATE TABLE IF NOT EXISTS settings (
  room_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT,
  PRIMARY KEY (room_id, key)
);

CREATE TABLE IF NOT EXISTS logs (
  room_id TEXT NOT NULL,
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      INTEGER, type TEXT, detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_logs_room ON logs(room_id, ts);

-- 点名状态（mode/scope/roundPool/round…）以 JSON 存一行
CREATE TABLE IF NOT EXISTS roll_state (
  room_id TEXT PRIMARY KEY, json TEXT
);

-- 常用统计视图：每生每题型（学情分析可直接查）
CREATE VIEW IF NOT EXISTS v_student_tier AS
SELECT room_id, sid, tier,
       COUNT(*)                                             AS attempts,
       SUM(CASE WHEN result = 'correct' THEN 1 ELSE 0 END)   AS correct,
       SUM(CASE WHEN result = 'half'    THEN 1 ELSE 0 END)   AS half,
       SUM(CASE WHEN result = 'wrong'   THEN 1 ELSE 0 END)   AS wrong,
       SUM(CASE WHEN result = 'skip'    THEN 1 ELSE 0 END)   AS skip,
       SUM(points)                                           AS earned,
       SUM(base)                                             AS base_total
FROM records
WHERE tier <> '' AND result <> 'manual'
GROUP BY room_id, sid, tier;

-- 常用统计视图：学生总分
CREATE VIEW IF NOT EXISTS v_student_score AS
SELECT room_id, sid, SUM(points) AS score FROM records GROUP BY room_id, sid;
