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

use ci_domain::state::ClassroomState;
use ci_domain::{
    type_label, type_of,
    default_open_levels, evaluate_open_full, levels_are_valid, levels_from_labels, open_rate, show_on_stage,
    ability_of_tiers, answer_key, apply_pick, trend, auto, build_report, decayed_rate, evaluate, growth_score,
    default_open_dimensions, evaluate_open,
    option_distribution, participation_rate, polish_prompt, sanitize_polish, student_stats, student_view,
    POLISH_RULES, class_stats, ranking, team_ranking, default_tiers, describe_submission,
    draw_questions, finalize_feed, handle_cmd, mistake_board, question_stats, report_markdown,
    rollcall_pick, score_of_input, set_phase_named, student_mistakes, validate_question, BankQuestion,
    Checkin, ClassStudent, ClassTeam, CmdOutcome, DrawOpts, PickOpts, Question, RollcallSettings,
    EvalWeights, ReportInput, Runtime, TrendBucket, TrendOpts, ScoreInput, ScoreRecord, ScoringSettings, StateStudent, Student,
    StudentCmd, Submission, Team, TeamStat, TierStat,
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
    mistakes: Vec<MistakeCase>,
    report: Vec<ReportCase>,
    composite: CompositeCases,
    #[serde(rename = "optionDist")]
    option_dist: Vec<OptionDistCase>,
    stats: Vec<StatsCase>,
    view: Vec<ViewCase>,
    openclass: Vec<OpenCase>,
    polish: Vec<PolishCase>,
    #[serde(rename = "stagePolicy")]
    stage_policy: Vec<PolicyCase>,
    levels: Vec<LevelCase>,
    #[serde(rename = "levelValidity")]
    level_validity: Vec<ValidityCase>,
    #[serde(rename = "questionType")]
    question_type: Vec<TypeCase>,
    trend: Vec<TrendCase>,
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
    #[serde(default)]
    ratio: f64,
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
    #[serde(default)]
    ratio: Option<f64>,
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


#[derive(Debug, Deserialize)]
struct MistakeCase {
    name: String,
    #[serde(rename = "halfRatio")]
    half_ratio: f64,
    tiers: Vec<TierRow>,
    students: Vec<MistakeStudentRow>,
    teams: Vec<TeamRow>,
    bank: Vec<MistakeBankRow>,
    records: Vec<MistakeRecordRow>,
    who: String,
    #[serde(rename = "expectOne")]
    expect_one: MistakeExpect,
    #[serde(rename = "expectBoard")]
    expect_board: Vec<MistakeExpect>,
}

#[derive(Debug, Deserialize)]
struct MistakeStudentRow {
    id: String,
    name: String,
    #[serde(rename = "teamId")]
    team_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TeamRow {
    id: String,
    name: String,
}

#[derive(Debug, Deserialize)]
struct MistakeBankRow {
    id: String,
    #[serde(default)]
    tier: String,
    #[serde(default)]
    stem: String,
    #[serde(default)]
    answer: String,
    #[serde(default)]
    options: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct MistakeRecordRow {
    #[serde(default)]
    sid: Option<String>,
    #[serde(default)]
    qid: Option<String>,
    #[serde(default)]
    result: String,
    #[serde(default)]
    points: f64,
    #[serde(default)]
    note: String,
    #[serde(default)]
    at: i64,
}

#[derive(Debug, Deserialize)]
struct MistakeExpect {
    sid: String,
    name: String,
    #[serde(rename = "teamName")]
    team_name: String,
    tiers: Vec<String>,
    items: Vec<MistakeItemRow>,
}

#[derive(Debug, Deserialize)]
struct MistakeItemRow {
    qid: String,
    stem: String,
    tier: String,
    #[serde(rename = "tierLabel")]
    tier_label: String,
    result: String,
    answer: String,
    expected: String,
    at: i64,
    count: u32,
}

#[derive(Debug, Deserialize)]
struct ReportCase {
    name: String,
    input: ReportInputRow,
    expect: ReportExpect,
}

#[derive(Debug, Deserialize)]
struct ReportInputRow {
    #[serde(rename = "courseName")]
    course_name: String,
    room: String,
    #[serde(rename = "generatedAt")]
    generated_at: i64,
    checkin: CheckinRow,
    records: Vec<ReportRecordRow>,
    students: Vec<MistakeStudentRow>,
    teams: Vec<TeamRow>,
    tiers: Vec<ReportTierRow>,
    #[serde(rename = "teamStats")]
    team_stats: Vec<ReportTeamRow>,
    questions: Vec<ReportQuestionRow>,
    comment: String,
    #[serde(rename = "reviewLine")]
    review_line: String,
    #[serde(rename = "halfRatio")]
    half_ratio: f64,
    #[serde(rename = "weakThreshold", default = "default_weak")]
    weak_threshold: f64,
}

fn default_weak() -> f64 {
    0.6
}

#[derive(Debug, Deserialize)]
struct CheckinRow {
    seated: u32,
    total: u32,
    rate: i64,
}

#[derive(Debug, Deserialize)]
struct ReportRecordRow {
    #[serde(default)]
    sid: Option<String>,
    #[serde(default)]
    qid: Option<String>,
    result: String,
    #[serde(default)]
    points: f64,
}

#[derive(Debug, Deserialize)]
struct ReportTierRow {
    key: String,
    label: String,
    attempts: u32,
    correct: u32,
    #[serde(rename = "creditRate")]
    credit_rate: f64,
    #[serde(rename = "correctRate")]
    correct_rate: f64,
}

#[derive(Debug, Deserialize)]
struct ReportTeamRow {
    #[serde(rename = "teamId")]
    team_id: String,
    name: String,
    correct: u32,
    attempts: u32,
    #[serde(rename = "creditRate")]
    credit_rate: f64,
    #[serde(default)]
    score: Option<f64>,
    #[serde(rename = "memberCount")]
    member_count: usize,
}

#[derive(Debug, Deserialize)]
struct ReportQuestionRow {
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

#[derive(Debug, Deserialize)]
struct ReportExpect {
    attempts: u32,
    correct: u32,
    half: u32,
    wrong: u32,
    skip: u32,
    #[serde(rename = "creditRate")]
    credit_rate: i64,
    earned: f64,
    students: Vec<ReportStudentRow>,
    markdown: String,
}

#[derive(Debug, Deserialize)]
struct ReportStudentRow {
    sid: String,
    name: String,
    #[serde(rename = "teamName")]
    team_name: String,
    score: f64,
    attempts: u32,
    correct: u32,
    #[serde(rename = "creditRate")]
    credit_rate: i64,
}


#[derive(Debug, Deserialize)]
struct CompositeCases {
    participation: Vec<ParticipationCase>,
    growth: Vec<GrowthCase>,
    decayed: Vec<DecayedCase>,
    evaluate: Vec<EvaluateCase>,
}

#[derive(Debug, Deserialize)]
struct ParticipationCase {
    name: String,
    answered: u32,
    total: u32,
    expect: i64,
}

#[derive(Debug, Deserialize)]
struct GrowthCase {
    name: String,
    early: i64,
    late: i64,
    enough: bool,
    expect: i64,
}

#[derive(Debug, Deserialize)]
struct DecayedCase {
    name: String,
    records: Vec<CompositeRecordRow>,
    #[serde(rename = "halfRatio")]
    half_ratio: f64,
    decay: f64,
    expect: i64,
}

#[derive(Debug, Deserialize)]
struct CompositeRecordRow {
    result: String,
    #[serde(default)]
    at: i64,
}

#[derive(Debug, Deserialize)]
struct EvaluateCase {
    name: String,
    mastery: i64,
    participation: i64,
    growth: i64,
    #[serde(rename = "growthValid")]
    growth_valid: bool,
    weights: EvalWeights,
    expect: EvaluateExpect,
}

#[derive(Debug, Deserialize)]
struct EvaluateExpect {
    total: i64,
    #[serde(rename = "weightUsed")]
    weight_used: f64,
    parts: Vec<EvalPartRow>,
}

#[derive(Debug, Deserialize)]
struct EvalPartRow {
    key: String,
    value: i64,
    weight: f64,
    contribution: f64,
    valid: bool,
}


#[derive(Debug, Deserialize)]
struct OptionDistCase {
    name: String,
    options: Vec<String>,
    answer: String,
    records: Vec<OptionDistRecord>,
    expect: Vec<OptionDistRow>,
}

#[derive(Debug, Deserialize)]
struct OptionDistRecord {
    #[serde(default)]
    picked: String,
    result: String,
}

#[derive(Debug, Deserialize)]
struct OptionDistRow {
    key: String,
    text: String,
    count: u32,
    rate: i64,
    correct: bool,
}


/* ---------- 学情统计（analysis.js::studentStats / classStats / ranking / teamRanking）---------- */

#[derive(Debug, Deserialize)]
struct StatsCase {
    name: String,
    students: Vec<StatsStudent>,
    teams: Vec<StatsTeam>,
    bank: Vec<StatsQuestion>,
    quizzes: Vec<StatsQuiz>,
    settings: StatsSettings,
    expect: StatsExpect,
}

#[derive(Debug, Deserialize)]
struct StatsStudent {
    id: String,
    name: String,
    #[serde(rename = "teamId")]
    team_id: Option<String>,
    active: bool,
}

#[derive(Debug, Deserialize)]
struct StatsTeam {
    id: String,
    name: String,
}

#[derive(Debug, Deserialize)]
struct StatsQuestion {
    id: String,
    tier: String,
    #[serde(default)]
    tags: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct StatsQuiz {
    id: String,
    records: Vec<StatsRecord>,
}

#[derive(Debug, Deserialize)]
struct StatsRecord {
    sid: String,
    qid: Option<String>,
    tier: String,
    result: String,
    #[serde(rename = "quizId")]
    quiz_id: Option<String>,
    points: f64,
    base: f64,
    at: i64,
    #[serde(default)]
    source: String,
}

#[derive(Debug, Deserialize)]
struct StatsSettings {
    #[serde(rename = "halfRatio")]
    half_ratio: f64,
    #[serde(rename = "minSample")]
    min_sample: i64,
    #[serde(rename = "weakThreshold")]
    weak_threshold: f64,
    #[serde(rename = "strongThreshold")]
    strong_threshold: f64,
}

#[derive(Debug, Deserialize)]
struct StatsExpect {
    all: Option<StatsStudentOut>,
    z1: Option<StatsStudentOut>,
    z2: Option<StatsStudentOut>,
    other: Option<StatsStudentOut>,
    #[serde(rename = "rankAll")]
    rank_all: Vec<StatsRankOut>,
    #[serde(rename = "rankZ1")]
    rank_z1: Vec<StatsRankOut>,
    #[serde(rename = "classAll")]
    class_all: StatsClassOut,
    #[serde(rename = "classZ1")]
    class_z1: StatsClassOut,
    team: Vec<StatsTeamOut>,
}

#[derive(Debug, Deserialize)]
struct StatsStudentOut {
    sid: String,
    name: String,
    #[serde(rename = "teamName")]
    team_name: String,
    score: f64,
    attempts: u32,
    correct: u32,
    half: u32,
    #[serde(rename = "creditRate")]
    credit_rate: f64,
    #[serde(rename = "correctRate")]
    correct_rate: f64,
    rolls: u32,
    #[serde(rename = "lastAt")]
    last_at: i64,
    weak: Vec<String>,
    strong: Vec<String>,
    level: String,
    #[serde(rename = "tierKeys")]
    tier_keys: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct StatsRankOut {
    sid: String,
    name: String,
    score: f64,
    attempts: u32,
    correct: u32,
    #[serde(rename = "creditRate")]
    credit_rate: f64,
    rank: u32,
    level: String,
    #[serde(rename = "weakCount")]
    weak_count: u32,
}

#[derive(Debug, Deserialize)]
struct StatsClassOut {
    #[serde(rename = "teamId")]
    team_id: String,
    #[serde(rename = "studentCount")]
    student_count: u32,
    participants: u32,
    attempts: u32,
    correct: u32,
    #[serde(rename = "creditRate")]
    credit_rate: f64,
    #[serde(rename = "weakTiers")]
    weak_tiers: Vec<String>,
    #[serde(rename = "needHelp")]
    need_help: Vec<String>,
    #[serde(rename = "rankAttempts")]
    rank_attempts: Vec<u32>,
}

#[derive(Debug, Deserialize)]
struct StatsTeamOut {
    #[serde(rename = "teamId")]
    team_id: String,
    score: f64,
    #[serde(rename = "memberCount")]
    member_count: u32,
    avg: f64,
    attempts: u32,
}


/* ---------- 学生可见视图（classroom.js::studentView）---------- */

#[derive(Debug, Deserialize)]
struct ViewCase {
    name: String,
    question: ViewQuestion,
    #[serde(rename = "tierLabel")]
    tier_label: String,
    points: f64,
    revealed: bool,
    expect: Option<ViewExpect>,
}

#[derive(Debug, Deserialize)]
struct ViewQuestion {
    id: String,
    tier: String,
    stem: String,
    answer: String,
    options: Vec<String>,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    note: String,
    #[serde(rename = "imageUrl", default)]
    image_url: String,
}

#[derive(Debug, Deserialize)]
struct ViewExpect {
    id: String,
    stem: String,
    #[serde(rename = "fullStem")]
    full_stem: String,
    #[serde(rename = "imageUrl")]
    image_url: String,
    tier: String,
    #[serde(rename = "tierLabel")]
    tier_label: String,
    points: f64,
    multiple: bool,
    options: Vec<ViewOption>,
    #[serde(rename = "hasAnswer")]
    has_answer: bool,
    #[serde(rename = "answerKey")]
    answer_key: Option<String>,
    explanation: String,
    tags: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct ViewOption {
    key: String,
    text: String,
}


/* ---------- 公开课现场评价量规（openclass.js）---------- */

#[derive(Debug, Deserialize)]
struct OpenCase {
    name: String,
    scores: Vec<OpenScoreIn>,
    expect: OpenExpect,
}

#[derive(Debug, Deserialize)]
struct OpenScoreIn {
    key: String,
    score: u8,
}

#[derive(Debug, Deserialize)]
struct OpenExpect {
    total: i64,
    level: String,
    #[serde(rename = "weightUsed")]
    weight_used: f64,
    strongest: Option<String>,
    weakest: Option<String>,
    comment: String,
    parts: Vec<OpenPartOut>,
}

#[derive(Debug, Deserialize)]
struct OpenPartOut {
    key: String,
    label: String,
    weight: f64,
    score: u8,
    level: String,
    rate: f64,
    contribution: f64,
}


/* ---------- AI 润色提示词（polish.js）---------- */

#[derive(Debug, Deserialize)]
struct PolishCase {
    name: String,
    evaluation: ci_domain::openclass::OpenEvaluation,
    expect: PolishExpect,
}

#[derive(Debug, Deserialize)]
struct PolishExpect {
    prompt: String,
    sanitized: Vec<String>,
}


/* ---------- 大屏公开展示策略 ---------- */

#[derive(Debug, Deserialize)]
struct PolicyCase {
    total: i64,
    policy: String,
    expect: bool,
}


/* ---------- 档位可配置 ---------- */

#[derive(Debug, Deserialize)]
struct LevelCase {
    name: String,
    labels: Option<Vec<String>>,
    levels: Vec<ci_domain::openclass::OpenLevel>,
    rows: Vec<LevelRow>,
}

#[derive(Debug, Deserialize)]
struct LevelRow {
    score: u8,
    total: i64,
    level: String,
    #[serde(rename = "partLevel")]
    part_level: String,
    rate: f64,
}


#[derive(Debug, Deserialize)]
struct ValidityCase {
    name: String,
    levels: Vec<ci_domain::openclass::OpenLevel>,
    expect: bool,
}


#[derive(Debug, Deserialize)]
struct TypeCase {
    name: String,
    options: Vec<String>,
    answer: String,
    #[serde(rename = "expectType")]
    expect_type: String,
    #[serde(rename = "expectLabel")]
    expect_label: String,
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
                // 部分得分系数：多答案题按命中比例算，漏 1 个与漏 3 个必须不同分
                assert!(
                    (got.ratio - want.ratio).abs() < 1e-9,
                    "[{}] 部分得分系数不一致：Rust {} vs JS {}",
                    n,
                    got.ratio,
                    want.ratio
                );
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
                ratio: step.ratio,
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
                picked: String::new(),
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

/// 错题本：逐字段比对（次数/最后一次提交/标准答案/题型/排序）
#[test]
fn mistakes_match_js_reference() {
    let fx = load();
    assert!(!fx.mistakes.is_empty(), "基准里没有错题本用例");

    for case in &fx.mistakes {
        let bank: Vec<BankQuestion> = case
            .bank
            .iter()
            .map(|r| BankQuestion {
                id: r.id.clone(),
                tier: r.tier.clone(),
                stem: r.stem.clone(),
                answer: r.answer.clone(),
                options: r.options.clone(),
                ..Default::default()
            })
            .collect();
        let students: Vec<StateStudent> = case
            .students
            .iter()
            .map(|s| StateStudent {
                id: s.id.clone(),
                name: s.name.clone(),
                team_id: s.team_id.clone(),
                active: true,
                joined_at: 0,
                called: 0,
            })
            .collect();
        let teams: Vec<Team> = case
            .teams
            .iter()
            .map(|t| Team {
                id: t.id.clone(),
                name: t.name.clone(),
                icon: String::new(),
                color: String::new(),
                order: 0,
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
                tier: String::new(),
                quiz_id: None,
                result: r.result.clone(),
                base: 0.0,
                ratio: 0.0,
                points: r.points,
                source: "student".to_string(),
                note: r.note.clone(),
                picked: String::new(),
                at: r.at,
                by: String::new(),
            })
            .collect();
        let labels: Vec<(String, String)> = case
            .tiers
            .iter()
            .map(|t| (t.key.clone(), t.label.clone()))
            .collect();

        // 单人
        let one = student_mistakes(&records, &bank, &students, &teams, &labels, &case.who);
        assert_eq!(one.sid, case.expect_one.sid, "[{}] sid", case.name);
        assert_eq!(one.name, case.expect_one.name, "[{}] 姓名", case.name);
        assert_eq!(one.team_name, case.expect_one.team_name, "[{}] 队伍", case.name);
        assert_eq!(one.tiers, case.expect_one.tiers, "[{}] 涉及题型", case.name);
        assert_eq!(one.items.len(), case.expect_one.items.len(), "[{}] 错题道数", case.name);
        for (i, want) in case.expect_one.items.iter().enumerate() {
            let g = &one.items[i];
            let n = format!("{} #{}", case.name, i + 1);
            assert_eq!(g.qid, want.qid, "[{}] qid", n);
            assert_eq!(g.stem, want.stem, "[{}] 题干", n);
            assert_eq!(g.tier, want.tier, "[{}] 题型", n);
            assert_eq!(g.tier_label, want.tier_label, "[{}] 题型中文名", n);
            assert_eq!(g.result, want.result, "[{}] 最后一次判定", n);
            assert_eq!(g.answer, want.answer, "[{}] 最后一次提交", n);
            assert_eq!(g.expected, want.expected, "[{}] 标准答案", n);
            assert_eq!(g.at, want.at, "[{}] 最后一次时间", n);
            assert_eq!(g.count, want.count, "[{}] 错误次数", n);
        }

        // 全班榜
        let board = mistake_board(&records, &bank, &students, &teams, &labels);
        assert_eq!(board.len(), case.expect_board.len(), "[{}] 榜上人数", case.name);
        for (i, want) in case.expect_board.iter().enumerate() {
            assert_eq!(board[i].sid, want.sid, "[{}] 榜 #{} sid", case.name, i + 1);
            assert_eq!(board[i].name, want.name, "[{}] 榜 #{} 姓名", case.name, i + 1);
            assert_eq!(board[i].items.len(), want.items.len(), "[{}] 榜 #{} 错题数", case.name, i + 1);
        }
        println!("  ✔ {} → {} 道错题，榜上 {} 人", case.name, one.items.len(), board.len());
    }

    println!("\n✅ 错题本：{} 组用例与 JS 参考实现逐字段一致", fx.mistakes.len());
}

/// 课后课堂报告：汇总字段 + **Markdown 逐行**比对
#[test]
fn report_matches_js_reference() {
    let fx = load();
    assert!(!fx.report.is_empty(), "基准里没有报告用例");

    for case in &fx.report {
        let i = &case.input;
        let records: Vec<ScoreRecord> = i
            .records
            .iter()
            .enumerate()
            .map(|(k, r)| ScoreRecord {
                id: format!("r{}", k + 1),
                sid: r.sid.clone(),
                qid: r.qid.clone(),
                tier: String::new(),
                quiz_id: None,
                result: r.result.clone(),
                base: 0.0,
                ratio: 0.0,
                points: r.points,
                source: "student".to_string(),
                note: String::new(),
                picked: String::new(),
                at: k as i64,
                by: String::new(),
            })
            .collect();
        let students: Vec<StateStudent> = i
            .students
            .iter()
            .map(|s| StateStudent {
                id: s.id.clone(),
                name: s.name.clone(),
                team_id: s.team_id.clone(),
                active: true,
                joined_at: 0,
                called: 0,
            })
            .collect();
        let teams: Vec<Team> = i
            .teams
            .iter()
            .map(|t| Team {
                id: t.id.clone(),
                name: t.name.clone(),
                icon: String::new(),
                color: String::new(),
                order: 0,
            })
            .collect();
        let tiers: Vec<TierStat> = i
            .tiers
            .iter()
            .map(|t| TierStat {
                key: t.key.clone(),
                label: t.label.clone(),
                color: String::new(),
                weight: 0.0,
                attempts: t.attempts,
                correct: t.correct,
                credit_rate: t.credit_rate,
                correct_rate: t.correct_rate,
            })
            .collect();
        let team_stats: Vec<TeamStat> = i
            .team_stats
            .iter()
            .map(|t| TeamStat {
                team_id: t.team_id.clone(),
                name: t.name.clone(),
                color: String::new(),
                icon: String::new(),
                correct: t.correct,
                attempts: t.attempts,
                credit_rate: t.credit_rate,
                score: t.score,
                member_count: t.member_count,
            })
            .collect();
        let questions: Vec<ci_domain::QuestionStat> = i
            .questions
            .iter()
            .map(|q| ci_domain::QuestionStat {
                qid: q.qid.clone(),
                stem: q.stem.clone(),
                tier: q.tier.clone(),
                tier_label: q.tier_label.clone(),
                attempts: q.attempts,
                correct: q.correct,
                half: q.half,
                wrong: q.wrong,
                skip: q.skip,
                correct_rate: q.correct_rate,
                credit_rate: q.credit_rate,
                avg_points: q.avg_points,
                missers: q.missers.clone(),
            })
            .collect();

        let r = build_report(ReportInput {
            course_name: i.course_name.clone(),
            room: i.room.clone(),
            generated_at: i.generated_at,
            checkin: Checkin { seated: i.checkin.seated, total: i.checkin.total, rate: i.checkin.rate },
            records,
            students,
            teams,
            tiers,
            team_stats,
            questions,
            comment: i.comment.clone(),
            review_line: i.review_line.clone(),
            half_ratio: i.half_ratio,
            weak_threshold: i.weak_threshold,
        });

        let n = &case.name;
        assert_eq!(r.attempts, case.expect.attempts, "[{}] 作答数", n);
        assert_eq!(r.correct, case.expect.correct, "[{}] 答对", n);
        assert_eq!(r.half, case.expect.half, "[{}] 半对", n);
        assert_eq!(r.wrong, case.expect.wrong, "[{}] 答错", n);
        assert_eq!(r.skip, case.expect.skip, "[{}] 跳过", n);
        assert_eq!(r.credit_rate, case.expect.credit_rate, "[{}] 掌握度", n);
        assert!((r.earned - case.expect.earned).abs() < 1e-9, "[{}] 累计得分", n);
        assert_eq!(r.students.len(), case.expect.students.len(), "[{}] 学生数", n);
        for (k, want) in case.expect.students.iter().enumerate() {
            let g = &r.students[k];
            assert_eq!(g.sid, want.sid, "[{}] 学生 #{} sid", n, k + 1);
            assert_eq!(g.name, want.name, "[{}] 学生 #{} 姓名", n, k + 1);
            assert_eq!(g.team_name, want.team_name, "[{}] 学生 #{} 队伍", n, k + 1);
            assert!((g.score - want.score).abs() < 1e-9, "[{}] 学生 #{} 积分", n, k + 1);
            assert_eq!(g.attempts, want.attempts, "[{}] 学生 #{} 作答", n, k + 1);
            assert_eq!(g.correct, want.correct, "[{}] 学生 #{} 答对", n, k + 1);
            assert_eq!(g.credit_rate, want.credit_rate, "[{}] 学生 #{} 掌握度", n, k + 1);
        }

        // Markdown 逐行比对
        let md = report_markdown(&r);
        let got: Vec<&str> = md.lines().collect();
        let want: Vec<&str> = case.expect.markdown.lines().collect();
        assert_eq!(got.len(), want.len(), "[{}] Markdown 行数", n);
        for (k, (a, b)) in got.iter().zip(want.iter()).enumerate() {
            assert_eq!(a, b, "[{}] Markdown 第 {} 行不一致", n, k + 1);
        }
        println!("  ✔ {} → {} 行 Markdown 逐行一致", n, got.len());
    }

    println!("\n✅ 课后课堂报告：{} 组用例与 JS 参考实现逐行一致", fx.report.len());
}

/// 多维度评价：参与度 / 进步 / 衰减平均掌握度 / 三维加权（含失效维度重归一）
#[test]
fn composite_matches_js_reference() {
    let fx = load();
    let c = &fx.composite;

    // 参与度
    for case in &c.participation {
        let got = participation_rate(case.answered, case.total);
        assert_eq!(got, case.expect, "[{}] 参与度", case.name);
    }
    println!("  ✔ 参与度 {} 组", c.participation.len());

    // 进步
    for case in &c.growth {
        let got = growth_score(case.early, case.late, case.enough);
        assert_eq!(got, case.expect, "[{}] 进步分", case.name);
    }
    println!("  ✔ 进步 {} 组", c.growth.len());

    // 衰减平均掌握度
    for case in &c.decayed {
        let records: Vec<ScoreRecord> = case
            .records
            .iter()
            .enumerate()
            .map(|(i, r)| ScoreRecord {
                id: format!("r{}", i + 1),
                sid: Some("s1".into()),
                qid: Some("q1".into()),
                tier: "basic".into(),
                quiz_id: None,
                result: r.result.clone(),
                base: 0.0,
                ratio: 0.0,
                points: 0.0,
                source: "student".into(),
                note: String::new(),
                picked: String::new(),
                at: if r.at == 0 { i as i64 + 1 } else { r.at },
                by: String::new(),
            })
            .collect();
        let got = decayed_rate(&records, case.half_ratio, case.decay);
        assert_eq!(got, case.expect, "[{}] 衰减平均掌握度", case.name);
    }
    println!("  ✔ 衰减平均掌握度 {} 组", c.decayed.len());

    // 三维加权
    for case in &c.evaluate {
        let got = evaluate(case.mastery, case.participation, case.growth, case.growth_valid, &case.weights);
        let n = &case.name;
        assert_eq!(got.total, case.expect.total, "[{}] 综合分", n);
        assert!(
            (got.weight_used - case.expect.weight_used).abs() < 1e-9,
            "[{}] 有效权重：{} vs {}",
            n,
            got.weight_used,
            case.expect.weight_used
        );
        assert_eq!(got.parts.len(), case.expect.parts.len(), "[{}] 维度数", n);
        for (i, want) in case.expect.parts.iter().enumerate() {
            let g = &got.parts[i];
            assert_eq!(g.key, want.key, "[{}] 维度 #{} key", n, i + 1);
            assert_eq!(g.value, want.value, "[{}] 维度 #{} 原始值", n, i + 1);
            assert!((g.weight - want.weight).abs() < 1e-9, "[{}] 维度 #{} 权重", n, i + 1);
            assert!(
                (g.contribution - want.contribution).abs() < 1e-9,
                "[{}] 维度 #{} 贡献分：{} vs {}",
                n,
                i + 1,
                g.contribution,
                want.contribution
            );
            assert_eq!(g.valid, want.valid, "[{}] 维度 #{} 是否有效", n, i + 1);
        }
    }
    println!("  ✔ 三维加权 {} 组", c.evaluate.len());

    println!("\n✅ 多维度评价：{} 组用例与 JS 参考实现逐字段一致",
        c.participation.len() + c.growth.len() + c.decayed.len() + c.evaluate.len());
}

/// 选项分布：每个选项多少人选（分母只算作答者，跳过不进分母）
#[test]
fn option_dist_matches_js_reference() {
    let fx = load();
    assert!(!fx.option_dist.is_empty(), "基准里没有选项分布用例");
    for case in &fx.option_dist {
        let q = BankQuestion {
            id: "q1".into(),
            tier: "basic".into(),
            stem: "选一选".into(),
            answer: case.answer.clone(),
            options: case.options.clone(),
            ..Default::default()
        };
        let records: Vec<ScoreRecord> = case
            .records
            .iter()
            .enumerate()
            .map(|(i, r)| ScoreRecord {
                id: format!("r{}", i + 1),
                sid: Some("s1".into()),
                qid: Some("q1".into()),
                tier: "basic".into(),
                quiz_id: None,
                result: r.result.clone(),
                base: 0.0,
                ratio: 0.0,
                points: 0.0,
                source: "student".into(),
                note: String::new(),
                picked: r.picked.clone(),
                at: i as i64 + 1,
                by: String::new(),
            })
            .collect();
        let got = option_distribution(&records, &q);
        assert_eq!(got.len(), case.expect.len(), "[{}] 选项数", case.name);
        for (i, want) in case.expect.iter().enumerate() {
            let g = &got[i];
            let n = format!("{} #{}", case.name, i + 1);
            assert_eq!(g.key, want.key, "[{}] 选项字母", n);
            assert_eq!(g.text, want.text, "[{}] 选项文本", n);
            assert_eq!(g.count, want.count, "[{}] 选择人数", n);
            assert_eq!(g.rate, want.rate, "[{}] 占比", n);
            assert_eq!(g.correct, want.correct, "[{}] 是否正确项", n);
        }
        println!("  ✔ {} → {}", case.name, got.iter().map(|o| format!("{} {}%", o.key, o.rate)).collect::<Vec<_>>().join(" / "));
    }
    println!("\n✅ 选项分布：{} 组用例与 JS 参考实现逐字段一致", fx.option_dist.len());
}

/// 学情统计：把基准里的最小状态搭出来，跑 Rust 实现，逐字段与 JS 参考实现比
///
/// 重点比 **数据范围（quizId）是否贯穿**：JS 版曾经漏传 opts，
/// 于是"只看本节课"只管得住汇总、管不住学生榜（汇总 1 次、榜上 2 次）。
#[test]
fn stats_matches_js_reference() {
    let fx = load();
    assert!(!fx.stats.is_empty(), "基准里没有学情统计用例");
    for case in &fx.stats {
        let mut s = ClassroomState::default();
        s.settings.half_ratio = case.settings.half_ratio;
        s.settings.min_sample = case.settings.min_sample;
        s.settings.weak_threshold = case.settings.weak_threshold;
        s.settings.strong_threshold = case.settings.strong_threshold;
        s.teams = case
            .teams
            .iter()
            .enumerate()
            .map(|(i, t)| ci_domain::state::Team {
                id: t.id.clone(),
                name: t.name.clone(),
                icon: String::new(),
                color: String::new(),
                order: i as i64,
            })
            .collect();
        s.students = case
            .students
            .iter()
            .enumerate()
            .map(|(i, x)| ci_domain::state::Student {
                id: x.id.clone(),
                name: x.name.clone(),
                team_id: x.team_id.clone(),
                active: x.active,
                joined_at: i as i64 + 1,
                called: 0,
            })
            .collect();
        s.bank = case
            .bank
            .iter()
            .map(|q| ci_domain::state::BankQuestion {
                id: q.id.clone(),
                tier: q.tier.clone(),
                tags: q.tags.clone(),
                ..Default::default()
            })
            .collect();
        s.quizzes = case
            .quizzes
            .iter()
            .map(|q| ci_domain::state::Quiz {
                id: q.id.clone(),
                name: q.id.clone(),
                note: String::new(),
                created_at: 1,
                closed_at: 0,
                question_ids: vec![],
                records: q
                    .records
                    .iter()
                    .map(|r| ScoreRecord {
                        id: format!("r{}-{}", q.id, r.at),
                        sid: Some(r.sid.clone()),
                        qid: r.qid.clone(),
                        tier: r.tier.clone(),
                        quiz_id: r.quiz_id.clone(),
                        result: r.result.clone(),
                        base: r.base,
                        ratio: 0.0,
                        points: r.points,
                        source: if r.source.is_empty() { "quiz".into() } else { r.source.clone() },
                        note: String::new(),
                        picked: String::new(),
                        at: r.at,
                        by: String::new(),
                    })
                    .collect(),
            })
            .collect();

        let z1 = case.quizzes.first().map(|q| q.id.clone());
        let z2 = case.quizzes.get(1).map(|q| q.id.clone());

        // 学生统计：全部课次 / 第一节 / 第二节
        let checks: [(&str, Option<&StatsStudentOut>, Option<&str>); 3] = [
            ("全部课次", case.expect.all.as_ref(), None),
            ("只看第一节", case.expect.z1.as_ref(), z1.as_deref()),
            ("只看第二节", case.expect.z2.as_ref(), z2.as_deref()),
        ];
        for (label, want, quiz) in checks {
            let Some(want) = want else { continue };
            let got = student_stats(&s, &want.sid, quiz).expect("学生应存在");
            let n = format!("{} / {}", case.name, label);
            assert_eq!(got.sid, want.sid, "[{}] sid", n);
            assert_eq!(got.name, want.name, "[{}] 姓名", n);
            assert_eq!(got.team_name, want.team_name, "[{}] 队伍名", n);
            assert_eq!(got.score, want.score, "[{}] 积分", n);
            assert_eq!(got.total.attempts, want.attempts, "[{}] 作答次数", n);
            assert_eq!(got.total.correct, want.correct, "[{}] 答对次数", n);
            assert_eq!(got.total.half, want.half, "[{}] 半对次数", n);
            assert_eq!(got.total.credit_rate, want.credit_rate, "[{}] 掌握度", n);
            assert_eq!(got.total.correct_rate, want.correct_rate, "[{}] 正确率", n);
            assert_eq!(got.rolls, want.rolls, "[{}] 被点次数", n);
            assert_eq!(got.last_at, want.last_at, "[{}] 最后作答时间", n);
            assert_eq!(got.weak, want.weak, "[{}] 薄弱题型", n);
            assert_eq!(got.strong, want.strong, "[{}] 优势题型", n);
            assert_eq!(got.level, want.level, "[{}] 等级", n);
            assert_eq!(
                got.tiers.iter().map(|t| t.key.clone()).collect::<Vec<_>>(),
                want.tier_keys,
                "[{}] 题型桶",
                n
            );
        }

        // 榜单：范围必须贯穿
        for (label, want, quiz) in [
            ("全部课次", &case.expect.rank_all, None),
            ("只看第一节", &case.expect.rank_z1, z1.as_deref()),
        ] {
            let got = ranking(&s, None, quiz);
            assert_eq!(got.len(), want.len(), "[{} / {}] 榜单长度", case.name, label);
            for (i, w) in want.iter().enumerate() {
                let g = &got[i];
                let n = format!("{} / {} #{}", case.name, label, i + 1);
                assert_eq!(g.sid, w.sid, "[{}] sid", n);
                assert_eq!(g.name, w.name, "[{}] 姓名", n);
                assert_eq!(g.score, w.score, "[{}] 积分", n);
                assert_eq!(g.attempts, w.attempts, "[{}] 作答次数（范围必须贯穿）", n);
                assert_eq!(g.correct, w.correct, "[{}] 答对次数", n);
                assert_eq!(g.credit_rate, w.credit_rate, "[{}] 掌握度", n);
                assert_eq!(g.rank, w.rank, "[{}] 名次", n);
                assert_eq!(g.level, w.level, "[{}] 等级", n);
                assert_eq!(g.weak_count, w.weak_count, "[{}] 薄弱题型数", n);
            }
        }

        // 班级统计
        for (label, want, quiz) in [
            ("全部课次", &case.expect.class_all, None),
            ("只看第一节", &case.expect.class_z1, z1.as_deref()),
        ] {
            let got = class_stats(&s, None, quiz);
            let n = format!("{} / class {}", case.name, label);
            assert_eq!(got.team_id, want.team_id, "[{}] teamId", n);
            assert_eq!(got.student_count, want.student_count, "[{}] 学生数", n);
            assert_eq!(got.participants, want.participants, "[{}] 参与者", n);
            assert_eq!(got.total.attempts, want.attempts, "[{}] 作答次数", n);
            assert_eq!(got.total.correct, want.correct, "[{}] 答对次数", n);
            assert_eq!(got.total.credit_rate, want.credit_rate, "[{}] 掌握度", n);
            assert_eq!(got.weak_tiers, want.weak_tiers, "[{}] 薄弱题型", n);
            assert_eq!(
                got.need_help.iter().map(|r| r.sid.clone()).collect::<Vec<_>>(),
                want.need_help,
                "[{}] 需关注名单",
                n
            );
            assert_eq!(
                got.ranking.iter().map(|r| r.attempts).collect::<Vec<_>>(),
                want.rank_attempts,
                "[{}] 榜上作答数（必须与汇总同口径）",
                n
            );
        }

        // 队伍榜
        let teams = team_ranking(&s);
        assert_eq!(teams.len(), case.expect.team.len(), "[{}] 队伍数", case.name);
        for (i, w) in case.expect.team.iter().enumerate() {
            let g = &teams[i];
            let n = format!("{} / team #{}", case.name, i + 1);
            assert_eq!(g.team_id, w.team_id, "[{}] teamId", n);
            assert_eq!(g.score, w.score, "[{}] 队伍分", n);
            assert_eq!(g.member_count, w.member_count, "[{}] 成员数", n);
            assert_eq!(g.avg, w.avg, "[{}] 人均分", n);
            assert_eq!(g.attempts, w.attempts, "[{}] 作答次数", n);
        }

        println!(
            "  ✔ {} → 全部 {} 次 / 第一节 {} 次 / 第二节 {} 次",
            case.name,
            case.expect.all.as_ref().map(|x| x.attempts).unwrap_or(0),
            case.expect.z1.as_ref().map(|x| x.attempts).unwrap_or(0),
            case.expect.z2.as_ref().map(|x| x.attempts).unwrap_or(0)
        );
    }
    println!("\n✅ 学情统计：{} 组用例与 JS 参考实现逐字段一致", fx.stats.len());
}

/// **前端发来的状态，Rust 必须能吃下**
///
/// 领域端点（`/api/domain/stats`）收的是前端序列化出来的 `ClassroomState`。
/// 只要有一个字段 Rust 要求、JS 不产出，整个请求就会被 serde 拒掉 ——
/// 实测踩到两个：`BankQuestion.archived`（测试 JSON 手写漏了）与
/// `ClassroomState.classroom`（JS 侧懒创建，新课堂的状态里根本没有它）。
///
/// 所以这里不手写 JSON，直接用 **JS 真实产出的那份**（`tests/fixtures/state-from-js.json`，
/// 由 `node tests/gen-state-fixture.cjs` 生成）。
#[test]
fn accepts_state_produced_by_js() {
    let raw = std::fs::read_to_string(fixtures_path().parent().unwrap().join("state-from-js.json"))
        .expect("缺 state-from-js.json —— 先跑 node tests/gen-state-fixture.cjs");
    let s: ClassroomState = serde_json::from_str(&raw)
        .expect("前端产出的状态必须能被 Rust 反序列化（缺字段就加 #[serde(default)]）");

    // 抽查几处：能反序列化还不够，值也得对上
    assert_eq!(s.students.len(), 1, "一名学生");
    assert_eq!(s.students[0].name, "甲");
    assert_eq!(s.bank.len(), 1, "一道题");
    assert_eq!(s.bank[0].archived, false, "题目未归档");
    assert_eq!(s.bank[0].image_url, "data:image/png;base64,AA", "题目配图（JS 的 imageUrl → Rust 的 image_url）");
    assert_eq!(s.bank[0].tags, vec!["代数".to_string()], "题目标签");
    assert_eq!(s.quizzes.len(), 1);
    assert_eq!(s.quizzes[0].records.len(), 1);
    assert_eq!(s.quizzes[0].records[0].picked, "A", "学生选的选项（错选分布要用）");
    assert_eq!(s.quizzes[0].records[0].points, 3.0, "基础题答对 3 分");
    assert_eq!(s.settings.min_sample, 5, "样本量默认 5");
    assert_eq!(s.runtime.phase, "question", "课堂环节");

    // 统计也得能在这份状态上跑起来（这才是端点的真实用途）
    let sid = s.students[0].id.clone();
    let st = student_stats(&s, &sid, None).expect("能算出学生统计");
    assert_eq!(st.total.attempts, 1);
    assert_eq!(st.total.credit_rate, 100.0, "答对 1 题 → 100%");
    assert_eq!(st.score, 3.0, "积分 3");
    assert_eq!(ranking(&s, None, None).len(), 1, "榜单里有这名学生");

    println!("  ✔ 前端状态（{} 字节）能被 Rust 吃下，且统计跑得通", raw.len());
}

/// 学生可见视图：与 JS 逐字段比对
///
/// **重点断言"没公布答案就不下发答案"** —— 这是防泄题的规则，不是传输细节。
#[test]
fn view_matches_js_reference() {
    let fx = load();
    assert!(!fx.view.is_empty(), "基准里没有学生视图用例");
    for case in &fx.view {
        let q = ci_domain::state::BankQuestion {
            // 用归一化后的 id（fixture 的 expect.id 是 q1，question.id 是原始 uid）
            id: case.expect.as_ref().map(|x| x.id.clone()).unwrap_or_else(|| case.question.id.clone()),
            tier: case.question.tier.clone(),
            stem: case.question.stem.clone(),
            answer: case.question.answer.clone(),
            options: case.question.options.clone(),
            tags: case.question.tags.clone(),
            note: case.question.note.clone(),
            image_url: case.question.image_url.clone(),
            ..Default::default()
        };
        let got = student_view(&q, &case.tier_label, case.points, case.revealed);
        let want = case.expect.as_ref().expect("用例应有 expect");
        let n = &case.name;
        assert_eq!(got.id, want.id, "[{}] id", n);
        assert_eq!(got.stem, want.stem, "[{}] 短题干", n);
        assert_eq!(got.full_stem, want.full_stem, "[{}] 完整题干", n);
        assert_eq!(got.image_url, want.image_url, "[{}] 配图", n);
        assert_eq!(got.tier, want.tier, "[{}] 题型", n);
        assert_eq!(got.tier_label, want.tier_label, "[{}] 题型名", n);
        assert_eq!(got.points, want.points, "[{}] 分值", n);
        assert_eq!(got.multiple, want.multiple, "[{}] 是否多选", n);
        assert_eq!(got.has_answer, want.has_answer, "[{}] 是否有标准答案", n);
        assert_eq!(got.answer_key, want.answer_key, "[{}] 答案（未公布必须为 None）", n);
        assert_eq!(got.explanation, want.explanation, "[{}] 讲评要点（未公布必须为空）", n);
        assert_eq!(got.tags, want.tags, "[{}] 标签（最多 4 个）", n);
        assert_eq!(got.options.len(), want.options.len(), "[{}] 选项数", n);
        for (i, w) in want.options.iter().enumerate() {
            assert_eq!(got.options[i].key, w.key, "[{}] 选项 {} 字母", n, i + 1);
            assert_eq!(got.options[i].text, w.text, "[{}] 选项 {} 文本", n, i + 1);
        }
        // 防泄题：未公布的用例必须没有答案与讲评要点
        if !case.revealed {
            assert!(got.answer_key.is_none(), "[{}] 未公布却下发了答案（泄题！）", n);
            assert!(got.explanation.is_empty(), "[{}] 未公布却下发了讲评要点（泄题！）", n);
        }
        println!("  ✔ {} → answerKey {:?}", n, got.answer_key);
    }
    println!("\n✅ 学生可见视图：{} 组用例与 JS 参考实现逐字段一致", fx.view.len());
}

/// 公开课现场评价量规：与 JS 逐字段比对
///
/// 重点断言 **未评的维度要剔除并重新归一** —— 按 0 分算会凭空拉低总分，
/// 那和"没数据就扣 15 分"是同一类错误（综合表现那边修过一次）。
#[test]
fn openclass_matches_js_reference() {
    let fx = load();
    assert!(!fx.openclass.is_empty(), "基准里没有公开课用例");
    for case in &fx.openclass {
        let scores: Vec<(String, u8)> = case.scores.iter().map(|s| (s.key.clone(), s.score)).collect();
        let got = evaluate_open(&scores, &default_open_dimensions());
        let want = &case.expect;
        let n = &case.name;
        assert_eq!(got.total, want.total, "[{}] 总分", n);
        assert_eq!(got.level, want.level, "[{}] 总评档位", n);
        assert_eq!(got.weight_used, want.weight_used, "[{}] 实际权重和（漏评要重新归一）", n);
        assert_eq!(got.strongest, want.strongest, "[{}] 最强维度", n);
        assert_eq!(got.weakest, want.weakest, "[{}] 最弱维度", n);
        assert_eq!(got.comment, want.comment, "[{}] 规则评语", n);
        assert_eq!(got.parts.len(), want.parts.len(), "[{}] 维度条数", n);
        for (i, w) in want.parts.iter().enumerate() {
            let g = &got.parts[i];
            assert_eq!(g.key, w.key, "[{}] 第 {} 维 key", n, i + 1);
            assert_eq!(g.label, w.label, "[{}] 第 {} 维名称", n, i + 1);
            assert_eq!(g.weight, w.weight, "[{}] 第 {} 维权重", n, i + 1);
            assert_eq!(g.score, w.score, "[{}] 第 {} 维档位", n, i + 1);
            assert_eq!(g.level, w.level, "[{}] 第 {} 维档位文字", n, i + 1);
            assert_eq!(g.rate, w.rate, "[{}] 第 {} 维折算分", n, i + 1);
            assert_eq!(g.contribution, w.contribution, "[{}] 第 {} 维贡献", n, i + 1);
        }
        // 漏评必须重新归一：只评一维且是最高档 → 满分（不是被剩下的三维拖到 30 分）
        if case.scores.len() == 1 && case.scores[0].score == 4 {
            assert_eq!(got.total, 100, "[{}] 只评一维最高档必须是 100", n);
        }
        println!("  ✔ {} → {} 分 {}", n, got.total, got.level);
    }
    println!("\n✅ 公开课量规：{} 组用例与 JS 参考实现逐字段一致", fx.openclass.len());
}

/// AI 润色提示词：与 JS 逐字符比对
///
/// 提示词是**规则**，不是随手拼的字符串 —— 它编码了三条硬约束：
/// 只润色不判断 / 不出现姓名 / 限长。所以它值得 parity。
#[test]
fn polish_matches_js_reference() {
    let fx = load();
    assert!(!fx.polish.is_empty(), "基准里没有润色用例");
    for case in &fx.polish {
        let got = polish_prompt(&case.evaluation);
        let n = &case.name;
        assert_eq!(got, case.expect.prompt, "[{}] 提示词逐字符一致", n);
        // 三条硬约束必须在提示词里（这是"AI 只润色不判断"的落地方式）
        for r in POLISH_RULES {
            assert!(got.contains(r), "[{}] 缺少约束：{}", n, r);
        }
        assert!(got.contains("只能用这些"), "[{}] 必须说明事实来源封闭", n);
        // 隐私：提示词里不能有姓名（调用方压根不传，这里也钉一遍）
        assert!(!got.contains("甲") && !got.contains("乙"), "[{}] 提示词不应出现姓名", n);
        println!("  ✔ {} → {} 字符", n, got.chars().count());
    }
    // 清理函数也要一致（去引号 / 换行 / 限长）
    let sanitized = vec![
        sanitize_polish("「他答得很好」"),
        sanitize_polish("第一行\n第二行"),
        sanitize_polish(&"字".repeat(200)),
    ];
    assert_eq!(sanitized, fx.polish[0].expect.sanitized, "清理函数与 JS 一致");
    assert_eq!(sanitize_polish("x").chars().count(), 1);
    println!("\n✅ 润色提示词：{} 组用例与 JS 参考实现一致", fx.polish.len());
}

/// 大屏公开展示策略：与 JS 逐项比对
///
/// 规则是"公开表扬、私下改进" —— 公开"待改进"在调研里是有害的。
#[test]
fn stage_policy_matches_js_reference() {
    let fx = load();
    assert!(!fx.stage_policy.is_empty(), "基准里没有策略用例");
    for c in &fx.stage_policy {
        let got = show_on_stage(c.total, &default_open_levels(), &c.policy);
        assert_eq!(got, c.expect, "[{} 分 / {}] 公开与否", c.total, c.policy);
    }
    // 核心性质：默认策略下"待改进"绝不公开
    assert!(!show_on_stage(0, &default_open_levels(), "smart"), "0 分（待改进）绝不公开");
    assert!(!show_on_stage(33, &default_open_levels(), "smart"), "33 分（合格）不公开");
    println!("\n✅ 大屏策略：{} 组用例与 JS 一致", fx.stage_policy.len());
}

/// 档位可配置：三档 / 四档 / 五档都要与 JS 一致
///
/// 核心性质：**每档全评时，总评档位与该档一致**（不会出现"四维全良好、总评却合格"）。
#[test]
fn levels_match_js_reference() {
    let fx = load();
    assert!(!fx.levels.is_empty(), "基准里没有档位用例");
    for case in &fx.levels {
        // 档位本身（含 labels 生成的均匀映射）
        if let Some(labels) = &case.labels {
            let built = levels_from_labels(labels);
            assert_eq!(built, case.levels, "[{}] 档位生成一致", case.name);
        } else {
            assert_eq!(default_open_levels(), case.levels, "[{}] 默认档位一致", case.name);
        }
        for row in &case.rows {
            let got = open_rate(row.score, &case.levels);
            assert_eq!(got, row.rate, "[{}] 第 {} 档分数", case.name, row.score);
            let ev = evaluate_open_full(
                &default_open_dimensions()
                    .iter()
                    .map(|d| (d.key.clone(), row.score))
                    .collect::<Vec<_>>(),
                &default_open_dimensions(),
                &case.levels,
            );
            assert_eq!(ev.total, row.total, "[{}] 第 {} 档全评 → 总分", case.name, row.score);
            assert_eq!(ev.level, row.level, "[{}] 第 {} 档全评 → 总评档位", case.name, row.score);
            assert_eq!(ev.parts[0].level, row.part_level, "[{}] 第 {} 档维度档位名", case.name, row.score);
            // 核心性质：全评同一档时，总评必须就是这一档
            assert_eq!(ev.level, row.part_level, "[{}] 总评与维度档位必须一致", case.name);
        }
        println!("  ✔ {} → {} 档", case.name, case.levels.len());
    }
    println!("\n✅ 档位可配置：{} 组用例与 JS 一致", fx.levels.len());
}

/// 档位分数校验：与 JS 一致
///
/// 必须严格递增且在 0–100 —— 总分是"落在不超过它的最高一档"。
#[test]
fn level_validity_matches_js_reference() {
    let fx = load();
    assert!(!fx.level_validity.is_empty(), "基准里没有校验用例");
    for c in &fx.level_validity {
        assert_eq!(levels_are_valid(&c.levels), c.expect, "[{}] 是否合法", c.name);
    }
    // 核心性质：默认四档必须合法（否则界面一打开就报错）
    assert!(levels_are_valid(&default_open_levels()));
    println!("\n✅ 档位校验：{} 组用例与 JS 一致", fx.level_validity.len());
}

/// 题型判定：与 JS 一致
///
/// 学生端靠它决定提交 choice 还是 text —— 缺了它选择题会被当主观题（真 bug）。
#[test]
fn question_type_matches_js_reference() {
    let fx = load();
    assert!(!fx.question_type.is_empty(), "基准里没有题型用例");
    for c in &fx.question_type {
        let q = ci_domain::grade::Question {
            options: c.options.clone(),
            answer: c.answer.clone(),
            ..Default::default()
        };
        assert_eq!(type_of(&q), c.expect_type, "[{}] 题型", c.name);
        assert_eq!(type_label(&q), c.expect_label, "[{}] 题型名", c.name);
    }
    println!("\n✅ 题型判定：{} 组用例与 JS 一致", fx.question_type.len());
}


/* ------------------------------------------------------------------ *
 * 趋势（analysis.js::trend ↔ ci_domain::trend）
 * ------------------------------------------------------------------ *
 * 审计 B7：原来只有"本节课 / 全部课次"两档，答不了"这几周是进步还是退步"。
 * 趋势是领域规则，所以必须逐字段一致 —— 尤其**按天分桶**依赖时区偏移，
 * 两边算法不同就会算出不同的"天"（这正是 parity 要钉住的）。
 */
#[derive(Debug, Deserialize)]
struct TrendCase {
    name: String,
    opts: TrendOpts,
    state: ClassroomState,
    expect: Vec<TrendBucket>,
}

#[test]
fn parity_trend() {
    let fx = load();
    assert!(!fx.trend.is_empty(), "基准里要有趋势用例");
    for c in &fx.trend {
        let got = trend(&c.state, &c.opts);
        assert_eq!(
            got, c.expect,
            "趋势不一致：{}（桶数 {} vs {}）",
            c.name, got.len(), c.expect.len()
        );
        // 逐字段也核一遍，报错时能直接看出是哪个字段漂了
        for (g, e) in got.iter().zip(c.expect.iter()) {
            assert_eq!(g.key, e.key, "{} 的 key", c.name);
            assert_eq!(g.attempts, e.attempts, "{} 的 attempts", c.name);
            assert_eq!(g.correct, e.correct, "{} 的 correct", c.name);
            assert_eq!(g.rate, e.rate, "{} 的 rate", c.name);
            assert!((g.points - e.points).abs() < 1e-9, "{} 的 points", c.name);
        }
    }
    println!("   趋势 {} 个用例逐字段一致", fx.trend.len());
}
