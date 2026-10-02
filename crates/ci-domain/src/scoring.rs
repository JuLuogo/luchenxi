//! scoring.rs — 加权计分引擎（题型权重 / 半对折算 / 抢答奖励 / 答错扣分）
//!
//! **迁移来源**：`assets/js/store.js` 的 `DEFAULT_TIERS` / `RESULT_RATIO` / `RESULT_LABEL` /
//! `tierOf` / `questionPoints` / `computePoints` / `isCountable`，以及 `recordResult` 里
//! "算分"的那部分（写流水与落库属于存储层，不在这里）。
//!
//! 迁移期两边并行：单测对应 `tests/logic.test.js` 第 3 组「加权计分引擎」，
//! 另有 `tests/fixtures/parity.json` 的 scoring 段做逐步比对。
//!
//! 口径要点：
//!   · 基准分：题目自定义 `points` 优先，否则取题型权重
//!   · 折算比例：答对 1、半对 = settings.halfRatio、答错/跳过 0
//!   · 抢答奖励只加在"答对"上；答错扣分只在"答错"上
//!   · 分数保留两位小数（`Math.round(x * 100) / 100`）
//!   · **流水带基准快照**：事后改题型权重不影响历史分

use serde::{Deserialize, Serialize};

/// 题型（权重是计分核心）
#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Tier {
    pub key: String,
    pub label: String,
    pub weight: f64,
    #[serde(default)]
    pub color: String,
    #[serde(default)]
    pub desc: String,
}

impl Tier {
    fn new(key: &str, label: &str, weight: f64, color: &str, desc: &str) -> Self {
        Tier {
            key: key.to_string(),
            label: label.to_string(),
            weight,
            color: color.to_string(),
            desc: desc.to_string(),
        }
    }
}

/// 默认题型（与 store.js 的 DEFAULT_TIERS 一致）
pub fn default_tiers() -> Vec<Tier> {
    vec![
        Tier::new("basic", "基础题", 3.0, "#66bb6a", "课本概念与常规运算，面向全体"),
        Tier::new("advanced", "拔高题", 5.0, "#42a5f5", "综合应用，需要两步以上推理"),
        Tier::new("extended", "扩展题", 8.0, "#ab47bc", "跨章节综合或建模，考查迁移能力"),
        Tier::new("improve", "提升题", 10.0, "#ef6c00", "压轴/竞赛级，挑战思维上限"),
    ]
}

/// 结果 → 折算比例（半对要用 settings.halfRatio，所以这里只给固定项）
pub fn base_ratio(result: &str) -> Option<f64> {
    match result {
        "correct" => Some(1.0),
        "half" => Some(0.5), // 仅是默认值；实际取 settings.half_ratio
        "wrong" | "skip" => Some(0.0),
        _ => None,
    }
}

/// 结果 → 中文标签（教师端实时流与流水列表都用它）
pub fn result_label(result: &str) -> &'static str {
    match result {
        "correct" => "答对",
        "half" => "部分正确",
        "wrong" => "答错",
        "skip" => "跳过",
        "manual" => "手动调整",
        _ => "答对",
    }
}

/// 未知结果一律按"答对"处理（与 JS 的 `RESULT_RATIO[opt.result] === undefined ? 'correct' : …` 一致）
pub fn normalize_result(result: &str) -> &'static str {
    match result {
        "correct" | "half" | "wrong" | "skip" | "manual" => match result {
            "correct" => "correct",
            "half" => "half",
            "wrong" => "wrong",
            "skip" => "skip",
            _ => "manual",
        },
        _ => "correct",
    }
}

/// 计分相关设置（只取算分要用的三项）
#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct ScoringSettings {
    #[serde(default = "default_half_ratio")]
    pub half_ratio: f64,
    #[serde(default)]
    pub fast_bonus: f64,
    #[serde(default)]
    pub wrong_penalty: f64,
}

fn default_half_ratio() -> f64 {
    0.5
}

impl Default for ScoringSettings {
    fn default() -> Self {
        ScoringSettings {
            half_ratio: 0.5,
            fast_bonus: 0.0,
            wrong_penalty: 0.0,
        }
    }
}

/// JS 的 `Math.round` 语义：**半值向 +∞ 取整**
///
/// Rust 的 `f64::round` 是"半值远离零"，两者在负半值上不同：
/// `Math.round(-0.5) === -0`（即 0），而 `(-0.5_f64).round() == -1`。
/// 计分涉及扣分（负数），必须按 JS 语义来，否则会出现 1 分钱的差异。
pub fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

