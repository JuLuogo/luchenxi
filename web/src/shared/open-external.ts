/**
 * 在「网页版」与「桌面客户端」两种环境下打开一个**外部**地址。
 *
 * 为什么需要它（2026-10-11 用户实测反馈：「打开大屏」点了根本打不开）：
 *   桌面端（Tauri）里 `window.open('http://…/stage')` **不会打开任何东西** ——
 *   Tauri 只允许应用自己的本地页面开新窗口，外部 http 地址会被拦掉。
 *   而「学生端地址」与「大屏」都指向**内置枢纽的 HTTP 地址**，
 *   于是网页版正常、装了客户端就点不动。
 *
 * 桌面端走 Tauri 的 shell 插件（`plugin:shell|open`）——用**系统默认浏览器**打开，
 * 这正好符合上课场景：老师把大屏窗口拖到投影上即可。
 * 权限 `shell:allow-open` 已在 `apps/teacher/src-tauri/capabilities/default.json` 里授权，
 * 插件也在 `Cargo.toml` / `package.json` 里，**这里只是补上调用**。
 *
 * 返回值：是否至少尝试成功（调用方据此决定要不要提示用户手动打开）。
 */
export async function openExternal(url: string): Promise<boolean> {
  if (!url) return false;

  // Tauri v2 的内部桥：@tauri-apps/api 的 invoke 最终就是调它
  const internals = (window as any).__TAURI_INTERNALS__;
  if (internals && typeof internals.invoke === 'function') {
    try {
      // 与 @tauri-apps/plugin-shell 的 open() 完全同一命令与参数
      await internals.invoke('plugin:shell|open', { path: url, with: null });
      return true;
    } catch (e) {
      // 插件没注册 / 权限没给 —— 退回 window.open，别静默失败
    }
  }

  try {
    const w = window.open(url, '_blank');
    return !!w;
  } catch (e) {
    return false;
  }
}

/** 当前是否跑在桌面客户端里（Tauri） */
export function inDesktopApp(): boolean {
  const internals = (window as any).__TAURI_INTERNALS__;
  return !!(internals && typeof internals.invoke === 'function');
}
