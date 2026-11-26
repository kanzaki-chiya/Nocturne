import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { createRuntime, FakeProvider } from "../src/index.js";
import {
  decodeDurableEvent,
  encodeDurableEvent,
  projectQueuedPageComments,
  replaySessionView,
  type DurableEvent,
  type PendingInputItem,
} from "../src/protocol/index.js";

const anchor = { path: "body > #entry", text: "入口", x: 80, y: 40, note: "加粗边框" };
const page = { page: "page-1", title: "流程", version: 1 };

async function writeLegacyCommentedSession(sessionsDir: string, cwd: string, sessionId: string) {
  await mkdir(path.join(sessionsDir, "attachments", sessionId), { recursive: true });
  const html = '<p id="entry">入口</p>';
  await writeFile(path.join(sessionsDir, "attachments", sessionId, "file-1.html"), html, "utf8");
  const events: DurableEvent[] = [
    {
      seq: 1,
      sessionId,
      time: "2026-11-24T10:00:00.000Z",
      type: "session.created",
      payload: {
        cwd,
        workspaceRoot: cwd,
        model: { provider: "fake", model: "fake-1" },
        permissionPreset: "read-only",
        formatVersion: 1,
        nocturneVersion: "0.68.0",
      },
    },
    {
      seq: 2,
      sessionId,
      turnId: "t1",
      time: "2026-11-24T10:00:01.000Z",
      type: "turn.started",
      payload: { turnIndex: 1 },
    },
    {
      seq: 3,
      sessionId,
      turnId: "t1",
      time: "2026-11-24T10:00:01.000Z",
      type: "message.user",
      payload: {
        messageId: "u1",
        content: [
          { type: "text", text: "生成流程" },
          {
            type: "text",
            text: '<work-mode name="cadenza">\nUse render_html with display: "panel".\n</work-mode>',
          },
        ],
        workMode: { name: "cadenza", body: 'Use render_html with display: "panel".' },
      },
    },
    {
      seq: 4,
      sessionId,
      turnId: "t1",
      time: "2026-11-24T10:00:02.000Z",
      type: "tool.completed",
      payload: {
        callId: "rh-1",
        name: "render_html",
        status: "ok",
        modelContent: "页面「流程」（page-1 v1，面板）已保存",
        durationMs: 12,
        output: {
          page: "page-1",
          version: 1,
          display: "panel",
          title: page.title,
          file: "file-1.html",
          path: path.join(sessionsDir, "attachments", sessionId, "file-1.html"),
          bytes: Buffer.byteLength(html),
        },
        files: [
          {
            type: "file",
            file: "file-1.html",
            bytes: Buffer.byteLength(html),
            sha256: "a".repeat(64),
            label: "流程.html",
            mimeType: "text/html",
            source: "upload",
            inline: { title: page.title, page: "page-1", version: 1, display: "panel" },
          },
        ],
      },
    },
    {
      seq: 5,
      sessionId,
      turnId: "t1",
      time: "2026-11-24T10:00:03.000Z",
      type: "turn.completed",
      payload: { reason: "done", steps: 1, usage: { inputTokens: 0, outputTokens: 0 } },
    },
    {
      seq: 6,
      sessionId,
      turnId: "t2",
      time: "2026-11-24T10:01:00.000Z",
      type: "turn.started",
      payload: { turnIndex: 2 },
    },
    {
      seq: 7,
      sessionId,
      turnId: "t2",
      time: "2026-11-24T10:01:00.000Z",
      type: "message.user",
      payload: {
        messageId: "u2",
        content: [
          { type: "text", text: "" },
          { type: "text", text: "<page-comments>1. id: c1</page-comments>" },
        ],
        pageComments: {
          ...page,
          comments: [{ ...anchor, id: "c1" }],
        },
      },
    },
    {
      seq: 8,
      sessionId,
      turnId: "t2",
      time: "2026-11-24T10:01:05.000Z",
      type: "tool.completed",
      payload: {
        callId: "rpc-1",
        name: "reply_page_comment",
        status: "ok",
        modelContent: "Replied to c1.",
        durationMs: 4,
        output: {
          page: page.page,
          comment: "c1",
          text: "已经加粗。",
          version: 1,
          resolve: false,
        },
      },
    },
    {
      seq: 9,
      sessionId,
      turnId: "t2",
      time: "2026-11-24T10:01:06.000Z",
      type: "turn.completed",
      payload: { reason: "done", steps: 1, usage: { inputTokens: 0, outputTokens: 0 } },
    },
    {
      seq: 10,
      sessionId,
      turnId: "t3",
      time: "2026-11-24T10:02:00.000Z",
      type: "turn.started",
      payload: { turnIndex: 3 },
    },
    {
      seq: 11,
      sessionId,
      turnId: "t3",
      time: "2026-11-24T10:02:00.000Z",
      type: "message.user",
      payload: {
        messageId: "u3",
        content: [
          { type: "text", text: "" },
          { type: "text", text: "<page-comments>1. id: c2, reply to c1</page-comments>" },
        ],
        pageComments: {
          ...page,
          comments: [{ id: "c2", replyTo: "c1", note: "再用强调色。" }],
        },
      },
    },
    {
      seq: 12,
      sessionId,
      turnId: "t3",
      time: "2026-11-24T10:02:05.000Z",
      type: "turn.completed",
      payload: { reason: "done", steps: 1, usage: { inputTokens: 0, outputTokens: 0 } },
    },
  ];
  await writeFile(
    path.join(sessionsDir, `${sessionId}.jsonl`),
    `${events.map((event) => encodeDurableEvent(event)).join("\n")}\n`,
    "utf8",
  );
  return events;
}