/// 保留两位小数（与 JS 的 `Math.round(x * 100) / 100` 一致）
pub fn round2(x: f64) -> f64 {
    js_round(x * 100.0) / 100.0
}

/// 取题型；找不到时退回第一个（与 JS 的 tierOf 一致）
pub fn tier_of<'a>(tiers: &'a [Tier], key: &str) -> Option<&'a Tier> {
    tiers.iter().find(|t| t.key == key).or_else(|| tiers.first())
}

/// 该题的实际基准分：题目自定义 points 优先，否则取题型权重
pub fn question_points(tiers: &[Tier], custom_points: Option<f64>, tier_key: &str) -> f64 {
    if let Some(p) = custom_points {
        return p;
    }
    tier_of(tiers, tier_key).map(|t| t.weight).unwrap_or(0.0)
}

/// 算分（对应 JS 的 computePoints）
///
/// * `ratio` —— 显式比例（手动调整等场景）；给了就不用结果推断
/// * `fast` —— 是否抢答（只在答对时加 fastBonus）
pub fn compute_points(
    result: &str,
    base: f64,
    ratio: Option<f64>,
    fast: bool,
    st: &ScoringSettings,
) -> f64 {
    let r = match ratio {
        Some(r) => r,
        None => match result {
            "half" => st.half_ratio,
            other => base_ratio(other).unwrap_or(0.0),
        },
    };
    let mut pts = base * r;
    if result == "correct" && fast {
        pts += st.fast_bonus;
    }
    if result == "wrong" {
        pts -= st.wrong_penalty;
    }
    round2(pts)
}

/// 是否计入题型统计：带题型快照且不是纯手动调整
pub fn is_countable(tier: &str, result: &str) -> bool {
    !tier.is_empty() && result != "manual"
}

/// 一条流水的算分快照（写库前的那部分）
#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ScoreSnapshot {
    pub sid: String,
    #[serde(default)]
    pub qid: Option<String>,
    #[serde(default)]
    pub tier: String,
    #[serde(default)]
    pub result: String,
    pub base: f64,
    pub ratio: f64,
    pub points: f64,
    #[serde(default)]
    pub source: String,
}

/// 计分输入（对应 recordResult 的参数）
#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ScoreInput {
    #[serde(default)]
    pub sid: String,
    #[serde(default)]
    pub qid: Option<String>,
    /// 显式题型（不给就从题目取）
    #[serde(default)]
    pub tier: Option<String>,
    /// 题目题型（用于兜底）
    #[serde(default)]
    pub question_tier: Option<String>,
    /// 题目自定义分值
    #[serde(default)]
    pub custom_points: Option<f64>,
    /// 显式基准分（优先级最高）
    #[serde(default)]
    pub base: Option<f64>,
    #[serde(default)]
    pub result: String,
    #[serde(default)]
    pub fast: bool,
    #[serde(default)]
    pub source: Option<String>,
}

/// 算出流水的基准/比例/得分（纯函数；写库与落盘由存储层负责）
pub fn score_of_input(tiers: &[Tier], st: &ScoringSettings, input: &ScoreInput) -> ScoreSnapshot {
    let tier_key = input
        .tier
        .clone()
        .or_else(|| input.question_tier.clone())
        .unwrap_or_default();
    let result = normalize_result(&input.result).to_string();

    let base = match input.base {
        Some(b) => b,
        None => {
            if input.qid.is_some() {
                question_points(tiers, input.custom_points, &tier_key)
            } else {
                tier_of(tiers, &tier_key).map(|t| t.weight).unwrap_or(0.0)
            }
        }
    };
    let ratio = if result == "half" {
        st.half_ratio
    } else {
        base_ratio(&result).unwrap_or(0.0)
    };
    let points = compute_points(&result, base, None, input.fast, st);

    ScoreSnapshot {
        sid: input.sid.clone(),
        qid: input.qid.clone(),
        tier: tier_key,
        result,
        base,
        ratio,
        points,
        source: input.source.clone().unwrap_or_else(|| "quiz".to_string()),
    }
}

