/**
 * a11y.ts — 无障碍偏好（每台设备各自记）
 *
 * 依据 `docs/17` 与同类产品调研（Wayground 免费档就有 read-aloud / extended-or-disabled
 * timer / 字号）：**后排看不清、阅读困难的学生被计时压死**，是课堂里真实存在的障碍。
 *
 * 这里做最小集（成本可控、收益明确）：
 *   · 字号档：标准 / 大 / 特大 —— 用 `zoom` 而不是逐条改 font-size
 *     （设计 token 全是 px，改成 rem 是大工程；zoom 在课堂用的浏览器上都支持）
 *   · 减少动效：关掉过渡与动画（前庭敏感的学生、以及老设备卡顿）
 *
 * **每台设备各自记**（localStorage）：老师的投影要大字，学生自己的手机未必想。
 */

export type FontScale = 'normal' | 'large' | 'xlarge';
export type Motion = 'normal' | 'reduced';

export interface A11yPrefs {
  fontScale: FontScale;
  motion: Motion;
}

const KEY = 'ci_a11y';

const DEFAULTS: A11yPrefs = { fontScale: 'normal', motion: 'normal' };

/** 字号档 → 缩放比例（1.15 / 1.3 是"看得清"与"不挤坏布局"之间的折中） */
const ZOOM: Record<FontScale, number> = { normal: 1, large: 1.15, xlarge: 1.3 };

export function load(): A11yPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const j = JSON.parse(raw) || {};
    return {
      fontScale: j.fontScale === 'large' || j.fontScale === 'xlarge' ? j.fontScale : 'normal',
      motion: j.motion === 'reduced' ? 'reduced' : 'normal'
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function save(p: A11yPrefs): A11yPrefs {
  const next: A11yPrefs = {
    fontScale: p.fontScale === 'large' || p.fontScale === 'xlarge' ? p.fontScale : 'normal',
    motion: p.motion === 'reduced' ? 'reduced' : 'normal'
  };
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* 存不下就算了 */ }
  apply(next);
  return next;
}

/**
 * 把偏好应用到当前页面
 *
 * 用 `zoom`：设计 token 全是 px（见 `styles/tokens.css`），逐条改 rem 是大工程；
 * 而课堂用的浏览器（Chrome / Edge / Safari / 安卓 WebView）都支持 zoom。
 * 注意：**不要**用 `transform: scale` —— 它会破坏布局与点击区域。
 */
export function apply(p: A11yPrefs): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const z = ZOOM[p.fontScale] || 1;
  if (z === 1) root.style.removeProperty('zoom');
  else root.style.setProperty('zoom', String(z));
  root.classList.toggle('a11y-reduce-motion', p.motion === 'reduced');
}

/** 启动时调用一次（在各端 main.ts 或 App.vue 的 onMounted 里） */
export function init(): A11yPrefs {
  const p = load();
  apply(p);
  return p;
}

/** 给界面用的中文标签 */
export const FONT_LABEL: Record<FontScale, string> = {
  normal: '标准',
  large: '大',
  xlarge: '特大'
};
