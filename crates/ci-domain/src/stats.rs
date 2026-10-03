//! stats.rs — 学情统计聚合
//!
//! **迁移来源**：`assets/js/analysis.js` 的 `studentStats` / `classStats` / `ranking` / `teamRanking`
//! 与它们的计数桶辅助（`blankBucket` / `addToBucket` / `finalizeBucket`）。
//! 这一层是"把所有流水按学生 / 题型 / 标签汇总成率"的纯计算，Vue 学情页、大屏、报告都建在它上面。
//!
//! **迁移时修掉的一个真 bug**：JS 版 `ranking(state, teamId, opts)` 收了 `opts` 却没传给
//! `studentStats`，于是「数据范围（本节课 / 全部课次）」只管得住汇总、管不住学生榜；
//! `classStats` 调 `ranking` 时也没传 —— 结果是汇总说"1 次作答"、同一份返回里的榜说"2 次"。
//! 这里两侧都按正确口径实现（JS 侧同步修好，见 `assets/js/analysis.js`）。
//!
//! 口径要点：
//!   · 只有"计入统计"的流水才进桶（`isCountable` + `quickCountsAsAttempt` 设置）
//!   · **掌握度 creditRate** 把"半对"按 `halfRatio` 折算（默认 0.5）—— 与得分口径一致
//!   · 薄弱/优势需要 **样本量 ≥ minSample**（默认 5）才判定，否则"只答 1 题全对"会被误判成优势
//!   · 全部按 `opts.quiz_id` 过滤：`None` = 全部课次，`Some(id)` = 只看这一套题

use serde::{Deserialize, Serialize};

use crate::ability::{ability_of_tiers, pct, Bucket, TierStat};
use crate::scoring::{is_countable, round2, tier_of};
use crate::state::{ClassroomState, ScoreRecord};

/// 计数桶 + 各种率（JS 的 finalizeBucket 结果）
#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FinalBucket {
    pub attempts: u32,
    pub correct: u32,
    pub half: u32,
    pub wrong: u32,
    pub skip: u32,
    pub earned: f64,
    pub base: f64,
    /// 正确率（百分比，一位小数）
    pub correct_rate: f64,
    /// 掌握度（百分比，半对按 halfRatio 折算）
    pub credit_rate: f64,
    /// 得分率（实际得分 / 基准分）
    pub earn_rate: f64,
}

/// 某个题型的统计（学生维度）
#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StudentTierRow {
    pub key: String,
    pub label: String,
    #[serde(default)]
    pub color: String,
    #[serde(default)]
    pub weight: f64,
    #[serde(flatten)]
    pub bucket: FinalBucket,
}

/// 某个标签的统计
#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagRow {
    pub tag: String,
    #[serde(flatten)]
    pub bucket: FinalBucket,
}

/// 单个学生的学情
#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StudentStats {
    pub sid: String,
    pub name: String,
    pub team_id: Option<String>,
    pub team_name: String,
    pub score: f64,
    pub total: FinalBucket,
    pub tiers: Vec<StudentTierRow>,
    pub tags: Vec<TagRow>,
    /// 被点名次数
    pub rolls: u32,
    /// 最后一次作答时间（0 = 没作答过）
    pub last_at: i64,
    /// 薄弱题型 key（按掌握度升序）
    pub weak: Vec<String>,
    /// 优势题型 key
    pub strong: Vec<String>,
    /// 综合评定等级（与雷达/大屏同一套等级）
    pub level: String,
}

/// 学生榜的一行
#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RankRow {
    pub sid: String,
    pub name: String,
    pub team_id: Option<String>,
    pub team_name: String,
    pub score: f64,
    pub attempts: u32,
    pub correct: u32,
    pub credit_rate: f64,
    pub correct_rate: f64,
    pub rolls: u32,
    pub weak_count: u32,
    pub level: String,
    pub rank: u32,
}

/// 队伍榜的一行
#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamRankRow {
    pub team_id: String,
    pub name: String,
    #[serde(default)]
    pub icon: String,
    #[serde(default)]
    pub color: String,
    /// 队伍分 = 成员分之和
    pub score: f64,
    pub member_count: u32,
    /// 人均分（一位小数）
    pub avg: f64,
    pub credit_rate: f64,
    pub attempts: u32,
    pub weak_tiers: Vec<String>,
}

