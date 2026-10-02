//! 课堂积分 · 教师端（Tauri v2）库入口
//!
//!  **移动端必需**：Tauri v2 的 Android/iOS 构建要求 crate 提供 `lib` target
//!  （`crate-type = ["staticlib", "cdylib", "rlib"]`），由平台侧生成的工程调用 `run()`；
//!  桌面端则由 `main.rs` 薄壳调用同一个 `run()`。集成测试也跑在这个 lib 上
//!  （`tests/hub_conformance.rs` 直接 `use luchenxi_teacher_lib::hub`）。
//!
//!  职责分工：
//!   · 前端（apps/teacher/ui）＝ 现有网页版，零改动复用；通过 invoke 或 /api/state 读写数据
//!   · Rust（本 crate）＝ 本地 SQLite + 内置枢纽（HTTP/WS，协议同 v3）+ EasyTier 组网 sidecar

// 业务核心已迁到 crates/*（v5）；这里保留同名模块做再导出，
// 这样本文件下面的 Tauri 命令与集成测试无需改动。
pub mod db {
    pub use ci_store::*;
}
pub mod hub {
    pub use ci_hub::*;
}
pub mod net {
    pub use ci_core::net::*;
}
pub mod protocol_gen {
    pub use ci_protocol::*;
}

/// 门面入口：需要领域规则/存储/枢纽时从这里拿
pub use ci_core as core;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use serde_json::{json, Value};
use tauri::{Manager, State};
use tokio::sync::{Mutex, RwLock};

use db::Store;
use hub::{HubState, Room};

pub struct AppState {
    /// 与内置枢纽共用同一个数据库连接（SQLite 单写者，避免"database is locked"）
    pub store: Arc<Mutex<Store>>,
    pub db_file: PathBuf,
    pub port: u16,
}

fn counts_to_json(counts: Vec<(String, i64)>) -> Value {
    let mut map: HashMap<String, i64> = HashMap::new();
    for (k, v) in counts {
        map.insert(k, v);
    }
    json!(map)
}

/* ------------------------------------------------------------------ *
 * 命令：前端用 invoke('命令名', {参数}) 调用
 * ------------------------------------------------------------------ */

/// 读取一份完整课堂数据（等价于网页版读 localStorage）
#[tauri::command]
async fn db_load(state: State<'_, AppState>, room: String) -> Result<Value, String> {
    let store = state.store.lock().await;
    match store.load_room(&room).map_err(|e| e.to_string())? {
        Some(r) => Ok(json!({
            "ok": true, "rev": r.rev, "updatedAt": r.updated_at,
            "state": r.state, "dump": r.dump
        })),
        None => Ok(json!({ "ok": true, "rev": 0, "updatedAt": 0, "state": null, "dump": null })),
    }
}

/// 保存课堂数据（前端每次 commit 后防抖调用）
#[tauri::command]
async fn db_save(
    state: State<'_, AppState>,
    room: String,
    dump: Value,
    rev: Option<i64>,
) -> Result<Value, String> {
    let mut store = state.store.lock().await;
    store
        .save_room(&room, rev.unwrap_or(0), None, Some(&dump))
        .map_err(|e| e.to_string())?;
    let counts = store.stats(&room).map_err(|e| e.to_string())?;
    Ok(json!({ "ok": true, "room": room, "counts": counts_to_json(counts) }))
}

/// 学情：每生每题型（SQL 下推，界面可直接画表）
#[tauri::command]
async fn db_student_tier(state: State<'_, AppState>, room: String) -> Result<Value, String> {
    let store = state.store.lock().await;
    let rows = store.student_tier(&room).map_err(|e| e.to_string())?;
    Ok(json!(rows
        .into_iter()
        .map(|(sid, tier, attempts, correct, earned)| json!({
            "sid": sid, "tier": tier, "attempts": attempts, "correct": correct, "earned": earned
        }))
        .collect::<Vec<_>>()))
}

/// 数据库文件位置与端口（界面「数据」面板显示，方便老师备份）
#[tauri::command]
fn db_file(state: State<'_, AppState>) -> Value {
    json!({ "path": state.db_file.to_string_lossy(), "port": state.port })
}

/// 启动 EasyTier 组网（sidecar）
#[tauri::command]
async fn net_start(cfg: net::NetConfig) -> Result<Value, String> {
    net::start(&cfg).await
}

/// 停止 EasyTier
#[tauri::command]
async fn net_stop() -> Result<Value, String> {
    net::stop().await
}

/// 查询组网状态（解析 easytier-cli 输出）
#[tauri::command]
async fn net_status() -> Result<Value, String> {
    net::status().await
}

/* ------------------------------------------------------------------ *
 * 应用入口
 * ------------------------------------------------------------------ */

