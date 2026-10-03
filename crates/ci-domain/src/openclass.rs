//! openclass.rs — 公开课模式的**现场评价量规**
//!
//! 与日常课的"综合表现"（正确性/参与度/进步，数据自动算）不同：公开课要的是
//! **老师现场观察判断**，所以另立一套四维量规 —— 每维四档，点四下就完事。
//!
//! 设计依据见 `docs/15-公开课模式设计.md`：公开课评课表普遍看"目标达成 / 思维品质 /
//! 参与度 / 表达"，这四维是它的**学生侧投影**（听课老师看教师，现场被点评的是学生，
//! 两侧口径要能对上）。
//!
//! **评语一律规则生成**（离线可用、确定性强、不编造）；AI 只做可选润色，
//! 且只允许用这里给出的事实改写措辞 —— 见设计文档 §3。

use serde::{Deserialize, Serialize};

/// 一个评价维度（含给老师的锚点：现场要一眼知道"看什么"）
#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenDimension {
    pub key: String,
    pub label: String,
    pub weight: f64,
    /// 给老师的锚点（"看什么"）
    pub anchor: String,
}

/// 默认四维量规（权重 30/30/25/15）
pub fn default_open_dimensions() -> Vec<OpenDimension> {
    vec![
        OpenDimension {
            key: "basic".into(),
            label: "基础掌握".into(),
            weight: 30.0,
            anchor: "概念、公式、常规运算是否准确".into(),
        },
        OpenDimension {
            key: "transfer".into(),
            label: "拓展迁移".into(),
            weight: 30.0,
            anchor: "能否举一反三、把方法用到新情境".into(),
        },
        OpenDimension {
            key: "expression".into(),
            label: "思维表达".into(),
            weight: 25.0,
            anchor: "思路是否清晰、表达是否有条理".into(),
        },
        OpenDimension {
            key: "attitude".into(),
            label: "参与态度".into(),
            weight: 15.0,
            anchor: "投入程度、回应质量、是否敢试".into(),
        },
    ]
}

/// 四档的文字（1–4）
pub const OPEN_LEVELS: [&str; 4] = ["待改进", "合格", "良好", "优秀"];

/// 一档 → 文字
pub fn open_level(score: u8) -> &'static str {
    match score {
        1 => OPEN_LEVELS[0],
        2 => OPEN_LEVELS[1],
        3 => OPEN_LEVELS[2],
        _ => OPEN_LEVELS[3],
    }
}

/// 一档 → 百分制（1→0 / 2→33 / 3→67 / 4→100）
pub fn open_rate(score: u8) -> f64 {
    let s = score.clamp(1, 4) as f64;
    ((s - 1.0) / 3.0 * 100.0 * 10.0).round() / 10.0
}

/// 单维结果
#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenPart {
    pub key: String,
    pub label: String,
    pub weight: f64,
    pub score: u8,
    pub level: String,
    pub rate: f64,
    /// 这一维对总分的贡献
    pub contribution: f64,
}

/// 一次公开课现场评价
#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenEvaluation {
    /// 加权总分（百分制，四舍五入到整数）
    // specta 禁止裸 i64（BigInt 精度问题），显式导成 number
    #[cfg_attr(feature = "bindings", specta(type = specta_typescript::Number))]
    pub total: i64,
    /// 总评档位（优秀/良好/合格/待改进）
    pub level: String,
    pub parts: Vec<OpenPart>,
    /// 实际使用的权重和（未评的维度会被剔除并重新归一）
    pub weight_used: f64,
    /// 最强 / 最弱维度 key（分差 <8 分时不给，避免"X 最好、X 是短板"式自相矛盾）
    pub strongest: Option<String>,
    pub weakest: Option<String>,
    /// 规则评语（离线可用；AI 润色是另一回事）
    pub comment: String,
}

