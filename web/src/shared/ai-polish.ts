/**
 * ai-polish.ts — AI 润色（公开课评语的**可选**增强）
 *
 * 三条硬约束（`docs/15-公开课模式设计.md` §3）：
 *   1. **只润色措辞，不得新增判断** —— 事实来自 `CI.openclass.comment`（规则评语）
 *   2. **默认关闭** —— 没配置 API 时界面不出现该按钮
 *   3. **密钥只存本机** —— `localStorage`，**绝不进 state**（state 会同步给枢纽与学生端）
 *
 * 为什么密钥不能进 state：`state` 会经 WebSocket 广播给大屏与学生端、并落库到枢纽。
 * 把 API Key 放进去等于把它发给全教室。
 */
import { CI } from './bridge';

const LS_KEY = 'ci_ai_polish';   // 只在本机 localStorage

export interface AiPolishConfig {
  enabled: boolean;
  /** OpenAI 兼容的 chat/completions 地址；留空表示用默认（不填就不启用） */
  endpoint: string;
  apiKey: string;
  model: string;
}

const EMPTY: AiPolishConfig = { enabled: false, endpoint: '', apiKey: '', model: 'gpt-4o-mini' };

/** 读配置（本机） */
export function loadAiConfig(): AiPolishConfig {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return { ...EMPTY };
    const j = JSON.parse(raw) as Partial<AiPolishConfig>;
    return {
      enabled: !!j.enabled,
      endpoint: String(j.endpoint || ''),
      apiKey: String(j.apiKey || ''),
      model: String(j.model || EMPTY.model)
    };
  } catch {
    return { ...EMPTY };
  }
}

/** 存配置（本机） */
export function saveAiConfig(cfg: AiPolishConfig): void {
  try { localStorage.setItem(LS_KEY, JSON.stringify(cfg)); } catch { /* 隐私模式下写不进去，忽略 */ }
}

/** 配好了才显示按钮 */
export function aiReady(): boolean {
  const c = loadAiConfig();
  return c.enabled && !!c.endpoint && !!c.apiKey;
}

export interface PolishResult {
  ok: boolean;
  /** 润色后的评语（已清理：去引号/换行、限长） */
  text?: string;
  error?: string;
}

/**
 * 润色一条评语
 *
 * 提示词由领域层构造（`CI.polish.prompt`，与 Rust `polish.rs` 同契约、有 parity）——
 * 界面里不拼提示词，否则"只润色不判断"这条约束会在两处漂移。
 *
 * @param evaluation 规则评价结果（含 comment）
 */
export async function polishComment(evaluation: Record<string, unknown>): Promise<PolishResult> {
  const cfg = loadAiConfig();
  if (!cfg.enabled || !cfg.endpoint || !cfg.apiKey) {
    return { ok: false, error: '没有配置 AI（在「设置 · AI 润色」里填接口与密钥）' };
  }
  const P = (CI as unknown as { polish: { prompt(e: unknown): string; sanitize(t: string): string } }).polish;
  const prompt = P.prompt(evaluation);

  try {
    const res = await fetch(cfg.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + cfg.apiKey
      },
      body: JSON.stringify({
        model: cfg.model,
        // 低温：润色要稳定，不要发挥
        temperature: 0.3,
        max_tokens: 120,
        messages: [
          { role: 'system', content: '你只做措辞润色，不做判断。严格按用户给出的约束执行。' },
          { role: 'user', content: prompt }
        ]
      })
    });
    if (!res.ok) return { ok: false, error: '接口返回 HTTP ' + res.status };
    const j = await res.json();
    const raw = j?.choices?.[0]?.message?.content;
    if (!raw) return { ok: false, error: '接口没有返回内容' };
    return { ok: true, text: P.sanitize(String(raw)) };
  } catch (e) {
    return { ok: false, error: '调用失败：' + (e as Error).message };
  }
}
