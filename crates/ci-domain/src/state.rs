//! state.rs — 整份课堂状态的结构化建模
//!
//! **迁移来源**：`assets/js/store.js` 的 `defaultState()` 与各 `normalize*`，
//! 以及 `classroom.js` 懒创建的 `classroom.{buzz,pending,feed}`。
//!
//! 为什么需要它：P3 要求"前端类型由 specta 生成"，而前端最核心的类型就是
//! `CI.store.get()` 返回的那份状态。之前前端只能手抄一份 `state.ts`（会过期），
//! 现在这份形状有了 Rust 定义，绑定就真正闭环了。
//!
//! 与既有类型的分工：
//!   · `grade::Question` —— **判分**需要的最小子集（options/answer/tier/points）
//!   · `state::BankQuestion` —— 题库里的完整题目（含 stem/tags/archived…），
//!     提供 `to_grade_question()` 转成判分子集
//!   · `scoring::ScoringSettings` —— 只含算分三项；`state::Settings` 是课堂设置全集
//!   · `classroom::ClassStudent` —— 课堂协同用到的学生视图；`state::Student` 是持久化实体
//!
//! 注意：这些结构体是**形状契约**，作用域是"JSON 里长什么样"，不是"谁来写它"。
//! 实际写入目前仍由 `assets/js/store.js` 完成（迁移期），Rust 侧先做类型与落库。

use crate::classroom::{Buzz, FeedItem, Pending, Runtime};
use crate::scoring::Tier;
use serde::{Deserialize, Serialize};

/* ------------------------------------------------------------------ *
 * 课堂设置
 * ------------------------------------------------------------------ */

/// 课堂设置（`state.settings` 全集）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub course_name: String,
    /// 部分正确计分系数
    pub half_ratio: f64,
    /// 答错扣分（正数表示扣多少分）
    pub wrong_penalty: f64,
    /// 抢答额外加分（仅"答对"时生效）
    pub fast_bonus: f64,
    /// 正确率低于该值 → 薄弱
    pub weak_threshold: f64,
    /// 正确率高于该值 → 优势
    pub strong_threshold: f64,
    /// 「快捷记分」是否计入作答次数（默认 true；只影响统计，不影响积分）
    #[serde(default)]
    pub quick_counts_as_attempt: Option<bool>,
    /// 判定薄弱/优势所需最少作答次数
    #[cfg_attr(feature = "bindings", specta(type = specta_typescript::Number))]
    pub min_sample: i64,
    /// 多维度评价权重（正确性 / 参与度 / 进步）—— 调研：权重没有实证最优值，属课程政策
    #[serde(default)]
    pub eval_weights: crate::composite::EvalWeights,
    /// 掌握度衰减平均系数：最近一次占多少（默认 0.65，看重"现在会什么"）
    #[serde(default = "default_decay_ratio")]
    pub decay_ratio: f64,
    /// 手动加减分的上限（防通胀：单次加分不超过它，默认 +2）
    #[serde(default = "default_cap_plus")]
    pub manual_cap_plus: f64,
    /// 手动加减分的下限（单次扣分不低于它，默认 −1）
    #[serde(default = "default_cap_minus")]
    pub manual_cap_minus: f64,
    /// 公开课现场评价量规（维度名/权重/锚点）—— **课程政策**，各校评课表不同，所以可配置。
    /// 默认 基础 30 / 拓展 30 / 表达 25 / 态度 15。
    #[serde(default = "default_open_dims")]
    pub open_dimensions: Vec<crate::openclass::OpenDimension>,
}

fn default_decay_ratio() -> f64 {
    0.65
}

fn default_cap_plus() -> f64 {
    2.0
}

fn default_cap_minus() -> f64 {
    -1.0
}

