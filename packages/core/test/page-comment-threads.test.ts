import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { createRuntime, FakeProvider } from "../src/index.js";
import {
  decodeDurableEvent,
  encodeDurableEvent,
  projectQueuedPageComments,
  replaySessionView,
  type PageCommentsInput,
  type PendingInputItem,
} from "../src/protocol/index.js";

const anchor = { path: "body > #entry", text: "入口", x: 80, y: 40, note: "加粗边框" };
const page = { page: "page-1", title: "流程", version: 1 };

it("writes threaded comments, delivers history to the model, and folds resolution across replay, rewind and fork", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "nct-comment-threads-"));
  const blocks: string[] = [];
  const provider = new FakeProvider({
    handler: (request, index) => {
      for (const block of request.messages.at(-1)?.content ?? []) {
        if (
          typeof block !== "string" &&
          block.type === "text" &&
          block.text.startsWith("<page-comments ")
        ) {
          blocks.push(block.text);
        }
      }
      const tools = [
        {
          name: "render_html",
          input: { html: '<p id="entry">入口</p>', title: page.title, display: "panel" },
        },
        undefined,
        {
          name: "reply_page_comment",
          input: { page: page.page, comment: "c1", text: "已经加粗。" },
        },
        undefined,
        {
          name: "reply_page_comment",
          input: { page: page.page, comment: "c99", text: "不存在。" },
        },
        undefined,
        {
          name: "reply_page_comment",
          input: { page: page.page, comment: "c1", text: "已经关闭。" },
        },
      ];
      const tool = tools[index];
      return tool === undefined
        ? [
            { type: "text_delta", text: "收到。" },
            { type: "finish", reason: "stop" },
          ]
        : [
            { type: "tool_call", toolCallId: `test-${index}`, ...tool },
            { type: "finish", reason: "tool_calls" },
          ];
    },
  });
  const runtime = await createRuntime({
    cwd: root,
    sessionsDir: path.join(root, "sessions"),
    providers: [provider],
    interactive: true,
  });
  const session = await runtime.createSession({
    model: "fake/fake-1",
    permissionPreset: "read-only",
  });
  const events = () => session.durableEvents();
  const threads = () => replaySessionView(events()).pages[0]?.comments;
  const submit = (comments: PageCommentsInput["comments"]) =>
    session.submit({ text: "", pageComments: { ...page, comments } });
  try {
    await session.submit({ text: "生成流程" });
    await submit([anchor]);
    expect(threads()).toMatchObject([
      {
        id: "c1",
        pending: false,
        resolved: false,
        replies: [{ by: "model", text: "已经加粗。", version: 1 }],
      },
    ]);
    expect(blocks[0]).toContain("1. id: c1, path: body > #entry");
    expect(blocks[0]).toContain("reply_page_comment");
    expect((await runtime.listPages()).items[0]?.hasUnresolvedComments).toBe(true);
    await submit([{ replyTo: "c1", note: "再用强调色。" }]);
    expect(blocks[1]).toContain(
      '1. id: c2, reply to c1\n   Previous messages (by, text):\n   - {"by":"user","text":"加粗边框"}\n   - {"by":"model","text":"已经加粗。"}\n   note: 再用强调色。',
    );
    expect(threads()?.[0]).toMatchObject({
      pending: true,
      replies: [{ by: "model" }, { by: "user", text: "再用强调色。" }],
    });
    const users = events().filter((event) => event.type === "message.user");
    const replyEvent = users.at(-1);
    const firstCommentEvent = users[1];
    if (!replyEvent || !firstCommentEvent) throw new Error("Missing persisted comment events");
    expect(decodeDurableEvent(encodeDurableEvent(replyEvent))).toEqual(replyEvent);

    await session.resolvePageComment("page-1", "c1");
    const resolved = events().at(-1);
    expect(resolved).toMatchObject({
      type: "page.comment_resolved",
      payload: { page: "page-1", comment: "c1" },
    });
    expect(resolved?.turnId).toBeUndefined();
    expect(threads()?.[0]).toMatchObject({ resolved: true, pending: false });
    expect((await runtime.listPages()).items[0]?.hasUnresolvedComments).toBeUndefined();
    await session.submit({ text: "复查" });
    const replies = events().filter(
      (event) => event.type === "tool.completed" && event.payload.name === "reply_page_comment",
    );
    expect(replies.map((event) => event.payload)).toMatchObject([
      { status: "ok" },
      {
        status: "error",
        error: { code: "invalid_input", message: expect.stringContaining("unknown") },
      },
      {
        status: "error",
        error: { code: "invalid_input", message: expect.stringContaining("resolved") },
      },
    ]);
    const forkId = await runtime.forkSession(session.id);
    const forked = await runtime.resumeSession(forkId);
    try {
      expect(replaySessionView(forked.durableEvents()).pages[0]?.comments).toEqual(threads());
    } finally {
      await forked.close();
    }
    await session.rewind(replyEvent.seq, "conversation");
    expect(threads()).toMatchObject([
      { id: "c1", resolved: true, pending: false, replies: [{ by: "model" }] },
    ]);
    await session.rewind(firstCommentEvent.seq, "conversation");
    expect(threads()).toBeUndefined();
    await submit([anchor]);
    expect(threads()).toMatchObject([{ id: "c3", resolved: false, pending: true }]);
  } finally {
    await session.close();
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("projects queued root comments and reply targets without reserving durable IDs", () => {
  const item: PendingInputItem = {
    id: "pending-1",
    mode: "steer",
    text: "",
    attachments: 0,
    createdAt: "2026-11-24T00:00:00Z",
    paused: false,
    pageComments: { ...page, count: 2, items: [anchor, { replyTo: "c2", note: "继续" }] },
  };
  expect(projectQueuedPageComments("page-1", [item])).toEqual({
    threads: [
      {
        ...anchor,
        version: 1,
        queueKey: "pending-1:0",
        seq: 0,
        time: item.createdAt,
        replies: [],
        pending: true,
        resolved: false,
      },
    ],
    replyTargets: new Set(["c2"]),
  });
  expect(projectQueuedPageComments("page-1", []).threads).toEqual([]);
});