/// 供桌面端 `main.rs` 与移动端平台工程共同调用
///
/// `mobile_entry_point` 是 **Android/iOS 必需**的（生成 JNI 入口符号，
/// Tauri 的移动端构建会校验；缺了会报 "does not include required runtime symbols"）。
/// 桌面端不受影响（`cfg(mobile)` 只在移动目标下生效）。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // 数据目录：Windows %APPDATA%\<identifier>\classroom.db
            let dir = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| PathBuf::from("."));
            let db_file = dir.join("classroom.db");

            // 只开一个连接：db_save 与内置枢纽写的是同一个库，SQLite 单写者语义更稳
            let store = match Store::open(&db_file) {
                Ok(s) => s,
                Err(e) => return Err(format!("数据库初始化失败（{}）：{}", db_file.display(), e).into()),
            };
            let store = Arc::new(Mutex::new(store));

            let port: u16 = std::env::var("CLASSROOM_PORT")
                .ok()
                .and_then(|p| p.parse().ok())
                .unwrap_or(8080);

            let hub_state = HubState {
                rooms: Arc::new(RwLock::new(HashMap::<String, Room>::new())),
                db: store.clone(),
                port,
            };

            // 枢纽跑在 Tauri 自带的 tokio 运行时里；即便端口被占用也不该挡住主界面
            let hub_for_task = hub_state.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = hub::serve(hub_for_task).await {
                    eprintln!("[hub] 内置枢纽未启动：{}", e);
                }
            });

            app.manage(AppState {
                store,
                db_file,
                port,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            db_load, db_save, db_student_tier, db_file, net_start, net_stop, net_status
        ])
        .run(tauri::generate_context!())
        .expect("Tauri 启动失败");
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 数据库能建、能写、能读、能统计（不依赖 Tauri 运行时）
    #[test]
    fn db_roundtrip_without_tauri() {
        let dir = std::env::temp_dir().join(format!("ci-rust-db-{}", std::process::id()));
        let file = dir.join("classroom.db");
        let mut store = Store::open(&file).expect("建库");
        let dump = json!({
            "courseName": "Rust 单测",
            "students": [{ "id": "st_1", "name": "张三" }, { "id": "st_2", "name": "李四", "teamId": "tm_1" }],
            "teams": [{ "id": "tm_1", "name": "红队" }],
            "quizzes": [{ "id": "qz_1", "name": "随堂", "questionIds": [], "records": [
                { "id": "rc_1", "sid": "st_1", "tier": "basic", "result": "correct", "base": 3, "points": 3, "at": 1 }
            ] }]
        });
        store.save_room("t", 1, None, Some(&dump)).expect("写入");
        let back = store.load_room("t").expect("读取").expect("有数据");
        assert_eq!(back.dump.unwrap()["students"].as_array().unwrap().len(), 2);
        let counts = store.stats("t").unwrap();
        assert!(counts.iter().any(|(k, v)| k == "records" && *v == 1));
        // 缺字段（没有 teamId 的学生）也必须能写进去 —— node:sqlite 侧的同类坑在 JS 测试里
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 协议常量来自生成文件，且与契约版本一致
    #[test]
    fn protocol_constants_generated() {
        assert_eq!(protocol_gen::PROTOCOL_VERSION, 3);
        for t in ["welcome", "state", "dump", "cmd", "cmd-backlog", "ack", "presence", "error", "hello", "leaderboard"] {
            assert!(protocol_gen::ALL_TYPES.contains(&t), "缺少报文 {}", t);
        }
        assert!(protocol_gen::CMD_KINDS.contains(&"answer"));
        assert!(protocol_gen::SNAPSHOT_FIELDS.contains(&"meta"));
    }

    /// 房间号清洗与 Node 版同规则
    #[test]
    fn safe_room_rules() {
        assert_eq!(hub::safe_room(Some("../../etc/passwd".into())), "etcpasswd");
        assert_eq!(hub::safe_room(Some("a".repeat(80))).len(), 32);
        assert_eq!(hub::safe_room(Some("".into())), "default");
        assert_eq!(hub::safe_room(None), "default");
        assert_eq!(hub::safe_room(Some("class-3F_x".into())), "class-3F_x");
    }

    /// presence 语义：按队去重；断开只在没有同队设备时置 offline，且保留 label
    /// （这段逻辑与 Node 版 presenceList 一致，网络层测试见 tests/hub_conformance.rs）
    #[test]
    fn presence_dedupe_and_disconnect() {
        use tokio::sync::mpsc;
        let mut room = hub::Room::default();

        let (tx1, _rx1) = mpsc::unbounded_channel();
        let (tx2, _rx2) = mpsc::unbounded_channel();
        let (txh, _rxh) = mpsc::unbounded_channel();

        let h = room.add_client("host".into(), None, None, txh);
        let a = room.add_client("team".into(), Some("tm_1".into()), Some("第一组".into()), tx1);
        let b = room.add_client("team".into(), Some("tm_1".into()), Some("第一组-备用".into()), tx2);

        assert!(room.host_online(), "host 在线");
        let p = room.presence();
        let teams = p["teams"].as_array().unwrap();
        assert_eq!(teams.len(), 1, "同队两台设备只占一条");
        assert_eq!(teams[0]["teamId"], serde_json::json!("tm_1"));
        assert_eq!(teams[0]["online"], serde_json::json!(true));

        // 关掉一台：同队还有设备 → 仍在线
        room.remove_client(a);
        assert_eq!(room.presence()["teams"][0]["online"], serde_json::json!(true), "同队还有设备时保持在线");

        // 关掉最后一台：online=false 且保留条目（教师端据此显示"未入座"）
        room.remove_client(b);
        let p2 = room.presence();
        assert_eq!(p2["teams"].as_array().unwrap().len(), 1, "断开不移除条目");
        assert_eq!(p2["teams"][0]["online"], serde_json::json!(false));
        assert_eq!(p2["teams"][0]["label"], serde_json::json!("第一组-备用"), "保留最后一次 label");

        // host 断开 → hostOnline=false
        room.remove_client(h);
        assert_eq!(room.presence()["hostOnline"], serde_json::json!(false));
    }

    /// 离线命令队列：超过上限丢最旧的（与 Node 版 CMD_QUEUE_MAX 一致）
    #[test]
    fn offline_queue_caps_at_limit() {
        let mut room = hub::Room::default();
        for i in 0..(hub::CMD_QUEUE_MAX + 15) {
            room.enqueue(serde_json::json!({ "id": format!("cm_{}", i) }));
        }
        assert_eq!(room.queue.len(), hub::CMD_QUEUE_MAX, "队列长度被截到上限");
        // 保留的是最新的那一批
        let first = room.queue[0]["id"].as_str().unwrap().to_string();
        assert_eq!(first, format!("cm_{}", 15), "丢掉的是最旧的 15 条");
    }

    /// 导入备份：dump 与轻量快照都要替换（这条曾是真 bug：只换 dump，导致大屏继续显示旧数据）
    #[test]
    fn restore_replaces_both_snapshots() {
        let mut room = hub::Room::default();
        room.state = Some(serde_json::json!({ "courseName": "旧课" }));
        room.dump = Some(serde_json::json!({ "courseName": "旧课", "students": [] }));

        let rev = room.apply_restore(serde_json::json!({ "courseName": "导入的课", "students": [{ "id": "st_9" }] }));
        assert_eq!(rev, 1, "rev 自增");
        assert_eq!(room.state.as_ref().unwrap()["courseName"], serde_json::json!("导入的课"),
            "轻量快照必须被替换（否则大屏/学生端继续显示旧数据）");
        assert_eq!(room.dump.as_ref().unwrap()["students"].as_array().unwrap().len(), 1);
    }

    /// EasyTier 参数拼装（与 tests/net.test.js 同一套规则）
    #[test]
    fn easytier_args_match_js_rules() {
        let cfg = net::NetConfig {
            network_name: "class-3f".into(),
            network_secret: "s3cret".into(),
            virtual_ip: Some("10.144.144.1".into()),
            peers: vec!["tcp://public.easytier.cn:11010".into(), "".into()],
            listen_port: Some(21010),
            config_server: Some("https://easytier.example.com".into()),
            username: Some("teacher01".into()),
            no_tun: true,
        };
        let args = net::build_args(&cfg);
        assert_eq!(args[0], "-i");
        assert_eq!(args[1], "10.144.144.1");
        assert!(args.contains(&"--network-name".to_string()));
        assert!(args.contains(&"--network-secret".to_string()));
        assert_eq!(args.iter().filter(|a| *a == "-p").count(), 1, "空 peer 应被忽略");
        assert!(args.contains(&"--config-server".to_string()));
        assert!(!args.contains(&"-w".to_string()), "给了 config-server 就不再传 -w");
        assert_eq!(args.last().unwrap(), "--no-tun");

        let dhcp = net::NetConfig {
            virtual_ip: None,
            peers: vec![],
            listen_port: None,
            config_server: None,
            username: Some("teacher01".into()),
            no_tun: false,
            ..cfg
        };
        let a2 = net::build_args(&dhcp);
        assert_eq!(a2[0], "-d", "没有固定虚拟 IP 时用 DHCP");
        assert!(a2.contains(&"-w".to_string()));
    }
}