/// 全班（或某队伍）统计
#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClassStats {
    pub team_id: String,
    pub student_count: u32,
    pub active_count: u32,
    /// 有作答记录的人数
    pub participants: u32,
    pub total: FinalBucket,
    pub tiers: Vec<TierStat>,
    /// 薄弱题型 key（按掌握度升序）
    pub weak_tiers: Vec<String>,
    pub ranking: Vec<RankRow>,
    /// 需要关注的人（有薄弱题型，或样本够但掌握度低）
    pub need_help: Vec<RankRow>,
}

/* ============================ 内部辅助 ============================ */

/// 这条流水是否计入统计（JS 的 counts(s, r)）
fn counts(s: &ClassroomState, r: &ScoreRecord) -> bool {
    if !is_countable(&r.tier, &r.result) {
        return false;
    }
    // 快捷记分默认计入；只有显式关掉时才排除
    if r.source == "quick" && s.settings.quick_counts_as_attempt == Some(false) {
        return false;
    }
    true
}

/// 按学生 + 可选课次取出计入统计的流水（保持时间顺序）
fn counted_records<'a>(s: &'a ClassroomState, sid: &str, quiz_id: Option<&str>) -> Vec<&'a ScoreRecord> {
    let mut recs: Vec<&ScoreRecord> = s
        .records_of(sid)
        .into_iter()
        .filter(|r| counts(s, r))
        .filter(|r| match quiz_id {
            None => true,
            Some(id) => r.quiz_id.as_deref() == Some(id),
        })
        .collect();
    recs.sort_by_key(|r| r.at);
    recs
}

/// 把原始桶收尾成带各种率的形态（JS 的 finalizeBucket）
fn finalize(s: &ClassroomState, b: &Bucket) -> FinalBucket {
    let half_ratio = s.settings.half_ratio;
    let credit = b.correct as f64 + b.half as f64 * half_ratio;
    FinalBucket {
        attempts: b.attempts,
        correct: b.correct,
        half: b.half,
        wrong: b.wrong,
        skip: b.skip,
        earned: round2(b.earned),
        base: round2(b.base),
        correct_rate: pct(b.correct as f64, b.attempts),
        credit_rate: pct(credit, b.attempts),
        earn_rate: pct(b.earned, b.base as u32),
    }
}

/// 题型在题型表里的顺序（不在表里排最后）—— 与 JS 的 tierOrder 一致
fn tier_order(s: &ClassroomState, key: &str) -> usize {
    s.tiers.iter().position(|t| t.key == key).unwrap_or(999)
}

/// 取某题型的掌握度（找不到给 0）
fn rate_of(tiers: &[StudentTierRow], key: &str) -> f64 {
    tiers.iter().find(|t| t.key == key).map(|t| t.bucket.credit_rate).unwrap_or(0.0)
}

/// 有效学生（停用的不算）—— 与 JS 的 activeStudentsOf 一致
fn active_students<'a>(s: &'a ClassroomState, team_id: Option<&str>) -> Vec<&'a crate::state::Student> {
    s.students
        .iter()
        .filter(|x| x.active)
        .filter(|x| match team_id {
            None => true,
            Some(t) => x.team_id.as_deref() == Some(t),
        })
        .collect()
}

/* ============================ 对外接口 ============================ */

