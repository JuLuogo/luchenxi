//! classroom.rs — 课堂协同：环节状态机、学生命令决策、大屏数据打包
//!
//! **迁移来源**：`assets/js/classroom.js` 的
//! `PHASES` / `PHASE_LABEL` / `phase` / `setPhase` / `pickAnswerer` / `addBuzz` /
//! `pushFeed` / `addPending` / `handleCmd` / `teamStats` / `abilityPayload`。
//!
//! 设计原则：**只做决策，不碰存储**。`handle_cmd` 返回"应该发生什么"
//! （结果枚举 + 要写进实时流的条目 + 要记分的请求），由存储层/枢纽去落库。
//! 这样领域规则可以脱离 store 单测，也让 Node 与 Rust 两版枢纽共用同一套判断。
//!
//! 迁移期两边并行：单测对应 `tests/logic.test.js` 第 9 组（多端协同：学生提交与判定）
//! 与第 12 组（课堂环节与大屏数据）。

use crate::ability::Ability;
use crate::grade::{self, Question, Submission};
use crate::scoring::{self, ScoreSnapshot, ScoringSettings, Tier};
use serde::{Deserialize, Serialize};

/* ------------------------------------------------------------------ *
 * 课堂环节
 * ------------------------------------------------------------------ */

/// 四个环节：待机 / 随机点名 / 出题答题 / 点评总结
pub const PHASES: [&str; 4] = ["idle", "rollcall", "question", "review"];

/// 环节中文名（大屏顶栏与学生端提示都用它）
pub fn phase_label(phase: &str) -> &'static str {
    match phase {
        "rollcall" => "随机点名",
        "question" => "出题答题",
        "review" => "点评总结",
        _ => "待机",
    }
}

#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    Idle,
    Rollcall,
    Question,
    Review,
}

impl Phase {
    pub fn as_str(self) -> &'static str {
        match self {
            Phase::Idle => "idle",
            Phase::Rollcall => "rollcall",
            Phase::Question => "question",
            Phase::Review => "review",
        }
    }
    pub fn label(self) -> &'static str {
        phase_label(self.as_str())
    }
    /// 非法值一律落到待机（与 JS 的 `PHASES.indexOf(p) >= 0 ? p : 'idle'` 一致）
    pub fn parse(s: &str) -> Phase {
        match s {
            "rollcall" => Phase::Rollcall,
            "question" => Phase::Question,
            "review" => Phase::Review,
            _ => Phase::Idle,
        }
    }
}

/// 环节相关的运行态（对应 state.runtime 里与课堂有关的部分）
#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Runtime {
    #[serde(default)]
    pub phase: String,
    #[serde(default)]
    pub quiz_id: Option<String>,
    #[serde(default)]
    pub qid: Option<String>,
    #[serde(default)]
    pub accepting: bool,
    #[serde(default)]
    pub reveal: bool,
    /// 当前被点到的学生（点名环节大屏用）
    #[serde(default)]
    pub sid: Option<String>,
    /// 课堂计时器结束时刻（ms 时间戳）；None = 没在计时。
    /// 大屏/学生端按这个时刻**本地**渲染倒计时，不需要每秒广播。
    #[serde(default)]
    #[cfg_attr(feature = "bindings", specta(type = Option<specta_typescript::Number>))]
    pub timer_ends_at: Option<i64>,
    /// 计时器说明（如「随堂练习」「小组讨论」），显示在倒计时旁边
    #[serde(default)]
    pub timer_label: String,
}

impl Default for Runtime {
    fn default() -> Self {
        Runtime {
            phase: "idle".to_string(),
            quiz_id: None,
            qid: None,
            accepting: false,
            reveal: false,
            sid: None,
            timer_ends_at: None,
            timer_label: String::new(),
        }
    }
}

impl Runtime {
    pub fn phase(&self) -> Phase {
        Phase::parse(&self.phase)
    }
}

/* ------------------------------------------------------------------ *
 * 课堂计时器（对应学习通的「计时器」控件）
 *
 * 设计要点：只存**结束时刻**，不存剩余秒数、也不广播 tick ——
 * 大屏/学生端各自按 `timerEndsAt - now` 本地渲染，一秒一次刷新。
 * 这样网络断了倒计时也照常走，枢纽不必每秒发消息。
 * ------------------------------------------------------------------ */

/// 开始计时（`seconds <= 0` 等价于停止）
pub fn set_timer(rt: &mut Runtime, seconds: i64, label: &str, now_ms: i64) -> Option<i64> {
    if seconds <= 0 {
        rt.timer_ends_at = None;
        rt.timer_label = String::new();
        return None;
    }
    let ends = now_ms + seconds * 1000;
    rt.timer_ends_at = Some(ends);
    rt.timer_label = label.to_string();
    Some(ends)
}

/// 停止计时
pub fn clear_timer(rt: &mut Runtime) {
    rt.timer_ends_at = None;
    rt.timer_label = String::new();
}

/// 剩余毫秒（没在计时返回 None；已到点返回 0）
pub fn timer_left(rt: &Runtime, now_ms: i64) -> Option<i64> {
    rt.timer_ends_at.map(|end| (end - now_ms).max(0))
}

/// 计时是否已结束（没在计时算"未在计时"，返回 false）
pub fn timer_expired(rt: &Runtime, now_ms: i64) -> bool {
    matches!(timer_left(rt, now_ms), Some(0))
}

/// 把剩余毫秒显示成 `m:ss`（大屏用；与 JS 的 formatLeft 同一口径）
pub fn format_left(ms: i64) -> String {
    let total = (ms.max(0) + 999) / 1000; // 向上取整：还剩 0.4 秒也显示 1 秒
    format!("{}:{:02}", total / 60, total % 60)
}

