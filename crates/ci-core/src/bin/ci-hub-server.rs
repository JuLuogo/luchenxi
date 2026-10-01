//! ci-hub-server —— 独立枢纽（Rust 版 sync-server.js）
//!
//!   cargo run -p ci-core --bin ci-hub-server
//!   PORT=8231 SERVE_TESTS=1 DATA_DIR=/tmp/ci STATIC_ROOT=. cargo run -p ci-core --bin ci-hub-server
//!
//! 环境变量：PORT / HOST / DATA_DIR / STATIC_ROOT / SERVE_TESTS

#[tokio::main]
async fn main() {
    let opts = ci_core::server::ServerOptions::from_env();
    if let Err(e) = ci_core::server::run(opts).await {
        eprintln!("枢纽启动失败：{}", e);
        std::process::exit(1);
    }
}
