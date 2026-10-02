//! export-bindings —— 从 Rust 类型生成前端 TS 绑定（specta）
//!
//!   cargo run -p ci-core --bin export-bindings            # 写入 web/src/bindings/generated.ts
//!   cargo run -p ci-core --bin export-bindings -- --check  # 只校验是否过期（CI 用）
//!
//! 为什么要有 `--check`：**契约漂移**是这类跨语言项目最隐蔽的 bug 来源。
//! Rust 改了字段、前端还按老结构读 → 运行时才炸（P2 里 `scores` / `ips` 就是这么翻车的）。
//! 所以 CI 必须能发现"生成物与 Rust 不一致"，跟 protocol_gen 一个套路。

use std::path::PathBuf;

fn collect() -> specta::Types {
    use ci_domain::ability::{Ability, Axis, Grade, TierStat};
    use ci_domain::classroom::{
        AbilityPack, AxisBrief, AxisPack, Buzz, BuzzOutcome, ClassStudent, ClassTeam, CmdOutcome,
        CmdResult, FeedItem, GradePack, Pending, Phase, Runtime, ScoreRequest, StudentCmd, TeamStat,
    };
    use ci_domain::grade::Question;
    use ci_domain::scoring::{ScoreSnapshot, ScoringSettings, Tier};

    specta::Types::default()
        // 课堂状态与角色
        .register::<Runtime>()
        .register::<Phase>()
        .register::<ClassStudent>()
        .register::<ClassTeam>()
        // 题库与计分
        .register::<Question>()
        .register::<Tier>()
        .register::<ScoringSettings>()
        .register::<ScoreSnapshot>()
        // 课堂协同（大屏/学生端要用的载荷）
        .register::<FeedItem>()
        .register::<Buzz>()
        .register::<BuzzOutcome>()
        .register::<Pending>()
        .register::<StudentCmd>()
        .register::<CmdOutcome>()
        .register::<CmdResult>()
        .register::<ScoreRequest>()
        .register::<TeamStat>()
        // 能力评价（雷达图与画像）
        .register::<Ability>()
        .register::<Axis>()
        .register::<Grade>()
        .register::<TierStat>()
        .register::<AbilityPack>()
        .register::<GradePack>()
        .register::<AxisPack>()
        .register::<AxisBrief>()
}

const HEADER: &str = "\
/* eslint-disable */
/**
 * 本文件由 `cargo run -p ci-core --bin export-bindings` 生成，请勿手改。
 *
 * 来源：crates/ci-domain（specta 派生）。前端只允许用这里的类型，
 * 这样「Rust 改了字段、前端还按老结构读」这类漂移会在 CI 就被拦住。
 */
";

fn main() {
    let check = std::env::args().any(|a| a == "--check");
    let out = std::env::args()
        .position(|a| a == "--out")
        .and_then(|i| std::env::args().nth(i + 1))
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../web/src/bindings/generated.ts")
        });

    let types = collect();
    let body = match specta_typescript::Typescript::default().export(&types, specta_serde::Format) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("生成 TS 绑定失败：{e}");
            std::process::exit(1);
        }
    };
    let content = format!("{HEADER}{body}");

    if check {
        let existing = std::fs::read_to_string(&out).unwrap_or_default();
        let norm = |s: &str| s.replace("\r\n", "\n").trim_end().to_string();
        if norm(&existing) == norm(&content) {
            println!("[ok] 前端类型绑定与 Rust 一致（{}）", out.display());
            return;
        }
        eprintln!(
            "[stale] {} 与 Rust 类型不一致 —— 运行 cargo run -p ci-core --bin export-bindings 重新生成",
            out.display()
        );
        std::process::exit(1);
    }

    if let Some(dir) = out.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Err(e) = std::fs::write(&out, &content) {
        eprintln!("写入 {} 失败：{e}", out.display());
        std::process::exit(1);
    }
    println!("[ok] 已写入 {}（{} 字节）", out.display(), content.len());
}