/// 现场评价：`scores` 是 `(维度 key, 档位 1–4)`，**未给的维度会被剔除并重新归一**
///
/// 为什么允许漏评：公开课现场时间紧，老师可能只想评其中两维（比如只关心"拓展迁移"）。
/// 若按缺失即 0 分算，总分会被凭空拉低 —— 那和"没数据就扣 15 分"是同一类错误。
pub fn evaluate_open(scores: &[(String, u8)], dims: &[OpenDimension]) -> OpenEvaluation {
    let mut parts: Vec<OpenPart> = Vec::new();
    let mut weight_used = 0.0;
    let mut weighted = 0.0;

    for d in dims {
        let Some((_, score)) = scores.iter().find(|(k, _)| k == &d.key) else {
            continue;
        };
        let rate = open_rate(*score);
        weight_used += d.weight;
        weighted += rate * d.weight;
        parts.push(OpenPart {
            key: d.key.clone(),
            label: d.label.clone(),
            weight: d.weight,
            score: *score,
            level: open_level(*score).to_string(),
            rate,
            contribution: (rate * d.weight / 100.0 * 10.0).round() / 10.0,
        });
    }

    let total = if weight_used > 0.0 {
        (weighted / weight_used).round() as i64
    } else {
        0
    };

    // 阈值与维度档位**对齐**：每维都是"良好"(3 档 = 67 分) → 总评也该是良好。
    // 原来按 90/75/60 分档，会出现"四维全良好、总评却是合格"的自相矛盾（测试抓到过）。
    let level = match total {
        90..=100 => "优秀",   // 大致对应"四维多为优秀"
        65..=89 => "良好",    // 四维全 3 档 = 67
        30..=64 => "合格",    // 四维全 2 档 = 33
        _ => "待改进",        // 四维全 1 档 = 0
    }
    .to_string();

    // 最强 / 最弱：分差太小就不指（否则会出现"表达最好、表达是短板"）
    let (strongest, weakest) = if parts.len() >= 2 {
        let mut sorted = parts.clone();
        sorted.sort_by(|a, b| b.rate.partial_cmp(&a.rate).unwrap_or(std::cmp::Ordering::Equal));
        let hi = sorted.first().unwrap();
        let lo = sorted.last().unwrap();
        if hi.rate - lo.rate >= 8.0 {
            (Some(hi.key.clone()), Some(lo.key.clone()))
        } else {
            (None, None)
        }
    } else {
        (None, None)
    };

    let mut ev = OpenEvaluation {
        total,
        level,
        parts,
        weight_used: (weight_used * 10.0).round() / 10.0,
        strongest,
        weakest,
        comment: String::new(),
    };
    ev.comment = open_comment(&ev);
    ev
}

/// 现场评价要不要在大屏上公开
///
/// **公开表扬、私下改进**：调研里公开"待改进"是有害的（国内教师反馈
/// "垫底的学生每次抬头就看见自己名字在最后面，逐渐产生抵触心理"）。
/// 所以默认只在"良好/优秀"时公开；合格/待改进只发给学生自己的设备。
///
/// `policy`：smart（默认）/ always / never
pub fn show_on_stage(level: &str, policy: &str) -> bool {
    match policy {
        "always" => true,
        "never" => false,
        // smart 与任何未知值都按"只公开表扬"处理（安全默认）
        _ => level == "优秀" || level == "良好",
    }
}

