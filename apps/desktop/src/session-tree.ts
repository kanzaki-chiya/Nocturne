/**
 * 会话树（纯函数）：置顶区、普通对话区（<NOCTURNE_HOME>/workspace 的会话）、
 * 按项目分组、默认每区 5 条。项目归并以 projectKey 比较（Windows 路径忽略大小写
 * 与分隔符差异），显示用第一次见到的原始路径（docs/apps/desktop.md）。
 */
import type { RpcRuntime } from "@nocturne/rpc/client";

export type SessionSummary = Awaited<ReturnType<RpcRuntime["listSessions"]>>[number];

/** 归并键：去掉末尾分隔符；像 Windows 路径就统一 `\` 并小写 */
export function projectKey(path: string): string {
  let p = path;
  while (p.length > 1 && (p.endsWith("/") || p.endsWith("\\"))) {
    // 根目录（C:\ 或 /）不去分隔符
    if (p.length <= 3 && /^[A-Za-z]:[\\/]$/.test(p)) break;
    if (p === "/" || p === "\\") break;
    p = p.slice(0, -1);
  }
  if (/^[A-Za-z]:/.test(p) || p.includes("\\")) {
    return p.replace(/\//g, "\\").toLowerCase();
  }
  return p;
}

/** 项目名 = 路径最后一段 */
export function projectName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

/** 相对时间：<60s「现在」<1h「N 分钟」<24h「N 小时」<48h「昨天」<30d「N 天」否则 YYYY-MM-DD */
export function formatRelative(mtimeMs: number, now: number): string {
  const delta = Math.max(0, now - mtimeMs);
  if (delta < 60_000) return "现在";
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时`;
  if (hours < 48) return "昨天";
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天`;
  const d = new Date(mtimeMs);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export type SessionStatus = "idle" | "running" | "pending";

export interface SessionRow {
  id: string;
  title: string;
  meta: string;
  locked: boolean;
  status: SessionStatus;
}

export interface PinnedRow extends SessionRow {
  /** 所属项目名（置顶区每条都标出） */
  project: string;
}

export interface ProjectNode {
  key: string;
  name: string;
  /** 第一次见到的原始路径 */
  path: string;
  /** 项目内会话总数（折叠时右侧显示） */
  count: number;
  /** 已置顶的不在项目里重复出现 */
  sessions: SessionRow[];
  moreCount: number;
  /** 手动添加且没有会话的项目 */
  manual: boolean;
}

/** 「对话」分区（普通对话工作区的会话平铺列表） */
export interface ChatsSection {
  rows: SessionRow[];
  moreCount: number;
}

export interface SessionTree {
  pinned: PinnedRow[];
  chats: ChatsSection;
  projects: ProjectNode[];
  /**
   * 可见但还不在 projectOrder 里的项目键（按手动模式规则排好的顺序）。
   * 纯函数不写 prefs：由 App 把它们插到 projectOrder 前面并保存（任何排序模式都返回）。
   */
  newProjectKeys: string[];
}

/** 项目排序：手动（默认）/ 名称 / 最近活动 */
export type ProjectSort = "manual" | "name" | "activity";

export interface TreePrefs {
  pinned: readonly string[];
  projects: readonly string[];
  hidden: readonly string[];
  /** 项目排序（缺省按手动） */
  projectSort?: ProjectSort;
  /** 手动排序的项目键顺序；缺省按空数组处理（全部视为新项目） */
  projectOrder?: readonly string[] | undefined;
}

export interface TreeOptions {
  /** 当前普通对话工作区路径；与 plainWorkspaces 都为 null/空时全部会话按项目处理 */
  plainWorkspace: string | null;
  /** 用过的全部普通对话工作区：cwd 命中任意一个的会话归入「对话」区 */
  plainWorkspaces?: readonly string[];
  /** 「展开显示」已展开的项目 key */
  expanded: ReadonlySet<string>;
  /** 「对话」区已展开（显示全部，不再限 limit 条） */
  chatsExpanded?: boolean;
  /** 已折叠的项目 key */
  collapsed: ReadonlySet<string>;
  now?: number;
  /** 每区默认显示条数 */
  limit?: number;
  statuses?: Readonly<Record<string, SessionStatus>>;
}

const DEFAULT_LIMIT = 5;

/** 空会话（无用户消息且未锁定）不显示（ADR-0046 修订第 4 条） */
function isVisible(session: SessionSummary): boolean {
  const hasText = session.firstText !== undefined && session.firstText.trim() !== "";
  return hasText || session.locked === true;
}

function toRow(session: SessionSummary, now: number, status: SessionStatus): SessionRow {
  let meta = status === "pending" ? "待确认" : formatRelative(session.mtimeMs, now);
  if (session.locked === true) meta = `🔒 ${meta}`;
  return {
    id: session.id,
    title: session.firstText ?? "未命名会话",
    meta,
    locked: session.locked === true,
    status,
  };
}

/**
 * 构建会话树：
 * - 空会话（firstText 缺省/空白且未锁定）一律过滤；
 * - cwd == plainWorkspace 的会话进 chats（不进 projects），手动项目里同路径的也不显示为项目；
 * - projects = 其余会话 cwd 的 key ∪ 手动项目 − hidden；
 *   排序：manual（缺省）按 projectOrder，不在其中的新项目排最上面（无会话的在前，
 *   其余按最早会话 createdAt 降序）；activity 有会话的按最新 mtimeMs 降序，其后是
 *   无会话的手动项目按添加顺序；name 按名称（大小写不敏感、数字按数值比）。
 */
export function buildSessionTree(
  sessions: SessionSummary[],
  prefs: TreePrefs,
  options: TreeOptions,
): SessionTree {
  const now = options.now ?? Date.now();
  const limit = options.limit ?? DEFAULT_LIMIT;
  const hidden = new Set(prefs.hidden.map(projectKey));
  const pinnedIds = new Set(prefs.pinned);
  // 当前工作区 + prefs 记下的历史工作区都归「对话」（换位置后旧会话不跑进「项目」）
  const chatKeys = new Set<string>();
  if (options.plainWorkspace !== null) chatKeys.add(projectKey(options.plainWorkspace));
  for (const path of options.plainWorkspaces ?? []) chatKeys.add(projectKey(path));

  const visible = sessions.filter(isVisible);

  // 对话区：cwd 归并后等于任一普通对话工作区
  const chatSessions = visible.filter((s) => chatKeys.has(projectKey(s.cwd)));
  const chatRows = chatSessions
    .filter((s) => !pinnedIds.has(s.id))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  const chatsShown = options.chatsExpanded ? chatRows : chatRows.slice(0, limit);
  const chats: ChatsSection = {
    rows: chatsShown.map((s) => toRow(s, now, options.statuses?.[s.id] ?? "idle")),
    moreCount: options.chatsExpanded ? 0 : chatRows.length - chatsShown.length,
  };

  // 项目分组（对话会话与对话工作区本身不进 projects）
  const groups = new Map<string, { path: string; sessions: SessionSummary[] }>();
  for (const session of visible) {
    const key = projectKey(session.cwd);
    if (chatKeys.has(key)) continue;
    let group = groups.get(key);
    if (group === undefined) {
      group = { path: session.cwd, sessions: [] };
      groups.set(key, group);
    }
    group.sessions.push(session);
  }

  // 手动项目：合并进分组（保留添加顺序与原始路径）；对话工作区不算手动项目
  const manualOrder: string[] = [];
  for (const path of prefs.projects) {
    const key = projectKey(path);
    if (chatKeys.has(key)) continue;
    if (!groups.has(key)) {
      groups.set(key, { path, sessions: [] });
    }
    manualOrder.push(key);
  }

  // 置顶区：按 pinned 数组顺序；隐藏项目的置顶会话仍显示；对话会话标「对话」
  const byId = new Map(visible.map((s) => [s.id, s]));
  const pinned: PinnedRow[] = [];
  for (const id of prefs.pinned) {
    const session = byId.get(id);
    if (session === undefined) continue;
    const isChat = chatKeys.has(projectKey(session.cwd));
    pinned.push({
      ...toRow(session, now, options.statuses?.[session.id] ?? "idle"),
      project: isChat ? "对话" : projectName(session.cwd),
    });
  }

  const visibleKeys: string[] = [];
  for (const [key, group] of groups) {
    if (hidden.has(key)) continue;
    if (group.sessions.length === 0 && !manualOrder.includes(key)) continue;
    visibleKeys.push(key);
  }

  // 新项目（不在 projectOrder 里）：无会话的在前（后添加的在前），其余按最早会话 createdAt 降序
  const orderIndex = new Map((prefs.projectOrder ?? []).map((key, i) => [key, i]));
  const earliest = (key: string): string => {
    const created = (groups.get(key)?.sessions ?? []).map((s) => s.createdAt);
    return created.reduce((min, c) => (c < min ? c : min), created[0] ?? "");
  };
  const newProjectKeys = visibleKeys
    .filter((key) => !orderIndex.has(key))
    .sort((a, b) => {
      const ea = groups.get(a)?.sessions.length === 0;
      const eb = groups.get(b)?.sessions.length === 0;
      if (ea !== eb) return ea ? -1 : 1;
      if (ea) return manualOrder.indexOf(b) - manualOrder.indexOf(a);
      const ca = earliest(a);
      const cb = earliest(b);
      return ca === cb ? 0 : ca < cb ? 1 : -1;
    });

  let order: string[];
  if (prefs.projectSort === "activity") {
    const withSessions: { key: string; latest: number }[] = [];
    const manualEmpty: string[] = [];
    for (const key of visibleKeys) {
      const group = groups.get(key);
      if (group === undefined) continue;
      if (group.sessions.length === 0) {
        manualEmpty.push(key);
        continue;
      }
      withSessions.push({ key, latest: Math.max(...group.sessions.map((s) => s.mtimeMs)) });
    }
    withSessions.sort((a, b) => b.latest - a.latest);
    manualEmpty.sort((a, b) => manualOrder.indexOf(a) - manualOrder.indexOf(b));
    order = [...withSessions.map((w) => w.key), ...manualEmpty];
  } else {
    const known = visibleKeys
      .filter((key) => orderIndex.has(key))
      .sort((a, b) => (orderIndex.get(a) ?? 0) - (orderIndex.get(b) ?? 0));
    order = [...newProjectKeys, ...known];
  }

  const projects: ProjectNode[] = [];
  for (const key of order) {
    const group = groups.get(key);
    if (group === undefined) continue;
    const unpinned = group.sessions
      .filter((s) => !pinnedIds.has(s.id))
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    const expanded = options.expanded.has(key);
    const shown = expanded ? unpinned : unpinned.slice(0, limit);
    projects.push({
      key,
      name: projectName(group.path),
      path: group.path,
      count: group.sessions.length,
      sessions: shown.map((s) => toRow(s, now, options.statuses?.[s.id] ?? "idle")),
      moreCount: expanded ? 0 : unpinned.length - shown.length,
      manual: manualOrder.includes(key),
    });
  }

  // 名称排序时对全部项目（含无会话的手动项目）统一排序
  if (prefs.projectSort === "name") {
    projects.sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }),
    );
  }

  return { pinned, chats, projects, newProjectKeys };
}

/**
 * 把可见列表里的 key 移到可见位置 toIndex（移动前的插入下标，0..visible.length），
 * 换算回完整的 projectOrder：落在某个可见项之前就插到它在完整数组里的位置之前，
 * 落在末尾就插到最后一个可见项之后；隐藏项目之间及相对其他项的位置不变。
 * 不在 order 里的可见键先按显示顺序补到最前面。
 */
export function moveProjectKey(
  order: readonly string[],
  visible: readonly string[],
  key: string,
  toIndex: number,
): string[] {
  const missing = visible.filter((k) => !order.includes(k));
  const full = [...missing, ...order].filter((k) => k !== key);
  const from = visible.indexOf(key);
  const rest = visible.filter((k) => k !== key);
  let target = Math.max(0, Math.min(toIndex, visible.length));
  if (from >= 0 && from < target) target -= 1;
  if (rest.length === 0) return [key, ...full];
  const anchor = rest[target];
  if (anchor !== undefined) {
    full.splice(full.indexOf(anchor), 0, key);
  } else {
    const last = rest[rest.length - 1] ?? "";
    full.splice(full.indexOf(last) + 1, 0, key);
  }
  return full;
}