/// 切换课堂环节（**修改传入的 runtime**，返回切换后的环节）
///
/// 规则（与 JS 的 setPhase 逐条一致）：
///   · 非法值忽略，保持原环节
///   · 出题环节自动带上当前题：优先当前试卷第一题，其次题库第一题；都没有则退回待机
///   · 出题环节开始接收作答；点评环节停止接收；点名环节收起答案
///
/// `quiz_first_qid` —— 当前试卷的第一题（调用方按 runtime.quiz_id 查好）
/// `bank_first_qid` —— 题库第一题
pub fn set_phase(rt: &mut Runtime, quiz_first_qid: Option<&str>, bank_first_qid: Option<&str>) -> Phase {
    let requested = match PHASES.contains(&rt.phase.as_str()) {
        true => Phase::parse(&rt.phase),
        // 传入的 phase 字段本身非法时的兜底（正常路径下由 set_phase_named 处理）
        false => rt.phase(),
    };
    apply_phase(rt, requested, quiz_first_qid, bank_first_qid)
}

/// 按名字切换环节（对应 JS 的 `setPhase('review')`）
pub fn set_phase_named(
    rt: &mut Runtime,
    name: &str,
    quiz_first_qid: Option<&str>,
    bank_first_qid: Option<&str>,
) -> Phase {
    if !PHASES.contains(&name) {
        return rt.phase(); // 非法环节值被忽略，保持原环节
    }
    apply_phase(rt, Phase::parse(name), quiz_first_qid, bank_first_qid)
}

fn apply_phase(rt: &mut Runtime, phase: Phase, quiz_first_qid: Option<&str>, bank_first_qid: Option<&str>) -> Phase {
    rt.phase = phase.as_str().to_string();
    if phase == Phase::Question {
        if rt.qid.is_none() {
            rt.qid = quiz_first_qid
                .map(|s| s.to_string())
                .or_else(|| bank_first_qid.map(|s| s.to_string()));
            if rt.qid.is_none() {
                // 没题可出，回到待机
                rt.phase = Phase::Idle.as_str().to_string();
            }
        }
        if rt.phase == Phase::Question.as_str() {
            rt.accepting = true; // 出题即开始接收作答
        }
    }
    if phase == Phase::Review {
        rt.accepting = false;
    }
    if phase == Phase::Rollcall {
        rt.reveal = false;
    }
    rt.phase()
}

/* ------------------------------------------------------------------ *
 * 学生 / 队伍
 * ------------------------------------------------------------------ */

#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClassStudent {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub team_id: Option<String>,
    #[serde(default = "default_true")]
    pub active: bool,
}

fn default_true() -> bool {
    true
}

#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClassTeam {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub color: String,
    #[serde(default)]
    pub icon: String,
    /// 全员 id（用于"队伍里没有成员"判断与取第一个成员）
    #[serde(default)]
    pub member_ids: Vec<String>,
}

/// 从队伍里挑选作答人：命令指定 → 当前被点学生（若属于该队）→ 队伍第一个成员
pub fn pick_answerer(
    students: &[ClassStudent],
    team_id: Option<&str>,
    sid: Option<&str>,
    runtime_sid: Option<&str>,
) -> Option<String> {
    if let Some(s) = sid {
        if students.iter().any(|x| x.id == s) {
            return Some(s.to_string());
        }
    }
    if let Some(cur) = runtime_sid {
        if let Some(stu) = students.iter().find(|x| x.id == cur) {
            match team_id {
                None => return Some(stu.id.clone()),
                Some(t) if stu.team_id.as_deref() == Some(t) => return Some(stu.id.clone()),
                _ => {}
            }
        }
    }
    students
        .iter()
        .find(|x| match team_id {
            None => true,
            Some(t) => x.team_id.as_deref() == Some(t),
        })
        .map(|x| x.id.clone())
}

fn student_name(students: &[ClassStudent], sid: &str) -> String {
    students
        .iter()
        .find(|s| s.id == sid)
        .map(|s| s.name.clone())
        .unwrap_or_else(|| "（未知学生）".to_string())
}

fn team_name(teams: &[ClassTeam], tid: Option<&str>) -> String {
    tid.and_then(|t| teams.iter().find(|x| x.id == t))
        .map(|t| t.name.clone())
        .unwrap_or_else(|| "（未知队伍）".to_string())
}

/* ------------------------------------------------------------------ *
 * 实时流 / 抢答榜 / 待确认队列
 * ------------------------------------------------------------------ */

/// 实时流条目（教师端右上角滚动显示）
#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedItem {
    pub kind: String,
    #[serde(default)]
    pub team_id: Option<String>,
    #[serde(default)]
    pub sid: Option<String>,
    #[serde(default)]
    pub qid: Option<String>,
    #[serde(default)]
    pub result: Option<String>,
    #[serde(default)]
    pub answer: Option<String>,
    #[serde(default)]
    pub expected: Option<String>,
    #[serde(default)]
    pub points: f64,
    pub text: String,
    #[cfg_attr(feature = "bindings", specta(type = specta_typescript::Number))]
    pub at: i64,
}

pub const FEED_CAP: usize = 60;

/// 实时流是**倒序**（新的在前），最多留 60 条
pub fn push_feed(feed: &mut Vec<FeedItem>, item: FeedItem) {
    feed.insert(0, item);
    feed.truncate(FEED_CAP);
}

