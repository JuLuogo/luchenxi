/**
 * 课堂状态 → Vue 响应式（Pinia）
 *
 * 领域层（CI.store）是普通对象 + 事件订阅，不是响应式系统。
 * 这里做一层薄桥接：订阅 'change' 事件，把 state 快照暴露为 computed，
 * 组件只管调用 action（内部就是 CI.store 的写接口），不需要知道领域层细节。
 *
 * 类型：状态形状见 `@/bindings/state`（过渡文件），课堂协同与计分的载荷
 * 见 `@/bindings/generated`（specta 从 Rust 生成）。
 */
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { CI } from './bridge';
import type {
  BankQuestion,
  ClassroomState,
  ScoreRecord,
  Student,
  Team,
  Tier
} from '@/bindings/state';

type Timer = ReturnType<typeof setTimeout> | null;

export const useClassStore = defineStore('class', () => {
  /* ---------- 响应式桥 ---------- */
  const rev = ref(0);
  CI.store.on('change', () => {
    rev.value += 1;
  });

  const state = computed<ClassroomState>(() => {
    void rev.value; // 依赖版本号触发重算
    return CI.store.get() as ClassroomState;
  });

  /* ---------- 派生数据 ---------- */
  const settings = computed(() => state.value.settings || ({} as ClassroomState['settings']));
  const tiers = computed<Tier[]>(() =>
    (state.value.tiers || []).slice().sort((a, b) => (a.weight || 0) - (b.weight || 0))
  );
  const teams = computed<Team[]>(() =>
    (state.value.teams || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0))
  );
  const students = computed<Student[]>(() => state.value.students || []);
  const bank = computed<BankQuestion[]>(() => state.value.bank || []);
  const quizzes = computed(() => state.value.quizzes || []);
  const runtime = computed(() => state.value.runtime || ({} as ClassroomState['runtime']));
  const logs = computed(() => (state.value.logs || []).slice(-200).reverse());

  // 必须显式带上 currentQuizId：CI.store.quiz(s) 只传 state 时 id 为 undefined，
  // 会一直返回 null（表现为「当前试卷」永远显示"未选择"、课堂协同进度恒为 0/0）。
  const currentQuiz = computed(() => CI.store.quiz(state.value, state.value.currentQuizId));
  const currentQuestion = computed(() => CI.store.question(state.value, runtime.value.qid));
  const currentStudent = computed(() => CI.store.student(state.value, runtime.value.sid));

  /** 全部标签（含出现次数，供标签管理页用） */
  const tags = computed(() => {
    const map = new Map<string, number>();
    // tags 现在是 Rust 生成的类型（BankQuestion.tags: string[]），不需要再断言
    bank.value.forEach((q) => (q.tags || []).forEach((t) => map.set(t, (map.get(t) || 0) + 1)));
    return [...map.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh'));
  });

  /* ---------- 读接口 ---------- */
  const scoreOf = (sid: string): number => CI.store.scoreOf(state.value, sid);
  const teamScore = (tid: string): number => CI.store.teamScore(state.value, tid);
  const studentsOf = (tid: string): Student[] => CI.store.studentsOf(state.value, tid);
  const calledCount = (sid: string): number => CI.store.calledCount(state.value, sid);
// 领域层签名是 recordsOf(state, {sid, qid, quizId, tier, countable})：
// 直接传 sid 会被当成 filter 对象 → 返回**全班**流水（审计发现）
  const recordsOf = (sid: string): ScoreRecord[] =>
    (CI.store.recordsOf(state.value, { sid: sid }) as ScoreRecord[]).slice().reverse();
  const describeRecord = (rec: ScoreRecord): string => CI.store.describeRecord(state.value, rec);
  const questionPoints = (q: BankQuestion): number => CI.store.questionPoints(state.value, q);
  const lastRecord = (): ScoreRecord | null => CI.store.lastRecord(state.value);
  const answeredAlready = (qid: string, sid: string): boolean =>
    CI.store.answeredAlready(state.value, currentQuiz.value ? currentQuiz.value.id : '', qid, sid);

  /* ---------- 写接口（全部走 store，自动落 localStorage + SQLite + 推送） ---------- */
  const actions = {
    // 课程与设置
    updateSettings: (patch: Record<string, unknown>) => CI.store.updateSettings(patch),

    // 队伍
    addTeam: (name: string) => CI.store.addTeam(name),
    updateTeam: (tid: string, patch: Partial<Team>) => CI.store.updateTeam(tid, patch),
    removeTeam: (tid: string) => CI.store.removeTeam(tid),

    // 学生
    addStudent: (name: string, teamId: string) => CI.store.addStudent(name, teamId),
    addStudentsBulk: (text: string, teamId: string) => CI.store.addStudentsBulk(text, teamId),
    updateStudent: (sid: string, patch: Partial<Student>) => CI.store.updateStudent(sid, patch),
    removeStudent: (sid: string) => CI.store.removeStudent(sid),

    // 记分
    /** 按题型快捷加分：sources 走 recordResult，权重由题型表决定 */
    quickTier: (sid: string, tierKey: string, note?: string) =>
      CI.store.recordResult({ sid, tier: tierKey, result: 'correct', source: 'quick', note: note || '' }),
    judge: (sid: string, qid: string, result: string, note?: string) =>
      CI.store.recordResult({ sid, qid, result, note: note || '' }),
    addManual: (sid: string, delta: number, note?: string) => CI.store.addManual(sid, delta, note),
    resetStudentScore: (sid: string) => CI.store.resetStudentScore(sid),
    undoLast: () => CI.store.undoLastRecord(),
    removeRecord: (rid: string) => CI.store.removeRecord(rid),
    clearRecords: (filter: unknown) => CI.store.clearRecords(filter),
    resetAllScores: () => CI.store.resetAllScores(),

    // 题库
    addQuestion: (data: Record<string, unknown>) => CI.store.addQuestion(data),
    updateQuestion: (qid: string, patch: Record<string, unknown>) => CI.store.updateQuestion(qid, patch),
    removeQuestion: (qid: string) => CI.store.removeQuestion(qid),
    bulkImportQuestions: (list: unknown[], opts?: unknown) => CI.store.bulkImportQuestions(list, opts),
    exportBank: () => CI.store.exportBank(),

    // 题型与权重
    addTier: (data: Record<string, unknown>) => CI.store.addTier(data),
    updateTier: (key: string, patch: Partial<Tier>) => CI.store.updateTier(key, patch),
    removeTier: (key: string) => CI.store.removeTier(key),

    // 试卷
    createQuiz: (name: string, qids: string[], note?: string) => CI.store.createQuiz(name, qids, note),
    setQuizQuestions: (qid: string, qids: string[]) => CI.store.setQuizQuestions(qid, qids),
    addQuestionsToQuiz: (qid: string, qids: string[]) => CI.store.addQuestionsToQuiz(qid, qids),
    updateQuiz: (qid: string, patch: Record<string, unknown>) => CI.store.updateQuiz(qid, patch),
    setCurrentQuiz: (qid: string) => CI.store.setCurrentQuiz(qid),
    closeQuiz: (qid: string) => CI.store.closeQuiz(qid),
    deleteQuiz: (qid: string) => CI.store.deleteQuiz(qid),

    // 运行态
    setRuntime: (patch: Record<string, unknown>) => CI.store.setRuntime(patch),

    // 备份
    exportAll: () => CI.store.exportAll(),
    importAll: (payload: unknown) => CI.store.importAll(payload),
    factoryReset: () => CI.store.factoryReset()
  };

  /** 定时器句柄（旧代码遗留在组件里的 debounce 用得到，集中放这里便于清理） */
  const timers = ref<Timer>(null);

  return {
    rev, state, settings, tiers, teams, students, bank, quizzes, runtime, logs, tags,
    currentQuiz, currentQuestion, currentStudent,
    scoreOf, teamScore, studentsOf, calledCount, recordsOf, describeRecord, questionPoints,
    lastRecord, answeredAlready,
    timers,
    ...actions
  };
});
