//! EasyTier 组网管理（sidecar）
//!
//!  桌面端把官方 `easytier-core` 作为 sidecar 随包分发（tauri.conf.json 的 bundle.externalBin），
//!  这里负责：拼参数 → 启动进程 → 用 easytier-cli 查询状态 → 停止。
//!
//!  支持的组网方式（对应 docs/11 §6）：
//!   ① 共享节点：-p tcp://public.easytier.cn:11010（可多个，容灾）
//!   ② 去中心化：只填其它节点的地址，不依赖公共服务
//!   ③ 托管模式：-w <用户名> 或 --config-server <URL>，由 EasyTier Web 控制台/自建 easytier-web 下发配置
//!
//!  注意：TUN 模式在 Windows 需要管理员、Linux 需要 root/CAP_NET_ADMIN；无权限时可改用 no-root 模式。

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::process::Stdio;
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

/// 当前 easytier-core 子进程（全局唯一：一台机器只应有一个 EasyTier 实例被我们管理）
static CHILD: Mutex<Option<Child>> = Mutex::const_new(None);

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct NetConfig {
    /// 网络名（等同于 EasyTier 的 --network-name）
    pub network_name: String,
    /// 网络密钥
    pub network_secret: String,
    /// 本机虚拟 IP；留空表示 DHCP 自动获取（-d）
    pub virtual_ip: Option<String>,
    /// 共享节点 / 对端地址列表（-p，可多个）
    pub peers: Vec<String>,
    /// 监听端口（-l），多开时需不同
    pub listen_port: Option<u16>,
    /// 托管模式：Web 控制台用户名（-w）或配置服务器地址（--config-server）
    pub config_server: Option<String>,
    /// 托管模式下的用户名
    pub username: Option<String>,
    /// 无 TUN 模式（免 root/管理员）
    pub no_tun: bool,
}

/// sidecar 路径：Tauri 会把 externalBin 放到与可执行文件同级的目录，文件名带目标三元组后缀
fn sidecar(name: &str) -> String {
    name.to_string()
}

/// 组装 easytier-core 参数（便于单测/排障：界面可展示实际执行的命令）
pub fn build_args(cfg: &NetConfig) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();

    match cfg.virtual_ip.as_deref() {
        Some(ip) if !ip.trim().is_empty() => { args.push("-i".into()); args.push(ip.trim().into()); }
        _ => args.push("-d".into()),
    }
    args.push("--network-name".into());
    args.push(cfg.network_name.clone());
    args.push("--network-secret".into());
    args.push(cfg.network_secret.clone());

    for p in &cfg.peers {
        if p.trim().is_empty() { continue; }
        args.push("-p".into());
        args.push(p.trim().to_string());
    }
    if let Some(port) = cfg.listen_port {
        args.push("-l".into());
        args.push(port.to_string());
    }
    if let Some(server) = cfg.config_server.as_deref() {
        if !server.trim().is_empty() {
            args.push("--config-server".into());
            args.push(server.trim().to_string());
        }
    } else if let Some(user) = cfg.username.as_deref() {
        if !user.trim().is_empty() {
            args.push("-w".into());
            args.push(user.trim().to_string());
        }
    }
    if cfg.no_tun {
        args.push("--no-tun".into());
    }
    args
}

pub async fn start(cfg: &NetConfig) -> Result<Value, String> {
    let mut guard = CHILD.lock().await;
    if let Some(child) = guard.as_mut() {
        // 已在运行：先停掉旧的，保证参数生效
        let _ = child.kill().await;
    }
    let args = build_args(cfg);
    let child = Command::new(sidecar("easytier-core"))
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("启动 easytier-core 失败：{}（安装包是否包含 sidecar？）", e))?;
    *guard = Some(child);
    Ok(json!({ "ok": true, "args": args }))
}

pub async fn stop() -> Result<Value, String> {
    let mut guard = CHILD.lock().await;
    match guard.as_mut() {
        Some(child) => {
            child.kill().await.map_err(|e| e.to_string())?;
            *guard = None;
            Ok(json!({ "ok": true }))
        }
        None => Ok(json!({ "ok": true, "message": "未在运行" })),
    }
}

/// 用 easytier-cli 拉取状态；失败时返回空表（不阻塞界面）
pub async fn status() -> Result<Value, String> {
    let running = CHILD.lock().await.is_some();
    let mut out = json!({ "running": running, "peers": [], "routes": [], "node": null });

    if !running {
        return Ok(out);
    }
    for (key, sub) in [("peers", "peer"), ("routes", "route"), ("node", "node")] {
        let res = Command::new(sidecar("easytier-cli"))
            .arg(sub)
            .output()
            .await;
        if let Ok(o) = res {
            let text = String::from_utf8_lossy(&o.stdout).to_string();
            out[key] = json!(text);
        }
    }
    Ok(out)
}
