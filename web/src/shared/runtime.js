/**
 * 启动接线：复刻旧 admin.js init() 里与领域层的约定（同步、课堂协同、存储、快捷键）。
 * 这些是"领域层与外壳之间"的契约，UI 换成 Vue 后必须一致，否则同步/判分不会工作。
 */
import { CI } from './bridge.js';

export function createRuntime({ onStatus, onRemoteDump } = {}) {
  const info = {
    connected: false,
    statusText: '连接中…',
    statusKind: 'wait',
    serverInfo: null,
    storageText: '',
    storageWarning: '',
    room: ''
  };

  function setStatus(text, kind) {
    info.statusText = text;
    info.statusKind = kind || 'wait';
    if (onStatus) onStatus(info);
  }

  function boot() {
    CI.store.init();

    /* ---- 存储：教师端本地 SQLite 自动接管（远端新→载入；本地新→推上去） ---- */
    if (CI.storage) {
      CI.storage.bootstrap()
        .then((res) => {
          if (res && res.action === 'loaded-remote' && CI.sync) CI.sync.push(true);
          info.storageText = CI.storage.describe();
          info.storageWarning = CI.storage.warning();
          if (onStatus) onStatus(info);
        })
        .catch(() => { /* 无枢纽时静默用 localStorage */ });

      const flushNow = () => { try { CI.storage.flush(); } catch (e) { /* 忽略 */ } };
      window.addEventListener('beforeunload', flushNow);
      window.addEventListener('pagehide', flushNow);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') flushNow();
      });
    }

    /* ---- 任何状态变更：更新存储芯片 + 推给枢纽 ---- */
    CI.store.on('change', () => {
      if (CI.storage) {
        info.storageText = CI.storage.describe();
        info.storageWarning = CI.storage.warning();
      }
      if (CI.sync) CI.sync.push();
      if (onStatus) onStatus(info);
    });

    /* ---- 枢纽连接：命令（学生提交）/ 在线小组 / 服务器信息 / 远端快照 ---- */
    if (CI.sync) {
      CI.sync.init({
        // sync.js 的回调签名是 (text, cls)：cls 形如 'chip-ok' / 'chip-bad' / ''
        onStatus: (text, cls) => {
          info.connected = /ok|live/.test(cls || '');
          setStatus(text, cls);
        },
        onCmd: (cmd) => CI.classroom.handleCmd(cmd),
        onPresence: (msg) => CI.classroom.setPresence(msg),
        onServerInfo: (serverInfo) => {
          info.serverInfo = serverInfo;
          CI.classroom.setServerInfo(serverInfo);
          if (onStatus) onStatus(info);
        },
        onDump: (dump, force) => {
          if (force) { CI.classroom.loadRemoteState(dump); return; }
          if (onRemoteDump) onRemoteDump(dump);
        }
      });
      info.room = CI.sync.room();
    }

    window.addEventListener('beforeunload', () => { if (CI.sync) CI.sync.push(true); });

    return info;
  }

  return { info, boot, setStatus };
}
