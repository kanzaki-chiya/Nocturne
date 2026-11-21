/**
 * 页面与版本派生（ADR-0109）：从有效工具结果附件投影会话页面列表。
 * 纯函数、无 I/O；不按工具名硬编码，沿用「带有效 inline 标记的成功工具结果」规则。
 */
import type { DurableEvent } from "./events.js";
import { effectiveEvents } from "./rewind.js";
import type { FileAttachment, InlinePageDisplay } from "./types.js";

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
  versions: SessionPageVersion[];
}

const NEW_PAGE_ID_RE = /^page-(\d+)$/;

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

/** 将一条成功工具结果中的有效 inline 附件归约进 pages（原地更新） */
export function appendSessionPageFromFile(
  pages: SessionPage[],
  file: FileAttachment,
  seq: number,
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
    pages.push({
      page: pageId,
      title,
      display: resolveInlinePageDisplay(file),
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
  // 更新时沿用第一版的显示方式
  existing.versions.push({ version, file, title, seq });
}

/** 从持久事件流按有效事件派生会话页面列表 */
export function deriveSessionPages(events: readonly DurableEvent[]): SessionPage[] {
  const pages: SessionPage[] = [];
  for (const event of effectiveEvents(events)) {
    if (event.type !== "tool.completed" || event.payload.status !== "ok") continue;
    for (const file of filterInlinePageFiles(event.payload.files)) {
      appendSessionPageFromFile(pages, file, event.seq);
    }
  }
  return pages;
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
