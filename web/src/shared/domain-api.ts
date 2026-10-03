/**
 * domain-api.ts — 领域能力客户端：**优先走 Rust 核心**，不可达时回退到本地 JS 参考实现
 *
 * 为什么要这一层（docs/14 P4）：
 *   规则只应该有一份实现。Rust 侧（`ci-domain`）已经是那份实现 —— 有 143 个测试、
 *   与 JS 逐字段比对的 parity 基准。但前端页面还在同步调用 `CI.analysis.*`（浏览器里的
 *   JS 参考实现），于是"两份实现同时在跑"，改一处忘一处就会漂移。
 *
 * 过渡策略（本文件就是过渡期的全部复杂度）：
 *   1. 页面加载时探测 `POST /api/domain/stats` 是否可用（教师机枢纽、Tauri 内置枢纽都有）
 *   2. 可用 → 用 Rust 的结果，界面上标注「统计来源：Rust 核心」
 *   3. 不可用（比如网页版连的是还没实现的旧枢纽、或离线）→ 回退 `CI.analysis.*`，
 *      标注「统计来源：本地参考实现」—— **功能不降级，只是口径来自 JS**
 *
 * 这样"删掉 JS 领域层"就变成一个**可验证的开关**：等所有页面都走通 Rust，
 * 把回退分支删掉即可，而不是某天突然发现前端还在跑另一套规则。
 */
import { CI } from './bridge';

export type StatsSource = 'rust' | 'js';

export interface DomainStatsResult {
  source: StatsSource;
  /** 与 `ci_domain::stats` 同形；回退时由 JS 参考实现拼出同样的形状 */
  student: unknown | null;
  klass: unknown;
  ranking: unknown[];
  teamRanking: unknown[];
  /** Rust 不可用的原因（用于界面提示与排查） */
  note?: string;
}

/** 枢纽地址：与 sync.js 同一套约定（空值表示与页面同源） */
function hubBase(): string {
  try {
    const host = (CI.sync as { host?: () => string } | undefined)?.host?.();
    if (host) return /^https?:\/\//.test(host) ? host : 'http://' + host;
  } catch { /* 忽略 */ }
  const stored = (() => { try { return localStorage.getItem('ci_ws_host') || ''; } catch { return ''; } })();
  if (stored) return /^https?:\/\//.test(stored) ? stored : 'http://' + stored;
  return location.origin;
}

/** 探测结果缓存：一次探测，之后直接用（页面生命周期内不会变） */
let cached: { ok: boolean; note?: string } | null = null;

/** 探测 Rust 领域端点是否可用 */
export async function probeDomainApi(force = false): Promise<{ ok: boolean; note?: string }> {
  if (cached && !force) return cached;
  try {
    const res = await fetch(hubBase() + '/api/domain/stats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // 空状态探测：能算出结果就说明端点在，且不需要真的传数据
      body: JSON.stringify({ state: CI.store.defaultState() })
    });
    if (!res.ok) {
      cached = { ok: false, note: '枢纽没有 /api/domain/stats（HTTP ' + res.status + '）' };
    } else {
      const j = await res.json();
      cached = j && j.ok ? { ok: true } : { ok: false, note: '端点返回异常' };
    }
  } catch (e) {
    cached = { ok: false, note: '枢纽不可达：' + (e as Error).message };
  }
  return cached;
}

/**
 * 取学情统计：Rust 优先，失败回退本地
 *
 * @param opts `{ quizId, teamId, sid }` —— 与 Rust 端点的请求体同名同义
 */
