//! 内置枢纽：把网页版 sync-server.js 的职责搬进客户端（HTTP + WebSocket 房间中继）
//!
//! 协议与 v3 **逐字一致**（契约见 packages/protocol/messages.js，Rust 侧常量由
//! `scripts/gen-protocol.mjs` 生成到 `protocol_gen.rs`，对照测试 tests/protocol.test.js）：
//!   welcome / state / leaderboard / dump / request / request-dump / cmd / cmd-backlog / ack / presence / error
//! 学生端（浏览器或 Android 客户端）与大屏不需要任何改动即可连上。
//!
//! 为什么用 Rust 重写：安装成桌面 App 后，教师机不应再依赖 Node 运行时。

/// 领域能力 HTTP 端点（判分/计分/能力/点名）：网页版据此调用 Rust 核心，
/// 而不是在浏览器里再实现一份规则（docs/14 §2 的硬规矩）
pub mod domain_api;

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query, State,
    },
    response::IntoResponse,
    routing::get,
    Json, Router,
};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex, RwLock};

use ci_store::{now_ms, Store};
use ci_protocol as proto;

/// 离线命令队列上限（与 Node 版 CMD_QUEUE_MAX 一致）
pub const CMD_QUEUE_MAX: usize = 60;

#[derive(Clone)]
pub struct HubState {
    pub rooms: Arc<RwLock<HashMap<String, Room>>>,
    pub db: Arc<Mutex<Store>>,
    pub port: u16,
}

#[derive(Default)]
pub struct Room {
    pub rev: i64,
    pub updated_at: i64,
    /// 轻量快照（广播给 stage/team）
    pub state: Option<Value>,
    /// 完整课堂存档（只在 host 与枢纽之间往返，**永不广播**）
    pub dump: Option<Value>,
    /// clientId -> 连接
    pub clients: HashMap<u64, Client>,
    /// 教师端离线时排队的命令
    pub queue: Vec<Value>,
    /// 队伍 -> 最近一次在线状态。**断开不移除**，只把 online 置 false：
    /// 这样教师端能区分"从未入座"与"曾入座、当前离线"（与 Node 版 presence 语义一致）
    pub known_teams: HashMap<String, TeamPresence>,
    next_id: u64,
}

#[derive(Clone)]
pub struct TeamPresence {
    pub label: String,
    pub online: bool,
    pub at: i64,
}

pub struct Client {
    role: String,             // host | stage | team
    team_id: Option<String>,
    label: Option<String>,
    tx: mpsc::UnboundedSender<Value>,
}

impl Room {
    pub fn add_client(&mut self, role: String, team_id: Option<String>, label: Option<String>, tx: mpsc::UnboundedSender<Value>) -> u64 {
        self.next_id += 1;
        let id = self.next_id;
        // 队伍一进来就登记（并置为在线）
        if let Some(tid) = &team_id {
            let entry = self.known_teams.entry(tid.clone()).or_insert_with(|| TeamPresence {
                label: label.clone().unwrap_or_else(|| tid.clone()),
                online: true,
                at: now_ms(),
            });
            entry.online = true;
            entry.at = now_ms();
            if let Some(l) = &label {
                entry.label = l.clone();
            }
        }
        self.clients.insert(id, Client { role, team_id, label, tx });
        id
    }

    pub fn remove_client(&mut self, id: u64) {
        let gone = self.clients.remove(&id);
        if let Some(c) = gone {
            if c.role == "team" {
                if let Some(tid) = c.team_id {
                    // 同队还有别的设备在线吗？
                    let still = self.clients.values().any(|o| o.role == "team" && o.team_id.as_deref() == Some(tid.as_str()));
                    if !still {
                        if let Some(entry) = self.known_teams.get_mut(&tid) {
                            entry.online = false;
                            entry.at = now_ms();
                        }
                    }
                }
            }
        }
    }

    /// 把命令放进离线队列（教师端不在线时用）；超过上限丢最旧的
    pub fn enqueue(&mut self, cmd: Value) -> usize {
        self.queue.push(cmd);
        if self.queue.len() > CMD_QUEUE_MAX {
            let overflow = self.queue.len() - CMD_QUEUE_MAX;
            self.queue.drain(0..overflow);
        }
        self.queue.len()
    }

