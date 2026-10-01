# 07 · 通信协议与 API 索引

> v3 的同步链路是 **教师端 `sync.js`（角色 `host`，唯一写入者）→ 教师机本地枢纽 `sync-server.js` → 大屏 `index.html`（`stage`）/ 学生端 `student.js`（`team`）**。
> 枢纽刻意不理解业务：它按**房间**缓存 `state` 与 `dump`、转发 `cmd`、广播在线状态，业务判定全部发生在教师端。
>
> 本文只讲**报文与接口**。设计动机、数据分区理由、权威与容错见 [10 多端协同架构](10-多端协同架构.md)；怎么跑、怎么组网、怎么测见 [08 开发部署与测试](08-开发部署与测试.md)。
>
> ⚙️ **机器可读契约**：报文类型、必填字段、快照字段、命令种类都写在
> [`packages/protocol/messages.js`](../packages/protocol/messages.js)，并由
> [`tests/protocol.test.js`](../tests/protocol.test.js) 在**四端之间做静态对照**
> （Node 枢纽 `sync-server.js`、Rust 枢纽 `crates/ci-hub/src/lib.rs`、教师端 `sync.js`、学生端 `student.js`、大屏 `index.html`、以及本文）。
> 改协议的正确姿势：**先改契约 → 再改实现与本文 → 跑 `node tests/protocol.test.js`**。两版枢纽必须逐字一致，否则课堂上的表现是"连上了但不动"。

## 1. 传输与端点

| 项 | 值 | 位置 |
| --- | --- | --- |
| 传输 | 浏览器原生 `WebSocket`（客户端）/ `ws` 库（服务端） | `sync-server.js:24` |
| 端口 | `PORT` 环境变量，默认 `8080`；监听 `HOST`，默认 `0.0.0.0` | `sync-server.js:26-27` |
| 路径 | 根路径 `/`，连接参数携带房间与角色（**无鉴权**） | `sync-server.js:142-147` |
| 单帧上限 | `maxPayload: 8MB`（一次全量快照 / dump 足够用） | `sync-server.js:139` |
| 同端口 HTTP | 静态托管教师端 / 学生端 / 大屏 / 二维码；`NO_HTTP=1` 只跑 WS | `sync-server.js:361-365` |
| 状态缓存 | 内存 `Map<roomId, room>` + `rooms/<房间>.json` 落盘，800ms 防抖 | `sync-server.js:59`、`sync-server.js:89-99` |
| 心跳 | 每 30s 一轮 `ping`，未回 `pong` 的连接被 `terminate` | `sync-server.js:286-294` |
| 离线命令队列 | 教师端离线时学生命令排队，上限 60 条 | `sync-server.js:34`、`sync-server.js:230-245` |
| 服务器时间 | `welcome.serverTime`、`cmd.at` 由枢纽补写（不信任学生机时钟） | `sync-server.js:163-167`、`sync-server.js:231-235` |

> v2 的「每 1 秒周期广播快照」已取消：现在是**事件驱动**（有变更才推 `state`）。新连接一律先收 `welcome`，再由服务端立刻补一条缓存 `state`（教师端除外，见 §5.1）。

### 1.1 HTTP 路由

| 路径 | 行为 | 位置 |
| --- | --- | --- |
| `/`、`/admin`、`/admin.html` | 教师端（`admin.html`） | `sync-server.js:368` |
| `/join`、`/s`、`/student` | 学生端（`student.html`），学生只需输入 `http://<教师机IP>:8080/join` | `sync-server.js:369` |
| `/stage`、`/big`、`/screen` | 教室大屏（`index.html`） | `sync-server.js:370` |
| `/health` | 存活探测，见 §1.2 | `sync-server.js:342-348` |
| `/qr.png?text=…` | 二维码 PNG（宽 260、静区 1）。装了 `qrcode` 才可用，否则返回 **501** + 提示，前端降级为文字地址 | `sync-server.js:350-359` |
| 其它路径 | 静态文件；目录自动补 `index.html`；`.html` 强制 `no-cache`，其余 `max-age=60` | `sync-server.js:300-314`、`sync-server.js:383-386` |

