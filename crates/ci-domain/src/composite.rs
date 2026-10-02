//! composite.rs — **多维度评价**：把"答对率"之外的参与度与进步纳入评价
//!
//! 为什么加：调研（`docs/research/评价算法与量规设计.md` §3.3）的结论是——
//! 只有"正确性"一个维度会奖励外向行为（"谁话多谁分高"）、也看不出学生的变化；
//! 成熟做法是 3~4 个维度加权，且**权重必须可配置**（没有任何研究给出"正确权重"）。
//!
//! 本模块只做**纯计算**，维度取值由调用方提供：
//!   · 正确性（mastery）—— 掌握度，建议用 [`decayed_rate`] 的衰减平均（看重"现在会什么"）
//!   · 参与度（participation）—— 出席/作答即计分，**不论对错**（IST 课程里 50% 的测验分仅按参与给）
//!   · 进步（growth）—— 与**自己**前后半段比，个体内比较，不与别人比
//!
//! 三条口径都刻意做成"可解释、可下钻"：`Evaluation.parts` 里带每个维度的原始值、权重与贡献分，
//! 学生能看到"我这项为什么低"（Hattie 的 Where to next 要求可执行）。
//!
//! 与 JS 侧 `analysis.js::evaluate / participationRate / growthScore / decayedRate`
//! 逐字段 parity 比对。

use crate::state::ScoreRecord;
use serde::{Deserialize, Serialize};

/// 三个维度的权重（百分比，调用方保证和为 100）
#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvalWeights {
    /// 正确性（掌握度）
    pub mastery: f64,
    /// 参与度（出席/作答，不论对错）
    pub participation: f64,
    /// 进步（个体内比较）
    pub growth: f64,
}

impl Default for EvalWeights {
    fn default() -> Self {
        // 调研建议：正确性 50–60 / 参与度 20–30 / 进步 10–15
        EvalWeights { mastery: 60.0, participation: 25.0, growth: 15.0 }
    }
}

/// 一个维度的下钻信息
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvalPart {
    pub key: String,
    pub label: String,
    /// 该维度的原始分（0~100）
    pub value: i64,
    /// 权重（百分比）
    pub weight: f64,
    /// 对总分的贡献（value × weight / 100，两位小数）
    pub contribution: f64,
    /// 该维度是否有效（样本不足时 false，且不计入总分）
    pub valid: bool,
    /// 一句话说明（为什么是这个分）
    pub hint: String,
}

/// 综合表现
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Evaluation {
    /// 综合分（0~100）
    pub total: i64,
    pub parts: Vec<EvalPart>,
    /// 实际参与计算的权重和（有维度失效时 < 100）
    pub weight_used: f64,
}

fn round2(x: f64) -> f64 {
    (x * 100.0).round() / 100.0
}

/// 参与度：作答过的题数 / 应作答的题数（百分比整数）
///
/// 分母是"这节课推过的题数"（试卷题数）；**答错也算参与** —— 这正是它的意义：
/// 把"敢答"与"答对"分开，内向或基础弱的学生也能拿到过程分。
pub fn participation_rate(answered: u32, total: u32) -> i64 {
    if total == 0 {
        return 0;
    }
    (((answered.min(total) as f64) / total as f64) * 100.0).round() as i64
}

/// 进步分：前后半段掌握度的变化
///
/// * `early` / `late` —— 前半段与后半段的掌握度（0~100）
/// * `enough` —— 样本是否够（不足时该维度失效，不参与加权）
///
/// 映射：以 50 为基准（不变 = 50 分），每变化 1 个百分点折算 1 分，封顶 0~100。
/// 这样"退步"会低于 50 分，但不会变成 0 —— 它是**相对自己的**信号，不是惩罚。
pub fn growth_score(early: i64, late: i64, enough: bool) -> i64 {
    if !enough {
        return 0;
    }
    let delta = late - early;
    (50 + delta).clamp(0, 100)
}