    /// 导入备份：**dump 与轻量快照都要替换**（否则大屏/学生端会继续显示导入前的旧数据）
    /// 返回新的 rev。
    pub fn apply_restore(&mut self, state: Value) -> i64 {
        self.dump = Some(state.clone());
        self.state = Some(state);
        self.rev += 1;
        self.updated_at = now_ms();
        self.rev
    }

    /// 教师端是否在线
    pub fn host_online(&self) -> bool {
        self.clients.values().any(|c| c.role == "host")
    }

    pub fn send_to(&self, id: u64, msg: Value) {
        if let Some(c) = self.clients.get(&id) {
            let _ = c.tx.send(msg);
        }
    }

    /// 发给某个角色的所有连接（例如 host 可能开了多个窗口）
    pub fn send_to_role(&self, role: &str, msg: Value) {
        for c in self.clients.values() {
            if c.role == role {
                let _ = c.tx.send(msg.clone());
            }
        }
    }

    /// 广播给所有连接（可按 clientId 排除自己）
    pub fn broadcast(&self, msg: Value, except: Option<u64>) {
        for (id, c) in self.clients.iter() {
            if Some(*id) == except {
                continue;
            }
            let _ = c.tx.send(msg.clone());
        }
    }

    /// 在线小组状态（对应 Node 版 presenceList：**断开只把 online 置 false，不移除条目**）
    pub fn presence(&self) -> Value {
        let mut teams: Vec<Value> = Vec::new();
        for (tid, info) in self.known_teams.iter() {
            teams.push(json!({
                "teamId": tid,
                "label": info.label,
                "online": info.online,
                "at": info.at
            }));
        }
        teams.sort_by(|a, b| {
            a.get("label").and_then(|v| v.as_str()).unwrap_or("")
                .cmp(b.get("label").and_then(|v| v.as_str()).unwrap_or(""))
        });
        json!({
            "type": "presence",
            "hostOnline": self.host_online(),
            "teams": teams
        })
    }
}

#[derive(Deserialize)]
pub struct WsQuery {
    pub room: Option<String>,
    pub role: Option<String>,
    pub team: Option<String>,
    pub label: Option<String>,
}

#[derive(Deserialize)]
pub struct RoomQuery {
    pub room: Option<String>,
}

#[derive(Deserialize)]
pub struct StateBody {
    pub rev: Option<i64>,
    pub state: Option<Value>,
    pub dump: Option<Value>,
}

/// 房间号白名单清洗（与 Node 版 safeRoom 同规则：`[A-Za-z0-9_-]`，最长 32，空则回落 default）
pub fn safe_room(id: Option<String>) -> String {
    let raw = id.unwrap_or_else(|| "default".to_string());
    let cleaned: String = raw
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
        .take(32)
        .collect();
    if cleaned.is_empty() { "default".to_string() } else { cleaned }
}

/// 枢纽的路由（不绑端口）：独立服务器模式要在这上面再挂静态文件服务
pub fn router(state: HubState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/api/state", get(api_get_state).put(api_put_state))
        .route("/api/backup", get(api_backup))
        .route("/api/restore", axum::routing::post(api_restore))
        .route("/api/stats", get(api_stats))
        // 领域能力：网页版通过这几个端点调用 Rust 核心，而不是在前端重写规则
        .route("/api/domain/grade", axum::routing::post(domain_api::grade))
        .route("/api/domain/score", axum::routing::post(domain_api::score))
        .route("/api/domain/ability", axum::routing::post(domain_api::ability))
        .route("/api/domain/pick", axum::routing::post(domain_api::pick_handler))
          .route("/api/domain/stats", axum::routing::post(domain_api::stats))
          .route("/api/domain/ability-board", axum::routing::post(domain_api::ability_board))
          .route("/api/domain/open-eval", axum::routing::post(domain_api::open_eval))
        // 二维码：与 Node 版同一路径与查询参数（?text=…）。
        // 返回 SVG（浏览器 <img> 直接渲染），省掉 image/png 依赖。
        .route("/qr.png", get(qr_image))
        // WebSocket 同时挂在 "/" 与 "/ws"。
        // 客户端（教师端/学生端/大屏）连的是 ws://host:port/?room=…&role=…，
        // 而 Node 版枢纽对任意路径都同意升级；只挂 /ws 会让桌面端连不上自己的界面
        // —— 这是 hub_conformance 用例发现的（首轮 13 个用例全挂在 404）。
        .route("/", get(ws_handler))
        .route("/ws", get(ws_handler))
        .layer(tower_http::cors::CorsLayer::permissive())
        .with_state(state)
}

