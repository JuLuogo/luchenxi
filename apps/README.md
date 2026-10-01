# 客户端（Tauri v2）开发与构建说明

两套客户端都把**仓库根目录的网页版前端**套壳复用（见 `scripts/sync-ui.mjs`），因此：

- 界面/业务逻辑只有一份：改根目录的 `admin.html` / `student.html` / `assets/**` 即可，两边同时生效；
- 客户端各自的 Rust 侧只负责「本地数据库 / 内置枢纽 / 组网」这类浏览器做不到的事。

```
apps/
├─ teacher/            教师端（Windows/macOS/Linux）
│  ├─ ui/              ← 由 scripts/sync-ui.mjs 生成（勿手改）
│  └─ src-tauri/       Rust：lib.rs（业务：SQLite 命令 + 内置枢纽 + 组网）· main.rs（薄壳）
│     ├─ src/db.rs     SQLite 持久层（与 packages/db/schema.sql 同源）
│     ├─ src/hub.rs    内置枢纽（协议与 Node 版逐字一致）
│     ├─ src/net.rs    EasyTier sidecar 管理
│     ├─ src/protocol_gen.rs  ← 由 scripts/gen-protocol.mjs 生成（勿手改）
│     ├─ tests/hub_conformance.rs  与 tests/hub-spec.test.js 同一份场景清单
│     ├─ binaries/     EasyTier sidecar（由 scripts/fetch-easytier.mjs 放置）
│     └─ schema.sql    ← 由 sync-ui 从 packages/db/schema.sql 拷贝
└─ student/            学生端（Android 为主，桌面亦可）
   ├─ ui/              ← 由 scripts/sync-ui.mjs 生成
   └─ src-tauri/       Rust：lib.rs（连通性自检 + 地址规范化）· main.rs（薄壳）
```

> **两套客户端都必须有 lib target**：Tauri v2 的 Android/iOS 工程只能调用 `lib`，
> 所以业务代码一律写在 `src/lib.rs`，`main.rs` 只调用 `luchenxi_*_lib::run()`。
> `tests/ci.test.js` 会检查这一点，缺了就直接红。

## 本地开发

```powershell
# 0) 前置：Node 22+、Rust（rustup + MSVC 生成工具）；打 Android 还需 JDK 17 + Android SDK/NDK
node scripts/sync-ui.mjs                 # 生成 ui/ 与 schema.sql
node scripts/gen-protocol.mjs            # 由契约生成 Rust 常量（改协议后必跑）
node scripts/fetch-easytier.mjs          # 教师端：放好 easytier-core / easytier-cli sidecar（可按平台指定 target）

cd apps/teacher
npm install
npm run dev                              # 开发模式（自动起前端 + Rust）
npm run build                            # 出安装包（.msi / .dmg / .deb / .AppImage）
```

### 测试（Rust 侧）

```powershell
cd apps/teacher/src-tauri
cargo test --all-targets     # lib 单测 + tests/hub_conformance.rs（13 个枢纽场景）
cd ../../student/src-tauri
cargo check --all-targets
```

> 本机若装了 `cargo`，根目录 `npm run ci` 会**自动**把上面两步纳入（没装则明确跳过）。
> CI 上由 [.github/workflows/rust.yml](../.github/workflows/rust.yml) 负责——这是 Rust 侧唯一的编译验证入口。

学生端（Android）：

```powershell
cd apps/student
npm install
npm run android:init                     # 首次生成 gen/android 工程
npm run android:build                    # 产出 APK（内部就是 tauri android build --apk）
```

> **注意**：Android 产物只能由 `tauri android build` 生成，**不要**把 `apk`/`aab` 写进
> `tauri.conf.json` 的 `bundle.targets` —— 那是桌面打包目标枚举（`deb`/`rpm`/`appimage`/`msi`/`nsis`/`dmg`/`app`），
> 写错会被官方 schema 判非法、`tauri build` 直接失败。`tests/tauri-config.test.js` 会用官方 schema 拦住这类错误。

> **注意**：`apps/teacher/src-tauri/binaries/` 里的 sidecar 必须存在，否则 `tauri build` 会报错找不到 externalBin；
> CI 由 `scripts/fetch-easytier.mjs` 自动下载官方 Release，本地也可先只跑 `npm run dev`（开发模式不校验 sidecar 打包）。

## 数据与端口

| 项 | 说明 |
| --- | --- |
| 数据库 | `%APPDATA%\top.peroe.luchenxi.teacher\classroom.db`（macOS/Linux 对应 app_data_dir），表结构见 `packages/db/schema.sql` |
| 枢纽端口 | 默认 8080，可用环境变量 `CLASSROOM_PORT` 覆盖；学生端连 `http://<教师机IP>:8080` |
| 备份 | 界面「导出全部数据」得到 `ci-backup` JSON，与网页版完全互通；也可直接复制 `.db` 文件 |

## 组网（EasyTier）

- 教师端内置 `easytier-core`：界面填网络名/密钥/共享节点即可组网；支持 `--config-server`（官方 Web 控制台或自建 `easytier-web`）下发配置。
- 学生端（Android）**不能内置 EasyTier**（官方 Android 只有 GUI APK，无 CLI）：同一局域网直连，或先装官方 EasyTier App 加入同一虚拟网，再在小组端填教师机的虚拟 IP。
- 权限：TUN 模式在 Windows 需管理员、Linux 需 root/CAP_NET_ADMIN；无权限时可用无 TUN 模式（App 内可勾选）。

## 首次 CI 实跑结果（v4.0.0，2026-10-01）

三个工作流都跑起来了（push main + tag v4.0.0），失败点如下 —— 已全部修掉：

