//! ability.rs — 加权计分口径下的能力评价（题型雷达 + 综合评级 + 自动评语）
//!
//! **迁移来源**：`assets/js/analysis.js` 的 `ABILITY_GRADES` / `abilityOfTiers` /
//! `abilityComment`（以及 `blankBucket` / `addToBucket` / `finalizeBucket` 这几个口径函数）。
//! 迁移期两边并行：本文件测试与 `tests/logic.test.js` 第 11 组「能力评价」断言一一对应。
//!
//! 设计原则：**纯函数、无 IO**。输入是"已经算好的题型统计"，输出是评价结果，
//! 因此不需要 store / dump / 前端即可完整单测。
//!
//! 口径（与计分保持一致）：
//!   · 每条轴 = 一个题型的掌握度 creditRate（答对 100%、半对按 halfRatio 折算）
//!   · 掌握度 mastery = 只在"有作答的题型"上按**题型权重**加权平均（拔高题做对更值钱）
//!   · 覆盖率 coverage = 有作答题型 / 全部题型
//!   · 综合分 overall = mastery × (0.6 + 0.4 × coverage) —— 不惩罚"这节没考到的题型"，
//!     也不让"只答对 1 道基础题"显示成 100 分
//!   · 均衡度 balance = 100 − (最高轴 − 最低轴)，只在答过 ≥2 个题型时有意义

use serde::{Deserialize, Serialize};

/// 题型统计（finalizeBucket 之后的形态）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TierStat {
    pub key: String,
    pub label: String,
    #[serde(default)]
    pub color: String,
    #[serde(default)]
    pub weight: f64,
    pub attempts: u32,
    pub correct: u32,
    /// 掌握度百分比（已按 halfRatio 折算，保留一位小数，与 JS 的 pct 一致）
    #[serde(default)]
    pub credit_rate: f64,
    /// 正确率百分比
    #[serde(default)]
    pub correct_rate: f64,
}

/// 原始计数桶（addToBucket 的累加结果）
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Bucket {
    pub attempts: u32,
    pub correct: u32,
    pub half: u32,
    pub wrong: u32,
    pub skip: u32,
    pub earned: f64,
    pub base: f64,
}

impl Bucket {
    /// 记录一次作答（对应 JS 的 addToBucket）
    pub fn add(&mut self, result: &str, points: f64, base: f64) {
        self.attempts += 1;
        match result {
            "correct" => self.correct += 1,
            "half" => self.half += 1,
            "wrong" => self.wrong += 1,
            "skip" => self.skip += 1,
            _ => {}
        }
        self.earned += points;
        self.base += base;
    }

    /// 掌握度百分比：`pct(correct + half × halfRatio, attempts)`
    pub fn credit_rate(&self, half_ratio: f64) -> f64 {
        let credit = self.correct as f64 + self.half as f64 * half_ratio;
        pct(credit, self.attempts)
    }

    pub fn correct_rate(&self) -> f64 {
        pct(self.correct as f64, self.attempts)
    }

    /// 折算成题型统计（对应 JS 的 finalizeBucket）
    pub fn finalize(&self, key: &str, label: &str, color: &str, weight: f64, half_ratio: f64) -> TierStat {
        TierStat {
            key: key.to_string(),
            label: label.to_string(),
            color: color.to_string(),
            weight,
            attempts: self.attempts,
            correct: self.correct,
            credit_rate: self.credit_rate(half_ratio),
            correct_rate: self.correct_rate(),
        }
    }
}

/// `U.pct(a, b)`：百分比，保留一位小数（b = 0 时返回 0）
pub fn pct(a: f64, b: u32) -> f64 {
    if b > 0 {
        ((a / b as f64) * 1000.0).round() / 10.0
    } else {
        0.0
    }
}

/// 评级档位
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Grade {
    pub key: &'static str,
    pub short: &'static str,
    pub label: &'static str,
    pub color: &'static str,
    pub tip: &'static str,
}

/// 评级表：从最理想往下判定，第一个命中即采用（顺序不能改）
pub const GRADES: [Grade; 8] = [
    Grade { key: "hexagon", short: "S", label: "六边形战士", color: "#7c3aed", tip: "每个题型都稳，没有明显短板" },
    Grade { key: "allround", short: "A", label: "全面发展", color: "#16a34a", tip: "各题型都能拿下，个别题再加把劲就满格" },
    Grade { key: "strong", short: "A-", label: "学有余力", color: "#0ea5e9", tip: "整体不错，继续拔高" },
    Grade { key: "specialist", short: "B+", label: "偏科尖子", color: "#f59e0b", tip: "有强项，但存在明显短板" },
    Grade { key: "steady", short: "B", label: "稳步提升", color: "#6366f1", tip: "基础还行，靠多练把正确率提上来" },
    Grade { key: "basic", short: "C", label: "基础待巩固", color: "#fb923c", tip: "简单题先稳住，再挑战难题" },
    Grade { key: "weak", short: "D", label: "需要重点辅导", color: "#ef4444", tip: "建议单独安排针对性练习" },
    Grade { key: "insufficient", short: "—", label: "样本不足", color: "#94a3b8", tip: "多给几次机会，数据才说明问题" },
];