export async function fetchStats(opts: {
  quizId?: string | null;
  teamId?: string | null;
  sid?: string | null;
} = {}): Promise<DomainStatsResult> {
  const state = CI.store.get();
  const body = {
    state,
    quizId: opts.quizId ?? null,
    teamId: opts.teamId ?? null,
    sid: opts.sid ?? null
  };

  const probe = await probeDomainApi();
  if (probe.ok) {
    try {
      const res = await fetch(hubBase() + '/api/domain/stats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (res.ok) {
        const j = await res.json();
        if (j && j.ok) {
          return { source: 'rust', student: j.student ?? null, klass: j.class, ranking: j.ranking || [], teamRanking: j.teamRanking || [] };
        }
      }
      cached = { ok: false, note: '端点调用失败' };
    } catch (e) {
      cached = { ok: false, note: '端点调用异常：' + (e as Error).message };
    }
  }

  /* ---------- 回退：本地 JS 参考实现 ---------- */
  const A = CI.analysis as {
    studentStats(s: unknown, sid: string, o: unknown): unknown;
    classStats(s: unknown, teamId: string | null, o: unknown): unknown;
    ranking(s: unknown, teamId: string | null, o: unknown): unknown[];
    teamRanking(s: unknown): unknown[];
  };
  const o = { quizId: opts.quizId ?? null };
  return {
    source: 'js',
    student: opts.sid ? A.studentStats(state, opts.sid, o) : null,
    klass: A.classStats(state, opts.teamId ?? null, o),
    ranking: A.ranking(state, opts.teamId ?? null, o),
    teamRanking: A.teamRanking(state),
    note: probe.note
  };
}

/** 一次点名结果（与 Rust `rollcall::Pick` 同形，也是 JS `applyPick` 要的形状） */
export interface DomainPick {
  sid: string;
  name: string;
  mode: string;
  note: string;
  candidateCount?: number;
  newRound?: boolean;
  pool?: string[] | null;
  round?: number | null;
}

export interface DomainPickResult {
  source: StatsSource;
  pick: DomainPick | null;
  /** Rust 侧回传的随机种子（便于复现这次点名） */
  seed?: number;
  note?: string;
}

/**
 * 随机点名：**Rust 优先**（`/api/domain/pick`，与 parity 基准同一套算法），失败回退本地参考实现
 *
 * 端点要求蛇形入参（rollcall 段的既有约定），所以这里把 JS 状态翻译一遍。
 */
export async function fetchPick(opts: { seed?: number } = {}): Promise<DomainPickResult> {
  const state = CI.store.get() as {
    students?: { id: string; name: string; active?: boolean; teamId?: string | null }[];
    rollcall?: Record<string, unknown>;
    runtime?: { quizId?: string | null; qid?: string | null };
  };
  const rollcall = (state.rollcall || {}) as Record<string, unknown>;

  // 候选名单：与 JS 的 candidates() 同一来源（启用中的学生）
  const students = (state.students || [])
    .filter((x) => x.active !== false)
    .map((x) => ({ id: x.id, name: x.name, active: true, called: CI.store.calledCount(x.id) }));

  // 已作答的人（排除作答者模式用）
  const quizId = state.runtime?.quizId ?? null;
  const answered: string[] = [];
  for (const st of students) {
    const recs = CI.store.recordsOf(state, { sid: st.id, quizId }) as unknown[];
    if (recs && recs.length) answered.push(st.id);
  }

  const body = {
    students,
    answered,
    settings: {
      mode: rollcall.mode ?? 'even',
      scope: rollcall.scope ?? 'all',
      exclude_answered: !!rollcall.excludeAnswered,
      recent_exclude: Number(rollcall.recentExclude) || 0,
      round: Number(rollcall.round) || 1,
      round_pool: (rollcall.roundPool as string[]) || [],
      history: ((rollcall.history as { sid: string }[]) || []).map((h) => ({ sid: h.sid, at: 0 }))
    },
    opts: {
      // 与 JS 的 candidates() 口径一致：scope 为空表示全部
      scope: (rollcall.scope as string) || 'all',
      mode: (rollcall.mode as string) || 'even',
      exclude_answered: !!rollcall.excludeAnswered,
      recent_exclude: Number(rollcall.recentExclude) || 0,
      has_current_question: !!(state.runtime?.quizId && state.runtime?.qid)
    },
    seed: opts.seed ?? null
  };

  const probe = await probeDomainApi();
  if (probe.ok) {
    try {
      const res = await fetch(hubBase() + '/api/domain/pick', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (res.ok) {
        const j = await res.json();
        if (j && j.ok) {
          return { source: 'rust', pick: (j.pick as DomainPick) ?? null, seed: j.seed };
        }
      }
    } catch { /* 落到回退分支 */ }
  }

  const local = (CI.rollcall as { pick(s: unknown, o: unknown): DomainPick | null }).pick(CI.store.get(), {});
  return { source: 'js', pick: local, note: probe.note };
}

/** 能力评价榜（与 Rust `stats::AbilityBoard` 同形） */
export interface DomainAbilityBoard {
  class: Record<string, unknown>;
  students: Record<string, unknown>[];
  teams: Record<string, unknown>[];
}

export interface DomainAbilityResult {
  source: StatsSource;
  board: DomainAbilityBoard | null;
  note?: string;
}

/**
 * 能力评价榜：**Rust 优先**（`/api/domain/ability-board`），失败回退本地参考实现
 *
 * 顺带修掉一个与 JS 同源的口径问题：JS 的 `ability(state, {sid})` 没把 quizId 传下去，
 * 所以评价榜一直覆盖"全部课次"，与页面上的「数据范围」选择器不一致。
 */
export async function fetchAbilityBoard(opts: { quizId?: string | null } = {}): Promise<DomainAbilityResult> {
  const state = CI.store.get();
  const probe = await probeDomainApi();
  if (probe.ok) {
    try {
      const res = await fetch(hubBase() + '/api/domain/ability-board', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state, quizId: opts.quizId ?? null })
      });
      if (res.ok) {
        const j = await res.json();
        if (j && j.ok) return { source: 'rust', board: j.board as DomainAbilityBoard };
      }
    } catch { /* 落到回退分支 */ }
  }
  const A = CI.analysis as { abilityBoard(s: unknown): DomainAbilityBoard };
  return { source: 'js', board: A.abilityBoard(state), note: probe.note };
}

