/*!
 * packages/protocol/messages.js — **v3 报文的唯一契约来源**
 *
 *  为什么要有这个文件：枢纽有两份实现（`sync-server.js` 的 Node 版与
 *  `apps/teacher/src-tauri/src/hub.rs` 的 Rust 版），还有三个客户端
 *  （教师端 `sync.js`、学生端 `student.js`、大屏 `index.html`）。
 *  报文一旦在某一端漂移，表现是"连上了但不动"，很难查。
 *  所以把契约写成数据 + 用 `tests/protocol.test.js` 在四端之间做静态对照。
 *
 *  修改协议的正确姿势：先改这里，再改实现，最后跑 `node tests/protocol.test.js`。
 */
'use strict';

/** 客户端 → 枢纽 */
const CLIENT_TO_HUB = {
  hello: {
    direction: 'client → hub',
    required: ['type'],
    optional: ['role', 'teamId', 'label'],
    note: '**枢纽级**身份宣告（扁平的 role/teamId/label）：更新在线小组与 label，并立刻刷新 presence。' +
      '注意与业务命令 `{type:"cmd",cmd:{kind:"hello"}}` 区分：后者由教师端处理（见 CMD_KINDS.hello）'
  },
  state: {
    direction: 'host → hub',
    required: ['type', 'payload'],
    optional: ['rev'],
    note: '教师端推送轻量快照；枢纽缓存并广播给 stage/team'
  },
  dump: {
    direction: 'host → hub',
    required: ['type', 'payload'],
    optional: ['rev'],
    note: '教师端推送完整课堂存档；**只在 host 与枢纽之间往返，永不广播**'
  },
  request: {
    direction: 'client → hub',
    required: ['type'],
    note: '拉取最近一次 state（大屏「重新请求」、教师端判断是否有数据）'
  },
  'request-dump': {
    direction: 'host → hub',
    required: ['type'],
    note: '教师端请求完整存档（换设备恢复）；非 host 会被拒绝'
  },
  cmd: {
    direction: 'team → hub → host',
    required: ['type', 'cmd'],
    optional: ['cmd.id', 'cmd.kind', 'cmd.teamId', 'cmd.sid', 'cmd.qid', 'cmd.choice', 'cmd.text', 'cmd.skip'],
    note: '学生端命令；枢纽转发给 host，离线时入队（≤60 条）并在上线后走 cmd-backlog'
  }
};

/** 枢纽 → 客户端 */
const HUB_TO_CLIENT = {
  welcome: {
    direction: 'hub → client',
    required: ['type', 'room', 'role', 'clientId'],
    optional: ['teamId', 'label', 'rev', 'hasState', 'hasDump', 'hostOnline', 'serverTime'],
    note: '连上即发；hasState/hasDump 决定客户端要不要 request / request-dump'
  },
  state: {
    direction: 'hub → stage/team（以及回给请求者）',
    required: ['type', 'room', 'rev', 'payload'],
    note: '轻量快照：队伍/学生/当前题/题型权重/最近得分/课堂过程数据'
  },
  leaderboard: {
    direction: 'hub → client',
    required: ['type', 'room', 'rev', 'payload'],
    note: 'v2 兼容别名，与 state 同体（老客户端仍在监听）'
  },
  dump: {
    direction: 'hub → host',
    required: ['type', 'room', 'rev', 'payload'],
    note: '完整课堂存档，仅教师端可取'
  },
  cmd: {
    direction: 'hub → host',
    required: ['type', 'cmd'],
    note: '转发学生端命令'
  },
  'cmd-backlog': {
    direction: 'hub → host',
    required: ['type', 'cmds'],
    note: '教师端上线时补发离线期间排队的命令（数组，≤60 条）'
  },
  ack: {
    direction: 'hub → team',
    required: ['type', 'cmdId', 'ok'],
    optional: ['reason'],
    note: '学生端命令回执；ok=false 且 reason=teacher-offline 表示已排队'
  },
  presence: {
    direction: 'hub → client',
    required: ['type', 'room', 'hostOnline', 'teams'],
    note: '在线小组列表（teamId/online/label/lastSeen）'
  },
  error: {
    direction: 'hub → client',
    required: ['type', 'message'],
    note: '权限或状态错误（例如非 host 推 state、枢纽无存档）'
  }
};

/** 快照 payload 的关键字段（大屏/学生端依赖这些名字） */
const SNAPSHOT_FIELDS = {
  courseName: 'string',
  room: 'string',
  updatedAt: 'number',
  teams: 'array<{id,name,icon,color,score,memberCount,avg,creditRate}>',
  students: 'array<{id,name,teamId,teamName,color,score,attempts,correct,creditRate,correctRate,rank,level,rolls,weakTiers}>',
  meta: {
    quizName: 'string|null',
    accepting: 'boolean',
    reveal: 'boolean（按题判定：仅当前题公布过才为 true）',
    questionIndex: '{index,total}|null',
    question: '{id,stem,fullStem,tier,tierLabel,points,type,typeLabel,multiple,options,hasAnswer,answerKey,tags}|null',
    tierWeights: 'array<{key,label,weight}>',
    recent: 'array<{name,tier,result,points,at}>',
    buzz: 'array（由 classroom 合并，见 classroom.js metaPayload）',
    pending: 'array',
    feed: 'array'
  }
};

/** 命令种类（cmd.kind） */
const CMD_KINDS = {
  hello: { from: 'team', fields: ['teamId', 'label'], note: '业务级报到：教师端据此把该队标为"已入座"并记 label' },
  answer: { from: 'team', fields: ['teamId', 'sid', 'qid', 'choice|text|skip'], note: '提交作答（客观题自动判分，主观题进待确认）' },
  buzz: { from: 'team', fields: ['teamId', 'sid', 'qid'], note: '抢答' }
};

const ALL_TYPES = Object.assign({}, CLIENT_TO_HUB, HUB_TO_CLIENT);

module.exports = {
  version: 3,
  CLIENT_TO_HUB: CLIENT_TO_HUB,
  HUB_TO_CLIENT: HUB_TO_CLIENT,
  SNAPSHOT_FIELDS: SNAPSHOT_FIELDS,
  CMD_KINDS: CMD_KINDS,
  ALL_TYPES: ALL_TYPES,
  typeList: function () { return Object.keys(ALL_TYPES); },
  /** 某条报文的必填字段（不含 type 自身） */
  requiredOf: function (type) {
    var t = ALL_TYPES[type];
    return t ? t.required.filter(function (f) { return f !== 'type'; }) : null;
  }
};