**静态托管的目录白名单**：默认拒绝 `rooms/`、`node_modules/`、`tests/`、`docs/`；任何解析后逃出项目根的路径、以及含 `.` 前缀目录段的路径一律 `403`。设 `SERVE_TESTS=1` 时放行 `tests/` 与 `docs/`（**仅供自动化测试**，见 [08 §7](08-开发部署与测试.md#7-测试)）。代码见 `sync-server.js:372-382`。

### 1.2 `/health`

教师端用它判断「页面是否跑在本地枢纽上」，并拿到学生端可用的地址：

```jsonc
{
  "ok": true,
  "service": "classroom-hub",
  "port": 8080,
  "rooms": ["default", "class1"],       // 当前已创建的房间 id
  "ips": ["192.168.0.180", "10.126.0.1"], // 本机 IPv4，私网地址优先排序
  "qrcode": true,                        // 是否装了 qrcode 依赖
  "uptime": 1234                         // 进程运行秒数
}
```

`ips` 由 `localIPs()` 生成：过滤 `internal` 地址，`192.168.` / `10.` / `172.16-31.` 判为私网并排在前面（`sync-server.js:322-334`）——EasyTier / ZeroTier 这类虚拟网卡地址通常就在私网段里，因此会排在前面直接可用。

### 1.3 环境变量

| 变量 | 默认 | 作用 | 位置 |
| --- | --- | --- | --- |
| `PORT` | `8080` | 监听端口 | `sync-server.js:26` |
| `HOST` | `0.0.0.0` | 监听地址 | `sync-server.js:27` |
| `ROOM` | `default` | 默认房间 id（客户端没带 `?room=` 时用它） | `sync-server.js:30` |
| `NO_PERSIST=1` | 关闭 | 不读写 `rooms/*.json` | `sync-server.js:31` |
| `NO_HTTP=1` | 关闭 | 不做静态托管，只提供 WS + `/health` + `/qr.png` | `sync-server.js:32` |
| `SERVE_TESTS=1` | 关闭 | 额外托管 `tests/` 与 `docs/`（自动化测试与截图用） | `sync-server.js:33` |

端口被占用时会打印中文提示并 `exit 1`，不甩堆栈（`sync-server.js:389-398`）。

### 1.4 WebSocket 连接参数

```
ws://<host>:<port>/?room=<房间id>&role=host|stage|team&team=<队伍id>&label=<显示名>
```

| 参数 | 说明 |
| --- | --- |
| `room` | 房间 id，白名单字符，默认取 `ROOM`（`sync-server.js:61-63`） |
| `role` | `host` 教师端 / `stage` 大屏（默认）/ `team` 学生端；**非法值一律降级为 `stage`**（`sync-server.js:145`） |
| `team` | 仅 `team` 角色有意义：队伍 id，用于 presence 与命令归属 |
| `label` | 显示名（队伍名），只用于 presence 展示 |

三端的 URL 构造位置：教师端 `sync.js:57-64`（空地址 = 与页面同源）、学生端 `student.js:67-72`、大屏 `index.html:113-125`。

## 2. 角色与房间

### 2.1 权限矩阵

| 能力 | `host` 教师端 | `stage` 大屏 | `team` 学生端 |
| --- | --- | --- | --- |
| 收 `state` 广播 | ✅ | ✅ | ✅ |
| 收 `presence` | ✅ | ✅ | ✅ |
| 发 `state`（写快照） | ✅ 唯一 | ❌ 返回 `error` | ❌ 返回 `error` |
| 发 `dump` / `request-dump` | ✅ 唯一 | ❌ 返回 `error` | ❌ 返回 `error` |
| 发 `cmd`（抢答/作答/入座） | ✅（会被当成学生命令） | ✅ | ✅ |
| 发 `request` 拉缓存 | ✅ | ✅ | ✅ |
| 拿到有 `payload` 的快照 | 需自己发 `request` | 连接即得 | 连接即得 |

写权限校验只有「角色是不是 host」这一条（`sync-server.js:198-228`）；`hello` 可以把连接**改**成 host（`sync-server.js:247-261`），因此这是**课堂内网的弱约束，不是安全边界**，公网暴露必须加反代鉴权（见 [10 §8](10-多端协同架构.md#8-安全边界课堂场景的取舍)）。

### 2.2 房间

- id 白名单 `[A-Za-z0-9_-]`，超长截断到 32 字符，清洗后为空则回落默认房间（`sync-server.js:61-63`）；教师端 `setRoom()` 用**同一套规则**清洗（`sync.js:34-39`），保证两边算出的房间名一致。
- **懒创建**：首次有客户端连入（或教师端设置房间）时才建房间，并顺手尝试从磁盘恢复（`sync-server.js:67-86`）。
- 落盘文件 `rooms/<房间>.json`（`sync-server.js:65`）：

```jsonc
{
  "rev": 12,                    // 快照版本号，每次 state 自增
  "updatedAt": 1790778815841,   // 最后一次写入时间
  "payload": { /* state 快照，见 §4.1 */ },
  "dump":    { /* 完整课堂数据，见 §4.2；可能为 null */ }
}
```

- 重启枢纽即自动恢复 `payload` 与 `dump`：大屏与学生端一连上就有数据，教师端则据此提示「是否载入枢纽上的课堂数据」（`sync.js:121-127`、`admin.js:524-534`）。
- 房间之间完全隔离：状态、命令队列、在线列表互不可见。

## 3. 报文格式

所有报文都是**单层 JSON 对象**，以 `type` 区分。服务端对无法 `JSON.parse` 的消息静默丢弃（`sync-server.js:183-185`）。

### 3.1 客户端 → 服务端

| `type` | 谁可以发 | 作用 | 服务端行为 | 位置 |
| --- | --- | --- | --- | --- |
| `state` | 仅 `host` | 推送全量课堂快照 | 覆盖缓存、`rev+1`、落盘、**广播给同房间其它连接** | `sync-server.js:198-207` |
| `dump` | 仅 `host` | 推送完整课堂数据 | 只更新缓存与落盘，**永不广播** | `sync-server.js:214-221` |
| `request` | 任意 | 请求当前快照 | **只回给请求方**一条 `state`；无缓存则回 `error` | `sync-server.js:209-212` |
| `request-dump` | 仅 `host` | 取回完整课堂数据 | 只回给请求方 `dump`；无存档回 `error` | `sync-server.js:223-228` |
| `cmd` | 任意 | 学生端命令（入座/抢答/作答） | 补 `id`/`at`/`from` 后转发给 host；host 离线则排队 | `sync-server.js:230-245` |
| `hello` | 任意 | 重连后重新声明身份 | 可改 `role`/`teamId`/`label`，随后**重发 `welcome` + `state` + `presence`** | `sync-server.js:247-261` |
| `leaderboard` | 任意（v2 兼容） | 老版主控台的裸榜单推送 | 与 `state` 相同地缓存与广播，并额外广播一条 `leaderboard` | `sync-server.js:188-196` |

```jsonc
// ① 快照（教师端每次数据变更后 400ms 节流推送）
{ "type": "state", "room": "default", "payload": { /* §4.1 */ } }

// ② 完整课堂数据（教师端首次连接与最多每 15s 一次）
{ "type": "dump", "room": "default", "payload": { "updatedAt": 1790778815841, "rev": 12, "state": { /* store 全量状态 */ } } }

// ③ 拉取
{ "type": "request" }          // 任意角色
{ "type": "request-dump" }     // 仅教师端

// ④ 学生命令（学生端唯一的上行业务报文）
{ "type": "cmd", "cmd": {
    "kind": "hello",                                  // 入座报到
    "teamId": "tm_x", "label": "红队"
} }
{ "type": "cmd", "cmd": {
    "kind": "buzz",                                   // 抢答
    "teamId": "tm_x", "sid": "st_y", "qid": "q_z"
} }
{ "type": "cmd", "cmd": {
    "kind": "answer",                                 // 提交作答
    "teamId": "tm_x", "sid": "st_y", "qid": "q_z",
    "choice": ["C"],        // 选择题：选项字母数组（可多选）
    "text": "8",            // 填空题/主观题：文本
    "skip": false           // true = 这题跳过
} }
```

服务端会给每条 `cmd` 补上 `id`、`at` 与来源信息，教师端收到的完整形态是：

```jsonc
{ "type": "cmd", "cmd": {
    "kind": "answer", "teamId": "tm_x", "sid": "st_y", "qid": "q_z", "choice": ["C"],
    "id": "cmd_m1a2b3c4", "at": 1790778815841,
    "from": { "role": "team", "teamId": "tm_x", "label": "红队", "clientId": "c_ab12cd3" }
} }
```

> 学生端只发命令、**不持有课堂数据**；`sid` 可以缺省，缺省时教师端按「当前学生 → 该队第一个成员」兜底挑人（`classroom.js:57-65`）。

### 3.2 服务端 → 客户端

| `type` | 触发时机 | 载荷 | 位置 |
| --- | --- | --- | --- |
| `welcome` | 连接建立时、收到 `hello` 时 | `{room, role, teamId, clientId, serverTime, rev, hasState, hasDump, hostOnline}` | `sync-server.js:163-167` |
| `state` | 有快照变更时广播；非 host 连接建立/`request` 时单发 | `{room, rev, payload}` | `sync-server.js:129-132`、`sync-server.js:204` |
| `dump` | 仅回应 host 的 `request-dump` | `{room, rev, payload}` | `sync-server.js:225` |
| `cmd` | 学生命令转发给 host | `{cmd}` | `sync-server.js:237` |
| `cmd-backlog` | 教师端上线且有排队命令 | `{cmds: [cmd, …]}`（一次清空队列） | `sync-server.js:171-175` |
| `ack` | 对每条学生 `cmd` 的回执 | `{cmdId, ok}`；排队时为 `{cmdId, ok:false, reason:'teacher-offline'}` | `sync-server.js:238`、`sync-server.js:242` |
| `presence` | 有连接/断开、有队伍入座时广播 | `{room, hostOnline, teams:[{teamId,label,online,at}]}` | `sync-server.js:123-127` |
| `error` | 越权或数据缺失 | `{message}`（见 §3.5） | `sync-server.js:199` 等 |
| `leaderboard` | 仅当收到 v2 的 `leaderboard` 推送时 | `{room, rev, payload}` | `sync-server.js:194` |

```jsonc
{ "type": "welcome", "room": "default", "role": "team", "teamId": "tm_x",
  "clientId": "c_ab12cd3", "serverTime": 1790778815841,
  "rev": 12, "hasState": true, "hasDump": true, "hostOnline": true }

{ "type": "presence", "room": "default", "hostOnline": true,
  "teams": [ { "teamId": "tm_x", "label": "红队", "online": true,  "at": 1790778815841 },
             { "teamId": "tm_y", "label": "蓝队", "online": false, "at": 1790778810000 } ] }

{ "type": "ack", "cmdId": "cmd_m1a2b3c4", "ok": false, "reason": "teacher-offline" }
```

`welcome.hasDump` 是关键分叉点：教师端据此决定是否发 `request-dump` 恢复课堂（`sync.js:121-127`）。

### 3.3 一次「学生答题」的报文时序

```
学生端                枢纽                        教师端(host)
  │  (连接 ?room=&role=team&team=tm_x)
  ├──────────────────▶│ welcome{hasState}
  │◀──────────────────┤ state（缓存快照，若已有）
  │                   ├──────────────────────────▶│ presence{teams:[tm_x online]}
  │  cmd{kind:'answer'}                    （教师端后台运行 handleCmd）
  ├──────────────────▶├──────────────────────────▶│ cmd{…, from:{role:'team'}}
  │◀──────────────────┤ ack{ok:true}              │ CI.grade.auto() → correct
  │                   │                           │ store.recordResult({source:'student'})
  │                   │◀──────────────────────────┤ state（新快照：学生 +3）
  │◀──────────────────┤ 广播 state                │
  │  渲染「已提交：答对 +3」
```

时序中「判定 → 记分 → 回推」全部在教师端完成，学生端只能看到结果（`classroom.js:110-196`）。

### 3.4 离线积压与补发

- 教师端离线（`room.host` 为空或已关闭）时，`cmd` 进队列 `room.queue`，**上限 60 条**，超出丢最旧的（`sync-server.js:240-243`）。
- 学生端立即收到 `ack{ok:false, reason:'teacher-offline'}`，界面提示「老师端离线，已排队，稍后自动提交」（`student.js:99-100`）。
- 教师端重新上线时，服务端一次性发 `cmd-backlog{cmds}`，教师端逐条 `handleCmd(cmd, true)` 并提示「已补收 N 条离线提交」（`sync-server.js:171-175`、`sync.js:144-147`、`admin.js:566-574`）。
- 队列是**内存态**：枢纽重启即丢（课堂数据本身不受影响，已判定的分数早已进 `store`）。

### 3.5 错误消息一览

| 场景 | `error.message` |
| --- | --- |
| 非 host 推送 `state` | `只有教师端可以推送状态` |
| 无缓存时 `request` | `暂无课堂数据（教师端还没推送）` |
| 非 host 推送 `dump` | `只有教师端可以推送课堂数据` |
| 非 host 请求 `dump` | `只有教师端可以读取课堂数据` |
| host 请求 `dump` 但无存档 | `枢纽上没有课堂数据存档` |

教师端把 `error` 显示为顶部状态条的黄色提示（`sync.js:157-159`），学生端用 toast（`student.js:101-103`）。

## 4. 快照 payload

### 4.1 `state`（全量课堂快照，`sync.js:197-267` `snapshot()`）

```jsonc
{
  "courseName": "24机械高考公开课",
  "room": "default",
  "updatedAt": 1790778815841,
  "teams": [                                   // 队伍榜，已按分数降序
    { "id": "tm_x", "name": "红队", "icon": "🔴", "color": "#e74c3c",
      "score": 28.5, "memberCount": 3, "avg": 9.5, "creditRate": 91.7 }
  ],
  "students": [                                // 个人榜，已按分数降序
    { "id": "st_y", "name": "张三", "teamId": "tm_x", "teamName": "红队",
      "color": "#e74c3c", "score": 18.5, "attempts": 4, "correct": 3,
      "creditRate": 87.5, "correctRate": 75, "rank": 1, "level": "良好",
      "rolls": 2, "weakTiers": ["拔高题"] }
  ],
  "meta": {
    "quizName": "冒烟随堂测",                  // 当前试卷名，可为 null
    "accepting": true,                          // 是否接收学生作答
    "reveal": false,                            // 是否已公布答案（**按题判定**：只有针对"当前题"公布过才为 true，换题自动变回 false）
    "questionIndex": { "index": 0, "total": 4 },// 当前题在本套题中的位置（可为 null：无试卷/无当前题）
    "question": {                               // 当前题，可为 null
      "id": "q_z",
      "stem": "冒烟拔高题：导数极值",            // 截断版（≤120 字），大屏/列表用
      "fullStem": "冒烟拔高题：求函数 f(x)=…",   // 完整题干，学生端答题用
      "tier": "advanced", "tierLabel": "拔高题",
      "points": 5,                              // 实际计分值（题目自定义分优先）
      "type": "choice", "typeLabel": "选择题",   // grade.js 的题型推断
      "multiple": false,                        // 答案是否为多选
      "options": [ { "key": "A", "text": "4" }, { "key": "B", "text": "6" } ],
      "hasAnswer": true,                        // 题库里是否填了答案
      "answerKey": null,                        // 仅 reveal=true 时给出参考答案
      "tags": ["函数与导数"]
    },
    "tierWeights": [ { "key": "basic", "label": "基础题", "weight": 3, "color": "#66bb6a" } ],
    "recent": [                                 // 最近 8 条流水，倒序
      { "name": "张三", "tier": "拔高题", "result": "答对", "points": 5, "at": 1790778815841 }
    ],

    /* ↓ 以下 3 个字段由 assets/js/classroom.js:596-611 合并进来（学生端/大屏用） */
    "buzz":    [ { "id":"bz_1", "teamId":"tm_x", "teamName":"红队", "sid":"st_y", "sidName":"张三", "at":1790778815841 } ],
    "pending": [ { "id":"pd_1", "teamId":"tm_x", "teamName":"红队", "sid":"st_y", "sidName":"张三",
                   "answer":"先设未知数…", "at":1790778815841 } ],
    "feed":    [ { "id":"fd_1", "at":1790778815841, "teamId":"tm_x", "teamName":"红队",
                   "text":"张三 答对（+3）", "result":"correct", "points":3, "auto":true } ]
  }
}
```

要点：

- **只给必要字段**：学生端拿不到 `logs`、题库、完整流水等无关数据；`stem` 与 `fullStem` 分开是为了让列表用短串、答题用全串。
- **`answerKey` 只在公布答案后下发**（`sync.js:254`），否则学生端无答案可抄。
- **`meta.reveal` 是"按题"的**：教师端把"公布的是哪一道题"记在 `state.runtime.revealedQid`，快照里的 `reveal` 只有
  `reveal && revealedQid === 当前题` 时才为真（`classroom.js:273` `isRevealed`）；换题（上一题/下一题、改当前题）自动收起，
  避免下一题的答案提前出现在学生手机与大屏上（`classroom.js:267` 写入、`classroom.js:298` 换题清空）。
- **`meta.questionIndex`**（`{index,total}` 或 `null`）让大屏与学生端显示"第 n / m 题"进度（`sync.js:284`）。
- `buzz` / `pending` / `feed` 分别截断到 20 / 30 / 20 条，`recent` 为 8 条，控制单帧体积。
- **向后兼容**：`teams[].{name,score}` 与 v2 大屏所需字段一致，元素多出的字段不影响旧渲染（§3.1 的 `leaderboard` 通道保留了老客户端）。

### 4.2 `dump`（完整课堂数据，仅教师端可读写）

```jsonc
{ "updatedAt": 1790778815841, "rev": 12, "state": { /* CI.store.get() 的全量状态，见 02 数据模型 */ } }
```

- 教师端 `pushDump()` 节流 **15s**，并且**带脏标记补发**：被节流时记下 `dumpDirty` 并预约一次补发（`15s - 已过时间`，最少 1s），保证最后一次变更最终一定落到枢纽 —— 否则换设备恢复出来的是旧数据。`sendNow()` 每次推 `state` 时都会顺带尝试一次 `dump`（`sync.js:300-313`、`sync.js:310-338`）。
- 连接建立与页面 `beforeunload` 都会走 `push(true)`（即时发送），因此正常关闭标签页前的那次变更也会带上 `dump`（`sync.js:90-95`、`admin.js:586`）。
- 想立刻强制推一次（例如自动化测试里不想等 15s）：`CI.sync.pushDump(true)`，见 `tests/smoke-class.html:185-187`。
- 用途只有一个：**教师端换设备 / 清缓存后恢复课堂**。学生端永远拿不到 `dump`（服务端只发给 host，`sync-server.js:214-228`）。
- 教师端 `onDump` 回调 → `maybeOfferRestore()`：本机为空时弹窗询问是否载入（`admin.js:524-534`、`classroom.js:315-330`）。

## 5. 三端客户端行为

### 5.1 教师端 `assets/js/sync.js`

| 行为 | 说明 | 位置 |
| --- | --- | --- |
| 地址来源 | `localStorage['ci_ws_host']`，**空字符串 = 与页面同源**（教师机用 `http://localhost:8080/admin.html` 打开时零配置） | `sync.js:16-19`、`sync.js:41-52` |
| 房间来源 | `localStorage['ci_room']`，默认 `default` | `sync.js:17`、`sync.js:30-39` |
| 连接 | `init({onStatus,…})` → `connect()`，回调钩子见下 | `sync.js:71-76` |
| 重连 | 断开后线性退避 1.5s × 重试次数，上限 15s | `sync.js:177-184` |
| 推送 | `push()` 400ms 节流推 `state`；`push(true)` 立即发（连接建立、`beforeunload`、收到 `request`） | `sync.js:346-350`、`sync.js:90-95`、`admin.js:557-564`、`admin.js:586` |
| 完整数据 | `pushDump()` 15s 节流推 `dump`，被节流时预约补发（脏标记），可用 `pushDump(true)` 强制 | `sync.js:310-338` |
| 接收 | `welcome` → 记 `rev`、按 `hasState`/`hasDump` 主动拉取；`state` → 只回调**不自动覆盖本地**（教师端是权威） | `sync.js:103-119` |
| 服务器信息 | `fetchServerInfo()` 拉 `/health`，供「⑦ 课堂协同」显示地址与二维码 | `sync.js:187-198` |
| 地址生成 | `joinURL()`（学生端入口）、`qrURL()`（二维码图片地址） | `sync.js:201-212` |
| 快照组装 | `snapshot()` 组装 §4.1 的 payload | `sync.js:197-267` |

回调钩子（`admin.js:566-574` 装配）：

| 钩子 | 时机 | 教师端动作 |
| --- | --- | --- |
| `onStatus(text, cls)` | 连接状态变化 | 顶部「同步：…」状态条 |
| `onWelcome(msg)` | 收到 `welcome` | 记录 `rev` / 提示服务端已有数据 |
| `onRemoteState(payload, rev)` | 收到 `state` | 仅用于判断，不覆盖本地 |
| `onCmd(cmd, backlog)` | 收到 `cmd` / `cmd-backlog` 条目 | `CI.classroom.handleCmd()` |
| `onPresence(msg)` | 收到 `presence` | 刷新在线小组 |
| `onServerInfo(info)` | `/health` 返回 | 刷新地址、二维码可用性 |
| `onDump(payload, rev)` | 收到 `dump` | 本机为空时询问是否恢复课堂 |

对外 API：`init` `push` `pushDump` `snapshot` `host` `setHost` `room` `setRoom` `joinURL` `qrURL` `serverInfo` `sameOrigin` `reconnect` `refreshServerInfo` `state` `connected` `rev` `lastStatus`（`sync.js:324-333`）。

### 5.2 学生端 `assets/js/student.js` + `student.html`

| 行为 | 说明 | 位置 |
| --- | --- | --- |
| 身份 | **以队伍为身份入座**：`?room=&team=` 直达，或页面内从队伍列表点选 | `student.js:22-27`、`student.js:179-204` |
| 本地记忆 | `localStorage['ci_team']`（队伍）、`['ci_answerer']`（本题作答人）、`['ci_room']` | `student.js:14-16` |
| 连接 | 与页面同源：`ws://<当前host>/?room=&role=team&team=&label=` | `student.js:67-72` |
| 上行 | 只发 `cmd`：`hello`（入座）/ `buzz`（抢答）/ `answer`（作答/跳过） | `student.js:118-120`、`student.js:476-509` |
| 下行 | `state`/`leaderboard` → 渲染；`presence` → 顶栏「老师在线」；`ack` → 离线排队提示；`error` → toast | `student.js:87-104` |
| 视图 | 答题（选项/填空/主观 + 抢答 + 跳过）、本组、我的（个人学情）、排行榜 | `student.js:232-398` |
| 小组公屏 | `?view=board`：只显示本组大分数、当前题、组员，隐藏底部页签 | `student.js:31`、`student.js:401-422` |
| 交互 | 双击顶栏换队（`switchTeam`）；单选换选项即替换，多选可累加 | `student.js:515`、`student.js:457-468` |
| 提交保护 | 同一题本地只提交一次（`submitted`），服务端侧再由教师端 `answeredAlready()` 去重 | `student.js:476-502`、`classroom.js:138-145` |

### 5.3 大屏 `index.html`（角色 `stage`，只读）

| 行为 | 说明 | 位置 |
| --- | --- | --- |
| 地址 | `?room=&ws=` 参数 → 同源 `location.host`（页面在 HTTP(S) 下时） → `localStorage['ci_ws_host']` → 兜底 `ws.peroe.top` | `index.html:113-125` |
| 拉取 | 连接后发 `{type:'request'}`；未拿到数据时每 2s 重试，拿到即停 | `index.html:139-156` |
| 渲染 | 队伍榜（分差进度条）、个人榜、当前题（题干 + 选项 + 公布后的答案）、最近得分滚动条、题型分值提示 | `index.html:180-283` |
| 抢答榜 | `meta.buzz` 非空时显示抢答卡片（前 6 条：队名 + 作答人 + 时间） | `index.html:259-269` |
| 在线提示 | 收 `presence` 时显示「实时同步 · N 组在线（教师端离线）」 | `index.html:164-167` |
| 断线 | 状态条提示「连接断开，重试中…」，2s 后重连 | `index.html:170-175` |
| 只读 | 除 `request` 外不发任何消息 | — |

## 6. 服务端实现要点（`sync-server.js`）

| 能力 | 实现 | 位置 |
| --- | --- | --- |
| 房间表 | `Map<roomId, {id, rev, updatedAt, payload, dump, host, clients:Set, presence:Map, queue:[]}>` | `sync-server.js:58-59`、`sync-server.js:72` |
| 静态托管 | 路由白名单 + 根目录逃逸/点目录/敏感目录三重拦截，403 兜底 | `sync-server.js:336-387` |
| MIME 与缓存 | 常见文本/图片类型；`.html` → `no-cache`，其余 `max-age=60` | `sync-server.js:39-52`、`sync-server.js:308-311` |
| 快照落盘 | `saveRoomSoon()`：800ms 防抖写 `rooms/<房间>.json` | `sync-server.js:88-99` |
| 启动恢复 | `getRoom()` 首次创建房间时读盘恢复 `payload`/`dump`/`rev` | `sync-server.js:73-83` |
| 广播 | `broadcast()` 遍历 `room.clients`，跳过发送者 | `sync-server.js:106-112` |
| 在线状态 | `presence` 以「队伍」为粒度：同一队多设备时，最后一个连接断开才置 `online:false` | `sync-server.js:114-127`、`sync-server.js:270-279` |
| 心跳 | 30s 一轮 `ping/pong`，假连接 `terminate` | `sync-server.js:286-294` |
| 本机地址 | `localIPs()`：私网地址优先排序，供 `/health` 与启动日志 | `sync-server.js:322-334` |
| 启动日志 | 打印教师端/学生端/大屏地址、房间、二维码可用性、其它网卡地址、落盘路径 | `sync-server.js:400-411` |

启动日志示例：

```
课堂枢纽已启动（教师机本地，无需公网服务器）
  教师端 : http://localhost:8080/admin.html
  学生端 : http://192.168.0.180:8080/join    ← 学生手机/平板输入这个地址（或用 EasyTier 虚拟 IP）
  大屏   : http://localhost:8080/stage
  房间   : default（教师端可改；学生端用 ?room=xxx 进入指定房间）
  二维码 : 可用（/qr.png?text=…）
  其它网卡: 10.126.0.1  ← 多网卡/EasyTier 时学生端改用其一
  快照   : D:\github\luchenxi\rooms\<房间>.json
```

## 7. 已知限制

1. **无鉴权**：任何能访问该端口的人都能读全班数据、也能伪造成 `host` 覆盖大屏；`leaderboard` 兼容通道甚至不校验角色。公网暴露必须自行加反代鉴权。
2. **单写者假设**：同时打开两台教师端会互相覆盖快照，没有冲突合并（`rev` 只是单调计数，未做乐观锁拒绝）。
3. **全量覆盖语义**：`state` 是全量快照而非增量；`dump` 更大（整个 `state`），靠 15s 节流压制流量。
4. **快照与房间文件含学生姓名与成绩**：属个人信息，`rooms/` 与 `snapshot.json` 均已在 `.gitignore` 中（`.gitignore:29-31`），请勿提交或公开发布。
5. **不校验载荷结构**：服务端不检查 `payload` 字段，非法数据会原样缓存并广播（各端渲染时对缺字段做了兜底）。
6. **离线队列是内存态**：枢纽重启会丢未补发的学生命令。
7. **学生端可任选队伍入座**：以「队伍即身份」换取零登录成本，靠课堂纪律 + 教师端在线面板兜底（见 [10 §8](10-多端协同架构.md#8-安全边界课堂场景的取舍)）。

## 8. 模块 API 索引

> 全部挂在全局 `CI` 下（学生端是独立的 `CIStudent`）；内联事件直接调用，`tests/dom-check.js` 会逐个校验接口真实存在（`tests/dom-check.js:95-124`）。
> 「位置」列是模块导出对象的行号，改动后可用 `node tests/doc-refs.js` 复核（见 [08 §7.5](08-开发部署与测试.md#75-文档行号审计)）。

### 8.1 `CI.store`（唯一数据源，`store.js:1200`）

| 分类 | 方法 |
| --- | --- |
| 生命周期 | `init` `get` `load` `save` `commit` `on('change')` `replaceState` `log` `tx` |
| 选择器 | `tierOf` `question` `quiz` `student` `team` `questionPoints` `allRecords` `recordsOf` `isCountable` `scoreOf` `teamScore` `studentsOf` `calledCount` `lastRecord` `answeredAlready` `describeRecord` `computePoints` `collectorQuiz` |
| 记分 | `recordResult` `addManual` `resetStudentScore` `undoLastRecord` `removeRecord` `clearRecords` |
| 队伍 / 学生 | `addTeam` `updateTeam` `removeTeam` `addStudent` `addStudentsBulk` `updateStudent` `removeStudent` |
| 题库 | `addQuestion` `updateQuestion` `removeQuestion` `bulkImportQuestions` `exportBank` |
| 题型 / 设置 | `addTier` `updateTier` `removeTier` `updateSettings` |
| 点名 | `addRoll` `setRollSettings` `setRoundPool` `resetRolls` `removeRoll` |
| 试卷 | `createQuiz` `setCurrentQuiz` `updateQuiz` `setQuizQuestions` `addQuestionsToQuiz` `closeQuiz` `deleteQuiz` `setRuntime` |
| 危险操作 | `resetAllScores` `factoryReset` `exportAll` `importAll` |
| 常量 | `LS_KEY`（`ci_data_v2`）`VERSION` `DEFAULT_TIERS` `ICONS` `TEAM_COLORS` `RESULT_RATIO` `RESULT_LABEL` |

> 数据键仍是 `ci_data_v2`（`store.js:19`、`store.js:23`）：**v3 没有换存储格式**，只在状态里新增了 `classroom` 分区与 `runtime.accepting` / `runtime.reveal`（由 `classroom.js` 按需惰性创建，`classroom.js:31-39`）。

### 8.2 其余模块

| 命名空间 | 关键方法 | 位置 |
| --- | --- | --- |
| `CI.util` | `uid` `clone` `num` `str` `escapeHTML` `fmtTime` `fmtClock` `round1` `pct` `download` `copyText` `toCSV` `pad2` `shortStem` | `store.js:1237` |
| `CI.analysis` | `studentStats` `classStats` `ranking` `teamRanking` `summarizeStudent` `summarizeClass` `studentCSV` `classCSV` `questionCSV` `counts` | `analysis.js:421` |
| `CI.grade` | `typeOf` `typeLabel` `canAutoGrade` `optionMap` `parseChoice` `normalizeText` `acceptedAnswers` `auto` `answerKey` `describeSubmission` + 常量 `LETTERS` | `grade.js:162` |
| `CI.sync` | `init` `push` `pushDump` `snapshot` `host` `setHost` `room` `setRoom` `joinURL` `qrURL` `serverInfo` `sameOrigin` `reconnect` `refreshServerInfo` `state` `connected` `rev` `lastStatus` | `sync.js:324` |
| `CI.classroom` | `handleCmd` `metaPayload` `setPresence` `setServerInfo` `resolvePending` `dropPending` `addBuzz` `clearBuzz` `clearFeed` `setAccepting` `setReveal` `isRevealed` **`moveQuestion`** `focusBuzz` `loadRemoteState` `applyRemote` `pickAnswerer` `currentQuestion` `box` `presence` `lastAutoResult` + UI：`render` `toggleAccepting` `toggleReveal` **`restoreFromHub`** `resolve` `drop` `saveRoom` `copyJoin` | `classroom.js:605` |
| `CI.rollcall` | `candidates` `pick` `applyPick`（纯算法） | `rollcall.js:385` |
| `CI.rollUI` | `render` `spin` `judge` `quick` `quickFor` `bindKeys` `currentStudent` `isSpinning` | `rollcall.js:386` |
| `CI.bankUI` | `render` `renderList` `renderToolbar` `renderTierPanel` `openEditor` `closeEditor` `saveEditor` `remove` `toggleKind` `toggleImport` `parseImport` `doImport` `downloadTemplate` `exportJSON` `saveTier` `addTier` `removeTier` `openSettings` `saveSettings` `getFilter` | `bank.js:482` |
| `CI.quizUI` | `render` `renderToolbar` `renderPicker` `renderQuestions` `renderCurrent` `renderRecords` `selectQuiz` `newQuiz` `renameQuiz` `closeQuiz` `deleteQuiz` `addSelected` `addAllTier` `addToCurrent` `setQuestion` `moveQuestion` `removeQuestion` `setStudent` `judge` `batchQuick` `removeRecord` `exportCSV` `currentQuiz` | `quiz.js:475` |
| `CI.analysisUI` | `render` `setScope` `generate` `showStudentReport` `closeReport` `copyStudent` `copySummary` `downloadSummary` `exportCSV` `getScope` `getSummary` | `analysis-ui.js:242` |
| `CI.admin` | `init` `gotoTab` `renderAll` `setSyncStatus` `addTeam` `renameTeam` `removeTeam` `pickIcon` `addStudent` `bulkAdd` `changeScore` `customScore` `quickTier` `zeroStudent` `undoLast` `saveWsHost` `exportBackup` `importBackup` `exportClassCSV` `openLogs` `resetAllScores` `factoryReset` … | `admin.js:593` |
| `CIStudent`（学生端） | `pickTeam` `switchTeam` `setAnswerer` `toggleOption` `draft` `submit` `buzz` `switchTab` `data` | `student.js:518-526` |

## 9. 自建客户端示例

### 9.1 只读大屏（任意语言）

```js
const ws = new WebSocket('ws://192.168.0.180:8080/?room=default&role=stage');
ws.onopen = () => ws.send(JSON.stringify({ type: 'request' }));
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.type === 'welcome') console.log('已连接，服务端有数据：', m.hasState);
  if (m.type === 'state') {
    const { teams, students, meta } = m.payload;
    // teams / students 已按分数降序；meta.question 为当前题（含 options）
  }
  if (m.type === 'presence') console.log('在线小组：', m.teams.filter(t => t.online).length);
};
```

### 9.2 学生端（命令行 / 其它语言）

```js
const ws = new WebSocket('ws://192.168.0.180:8080/?room=default&role=team&team=tm_x&label=红队');
ws.onopen = () => {
  ws.send(JSON.stringify({ type: 'cmd', cmd: { kind: 'hello', teamId: 'tm_x', label: '红队' } }));
};
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.type === 'state' && m.payload.meta.accepting) {
    ws.send(JSON.stringify({ type: 'cmd', cmd: {
      kind: 'answer', teamId: 'tm_x', qid: m.payload.meta.question.id, choice: ['C']
    } }));
  }
  if (m.type === 'ack' && m.ok === false) console.log('教师端离线，已排队');
};
```

### 9.3 推给自建服务器（v2 兼容）

教师端页签⑥「大屏同步服务器」可填任意 `ws://` / `wss://` 地址（`admin.js:374-380`）。只要对方实现同一套 `state` / `request` 语义即可 —— 它收到 `state` 后按房间缓存并广播；若你的服务端只会发 `{type:'leaderboard', payload}`，v3 的大屏与学生端**同样能识别**（`index.html:160`、`student.js:90`）。

> 反过来：v2 的老服务端（每 1s 广播 `leaderboard`）也能继续给 v3 页面供数据，但**没有房间、没有命令通道**，学生端无法参与。
