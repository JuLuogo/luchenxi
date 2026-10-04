//!
//! ci-domain —— 业务规则（纯逻辑，无 IO、无 Tauri、无网络）
//!
//! 为什么单独成 crate：v5 的目标是"一份核心逻辑，三端只做展示"。
//! 把规则放在这里，客户端（Tauri）、枢纽（HTTP/WS）、以及将来的网页版
//! 都调用同一份实现，前端不再复写判断。
//!
//! **迁移来源**：`assets/js/` 下的领域模块（判分 / 加权计分 / 能力评价 / 点名 / 课堂环节）。
//! 迁移期两边并行：本 crate 的测试与 `tests/logic.test.js` 的断言组一一对应，
//! 直到 Rust 侧全绿再把 JS 实现标记为参考实现。
//!
//! 依赖方向：ci-domain ← ci-hub ← ci-core ← apps/

pub mod ability;
pub mod bank_import;
pub mod classroom;
pub mod composite;
pub mod draw;
pub mod grade;
pub mod mistakes;
pub mod question_stats;
pub mod openclass;
pub mod polish;
pub mod report;
pub mod rollcall;
pub mod scoring;
pub mod stats;
pub mod state;

pub use ability::{
    ability_comment, ability_of_tiers, grade_by_key, pct, Ability, Axis, Bucket, Grade, TierStat,
    GRADES,
};
pub use bank_import::{parse_import, ImportQuestion};
pub use composite::{
    decayed_rate, evaluate, growth_score, participation_rate, EvalPart, EvalWeights, Evaluation,
};
pub use draw::{candidates as draw_candidates, draw as draw_questions, DrawOpts};
pub use mistakes::{mistake_board, student_mistakes, MistakeItem, StudentMistakes};
pub use question_stats::{
    option_distribution, question_stats, review_line, short_stem, short_stem_with, student_view,
    OptionCount, OptionView, QuestionStat, StudentQuestionView,
};
pub use openclass::{
    show_on_stage,
    default_open_dimensions, evaluate_open, open_comment, open_level, open_rate, OpenDimension,
    default_open_levels, evaluate_open_full, is_praise, level_for_total, levels_are_valid,
    levels_from_labels,
    OpenEvaluation, OpenLevel, OpenPart,
};
pub use polish::{polish_prompt, sanitize_polish, POLISH_MAX_CHARS, POLISH_RULES};
pub use report::{build_report, to_markdown as report_markdown, Checkin, ClassReport, ReportInput, ReportStudent};
pub use rollcall::{
    apply_pick, called_count, candidates as rollcall_candidates, pick as rollcall_pick, recent_ids,
    Pick, PickOpts, RollEntry, RollcallSettings, Student, XorShift64,
};
pub use stats::{
    ability_board, class_stats, ranking, student_stats, team_ranking, AbilityBoard, AbilityEntry, ClassStats,
    FinalBucket, RankRow, StudentStats,
    StudentTierRow, TagRow, TeamRankRow,
};
pub use scoring::{
    compute_points, default_tiers, is_countable, normalize_result, question_points, result_label,
    round2, score_of_input, sum_points, tier_of, ScoreInput, ScoreSnapshot, ScoringSettings, Tier,
};
pub use classroom::{
    add_buzz, add_pending, finalize_feed, handle_cmd, pack_ability, phase_label, pick_answerer, push_feed,
    set_phase, set_phase_named, team_stats, tier_key_default, AbilityPack, Buzz, BuzzOutcome,
    ClassStudent, ClassTeam, CmdOutcome, CmdResult, FeedItem, Pending, Phase, Runtime, ScoreRequest,
    StudentCmd, TeamStat, PHASES,
};
pub use state::{
    BankQuestion, ClassroomBox, ClassroomState, LogItem, Quiz, RollcallState, RollHistoryEntry,
    ScoreRecord, Settings, Student as StateStudent, Team,
};
pub use grade::{
    type_label, type_of,
    answer_key, auto, describe_submission, normalize_text, parse_choice, validate_question,
    AutoResult, Question, QuestionType, Submission, Validation, Verdict, LETTERS,
};
