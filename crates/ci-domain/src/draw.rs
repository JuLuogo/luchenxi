//! draw.rs — 从题库里**随机抽题**（组卷用）
//!
//! **迁移来源**：这是新增能力（`assets/js/store.js` 里原来没有），
//! 但两侧实现同一契约、共用 parity 基准，理由与既有模块一致：
//! 组卷规则属于"业务判断"，不能只活在浏览器里（docs/14 §2）。
//!
//! 抽取算法刻意与 `rollcall.rs` 保持一致，便于共用同一套固定随机序列做基准比对：
//!   · 候选先过滤（题型 / 标签 / 排除 id / 归档）
//!   · Fisher-Yates 洗牌：从后往前，每步消耗**一次**随机数，
//!     下标 = `floor(r × (i + 1))`（与 JS 的 `Math.floor(Math.random() * (i + 1))` 逐位一致）
//!   · 取前 count 个
//!
//! 为什么不用"每次随机取一个再查重"：那样随机数消耗次数与碰撞有关，
//! 两边很难保证消耗序列一致，parity 就无从谈起。

use crate::state::BankQuestion;
use serde::{Deserialize, Serialize};

/// 抽题条件
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DrawOpts {
    /// 要抽几道
    pub count: usize,
    /// 限定题型（空 = 不限）
    #[serde(default)]
    pub tiers: Vec<String>,
    /// 限定标签（命中**任意一个**即可；空 = 不限）
    #[serde(default)]
    pub tags: Vec<String>,
    /// 排除的题目 id（比如已在试卷里的，避免抽重）
    #[serde(default)]
    pub exclude_ids: Vec<String>,
    /// 是否包含已归档的题（默认不包含）
    #[serde(default)]
    pub include_archived: bool,
}

/// 候选题目（过滤后、保持题库原顺序 —— 顺序稳定性是 parity 的前提）
pub fn candidates<'a>(bank: &'a [BankQuestion], opts: &DrawOpts) -> Vec<&'a BankQuestion> {
    bank.iter()
        .filter(|q| {
            if !opts.include_archived && q.archived {
                return false;
            }
            if opts.exclude_ids.iter().any(|id| id == &q.id) {
                return false;
            }
            if !opts.tiers.is_empty() && !opts.tiers.iter().any(|t| t == &q.tier) {
                return false;
            }
            if !opts.tags.is_empty() && !opts.tags.iter().any(|t| q.tags.iter().any(|qt| qt == t)) {
                return false;
            }
            true
        })
        .collect()
}

