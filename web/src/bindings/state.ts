/**
 * 类型出口（**全部来自 Rust**）
 *
 * 这里曾经是一份手工维护的状态类型（过渡文件），现在只做 re-export：
 * 真实定义在 `crates/ci-domain`，由 specta 生成到 `./generated.ts`。
 *
 * 保留这个文件的唯一理由：组件里 `import … from '@/bindings/state'` 的路径不用改。
 * 新代码建议直接 import `@/bindings/generated`。
 *
 * 契约纪律：改 Rust 结构体 → 跑
 * `cargo run -p ci-core --bin export-bindings --features bindings`
 * → 忘了跑的话，CI 的「类型绑定与 Rust 一致」那一步会红。
 */
export type {
  /* 整份课堂状态与实体 */
  ClassroomState,
  Settings,
  Team,
  Student,
  BankQuestion,
  ScoreRecord,
  Quiz,
  RollcallState,
  RollHistoryEntry,
  LogItem,
  ClassroomBox,
  /* 运行时与课堂协同 */
  Runtime,
  Phase,
  FeedItem,
  Pending,
  Buzz,
  BuzzOutcome,
  StudentCmd,
  CmdOutcome,
  CmdResult,
  ScoreRequest,
  ClassStudent,
  ClassTeam,
  TeamStat,
  /* 难度与计分 */
  Tier,
  Question,
  ScoringSettings,
  ScoreSnapshot,
  /* 能力评价 */
  Ability,
  Axis,
  Grade,
  TierStat,
  AbilityPack,
  GradePack,
  AxisPack,
  AxisBrief
} from './generated';