/// 启动枢纽（在 Tauri 的 tokio 运行时里 spawn）
pub async fn serve(state: HubState) -> Result<(), String> {
    let app = router(state.clone());
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", state.port))
        .await
        .map_err(|e| format!("端口 {} 绑定失败：{}", state.port, e))?;
    axum::serve(listener, app).await.map_err(|e| e.to_string())
}

async fn health(State(st): State<HubState>) -> impl IntoResponse {
    let rooms: Vec<String> = st.rooms.read().await.keys().cloned().collect();
    // ips 与 Node 版一致：教师端用它拼"学生端地址"，自检也会判断是不是局域网/组网网段。
    // 少了这个字段，界面只能退回 location.host（127.0.0.1），自检就会报"学生手机可能连不上"。
    let ips = local_ips();
    let counts = {
        let db = st.db.lock().await;
        let room = st.rooms.read().await.keys().next().cloned().unwrap_or_else(|| "default".to_string());
        db.stats(&room).unwrap_or_default().into_iter().collect::<HashMap<String, i64>>()
    };
    Json(json!({
        "ok": true,
        "service": "classroom-hub-rust",
        "port": st.port,
        "rooms": rooms,
        "ips": ips,
        "qrcode": false,
        "storage": "sqlite",
        "db": "classroom.db",
        "counts": counts
    }))
}

async fn api_get_state(State(st): State<HubState>, Query(q): Query<RoomQuery>) -> impl IntoResponse {
    let room = safe_room(q.room);
    let rooms = st.rooms.read().await;
    match rooms.get(&room) {
        Some(r) => Json(json!({
            "ok": true, "room": room, "rev": r.rev, "updatedAt": r.updated_at,
            "storage": "sqlite", "state": r.state, "dump": r.dump
        })),
        None => Json(json!({ "ok": true, "room": room, "rev": 0, "updatedAt": 0, "state": null, "dump": null })),
    }
}

async fn api_put_state(
    State(st): State<HubState>,
    Query(q): Query<RoomQuery>,
    Json(body): Json<StateBody>,
) -> impl IntoResponse {
    let room = safe_room(q.room);

    // 过期写入防护：客户端带 rev 且比当前小 → 拒绝（不覆盖更新的数据）
    let client_rev = body.rev.unwrap_or(0);
    {
        let rooms = st.rooms.read().await;
        if let Some(r) = rooms.get(&room) {
            if client_rev > 0 && client_rev < r.rev {
                return (
                    axum::http::StatusCode::CONFLICT,
                    Json(json!({
                        "ok": false, "stale": true, "room": room, "rev": r.rev, "updatedAt": r.updated_at,
                        "message": "枢纽上已有更新的数据，本次未覆盖；请先拉取最新状态"
                    })),
                );
            }
        }
    }

    let (rev, updated_at, payload) = {
        let mut rooms = st.rooms.write().await;
        let entry = rooms.entry(room.clone()).or_default();
        if let Some(s) = body.state {
            entry.state = Some(s);
        }
        if let Some(d) = body.dump {
            entry.dump = Some(d);
        }
        // 与 WS 路径同一套 rev 规则：带 rev 就采纳，没带才自增
        entry.rev = if client_rev > 0 { entry.rev.max(client_rev) } else { entry.rev + 1 };
        entry.updated_at = now_ms();
        (entry.rev, entry.updated_at, entry.state.clone())
    };

    // 落库（失败不影响内存态可用）
    {
        let rooms = st.rooms.read().await;
        if let Some(r) = rooms.get(&room) {
            let mut db = st.db.lock().await;
            // 落库失败**不能吞**：原来回 ok:true 但库里没写，重启就丢（审计实测过）
            if let Err(e) = db.save_room(&room, r.rev, r.state.as_ref(), r.dump.as_ref()) {
                eprintln!("[hub] 恢复落库失败 room={}: {}", room, e);
                return (
                    axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({ "ok": false, "message": format!("落库失败：{}", e) })),
                );
            }
        }
    }

    // 大屏与学生端立刻看到新数据
    if payload.is_some() {
        let rooms = st.rooms.read().await;
        if let Some(r) = rooms.get(&room) {
            r.broadcast(json!({ "type": "state", "room": room, "rev": rev, "payload": payload }), None);
        }
    }
    (
        axum::http::StatusCode::OK,
        Json(json!({ "ok": true, "room": room, "rev": rev, "updatedAt": updated_at })),
    )
}

