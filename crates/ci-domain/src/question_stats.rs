//! question_stats.rs — **按题目**的作答统计（课后讲评与评价的依据）
//!
//! 为什么需要：既有分析都是"按题型"（`ability.rs` 的雷达轴）与"按人/队"（排名），
//! 但老师课后最想知道的是**哪几道题全班都不会** —— 那才是下一节课要重点讲评的东西。
//! 学习通等平台的"课堂报告"里也有这一块（题目维度正确率）。
//!
//! 口径（与 JS `analysis.js::questionStats` 逐字段一致）：
//!   · 只统计**有题目归属**的流水（快捷记分/手动加减没有 qid，不计入）
//!   · `attempts` = 该题流水条数；`correct`/`half`/`wrong`/`skip` 按判定计数
//!   · `correct_rate` = correct / attempts（百分比，四舍五入到整数）
//!   · `credit_rate` = (correct + half × halfRatio) / attempts（掌握度，与题型轴同一口径）
//!   · `avg_points` = 该题总得分 / attempts（保留两位小数）
//!   · `missers` = 答错/跳过的人名（去重、保持首次出现顺序）—— 讲评时点名用
//!   · 排序：正确率升序（最需要讲评的排最前）；正确率相同按作答人数多的在前

use crate::scoring::round2;
use crate::state::{BankQuestion, ScoreRecord, Student};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

/// 一道题的统计
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionStat {
    pub qid: String,
    /// 题干（截断到 40 字，够大屏/表格显示）
    pub stem: String,
    pub tier: String,
    pub tier_label: String,
    pub attempts: u32,
    pub correct: u32,
    pub half: u32,
    pub wrong: u32,
    pub skip: u32,
    /// 正确率（百分比整数）
    pub correct_rate: i64,
    /// 掌握度（半对按 halfRatio 折算，百分比整数）
    pub credit_rate: i64,
    /// 平均得分（两位小数）
    pub avg_points: f64,
    /// 答错/跳过的人名（去重，首次出现顺序）
    pub missers: Vec<String>,
}

/// 百分比（四舍五入到整数；分母 0 → 0）
fn pct(a: f64, b: f64) -> i64 {
    if b <= 0.0 {
        return 0;
    }
    ((a / b) * 100.0).round() as i64
}

/// 题干截断（与 JS 的 `U.shortStem` 同口径：40 字 + 省略号）
pub fn short_stem(stem: &str) -> String {
    let chars: Vec<char> = stem.chars().collect();
    if chars.len() <= 40 {
        return stem.to_string();
    }
    let head: String = chars.into_iter().take(40).collect();
    format!("{}…", head)
}

/// 按题目统计
///
/// * `records` —— 该次统计范围内的流水（通常是某套试卷的 records；传全部也行）
/// * `bank` —— 题库（用来取题干与题型）
/// * `students` —— 学生表（把 sid 变成人名）
/// * `half_ratio` —— 半对折算系数（与设置一致）
pub fn question_stats(
    records: &[ScoreRecord],
    bank: &[BankQuestion],
    students: &[Student],
    tier_labels: &[(String, String)],
    half_ratio: f64,
) -> Vec<QuestionStat> {
    // 按 qid 归集（保持首次出现顺序，便于稳定输出）
    let mut order: Vec<String> = Vec::new();
    let mut buckets: std::collections::HashMap<String, (u32, u32, u32, u32, u32, f64, Vec<String>)> =
        std::collections::HashMap::new();

    for r in records {
        let Some(qid) = r.qid.as_ref().filter(|q| !q.is_empty()) else {
            continue; // 快捷记分/手动加减没有题目归属
        };
        if !buckets.contains_key(qid) {
            order.push(qid.clone());
            buckets.insert(qid.clone(), (0, 0, 0, 0, 0, 0.0, Vec::new()));
        }
        let e = buckets.get_mut(qid).unwrap();
        e.0 += 1; // attempts
        match r.result.as_str() {
            "correct" => e.1 += 1,
            "half" => e.2 += 1,
            "wrong" => e.3 += 1,
            "skip" => e.4 += 1,
            _ => {} // manual 等不计入判定分布
        }
        e.5 += r.points;
        if matches!(r.result.as_str(), "wrong" | "skip") {
            if let Some(sid) = r.sid.as_ref() {
                if let Some(stu) = students.iter().find(|s| &s.id == sid) {
                    if !e.6.contains(&stu.name) {
                        e.6.push(stu.name.clone());
                    }
                }
            }
        }
    }

    let mut out: Vec<QuestionStat> = order
        .into_iter()
        .map(|qid| {
            let (attempts, correct, half, wrong, skip, points, missers) = buckets.remove(&qid).unwrap();
            let q = bank.iter().find(|b| b.id == qid);
            let tier = q.map(|x| x.tier.clone()).unwrap_or_default();
            let label = tier_labels
                .iter()
                .find(|(k, _)| k == &tier)
                .map(|(_, l)| l.clone())
                .unwrap_or_else(|| tier.clone());
            let denom = attempts as f64;
            QuestionStat {
                qid,
                stem: q.map(|x| short_stem(&x.stem)).unwrap_or_else(|| "（题目已删除）".to_string()),
                tier,
                tier_label: label,
                attempts,
                correct,
                half,
                wrong,
                skip,
                correct_rate: pct(correct as f64, denom),
                credit_rate: pct(correct as f64 + half as f64 * half_ratio, denom),
                avg_points: round2(if denom > 0.0 { points / denom } else { 0.0 }),
                missers,
            }
        })
        .collect();

    // 正确率升序（最需要讲评的在前）；同率则作答多的在前
    out.sort_by(|a, b| {
        a.correct_rate
            .cmp(&b.correct_rate)
            .then(b.attempts.cmp(&a.attempts))
            .then(a.qid.cmp(&b.qid))
    });
    out
}

