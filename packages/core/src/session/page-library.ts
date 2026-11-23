/**
 * 项目页面库（ADR-0114）：按共用项目键聚合顶层会话的面板页面、按来源去重取最近副本，
 * 并维护按日志 mtimeMs + size 校验的可重建旁路缓存 `<sessionsDir>/<id>.pages.json`。
 */
import { randomBytes } from "node:crypto";
import {
  fsErrorCode,
  resolveWorkspaceProject,
  type Platform,
  type WorkspaceProjectIdentity,
} from "../platform/index.js";
import {
  deriveSessionPages,
  deriveSessionPanelPageSummaries,
  effectiveEvents,
  firstUserText,
  formatPageOriginKey,
  type DurableEvent,
  type FileAttachment,
  type PageLibraryItem,
  type PageLibraryListResult,
  type PageLibraryProject,
  type PageLibraryProjectsResult,
  type PageOrigin,
  type SessionPanelPageSummary,
} from "../protocol/index.js";
import { readSessionAttachment } from "./attachment-read.js";
import { copyPageDataFile } from "./page-data.js";
import { assertSafeSessionId, readLogReadonly } from "./readonly-log.js";
import type { SessionStore, SessionSummary } from "./types.js";

const PAGES_CACHE_VERSION = 1;
const SCAN_CONCURRENCY = 8;

interface SessionPagesCacheFile {
  version: typeof PAGES_CACHE_VERSION;
  mtimeMs: number;
  size: number;
  pages: SessionPanelPageSummary[];
}

interface ScannedPageInstance {
  sessionId: string;
  sessionTitle: string;
  sessionArchived?: boolean | undefined;
  project: WorkspaceProjectIdentity;
  summary: SessionPanelPageSummary;
}

export interface PageLibraryDeps {
  platform: Platform;
  store: SessionStore;
  sessionsDir: string;
  nocturneHome: string;
  defaultWorkspaceRoot: string;
  /** 读取当前已打开会话的实时持久事件（未打开时返回 undefined） */
  getOpenSessionEvents?: ((sessionId: string) => readonly DurableEvent[] | undefined) | undefined;
}

export interface PageLibraryItemWithPath extends PageLibraryItem {
  /** 最新版本 HTML 文件的绝对路径（仅 Core 内部给 list_pages 工具使用，不经远程 RPC 返回） */
  path: string;
}

export interface ResolvedProjectPage {
  ref: string;
  sessionId: string;
  page: string;
  title: string;
  version: number;
  origin: PageOrigin;
  file: FileAttachment;
  path: string;
  readHtml(): Promise<Uint8Array | undefined>;
  copyPageDataTo(targetSessionId: string, targetPage: string): Promise<void>;
}

export interface PageLibrary {
  listPages(input?: {
    projectKey?: string | undefined;
    workspaceRoot?: string | undefined;
  }): Promise<PageLibraryListResult>;
  listPagesWithPaths(input: { workspaceRoot: string }): Promise<PageLibraryItemWithPath[]>;
  listProjects(input?: { workspaceRoot?: string | undefined }): Promise<PageLibraryProjectsResult>;
  listProjectPanelPageFiles(input: {
    workspaceRoot: string;
    excludeSessionId?: string | undefined;
  }): Promise<string[]>;
  resolveCrossSessionPage(input: {
    workspaceRoot: string;
    ref: string;
  }): Promise<ResolvedProjectPage | undefined>;
}

function isValidOrigin(value: unknown): value is PageOrigin {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { sessionId?: unknown }).sessionId === "string" &&
    (value as { sessionId: string }).sessionId.trim() !== "" &&
    typeof (value as { page?: unknown }).page === "string" &&
    (value as { page: string }).page.trim() !== ""
  );
}

