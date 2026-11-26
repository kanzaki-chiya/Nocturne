import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSessionView,
  reduceSessionView,
  type AssistantEntry,
  type RuntimeEvent,
  type SessionView,
  type UserEntry,
  type ViewEntry,
} from "@nocturne/core/protocol";
import type { RpcSession } from "@nocturne/rpc/client";

import { Conversation, Markdown } from "../src/Conversation";
import { createAttachmentImageSource } from "../src/attachment-images";
import { lexMarkdownBlocks } from "../src/streaming-markdown";

const STREAM_CHUNKS = [
  "第一段先说明核心结论：在流式回答持续输出期间，已经定型的正文节点必须保持原位，避免选区丢失与阅读位置跳动。\n\n",
  "第二段补充边界条件：当表格与代码块逐步到达时，",
  "未闭合结构不应波及上方已经定型的段落。\n\n",
  "| 模块 | 状态 | 说明 |\n",
  "| --- |",
  " --- | --- |",
  "\n",
  "| Markdown | 流式解析 | 分隔行闭合后再排版 |\n",
  "| Conversation | 交接路径 | 实时转历史保留选区 |\n\n",
  "```lean\ntheorem add_comm_demo (a b : Nat) : a + b = b + a := by\n",
  "  induction a with\n  | zero => simp\n  | succ n ih => simp [Nat.succ_add, ih]\n",
  "```\n\n以上示例参考 [规范][adr-ref]。\n\n[adr-ref]: https://example.com/adr-0128\n",
];

const FULL_REPLY = STREAM_CHUNKS.join("");
const SELECTED_PHRASE = "已经定型的正文节点必须保持原位";

function stubSession(id = "stream-session"): RpcSession {
  return {
    id,
    resolveFiles: vi.fn(() => Promise.resolve([])),
    readAttachment: vi.fn(() =>
      Promise.resolve({ data: new Uint8Array(), mimeType: "text/plain", bytes: 0 }),
    ),
    respondPermission: vi.fn(() => Promise.resolve()),
    respondSubagentPermission: vi.fn(() => Promise.resolve()),
    respondQuestion: vi.fn(() => Promise.resolve()),
  } as unknown as RpcSession;
}

function selectPhraseIn(root: HTMLElement, phrase: string): Text {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node !== null) {
    const textNode = node as Text;
    const offset = textNode.data.indexOf(phrase);
    if (offset >= 0) {
      const range = document.createRange();
      range.setStart(textNode, offset);
      range.setEnd(textNode, offset + phrase.length);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      return textNode;
    }
    node = walker.nextNode();
  }
  throw new Error(`未在节点内找到目标短语：${phrase}`);
}

function buildLongHistoryView(count: number): { view: SessionView; nextSeq: number } {
  const view = createSessionView();
  const entries: ViewEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    const seq = i + 1;
    if (i % 2 === 0) {
      const user: UserEntry = {
        kind: "user",
        key: `u:${String(seq)}`,
        turnId: `turn-${String(seq)}`,
        seq,
        content: [{ type: "text", text: `历史提问 ${String(seq)}` }],
        attachments: [],
        fileRefs: [],
      };
      entries.push(user);
    } else {
      const assistant: AssistantEntry = {
        kind: "assistant",
        key: `a:hist-${String(seq)}`,
        turnId: `turn-${String(seq - 1)}`,
        messageId: `hist-${String(seq)}`,
        seq,
        time: "2026-11-26T10:00:00.000Z",
        text: `历史回复 ${String(seq)}`,
        reasoning: "",
        toolCalls: [],
        model: { provider: "fake", model: "fake-1" },
        usage: undefined,
        finishReason: "stop",
      };
      entries.push(assistant);
    }
  }
  view.entries = entries;
  view.lastSeq = count;
  return { view, nextSeq: count + 1 };
}

function mockScrollMetrics(
  el: HTMLElement,
  metrics: { clientHeight: number; scrollHeight: number; scrollTop?: number },
): void {
  let top = metrics.scrollTop ?? 0;
  Object.defineProperty(el, "clientHeight", {
    configurable: true,
    get: () => metrics.clientHeight,
  });
  Object.defineProperty(el, "scrollHeight", {
    configurable: true,
    get: () => metrics.scrollHeight,
  });
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (val: number) => {
      top = val;
    },
  });
}

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  cleanup();
});

