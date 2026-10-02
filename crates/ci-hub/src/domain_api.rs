//! domain_api.rs —— 把 **Rust 核心的领域能力**通过枢纽 HTTP 暴露出来
//!
//! 为什么需要它：v5 的规矩是「展示层不得包含业务判断」（docs/14 §2）。
//! 桌面客户端直接链接 `ci-core` 就行，但**网页版跑在浏览器里**，它要判分/算分/点名，
//! 只能通过枢纽调用 —— 否则规则又会在前端分叉出第二份实现。
//!
//! 端点（全部 POST，JSON 进出，纯函数、不碰存储）：
//!   POST /api/domain/grade   客观题判分
//!   POST /api/domain/score   加权计分（含题型权重 / 半对折算 / 抢答加分 / 答错扣分）
//!   POST /api/domain/ability 能力评价（雷达轴 / 评级 / 评语）
//!   POST /api/domain/pick    随机点名（带种子，可复现 —— 与 parity 基准同一套算法）
//!
//! 设计取舍：
//!   · **不做鉴权**：教师机自己局域网内的枢纽，与 /api/state 同级；要防的是误用不是攻击。
//!   · **点名要种子**：`Math.random` 换成可传入的 XorShift64 种子，这样前端能复现、
//!     测试也能断言具体结果（与 `tests/fixtures/parity.json` 的 rollcall 段同源）。

use axum::extract::Json;
use axum::response::IntoResponse;
use ci_domain::ability::{ability_of_tiers, TierStat};
use ci_domain::grade::{auto, describe_submission, Question, Submission};
use ci_domain::rollcall::{pick, PickOpts, RollcallSettings, Student as RollStudent, XorShift64};
use ci_domain::scoring::{default_tiers, score_of_input, ScoreInput, ScoringSettings};
use serde::Deserialize;
use serde_json::{json, Value};

/* ------------------------------------------------------------------ *
 * 判分
 * ------------------------------------------------------------------ */

#[derive(Deserialize)]
pub struct GradeBody {
    pub question: Question,
    #[serde(default)]
    pub submission: Submission,
}

/// 客观题判分：判不出来（主观题）就返回 `graded: false`，与 `grade::auto` 的语义一致
pub async fn grade(Json(body): Json<GradeBody>) -> impl IntoResponse {
    let q = body.question;
    let s = body.submission;
    let description = describe_submission(&q, &s);
    match auto(&q, &s) {
        Some(v) => Json(json!({
            "ok": true,
            "graded": true,
            "result": v.result.as_str(),
            "expected": v.expected,
            "description": description
        })),
        None => Json(json!({
            "ok": true,
            "graded": false,
            "result": Value::Null,
            "expected": Value::Null,
            "description": description
        })),
    }
}

/* ------------------------------------------------------------------ *
 * 计分
 * ------------------------------------------------------------------ */

#[derive(Deserialize)]
pub struct ScoreBody {
    /// 题型表（不传用默认四档）
    #[serde(default)]
    pub tiers: Option<Vec<ci_domain::scoring::Tier>>,
    #[serde(default)]
    pub settings: ScoringSettings,
    /// 与 `ScoreInput` 同形（sid/qid/tier/questionTier/customPoints/base/result/fast/source）
    pub input: ScoreInput,
}

/// 加权计分：返回基准分 / 比例 / 得分 / 结果归一化 / 题型快照
pub async fn score(Json(body): Json<ScoreBody>) -> impl IntoResponse {
    let tiers = body.tiers.unwrap_or_else(default_tiers);
    let snap = score_of_input(&tiers, &body.settings, &body.input);
    Json(json!({ "ok": true, "snapshot": snap }))
}

/* ------------------------------------------------------------------ *
 * 能力评价
 * ------------------------------------------------------------------ */

#[derive(Deserialize)]
pub struct AbilityBody {
    #[serde(default)]
    pub tiers: Vec<TierStat>,
    #[serde(default)]
    pub total_attempts: u32,
    #[serde(default = "min_sample_default")]
    pub min_sample: u32,
}

fn min_sample_default() -> u32 {
    2
}

/// 能力评价：覆盖率、均衡度、综合分、评级与评语
pub async fn ability(Json(body): Json<AbilityBody>) -> impl IntoResponse {
    let a = ability_of_tiers(&body.tiers, body.total_attempts, body.min_sample);
    Json(json!({ "ok": true, "ability": a }))
}

/* ------------------------------------------------------------------ *
 * 随机点名
 * ------------------------------------------------------------------ */

#[derive(Deserialize)]
pub struct PickBody {
    #[serde(default)]
    pub students: Vec<RollStudent>,
    #[serde(default)]
    pub answered: Vec<String>,
    #[serde(default)]
    pub settings: RollcallSettings,
    #[serde(default)]
    pub opts: PickOpts,
    /// 随机种子：同一个种子 + 同一份名单 → 同一个人被点到（可复现、可测试）
    #[serde(default)]
    pub seed: Option<u64>,
}

/// 随机点名：与 parity 基准同一套算法，只是把随机源换成可传入的种子
pub async fn pick_handler(Json(body): Json<PickBody>) -> impl IntoResponse {
    let seed = body.seed.unwrap_or_else(|| {
        // 没给种子就自己造一个（仍然返回给调用方，便于复现这次点名）
        ci_store::now_ms() as u64
    });
    let mut rng = XorShift64::seed(seed);
    let answered: std::collections::BTreeSet<String> = body.answered.iter().cloned().collect();
    // `pick` 的最后一位参数是"抽一个下标"的函数（不是随机源本身）：
    // parity 基准注入固定序列，这里注入带种子的 xorshift64，两边同一套算法。
    match pick(&body.students, &answered, &body.settings, &body.opts, |n| rng.index(n)) {
        Some(p) => Json(json!({ "ok": true, "seed": seed, "pick": p })),
        None => Json(json!({
            "ok": false,
            "seed": seed,
            "message": "没有可点名的学生（名单为空，或都被排除规则过滤掉了）"
        })),
    }
}
