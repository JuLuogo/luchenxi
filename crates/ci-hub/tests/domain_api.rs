//! domain_api.rs —— 领域端点的集成测试：起一个真枢纽，用真 HTTP 打它
//!
//! 为什么值得单独测：这几个端点是"网页版也能由 Rust 核心驱动"的入口
//! （docs/14 §2：展示层不得含业务判断）。它们必须与 `ci-domain` 的算法**同一份结果**，
//! 所以这里的期望值直接写"算法该给什么"，而不是"上次返回了什么"。

use serde_json::{json, Value};
use std::sync::atomic::{AtomicU16, Ordering};

static PORT: AtomicU16 = AtomicU16::new(8700);

/// 起一个空枢纽（临时目录里的 SQLite），返回 base url
async fn start_hub(tag: &str) -> (String, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("ci-domain-api-{}-{}", tag, ci_store::now_ms()));
    let store = ci_store::Store::open(&dir.join("classroom.db")).expect("打开测试库");
    let port = PORT.fetch_add(1, Ordering::SeqCst);
    let state = ci_hub::HubState {
        rooms: std::sync::Arc::new(tokio::sync::RwLock::new(std::collections::HashMap::new())),
        db: std::sync::Arc::new(tokio::sync::Mutex::new(store)),
        port,
    };
    let app = ci_hub::router(state);
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await.expect("绑定端口");
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    (format!("http://127.0.0.1:{port}"), dir)
}

async fn post(base: &str, path: &str, body: Value) -> Value {
    let r = reqwest::Client::new()
        .post(format!("{base}{path}"))
        .json(&body)
        .send()
        .await
        .unwrap_or_else(|e| panic!("请求 {path} 失败：{e}"));
    let status = r.status();
    let text = r.text().await.unwrap_or_default();
    assert!(
        !text.is_empty(),
        "{path} 返回空响应体（HTTP {status}）—— 路由没挂上或方法不对？"
    );
    let v: Value = serde_json::from_str(&text)
        .unwrap_or_else(|e| panic!("{path} 返回的不是 JSON（HTTP {status}）：{e}\n原文：{text}"));
    assert!(status.is_success(), "{path} HTTP {status}：{v}");
    v
}