fn default_open_dims() -> Vec<crate::openclass::OpenDimension> {
    crate::openclass::default_open_dimensions()
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            course_name: "24机械高考公开课".to_string(),
            half_ratio: 0.5,
            wrong_penalty: 0.0,
            fast_bonus: 0.0,
            weak_threshold: 0.6,
            strong_threshold: 0.85,
            quick_counts_as_attempt: Some(true),
            min_sample: 5,
            eval_weights: crate::composite::EvalWeights::default(),
            decay_ratio: 0.65,
            manual_cap_plus: 2.0,
            manual_cap_minus: -1.0,
            open_dimensions: default_open_dims(),
        }
    }
}

/* ------------------------------------------------------------------ *
 * 队伍 / 学生
 * ------------------------------------------------------------------ */

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct Team {
    pub id: String,
    pub name: String,
    pub icon: String,
    pub color: String,
    #[cfg_attr(feature = "bindings", specta(type = specta_typescript::Number))]
    pub order: i64,
}

/// 学生（持久化实体）
///
/// `called` 是"被点名次数"，与 `rollcall::Student` 的对应字段一致；
/// 之所以这里也要带上，是因为教师端名单页会直接读它。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct Student {
    pub id: String,
    pub name: String,
    pub team_id: Option<String>,
    pub active: bool,
    #[cfg_attr(feature = "bindings", specta(type = specta_typescript::Number))]
    pub joined_at: i64,
    #[cfg_attr(feature = "bindings", specta(type = specta_typescript::Number))]
    pub called: i64,
}

/* ------------------------------------------------------------------ *
 * 题库 / 流水 / 试卷
 * ------------------------------------------------------------------ */

/// 题库里的完整题目
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct BankQuestion {
    pub id: String,
    pub tier: String,
    /// 自定义分值；None 表示取题型权重
    #[cfg_attr(feature = "bindings", specta(type = Option<specta_typescript::Number>))]
    pub points: Option<i64>,
    pub stem: String,
    pub answer: String,
    pub options: Vec<String>,
    pub tags: Vec<String>,
    pub source: String,
    pub note: String,
    /// 题目配图（数学图形题刚需）：图片 URL 或 data:URI；空串表示没有图
    #[serde(default)]
    pub image_url: String,
    pub archived: bool,
    #[cfg_attr(feature = "bindings", specta(type = specta_typescript::Number))]
    pub created_at: i64,
}

impl BankQuestion {
    /// 转成判分需要的最小子集
    pub fn to_grade_question(&self) -> crate::grade::Question {
        crate::grade::Question {
            options: self.options.clone(),
            answer: self.answer.clone(),
            tier: self.tier.clone(),
            points: self.points,
        }
    }
}

/// 一条积分流水（与 `store.js` 的 `normalizeRecord` 字段一致）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct ScoreRecord {
    pub id: String,
    pub sid: Option<String>,
    pub qid: Option<String>,
    /// 计分时的题型快照（题干/权重改动不影响历史）
    pub tier: String,
    pub quiz_id: Option<String>,
    pub result: String,
    /// 该题基准分
    // 金额字段永远是有限数：显式导成 number，前端不必到处判空
    #[cfg_attr(feature = "bindings", specta(type = specta_typescript::Number))]
    pub base: f64,
    // 金额字段永远是有限数：显式导成 number，前端不必到处判空
    #[cfg_attr(feature = "bindings", specta(type = specta_typescript::Number))]
    pub ratio: f64,
    /// 实际记入积分（可为负）
    // 金额字段永远是有限数：显式导成 number，前端不必到处判空
    #[cfg_attr(feature = "bindings", specta(type = specta_typescript::Number))]
    pub points: f64,
    pub source: String,
    pub note: String,
    /// 学生具体选了哪些选项（如 "AB"）—— 用于"错选分布"（哪个干扰项最吸引人）
    #[serde(default)]
    pub picked: String,
    #[cfg_attr(feature = "bindings", specta(type = specta_typescript::Number))]
    pub at: i64,
    /// 操作来源页签，便于排查
    pub by: String,
}

