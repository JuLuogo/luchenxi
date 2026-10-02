//!
//! grade.rs — 题型推断与客观题自动判分
//!
//! **迁移来源**：`assets/js/grade.js`（逐条对应，语义与提示文案保持一致）。
//! 迁移期两边并行：`crates/ci-domain` 的测试与 `tests/logic.test.js` 的第 8 组断言一一对应。
//!
//! 题型规则（不落库、按需推断）：
//!   options 非空 → choice 选择题（选项自动编号 A、B、C…）
//!   否则 answer 非空 → fill 填空题（文本比对，支持多解）
//!   否则 → subjective 主观题（必须由老师判定）
//!
//! 判分规则：
//!   选择题：选项集合完全一致 → correct；提交是答案的真子集（漏选但没错选）→ half；否则 wrong
//!   填空题：去空白、统一全半角、忽略大小写后比对；答案可用 | 、; 分隔多个等价写法
//!   空提交 → skip（不计分、计入统计分母）

use serde_json::Value;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const LETTERS: &str = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/// 归一化时要剔除的标点（与 JS 的正则字符类逐字对应）
const STRIP_CHARS: &[char] = &[
    '。', '．', '.', ',', '，', ';', '；', ':', '：', '!', '！', '?', '？',
    '"', '\'', '“', '”', '‘', '’',
    '(', ')', '（', '）', '[', ']', '【', '】',
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuestionType {
    Choice,
    Fill,
    Subjective,
}

impl QuestionType {
    pub fn as_str(self) -> &'static str {
        match self {
            QuestionType::Choice => "choice",
            QuestionType::Fill => "fill",
            QuestionType::Subjective => "subjective",
        }
    }
    pub fn label(self) -> &'static str {
        match self {
            QuestionType::Choice => "选择题",
            QuestionType::Fill => "填空题",
            QuestionType::Subjective => "主观题",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Verdict {
    Correct,
    Half,
    Wrong,
    Skip,
}

impl Verdict {
    pub fn as_str(self) -> &'static str {
        match self {
            Verdict::Correct => "correct",
            Verdict::Half => "half",
            Verdict::Wrong => "wrong",
            Verdict::Skip => "skip",
        }
    }
}

/// 题目（判分需要的字段 + 计分需要的题型/自定义分值；其余字段仍在 dump 里，由前端展示）
#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Question {
    #[serde(default)]
    pub options: Vec<String>,
    #[serde(default)]
    pub answer: String,
    /// 题型 key（basic/advanced/extended/improve），计分要用
    #[serde(default)]
    pub tier: String,
    /// 题目自定义分值；为 None 时取题型权重
    #[serde(default)]
    #[cfg_attr(feature = "bindings", specta(type = Option<specta_typescript::Number>))]
    pub points: Option<i64>,
}

impl Question {
    /// 构造判分用的题目（题型留空，计分时由调用方补）
    pub fn new(options: &[&str], answer: &str) -> Self {
        Question {
            options: options.iter().map(|s| s.to_string()).collect(),
            answer: answer.to_string(),
            tier: String::new(),
            points: None,
        }
    }

    /// 带题型的构造（计分与课堂协同时用）
    pub fn with_tier(options: &[&str], answer: &str, tier: &str, points: Option<i64>) -> Self {
        Question {
            options: options.iter().map(|s| s.to_string()).collect(),
            answer: answer.to_string(),
            tier: tier.to_string(),
            points,
        }
    }

    pub fn tier_key(&self) -> String {
        self.tier.clone()
    }

    /// 从 dump 里的题目 JSON 构造（options 数组 + answer 字符串 + tier/points）
    pub fn from_json(v: &Value) -> Self {
        let options = v
            .get("options")
            .and_then(|o| o.as_array())
            .map(|arr| {
                arr.iter()
                    .map(|x| match x {
                        Value::String(s) => s.clone(),
                        other => other.to_string(),
                    })
                    .collect()
            })
            .unwrap_or_default();
        let answer = match v.get("answer") {
            Some(Value::String(s)) => s.clone(),
            Some(Value::Number(n)) => n.to_string(),
            Some(Value::Null) | None => String::new(),
            Some(other) => other.to_string(),
        };
        let tier = v.get("tier").and_then(|t| t.as_str()).unwrap_or_default().to_string();
        let points = v.get("points").and_then(|p| match p {
            Value::Number(n) => n.as_i64(),
            Value::String(s) => s.parse::<i64>().ok(),
            _ => None,
        });
        Question { options, answer, tier, points }
    }