describe("lexMarkdownBlocks 流式块稳定化（ADR-0128）", () => {
  it("忽略 space 与 def 保持可见块键稳定，且段落签名不受尾随换行变化影响", () => {
    const b1 = lexMarkdownBlocks("第一段正文", true);
    const b2 = lexMarkdownBlocks("第一段正文\n", true);
    const b3 = lexMarkdownBlocks("第一段正文\n\n", true);
    const b4 = lexMarkdownBlocks(
      "第一段正文\n\n第二段 [链接][ref]\n\n[ref]: https://example.com",
      true,
    );

    expect(b1[0]?.key).toBe("b:0");
    expect(b2[0]?.key).toBe("b:0");
    expect(b3[0]?.key).toBe("b:0");
    expect(b4[0]?.key).toBe("b:0");
    expect(b1[0]?.sig).toBe("第一段正文");
    expect(b2[0]?.sig).toBe("第一段正文");
    expect(b3[0]?.sig).toBe("第一段正文");
    expect(b4[0]?.sig).toBe("第一段正文");
    // 不含引用的首段 linksKey 始终为空，不会因后置链接定义重渲染
    expect(b4[0]?.linksKey).toBe("");
    // 含引用的第二段 linksKey 捕获后置定义
    expect(b4[1]?.linksKey).toContain("https://example.com");
  });

  it("流式期表格分隔行未以换行闭合时暂不排版为 table，闭合后立即排版；非流式按原 Markdown 语义", () => {
    const partialNoNl = "前文\n\n| A | B |\n| --- | --- |";
    const closedNl = `${partialNoNl}\n`;

    const streamingPartial = lexMarkdownBlocks(partialNoNl, true);
    expect(streamingPartial[1]?.type).toBe("paragraph");

    const streamingClosed = lexMarkdownBlocks(closedNl, true);
    expect(streamingClosed[1]?.type).toBe("table");

    // 结束或中断（streaming=false）按原有 Markdown 语义渲染
    const finalizedPartial = lexMarkdownBlocks(partialNoNl, false);
    expect(finalizedPartial[1]?.type).toBe("table");
  });

  it("流式期未闭合 Setext 下划线前缀不把上文段落提前改写为 heading", () => {
    const s1 = lexMarkdownBlocks("第一段正文\n", true);
    const s2 = lexMarkdownBlocks("第一段正文\n-", true);
    const s3 = lexMarkdownBlocks("第一段正文\n- 列表项", true);

    expect(s1[0]).toMatchObject({ key: "b:0", type: "paragraph", sig: "第一段正文" });
    expect(s2[0]).toMatchObject({ key: "b:0", type: "paragraph", sig: "第一段正文" });
    expect(s3[0]).toMatchObject({ key: "b:0", type: "paragraph", sig: "第一段正文" });
    expect(s3[1]?.type).toBe("list");
  });
});