/// 单个学生的学情统计（`quiz_id = None` 表示全部课次）
pub fn student_stats(s: &ClassroomState, sid: &str, quiz_id: Option<&str>) -> Option<StudentStats> {
    let stu = s.student(sid)?;
    let team_name = stu
        .team_id
        .as_deref()
        .and_then(|t| s.teams.iter().find(|x| x.id == t))
        .map(|t| t.name.clone())
        .unwrap_or_else(|| "未分组".to_string());

    let recs = counted_records(s, sid, quiz_id);

    // 题型桶：先把题型表里都建好（没考到的题型显示 0，而不是消失）
    let mut tier_keys: Vec<(String, String, String, f64)> = s
        .tiers
        .iter()
        .map(|t| (t.key.clone(), t.label.clone(), t.color.clone(), t.weight))
        .collect();
    let mut tier_buckets: Vec<Bucket> = vec![Bucket::default(); tier_keys.len()];
    let mut tag_names: Vec<String> = Vec::new();
    let mut tag_buckets: Vec<Bucket> = Vec::new();
    let mut total = Bucket::default();

    for r in &recs {
        total.add(&r.result, r.points, r.base);

        // 题型（流水里的 tier 是计分时的快照；不在表里就补一条）
        let idx = match tier_keys.iter().position(|(k, ..)| k == &r.tier) {
            Some(i) => i,
            None => {
                let t = tier_of(&s.tiers, &r.tier).cloned().unwrap_or(crate::scoring::Tier {
                    key: r.tier.clone(),
                    label: r.tier.clone(),
                    weight: 3.0,
                    color: String::new(),
                    desc: String::new(),
                });
                tier_keys.push((t.key.clone(), t.label.clone(), t.color.clone(), t.weight));
                tier_buckets.push(Bucket::default());
                tier_keys.len() - 1
            }
        };
        tier_buckets[idx].add(&r.result, r.points, r.base);

        // 标签（题目没打标签算「未标注」）
        let q = r.qid.as_deref().and_then(|id| s.question(id));
        let tags: Vec<String> = match q {
            Some(q) if !q.tags.is_empty() => q.tags.clone(),
            _ => vec!["未标注".to_string()],
        };
        for tag in tags {
            let i = match tag_names.iter().position(|x| x == &tag) {
                Some(i) => i,
                None => {
                    tag_names.push(tag.clone());
                    tag_buckets.push(Bucket::default());
                    tag_names.len() - 1
                }
            };
            tag_buckets[i].add(&r.result, r.points, r.base);
        }
    }

    let mut tiers: Vec<StudentTierRow> = tier_keys
        .iter()
        .zip(tier_buckets.iter())
        .map(|((key, label, color, weight), b)| StudentTierRow {
            key: key.clone(),
            label: label.clone(),
            color: color.clone(),
            weight: *weight,
            bucket: finalize(s, b),
        })
        .collect();
    tiers.sort_by_key(|t| tier_order(s, &t.key));

    let mut tags: Vec<TagRow> = tag_names
        .iter()
        .zip(tag_buckets.iter())
        .map(|(tag, b)| TagRow { tag: tag.clone(), bucket: finalize(s, b) })
        .collect();
    // 作答多的排前面（同数量按标签名，保证可复现）
    tags.sort_by(|a, b| {
        b.bucket
            .attempts
            .cmp(&a.bucket.attempts)
            .then_with(|| a.tag.cmp(&b.tag))
    });

    let min_sample = s.settings.min_sample.max(0) as u32;
    let weak_at = s.settings.weak_threshold * 100.0;
    let strong_at = s.settings.strong_threshold * 100.0;

    let mut weak: Vec<String> = Vec::new();
    let mut strong: Vec<String> = Vec::new();
    for t in &tiers {
        if t.bucket.attempts >= min_sample {
            if t.bucket.credit_rate < weak_at {
                weak.push(t.key.clone());
            } else if t.bucket.credit_rate >= strong_at {
                strong.push(t.key.clone());
            }
        }
    }
    weak.sort_by(|a, b| rate_of(&tiers, a).partial_cmp(&rate_of(&tiers, b)).unwrap_or(std::cmp::Ordering::Equal));

    let total_final = finalize(s, &total);
    let ability = ability_of_tiers(
        &tiers
            .iter()
            .map(|t| TierStat {
                key: t.key.clone(),
                label: t.label.clone(),
                color: t.color.clone(),
                weight: t.weight,
                attempts: t.bucket.attempts,
                correct: t.bucket.correct,
                credit_rate: t.bucket.credit_rate,
                correct_rate: t.bucket.correct_rate,
            })
            .collect::<Vec<_>>(),
        total_final.attempts,
        min_sample,
    );

    let all = s.records_of(sid);
    let last_at = all.last().map(|r| r.at).unwrap_or(0);

    Some(StudentStats {
        sid: stu.id.clone(),
        name: stu.name.clone(),
        team_id: stu.team_id.clone(),
        team_name,
        score: s.score_of(sid),
        total: total_final,
        tiers,
        tags,
        rolls: crate::rollcall::called_count(&s.rollcall.history, sid),
        last_at,
        weak,
        strong,
        // JS 的 level 是等级字母（S/A/A-/…），对应 Rust 的 Grade.short
        level: ability.grade.short.to_string(),
    })
}