async fn api_stats(State(st): State<HubState>, Query(q): Query<RoomQuery>) -> impl IntoResponse {
    let room = safe_room(q.room);
    let db = st.db.lock().await;
    let counts = db.stats(&room).unwrap_or_default();
    let tier = db.student_tier(&room).unwrap_or_default();
    // scores / rooms 与 Node 版 /api/stats 对齐：
    // 教师端「排行榜」与"上课前自检"都会读这两个字段，缺了会在前端报 undefined.length
    // —— 这是把端到端测试切到 Rust 枢纽时发现的
    let scores = db.scores(&room).unwrap_or_default();
    let rooms = db.list_rooms().unwrap_or_default();
    Json(json!({
        "ok": true, "room": room,
        "counts": counts.into_iter().collect::<HashMap<String, i64>>(),
        "scores": scores.into_iter().take(100).collect::<Vec<_>>(),
        "studentTier": tier.into_iter().map(|(sid, t, a, c, e)| json!({
            "sid": sid, "tier": t, "attempts": a, "correct": c, "earned": e
        })).collect::<Vec<_>>(),
        "rooms": rooms
    }))
}

/// 导出完整课堂存档（与 Node 版 /api/backup 同结构：`{type:'ci-backup', version, state}`）
/// 前端「导出全部数据」与换设备迁移都用它；网页版与客户端产出完全一致，可互相导入。
async fn api_backup(State(st): State<HubState>, Query(q): Query<RoomQuery>) -> impl IntoResponse {
    let room = safe_room(q.room);
    let (code, body) = {
        let rooms = st.rooms.read().await;
        match rooms.get(&room).and_then(|r| r.dump.clone()) {
            Some(dump) => (
                200,
                json!({
                    "type": "ci-backup",
                    "version": 3,
                    "exportedAt": now_ms(),
                    "state": dump
                }),
            ),
            None => (404, json!({ "ok": false, "message": "该房间还没有数据" })),
        }
    };
    (axum::http::StatusCode::from_u16(code).unwrap_or(axum::http::StatusCode::OK), Json(body))
}

/// 导入备份（接受 ci-backup 或裸 state），写入内存 + SQLite，并广播给大屏/学生端
async fn api_restore(
    State(st): State<HubState>,
    Query(q): Query<RoomQuery>,
    Json(body): Json<Value>,
) -> impl IntoResponse {
    let room = safe_room(q.room);
    let state = body.get("state").cloned().unwrap_or_else(|| body.clone());
    if !state.is_object() {
        return (
            axum::http::StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "message": "备份格式不正确（需要 ci-backup 或裸 state）" })),
        );
    }

    let rev = {
        let mut rooms = st.rooms.write().await;
        // 导入的是"整份课堂数据"：dump 与轻量快照都要替换（与 Node 版一致）
        rooms.entry(room.clone()).or_default().apply_restore(state.clone())
    };
    {
        let rooms = st.rooms.read().await;
        if let Some(r) = rooms.get(&room) {
            let mut db = st.db.lock().await;
            let _ = db.save_room(&room, r.rev, r.state.as_ref(), r.dump.as_ref());
        }
    }
    {
        let rooms = st.rooms.read().await;
        if let Some(r) = rooms.get(&room) {
            r.broadcast(json!({ "type": "state", "room": room, "rev": rev, "payload": state }), None);
        }
    }
    (axum::http::StatusCode::OK, Json(json!({ "ok": true, "room": room, "rev": rev })))
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    Query(q): Query<WsQuery>,
    State(st): State<HubState>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, q, st))
}