describe("Conversation 流式输出与实时转历史交接（ADR-0128）", () => {
  it("短会话：追加分片与实时消息转为正式条目期间，首段 DOM 节点与浏览器选区保持不变且终态与历史回放一致", () => {
    const view = createSessionView();
    const session = stubSession("short-handoff");
    const images = createAttachmentImageSource();
    const openUrl = vi.fn();
    let seq = 1;
    const emit = (ev: Record<string, unknown>) => {
      const full = {
        time: "2026-11-26T10:00:00.000Z",
        ...(ev.durable === true ? { seq: seq++ } : {}),
        ...ev,
      } as unknown as RuntimeEvent;
      reduceSessionView(view, full);
    };

    emit({ type: "turn.started", durable: true, turnId: "t1", payload: { turnIndex: 1 } });
    emit({
      type: "message.user",
      durable: true,
      turnId: "t1",
      payload: { messageId: "u1", content: [{ type: "text", text: "请输出测试回复" }] },
    });
    for (let i = 0; i < 3; i += 1) {
      emit({
        type: "message.assistant.delta",
        turnId: "t1",
        payload: { messageId: "m1", kind: "text", delta: STREAM_CHUNKS[i] },
      });
    }

    const { container, rerender } = render(
      <Conversation
        session={session}
        view={view}
        openUrl={openUrl}
        cwd="Z:/project"
        subscribeEvents={() => () => undefined}
        images={images}
        busy
      />,
    );

    const articleBefore = container.querySelector<HTMLElement>("article.a");
    const p1Before = articleBefore?.querySelector<HTMLParagraphElement>(".conversation-markdown p");
    if (!articleBefore || !p1Before) throw new Error("expected live assistant paragraph");
    const textNodeBefore = selectPhraseIn(p1Before, SELECTED_PHRASE);
    expect(window.getSelection()?.toString()).toBe(SELECTED_PHRASE);

    // 依次流入表格（含未闭合分隔行）、Lean 代码块与后置链接定义
    for (let i = 3; i < STREAM_CHUNKS.length; i += 1) {
      emit({
        type: "message.assistant.delta",
        turnId: "t1",
        payload: { messageId: "m1", kind: "text", delta: STREAM_CHUNKS[i] },
      });
      rerender(
        <Conversation
          session={session}
          view={view}
          openUrl={openUrl}
          cwd="Z:/project"
          subscribeEvents={() => () => undefined}
          images={images}
          busy
        />,
      );
      if (i === 5) {
        // 分隔行尚未换行，不提前排版表格
        expect(articleBefore.querySelector("table")).toBeNull();
      }
      if (i === 6) {
        // 分隔行换行闭合后立即排版表格
        expect(articleBefore.querySelector("table")).not.toBeNull();
      }
      expect(container.querySelector("article.a")).toBe(articleBefore);
      expect(articleBefore.querySelector(".conversation-markdown p")).toBe(p1Before);
      expect(textNodeBefore.isConnected).toBe(true);
      expect(window.getSelection()?.toString()).toBe(SELECTED_PHRASE);
      expect(window.getSelection()?.getRangeAt(0).startContainer).toBe(textNodeBefore);
    }

    // 实时回复转为正式条目并完成本轮
    emit({
      type: "message.assistant",
      durable: true,
      turnId: "t1",
      payload: {
        messageId: "m1",
        content: [{ type: "text", text: FULL_REPLY }],
        toolCalls: [],
        model: { provider: "fake", model: "fake-1" },
        finishReason: "stop",
      },
    });
    emit({
      type: "turn.completed",
      durable: true,
      turnId: "t1",
      payload: {
        turnIndex: 1,
        reason: "done",
        steps: 1,
        usage: { inputTokens: 1, outputTokens: 2 },
      },
    });

    rerender(
      <Conversation
        session={session}
        view={view}
        openUrl={openUrl}
        cwd="Z:/project"
        subscribeEvents={() => () => undefined}
        images={images}
        busy={false}
      />,
    );

    // 交接后为同一个 DOM 节点，选区完整保留
    expect(container.querySelector("article.a")).toBe(articleBefore);
    expect(articleBefore.getAttribute("aria-label")).toBe("助手消息");
    expect(articleBefore.querySelector(".conversation-markdown p")).toBe(p1Before);
    expect(textNodeBefore.isConnected).toBe(true);
    expect(window.getSelection()?.toString()).toBe(SELECTED_PHRASE);
    expect(window.getSelection()?.getRangeAt(0).startContainer).toBe(textNodeBefore);

    // 后置链接定义解析结果与直接历史回放一致
    const link = articleBefore.querySelector<HTMLAnchorElement>(
      'a[href="https://example.com/adr-0128"]',
    );
    expect(link?.textContent).toBe("规范");

    const liveFinalHtml = articleBefore.querySelector(".conversation-markdown")?.innerHTML;
    const replay = render(<Markdown text={FULL_REPLY} openUrl={openUrl} />);
    expect(liveFinalHtml).toBe(replay.container.querySelector(".conversation-markdown")?.innerHTML);
  });

  it("启用虚拟列表的长会话：用户上滚并选中首段后，实时消息转为正式条目不消失、不卸载、保留选区", () => {
    const { view, nextSeq } = buildLongHistoryView(120);
    let seq = nextSeq;
    const session = stubSession("virtual-handoff");
    const images = createAttachmentImageSource();
    const openUrl = vi.fn();
    const emit = (ev: Record<string, unknown>) => {
      const full = {
        time: "2026-11-26T10:00:00.000Z",
        ...(ev.durable === true ? { seq: seq++ } : {}),
        ...ev,
      } as unknown as RuntimeEvent;
      reduceSessionView(view, full);
    };

    emit({ type: "turn.started", durable: true, turnId: "t-live", payload: { turnIndex: 61 } });
    emit({
      type: "message.user",
      durable: true,
      turnId: "t-live",
      payload: { messageId: "u-live", content: [{ type: "text", text: "长会话流式测试" }] },
    });
    for (let i = 0; i < 3; i += 1) {
      emit({
        type: "message.assistant.delta",
        turnId: "t-live",
        payload: { messageId: "m-live", kind: "text", delta: STREAM_CHUNKS[i] },
      });
    }

    const { container, rerender } = render(
      <Conversation
        session={session}
        view={view}
        openUrl={openUrl}
        cwd="Z:/project"
        subscribeEvents={() => () => undefined}
        images={images}
        busy
        virtualize
      />,
    );

    const region = screen.getByRole("region", { name: "会话消息" });
    mockScrollMetrics(region, { clientHeight: 844, scrollHeight: 10000, scrollTop: 9156 });
    fireEvent.scroll(region);
    // 用户上滚取消贴底跟随
    region.scrollTop = 9000;
    fireEvent.scroll(region);
    expect(screen.getByRole("button", { name: "回到最新消息" })).toBeTruthy();

    const liveArticle = container.querySelector<HTMLElement>(
      'article.a[aria-label="助手实时回复"]',
    );
    const p1Before = liveArticle?.querySelector<HTMLParagraphElement>(".conversation-markdown p");
    if (!liveArticle || !p1Before) throw new Error("expected virtualized live assistant");
    const textNodeBefore = selectPhraseIn(p1Before, SELECTED_PHRASE);

    // 流入后续内容并完成交接
    for (let i = 3; i < STREAM_CHUNKS.length; i += 1) {
      emit({
        type: "message.assistant.delta",
        turnId: "t-live",
        payload: { messageId: "m-live", kind: "text", delta: STREAM_CHUNKS[i] },
      });
    }
    rerender(
      <Conversation
        session={session}
        view={view}
        openUrl={openUrl}
        cwd="Z:/project"
        subscribeEvents={() => () => undefined}
        images={images}
        busy
        virtualize
      />,
    );

    emit({
      type: "message.assistant",
      durable: true,
      turnId: "t-live",
      payload: {
        messageId: "m-live",
        content: [{ type: "text", text: FULL_REPLY }],
        toolCalls: [],
        model: { provider: "fake", model: "fake-1" },
        finishReason: "stop",
      },
    });
    emit({
      type: "turn.completed",
      durable: true,
      turnId: "t-live",
      payload: {
        turnIndex: 61,
        reason: "done",
        steps: 1,
        usage: { inputTokens: 1, outputTokens: 2 },
      },
    });

    rerender(
      <Conversation
        session={session}
        view={view}
        openUrl={openUrl}
        cwd="Z:/project"
        subscribeEvents={() => () => undefined}
        images={images}
        busy={false}
        virtualize
      />,
    );

    // 正式条目不得落进 spacer 消失，且复用同一个 DOM 节点与选区
    expect(liveArticle.isConnected).toBe(true);
    expect(liveArticle.getAttribute("aria-label")).toBe("助手消息");
    expect(liveArticle.closest(".conversation-virtual-list")).not.toBeNull();
    expect(textNodeBefore.isConnected).toBe(true);
    expect(window.getSelection()?.toString()).toBe(SELECTED_PHRASE);
    expect(window.getSelection()?.getRangeAt(0).startContainer).toBe(textNodeBefore);

    // 清空选区并滚到顶部后，该条目可被正常虚拟化回收
    window.getSelection()?.removeAllRanges();
    region.scrollTop = 0;
    fireEvent.scroll(region);
    expect(liveArticle.isConnected).toBe(false);
  });

  it("停止中断后保留已收到的未闭合内容、原 DOM 节点和选区，并展示中断标记", () => {
    const view = createSessionView();
    const session = stubSession("abort-handoff");
    const images = createAttachmentImageSource();
    const openUrl = vi.fn();
    let seq = 1;
    const emit = (ev: Record<string, unknown>) => {
      const full = {
        time: "2026-11-26T10:00:00.000Z",
        ...(ev.durable === true ? { seq: seq++ } : {}),
        ...ev,
      } as unknown as RuntimeEvent;
      reduceSessionView(view, full);
    };

    const partialChunks = STREAM_CHUNKS.slice(0, 10);
    const partialText = partialChunks.join("");

    emit({ type: "turn.started", durable: true, turnId: "t1", payload: { turnIndex: 1 } });
    emit({
      type: "message.user",
      durable: true,
      turnId: "t1",
      payload: { messageId: "u1", content: [{ type: "text", text: "测试中断" }] },
    });
    for (let i = 0; i < 3; i += 1) {
      emit({
        type: "message.assistant.delta",
        turnId: "t1",
        payload: { messageId: "m1", kind: "text", delta: partialChunks[i] },
      });
    }

    const { container, rerender } = render(
      <Conversation
        session={session}
        view={view}
        openUrl={openUrl}
        cwd="Z:/project"
        subscribeEvents={() => () => undefined}
        images={images}
        busy
      />,
    );

    const articleBefore = container.querySelector<HTMLElement>("article.a");
    const p1Before = articleBefore?.querySelector<HTMLParagraphElement>(".conversation-markdown p");
    if (!articleBefore || !p1Before) throw new Error("expected live assistant");
    const textNodeBefore = selectPhraseIn(p1Before, SELECTED_PHRASE);

    for (let i = 3; i < partialChunks.length; i += 1) {
      emit({
        type: "message.assistant.delta",
        turnId: "t1",
        payload: { messageId: "m1", kind: "text", delta: partialChunks[i] },
      });
    }
    rerender(
      <Conversation
        session={session}
        view={view}
        openUrl={openUrl}
        cwd="Z:/project"
        subscribeEvents={() => () => undefined}
        images={images}
        busy
      />,
    );

    emit({
      type: "message.assistant",
      durable: true,
      turnId: "t1",
      payload: {
        messageId: "m1",
        content: [{ type: "text", text: partialText }],
        toolCalls: [],
        model: { provider: "fake", model: "fake-1" },
        finishReason: "aborted",
      },
    });
    emit({
      type: "turn.completed",
      durable: true,
      turnId: "t1",
      payload: {
        turnIndex: 1,
        reason: "aborted",
        steps: 1,
        usage: { inputTokens: 1, outputTokens: 2 },
      },
    });

    rerender(
      <Conversation
        session={session}
        view={view}
        openUrl={openUrl}
        cwd="Z:/project"
        subscribeEvents={() => () => undefined}
        images={images}
        busy={false}
      />,
    );

    expect(container.querySelector("article.a")).toBe(articleBefore);
    expect(textNodeBefore.isConnected).toBe(true);
    expect(window.getSelection()?.toString()).toBe(SELECTED_PHRASE);
    expect(articleBefore.textContent).toContain("theorem add_comm_demo");
    expect(articleBefore.textContent).toContain("回复已中断");
  });

  it("流式期 Setext 下划线前缀到达时不把上方段落临时改成 h2 导致选区丢失", () => {
    const openUrl = vi.fn();
    const { container, rerender } = render(
      <Markdown text={"第一段需要稳定选中的文字\n"} openUrl={openUrl} streaming />,
    );
    const p1 = container.querySelector<HTMLParagraphElement>(".conversation-markdown p");
    if (!p1) throw new Error("expected paragraph");
    const textNode = selectPhraseIn(p1, "需要稳定选中");

    rerender(<Markdown text={"第一段需要稳定选中的文字\n-"} openUrl={openUrl} streaming />);
    expect(container.querySelector("h2")).toBeNull();
    expect(container.querySelector(".conversation-markdown p")).toBe(p1);
    expect(textNode.isConnected).toBe(true);
    expect(window.getSelection()?.toString()).toBe("需要稳定选中");

    rerender(
      <Markdown text={"第一段需要稳定选中的文字\n- 列表第一项"} openUrl={openUrl} streaming />,
    );
    expect(container.querySelector(".conversation-markdown p")).toBe(p1);
    expect(container.querySelector("ul li")?.textContent).toContain("列表第一项");
    expect(textNode.isConnected).toBe(true);
    expect(window.getSelection()?.toString()).toBe("需要稳定选中");
  });

  it("交接完成后文件链接解析与复制回复原文正常工作", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const session = stubSession("links-copy");
    (session.resolveFiles as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        input: "src/app.ts",
        absolutePath: "Z:/project/src/app.ts",
        relativePath: "src/app.ts",
        withinWorkspace: true,
        exists: true,
        isDirectory: false,
      },
    ]);
    const fileLinks = {
      open: vi.fn(() => Promise.resolve()),
      outsideOpenable: () => true,
      editors: () => ({ vscode: false, cursor: false }),
      openInEditor: vi.fn(() => Promise.resolve()),
      openFolder: vi.fn(() => Promise.resolve()),
      copy: vi.fn(() => Promise.resolve()),
      reveal: vi.fn(() => Promise.resolve()),
    };

    const view = createSessionView();
    const images = createAttachmentImageSource();
    const openUrl = vi.fn();
    const body = "第一段结论。\n\n详见 `src/app.ts`。\n";
    let seq = 1;
    const emit = (ev: Record<string, unknown>) => {
      reduceSessionView(view, {
        time: "2026-11-26T10:00:00.000Z",
        ...(ev.durable === true ? { seq: seq++ } : {}),
        ...ev,
      } as unknown as RuntimeEvent);
    };

    emit({ type: "turn.started", durable: true, turnId: "t1", payload: { turnIndex: 1 } });
    emit({
      type: "message.user",
      durable: true,
      turnId: "t1",
      payload: { messageId: "u1", content: [{ type: "text", text: "文件链接测试" }] },
    });
    emit({
      type: "message.assistant.delta",
      turnId: "t1",
      payload: { messageId: "m1", kind: "text", delta: body },
    });

    const { container, rerender } = render(
      <Conversation
        session={session}
        view={view}
        openUrl={openUrl}
        cwd="Z:/project"
        subscribeEvents={() => () => undefined}
        images={images}
        fileLinks={fileLinks}
        busy
      />,
    );
    // 流式期间不链接化
    expect(container.querySelector(".file-ref-link")).toBeNull();

    emit({
      type: "message.assistant",
      durable: true,
      turnId: "t1",
      payload: {
        messageId: "m1",
        content: [{ type: "text", text: body }],
        toolCalls: [],
        model: { provider: "fake", model: "fake-1" },
        finishReason: "stop",
      },
    });
    emit({
      type: "turn.completed",
      durable: true,
      turnId: "t1",
      payload: {
        turnIndex: 1,
        reason: "done",
        steps: 1,
        usage: { inputTokens: 1, outputTokens: 2 },
      },
    });

    rerender(
      <Conversation
        session={session}
        view={view}
        openUrl={openUrl}
        cwd="Z:/project"
        subscribeEvents={() => () => undefined}
        images={images}
        fileLinks={fileLinks}
        busy={false}
      />,
    );

    const fileLink = await waitFor(() => {
      const el = container.querySelector<HTMLElement>(".file-ref-link");
      if (!el) throw new Error("waiting for file ref link");
      return el;
    });
    fireEvent.click(fileLink);
    expect(fileLinks.open).toHaveBeenCalledWith("Z:/project/src/app.ts", undefined, {
      endLine: undefined,
    });

    fireEvent.click(screen.getByRole("button", { name: "复制回复" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(body));
  });
});
