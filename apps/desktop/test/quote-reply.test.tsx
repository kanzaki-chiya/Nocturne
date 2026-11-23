// @vitest-environment jsdom
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSessionView,
  formatQuotesBlock,
  type AssistantEntry,
  type MessageQuote,
  type SessionView,
  type ToolEntry,
  type UserEntry,
} from "@nocturne/core/protocol";
import type { RpcSession } from "@nocturne/rpc/client";

import { createAttachmentImageSource } from "../src/attachment-images";
import { Composer, type ComposerSubmit } from "../src/Composer";
import { Conversation } from "../src/Conversation";
import { QUOTE_FLASH_HIGHLIGHT, addDraftQuote, removeDraftQuote } from "../src/quote-reply";

function stubSession(id = "session-quote"): RpcSession {
  return {
    id,
    readAttachment: vi.fn(() => Promise.reject(new Error("no attachment"))),
    respondPermission: vi.fn(() => Promise.resolve()),
    respondSubagentPermission: vi.fn(() => Promise.resolve()),
    respondQuestion: vi.fn(() => Promise.resolve()),
    readInputHistory: vi.fn(() => Promise.resolve([])),
    recordInputHistory: vi.fn(() => Promise.resolve()),
  } as unknown as RpcSession;
}

function makeUser(
  seq: number,
  text: string,
  quotes?: MessageQuote[],
  extra?: Partial<UserEntry>,
): UserEntry {
  return {
    kind: "user",
    key: `u:${String(seq)}`,
    turnId: `turn-${String(seq)}`,
    seq,
    content: [
      ...(quotes?.length ? [{ type: "text" as const, text: formatQuotesBlock(quotes) }] : []),
      { type: "text", text },
    ],
    attachments: [],
    fileRefs: [],
    ...(quotes?.length ? { quotes } : {}),
    ...extra,
  };
}

function makeAssistant(seq: number, text: string, reasoning = ""): AssistantEntry {
  return {
    kind: "assistant",
    key: `a:${String(seq)}`,
    turnId: `turn-${String(seq)}`,
    messageId: `msg-${String(seq)}`,
    seq,
    time: "2026-11-24T10:00:00.000Z",
    text,
    reasoning,
    toolCalls: [],
    model: { provider: "fake", model: "fake-1" },
    usage: undefined,
    finishReason: "stop",
  };
}

function makeTool(seq: number, content: string): ToolEntry {
  return {
    kind: "tool",
    key: `t:call-${String(seq)}`,
    turnId: `turn-${String(seq)}`,
    callId: `call-${String(seq)}`,
    name: "read",
    seq,
    completedSeq: seq,
    status: "ok",
    input: { path: content },
    subjects: [],
    permission: undefined,
    resolution: undefined,
    liveOutput: "",
    result: {
      status: "ok",
      durationMs: 5,
      output: { path: content },
      error: undefined,
      truncated: false,
      spillPath: undefined,
      modelContent: content,
    },
  };
}

function makeView(entries: SessionView["entries"]): SessionView {
  const view = createSessionView();
  return {
    ...view,
    entries,
    lastSeq: entries.at(-1)?.seq ?? 0,
  };
}

function mockSelectionOnText(
  startNode: Node,
  startOffset: number,
  endNode: Node,
  endOffset: number,
  selectedText: string,
  rect: Partial<DOMRect> = { left: 100, top: 120, width: 160, height: 20, right: 260, bottom: 140 },
) {
  const fullRect = {
    x: rect.left ?? 100,
    y: rect.top ?? 120,
    left: rect.left ?? 100,
    top: rect.top ?? 120,
    width: rect.width ?? 160,
    height: rect.height ?? 20,
    right: rect.right ?? (rect.left ?? 100) + (rect.width ?? 160),
    bottom: rect.bottom ?? (rect.top ?? 120) + (rect.height ?? 20),
    toJSON: () => ({}),
  } as DOMRect;
  const fakeRange = {
    startContainer: startNode,
    startOffset,
    endContainer: endNode,
    endOffset,
    getClientRects: () => [fullRect],
    getBoundingClientRect: () => fullRect,
  } as unknown as Range;
  const removeAllRanges = vi.fn();
  const fakeSelection = {
    isCollapsed: false,
    rangeCount: 1,
    getRangeAt: () => fakeRange,
    toString: () => selectedText,
    removeAllRanges,
  } as unknown as Selection;
  vi.spyOn(window, "getSelection").mockReturnValue(fakeSelection);
  return { removeAllRanges };
}