const G_HEXAGON: usize = 0;
const G_ALLROUND: usize = 1;
const G_STRONG: usize = 2;
const G_SPECIALIST: usize = 3;
const G_STEADY: usize = 4;
const G_BASIC: usize = 5;
const G_WEAK: usize = 6;
const G_INSUFFICIENT: usize = 7;

pub fn grade_by_key(key: &str) -> Grade {
    GRADES.iter().copied().find(|g| g.key == key).unwrap_or(GRADES[G_INSUFFICIENT])
}

/// 雷达上的一条轴（rate 为整数百分比，供前端直接显示）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Axis {
    pub key: String,
    pub label: String,
    pub color: String,
    pub weight: f64,
    pub attempts: u32,
    pub correct: u32,
    /// 掌握度（整数百分比）
    pub rate: i64,
    pub correct_rate: f64,
}

/// 能力评价结果
#[derive(Debug, Clone, PartialEq)]
pub struct Ability {
    pub axes: Vec<Axis>,
    /// 综合分（掌握度 × 覆盖系数）
    pub overall: i64,
    /// 掌握度（只在有作答的题型上加权）
    pub mastery: i64,
    /// 均衡度：答过 <2 个题型时为 None（与 JS 的 null 对应）
    pub balance: Option<i64>,
    pub coverage: i64,
    pub attempts: u32,
    pub filled: usize,
    pub max_rate: i64,
    pub min_rate: i64,
    /// 最弱/最强轴的**下标**（axes 内），无作答时为 None
    pub weakest: Option<usize>,
    pub strongest: Option<usize>,
    pub grade: Grade,
    pub comment: String,
}

impl Ability {
    pub fn weakest_axis(&self) -> Option<&Axis> {
        self.weakest.and_then(|i| self.axes.get(i))
    }
    pub fn strongest_axis(&self) -> Option<&Axis> {
        self.strongest.and_then(|i| self.axes.get(i))
    }
}

/// 能力雷达（对应 JS 的 abilityOfTiers）
///
/// * `tiers` —— 题型统计（顺序任意，内部按权重升序排列）
/// * `total_attempts` —— 合计作答次数（样本量判定用；直接传 total.attempts）
/// * `min_sample` —— 少于这个作答次数判为「样本不足」（默认 2，取自 settings.minSample）
pub fn ability_of_tiers(tiers: &[TierStat], total_attempts: u32, min_sample: u32) -> Ability {
    // 轴按题型权重升序（拔高题排在后面，视觉上就是"越来越难"）
    let mut sorted: Vec<&TierStat> = tiers.iter().collect();
    sorted.sort_by(|a, b| a.weight.partial_cmp(&b.weight).unwrap_or(std::cmp::Ordering::Equal));

    let axes: Vec<Axis> = sorted
        .iter()
        .map(|t| Axis {
            key: t.key.clone(),
            label: t.label.clone(),
            color: t.color.clone(),
            weight: t.weight,
            attempts: t.attempts,
            correct: t.correct,
            rate: t.credit_rate.round() as i64,
            correct_rate: t.correct_rate,
        })
        .collect();

    let filled: Vec<usize> = (0..axes.len()).filter(|i| axes[*i].attempts > 0).collect();
    let weight_sum: f64 = filled.iter().map(|i| axes[*i].weight.max(0.0001)).sum();
    let mastery = if weight_sum > 0.0 {
        let acc: f64 = filled.iter().map(|i| axes[*i].rate as f64 * axes[*i].weight.max(0.0001)).sum();
        (acc / weight_sum).round() as i64
    } else {
        0
    };

    let rates: Vec<i64> = filled.iter().map(|i| axes[*i].rate).collect();
    let max_rate = rates.iter().copied().max().unwrap_or(0);
    let min_rate = rates.iter().copied().min().unwrap_or(0);
    let balance = if filled.len() >= 2 { Some(100 - (max_rate - min_rate)) } else { None };
    let coverage = if axes.is_empty() { 0 } else { ((filled.len() as f64 / axes.len() as f64) * 100.0).round() as i64 };
    let overall = (mastery as f64 * (0.6 + 0.4 * (coverage as f64 / 100.0))).round() as i64;

    // 最弱/最强：按 rate 升序排（稳定排序，和 JS 的 sort 行为一致）
    let mut by_rate = filled.clone();
    by_rate.sort_by_key(|i| axes[*i].rate);
    let weakest = by_rate.first().copied();
    let strongest = by_rate.last().copied();

    let grade = if total_attempts < min_sample {
        GRADES[G_INSUFFICIENT]
    } else if coverage == 100 && filled.len() >= 2 && min_rate >= 80 && balance.is_some_and(|b| b >= 10) {
        GRADES[G_HEXAGON]
    } else if coverage >= 75 && min_rate >= 60 {
        GRADES[G_ALLROUND]
    } else if max_rate >= 85 && min_rate < 50 {
        GRADES[G_SPECIALIST]
    } else if overall >= 80 {
        GRADES[G_STRONG]
    } else if overall >= 60 {
        GRADES[G_STEADY]
    } else if overall >= 40 {
        GRADES[G_BASIC]
    } else {
        GRADES[G_WEAK]
    };

    let comment = ability_comment(
        grade,
        weakest.map(|i| &axes[i]),
        strongest.map(|i| &axes[i]),
        coverage,
        filled.len(),
    );

    Ability {
        axes,
        overall,
        mastery,
        balance,
        coverage,
        attempts: total_attempts,
        filled: filled.len(),
        max_rate,
        min_rate,
        weakest,
        strongest,
        grade,
        comment,
    }
}