/// 学生榜（按积分 → 掌握度 → 姓名排序；`quiz_id` 会一路传到最底层）
pub fn ranking(s: &ClassroomState, team_id: Option<&str>, quiz_id: Option<&str>) -> Vec<RankRow> {
    let mut list: Vec<RankRow> = active_students(s, team_id)
        .into_iter()
        .filter_map(|stu| {
            let st = student_stats(s, &stu.id, quiz_id)?;
            Some(RankRow {
                sid: st.sid.clone(),
                name: st.name.clone(),
                team_id: st.team_id.clone(),
                team_name: st.team_name.clone(),
                score: st.score,
                attempts: st.total.attempts,
                correct: st.total.correct,
                credit_rate: st.total.credit_rate,
                correct_rate: st.total.correct_rate,
                rolls: st.rolls,
                weak_count: st.weak.len() as u32,
                level: st.level.clone(),
                rank: 0,
            })
        })
        .collect();

    // 同分比掌握度，再同则按姓名（中文按 Unicode 码位 —— 与 JS 的 localeCompare 可能有差异，
    // 但**同分同名**在实际数据里几乎不出现，且 parity 用固定数据可复现）
    list.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| b.credit_rate.partial_cmp(&a.credit_rate).unwrap_or(std::cmp::Ordering::Equal))
            .then_with(|| a.name.cmp(&b.name))
    });
    for (i, r) in list.iter_mut().enumerate() {
        r.rank = i as u32 + 1;
    }
    list
}

/// 全班（或某队伍）统计
pub fn class_stats(s: &ClassroomState, team_id: Option<&str>, quiz_id: Option<&str>) -> ClassStats {
    let list = active_students(s, team_id);
    let mut total = Bucket::default();
    let mut tier_keys: Vec<(String, String, String, f64)> = s
        .tiers
        .iter()
        .map(|t| (t.key.clone(), t.label.clone(), t.color.clone(), t.weight))
        .collect();
    let mut tier_buckets: Vec<Bucket> = vec![Bucket::default(); tier_keys.len()];

    for stu in &list {
        if let Some(st) = student_stats(s, &stu.id, quiz_id) {
            total.attempts += st.total.attempts;
            total.correct += st.total.correct;
            total.half += st.total.half;
            total.wrong += st.total.wrong;
            total.skip += st.total.skip;
            total.earned += st.total.earned;
            total.base += st.total.base;
            for t in &st.tiers {
                let i = match tier_keys.iter().position(|(k, ..)| k == &t.key) {
                    Some(i) => i,
                    None => {
                        tier_keys.push((t.key.clone(), t.label.clone(), t.color.clone(), t.weight));
                        tier_buckets.push(Bucket::default());
                        tier_keys.len() - 1
                    }
                };
                tier_buckets[i].attempts += t.bucket.attempts;
                tier_buckets[i].correct += t.bucket.correct;
                tier_buckets[i].half += t.bucket.half;
                tier_buckets[i].wrong += t.bucket.wrong;
                tier_buckets[i].skip += t.bucket.skip;
                tier_buckets[i].earned += t.bucket.earned;
                tier_buckets[i].base += t.bucket.base;
            }
        }
    }

    let mut tiers: Vec<TierStat> = tier_keys
        .iter()
        .zip(tier_buckets.iter())
        .map(|((key, label, color, weight), b)| {
            let f = finalize(s, b);
            TierStat {
                key: key.clone(),
                label: label.clone(),
                color: color.clone(),
                weight: *weight,
                attempts: f.attempts,
                correct: f.correct,
                credit_rate: f.credit_rate,
                correct_rate: f.correct_rate,
            }
        })
        .collect();
    tiers.sort_by_key(|t| tier_order(s, &t.key));

    let min_sample = s.settings.min_sample.max(0) as u32;
    let weak_at = s.settings.weak_threshold * 100.0;

    // 注意：这里必须把 quiz_id 传给 ranking —— JS 版漏传过，导致"汇总 1 次、榜上 2 次"
    let ranked = ranking(s, team_id, quiz_id);
    let mut weak_tiers: Vec<String> = tiers
        .iter()
        .filter(|t| t.attempts >= min_sample && t.credit_rate < weak_at)
        .map(|t| t.key.clone())
        .collect();
    weak_tiers.sort_by(|a, b| {
        let ra = tiers.iter().find(|t| &t.key == a).map(|t| t.credit_rate).unwrap_or(0.0);
        let rb = tiers.iter().find(|t| &t.key == b).map(|t| t.credit_rate).unwrap_or(0.0);
        ra.partial_cmp(&rb).unwrap_or(std::cmp::Ordering::Equal)
    });

    let need_help: Vec<RankRow> = ranked
        .iter()
        .filter(|r| r.weak_count > 0 || (r.attempts >= min_sample && r.credit_rate < weak_at))
        .cloned()
        .collect();

    ClassStats {
        team_id: team_id.unwrap_or("all").to_string(),
        student_count: list.len() as u32,
        active_count: list.iter().filter(|x| x.active).count() as u32,
        participants: ranked.iter().filter(|r| r.attempts > 0).count() as u32,
        total: finalize(s, &total),
        tiers,
        weak_tiers,
        ranking: ranked,
        need_help,
    }
}