/// 规则评语：说人话，指出强项与短板（老师可直接念）
///
/// 与 `ability::ability_comment` 同一套思路：**只用已经算出来的事实**，
/// 不新增判断 —— 这是"AI 只润色不判断"的前提（事实来自这里，措辞才可以交给模型）。
pub fn open_comment(ev: &OpenEvaluation) -> String {
    if ev.parts.is_empty() {
        return "还没有评价任何维度。".to_string();
    }

    let mut head: Vec<String> = Vec::new();
    let find = |k: &Option<String>| -> Option<&OpenPart> {
        k.as_ref().and_then(|key| ev.parts.iter().find(|p| &p.key == key))
    };

    match (find(&ev.strongest), find(&ev.weakest)) {
        (Some(s), Some(w)) => {
            head.push(format!("{} 最突出（{}）", s.label, s.level));
            head.push(format!("{} 还有空间（{}）", w.label, w.level));
        }
        _ => {
            // 各维接近：不硬凑强项/短板
            let avg = (ev.parts.iter().map(|p| p.rate).sum::<f64>() / ev.parts.len() as f64).round();
            head.push(format!("各维度比较均衡（约 {} 分）", avg as i64));
        }
    }

    let tail = match ev.level.as_str() {
        "优秀" => "表现很完整，可以请他讲讲思路，给全班做个示范。",
        "良好" => "整体不错，把刚才那一步再追问一句，就能看出他到底懂到哪。",
        "合格" => "基本答到了，建议追问一个变式，看能不能迁移。",
        _ => "先肯定他愿意试，再从最基础的一步重新搭梯子。",
    };

    let missing = 4 - ev.parts.len();
    let tail = if missing > 0 {
        format!("{}（还有 {} 个维度没评）", tail, missing)
    } else {
        tail.to_string()
    };

    format!("{}。{}", head.join("，"), tail)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dims() -> Vec<OpenDimension> {
        default_open_dimensions()
    }

    fn sc(pairs: &[(&str, u8)]) -> Vec<(String, u8)> {
        pairs.iter().map(|(k, v)| (k.to_string(), *v)).collect()
    }

    #[test]
    fn full_four_dimension_scoring() {
        let ev = evaluate_open(&sc(&[("basic", 4), ("transfer", 4), ("expression", 4), ("attitude", 4)]), &dims());
        assert_eq!(ev.total, 100);
        assert_eq!(ev.level, "优秀");
        assert_eq!(ev.parts.len(), 4);
        assert_eq!(ev.weight_used, 100.0, "四维权重和 100");
        // 全同分：不指强项/短板（避免自相矛盾）
        assert!(ev.strongest.is_none() && ev.weakest.is_none());
        assert!(ev.comment.contains("均衡"), "评语：{}", ev.comment);

        let ev2 = evaluate_open(&sc(&[("basic", 1), ("transfer", 1), ("expression", 1), ("attitude", 1)]), &dims());
        assert_eq!(ev2.total, 0);
        assert_eq!(ev2.level, "待改进");
    }

    #[test]
    fn missing_dimensions_are_renormalized() {
        // 只评两维：不能被"没评的"拖低
        let ev = evaluate_open(&sc(&[("basic", 4), ("transfer", 4)]), &dims());
        assert_eq!(ev.total, 100, "只评的两维都是最高档 → 100（不是 60）");
        assert_eq!(ev.weight_used, 60.0);
        assert_eq!(ev.parts.len(), 2);
        assert!(ev.comment.contains("还有 2 个维度没评"), "评语要说明漏评：{}", ev.comment);

        // 只评一维
        let ev1 = evaluate_open(&sc(&[("transfer", 3)]), &dims());
        assert_eq!(ev1.total, 67, "3 档 → 66.7 → 67");
        assert_eq!(ev1.parts.len(), 1);
    }

    #[test]
    fn strongest_and_weakest_need_a_real_gap() {
        // 分差 33 分（4 档 vs 3 档 = 100 vs 67）→ 要指出
        let ev = evaluate_open(&sc(&[("basic", 4), ("transfer", 1)]), &dims());
        assert_eq!(ev.strongest.as_deref(), Some("basic"));
        assert_eq!(ev.weakest.as_deref(), Some("transfer"));
        assert!(ev.comment.contains("基础掌握 最突出"), "评语：{}", ev.comment);
        assert!(ev.comment.contains("拓展迁移 还有空间"), "评语：{}", ev.comment);

        // 分差为 0 → 不指
        let ev2 = evaluate_open(&sc(&[("basic", 3), ("transfer", 3)]), &dims());
        assert!(ev2.strongest.is_none() && ev2.weakest.is_none());
    }

    #[test]
    fn levels_follow_the_thresholds() {
        // 90/75/60 三档边界
        let all = |s: u8| evaluate_open(&sc(&[("basic", s), ("transfer", s), ("expression", s), ("attitude", s)]), &dims());
        assert_eq!(all(4).level, "优秀", "四维全 4 档 = 100");
        assert_eq!(all(3).level, "良好", "四维全 3 档 = 67 → 良好（与维度标签一致）");
        assert_eq!(all(2).level, "合格", "四维全 2 档 = 33 → 合格（与维度标签一致）");
        assert_eq!(all(1).level, "待改进", "四维全 1 档 = 0");
    }

    #[test]
    fn rate_mapping_is_linear() {
        assert_eq!(open_rate(1), 0.0);
        assert_eq!(open_rate(2), 33.3);
        assert_eq!(open_rate(3), 66.7);
        assert_eq!(open_rate(4), 100.0);
        assert_eq!(open_level(1), "待改进");
        assert_eq!(open_level(4), "优秀");
    }

    #[test]
    fn empty_evaluation_is_safe() {
        let ev = evaluate_open(&[], &dims());
        assert_eq!(ev.total, 0);
        assert_eq!(ev.weight_used, 0.0);
        assert!(ev.parts.is_empty());
        assert_eq!(ev.comment, "还没有评价任何维度。");
    }
    #[test]
    fn stage_policy_is_praise_public_criticism_private() {
        // smart（默认）：只公开表扬
        assert!(show_on_stage("优秀", "smart"));
        assert!(show_on_stage("良好", "smart"));
        assert!(!show_on_stage("合格", "smart"), "合格不公开（私下改进）");
        assert!(!show_on_stage("待改进", "smart"), "待改进更不能公开");
        // 未知策略按安全默认处理（宁可少公开）
        assert!(!show_on_stage("待改进", "whatever"));
        assert!(show_on_stage("优秀", ""));
        // 显式策略
        assert!(show_on_stage("待改进", "always"), "always：一律公开");
        assert!(!show_on_stage("优秀", "never"), "never：一律不公开");
    }

}
