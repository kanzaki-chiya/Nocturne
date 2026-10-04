/**
 * 桌面端界面状态：置顶会话、手动添加与隐藏的项目。
 * 存 localStorage（键 nocturne.desktop.prefs.v1）；读写失败都不影响本次运行，
 * 只是 persistent 变 false（docs/apps/desktop.md）。
 */

export const PREFS_KEY = "nocturne.desktop.prefs.v1";

export interface Prefs {
  /** 置顶会话 id（数组顺序即显示顺序） */
  pinned: string[];
  /** 手动添加的项目路径（原始字符串，添加顺序） */
  projects: string[];
  /** 从列表移除（隐藏）的项目 key */
  hidden: string[];
}

const DEFAULTS: Prefs = { pinned: [], projects: [], hidden: [] };

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
