/**
 * 会话树（纯函数）：按项目分组、置顶区、默认每项目 5 条。
 * 项目归并以 projectKey 比较（Windows 路径忽略大小写与分隔符差异），
 * 显示用第一次见到的原始路径（docs/apps/desktop.md）。
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

export interface SessionTree {
  pinned: PinnedRow[];
  projects: ProjectNode[];
}

export interface TreePrefs {
  pinned: readonly string[];
  projects: readonly string[];
  hidden: readonly string[];
}

export interface TreeOptions {
  /** 「展开显示」已展开的项目 key */
  expanded: ReadonlySet<string>;
  /** 已折叠的项目 key */
  collapsed: ReadonlySet<string>;
  now?: number;
  /** 每项目默认显示条数 */
  limit?: number;
}

const DEFAULT_LIMIT = 5;

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
 * 构建会话树：项目 = 会话 cwd 的 key ∪ 手动项目 − hidden。
 * 排序：有会话的按最新 mtimeMs 降序，其后是无会话的手动项目（按添加顺序）。
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

  // 分组 + 每个 key 的显示路径（第一次见到的原始路径）
  const groups = new Map<string, { path: string; sessions: SessionSummary[] }>();
  for (const session of sessions) {
    const key = projectKey(session.cwd);
    let group = groups.get(key);
    if (group === undefined) {
      group = { path: session.cwd, sessions: [] };
      groups.set(key, group);
    }
    group.sessions.push(session);
  }

  // 手动项目：合并进分组（保留添加顺序与原始路径）
  const manualOrder: string[] = [];
  for (const path of prefs.projects) {
    const key = projectKey(path);
    if (!groups.has(key)) {
      groups.set(key, { path, sessions: [] });
    }
    manualOrder.push(key);
  }

  // 置顶区：按 pinned 数组顺序；隐藏项目的置顶会话仍显示
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const pinned: PinnedRow[] = [];
  for (const id of prefs.pinned) {
    const session = byId.get(id);
    if (session === undefined) continue;
    pinned.push({ ...toRow(session, now, "idle"), project: projectName(session.cwd) });
  }

  const withSessions: { key: string; latest: number }[] = [];
  const manualEmpty: string[] = [];
  for (const [key, group] of groups) {
    if (hidden.has(key)) continue;
    if (group.sessions.length === 0) {
      if (manualOrder.includes(key)) manualEmpty.push(key);
      continue;
    }
    const latest = Math.max(...group.sessions.map((s) => s.mtimeMs));
    withSessions.push({ key, latest });
  }
  withSessions.sort((a, b) => b.latest - a.latest);
  manualEmpty.sort((a, b) => manualOrder.indexOf(a) - manualOrder.indexOf(b));

  const projects: ProjectNode[] = [];
  const order = [...withSessions.map((w) => w.key), ...manualEmpty];
  for (const key of order) {
    const group = groups.get(key);
    if (group === undefined) continue;
    const visible = group.sessions
      .filter((s) => !pinnedIds.has(s.id))
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    const expanded = options.expanded.has(key);
    const shown = expanded ? visible : visible.slice(0, limit);
    projects.push({
      key,
      name: projectName(group.path),
      path: group.path,
      count: group.sessions.length,
      sessions: shown.map((s) => toRow(s, now, "idle")),
      moreCount: expanded ? 0 : visible.length - shown.length,
      manual: manualOrder.includes(key),
    });
  }

  return { pinned, projects };
}