#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Buzz {
    pub team_id: String,
    #[serde(default)]
    pub qid: Option<String>,
    #[serde(default)]
    pub sid: Option<String>,
    #[cfg_attr(feature = "bindings", specta(type = specta_typescript::Number))]
    pub at: i64,
}

pub const BUZZ_CAP: usize = 40;

/// 抢答结果
#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuzzOutcome {
    /// 同一队同一题重复抢答被忽略
    pub dup: bool,
    pub team_name: String,
}

/// 抢答去重：同一队同一题只记一次，最多留 40 条（新的在前）
pub fn add_buzz(
    buzz: &mut Vec<Buzz>,
    teams: &[ClassTeam],
    students: &[ClassStudent],
    team_id: &str,
    cmd_qid: Option<&str>,
    cmd_sid: Option<&str>,
    current_qid: Option<&str>,
    runtime_sid: Option<&str>,
    at: i64,
) -> BuzzOutcome {
    let qid = cmd_qid.map(|s| s.to_string()).or_else(|| current_qid.map(|s| s.to_string()));
    let dup = buzz
        .iter()
        .any(|b| b.team_id == team_id && b.qid == qid);
    if dup {
        return BuzzOutcome {
            dup: true,
            team_name: team_name(teams, Some(team_id)),
        };
    }
    buzz.insert(
        0,
        Buzz {
            team_id: team_id.to_string(),
            qid,
            sid: pick_answerer(students, Some(team_id), cmd_sid, runtime_sid),
            at,
        },
    );
    buzz.truncate(BUZZ_CAP);
    BuzzOutcome {
        dup: false,
        team_name: team_name(teams, Some(team_id)),
    }
}

/// 待确认提交（主观题由老师判定）
#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pending {
    pub sid: String,
    #[serde(default)]
    pub team_id: Option<String>,
    #[serde(default)]
    pub qid: Option<String>,
    #[serde(default)]
    pub quiz_id: Option<String>,
    /// 提交内容可读化后的文本
    pub answer: String,
    #[serde(default)]
    pub backlog: bool,
    #[cfg_attr(feature = "bindings", specta(type = specta_typescript::Number))]
    pub at: i64,
}

pub const PENDING_CAP: usize = 60;

pub fn add_pending(pending: &mut Vec<Pending>, item: Pending) {
    pending.insert(0, item);
    pending.truncate(PENDING_CAP);
}

/* ------------------------------------------------------------------ *
 * 学生命令处理
 * ------------------------------------------------------------------ */

/// 学生命令（对应 cmd.kind = hello | buzz | answer）
#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StudentCmd {
    pub kind: String,
    #[serde(default)]
    pub team_id: Option<String>,
    #[serde(default)]
    pub sid: Option<String>,
    #[serde(default)]
    pub qid: Option<String>,
    #[serde(default)]
    pub choice: Vec<String>,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub skip: bool,
    #[serde(default)]
    pub backlog: bool,
}

/// 记分请求（由存储层执行：写流水 + 落库）
#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScoreRequest {
    pub sid: String,
    pub qid: Option<String>,
    pub tier: String,
    pub result: String,
    pub note: String,
    pub points: f64,
    /// 抢答名次（1 起）：本队此前是否对该题抢过答、排第几。
    /// 答对且有名次 → 存储层按名次加分（第 1 个 +2 / 第 2 个 +1，见 ScoringSettings）。
    #[serde(default)]
    pub rank: Option<u32>,
}

/// 命令处理结果（对应 JS handleCmd 的返回值，外加要落库的副作用）
#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CmdOutcome {
    /// 不认识的命令
    Ignored,
    /// 入座
    Hello { team_id: Option<String> },
    /// 抢答（dup=true 表示重复被忽略）
    Buzz { dup: bool, team_id: Option<String> },
    /// 提交失败：队伍没有成员
    AnswerNoStudent { team_id: Option<String> },
    /// 重复提交，已忽略
    AnswerDuplicate { sid: String },
    /// 主观题：进待确认队列
    AnswerPending { sid: String },
    /// 客观题：自动判分并记分
    AnswerScored { sid: String, result: String, points: f64 },
}

/// 一次命令处理的完整产物
#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Debug, Clone, PartialEq)]
pub struct CmdResult {
    pub outcome: CmdOutcome,
    /// 要写进实时流的条目（按顺序插入，新的在前）
    pub feeds: Vec<FeedItem>,
    /// 主观题待确认条目
    pub pending: Option<Pending>,
    /// 抢答条目（若发生）
    pub buzz: Option<Buzz>,
    /// 记分请求（客观题才有）
    pub score: Option<ScoreRequest>,
}

impl CmdResult {
    fn new(outcome: CmdOutcome) -> Self {
        CmdResult {
            outcome,
            feeds: Vec::new(),
            pending: None,
            buzz: None,
            score: None,
        }
    }
}

