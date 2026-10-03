//! polish.rs — AI 润色的**提示词构造**（公开课评语的可选增强）
//!
//! 为什么把提示词放进领域层：它**是一条规则**，不是随手拼的字符串 ——
//! 它编码了本项目对 AI 的硬约束（见 `docs/15-公开课模式设计.md` §3）：
//!
//!   1. **只润色措辞，不得新增判断** —— 事实全部由 `openclass::open_comment` 给出
//!   2. **不得出现学生姓名** —— 请求体里根本没有姓名（隐私）
//!   3. 输出长度受限 —— 评语要能当众念，不是作文
//!
//! 依据：Kluger & DeNisi (1996) 的元分析显示 >38% 的反馈干预让表现变差，
//! 其中危害最大的一类是**判断错误**的反馈；而 LLM 恰好最擅长生成"听起来很对"的话。
//! 所以定位必须是润色器，不是评委。
//!
//! **默认关闭**：没配置 API 时界面不出现该按钮，规则评语照常可用。

use crate::openclass::OpenEvaluation;

/// 润色请求的硬约束（写进提示词，也用于测试断言）
pub const POLISH_RULES: [&str; 4] = [
    "只能改写措辞，不得新增任何判断、评价或建议",
    "只能使用下面给出的事实，不得推断学生的性格、态度或能力",
    "不得添加原文没有的数字、比较或因果",
    "输出一句话，不超过 60 字，不要引号、不要换行",
];

/// 评语长度上限（与 `POLISH_RULES` 的最后一条一致）
pub const POLISH_MAX_CHARS: usize = 60;

/// 构造润色提示词：**事实在前，约束在后**（模型更容易遵守靠后的指令）
pub fn polish_prompt(ev: &OpenEvaluation) -> String {
    let mut facts: Vec<String> = Vec::new();
    facts.push(format!("总评：{} 分（{}）", ev.total, ev.level));
    for p in &ev.parts {
        facts.push(format!("{}：{}", p.label, p.level));
    }
    if let (Some(s), Some(w)) = (&ev.strongest, &ev.weakest) {
        let label = |k: &str| {
            ev.parts
                .iter()
                .find(|p| p.key == k)
                .map(|p| p.label.clone())
                .unwrap_or_else(|| k.to_string())
        };
        facts.push(format!("最突出：{}", label(s)));
        facts.push(format!("还有空间：{}", label(w)));
    } else {
        facts.push("各维度比较均衡".to_string());
    }
    facts.push(format!("原始评语：{}", ev.comment));

    let mut out = String::new();
    out.push_str("你是课堂评语的润色助手。把下面这份评语改得更自然、更适合当众念出来。\n\n");
    out.push_str("【事实】（只能用这些）\n");
    for f in &facts {
        out.push_str("- ");
        out.push_str(f);
        out.push('\n');
    }
    out.push_str("\n【硬约束】\n");
    for (i, r) in POLISH_RULES.iter().enumerate() {
        out.push_str(&format!("{}. {}\n", i + 1, r));
    }
    out.push_str("\n只输出润色后的那一句话。");
    out
}

/// 清理模型返回：去引号/换行、限长（防止它"顺手"多写一段）
pub fn sanitize_polish(text: &str) -> String {
    let cleaned: String = text
        .trim()
        .trim_matches(|c| c == '"' || c == '“' || c == '”' || c == '\'' || c == '「' || c == '」')
        .replace(['\n', '\r'], " ");
    let chars: Vec<char> = cleaned.chars().collect();
    if chars.len() <= POLISH_MAX_CHARS {
        return cleaned.trim().to_string();
    }
    format!("{}…", chars[..POLISH_MAX_CHARS].iter().collect::<String>())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::openclass::{default_open_dimensions, evaluate_open};

    fn ev() -> OpenEvaluation {
        evaluate_open(
            &[
                ("basic".to_string(), 4),
                ("transfer".to_string(), 3),
                ("expression".to_string(), 4),
                ("attitude".to_string(), 4),
            ],
            &default_open_dimensions(),
        )
    }

    #[test]
    fn prompt_carries_the_hard_constraints() {
        let p = polish_prompt(&ev());
        // 四条约束一条都不能少（这是"只润色不判断"的落地方式）
        for r in POLISH_RULES {
            assert!(p.contains(r), "提示词缺少约束：{}", r);
        }
        assert!(p.contains("不得新增任何判断"), "必须明确禁止新增判断");
        assert!(p.contains("只能用这些"), "必须说明事实来源是封闭的");
    }

    #[test]
    fn prompt_contains_only_real_facts() {
        let e = ev();
        let p = polish_prompt(&e);
        assert!(p.contains(&format!("{} 分", e.total)), "带上总分");
        assert!(p.contains(&e.level), "带上总评档位");
        assert!(p.contains("基础掌握：优秀"), "带上各维度档位");
        assert!(p.contains(&e.comment), "带上原始评语（作为润色对象）");
        // 隐私：不能有姓名（调用方压根不传，这里也断言一遍）
        assert!(!p.contains("甲"), "提示词里不应出现学生姓名");
    }

    #[test]
    fn balanced_case_says_so_instead_of_faking_a_weakness() {
        let flat = evaluate_open(
            &[
                ("basic".to_string(), 3),
                ("transfer".to_string(), 3),
                ("expression".to_string(), 3),
                ("attitude".to_string(), 3),
            ],
            &default_open_dimensions(),
        );
        let p = polish_prompt(&flat);
        assert!(p.contains("各维度比较均衡"), "分差不足时要说均衡，不能硬编一个短板");
        assert!(!p.contains("还有空间"), "不能凭空造短板");
    }

    #[test]
    fn sanitize_strips_quotes_newlines_and_truncates() {
        assert_eq!(sanitize_polish("「他答得很好」"), "他答得很好");
        assert_eq!(sanitize_polish("\"不错\"\n"), "不错");
        assert_eq!(sanitize_polish("第一行\n第二行"), "第一行 第二行");
        let long = "字".repeat(200);
        let out = sanitize_polish(&long);
        assert_eq!(out.chars().count(), POLISH_MAX_CHARS + 1, "超长要截断并加省略号");
        assert!(out.ends_with('…'));
    }

    #[test]
    fn empty_evaluation_still_produces_a_prompt() {
        let empty = evaluate_open(&[], &default_open_dimensions());
        let p = polish_prompt(&empty);
        assert!(p.contains("0 分"), "没评也要能构造（总分 0）");
        assert!(p.contains("【硬约束】"));
    }
}