/// 衰减平均掌握度：`decay` 给最近一次，其余给此前所有尝试的平均（默认 0.65/0.35）
///
/// 依据（Otus 官方）：O'Connor「Accuracy Over History」——优先体现学生**现在**会什么；
/// Marzano 的幂律学习曲线；Guskey「Safety to Fail」——最近一次权重高，学生永远有成功路径。
///
/// 只在**有判定的流水**上算（manual 不算），空集返回 0。
pub fn decayed_rate(records: &[ScoreRecord], half_ratio: f64, decay: f64) -> i64 {
    let scored: Vec<f64> = records
        .iter()
        .filter(|r| matches!(r.result.as_str(), "correct" | "half" | "wrong" | "skip"))
        .map(|r| match r.result.as_str() {
            "correct" => 1.0,
            "half" => half_ratio,
            _ => 0.0,
        })
        .collect();
    if scored.is_empty() {
        return 0;
    }
    let last = *scored.last().unwrap();
    if scored.len() == 1 {
        return (last * 100.0).round() as i64;
    }
    let prior: f64 = scored[..scored.len() - 1].iter().sum::<f64>() / (scored.len() - 1) as f64;
    let d = decay.clamp(0.0, 1.0);
    (((last * d) + (prior * (1.0 - d))) * 100.0).round() as i64
}

