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
  /** 读系统剪贴板文本（右键粘贴）；剪贴板里没有文本时是空串 */
  readClipboard: () => Promise<string>;
  /**
   * 写系统剪贴板文本（Ctrl+Shift+C、右键复制）。WebView2 里 navigator.clipboard.writeText
   * 会静默失败，所以由外壳写；失败时抛错，界面要给出提示。
   */
  writeClipboard: (text: string) => Promise<void>;
}

/** 外壳浏览器推来的页面事件（src-tauri/src/browser.rs BrowserMessage） */
export type BrowserMessage =
  | { kind: "url"; url: string }
  | { kind: "title"; title: string }
  | { kind: "loading"; loading: boolean }
  | { kind: "history"; back: boolean; forward: boolean }
  /** 网站图标 PNG 字节；没有图标时 null */
  | { kind: "favicon"; png: number[] | null }
  /** target=_blank / window.open：在本会话开一个新浏览器标签 */
  | { kind: "newWindow"; url: string }
  /** 被导航规则拦下（外部程序、应用自身地址、网页跳本地文件等） */
  | { kind: "blocked"; url: string; reason: string; message: string }
  | { kind: "download"; state: "started" | "finished" | "failed"; name: string }
  /** 焦点在网页里时按下的应用快捷键（Ctrl+B / T / P / `） */
  | { kind: "shortcut"; key: "b" | "t" | "p" | "backquote" };

/** 浏览器在窗口里的位置（CSS 像素，相对窗口客户区左上角） */
export interface BrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type BrowserAction = "reload" | "back" | "forward" | "stop" | "devtools" | "focus";

/**
 * 面板内置浏览器（ADR-0060 第 5 节、desktop.md 5.10）：每个浏览器标签一个外壳子 webview，
 * 叠在主界面上方。导航规则、隔离和下载都在外壳；前端只给地址和位置。
 */
export interface BrowserHost {
  /** bounds 为 null 时先建好但不显示 */
  create: (
    url: string,
    bounds: BrowserBounds | null,
    onMessage: (message: BrowserMessage) => void,
  ) => Promise<number>;
  /** 地址栏导航；白名单外的协议被拒绝（抛错，message 是给用户看的文案） */
  navigate: (id: number, url: string) => Promise<void>;
  /** null = 隐藏 */
  layout: (id: number, bounds: BrowserBounds | null) => Promise<void>;
  action: (id: number, action: BrowserAction) => Promise<void>;
  /** 当前页面截图（PNG）；主界面浮层伸进面板时做占位 */
  capture: (id: number) => Promise<Uint8Array>;
  destroy: (id: number) => Promise<void>;
}

/** agent 标签的展示状态（desktop-browser.md 第 7 节） */
export interface AgentTabInfo {
  tabId: string;
  rootSessionId: string;
  actorSessionId: string;
  title: string;
  url: string;
  live: boolean;
  pinned: boolean;
  state: "agent" | "busy" | "taken_over" | "ended";
  operation?: string | undefined;
  child: boolean;
  notice?: string | undefined;
  /** 网页挂起的脚本对话框，等用户在横幅里答复（`defaultText` 只对 prompt 有意义） */
  dialog?: { kind: string; uri: string; message: string; defaultText?: string } | undefined;
}

export interface AgentWatchSnapshot {
  shellGeneration: number;
  revision: number;
  enabled: boolean;
  tabs: AgentTabInfo[];
}

export type AgentWatchMessage =
  | ({
      kind: "tabs";
      tabs: AgentTabInfo[];
    } & Omit<AgentWatchSnapshot, "tabs" | "enabled">)
  | {
      kind: "present";
      shellGeneration: number;
      revision: number;
      operationId: string;
      tabId: string;
    }
  | {
      kind: "operation";
      shellGeneration: number;
      revision: number;
      tabId: string;
      operationId: string;
      state: "started" | "completed" | "cancelled";
      operation: string;
      errorCode?: string | undefined;
    };

/** 主界面向外壳报告的 UI 状态：外壳据此把 agent webview 放到面板或移出可见区 */
export interface AgentUiState {
  shellGeneration: number;
  revision: number;
  route: "session" | "settings" | "home";
  sessionId?: string | undefined;
  panelOpen: boolean;
  activeTabId?: string | undefined;
  covered: boolean;
  layout?: { tabId: string; version: number; bounds: BrowserBounds } | undefined;
}

/**
 * 面板浏览器 · 桌面内置（desktop-browser.md）：功能默认关闭；启用后 agent 经回环 MCP
 * 操作自己的标签。前端只做展示、接管/交回与布局，不接触 bearer 或网页正文。
 */
export interface AgentBrowserHost {
  watch: (onMessage: (message: AgentWatchMessage) => void) => Promise<AgentWatchSnapshot>;
  uiState: (ui: AgentUiState) => Promise<void>;
  presented: (input: {
    shellGeneration: number;
    operationId: string;
    tabId: string;
    layoutVersion: number;
  }) => Promise<void>;
  control: (
    tabId: string,
    action: "takeover" | "return" | "close",
  ) => Promise<{ revision: number; state?: string | undefined }>;
  /** 用户答复挂起的脚本对话框：确定（prompt 带输入）或取消 */
  dialog: (tabId: string, accept: boolean, text?: string) => Promise<void>;
  setEnabled: (enabled: boolean) => Promise<{ enabled: boolean; restartRequired: boolean }>;
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
  /** 面板内置浏览器；没有时网址与 HTML 交给系统浏览器 */
  browsers?: BrowserHost;
  /** 面板浏览器 · 桌面内置（agent）；没有时设置里不显示这一项 */
  agentBrowser?: AgentBrowserHost;
}
