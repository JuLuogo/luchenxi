//! bank_import.rs — 批量导入题目的**解析规则**
//!
//! **迁移来源**：`assets/js/bank.js::parseImport`（旧版题库页里的一个函数）。
//! 它是纯逻辑（文本 → 题目数组），却一直住在"旧界面渲染层"里 —— 于是
//! Vue 的批量导入页要 import 整个 bank.js 才能用它，删旧界面也就删不掉。
//! 现在下沉到领域层：Rust 侧一份、JS 侧一份，parity 逐字段比对。
//!
//! 支持的写法（与 JS 参考实现逐条一致）：
//!   · JSON：`[{...}]` / `{"questions":[...]}` / 单个 `{"stem":"..."}`
//!   · 管道分隔：`题干 | 答案`
//!   · 选择题：`题干 | 选项1 ; 选项2 ; 选项3 | C`（选项可带 `A.`/`A、`/`A:` 前缀）
//!   · 逗号分隔兜底：`题干，答案`
//!   · 题型前缀：`基础题：题干 | 答案`（`基础`/`拔高`/`扩展`/`提升` 皆可，可省"题"字）
//!
//! 题型前缀要查题型表（label → key），所以由调用方把题型表传进来 ——
//! 旧实现直接读全局 store，那是"领域层不该知道的东西"。

use serde::{Deserialize, Serialize};

/// 解析出来的一道题（字段名与 JS 的对象一致，便于直接喂给 bulkImportQuestions）
#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportQuestion {
    pub stem: String,
    #[serde(default)]
    pub answer: String,
    #[serde(default)]
    pub options: Vec<String>,
    /// 题型 key（写了前缀且能在题型表里找到时才有）
    #[serde(default)]
    pub tier: Option<String>,
}

/// 题型前缀识别：`基础` → `基础题`
const TIER_PREFIXES: [&str; 8] = ["基础", "拔高", "扩展", "提升", "基础题", "拔高题", "扩展题", "提升题"];

/// 选项字母上限（与 `grade::LETTERS` 一致：A–H 视为选择题写法）
fn is_option_letters(s: &str) -> bool {
    let mut it = s.chars();
    match it.next() {
        Some(c) if c.is_ascii_alphabetic() && (c.to_ascii_uppercase() as u8) <= b'H' => {}
        _ => return false,
    }
    it.all(|c| {
        c.is_ascii_alphabetic() && (c.to_ascii_uppercase() as u8) <= b'H'
            || matches!(c, ',' | '，' | '、' | ' ' | '\t')
    })
}

/// 去掉选项前的 `A.` / `A、` / `A:` / `A：` / `A)` / `A）` 前缀
fn strip_option_prefix(s: &str) -> String {
    let t = s.trim_start();
    let mut it = t.chars();
    if let Some(c) = it.next() {
        if c.is_ascii_alphabetic() && (c.to_ascii_uppercase() as u8) <= b'H' {
            let rest: String = it.collect();
            let rest_trim = rest.trim_start();
            if let Some(p) = rest_trim.chars().next() {
                if matches!(p, '.' | '、' | ':' | '：' | ')' | '）') {
                    return rest_trim[p.len_utf8()..].trim().to_string();
                }
            }
        }
    }
    t.trim().to_string()
}

/// 按分隔符切分（保留"没有分隔符"的情况）
fn split_any(s: &str, seps: &[char]) -> Vec<String> {
    let mut out = vec![String::new()];
    for c in s.chars() {
        if seps.contains(&c) {
            out.push(String::new());
        } else {
            out.last_mut().unwrap().push(c);
        }
    }
    out
}