/// 队伍榜（队伍分 = 成员分之和）
pub fn team_ranking(s: &ClassroomState) -> Vec<TeamRankRow> {
    let mut list: Vec<TeamRankRow> = s
        .teams
        .iter()
        .map(|t| {
            let members = active_students(s, Some(&t.id));
            let cs = class_stats(s, Some(&t.id), None);
            // 队伍分 = 成员分之和（与 JS 的 teamScore 一致）
            let score = crate::scoring::round2(
                members.iter().map(|m| s.score_of(&m.id)).sum::<f64>(),
            );
            TeamRankRow {
                team_id: t.id.clone(),
                name: t.name.clone(),
                icon: t.icon.clone(),
                color: t.color.clone(),
                score,
                member_count: members.len() as u32,
                avg: if members.is_empty() {
                    0.0
                } else {
                    (score / members.len() as f64 * 10.0).round() / 10.0
                },
                credit_rate: cs.total.credit_rate,
                attempts: cs.total.attempts,
                weak_tiers: cs.weak_tiers,
            }
        })
        .collect();
    // 分高的在前（同分按名字，保证可复现）
    list.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.name.cmp(&b.name))
    });
    list
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{BankQuestion, Quiz, ScoreRecord, Student, Team};

    fn rec(sid: &str, qid: &str, tier: &str, result: &str, points: f64, quiz: &str, at: i64) -> ScoreRecord {
        ScoreRecord {
            id: format!("r{}", at),
            sid: Some(sid.into()),
            qid: Some(qid.into()),
            tier: tier.into(),
            quiz_id: Some(quiz.into()),
            result: result.into(),
            base: 3.0,
            ratio: 1.0,
            points,
            source: "quiz".into(),
            note: String::new(),
            picked: String::new(),
            at,
            by: String::new(),
        }
    }

    fn state_with_two_quizzes() -> ClassroomState {
        let mut s = ClassroomState::default();
        s.teams = vec![Team {
            id: "t1".into(),
            name: "红队".into(),
            icon: String::new(),
            color: String::new(),
            order: 1,
        }];
        s.students = vec![
            Student { id: "s1".into(), name: "甲".into(), team_id: Some("t1".into()), active: true, joined_at: 1, called: 0 },
            Student { id: "s2".into(), name: "乙".into(), team_id: Some("t1".into()), active: true, joined_at: 2, called: 0 },
        ];
        s.bank = vec![
            BankQuestion { id: "q1".into(), tier: "basic".into(), stem: "第一节".into(), answer: "A".into(), ..Default::default() },
            BankQuestion { id: "q2".into(), tier: "basic".into(), stem: "第二节".into(), answer: "A".into(), ..Default::default() },
        ];
        s.quizzes = vec![
            Quiz {
                id: "z1".into(), name: "第一节".into(), question_ids: vec!["q1".into()], created_at: 1, closed_at: 0,
                note: String::new(),
                records: vec![
                    rec("s1", "q1", "basic", "wrong", 0.0, "z1", 1),
                    rec("s2", "q1", "basic", "correct", 3.0, "z1", 2),
                ],
            },
            Quiz {
                id: "z2".into(), name: "第二节".into(), question_ids: vec!["q2".into()], created_at: 2, closed_at: 0,
                note: String::new(),
                records: vec![rec("s1", "q2", "basic", "correct", 3.0, "z2", 3)],
            },
        ];
        s
    }

    #[test]
    fn scope_must_reach_the_ranking() {
        // 这条用例是为了钉住一个真 bug：JS 版 ranking 收了 opts 却不往下传，
        // 于是"只看本节课"只管得住汇总、管不住学生榜。
        let s = state_with_two_quizzes();
        let all = ranking(&s, None, None);
        let z1 = ranking(&s, None, Some("z1"));
        let z2 = ranking(&s, None, Some("z2"));

        let a1 = all.iter().find(|r| r.sid == "s1").unwrap();
        assert_eq!(a1.attempts, 2, "全部课次：甲作答 2 次");
        assert_eq!(a1.credit_rate, 50.0, "全部课次：甲 1 对 1 错 → 50%");

        let b1 = z1.iter().find(|r| r.sid == "s1").unwrap();
        assert_eq!(b1.attempts, 1, "只看第一节：甲作答 1 次");
        assert_eq!(b1.credit_rate, 0.0, "只看第一节：甲 0%");
        let b2 = z1.iter().find(|r| r.sid == "s2").unwrap();
        assert_eq!(b2.credit_rate, 100.0, "只看第一节：乙 100%");

        let c1 = z2.iter().find(|r| r.sid == "s1").unwrap();
        assert_eq!(c1.attempts, 1, "只看第二节：甲作答 1 次");
        assert_eq!(c1.credit_rate, 100.0, "只看第二节：甲 100%");
        // 没答过第二节的乙：样本 0
        let c2 = z2.iter().find(|r| r.sid == "s2").unwrap();
        assert_eq!(c2.attempts, 0, "只看第二节：乙没作答");
    }

    #[test]
    fn class_stats_summary_and_ranking_agree() {
        let s = state_with_two_quizzes();
        let cs = class_stats(&s, None, Some("z1"));
        assert_eq!(cs.student_count, 2);
        assert_eq!(cs.participants, 2);
        assert_eq!(cs.total.attempts, 2, "汇总：2 次作答");
        let sum: u32 = cs.ranking.iter().map(|r| r.attempts).sum();
        assert_eq!(sum, cs.total.attempts, "榜单里的作答数与汇总必须一致（曾经一个 1、一个 2）");
    }

    #[test]
    fn student_stats_buckets_and_rates() {
        let s = state_with_two_quizzes();
        let st = student_stats(&s, "s1", None).unwrap();
        assert_eq!(st.name, "甲");
        assert_eq!(st.team_name, "红队");
        assert_eq!(st.total.attempts, 2);
        assert_eq!(st.total.correct, 1);
        assert_eq!(st.total.wrong, 1);
        assert_eq!(st.total.credit_rate, 50.0);
        assert_eq!(st.score, 3.0, "得分 = 流水积分之和");
        assert_eq!(st.last_at, 3, "最后一次作答时间");
        // 题型桶：题型表里的题型都在（哪怕没考到）
        assert_eq!(st.tiers.len(), s.tiers.len().max(1), "题型表里的题型都建了桶");
        // 标签：题目没打标签算「未标注」
        assert!(st.tags.iter().any(|t| t.tag == "未标注"));
        // 样本不足（min_sample=5）时不判薄弱/优势
        assert!(st.weak.is_empty(), "只答 1 题不该判薄弱");
        assert!(st.strong.is_empty(), "只答 1 题不该判优势");
        assert_eq!(st.level, "—", "样本不足时等级是「—」");
    }

    #[test]
    fn half_counts_by_half_ratio() {
        let mut s = state_with_two_quizzes();
        // 把甲的"错"改成"半对"，掌握度应按 halfRatio(0.5) 折算
        s.quizzes[0].records[0].result = "half".into();
        s.quizzes[0].records[0].points = 1.5;
        let st = student_stats(&s, "s1", None).unwrap();
        assert_eq!(st.total.half, 1);
        // 该生是「1 次答对 + 1 次半对」：credit = 1 + 0.5 = 1.5，1.5 / 2 次 = 75%
        assert_eq!(st.total.credit_rate, 75.0, "1 对 + 1 半对(0.5) / 2 次 = 75%");
        // 改 halfRatio 后口径跟着变
        s.settings.half_ratio = 1.0;
        let st2 = student_stats(&s, "s1", None).unwrap();
        assert_eq!(st2.total.credit_rate, 100.0, "halfRatio=1 时半对算全对：(1+1)/2 = 100%");
    }

    #[test]
    fn inactive_students_are_excluded() {
        let mut s = state_with_two_quizzes();
        s.students[0].active = false;
        let cs = class_stats(&s, None, None);
        assert_eq!(cs.student_count, 1, "停用学生不进班级统计");
        assert!(ranking(&s, None, None).iter().all(|r| r.sid != "s1"));
    }

    #[test]
    fn team_ranking_sums_members() {
        let s = state_with_two_quizzes();
        let tr = team_ranking(&s);
        assert_eq!(tr.len(), 1);
        assert_eq!(tr[0].score, 6.0, "队伍分 = 成员分之和（3 + 3）");
        assert_eq!(tr[0].member_count, 2);
        assert_eq!(tr[0].avg, 3.0, "人均 3 分");
        assert_eq!(tr[0].attempts, 3, "全队共 3 次作答");
    }
    #[test]
    fn ability_board_covers_class_students_and_teams() {
        let s = state_with_two_quizzes();
        let board = ability_board(&s, None);
        assert_eq!(board.class.kind, "class");
        assert_eq!(board.class.id, "all");
        assert_eq!(board.class.member_count, 2, "全班 2 人");
        assert_eq!(board.students.len(), 2, "每人一条");
        assert_eq!(board.teams.len(), 1, "每队一条");
        assert_eq!(board.students[0].kind, "student");
        assert_eq!(board.students[0].team_name, "红队", "学生条目带队伍名");
        assert_eq!(board.teams[0].kind, "team");
        assert_eq!(board.teams[0].name, "红队");
        assert_eq!(board.teams[0].score, 6.0, "队伍分 = 成员分之和");
        assert!(board.students.iter().all(|x| x.axes.len() == s.tiers.len()), "每人都有全部题型的轴");
        assert_eq!(board.class.grade.short, "—", "样本不足时评级是「—」");
        // 数据范围也要贯穿到评价榜（JS 版这里同样漏传过 quizId）
        assert_eq!(ability_board(&s, Some("z1")).class.attempts, 2, "只看第一节：2 次作答");
        assert_eq!(ability_board(&s, Some("z2")).class.attempts, 1, "只看第二节：1 次作答（范围生效）");
    }
}