/// 抽题：返回抽中的题目 id（不足则全给，不报错）
///
/// `rand` 每次调用返回 `[0, 1)`；传固定序列即可复现同一次抽题。
pub fn draw<F: FnMut() -> f64>(bank: &[BankQuestion], opts: &DrawOpts, mut rand: F) -> Vec<String> {
    let mut list: Vec<&BankQuestion> = candidates(bank, opts);
    if opts.count == 0 || list.is_empty() {
        return Vec::new();
    }
    // Fisher-Yates：每步恰好消耗一次随机数（与 JS 逐位一致）
    let mut i = list.len();
    while i > 1 {
        let r = rand();
        let j = ((r * i as f64) as usize).min(i - 1);
        list.swap(i - 1, j);
        i -= 1;
    }
    list.into_iter().take(opts.count).map(|q| q.id.clone()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rollcall::XorShift64;

    fn q(id: &str, tier: &str, tags: &[&str], archived: bool) -> BankQuestion {
        BankQuestion {
            id: id.to_string(),
            tier: tier.to_string(),
            tags: tags.iter().map(|s| s.to_string()).collect(),
            archived,
            ..Default::default()
        }
    }

    fn bank() -> Vec<BankQuestion> {
        vec![
            q("q1", "basic", &["集合与逻辑"], false),
            q("q2", "basic", &["函数与导数"], false),
            q("q3", "advanced", &["函数与导数"], false),
            q("q4", "advanced", &["概率统计"], false),
            q("q5", "improve", &["集合与逻辑"], true), // 已归档
        ]
    }

    #[test]
    fn candidates_filters_by_tier_tags_and_archive() {
        let b = bank();
        // 默认排除归档
        let all = candidates(&b, &DrawOpts::default());
        assert_eq!(all.len(), 4, "归档的 q5 不该出现");
        // 限定题型
        let adv = candidates(&b, &DrawOpts { tiers: vec!["advanced".into()], ..Default::default() });
        assert_eq!(adv.iter().map(|q| q.id.as_str()).collect::<Vec<_>>(), vec!["q3", "q4"]);
        // 限定标签（命中任意一个）
        let tagged = candidates(&b, &DrawOpts { tags: vec!["函数与导数".into()], ..Default::default() });
        assert_eq!(tagged.iter().map(|q| q.id.as_str()).collect::<Vec<_>>(), vec!["q2", "q3"]);
        // 题型 + 标签
        let both = candidates(&b, &DrawOpts { tiers: vec!["basic".into()], tags: vec!["函数与导数".into()], ..Default::default() });
        assert_eq!(both.iter().map(|q| q.id.as_str()).collect::<Vec<_>>(), vec!["q2"]);
        // 排除 id（试卷里已有的）
        let excl = candidates(&b, &DrawOpts { exclude_ids: vec!["q1".into(), "q3".into()], ..Default::default() });
        assert_eq!(excl.iter().map(|q| q.id.as_str()).collect::<Vec<_>>(), vec!["q2", "q4"]);
        // 显式包含归档
        let with_archived = candidates(&b, &DrawOpts { include_archived: true, ..Default::default() });
        assert_eq!(with_archived.len(), 5);
        // 候选顺序保持题库原序（parity 的前提）
        assert_eq!(all.iter().map(|q| q.id.as_str()).collect::<Vec<_>>(), vec!["q1", "q2", "q3", "q4"]);
    }

    #[test]
    fn draw_is_deterministic_with_seed_and_respects_count() {
        let b = bank();
        let opts = DrawOpts { count: 2, ..Default::default() };
        // 同一个种子 → 同一批题（两个独立的 rng 实例，各喂各的）
        let mut rng1 = XorShift64::seed(7);
        let mut rng2 = XorShift64::seed(7);
        let d1 = draw(&b, &opts, || rng1.next_f64());
        let d2 = draw(&b, &opts, || rng2.next_f64());
        assert_eq!(d1, d2, "同种子必须抽到同一批题");
        assert_eq!(d1.len(), 2);
        // 抽到的题不重复，且都来自候选
        let mut sorted = d1.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(sorted.len(), d1.len(), "不该抽出重复题");
        for id in &d1 {
            assert!(["q1", "q2", "q3", "q4"].contains(&id.as_str()), "抽到了非法题 {}", id);
        }
        // 换种子通常换结果（不强制不同，但要是合法结果）
        let mut rng3 = XorShift64::seed(99);
        let d3 = draw(&b, &opts, || rng3.next_f64());
        assert_eq!(d3.len(), 2);
        for id in &d3 {
            assert!(["q1", "q2", "q3", "q4"].contains(&id.as_str()));
        }
    }

    #[test]
    fn draw_edge_cases() {
        let b = bank();
        // 要 0 道
        let mut rng = XorShift64::seed(1);
        assert!(draw(&b, &DrawOpts { count: 0, ..Default::default() }, || rng.next_f64()).is_empty());
        // 要的比候选多 → 全给
        let mut rng = XorShift64::seed(1);
        let all = draw(&b, &DrawOpts { count: 99, ..Default::default() }, || rng.next_f64());
        assert_eq!(all.len(), 4, "候选只有 4 道就全给，不报错");
        // 条件过滤后没有候选 → 空
        let mut rng = XorShift64::seed(1);
        let none = draw(&b, &DrawOpts { count: 3, tiers: vec!["不存在".into()], ..Default::default() }, || rng.next_f64());
        assert!(none.is_empty());
        // 空题库
        let mut rng = XorShift64::seed(1);
        assert!(draw(&[], &DrawOpts { count: 3, ..Default::default() }, || rng.next_f64()).is_empty());
    }

    #[test]
    fn draw_consumes_one_random_per_swap() {
        // 这条是 parity 的命门：消耗次数必须只与候选数有关，与抽中谁无关
        let b = bank(); // 4 道候选
        let opts = DrawOpts { count: 4, ..Default::default() };
        let mut count = 0;
        let mut rng = XorShift64::seed(3);
        let _ = draw(&b, &opts, || {
            count += 1;
            rng.next_f64()
        });
        assert_eq!(count, 3, "4 个候选洗牌需要 3 次随机（i = 4,3,2）");
    }
}
