/**
 * 领域层桥接：**不重写业务逻辑**，直接复用 assets/js/*（已被 1243 项断言覆盖）。
 *
 * 这些模块是挂在 window.CI 上的经典 IIFE 脚本（原页面用 <script src> 按固定顺序加载），
 * 这里按**同样的顺序** import 它们产生副作用，再把 CI 暴露给 Vue 组件。
 * 顺序与 assets/js/*.js 的约定一致，tests/dom-check.js 也在校验这个顺序。
 *
 * 它们内部只在函数被调用时才访问 DOM，因此不加载旧页面也不会报错；
 * 旧的那批 render 函数（CI.bankUI.render 等）保留但不再使用。
 */
import '@domain/store.js';
import '@domain/storage.js';
import '@domain/analysis.js';
import '@domain/grade.js';
import '@domain/sync.js';
import '@domain/classroom.js';
import '@domain/net.js';
import '@domain/rollcall.js';
import '@domain/bank.js';
import '@domain/quiz.js';
import '@domain/analysis-ui.js';

/** 领域层命名空间（store / grade / classroom / sync / net / analysis / rollcall …） */
export const CI = globalThis.CI;

export default CI;
