/**
 * token-value.ts — 把 CSS 设计 token 解析成**实际颜色值**
 *
 * 为什么需要它：ECharts / canvas 图表**解析不了 CSS 变量** ——
 * 直接把 `var(--c-brand)` 塞进图表配置会渲染成黑白（真实踩过，截图才发现）。
 *
 * 用法：图表配置里 `token('--c-brand')` —— 既保留"颜色只有一个来源"（tokens.css），
 * 又能给 canvas 用。SSR / 无 DOM 环境回落空串（图表自己会有默认色）。
 */
export function token(name: string, fallback = ''): string {
  if (typeof document === 'undefined') return fallback;
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name);
    return (v || '').trim() || fallback;
  } catch {
    return fallback;
  }
}