async fn handle_socket(socket: WebSocket, q: WsQuery, st: HubState) {
    let room_id = safe_room(q.room.clone());
    let role = match q.role.as_deref() {
        Some("host") => "host",
        Some("team") => "team",
        _ => "stage",
    }
    .to_string();

    let (mut sender, mut receiver) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<Value>();

    // 注册连接，并取回欢迎信息所需的房间状态
    let (client_id, rev, has_state, has_dump, host_online, state_for_me, backlog) = {
        let mut rooms = st.rooms.write().await;
        let r = rooms.entry(room_id.clone()).or_default();
        let id = r.add_client(role.clone(), q.team.clone(), q.label.clone(), tx.clone());

        // 教师端上线：把离线期间排队的命令一次性补发
        let backlog = if role == "host" && !r.queue.is_empty() {
            Some(r.queue.drain(..).collect::<Vec<Value>>())
        } else {
            None
        };
        (
            id,
            r.rev,
            r.state.is_some(),
            r.dump.is_some(),
            r.host_online(),
            if role == "host" { None } else { r.state.clone() },
            backlog,
        )
    };

    // ① welcome
    let _ = sender
        .send(Message::Text(
            json!({
                "type": "welcome",
                "room": room_id,
                "role": role,
                "clientId": client_id,
                "teamId": q.team,
                "label": q.label,
                "serverTime": now_ms(),
                "rev": rev,
                "hasState": has_state,
                "hasDump": has_dump,
                "hostOnline": host_online
            })
            .to_string(),
        ))
        .await;

    // ② 非教师端：立刻补一份快照（大屏/学生端一连上就有数据）
    if let Some(payload) = state_for_me {
        let _ = sender
            .send(Message::Text(
                json!({ "type": "state", "room": room_id, "rev": rev, "payload": payload }).to_string(),
            ))
            .await;
    }

    // ③ 教师端：补发离线命令
    if let Some(cmds) = backlog {
        let _ = sender
            .send(Message::Text(json!({ "type": "cmd-backlog", "cmds": cmds }).to_string()))
            .await;
    }

    // ④ 广播在线状态（有人进来/换队都会变）
    broadcast_presence(&st, &room_id).await;

    // 出站任务：把 mpsc 里的消息写给 WebSocket
    let mut send_task = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if sender.send(Message::Text(msg.to_string())).await.is_err() {
                break;
            }
        }
    });

    // 入站任务：按协议处理
    let st2 = st.clone();
    let room2 = room_id.clone();
    let role2 = role.clone();
    let mut recv_task = tokio::spawn(async move {
        while let Some(Ok(msg)) = receiver.next().await {
            let text = match msg {
                Message::Text(t) => t,
                Message::Binary(b) => String::from_utf8_lossy(&b).to_string(),
                Message::Close(_) => break,
                _ => continue,
            };
            let parsed: Value = match serde_json::from_str(&text) {
                Ok(v) => v,
                Err(_) => continue,
            };
            handle_client_message(&st2, &room2, client_id, &role2, parsed).await;
        }
    });

    tokio::select! {
        _ = (&mut send_task) => recv_task.abort(),
        _ = (&mut recv_task) => send_task.abort(),
    }

    // 断开：注销并刷新在线状态
    {
        let mut rooms = st.rooms.write().await;
        if let Some(r) = rooms.get_mut(&room_id) {
            r.remove_client(client_id);
        }
    }
    broadcast_presence(&st, &room_id).await;
}

