//! Rust 内置枢纽的一致性测试 —— 与 `tests/hub-spec.test.js` **同一份场景清单**
//! （`packages/protocol/hub-scenarios.json`），在真实 WebSocket 上跑一遍。
//!
//! 运行：`cargo test --manifest-path apps/teacher/src-tauri/Cargo.toml`
//!   · 需要先 `node scripts/sync-ui.mjs teacher`（生成 ui/，`generate_context!` 会检查）
//!   · 不依赖 Tauri 运行时，只用到 `hub`/`db` 两个模块
//!
//! 为什么要有它：Node 版枢纽是当前线上实现，Rust 版是客户端内置实现。
//! 两者只要有一处行为不一致，课堂上的表现就是"连上了但不动"或"数据丢了"。
//! 场景 id 与 JSON 清单一一对应，`tests/ci.test.js` 会校验覆盖完整。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::{Mutex, RwLock};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

use ci_store::Store;
use ci_hub::{self as hub, HubState, Room};

/* ------------------------------------------------------------------ *
 * 测试用客户端
 * ------------------------------------------------------------------ */

struct Client {
    tx: futures_util::stream::SplitSink<
        tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
        Message,
    >,
    rx: futures_util::stream::SplitStream<
        tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    >,
    inbox: Vec<Value>,
}

impl Client {
    async fn connect(port: u16, room: &str, role: &str, team: Option<&str>, label: Option<&str>) -> Client {
        let mut url = format!("ws://127.0.0.1:{}/?room={}&role={}", port, room, role);
        if let Some(t) = team {
            url.push_str(&format!("&team={}", t));
        }
        if let Some(l) = label {
            url.push_str(&format!("&label={}", l));
        }
        let (ws, _) = connect_async(url).await.expect("连接枢纽");
        let (tx, rx) = ws.split();
        Client { tx, rx, inbox: Vec::new() }
    }

    async fn send(&mut self, msg: Value) {
        self.tx.send(Message::Text(msg.to_string())).await.expect("发送");
    }

    /// 等一条指定类型的报文（先翻收件箱）
    async fn next_of(&mut self, ty: &str) -> Value {
        if let Some(i) = self.inbox.iter().position(|m| m.get("type").and_then(|v| v.as_str()) == Some(ty)) {
            return self.inbox.remove(i);
        }
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        loop {
            let left = deadline.saturating_duration_since(tokio::time::Instant::now());
            if left.is_zero() {
                panic!("等待 {} 超时；已收到 {:?}", ty, self.inbox.iter().map(|m| m["type"].clone()).collect::<Vec<_>>());
            }
            match tokio::time::timeout(left, self.rx.next()).await {
                Ok(Some(Ok(Message::Text(t)))) => {
                    if let Ok(v) = serde_json::from_str::<Value>(&t) {
                        if v.get("type").and_then(|x| x.as_str()) == Some(ty) {
                            return v;
                        }
                        self.inbox.push(v);
                    }
                }
                Ok(Some(Ok(_))) => continue,
                Ok(Some(Err(e))) => panic!("ws 错误：{}", e),
                Ok(None) => panic!("连接被关闭，等待 {}", ty),
                Err(_) => continue,
            }
        }
    }

    /// 一段时间内收到的全部报文类型（用于断言"绝不该收到"）。
    /// 注意：它**只收集、不清空** —— 想让后续 next_of 读到新消息，请用 settle()。
    async fn drain_types(&mut self, ms: u64) -> Vec<String> {
        let deadline = tokio::time::Instant::now() + Duration::from_millis(ms);
        loop {
            let left = deadline.saturating_duration_since(tokio::time::Instant::now());
            if left.is_zero() {
                break;
            }
            match tokio::time::timeout(left, self.rx.next()).await {
                Ok(Some(Ok(Message::Text(t)))) => {
                    if let Ok(v) = serde_json::from_str::<Value>(&t) {
                        self.inbox.push(v);
                    }
                }
                Ok(Some(Ok(_))) => continue,
                Ok(Some(Err(_))) | Ok(None) => break,
                Err(_) => break,
            }
        }
        self.inbox.iter().map(|m| m["type"].as_str().unwrap_or("").to_string()).collect()
    }

