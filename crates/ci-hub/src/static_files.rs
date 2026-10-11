//! static_files.rs —— 静态文件服务（**枢纽的公共能力**）
//!
//! 为什么放在这里（2026-10-11 修复）：
//!   这一层原来**只在 `ci-core` 的独立枢纽服务器里**（`server.rs`），
//!   而**教师端桌面 App 的内置枢纽没有它** —— 于是装完教师端之后：
//!     · 「复制学生端地址」给的是 `http://<IP>:8080/join?room=…`，而内置枢纽没有 `/join` → 学生用浏览器**打不开**
//!     · 「打开大屏」用相对路径 `/stage`，在 Tauri 里会解析到自定义协议 → **大屏打不开**
//!   两者都是"教师端看起来只是个壳子"的直接原因。
//!
//!   现在把它提到 `ci-hub`，**独立枢纽与桌面端内置枢纽共用同一实现**：
//!     · 独立枢纽：`ci_hub::router_with_static(state, 仓库根, serve_tests)`
//!     · 桌面端：`ci_hub::serve_with_static(state, 资源目录, false)`（UI 作为 bundle.resources 打进去）
//!
//! 映射约定（与 Node 版 `sync-server.js` 一致，界面 2026-10 起统一到 Vue）：
//!   `/` `/admin`      → `web/dist/admin.html`
//!   `/join` `/s`      → `web/dist/student.html`
//!   `/stage` `/big`   → `web/dist/index.html`
//!   `/assets/*`       → `web/dist/assets/*`

use axum::Router;
use std::path::{Path, PathBuf};

use crate::HubState;

/// 在枢纽路由上挂一层**静态兜底**（不遮住 `/health`、`/api/*`、WebSocket）
pub fn router_with_static(state: HubState, static_root: PathBuf, serve_tests: bool) -> Router {
    let root = static_root;
    crate::router(state).fallback(move |req: axum::extract::Request| {
        let root = root.clone();
        async move { serve_static(root, serve_tests, req).await }
    })
}

/// 启动带静态服务的枢纽（桌面端内置枢纽用这个）
pub async fn serve_with_static(
    state: HubState,
    static_root: PathBuf,
    serve_tests: bool,
) -> Result<(), String> {
    let app = router_with_static(state.clone(), static_root, serve_tests);
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", state.port))
        .await
        .map_err(|e| format!("端口 {} 绑定失败：{}", state.port, e))?;
    axum::serve(listener, app).await.map_err(|e| e.to_string())
}

/// 读文件并回响应（静态服务的公共部分）
pub async fn file_response(target: &Path) -> axum::response::Response {
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
pub async fn serve_static(
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
    let rel = url_path.trim_start_matches('/').to_string();

    if dist_ready {
        let alias = match url_path.as_str() {
            "/" | "/admin" | "/admin.html" => Some("admin.html"),
            "/join" | "/s" | "/student" | "/student.html" => Some("student.html"),
            "/stage" | "/big" | "/screen" | "/index.html" => Some("index.html"),
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

/// 扩展名 → Content-Type
pub fn mime_of(p: &Path) -> &'static str {
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
