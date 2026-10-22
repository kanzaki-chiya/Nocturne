/**
 * 桌面端界面状态：置顶会话、手动添加与隐藏的项目。
 * 存 localStorage（键 nocturne.desktop.prefs.v1）；读写失败都不影响本次运行，
 * 只是 persistent 变 false（docs/apps/desktop.md）。
 */

import type { ProjectSort } from "./session-tree";
import {
  parseStoredSessionPanels,
  parseStoredTabs,
  type StoredPanelTab,
  type StoredSessionPanel,
} from "./side-panel";

export type { ProjectSort };

export type FileOpener = "panel" | "system" | "vscode" | "cursor";

export const FILE_OPENER_LABELS: Record<FileOpener, string> = {
  panel: "Nocturne 面板",
  system: "系统默认程序",
  vscode: "VS Code",
  cursor: "Cursor",
};

/**
 * 工作区外的文件能不能左键直接打开：面板与检测到的编辑器可以；
 * 系统默认程序（以及没检测到的编辑器，会退回系统默认）只开菜单，避免点到可执行文件。
 */
export function outsideOpenable(
  opener: FileOpener,
  editors: { vscode: boolean; cursor: boolean },
): boolean {
  return opener === "panel" || (opener !== "system" && editors[opener]);
}

export function isFileOpener(value: unknown): value is FileOpener {
  return value === "panel" || value === "system" || value === "vscode" || value === "cursor";
}

export const PREFS_KEY = "nocturne.desktop.prefs.v1";

export interface Prefs {
  /** 置顶会话 id（数组顺序即显示顺序） */
  pinned: string[];
  /** 手动添加的项目路径（原始字符串，添加顺序） */
  projects: string[];
  /** 从列表移除（隐藏）的项目路径 */
  hidden: string[];
  /** 项目排序：手动（缺省）/ 名称 / 最近活动 */
  projectSort: ProjectSort;
  /**
   * 手动排序的项目归并键顺序，覆盖所有已知项目（含会话 cwd 推出的）。
   * undefined = 旧数据还没有这个字段，App 拿到会话列表后经 migrateLegacyProjectOrder 初始化一次。
   */
  projectOrder?: string[] | undefined;
  /** 上次选用的思考档位（新会话草稿的默认档位） */
  lastEffort?: string | undefined;
  /** 主题：跟随系统 / 月之亮面（浅色） / 月之暗面（深色）；取值仍是 system/light/dark（桌面端本机设置，不进 Core） */
  theme?: "system" | "light" | "dark" | undefined;
  /** 用户选过的普通对话工作区；undefined 用外壳 plain_workspace 的默认路径 */
  plainWorkspace?: string | undefined;
  /** 所有当普通对话工作区用过的路径：cwd 命中任意一个的会话都归入「对话」 */
  plainWorkspaces: string[];
  /** 自动检查更新（默认开；只有显式 false 才关闭） */
  autoUpdate?: boolean | undefined;
  /** 常驻任务清单折叠状态；缺省展开，全局一份 */
  todosCollapsed?: boolean | undefined;
  /**
   * 回答内文件引用"打开文件用"（U-09、ADR-0060）：Nocturne 面板 / 系统默认程序 /
   * VS Code / Cursor。存应用数据（localStorage），不进 settings.json；缺省 panel。
   */
  fileOpener?: FileOpener | undefined;
  /**
   * ADR-0060 升级迁移标记：没有这个标记的旧数据，已有的 fileOpener 一律改回缺省
   * （Nocturne 面板），只做一次；之后用户改回 VS Code 等保留。
   */
  fileOpenerMigrated?: boolean | undefined;
  /** 右侧面板宽度 px（全局，ADR-0060 第 1 节）；缺省 PANEL_DEFAULT_WIDTH，读取时夹在上下限之间 */
  panelWidth?: number | undefined;
  /** 会话概览浮层开关（全局，只在有会话时显示）；缺省关 */
  overviewOpen?: boolean | undefined;
  /**
   * 按会话存的面板（ADR-0060 修订 2026-10-18（二））：开关、「文件」「变更」标签、
   * 当前标签、文件树宽度、换行。会话被删除时一并清掉。
   */
  panelSessions?: Record<string, StoredSessionPanel> | undefined;
  /**
   * 第 1、2 轮的全局标签已经迁移到会话（只迁一次）。没有这个标记时，下面三个旧字段在
   * 拿到会话列表后迁移给最近活动的会话，然后清掉。
   */
  panelSessionsMigrated?: boolean | undefined;
  /** 旧：全局面板开关（只读来迁移） */
  panelOpen?: boolean | undefined;
  /** 旧：全局面板标签（只读来迁移） */
  panelTabs?: StoredPanelTab[] | undefined;
  /** 旧：全局当前标签（只读来迁移） */
  panelActiveTab?: string | undefined;
  /** 上次检查更新的时间戳 ms；自动与手动检查都计入 24h 节流 */
  lastUpdateCheck?: number | undefined;
  /**
   * 面板浏览器 · 桌面内置（第 5 轮）：默认关闭。外壳另有同名开关文件，
   * 启用后要重启后台（新的 Turn）才拿到工具；关闭立即撤销旧绑定。
   */
  agentBrowserEnabled?: boolean | undefined;
  /** 用户已经看过启用风险说明（只在第一次启用时拦一下） */
  agentBrowserRiskAccepted?: boolean | undefined;
  /** 上次检查发现的新版本；「稍后」只清本次运行，重启后若仍比当前新则继续提示 */
  pendingUpdate?: { version: string; notes: string | null } | undefined;
}

