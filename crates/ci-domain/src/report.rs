//! report.rs — **课后课堂报告**：把一节课的数据汇总成一份可导出的报告
//!
//! 为什么需要：既有产物是"文字小结（txt）+ 明细 CSV"，老师课后想要的是**一份能发出去的完整报告**
//! —— 出勤、整体、各队对比、题型掌握、题目正确率与讲评顺序、学生表现、能力画像。
//! 学习通的"课堂报告"就是这个形态，也是这套积分系统最自然的收尾。
//!
//! 设计：`build_report` 只做**数据汇总**（纯函数、可测），`to_markdown` 负责**排版**。
//! 两者都与 JS 侧 `analysis.js::classReport` 逐字段/逐行 parity 比对。
//!
//! 口径说明：
//!   · 出勤（签到）由调用方传入 —— 它来自枢纽的 presence，不在流水里
//!   · 整体/题型：与 `ability` 同一口径（掌握度 = 答对 + 半对×halfRatio）
//!   · 各队：与 `classroom::team_stats` 同一口径（第一行是全班）
//!   · 题目：与 `question_stats` 同一口径（正确率升序 = 讲评顺序）
//!   · 学生：积分 = 流水求和；得分率 = 掌握度

use crate::ability::TierStat;
use crate::classroom::TeamStat;
use crate::question_stats::QuestionStat;
use crate::state::{ScoreRecord, Student, Team};
use serde::{Deserialize, Serialize};

/// 报告里的一个学生
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportStudent {
    pub sid: String,
    pub name: String,
    pub team_name: String,
    pub score: f64,
    pub attempts: u32,
    pub correct: u32,
    /// 掌握度（百分比整数）
    pub credit_rate: i64,
}

/// 出勤情况（由调用方传入：来自枢纽 presence）
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Checkin {
    pub seated: u32,
    pub total: u32,
    pub rate: i64,
}

/// 一节课的完整报告数据
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClassReport {
    pub course_name: String,
    pub generated_at: i64,
    pub room: String,
    pub checkin: Checkin,
    /// 作答题次
    pub attempts: u32,
    pub correct: u32,
    pub half: u32,
    pub wrong: u32,
    pub skip: u32,
    /// 整体掌握度（百分比整数）
    pub credit_rate: i64,
    /// 累计得分
    pub earned: f64,
    /// 各队对比（第一行是"全班"）
    pub teams: Vec<TeamStat>,
    /// 题型掌握
    pub tiers: Vec<TierStat>,
    /// 题目正确率（已按正确率升序 = 讲评顺序）
    pub questions: Vec<QuestionStat>,
    /// 学生（按积分降序）
    pub students: Vec<ReportStudent>,
    /// 班级评语（来自 ability 的评语；没有数据时为空串）
    pub comment: String,
    /// 讲评建议（来自 question_stats::review_line）
    pub review_line: String,
}

/// 汇总出报告数据（纯函数）
///
/// * `tiers` —— 题型统计（`ability::TierStat`，调用方按同一口径算好）
/// * `teams` —— 各队统计（`classroom::TeamStat`，第一行应为"全班"）
/// * `questions` —— 题目统计（`question_stats`，已排序）
/// * `comment` / `review_line` —— 评语与讲评建议（调用方从 ability/question_stats 取）
#[allow(clippy::too_many_arguments)]
pub fn build_report(
    course_name: &str,
    room: &str,
    generated_at: i64,
    checkin: Checkin,
    records: &[ScoreRecord],
    students: &[Student],
    teams: &[Team],
    tiers: Vec<TierStat>,
    team_stats: Vec<TeamStat>,
    questions: Vec<QuestionStat>,
    comment: &str,
    review_line: &str,
    half_ratio: f64,
) -> ClassReport {
    // 整体：只统计有判定意义的流水（manual 不算作答）
    let mut attempts = 0u32;
    let mut correct = 0u32;
    let mut half = 0u32;
    let mut wrong = 0u32;
    let mut skip = 0u32;
    let mut earned = 0.0f64;
    for r in records {
        earned += r.points;
        match r.result.as_str() {
            "correct" => {
                attempts += 1;
                correct += 1;
            }
            "half" => {
                attempts += 1;
                half += 1;
            }
            "wrong" => {
                attempts += 1;
                wrong += 1;
            }
            "skip" => {
                attempts += 1;
                skip += 1;
            }
            _ => {}
        }
    }
    let credit_rate = if attempts > 0 {
        (((correct as f64 + half as f64 * half_ratio) / attempts as f64) * 100.0).round() as i64
    } else {
        0
    };

    // 学生：积分 + 作答 + 答对 + 掌握度
    let mut rows: Vec<ReportStudent> = students
        .iter()
        .map(|s| {
            let mine: Vec<&ScoreRecord> = records.iter().filter(|r| r.sid.as_deref() == Some(&s.id)).collect();
            let mut att = 0u32;
            let mut cor = 0u32;
            let mut hf = 0u32;
            let mut score = 0.0f64;
            for r in mine {
                score += r.points;
                match r.result.as_str() {
                    "correct" => {
                        att += 1;
                        cor += 1;
                    }
                    "half" => {
                        att += 1;
                        hf += 1;
                    }
                    "wrong" | "skip" => att += 1,
                    _ => {}
                }
            }
            let team_name = s
                .team_id
                .as_ref()
                .and_then(|tid| teams.iter().find(|t| &t.id == tid))
                .map(|t| t.name.clone())
                .unwrap_or_default();
            ReportStudent {
                sid: s.id.clone(),
                name: s.name.clone(),
                team_name,
                score: crate::scoring::round2(score),
                attempts: att,
                correct: cor,
                credit_rate: if att > 0 {
                    (((cor as f64 + hf as f64 * half_ratio) / att as f64) * 100.0).round() as i64
                } else {
                    0
                },
            }
        })
        .collect();
    rows.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(b.credit_rate.cmp(&a.credit_rate))
            .then(a.name.cmp(&b.name))
    });

    ClassReport {
        course_name: course_name.to_string(),
        generated_at,
        room: room.to_string(),
        checkin,
        attempts,
        correct,
        half,
        wrong,
        skip,
        credit_rate,
        earned: crate::scoring::round2(earned),
        teams: team_stats,
        tiers,
        questions,
        students: rows,
        comment: comment.to_string(),
        review_line: review_line.to_string(),
    }
}