    /// 把当前收到的消息**全部丢掉**（含已在收件箱里的），让后续 next_of 拿到的一定是新消息。
    /// 对应 JS 测试里的 `settle(ms)`。
    /// 为什么需要：连接瞬间枢纽会补发 welcome/state/presence，与断言要等的"新"消息同类型，
    /// 不先清掉就会读到旧的（本轮 3 个用例就是栽在这里）。
    async fn settle(&mut self, ms: u64) {
        let _ = self.drain_types(ms).await;
        self.inbox.clear();
    }

    async fn close(mut self) {
        let _ = self.tx.close().await;
    }
}

/* ------------------------------------------------------------------ *
 * 起一个跑在测试进程里的枢纽
 * ------------------------------------------------------------------ */

struct TestHub {
    port: u16,
    _dir: PathBuf,
}

async fn start_hub(tag: &str) -> TestHub {
    // 每个用例一个端口。
    // 早先用"标签散列 % 400"分配，会出现两个标签落到同一端口：并行跑时
    // 先绑上的那个赢，另一个的 serve() 失败被忽略，客户端连到别的用例的枢纽上，
    // 表现为随机的 404/超时（dump_privacy 单独跑必过、并行跑必挂就是这么来的）。
    // 改为进程内自增，彻底避免碰撞。
    use std::sync::atomic::{AtomicU16, Ordering};
    static NEXT_PORT: AtomicU16 = AtomicU16::new(8400);
    let port = NEXT_PORT.fetch_add(1, Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!("ci-rust-hub-{}-{}", std::process::id(), tag));
    let _ = std::fs::create_dir_all(&dir);
    let store = Store::open(&dir.join("classroom.db")).expect("建库");
    let state = HubState {
        rooms: Arc::new(RwLock::new(HashMap::<String, Room>::new())),
        db: Arc::new(Mutex::new(store)),
        port,
    };
    tokio::spawn(async move {
        let _ = hub::serve(state).await;
    });
    // 等端口就绪
    for _ in 0..40 {
        tokio::time::sleep(Duration::from_millis(100)).await;
        if tokio::net::TcpStream::connect(("127.0.0.1", port)).await.is_ok() {
            return TestHub { port, _dir: dir };
        }
    }
    panic!("枢纽未能在 4 秒内就绪");
}

fn room(tag: &str) -> String {
    format!("spec-{}", tag)
}

/* ------------------------------------------------------------------ *
 * 场景（id 对应 packages/protocol/hub-scenarios.json）
 * ------------------------------------------------------------------ */

#[tokio::test]
async fn welcome_fields() {
    let h = start_hub("welcome").await;
    let r = room("welcome");
    let mut host = Client::connect(h.port, &r, "host", None, None).await;
    let w = host.next_of("welcome").await;
    assert_eq!(w["room"], json!(r));
    assert_eq!(w["role"], json!("host"));
    assert!(w["clientId"].is_number() || w["clientId"].is_string(), "clientId 必须存在");
    assert_eq!(w["hasState"], json!(false));
    assert_eq!(w["hasDump"], json!(false));
    assert_eq!(w["hostOnline"], json!(true), "host 连上后 hostOnline=true");
    assert!(w["serverTime"].is_number());
    host.close().await;
}

#[tokio::test]
async fn state_broadcast() {
    let h = start_hub("state").await;
    let r = room("state");
    let mut host = Client::connect(h.port, &r, "host", None, None).await;
    host.next_of("welcome").await;
    let mut stage = Client::connect(h.port, &r, "stage", None, None).await;
    stage.next_of("welcome").await;
    let _ = stage.drain_types(300).await;

    host.send(json!({ "type": "state", "payload": { "courseName": "规格课" } })).await;
    let got = stage.next_of("state").await;
    assert_eq!(got["payload"]["courseName"], json!("规格课"));
    assert!(got["rev"].as_i64().unwrap_or(0) >= 1, "rev 应自增");
    let seen = host.drain_types(400).await;
    assert!(!seen.contains(&"state".to_string()), "host 不该收到自己推的 state");
    host.close().await;
    stage.close().await;
}