/// 试卷
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct Quiz {
    pub id: String,
    pub name: String,
    pub note: String,
    #[cfg_attr(feature = "bindings", specta(type = specta_typescript::Number))]
    pub created_at: i64,
    /// 0 表示未关闭
    #[cfg_attr(feature = "bindings", specta(type = specta_typescript::Number))]
    pub closed_at: i64,
    pub question_ids: Vec<String>,
    /// 本套题的流水（与全局 records 是同一批数据的两处索引）
    pub records: Vec<ScoreRecord>,
}

/* ------------------------------------------------------------------ *
 * 点名 / 日志 / 课堂协同
 * ------------------------------------------------------------------ */

/// 一次点名记录
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct RollHistoryEntry {
    pub id: String,
    pub sid: String,
    #[cfg_attr(feature = "bindings", specta(type = specta_typescript::Number))]
    pub at: i64,
    pub quiz_id: Option<String>,
    pub qid: Option<String>,
}

/// 点名设置与轮次池（`state.rollcall`）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct RollcallState {
    /// even=轮次池均匀 / random=纯随机 / least=最少被点优先
    pub mode: String,
    /// 'all' 或队伍 id
    pub scope: String,
    pub exclude_answered: bool,
    #[cfg_attr(feature = "bindings", specta(type = specta_typescript::Number))]
    pub recent_exclude: i64,
    pub history: Vec<RollHistoryEntry>,
    /// 本轮尚未被点到的学生 id
    pub round_pool: Vec<String>,
    #[cfg_attr(feature = "bindings", specta(type = specta_typescript::Number))]
    pub round: i64,
}

impl Default for RollcallState {
    fn default() -> Self {
        RollcallState {
            mode: "even".to_string(),
            scope: "all".to_string(),
            exclude_answered: false,
            recent_exclude: 1,
            history: Vec::new(),
            round_pool: Vec::new(),
            round: 1,
        }
    }
}

/// 审计日志
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct LogItem {
    pub id: String,
    /// 日志类型（"添加学生"/"课堂环节"/"抢答"…）
    #[serde(rename = "type", default)]
    pub kind: String,
    pub detail: String,
    /// 时间戳 —— JS 侧这个字段叫 `ts`，所以直接按它序列化（specta 不支持 alias）
    #[cfg_attr(feature = "bindings", specta(type = specta_typescript::Number))]
    #[serde(rename = "ts")]
    pub at: i64,
}

/// 课堂协同的即时状态（`state.classroom`，由 classroom.js 懒创建）
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct ClassroomBox {
    pub buzz: Vec<Buzz>,
    pub pending: Vec<Pending>,
    pub feed: Vec<FeedItem>,
    /// 公开课现场状态（点名 → 抽题 → 判定 → 评价）—— 大屏与学生端据此同步显示。

    /// 日常课为 None，公开课页面开始后才有值。
    #[serde(default)]
    pub open: Option<OpenClassState>,
}

/// 一条公开课评价留痕
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct OpenRecord {
    #[serde(default)]
    pub sid: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub qid: Option<String>,
    /// 题干快照（题目之后被删也能看懂这条记录）
    #[serde(default)]
    pub stem: String,
    /// correct | half | wrong（没判定时为空）
    #[serde(default)]
    pub verdict: String,
    /// 现场评价（四维四档的结果）
    #[serde(default)]
    pub evaluation: Option<crate::openclass::OpenEvaluation>,
    #[serde(default)]
    #[cfg_attr(feature = "bindings", specta(type = specta_typescript::Number))]
    pub at: i64,
}

/// 公开课现场状态（一次现场问答 + 评价）
///
/// 刻意只放"大屏与学生端要看到的东西"：被点到的学生、当前题、判定结果、四维评价。
/// 量规本身在 `openclass.rs`，这里只存**这一次的结果**。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct OpenClassState {
    /// 当前进行到哪一步：rollcall | question | verdict | eval
    #[serde(default)]
    pub step: String,
    #[serde(default)]
    pub sid: Option<String>,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub qid: Option<String>,
    /// correct | half | wrong（没判定时为空）
    #[serde(default)]
    pub verdict: String,
    /// 这一次现场评价的结果（没评时 None）—— 用有类型的 OpenEvaluation，specta 才能生成 TS
    pub evaluation: Option<crate::openclass::OpenEvaluation>,
}