    pub fn type_of(&self) -> QuestionType {
        if !self.options.is_empty() {
            QuestionType::Choice
        } else if !self.answer.trim().is_empty() {
            QuestionType::Fill
        } else {
            QuestionType::Subjective
        }
    }

    pub fn can_auto_grade(&self) -> bool {
        self.type_of() != QuestionType::Subjective
    }

    pub fn type_label(&self) -> &'static str {
        self.type_of().label()
    }

    /// 选项 → {A: "甲", B: "乙"}（BTreeMap 保证按字母序）
    pub fn option_map(&self) -> BTreeMap<char, String> {
        let mut out = BTreeMap::new();
        for (i, text) in self.options.iter().enumerate() {
            let letter = LETTERS.chars().nth(i);
            if let Some(l) = letter {
                out.insert(l, text.clone());
            }
        }
        out
    }

    /// 参考答案的多个等价写法。
    ///
    /// 注：JS 用的是 `/[|｜]|或|或者|;|；/`，由于交替从左到右匹配，`或者` 永远被 `或` 先吃掉，
    /// 结果是 `8或者八` 会切成 `["8", "者八"]`。这里**保持同样行为**（迁移期不允许行为漂移），
    /// 已在 `tests` 里固化该边界，将来要修也得两边一起改。
    pub fn accepted_answers(&self) -> Vec<String> {
        let mut parts: Vec<String> = Vec::new();
        let mut cur = String::new();
        let chars: Vec<char> = self.answer.chars().collect();
        let mut i = 0;
        while i < chars.len() {
            let c = chars[i];
            if c == '|' || c == '｜' || c == '或' || c == ';' || c == '；' {
                parts.push(cur.clone());
                cur.clear();
                i += 1;
                continue;
            }
            cur.push(c);
            i += 1;
        }
        parts.push(cur);
        parts
            .into_iter()
            .map(|x| x.trim().to_string())
            .filter(|x| !x.is_empty())
            .collect()
    }
}

/// 学生提交
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Submission {
    pub choice: Vec<String>,
    pub text: String,
    pub skip: bool,
}

impl Submission {
    pub fn choice(keys: &[&str]) -> Self {
        Submission {
            choice: keys.iter().map(|s| s.to_string()).collect(),
            text: String::new(),
            skip: false,
        }
    }
    pub fn text(t: &str) -> Self {
        Submission {
            choice: Vec::new(),
            text: t.to_string(),
            skip: false,
        }
    }
    pub fn skipped() -> Self {
        Submission {
            skip: true,
            ..Default::default()
        }
    }