const DEFAULTS: Prefs = {
  pinned: [],
  projects: [],
  hidden: [],
  projectSort: "manual",
  plainWorkspaces: [],
};

export interface PrefsStore {
  /** false 表示写不进存储，本次运行内仍生效 */
  readonly persistent: boolean;
  get(): Prefs;
  update(patch: Partial<Prefs>): void;
}

function strings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (!value.every((v): v is string => typeof v === "string")) return undefined;
  return value;
}

/** 逐字段校验：损坏或类型不对的字段回退默认值 */
function parse(raw: string | null): Prefs {
  const prefs: Prefs = { ...DEFAULTS };
  if (raw === null) return prefs;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return prefs;
  }
  if (typeof value !== "object" || value === null) return prefs;
  const obj = value as Record<string, unknown>;
  const pinned = strings(obj.pinned);
  const projects = strings(obj.projects);
  const hidden = strings(obj.hidden);
  if (pinned !== undefined) prefs.pinned = pinned;
  if (projects !== undefined) prefs.projects = projects;
  if (hidden !== undefined) prefs.hidden = hidden;
  if (
    obj.projectSort === "manual" ||
    obj.projectSort === "activity" ||
    obj.projectSort === "name"
  ) {
    prefs.projectSort = obj.projectSort;
  }
  // 有这个字段就不是旧数据：类型不对按空数组（不再触发迁移），缺字段保持 undefined
  if ("projectOrder" in obj) prefs.projectOrder = strings(obj.projectOrder) ?? [];
  if (typeof obj.lastEffort === "string") prefs.lastEffort = obj.lastEffort;
  if (obj.theme === "system" || obj.theme === "light" || obj.theme === "dark") {
    prefs.theme = obj.theme;
  }
  if (typeof obj.plainWorkspace === "string" && obj.plainWorkspace.trim() !== "") {
    prefs.plainWorkspace = obj.plainWorkspace;
  }
  const plainWorkspaces = strings(obj.plainWorkspaces);
  if (plainWorkspaces !== undefined) prefs.plainWorkspaces = plainWorkspaces;
  if (typeof obj.autoUpdate === "boolean") prefs.autoUpdate = obj.autoUpdate;
  if (typeof obj.todosCollapsed === "boolean") prefs.todosCollapsed = obj.todosCollapsed;
  // ADR-0060：没有迁移标记的旧选择不读，统一回到缺省的 Nocturne 面板
  if (obj.fileOpenerMigrated === true) {
    prefs.fileOpenerMigrated = true;
    if (isFileOpener(obj.fileOpener)) {
      prefs.fileOpener = obj.fileOpener;
    }
  }
  if (typeof obj.panelWidth === "number" && Number.isFinite(obj.panelWidth)) {
    prefs.panelWidth = obj.panelWidth;
  }
  if (typeof obj.overviewOpen === "boolean") prefs.overviewOpen = obj.overviewOpen;
  const sessions = parseStoredSessionPanels(obj.panelSessions);
  if (Object.keys(sessions).length > 0) prefs.panelSessions = sessions;
  if (obj.panelSessionsMigrated === true) {
    prefs.panelSessionsMigrated = true;
  } else {
    // 迁移前的旧全局字段；迁移后不再读
    if (typeof obj.panelOpen === "boolean") prefs.panelOpen = obj.panelOpen;
    const tabs = parseStoredTabs(obj.panelTabs);
    if (tabs.length > 0) prefs.panelTabs = tabs;
    if (typeof obj.panelActiveTab === "string") prefs.panelActiveTab = obj.panelActiveTab;
  }
  if (typeof obj.lastUpdateCheck === "number" && Number.isFinite(obj.lastUpdateCheck)) {
    prefs.lastUpdateCheck = obj.lastUpdateCheck;
  }
  if (typeof obj.agentBrowserEnabled === "boolean") {
    prefs.agentBrowserEnabled = obj.agentBrowserEnabled;
  }
  if (obj.agentBrowserRiskAccepted === true) prefs.agentBrowserRiskAccepted = true;
  const pending = obj.pendingUpdate;
  if (
    typeof pending === "object" &&
    pending !== null &&
    typeof (pending as Record<string, unknown>).version === "string"
  ) {
    const notes = (pending as Record<string, unknown>).notes;
    prefs.pendingUpdate = {
      version: (pending as { version: string }).version,
      notes: typeof notes === "string" ? notes : null,
    };
  }
  // lastProject 已废弃：旧数据里的这个字段直接忽略
  return prefs;
}

