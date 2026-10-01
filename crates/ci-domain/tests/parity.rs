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

use ci_domain::{
    ability_of_tiers, answer_key, apply_pick, auto, default_tiers, describe_submission,
    rollcall_pick, score_of_input, validate_question, PickOpts, Question, RollcallSettings,
    ScoreInput, ScoringSettings, Student, Submission, TierStat,
};
use serde::Deserialize;
use serde_json::Value;
use std::path::PathBuf;

#[derive(Debug, Deserialize)]
struct Fixture {
    ability: Vec<Case>,
    grading: Vec<GradeCase>,
    rollcall: Vec<RollCase>,
    scoring: Vec<ScoreCase>,
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


#[derive(Debug, Deserialize)]
struct RollCase {
    name: String,
    mode: String,
    #[serde(rename = "hasCurrentQuestion")]
    has_current_question: bool,
    steps: Vec<RollStep>,
}

#[derive(Debug, Deserialize)]
struct RollStep {
    students: Vec<Student>,
    answered: Vec<String>,
    settings_before: RollcallSettings,
    draw: f64,
    expect: RollExpect,
    settings_after: RollAfter,
}

#[derive(Debug, Deserialize)]
struct RollExpect {
    sid: String,
    name: String,
    mode: String,
    note: String,
    #[serde(rename = "candidateCount")]
    candidate_count: usize,
    #[serde(rename = "newRound")]
    new_round: bool,
    pool: Option<Vec<String>>,
    round: Option<u32>,
}

#[derive(Debug, Deserialize)]
struct RollAfter {
    round: u32,
    round_pool: Vec<String>,
    history: Vec<String>,
}


#[derive(Debug, Deserialize)]
struct ScoreCase {
    name: String,
    steps: Vec<ScoreStep>,
}

#[derive(Debug, Deserialize)]
struct ScoreStep {
    settings: ScoringSettings,
    #[serde(rename = "hasQuestion")]
    has_question: bool,
    #[serde(rename = "questionTier")]
    question_tier: Option<String>,
    #[serde(rename = "customPoints")]
    custom_points: Option<f64>,
    tier: Option<String>,
    result: String,
    fast: bool,
    source: String,
    expect: ScoreExpect,
}

#[derive(Debug, Deserialize)]
struct ScoreExpect {
    base: f64,
    ratio: f64,
    points: f64,
    result: String,
    tier: String,
    #[serde(rename = "scoreAfter")]
    score_after: f64,
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

/// 随机点名：喂同一串随机数（fixture 里的 draw），两边必须选出同一个人、
/// 同样的 note / 轮次池 / 新一轮标记，并且 apply 之后的状态也一致
#[test]
fn rollcall_matches_js_reference() {
    let fx = load();
    assert!(!fx.rollcall.is_empty(), "基准里没有点名用例");

    for case in &fx.rollcall {
        let mut settings = RollcallSettings::default();
        for (i, step) in case.steps.iter().enumerate() {
            let n = format!("{} #{ }", case.name, i + 1);
            // 用 fixture 里记录的"这一步开始前的状态"
            settings = step.settings_before.clone();
            let answered: std::collections::BTreeSet<String> = step.answered.iter().cloned().collect();
            let opts = PickOpts {
                scope: Some("all".to_string()),
                mode: Some(case.mode.clone()),
                exclude_answered: Some(settings.exclude_answered),
                recent_exclude: Some(settings.recent_exclude),
                has_current_question: case.has_current_question,
            };

            // draw 与 JS 的 Math.floor(Math.random() * len) 完全同构
            let draw = step.draw;
            let got = rollcall_pick(&step.students, &answered, &settings, &opts, |len| {
                if len == 0 { 0 } else { ((draw * len as f64) as usize).min(len - 1) }
            });

            let got = got.unwrap_or_else(|| panic!("[{}] Rust 侧没有选出人", n));
            let want = &step.expect;
            assert_eq!(got.sid, want.sid, "[{}] 选中的人不一致", n);
            assert_eq!(got.name, want.name, "[{}] 姓名不一致", n);
            assert_eq!(got.mode, want.mode, "[{}] 模式不一致", n);
            assert_eq!(got.note, want.note, "[{}] 提示语不一致", n);
            assert_eq!(got.candidate_count, want.candidate_count, "[{}] 候选人数不一致", n);
            assert_eq!(got.new_round, want.new_round, "[{}] 新一轮标记不一致", n);
            assert_eq!(got.round, want.round, "[{}] 轮次号不一致", n);
            assert_eq!(got.pool, want.pool, "[{}] 轮次池不一致", n);

            // apply 之后：轮次池与历史都要一致
            apply_pick(&mut settings, &got, 0);
            assert_eq!(settings.round, step.settings_after.round, "[{}] apply 后轮次不一致", n);
            assert_eq!(settings.round_pool, step.settings_after.round_pool, "[{}] apply 后池子不一致", n);
            let hist: Vec<String> = settings.history.iter().map(|h| h.sid.clone()).collect();
            assert_eq!(hist, step.settings_after.history, "[{}] apply 后历史不一致", n);

            println!("  ✔ {} → {}（{}）", n, got.name, got.note);
        }
    }

    println!("\n✅ 随机点名：{} 组用例与 JS 参考实现逐步一致", fx.rollcall.len());
}

/// 加权计分：逐步复现 JS 的流水线（含扣分/抢答奖励/halfRatio 改动/自定义分值/未知结果），
/// 比对每一步的基准分、折算比例、得分，以及累计分数（两位小数舍入也要一致）
#[test]
fn scoring_matches_js_reference() {
    let fx = load();
    assert!(!fx.scoring.is_empty(), "基准里没有计分用例");
    let tiers = default_tiers();

    for case in &fx.scoring {
        let mut total = 0.0_f64;
        for (i, step) in case.steps.iter().enumerate() {
            let n = format!("{} #{ }", case.name, i + 1);
            let input = ScoreInput {
                sid: "s1".to_string(),
                qid: if step.has_question { Some("q".to_string()) } else { None },
                tier: step.tier.clone(),
                question_tier: step.question_tier.clone(),
                custom_points: step.custom_points,
                base: None,
                result: step.result.clone(),
                fast: step.fast,
                source: Some(step.source.clone()),
            };
            let got = score_of_input(&tiers, &step.settings, &input);

            assert!((got.base - step.expect.base).abs() < 1e-9, "[{}] base 不一致：{} vs {}", n, got.base, step.expect.base);
            assert!((got.ratio - step.expect.ratio).abs() < 1e-9, "[{}] ratio 不一致：{} vs {}", n, got.ratio, step.expect.ratio);
            assert!((got.points - step.expect.points).abs() < 1e-9, "[{}] points 不一致：{} vs {}", n, got.points, step.expect.points);
            assert_eq!(got.result, step.expect.result, "[{}] 结果归一化不一致", n);
            assert_eq!(got.tier, step.expect.tier, "[{}] 题型快照不一致", n);

            total = ci_domain::round2(total + got.points);
            assert!(
                (total - step.expect.score_after).abs() < 1e-9,
                "[{}] 累计分数不一致：{} vs {}",
                n,
                total,
                step.expect.score_after
            );

            println!("  ✔ {} → base {} × {} = {}", n, got.base, got.ratio, got.points);
        }
    }

    println!("\n✅ 计分引擎：{} 组用例与 JS 参考实现逐步一致", fx.scoring.len());
}