it("restores legacy threaded comments read-only, rejects new pageComments submissions, and removes reply_page_comment from model tools", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "nct-comment-threads-"));
  const sessionsDir = path.join(root, "sessions");
  const sessionId = "legacy-comment-session";
  const seenToolNames: string[][] = [];
  const provider = new FakeProvider({
    handler: (request) => {
      seenToolNames.push(request.tools.map((t) => t.name));
      return [
        { type: "text_delta", text: "收到。" },
        { type: "finish", reason: "stop" },
      ];
    },
  });
  await writeLegacyCommentedSession(sessionsDir, root, sessionId);
  const runtime = await createRuntime({
    cwd: root,
    sessionsDir,
    providers: [provider],
    interactive: true,
  });
  const session = await runtime.resumeSession(sessionId);
  const events = () => session.durableEvents();
  const threads = () => replaySessionView(events()).pages[0]?.comments;
  try {
    expect(threads()).toMatchObject([
      {
        id: "c1",
        note: "加粗边框",
        pending: true,
        resolved: false,
        replies: [
          { by: "model", text: "已经加粗。", version: 1 },
          { by: "user", text: "再用强调色。", version: 1 },
        ],
      },
    ]);
    expect((await runtime.listPages()).items[0]?.hasUnresolvedComments).toBe(true);

    // 历史 replyTo 评论事件编解码 round-trip 仍保留
    const replyEvent = events().find(
      (event): event is DurableEvent<"message.user"> =>
        event.type === "message.user" && event.seq === 11,
    );
    if (!replyEvent) throw new Error("Missing legacy reply comment event");
    expect(decodeDurableEvent(encodeDurableEvent(replyEvent))).toEqual(replyEvent);

    // 新请求禁止通过 submit / enqueueInput 提交 pageComments
    await expect(
      session.submit({ text: "", pageComments: { ...page, comments: [anchor] } }),
    ).rejects.toMatchObject({ code: "invalid_command" });
    await expect(
      session.enqueueInput("queue", {
        text: "",
        pageComments: { ...page, comments: [{ replyTo: "c1", note: "继续" }] },
      }),
    ).rejects.toMatchObject({ code: "invalid_command" });

    // 模型工具清单不再暴露 reply_page_comment 或 list_pages
    await session.submit({ text: "你好" });
    expect(seenToolNames[0]).not.toContain("reply_page_comment");
    expect(seenToolNames[0]).not.toContain("list_pages");

    // 仍支持本地标记解决旧讨论串，跨分叉与回退行为一致
    await session.resolvePageComment("page-1", "c1");
    expect(threads()?.[0]).toMatchObject({ resolved: true, pending: false });
    expect((await runtime.listPages()).items[0]?.hasUnresolvedComments).toBeUndefined();

    const forkId = await runtime.forkSession(session.id);
    const forked = await runtime.resumeSession(forkId);
    try {
      expect(replaySessionView(forked.durableEvents()).pages[0]?.comments).toEqual(threads());
    } finally {
      await forked.close();
    }

    await session.rewind(11, "conversation");
    expect(threads()).toMatchObject([
      { id: "c1", resolved: true, pending: false, replies: [{ by: "model", text: "已经加粗。" }] },
    ]);
    await session.rewind(7, "conversation");
    expect(threads()).toBeUndefined();
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
