//! server.rs —— 独立枢纽服务器（等价于 Node 版的 sync-server.js）
//!
//! 用途：
//!   · **P2 的验收手段**：让两条浏览器端到端测试改打 Rust 枢纽（而不是 Node 枢纽）
//!   · 教室里的"教师机不装客户端，只跑一个枢纽"场景
//!   · 本机开发时替代 `node sync-server.js`
//!
//! 与 Node 版对齐的行为：`/health`、`/api/*`、WebSocket（`/` 与 `/ws`）、
//! 静态文件服务（UI + 资源；`serve_tests` 打开时也服务 `/tests`）。
//! 安全策略与 sync-server.js 一致：禁止越出根目录、禁止点号目录、默认不服务 tests/docs。

use ci_hub::{router as hub_router, HubState};
use ci_store::Store;
use serde_json::json;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::{Mutex, RwLock};

/// 服务器启动参数
#[derive(Debug, Clone)]
pub struct ServerOptions {
    pub host: String,
    pub port: u16,
    /// 数据目录（SQLite 落在这里）
    pub data_dir: PathBuf,
    /// 静态文件根目录（通常是仓库根或客户端 ui/）
    pub static_root: PathBuf,
    /// 是否服务 tests 目录（只有本地 CI 才开）
    pub serve_tests: bool,
    /// 静态服务开关（桌面端内置枢纽不需要）
    pub serve_static: bool,
}

impl Default for ServerOptions {
    fn default() -> Self {
        ServerOptions {
            host: "0.0.0.0".to_string(),
            port: 8080,
            data_dir: PathBuf::from("data"),
            static_root: PathBuf::from("."),
            serve_tests: false,
            serve_static: true,
        }
    }
}

impl ServerOptions {
    /// 从环境变量读取（PORT / HOST / DATA_DIR / STATIC_ROOT / SERVE_TESTS）
    pub fn from_env() -> Self {
        let mut o = ServerOptions::default();
        if let Ok(v) = std::env::var("PORT") {
            if let Ok(p) = v.parse() {
                o.port = p;
            }
        }
        if let Ok(v) = std::env::var("HOST") {
            o.host = v;
        }
        if let Ok(v) = std::env::var("DATA_DIR") {
            o.data_dir = PathBuf::from(v);
        }
        if let Ok(v) = std::env::var("STATIC_ROOT") {
            o.static_root = PathBuf::from(v);
        }
        o.serve_tests = std::env::var("SERVE_TESTS").map(|v| v == "1" || v == "true").unwrap_or(false);
        o
    }
}

/// 启动独立枢纽（阻塞直到进程结束）
pub async fn run(opts: ServerOptions) -> Result<(), String> {
    std::fs::create_dir_all(&opts.data_dir).map_err(|e| format!("创建数据目录失败：{}", e))?;
    let db_file = opts.data_dir.join("classroom.db");
    let store = Store::open(&db_file).map_err(|e| format!("打开数据库失败：{}", e))?;

    let state = HubState {
        rooms: Arc::new(RwLock::new(HashMap::new())),
        db: Arc::new(Mutex::new(store)),
        port: opts.port,
    };

    let mut app = hub_router(state);
    if opts.serve_static {
        let root = opts
            .static_root
            .canonicalize()
            .map_err(|e| format!("静态根目录不存在：{}", e))?;
        let serve_tests = opts.serve_tests;
        // 兜底路由：命中文件就返回，否则 404。
        // 用 fallback 而不是 nest_service，避免遮住上面的 /health、/api、WebSocket。
        app = app.fallback(move |req: axum::extract::Request| {
            let root = root.clone();
            async move { serve_static(root, serve_tests, req).await }
        });
    }

    let addr = format!("{}:{}", opts.host, opts.port);
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .map_err(|e| format!("端口绑定失败（{}）：{}", addr, e))?;
    println!("课代表枢纽（Rust）已启动");
    println!("  监听   : http://{addr}");
    println!("  数据   : {}", db_file.display());
    println!("  静态   : {}{}", opts.static_root.display(), if opts.serve_static { "" } else { "（已关闭）" });
    println!("  测试目录: {}", if opts.serve_tests { "服务中" } else { "不对外" });
    axum::serve(listener, app).await.map_err(|e| e.to_string())
}