/// 排版成 Markdown（老师可以直接发到班级群 / 存进课后资料）
pub fn to_markdown(r: &ClassReport) -> String {
    let mut out = String::new();
    out.push_str(&format!("# 课堂报告 · {}\n\n", if r.course_name.is_empty() { "课堂积分" } else { &r.course_name }));
    out.push_str(&format!(
        "> 房间 {} ｜ 生成于 {}\n\n",
        r.room,
        fmt_time(r.generated_at)
    ));

    // 一、出勤
    out.push_str("## 一、出勤\n\n");
    if r.checkin.total > 0 {
        out.push_str(&format!(
            "- 签到 **{} / {} 队**（{}%）\n\n",
            r.checkin.seated, r.checkin.total, r.checkin.rate
        ));
    } else {
        out.push_str("- 还没有队伍数据\n\n");
    }

    // 二、整体
    out.push_str("## 二、整体\n\n");
    if r.attempts == 0 {
        out.push_str("- 本节课没有作答数据\n\n");
    } else {
        out.push_str(&format!(
            "- 作答 **{} 题次**：答对 {}、部分正确 {}、答错 {}、跳过 {}\n",
            r.attempts, r.correct, r.half, r.wrong, r.skip
        ));
        out.push_str(&format!(
            "- 整体掌握度 **{}%**，累计得分 **{} 分**\n\n",
            r.credit_rate, r.earned
        ));
    }
    if !r.comment.is_empty() {
        out.push_str(&format!("> {}\n\n", r.comment));
    }

    // 三、各队对比
    if r.teams.len() > 1 {
        out.push_str("## 三、各队对比\n\n");
        out.push_str("| 队伍 | 答对 | 作答 | 掌握度 | 得分 | 人数 |\n| --- | --- | --- | --- | --- | --- |\n");
        for t in &r.teams {
            let score = match t.score {
                Some(s) => format!("{}", s),
                None => "—".to_string(),
            };
            out.push_str(&format!(
                "| {} | {} | {} | {}% | {} | {} |\n",
                t.name, t.correct, t.attempts, t.credit_rate.round() as i64, score, t.member_count
            ));
        }
        out.push('\n');
    }

    // 四、题型掌握
    let filled: Vec<&TierStat> = r.tiers.iter().filter(|t| t.attempts > 0).collect();
    if !filled.is_empty() {
        out.push_str("## 四、题型掌握\n\n");
        out.push_str("| 题型 | 作答 | 答对 | 掌握度 | 正确率 |\n| --- | --- | --- | --- | --- |\n");
        for t in filled {
            out.push_str(&format!(
                "| {} | {} | {} | {}% | {}% |\n",
                t.label, t.attempts, t.correct, t.credit_rate.round() as i64, t.correct_rate.round() as i64
            ));
        }
        out.push('\n');
    }

    // 五、题目正确率与讲评顺序
    let answered: Vec<&QuestionStat> = r.questions.iter().filter(|q| q.attempts > 0).collect();
    if !answered.is_empty() {
        out.push_str("## 五、题目正确率（讲评顺序）\n\n");
        out.push_str("| # | 题目 | 题型 | 作答 | 答对 | 正确率 | 未答对 |\n| --- | --- | --- | --- | --- | --- | --- |\n");
        for (i, q) in answered.iter().enumerate() {
            out.push_str(&format!(
                "| {} | {} | {} | {} | {} | {}% | {} |\n",
                i + 1,
                q.stem,
                q.tier_label,
                q.attempts,
                q.correct,
                q.correct_rate,
                q.wrong + q.skip
            ));
        }
        out.push('\n');
        if !r.review_line.is_empty() {
            out.push_str(&format!("> {}\n\n", r.review_line));
        }
    }

    // 六、学生表现
    let active: Vec<&ReportStudent> = r.students.iter().filter(|s| s.attempts > 0).collect();
    if !active.is_empty() {
        out.push_str("## 六、学生表现\n\n");
        out.push_str("| 名次 | 学生 | 队伍 | 积分 | 作答 | 答对 | 掌握度 |\n| --- | --- | --- | --- | --- | --- | --- |\n");
        for (i, s) in active.iter().enumerate() {
            out.push_str(&format!(
                "| {} | {} | {} | {} | {} | {} | {}% |\n",
                i + 1,
                s.name,
                if s.team_name.is_empty() { "—" } else { &s.team_name },
                s.score,
                s.attempts,
                s.correct,
                s.credit_rate
            ));
        }
        out.push('\n');

        // 表现突出 / 需要关注（各取前三，避免报告太长）
        let top: Vec<&ReportStudent> = active.iter().take(3).copied().collect();
        out.push_str(&format!(
            "- **表现突出**：{}\n",
            top.iter()
                .map(|s| format!("{}（{} 分，掌握度 {}%）", s.name, s.score, s.credit_rate))
                .collect::<Vec<_>>()
                .join("、")
        ));
        let mut weak: Vec<&ReportStudent> = active.iter().filter(|s| s.credit_rate < 60).copied().collect();
        weak.sort_by_key(|s| s.credit_rate);
        if weak.is_empty() {
            out.push_str("- **需要关注**：无（掌握度均不低于 60%）\n\n");
        } else {
            out.push_str(&format!(
                "- **需要关注**：{}\n\n",
                weak.iter()
                    .take(3)
                    .map(|s| format!("{}（掌握度 {}%）", s.name, s.credit_rate))
                    .collect::<Vec<_>>()
                    .join("、")
            ));
        }
    }

    out.push_str("---\n\n");
    out.push_str("*由课堂积分系统生成（Rust 核心 ci-domain::report）*\n");
    out
}

