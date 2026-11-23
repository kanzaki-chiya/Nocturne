import type {
  PageCommentScreenshotInput,
  PageCommentsInput,
  PageCommentsSnapshot,
} from "@nocturne/core/protocol";

export interface DraftPageComment {
  id: string;
  path: string;
  text: string;
  x: number;
  y: number;
  note: string;
  screenshot?: PageCommentScreenshotInput | undefined;
}

export interface DraftPageCommentGroup {
  page: string;
  version: number;
  title: string;
  comments: DraftPageComment[];
}

export interface CaptureRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 无可见文字元素点击处周围局部截图的 CSS 像素边长（2× 导出即至多 480×480 px） */
export const COMMENT_CAPTURE_SIZE = 240;

export function commentCaptureRegion(x: number, y: number): CaptureRegion {
  const half = Math.floor(COMMENT_CAPTURE_SIZE / 2);
  return {
    x: Math.max(0, Math.round(x) - half),
    y: Math.max(0, Math.round(y) - half),
    width: COMMENT_CAPTURE_SIZE,
    height: COMMENT_CAPTURE_SIZE,
  };
}

export function findDraftPageCommentGroup(
  groups: readonly DraftPageCommentGroup[],
  page: string,
  version: number,
): DraftPageCommentGroup | undefined {
  return groups.find((g) => g.page === page && g.version === version);
}

export function addDraftPageComment(
  groups: readonly DraftPageCommentGroup[],
  meta: { page: string; version: number; title: string },
  item: DraftPageComment,
): DraftPageCommentGroup[] {
  const idx = groups.findIndex((g) => g.page === meta.page && g.version === meta.version);
  if (idx === -1) {
    return [...groups, { ...meta, comments: [item] }];
  }
  return groups.map((g, i) =>
    i === idx ? { ...g, title: meta.title, comments: [...g.comments, item] } : g,
  );
}

export function updateDraftPageComment(
  groups: readonly DraftPageCommentGroup[],
  page: string,
  version: number,
  id: string,
  note: string,
): DraftPageCommentGroup[] {
  return groups.map((g) =>
    g.page === page && g.version === version
      ? {
          ...g,
          comments: g.comments.map((c) => (c.id === id ? { ...c, note } : c)),
        }
      : g,
  );
}

export function removeDraftPageComment(
  groups: readonly DraftPageCommentGroup[],
  page: string,
  version: number,
  id: string,
): DraftPageCommentGroup[] {
  const next: DraftPageCommentGroup[] = [];
  for (const g of groups) {
    if (g.page !== page || g.version !== version) {
      next.push(g);
      continue;
    }
    const rest = g.comments.filter((c) => c.id !== id);
    if (rest.length > 0) next.push({ ...g, comments: rest });
  }
  return next;
}

export function removeDraftPageCommentGroup(
  groups: readonly DraftPageCommentGroup[],
  page: string,
  version: number,
): DraftPageCommentGroup[] {
  return groups.filter((g) => !(g.page === page && g.version === version));
}

export function removeDraftPageCommentsByPage(
  groups: readonly DraftPageCommentGroup[],
  page: string,
): DraftPageCommentGroup[] {
  return groups.filter((g) => g.page !== page);
}

export function toPageCommentsInput(group: DraftPageCommentGroup): PageCommentsInput {
  return {
    page: group.page,
    version: group.version,
    title: group.title,
    comments: group.comments.map((c) => ({
      path: c.path,
      text: c.text,
      x: c.x,
      y: c.y,
      note: c.note,
      ...(c.screenshot !== undefined ? { screenshot: c.screenshot } : {}),
    })),
  };
}

export function toPageCommentsSnapshot(input: PageCommentsInput): PageCommentsSnapshot {
  return {
    page: input.page,
    version: input.version,
    title: input.title,
    comments: input.comments.map((c) =>
      c.replyTo !== undefined
        ? { replyTo: c.replyTo, note: c.note }
        : { path: c.path, text: c.text, x: c.x, y: c.y, note: c.note },
    ),
  };
}

/** 将评论弹窗定位在点击点下方/右侧并夹紧在容器可视范围内 */
export function clampCommentPopoverPosition(
  viewportX: number,
  viewportY: number,
  containerWidth: number,
  containerHeight: number,
  popoverWidth = 264,
  popoverHeight = 124,
): { left: number; top: number } {
  const margin = 10;
  const maxLeft = Math.max(margin, containerWidth - popoverWidth - margin);
  const left = Math.max(margin, Math.min(Math.round(viewportX + 10), maxLeft));
  const preferredTop = Math.round(viewportY + 12);
  const maxTop = Math.max(margin, containerHeight - popoverHeight - margin);
  const top =
    preferredTop <= maxTop
      ? Math.max(margin, preferredTop)
      : Math.max(margin, Math.min(Math.round(viewportY - popoverHeight - 12), maxTop));
  return { left, top };
}