/// 综合表现：三维加权求和（失效维度自动剔除，权重重新归一）
pub fn evaluate(mastery: i64, participation: i64, growth: i64, growth_valid: bool, w: &EvalWeights) -> Evaluation {
    let mut parts = vec![
        EvalPart {
            key: "mastery".into(),
            label: "正确性".into(),
            value: mastery.clamp(0, 100),
            weight: w.mastery,
            contribution: 0.0,
            valid: true,
            hint: "掌握度（答对 + 半对按系数折算），用衰减平均更看重最近表现".into(),
        },
        EvalPart {
            key: "participation".into(),
            label: "参与度".into(),
            value: participation.clamp(0, 100),
            weight: w.participation,
            contribution: 0.0,
            valid: true,
            hint: "本节课作答过的题数占比 —— **答错也算参与**".into(),
        },
        EvalPart {
            key: "growth".into(),
            label: "进步".into(),
            value: growth.clamp(0, 100),
            weight: w.growth,
            contribution: 0.0,
            valid: growth_valid,
            hint: if growth_valid {
                "与自己前半段比：50 = 持平，>50 进步，<50 退步".into()
            } else {
                "样本还太少，暂时不评进步（不作 0 分处理）".to_string()
            },
        },
    ];

    let weight_used: f64 = parts.iter().filter(|p| p.valid).map(|p| p.weight.max(0.0)).sum();
    let mut total = 0.0;
    for p in parts.iter_mut() {
        if !p.valid || weight_used <= 0.0 {
            p.contribution = 0.0;
            continue;
        }
        // 权重按"有效维度"重新归一 —— 否则样本不足的学生会被凭空扣掉 15 分
        let eff = p.weight.max(0.0) / weight_used * 100.0;
        p.contribution = round2(p.value as f64 * eff / 100.0);
        total += p.contribution;
    }

    Evaluation { total: total.round() as i64, parts, weight_used: round2(weight_used) }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(result: &str, at: i64) -> ScoreRecord {
        ScoreRecord {
            id: format!("r{}", at),
            sid: Some("s1".into()),
            qid: Some("q1".into()),
            tier: "basic".into(),
            quiz_id: None,
            result: result.into(),
            base: 3.0,
            ratio: 1.0,
            points: 0.0,
            source: "student".into(),
            note: String::new(),
            at,
            by: String::new(),
        }
    }

    #[test]
    fn participation_counts_wrong_answers() {
        assert_eq!(participation_rate(5, 5), 100);
        assert_eq!(participation_rate(3, 5), 60);
        assert_eq!(participation_rate(0, 5), 0);
        assert_eq!(participation_rate(3, 0), 0, "没有题时不给分（也不 panic）");
        assert_eq!(participation_rate(9, 5), 100, "答多了也不超过 100");
        // 关键语义：参与度只看"答没答"，与对错无关 —— 由调用方只统计作答条数即可
    }

    #[test]
    fn growth_is_relative_to_self() {
        assert_eq!(growth_score(50, 50, true), 50, "持平 = 50 分");
        assert_eq!(growth_score(40, 70, true), 80, "进步 30 个点 → 80 分");
        assert_eq!(growth_score(70, 40, true), 20, "退步 30 个点 → 20 分（不是 0 分）");
        assert_eq!(growth_score(0, 100, true), 100, "封顶 100");
        assert_eq!(growth_score(100, 0, true), 0, "下限 0");
        assert_eq!(growth_score(40, 70, false), 0, "样本不足 → 0（由 valid=false 决定不计入）");
    }

    #[test]
    fn decayed_rate_weighs_recent_more() {
        // 早期全错、最近一次答对 → 衰减平均应显著高于"累计平均"
        let recs = vec![rec("wrong", 1), rec("wrong", 2), rec("wrong", 3), rec("correct", 4)];
        // 累计平均 = 1/4 = 25%；衰减 = 1×0.65 + 0×0.35 = 65%
        assert_eq!(decayed_rate(&recs, 0.5, 0.65), 65, "最近一次答对 → 65（累计平均只有 25）");
        assert_eq!(decayed_rate(&recs, 0.5, 1.0), 100, "decay=1 → 完全看最近一次");
        assert_eq!(decayed_rate(&recs, 0.5, 0.0), 0, "decay=0 → 完全看此前平均");
        // 半对按系数折算
        let half = vec![rec("half", 1), rec("half", 2)];
        assert_eq!(decayed_rate(&half, 0.5, 0.65), 50, "两次半对 → 50");
        assert_eq!(decayed_rate(&half, 0.4, 0.65), 40, "半对系数 0.4 → 40");
        // 单条流水
        assert_eq!(decayed_rate(&[rec("correct", 1)], 0.5, 0.65), 100);
        // 空集与纯手动
        assert_eq!(decayed_rate(&[], 0.5, 0.65), 0);
        let mut manual = rec("manual", 1);
        manual.result = "manual".into();
        assert_eq!(decayed_rate(&[manual], 0.5, 0.65), 0, "手动加减不算掌握度");
    }

    #[test]
    fn evaluate_weights_and_drilldown() {
        let w = EvalWeights::default();
        let e = evaluate(80, 100, 60, true, &w);
        // 80×0.6 + 100×0.25 + 60×0.15 = 48 + 25 + 9 = 82
        assert_eq!(e.total, 82);
        assert_eq!(e.parts.len(), 3, "三个维度可下钻");
        assert_eq!(e.parts[0].contribution, 48.0);
        assert_eq!(e.parts[1].contribution, 25.0);
        assert_eq!(e.parts[2].contribution, 9.0);
        assert_eq!(e.weight_used, 100.0);
        assert!(e.parts.iter().all(|p| p.valid));
    }

    #[test]
    fn evaluate_renormalizes_when_growth_missing() {
        // 进步维度样本不足 → 剔除并把权重按比例分给其余两个维度，
        // 否则"数据不足"会被凭空扣掉 15 分
        let w = EvalWeights::default();
        let e = evaluate(80, 100, 0, false, &w);
        // 有效权重 60+25=85 → 正确性 60/85、参与度 25/85
        assert_eq!(e.weight_used, 85.0);
        assert_eq!(e.parts[2].valid, false);
        assert_eq!(e.parts[2].contribution, 0.0);
        let expect = ((80.0_f64 * 60.0 / 85.0) + (100.0_f64 * 25.0 / 85.0)).round() as i64;
        assert_eq!(e.total, expect, "剔除后重新归一：{}", e.total);
        assert!(e.total > 80, "不能因为样本不足就把总分压低");
    }

    #[test]
    fn evaluate_handles_custom_weights() {
        // 教师把权重改成"参与为主"（调研明确：权重是课程政策，没有最优值）
        let w = EvalWeights { mastery: 20.0, participation: 60.0, growth: 20.0 };
        let e = evaluate(0, 100, 50, true, &w);
        assert_eq!(e.total, 70, "0×0.2 + 100×0.6 + 50×0.2 = 70");
        // 全 0 权重不能 panic、不能除零
        let zero = EvalWeights { mastery: 0.0, participation: 0.0, growth: 0.0 };
        let e2 = evaluate(50, 50, 50, true, &zero);
        assert_eq!(e2.total, 0);
        assert_eq!(e2.weight_used, 0.0);
    }
}
