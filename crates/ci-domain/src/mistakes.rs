//! mistakes.rs — **错题本**：按学生汇总答错/跳过的题（课后订正的依据）
//!
//! 为什么值得单独做：数据其实早就在流水里了（每条 `ScoreRecord` 有 sid/qid/result/note），
//! 但一直只按"题型"和"题目"聚合，没有按**人**聚合 —— 而"这个学生哪几道题不会"才是订正时看的。
//! 学习通等平台的"错题本"就是这个形态。
//!
//! 口径（与 JS `analysis.js::studentMistakes` 逐字段一致）：
//!   · 只收 `wrong` / `skip` 两种判定（半对不算错题 —— 它是"部分会"）
//!   · 同一道题错多次只占一条，`count` 记次数、`at` 取**最后一次**
//!   · `answer` 取最后一次提交的可读文本（流水 note，如「A. 甲」「跳过」）
//!   · `expected` 从题库取标准答案（题被删了就是「（题目已删除）」）
//!   · 排序：错误次数多的在前 → 时间新的在前 → qid（保证稳定）

use crate::grade::answer_key;
use crate::state::{BankQuestion, ScoreRecord, Student, Team};
use serde::{Deserialize, Serialize};

/// 一条错题
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MistakeItem {
    pub qid: String,
    pub stem: String,
    pub tier: String,
    pub tier_label: String,
    /// wrong / skip
    pub result: String,
    /// 学生最后一次提交的可读文本
    pub answer: String,
    /// 标准答案
    pub expected: String,
    /// 最后一次错的时间（不进 TS 绑定：界面走 CI.analysis 的 JS 实现）
    pub at: i64,
    /// 错了多少次
    pub count: u32,
}

/// 一个学生的错题本
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StudentMistakes {
    pub sid: String,
    pub name: String,
    pub team_name: String,
    pub items: Vec<MistakeItem>,
    /// 错题涉及的题型（去重，按首次出现顺序）—— 订正时可以按题型成组讲
    pub tiers: Vec<String>,
}

impl StudentMistakes {
    /// 错题总数（含重复错的次数）
    pub fn total(&self) -> u32 {
        self.items.iter().map(|i| i.count).sum()
    }
    /// 不同题目的道数
    pub fn distinct(&self) -> usize {
        self.items.len()
    }
}

fn short_stem(stem: &str) -> String {
    crate::question_stats::short_stem(stem)
}

/// 单个学生的错题本（没有错题时返回空 items，不返回 None —— 界面更好用）
pub fn student_mistakes(
    records: &[ScoreRecord],
    bank: &[BankQuestion],
    students: &[Student],
    teams: &[Team],
    tier_labels: &[(String, String)],
    sid: &str,
) -> StudentMistakes {
    let stu = students.iter().find(|s| s.id == sid);
    let name = stu.map(|s| s.name.clone()).unwrap_or_else(|| "（未知学生）".to_string());
    let team_name = stu
        .and_then(|s| s.team_id.as_ref())
        .and_then(|tid| teams.iter().find(|t| &t.id == tid))
        .map(|t| t.name.clone())
        .unwrap_or_default();

    // 按 qid 归集：保留最后一次提交与次数
    let mut order: Vec<String> = Vec::new();
    let mut map: std::collections::HashMap<String, MistakeItem> = std::collections::HashMap::new();

    for r in records {
        if r.sid.as_deref() != Some(sid) {
            continue;
        }
        if !matches!(r.result.as_str(), "wrong" | "skip") {
            continue;
        }
        let Some(qid) = r.qid.as_ref().filter(|q| !q.is_empty()) else {
            continue; // 手动/快捷加减不是错题
        };
        let q = bank.iter().find(|b| b.id == *qid);
        let tier = q.map(|x| x.tier.clone()).unwrap_or_default();
        let label = tier_labels
            .iter()
            .find(|(k, _)| k == &tier)
            .map(|(_, l)| l.clone())
            .unwrap_or_else(|| tier.clone());

        match map.get_mut(qid) {
            Some(item) => {
                item.count += 1;
                if r.at >= item.at {
                    item.at = r.at;
                    item.result = r.result.clone();
                    item.answer = r.note.clone();
                }
            }
            None => {
                order.push(qid.clone());
                map.insert(
                    qid.clone(),
                    MistakeItem {
                        qid: qid.clone(),
                        stem: q.map(|x| short_stem(&x.stem)).unwrap_or_else(|| "（题目已删除）".to_string()),
                        tier,
                        tier_label: label,
                        result: r.result.clone(),
                        answer: r.note.clone(),
                        expected: q.map(|x| answer_key(&x.to_grade_question())).unwrap_or_else(|| "—".to_string()),
                        at: r.at,
                        count: 1,
                    },
                );
            }
        }
    }

    let mut items: Vec<MistakeItem> = order.into_iter().filter_map(|q| map.remove(&q)).collect();
    items.sort_by(|a, b| {
        b.count
            .cmp(&a.count)
            .then(b.at.cmp(&a.at))
            .then(a.qid.cmp(&b.qid))
    });

    let mut tiers: Vec<String> = Vec::new();
    for it in &items {
        if !it.tier_label.is_empty() && !tiers.contains(&it.tier_label) {
            tiers.push(it.tier_label.clone());
        }
    }

    StudentMistakes {
        sid: sid.to_string(),
        name,
        team_name,
        items,
        tiers,
    }
}

