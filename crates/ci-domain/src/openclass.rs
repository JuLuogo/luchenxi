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

/// 一个档位（档位名 + 它对应的百分制分数）
///
/// 档位**可配置**：各校评课表不同 —— 有的四档（优秀/良好/合格/待改进），有的三档，
/// 有的叫"优良中差"。分数按档位**均匀映射**（第 k 档 → (k-1)/(N-1)×100），
/// 所以三档/五档都不需要额外配置。
#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenLevel {
    pub label: String,
    /// 该档对应的百分制分数（0–100）
    pub rate: f64,
}

/// 默认四档
pub fn default_open_levels() -> Vec<OpenLevel> {
    vec![
        // 整数：总分是 round 过的整数，档位分数也取整数，否则 33 会落到 33.3 之下（错档）
        OpenLevel { label: "待改进".into(), rate: 0.0 },
        OpenLevel { label: "合格".into(), rate: 33.0 },
        OpenLevel { label: "良好".into(), rate: 67.0 },
        OpenLevel { label: "优秀".into(), rate: 100.0 },
    ]
}

/// 按档位名生成均匀档位（从低到高）。三档 ["待改进","合格","优秀"] → 0 / 50 / 100。
pub fn levels_from_labels(labels: &[String]) -> Vec<OpenLevel> {
    let n = labels.len();
    if n == 0 {
        return Vec::new();
    }
    if n == 1 {
        return vec![OpenLevel { label: labels[0].clone(), rate: 100.0 }];
    }
    labels
        .iter()
        .enumerate()
        .map(|(i, l)| OpenLevel {
            label: l.clone(),
            // 取整数，与总分的取整口径一致
            rate: ((i as f64) / ((n - 1) as f64) * 100.0).round(),
        })
        .collect()
}

/// 档位分数是否合法：**严格递增且在 0–100**
///
/// 为什么要有这条：总分是"落在哪一档"（取 rate 不超过总分的最高一档）。
/// 如果两档分数相同或递减，这个判断就没有意义了（总分 80 该算哪档？）。
/// 界面上保存前会调它，服务端也用它兜底。
pub fn levels_are_valid(levels: &[OpenLevel]) -> bool {
    if levels.len() < 2 {
        return false;
    }
    let mut prev = f64::NEG_INFINITY;
    for l in levels {
        if !(0.0..=100.0).contains(&l.rate) {
            return false;
        }
        if l.rate <= prev {
            return false;
        }
        prev = l.rate;
    }
    true
}

/// 一档（1 起）→ 档位名（越界取两端）
pub fn open_level(score: u8, levels: &[OpenLevel]) -> String {
    if levels.is_empty() {
        return String::new();
    }
    let i = (score.max(1) as usize - 1).min(levels.len() - 1);
    levels[i].label.clone()
}

/// 一档（1 起）→ 百分制（越界取两端）
pub fn open_rate(score: u8, levels: &[OpenLevel]) -> f64 {
    if levels.is_empty() {
        return 0.0;
    }
    let i = (score.max(1) as usize - 1).min(levels.len() - 1);
    levels[i].rate
}

/// 总分落在哪一档（**不再硬编码阈值**：取 rate 不超过总分的最高一档）
pub fn level_for_total(total: i64, levels: &[OpenLevel]) -> String {
    if levels.is_empty() {
        return String::new();
    }
    let mut best = &levels[0];
    for l in levels {
        if (total as f64) + 1e-9 >= l.rate {
            best = l;
        }
    }
    best.label.clone()
}

/// 这一档算不算"表扬"（供公开展示策略用：公开表扬、私下改进）
///
/// 判据是**上半档**：四档 → 良好/优秀（与之前的硬编码一致）；三档 → 第 2 档及以上；
/// 五档 → 第 3 档及以上。
pub fn is_praise(total: i64, levels: &[OpenLevel]) -> bool {
    let n = levels.len();
    if n == 0 {
        return false;
    }
    let idx = if n % 2 == 0 { n / 2 } else { (n + 1) / 2 - 1 };
    (total as f64) + 1e-9 >= levels[idx].rate
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
    // 保持签名不变：内部走默认四档（现有调用方与 parity 完全不受影响）
    evaluate_open_full(scores, dims, &default_open_levels())
}

