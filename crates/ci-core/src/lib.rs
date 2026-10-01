//! ci-core —— 客户端门面
//!
//! 把"枢纽 + 存储 + 领域规则 + 组网"收在一处，apps/* 只依赖这个 crate。
//! 展示层（网页/Tauri 前端）通过 Tauri 命令或 HTTP/WS 访问这里的能力，
//! **不得**在前端复写业务规则。

pub mod net;

pub use ci_domain as domain;
pub use ci_hub as hub;
pub use ci_protocol as protocol;
pub use ci_store as store;

/// 版本号：出包与 /health 都用它（与 Cargo.toml 的 workspace.version 一致）
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
