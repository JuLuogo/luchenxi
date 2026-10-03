//! rollcall.rs — 随机点名（候选人筛选 + 三种抽选模式 + 轮次池/防连点）
//!
//! **迁移来源**：`assets/js/rollcall.js` 的 `candidates` / `pick` / `applyPick`。
//! 迁移期两边并行：本文件单测对应 `tests/logic.test.js` 第 7 组「点名系统」，
//! 另外由 `tests/fixtures/parity.json` 的 rollcall 段做逐字段一致性比对
//! （抽选用固定随机序列喂给两边，结果必须完全一样）。
//!
//! 为什么把随机数做成可注入：抽选必须可复现才能测。真实使用时传入
//! [`XorShift64`]（无第三方依赖），测试与基准比对时传入"按脚本出数"的闭包。
//!
//! 三种模式：
//!   · `even`（默认）—— 轮次池内不放回，一轮点完自动开新一轮
//!   · `least`       —— 优先点被点次数最少的人
//!   · `random`      —— 纯随机
//!
//! 约束：
//!   · `exclude_answered` —— 排除"当前题已作答"的学生（由调用方查好作答名单）
//!   · `recent_exclude`   —— 不点最近 N 次被点到的人；**若排除后无人可选则放弃该约束**

use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

/// 候选学生（`called` = 被点次数，由调用方从流水里数好）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Student {
    pub id: String,
    pub name: String,
    #[serde(default = "default_true")]
    pub active: bool,
    pub called: u32,
}

fn default_true() -> bool {
    true
}

/// 点名历史的一条（只需要 sid）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RollEntry {
    pub sid: String,
    pub at: i64,
}

/// 点名设置与轮次状态（对应 state.rollcall）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RollcallSettings {
    #[serde(default = "default_mode")]
    pub mode: String,
    #[serde(default = "default_scope")]
    pub scope: String,
    pub exclude_answered: bool,
    #[serde(default)]
    pub recent_exclude: u32,
    #[serde(default = "default_round")]
    pub round: u32,
    pub round_pool: Vec<String>,
    #[serde(default)]
    pub history: Vec<RollEntry>,
}

fn default_mode() -> String {
    "even".to_string()
}
fn default_scope() -> String {
    "all".to_string()
}
fn default_round() -> u32 {
    1
}

impl Default for RollcallSettings {
    fn default() -> Self {
        RollcallSettings {
            mode: default_mode(),
            scope: default_scope(),
            exclude_answered: false,
            recent_exclude: 0,
            round: 1,
            round_pool: Vec::new(),
            history: Vec::new(),
        }
    }
}

