//! 课堂积分 · 学生小组端（Tauri v2）库入口
//!
//!  **移动端必需**：Tauri v2 的 Android/iOS 工程只能调用 `lib` target，
//!  桌面端 `main.rs` 也是薄壳调用 `run()`。
//!
//!  学生端刻意保持"轻"：不连数据库、不做枢纽，只做三件事
//!   ① 承载现有 student.html（入座 / 答题 / 抢答 / 看板 / 公屏模式）
//!   ② 记住教师机地址（扫码或手输），并提供连通性自检
//!   ③ 组网引导：同局域网直连，或先装 EasyTier 官方 App 加入虚拟网后连教师机虚拟 IP
//!
//!  连接目标由前端 student.js 的 `ci_ws_host` / `ci_room` 决定；这里只补一个「自检」命令，
//!  让 Android 端能在进教室前先确认能不能连上教师机。

use serde_json::{json, Value};

/// 连通性自检：尝试访问教师机枢纽的 /health
/// 说明：自检用最朴素的阻塞式 HTTP（只为省一个 http 客户端依赖），因此放到阻塞线程池里跑，
///       避免卡住异步运行时。
#[tauri::command]
async fn check_hub(host: String) -> Result<Value, String> {
    let base = normalize(&host);
    if base.is_empty() {
        return Ok(json!({ "ok": false, "message": "没有填写教师机地址" }));
    }
    let url = format!("{}/health", base);
    let result = tauri::async_runtime::spawn_blocking({
        let url = url.clone();
        move || reqwest_get(&url)
    })
    .await
    .unwrap_or_else(|e| Err(format!("自检线程异常：{}", e)));

    Ok(match result {
        Ok(text) => json!({ "ok": true, "url": url, "response": text }),
        Err(e) => json!({ "ok": false, "url": url, "message": e }),
    })
}

/// 把用户输入（IP、IP:端口、http://…、甚至整条 /join 链接）规范成 `scheme://host:port`
///
/// 与前端 `assets/js/student.js` 的 `hubHost()` 规则一致（见 tests/net.test.js 的双实现对照）：
///   · 允许直接粘贴教师端给的整条链接（截断到 `/join` 之前）
///   · 没写协议头默认 `http://`
///   · 没写端口默认 `8080`
///   · 去掉路径与结尾斜杠
pub fn normalize(input: &str) -> String {
    let mut s = input.trim().to_string();
    if s.is_empty() {
        return String::new();
    }
    // 允许直接粘贴教师端给的整条链接
    if let Some(idx) = s.find("/join") {
        s = s[..idx].to_string();
    }
    let has_scheme = s.starts_with("http://") || s.starts_with("https://");
    if !has_scheme {
        s = format!("http://{}", s);
    }
    let (scheme, rest) = match s.split_once("://") {
        Some((a, b)) => (a.to_string(), b.to_string()),
        None => ("http".to_string(), s.clone()),
    };
    let hostpart = rest.split('/').next().unwrap_or("").to_string();
    let hostport = if hostpart.contains(':') {
        hostpart
    } else {
        format!("{}:{}", hostpart, 8080)
    };
    format!("{}://{}", scheme, hostport)
}

/// 极简 GET（学生端不想为一次自检引入整套 HTTP 客户端）
fn reqwest_get(url: &str) -> Result<String, String> {
    use std::io::{Read, Write};
    use std::net::TcpStream;
    use std::time::Duration;

    let rest = url.strip_prefix("http://").ok_or_else(|| "只支持 http:// 自检（教师机默认 http）".to_string())?;
    let mut parts = rest.splitn(2, '/');
    let hostport = parts.next().unwrap_or("");
    let path = format!("/{}", parts.next().unwrap_or(""));
    let mut hp = hostport.splitn(2, ':');
    let host = hp.next().unwrap_or("");
    let port: u16 = hp.next().and_then(|p| p.parse().ok()).unwrap_or(80);

    let mut stream = TcpStream::connect((host, port)).map_err(|e| format!("连接失败：{}", e))?;
    stream.set_read_timeout(Some(Duration::from_secs(5))).ok();
    let req = format!("GET {} HTTP/1.1\r\nHost: {}\r\nConnection: close\r\n\r\n", path, hostport);
    stream.write_all(req.as_bytes()).map_err(|e| e.to_string())?;

    let mut buf = Vec::new();
    stream.read_to_end(&mut buf).map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&buf).to_string();
    let body = text.split("\r\n\r\n").nth(1).unwrap_or("").to_string();
    if text.starts_with("HTTP/") && !text.contains(" 200 ") {
        return Err(format!("教师机返回异常：{}", text.lines().next().unwrap_or("")));
    }
    Ok(body)
}

/// 供桌面端 `main.rs` 与移动端平台工程共同调用
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![check_hub])
        .run(tauri::generate_context!())
        .expect("Tauri 启动失败");
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 地址规范化：与 assets/js/student.js 的 hubHost() 同一套规则
    /// （同样的用例也在 tests/net.test.js 里跑 JS 版，两边结果必须一致）
    #[test]
    fn normalize_matches_js_rules() {
        let cases = [
            ("192.168.1.20:8080", "http://192.168.1.20:8080"),
            ("192.168.1.20", "http://192.168.1.20:8080"),
            ("http://192.168.1.20:9000", "http://192.168.1.20:9000"),
            ("https://10.144.144.1", "https://10.144.144.1:8080"),
            ("http://192.168.1.20:8080/join?room=c3", "http://192.168.1.20:8080"),
            ("  10.0.0.5:8080  ", "http://10.0.0.5:8080"),
            ("", ""),
            ("   ", ""),
        ];
        for (input, want) in cases {
            assert_eq!(normalize(input), want, "输入 {:?}", input);
        }
    }

    /// 自检失败要给出可读原因，而不是 panic
    #[test]
    fn check_target_is_reported() {
        // 未填地址 → 空串（调用方据此回 "没有填写教师机地址"）
        assert_eq!(normalize("   "), "");
        // 只支持 http（教师机默认就是 http），https 会走到 TcpStream 而非被误当成明文端口
        assert!(reqwest_get("https://127.0.0.1:1/health").is_err());
    }
}