/// 求和（队伍分 / 个人分都只是流水求和）
pub fn sum_points(records: &[ScoreSnapshot]) -> f64 {
    round2(records.iter().map(|r| r.points).sum())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn st() -> ScoringSettings {
        ScoringSettings::default()
    }

    fn basic_input(result: &str) -> ScoreInput {
        ScoreInput {
            sid: "s1".into(),
            qid: Some("q1".into()),
            question_tier: Some("basic".into()),
            result: result.into(),
            ..Default::default()
        }
    }

    /* ---- 与 tests/logic.test.js 第 3 组「加权计分引擎」逐条对应 ---- */

    #[test]
    fn base_points_by_tier() {
        let tiers = default_tiers();
        // 基础题基准 3 分 / 拔高题 5 分 / 自定义分值优先
        assert_eq!(question_points(&tiers, None, "basic"), 3.0);
        assert_eq!(question_points(&tiers, None, "advanced"), 5.0);
        assert_eq!(question_points(&tiers, Some(20.0), "extended"), 20.0);
        assert_eq!(question_points(&tiers, None, "extended"), 8.0);
        assert_eq!(question_points(&tiers, None, "improve"), 10.0);
    }

    #[test]
    fn score_accumulates_like_js() {
        let tiers = default_tiers();
        let s = st();
        let mut recs: Vec<ScoreSnapshot> = Vec::new();

        recs.push(score_of_input(&tiers, &s, &basic_input("correct")));
        assert_eq!(sum_points(&recs), 3.0, "基础题答对 +3");

        // 拔高题答对再 +5（累计 8）
        let mut adv = basic_input("correct");
        adv.qid = Some("q2".into());
        adv.question_tier = Some("advanced".into());
        recs.push(score_of_input(&tiers, &s, &adv));
        assert_eq!(sum_points(&recs), 8.0);

        // 部分正确 = 基准 × 0.5（+2.5 → 10.5）
        let mut half = adv.clone();
        half.result = "half".into();
        recs.push(score_of_input(&tiers, &s, &half));
        assert_eq!(sum_points(&recs), 10.5);

        // 答错默认不扣分
        let mut wrong = adv.clone();
        wrong.result = "wrong".into();
        recs.push(score_of_input(&tiers, &s, &wrong));
        assert_eq!(sum_points(&recs), 10.5);

        // 快捷题型加分（无题目，按题型权重）
        let quick = ScoreInput {
            sid: "s1".into(),
            tier: Some("improve".into()),
            result: "correct".into(),
            source: Some("quick".into()),
            ..Default::default()
        };
        recs.push(score_of_input(&tiers, &s, &quick));
        assert_eq!(sum_points(&recs), 20.5, "快捷题型加分 +10");
    }

    #[test]
    fn penalties_and_bonus_follow_settings() {
        let tiers = default_tiers();
        let s = ScoringSettings { half_ratio: 0.4, fast_bonus: 1.0, wrong_penalty: 2.0 };
        let mut recs: Vec<ScoreSnapshot> = Vec::new();
        // 先攒到 20.5（与上一组同样的过程，但换设置）
        recs.push(score_of_input(&tiers, &st(), &basic_input("correct")));
        let mut adv = basic_input("correct");
        adv.question_tier = Some("advanced".into());
        recs.push(score_of_input(&tiers, &st(), &adv));
        let mut half = adv.clone();
        half.result = "half".into();
        recs.push(score_of_input(&tiers, &st(), &half));
        let mut wrong = adv.clone();
        wrong.result = "wrong".into();
        recs.push(score_of_input(&tiers, &st(), &wrong));
        recs.push(score_of_input(&tiers, &st(), &ScoreInput {
            sid: "s1".into(), tier: Some("improve".into()), result: "correct".into(),
            source: Some("quick".into()), ..Default::default()
        }));
        assert_eq!(sum_points(&recs), 20.5);

        // 答错扣 2 分 → 18.5
        let mut w = basic_input("wrong");
        w.result = "wrong".into();
        recs.push(score_of_input(&tiers, &s, &w));
        assert_eq!(sum_points(&recs), 18.5, "答错扣 2 分");

        // 答对 +3 且抢答 +1 → 22.5
        let mut f = basic_input("correct");
        f.fast = true;
        recs.push(score_of_input(&tiers, &s, &f));
        assert_eq!(sum_points(&recs), 22.5, "答对 +3 且抢答 +1");

        // halfRatio 改为 0.4 后 +1.2 → 23.7
        let mut h = basic_input("half");
        h.result = "half".into();
        recs.push(score_of_input(&tiers, &s, &h));
        assert_eq!(sum_points(&recs), 23.7, "halfRatio 0.4 → +1.2");
    }

    #[test]
    fn rounding_is_two_decimals() {
        // 3 × 0.4 = 1.2000000000000002 → 必须四舍五入到 1.2
        assert_eq!(compute_points("half", 3.0, None, false, &ScoringSettings { half_ratio: 0.4, ..Default::default() }), 1.2);
        // 下面这几组期望值是用 JS 实测出来的（node -e 跑 Math.round(x*100)/100），
        // 不是"想当然的四舍五入"：浮点表示会让 2.675 与 1.005 朝不同方向走。
        assert_eq!(round2(1.665), 1.67);
        assert_eq!(round2(2.675), 2.68);
        assert_eq!(round2(0.125), 0.13);
        assert_eq!(round2(1.005), 1.0);
        // 负数扣分：JS Math.round(-0.5) = -0 → 0；Rust 原生 round 会得到 -1（本轮抓到的差异）
        assert_eq!(js_round(-0.5), 0.0);
        assert_eq!(js_round(0.5), 1.0);
        assert_eq!(js_round(2.5), 3.0);
        assert_eq!(js_round(-2.5), -2.0);
        assert_eq!(round2(-0.005), 0.0);
        assert_eq!(round2(-1.005), -1.0);
    }

    #[test]
    fn ratio_semantics() {
        let s = ScoringSettings { half_ratio: 0.4, ..Default::default() };
        assert_eq!(compute_points("correct", 10.0, None, false, &s), 10.0);
        assert_eq!(compute_points("half", 10.0, None, false, &s), 4.0, "半对用 halfRatio");
        assert_eq!(compute_points("wrong", 10.0, None, false, &s), 0.0);
        assert_eq!(compute_points("skip", 10.0, None, false, &s), 0.0);
        // 显式比例优先（手动调整场景）
        assert_eq!(compute_points("manual", 5.0, Some(1.0), false, &s), 5.0);
        assert_eq!(compute_points("wrong", 10.0, Some(0.5), false, &s), 5.0);
    }

    #[test]
    fn record_carries_base_snapshot() {
        // 流水带基准快照：事后改权重不影响历史分
        let tiers = default_tiers();
        let rec = score_of_input(&tiers, &st(), &basic_input("correct"));
        assert_eq!(rec.base, 3.0);
        assert_eq!(rec.points, 3.0);
        let mut heavier = default_tiers();
        heavier[0].weight = 9.0; // 改权重
        assert_eq!(sum_points(&[rec.clone()]), 3.0, "历史分不变");
        assert_eq!(question_points(&heavier, None, "basic"), 9.0, "新题按新权重");
    }

    #[test]
    fn countable_rules() {
        assert!(is_countable("basic", "correct"));
        assert!(is_countable("basic", "half"));
        assert!(!is_countable("basic", "manual"), "纯手动调整不计入题型统计");
        assert!(!is_countable("", "correct"), "没有题型快照的不计入");
    }

    #[test]
    fn result_label_and_normalize() {
        assert_eq!(result_label("correct"), "答对");
        assert_eq!(result_label("half"), "部分正确");
        assert_eq!(result_label("wrong"), "答错");
        assert_eq!(result_label("skip"), "跳过");
        assert_eq!(result_label("manual"), "手动调整");
        assert_eq!(normalize_result("bogus"), "correct", "未知结果按答对");
        assert_eq!(normalize_result("half"), "half");
        assert_eq!(normalize_result("manual"), "manual");
    }

    #[test]
    fn tier_fallback_and_sources() {
        let tiers = default_tiers();
        assert_eq!(tier_of(&tiers, "improve").unwrap().label, "提升题");
        assert_eq!(tier_of(&tiers, "不存在").unwrap().key, "basic", "找不到退回第一个");
        // 显式基准分优先级最高
        let input = ScoreInput { sid: "s".into(), base: Some(7.0), tier: Some("basic".into()), result: "correct".into(), ..Default::default() };
        assert_eq!(score_of_input(&tiers, &st(), &input).points, 7.0);
        // source 默认 quiz
        assert_eq!(score_of_input(&tiers, &st(), &basic_input("correct")).source, "quiz");
    }
}