/// 解析文本 → 题目数组
///
/// * `tiers` —— 题型表 `(key, label)`，用于识别 `基础题：…` 这类前缀
///
/// 返回 `Err` 只在 JSON 写法解析失败时（与 JS 的 `JSON.parse` 抛错一致）。
pub fn parse_import(text: &str, tiers: &[(String, String)]) -> Result<Vec<ImportQuestion>, String> {
    let raw = text.trim();
    if raw.is_empty() {
        return Ok(Vec::new());
    }

    /* ---------- JSON 写法 ---------- */
    if raw.starts_with('[') || raw.starts_with('{') {
        let v: serde_json::Value = serde_json::from_str(raw).map_err(|e| e.to_string())?;
        let list: Vec<serde_json::Value> = if let Some(arr) = v.as_array() {
            arr.clone()
        } else if let Some(arr) = v.get("questions").and_then(|q| q.as_array()) {
            arr.clone()
        } else if v.get("stem").is_some() {
            vec![v.clone()]
        } else {
            Vec::new()
        };
        return Ok(list
            .into_iter()
            .map(|item| ImportQuestion {
                stem: item.get("stem").and_then(|x| x.as_str()).unwrap_or("").trim().to_string(),
                answer: item.get("answer").and_then(|x| x.as_str()).unwrap_or("").trim().to_string(),
                options: item
                    .get("options")
                    .and_then(|x| x.as_array())
                    .map(|a| a.iter().map(|o| o.as_str().unwrap_or("").to_string()).collect())
                    .unwrap_or_default(),
                tier: item.get("tier").and_then(|x| x.as_str()).map(|s| s.to_string()),
            })
            .collect());
    }

    /* ---------- 逐行文本 ---------- */
    let mut out = Vec::new();
    for line in raw.split('\n') {
        let t = line.trim().trim_end_matches('\r').trim();
        if t.is_empty() {
            continue;
        }
        // 管道优先，其次制表符
        let mut parts = split_any(t, &['|', '｜'])
            .into_iter()
            .map(|p| p.trim().to_string())
            .collect::<Vec<_>>();
        if parts.len() < 2 {
            parts = t.split('\t').map(|p| p.trim().to_string()).collect();
        }

        // 选择题写法：题干 | 选项1 ; 选项2 | 答案字母
        if parts.len() >= 3 {
            let last = parts.last().unwrap().trim().to_string();
            if is_option_letters(&last) {
                let opts: Vec<String> = parts[1..parts.len() - 1]
                    .join(" ; ")
                    .split([';', '；'])
                    .map(|x| strip_option_prefix(x))
                    .filter(|x| !x.is_empty())
                    .collect();
                if opts.len() >= 2 {
                    out.push(ImportQuestion {
                        stem: parts[0].trim().to_string(),
                        options: opts,
                        answer: last.to_uppercase(),
                        tier: None,
                    });
                    continue;
                }
            }
        }

        // 逗号兜底：题干，答案（只在**只有一个**逗号时切，避免把题干里的逗号当分隔符）
        if parts.len() < 2 {
            if let Some(pos) = t.find(['，', ',']) {
                let head = t[..pos].to_string();
                let tail: String = t[pos..].chars().skip(1).collect();
                if !tail.contains(['，', ',']) {
                    parts = vec![head, tail];
                }
            }
        }

        let stem_raw = parts.first().cloned().unwrap_or_default();
        let answer = if parts.len() > 1 { parts[1..].join(" / ") } else { String::new() };

        // 题型前缀：基础题：题干 | 答案
        let mut stem = stem_raw.clone();
        let mut tier_key: Option<String> = None;
        for prefix in TIER_PREFIXES {
            let with_colon = [format!("{}：", prefix), format!("{}:", prefix)];
            for pat in &with_colon {
                if let Some(rest) = stem_raw.strip_prefix(pat.as_str()) {
                    let label = if prefix.ends_with('题') { prefix.to_string() } else { format!("{}题", prefix) };
                    if let Some((key, _)) = tiers.iter().find(|(_, l)| l == &label) {
                        tier_key = Some(key.clone());
                        stem = rest.to_string();
                    }
                    break;
                }
            }
            if tier_key.is_some() {
                break;
            }
        }

        out.push(ImportQuestion {
            stem: stem.trim().to_string(),
            answer: answer.trim().to_string(),
            options: Vec::new(),
            tier: tier_key,
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tiers() -> Vec<(String, String)> {
        vec![
            ("basic".into(), "基础题".into()),
            ("advanced".into(), "拔高题".into()),
            ("extended".into(), "扩展题".into()),
            ("improve".into(), "提升题".into()),
        ]
    }

    #[test]
    fn empty_and_json_forms() {
        assert!(parse_import("   ", &tiers()).unwrap().is_empty());
        // 数组
        let a = parse_import(r#"[{"stem":"题A","tier":"improve"}]"#, &tiers()).unwrap();
        assert_eq!(a.len(), 1);
        assert_eq!(a[0].stem, "题A");
        assert_eq!(a[0].tier.as_deref(), Some("improve"));
        // {"questions":[...]}
        let b = parse_import(r#"{"questions":[{"stem":"题B","answer":"2"}]}"#, &tiers()).unwrap();
        assert_eq!(b.len(), 1);
        assert_eq!(b[0].answer, "2");
        // 单个对象
        let c = parse_import(r#"{"stem":"题C"}"#, &tiers()).unwrap();
        assert_eq!(c.len(), 1);
        assert_eq!(c[0].stem, "题C");
        // 对象但没有 stem/questions → 空
        assert!(parse_import(r#"{"foo":1}"#, &tiers()).unwrap().is_empty());
        // 坏 JSON → 报错（与 JS 的 JSON.parse 抛错一致）
        assert!(parse_import("[{", &tiers()).is_err());
    }

    #[test]
    fn pipe_and_comma_lines() {
        let r = parse_import("已知集合A={1,2}，子集个数？ | 4\n函数 y=x² 对称轴？ | x=0", &tiers()).unwrap();
        assert_eq!(r.len(), 2);
        assert_eq!(r[0].stem, "已知集合A={1,2}，子集个数？");
        assert_eq!(r[0].answer, "4");
        assert_eq!(r[1].answer, "x=0");
        // 空行跳过
        assert_eq!(parse_import("题 | 答\n\n\n题2 | 答2", &tiers()).unwrap().len(), 2);
        // 全角竖线
        let q = parse_import("题干｜答案", &tiers()).unwrap();
        assert_eq!(q[0].stem, "题干");
        assert_eq!(q[0].answer, "答案");
        // 逗号兜底
        let c = parse_import("题干，答案", &tiers()).unwrap();
        assert_eq!(c[0].stem, "题干");
        assert_eq!(c[0].answer, "答案");
        // 多解用 / 连接
        let m = parse_import("题 | 答1 | 答2", &tiers()).unwrap();
        assert_eq!(m[0].answer, "答1 / 答2");
    }

    #[test]
    fn choice_lines() {
        let r = parse_import("下列哪个是质数？ | 4 ; 6 ; 7 ; 9 | C", &tiers()).unwrap();
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].options, vec!["4", "6", "7", "9"]);
        assert_eq!(r[0].answer, "C");
        assert_eq!(r[0].stem, "下列哪个是质数？");
        // 选项带字母前缀也要能剥掉
        let r2 = parse_import("选一选 | A. 甲 ; B、乙 ; C: 丙 | A", &tiers()).unwrap();
        assert_eq!(r2[0].options, vec!["甲", "乙", "丙"]);
        // 多选答案
        let r3 = parse_import("多选题 | 甲 ; 乙 ; 丙 ; 丁 | ABD", &tiers()).unwrap();
        assert_eq!(r3[0].answer, "ABD");
        // 选项不足两个 → 退回普通题（不当选择题）
        let r4 = parse_import("题 | 只有一个选项 | A", &tiers()).unwrap();
        assert!(r4[0].options.is_empty(), "少于两个选项就不算选择题");
    }

    #[test]
    fn tier_prefix() {
        let r = parse_import("基础题：集合A={1,2}，子集个数？ | 4", &tiers()).unwrap();
        assert_eq!(r[0].tier.as_deref(), Some("basic"));
        assert_eq!(r[0].stem, "集合A={1,2}，子集个数？", "前缀要从题干里去掉");
        // 省掉"题"字
        let r2 = parse_import("拔高：求导 | 2x", &tiers()).unwrap();
        assert_eq!(r2[0].tier.as_deref(), Some("advanced"));
        // 题型表里没有的前缀 → 保留原样、不设题型
        let r3 = parse_import("竞赛题：难题 | 答案", &tiers()).unwrap();
        assert_eq!(r3[0].tier, None);
        assert_eq!(r3[0].stem, "竞赛题：难题");
    }

    #[test]
    fn tabs_and_crlf() {
        let r = parse_import("题干\t答案\r\n题干2\t答案2\r\n", &tiers()).unwrap();
        assert_eq!(r.len(), 2);
        assert_eq!(r[0].answer, "答案");
        assert_eq!(r[1].stem, "题干2");
    }
}
