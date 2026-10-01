//! parity.rs —— JS 参考实现 ↔ Rust 实现的**逐字段一致性**测试
//!
//! 做法：`scripts/gen-parity-fixtures.mjs` 用 JS 参考实现（`assets/js/analysis.js`）
//! 跑一批固定输入并把结果落成 `tests/fixtures/parity.json`；
//! 这里读同一份输入、用 `ci_domain::ability_of_tiers` 算一遍，**逐字段断言相等**。
//!
//! 为什么这是迁移期最重要的一个测试：规则重写最容易出现"看起来对、边界差一点"的漂移
//! （四舍五入、排序稳定性、评语措辞）。逐字段比对能把这些全都钉死。
//! 迁移完成后即使删掉 JS 实现，这份基准仍然有效。
//!
//! 重新生成基准：`node scripts/gen-parity-fixtures.mjs`
//! CI 校验基准是否过期：`node scripts/gen-parity-fixtures.mjs --check`

use ci_domain::{ability_of_tiers, answer_key, auto, describe_submission, validate_question, Question, Submission, TierStat};
use serde::Deserialize;
use serde_json::Value;
use std::path::PathBuf;

#[derive(Debug, Deserialize)]
struct Fixture {
    ability: Vec<Case>,
    grading: Vec<GradeCase>,
}

#[derive(Debug, Deserialize)]
struct GradeCase {
    name: String,
    question: Question,
    submission: Submission,
    /// 主观题时 JS 返回 null，这里对应 None
    expect: Option<GradeExpect>,
    #[serde(rename = "answerKey")]
    answer_key: String,
    describe: String,
    validate: Vec<String>,
    #[serde(rename = "type")]
    qtype: String,
    #[serde(rename = "typeLabel")]
    type_label: String,
}

#[derive(Debug, Deserialize)]
struct GradeExpect {
    result: String,
    expected: String,
    got: String,
}

#[derive(Debug, Deserialize)]
struct Case {
    name: String,
    #[serde(rename = "minSample")]
    min_sample: u32,
    #[serde(rename = "totalAttempts")]
    total_attempts: u32,
    tiers: Vec<TierStat>,
    expect: Value,
}

fn fixtures_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("tests")
        .join("fixtures")
        .join("parity.json")
}

fn load() -> Fixture {
    let text = std::fs::read_to_string(fixtures_path())
        .expect("缺少 tests/fixtures/parity.json —— 先跑 node scripts/gen-parity-fixtures.mjs");
    serde_json::from_str(&text).expect("parity.json 格式不正确")
}

/// 数值比对：允许 1e-6 的浮点误差（字符串/整数则要求完全相等）
fn same_num(a: f64, b: f64, label: &str, case: &str) {
    assert!(
        (a - b).abs() < 1e-6,
        "[{}] {} 不一致：Rust {} vs JS {}",
        case,
        label,
        a,
        b
    );
}