/* ============================ 能力评价榜 ============================ */

/// 一条能力画像（对应 JS 的 ability(state, opts) 结果 + kind/id/name 等附加字段）
///
/// **顺带修掉一个与 JS 同源的口径问题**：JS 的 `ability(state, {sid})` 调
/// `studentStats(s, opts.sid)` 时同样没传 quizId，所以评价榜一直覆盖"全部课次"，
/// 与页面上「数据范围」选择器不一致。这里把 quiz_id 一路传下去。
#[cfg_attr(feature = "bindings", derive(specta::Type))]
// 只派生 Serialize：`Grade` 里是 &'static str，无法反序列化（端点只往外发，不往里读）
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AbilityEntry {
    /// class | student | team
    pub kind: String,
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub team_name: String,
    #[serde(default)]
    pub score: f64,
    #[serde(default)]
    pub rolls: u32,
    #[serde(default)]
    pub member_count: u32,
    /// 以下与 `ability::Ability` 同形（不 flatten：specta 对 flatten 支持有限）
    pub axes: Vec<crate::ability::Axis>,
    pub overall: i64,
    pub mastery: i64,
    pub balance: Option<i64>,
    pub coverage: i64,
    pub attempts: u32,
    pub grade: crate::ability::Grade,
    #[serde(default)]
    pub comment: String,
}

