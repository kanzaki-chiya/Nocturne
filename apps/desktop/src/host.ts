import type { NotifyResult } from "./notify";
import type { PickedImage } from "./picked-images";
import type { BackendMessage } from "./types";

/**
 * updater 插件发现的新版本（前端只拿展示数据与安装入口；
 * Windows 下 downloadAndInstall 期间进程被安装器接管退出，Promise 可能不返回）。
 */
export interface AvailableUpdate {
  version: string;
  /** 发布说明（latest.json 的 notes）；没有为 null */
  notes: string | null;
  downloadAndInstall: (
    onProgress?: (downloaded: number, total: number | undefined) => void,
  ) => Promise<void>;
}

/** 外壳终端推来的消息（src-tauri/src/terminal.rs TerminalMessage） */
export type TerminalMessage =
  { kind: "output"; data: string } | { kind: "exit"; code: number | null };

/**
 * 面板终端（ADR-0060 第 4 节）：pty 在 Tauri 外壳。shell 只能是外壳认可的可执行文件，
 * 参数由外壳按 shell 种类决定，前端只给路径、工作目录和尺寸。
 */
export interface TerminalHost {
  open: (
    input: { shell: string; cwd: string; cols: number; rows: number },
    onMessage: (message: TerminalMessage) => void,
  ) => Promise<number>;
  write: (id: number, data: string) => Promise<void>;
  resize: (id: number, cols: number, rows: number) => Promise<void>;
  /** 结束进程；已经结束的也返回成功 */
  close: (id: number) => Promise<void>;
  /** 读系统剪贴板文本（右键菜单「粘贴」）；剪贴板里没有文本时是空串 */
  readClipboard: () => Promise<string>;
}

/**
 * 宿主抽象：前端对 Tauri 的全部依赖都在这一个接口后面，
 * 测试用假宿主替换（docs/apps/desktop.md）。
 */
export interface DesktopHost {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  /** 建一个 Tauri Channel 等价物；返回值原样传进 invoke 参数 */
  createChannel: (onMessage: (m: BackendMessage) => void) => unknown;
  /** 用系统浏览器打开链接（实现里先过 isAllowedExternalUrl） */
  openUrl: (url: string) => Promise<void>;
  /**
   * 用系统默认程序打开文件（Rust 命令 open_with_default，不带行号）；
   * 脚本、可执行文件等会被直接执行的类型改为在资源管理器中显示
   */
  openPath: (path: string) => Promise<void>;
  /** 在资源管理器中显示文件/目录（opener reveal） */
  revealItem: (path: string) => Promise<void>;
  /** 检测已安装的编辑器（VS Code、Cursor） */
  detectEditors: () => Promise<{ vscode: boolean; cursor: boolean }>;
  /** 用指定编辑器打开文件并跳到行号（Rust 命令经 code/cursor -g 启动） */
  openInEditor: (editor: "vscode" | "cursor", path: string, line?: number) => Promise<void>;
  /** 系统文件夹选择对话框；取消返回 null */
  pickFolder: () => Promise<string | null>;
  /** 系统图片选择对话框；取消返回空列表 */
  pickImages: () => Promise<PickedImage[]>;
  /** 用户主目录（路径 ~ 缩写用）；取不到返回 null */
  homeDir: () => Promise<string | null>;
  /** 当前应用版本号 */
  appVersion: () => Promise<string>;
  /** updater 检查更新；null = 已是最新，失败抛错 */
  checkUpdate: () => Promise<AvailableUpdate | null>;
  /** 重启应用（非 Windows 平台装完更新需要手动重启） */
  relaunch: () => Promise<void>;
  /**
   * 往外壳日志写一行诊断（后台日志页「外壳」条目可见）。
   * 内部 fire-and-forget：写失败不抛错。
   */
  note: (line: string) => void;
  /**
   * 发一条 Windows 系统通知（外壳自实现的 WinRT toast，ADR-0056）。
   * 同一会话的新通知替换旧的（tag/group = sessionId）；非 Windows 或系统
   * 关掉了本应用的通知时返回 `{ shown: false }`，不抛错。
   */
  notify: (input: {
    sessionId: string;
    title: string;
    body: string;
    sound: boolean;
  }) => Promise<NotifyResult>;
  /** 撤掉某个会话的通知（用户切到该会话时）；没有也返回成功 */
  dismissNotification: (sessionId: string) => Promise<void>;
  /**
   * 任务栏闪烁（窗口失焦时提醒）：Windows 上一直闪到窗口获得焦点。
   * 非 Windows / 失败静默。
   */
  requestAttention: () => Promise<void>;
  /** 通知被点击（外壳在 toast 激活时空调用）：回调会话 id；返回取消订阅 */
  onNotificationActivated: (handler: (sessionId: string) => void) => () => void;
  /** 面板终端；没有（测试宿主）时新标签页的「终端」入口置灰 */
  terminals?: TerminalHost;
}