/// 读文件并回响应（静态服务的公共部分）
async fn file_response(target: &std::path::Path) -> axum::response::Response {
    use axum::body::Body;
    use axum::http::{header, StatusCode};
    match tokio::fs::read(target).await {
        Ok(bytes) => axum::response::Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, mime_of(target))
            .body(Body::from(bytes))
            .unwrap(),
        Err(_) => axum::response::Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Body::from("404 Not Found"))
            .unwrap(),
    }
}

/// 静态文件服务（与 sync-server.js 的策略一致）
async fn serve_static(
    root: PathBuf,
    serve_tests: bool,
    req: axum::extract::Request,
) -> axum::response::Response {
    use axum::body::Body;
    use axum::http::{header, StatusCode};

    let url_path = req.uri().path().to_string();
    // 只支持读
    if req.method() != axum::http::Method::GET && req.method() != axum::http::Method::HEAD {
        return axum::response::Response::builder()
            .status(StatusCode::METHOD_NOT_ALLOWED)
            .body(Body::from("405 Method Not Allowed"))
            .unwrap();
    }

    /* 主路径 → Vue 构建产物（与 sync-server.js 同一套映射，2026-10 起界面统一到 Vue） */
    let dist = root.join("web").join("dist");
    let dist_ready = dist.join("admin.html").exists();
    let mut rel = url_path.trim_start_matches('/').to_string();

    if dist_ready {
        let alias = match url_path.as_str() {
            "/" | "/admin" | "/admin.html" => Some("admin.html"),
            "/join" | "/s" | "/student" => Some("student.html"),
            "/stage" | "/big" | "/screen" => Some("index.html"),
            "/favicon.svg" => Some("favicon.svg"),
            _ => None,
        };
        if let Some(name) = alias {
            let f = dist.join(name);
            return file_response(&f).await;
        }
        if let Some(rest) = url_path.strip_prefix("/assets/") {
            // 显式拒绝点段：starts_with 在非 Windows 主机上挡不住 ../
            // （Windows 上只是恰好被 canonicalize 的 verbatim 前缀 + PathBuf::push 折叠救了）
            let dotted_asset = rest
                .split('/')
                .any(|seg| seg == ".." || (seg.starts_with('.') && seg != "."));
            if !dotted_asset {
                let f = dist.join("assets").join(rest);
                if f.starts_with(&dist) {
                    return file_response(&f).await;
                }
            }
        }
        // 旧版零构建页面已于 2026-10 删除（界面统一到 Vue）
    }

    let mut target = root.join(&rel);
    if target.is_dir() {
        target = target.join("index.html");
    }

    // 目录穿越防护：解析后必须仍在根目录内；且不允许点号目录（.git/.env 之类）
    let inside = target.starts_with(&root);
    let dotted = rel.split('/').any(|seg| seg.starts_with('.') && seg != ".");
    let blocked_dir = {
        let first = rel.split('/').next().unwrap_or("");
        // data/ 放的是**实时课堂数据库**（classroom.db + -wal），绝不能当静态资源发出去
        // （审计实测：GET /data/classroom.db 能下到 344KB 的 SQLite）
        first == "node_modules"
            || first == "rooms"
            || first == "data"
            || (!serve_tests && (first == "tests" || first == "docs"))
    };
    // 数据库文件一律不发（不论在哪个目录）
    let blocked_file = {
        let low = rel.to_ascii_lowercase();
        low.ends_with(".db") || low.ends_with(".db-wal") || low.ends_with(".db-shm") || low.ends_with(".sqlite")
    };
    if !inside || dotted || blocked_dir || blocked_file {
        return axum::response::Response::builder()
            .status(StatusCode::FORBIDDEN)
            .body(Body::from("403 Forbidden"))
            .unwrap();
    }

    match tokio::fs::read(&target).await {
        Ok(bytes) => {
            let mime = mime_of(&target);
            axum::response::Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, mime)
                .body(Body::from(bytes))
                .unwrap()
        }
        Err(_) => axum::response::Response::builder()
            .status(StatusCode::NOT_FOUND)
            .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
            .body(Body::from(format!("404 Not Found: {}", rel)))
            .unwrap(),
    }
}

fn mime_of(p: &Path) -> &'static str {
    match p.extension().and_then(|e| e.to_str()).unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "map" => "application/json; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// `/health` 的响应体形状（与 hub 的 health 保持一致，便于冒烟测试判断版本）
pub fn health_hint(port: u16) -> serde_json::Value {
    json!({ "ok": true, "port": port, "service": "classroom-hub-rust" })
}
