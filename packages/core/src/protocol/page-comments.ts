/**
 * 面板页面评论（ADR-0113）：用户消息携带的页面评论快照与追加给模型的英文块。
 * 纯类型与纯函数，无 I/O，不依赖 Node 内置模块。
 */

export const PAGE_COMMENT_TEXT_MAX_CHARS = 200;

export interface PageCommentItem {
  /** 从 body 起的 CSS 元素路径（优先用 id，其次标签名加 :nth-of-type） */
  path: string;
  /** 被点元素的可见文字（截断到 200 字符）；选中了文字时为选中原文；无可见文字时为空串 */
  text: string;
  /** 点击点相对页面文档左上角的 CSS 像素 X 坐标 */
  x: number;
  /** 点击点相对页面文档左上角的 CSS 像素 Y 坐标 */
  y: number;
  /** 用户写的评论 */
  note: string;
}

/**
 * 随 `message.user.pageComments` 持久化的评论快照（ADR-0113）。
 * 兼容扩展，不提升 formatVersion，旧版本按普通用户消息读取。
 */
export interface PageCommentsSnapshot {
  /** 页面 id（如 page-1） */
  page: string;
  /** 添加评论时所在页面的版本号（正整数） */
  version: number;
  /** 页面标题（用于界面标签展示） */
  title: string;
  /** 评论列表（至少 1 条） */
  comments: PageCommentItem[];
}

export interface PageCommentScreenshotInput {
  data: Uint8Array;
  mimeType: string;
  label?: string | undefined;
}

export interface PageCommentInput extends PageCommentItem {
  /** 无可见文字元素且模型支持图片输入时随消息附带的局部截图；不落入 pageComments 字段 */
  screenshot?: PageCommentScreenshotInput | undefined;
}

export interface PageCommentsInput {
  page: string;
  version: number;
  title: string;
  comments: PageCommentInput[];
}

export interface PageCommentsSummary {
  page: string;
  version: number;
  title: string;
  count: number;
}

/** 输入框上方与用户消息内共用的评论标签文字：「<页面标题> v<n> · <条数>」 */
export function pageCommentsLabel(
  value:
    | PageCommentsSummary
    | (Pick<PageCommentsSnapshot, "title" | "version"> & { comments: readonly unknown[] }),
): string {
  const count = "count" in value ? value.count : value.comments.length;
  return `${value.title} v${value.version} · ${count}`;
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * 在 Core 生成追加给模型的英文评论块（ADR-0113）。
 * 写明页面 id、版本号以及每条评论的 path、text、x、y、note，提示用 render_html 更新该页面。
 */
export function formatPageCommentsBlock(
  snapshot: PageCommentsSnapshot,
  screenshotIndices?: ReadonlySet<number>,
): string {
  const lines: string[] = [
    `<page-comments page="${escapeAttr(snapshot.page)}" version="${snapshot.version}" title="${escapeAttr(snapshot.title)}">`,
    `The user left ${snapshot.comments.length} comment${snapshot.comments.length === 1 ? "" : "s"} on page "${snapshot.page}" (v${snapshot.version}). Update this page by calling \`render_html\` with \`page: "${snapshot.page}"\` (prefer \`edits\` for targeted changes).`,
  ];
  snapshot.comments.forEach((item, index) => {
    lines.push(`${index + 1}. path: ${item.path}`);
    lines.push(`   text: ${item.text === "" ? "(none)" : item.text}`);
    lines.push(`   x: ${item.x}, y: ${item.y}`);
    if (screenshotIndices?.has(index)) {
      lines.push("   screenshot: attached");
    }
    lines.push(`   note: ${item.note}`);
  });
  lines.push("</page-comments>");
  return lines.join("\n");
}