function firstTextNodeContaining(root: Element, needle: string): Text {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node !== null) {
    if (node.textContent?.includes(needle)) return node as Text;
    node = walker.nextNode();
  }
  throw new Error(`Text node containing "${needle}" not found`);
}

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => "blob:test");
  URL.revokeObjectURL = vi.fn();
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe = vi.fn();
      disconnect = vi.fn();
    },
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe = vi.fn();
      disconnect = vi.fn();
    },
  );
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("桌面选中引用回复（ADR-0116）", () => {
  it("一条消息内选中出现「回复」，跨消息、思考内容、工具卡片不出现，Esc 消失", () => {
    const onQuote = vi.fn();
    const view = makeView([
      makeUser(1, "重试策略怎么设计？"),
      makeAssistant(
        2,
        "建议按错误类型处理：\n\n- 超过 3 次改成指数退避，间隔上限 30 秒\n\n```ts\nconst maxDelay = 30_000;\n```",
        "内部思考过程，不该被引用",
      ),
      makeTool(3, "src/retry.ts"),
    ]);
    const { container } = render(
      <Conversation
        session={stubSession()}
        view={view}
        cwd="/ws"
        subscribeEvents={() => () => undefined}
        images={createAttachmentImageSource()}
        busy={false}
        openUrl={vi.fn()}
        onQuote={onQuote}
      />,
    );

    const scrollEl = container.querySelector<HTMLElement>(".conversation-scroll");
    if (scrollEl === null) throw new Error("missing .conversation-scroll");
    vi.spyOn(scrollEl, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      width: 800,
      height: 600,
      right: 800,
      bottom: 600,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    const convEl = container.querySelector<HTMLElement>(".conversation");
    if (convEl === null) throw new Error("missing .conversation");
    vi.spyOn(convEl, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      width: 800,
      height: 600,
      right: 800,
      bottom: 600,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    // 1) 助手回答单条消息内选中 → 出现「回复」按钮
    const assistantNode = firstTextNodeContaining(container, "超过 3 次改成指数退避");
    const { removeAllRanges } = mockSelectionOnText(
      assistantNode,
      0,
      assistantNode,
      10,
      "超过 3 次改成指数退避",
    );
    fireEvent(document, new Event("selectionchange"));
    const btn = screen.getByRole("button", { name: "回复" });
    expect(btn).toBeTruthy();

    // 按 Esc 消失
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("button", { name: "回复" })).toBeNull();

    // 重新触发选区变化后再次出现，点「回复」触发回调并清除选区
    fireEvent(document, new Event("selectionchange"));
    fireEvent.click(screen.getByRole("button", { name: "回复" }));
    expect(onQuote).toHaveBeenCalledWith({ text: "超过 3 次改成指数退避", seq: 2 });
    expect(removeAllRanges).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "回复" })).toBeNull();

    // 2) 代码块内选中 → 同样可引用
    const codeNode = firstTextNodeContaining(container, "maxDelay");
    mockSelectionOnText(codeNode, 0, codeNode, 8, "const maxDelay = 30_000;");
    fireEvent(document, new Event("selectionchange"));
    expect(screen.getByRole("button", { name: "回复" })).toBeTruthy();

    // 3) 跨消息选中（从用户消息到助手消息）→ 不出现
    const userNode = firstTextNodeContaining(container, "重试策略怎么设计？");
    mockSelectionOnText(userNode, 0, assistantNode, 5, "重试策略怎么设计？\n超过 3 次");
    fireEvent(document, new Event("selectionchange"));
    expect(screen.queryByRole("button", { name: "回复" })).toBeNull();

    // 4) 思考内容内选中 → 不出现
    const thinkToggle = container.querySelector<HTMLElement>(".think-h");
    if (thinkToggle === null) throw new Error("missing .think-h");
    fireEvent.click(thinkToggle);
    const thinkEl = container.querySelector(".think");
    if (thinkEl === null) throw new Error("missing .think");
    const thinkNode = firstTextNodeContaining(thinkEl, "内部思考过程");
    mockSelectionOnText(thinkNode, 0, thinkNode, 6, "内部思考过程");
    fireEvent(document, new Event("selectionchange"));
    expect(screen.queryByRole("button", { name: "回复" })).toBeNull();

    // 5) 工具卡片内选中 → 不出现
    const toolEl = container.querySelector<HTMLElement>('[data-session-seq="3"]');
    expect(toolEl).toBeTruthy();
    if (toolEl === null) throw new Error("missing tool element");
    const toolNode = firstTextNodeContaining(toolEl, "retry.ts");
    mockSelectionOnText(toolNode, 0, toolNode, 5, "retry.ts");
    fireEvent(document, new Event("selectionchange"));
    expect(screen.queryByRole("button", { name: "回复" })).toBeNull();
  });

  it("点「回复」进入输入框、去重、× 移除、切会话保留、仅引用可发、发送后清空", async () => {
    const submitted: { sessionId: string; input: ComposerSubmit }[] = [];

    function Harness() {
      const [sessionId, setSessionId] = useState("sess-a");
      const [quotesBySession, setQuotesBySession] = useState<
        ReadonlyMap<string, readonly MessageQuote[]>
      >(() => new Map());
      const [focusNonce, setFocusNonce] = useState(0);

      const add = (quote: MessageQuote) => {
        setQuotesBySession((prev) => {
          const cur = prev.get(sessionId) ?? [];
          const next = addDraftQuote(cur, quote);
          return new Map(prev).set(sessionId, next);
        });
        setFocusNonce((n) => n + 1);
      };

      const remove = (index: number) => {
        setQuotesBySession((prev) => {
          const cur = prev.get(sessionId) ?? [];
          const next = removeDraftQuote(cur, index);
          const copy = new Map(prev);
          if (next.length === 0) copy.delete(sessionId);
          else copy.set(sessionId, next);
          return copy;
        });
      };

      return (
        <div>
          <button
            type="button"
            onClick={() => {
              add({ text: "第一段引用", seq: 2 });
            }}
          >
            添加一
          </button>
          <button
            type="button"
            onClick={() => {
              add({ text: "第二段引用", seq: 4 });
            }}
          >
            添加二
          </button>
          <button
            type="button"
            onClick={() => {
              setSessionId(sessionId === "sess-a" ? "sess-b" : "sess-a");
            }}
          >
            切换会话
          </button>
          <Composer
            key={sessionId}
            variant="session"
            running={false}
            fileRefs={{ key: "ws", load: () => Promise.resolve([]) }}
            pickImages={vi.fn(() => Promise.resolve([]))}
            onSlash={vi.fn()}
            quotes={quotesBySession.get(sessionId)}
            onRemoveQuote={remove}
            focusNonce={focusNonce}
            onSubmit={(input) => {
              submitted.push({ sessionId, input });
              setQuotesBySession((prev) => {
                const copy = new Map(prev);
                copy.delete(sessionId);
                return copy;
              });
              return true;
            }}
            onInterrupt={vi.fn()}
          />
        </div>
      );
    }

    render(<Harness />);
    const textarea = () => screen.getByRole("textbox");

    // 添加两段，再重复添加第一段 → 去重，且光标进入输入框
    fireEvent.click(screen.getByText("添加一"));
    expect(document.activeElement).toBe(textarea());
    fireEvent.click(screen.getByText("添加二"));
    fireEvent.click(screen.getByText("添加一"));
    expect(screen.getAllByLabelText("移除引用")).toHaveLength(2);
    expect(screen.getByText("第一段引用").getAttribute("title")).toBe("第一段引用");
    expect(screen.getByText("第二段引用").getAttribute("title")).toBe("第二段引用");

    // 切到 sess-b 再切回 sess-a，引用随草稿保留
    fireEvent.click(screen.getByText("切换会话"));
    expect(screen.queryByLabelText("移除引用")).toBeNull();
    fireEvent.click(screen.getByText("切换会话"));
    expect(screen.getAllByLabelText("移除引用")).toHaveLength(2);

    // 点 × 移除第一段
    const firstRemove = screen.getAllByLabelText("移除引用")[0];
    if (firstRemove === undefined) throw new Error("missing remove button");
    fireEvent.click(firstRemove);
    expect(screen.getAllByLabelText("移除引用")).toHaveLength(1);
    expect(screen.queryByText("第一段引用")).toBeNull();
    expect(screen.getByText("第二段引用")).toBeTruthy();

    // 正文为空、只有引用时也可以发送，发送后清空
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => {
      expect(submitted).toHaveLength(1);
    });
    expect(submitted[0]).toEqual({
      sessionId: "sess-a",
      input: expect.objectContaining({
        text: "",
        quotes: [{ text: "第二段引用", seq: 4 }],
      }),
    });
    expect(screen.queryByLabelText("移除引用")).toBeNull();
  });

  it("已发消息引用显示在正文上方并可点击跳回高亮；来源被回退撤掉时点击无反应", () => {
    vi.useFakeTimers();
    const highlightsMap = new Map<string, unknown>();
    class FakeHighlight {
      ranges: AbstractRange[];
      constructor(...ranges: AbstractRange[]) {
        this.ranges = ranges;
      }
    }
    vi.stubGlobal("CSS", {
      highlights: {
        set: (name: string, val: unknown) => highlightsMap.set(name, val),
        delete: (name: string) => highlightsMap.delete(name),
      },
    });
    vi.stubGlobal("Highlight", FakeHighlight);

    const view = makeView([
      makeAssistant(2, "超过 3 次改成指数退避，间隔上限 30 秒。"),
      makeUser(5, "上限改成 60 秒", [
        { text: "超过 3 次改成指数退避，间隔上限 30 秒", seq: 2 },
        { text: "这条来源已经被回退撤掉了", seq: 99 },
      ]),
    ]);

    const { container } = render(
      <Conversation
        session={stubSession()}
        view={view}
        cwd="/ws"
        subscribeEvents={() => () => undefined}
        images={createAttachmentImageSource()}
        busy={false}
        openUrl={vi.fn()}
        onQuote={vi.fn()}
      />,
    );

    // 用户消息正文中不显示首块 `> ` 原文，引用显示在正文上方
    const userBubble = container.querySelector<HTMLElement>('[data-session-seq="5"] .u-bubble');
    if (userBubble === null) throw new Error("missing user bubble");
    const uText = userBubble.querySelector<HTMLElement>(".u-text");
    if (uText === null) throw new Error("missing .u-text");
    expect(uText.textContent).toBe("上限改成 60 秒");
    const quoteButtons = userBubble.querySelectorAll<HTMLButtonElement>(".u-quote");
    expect(quoteButtons).toHaveLength(2);
    const firstQuoteBtn = quoteButtons[0];
    const secondQuoteBtn = quoteButtons[1];
    if (firstQuoteBtn === undefined || secondQuoteBtn === undefined) {
      throw new Error("missing quote buttons");
    }
    expect(firstQuoteBtn.dataset.jumpable).toBe("true");
    expect(secondQuoteBtn.dataset.jumpable).toBeUndefined();

    // 点击被撤掉来源的引用 → 无滚动、无高亮
    const scrollSpy = vi.mocked(Element.prototype.scrollIntoView);
    scrollSpy.mockClear();
    fireEvent.click(secondQuoteBtn);
    expect(scrollSpy).not.toHaveBeenCalled();
    expect(highlightsMap.size).toBe(0);

    // 点击有效来源引用 → 滚动并高亮原文，约 1 秒后淡出清除
    fireEvent.click(firstQuoteBtn);
    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(scrollSpy).toHaveBeenCalled();
    expect(highlightsMap.has(QUOTE_FLASH_HIGHLIGHT)).toBe(true);
    const sourceArticle = container.querySelector<HTMLElement>('[data-session-seq="2"]');
    if (sourceArticle === null) throw new Error("missing source article");
    expect(sourceArticle.dataset.quoteFlash).toBe("text");

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(highlightsMap.size).toBe(0);
    expect(sourceArticle.dataset.quoteFlash).toBeUndefined();
  });

  it("手机网页（remote，无 onQuote）与子代理只读视图不出现「回复」按钮，但照常显示已发引用", () => {
    const view = makeView([
      makeAssistant(2, "手机网页上显示助手回答内容"),
      makeUser(3, "收到", [{ text: "手机网页上显示助手回答内容", seq: 2 }]),
    ]);

    const { container } = render(
      <Conversation
        session={stubSession()}
        view={view}
        cwd="/ws"
        subscribeEvents={() => () => undefined}
        images={createAttachmentImageSource()}
        busy={false}
        openUrl={vi.fn()}
        remote
        hidePersistentPermissions
        hideRequests
      />,
    );

    // 复用显示已发引用
    expect(container.querySelectorAll(".u-quote")).toHaveLength(1);

    // 选中文字也不出现「回复」按钮
    const node = firstTextNodeContaining(container, "手机网页上显示助手回答内容");
    mockSelectionOnText(node, 0, node, 6, "手机网页上显示");
    fireEvent(document, new Event("selectionchange"));
    expect(screen.queryByRole("button", { name: "回复" })).toBeNull();
  });
});
