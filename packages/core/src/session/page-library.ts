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
  deriveSessionArtifacts,
  deriveSessionPages,
  deriveSessionPanelPageSummaries,
  effectiveEvents,
  firstUserText,
  formatOpenArtifactOriginKey,
  formatPageOriginKey,
  type DurableEvent,
  type FileAttachment,
  type PageLibraryItem,
  type PageLibraryListResult,
  type PageLibraryProject,
  type PageLibraryProjectsResult,
  type PageOrigin,
  type SessionArtifact,
  type SessionPanelPageSummary,
} from "../protocol/index.js";
import { isSafeAttachmentFilename, readSessionAttachment } from "./attachment-read.js";
import { copyPageDataFile } from "./page-data.js";
import { assertSafeSessionId, readLogReadonly } from "./readonly-log.js";
import type { SessionStore, SessionSummary } from "./types.js";

const PAGES_CACHE_VERSION = 3;
const SCAN_CONCURRENCY = 8;

interface SessionPagesCacheFile {
  version: typeof PAGES_CACHE_VERSION;
  mtimeMs: number;
  size: number;
  pages: SessionPanelPageSummary[];
  artifacts: SessionArtifact[];
}

interface ScannedPageInstance {
  sessionId: string;
  sessionTitle: string;
  sessionArchived?: boolean | undefined;
  project: WorkspaceProjectIdentity;
  summary: SessionPanelPageSummary;
}

interface ScannedArtifactInstance {
  sessionId: string;
  sessionTitle: string;
  sessionArchived?: boolean | undefined;
  project: WorkspaceProjectIdentity;
  artifact: SessionArtifact;
}

interface ScannedSessionItems {
  pages: ScannedPageInstance[];
  artifacts: ScannedArtifactInstance[];
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
    isValidOrigin(v.origin) &&
    (v.hasUnresolvedComments === undefined || typeof v.hasUnresolvedComments === "boolean")
  );
}

function isValidArtifact(value: unknown): value is SessionArtifact {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.url === "string" &&
    v.url.trim() !== "" &&
    typeof v.id === "string" &&
    v.id.trim() !== "" &&
    typeof v.title === "string" &&
    typeof v.type === "string" &&
    typeof v.seq === "number" &&
    Number.isInteger(v.seq) &&
    typeof v.updatedAt === "string" &&
    (v.summary === undefined || typeof v.summary === "string")
  );
}

function parseCacheFile(
  raw: unknown,
  expectedMtimeMs: number,
  expectedSize: number,
): { pages: SessionPanelPageSummary[]; artifacts: SessionArtifact[] } | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const obj = raw as Record<string, unknown>;
  if (obj.version !== PAGES_CACHE_VERSION) return undefined;
  if (obj.mtimeMs !== expectedMtimeMs || obj.size !== expectedSize) return undefined;
  if (!Array.isArray(obj.pages) || !Array.isArray(obj.artifacts)) return undefined;
  if (!obj.pages.every(isValidSummary) || !obj.artifacts.every(isValidArtifact)) return undefined;
  return { pages: obj.pages, artifacts: obj.artifacts };
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

function compareArtifactsDesc(a: ScannedArtifactInstance, b: ScannedArtifactInstance): number {
  const ta = parseTimeMs(a.artifact.updatedAt);
  const tb = parseTimeMs(b.artifact.updatedAt);
  if (tb !== ta) return tb - ta;
  if (b.artifact.seq !== a.artifact.seq) return b.artifact.seq - a.artifact.seq;
  return a.sessionId < b.sessionId ? 1 : a.sessionId > b.sessionId ? -1 : 0;
}

