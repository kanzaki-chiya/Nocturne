import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntime } from "../src/index.js";
import { FakeProvider } from "../src/provider/index.js";
import {
  LOG_FORMAT_VERSION,
  decodeDurableEvent,
  encodeDurableEvent,
  formatPageCommentsBlock,
  pageCommentsLabel,
  replaySessionView,
  userEntryText,
  type DurableEvent,
  type PageCommentsSnapshot,
} from "../src/protocol/index.js";

// 合法 1×1 透明 PNG
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("pageComments 协议与运行时（ADR-0113）", () => {
  it("新字段编解码正确且不提升 formatVersion，旧日志缺省按普通用户消息读取", () => {
    expect(LOG_FORMAT_VERSION).toBe(1);
    const snapshot: PageCommentsSnapshot = {
      page: "page-1",
      version: 2,
      title: "架构图",
      comments: [
        {
          path: "body > #box-1",
          text: "工具执行",
          x: 120,
          y: 240,
          note: "拆成两行",
        },
      ],
    };
    const event: DurableEvent = {
      seq: 2,
      time: "2026-11-23T00:00:00.000Z",
      sessionId: "sess-1",
      turnId: "turn-1",
      type: "message.user",
      payload: {
        messageId: "msg-1",
        content: [
          { type: "text", text: "顺便改下标题" },
          { type: "text", text: formatPageCommentsBlock(snapshot) },
        ],
        pageComments: snapshot,
      },
    };
    const encoded = encodeDurableEvent(event);
    const decoded = decodeDurableEvent(encoded);
    expect(decoded.type).toBe("message.user");
    if (decoded.type === "message.user") {
      expect(decoded.payload.pageComments).toEqual(snapshot);
    }

    // 不带 pageComments 的旧事件照常解码
    const legacy = decodeDurableEvent(
      JSON.stringify({
        seq: 1,
        time: "2026-11-23T00:00:00.000Z",
        sessionId: "sess-1",
        turnId: "turn-1",
        type: "message.user",
        payload: { messageId: "msg-0", content: [{ type: "text", text: "普通消息" }] },
      }),
    );
    expect(legacy.type).toBe("message.user");
    if (legacy.type === "message.user") {
      expect(legacy.payload.pageComments).toBeUndefined();
    }
  });

  it("formatPageCommentsBlock 包含页面 id、版本号、各字段与 render_html 更新提示", () => {
    const snapshot: PageCommentsSnapshot = {
      page: "page-3",
      version: 2,
      title: "Agent Loop",
      comments: [
        {
          path: "body > #canvas",
          text: "",
          x: 88,
          y: 144,
          note: "颜色太暗",
        },
        {
          path: "body > div:nth-of-type(1) > p:nth-of-type(2)",
          text: "Provider",
          x: 210,
          y: 300,
          note: "对齐左侧边框",
        },
      ],
    };
    const block = formatPageCommentsBlock(snapshot, new Set([0]));
    expect(block).toContain('page="page-3"');
    expect(block).toContain('version="2"');
    expect(block).toContain("render_html");
    expect(block).toContain('page: "page-3"');
    expect(block).toContain("1. path: body > #canvas");
    expect(block).toContain("text: (none)");
    expect(block).toContain("x: 88, y: 144");
    expect(block).toContain("screenshot: attached");
    expect(block).toContain("note: 颜色太暗");
    expect(block).toContain("2. path: body > div:nth-of-type(1) > p:nth-of-type(2)");
    expect(block).toContain("text: Provider");
    expect(block).toContain("x: 210, y: 300");
    expect(block).toContain("note: 对齐左侧边框");
    expect(pageCommentsLabel(snapshot)).toBe("Agent Loop v2 · 2");
  });

  it("提交评论后追加英文块给模型，回放、回退与分叉保留 pageComments", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "nct-page-comments-"));
    roots.push(root);
    const seenUserTexts: string[] = [];
    const provider = new FakeProvider({
      handler: (request) => {
        const last = request.messages.at(-1);
        if (last?.role === "user") {
          seenUserTexts.push(
            last.content
              .filter((p): p is { type: "text"; text: string } => p.type === "text")
              .map((p) => p.text)
              .join("\n---\n"),
          );
        }
        return [
          { type: "text_delta", text: "好的" },
          { type: "finish", reason: "stop" },
        ];
      },
    });
    const runtime = await createRuntime({
      cwd: root,
      sessionsDir: path.join(root, "sessions"),
      providers: [provider],
      interactive: true,
    });
    const session = await runtime.createSession({ model: "fake/fake-model" });
    try {
      await session.submit({
        text: "",
        pageComments: {
          page: "page-1",
          version: 1,
          title: "示意图",
          comments: [
            {
              path: "body > #card-a",
              text: "入口",
              x: 50,
              y: 80,
              note: "加粗边框",
            },
          ],
        },
      });
      // 第二轮普通对话，用于测试回退到第二轮之前时第一轮的评论仍保留
      await session.submit({ text: "第二轮对话" });

      expect(seenUserTexts[0]).toContain(
        '<page-comments page="page-1" version="1" title="示意图">',
      );
      expect(seenUserTexts[0]).toContain("render_html");
      expect(seenUserTexts[0]).toContain("path: body > #card-a");
      expect(seenUserTexts[0]).toContain("text: 入口");
      expect(seenUserTexts[0]).toContain("x: 50, y: 80");
      expect(seenUserTexts[0]).toContain("note: 加粗边框");

      const view = replaySessionView(session.durableEvents());
      const users = view.entries.filter((e) => e.kind === "user");
      expect(users).toHaveLength(2);
      const firstUser = users[0];
      const secondUser = users[1];
      if (!firstUser || !secondUser) throw new Error("expected two user entries");
      expect(firstUser.pageComments).toEqual({
        page: "page-1",
        version: 1,
        title: "示意图",
        comments: [
          { id: "c1", path: "body > #card-a", text: "入口", x: 50, y: 80, note: "加粗边框" },
        ],
      });
      expect(userEntryText(firstUser)).toBe("");

      // 分叉（保留第一轮，截掉第二轮）
      const secondSeq = secondUser.seq;
      const forkedId = await runtime.forkSession(session.id, { targetSeq: secondSeq });
      const forked = await runtime.resumeSession(forkedId);
      try {
        const forkedView = replaySessionView(forked.durableEvents());
        const forkedUsers = forkedView.entries.filter((e) => e.kind === "user");
        expect(forkedUsers).toHaveLength(1);
        expect(forkedUsers[0]?.pageComments?.page).toBe("page-1");
        expect(forkedUsers[0]?.pageComments?.comments[0]?.note).toBe("加粗边框");
      } finally {
        await forked.close();
      }

      // 回退到第二轮之前，第一轮的 pageComments 仍完整保留
      await session.rewind(secondSeq, "conversation");
      const rewoundView = replaySessionView(session.durableEvents());
      const rewoundUsers = rewoundView.entries.filter((e) => e.kind === "user");
      expect(rewoundUsers).toHaveLength(1);
      expect(rewoundUsers[0]?.pageComments?.page).toBe("page-1");
      expect(rewoundUsers[0]?.pageComments?.version).toBe(1);
    } finally {
      await session.close();
      await runtime.close();
    }
  });

  it("截图附件只在无可见文字元素且当前模型支持图片输入时出现", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "nct-page-comments-img-"));
    roots.push(root);
    const seenImagesPerCall: number[] = [];
    const seenTextsPerCall: string[] = [];
    const baseCaps = {
      toolCalls: true,
      parallelToolCalls: true,
      reasoning: "none" as const,
      promptCache: false,
      editTool: "edit" as const,
      historyPrune: true,
    };
    const provider = new FakeProvider({
      models: [
        {
          ref: { provider: "fake", model: "vision" },
          displayName: "Vision",
          contextWindow: 128000,
          maxOutputTokens: 8192,
          capabilities: { ...baseCaps, imageInput: true },
        },
        {
          ref: { provider: "fake", model: "text-only" },
          displayName: "TextOnly",
          contextWindow: 128000,
          maxOutputTokens: 8192,
          capabilities: { ...baseCaps, imageInput: false },
        },
      ],
      handler: (request) => {
        const last = request.messages.at(-1);
        if (last?.role === "user") {
          seenImagesPerCall.push(last.images?.length ?? 0);
          seenTextsPerCall.push(
            last.content
              .filter((p): p is { type: "text"; text: string } => p.type === "text")
              .map((p) => p.text)
              .join("\n"),
          );
        }
        return [
          { type: "text_delta", text: "收到" },
          { type: "finish", reason: "stop" },
        ];
      },
    });
    const runtime = await createRuntime({
      cwd: root,
      sessionsDir: path.join(root, "sessions"),
      providers: [provider],
      interactive: true,
    });
    const session = await runtime.createSession({ model: "fake/vision" });
    try {
      // 1. 无文字元素 + 支持图片模型 → 附带截图
      await session.submit({
        text: "",
        pageComments: {
          page: "page-1",
          version: 1,
          title: "画布",
          comments: [
            {
              path: "body > canvas:nth-of-type(1)",
              text: "",
              x: 40,
              y: 40,
              note: "这里线断了",
              screenshot: { data: new Uint8Array(TINY_PNG), mimeType: "image/png" },
            },
          ],
        },
      });
      // 2. 有文字元素 + 支持图片模型 → 即使传入 screenshot 也不附截图
      await session.submit({
        text: "",
        pageComments: {
          page: "page-1",
          version: 1,
          title: "画布",
          comments: [
            {
              path: "body > h1:nth-of-type(1)",
              text: "标题文字",
              x: 40,
              y: 20,
              note: "字号放大",
              screenshot: { data: new Uint8Array(TINY_PNG), mimeType: "image/png" },
            },
          ],
        },
      });
      // 3. 无文字元素 + 不支持图片模型 → 不附截图
      await session.setModel({ provider: "fake", model: "text-only" });
      await session.submit({
        text: "",
        pageComments: {
          page: "page-1",
          version: 1,
          title: "画布",
          comments: [
            {
              path: "body > svg:nth-of-type(1) > rect:nth-of-type(1)",
              text: "",
              x: 100,
              y: 100,
              note: "改成蓝色",
              screenshot: { data: new Uint8Array(TINY_PNG), mimeType: "image/png" },
            },
          ],
        },
      });

      const userEvents = session
        .durableEvents()
        .filter((e) => e.type === "message.user")
        .map((e) => e.payload);
      expect(userEvents).toHaveLength(3);
      expect(userEvents[0]?.attachments).toHaveLength(1);
      expect(userEvents[1]?.attachments).toBeUndefined();
      expect(userEvents[2]?.attachments).toBeUndefined();

      expect(seenImagesPerCall).toEqual([1, 0, 0]);
      expect(seenTextsPerCall[0]).toContain("screenshot: attached");
      expect(seenTextsPerCall[1]).not.toContain("screenshot: attached");
      expect(seenTextsPerCall[2]).not.toContain("screenshot: attached");
    } finally {
      await session.close();
      await runtime.close();
    }
  });
});