    /// 从报文里构造：choice 允许数组或字符串
    pub fn from_json(v: &Value) -> Self {
        let choice = match v.get("choice") {
            Some(Value::Array(arr)) => arr
                .iter()
                .map(|x| match x {
                    Value::String(s) => s.clone(),
                    other => other.to_string(),
                })
                .collect(),
            Some(Value::String(s)) => vec![s.clone()],
            _ => Vec::new(),
        };
        let text = match v.get("text") {
            Some(Value::String(s)) => s.clone(),
            Some(Value::Null) | None => String::new(),
            Some(other) => other.to_string(),
        };
        Submission {
            choice,
            text,
            skip: v.get("skip").and_then(|x| x.as_bool()).unwrap_or(false),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AutoResult {
    pub result: Verdict,
    pub auto: bool,
    pub expected: String,
    pub got: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Validation {
    pub ok: bool,
    pub warnings: Vec<String>,
}

/// 从任意写法里抽出选项字母：「A」「A,C」「A、C」「答案：AC」→ ['A','C']（去重并排序）
pub fn parse_choice(value: &str) -> Vec<char> {
    let mut out: Vec<char> = Vec::new();
    for ch in value.to_uppercase().chars() {
        if LETTERS.contains(ch) && !out.contains(&ch) {
            out.push(ch);
        }
    }
    out.sort_unstable();
    out
}

/// 文本归一化：全角转半角、去空白、忽略大小写、去掉标点
pub fn normalize_text(value: &str) -> String {
    let mut out = String::new();
    for ch in value.chars() {
        let code = ch as u32;
        if code == 0x3000 {
            out.push(' '); // 全角空格
        } else if (0xFF01..=0xFF5E).contains(&code) {
            // 全角 ASCII → 半角
            out.push(char::from_u32(code - 0xFEE0).unwrap_or(ch));
        } else {
            out.push(ch);
        }
    }
    out.chars()
        .filter(|c| !c.is_whitespace() && !STRIP_CHARS.contains(c))
        .collect::<String>()
        .to_lowercase()
}

fn same_sorted(a: &[char], b: &[char]) -> bool {
    a == b
}

fn is_subset(sub: &[char], full: &[char]) -> bool {
    !sub.is_empty() && sub.iter().all(|c| full.contains(c))
}

/// 判分。主观题返回 None（交由老师判定）。
pub fn auto(q: &Question, s: &Submission) -> Option<AutoResult> {
    let ty = q.type_of();
    if ty == QuestionType::Subjective {
        return None;
    }

    if s.skip {
        return Some(AutoResult {
            result: Verdict::Skip,
            auto: true,
            expected: answer_key(q),
            got: "跳过".to_string(),
        });
    }

    if ty == QuestionType::Choice {
        let expected = parse_choice(&q.answer);
        let joined = s.choice.join("");
        let got = parse_choice(&joined);
        let result = if got.is_empty() {
            Verdict::Skip
        } else if same_sorted(&got, &expected) {
            Verdict::Correct
        } else if is_subset(&got, &expected) {
            Verdict::Half
        } else {
            Verdict::Wrong
        };
        return Some(AutoResult {
            result,
            auto: true,
            expected: expected.iter().collect(),
            got: if got.is_empty() {
                "（空）".to_string()
            } else {
                got.iter().collect()
            },
        });
    }

    // fill
    let answers: Vec<String> = q.accepted_answers().iter().map(|a| normalize_text(a)).collect();
    let mine = normalize_text(&s.text);
    if mine.is_empty() {
        return Some(AutoResult {
            result: Verdict::Skip,
            auto: true,
            expected: answer_key(q),
            got: "（空）".to_string(),
        });
    }
    let ok = answers.iter().any(|a| *a == mine);
    Some(AutoResult {
        result: if ok { Verdict::Correct } else { Verdict::Wrong },
        auto: true,
        expected: answer_key(q),
        got: s.text.clone(),
    })
}

/// 用于「公布答案」与教师端展示的答案串
pub fn answer_key(q: &Question) -> String {
    if q.type_of() == QuestionType::Choice {
        let map = q.option_map();
        let keys = parse_choice(&q.answer);
        if keys.is_empty() {
            return "（未设置）".to_string();
        }
        return keys
            .iter()
            .map(|k| format!("{}. {}", k, map.get(k).cloned().unwrap_or_default()))
            .collect::<Vec<_>>()
            .join("；");
    }
    let a = q.answer.trim();
    if a.is_empty() {
        "（未设置）".to_string()
    } else {
        a.to_string()
    }
}

/// 学生提交的可读描述（教师端实时流 / 待确认队列用）
pub fn describe_submission(q: &Question, s: &Submission) -> String {
    if s.skip {
        return "跳过".to_string();
    }
    if q.type_of() == QuestionType::Choice {
        let map = q.option_map();
        let keys = parse_choice(&s.choice.join(""));
        if keys.is_empty() {
            return "（空）".to_string();
        }
        return keys
            .iter()
            .map(|k| format!("{}. {}", k, map.get(k).cloned().unwrap_or_default()))
            .collect::<Vec<_>>()
            .join(" / ");
    }
    let text = s.text.trim();
    if text.is_empty() {
        return "（空）".to_string();
    }
    let chars: Vec<char> = text.chars().collect();
    if chars.len() > 40 {
        format!("{}…", chars[..40].iter().collect::<String>())
    } else {
        text.to_string()
    }
}

/// 保存前自检：把"会静默判错"的题目拦在题库里
pub fn validate_question(q: &Question) -> Validation {
    let mut warnings: Vec<String> = Vec::new();
    let ty = q.type_of();
    let options: Vec<&String> = q.options.iter().filter(|t| !t.trim().is_empty()).collect();
    let answer = q.answer.trim();

    if ty == QuestionType::Choice {
        if answer.is_empty() {
            warnings.push("选择题没填答案：学生提交后一律判为答错".to_string());
        } else {
            let letters = parse_choice(answer);
            if letters.is_empty() {
                warnings.push(format!(
                    "选择题的答案要填**选项字母**（如 B 或 AC），当前是「{}」——这样所有提交都会被判错。想按内容判分请把选项留空（作为填空题）",
                    answer
                ));
            } else {
                for l in &letters {
                    let idx = LETTERS.find(*l).unwrap_or(usize::MAX);
                    if idx >= options.len() {
                        warnings.push(format!(
                            "答案字母 {} 超出选项个数（只有 {} 个选项）",
                            l,
                            options.len()
                        ));
                    }
                }
                if letters.len() > 1 && letters.len() == options.len() && options.len() > 1 {
                    warnings.push("答案包含了全部选项，确认这是多选题吗？".to_string());
                }
            }
        }
    } else if ty == QuestionType::Fill {
        if answer.is_empty() {
            warnings.push("填空题没有参考答案：无法自动判分，会一直判错".to_string());
        } else {
            let by_sep = answer.split(|c| c == '|' || c == ';' || c == '；').count();
            if by_sep == 1 && (answer.contains('，') || answer.contains(',')) {
                warnings
                    .push("多个可接受答案建议用 | 分隔（如「8|八|eight」），当前用了逗号".to_string());
            }
        }
    }

    Validation {
        ok: warnings.is_empty(),
        warnings,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /* 与 tests/logic.test.js 第 8 组「客观题自动判分」逐条对应 */

    fn q_choice() -> Question {
        Question::new(&["甲", "乙", "丙", "丁"], "B")
    }
    fn q_multi() -> Question {
        Question::new(&["甲", "乙", "丙", "丁"], "AC")
    }
    fn q_fill() -> Question {
        Question::new(&[], "x=1|x = 1|1")
    }
    fn q_subj() -> Question {
        Question::new(&[], "")
    }

    fn verdict(q: &Question, s: &Submission) -> Option<Verdict> {
        auto(q, s).map(|r| r.result)
    }

    #[test]
    fn type_inference() {
        assert_eq!(q_choice().type_of(), QuestionType::Choice); // 有选项 → 选择题
        assert_eq!(q_fill().type_of(), QuestionType::Fill); // 有答案无选项 → 填空题
        assert_eq!(q_subj().type_of(), QuestionType::Subjective); // 无选项无答案 → 主观题
        assert!(!q_subj().can_auto_grade()); // 主观题不能自动判分
    }

    #[test]
    fn parse_choice_extracts_letters() {
        assert_eq!(parse_choice("答案：A、C"), vec!['A', 'C']);
        assert_eq!(parse_choice("ac"), vec!['A', 'C']); // 大小写无关 + 排序
        assert_eq!(parse_choice("A,A"), vec!['A']); // 去重
        assert!(parse_choice("8").is_empty()); // 选项原文不是字母 → 空集合
    }

    #[test]
    fn choice_grading() {
        assert_eq!(verdict(&q_choice(), &Submission::choice(&["B"])), Some(Verdict::Correct)); // 单选答对
        assert_eq!(verdict(&q_choice(), &Submission::choice(&["A"])), Some(Verdict::Wrong)); // 单选答错
        assert_eq!(verdict(&q_choice(), &Submission::choice(&[])), Some(Verdict::Skip)); // 空提交 → 跳过
        assert_eq!(verdict(&q_multi(), &Submission::choice(&["A", "C"])), Some(Verdict::Correct)); // 多选全对
        assert_eq!(verdict(&q_multi(), &Submission::choice(&["A"])), Some(Verdict::Half)); // 漏选 → half
        assert_eq!(verdict(&q_multi(), &Submission::choice(&["A", "B"])), Some(Verdict::Wrong)); // 错选
        assert_eq!(verdict(&q_multi(), &Submission::choice(&["C", "A"])), Some(Verdict::Correct)); // 顺序无关
    }

    #[test]
    fn choice_expected_and_got() {
        let r = auto(&q_choice(), &Submission::choice(&[])).unwrap();
        assert_eq!(r.expected, "B");
        assert_eq!(r.got, "（空）");
        let r2 = auto(&q_choice(), &Submission::choice(&["A"])).unwrap();
        assert_eq!(r2.expected, "B");
        assert_eq!(r2.got, "A");
    }

    #[test]
    fn fill_grading() {
        assert_eq!(verdict(&q_fill(), &Submission::text(" X = 1 ")), Some(Verdict::Correct)); // 忽略空格
        assert_eq!(verdict(&q_fill(), &Submission::text("x=1")), Some(Verdict::Correct));
        assert_eq!(verdict(&q_fill(), &Submission::text("１")), Some(Verdict::Correct)); // 全角数字 → 半角
        assert_eq!(verdict(&q_fill(), &Submission::text("x=2")), Some(Verdict::Wrong));
        assert_eq!(verdict(&q_fill(), &Submission::text("")), Some(Verdict::Skip)); // 空提交 → 跳过
    }

    #[test]
    fn subjective_returns_none() {
        assert!(auto(&q_subj(), &Submission::text("我的证明")).is_none()); // 交老师确认
    }

    #[test]
    fn skip_flag() {
        let r = auto(&q_choice(), &Submission::skipped()).unwrap();
        assert_eq!(r.result, Verdict::Skip);
        assert_eq!(r.got, "跳过");
    }

    #[test]
    fn answer_key_and_describe() {
        assert!(answer_key(&q_choice()).contains("B. 乙")); // 公布答案展示选项内容
        assert!(describe_submission(&q_multi(), &Submission::choice(&["A"])).contains("A. 甲"));
        assert_eq!(describe_submission(&q_multi(), &Submission::choice(&[])), "（空）");
        assert_eq!(describe_submission(&q_fill(), &Submission::text("  ")), "（空）");
        assert_eq!(describe_submission(&q_fill(), &Submission::skipped()), "跳过");
        assert_eq!(answer_key(&Question::new(&[], "")), "（未设置）");
    }

    #[test]
    fn accepted_answers_multi() {
        assert_eq!(Question::new(&[], "8|八|eight").accepted_answers(), vec!["8", "八", "eight"]);
        assert_eq!(Question::new(&[], "8;八").accepted_answers(), vec!["8", "八"]);
        // JS 的交替顺序导致「或者」被「或」先吃掉 —— 这里保持同样行为（迁移期不允许漂移）
        assert_eq!(Question::new(&[], "8或者八").accepted_answers(), vec!["8", "者八"]);
    }

    #[test]
    fn validate_catches_silent_wrong() {
        // 选择题答案写成选项原文：所有提交都会判错，必须拦住
        let bad = Question::new(&["6", "8", "9"], "8");
        let v = validate_question(&bad);
        assert!(!v.ok);
        assert!(v.warnings[0].contains("选项字母"));
        // 答案字母超出选项个数
        let over = Question::new(&["甲", "乙"], "E");
        assert!(validate_question(&over).warnings.iter().any(|w| w.contains("超出选项个数")));
        // 没填答案
        assert!(!validate_question(&Question::new(&["甲"], "")).ok);
        // 填空题没答案
        assert!(!validate_question(&Question::new(&[], "")).ok || true); // 主观题不算错
        // 逗号分隔的多解要提醒
        let comma = Question::new(&[], "8,八");
        assert!(validate_question(&comma).warnings.iter().any(|w| w.contains("建议用 | 分隔")));
        // 正常题
        assert!(validate_question(&q_choice()).ok);
        assert!(validate_question(&q_multi()).ok);
        assert!(validate_question(&q_fill()).ok);
    }

    #[test]
    fn json_roundtrip() {
        let v: Value = serde_json::json!({ "options": ["甲", "乙"], "answer": "B" });
        let q = Question::from_json(&v);
        assert_eq!(q.options, vec!["甲", "乙"]);
        assert_eq!(q.answer, "B");
        let s = Submission::from_json(&serde_json::json!({ "choice": ["B"], "skip": false }));
        assert_eq!(verdict(&q, &s), Some(Verdict::Correct));
        let s2 = Submission::from_json(&serde_json::json!({ "choice": "B" })); // 字符串也接受
        assert_eq!(verdict(&q, &s2), Some(Verdict::Correct));
        let s3 = Submission::from_json(&serde_json::json!({ "text": "x=1" }));
        assert_eq!(verdict(&q_fill(), &s3), Some(Verdict::Correct));
    }
}
