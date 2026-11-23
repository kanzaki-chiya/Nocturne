/**
 * 页面与版本派生（ADR-0109、ADR-0114）：从有效工具结果附件投影会话页面列表与来源。
 * 纯函数、无 I/O；不按工具名硬编码，沿用「带有效 inline 标记的成功工具结果」规则。
 */
import type { DurableEvent } from "./events.js";
import { effectiveEvents } from "./rewind.js";
import type { FileAttachment, InlinePageDisplay } from "./types.js";

/** 默认工作区（普通对话）在页面库里的项目键 */
export const DEFAULT_PAGE_PROJECT_KEY = "default";

/** 页面来源（血缘根，ADR-0114 §3）：最早创建该页面的会话与页面 id */
export interface PageOrigin {
  sessionId: string;
  page: string;
}

export interface SessionPageVersion {
  version: number;
  file: FileAttachment;
  title: string;
  seq: number;
}

export interface SessionPage {
  page: string;
  title: string;
  display: InlinePageDisplay;
  /** 页面血缘来源（ADR-0114 §3）；经事件流派生时始终有值 */
  origin?: PageOrigin | undefined;
  versions: SessionPageVersion[];
}

export interface PageAppendContext {
  /** 当前会话 id（来自 session.created.sessionId） */
  sessionId?: string | undefined;
  /** 产生该工具结果事件自身的 sessionId（分叉复制事件保留源会话 id） */
  eventSessionId?: string | undefined;
  /** 当前会话的 forkedFrom（来自 session.created.payload.forkedFrom） */
  forkedFrom?: { sessionId: string; seq: number } | undefined;
}

/** 单个会话里派生出的面板页面摘要（页面库聚合与旁路缓存用，ADR-0114 §2） */
export interface SessionPanelPageSummary {
  page: string;
  title: string;
  version: number;
  file: string;
  /** 该面板页面全部有效版本的 HTML 附件文件名（供权限层只读放行规则使用） */
  files: string[];
  updatedAt: string;
  origin: PageOrigin;
}

/** 页面库中的项目条目（ADR-0114 §4；不含本机绝对路径，可安全经远程 RPC 返回） */
export interface PageLibraryProject {
  key: string;
  name: string;
  isDefault: boolean;
  pageCount: number;
  updatedAt: string;
}

/** 页面库中的页面条目（按来源去重后的最近副本，ADR-0114 §3–4；不含本机绝对路径） */
export interface PageLibraryItem {
  /** 最近副本的引用：`<sessionId>/<page>` */
  ref: string;
  origin: PageOrigin;
  /** 来源稳定键：`${origin.sessionId}/${origin.page}`，供去重与置顶存储使用 */
  originKey: string;
  sessionId: string;
  sessionTitle: string;
  sessionArchived?: boolean | undefined;
  page: string;
  title: string;
  version: number;
  file: string;
  updatedAt: string;
  projectKey: string;
}

export interface PageLibraryListResult {
  projectKey: string;
  items: PageLibraryItem[];
}

export interface PageLibraryProjectsResult {
  currentProjectKey: string;
  currentProjectName: string;
  currentProjectIsDefault: boolean;
  projects: PageLibraryProject[];
}

const NEW_PAGE_ID_RE = /^page-(\d+)$/;

/** 页面引用或来源的规范键 `<sessionId>/<page>` */
export function formatPageOriginKey(origin: PageOrigin): string {
  return `${origin.sessionId}/${origin.page}`;
}

/**
 * 旧会话（inline 不带 page 字段）的兼容页面 id：与 `page-<n>` 永不冲突。
 */
export function legacyInlinePageId(file: string): string {
  return `legacy-${file}`;
}

/** 从附件派生所属页面 id（新页面用 inline.page，旧页面用 legacy-<file>） */
export function resolveInlinePageId(file: Pick<FileAttachment, "file" | "inline">): string {
  const explicit = file.inline?.page?.trim();
  return explicit !== undefined && explicit !== "" ? explicit : legacyInlinePageId(file.file);
}

/** 从附件派生显示方式：旧页面（无 page）固定 inline；新页面缺省 inline */
export function resolveInlinePageDisplay(file: Pick<FileAttachment, "inline">): InlinePageDisplay {
  if (file.inline?.page === undefined || file.inline.page.trim() === "") return "inline";
  return file.inline.display === "panel" ? "panel" : "inline";
}

/** 返回附件列表中带有效 inline 标记的文件 */
export function filterInlinePageFiles(
  files: readonly FileAttachment[] | undefined,
): FileAttachment[] {
  if (files === undefined || files.length === 0) return [];
  return files.filter((f) => typeof f.inline?.title === "string" && f.inline.title.trim() !== "");
}

/**
 * 计算页面首个有效版本的来源（ADR-0114 §3）：
 * 1. 跨会话接着改（inline.from）：沿用 from 指定的来源；
 * 2. 分叉继承：分叉保留了源事件 sessionId（或 seq <= forkedFrom.seq），沿用源会话与同 page id；
 * 3. 本会话新建：来源为当前会话与当前 page id。
 */