/// 能力评价榜：全班 + 每个学生 + 每支队伍（供雷达切换与综合评价表）
pub fn ability_board(s: &ClassroomState, quiz_id: Option<&str>) -> AbilityBoard {
    let min_sample = s.settings.min_sample.max(0) as u32;

    // 用普通函数而不是闭包：闭包在这里会被推断出过严的生命周期
    fn entry_of(
        kind: &str,
        id: &str,
        name: &str,
        tiers: &[TierStat],
        total_attempts: u32,
        min_sample: u32,
        extra: (f64, u32, u32, String),
    ) -> AbilityEntry {
        let a = ability_of_tiers(tiers, total_attempts, min_sample);
        AbilityEntry {
            kind: kind.to_string(),
            id: id.to_string(),
            name: name.to_string(),
            team_name: extra.3,
            score: extra.0,
            rolls: extra.1,
            member_count: extra.2,
            axes: a.axes,
            overall: a.overall,
            mastery: a.mastery,
            balance: a.balance,
            coverage: a.coverage,
            attempts: a.attempts,
            comment: a.comment,
            grade: a.grade,
        }
    }

    // 全班
    let cs = class_stats(s, None, quiz_id);
    let class = entry_of("class", "all", "全班", &cs.tiers, cs.total.attempts, min_sample, (0.0, 0, cs.student_count, String::new()));

    // 每个学生（按榜单顺序）
    let students: Vec<AbilityEntry> = ranking(s, None, quiz_id)
        .iter()
        .filter_map(|r| {
            let st = student_stats(s, &r.sid, quiz_id)?;
            let tier_stats: Vec<TierStat> = st
                    .tiers
                    .iter()
                    .map(|t| TierStat {
                        key: t.key.clone(),
                        label: t.label.clone(),
                        color: t.color.clone(),
                        weight: t.weight,
                        attempts: t.bucket.attempts,
                        correct: t.bucket.correct,
                        credit_rate: t.bucket.credit_rate,
                        correct_rate: t.bucket.correct_rate,
                    })
                    .collect();
            Some(entry_of(
                "student",
                &st.sid,
                &st.name,
                &tier_stats,
                st.total.attempts,
                min_sample,
                (st.score, st.rolls, 0, st.team_name.clone()),
            ))
        })
        .collect();

    // 每支队伍
    let teams: Vec<AbilityEntry> = s
        .teams
        .iter()
        .map(|t| {
            let ts = class_stats(s, Some(&t.id), quiz_id);
            let score = round2(
                s.students
                    .iter()
                    .filter(|x| x.active && x.team_id.as_deref() == Some(t.id.as_str()))
                    .map(|x| s.score_of(&x.id))
                    .sum::<f64>(),
            );
            entry_of("team", &t.id, &t.name, &ts.tiers, ts.total.attempts, min_sample, (score, 0, ts.student_count, String::new()))
        })
        .collect();

    AbilityBoard { class, students, teams }
}

/// 能力评价榜
#[cfg_attr(feature = "bindings", derive(specta::Type))]
// 与 AbilityEntry 同理：只往外发
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AbilityBoard {
    pub class: AbilityEntry,
    pub students: Vec<AbilityEntry>,
    pub teams: Vec<AbilityEntry>,

}
