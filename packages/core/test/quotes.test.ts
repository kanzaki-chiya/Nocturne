import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntime } from "../src/index.js";
import { FakeProvider } from "../src/provider/index.js";
import {
  LOG_FORMAT_VERSION,
  decodeDurableEvent,
  encodeDurableEvent,
  firstUserText,
  formatPageCommentsBlock,
  formatQuotesBlock,
  replaySessionView,
  userEntryText,
  type DurableEvent,
  type MessageQuote,
  type PageCommentsSnapshot,
} from "../src/protocol/index.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("quotes 引用回复协议与运行时（ADR-0116）", () => {
  it("formatQuotesBlock 正确生成单段、多段、含换行与含代码的首块", () => {
    expect(formatQuotesBlock([{ text: "超过 3 次改成指数退避，间隔上限 30 秒", seq: 4 }])).toBe(
      "> 超过 3 次改成指数退避，间隔上限 30 秒\n\n",
    );

    expect(
      formatQuotesBlock([
        { text: "第一段引用", seq: 2 },
        { text: "第二段引用", seq: 4 },
      ]),
    ).toBe("> 第一段引用\n\n> 第二段引用\n\n");

    expect(formatQuotesBlock([{ text: "第一行\r\n第二行\n第三行" }])).toBe(
      "> 第一行\n> 第二行\n> 第三行\n\n",
    );

    expect(
      formatQuotesBlock([
        {
          text: "function retry(n: number) {\n\n  return Math.min(30, 2 ** n);\n}",
          seq: 5,
        },
      ]),
    ).toBe("> function retry(n: number) {\n> \n>   return Math.min(30, 2 ** n);\n> }\n\n");
  });

  it("quotes 编解码不提升 formatVersion，旧日志与额外字段兼容", () => {
    expect(LOG_FORMAT_VERSION).toBe(1);
    const quotes: MessageQuote[] = [{ text: "第一句", seq: 3 }, { text: "第二句" }];
    const event: DurableEvent = {
      seq: 5,
      time: "2026-11-24T00:00:00.000Z",
      sessionId: "sess-1",
      turnId: "turn-2",
      type: "message.user",
      payload: {
        messageId: "msg-2",
        content: [
          { type: "text", text: formatQuotesBlock(quotes) },
          { type: "text", text: "改一下" },
        ],
        quotes,
      },
    };
    const decoded = decodeDurableEvent(encodeDurableEvent(event));
    expect(decoded.type).toBe("message.user");
    if (decoded.type === "message.user") {
      expect(decoded.payload.quotes).toEqual(quotes);
    }

    // 未知字段忽略（非 .strict()）
    const withUnknown = decodeDurableEvent(
      JSON.stringify({
        ...event,
        payload: {
          ...event.payload,
          quotes: [{ text: "第一句", seq: 3, futureField: "ignored" }],
        },
      }),
    );
    expect(withUnknown.type).toBe("message.user");
    if (withUnknown.type === "message.user") {
      expect(withUnknown.payload.quotes).toEqual([{ text: "第一句", seq: 3 }]);
    }

    // 旧日志无 quotes 字段，显示不变
    const legacy = decodeDurableEvent(
      JSON.stringify({
        seq: 1,
        time: "2026-11-24T00:00:00.000Z",
        sessionId: "sess-1",
        turnId: "turn-1",
        type: "message.user",
        payload: {
          messageId: "msg-0",
          content: [{ type: "text", text: "> 用户手打的引用\n普通正文" }],
        },
      }),
    );
    expect(legacy.type).toBe("message.user");
    if (legacy.type === "message.user") {
      expect(legacy.payload.quotes).toBeUndefined();
      expect(userEntryText(legacy.payload)).toBe("> 用户手打的引用\n普通正文");
    }
  });

  it("userEntryText 去掉首块，并与页面评论、文件引用等尾部快照块共存时正确", () => {
    const quotes: MessageQuote[] = [{ text: "原文片段", seq: 2 }];
    const pageComments: PageCommentsSnapshot = {
      page: "page-1",
      version: 1,
      title: "示意图",
      comments: [{ path: "body > p", text: "标题", x: 10, y: 20, note: "加粗" }],
    };

    // 只有 quotes + 正文
    expect(
      userEntryText({
        content: [
          { type: "text", text: formatQuotesBlock(quotes) },
          { type: "text", text: "只看这里" },
        ],
        quotes,
      }),
    ).toBe("只看这里");

    // 只有 quotes、正文为空
    expect(
      userEntryText({
        content: [
          { type: "text", text: formatQuotesBlock(quotes) },
          { type: "text", text: "" },
        ],
        quotes,
      }),
    ).toBe("");

    // 同时存在首块 quotes 与尾部 fileRefs（含图片与非图片）、files、pageComments
    expect(
      userEntryText({
        content: [
          { type: "text", text: formatQuotesBlock(quotes) },
          { type: "text", text: "结合 @a.ts 改一下" },
          { type: "text", text: '<file path="a.ts">const x = 1;</file>' },
          { type: "text", text: "<attachments>notes.txt</attachments>" },
          { type: "text", text: formatPageCommentsBlock(pageComments) },
        ],
        quotes,
        fileRefs: [
          { path: "a.ts", kind: "file", lines: 1, totalLines: 1, chars: 12, truncated: false },
          { path: "shot.png", kind: "image", chars: 0, truncated: false },
        ],
        files: [
          {
            type: "file",
            file: "notes.txt",
            mimeType: "text/plain",
            bytes: 12,
            sha256: "abc",
            label: "notes.txt",
            source: "upload",
          },
        ],
        pageComments,
      }),
    ).toBe("结合 @a.ts 改一下");

    // firstUserText 也跳过首块引用
    expect(
      firstUserText({
        content: [
          { type: "text", text: formatQuotesBlock(quotes) },
          { type: "text", text: "\n第一行正文\n第二行" },
        ],
        quotes,
      }),
    ).toBe("第一行正文");
  });

  it("只有引用、正文为空时也可提交，并把首块送给模型", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "nct-quotes-empty-body-"));
    roots.push(root);
    const seenUserBlocks: string[][] = [];
    const provider = new FakeProvider({
      handler: (request) => {
        const lastUser = [...request.messages].reverse().find((m) => m.role === "user");
        if (lastUser?.role === "user") {
          seenUserBlocks.push(
            lastUser.content
              .filter((b): b is { type: "text"; text: string } => b.type === "text")
              .map((b) => b.text),
          );
        }
        return [
          { type: "text_delta", text: "收到引用" },
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
      const reason = await session.submit({
        text: "",
        quotes: [{ text: "  超过 3 次改成指数退避  \r\n  第二行  ", seq: 2 }],
      });
      expect(reason).toBe("done");
      expect(seenUserBlocks[0]).toEqual(["> 超过 3 次改成指数退避  \n>   第二行\n\n", ""]);

      const view = replaySessionView(session.durableEvents());
      const users = view.entries.filter((e) => e.kind === "user");
      expect(users).toHaveLength(1);
      const firstUser = users[0];
      expect(firstUser).toBeDefined();
      if (firstUser === undefined) throw new Error("expected user entry");
      expect(firstUser.quotes).toEqual([{ text: "超过 3 次改成指数退避  \n  第二行", seq: 2 }]);
      expect(userEntryText(firstUser)).toBe("");
    } finally {
      await session.close();
    }
  });

  it("待发队列（queue/steer、编辑保留引用）、回放、回退放回、分叉均保留 quotes", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "nct-quotes-flow-"));
    roots.push(root);
    writeFileSync(path.join(root, "a.ts"), "export const v = 1;\n", "utf8");

    let releaseFirstTurn: (() => void) | undefined;
    let markFirstTurnEntered: (() => void) | undefined;
    const firstTurnEntered = new Promise<void>((resolve) => {
      markFirstTurnEntered = resolve;
    });
    let callCount = 0;
    const seenUserBlocks: string[][] = [];
    const provider = new FakeProvider({
      handler: async (request) => {
        callCount += 1;
        const lastUser = [...request.messages].reverse().find((m) => m.role === "user");
        if (lastUser?.role === "user") {
          seenUserBlocks.push(
            lastUser.content
              .filter((b): b is { type: "text"; text: string } => b.type === "text")
              .map((b) => b.text),
          );
        }
        if (callCount === 1) {
          await new Promise<void>((resolve) => {
            releaseFirstTurn = resolve;
            markFirstTurnEntered?.();
          });
          return [
            { type: "text_delta", text: "第一轮回答" },
            { type: "finish", reason: "stop" },
          ];
        }
        return [
          { type: "text_delta", text: `第 ${callCount} 轮回答` },
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
      const firstTurn = session.submit({ text: "先介绍一下" });
      await firstTurnEntered;

      // 运行中入队一条带 quotes 的排队消息，并编辑其文本（引用应保留）
      const q1: MessageQuote[] = [{ text: "介绍里的关键句", seq: 3 }];
      const queued = await session.enqueueInput("queue", {
        text: "原问题",
        quotes: q1,
      });
      expect(queued.queued).toBe(true);
      expect(session.pendingInputs().items[0]?.quotes).toEqual(q1);
      expect(session.pendingInputs().items[0]?.text).toBe("原问题");

      await session.updateInput(queued.id, { input: { text: "修改后的问题" } });
      expect(session.pendingInputs().items[0]?.text).toBe("修改后的问题");
      expect(session.pendingInputs().items[0]?.quotes).toEqual(q1);

      // 运行中再插话一条带 quotes 的消息
      const steerQuote: MessageQuote[] = [{ text: "插话引用的句子", seq: 2 }];
      const steered = await session.enqueueInput("steer", {
        text: "插话正文",
        quotes: steerQuote,
      });
      expect(steered.queued).toBe(true);

      releaseFirstTurn?.();
      await firstTurn;
      await vi.waitFor(() => {
        expect(session.pendingInputs().items).toHaveLength(0);
        expect(session.state().openTurn).toBeUndefined();
      });

      // 再发一条同时包含 quotes 和 @a.ts 的消息
      const q2: MessageQuote[] = [
        { text: "第一轮回答", seq: 3 },
        { text: "修改后的问题", seq: 8 },
      ];
      await session.submit({ text: "结合 @a.ts 说明一下", quotes: q2 });

      // 验证持久事件与回放视图
      const view = replaySessionView(session.durableEvents());
      const users = view.entries.filter((e) => e.kind === "user");
      expect(users.map((u) => userEntryText(u))).toEqual([
        "先介绍一下",
        "插话正文",
        "修改后的问题",
        "结合 @a.ts 说明一下",
      ]);
      expect(users[1]?.steer).toBe(true);
      expect(users[1]?.quotes).toEqual(steerQuote);
      expect(users[2]?.quotes).toEqual(q1);
      expect(users[3]?.quotes).toEqual(q2);
      expect(users[3]?.fileRefs?.[0]?.path).toBe("a.ts");

      // 验证回退目标：保留 quotes 且 text 不含首块
      const targets = await session.rewindTargets();
      const targetForModified = targets.find((t) => t.text === "修改后的问题");
      expect(targetForModified?.quotes).toEqual(q1);
      const targetForMulti = targets.find((t) => t.text === "结合 @a.ts 说明一下");
      expect(targetForMulti?.quotes).toEqual(q2);

      // 验证分叉保留 quotes
      const forkedId = await runtime.forkSession(session.id);
      const forked = await runtime.resumeSession(forkedId);
      try {
        const forkedView = replaySessionView(forked.durableEvents());
        const forkedUsers = forkedView.entries.filter((e) => e.kind === "user");
        expect(forkedUsers[2]?.quotes).toEqual(q1);
        expect(forkedUsers[3]?.quotes).toEqual(q2);
        const forkedLast = forkedUsers[3];
        if (forkedLast === undefined) throw new Error("expected forked user entry");
        expect(userEntryText(forkedLast)).toBe("结合 @a.ts 说明一下");
      } finally {
        await forked.close();
      }

      // 验证回退后被撤掉的消息从有效视图移除，早先消息的 quotes 保留
      if (targetForMulti === undefined) throw new Error("expected rewind target");
      await session.rewind(targetForMulti.seq, "conversation");
      const rewoundView = replaySessionView(session.durableEvents());
      const rewoundUsers = rewoundView.entries.filter((e) => e.kind === "user");
      expect(rewoundUsers).toHaveLength(3);
      const rewoundLast = rewoundUsers[2];
      if (rewoundLast === undefined) throw new Error("expected rewound user entry");
      expect(rewoundLast.quotes).toEqual(q1);
      expect(userEntryText(rewoundLast)).toBe("修改后的问题");
    } finally {
      await session.close();
    }
  });
});
