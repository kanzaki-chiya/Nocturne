import { projectKey, type TreeSessionSummary } from "./session-tree";

export const SESSIONS_CACHE_KEY = "nocturne.desktop.sessionsCache.v1";
type CachedSession = Omit<TreeSessionSummary, "locked" | "openHere">;
interface CacheHost {
  sessionPaths?: { sessionsDir: string; plainWorkspace: string } | undefined;
  note: (line: string) => void;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** 显式投影白名单，同时校验磁盘中的旧数据；不接受锁、打开状态或通知留痕。 */
function summary(value: unknown): CachedSession | undefined {
  const v = object(value);
  if (
    v === undefined ||
    typeof v.id !== "string" ||
    v.id === "" ||
    typeof v.createdAt !== "string" ||
    !Number.isFinite(Date.parse(v.createdAt)) ||
    typeof v.cwd !== "string" ||
    typeof v.mtimeMs !== "number" ||
    !Number.isFinite(v.mtimeMs) ||
    (v.lastUserMs !== undefined &&
      (typeof v.lastUserMs !== "number" || !Number.isFinite(v.lastUserMs) || v.lastUserMs < 0)) ||
    (v.firstText !== undefined && typeof v.firstText !== "string") ||
    (v.archivedAt !== undefined &&
      (typeof v.archivedAt !== "string" || !Number.isFinite(Date.parse(v.archivedAt))))
  )
    return undefined;
  const result: CachedSession = {
    id: v.id,
    createdAt: v.createdAt,
    cwd: v.cwd,
    mtimeMs: v.mtimeMs,
    ...(typeof v.lastUserMs === "number" ? { lastUserMs: v.lastUserMs } : {}),
    ...(typeof v.firstText === "string" ? { firstText: v.firstText } : {}),
    ...(typeof v.archivedAt === "string" ? { archivedAt: v.archivedAt } : {}),
  };
  if (v.schedule !== undefined) {
    const s = object(v.schedule);
    if (
      s === undefined ||
      typeof s.taskId !== "string" ||
      typeof s.scheduledAt !== "string" ||
      !Number.isFinite(Date.parse(s.scheduledAt)) ||
      (s.trigger !== "schedule" && s.trigger !== "catchup" && s.trigger !== "manual")
    )
      return undefined;
    result.schedule = { taskId: s.taskId, scheduledAt: s.scheduledAt, trigger: s.trigger };
  }
  if (v.client !== undefined) {
    const c = object(v.client);
    if (
      c?.kind !== "agent" ||
      typeof c.name !== "string" ||
      typeof c.deviceId !== "string" ||
      (c.id !== undefined && typeof c.id !== "string")
    )
      return undefined;
    result.client = {
      kind: "agent",
      name: c.name,
      deviceId: c.deviceId,
      ...(typeof c.id === "string" ? { id: c.id } : {}),
    };
  }
  return result;
}

/** storage 用取值函数：浏览器连 localStorage 属性本身都可能拒绝访问。 */
export function readSessionsCache(
  storage: () => Storage,
  host: CacheHost,
): CachedSession[] | undefined {
  if (host.sessionPaths === undefined) return undefined;
  try {
    const raw = storage().getItem(SESSIONS_CACHE_KEY);
    if (raw === null) return undefined;
    const cache = object(JSON.parse(raw));
    if (
      cache?.version !== 1 ||
      typeof cache.sessionsDir !== "string" ||
      projectKey(cache.sessionsDir) !== projectKey(host.sessionPaths.sessionsDir) ||
      !Array.isArray(cache.sessions)
    )
      throw new Error("invalid_cache");
    const rows = cache.sessions.map(summary);
    if (rows.some((row) => row === undefined)) throw new Error("invalid_summary");
    const sessions = rows as CachedSession[];
    if (new Set(sessions.map((row) => row.id)).size !== sessions.length)
      throw new Error("duplicate_id");
    return sessions;
  } catch {
    host.note("[sessions-cache] 忽略不可用的会话列表缓存");
    return undefined;
  }
}

export function writeSessionsCache(
  storage: () => Storage,
  host: CacheHost,
  sessions: readonly TreeSessionSummary[],
): void {
  if (host.sessionPaths === undefined) return;
  try {
    const rows = sessions.map(summary);
    if (rows.some((row) => row === undefined)) throw new Error("invalid_summary");
    storage().setItem(
      SESSIONS_CACHE_KEY,
      JSON.stringify({ version: 1, sessionsDir: host.sessionPaths.sessionsDir, sessions: rows }),
    );
  } catch {
    host.note("[sessions-cache] 无法保存会话列表缓存");
  }
}