/// 处理学生命令（纯决策：不改任何存储，返回"应该发生什么"）
///
/// * `buzz` —— 已有的抢答榜（**必须传进来**，否则"同一队同一题只记一次"的去重无法生效）
/// * `answered_already` —— 该生是否已答过当前题（由调用方按 quizId/qid 查好）
/// * `current_qid` —— 当前题 id（无题则 None）
#[allow(clippy::too_many_arguments)]
pub fn handle_cmd(
    cmd: &StudentCmd,
    teams: &[ClassTeam],
    students: &[ClassStudent],
    runtime: &Runtime,
    question: Option<&Question>,
    current_qid: Option<&str>,
    answered_already: bool,
    buzz: &[Buzz],
    at: i64,
) -> CmdResult {
    if cmd.kind.is_empty() {
        return CmdResult::new(CmdOutcome::Ignored);
    }

    match cmd.kind.as_str() {
        "hello" => {
            let name = team_name(teams, cmd.team_id.as_deref());
            let mut r = CmdResult::new(CmdOutcome::Hello {
                team_id: cmd.team_id.clone(),
            });
            r.feeds.push(FeedItem {
                kind: "hello".into(),
                team_id: cmd.team_id.clone(),
                sid: None,
                qid: None,
                result: None,
                answer: None,
                expected: None,
                points: 0.0,
                text: format!("{} 已入座", name),
                at,
            });
            r
        }

        "buzz" => {
            // 在已有抢答榜的副本上判定去重（调用方负责把返回的条目插进去）
            let mut buzz_list: Vec<Buzz> = buzz.to_vec();
            let tid = cmd.team_id.clone().unwrap_or_default();
            let out = add_buzz(
                &mut buzz_list,
                teams,
                students,
                &tid,
                cmd.qid.as_deref(),
                cmd.sid.as_deref(),
                current_qid,
                runtime.sid.as_deref(),
                at,
            );
            let mut r = CmdResult::new(CmdOutcome::Buzz {
                dup: out.dup,
                team_id: cmd.team_id.clone(),
            });
            if !out.dup {
                r.buzz = buzz_list.into_iter().next();
            }
            r
        }

        "answer" => {
            let qid = cmd.qid.clone().or_else(|| current_qid.map(|s| s.to_string()));
            let sid = match pick_answerer(
                students,
                cmd.team_id.as_deref(),
                cmd.sid.as_deref(),
                runtime.sid.as_deref(),
            ) {
                Some(s) => s,
                None => {
                    // 队伍没有成员：写一条失败提示
                    let name = team_name(teams, cmd.team_id.as_deref());
                    let mut r = CmdResult::new(CmdOutcome::AnswerNoStudent {
                        team_id: cmd.team_id.clone(),
                    });
                    r.feeds.push(FeedItem {
                        kind: "error".into(),
                        team_id: cmd.team_id.clone(),
                        sid: None,
                        qid: qid.clone(),
                        result: None,
                        answer: None,
                        expected: None,
                        points: 0.0,
                        text: format!("{} 提交失败：队伍没有成员", name),
                        at,
                    });
                    return r;
                }
            };

            // 去重：有当前试卷时按该卷判重；没有试卷时按该题历史流水判重，避免重复加分
            if question.is_some() && answered_already {
                let mut r = CmdResult::new(CmdOutcome::AnswerDuplicate { sid: sid.clone() });
                r.feeds.push(FeedItem {
                    kind: "dup".into(),
                    team_id: cmd.team_id.clone(),
                    sid: Some(sid.clone()),
                    qid: qid.clone(),
                    result: None,
                    answer: None,
                    expected: None,
                    points: 0.0,
                    text: format!("{} 重复提交，已忽略", student_name(students, &sid)),
                    at,
                });
                return r;
            }

            let submission = Submission {
                choice: cmd.choice.clone(),
                text: cmd.text.clone().unwrap_or_default(),
                skip: cmd.skip,
            };
            let graded = question.and_then(|q| grade::auto(q, &submission));
            let desc = match question {
                Some(q) => grade::describe_submission(q, &submission),
                None => cmd
                    .text
                    .clone()
                    .filter(|t| !t.trim().is_empty())
                    .unwrap_or_else(|| "（空）".to_string()),
            };

            match graded {
                // 主观题：进待确认队列
                None => {
                    let mut r = CmdResult::new(CmdOutcome::AnswerPending { sid: sid.clone() });
                    r.feeds.push(FeedItem {
                        kind: "pending".into(),
                        team_id: cmd.team_id.clone(),
                        sid: Some(sid.clone()),
                        qid: qid.clone(),
                        result: None,
                        answer: Some(desc.clone()),
                        expected: None,
                        points: 0.0,
                        text: format!(
                            "{} 提交：{}（待确认）",
                            student_name(students, &sid),
                            desc
                        ),
                        at,
                    });
                    r.pending = Some(Pending {
                        sid: sid.clone(),
                        team_id: cmd.team_id.clone(),
                        qid,
                        quiz_id: runtime.quiz_id.clone(),
                        answer: desc,
                        backlog: cmd.backlog,
                        at,
                    });
                    r
                }
                // 客观题：自动判分 + 记分
                Some(g) => {
                    let tier = question
                        .map(|q| q.tier_key())
                        .filter(|t| !t.is_empty())
                        .unwrap_or_default();
                    // 抢答名次：本队对该题在抢答榜里的位置（1 起）；没抢过答就没有名次。
                    // 前面抢到的队排前面，所以 position + 1 即名次。
                    let rank = current_qid.and_then(|cqid| {
                        buzz.iter()
                            .position(|b| b.team_id == cmd.team_id.clone().unwrap_or_default() && b.qid.as_deref() == Some(cqid))
                            .map(|i| (i + 1) as u32)
                    });
                    let mut r = CmdResult::new(CmdOutcome::AnswerScored {
                        sid: sid.clone(),
                        result: g.result.as_str().to_string(),
                        points: 0.0,
                    });
                    r.feeds.push(FeedItem {
                        kind: "answer".into(),
                        team_id: cmd.team_id.clone(),
                        sid: Some(sid.clone()),
                        qid: qid.clone(),
                        result: Some(g.result.as_str().to_string()),
                        answer: Some(desc.clone()),
                        expected: Some(g.expected.clone()),
                        points: 0.0,
                        text: String::new(), // 分数由存储层算完后回填（见 finalize_feed）
                        at,
                    });
                    r.score = Some(ScoreRequest {
                        sid,
                        qid,
                        tier,
                        result: g.result.as_str().to_string(),
                        note: desc,
                        points: 0.0,
                        rank,
                    });
                    r
                }
            }
        }

        _ => CmdResult::new(CmdOutcome::Ignored),
    }
}