#[tokio::test]
async fn request_backfill() {
    let h = start_hub("backfill").await;
    let r = room("backfill");
    let mut host = Client::connect(h.port, &r, "host", None, None).await;
    host.next_of("welcome").await;
    host.send(json!({ "type": "state", "payload": { "courseName": "已有数据" } })).await;
    tokio::time::sleep(Duration::from_millis(200)).await;

    let mut late = Client::connect(h.port, &r, "stage", None, None).await;
    let w = late.next_of("welcome").await;
    assert_eq!(w["hasState"], json!(true), "已有数据后 hasState=true");
    let snap = late.next_of("state").await;
    assert_eq!(snap["payload"]["courseName"], json!("已有数据"), "连上就补发快照");
    late.send(json!({ "type": "request" })).await;
    assert_eq!(late.next_of("state").await["payload"]["courseName"], json!("已有数据"));

    // 空房间 request → error
    let empty = room("backfill-empty");
    let mut e = Client::connect(h.port, &empty, "stage", None, None).await;
    e.next_of("welcome").await;
    e.send(json!({ "type": "request" })).await;
    assert!(e.next_of("error").await["message"].as_str().unwrap_or("").contains("暂无课堂数据"));
    host.close().await;
    late.close().await;
    e.close().await;
}

#[tokio::test]
async fn dump_privacy() {
    let h = start_hub("dump").await;
    let r = room("dump");
    let mut host = Client::connect(h.port, &r, "host", None, None).await;
    host.next_of("welcome").await;
    let mut team = Client::connect(h.port, &r, "team", Some("tm_1"), Some("第一组")).await;
    team.next_of("welcome").await;
    let mut stage = Client::connect(h.port, &r, "stage", None, None).await;
    stage.next_of("welcome").await;
    let _ = team.drain_types(300).await;
    let _ = stage.drain_types(300).await;

    host.send(json!({ "type": "dump", "payload": { "courseName": "存档", "students": [{ "id": "st_1", "name": "张三" }] } })).await;
    let teamSaw = team.drain_types(600).await;
    let stageSaw = stage.drain_types(600).await;
    assert!(!teamSaw.contains(&"dump".to_string()), "学生端绝不能收到 dump，实际收到 {:?}", teamSaw);
    assert!(!stageSaw.contains(&"dump".to_string()), "大屏绝不能收到 dump，实际收到 {:?}", stageSaw);

    host.send(json!({ "type": "request-dump" })).await;
    let back = host.next_of("dump").await;
    assert_eq!(back["payload"]["students"].as_array().unwrap().len(), 1, "host 可取回存档");

    team.send(json!({ "type": "request-dump" })).await;
    assert!(team.next_of("error").await["message"].as_str().unwrap_or("").contains("只有教师端"));
    host.close().await;
    team.close().await;
    stage.close().await;
}

#[tokio::test]
async fn permission_guard() {
    let h = start_hub("perm").await;
    let r = room("perm");
    let mut host = Client::connect(h.port, &r, "host", None, None).await;
    host.next_of("welcome").await;
    let mut team = Client::connect(h.port, &r, "team", Some("tm_1"), None).await;
    team.next_of("welcome").await;
    let mut stage = Client::connect(h.port, &r, "stage", None, None).await;
    stage.next_of("welcome").await;

    team.send(json!({ "type": "state", "payload": { "courseName": "伪造" } })).await;
    assert!(team.next_of("error").await["message"].as_str().unwrap_or("").contains("只有教师端"));
    stage.send(json!({ "type": "dump", "payload": {} })).await;
    assert!(stage.next_of("error").await["message"].as_str().unwrap_or("").contains("只有教师端"));
    host.close().await;
    team.close().await;
    stage.close().await;
}

