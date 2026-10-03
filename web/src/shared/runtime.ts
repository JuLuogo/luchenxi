/**
 * 启动接线：复刻旧 admin.js init() 里与领域层的约定（同步、课堂协同、存储、快捷键）。
 * 这些是"领域层与外壳之间"的契约，UI 换成 Vue 后必须一致，否则同步/判分不会工作。
 */
import { CI } from './bridge';
import { gradeWithRust } from './domain-api';
import type { ClassroomState } from '@/bindings/state';

/** 连接与存储的展示状态（顶栏状态条用） */
export interface RuntimeInfo {
  connected: boolean;
  statusText: string;
  statusKind: string;
  serverInfo: unknown;
  storageText: string;
  storageWarning: string;
  room: string;
}

export interface RuntimeHooks {
  onStatus?: (info: RuntimeInfo) => void;
  onRemoteDump?: (dump: ClassroomState) => void;
}

interface BootstrapResult {
  action?: string;
}

export function createRuntime(hooks: RuntimeHooks = {}) {
  const { onStatus, onRemoteDump } = hooks;

  const info: RuntimeInfo = {
    connected: false,
    statusText: '连接中…',
    statusKind: 'wait',
    serverInfo: null,
    storageText: '',
    storageWarning: '',
    room: ''
  };

  function setStatus(text: string, kind?: string): void {
    info.statusText = text;
    info.statusKind = kind || 'wait';
    if (onStatus) onStatus(info);
  }

  function boot(): RuntimeInfo {
    CI.store.init();

    /* ---- 存储：教师端本地 SQLite 自动接管（远端新→载入；本地新→推上去） ---- */
    const storage = CI.storage as
      | {
          bootstrap(): Promise<BootstrapResult>;
          describe(): string;
          warning(): string;
          flush(): void;
        }
      | undefined;

    if (storage) {
      storage
        .bootstrap()
        .then((res: BootstrapResult) => {
          if (res && res.action === 'loaded-remote' && CI.sync) {
            (CI.sync as { push(force?: boolean): void }).push(true);
          }
          info.storageText = storage.describe();
          info.storageWarning = storage.warning();
          if (onStatus) onStatus(info);
        })
        .catch(() => {
          /* 无枢纽时静默用 localStorage */
        });

      const flushNow = (): void => {
        try {
          storage.flush();
        } catch {
          /* 忽略 */
        }
      };
      window.addEventListener('beforeunload', flushNow);
      window.addEventListener('pagehide', flushNow);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') flushNow();
      });
    }

    /* ---- 任何状态变更：更新存储芯片 + 推给枢纽 ---- */
    CI.store.on('change', () => {
      if (storage) {
        info.storageText = storage.describe();
        info.storageWarning = storage.warning();
      }
      if (CI.sync) (CI.sync as { push(force?: boolean): void }).push();
      if (onStatus) onStatus(info);
    });

    /* ---- 枢纽连接：命令（学生提交）/ 在线小组 / 服务器信息 / 远端快照 ---- */
    const sync = CI.sync as
      | {
          init(opts: Record<string, unknown>): void;
          room(): string;
          push(force?: boolean): void;
        }
      | undefined;

    if (sync) {
      const classroom = CI.classroom as {
        handleCmd(cmd: unknown, backlog?: boolean, pre?: unknown): unknown;
        setPresence(msg: unknown): void;
        setServerInfo(info: unknown): void;
        loadRemoteState(dump: ClassroomState): void;
      };

      sync.init({
        // sync.js 的回调签名是 (text, cls)：cls 形如 'chip-ok' / 'chip-bad' / ''
        onStatus: (text: string, cls?: string) => {
          info.connected = /ok|live/.test(cls || '');
          setStatus(text, cls);
        },
        // 异步边界就放在这里（WS 回调本来就可以 await）：先问 Rust 核心要判定，
        // 拿不到就让 handleCmd 走本地判分 —— 课堂核心循环用上 Rust 口径，
        // 同时网络抖一下也不会卡住流程。
        onCmd: async (cmd: unknown) => {
          let pre: unknown = null;
          try {
            pre = await gradeWithRust(cmd as Parameters<typeof gradeWithRust>[0]);
          } catch { /* 回退本地 */ }
          return classroom.handleCmd(cmd, false, pre);
        },
        onPresence: (msg: unknown) => classroom.setPresence(msg),
        onServerInfo: (serverInfo: unknown) => {
          info.serverInfo = serverInfo;
          classroom.setServerInfo(serverInfo);
          if (onStatus) onStatus(info);
        },
        onDump: (dump: ClassroomState, force?: boolean) => {
          if (force) {
            classroom.loadRemoteState(dump);
            return;
          }
          if (onRemoteDump) onRemoteDump(dump);
        }
      });
      info.room = sync.room();
    }

    window.addEventListener('beforeunload', () => {
      if (CI.sync) (CI.sync as { push(force?: boolean): void }).push(true);
    });

    return info;
  }

  return { info, boot, setStatus };
}