/// 记分完成后回填实时流文案与分数（对应 JS 里"先记分再补一条带分数的实时流"）
pub fn finalize_feed(feed: &mut FeedItem, snapshot: &ScoreSnapshot, students: &[ClassStudent]) {
    feed.points = snapshot.points;
    let label = scoring::result_label(&snapshot.result);
    let pts = if snapshot.points != 0.0 {
        format!("（{}{}）", if snapshot.points > 0.0 { "+" } else { "" }, snapshot.points)
    } else {
        String::new()
    };
    feed.text = format!(
        "{} {} → {}{}",
        student_name(students, &snapshot.sid),
        feed.answer.clone().unwrap_or_default(),
        label,
        pts
    );
    if let CmdOutcome::AnswerScored { points, .. } = &mut CmdOutcome::Ignored {
        *points = snapshot.points;
    }
}

/* ------------------------------------------------------------------ *
 * 大屏数据打包
 * ------------------------------------------------------------------ */

#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamStat {
    #[serde(rename = "teamId")]
    pub team_id: String,
    pub name: String,
    pub color: String,
    pub icon: String,
    pub correct: u32,
    pub attempts: u32,
    #[serde(rename = "creditRate")]
    pub credit_rate: f64,
    pub score: Option<f64>,
    #[serde(rename = "memberCount")]
    #[cfg_attr(feature = "bindings", specta(type = specta_typescript::Number))]
    pub member_count: usize,
}

/// 各队 + 全班的答题情况（第一行固定是"全班"），按答对数与掌握度排序
pub fn team_stats(
    teams: &[ClassTeam],
    per_team: &[(String, u32, u32, f64, Option<f64>, usize)],
    class: (u32, u32, f64, usize),
) -> Vec<TeamStat> {
    let mut out: Vec<TeamStat> = teams
        .iter()
        .map(|t| {
            let row = per_team.iter().find(|r| r.0 == t.id);
            let (correct, attempts, credit_rate, score, member_count) = match row {
                Some(r) => (r.1, r.2, r.3, r.4, r.5),
                None => (0, 0, 0.0, Some(0.0), 0),
            };
            TeamStat {
                team_id: t.id.clone(),
                name: t.name.clone(),
                color: t.color.clone(),
                icon: t.icon.clone(),
                correct,
                attempts,
                credit_rate,
                score,
                member_count,
            }
        })
        .collect();
    out.sort_by(|a, b| {
        b.correct
            .cmp(&a.correct)
            .then(b.credit_rate.partial_cmp(&a.credit_rate).unwrap_or(std::cmp::Ordering::Equal))
    });
    out.insert(
        0,
        TeamStat {
            team_id: "all".to_string(),
            name: "全班".to_string(),
            color: "#4f46e5".to_string(),
            icon: "∑".to_string(),
            correct: class.0,
            attempts: class.1,
            credit_rate: class.2,
            score: None,
            member_count: class.3,
        },
    );
    out
}

/// 大屏/学生端的"能力画像"打包
#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AbilityPack {
    pub id: String,
    pub name: String,
    pub kind: String,
    #[cfg_attr(feature = "bindings", specta(type = specta_typescript::Number))]
    pub overall: i64,
    #[cfg_attr(feature = "bindings", specta(type = specta_typescript::Number))]
    pub coverage: i64,
    #[cfg_attr(feature = "bindings", specta(type = Option<specta_typescript::Number>))]
    pub balance: Option<i64>,
    pub attempts: u32,
    pub grade: GradePack,
    pub axes: Vec<AxisPack>,
    pub weakest: Option<AxisBrief>,
    pub strongest: Option<AxisBrief>,
    pub comment: String,
}

#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GradePack {
    pub key: String,
    pub short: String,
    pub label: String,
    pub color: String,
}

#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AxisPack {
    pub key: String,
    pub label: String,
    pub color: String,
    #[cfg_attr(feature = "bindings", specta(type = specta_typescript::Number))]
    pub rate: i64,
    pub attempts: u32,
}

#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AxisBrief {
    pub label: String,
    #[cfg_attr(feature = "bindings", specta(type = specta_typescript::Number))]
    pub rate: i64,
}

/// 把一个 Ability 压成大屏所需的形态（学生只带画像，不带完整记录）
pub fn pack_ability(a: &Ability, id: &str, name: &str, kind: &str) -> AbilityPack {
    AbilityPack {
        id: id.to_string(),
        name: name.to_string(),
        kind: kind.to_string(),
        overall: a.overall,
        coverage: a.coverage,
        balance: a.balance,
        attempts: a.attempts,
        grade: GradePack {
            key: a.grade.key.to_string(),
            short: a.grade.short.to_string(),
            label: a.grade.label.to_string(),
            color: a.grade.color.to_string(),
        },
        axes: a
            .axes
            .iter()
            .map(|x| AxisPack {
                key: x.key.clone(),
                label: x.label.clone(),
                color: x.color.clone(),
                rate: x.rate,
                attempts: x.attempts,
            })
            .collect(),
        weakest: a.weakest_axis().map(|x| AxisBrief {
            label: x.label.clone(),
            rate: x.rate,
        }),
        strongest: a.strongest_axis().map(|x| AxisBrief {
            label: x.label.clone(),
            rate: x.rate,
        }),
        comment: a.comment.clone(),
    }
}