/// 处理一条客户端报文（与 Node 版 switch 一一对应）
async fn handle_client_message(st: &HubState, room_id: &str, client_id: u64, role: &str, msg: Value) {
    let kind = msg.get("type").and_then(|v| v.as_str()).unwrap_or("");

    match kind {
        // v2 兼容别名：老客户端推 leaderboard，语义等同 state
        "state" | "leaderboard" => {
            if role != "host" {
                send_error(st, room_id, client_id, "只有教师端可以推送状态").await;
                return;
            }
            let payload = match msg.get("payload") {
                Some(p) => p.clone(),
                None => return,
            };
            // rev 规则必须与 HTTP 的 /api/state 一致：带了就采纳，没带才自增
            // （否则同一份数据经两条路径写入时，其中一条会被判"过期"）
            let client_rev = msg.get("rev").and_then(|v| v.as_i64()).unwrap_or(0);
            let (rev, updated) = {
                let mut rooms = st.rooms.write().await;
                let r = rooms.entry(room_id.to_string()).or_default();
                r.state = Some(payload.clone());
                r.rev = if client_rev > 0 { r.rev.max(client_rev) } else { r.rev + 1 };
                r.updated_at = now_ms();
                (r.rev, (r.state.clone(), r.dump.clone()))
            };
            {
                let mut db = st.db.lock().await;
                let _ = db.save_room(room_id, rev, updated.0.as_ref(), updated.1.as_ref());
            }
            let rooms = st.rooms.read().await;
            if let Some(r) = rooms.get(room_id) {
                // 广播给除自己以外的所有人（教师端自己的界面由前端负责渲染）
                r.broadcast(json!({ "type": "state", "room": room_id, "rev": rev, "payload": payload }), Some(client_id));
            }
        }

        "dump" => {
            if role != "host" {
                send_error(st, room_id, client_id, "只有教师端可以推送课堂数据").await;
                return;
            }
            let payload = match msg.get("payload") {
                Some(p) => p.clone(),
                None => return,
            };
            let (rev, state, dump) = {
                let mut rooms = st.rooms.write().await;
                let r = rooms.entry(room_id.to_string()).or_default();
                r.dump = Some(payload.clone());
                // **不要把 dump 当 state**：dump 是完整存档（含答案与全部名单），
                // 当成 state 后每个 team/stage 一连上就会拿到它 —— 等于泄题（审计实测过）。
                // 没有轻量快照时就不发 state，等教师端推。
                r.rev += 1;
                r.updated_at = now_ms();
                (r.rev, r.state.clone(), r.dump.clone())
            };
            {
                let mut db = st.db.lock().await;
                let _ = db.save_room(room_id, rev, state.as_ref(), dump.as_ref());
            }
            // dump 只在 host 与枢纽之间往返：这里**不广播**，只回执给教师端自己
            let rooms = st.rooms.read().await;
            if let Some(r) = rooms.get(room_id) {
                r.send_to(client_id, json!({ "type": "state", "room": room_id, "rev": rev, "payload": state }));
            }
        }

        "request" => {
            let rooms = st.rooms.read().await;
            if let Some(r) = rooms.get(room_id) {
                match (&r.state, r.rev) {
                    (Some(p), rev) => r.send_to(client_id, json!({ "type": "state", "room": room_id, "rev": rev, "payload": p })),
                    (None, _) => drop(rooms),
                }
            }
            let rooms = st.rooms.read().await;
            if let Some(r) = rooms.get(room_id) {
                if r.state.is_none() {
                    r.send_to(client_id, json!({ "type": "error", "message": "暂无课堂数据（教师端还没推送）" }));
                }
            }
        }

        "request-dump" => {
            if role != "host" {
                send_error(st, room_id, client_id, "只有教师端可以读取课堂数据").await;
                return;
            }
            let rooms = st.rooms.read().await;
            if let Some(r) = rooms.get(room_id) {
                match (&r.dump, r.rev) {
                    (Some(d), rev) => r.send_to(client_id, json!({ "type": "dump", "room": room_id, "rev": rev, "payload": d })),
                    (None, _) => r.send_to(client_id, json!({ "type": "error", "message": "枢纽上没有课堂数据存档" })),
                }
            }
        }

        "hello" => {
            // 枢纽级身份宣告（扁平字段，与 Node 版一致）：
            // {type:'hello', role?, teamId?, label?} —— 更新连接身份并刷新 presence。
            // 注意：业务命令 {type:'cmd',cmd:{kind:'hello'}} 走下面的 cmd 分支转发给教师端。
            let role_update = msg.get("role").and_then(|v| v.as_str());
            let team = msg.get("teamId").and_then(|v| v.as_str()).map(|s| s.to_string());
            let label = msg.get("label").and_then(|v| v.as_str()).map(|s| s.to_string());
            {
                let mut rooms = st.rooms.write().await;
                let r = rooms.entry(room_id.to_string()).or_default();
                if let Some(c) = r.clients.get_mut(&client_id) {
                    if let Some(ro) = role_update {
                        if ["host", "stage", "team"].contains(&ro) {
                            // **不允许把自己提成 host**：host 是教师端的身份，
                            // 允许提权等于任何人发一条 hello 就能收到全部课堂命令、
                            // 并把真教师的离线队列吞掉（审计实测过）。
                            // 只允许"降级/平级"（host→stage/team 是合法的重连场景）。
                            let may = if ro == "host" {
                                c.role == "host"        // 已经是 host 才允许保持 host
                            } else {
                                true                // stage/team 之间随便切
                            };
                            if may {
                                c.role = ro.to_string();
                            }
                        }
                    }
                    if team.is_some() {
                        c.team_id = team.clone();
                    }
                    if label.is_some() {
                        c.label = label.clone();
                    }
                }
                if let Some(tid) = team {
                    let entry = r.known_teams.entry(tid.clone()).or_insert_with(|| TeamPresence {
                        label: label.clone().unwrap_or_else(|| tid.clone()),
                        online: true,
                        at: now_ms(),
                    });
                    entry.online = true;
                    entry.at = now_ms();
                    if let Some(l) = label {
                        entry.label = l;
                    }
                }
            }
            // 与 Node 版一致：hello 后也给发起者回一份 welcome + 当前快照
            let (rev, state) = {
                let rooms = st.rooms.read().await;
                match rooms.get(room_id) {
                    Some(r) => (r.rev, r.state.clone()),
                    None => (0, None),
                }
            };
            let rooms = st.rooms.read().await;
            if let Some(r) = rooms.get(room_id) {
                r.send_to(client_id, json!({
                    "type": "welcome", "room": room_id, "role": role, "clientId": client_id,
                    "serverTime": now_ms(), "rev": rev,
                    "hasState": state.is_some(), "hasDump": r.dump.is_some(), "hostOnline": r.host_online()
                }));
                if let Some(p) = state {
                    r.send_to(client_id, json!({ "type": "state", "room": room_id, "rev": rev, "payload": p }));
                }
            }
            broadcast_presence(st, room_id).await;
        }

        "cmd" => {
            let cmd = match msg.get("cmd") {
                Some(c) => c.clone(),
                None => return,
            };
            let host_online = {
                let rooms = st.rooms.read().await;
                rooms.get(room_id).map(|r| r.host_online()).unwrap_or(false)
            };
            let cmd_id = cmd.get("id").cloned().unwrap_or(Value::Null);

            if host_online {
                let rooms = st.rooms.read().await;
                if let Some(r) = rooms.get(room_id) {
                    r.send_to_role("host", json!({ "type": "cmd", "room": room_id, "cmd": cmd }));
                }
                let rooms = st.rooms.read().await;
                if let Some(r) = rooms.get(room_id) {
                    r.send_to(client_id, json!({ "type": "ack", "cmdId": cmd_id, "ok": true }));
                }
            } else {
                // 教师端离线：入队（≤60），并明确回执"已排队"，避免学生重复点
                let rooms = st.rooms.read().await;
                if let Some(r) = rooms.get(room_id) {
                    r.send_to(client_id, json!({ "type": "ack", "cmdId": cmd_id, "ok": false, "reason": "teacher-offline" }));
                }
                drop(rooms);
                let mut rooms = st.rooms.write().await;
                rooms.entry(room_id.to_string()).or_default().enqueue(cmd);
            }
        }

        _ => { /* 未知报文：忽略（与 Node 版一致） */ }
    }
}