function isValidSummary(value: unknown): value is SessionPanelPageSummary {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.page === "string" &&
    v.page.trim() !== "" &&
    typeof v.title === "string" &&
    v.title.trim() !== "" &&
    typeof v.version === "number" &&
    Number.isInteger(v.version) &&
    v.version >= 1 &&
    typeof v.file === "string" &&
    v.file.trim() !== "" &&
    Array.isArray(v.files) &&
    v.files.every((f) => typeof f === "string" && f.trim() !== "") &&
    typeof v.updatedAt === "string" &&
    isValidOrigin(v.origin)
  );
}

function parseCacheFile(
  raw: unknown,
  expectedMtimeMs: number,
  expectedSize: number,
): SessionPanelPageSummary[] | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const obj = raw as Record<string, unknown>;
  if (obj.version !== PAGES_CACHE_VERSION) return undefined;
  if (obj.mtimeMs !== expectedMtimeMs || obj.size !== expectedSize) return undefined;
  if (!Array.isArray(obj.pages)) return undefined;
  if (!obj.pages.every(isValidSummary)) return undefined;
  return obj.pages;
}

function deriveTitleFromEvents(events: readonly DurableEvent[]): string | undefined {
  let userTitle: string | undefined;
  let generatedTitle: string | undefined;
  let firstTitle: string | undefined;
  for (const event of events) {
    if (event.type === "session.titled") {
      if (event.payload.source === "user") userTitle = event.payload.title;
      else generatedTitle = event.payload.title;
    }
  }
  if (userTitle) return userTitle;
  if (generatedTitle) return generatedTitle;
  for (const event of effectiveEvents(events)) {
    if (event.type === "message.user" && event.payload.ensembleQuietReminder !== true) {
      firstTitle = firstUserText(event.payload);
      if (firstTitle) break;
    }
  }
  return firstTitle;
}