/// 全班错题本：只保留**有错题**的学生，按错题次数降序
pub fn mistake_board(
    records: &[ScoreRecord],
    bank: &[BankQuestion],
    students: &[Student],
    teams: &[Team],
    tier_labels: &[(String, String)],
) -> Vec<StudentMistakes> {
    let mut out: Vec<StudentMistakes> = students
        .iter()
        .map(|s| student_mistakes(records, bank, students, teams, tier_labels, &s.id))
        .filter(|m| !m.items.is_empty())
        .collect();
    out.sort_by(|a, b| {
        b.total()
            .cmp(&a.total())
            .then(b.distinct().cmp(&a.distinct()))
            .then(a.name.cmp(&b.name))
    });
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stu(id: &str, name: &str, team: &str) -> Student {
        Student {
            id: id.into(),
            name: name.into(),
            team_id: Some(team.into()),
            active: true,
            joined_at: 0,
            called: 0,
        }
    }

    fn team(id: &str, name: &str) -> Team {
        Team { id: id.into(), name: name.into(), icon: String::new(), color: String::new(), order: 0 }
    }

    fn bank() -> Vec<BankQuestion> {
        vec![
            BankQuestion { id: "q1".into(), tier: "basic".into(), stem: "1+1=?".into(), answer: "A".into(), options: vec!["甲".into(), "乙".into()], ..Default::default() },
            BankQuestion { id: "q2".into(), tier: "advanced".into(), stem: "求导".into(), answer: "2x".into(), ..Default::default() },
        ]
    }

    fn labels() -> Vec<(String, String)> {
        vec![("basic".into(), "基础题".into()), ("advanced".into(), "拔高题".into())]
    }

    fn rec(sid: &str, qid: &str, result: &str, note: &str, at: i64) -> ScoreRecord {
        ScoreRecord {
            id: format!("r{}", at),
            sid: Some(sid.into()),
            qid: Some(qid.into()),
            tier: String::new(),
            quiz_id: None,
            result: result.into(),
            base: 0.0,
            ratio: 0.0,
            points: 0.0,
            source: "student".into(),
            note: note.into(),
            at,
            by: String::new(),
        }
    }

    #[test]
    fn collects_only_wrong_and_skip() {
        let students = vec![stu("s1", "甲", "tm1")];
        let records = vec![
            rec("s1", "q1", "correct", "A. 甲", 1),
            rec("s1", "q1", "half", "B. 乙", 2),   // 半对不算错题
            rec("s1", "q2", "wrong", "1x", 3),
            rec("s1", "q2", "skip", "跳过", 4),
        ];
        let m = student_mistakes(&records, &bank(), &students, &[team("tm1", "红队")], &labels(), "s1");
        assert_eq!(m.name, "甲");
        assert_eq!(m.team_name, "红队");
        assert_eq!(m.items.len(), 1, "只有 q2 算错题（半对不算）");
        let it = &m.items[0];
        assert_eq!(it.qid, "q2");
        assert_eq!(it.count, 2, "错了一次 + 跳过一次");
        assert_eq!(it.result, "skip", "最后一次是跳过");
        assert_eq!(it.answer, "跳过");
        assert_eq!(it.expected, "2x", "标准答案来自题库");
        assert_eq!(it.tier_label, "拔高题");
        assert_eq!(m.total(), 2);
        assert_eq!(m.distinct(), 1);
    }

    #[test]
    fn repeated_mistake_keeps_last_submission() {
        let students = vec![stu("s1", "甲", "tm1")];
        let records = vec![
            rec("s1", "q1", "wrong", "B. 乙", 1),
            rec("s1", "q1", "wrong", "C. 丙", 5), // 后错的一次
        ];
        let m = student_mistakes(&records, &bank(), &students, &[team("tm1", "红队")], &labels(), "s1");
        assert_eq!(m.items.len(), 1, "同一题只占一条");
        assert_eq!(m.items[0].count, 2);
        assert_eq!(m.items[0].answer, "C. 丙", "取最后一次提交");
        assert_eq!(m.items[0].at, 5);
    }

    #[test]
    fn sorts_by_count_then_time() {
        let students = vec![stu("s1", "甲", "tm1"), stu("s2", "乙", "tm1")];
        let records = vec![
            rec("s1", "q1", "wrong", "x", 1),
            rec("s1", "q2", "wrong", "x", 2),
            rec("s1", "q2", "wrong", "x", 3), // q2 错两次
            rec("s2", "q1", "skip", "跳过", 9),
        ];
        // 单人的错题顺序：次数多的在前
        let m = student_mistakes(&records, &bank(), &students, &[team("tm1", "红队")], &labels(), "s1");
        assert_eq!(m.items[0].qid, "q2", "错两次的排前面");
        assert_eq!(m.items[1].qid, "q1");
        assert_eq!(m.tiers, vec!["拔高题", "基础题"], "题型按首次出现顺序去重");
        // 全班榜：错题多的学生在前
        let board = mistake_board(&records, &bank(), &students, &[team("tm1", "红队")], &labels());
        assert_eq!(board.len(), 2, "两个学生都有错题");
        assert_eq!(board[0].sid, "s1", "甲错 3 次在前");
        assert_eq!(board[1].sid, "s2");
    }

    #[test]
    fn no_mistakes_yields_empty_items() {
        let students = vec![stu("s1", "甲", "tm1")];
        let records = vec![rec("s1", "q1", "correct", "A. 甲", 1)];
        let m = student_mistakes(&records, &bank(), &students, &[team("tm1", "红队")], &labels(), "s1");
        assert!(m.items.is_empty());
        assert_eq!(m.total(), 0);
        let board = mistake_board(&records, &bank(), &students, &[team("tm1", "红队")], &labels());
        assert!(board.is_empty(), "全对的学生不进错题榜");
    }

    #[test]
    fn deleted_question_still_listed() {
        let students = vec![stu("s1", "甲", "tm1")];
        let records = vec![rec("s1", "已删题", "wrong", "x", 1)];
        let m = student_mistakes(&records, &bank(), &students, &[team("tm1", "红队")], &labels(), "s1");
        assert_eq!(m.items.len(), 1, "题删了流水还在，错题本仍要列出");
        assert_eq!(m.items[0].stem, "（题目已删除）");
        assert_eq!(m.items[0].expected, "—");
    }

    #[test]
    fn ignores_manual_and_quick_records() {
        let students = vec![stu("s1", "甲", "tm1")];
        let mut manual = rec("s1", "q1", "wrong", "x", 1);
        manual.qid = None; // 手动加减没有题目归属
        let m = student_mistakes(&[manual], &bank(), &students, &[team("tm1", "红队")], &labels(), "s1");
        assert!(m.items.is_empty(), "没有题目归属的不算错题");
    }
}