/// 带自定义档位的版本
pub fn evaluate_open_full(
    scores: &[(String, u8)],
    dims: &[OpenDimension],
    levels: &[OpenLevel],
) -> OpenEvaluation {
    let mut parts: Vec<OpenPart> = Vec::new();
    let mut weight_used = 0.0;
    let mut weighted = 0.0;

    for d in dims {
        let Some((_, score)) = scores.iter().find(|(k, _)| k == &d.key) else {
            continue;
        };
        let rate = open_rate(*score, levels);
        weight_used += d.weight;
        weighted += rate * d.weight;
        parts.push(OpenPart {
            key: d.key.clone(),
            label: d.label.clone(),
            weight: d.weight,
            score: *score,
            level: open_level(*score, levels),
            rate,
            contribution: (rate * d.weight / 100.0 * 10.0).round() / 10.0,
        });
    }

    let total = if weight_used > 0.0 {
        (weighted / weight_used).round() as i64
    } else {
        0
    };

    // 总评档位 = **总分落在哪一档**（不再硬编码 90/65/30 阈值）。
    // 默认四档时与之前完全一致：全 3 档 = 67 → 落在"良好"(66.7) → 良好。
    // 换成三档/五档时自动跟着变，不会出现"四维全良好、总评却是合格"的自相矛盾。
    let level = level_for_total(total, levels);

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
pub fn show_on_stage(total: i64, levels: &[OpenLevel], policy: &str) -> bool {
    match policy {
        "always" => true,
        "never" => false,
        // smart 与任何未知值都按"只公开表扬"处理（安全默认）
        // 判据是上半档，所以换三档/五档也成立（不再认死"良好/优秀"两个名字）
        _ => is_praise(total, levels),
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
        let lv = default_open_levels();
        assert_eq!(open_rate(1, &lv), 0.0);
        assert_eq!(open_rate(2, &lv), 33.0);
        assert_eq!(open_rate(3, &lv), 67.0);
        assert_eq!(open_rate(4, &lv), 100.0);
        assert_eq!(open_level(1, &lv), "待改进");
        assert_eq!(open_level(4, &lv), "优秀");
        // 越界取两端（多档时不会崩）
        assert_eq!(open_level(9, &lv), "优秀");
        assert_eq!(open_level(0, &lv), "待改进");
    }

    #[test]
    fn custom_rates_must_increase() {
        // 均匀映射的默认档位合法
        assert!(levels_are_valid(&default_open_levels()));
        // 自定义分数（优=95、良=85…）也合法
        let custom = vec![
            OpenLevel { label: "差".into(), rate: 60.0 },
            OpenLevel { label: "中".into(), rate: 70.0 },
            OpenLevel { label: "良".into(), rate: 85.0 },
            OpenLevel { label: "优".into(), rate: 95.0 },
        ];
        assert!(levels_are_valid(&custom));
        // 总分落在自定义档位上
        assert_eq!(level_for_total(95, &custom), "优");
        assert_eq!(level_for_total(88, &custom), "良");
        // 65 分：≥ 差(60) 但 < 中(70) → 落在"差"（"取不超过总分的最高一档"就是这个意思）
        assert_eq!(level_for_total(65, &custom), "差");
        assert_eq!(level_for_total(70, &custom), "中");
        assert_eq!(level_for_total(0, &custom), "差", "低于最低档也算最低档");
        assert_eq!(level_for_total(100, &custom), "优");

        // 非法：相同分数
        let dup = vec![
            OpenLevel { label: "甲".into(), rate: 80.0 },
            OpenLevel { label: "乙".into(), rate: 80.0 },
        ];
        assert!(!levels_are_valid(&dup), "两档同分不合法（总分 80 该算哪档？）");
        // 非法：递减
        let desc = vec![
            OpenLevel { label: "甲".into(), rate: 90.0 },
            OpenLevel { label: "乙".into(), rate: 80.0 },
        ];
        assert!(!levels_are_valid(&desc), "递减不合法");
        // 非法：越界 / 只有一档
        assert!(!levels_are_valid(&[
            OpenLevel { label: "甲".into(), rate: -1.0 },
            OpenLevel { label: "乙".into(), rate: 50.0 },
        ]));
        assert!(!levels_are_valid(&[
            OpenLevel { label: "甲".into(), rate: 50.0 },
            OpenLevel { label: "乙".into(), rate: 101.0 },
        ]));
        assert!(!levels_are_valid(&[OpenLevel { label: "唯一".into(), rate: 100.0 }]), "至少两档");
        assert!(!levels_are_valid(&[]));
    }

    #[test]
    fn custom_level_counts_work() {
        // 三档：待改进 / 合格 / 优秀 → 0 / 50 / 100
        let three = levels_from_labels(&["待改进".into(), "合格".into(), "优秀".into()]);
        assert_eq!(three.len(), 3);
        assert_eq!(three[0].rate, 0.0);
        assert_eq!(three[1].rate, 50.0);
        assert_eq!(three[2].rate, 100.0);
        // 四档默认是 0/33/67/100（整数，与总分取整口径一致）
        let d = default_open_levels();
        assert_eq!(d[1].rate, 33.0);
        assert_eq!(d[2].rate, 67.0);

        // 五档（优良中差 + 待改进）：均匀映射
        let five = levels_from_labels(&[
            "差".into(), "中".into(), "良".into(), "优".into(), "特优".into(),
        ]);
        assert_eq!(five.len(), 5);
        assert_eq!(five[2].rate, 50.0);

        // 三档下评价：全 2 档（合格）= 50 分 → 落在"合格"（50.0）
        let ev = evaluate_open_full(
            &[
                ("basic".to_string(), 2),
                ("transfer".to_string(), 2),
            ],
            &dims(),
            &three,
        );
        assert_eq!(ev.total, 50);
        assert_eq!(ev.level, "合格", "三档下总分 50 → 合格");
        assert_eq!(ev.parts[0].level, "合格", "维度档位名也跟着换");

        // 三档下"表扬"判据 = 上半档（第 2 档及以上）
        assert!(!is_praise(0, &three), "0 分不算表扬");
        assert!(is_praise(50, &three), "50 分算表扬（上半档）");
        assert!(is_praise(100, &three));
        // 四档下与之前的硬编码一致：良好/优秀
        let four = default_open_levels();
        assert!(!is_praise(33, &four), "33 分（合格）不公开");
        assert!(is_praise(67, &four), "67 分（良好）公开");
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
        assert!(show_on_stage(100, &default_open_levels(), "smart"));
        assert!(show_on_stage(67, &default_open_levels(), "smart"));
        assert!(!show_on_stage(33, &default_open_levels(), "smart"), "合格不公开（私下改进）");
        assert!(!show_on_stage(0, &default_open_levels(), "smart"), "待改进更不能公开");
        // 未知策略按安全默认处理（宁可少公开）
        assert!(!show_on_stage(0, &default_open_levels(), "whatever"));
        assert!(show_on_stage(100, &default_open_levels(), ""));
        // 显式策略
        assert!(show_on_stage(0, &default_open_levels(), "always"), "always：一律公开");
        assert!(!show_on_stage(100, &default_open_levels(), "never"), "never：一律不公开");
    }

}