/**
 * 旧数据迁移（没有 projectOrder 字段）：以前每次都会写入 projectSort "activity"，
 * 分不清是不是用户选的，所以 "activity" 改成 "manual"、"name" 保留；projectOrder 用升级前
 * 「最近活动」规则下的显示顺序初始化，升级后第一次打开项目位置不变。已有 projectOrder 返回 null。
 */
export function migrateLegacyProjectOrder(
  prefs: Pick<Prefs, "projectSort" | "projectOrder">,
  activityOrder: readonly string[],
): Pick<Prefs, "projectSort" | "projectOrder"> | null {
  if (prefs.projectOrder !== undefined) return null;
  return {
    projectSort: prefs.projectSort === "activity" ? "manual" : prefs.projectSort,
    projectOrder: [...activityOrder],
  };
}

export function createPrefsStore(storage: Storage | undefined): PrefsStore {
  let prefs: Prefs = { ...DEFAULTS };
  let persistent = storage !== undefined;
  try {
    prefs = parse(storage?.getItem(PREFS_KEY) ?? null);
  } catch {
    prefs = { ...DEFAULTS };
  }
  const store: PrefsStore = {
    get persistent() {
      return persistent;
    },
    get() {
      return {
        pinned: [...prefs.pinned],
        projects: [...prefs.projects],
        hidden: [...prefs.hidden],
        projectSort: prefs.projectSort,
        ...(prefs.projectOrder !== undefined ? { projectOrder: [...prefs.projectOrder] } : {}),
        plainWorkspaces: [...prefs.plainWorkspaces],
        ...(prefs.lastEffort !== undefined ? { lastEffort: prefs.lastEffort } : {}),
        ...(prefs.theme !== undefined ? { theme: prefs.theme } : {}),
        ...(prefs.plainWorkspace !== undefined ? { plainWorkspace: prefs.plainWorkspace } : {}),
        ...(prefs.autoUpdate !== undefined ? { autoUpdate: prefs.autoUpdate } : {}),
        ...(prefs.todosCollapsed !== undefined ? { todosCollapsed: prefs.todosCollapsed } : {}),
        ...(prefs.fileOpener !== undefined ? { fileOpener: prefs.fileOpener } : {}),
        ...(prefs.fileOpenerMigrated !== undefined
          ? { fileOpenerMigrated: prefs.fileOpenerMigrated }
          : {}),
        ...(prefs.panelOpen !== undefined ? { panelOpen: prefs.panelOpen } : {}),
        ...(prefs.panelWidth !== undefined ? { panelWidth: prefs.panelWidth } : {}),
        ...(prefs.overviewOpen !== undefined ? { overviewOpen: prefs.overviewOpen } : {}),
        ...(prefs.panelSessions !== undefined
          ? {
              panelSessions: Object.fromEntries(
                Object.entries(prefs.panelSessions).map(([id, panel]) => [
                  id,
                  { ...panel, tabs: panel.tabs.map((tab) => ({ ...tab })) },
                ]),
              ),
            }
          : {}),
        ...(prefs.panelSessionsMigrated !== undefined
          ? { panelSessionsMigrated: prefs.panelSessionsMigrated }
          : {}),
        ...(prefs.panelTabs !== undefined
          ? { panelTabs: prefs.panelTabs.map((tab) => ({ ...tab })) }
          : {}),
        ...(prefs.panelActiveTab !== undefined ? { panelActiveTab: prefs.panelActiveTab } : {}),
        ...(prefs.lastUpdateCheck !== undefined ? { lastUpdateCheck: prefs.lastUpdateCheck } : {}),
        ...(prefs.agentBrowserEnabled !== undefined
          ? { agentBrowserEnabled: prefs.agentBrowserEnabled }
          : {}),
        ...(prefs.agentBrowserRiskAccepted !== undefined
          ? { agentBrowserRiskAccepted: prefs.agentBrowserRiskAccepted }
          : {}),
        ...(prefs.pendingUpdate !== undefined ? { pendingUpdate: { ...prefs.pendingUpdate } } : {}),
      };
    },
    update(patch) {
      prefs = { ...prefs, ...patch };
      if (storage === undefined) return;
      try {
        storage.setItem(PREFS_KEY, JSON.stringify(prefs));
      } catch {
        // 写不进去：内存值继续生效，标记非持久
        persistent = false;
      }
    },
  };
  // ADR-0060 一次性迁移：写回标记，此后用户的选择原样保留
  if (prefs.fileOpenerMigrated !== true) store.update({ fileOpenerMigrated: true });
  return store;
}