#[tokio::test]
async fn grade_endpoint_matches_domain_rules() {
    let (base, dir) = start_hub("grade").await;

    // 选择题：选 A 判对
    let out = post(
        &base,
        "/api/domain/grade",
        json!({
            "question": { "options": ["甲", "乙"], "answer": "A", "tier": "basic" },
            "submission": { "choice": ["A"], "text": "", "skip": false }
        }),
    )
    .await;
    assert_eq!(out["ok"], json!(true));
    assert_eq!(out["graded"], json!(true));
    assert_eq!(out["result"], json!("correct"), "选 A 应判对");
    assert!(out["description"].as_str().unwrap().contains('A'), "描述里带答案");

    // 选错
    let out = post(
        &base,
        "/api/domain/grade",
        json!({
            "question": { "options": ["甲", "乙"], "answer": "A" },
            "submission": { "choice": ["B"], "text": "", "skip": false }
        }),
    )
    .await;
    assert_eq!(out["result"], json!("wrong"));

    // 主观题：判不出来 → graded=false（前端据此进"待确认"）
    let out = post(
        &base,
        "/api/domain/grade",
        json!({
            "question": { "options": [], "answer": "" },
            "submission": { "choice": [], "text": "我的证明", "skip": false }
        }),
    )
    .await;
    assert_eq!(out["graded"], json!(false));
    assert_eq!(out["result"], json!(null));
    assert_eq!(out["description"], json!("我的证明"));

    // 跳过
    let out = post(
        &base,
        "/api/domain/grade",
        json!({
            "question": { "options": ["甲"], "answer": "A" },
            "submission": { "skip": true }
        }),
    )
    .await;
    assert_eq!(out["result"], json!("skip"));

    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn score_endpoint_uses_tier_weights_and_settings() {
    let (base, dir) = start_hub("score").await;

    // 基础题答对：默认权重 3 分
    let out = post(
        &base,
        "/api/domain/score",
        json!({
            "settings": { "half_ratio": 0.5, "fast_bonus": 0, "wrong_penalty": 0 },
            "input": { "sid": "s1", "qid": "q1", "question_tier": "basic", "result": "correct" }
        }),
    )
    .await;
    let snap = &out["snapshot"];
    assert_eq!(snap["base"], json!(3.0), "基础题基准 3 分");
    assert_eq!(snap["ratio"], json!(1.0));
    assert_eq!(snap["points"], json!(3.0));
    assert_eq!(snap["tier"], json!("basic"));

    // 拔高题半对 + halfRatio 0.4 → 5 × 0.4 = 2
    let out = post(
        &base,
        "/api/domain/score",
        json!({
            "settings": { "half_ratio": 0.4 },
            "input": { "sid": "s1", "qid": "q2", "question_tier": "advanced", "result": "half" }
        }),
    )
    .await;
    assert_eq!(out["snapshot"]["points"], json!(2.0));

    // 答错扣 2 分 + 抢答加分只作用于答对
    let out = post(
        &base,
        "/api/domain/score",
        json!({
            "settings": { "wrong_penalty": 2, "fast_bonus": 1 },
            "input": { "sid": "s1", "qid": "q1", "question_tier": "basic", "result": "wrong" }
        }),
    )
    .await;
    assert_eq!(out["snapshot"]["points"], json!(-2.0), "答错扣 2");

    let out = post(
        &base,
        "/api/domain/score",
        json!({
            "settings": { "wrong_penalty": 2, "fast_bonus": 1 },
            "input": { "sid": "s1", "qid": "q1", "question_tier": "basic", "result": "correct", "fast": true }
        }),
    )
    .await;
    assert_eq!(out["snapshot"]["points"], json!(4.0), "答对 3 + 抢答 1");

    // 自定义分值优先（扩展题自定义 20 分）
    let out = post(
        &base,
        "/api/domain/score",
        json!({
            "input": { "sid": "s1", "qid": "q9", "question_tier": "extended", "custom_points": 20, "result": "correct" }
        }),
    )
    .await;
    assert_eq!(out["snapshot"]["points"], json!(20.0));

    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn ability_endpoint_returns_radar_and_grade() {
    let (base, dir) = start_hub("ability").await;

    // 四个题型全对 → 六边形战士，综合分 100
    let tiers = json!([
        { "key": "basic",    "label": "基础题", "weight": 3,  "attempts": 2, "correct": 2, "credit_rate": 100, "correct_rate": 100 },
        { "key": "advanced", "label": "拔高题", "weight": 5,  "attempts": 2, "correct": 2, "credit_rate": 100, "correct_rate": 100 },
        { "key": "extended", "label": "扩展题", "weight": 8,  "attempts": 2, "correct": 2, "credit_rate": 100, "correct_rate": 100 },
        { "key": "improve",  "label": "提升题", "weight": 10, "attempts": 2, "correct": 2, "credit_rate": 100, "correct_rate": 100 }
    ]);
    let out = post(&base, "/api/domain/ability", json!({ "tiers": tiers, "total_attempts": 8, "min_sample": 2 })).await;
    let a = &out["ability"];
    assert_eq!(a["overall"], json!(100), "全对 → 综合分 100");
    assert_eq!(a["coverage"], json!(100));
    assert_eq!(a["balance"], json!(100), "四轴齐平");
    assert_eq!(a["grade"]["label"], json!("六边形战士"));
    assert_eq!(a["axes"].as_array().unwrap().len(), 4, "四条轴");
    assert!(a["comment"].as_str().unwrap().contains("六边形战士"), "评语要带评级");

    // 只答一个题型 → 覆盖不足，且 balance 为 null（答过 <2 类）
    // 注意：覆盖率 = 答过的题型 / **全部题型**，所以未作答的题型也要传进来（attempts=0），
    // 这与 JS 侧一致（它总是拿 state.tiers 的全部四档去算）。
    let out = post(
        &base,
        "/api/domain/ability",
        json!({
            "tiers": [
                { "key": "basic",    "label": "基础题", "weight": 3,  "attempts": 5, "correct": 3, "credit_rate": 60, "correct_rate": 60 },
                { "key": "advanced", "label": "拔高题", "weight": 5,  "attempts": 0, "correct": 0, "credit_rate": 0,  "correct_rate": 0 },
                { "key": "extended", "label": "扩展题", "weight": 8,  "attempts": 0, "correct": 0, "credit_rate": 0,  "correct_rate": 0 },
                { "key": "improve",  "label": "提升题", "weight": 10, "attempts": 0, "correct": 0, "credit_rate": 0,  "correct_rate": 0 }
            ],
            "total_attempts": 5,
            "min_sample": 2
        }),
    )
    .await;
    let a = &out["ability"];
    assert_eq!(a["coverage"], json!(25), "只覆盖 1/4 题型");
    assert_eq!(a["balance"], json!(null), "答过 <2 类时均衡度无意义");

    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn pick_endpoint_is_deterministic_with_seed() {
    let (base, dir) = start_hub("pick").await;

    let body = json!({
        "students": [
            { "id": "s1", "name": "甲", "active": true },
            { "id": "s2", "name": "乙", "active": true },
            { "id": "s3", "name": "丙", "active": true }
        ],
        "answered": [],
        "settings": { "mode": "random", "scope": "all", "exclude_answered": false, "recent_exclude": 0 },
        "opts": {},
        "seed": 20261002
    });

    let a = post(&base, "/api/domain/pick", body.clone()).await;
    let b = post(&base, "/api/domain/pick", body.clone()).await;
    assert_eq!(a["ok"], json!(true));
    assert_eq!(a["seed"], json!(20261002), "种子原样返回，便于复现");
    assert_eq!(a["pick"]["sid"], b["pick"]["sid"], "同种子必须抽到同一个人");
    let sid = a["pick"]["sid"].as_str().unwrap();
    assert!(["s1", "s2", "s3"].contains(&sid), "抽到的人必须来自名单：{sid}");
    assert_eq!(a["pick"]["mode"], json!("random"));

    // 换种子通常换人（不强制不同，但至少要是合法结果）
    let c = post(&base, "/api/domain/pick", json!({ "students": body["students"], "settings": body["settings"], "seed": 7 })).await;
    assert!(["s1", "s2", "s3"].contains(&c["pick"]["sid"].as_str().unwrap()), "换种子也要落在名单里");

    // 空名单：明确失败而不是 panic
    let d = post(&base, "/api/domain/pick", json!({ "students": [], "seed": 1 })).await;
    assert_eq!(d["ok"], json!(false));
    assert!(d["message"].as_str().unwrap().contains("没有可点名的学生"));

    let _ = std::fs::remove_dir_all(dir);
}
