/**
 * 课堂状态的 TypeScript 视图（**过渡文件**）
 *
 * 说明：`web/src/bindings/generated.ts` 里的类型是 specta 从 Rust 生成的，
 * 属于"已经有 Rust 结构体"的那部分（题型、计分、课堂协同载荷、能力画像……）。
 *
 * 但**整份课堂状态**（students/teams/bank/records/logs…）目前在 Rust 侧还是
 * 以 JSON dump 的形式流动（`ci-store` 负责落库但不建模），所以这里先手工写下它的形状，
 * 等 `ci-domain` 里补出 `ClassroomState` 结构体后，这个文件就会被生成物取代。
 *
 * 迁移纪律：组件只从 `@/bindings/*` 取类型，不要就地写 `any` 或自己抄一份 interface。
 */
import type {
  Phase,
  Question,
  Runtime,
  ScoringSettings,
  Tier
} from './generated';

export type { Phase, Question, Runtime, ScoringSettings, Tier };

/** 队伍 */
export interface Team {
  id: string;
  name: string;
  color?: string;
  icon?: string;
  order?: number;
  createdAt?: number;
}

/** 学生 */
export interface Student {
  id: string;
  name: string;
  teamId: string;
  active?: boolean;
  called?: number;
  createdAt?: number;
}

/**
 * 一次作答的流水（计分引擎的快照：事后改题型权重不影响历史分）
 *
 * 名字不叫 Record —— 那会盖住 TypeScript 内置的 Record<K,V>，
 * 到处报 "Type Record is not generic"。
 */
export interface ScoreRecord {
  id: string;
  sid: string;
  qid?: string | null;
  quizId?: string | null;
  tier?: string;
  result?: 'correct' | 'half' | 'wrong' | 'skip' | 'manual' | string;
  base?: number;
  ratio?: number;
  points: number;
  note?: string;
  source?: string;
  by?: string;
  at: number;
}

/** 试卷 */
export interface Quiz {
  id: string;
  name: string;
  questionIds: string[];
  note?: string;
  closed?: boolean;
  createdAt?: number;
  records?: ScoreRecord[];
}

/** 课堂设置 */
export interface Settings extends Partial<ScoringSettings> {
  courseName?: string;
  weakThreshold?: number;
  strongThreshold?: number;
}

/** 抢答 / 待确认 / 实时流（与 Rust `ci-domain::classroom` 对齐，字段名同 JSON） */
export interface Buzz {
  id?: string;
  teamId: string;
  qid?: string | null;
  sid?: string | null;
  at: number;
  by?: string;
}

export interface PendingItem {
  id?: string;
  sid: string;
  teamId?: string | null;
  qid?: string | null;
  quizId?: string | null;
  answer: string;
  backlog?: boolean;
  at: number;
}

export interface FeedItem {
  id?: string;
  kind: string;
  teamId?: string | null;
  sid?: string | null;
  qid?: string | null;
  result?: string | null;
  answer?: string | null;
  expected?: string | null;
  points?: number;
  text: string;
  at: number;
}

/** 课堂协同的即时状态（抢答榜 / 待确认队列 / 实时流） */
export interface ClassroomBox {
  buzz: Buzz[];
  pending: PendingItem[];
  feed: FeedItem[];
}

/** 日志（审计用） */
export interface LogItem {
  id?: string;
  type: string;
  detail?: string;
  at: number;
}

/**
 * 整份课堂状态（对应 `CI.store.get()`）
 *
 * 迁移进度标记：这些字段将在 `ci-domain::ClassroomState` 落地后改为生成类型，
 * 届时本文件只剩 re-export。
 */
export interface ClassroomState {
  version?: number;
  rev?: number;
  updatedAt?: number;
  settings: Settings;
  tiers: Tier[];
  teams: Team[];
  students: Student[];
  bank: Question[];
  quizzes: Quiz[];
  records: ScoreRecord[];
  logs: LogItem[];
  runtime: Runtime & { quizId?: string | null };
  classroom: ClassroomBox;
  presence?: {
    teams?: Record<string, { online?: boolean; seated?: boolean }>;
    clients?: number;
  };
}