#[test]
fn ability_matches_js_reference() {
    let fx = load();
    assert!(!fx.ability.is_empty(), "基准里没有用例");

    for case in &fx.ability {
        let got = ability_of_tiers(&case.tiers, case.total_attempts, case.min_sample);
        let want = &case.expect;
        let n = &case.name;

        // ---- 标量字段 ----
        same_num(got.overall as f64, want["overall"].as_f64().unwrap(), "overall", n);
        same_num(got.mastery as f64, want["mastery"].as_f64().unwrap(), "mastery", n);
        same_num(got.coverage as f64, want["coverage"].as_f64().unwrap(), "coverage", n);
        same_num(got.attempts as f64, want["attempts"].as_f64().unwrap(), "attempts", n);
        same_num(got.filled as f64, want["filled"].as_f64().unwrap(), "filled", n);
        same_num(got.max_rate as f64, want["maxRate"].as_f64().unwrap(), "maxRate", n);
        same_num(got.min_rate as f64, want["minRate"].as_f64().unwrap(), "minRate", n);

        // ---- balance：可能是 null（答过 <2 个题型）----
        match (got.balance, want["balance"].as_i64()) {
            (None, None) => {}
            (Some(a), Some(b)) => same_num(a as f64, b as f64, "balance", n),
            (a, b) => panic!("[{}] balance 不一致：Rust {:?} vs JS {:?}", n, a, b),
        }

        // ---- 评级 ----
        assert_eq!(got.grade.key, want["grade"].as_str().unwrap(), "[{}] 评级 key 不一致", n);
        assert_eq!(got.grade.short, want["gradeShort"].as_str().unwrap(), "[{}] 评级 short 不一致", n);
        assert_eq!(got.grade.label, want["gradeLabel"].as_str().unwrap(), "[{}] 评级 label 不一致", n);

        // ---- 评语：逐字相等（措辞漂移在这个断言前无处可藏）----
        assert_eq!(got.comment, want["comment"].as_str().unwrap(), "[{}] 评语不一致", n);

        // ---- 最强 / 最弱轴 ----
        for (field, mine) in [("weakest", got.weakest_axis()), ("strongest", got.strongest_axis())] {
            let w = &want[field];
            match (mine, w.is_null()) {
                (None, true) => {}
                (Some(a), false) => {
                    assert_eq!(a.key, w["key"].as_str().unwrap(), "[{}] {}.key 不一致", n, field);
                    same_num(a.rate as f64, w["rate"].as_f64().unwrap(), &format!("{}.rate", field), n);
                }
                (a, b) => panic!("[{}] {} 不一致：Rust {:?} vs JS null={}", n, field, a.map(|x| &x.key), b),
            }
        }

        // ---- 每条轴 ----
        let want_axes = want["axes"].as_array().unwrap();
        assert_eq!(got.axes.len(), want_axes.len(), "[{}] 轴数量不一致", n);
        for (i, wa) in want_axes.iter().enumerate() {
            let ga = &got.axes[i];
            assert_eq!(ga.key, wa["key"].as_str().unwrap(), "[{}] axes[{}].key", n, i);
            assert_eq!(ga.label, wa["label"].as_str().unwrap(), "[{}] axes[{}].label", n, i);
            same_num(ga.weight, wa["weight"].as_f64().unwrap(), &format!("axes[{}].weight", i), n);
            same_num(ga.attempts as f64, wa["attempts"].as_f64().unwrap(), &format!("axes[{}].attempts", i), n);
            same_num(ga.correct as f64, wa["correct"].as_f64().unwrap(), &format!("axes[{}].correct", i), n);
            same_num(ga.rate as f64, wa["rate"].as_f64().unwrap(), &format!("axes[{}].rate", i), n);
            same_num(ga.correct_rate, wa["correctRate"].as_f64().unwrap(), &format!("axes[{}].correctRate", i), n);
        }

        println!("  ✔ {}（{} / overall {}）", n, got.grade.label, got.overall);
    }

    println!(
        "\n✅ 能力评价：{} 组用例与 JS 参考实现逐字段一致",
        fx.ability.len()
    );
}

/// 判分：同样逐字段比对（含 answerKey / describeSubmission / validateQuestion 的文案）
#[test]
fn grading_matches_js_reference() {
    let fx = load();
    assert!(!fx.grading.is_empty(), "基准里没有判分用例");

    for c in &fx.grading {
        let n = &c.name;
        assert_eq!(c.question.type_of().as_str(), c.qtype, "[{}] 题型推断不一致", n);
        assert_eq!(c.question.type_label(), c.type_label, "[{}] 题型名称不一致", n);

        match (auto(&c.question, &c.submission), &c.expect) {
            (None, None) => {}
            (Some(got), Some(want)) => {
                assert_eq!(got.result.as_str(), want.result, "[{}] 判定结果不一致", n);
                assert_eq!(got.expected, want.expected, "[{}] expected 不一致", n);
                assert_eq!(got.got, want.got, "[{}] got 不一致", n);
            }
            (a, b) => panic!("[{}] auto 返回形态不一致：Rust {:?} vs JS {:?}", n, a, b.is_some()),
        }

        assert_eq!(answer_key(&c.question), c.answer_key, "[{}] 答案串不一致", n);
        assert_eq!(describe_submission(&c.question, &c.submission), c.describe, "[{}] 提交描述不一致", n);
        assert_eq!(validate_question(&c.question).warnings, c.validate, "[{}] 保存前自检告警不一致", n);

        println!(
            "  ✔ {}（{}）",
            n,
            c.expect.as_ref().map(|e| e.result.as_str()).unwrap_or("主观题→老师判定")
        );
    }

    println!("\n✅ 判分：{} 组用例与 JS 参考实现逐字段一致", fx.grading.len());
}