export function resolvePageOrigin(
  file: Pick<FileAttachment, "file" | "inline">,
  pageId: string,
  seq: number,
  context?: PageAppendContext,
): PageOrigin | undefined {
  const fromSession = file.inline?.from?.session.trim();
  const fromPage = file.inline?.from?.page.trim();
  if (fromSession && fromPage) {
    return { sessionId: fromSession, page: fromPage };
  }
  const eventSession = context?.eventSessionId?.trim();
  const currentSession = context?.sessionId?.trim();
  if (eventSession && currentSession && eventSession !== currentSession) {
    return { sessionId: eventSession, page: pageId };
  }
  if (context?.forkedFrom !== undefined && seq <= context.forkedFrom.seq) {
    return { sessionId: context.forkedFrom.sessionId, page: pageId };
  }
  const owner =
    currentSession !== undefined && currentSession !== "" ? currentSession : eventSession;
  if (!owner) return undefined;
  return { sessionId: owner, page: pageId };
}

/** 将一条成功工具结果中的有效 inline 附件归约进 pages（原地更新） */
export function appendSessionPageFromFile(
  pages: SessionPage[],
  file: FileAttachment,
  seq: number,
  context?: PageAppendContext,
): void {
  const rawTitle = file.inline?.title;
  if (typeof rawTitle !== "string" || rawTitle.trim() === "") return;
  const title = rawTitle.trim();
  const pageId = resolveInlinePageId(file);
  const existing = pages.find((p) => p.page === pageId);
  if (existing === undefined) {
    const version =
      typeof file.inline?.version === "number" &&
      Number.isInteger(file.inline.version) &&
      file.inline.version >= 1
        ? file.inline.version
        : 1;
    const origin = resolvePageOrigin(file, pageId, seq, context);
    pages.push({
      page: pageId,
      title,
      display: resolveInlinePageDisplay(file),
      ...(origin !== undefined ? { origin } : {}),
      versions: [{ version, file, title, seq }],
    });
    return;
  }
  const version =
    typeof file.inline?.version === "number" &&
    Number.isInteger(file.inline.version) &&
    file.inline.version >= 1
      ? file.inline.version
      : existing.versions.length + 1;
  existing.title = title;
  existing.versions.push({ version, file, title, seq });
}

/** 从持久事件流按有效事件派生会话页面列表 */
export function deriveSessionPages(events: readonly DurableEvent[]): SessionPage[] {
  const pages: SessionPage[] = [];
  const created = events[0];
  const sessionId = created?.type === "session.created" ? created.sessionId : undefined;
  const forkedFrom = created?.type === "session.created" ? created.payload.forkedFrom : undefined;
  for (const event of effectiveEvents(events)) {
    if (event.type !== "tool.completed" || event.payload.status !== "ok") continue;
    for (const file of filterInlinePageFiles(event.payload.files)) {
      appendSessionPageFromFile(pages, file, event.seq, {
        sessionId: sessionId ?? event.sessionId,
        eventSessionId: event.sessionId,
        forkedFrom,
      });
    }
  }
  return pages;
}

/**
 * 从持久事件流派生该会话的全部有效面板页面摘要（含最新更新时间与全部版本文件名）。
 * 供项目页面库查询与旁路缓存使用（ADR-0114 §2）。
 */
export function deriveSessionPanelPageSummaries(
  events: readonly DurableEvent[],
): SessionPanelPageSummary[] {
  const pages: SessionPage[] = [];
  const updatedByPage = new Map<string, string>();
  const created = events[0];
  const sessionId = created?.type === "session.created" ? created.sessionId : undefined;
  const forkedFrom = created?.type === "session.created" ? created.payload.forkedFrom : undefined;
  for (const event of effectiveEvents(events)) {
    if (event.type !== "tool.completed" || event.payload.status !== "ok") continue;
    for (const file of filterInlinePageFiles(event.payload.files)) {
      const pageId = resolveInlinePageId(file);
      appendSessionPageFromFile(pages, file, event.seq, {
        sessionId: sessionId ?? event.sessionId,
        eventSessionId: event.sessionId,
        forkedFrom,
      });
      updatedByPage.set(pageId, event.time);
    }
  }
  const result: SessionPanelPageSummary[] = [];
  for (const page of pages) {
    if (page.display !== "panel") continue;
    const latest = page.versions.at(-1);
    if (latest === undefined) continue;
    const origin = page.origin ?? { sessionId: sessionId ?? "", page: page.page };
    if (!origin.sessionId) continue;
    result.push({
      page: page.page,
      title: page.title,
      version: latest.version,
      file: latest.file.file,
      files: page.versions.map((v) => v.file.file),
      updatedAt: updatedByPage.get(page.page) ?? created?.time ?? "",
      origin,
    });
  }
  return result;
}

/** 分配下一个新建页面 id（`page-<n>`，按有效历史顺序从 1 递增） */
export function nextSessionPageId(
  pages: readonly SessionPage[],
  extraAllocated?: ReadonlySet<string>,
): string {
  let max = 0;
  for (const p of pages) {
    const m = NEW_PAGE_ID_RE.exec(p.page);
    if (m !== null) max = Math.max(max, Number(m[1]));
  }
  if (extraAllocated !== undefined) {
    for (const id of extraAllocated) {
      const m = NEW_PAGE_ID_RE.exec(id);
      if (m !== null) max = Math.max(max, Number(m[1]));
    }
  }
  return `page-${max + 1}`;
}