/** Rust 核心给出的判定（handleCmd 的 pre 参数） */
export interface DomainVerdict {
  result: string;
  ratio: number;
  points: number;
  expected: string | null;
}

/**
 * 客观题判分 + 计分：**两步都走 Rust 核心**
 *
 *   POST /api/domain/grade → { graded, result, expected }
 *   POST /api/domain/score → { snapshot: { points, ratio } }
 *
 * 主观题（graded=false）、端点不可用、任何异常 → 返回 null，调用方回退本地判分。
 * 这样"Rust 优先"不会让课堂流程变脆：网络抖一下也只是这一题用本地口径。
 */
export async function gradeWithRust(cmd: {
  qid?: string | null;
  choice?: string[] | string | null;
  text?: string | null;
  skip?: boolean;
  teamId?: string | null;
  sid?: string | null;
}): Promise<DomainVerdict | null> {
  const probe = await probeDomainApi();
  if (!probe.ok) return null;
  const state = CI.store.get() as { runtime?: { quizId?: string | null } };
  const q = cmd.qid ? (CI.store.question(state, cmd.qid) as Record<string, unknown> | null) : null;
  if (!q) return null;

  const choice = Array.isArray(cmd.choice) ? cmd.choice : (cmd.choice ? [cmd.choice] : []);
  try {
    const gRes = await fetch(hubBase() + '/api/domain/grade', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: {
          options: q.options ?? [],
          answer: q.answer ?? '',
          tier: q.tier ?? '',
          points: q.points ?? null
        },
        submission: { choice, text: cmd.text ?? '', skip: !!cmd.skip }
      })
    });
    const g = await gRes.json();
    if (!g || !g.ok || !g.graded) return null;   // 主观题 → 走本地（进待确认队列）

    const rank = buzzRankOf(state, cmd.teamId, q.id as string);
    const sRes = await fetch(hubBase() + '/api/domain/score', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: {
          sid: cmd.sid ?? 's',
          qid: q.id ?? null,
          tier: q.tier ?? null,
          questionTier: q.tier ?? null,
          customPoints: q.points ?? null,
          result: g.result,
          rank
        }
      })
    });
    const sc = await sRes.json();
    if (!sc || !sc.ok || !sc.snapshot) return null;
    return {
      result: g.result,
      ratio: Number(sc.snapshot.ratio) || 0,
      points: Number(sc.snapshot.points) || 0,
      expected: g.expected ?? null
    };
  } catch {
    return null;
  }
}

/** 本队对该题在抢答榜里的位置（1 起）；没抢过答返回 null */
function buzzRankOf(state: unknown, teamId?: string | null, qid?: string): number | null {
  if (!teamId || !qid) return null;
  const buzz = ((state as { classroom?: { buzz?: { teamId?: string; qid?: string }[] } }).classroom?.buzz) || [];
  const i = buzz.findIndex((b) => b.teamId === teamId && b.qid === qid);
  return i < 0 ? null : i + 1;
}