#[tokio::test]
async fn cmd_forward_ack() {
    let h = start_hub("cmd").await;
    let r = room("cmd");
    let mut host = Client::connect(h.port, &r, "host", None, None).await;
    host.next_of("welcome").await;
    let mut team = Client::connect(h.port, &r, "team", Some("tm_1"), Some("第一组")).await;
    team.next_of("welcome").await;

    team.send(json!({ "type": "cmd", "cmd": { "id": "cm_1", "kind": "answer", "teamId": "tm_1", "qid": "q_1", "choice": ["B"] } })).await;
    let got = host.next_of("cmd").await;
    assert_eq!(got["cmd"]["id"], json!("cm_1"));
    assert_eq!(got["cmd"]["choice"], json!(["B"]));
    let ack = team.next_of("ack").await;
    assert_eq!(ack["ok"], json!(true));
    assert_eq!(ack["cmdId"], json!("cm_1"));
    host.close().await;
    team.close().await;
}

#[tokio::test]
async fn offline_queue_backlog() {
    let h = start_hub("offline").await;
    let r = room("offline");
    let mut team = Client::connect(h.port, &r, "team", Some("tm_1"), None).await;
    team.next_of("welcome").await;

    team.send(json!({ "type": "cmd", "cmd": { "id": "cm_2", "kind": "buzz", "teamId": "tm_1", "qid": "q_1" } })).await;
    let ack = team.next_of("ack").await;
    assert_eq!(ack["ok"], json!(false), "教师端离线时 ok=false");
    assert_eq!(ack["reason"], json!("teacher-offline"), "学生端据此提示已排队");

    let mut host = Client::connect(h.port, &r, "host", None, None).await;
    host.next_of("welcome").await;
    let backlog = host.next_of("cmd-backlog").await;
    let cmds = backlog["cmds"].as_array().unwrap();
    assert_eq!(cmds.len(), 1, "补发 1 条离线命令");
    assert_eq!(cmds[0]["id"], json!("cm_2"));
    host.close().await;
    team.close().await;
}

#[tokio::test]
async fn presence_dedupe() {
    let h = start_hub("presence").await;
    let r = room("presence");
    let mut host = Client::connect(h.port, &r, "host", None, None).await;
    host.next_of("welcome").await;
    // 教师端一连上枢纽就会收到一份"当前在线状态"（Node 版同样如此）；
    // 先清掉，否则下面读到的是这份空列表而不是新队伍加入后的。
    host.settle(250).await;
    let mut t1 = Client::connect(h.port, &r, "team", Some("tm_1"), Some("第一组")).await;
    t1.next_of("welcome").await;

    let p = host.next_of("presence").await;
    assert_eq!(p["hostOnline"], json!(true));
    let teams = p["teams"].as_array().unwrap();
    assert_eq!(teams.iter().filter(|t| t["teamId"] == json!("tm_1")).count(), 1, "同一队只报一次");

    // 同队第二台设备：仍只占一条
    let mut t2 = Client::connect(h.port, &r, "team", Some("tm_1"), Some("备用机")).await;
    t2.next_of("welcome").await;
    let p2 = host.next_of("presence").await;
    assert_eq!(p2["teams"].as_array().unwrap().iter().filter(|t| t["teamId"] == json!("tm_1")).count(), 1);

    // 换队/改 label：枢纽级 hello（扁平字段）后 presence 更新
    host.settle(300).await;                            // 清掉之前的 presence，避免读到旧的那条
    t2.send(json!({ "type": "hello", "role": "team", "teamId": "tm_2", "label": "第二组" })).await;
    let p3 = host.next_of("presence").await;
    assert!(p3["teams"].as_array().unwrap().iter().any(|t| t["teamId"] == json!("tm_2")), "hello 后新队伍出现");
    let _ = t2.next_of("welcome").await;   // hello 也会回一份 welcome（与 Node 版一致）

    // 业务级 hello（cmd.kind=hello）必须转发给教师端
    t1.send(json!({ "type": "cmd", "cmd": { "id": "cm_hello", "kind": "hello", "teamId": "tm_1", "label": "第一组" } })).await;
    let fwd = host.next_of("cmd").await;
    assert_eq!(fwd["cmd"]["kind"], json!("hello"), "业务级 hello 是命令，不是枢纽控制报文");

    host.close().await;
    t1.close().await;
    t2.close().await;
}