/* ------------------------------------------------------------------ *
 * 整份状态
 * ------------------------------------------------------------------ */

/// 整份课堂状态（`CI.store.get()` 的返回形状）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct ClassroomState {
    #[cfg_attr(feature = "bindings", specta(type = specta_typescript::Number))]
    pub version: i64,
    #[cfg_attr(feature = "bindings", specta(type = specta_typescript::Number))]
    pub rev: i64,
    #[cfg_attr(feature = "bindings", specta(type = specta_typescript::Number))]
    pub updated_at: i64,
    pub settings: Settings,
    pub tiers: Vec<Tier>,
    pub tags: Vec<String>,
    pub teams: Vec<Team>,
    pub students: Vec<Student>,
    pub bank: Vec<BankQuestion>,
    pub quizzes: Vec<Quiz>,
    pub current_quiz_id: Option<String>,
    pub rollcall: RollcallState,
    pub logs: Vec<LogItem>,
    /// 运行时上下文（本地记忆，不参与同步）
    pub runtime: Runtime,
    pub classroom: ClassroomBox,
    /// 公开课评价留痕（每次"完成，请下一位"追加一条）—— 公开课结束后要能回看与导出。
    /// 与 classroom.open 的区别：open 是**当前正在进行的这一次**（会被清空），
    /// openRecords 是**历史**，一直留着。
    #[serde(default)]
    pub open_records: Vec<OpenRecord>,
}

impl Default for ClassroomState {
    fn default() -> Self {
        ClassroomState {
            version: 2,
            rev: 1,
            updated_at: 0,
            settings: Settings::default(),
            tiers: crate::scoring::default_tiers(),
            tags: vec![
                "集合与逻辑".into(),
                "函数与导数".into(),
                "三角函数".into(),
                "数列".into(),
                "立体几何".into(),
                "解析几何".into(),
                "概率统计".into(),
            ],
            teams: Vec::new(),
            students: Vec::new(),
            bank: Vec::new(),
            quizzes: Vec::new(),
            current_quiz_id: None,
            rollcall: RollcallState::default(),
            logs: Vec::new(),
            runtime: Runtime::default(),
            classroom: ClassroomBox::default(),
            open_records: Vec::new(),
        }
    }
}

impl ClassroomState {
    /// 按 id 找学生
    pub fn student(&self, sid: &str) -> Option<&Student> {
        self.students.iter().find(|s| s.id == sid)
    }

    /// 按 id 找题目
    pub fn question(&self, qid: &str) -> Option<&BankQuestion> {
        self.bank.iter().find(|q| q.id == qid)
    }

    /// 当前试卷
    pub fn current_quiz(&self) -> Option<&Quiz> {
        let id = self.current_quiz_id.as_deref()?;
        self.quizzes.iter().find(|q| q.id == id)
    }

    /// 队伍学生
    pub fn students_of(&self, team_id: &str) -> Vec<&Student> {
        self.students
            .iter()
            .filter(|s| s.team_id.as_deref() == Some(team_id))
            .collect()
    }

    /// 某个学生当前积分（流水求和；与 JS 的 scoreOf 一致）
    pub fn score_of(&self, sid: &str) -> f64 {
        crate::scoring::round2(
            self.records_of(sid).iter().map(|r| r.points).sum::<f64>(),
        )
    }