/// 题型权重取默认值时的便捷入口（枢纽与客户端都用它）
pub fn tier_key_default(tiers: &[Tier], key: &str) -> String {
    scoring::tier_of(tiers, key)
        .map(|t| t.key.clone())
        .unwrap_or_else(|| "basic".to_string())
}

/// 环境设置（计分用）；保留此别名方便调用方阅读
pub type ClassSettings = ScoringSettings;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ability::ability_of_tiers;
    use crate::scoring::{default_tiers, score_of_input, ScoreInput};

    fn teams() -> Vec<ClassTeam> {
        vec![
            ClassTeam { id: "tm1".into(), name: "红队".into(), color: "#e11d48".into(), icon: "🔴".into(), member_ids: vec!["s1".into(), "s2".into()] },
            ClassTeam { id: "tm2".into(), name: "蓝队".into(), color: "#2563eb".into(), icon: "🔵".into(), member_ids: vec!["s3".into(), "s4".into()] },
        ]
    }

    fn students() -> Vec<ClassStudent> {
        vec![
            ClassStudent { id: "s1".into(), name: "甲".into(), team_id: Some("tm1".into()), active: true },
            ClassStudent { id: "s2".into(), name: "乙".into(), team_id: Some("tm1".into()), active: true },
            ClassStudent { id: "s3".into(), name: "丙".into(), team_id: Some("tm2".into()), active: true },
            ClassStudent { id: "s4".into(), name: "丁".into(), team_id: Some("tm2".into()), active: true },
        ]
    }

    fn choice_q() -> Question {
        // 带题型（计分要用）：基础题、选择题
        Question::with_tier(&["甲", "乙"], "A", "basic", None)
    }

    /* ---- 与 tests/logic.test.js 第 12 组「课堂环节与大屏数据」逐条对应 ---- */

    #[test]
    fn timer_counts_down_from_a_deadline() {
        let mut rt = Runtime::default();
        assert_eq!(timer_left(&rt, 1000), None, "没在计时 → None");
        assert!(!timer_expired(&rt, 1000));

        // 开始 90 秒
        let ends = set_timer(&mut rt, 90, "随堂练习", 1_000_000).unwrap();
        assert_eq!(ends, 1_090_000, "结束时刻 = now + 90s");
        assert_eq!(rt.timer_label, "随堂练习");
        assert_eq!(timer_left(&rt, 1_000_000), Some(90_000));
        assert_eq!(timer_left(&rt, 1_045_000), Some(45_000));
        assert_eq!(timer_left(&rt, 1_090_000), Some(0), "到点即 0");
        assert_eq!(timer_left(&rt, 1_200_000), Some(0), "过点不会变负数");
        assert!(timer_expired(&rt, 1_090_001));

        // 显示口径：向上取整，59.4 秒显示 1:00，0.4 秒显示 0:01
        assert_eq!(format_left(90_000), "1:30");
        assert_eq!(format_left(59_400), "1:00");
        assert_eq!(format_left(400), "0:01");
        assert_eq!(format_left(0), "0:00");
        assert_eq!(format_left(600_000), "10:00");

        // 停止
        clear_timer(&mut rt);
        assert_eq!(timer_left(&rt, 1_000_000), None);
        assert_eq!(rt.timer_label, "");
        // seconds <= 0 也等价于停止
        set_timer(&mut rt, 30, "讨论", 0);
        assert!(timer_left(&rt, 0).is_some());
        assert_eq!(set_timer(&mut rt, 0, "", 0), None);
        assert_eq!(timer_left(&rt, 0), None, "传 0 秒 = 停止");
    }

    #[test]
    fn phases_and_labels() {
        assert_eq!(PHASES.join(","), "idle,rollcall,question,review");
        assert_eq!(phase_label("idle"), "待机");
        assert_eq!(phase_label("rollcall"), "随机点名");
        assert_eq!(phase_label("question"), "出题答题");
        assert_eq!(phase_label("review"), "点评总结");
        assert_eq!(Runtime::default().phase(), Phase::Idle, "默认处于待机环节");
        assert_eq!(Phase::parse("乱写"), Phase::Idle, "非法值落到待机");
    }

    #[test]
    fn set_phase_question_picks_first_and_accepts() {
        let mut rt = Runtime::default();
        let out = set_phase_named(&mut rt, "question", Some("q1"), Some("q9"));
        assert_eq!(out, Phase::Question);
        assert!(rt.accepting, "出题即开始接收作答");
        assert_eq!(rt.qid.as_deref(), Some("q1"), "优先当前试卷第一题");

        // 没有试卷时退回题库第一题
        let mut rt2 = Runtime::default();
        set_phase_named(&mut rt2, "question", None, Some("q9"));
        assert_eq!(rt2.qid.as_deref(), Some("q9"));

        // 都没有 → 退回待机
        let mut rt3 = Runtime::default();
        assert_eq!(set_phase_named(&mut rt3, "question", None, None), Phase::Idle, "没有题目时出题环节退回待机");
        assert!(!rt3.accepting);
    }

    #[test]
    fn set_phase_review_stops_accepting_and_rollcall_hides_answer() {
        let mut rt = Runtime { accepting: true, reveal: true, ..Default::default() };
        set_phase_named(&mut rt, "review", None, None);
        assert!(!rt.accepting, "进入点评后停止接收作答");
        rt.reveal = true;
        set_phase_named(&mut rt, "rollcall", None, None);
        assert!(!rt.reveal, "切到点名环节会收起答案");
        // 非法环节值被忽略，保持原环节
        assert_eq!(set_phase_named(&mut rt, "nonsense", None, None), Phase::Rollcall);
        assert_eq!(rt.phase, "rollcall");
    }

    #[test]
    fn pick_answerer_precedence() {
        let st = students();
        // 命令指定优先
        assert_eq!(pick_answerer(&st, Some("tm2"), Some("s1"), None).as_deref(), Some("s1"), "命令点名的人优先（哪怕是别队的）");
        // 当前学生（属于该队）
        assert_eq!(pick_answerer(&st, Some("tm1"), None, Some("s2")).as_deref(), Some("s2"));
        // 当前学生不属于该队 → 取队伍第一个成员
        assert_eq!(pick_answerer(&st, Some("tm2"), None, Some("s2")).as_deref(), Some("s3"));
        // 都没有 → 队伍第一个成员
        assert_eq!(pick_answerer(&st, Some("tm2"), None, None).as_deref(), Some("s3"));
        assert_eq!(pick_answerer(&[], Some("tm1"), None, None), None, "队伍没有成员");
    }

    /* ---- 与 tests/logic.test.js 第 9 组「多端协同：学生提交与判定」逐条对应 ---- */

    #[test]
    fn hello_writes_feed() {
        let cmd = StudentCmd { kind: "hello".into(), team_id: Some("tm1".into()), ..Default::default() };
        let r = handle_cmd(&cmd, &teams(), &students(), &Runtime::default(), None, None, false, &[], 0);
        assert_eq!(r.outcome, CmdOutcome::Hello { team_id: Some("tm1".into()) });
        assert_eq!(r.feeds.len(), 1);
        assert!(r.feeds[0].text.contains("红队"), "入座写进实时流：{}", r.feeds[0].text);
        assert_eq!(r.feeds[0].kind, "hello");
    }

    #[test]
    fn buzz_dedupes_same_team_and_question() {
        let mut buzz: Vec<Buzz> = Vec::new();
        let teams = teams();
        let st = students();
        let o1 = add_buzz(&mut buzz, &teams, &st, "tm1", None, Some("s1"), Some("q1"), None, 1);
        assert!(!o1.dup);
        assert_eq!(buzz.len(), 1);
        // 同一队同一题再抢 → 忽略
        let o2 = add_buzz(&mut buzz, &teams, &st, "tm1", None, Some("s2"), Some("q1"), None, 2);
        assert!(o2.dup, "同一队同一题只记一次");
        assert_eq!(buzz.len(), 1);
        // 另一队可以抢
        let o3 = add_buzz(&mut buzz, &teams, &st, "tm2", None, Some("s3"), Some("q1"), None, 3);
        assert!(!o3.dup);
        assert_eq!(buzz.len(), 2);
        // 新的在前
        assert_eq!(buzz[0].team_id, "tm2", "先抢到的排在后面（倒序展示）");
        // 队伍名带上，便于实时流文案
        assert_eq!(o3.team_name, "蓝队");
    }

    #[test]
    fn answer_scores_objective_questions() {
        let cmd = StudentCmd {
            kind: "answer".into(),
            team_id: Some("tm1".into()),
            sid: Some("s1".into()),
            choice: vec!["A".into()],
            ..Default::default()
        };
        let q = choice_q();
        let r = handle_cmd(&cmd, &teams(), &students(), &Runtime::default(), Some(&q), Some("q1"), false, &[], 0);
        match &r.outcome {
            CmdOutcome::AnswerScored { sid, result, .. } => {
                assert_eq!(sid, "s1");
                assert_eq!(result, "correct", "选择题答对自动判分");
            }
            other => panic!("期望自动判分，实际 {:?}", other),
        }
        assert!(r.score.is_some(), "客观题要产生记分请求");
        let req = r.score.unwrap();
        assert_eq!(req.tier, "basic", "题型取自题目");
        assert_eq!(req.result, "correct");
        // 用计分引擎算出 +3（基础题）
        let snap = score_of_input(
            &default_tiers(),
            &ScoringSettings::default(),
            &ScoreInput { sid: req.sid.clone(), qid: Some("q1".into()), question_tier: Some(req.tier.clone()), result: req.result.clone(), ..Default::default() },
        );
        assert_eq!(snap.points, 3.0, "自动加分 +3（基础题）");

        // 回填文案
        let mut feed = r.feeds[0].clone();
        finalize_feed(&mut feed, &snap, &students());
        assert!(feed.text.contains("甲"), "实时流带学生名：{}", feed.text);
        assert!(feed.text.contains("答对"), "实时流带结果：{}", feed.text);
        assert!(feed.text.contains("+3"), "实时流带分数：{}", feed.text);
        assert_eq!(feed.points, 3.0);
    }

    #[test]
    fn answer_wrong_and_duplicate_and_no_student() {
        let q = choice_q();
        // 答错
        let wrong = StudentCmd { kind: "answer".into(), team_id: Some("tm1".into()), sid: Some("s1".into()), choice: vec!["B".into()], ..Default::default() };
        let r = handle_cmd(&wrong, &teams(), &students(), &Runtime::default(), Some(&q), Some("q1"), false, &[], 0);
        match r.outcome {
            CmdOutcome::AnswerScored { result, .. } => assert_eq!(result, "wrong", "选择题答错自动判分"),
            other => panic!("期望自动判分，实际 {:?}", other),
        }

        // 重复提交
        let r2 = handle_cmd(&wrong, &teams(), &students(), &Runtime::default(), Some(&q), Some("q1"), true, &[], 0);
        assert!(matches!(r2.outcome, CmdOutcome::AnswerDuplicate { .. }), "重复提交被忽略");
        assert!(r2.feeds[0].text.contains("重复提交"), "{}", r2.feeds[0].text);

        // 队伍没有成员
        let empty_teams = vec![ClassTeam { id: "tm9".into(), name: "空队".into(), color: String::new(), icon: String::new(), member_ids: vec![] }];
        let cmd = StudentCmd { kind: "answer".into(), team_id: Some("tm9".into()), choice: vec!["A".into()], ..Default::default() };
        let r3 = handle_cmd(&cmd, &empty_teams, &students(), &Runtime::default(), Some(&q), Some("q1"), false, &[], 0);
        assert!(matches!(r3.outcome, CmdOutcome::AnswerNoStudent { .. }));
        assert!(r3.feeds[0].text.contains("队伍没有成员"), "{}", r3.feeds[0].text);
    }

    #[test]
    fn answer_subjective_goes_to_pending() {
        let subj = Question::new(&[], "");
        let cmd = StudentCmd {
            kind: "answer".into(),
            team_id: Some("tm1".into()),
            sid: Some("s1".into()),
            text: Some("我的证明".into()),
            ..Default::default()
        };
        let r = handle_cmd(&cmd, &teams(), &students(), &Runtime::default(), Some(&subj), Some("q2"), false, &[], 0);
        match r.outcome {
            CmdOutcome::AnswerPending { ref sid } => assert_eq!(sid, "s1"),
            ref other => panic!("主观题应进待确认队列，实际 {:?}", other),
        }
        let p = r.pending.expect("要有待确认条目");
        assert_eq!(p.answer, "我的证明");
        assert!(!p.backlog);
        assert!(r.feeds[0].text.contains("待确认"), "{}", r.feeds[0].text);
        assert!(r.score.is_none(), "主观题不自动记分");
    }

    #[test]
    fn feed_is_newest_first_and_capped() {
        let mut feed: Vec<FeedItem> = Vec::new();
        for i in 0..(FEED_CAP + 5) {
            push_feed(&mut feed, FeedItem {
                kind: "hello".into(), team_id: None, sid: None, qid: None, result: None,
                answer: None, expected: None, points: 0.0, text: format!("第 {} 条", i), at: i as i64,
            });
        }
        assert_eq!(feed.len(), FEED_CAP, "实时流最多 60 条");
        assert!(feed[0].text.contains(&format!("第 {}", FEED_CAP + 4)), "新的在前：{}", feed[0].text);
    }

    #[test]
    fn pending_capped_and_newest_first() {
        let mut pending: Vec<Pending> = Vec::new();
        for i in 0..(PENDING_CAP + 3) {
            add_pending(&mut pending, Pending {
                sid: format!("s{}", i), team_id: None, qid: None, quiz_id: None,
                answer: format!("答案 {}", i), backlog: false, at: i as i64,
            });
        }
        assert_eq!(pending.len(), PENDING_CAP);
        assert_eq!(pending[0].answer, format!("答案 {}", PENDING_CAP + 2));
    }

    /* ---- 大屏数据 ---- */

    #[test]
    fn team_stats_class_first_and_sorted() {
        let teams = teams();
        // 红队答对 5、蓝队答对 2；全班合计 7
        let per_team = vec![
            ("tm1".to_string(), 5u32, 6u32, 83.3, Some(12.0), 2usize),
            ("tm2".to_string(), 2u32, 4u32, 50.0, Some(5.0), 2usize),
        ];
        let out = team_stats(&teams, &per_team, (7, 10, 70.0, 4));
        assert_eq!(out.len(), teams.len() + 1, "覆盖全班 + 每支队伍");
        assert_eq!(out[0].team_id, "all", "第一行是全班合计");
        assert_eq!(out[0].correct, 7);
        assert_eq!(out[0].name, "全班");
        assert!(out[0].score.is_none(), "全班不显示队伍分");
        assert_eq!(out[1].team_id, "tm1", "按答对数降序：红队在前");
        assert_eq!(out[1].correct, 5);
        assert_eq!(out[2].team_id, "tm2");
        // 缺数据的队伍按 0 处理，不 panic
        let out2 = team_stats(&teams, &[], (0, 0, 0.0, 0));
        assert!(out2.iter().skip(1).all(|t| t.correct == 0));
    }

    #[test]
    fn pack_ability_for_stage() {
        // 四题型全对 → 六边形战士，打包后字段齐全
        let tiers: Vec<crate::ability::TierStat> = default_tiers()
            .iter()
            .map(|t| crate::ability::Bucket { attempts: 2, correct: 2, ..Default::default() }
                .finalize(&t.key, &t.label, &t.color, t.weight, 0.5))
            .collect();
        let a = ability_of_tiers(&tiers, 8, 2);
        let packed = pack_ability(&a, "all", "全班", "class");
        assert_eq!(packed.kind, "class");
        assert_eq!(packed.overall, 100);
        assert_eq!(packed.grade.label, "六边形战士");
        assert_eq!(packed.axes.len(), 4, "轴数与题型数一致");
        assert!(packed.comment.contains("六边形战士"));
        assert_eq!(packed.strongest.as_ref().map(|x| x.rate), Some(100));
        assert_eq!(packed.weakest.as_ref().map(|x| x.rate), Some(100));
    }

    #[test]
    fn tier_key_default_falls_back() {
        let tiers = default_tiers();
        assert_eq!(tier_key_default(&tiers, "improve"), "improve");
        assert_eq!(tier_key_default(&tiers, ""), "basic", "空题型回落到第一个");
        assert_eq!(scoring::tier_of(&tiers, "不存在").unwrap().key, "basic");
    }
}
