/**
 * 领域层桥接：**不重写业务逻辑**，直接复用 assets/js/*（已有 1300+ 断言覆盖）。
 *
 * 这些模块是挂在 window.CI 上的经典 IIFE 脚本（原页面用 <script src> 按固定顺序加载），
 * 这里按**同样的顺序** import 它们产生副作用，再把 CI 暴露给 Vue 组件。
 * 顺序与 assets/js/*.js 的约定一致，tests/dom-check.js 也在校验这个顺序。
 *
 * 它们内部只在函数被调用时才访问 DOM，因此不加载旧页面也不会报错；
 * 旧的那批 render 函数已随旧界面删除（admin.js / quiz.js / analysis-ui.js / bank.js）。
 */
import type { DomainApi } from '@/bindings/domain';

import '@domain/store.js';
import '@domain/storage.js';
import '@domain/analysis.js';
import '@domain/grade.js';
import '@domain/sync.js';
import '@domain/classroom.js';
import '@domain/net.js';
import '@domain/rollcall.js';
import '@domain/import.js';
import '@domain/openclass.js';
import '@domain/polish.js';
/*
 * 说明（2026-10）：这里原来还按旧页面的顺序 import 了 quiz.js / analysis-ui.js。
 * Vue 界面**一处都没用到**它们 —— 它们只提供 CI.quizUI / CI.analysisUI 那批旧 render 函数，
 * 所以去掉了（少两个模块的副作用加载，也为将来删掉旧渲染层铺路）。
 * 批量导入的解析规则在 import.js（bankImport），已从旧版 bank.js 下沉出来。
 */

/** 领域层命名空间（store / grade / classroom / sync / net / analysis / rollcall …） */
export const CI: DomainApi = (globalThis as unknown as { CI: DomainApi }).CI;

export default CI;