/// 时间显示：`YYYY-MM-DD HH:MM`（本地时区由调用方决定，这里按 UTC 偏移 8 小时处理课堂场景）
fn fmt_time(ms: i64) -> String {
    if ms <= 0 {
        return "—".to_string();
    }
    let total_secs = ms / 1000 + 8 * 3600; // 课堂场景固定东八区
    let days = total_secs / 86400;
    let secs = total_secs % 86400;
    let (y, m, d) = civil_from_days(days);
    format!(
        "{:04}-{:02}-{:02} {:02}:{:02}",
        y,
        m,
        d,
        secs / 3600,
        (secs % 3600) / 60
    )
}

/// 天数（1970-01-01 起）→ 年月日（Howard Hinnant 的 civil_from_days）
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::classroom::TeamStat;

    fn stu(id: &str, name: &str, team: &str) -> Student {
        Student { id: id.into(), name: name.into(), team_id: Some(team.into()), active: true, joined_at: 0, called: 0 }
    }

    fn team(id: &str, name: &str) -> Team {
        Team { id: id.into(), name: name.into(), icon: String::new(), color: String::new(), order: 0 }
    }

    fn rec(sid: &str, result: &str, points: f64, at: i64) -> ScoreRecord {
        ScoreRecord {
            id: format!("r{}", at),
            sid: Some(sid.into()),
            qid: Some("q1".into()),
            tier: "basic".into(),
            quiz_id: None,
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

    fn tier_stat(label: &str, attempts: u32, correct: u32, earned: f64) -> TierStat {
        let _ = earned;
        TierStat {
            key: "basic".into(),
            label: label.into(),
            color: "#66bb6a".into(),
            weight: 3.0,
            attempts,
            correct,
            credit_rate: if attempts > 0 { (correct as f64 / attempts as f64 * 100.0).round() } else { 0.0 },
            correct_rate: if attempts > 0 { (correct as f64 / attempts as f64 * 100.0).round() } else { 0.0 },
        }
    }

    fn team_row(id: &str, name: &str, correct: u32, attempts: u32, rate: f64, score: Option<f64>, members: usize) -> TeamStat {
        TeamStat {
            team_id: id.into(),
            name: name.into(),
            color: "#f00".into(),
            icon: "🔴".into(),
            correct,
            attempts,
            credit_rate: rate,
            score,
            member_count: members,
        }
    }

    fn sample() -> ClassReport {
        let students = vec![stu("s1", "甲", "tm1"), stu("s2", "乙", "tm1"), stu("s3", "丙", "tm2")];
        let teams = vec![team("tm1", "红队"), team("tm2", "蓝队")];
        let records = vec![
            rec("s1", "correct", 3.0, 1),
            rec("s1", "correct", 5.0, 2),
            rec("s2", "half", 2.5, 3),
            rec("s3", "wrong", 0.0, 4),
        ];
        build_report(
            "24机械高考公开课",
            "default",
            1_700_000_000_000,
            Checkin { seated: 2, total: 2, rate: 100 },
            &records,
            &students,
            &teams,
            vec![tier_stat("基础题", 4, 2, 10.5)],
            vec![
                team_row("all", "全班", 2, 4, 62.5, None, 3),
                team_row("tm1", "红队", 2, 3, 83.3, Some(10.5), 2),
                team_row("tm2", "蓝队", 0, 1, 0.0, Some(0.0), 1),
            ],
            vec![],
            "全班表现不错",
            "最需要讲评的是「求导」",
            0.5,
        )
    }

    #[test]
    fn totals_and_credit_rate() {
        let r = sample();
        assert_eq!(r.attempts, 4, "4 条有判定的流水");
        assert_eq!(r.correct, 2);
        assert_eq!(r.half, 1);
        assert_eq!(r.wrong, 1);
        assert_eq!(r.earned, 10.5, "3 + 5 + 2.5 + 0");
        assert_eq!(r.credit_rate, 63, "(2 + 1×0.5) / 4 = 62.5 → 63");
        assert_eq!(r.checkin.rate, 100);
    }

    #[test]
    fn students_sorted_by_score() {
        let r = sample();
        assert_eq!(r.students.len(), 3);
        assert_eq!(r.students[0].name, "甲", "8 分最高");
        assert_eq!(r.students[0].score, 8.0);
        assert_eq!(r.students[0].correct, 2);
        assert_eq!(r.students[0].credit_rate, 100);
        assert_eq!(r.students[0].team_name, "红队");
        assert_eq!(r.students[1].name, "乙");
        assert_eq!(r.students[1].credit_rate, 50, "半对 0.5 / 1 = 50%");
        assert_eq!(r.students[2].name, "丙");
        assert_eq!(r.students[2].credit_rate, 0);
    }

    #[test]
    fn markdown_has_all_sections() {
        let md = to_markdown(&sample());
        assert!(md.starts_with("# 课堂报告 · 24机械高考公开课"), "标题带课程名：{}", &md[..40]);
        assert!(md.contains("## 一、出勤"));
        assert!(md.contains("签到 **2 / 2 队**（100%）"));
        assert!(md.contains("## 二、整体"));
        assert!(md.contains("作答 **4 题次**"));
        assert!(md.contains("整体掌握度 **63%**"));
        assert!(md.contains("## 三、各队对比"));
        assert!(md.contains("| 红队 | 2 | 3 | 83% | 10.5 | 2 |"), "队伍行：{}", md);
        assert!(md.contains("## 四、题型掌握"));
        assert!(md.contains("| 基础题 | 4 | 2 | 50% | 50% |"), "题型行：{}", md);
        assert!(md.contains("## 六、学生表现"));
        assert!(md.contains("| 1 | 甲 | 红队 | 8 | 2 | 2 | 100% |"));
        assert!(md.contains("**表现突出**：甲（8 分，掌握度 100%）"));
        assert!(md.contains("**需要关注**：丙（掌握度 0%）"));
        assert!(md.ends_with("由课堂积分系统生成（Rust 核心 ci-domain::report）*\n"));
    }

    #[test]
    fn markdown_handles_empty_class() {
        let r = build_report(
            "", "default", 0, Checkin::default(), &[], &[], &[], vec![], vec![], vec![], "", "", 0.5,
        );
        let md = to_markdown(&r);
        assert!(md.contains("# 课堂报告 · 课堂积分"), "没课程名时用默认标题");
        assert!(md.contains("还没有队伍数据"));
        assert!(md.contains("本节课没有作答数据"));
        assert!(!md.contains("## 五、题目正确率"), "没有题目数据就不出这一节");
        assert!(!md.contains("## 六、学生表现"), "没有学生数据就不出这一节");
    }

    #[test]
    fn time_format_is_beijing() {
        // 2023-11-15 06:13:20 UTC → 北京 14:13
        assert_eq!(fmt_time(1_700_000_000_000), "2023-11-15 06:13");
        assert_eq!(fmt_time(0), "—");
    }
}