| 症状 | 真实原因 | 修法 |
| --- | --- | --- |
| `test.yml` 十二组断言失败 | CI 用 **Node 22**，而 `node:sqlite` 在 22.x 仍需 `--experimental-sqlite`，数据库断言全挂 | 所有工作流改用 **Node 24**（`setup-node@v7`）；`hub-db.js` 的错误信息也写清了升级提示 |
| `rust.yml` / Linux 桌面构建 exit 100 | `apt-get install libappindicator3-dev` —— **Ubuntu 22.04 没有这个包名**，apt 直接失败 | 改用 Tauri v2 官方清单：`libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev libssl-dev patchelf` |
| `android` 作业在 `android-actions/setup-android@v3` 失败 | 该 action 仍基于 **Node 20**，在新的 runner 上被强制跑 Node 24 → 失败 | 删掉它：ubuntu runner **已预装 Android SDK**，直接用 `sdkmanager` 装 NDK 并接受许可 |
| `desktop` 的 `tauri-action` 失败信息只有 "exit code 1" | 看不到真正的编译错误，无法定位 | 不再用 tauri-action：显式 `npm run build -- --target <triple>` + `tee` 日志，并把 `error[..]` 行写成 **GitHub 注解**（`::error::`），注解匿名可读 |
| 工作流里 `npm run tauri build` | 客户端 package.json 的脚本名是 **build**（`tauri build`）而不是 `tauri` | 改为 `npm run build -- --target <triple>`；`tests/ci.test.js` 增加了"引用的 npm script 必须存在"的校验（会把注释里的命令也排除掉） |
| 动作都提示 "Node.js 20 is deprecated" | `checkout@v4`/`setup-node@v4`/`setup-java@v4` 等仍是 Node 20 | 统一升到 `checkout@v7` / `setup-node@v7` / `setup-java@v6` / `upload-artifact@v7` / `softprops/action-gh-release@v3` |

| 本机 `cargo check` 失败：`resource path binaries/easytier-core-<triple>.exe doesn't exist` | 教师端的 `externalBin` 声明了 EasyTier sidecar，构建时它必须存在 | 构建前跑 `node scripts/fetch-easytier.mjs <triple>`（`rust.yml` 已补这一步） |
| 本机 `tauri build` 到最后一步 `light.exe` 失败，无报错 | MSI 产物名含中文（课堂积分-教师端），而 WiX 默认语言 `en-US` 用代码页 1252，装不下中文 | 两个客户端都设 `bundle.windows.wix.language = "zh-CN"`（代码页 936）→ 出包成功 |
| **13 个枢纽一致性用例全部 404** | Rust 枢纽只把 WebSocket 挂在 `/ws`，而所有客户端连的是 `ws://host:port/?room=…`（Node 版对任意路径都升级）→ 打包后的桌面端连不上自己的界面 | `hub.rs` 同时挂 `/` 与 `/ws`；本机 20 个 Rust 测试全绿 |

> 教训：**工作流的失败信息要能被读到**。注解（`::error::`）与 `tee` 日志是这次能定位问题的关键，
> 所以 `ci-local.mjs` 现在在 Actions 上会把失败步骤的最后十几行直接写成注解。

## 首次跑 CI 的排查清单（保留：下次换环境时仍适用）

本机没有 Rust 工具链，也没有 MSVC/MinGW 链接器，所以 **`apps/` 下的 Rust 只有在 GitHub Actions 上才第一次真正编译**。
首次失败属正常，按下面的顺序看日志即可（每条都对应一个已存在的检查点）：

| 症状 | 原因与处理 |
| --- | --- |
| `generate_context!` 报找不到 `../ui` 或图标 | 构建前必须 `node scripts/sync-ui.mjs <app>`；工作流已内置该步骤。图标由 `scripts/make-icons.py` 生成并已入库 |
| 报 `externalBin` 找不到 sidecar | 教师端要先跑 `node scripts/fetch-easytier.mjs <target>`（`rust.yml` 不打包，故不校验；`build.yml` 会下载）。本地开发用 `tauri dev` 不校验打包资源 |
| `error[E0308]` 或 `Message::Text(...)` 类型不匹配 | 十有八九是 axum 被升到 0.8（它把 ws 的 `Message::Text` 改成 `Utf8Bytes`）。`tests/crates.test.js` 会拦住这种升级 |
| 报 `protocol_gen` 相关符号缺失 | 忘了跑 `node scripts/gen-protocol.mjs`（改过 `packages/protocol/messages.js` 就必须重新生成） |
| `link.exe not found` / `LINK : fatal error` | 只在**本地** Windows 上出现：需要 VS Build Tools（MSVC）。CI 上不会 |
| Linux 报 `webkit2gtk` / `libsoup` 找不到 | 缺系统依赖，`rust.yml` 与 `build.yml` 都已安装；本地 WSL 需自行 `apt install libwebkit2gtk-4.1-dev` |
| Android 构建报 NDK 相关 | `build.yml` 已装 `ndk;26.1.10909125` 并设 `NDK_HOME`；若镜像版本变化，改那一步的版本号即可 |
| iOS 任务失败 | 预期行为：`continue-on-error: true`，真正出包需 Apple 证书（见 docs/11 §7） |
| 出包成功但安装后打不开 | 检查 `identifier` 是否与应用数据目录一致、`ui/` 是否被正确打包（`tauri.conf.json` 的 `frontendDist`） |

> 本地想先把 Rust 验掉：装 `rustup`（+ MSVC 生成工具），然后 `npm run ci`——脚本检测到 `cargo` 会自动加上
> 「教师端 `cargo test`（含 13 个枢纽场景 + 7 个 lib 单测）」与「学生端 `cargo check`」两步。

## 与网页版的关系

网页版（`npm start` + 浏览器）继续可用，是零安装兜底方案；两者数据格式一致，可互相导入导出。