/// 课后评价用的"题目维度"结论（一句话，供学情总结与讲评建议使用）
///
/// 只在**有题目统计**时给结论；一道题都没答则返回 None。
pub fn review_line(stats: &[QuestionStat]) -> Option<String> {
    let answered: Vec<&QuestionStat> = stats.iter().filter(|s| s.attempts > 0).collect();
    if answered.is_empty() {
        return None;
    }
    let worst = answered.first()?; // 已按正确率升序
    let best = answered.last()?;
    let mut line = format!(
        "本套题共 {} 道有作答，整体正确率 {}%。",
        answered.len(),
        pct(
            answered.iter().map(|s| s.correct as f64).sum::<f64>(),
            answered.iter().map(|s| s.attempts as f64).sum::<f64>()
        )
    );
    line.push_str(&format!(
        "最需要讲评的是「{}」（正确率 {}%，{} 人作答，{} 人答错或跳过）；掌握最好的是「{}」（正确率 {}%）。",
        worst.stem,
        worst.correct_rate,
        worst.attempts,
        worst.wrong + worst.skip,
        best.stem,
        best.correct_rate
    ));
    // 全班都没答对的题单独点出来
    let zero: Vec<&QuestionStat> = answered.iter().filter(|s| s.correct == 0).copied().collect();
    if !zero.is_empty() {
        line.push_str(&format!("另有 {} 道题无人答对，建议课堂重讲。", zero.len()));
    }
    Some(line)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::BankQuestion;

    fn stu(id: &str, name: &str) -> Student {
        Student {
            id: id.into(),
            name: name.into(),
            team_id: Some("tm1".into()),
            active: true,
            joined_at: 0,
            called: 0,
        }
    }

    fn rec(sid: &str, qid: Option<&str>, result: &str, points: f64, at: i64) -> ScoreRecord {
        ScoreRecord {
            id: format!("r{}", at),
            sid: Some(sid.into()),
            qid: qid.map(|s| s.to_string()),
            tier: "basic".into(),
            quiz_id: Some("qz1".into()),
            result: result.into(),
            base: 3.0,
            ratio: 1.0,
            points,
            source: "student".into(),
            note: String::new(),
            at,
            by: String::new(),
        }
    }

    fn bank() -> Vec<BankQuestion> {
        vec![
            BankQuestion { id: "q1".into(), tier: "basic".into(), stem: "1+1=?".into(), ..Default::default() },
            BankQuestion { id: "q2".into(), tier: "advanced".into(), stem: "求导：x²".into(), ..Default::default() },
            BankQuestion { id: "q3".into(), tier: "basic".into(), stem: "很难的题".into(), ..Default::default() },
        ]
    }

    fn labels() -> Vec<(String, String)> {
        vec![("basic".into(), "基础题".into()), ("advanced".into(), "拔高题".into())]
    }

    #[test]
    fn counts_and_rates_per_question() {
        let students = vec![stu("s1", "甲"), stu("s2", "乙"), stu("s3", "丙")];
        let records = vec![
            // q1：3 人作答，2 对 1 错
            rec("s1", Some("q1"), "correct", 3.0, 1),
            rec("s2", Some("q1"), "correct", 3.0, 2),
            rec("s3", Some("q1"), "wrong", 0.0, 3),
            // q2：2 人作答，1 半对 1 跳过
            rec("s1", Some("q2"), "half", 2.5, 4),
            rec("s2", Some("q2"), "skip", 0.0, 5),
            // q3：没人答（不该出现在结果里）
            // 快捷记分（没有 qid）→ 不计入任何题
            rec("s1", None, "correct", 5.0, 6),
        ];
        let stats = question_stats(&records, &bank(), &students, &labels(), 0.5);
        assert_eq!(stats.len(), 2, "只统计有题目归属的流水");

        // 排序：正确率升序 → q2(0%) 在前，q1(67%) 在后
        let q2 = &stats[0];
        assert_eq!(q2.qid, "q2");
        assert_eq!(q2.stem, "求导：x²");
        assert_eq!(q2.tier_label, "拔高题");
        assert_eq!(q2.attempts, 2);
        assert_eq!(q2.half, 1);
        assert_eq!(q2.skip, 1);
        assert_eq!(q2.correct_rate, 0);
        assert_eq!(q2.credit_rate, 25, "1 半对 × 0.5 / 2 次 = 25%");
        assert_eq!(q2.avg_points, 1.25, "(2.5 + 0) / 2");
        assert_eq!(q2.missers, vec!["乙"], "跳过的人也算进 missers");

        let q1 = &stats[1];
        assert_eq!(q1.qid, "q1");
        assert_eq!(q1.attempts, 3);
        assert_eq!(q1.correct, 2);
        assert_eq!(q1.wrong, 1);
        assert_eq!(q1.correct_rate, 67, "2/3 → 67%");
        assert_eq!(q1.credit_rate, 67);
        assert_eq!(q1.avg_points, 2.0, "(3+3+0)/3");
        assert_eq!(q1.missers, vec!["丙"]);
    }

    #[test]
    fn missers_are_deduped_and_keep_first_order() {
        let students = vec![stu("s1", "甲"), stu("s2", "乙")];
        let records = vec![
            rec("s1", Some("q1"), "wrong", 0.0, 1),
            rec("s1", Some("q1"), "wrong", 0.0, 2), // 同一人错两次
            rec("s2", Some("q1"), "skip", 0.0, 3),
        ];
        let stats = question_stats(&records, &bank(), &students, &labels(), 0.5);
        assert_eq!(stats[0].missers, vec!["甲", "乙"], "去重且保持首次出现顺序");
    }

    #[test]
    fn deleted_question_still_counted() {
        let students = vec![stu("s1", "甲")];
        let records = vec![rec("s1", Some("已删除的题"), "correct", 3.0, 1)];
        let stats = question_stats(&records, &bank(), &students, &labels(), 0.5);
        assert_eq!(stats.len(), 1);
        assert_eq!(stats[0].stem, "（题目已删除）", "题被删了也要能统计（流水还在）");
        assert_eq!(stats[0].correct_rate, 100);
    }

    #[test]
    fn short_stem_truncates() {
        assert_eq!(short_stem("短题干"), "短题干");
        let long: String = "题".repeat(50);
        let cut = short_stem(&long);
        assert_eq!(cut.chars().count(), 41, "40 字 + 省略号");
        assert!(cut.ends_with('…'));
    }

    #[test]
    fn review_line_points_at_weakest_question() {
        let students = vec![stu("s1", "甲"), stu("s2", "乙")];
        let records = vec![
            rec("s1", Some("q1"), "correct", 3.0, 1),
            rec("s2", Some("q1"), "correct", 3.0, 2),
            rec("s1", Some("q3"), "wrong", 0.0, 3),
            rec("s2", Some("q3"), "wrong", 0.0, 4),
        ];
        let stats = question_stats(&records, &bank(), &students, &labels(), 0.5);
        let line = review_line(&stats).expect("有作答就该有结论");
        assert!(line.contains("共 2 道有作答"), "{}", line);
        assert!(line.contains("很难的题"), "要点名最需要讲评的题：{}", line);
        assert!(line.contains("无人答对"), "全班没人对的题要单独点出来：{}", line);
        assert!(line.contains("1+1=?"), "也要提掌握最好的：{}", line);

        // 一道题都没答 → 不给结论
        assert!(review_line(&[]).is_none());
    }
}