async fn send_error(st: &HubState, room_id: &str, client_id: u64, message: &str) {
    let rooms = st.rooms.read().await;
    if let Some(r) = rooms.get(room_id) {
        r.send_to(client_id, json!({ "type": "error", "message": message }));
    }
}

async fn broadcast_presence(st: &HubState, room_id: &str) {
    let rooms = st.rooms.read().await;
    if let Some(r) = rooms.get(room_id) {
        let mut p = r.presence();
        if let Some(obj) = p.as_object_mut() {
            obj.insert("room".to_string(), json!(room_id));
        }
        r.broadcast(p, None);
    }
}

/* ================= 与 Node 版对齐的辅助接口 ================= */

/// `/qr.png?text=…` —— 生成二维码（SVG）
///
/// 与 Node 版一致的语义：装不了/生成失败时前端会自动降级为文字地址，
/// 所以这里出错返回 500 + 可读原因，而不是让页面白屏。
async fn qr_image(Query(q): Query<QrQuery>) -> axum::response::Response {
    use axum::body::Body;
    use axum::http::{header, StatusCode};

    let text = q.text.unwrap_or_else(|| "default".to_string());
    match qrcode::QrCode::new(text.as_bytes()) {
        Ok(code) => {
            let svg = code
                .render::<qrcode::render::svg::Color>()
                .min_dimensions(260, 260)
                .quiet_zone(true)
                .build();
            axum::response::Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, "image/svg+xml; charset=utf-8")
                .header(header::CACHE_CONTROL, "no-store")
                .body(Body::from(svg))
                .unwrap()
        }
        Err(e) => axum::response::Response::builder()
            .status(StatusCode::INTERNAL_SERVER_ERROR)
            .header(header::CONTENT_TYPE, "application/json; charset=utf-8")
            .body(Body::from(
                json!({ "ok": false, "message": format!("二维码生成失败：{}", e) }).to_string(),
            ))
            .unwrap(),
    }
}

