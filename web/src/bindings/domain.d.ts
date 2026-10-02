/**
 * 领域层的类型声明（过渡文件）
 *
 * `assets/js/*.js` 是**参考实现**，目前仍是普通 IIFE 脚本、挂在 `globalThis.CI` 上。
 * 它们正在一块块迁到 Rust（`crates/ci-domain`），所以这里**故意**先给宽松声明：
 * 与其手抄一份很快就会过期的 interface，不如让 TS 只保证"用得到的地方形状对"。
 *
 * 纪律：
 *   · 新写的组件/模块要用类型时，优先从 `@/bindings/generated`（specta 生成）取；
 *   · 只有当某个能力**已经迁到 Rust 并暴露成 Tauri 命令/HTTP 接口**时，
 *     才在这里收紧成精确类型（那时它已经不由 assets/js 实现了）。
 */
import type { ClassroomState } from './state';

/** 领域层命名空间（store / grade / classroom / sync / net / analysis / rollcall / storage …） */
export interface DomainApi {
  store: {
    get(): ClassroomState;
    init(): void;
    on(event: string, cb: (...args: unknown[]) => void): void;
    /**
     * 其余方法仍是 JS 实现（正在一块块迁到 Rust），这里先放开。
     * 之所以用 any 而不是 unknown：unknown 会让每次调用都报"不可调用"，
     * 迁移期噪声太大；等对应能力迁完，会在这里换成精确签名。
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [key: string]: any;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

declare global {
  /* 用 var 而不是 const：只有这样它们才会出现在 globalThis 上 */
  /** 领域层总入口（assets/js/*） */
  // eslint-disable-next-line no-var
  var CI: DomainApi;
  /** 学生端领域层（assets/js/student.js） */
  // eslint-disable-next-line no-var
  /** 学生端领域层（assets/js/student.js）—— 同样是 JS，边界先宽松 */
  // eslint-disable-next-line no-var
  var CIStudent: any;

  interface Window {
    CI: DomainApi;
    CIStudent: any;
  }
}

export {};