    /// 某个学生的流水（全局列表里筛）
    pub fn records_of(&self, sid: &str) -> Vec<&ScoreRecord> {
        // 全局流水在 quizzes[].records 里（JS 的 recordsOf 也是从这里取的）
        self.quizzes
            .iter()
            .flat_map(|q| q.records.iter())
            .filter(|r| r.sid.as_deref() == Some(sid))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> ClassroomState {
        let mut s = ClassroomState::default();
        s.teams.push(Team {
            id: "tm1".into(),
            name: "红队".into(),
            icon: "🔴".into(),
            color: "#e11d48".into(),
            order: 0,
        });
        s.students.push(Student {
            id: "s1".into(),
            name: "甲".into(),
            team_id: Some("tm1".into()),
            active: true,
            joined_at: 1,
            called: 0,
        });
        s.bank.push(BankQuestion {
            id: "q1".into(),
            tier: "basic".into(),
            points: None,
            stem: "1+1=?".into(),
            answer: "2".into(),
            options: vec![],
            tags: vec!["集合与逻辑".into()],
            source: String::new(),
            note: String::new(),
            image_url: String::new(),
            archived: false,
            created_at: 1,
        });
        s
    }

    #[test]
    fn defaults_match_js() {
        let d = ClassroomState::default();
        assert_eq!(d.settings.half_ratio, 0.5);
        assert_eq!(d.settings.weak_threshold, 0.6);
        assert_eq!(d.settings.strong_threshold, 0.85);
        // 2026-10：从 2 提到 5 —— 少于 5 题的等级分类极不稳定（调研：单次评价 <5 题不生成等级）
        assert_eq!(d.settings.min_sample, 5);
        assert_eq!(d.settings.course_name, "24机械高考公开课");
        assert_eq!(d.tiers.len(), 4, "默认四个题型");
        assert_eq!(d.tags.len(), 7, "默认七个标签");
        assert_eq!(d.rollcall.mode, "even");
        assert_eq!(d.rollcall.recent_exclude, 1);
        assert_eq!(d.rollcall.round, 1);
        assert_eq!(d.version, 2);
    }

    #[test]
    fn lookups_and_scores() {
        let mut s = sample();
        assert_eq!(s.student("s1").unwrap().name, "甲");
        assert!(s.student("nope").is_none());
        assert_eq!(s.question("q1").unwrap().stem, "1+1=?");
        assert!(s.current_quiz().is_none(), "默认没有当前试卷");
        assert_eq!(s.students_of("tm1").len(), 1);
        assert_eq!(s.students_of("tm2").len(), 0);
        assert_eq!(s.score_of("s1"), 0.0, "没有流水就是 0 分");

        // 加两条流水后求和（含负数，验证 round2）
        s.quizzes.push(Quiz {
            id: "qz1".into(),
            name: "随堂测".into(),
            note: String::new(),
            created_at: 1,
            closed_at: 0,
            question_ids: vec!["q1".into()],
            records: vec![
                ScoreRecord {
                    id: "rc1".into(), sid: Some("s1".into()), qid: Some("q1".into()),
                    tier: "basic".into(), quiz_id: Some("qz1".into()), result: "correct".into(),
                    base: 3.0, ratio: 1.0, points: 3.0, source: "quiz".into(),
                    note: String::new(), picked: "A".into(), at: 1, by: String::new(),
                },
                ScoreRecord {
                    id: "rc2".into(), sid: Some("s1".into()), qid: None,
                    tier: String::new(), quiz_id: None, result: "manual".into(),
                    base: 0.0, ratio: 0.0, points: -0.5, source: "manual".into(),
                    note: String::new(), picked: String::new(), at: 2, by: String::new(),
                },
            ],
        });
        s.current_quiz_id = Some("qz1".into());
        assert_eq!(s.score_of("s1"), 2.5);
        assert_eq!(s.records_of("s1").len(), 2);
        assert_eq!(s.current_quiz().unwrap().name, "随堂测");
    }

    #[test]
    fn bank_question_image_url_is_camel_case() {
        // 前端发的是 JS 对象（imageUrl）；Rust 侧必须按驼峰收发，
        // 否则配图字段会被 serde 静默忽略（迁移里抓到过好几次这类"静默错值"）
        let q = BankQuestion {
            id: "q1".into(),
            tier: "basic".into(),
            points: None,
            stem: "如图，求阴影面积".into(),
            answer: "6".into(),
            options: vec![],
            tags: vec![],
            source: String::new(),
            note: String::new(),
            image_url: "./images/图1.png".into(),
            archived: false,
            created_at: 0,
        };

        // 序列化用驼峰
        let out = serde_json::to_string(&q).unwrap();
        assert!(out.contains("\"imageUrl\":\"./images/图1.png\""), "序列化用驼峰：{}", out);

        // 反序列化认驼峰
        let back: BankQuestion = serde_json::from_str(&out).expect("应能反序列化");
        assert_eq!(back.image_url, "./images/图1.png", "驼峰 imageUrl → image_url");

        // 缺字段时默认为空串（老备份/老数据没有这个字段）
        let no_image = r#"{"id":"q2","tier":"basic","points":null,"stem":"x","answer":"","options":[],"tags":[],"source":"","note":"","archived":false,"createdAt":0}"#;
        let bare: BankQuestion = serde_json::from_str(no_image).expect("缺 imageUrl 也要能读");
        assert_eq!(bare.image_url, "", "缺字段时默认为空串");

        // 判分子集不受配图影响
        let g = q.to_grade_question();
        assert_eq!(g.answer, "6");
    }

    #[test]
    fn bank_question_to_grade_subset() {
        let mut q = BankQuestion {
            id: "q1".into(),
            tier: "advanced".into(),
            points: Some(7),
            stem: "题干".into(),
            answer: "A".into(),
            options: vec!["A".into(), "B".into()],
            tags: vec![],
            source: String::new(),
            note: String::new(),
            image_url: String::new(),
            archived: false,
            created_at: 0,
        };
        let g = q.to_grade_question();
        assert_eq!(g.answer, "A");
        assert_eq!(g.options.len(), 2);
        assert_eq!(g.tier_key(), "advanced");
        assert_eq!(g.points, Some(7));
        // 判分子集跑一遍：选 A 判对
        let sub = crate::grade::Submission { choice: vec!["A".into()], text: String::new(), skip: false };
        assert!(crate::grade::auto(&g, &sub).is_some());
        q.points = None;
        assert_eq!(q.to_grade_question().points, None);
    }

    #[test]
    fn serde_roundtrip_keeps_json_shape() {
        // 形状契约：反序列化一份"JS 风格"的 JSON（蛇形字段名由 serde 处理）
        let json = serde_json::json!({
            "version": 2, "rev": 7, "updatedAt": 123,
            "settings": { "courseName": "公开课", "halfRatio": 0.4, "wrongPenalty": 2,
                          "fastBonus": 1, "weakThreshold": 0.5, "strongThreshold": 0.9, "minSample": 3 },
            "tiers": [{ "key": "basic", "label": "基础题", "weight": 3, "color": "#66bb6a", "desc": "" }],
            "tags": ["集合与逻辑"],
            "teams": [{ "id": "tm1", "name": "红队", "icon": "🔴", "color": "#f00", "order": 0 }],
            "students": [{ "id": "s1", "name": "甲", "teamId": "tm1", "active": true, "joinedAt": 9, "called": 2 }],
            "bank": [{ "id": "q1", "tier": "basic", "points": 5, "stem": "题", "answer": "A",
                       "options": ["A"], "tags": [], "source": "", "note": "", "archived": false, "createdAt": 1 }],
            "quizzes": [{ "id": "qz1", "name": "测", "note": "", "createdAt": 1, "closedAt": 0,
                          "questionIds": ["q1"], "records": [] }],
            "currentQuizId": "qz1",
            "rollcall": { "mode": "random", "scope": "tm1", "excludeAnswered": true,
                          "recentExclude": 2, "history": [], "roundPool": ["s1"], "round": 3 },
            // 日志时间字段 JS 侧叫 ts（Rust 用 #[serde(rename = "ts")] 对齐）
            "logs": [{ "id": "lg1", "type": "添加学生", "detail": "甲", "ts": 5 }],
            "runtime": { "phase": "question", "quizId": "qz1", "qid": "q1", "accepting": true, "reveal": false, "sid": "s1",
                         "timerEndsAt": 0, "timerLabel": "" },
            "classroom": { "buzz": [], "pending": [], "feed": [] }
        });
        // 用默认状态打底再合并覆盖项：手写全字段的 JSON 会随结构演进而腐烂
        // （本轮就补了 timerLabel、tiers[].color…）。这样断言仍针对下面这些具体值，
        // 但不必把每个字段都抄一遍。
        let mut merged = serde_json::to_value(ClassroomState::default()).unwrap();
        fn merge(dst: &mut serde_json::Value, src: &serde_json::Value) {
            match (dst, src) {
                (serde_json::Value::Object(d), serde_json::Value::Object(s)) => {
                    for (k, v) in s {
                        merge(d.entry(k.clone()).or_insert(serde_json::Value::Null), v);
                    }
                }
                (d, s) => *d = s.clone(),
            }
        }
        merge(&mut merged, &json);
        let s: ClassroomState = serde_json::from_value(merged).expect("反序列化失败");
        assert_eq!(s.rev, 7);
        assert_eq!(s.settings.half_ratio, 0.4);
        assert_eq!(s.settings.wrong_penalty, 2.0);
        assert_eq!(s.settings.min_sample, 3);
        assert_eq!(s.tiers.len(), 1);
        assert_eq!(s.students[0].team_id.as_deref(), Some("tm1"));
        assert_eq!(s.students[0].called, 2);
        assert_eq!(s.bank[0].points, Some(5));
        assert_eq!(s.current_quiz_id.as_deref(), Some("qz1"));
        assert_eq!(s.rollcall.mode, "random");
        assert_eq!(s.rollcall.round, 3);
        assert_eq!(s.logs[0].kind, "添加学生", "日志类型字段名是 type");
        assert_eq!(s.runtime.phase, "question");
        assert!(s.runtime.accepting);

        // 再序列化回去，字段名要一致（前端读的就是这套名字）
        let out = serde_json::to_value(&s).unwrap();
        assert!(out.get("updatedAt").is_some(), "驼峰字段名");
        assert!(out.get("currentQuizId").is_some());
        assert_eq!(out["logs"][0]["type"], serde_json::json!("添加学生"));
        assert_eq!(out["settings"]["halfRatio"], serde_json::json!(0.4));
    }

    #[test]
    fn shape_is_strict_and_default_serializes_everything() {
        // 这份结构体是**形状契约**：JS 的 defaultState() 永远写全这些字段，
        // 所以这里刻意不给 #[serde(default)] —— 前端因此能拿到非可选类型，
        // 少写一堆 `?.`。代价是缺字段的 JSON 会被拒绝，这是故意的。
        let missing = serde_json::from_value::<ClassroomState>(serde_json::json!({ "rev": 3 }));
        assert!(missing.is_err(), "缺字段应当被拒绝（否则前端类型会变可空）");

        // 默认值序列化后必须字段齐全
        let out = serde_json::to_value(ClassroomState::default()).unwrap();
        for key in [
            "version", "rev", "updatedAt", "settings", "tiers", "tags", "teams", "students",
            "bank", "quizzes", "currentQuizId", "rollcall", "logs", "runtime", "classroom",
        ] {
            assert!(out.get(key).is_some(), "序列化结果缺少 {key}");
        }
        // 嵌套结构也要齐
        for key in [
            "courseName", "halfRatio", "wrongPenalty", "fastBonus", "weakThreshold",
            "strongThreshold", "minSample",
        ] {
            assert!(out["settings"].get(key).is_some(), "settings 缺少 {key}");
        }
        assert_eq!(out["classroom"]["buzz"], serde_json::json!([]));
        assert_eq!(out["rollcall"]["round"], serde_json::json!(1));
    }
}
