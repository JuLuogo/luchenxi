/**
 * 课堂状态 → Vue 响应式（Pinia）
 *
 * 领域层（CI.store）是普通对象 + 事件订阅，不是响应式系统。
 * 这里做一层薄桥接：订阅 'change' 事件，把 state 快照暴露为 computed，
 * 组件只管调用 action（内部就是 CI.store 的写接口），不需要知道领域层细节。
 */
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { CI } from './bridge.js';

export const useClassStore = defineStore('class', () => {
  /* ---------- 响应式桥 ---------- */
  const rev = ref(0);
  CI.store.on('change', () => { rev.value += 1; });

  const state = computed(() => {
    void rev.value;                       // 依赖版本号触发重算
    return CI.store.get();
  });

  /* ---------- 派生数据 ---------- */
  const settings = computed(() => state.value.settings || {});
  const tiers = computed(() => (state.value.tiers || []).slice().sort((a, b) => a.weight - b.weight));
  const teams = computed(() => (state.value.teams || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0)));
  const students = computed(() => state.value.students || []);
  const bank = computed(() => state.value.bank || []);
  const quizzes = computed(() => state.value.quizzes || []);
  const runtime = computed(() => state.value.runtime || {});
  const logs = computed(() => (state.value.logs || []).slice(-200).reverse());

  const currentQuiz = computed(() => CI.store.quiz(state.value));
  const currentQuestion = computed(() => CI.store.question(state.value, runtime.value.qid));
  const currentStudent = computed(() => CI.store.student(state.value, runtime.value.sid));

  /** 全部标签（含出现次数，供标签管理页用） */
  const tags = computed(() => {
    const map = new Map();
    bank.value.forEach((q) => (q.tags || []).forEach((t) => map.set(t, (map.get(t) || 0) + 1)));
    return [...map.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh'));
  });

  /* ---------- 读接口 ---------- */
  const scoreOf = (sid) => CI.store.scoreOf(state.value, sid);
  const teamScore = (tid) => CI.store.teamScore(state.value, tid);
  const studentsOf = (tid) => CI.store.studentsOf(state.value, tid);
  const calledCount = (sid) => CI.store.calledCount(state.value, sid);
  const recordsOf = (sid) => CI.store.recordsOf(state.value, sid).slice().reverse();
  const describeRecord = (rec) => CI.store.describeRecord(state.value, rec);
  const questionPoints = (q) => CI.store.questionPoints(state.value, q);
  const lastRecord = () => CI.store.lastRecord(state.value);
  const answeredAlready = (qid, sid) => CI.store.answeredAlready(state.value, currentQuiz.value ? currentQuiz.value.id : '', qid, sid);

  /* ---------- 写接口（全部走 store，自动落 localStorage + SQLite + 推送） ---------- */
  const actions = {
    // 课程与设置
    updateSettings: (patch) => CI.store.updateSettings(patch),

    // 队伍
    addTeam: (name) => CI.store.addTeam(name),
    updateTeam: (tid, patch) => CI.store.updateTeam(tid, patch),
    removeTeam: (tid) => CI.store.removeTeam(tid),

    // 学生
    addStudent: (name, teamId) => CI.store.addStudent(name, teamId),
    addStudentsBulk: (text, teamId) => CI.store.addStudentsBulk(text, teamId),
    updateStudent: (sid, patch) => CI.store.updateStudent(sid, patch),
    removeStudent: (sid) => CI.store.removeStudent(sid),

    // 记分
    /** 按题型快捷加分：sources 走 recordResult，权重由题型表决定 */
    quickTier: (sid, tierKey, note) => CI.store.recordResult({ sid, tier: tierKey, result: 'correct', source: 'quick', note: note || '' }),
    judge: (sid, qid, result, note) => CI.store.recordResult({ sid, qid, result, note: note || '' }),
    addManual: (sid, delta, note) => CI.store.addManual(sid, delta, note),
    resetStudentScore: (sid) => CI.store.resetStudentScore(sid),
    undoLast: () => CI.store.undoLastRecord(),
    removeRecord: (rid) => CI.store.removeRecord(rid),
    clearRecords: (filter) => CI.store.clearRecords(filter),
    resetAllScores: () => CI.store.resetAllScores(),

    // 题库
    addQuestion: (data) => CI.store.addQuestion(data),
    updateQuestion: (qid, patch) => CI.store.updateQuestion(qid, patch),
    removeQuestion: (qid) => CI.store.removeQuestion(qid),
    bulkImportQuestions: (list, opts) => CI.store.bulkImportQuestions(list, opts),
    exportBank: () => CI.store.exportBank(),

    // 题型与权重
    addTier: (data) => CI.store.addTier(data),
    updateTier: (key, patch) => CI.store.updateTier(key, patch),
    removeTier: (key) => CI.store.removeTier(key),

    // 试卷
    createQuiz: (name, qids, note) => CI.store.createQuiz(name, qids, note),
    setQuizQuestions: (qid, qids) => CI.store.setQuizQuestions(qid, qids),
    addQuestionsToQuiz: (qid, qids) => CI.store.addQuestionsToQuiz(qid, qids),
    updateQuiz: (qid, patch) => CI.store.updateQuiz(qid, patch),
    setCurrentQuiz: (qid) => CI.store.setCurrentQuiz(qid),
    closeQuiz: (qid) => CI.store.closeQuiz(qid),
    deleteQuiz: (qid) => CI.store.deleteQuiz(qid),

    // 运行态
    setRuntime: (patch) => CI.store.setRuntime(patch),

    // 备份
    exportAll: () => CI.store.exportAll(),
    importAll: (payload) => CI.store.importAll(payload),
    factoryReset: () => CI.store.factoryReset()
  };

  return {
    rev, state, settings, tiers, teams, students, bank, quizzes, runtime, logs, tags,
    currentQuiz, currentQuestion, currentStudent,
    scoreOf, teamScore, studentsOf, calledCount, recordsOf, describeRecord, questionPoints,
    lastRecord, answeredAlready,
    ...actions
  };
});