#[tokio::test]
async fn presence_disconnect_keeps_entry() {
    let h = start_hub("disconnect").await;
    let r = room("disconnect");
    let mut host = Client::connect(h.port, &r, "host", None, None).await;
    host.next_of("welcome").await;
    let mut t = Client::connect(h.port, &r, "team", Some("tm_9"), Some("第九组")).await;
    t.next_of("welcome").await;
    // 清掉"入座时的 presence"，这样下一步读到的才是断开后的那条
    host.settle(300).await;
    t.close().await;

    let p = host.next_of("presence").await;
    let mine: Vec<&Value> = p["teams"].as_array().unwrap().iter().filter(|x| x["teamId"] == json!("tm_9")).collect();
    assert_eq!(mine.len(), 1, "断开后仍保留条目（教师端据此显示未入座）");
    assert_eq!(mine[0]["online"], json!(false));
    assert_eq!(mine[0]["label"], json!("第九组"), "保留最后一次 label");
    host.close().await;
}

#[tokio::test]
async fn leaderboard_alias() {
    let h = start_hub("alias").await;
    let r = room("alias");
    let mut host = Client::connect(h.port, &r, "host", None, None).await;
    host.next_of("welcome").await;
    let mut team = Client::connect(h.port, &r, "team", Some("tm_1"), None).await;
    team.next_of("welcome").await;
    let _ = team.drain_types(300).await;
    host.send(json!({ "type": "leaderboard", "payload": { "courseName": "兼容课" } })).await;
    assert_eq!(team.next_of("state").await["payload"]["courseName"], json!("兼容课"));
    host.close().await;
    team.close().await;
}

#[tokio::test]
async fn room_isolation() {
    let h = start_hub("isolation").await;
    let a = room("iso-a");
    let b = room("iso-b");
    let mut host = Client::connect(h.port, &a, "host", None, None).await;
    host.next_of("welcome").await;
    let mut other = Client::connect(h.port, &b, "stage", None, None).await;
    other.next_of("welcome").await;
    let _ = other.drain_types(300).await;

    host.send(json!({ "type": "state", "payload": { "courseName": "A 房间" } })).await;
    let seen = other.drain_types(700).await;
    assert!(!seen.contains(&"state".to_string()), "另一个房间不该收到数据，实际 {:?}", seen);
    host.close().await;
    other.close().await;
}