#[derive(Deserialize)]
pub struct QrQuery {
    pub text: Option<String>,
}

/// 本机可用于学生端连接的 IP（局域网/组网网段优先）
/// 枚举**所有**网卡，而不是只看默认出口 —— 教室里的教师机常同时有有线/无线/
/// EasyTier 虚拟网卡，学生手机要连的那个往往不是默认路由那一个。
/// （以前这里是空实现，前端只能退回 127.0.0.1，自检会误报"学生手机可能连不上"。）
pub fn local_ips() -> Vec<String> {
    let is_private = |ip: &str| {
        ip.starts_with("192.168.") || ip.starts_with("10.") || {
            if let Some(rest) = ip.strip_prefix("172.") {
                let second: u32 = rest.split('.').next().and_then(|x| x.parse().ok()).unwrap_or(0);
                (16..=31).contains(&second)
            } else {
                false
            }
        }
    };

    let mut out: Vec<String> = Vec::new();
    if let Ok(ifaces) = if_addrs::get_if_addrs() {
        for i in ifaces {
            if let std::net::IpAddr::V4(v4) = i.addr.ip() {
                // 排除回环与链路本地（169.254.x）
                if !v4.is_loopback() && !v4.is_link_local() {
                    let ip = v4.to_string();
                    if !out.contains(&ip) {
                        out.push(ip);
                    }
                }
            }
        }
    }
    // 局域网/组网网段排前面：前端取第一个当"学生端地址"
    out.sort_by_key(|ip| if is_private(ip) { 0 } else { 1 });
    out
}

/// 序列化辅助：给 UI 展示的房间摘要
pub fn room_summary(r: &Room) -> Value {
    json!({
        "rev": r.rev,
        "updatedAt": r.updated_at,
        "clients": r.clients.len(),
        "hostOnline": r.host_online(),
        "queued": r.queue.len()
    })
}

/// 供 tests/ci.test.js 与 tests/protocol.test.js 做静态自查：
/// 本文件声明支持的报文类型，直接引用**生成**的契约常量（避免手写漂移）
pub const SUPPORTED_TYPES: &[&str] = proto::ALL_TYPES;

/// 生成常量的存在性断言：编译期就能发现"忘了跑 gen-protocol"
const _: () = {
    assert!(proto::PROTOCOL_VERSION == 3);
    assert!(!proto::ALL_TYPES.is_empty());
};
