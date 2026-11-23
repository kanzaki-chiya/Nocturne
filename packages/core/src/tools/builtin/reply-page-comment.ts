import { PAGE_COMMENT_ID_PATTERN, type PageCommentReplyOutput } from "../../protocol/index.js";
import type { ToolDefinition } from "../types.js";

type ReplyPageCommentInput = Omit<PageCommentReplyOutput, "version" | "resolve"> & {
  resolve?: boolean;
};

export const replyPageCommentTool: ToolDefinition<ReplyPageCommentInput, PageCommentReplyOutput> = {
  name: "reply_page_comment",
  description: "Reply to a panel page comment. Set resolve to true when the request is addressed.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["page", "comment", "text"],
    properties: {
      page: { type: "string", minLength: 1 },
      comment: { type: "string", pattern: PAGE_COMMENT_ID_PATTERN },
      text: { type: "string", minLength: 1, maxLength: 10000 },
      resolve: { type: "boolean" },
    },
  },
  traits: { mutates: false, concurrencySafe: true, mainSessionOnly: true },
  permissionSubjects: () => [],
  validateInput: ({ text }) => (text.trim() === "" ? "Reply text is required." : undefined),
  execute(input, ctx) {
    const { page, comment } = input;
    const target = ctx.pages?.().find((entry) => entry.page === page);
    const thread = target?.comments?.find((entry) => entry.id === comment);
    const version = target?.versions.at(-1)?.version;
    if (thread === undefined || thread.resolved || version === undefined) {
      const message = `Comment ${comment} on ${page} is ${thread?.resolved ? "resolved" : "unknown"}.`;
      return Promise.resolve({
        status: "error",
        error: { code: "invalid_input", message },
        modelContent: message,
      });
    }
    const resolve = input.resolve === true;
    return Promise.resolve({
      status: "ok",
      modelContent: `Replied to ${comment}${resolve ? " and resolved it" : ""}.`,
      output: { page, comment, text: input.text.trim(), version, resolve },
    });
  },
};
