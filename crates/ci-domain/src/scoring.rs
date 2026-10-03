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
    pub color: String,
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

/// 计分相关设置（只取算分要用的几项）
///
/// **字段名是驼峰**：前端传的是 JS 的 settings 对象（`halfRatio` / `fastBonus` /
/// `wrongPenalty` / `buzzRankBonuses`）。少了 rename_all 会让这些值被 serde 静默忽略——
/// 这类"静默错值"在迁移里抓到过好几次了。
#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScoringSettings {
    #[serde(default = "default_half_ratio")]
    pub half_ratio: f64,
    #[serde(default)]
    pub fast_bonus: f64,
    #[serde(default)]
    pub wrong_penalty: f64,
    /// 抢答名次加分（学习通"不同名次的分数"经验）：第 1 个抢答的队 +bonuses[0]，
    /// 第 2 个 +bonuses[1]，以此类推，名单之外的名次不加分。
    /// 传了名次就用名次分，不再叠加扁平 fastBonus；不传名次时 fastBonus 照旧（老行为）。
    #[serde(default = "default_buzz_rank_bonuses")]
    pub buzz_rank_bonuses: Vec<f64>,
}

fn default_half_ratio() -> f64 {
    0.5
}

fn default_buzz_rank_bonuses() -> Vec<f64> {
    // 默认关闭：空名单 = 不给名次分，既有计分行为完全不变。
    // 想开启的老师在设置里填 [2,1]（第1个抢答的队+2、第2个+1）等。
    vec![]
}

impl ScoringSettings {
    /// 第 n 个抢答应得的加分（n 从 1 起；名单外为 0）
    pub fn buzz_rank_bonus(&self, rank: usize) -> f64 {
        if rank == 0 {
            return 0.0;
        }
        self.buzz_rank_bonuses
            .get(rank - 1)
            .copied()
            .unwrap_or(0.0)
    }
}

impl Default for ScoringSettings {
    fn default() -> Self {
        ScoringSettings {
            half_ratio: 0.5,
            fast_bonus: 0.0,
            wrong_penalty: 0.0,
            buzz_rank_bonuses: default_buzz_rank_bonuses(),
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
/// * `rank` —— 抢答名次（第 1 个抢到的队为 1）；给了就用名次分、不用扁平 fastBonus
pub fn compute_points(
    result: &str,
    base: f64,
    ratio: Option<f64>,
    fast: bool,
    rank: Option<usize>,
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
    if result == "correct" {
        match rank {
            Some(n) => pts += st.buzz_rank_bonus(n),
            None if fast => pts += st.fast_bonus,
            _ => {}
        }
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
    pub qid: Option<String>,
    pub tier: String,
    pub result: String,
    pub base: f64,
    pub ratio: f64,
    pub points: f64,
    pub source: String,
}

/// 计分输入（对应 recordResult 的参数）
///
/// 同样是驼峰（`questionTier` / `customPoints`），因为前端/枢纽 API 传的是 JS 的对象字面量。
#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScoreInput {
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
    pub result: String,
    #[serde(default)]
    pub fast: bool,
    /// 抢答名次（1 起）：答对且给了名次 → 用名次加分
    #[serde(default)]
    pub rank: Option<usize>,
    /// 显式部分得分系数（多答案题按命中比例算出的值，见 grade::auto 的 ratio）。
    /// 为空时：half 用 `st.half_ratio`（教师手工判定「部分正确」的情形），其余按判定取整。
    #[serde(default)]
    pub ratio: Option<f64>,
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
    // 显式 ratio 优先（多答案题按命中比例算出来的部分分）；
    // 没有显式值时：半对回退到 half_ratio（教师手工判定），其余按判定取整
    let ratio = match input.ratio {
        Some(r) => r,
        None => {
            if result == "half" {
                st.half_ratio
            } else {
                base_ratio(&result).unwrap_or(0.0)
            }
        }
    };
    let points = compute_points(&result, base, Some(ratio), input.fast, input.rank, st);

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
        let s = ScoringSettings { half_ratio: 0.4, fast_bonus: 1.0, wrong_penalty: 2.0, buzz_rank_bonuses: vec![2.0, 1.0] };
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
        assert_eq!(compute_points("half", 3.0, None, false, None, &ScoringSettings { half_ratio: 0.4, ..Default::default() }), 1.2);
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
        assert_eq!(compute_points("correct", 10.0, None, false, None, &s), 10.0);
        assert_eq!(compute_points("half", 10.0, None, false, None, &s), 4.0, "半对用 halfRatio");
        assert_eq!(compute_points("wrong", 10.0, None, false, None, &s), 0.0);
        assert_eq!(compute_points("skip", 10.0, None, false, None, &s), 0.0);
        // 显式比例优先（手动调整场景）
        assert_eq!(compute_points("manual", 5.0, Some(1.0), false, None, &s), 5.0);
        assert_eq!(compute_points("wrong", 10.0, Some(0.5), false, None, &s), 5.0);
    }

    #[test]
    fn buzz_rank_bonus_semantics() {
        let tiers = default_tiers();
        // 默认关闭：没有名次分，行为与老版本一致
        let s = ScoringSettings::default();
        assert!(s.buzz_rank_bonuses.is_empty(), "默认不给名次分");
        assert_eq!(s.buzz_rank_bonus(1), 0.0);
        assert_eq!(compute_points("correct", 3.0, None, true, Some(1), &s), 3.0, "默认关闭：抢答不加分");

        // 开启后（[2, 1]）：第 1 个抢答 +2、第 2 个 +1、第 3 个起不加分
        let s = ScoringSettings { buzz_rank_bonuses: vec![2.0, 1.0], ..Default::default() };
        assert_eq!(s.buzz_rank_bonus(1), 2.0);
        assert_eq!(s.buzz_rank_bonus(2), 1.0);
        assert_eq!(s.buzz_rank_bonus(3), 0.0);
        assert_eq!(s.buzz_rank_bonus(0), 0.0, "名次从 1 起");

        // 名次分替代扁平 fastBonus（不叠加）
        assert_eq!(compute_points("correct", 3.0, None, true, Some(1), &s), 5.0, "基础题 3 + 名次1 → 5");
        assert_eq!(compute_points("correct", 3.0, None, true, Some(2), &s), 4.0, "基础题 3 + 名次2 → 4");
        assert_eq!(compute_points("correct", 3.0, None, true, Some(9), &s), 3.0, "名单外名次不加分");
        assert_eq!(compute_points("correct", 3.0, None, true, None, &s), 3.0, "无名次 + fastBonus(0) → 3");

        // 只有答对才给名次分（答错没有）
        assert_eq!(compute_points("wrong", 3.0, None, true, Some(1), &s), 0.0);
        // 半对也没有
        assert_eq!(compute_points("half", 3.0, None, true, Some(1), &s), 1.5);

        // 自定义名次分（如第 1 名 +5 / 第 2 名 +3 / 第 3 名 +1）
        let s2 = ScoringSettings { buzz_rank_bonuses: vec![5.0, 3.0, 1.0], ..Default::default() };
        assert_eq!(compute_points("correct", 3.0, None, false, Some(3), &s2), 4.0);
        assert_eq!(compute_points("correct", 3.0, None, false, Some(4), &s2), 3.0);
        // 与 score_of_input 的整链路：input.rank → 快照
        let snap = score_of_input(&tiers, &s2, &ScoreInput {
            sid: "s1".into(), qid: Some("q1".into()), question_tier: Some("basic".into()),
            result: "correct".into(), rank: Some(2), ..Default::default()
        });
        assert_eq!(snap.points, 6.0, "3 + 名次2(3) → 6");
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