#[tokio::test]
async fn room_name_sanitize() {
    let h = start_hub("sanitize").await;
    let mut evil = Client::connect(h.port, "../../etc/passwd", "stage", None, None).await;
    let w = evil.next_of("welcome").await;
    let name = w["room"].as_str().unwrap_or("");
    assert!(!name.contains('/') && !name.contains('.'), "房间号必须被清洗：{}", name);
    assert!(name.len() <= 32);
    assert!(name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-'), "只允许 [A-Za-z0-9_-]：{}", name);
    evil.close().await;
}

#[tokio::test]
async fn http_api() {
    let h = start_hub("http").await;
    let r = room("http");
    let mut host = Client::connect(h.port, &r, "host", None, None).await;
    host.next_of("welcome").await;
    host.send(json!({ "type": "dump", "payload": { "courseName": "HTTP 规格", "students": [{ "id": "st_1", "name": "张三" }], "quizzes": [] } })).await;
    tokio::time::sleep(Duration::from_millis(400)).await;

    let (code, body) = http_get(h.port, "/health").await;
    assert_eq!(code, 200, "/health 200");
    let info: Value = serde_json::from_str(&body).expect("/health 是 JSON");
    assert_eq!(info["ok"], json!(true));
    assert_eq!(info["storage"], json!("sqlite"));

    let (code, body) = http_get(h.port, &format!("/api/state?room={}", r)).await;
    assert_eq!(code, 200);
    let st: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(st["dump"]["students"].as_array().unwrap().len(), 1, "/api/state 读回落库数据");

    let (code, body) = http_get(h.port, &format!("/api/stats?room={}", r)).await;
    assert_eq!(code, 200);
    let stats: Value = serde_json::from_str(&body).unwrap();
    assert!(stats["counts"].is_object(), "/api/stats 返回统计");

    // /api/backup：与 Node 版同结构
    let (code, body) = http_get(h.port, &format!("/api/backup?room={}", r)).await;
    assert_eq!(code, 200, "/api/backup 200");
    let backup: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(backup["type"], json!("ci-backup"));
    assert_eq!(backup["version"], json!(3));
    assert_eq!(backup["state"]["students"].as_array().unwrap().len(), 1);

    // 空房间导出 → 404 + 可读原因
    let (code, body) = http_get(h.port, &format!("/api/backup?room={}-empty", r)).await;
    assert_eq!(code, 404, "空房间 /api/backup 404");
    assert!(body.contains("还没有数据"), "给出可读原因：{}", body);

    // /api/restore：导入后内存态与数据库都要更新，并广播 state
    let mut stage = Client::connect(h.port, &r, "stage", None, None).await;
    stage.next_of("welcome").await;
    // 大屏一连上就会收到当前快照（courseName 还是旧的），必须清掉再断言"导入后广播"
    stage.settle(300).await;
    let backup_text = serde_json::to_string(&json!({
        "type": "ci-backup", "version": 3,
        "state": { "courseName": "导入的课", "students": [{ "id": "st_9", "name": "李四" }], "quizzes": [] }
    })).unwrap();
    let (code, body) = http_post(h.port, &format!("/api/restore?room={}", r), &backup_text).await;
    assert_eq!(code, 200, "/api/restore 200");
    let res: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(res["ok"], json!(true));
    assert!(res["rev"].as_i64().unwrap_or(0) >= 1, "rev 自增");

    let got = stage.next_of("state").await;
    assert_eq!(got["payload"]["courseName"], json!("导入的课"), "导入后广播新状态给大屏");

    let (_, body) = http_get(h.port, &format!("/api/state?room={}", r)).await;
    let after: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(after["dump"]["students"][0]["id"], json!("st_9"), "内存态已替换为导入数据");

    // 坏格式 → 400
    let (code, _) = http_post(h.port, &format!("/api/restore?room={}", r), "\"just-a-string\"").await;
    assert_eq!(code, 400, "非对象备份体被拒");

    host.close().await;
    stage.close().await;
}

/// 极简 HTTP GET：只取状态行与正文，省一个 HTTP 客户端依赖
async fn http_get(port: u16, path: &str) -> (u16, String) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut s = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.expect("连接");
    let req = format!("GET {} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n", path);
    s.write_all(req.as_bytes()).await.unwrap();
    let mut buf = Vec::new();
    s.read_to_end(&mut buf).await.unwrap();
    let text = String::from_utf8_lossy(&buf).to_string();
    let status = text.lines().next().unwrap_or("").split_whitespace().nth(1).unwrap_or("0").parse().unwrap_or(0);
    let body = text.split("\r\n\r\n").nth(1).unwrap_or("").to_string();
    (status, body)
}

/// 极简 HTTP POST（带 JSON 体）
async fn http_post(port: u16, path: &str, body: &str) -> (u16, String) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut s = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.expect("连接");
    let req = format!(
        "POST {} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        path,
        body.as_bytes().len(),
        body
    );
    s.write_all(req.as_bytes()).await.unwrap();
    let mut buf = Vec::new();
    s.read_to_end(&mut buf).await.unwrap();
    let text = String::from_utf8_lossy(&buf).to_string();
    let status = text.lines().next().unwrap_or("").split_whitespace().nth(1).unwrap_or("0").parse().unwrap_or(0);
    let body = text.split("\r\n\r\n").nth(1).unwrap_or("").to_string();
    (status, body)
}