function parseTimeMs(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

/** 比较同一血缘的两个副本：按最新更新时间更晚者胜，其次版本号更大，再其次 sessionId 字典序更大 */
function compareInstancesDesc(a: ScannedPageInstance, b: ScannedPageInstance): number {
  const ta = parseTimeMs(a.summary.updatedAt);
  const tb = parseTimeMs(b.summary.updatedAt);
  if (tb !== ta) return tb - ta;
  if (b.summary.version !== a.summary.version) return b.summary.version - a.summary.version;
  if (a.sessionId !== b.sessionId) return a.sessionId < b.sessionId ? 1 : -1;
  return a.summary.page < b.summary.page ? 1 : a.summary.page > b.summary.page ? -1 : 0;
}

function isTopLevelLibrarySession(summary: SessionSummary): boolean {
  if (summary.parent !== undefined) return false;
  if (summary.suite !== undefined) return false;
  return true;
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const idx = next;
      next += 1;
      if (idx >= items.length) return;
      const item = items[idx];
      if (item !== undefined) {
        results[idx] = await fn(item);
      }
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * 解析血缘根：若某条记录的 origin 指向另一个也存在于当前集合里的副本，则沿链追溯到底（防环）。
 */
function resolveCanonicalOrigins(
  instances: readonly ScannedPageInstance[],
): Map<ScannedPageInstance, PageOrigin> {
  const byRef = new Map<string, PageOrigin>();
  for (const inst of instances) {
    byRef.set(`${inst.sessionId}/${inst.summary.page}`, inst.summary.origin);
  }
  const canonical = new Map<ScannedPageInstance, PageOrigin>();
  for (const inst of instances) {
    let cur = inst.summary.origin;
    const seen = new Set<string>([`${inst.sessionId}/${inst.summary.page}`]);
    for (;;) {
      const key = formatPageOriginKey(cur);
      if (seen.has(key)) break;
      seen.add(key);
      const parent = byRef.get(key);
      if (parent === undefined || formatPageOriginKey(parent) === key) break;
      cur = parent;
    }
    canonical.set(inst, cur);
  }
  return canonical;
}

function mergeInstancesToLibraryItems(
  instances: readonly ScannedPageInstance[],
): PageLibraryItem[] {
  const canonicalOrigins = resolveCanonicalOrigins(instances);
  const byOrigin = new Map<string, { origin: PageOrigin; best: ScannedPageInstance }>();

  for (const inst of instances) {
    const origin = canonicalOrigins.get(inst) ?? inst.summary.origin;
    const originKey = formatPageOriginKey(origin);
    const existing = byOrigin.get(originKey);
    if (existing === undefined || compareInstancesDesc(inst, existing.best) < 0) {
      byOrigin.set(originKey, { origin, best: inst });
    }
  }

  const merged = [...byOrigin.entries()].map(([originKey, { origin, best }]) => ({
    ref: `${best.sessionId}/${best.summary.page}`,
    origin,
    originKey,
    sessionId: best.sessionId,
    sessionTitle: best.sessionTitle,
    ...(best.sessionArchived ? { sessionArchived: true } : {}),
    page: best.summary.page,
    title: best.summary.title,
    version: best.summary.version,
    file: best.summary.file,
    updatedAt: best.summary.updatedAt,
    projectKey: best.project.key,
  }));

  merged.sort((a, b) => {
    const ta = parseTimeMs(a.updatedAt);
    const tb = parseTimeMs(b.updatedAt);
    if (tb !== ta) return tb - ta;
    if (b.version !== a.version) return b.version - a.version;
    return a.ref < b.ref ? 1 : a.ref > b.ref ? -1 : 0;
  });

  return merged;
}

export function createPageLibrary(deps: PageLibraryDeps): PageLibrary {
  const { platform, store, sessionsDir, nocturneHome, defaultWorkspaceRoot } = deps;
  const { fs, paths } = platform;

  function logPath(id: string): string {
    return paths.join(sessionsDir, `${id}.jsonl`);
  }

  function cachePath(id: string): string {
    return paths.join(sessionsDir, `${id}.pages.json`);
  }

  async function writeCache(
    id: string,
    mtimeMs: number,
    size: number,
    pages: SessionPanelPageSummary[],
  ): Promise<void> {
    const target = cachePath(id);
    const temp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
    const payload: SessionPagesCacheFile = {
      version: PAGES_CACHE_VERSION,
      mtimeMs,
      size,
      pages,
    };
    try {
      await fs.writeFile(temp, JSON.stringify(payload));
      await fs.rename(temp, target);
    } catch {
      // 缓存只是旁路加速，写盘失败不影响查询结果
    } finally {
      await fs.unlink(temp).catch(() => undefined);
    }
  }

  async function readSessionPanelPages(
    summary: SessionSummary,
  ): Promise<{ pages: SessionPanelPageSummary[]; sessionTitle: string }> {
    const openEvents = deps.getOpenSessionEvents?.(summary.id);
    if (openEvents !== undefined) {
      return {
        pages: deriveSessionPanelPageSummaries(openEvents),
        sessionTitle: deriveTitleFromEvents(openEvents) ?? summary.firstText ?? "",
      };
    }

    const file = logPath(summary.id);
    let stat: { mtimeMs: number; size: number };
    try {
      const s = await fs.stat(file);
      stat = { mtimeMs: s.mtimeMs, size: s.size };
    } catch (error) {
      if (fsErrorCode(error) === "ENOENT") {
        return { pages: [], sessionTitle: summary.firstText ?? "" };
      }
      return { pages: [], sessionTitle: summary.firstText ?? "" };
    }

    const sidecar = cachePath(summary.id);
    try {
      if (await fs.exists(sidecar)) {
        const parsed: unknown = JSON.parse(await fs.readTextFile(sidecar));
        const cached = parseCacheFile(parsed, stat.mtimeMs, stat.size);
        if (cached !== undefined) {
          return { pages: cached, sessionTitle: summary.firstText ?? "" };
        }
      }
    } catch {
      // 缓存损坏或被并发删改：回退重新派生
    }

    try {
      const readonly = await readLogReadonly(fs, file, summary.id);
      const pages = deriveSessionPanelPageSummaries(readonly.events);
      await writeCache(summary.id, stat.mtimeMs, stat.size, pages);
      return { pages, sessionTitle: summary.firstText ?? "" };
    } catch {
      // 单个坏日志不阻塞页面库
      return { pages: [], sessionTitle: summary.firstText ?? "" };
    }
  }

  async function scanTopLevelSessions(filterProjectKey?: string): Promise<ScannedPageInstance[]> {
    const summaries = (await store.list({ includeArchived: true })).filter(
      isTopLevelLibrarySession,
    );
    const projectMemo = new Map<string, Promise<WorkspaceProjectIdentity>>();
    const resolveProjectCached = (ws: string): Promise<WorkspaceProjectIdentity> => {
      let cached = projectMemo.get(ws);
      if (cached === undefined) {
        cached = resolveWorkspaceProject(platform, nocturneHome, ws);
        projectMemo.set(ws, cached);
      }
      return cached;
    };

    const resolved = await mapWithConcurrency(summaries, SCAN_CONCURRENCY, async (summary) => {
      const project = await resolveProjectCached(summary.workspaceRoot);
      if (filterProjectKey !== undefined && project.key !== filterProjectKey) return [];
      const { pages, sessionTitle } = await readSessionPanelPages(summary);
      if (pages.length === 0) return [];
      return pages.map<ScannedPageInstance>((page) => ({
        sessionId: summary.id,
        sessionTitle,
        ...(summary.archivedAt !== undefined ? { sessionArchived: true } : {}),
        project,
        summary: page,
      }));
    });

    return resolved.flat();
  }

  async function targetProjectKey(input?: {
    projectKey?: string | undefined;
    workspaceRoot?: string | undefined;
  }): Promise<string> {
    if (input?.projectKey !== undefined && input.projectKey.trim() !== "") {
      return input.projectKey.trim();
    }
    const ws = input?.workspaceRoot ?? defaultWorkspaceRoot;
    const project = await resolveWorkspaceProject(platform, nocturneHome, ws);
    return project.key;
  }

  return {
    async listPages(input) {
      const projectKey = await targetProjectKey(input);
      const instances = await scanTopLevelSessions(projectKey);
      return {
        projectKey,
        items: mergeInstancesToLibraryItems(instances),
      };
    },

    async listPagesWithPaths(input) {
      const { items } = await this.listPages({ workspaceRoot: input.workspaceRoot });
      const realSessionsDir = await platform.resolveReal(sessionsDir);
      return items.map((item) => ({
        ...item,
        path: paths.join(realSessionsDir, "attachments", item.sessionId, item.file),
      }));
    },

    async listProjects(input) {
      const current = await resolveWorkspaceProject(
        platform,
        nocturneHome,
        input?.workspaceRoot ?? defaultWorkspaceRoot,
      );
      const instances = await scanTopLevelSessions();
      const byProject = new Map<
        string,
        { identity: WorkspaceProjectIdentity; instances: ScannedPageInstance[] }
      >();
      for (const inst of instances) {
        let bucket = byProject.get(inst.project.key);
        if (bucket === undefined) {
          bucket = { identity: inst.project, instances: [] };
          byProject.set(inst.project.key, bucket);
        }
        bucket.instances.push(inst);
      }

      const projects: PageLibraryProject[] = [];
      for (const { identity, instances: projectInstances } of byProject.values()) {
        const merged = mergeInstancesToLibraryItems(projectInstances);
        if (merged.length === 0) continue;
        projects.push({
          key: identity.key,
          name: identity.name,
          isDefault: identity.isDefault,
          pageCount: merged.length,
          updatedAt: merged[0]?.updatedAt ?? "",
        });
      }

      projects.sort((a, b) => parseTimeMs(b.updatedAt) - parseTimeMs(a.updatedAt));

      return {
        currentProjectKey: current.key,
        currentProjectName: current.name,
        currentProjectIsDefault: current.isDefault,
        projects,
      };
    },

    async listProjectPanelPageFiles(input) {
      const current = await resolveWorkspaceProject(platform, nocturneHome, input.workspaceRoot);
      const instances = await scanTopLevelSessions(current.key);
      const realSessionsDir = await platform.resolveReal(sessionsDir);
      const files = new Set<string>();
      for (const inst of instances) {
        if (input.excludeSessionId !== undefined && inst.sessionId === input.excludeSessionId) {
          continue;
        }
        for (const file of inst.summary.files) {
          files.add(paths.join(realSessionsDir, "attachments", inst.sessionId, file));
        }
      }
      return [...files];
    },

    async resolveCrossSessionPage(input) {
      const parts = input.ref.trim().split("/");
      if (parts.length !== 2) return undefined;
      const [targetSessionId, targetPageId] = parts;
      if (!targetSessionId || !targetPageId) return undefined;
      try {
        assertSafeSessionId(targetSessionId);
      } catch {
        return undefined;
      }

      const currentProject = await resolveWorkspaceProject(
        platform,
        nocturneHome,
        input.workspaceRoot,
      );

      let events: readonly DurableEvent[];
      const openEvents = deps.getOpenSessionEvents?.(targetSessionId);
      if (openEvents !== undefined) {
        events = openEvents;
      } else {
        try {
          events = (await readLogReadonly(fs, logPath(targetSessionId), targetSessionId)).events;
        } catch {
          return undefined;
        }
      }

      const head = events[0];
      if (head?.type !== "session.created") return undefined;
      if (head.payload.parent !== undefined || head.payload.suite !== undefined) return undefined;

      const targetProject = await resolveWorkspaceProject(
        platform,
        nocturneHome,
        head.payload.workspaceRoot,
      );
      if (targetProject.key !== currentProject.key) return undefined;

      const pages = deriveSessionPages(events);
      const targetPage = pages.find((p) => p.page === targetPageId && p.display === "panel");
      if (targetPage === undefined) return undefined;
      const latest = targetPage.versions.at(-1);
      if (latest === undefined) return undefined;

      // 沿同项目血缘解析最终来源，确保跨多次续改/分叉后仍沿用最早来源
      const projectInstances = await scanTopLevelSessions(currentProject.key);
      const canonicalOrigins = resolveCanonicalOrigins(projectInstances);
      const matchedInstance = projectInstances.find(
        (inst) => inst.sessionId === targetSessionId && inst.summary.page === targetPageId,
      );
      const origin: PageOrigin = (matchedInstance !== undefined
        ? canonicalOrigins.get(matchedInstance)
        : undefined) ??
        targetPage.origin ?? { sessionId: targetSessionId, page: targetPageId };

      const realSessionsDir = await platform.resolveReal(sessionsDir);
      const htmlPath = paths.join(
        realSessionsDir,
        "attachments",
        targetSessionId,
        latest.file.file,
      );

      return {
        ref: `${targetSessionId}/${targetPageId}`,
        sessionId: targetSessionId,
        page: targetPageId,
        title: targetPage.title,
        version: latest.version,
        origin,
        file: latest.file,
        path: htmlPath,
        async readHtml() {
          try {
            const loaded = await readSessionAttachment(
              platform,
              sessionsDir,
              targetSessionId,
              events,
              latest.file.file,
            );
            return loaded.data;
          } catch {
            return undefined;
          }
        },
        async copyPageDataTo(targetSessionIdDest: string, targetPageDest: string) {
          await copyPageDataFile(
            platform,
            sessionsDir,
            targetSessionId,
            targetPageId,
            targetSessionIdDest,
            targetPageDest,
          );
        },
      };
    },
  };
}
