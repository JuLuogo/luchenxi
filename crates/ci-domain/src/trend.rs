//! trend.rs — 趋势：按「天」或「按课次（测验）」聚合，回答「这几周是进步还是退步」
//!
//! 为什么需要（审计 B7）：原来只有「本节课 / 全部课次」两档，看不出走向。
//! 学习通/班级优化大师都有趋势曲线；而我们的数据里本来就有时间戳，只是没人算。
//!
//! 口径（与 JS `analysis.js::trend` **逐字段一致**，有 parity 基准）：
//!   · 只统计**可计入**的流水（`is_countable`：带题型快照、不是纯手动调整）
//!   · `by = "day"`  —— 按**本地日期**分桶。`tz_offset_min` 与
//!     `Date.prototype.getTimezoneOffset()` 同义（东八区是 -480）。
//!     **必须由调用方给**：Rust 侧不知道浏览器在哪个时区，猜就会与 JS 分叉。
//!   · `by = "quiz"` —— 按测验分桶，顺序跟着 `state.quizzes`
//!   · `rate` = 答对 / 作答次数（百分比四舍五入），与 docs/05 的"严格正确率"一致
//!   · `points` 保留两位小数；day 桶按日期升序

use crate::scoring::{is_countable, round2};
use crate::state::ClassroomState;
use serde::{Deserialize, Serialize};

/// 一个时间桶（一天 / 一次课）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrendBucket {
    /// day → `YYYY-MM-DD`；quiz → 测验 id
    pub key: String,
    pub label: String,
    pub attempts: u32,
    pub correct: u32,
    pub half: u32,
    pub wrong: u32,
    pub skip: u32,
    pub points: f64,
    /// 严格正确率（百分比整数）
    pub rate: i64,
}

/// 趋势参数（与 JS 的 opts 同名同义）
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrendOpts {
    /// "day" | "quiz"（缺省 day）
    #[serde(default)]
    pub by: Option<String>,
    #[serde(default)]
    pub student_id: Option<String>,
    #[serde(default)]
    pub team_id: Option<String>,
    /// 与 `getTimezoneOffset()` 同义（分钟）
    #[serde(default)]
    pub tz_offset_min: Option<i64>,
}

/// 本地日期键 `YYYY-MM-DD`（`tz_offset_min` 与 `getTimezoneOffset()` 同义）
pub fn day_key(at: i64, tz_offset_min: i64) -> String {
    if at == 0 {
        return String::new();
    }
    // 与 JS 同算法：把时间戳减去偏移，再取 UTC 字段
    let local = at - tz_offset_min * 60_000;
    let days = local.div_euclid(86_400_000);
    let (y, m, d) = civil_from_days(days);
    format!("{:04}-{:02}-{:02}", y, m, d)
}

/// 天数 → (年, 月, 日)（Howard Hinnant 的 civil_from_days，避免引入 chrono）
fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;                                     // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);                // [0, 365]
    let mp = (5 * doy + 2) / 153;                                     // [0, 11]
    let d = doy - (153 * mp + 2) / 5 + 1;                             // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 };                    // [1, 12]
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn pct(a: u32, b: u32) -> i64 {
    if b == 0 {
        return 0;
    }
    ((a as f64 / b as f64) * 100.0).round() as i64
}

/// 趋势（与 JS `analysis.js::trend` 逐字段一致）
pub fn trend(s: &ClassroomState, opts: &TrendOpts) -> Vec<TrendBucket> {
    let by_quiz = opts.by.as_deref() == Some("quiz");
    let tz = opts.tz_offset_min.unwrap_or(0);

    let mut out: Vec<TrendBucket> = Vec::new();
    let mut index: Vec<String> = Vec::new();

    for qz in &s.quizzes {
        for r in &qz.records {
            if !is_countable(&r.tier, &r.result) {
                continue;
            }
            // r.sid 是 Option（团队级流水可能没有个人归属）
            if let Some(sid) = &opts.student_id {
                if r.sid.as_deref() != Some(sid.as_str()) {
                    continue;
                }
            }
            if let Some(tid) = &opts.team_id {
                let ok = r
                    .sid
                    .as_deref()
                    .and_then(|sid| s.students.iter().find(|x| x.id == sid))
                    .map(|x| x.team_id.as_deref() == Some(tid.as_str()))
                    .unwrap_or(false);
                if !ok {
                    continue;
                }
            }
            let (key, label) = if by_quiz {
                (qz.id.clone(), qz.name.clone())
            } else {
                let k = day_key(r.at, tz);
                (k.clone(), k)
            };
            if key.is_empty() {
                continue;
            }
            let pos = match index.iter().position(|x| x == &key) {
                Some(p) => p,
                None => {
                    index.push(key.clone());
                    out.push(TrendBucket {
                        key: key.clone(),
                        label,
                        attempts: 0,
                        correct: 0,
                        half: 0,
                        wrong: 0,
                        skip: 0,
                        points: 0.0,
                        rate: 0,
                    });
                    out.len() - 1
                }
            };
            let e = &mut out[pos];
            e.attempts += 1;
            match r.result.as_str() {
                "correct" => e.correct += 1,
                "half" => e.half += 1,
                "wrong" => e.wrong += 1,
                "skip" => e.skip += 1,
                _ => {}
            }
            e.points += r.points;
        }
    }

    if !by_quiz {
        out.sort_by(|a, b| a.key.cmp(&b.key));
    }
    for e in out.iter_mut() {
        e.points = round2(e.points);
        e.rate = pct(e.correct, e.attempts);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn day_key_matches_js_for_east_eight() {
        // 2026-10-01 01:00 UTC = 东八区 09:00 → 同一天
        let at = 1_790_816_400_000; // 2026-10-01T01:00:00Z
        assert_eq!(day_key(at, -480), "2026-10-01");
        // 2026-09-30 17:00 UTC = 东八区 10-01 01:00 → 东八区仍是 10-01，UTC 是 09-30
        let at2 = at - 8 * 3_600_000;
        assert_eq!(day_key(at2, -480), "2026-10-01");
        assert_eq!(day_key(at2, 0), "2026-09-30");
    }

    #[test]
    fn empty_state_gives_no_buckets() {
        let s = ClassroomState::default();
        assert!(trend(&s, &TrendOpts::default()).is_empty());
    }
}