/// 自动评语：说人话，指出强项与短板（老师可直接念或发班级群）
///
/// 注意：各题型掌握度接近时**不要**硬凑"强项/短板"，
/// 否则会出现"X 掌握最好、X 是短板"这种自相矛盾的话（本轮修过）。
pub fn ability_comment(
    grade: Grade,
    weakest: Option<&Axis>,
    strongest: Option<&Axis>,
    coverage: i64,
    filled: usize,
) -> String {
    if grade.key == "insufficient" {
        return format!("{}（目前只有 {} 个题型有作答）", grade.tip, filled);
    }

    let mut parts: Vec<String> = Vec::new();
    let spread = match (strongest, weakest) {
        (Some(s), Some(w)) => s.rate - w.rate,
        _ => 0,
    };
    if let (Some(s), Some(w)) = (strongest, weakest) {
        if spread >= 5 {
            parts.push(format!("{} 掌握最好（{}%）", s.label, s.rate));
            parts.push(format!("{} 是短板（{}%）", w.label, w.rate));
        } else {
            parts.push(format!("已作答的题型掌握度接近（约 {}%）", s.rate));
        }
    }

    let mut tail = match grade.key {
        "hexagon" => "六边形战士：各题型都稳，可以给更难的挑战。".to_string(),
        "allround" => "整体均衡，把最低那项再提 10% 就很亮眼。".to_string(),
        "specialist" => "强项很强，先把短板补到及格线，总分涨得最快。".to_string(),
        "strong" => "保持节奏，多练拔高题拉开差距。".to_string(),
        "steady" => "基础题优先保证全对，再逐步上难度。".to_string(),
        "basic" => "建议先把基础题正确率提到 80% 以上。".to_string(),
        _ => "建议课后单独安排针对性练习。".to_string(),
    };
    if coverage < 100 && filled > 0 {
        tail.push_str("（还有题型没作答，数据会随课堂更新）");
    }
    format!("{}。{}", parts.join("，"), tail)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 默认四个题型（权重取自 store.js 的 DEFAULT_TIERS）
    fn axes_fixture() -> Vec<(&'static str, &'static str, f64)> {
        vec![
            ("basic", "基础题", 3.0),
            ("advanced", "拔高题", 5.0),
            ("extended", "扩展题", 8.0),
            ("improve", "提升题", 10.0),
        ]
    }

    /// 造一份题型统计：`counts` 与 axes_fixture 一一对应，每项 (attempts, correct, half)
    fn tiers(counts: &[(u32, u32, u32)]) -> Vec<TierStat> {
        let fx = axes_fixture();
        fx.iter()
            .enumerate()
            .map(|(i, (key, label, weight))| {
                let (a, c, h) = counts[i];
                let mut b = Bucket::default();
                for _ in 0..c {
                    b.add("correct", 0.0, 0.0);
                }
                for _ in 0..h {
                    b.add("half", 0.0, 0.0);
                }
                for _ in 0..a.saturating_sub(c + h) {
                    b.add("wrong", 0.0, 0.0);
                }
                b.finalize(key, label, "#000", *weight, 0.5)
            })
            .collect()
    }

    fn total_attempts(t: &[TierStat]) -> u32 {
        t.iter().map(|x| x.attempts).sum()
    }

    /* ---- 与 tests/logic.test.js 第 11 组「能力评价」逐条对应 ---- */

    #[test]
    fn grade_table() {
        assert_eq!(GRADES.len(), 8); // 评级共 8 档
        let mut keys: Vec<&str> = GRADES.iter().map(|g| g.key).collect();
        keys.sort_unstable();
        keys.dedup();
        assert_eq!(keys.len(), 8); // key 不重复
        assert_eq!(GRADES[0].key, "hexagon");
        assert!(GRADES[0].label.contains("六边形")); // 最高档是「六边形战士」
    }

    #[test]
    fn all_round_genius() {
        // 四个题型各答对两次 → 全才
        let t = tiers(&[(2, 2, 0), (2, 2, 0), (2, 2, 0), (2, 2, 0)]);
        let a = ability_of_tiers(&t, total_attempts(&t), 2);
        assert_eq!(a.axes.len(), 4); // 雷达轴数 = 题型数
        assert!(a.axes.iter().all(|x| !x.label.is_empty())); // 每条轴都有名称
        assert!(a.axes.iter().all(|x| x.attempts == 2)); // 每条轴都记录了作答次数
        assert_eq!(a.overall, 100); // 四题型全对 → 综合分 100
        assert_eq!(a.mastery, 100); // 掌握度 100
        assert_eq!(a.coverage, 100); // 覆盖率 100%
        assert_eq!(a.balance, Some(100)); // 各轴齐平 → 均衡度 100
        assert_eq!(a.grade.key, "hexagon"); // 判定为六边形战士
        assert!(a.comment.contains("六边形战士"), "评语点出六边形战士：{}", a.comment);
    }

    #[test]
    fn specialist_with_weak_side() {
        // 基础/拔高全对，扩展/提升全错
        let t = tiers(&[(2, 2, 0), (2, 2, 0), (2, 0, 0), (2, 0, 0)]);
        let a = ability_of_tiers(&t, total_attempts(&t), 2);
        assert_eq!(a.grade.key, "specialist"); // 强项强、短板明显 → 偏科尖子
        assert_eq!(a.balance, Some(0)); // 均衡度 0
        assert!(a.comment.contains("短板"), "评语指出短板：{}", a.comment);
        assert_eq!(a.weakest_axis().map(|x| x.rate), Some(0)); // 最弱轴正确率为 0
        assert_eq!(a.strongest_axis().map(|x| x.rate), Some(100)); // 最强轴正确率为 100
    }

    #[test]
    fn half_ratio_is_consistent_with_scoring() {
        // 半对按 halfRatio = 0.5 折算（与加分口径一致）
        let t = tiers(&[(2, 0, 2), (0, 0, 0), (0, 0, 0), (0, 0, 0)]);
        let a = ability_of_tiers(&t, total_attempts(&t), 2);
        assert_eq!(a.axes.iter().find(|x| x.key == "basic").unwrap().rate, 50); // 半对两次 → 该轴 50%
    }

    #[test]
    fn newbie_is_insufficient_and_coverage_adjusted() {
        // 只答对 1 道基础题：样本不足，但综合分不能被算成 100
        let t = tiers(&[(1, 1, 0), (0, 0, 0), (0, 0, 0), (0, 0, 0)]);
        let a = ability_of_tiers(&t, total_attempts(&t), 2);
        assert_eq!(a.grade.key, "insufficient"); // 作答次数少于 minSample
        assert_eq!(a.coverage, 25); // 覆盖率 = 已作答题型占比（100 / 4）
        assert!(a.overall > 0 && a.overall < 100, "综合分被覆盖率折算（{}）", a.overall);
        assert_eq!(a.balance, None); // 只答过 1 个题型时均衡度无意义
        assert_eq!(a.axes.iter().filter(|x| x.attempts == 0).count(), 3); // 未作答题型次数为 0
    }

    #[test]
    fn axes_sorted_by_weight() {
        let t = tiers(&[(1, 1, 0), (1, 1, 0), (1, 1, 0), (1, 1, 0)]);
        let a = ability_of_tiers(&t, total_attempts(&t), 2);
        let first = a.axes.first().unwrap().weight;
        let last = a.axes.last().unwrap().weight;
        assert!(last >= first, "轴按权重升序排列（{} → {}）", first, last);
        assert_eq!(a.axes.first().unwrap().key, "basic");
        assert_eq!(a.axes.last().unwrap().key, "improve");
    }

    #[test]
    fn mastery_weights_by_tier() {
        // 基础题 100%（权重 3）、提升题 0%（权重 10）：掌握度应按权重加权
        let t = tiers(&[(1, 1, 0), (0, 0, 0), (0, 0, 0), (1, 0, 0)]);
        let a = ability_of_tiers(&t, total_attempts(&t), 1);
        // (100×3 + 0×10) / 13 = 23.07 → 23
        assert_eq!(a.mastery, 23, "掌握度按题型权重加权");
        // 覆盖率 50% → overall = round(23 × (0.6 + 0.4×0.5)) = round(23×0.8) = 18
        assert_eq!(a.overall, 18, "综合分 = 掌握度 × 覆盖系数");
        assert_eq!(a.balance, Some(0)); // 100 与 0 相差 100 → 均衡度 0
    }

    #[test]
    fn comment_avoids_self_contradiction() {
        // 各轴掌握度接近（spread < 5）时，不能说"X 最好、X 是短板"
        let t = tiers(&[(2, 1, 0), (2, 1, 0), (2, 1, 0), (2, 1, 0)]);
        let a = ability_of_tiers(&t, total_attempts(&t), 2);
        assert!(a.comment.contains("掌握度接近"), "应说明掌握度接近：{}", a.comment);
        assert!(!a.comment.contains("是短板"), "不应硬凑短板：{}", a.comment);
    }

    #[test]
    fn comment_mentions_missing_tiers() {
        let t = tiers(&[(1, 1, 0), (1, 1, 0), (0, 0, 0), (0, 0, 0)]);
        let a = ability_of_tiers(&t, total_attempts(&t), 1);
        assert!(a.comment.contains("还有题型没作答"), "覆盖率不满时提示：{}", a.comment);
    }

    #[test]
    fn empty_input_is_safe() {
        let a = ability_of_tiers(&[], 0, 2);
        assert_eq!(a.overall, 0);
        assert_eq!(a.mastery, 0);
        assert_eq!(a.coverage, 0);
        assert_eq!(a.balance, None);
        assert_eq!(a.grade.key, "insufficient");
        assert!(a.weakest.is_none() && a.strongest.is_none());
    }

    #[test]
    fn grade_thresholds_in_order() {
        // 依次验证判定顺序（顺序错了会把偏科尖子判成全面发展）
        let mk = |counts: &[(u32, u32, u32)], min_sample: u32| {
            let t = tiers(counts);
            ability_of_tiers(&t, total_attempts(&t), min_sample).grade.key
        };
        assert_eq!(mk(&[(2, 2, 0), (2, 2, 0), (2, 2, 0), (2, 2, 0)], 2), "hexagon");
        // 三题型 100%：覆盖率 75 但 minRate 100 → 全面发展（不是六边形，因为没覆盖满）
        assert_eq!(mk(&[(2, 2, 0), (2, 2, 0), (2, 2, 0), (0, 0, 0)], 2), "allround");
        // 强弱分明（≥85 且 <50）→ 先判偏科尖子，而不是学有余力
        assert_eq!(mk(&[(2, 2, 0), (2, 2, 0), (2, 2, 0), (2, 0, 0)], 2), "specialist");
        // 全部偏低 → 需要重点辅导
        assert_eq!(mk(&[(2, 0, 0), (2, 1, 0), (2, 0, 0), (2, 0, 0)], 2), "weak");
        // 样本不足优先级最高
        assert_eq!(mk(&[(1, 1, 0), (1, 1, 0), (1, 1, 0), (1, 1, 0)], 5), "insufficient");
    }

    #[test]
    fn bucket_finalize_matches_js() {
        let mut b = Bucket::default();
        b.add("correct", 3.0, 3.0);
        b.add("half", 1.5, 3.0);
        b.add("wrong", 0.0, 3.0);
        b.add("skip", 0.0, 3.0);
        assert_eq!(b.attempts, 4);
        assert_eq!(b.earned, 4.5);
        assert_eq!(b.base, 12.0);
        // credit = 1 + 0.5×1 = 1.5 → 1.5/4 = 37.5%
        assert_eq!(b.credit_rate(0.5), 37.5);
        assert_eq!(b.correct_rate(), 25.0);
        let t = b.finalize("basic", "基础题", "#66bb6a", 3.0, 0.5);
        assert_eq!(t.credit_rate, 37.5);
        assert_eq!(t.correct, 1);
    }

    #[test]
    fn grade_by_key_falls_back() {
        assert_eq!(grade_by_key("hexagon").short, "S");
        assert_eq!(grade_by_key("不存在").key, "insufficient");
    }
}
