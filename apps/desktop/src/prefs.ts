/**
 * 桌面端界面状态：置顶会话、手动添加与隐藏的项目。
 * 存 localStorage（键 nocturne.desktop.prefs.v1）；读写失败都不影响本次运行，
 * 只是 persistent 变 false（docs/apps/desktop.md）。
 */

export const PREFS_KEY = "nocturne.desktop.prefs.v1";

export type ProjectSort = "activity" | "name";

export interface Prefs {
  /** 置顶会话 id（数组顺序即显示顺序） */
  pinned: string[];
  /** 手动添加的项目路径（原始字符串，添加顺序） */
  projects: string[];
  /** 从列表移除（隐藏）的项目路径 */
  hidden: string[];
  /** 项目排序：最近活动 / 名称 */
  projectSort: ProjectSort;
  /** 上次选用的思考档位（新会话草稿的默认档位） */
  lastEffort?: string | undefined;
  /** 主题：跟随系统 / 浅色 / 深色（桌面端本机设置，不进 Core） */
  theme?: "system" | "light" | "dark" | undefined;
  /** 用户选过的普通对话工作区；undefined 用外壳 plain_workspace 的默认路径 */
  plainWorkspace?: string | undefined;
  /** 所有当普通对话工作区用过的路径：cwd 命中任意一个的会话都归入「对话」 */
  plainWorkspaces: string[];
  /** 自动检查更新（默认开；只有显式 false 才关闭） */
  autoUpdate?: boolean | undefined;
  /** 上次检查更新的时间戳 ms；自动与手动检查都计入 24h 节流 */
  lastUpdateCheck?: number | undefined;
  /** 上次检查发现的新版本；「稍后」只清本次运行，重启后若仍比当前新则继续提示 */
  pendingUpdate?: { version: string; notes: string | null } | undefined;
}

const DEFAULTS: Prefs = {
  pinned: [],
  projects: [],
  hidden: [],
  projectSort: "activity",
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
  if (obj.projectSort === "activity" || obj.projectSort === "name") {
    prefs.projectSort = obj.projectSort;
  }
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
  if (typeof obj.lastUpdateCheck === "number" && Number.isFinite(obj.lastUpdateCheck)) {
    prefs.lastUpdateCheck = obj.lastUpdateCheck;
  }
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

export function createPrefsStore(storage: Storage | undefined): PrefsStore {
  let prefs: Prefs = { ...DEFAULTS };
  let persistent = storage !== undefined;
  try {
    prefs = parse(storage?.getItem(PREFS_KEY) ?? null);
  } catch {
    prefs = { ...DEFAULTS };
  }
  return {
    get persistent() {
      return persistent;
    },
    get() {
      return {
        pinned: [...prefs.pinned],
        projects: [...prefs.projects],
        hidden: [...prefs.hidden],
        projectSort: prefs.projectSort,
        plainWorkspaces: [...prefs.plainWorkspaces],
        ...(prefs.lastEffort !== undefined ? { lastEffort: prefs.lastEffort } : {}),
        ...(prefs.theme !== undefined ? { theme: prefs.theme } : {}),
        ...(prefs.plainWorkspace !== undefined ? { plainWorkspace: prefs.plainWorkspace } : {}),
        ...(prefs.autoUpdate !== undefined ? { autoUpdate: prefs.autoUpdate } : {}),
        ...(prefs.lastUpdateCheck !== undefined ? { lastUpdateCheck: prefs.lastUpdateCheck } : {}),
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
}