/// 本次抽选的覆盖参数（对应 JS 的 opts；None 表示沿用设置）
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PickOpts {
    #[serde(default)]
    pub scope: Option<String>,
    pub mode: Option<String>,
    #[serde(default)]
    pub exclude_answered: Option<bool>,
    pub recent_exclude: Option<u32>,
    /// 是否真的有"当前题"（对应 JS 里 quizId && qid 都存在）
    #[serde(default)]
    pub has_current_question: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Pick {
    pub sid: String,
    pub name: String,
    pub mode: String,
    pub note: String,
    #[serde(rename = "candidateCount")]
    pub candidate_count: usize,
    #[serde(rename = "newRound")]
    pub new_round: bool,
    /// 本轮剩余候选（不放回）；`random` 模式为 None
    pub pool: Option<Vec<String>>,
    /// 开启新一轮时的轮次号
    pub round: Option<u32>,
}

/// 最近 N 次被点到的人（对应 JS 的 recentIds）
pub fn recent_ids(history: &[RollEntry], n: u32) -> Vec<String> {
    let n = n as usize;
    if n == 0 || history.is_empty() {
        return Vec::new();
    }
    let start = history.len().saturating_sub(n);
    history[start..].iter().map(|h| h.sid.clone()).collect()
}

/// 计算候选学生（对应 JS 的 candidates；**纯函数**）
///
/// * `students` —— 已按 scope 过滤过的学生（scope 过滤在调用方做，与 JS 的
///   `studentsOf(s, scope)` 对应），这里只负责 `active` 与两条约束
/// * `answered` —— 当前题已作答的学生 id（`has_current_question` 为真时才生效）
pub fn candidates(
    students: &[Student],
    answered: &BTreeSet<String>,
    settings: &RollcallSettings,
    opts: &PickOpts,
) -> Vec<Student> {
    let exclude_answered = opts.exclude_answered.unwrap_or(settings.exclude_answered);
    let recent = opts.recent_exclude.unwrap_or(settings.recent_exclude);

    let mut list: Vec<Student> = students.iter().filter(|s| s.active).cloned().collect();

    if exclude_answered && opts.has_current_question {
        list.retain(|s| !answered.contains(&s.id));
    }

    if recent > 0 {
        let skip = recent_ids(&settings.history, recent);
        let filtered: Vec<Student> = list.iter().filter(|s| !skip.contains(&s.id)).cloned().collect();
        // 若排除后无人可选则放弃该约束（否则会出现"没人可点"）
        if !filtered.is_empty() {
            list = filtered;
        }
    }

    list
}

/// 抽选一人（不修改 settings）。`draw` 接收候选个数、返回下标 —— 与 JS 的
/// `Math.floor(Math.random() * list.length)` 对应，便于注入固定序列做基准比对。
pub fn pick<F: FnOnce(usize) -> usize>(
    students: &[Student],
    answered: &BTreeSet<String>,
    settings: &RollcallSettings,
    opts: &PickOpts,
    draw: F,
) -> Option<Pick> {
    let mode = opts.mode.clone().unwrap_or_else(|| settings.mode.clone());
    let list = candidates(students, answered, settings, opts);
    if list.is_empty() {
        return None;
    }

    let mut note = String::new();
    let mut new_round = false;
    let mut pool: Option<Vec<String>> = None;
    let mut round: Option<u32> = None;
    // 三个分支各自赋值，这里用 let 声明避免"未使用赋值"告警
    let chosen_index: usize;

    if mode == "least" {
        let min = list.iter().map(|s| s.called).min().unwrap_or(0);
        let least: Vec<usize> = (0..list.len()).filter(|i| list[*i].called == min).collect();
        chosen_index = least[draw(least.len()).min(least.len() - 1)];
        note = format!("最少被点优先（本轮候选最少 {} 次）", min);
    } else if mode == "even" {
        let pool_ids = &settings.round_pool;
        let mut in_pool: Vec<usize> = (0..list.len()).filter(|i| pool_ids.contains(&list[*i].id)).collect();
        if in_pool.is_empty() {
            // 轮次池为空：要么是首次开始，要么上一轮已全部点到
            new_round = !settings.history.is_empty() && pool_ids.is_empty();
            in_pool = (0..list.len()).collect();
            note = if new_round {
                "本轮已全部点到，开启新一轮".to_string()
            } else {
                "新一轮开始".to_string()
            };
            if new_round {
                round = Some(settings.round + 1);
            }
        }
        chosen_index = in_pool[draw(in_pool.len()).min(in_pool.len() - 1)];
        // 本轮剩余候选：不放回，点完为止
        pool = Some(
            in_pool
                .iter()
                .filter(|i| **i != chosen_index)
                .map(|i| list[*i].id.clone())
                .collect(),
        );
    } else {
        chosen_index = draw(list.len()).min(list.len() - 1);
        note = "纯随机模式".to_string();
    }

    let chosen = &list[chosen_index];
    Some(Pick {
        sid: chosen.id.clone(),
        name: chosen.name.clone(),
        mode,
        note,
        candidate_count: list.len(),
        new_round,
        pool,
        round,
    })
}

/// 把抽选结果写回设置（轮次池 + 历史），对应 JS 的 applyPick
pub fn apply_pick(settings: &mut RollcallSettings, p: &Pick, at: i64) {
    if let Some(pool) = &p.pool {
        settings.round_pool = pool.clone();
        if let Some(r) = p.round {
            settings.round = r;
        }
    }
    settings.history.push(RollEntry {
        sid: p.sid.clone(),
        at,
    });
}

/// 「有 sid 的历史条目」—— 让 called_count 同时接受两种历史类型
///
/// 为什么需要它：`rollcall::RollEntry`（apply_pick 的输入，字段少）与
/// `state::RollHistoryEntry`（持久化历史，字段多）是**两个结构**，
/// 但它们都能回答"这次点的是谁"。
pub trait HasSid {
    fn sid_of(&self) -> &str;
}

impl HasSid for RollEntry {
    fn sid_of(&self) -> &str {
        &self.sid
    }
}

impl HasSid for crate::state::RollHistoryEntry {
    fn sid_of(&self) -> &str {
        &self.sid
    }
}

/// 被点次数统计（对应 JS 的 calledCount：数历史里同一个人出现几次）
pub fn called_count<T: HasSid>(history: &[T], sid: &str) -> u32 {
    history.iter().filter(|h| h.sid_of() == sid).count() as u32
}

/* ------------------------------------------------------------------ *
 * 真实使用的随机源：xorshift64*（不引第三方依赖，够均匀也够快）
 * ------------------------------------------------------------------ */

pub struct XorShift64 {
    state: u64,
}

impl XorShift64 {
    /// 用当前时间（纳秒）与一个地址熵播种；同一次课堂里不会重复
    pub fn from_entropy() -> Self {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0x9E3779B97F4A7C15);
        XorShift64::seed(nanos ^ 0x2545F4914F6CDD1D)
    }

    pub fn seed(seed: u64) -> Self {
        XorShift64 {
            state: if seed == 0 { 0x9E3779B97F4A7C15 } else { seed },
        }
    }

    pub fn next_u64(&mut self) -> u64 {
        let mut x = self.state;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.state = x;
        x.wrapping_mul(0x2545F4914F6CDD1D)
    }

    /// [0, 1) 区间的浮点（与 JS 的 Math.random 同区间）
    pub fn next_f64(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }

    /// 抽取下标：`floor(r × len)`，与 JS 的 `Math.floor(Math.random() * list.length)` 一致
    pub fn index(&mut self, len: usize) -> usize {
        if len == 0 {
            return 0;
        }
        ((self.next_f64() * len as f64) as usize).min(len - 1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn students() -> Vec<Student> {
        vec![
            Student { id: "s1".into(), name: "甲".into(), active: true, called: 0 },
            Student { id: "s2".into(), name: "乙".into(), active: true, called: 0 },
            Student { id: "s3".into(), name: "丙".into(), active: true, called: 0 },
            Student { id: "s4".into(), name: "丁".into(), active: true, called: 0 },
            Student { id: "s5".into(), name: "戊".into(), active: true, called: 0 },
        ]
    }

    fn settings(mode: &str) -> RollcallSettings {
        RollcallSettings {
            mode: mode.into(),
            scope: "all".into(),
            recent_exclude: 0,
            ..Default::default()
        }
    }

    fn none() -> BTreeSet<String> {
        BTreeSet::new()
    }

    #[test]
    fn active_filter() {
        let mut list = students();
        list[0].active = false;
        let c = candidates(&list, &none(), &settings("even"), &PickOpts::default());
        assert_eq!(c.len(), 4, "停用的学生不参与点名");
    }

    #[test]
    fn even_mode_covers_everyone_in_one_round() {
        // 均匀模式：一轮内不放回，5 次点完 5 个人且不重复
        let mut st = settings("even");
        let list = students();
        let mut picked: Vec<String> = Vec::new();
        let mut rng = XorShift64::seed(42);
        for _ in 0..5 {
            let p = pick(&list, &none(), &st, &PickOpts { recent_exclude: Some(0), ..Default::default() }, |n| rng.index(n)).unwrap();
            picked.push(p.sid.clone());
            apply_pick(&mut st, &p, 0);
        }
        let uniq: BTreeSet<&String> = picked.iter().collect();
        assert_eq!(uniq.len(), 5, "均匀模式一轮覆盖全部 5 人且不重复：{:?}", picked);
        assert_eq!(st.round_pool.len(), 0, "点完一轮后池子清空");
    }

    #[test]
    fn even_mode_starts_new_round() {
        let mut st = settings("even");
        let list = students();
        let mut rng = XorShift64::seed(7);
        for _ in 0..5 {
            let p = pick(&list, &none(), &st, &PickOpts { recent_exclude: Some(0), ..Default::default() }, |n| rng.index(n)).unwrap();
            apply_pick(&mut st, &p, 0);
        }
        let p6 = pick(&list, &none(), &st, &PickOpts { recent_exclude: Some(0), ..Default::default() }, |n| rng.index(n)).unwrap();
        assert!(p6.note.contains("新一轮") || p6.new_round, "第 6 次进入新一轮：{}", p6.note);
        assert_eq!(p6.round, Some(2), "轮次号 +1");
    }

    #[test]
    fn least_mode_prefers_never_called() {
        let mut list = students();
        list[0].called = 3; // 甲被点过 3 次
        let st = settings("least");
        // 最少被点的是其余 4 人（各 0 次）
        let p = pick(&list, &none(), &st, &PickOpts::default(), |n| {
            assert_eq!(n, 4, "候选池应排除被点最多的甲");
            0
        })
        .unwrap();
        assert_ne!(p.sid, "s1");
        assert!(p.note.contains("最少被点优先"));
        assert_eq!(p.candidate_count, 5, "候选人数仍是全部（最少优先只影响挑选）");
    }

    #[test]
    fn least_mode_avoids_just_picked() {
        // 对应 JS：最少被点优先会避开刚点过的人
        let mut st = settings("least");
        let mut list = students();
        let mut rng = XorShift64::seed(11);
        let first = pick(&list, &none(), &st, &PickOpts::default(), |n| rng.index(n)).unwrap();
        apply_pick(&mut st, &first, 0);
        // 被点者次数 +1（真实系统里由流水统计；这里手工同步）
        for s in list.iter_mut() {
            if s.id == first.sid {
                s.called += 1;
            }
        }
        let second = pick(&list, &none(), &st, &PickOpts::default(), |n| rng.index(n)).unwrap();
        assert_ne!(second.sid, first.sid, "第二次不会点到刚点过的人");
    }

    #[test]
    fn random_mode_has_no_pool() {
        let st = settings("random");
        let mut rng = XorShift64::seed(3);
        let p = pick(&students(), &none(), &st, &PickOpts::default(), |n| rng.index(n)).unwrap();
        assert!(p.pool.is_none(), "纯随机模式不维护轮次池");
        assert_eq!(p.note, "纯随机模式");
    }

    #[test]
    fn exclude_answered_removes_them() {
        // 对应 JS：排除已答当前题的学生
        let list = students();
        let mut answered = BTreeSet::new();
        answered.insert("s1".to_string());
        let st = settings("even");
        let opts = PickOpts { exclude_answered: Some(true), has_current_question: true, recent_exclude: Some(0), ..Default::default() };
        let c = candidates(&list, &answered, &st, &opts);
        assert_eq!(c.len(), 4);
        assert!(!c.iter().any(|x| x.id == "s1"));
        // 没有当前题时该约束不生效（与 JS 的 `excludeAnswered && quizId && qid` 一致）
        let opts2 = PickOpts { exclude_answered: Some(true), has_current_question: false, ..Default::default() };
        assert_eq!(candidates(&list, &answered, &st, &opts2).len(), 5);
    }

    #[test]
    fn recent_exclude_but_gives_up_when_empty() {
        let list = students();
        let mut st = settings("even");
        st.history = vec![
            RollEntry { sid: "s1".into(), at: 1 },
            RollEntry { sid: "s2".into(), at: 2 },
        ];
        let opts = PickOpts { recent_exclude: Some(1), ..Default::default() };
        let c = candidates(&list, &none(), &st, &opts);
        assert_eq!(c.len(), 4, "最近 1 次被点到的 s2 被排除");
        assert!(!c.iter().any(|x| x.id == "s2"));

        // 全部人都在最近名单里 → 放弃该约束，而不是没人可点
        // （注意 recentExclude 取的是"最近 N 次"，要覆盖全部 5 人才会走到这条分支）
        let mut st2 = settings("even");
        st2.history = list.iter().map(|s| RollEntry { sid: s.id.clone(), at: 0 }).collect();
        let c2 = candidates(&list, &none(), &st2, &PickOpts { recent_exclude: Some(5), ..Default::default() });
        assert_eq!(c2.len(), 5, "排除后无人可选则放弃该约束");
    }

    #[test]
    fn empty_candidates_returns_none() {
        assert!(pick(&[], &none(), &settings("even"), &PickOpts::default(), |_| 0).is_none());
        let mut list = students();
        list.iter_mut().for_each(|s| s.active = false);
        assert!(pick(&list, &none(), &settings("even"), &PickOpts::default(), |_| 0).is_none());
    }

    #[test]
    fn history_and_called_count() {
        let mut st = settings("even");
        let list = students();
        let p = pick(&list, &none(), &st, &PickOpts::default(), |_| 0).unwrap();
        apply_pick(&mut st, &p, 1234);
        assert_eq!(st.history.len(), 1, "点名历史已记录");
        assert_eq!(st.history[0].at, 1234);
        assert_eq!(called_count(&st.history, &p.sid), 1, "被点次数统计");
    }

    #[test]
    fn rng_is_deterministic_and_in_range() {
        let mut a = XorShift64::seed(2026);
        let mut b = XorShift64::seed(2026);
        for _ in 0..50 {
            assert_eq!(a.next_u64(), b.next_u64(), "同种子必须同序列（基准比对的前提）");
        }
        let mut r = XorShift64::seed(1);
        for len in [1usize, 2, 5, 100] {
            for _ in 0..200 {
                assert!(r.index(len) < len, "下标必须落在 [0, len)");
            }
        }
    }
}
