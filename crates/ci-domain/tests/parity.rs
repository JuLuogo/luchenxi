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
    draw_questions, finalize_feed, handle_cmd, question_stats, rollcall_pick, score_of_input,
    set_phase_named, validate_question, BankQuestion, ClassStudent, ClassTeam, CmdOutcome, DrawOpts,
    PickOpts, Question, RollcallSettings, Runtime, ScoreInput, ScoreRecord, ScoringSettings,
    StateStudent, Student, StudentCmd, Submission, TierStat,
};
use serde_json::json;
use serde::Deserialize;
use serde_json::Value;
use std::path::PathBuf;

#[derive(Debug, Deserialize)]
struct Fixture {
    ability: Vec<Case>,
    grading: Vec<GradeCase>,
    rollcall: Vec<RollCase>,
    scoring: Vec<ScoreCase>,
    classroom: Vec<ClassCase>,
    draw: Vec<DrawCase>,
    #[serde(rename = "questionStats")]
    question_stats: Vec<QsCase>,
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
    #[serde(default)]
    rank: Option<usize>,
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


#[derive(Debug, Deserialize)]
struct ClassCase {
    name: String,
    teams: Vec<ClassTeam>,
    students: Vec<ClassStudent>,
    q1: QRef,
    q2: QRef,
    #[serde(rename = "quizFirstQid")]
    quiz_first_qid: String,
    #[serde(rename = "bankFirstQid")]
    bank_first_qid: String,
    steps: Vec<ClassStep>,
}

#[derive(Debug, Deserialize)]
struct QRef {
    id: String,
    tier: String,
    options: Vec<String>,
    answer: String,
}

#[derive(Debug, Deserialize)]
struct ClassStep {
    #[serde(rename = "type")]
    step_type: String,
    #[serde(default)]
    phase: Option<String>,
    #[serde(default)]
    cmd: Option<CmdIn>,
    #[serde(rename = "questionRef", default)]
    question_ref: Option<String>,
    #[serde(rename = "answeredAlready", default)]
    answered_already: bool,
    expect: StepExpect,
}

#[derive(Debug, Deserialize)]
struct CmdIn {
    kind: String,
    #[serde(rename = "teamId", default)]
    team_id: Option<String>,
    #[serde(default)]
    sid: Option<String>,
    #[serde(default)]
    qid: Option<String>,
    #[serde(default)]
    choice: Vec<String>,
    #[serde(default)]
    text: String,
    #[serde(default)]
    skip: bool,
}

#[derive(Debug, Deserialize)]
struct StepExpect {
    #[serde(default)]
    phase: Option<String>,
    #[serde(default)]
    accepting: Option<bool>,
    #[serde(default)]
    qid: Option<String>,
    #[serde(default)]
    reveal: Option<bool>,
    #[serde(default)]
    outcome: Option<Value>,
    #[serde(rename = "feedText", default)]
    feed_text: Option<String>,
}


#[derive(Debug, Deserialize)]
struct DrawCase {
    name: String,
    bank: Vec<BankRow>,
    opts: DrawOpts,
    /// 固定随机序列（Rust 侧按同样顺序消耗）
    seq: Vec<f64>,
    expect: DrawExpect,
}

#[derive(Debug, Deserialize)]
struct BankRow {
    id: String,
    #[serde(default)]
    tier: String,
    /// 题干（题目统计用例里有；抽题用例里没有）
    #[serde(default)]
    stem: String,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    archived: bool,
}

#[derive(Debug, Deserialize)]
struct DrawExpect {
    ids: Vec<String>,
    #[serde(rename = "drawsUsed")]
    draws_used: usize,
}

#[derive(Debug, Deserialize)]
struct QsCase {
    name: String,
    #[serde(rename = "halfRatio")]
    half_ratio: f64,
    tiers: Vec<TierRow>,
    students: Vec<StudentRow>,
    bank: Vec<BankRow>,
    records: Vec<RecordRow>,
    expect: Vec<StatRow>,
}

#[derive(Debug, Deserialize)]
struct TierRow {
    key: String,
    label: String,
}

#[derive(Debug, Deserialize)]
struct StudentRow {
    id: String,
    name: String,
}

#[derive(Debug, Deserialize)]
struct RecordRow {
    #[serde(default)]
    sid: Option<String>,
    #[serde(default)]
    qid: Option<String>,
    #[serde(default)]
    tier: String,
    result: String,
    #[serde(default)]
    points: f64,
}

#[derive(Debug, Deserialize)]
struct StatRow {
    qid: String,
    stem: String,
    tier: String,
    #[serde(rename = "tierLabel")]
    tier_label: String,
    attempts: u32,
    correct: u32,
    half: u32,
    wrong: u32,
    skip: u32,
    #[serde(rename = "correctRate")]
    correct_rate: i64,
    #[serde(rename = "creditRate")]
    credit_rate: i64,
    #[serde(rename = "avgPoints")]
    avg_points: f64,
    missers: Vec<String>,
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
                rank: step.rank,
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

/// 课堂协同：环节切换序列 + 学生命令（入座/抢答去重/自动判分/主观题待确认/重复提交/空队），
/// 比对结果摘要与**实时流文案逐字相同**
#[test]
fn classroom_matches_js_reference() {
    let fx = load();
    assert!(!fx.classroom.is_empty(), "基准里没有课堂协同用例");

    for case in &fx.classroom {
        let mut rt = Runtime::default();
        let mut buzz: Vec<ci_domain::Buzz> = Vec::new();

        for (i, step) in case.steps.iter().enumerate() {
            let n = format!("{} #{}", case.name, i + 1);

            if step.step_type == "setPhase" {
                let name = step.phase.clone().unwrap_or_default();
                let got = set_phase_named(&mut rt, &name, Some(&case.quiz_first_qid), Some(&case.bank_first_qid));
                let e = &step.expect;
                if let Some(p) = &e.phase {
                    assert_eq!(got.as_str(), p.as_str(), "[{}] 环节不一致", n);
                }
                if let Some(a) = e.accepting {
                    assert_eq!(rt.accepting, a, "[{}] accepting 不一致", n);
                }
                if let Some(r) = e.reveal {
                    assert_eq!(rt.reveal, r, "[{}] reveal 不一致", n);
                }
                // 注意：qid 只在"出题且原本没题"时才会变，这里按 fixture 记录的现状比对
                if e.qid.is_some() && rt.qid.is_some() {
                    assert_eq!(rt.qid.as_deref(), e.qid.as_deref(), "[{}] 当前题不一致", n);
                }
                println!("  ✔ {} setPhase {} → {}", n, name, got.as_str());
                continue;
            }

            let cmd_in = step.cmd.as_ref().expect("cmd 步骤缺少 cmd");
            let question = match step.question_ref.as_deref() {
                Some("q1") => Some(Question {
                    options: case.q1.options.clone(),
                    answer: case.q1.answer.clone(),
                    tier: case.q1.tier.clone(),
                    points: None,
                }),
                Some("q2") => Some(Question {
                    options: case.q2.options.clone(),
                    answer: case.q2.answer.clone(),
                    tier: case.q2.tier.clone(),
                    points: None,
                }),
                _ => None,
            };
            let current_qid: Option<&str> = match step.question_ref.as_deref() {
                Some("q1") => Some(case.q1.id.as_str()),
                Some("q2") => Some(case.q2.id.as_str()),
                _ => None,
            };
            let cmd = StudentCmd {
                kind: cmd_in.kind.clone(),
                team_id: cmd_in.team_id.clone(),
                sid: cmd_in.sid.clone(),
                qid: cmd_in.qid.clone(),
                choice: cmd_in.choice.clone(),
                text: if cmd_in.text.is_empty() { None } else { Some(cmd_in.text.clone()) },
                skip: cmd_in.skip,
                backlog: false,
            };

            let r = handle_cmd(
                &cmd,
                &case.teams,
                &case.students,
                &rt,
                question.as_ref(),
                current_qid,
                step.answered_already,
                &buzz,
                0,
            );

            // 结果摘要（与 JS handleCmd 的返回值同形）
            let got_outcome = match &r.outcome {
                CmdOutcome::Ignored => json!({ "kind": "ignored" }),
                CmdOutcome::Hello { team_id } => json!({ "kind": "hello", "teamId": team_id }),
                CmdOutcome::Buzz { dup, .. } => json!({ "kind": "buzz", "dup": dup }),
                CmdOutcome::AnswerNoStudent { .. } => json!({ "kind": "answer", "ok": false, "reason": "no-student" }),
                CmdOutcome::AnswerDuplicate { .. } => json!({ "kind": "answer", "ok": false, "reason": "duplicate" }),
                CmdOutcome::AnswerPending { sid } => json!({ "kind": "answer", "ok": true, "result": "pending", "sid": sid }),
                CmdOutcome::AnswerScored { sid, result, .. } => {
                    json!({ "kind": "answer", "ok": true, "result": result, "sid": sid, "points": 0 })
                }
            };

            // 抢答要累积，否则下一步的去重判断就不成立
            if let Some(b) = &r.buzz {
                buzz.insert(0, b.clone());
            }

            // 自动判分的题：用计分引擎算出分数与文案
            let mut feed_text = r.feeds.first().map(|f| f.text.clone());
            if let Some(sc) = &r.score {
                let snap = score_of_input(
                    &default_tiers(),
                    &ScoringSettings::default(),
                    &ScoreInput {
                        sid: sc.sid.clone(),
                        qid: sc.qid.clone(),
                        question_tier: Some(sc.tier.clone()),
                        result: sc.result.clone(),
                        ..Default::default()
                    },
                );
                if let Some(want) = step.expect.outcome.as_ref().and_then(|o| o.get("points")).and_then(|x| x.as_f64()) {
                    assert!((snap.points - want).abs() < 1e-9, "[{}] 分数不一致：{} vs {}", n, snap.points, want);
                }
                if let Some(f) = r.feeds.first() {
                    let mut f = f.clone();
                    finalize_feed(&mut f, &snap, &case.students);
                    feed_text = Some(f.text);
                }
            }

            if let Some(want) = &step.expect.outcome {
                let wo = want.clone();
                // points 已单独比对过，这里比对其它字段
                for key in ["kind", "ok", "reason", "result", "sid", "dup", "teamId"] {
                    let w = wo.get(key);
                    let g = got_outcome.get(key);
                    if w.is_some() || g.is_some() {
                        assert_eq!(g, w, "[{}] 结果字段 {} 不一致", n, key);
                    }
                }
            }
            if let Some(want_text) = &step.expect.feed_text {
                assert_eq!(
                    feed_text.as_deref(),
                    Some(want_text.as_str()),
                    "[{}] 实时流文案不一致",
                    n
                );
            } else {
                assert!(feed_text.is_none(), "[{}] 不该写实时流，实际写了：{:?}", n, feed_text);
            }

            println!("  ✔ {} {} → {}", n, cmd.kind, feed_text.unwrap_or_else(|| "（不写流）".to_string()));
        }
    }

    println!("\n✅ 课堂协同：{} 组用例与 JS 参考实现逐步一致", fx.classroom.len());
}

/// 随机抽题：同一份题库 + 同一串固定随机数 → 必须抽出同一批题，
/// 且**消耗的随机数个数**也要一致（洗牌次数决定序列对齐，这是 parity 的命门）
#[test]
fn draw_matches_js_reference() {
    let fx = load();
    assert!(!fx.draw.is_empty(), "基准里没有抽题用例");

    for case in &fx.draw {
        let bank: Vec<BankQuestion> = case
            .bank
            .iter()
            .map(|r| BankQuestion {
                id: r.id.clone(),
                tier: r.tier.clone(),
                tags: r.tags.clone(),
                archived: r.archived,
                ..Default::default()
            })
            .collect();

        let seq = case.seq.clone();
        let mut used = 0usize;
        let got = draw_questions(&bank, &case.opts, || {
            let v = seq[used % seq.len()];
            used += 1;
            v
        });

        assert_eq!(got, case.expect.ids, "[{}] 抽到的题不一致", case.name);
        assert_eq!(used, case.expect.draws_used, "[{}] 消耗的随机数个数不一致", case.name);
        println!("  ✔ {} → 抽 {} 道（消耗 {} 次随机）", case.name, got.len(), used);
    }

    println!("\n✅ 随机抽题：{} 组用例与 JS 参考实现一致", fx.draw.len());
}

/// 按题目的作答统计：逐字段比对（作答数/判定分布/正确率/掌握度/平均分/答错人名/排序）
#[test]
fn question_stats_matches_js_reference() {
    let fx = load();
    assert!(!fx.question_stats.is_empty(), "基准里没有题目统计用例");

    for case in &fx.question_stats {
        let bank: Vec<BankQuestion> = case
            .bank
            .iter()
            .map(|r| BankQuestion {
                id: r.id.clone(),
                tier: r.tier.clone(),
                stem: r.stem.clone(),
                ..Default::default()
            })
            .collect();
        let students: Vec<StateStudent> = case
            .students
            .iter()
            .map(|s| StateStudent {
                id: s.id.clone(),
                name: s.name.clone(),
                team_id: None,
                active: true,
                joined_at: 0,
                called: 0,
            })
            .collect();
        let records: Vec<ScoreRecord> = case
            .records
            .iter()
            .enumerate()
            .map(|(i, r)| ScoreRecord {
                id: format!("r{}", i + 1),
                sid: r.sid.clone(),
                qid: r.qid.clone(),
                tier: r.tier.clone(),
                quiz_id: None,
                result: r.result.clone(),
                base: 0.0,
                ratio: 0.0,
                points: r.points,
                source: "student".to_string(),
                note: String::new(),
                at: i as i64,
                by: String::new(),
            })
            .collect();
        let labels: Vec<(String, String)> = case
            .tiers
            .iter()
            .map(|t| (t.key.clone(), t.label.clone()))
            .collect();

        let got = question_stats(&records, &bank, &students, &labels, case.half_ratio);
        assert_eq!(got.len(), case.expect.len(), "[{}] 题目数不一致", case.name);

        for (i, want) in case.expect.iter().enumerate() {
            let g = &got[i];
            let n = format!("{} #{}", case.name, i + 1);
            assert_eq!(g.qid, want.qid, "[{}] qid", n);
            assert_eq!(g.stem, want.stem, "[{}] 题干", n);
            assert_eq!(g.tier, want.tier, "[{}] 题型", n);
            assert_eq!(g.tier_label, want.tier_label, "[{}] 题型中文名", n);
            assert_eq!(g.attempts, want.attempts, "[{}] 作答次数", n);
            assert_eq!(g.correct, want.correct, "[{}] 答对", n);
            assert_eq!(g.half, want.half, "[{}] 半对", n);
            assert_eq!(g.wrong, want.wrong, "[{}] 答错", n);
            assert_eq!(g.skip, want.skip, "[{}] 跳过", n);
            assert_eq!(g.correct_rate, want.correct_rate, "[{}] 正确率", n);
            assert_eq!(g.credit_rate, want.credit_rate, "[{}] 掌握度", n);
            assert!((g.avg_points - want.avg_points).abs() < 1e-9, "[{}] 平均分", n);
            assert_eq!(g.missers, want.missers, "[{}] 答错/跳过人名", n);
            println!("  ✔ {} → {} 人作答 / 正确率 {}%", n, g.attempts, g.correct_rate);
        }
    }

    println!("\n✅ 题目统计：{} 组用例与 JS 参考实现逐字段一致", fx.question_stats.len());
}
