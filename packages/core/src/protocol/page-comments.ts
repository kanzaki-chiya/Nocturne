/** Panel page comment messages and threads (ADR-0113, ADR-0115). */
export const PAGE_COMMENT_TEXT_MAX_CHARS = 200;
export const PAGE_COMMENT_ID_PATTERN = "^c[1-9][0-9]*$";

export interface PageCommentAnchor {
  path: string;
  text: string;
  /** Document-relative CSS pixels. */
  x: number;
  y: number;
}

export interface PageCommentItem extends PageCommentAnchor {
  id?: string | undefined;
  replyTo?: undefined;
  note: string;
}

export interface PageCommentReplyInput {
  id?: string | undefined;
  replyTo: string;
  note: string;
}

export interface PageCommentsSnapshot {
  page: string;
  version: number;
  title: string;
  comments: (PageCommentItem | PageCommentReplyInput)[];
}

export interface PageCommentScreenshotInput {
  data: Uint8Array;
  mimeType: string;
  label?: string | undefined;
}

export interface PageCommentInput extends PageCommentItem {
  /** Included only for anchors without visible text and models that accept images. */
  screenshot?: PageCommentScreenshotInput | undefined;
}

export interface PageCommentsInput {
  page: string;
  version: number;
  title: string;
  comments: (PageCommentInput | PageCommentReplyInput)[];
}

export interface PageCommentsSummary {
  page: string;
  version: number;
  title: string;
  count: number;
  /** Pending snapshot without screenshot bytes or durable comment IDs. */
  items?: PageCommentsSnapshot["comments"] | undefined;
}

export interface PageCommentReply {
  by: "user" | "model";
  text: string;
  version: number;
  seq: number;
  time: string;
}

export interface PageCommentThread extends PageCommentItem {
  version: number;
  seq: number;
  time: string;
  replies: PageCommentReply[];
  pending: boolean;
  resolved: boolean;
}

export interface PageCommentReplyOutput {
  page: string;
  comment: string;
  text: string;
  version: number;
  resolve: boolean;
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

export function formatPageCommentsBlock(
  snapshot: PageCommentsSnapshot,
  screenshotIndices?: ReadonlySet<number>,
  threads: readonly PageCommentThread[] = [],
): string {
  const lines = [
    `<page-comments page="${escapeAttr(snapshot.page)}" version="${snapshot.version}" title="${escapeAttr(snapshot.title)}">`,
    `The user sent ${snapshot.comments.length} page comment item${snapshot.comments.length === 1 ? "" : "s"}.`,
  ];
  snapshot.comments.forEach((item, index) => {
    const id = item.id === undefined ? "" : `id: ${item.id}, `;
    if (item.replyTo !== undefined) {
      lines.push(`${index + 1}. ${id}reply to ${item.replyTo}`);
      const thread = threads.find((candidate) => candidate.id === item.replyTo);
      if (thread !== undefined) {
        lines.push("   Previous messages (by, text):");
        for (const message of [{ by: "user", text: thread.note }, ...thread.replies]) {
          lines.push(`   - ${JSON.stringify({ by: message.by, text: message.text })}`);
        }
      }
    } else {
      lines.push(`${index + 1}. ${id}path: ${item.path}`);
      lines.push(`   text: ${item.text === "" ? "(none)" : item.text}`);
      lines.push(`   x: ${item.x}, y: ${item.y}`);
      if (screenshotIndices?.has(index)) lines.push("   screenshot: attached");
    }
    lines.push(`   note: ${item.note}`);
  });
  lines.push(
    `Make the requested page changes with \`render_html\` using \`page: ${JSON.stringify(snapshot.page)}\` (prefer \`edits\` for targeted changes).`,
    "Then call `reply_page_comment` for each thread to explain what changed. For a reply, use its `reply to` ID as `comment`. Set `resolve: true` when the request is addressed. Leave the thread open if you need an answer from the user.",
    "</page-comments>",
  );
  return lines.join("\n");
}
