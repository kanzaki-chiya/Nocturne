/**
 * 手机首页与项目页的分组：复用桌面侧栏的 session-tree 纯函数，不另写归并规则。
 * 置顶存在桌面前端本地，手机读不到，所以不传置顶；项目按最近活动排序。
 */
import {
  buildSessionTree,
  formatRelative,
  projectKey,
  projectName,
  type SessionRow,
  type SessionStatus,
  type SessionSummary,
} from "../session-tree";

export interface PhoneProject {
  key: string;
  name: string;
  path: string;
  count: number;
  /** 最近活动时间（列表右侧日期）；没有会话时缺省 */
  latest?: number;
  plain: boolean;
}

/** 普通对话工作区：与桌面外壳一致，是 `<NOCTURNE_HOME>/workspace`，由会话目录推导 */
export function plainWorkspaceOf(sessionsDir: string | undefined): string | undefined {
  if (sessionsDir === undefined) return undefined;
  const trimmed = sessionsDir.replace(/[\\/]+$/, "");
  const at = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  if (at <= 0) return undefined;
  const separator = trimmed.charAt(at);
  return `${trimmed.slice(0, at)}${separator}workspace`;
}

const EMPTY_PREFS = { pinned: [], projects: [], hidden: [], projectSort: "activity" } as const;

function latestOf(sessions: SessionSummary[], key: string): number | undefined {
  let latest: number | undefined;
  for (const s of sessions)
    if (!s.parent && projectKey(s.cwd) === key) latest = Math.max(latest ?? 0, s.mtimeMs);
  return latest;
}

/** 首页列表：第一项普通对话，其余项目按最近活动排序 */
export function phoneProjects(
  sessions: SessionSummary[],
  plainWorkspace: string | undefined,
): PhoneProject[] {
  const tree = buildSessionTree(sessions, EMPTY_PREFS, {
    plainWorkspace: plainWorkspace ?? null,
    expanded: new Set(),
    collapsed: new Set(),
    chatsExpanded: true,
  });
  const result: PhoneProject[] = [];
  if (plainWorkspace !== undefined) {
    const key = projectKey(plainWorkspace);
    const latest = latestOf(sessions, key);
    result.push({
      key,
      name: "普通对话",
      path: plainWorkspace,
      count: tree.chats.rows.length,
      plain: true,
      ...(latest !== undefined ? { latest } : {}),
    });
  }
  for (const project of tree.projects) {
    const latest = latestOf(sessions, project.key);
    result.push({
      key: project.key,
      name: project.name,
      path: project.path,
      count: project.count,
      plain: false,
      ...(latest !== undefined ? { latest } : {}),
    });
  }
  return result;
}

/** 项目页的会话列表（全部展开，按最近活动） */
export function projectSessions(
  sessions: SessionSummary[],
  path: string,
  plainWorkspace: string | undefined,
  statuses: Readonly<Record<string, SessionStatus>> = {},
): SessionRow[] {
  const key = projectKey(path);
  const plain = plainWorkspace !== undefined && projectKey(plainWorkspace) === key;
  const tree = buildSessionTree(sessions, EMPTY_PREFS, {
    plainWorkspace: plain ? plainWorkspace : null,
    expanded: new Set([key]),
    collapsed: new Set(),
    chatsExpanded: true,
    statuses,
  });
  if (plain) return tree.chats.rows;
  return tree.projects.find((project) => project.key === key)?.sessions ?? [];
}

/** 列表日期：今天显示相对时间，更早显示 MM-DD（跨年带年份） */
export function shortDate(ms: number, now = Date.now()): string {
  const relative = formatRelative(ms, now);
  if (!/\d{4}-/.test(relative) && now - ms < 86_400_000) return relative;
  const d = new Date(ms);
  const md = `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return d.getFullYear() === new Date(now).getFullYear() ? md : `${d.getFullYear()}-${md}`;
}

export { projectName };