function mergeInstancesToLibraryItems(
  instances: readonly ScannedPageInstance[],
  artifacts: readonly ScannedArtifactInstance[] = [],
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

  const pageItems: PageLibraryItem[] = [...byOrigin.entries()].map(
    ([originKey, { origin, best }]) => ({
      kind: "page" as const,
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
      ...(best.summary.hasUnresolvedComments ? { hasUnresolvedComments: true } : {}),
    }),
  );

  const byArtifactId = new Map<string, ScannedArtifactInstance>();
  for (const inst of artifacts) {
    const existing = byArtifactId.get(inst.artifact.id);
    if (existing === undefined || compareArtifactsDesc(inst, existing) < 0) {
      byArtifactId.set(inst.artifact.id, inst);
    }
  }

  const artifactItems: PageLibraryItem[] = [...byArtifactId.values()].map((best) => ({
    kind: "artifact" as const,
    ref: best.artifact.url,
    origin: { sessionId: best.sessionId, page: `artifact-${best.artifact.id}` },
    originKey: formatOpenArtifactOriginKey(best.artifact.id),
    sessionId: best.sessionId,
    sessionTitle: best.sessionTitle,
    ...(best.sessionArchived ? { sessionArchived: true } : {}),
    page: `artifact-${best.artifact.id}`,
    title: best.artifact.title,
    version: 1,
    file: "",
    updatedAt: best.artifact.updatedAt,
    projectKey: best.project.key,
    artifact: {
      url: best.artifact.url,
      id: best.artifact.id,
      type: best.artifact.type,
      ...(best.artifact.summary !== undefined ? { summary: best.artifact.summary } : {}),
    },
  }));

  const merged = [...pageItems, ...artifactItems];

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
    artifacts: SessionArtifact[],
  ): Promise<void> {
    const target = cachePath(id);
    const temp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
    const payload: SessionPagesCacheFile = {
      version: PAGES_CACHE_VERSION,
      mtimeMs,
      size,
      pages,
      artifacts,
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

  async function readSessionLibraryItems(summary: SessionSummary): Promise<{
    pages: SessionPanelPageSummary[];
    artifacts: SessionArtifact[];
    sessionTitle: string;
  }> {
    const openEvents = deps.getOpenSessionEvents?.(summary.id);
    if (openEvents !== undefined) {
      return {
        pages: deriveSessionPanelPageSummaries(openEvents),
        artifacts: deriveSessionArtifacts(openEvents),
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
        return { pages: [], artifacts: [], sessionTitle: summary.firstText ?? "" };
      }
      return { pages: [], artifacts: [], sessionTitle: summary.firstText ?? "" };
    }

    const sidecar = cachePath(summary.id);
    try {
      if (await fs.exists(sidecar)) {
        const parsed: unknown = JSON.parse(await fs.readTextFile(sidecar));
        const cached = parseCacheFile(parsed, stat.mtimeMs, stat.size);
        if (cached !== undefined) {
          return {
            pages: cached.pages,
            artifacts: cached.artifacts,
            sessionTitle: summary.firstText ?? "",
          };
        }
      }
    } catch {
      // 缓存损坏或被并发删改：回退重新派生
    }

    try {
      const readonly = await readLogReadonly(fs, file, summary.id);
      const pages = deriveSessionPanelPageSummaries(readonly.events);
      const artifacts = deriveSessionArtifacts(readonly.events);
      await writeCache(summary.id, stat.mtimeMs, stat.size, pages, artifacts);
      return { pages, artifacts, sessionTitle: summary.firstText ?? "" };
    } catch {
      // 单个坏日志不阻塞页面库
      return { pages: [], artifacts: [], sessionTitle: summary.firstText ?? "" };
    }
  }

  async function scanTopLevelSessions(filterProjectKey?: string): Promise<ScannedSessionItems> {
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
      if (filterProjectKey !== undefined && project.key !== filterProjectKey) {
        return { pages: [] as ScannedPageInstance[], artifacts: [] as ScannedArtifactInstance[] };
      }
      const { pages, artifacts, sessionTitle } = await readSessionLibraryItems(summary);
      return {
        pages: pages
          .filter((page) => isSafeAttachmentFilename(page.file))
          .map<ScannedPageInstance>((page) => ({
            sessionId: summary.id,
            sessionTitle,
            ...(summary.archivedAt !== undefined ? { sessionArchived: true } : {}),
            project,
            summary: page,
          })),
        artifacts: artifacts.map<ScannedArtifactInstance>((artifact) => ({
          sessionId: summary.id,
          sessionTitle,
          ...(summary.archivedAt !== undefined ? { sessionArchived: true } : {}),
          project,
          artifact,
        })),
      };
    });

    return {
      pages: resolved.flatMap((r) => r.pages),
      artifacts: resolved.flatMap((r) => r.artifacts),
    };
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
      const scanned = await scanTopLevelSessions(projectKey);
      return {
        projectKey,
        items: mergeInstancesToLibraryItems(scanned.pages, scanned.artifacts),
      };
    },

    async listPagesWithPaths(input) {
      const { items } = await this.listPages({ workspaceRoot: input.workspaceRoot });
      const realSessionsDir = await platform.resolveReal(sessionsDir);
      return items
        .filter((item) => item.kind !== "artifact" && item.file !== "")
        .map((item) => ({
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
      const scanned = await scanTopLevelSessions();
      const byProject = new Map<
        string,
        {
          identity: WorkspaceProjectIdentity;
          pages: ScannedPageInstance[];
          artifacts: ScannedArtifactInstance[];
        }
      >();
      const ensureBucket = (identity: WorkspaceProjectIdentity) => {
        let bucket = byProject.get(identity.key);
        if (bucket === undefined) {
          bucket = { identity, pages: [], artifacts: [] };
          byProject.set(identity.key, bucket);
        }
        return bucket;
      };
      for (const inst of scanned.pages) ensureBucket(inst.project).pages.push(inst);
      for (const inst of scanned.artifacts) ensureBucket(inst.project).artifacts.push(inst);

      const projects: PageLibraryProject[] = [];
      for (const { identity, pages, artifacts } of byProject.values()) {
        const merged = mergeInstancesToLibraryItems(pages, artifacts);
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
      const scanned = await scanTopLevelSessions(current.key);
      const realSessionsDir = await platform.resolveReal(sessionsDir);
      const files = new Set<string>();
      for (const inst of scanned.pages) {
        if (input.excludeSessionId !== undefined && inst.sessionId === input.excludeSessionId) {
          continue;
        }
        for (const file of inst.summary.files) {
          if (isSafeAttachmentFilename(file)) {
            files.add(paths.join(realSessionsDir, "attachments", inst.sessionId, file));
          }
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
      if (latest === undefined || !isSafeAttachmentFilename(latest.file.file)) return undefined;

      // 沿同项目血缘解析最终来源，确保跨多次续改/分叉后仍沿用最早来源
      const projectInstances = (await scanTopLevelSessions(currentProject.key)).pages;
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
