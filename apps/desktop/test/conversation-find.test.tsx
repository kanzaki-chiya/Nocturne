import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSessionView,
  type AssistantEntry,
  type NoticeEntry,
  type SessionView,
  type ToolEntry,
  type UserEntry,
  type ViewEntry,
} from "@nocturne/core/protocol";
import type { RpcSession } from "@nocturne/rpc/client";

import { Conversation } from "../src/Conversation";
import { createAttachmentImageSource } from "../src/attachment-images";
import {
  applyConversationHighlights,
  collectElementMatchRanges,
  FIND_DEBOUNCE_MS,
  findConversationMatches,
  HIGHLIGHT_ALL,
  HIGHLIGHT_CURRENT,
  pickInitialMatchIndex,
  stepMatchIndex,
} from "../src/conversation-find";

function stubSession(id = "session-find"): RpcSession {
  return {
    id,
    readAttachment: vi.fn(() => Promise.reject(new Error("no attachment"))),
    respondPermission: vi.fn(() => Promise.resolve()),
    respondSubagentPermission: vi.fn(() => Promise.resolve()),
    respondQuestion: vi.fn(() => Promise.resolve()),
  } as unknown as RpcSession;
}

function makeUser(seq: number, text: string, extra?: Partial<UserEntry>): UserEntry {
  return {
    kind: "user",
    key: `u:${String(seq)}`,
    turnId: `turn-${String(seq)}`,
    seq,
    content: [{ type: "text", text }],
    attachments: [],
    fileRefs: [],
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
    time: "2026-11-21T10:00:00.000Z",
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

function makeNotice(seq: number, message: string): NoticeEntry {
  return {
    kind: "notice",
    key: `n:${String(seq)}`,
    seq,
    subtype: "turn_end",
    message,
    payload: { reason: "done" },
  };
}

function makeView(entries: ViewEntry[]): SessionView {
  const view = createSessionView();
  view.entries = entries;
  view.lastSeq = entries.at(-1)?.seq ?? 0;
  return view;
}

class FakeHighlight {
  ranges: AbstractRange[];
  constructor(...ranges: AbstractRange[]) {
    this.ranges = ranges;
  }
}

function installFakeHighlights(): Map<string, FakeHighlight> {
  const registry = new Map<string, FakeHighlight>();
  (globalThis as unknown as { CSS?: unknown }).CSS = { highlights: registry };
  (globalThis as unknown as { Highlight?: unknown }).Highlight = FakeHighlight;
  return registry;
}

function removeFakeHighlights(): void {
  delete (globalThis as unknown as { CSS?: unknown }).CSS;
  delete (globalThis as unknown as { Highlight?: unknown }).Highlight;
}

const scrollIntoViewMock = vi.fn();

beforeEach(() => {
  scrollIntoViewMock.mockReset();
  Element.prototype.scrollIntoView = scrollIntoViewMock;
});

afterEach(() => {
  cleanup();
  removeFakeHighlights();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("conversation-find 纯函数", () => {
  it("按大小写不敏感子串匹配用户与助手正文，跳过思考、工具与通知及非用户消息送达", () => {
    const entries: ViewEntry[] = [
      makeUser(1, "合进来之后把 Worktree 和分支都删掉"),
      makeTool(2, "worktree inside tool output"),
      makeAssistant(3, "已删除这个 worktree，顺便清理了临时目录", "reasoning mentions worktree"),
      makeAssistant(4, "这条回复只把关键词放在思考里", "worktree only in reasoning"),
      makeNotice(5, "worktree notice"),
      makeUser(6, "插话里也有 WORKTREE", { steer: true }),
      makeUser(7, "worktree in subagent result", {
        subagent: {
          childSessionId: "child-1",
          callId: "call-sub-1",
          status: "ok",
          profile: "quick",
        },
      }),
      makeUser(8, "worktree in background shell", {
        backgroundShell: {
          taskId: "bg-1",
          callId: "c-1",
          status: "exited",
          name: "echo worktree",
          exitCode: 0,
        },
      }),
    ];

    const matches = findConversationMatches(entries, "worktree");
    expect(matches).toEqual([
      { seq: 1, entryIndex: 0, kind: "user" },
      { seq: 3, entryIndex: 2, kind: "assistant" },
      { seq: 6, entryIndex: 5, kind: "user" },
    ]);
    expect(findConversationMatches(entries, "")).toEqual([]);
    expect(findConversationMatches(entries, "   ")).toEqual([]);
  });

  it("首次落点取视口顶部及以下最近的一处，无则取最后一处", () => {
    const matches = [
      { seq: 1, entryIndex: 2, kind: "user" as const },
      { seq: 5, entryIndex: 10, kind: "assistant" as const },
      { seq: 9, entryIndex: 20, kind: "assistant" as const },
    ];
    expect(pickInitialMatchIndex(matches, 0)).toBe(0);
    expect(pickInitialMatchIndex(matches, 10)).toBe(1);
    expect(pickInitialMatchIndex(matches, 11)).toBe(2);
    expect(pickInitialMatchIndex(matches, 25)).toBe(2);
    expect(pickInitialMatchIndex([], 0)).toBe(-1);
  });

  it("前后切换按条循环", () => {
    expect(stepMatchIndex(0, 3, 1)).toBe(1);
    expect(stepMatchIndex(2, 3, 1)).toBe(0);
    expect(stepMatchIndex(0, 3, -1)).toBe(2);
    expect(stepMatchIndex(1, 3, -1)).toBe(0);
    expect(stepMatchIndex(-1, 3, 1)).toBe(0);
    expect(stepMatchIndex(-1, 3, -1)).toBe(2);
    expect(stepMatchIndex(0, 0, 1)).toBe(-1);
  });

  it("collectElementMatchRanges 支持跨行内节点建 Range 且跳过代码块头部与跨块匹配", () => {
    const container = document.createElement("div");
    container.innerHTML =
      '<p>第一段 <strong>work</strong>tree 再次 WORKTREE</p><p>第二段 work</p><p>tree 不应跨段命中</p><div class="conversation-code"><div class="conversation-code-language"><span>worktree</span></div><pre><code>const x = "worktree";</code></pre></div>';
    const ranges = collectElementMatchRanges(container, "worktree");
    expect(ranges.map((r) => r.toString())).toEqual(["worktree", "WORKTREE", "worktree"]);
  });

  it("缺少 CSS.highlights 时安全跳过不报错；存在替身时分别写入当前与其他高亮", () => {
    const root = document.createElement("div");
    root.innerHTML =
      '<article class="u" data-session-seq="1"><div class="u-bubble"><div class="u-text">alpha one</div></div></article>' +
      '<article class="a" data-session-seq="2"><div class="conversation-markdown"><p>alpha two and alpha three</p></div></article>';

    // 无 CSS.highlights
    removeFakeHighlights();
    const noApi = applyConversationHighlights(root, "alpha", 2);
    expect(noApi).toEqual({ currentMounted: true, currentHasDomMatch: true });

    // 有替身
    const registry = installFakeHighlights();
    const withApi = applyConversationHighlights(root, "alpha", 2);
    expect(withApi).toEqual({ currentMounted: true, currentHasDomMatch: true });
    expect(registry.get(HIGHLIGHT_CURRENT)?.ranges.map((r) => r.toString())).toEqual([
      "alpha",
      "alpha",
    ]);
    expect(registry.get(HIGHLIGHT_ALL)?.ranges.map((r) => r.toString())).toEqual(["alpha"]);
  });
});

describe("Conversation 会话内搜索组件行为", () => {
  const noopSubscribe = () => () => undefined;

  it("Ctrl+F 打开并 preventDefault；Enter / Shift+Enter 切换计数；Esc 清空高亮并回焦输入框", async () => {
    vi.useFakeTimers();
    const registry = installFakeHighlights();
    const view = makeView([
      makeUser(1, "先看 worktree 状态"),
      makeAssistant(2, "当前 worktree 有两处改动，请确认 worktree 分支"),
      makeUser(3, "好的，保留 worktree"),
    ]);

    render(
      <div className="mainpane">
        <Conversation
          session={stubSession("s1")}
          view={view}
          openUrl={vi.fn()}
          cwd="Z:\\nocturne"
          subscribeEvents={noopSubscribe}
          images={createAttachmentImageSource()}
          busy={false}
          enableFind
        />
        <div className="composer">
          <textarea aria-label="消息输入" />
        </div>
      </div>,
    );

    const openEvent = new KeyboardEvent("keydown", {
      key: "f",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      window.dispatchEvent(openEvent);
    });
    expect(openEvent.defaultPrevented).toBe(true);

    const input = screen.getByRole("textbox", { name: "搜索会话" });
    expect(input.getAttribute("placeholder")).toBeNull();
    expect(screen.getByText("0/0")).toBeTruthy();

    fireEvent.change(input, { target: { value: "worktree" } });
    act(() => {
      vi.advanceTimersByTime(FIND_DEBOUNCE_MS);
    });
    expect(screen.getByText("1/3")).toBeTruthy();
    expect(registry.get(HIGHLIGHT_CURRENT)?.ranges).toHaveLength(1);
    expect(registry.get(HIGHLIGHT_ALL)?.ranges).toHaveLength(3);

    // Enter -> 第 2/3 条（含 2 处 worktree）
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByText("2/3")).toBeTruthy();
    expect(registry.get(HIGHLIGHT_CURRENT)?.ranges).toHaveLength(2);
    expect(registry.get(HIGHLIGHT_ALL)?.ranges).toHaveLength(2);

    // Shift+Enter -> 回到 1/3，再 Shift+Enter -> 循环到 3/3
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(screen.getByText("1/3")).toBeTruthy();
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(screen.getByText("3/3")).toBeTruthy();

    // Esc 关闭 -> 高亮清空，焦点回到输入框
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("textbox", { name: "搜索会话" })).toBeNull();
    expect(registry.size).toBe(0);
    expect(document.activeElement).toBe(screen.getByLabelText("消息输入"));
  });

  it("焦点在 .xterm、右侧面板或弹窗里时不接管 Ctrl+F", () => {
    const view = makeView([makeUser(1, "hello"), makeAssistant(2, "world")]);
    render(
      <div>
        <div className="mainpane">
          <Conversation
            session={stubSession("s2")}
            view={view}
            openUrl={vi.fn()}
            cwd="Z:\\nocturne"
            subscribeEvents={noopSubscribe}
            images={createAttachmentImageSource()}
            busy={false}
            enableFind
          />
        </div>
        <div className="side-panel">
          <div className="xterm">
            <textarea aria-label="终端输入" />
          </div>
          <input aria-label="面板过滤" />
        </div>
      </div>,
    );

    const xtermInput = screen.getByLabelText("终端输入");
    xtermInput.focus();
    const termEvent = new KeyboardEvent("keydown", {
      key: "f",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      xtermInput.dispatchEvent(termEvent);
    });
    expect(termEvent.defaultPrevented).toBe(false);
    expect(screen.queryByRole("textbox", { name: "搜索会话" })).toBeNull();

    const panelInput = screen.getByLabelText("面板过滤");
    panelInput.focus();
    const panelEvent = new KeyboardEvent("keydown", {
      key: "f",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      panelInput.dispatchEvent(panelEvent);
    });
    expect(panelEvent.defaultPrevented).toBe(false);
    expect(screen.queryByRole("textbox", { name: "搜索会话" })).toBeNull();
  });

  it("切换会话时自动关闭搜索栏并清空高亮", () => {
    vi.useFakeTimers();
    const registry = installFakeHighlights();
    const viewA = makeView([makeUser(1, "needle A")]);
    const viewB = makeView([makeUser(1, "needle B")]);

    const { rerender } = render(
      <Conversation
        session={stubSession("session-a")}
        view={viewA}
        openUrl={vi.fn()}
        cwd="Z:\\nocturne"
        subscribeEvents={noopSubscribe}
        images={createAttachmentImageSource()}
        busy={false}
        enableFind
      />,
    );

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true, cancelable: true }),
      );
    });
    const input = screen.getByRole("textbox", { name: "搜索会话" });
    fireEvent.change(input, { target: { value: "needle" } });
    act(() => {
      vi.advanceTimersByTime(FIND_DEBOUNCE_MS);
    });
    expect(registry.size).toBeGreaterThan(0);

    rerender(
      <Conversation
        session={stubSession("session-b")}
        view={viewB}
        openUrl={vi.fn()}
        cwd="Z:\\nocturne"
        subscribeEvents={noopSubscribe}
        images={createAttachmentImageSource()}
        busy={false}
        enableFind
      />,
    );

    expect(screen.queryByRole("textbox", { name: "搜索会话" })).toBeNull();
    expect(registry.size).toBe(0);
  });

  it("仅出现在链接地址里的命中切到它时加 search-hit 整条背景", () => {
    vi.useFakeTimers();
    const view = makeView([
      makeAssistant(1, "请查看 [文档](https://example.com/secret-token) 说明"),
    ]);

    const { container } = render(
      <Conversation
        session={stubSession("session-link")}
        view={view}
        openUrl={vi.fn()}
        cwd="Z:\\nocturne"
        subscribeEvents={noopSubscribe}
        images={createAttachmentImageSource()}
        busy={false}
        enableFind
      />,
    );

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true, cancelable: true }),
      );
    });
    const input = screen.getByRole("textbox", { name: "搜索会话" });
    fireEvent.change(input, { target: { value: "secret-token" } });
    act(() => {
      vi.advanceTimersByTime(FIND_DEBOUNCE_MS);
    });
    expect(screen.getByText("1/1")).toBeTruthy();
    const article = container.querySelector('article.a[data-session-seq="1"]');
    expect(article?.classList.contains("search-hit")).toBe(true);
  });

  it("流式追加新命中时更新计数但不跳走", () => {
    vi.useFakeTimers();
    const entries: ViewEntry[] = [makeUser(1, "第一处 alpha"), makeAssistant(2, "第二处 alpha")];
    const view = makeView(entries);

    const { rerender } = render(
      <Conversation
        session={stubSession("session-stream")}
        view={view}
        openUrl={vi.fn()}
        cwd="Z:\\nocturne"
        subscribeEvents={noopSubscribe}
        images={createAttachmentImageSource()}
        busy
        enableFind
      />,
    );

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true, cancelable: true }),
      );
    });
    const input = screen.getByRole("textbox", { name: "搜索会话" });
    fireEvent.change(input, { target: { value: "alpha" } });
    act(() => {
      vi.advanceTimersByTime(FIND_DEBOUNCE_MS);
    });
    expect(screen.getByText("1/2")).toBeTruthy();
    const callsBefore = scrollIntoViewMock.mock.calls.length;

    const updatedView = makeView([...entries, makeAssistant(3, "新流式落盘的 alpha")]);
    rerender(
      <Conversation
        session={stubSession("session-stream")}
        view={updatedView}
        openUrl={vi.fn()}
        cwd="Z:\\nocturne"
        subscribeEvents={noopSubscribe}
        images={createAttachmentImageSource()}
        busy
        enableFind
      />,
    );

    expect(screen.getByText("1/3")).toBeTruthy();
    expect(scrollIntoViewMock.mock.calls.length).toBe(callsBefore);
  });

  it("虚拟化 320 条消息时跳到未渲染的早期命中，渲染目标、滚到可见且关闭粘底跟随", async () => {
    const entries: ViewEntry[] = [];
    for (let i = 1; i <= 320; i += 1) {
      if (i === 5) {
        entries.push(makeAssistant(i, "远处唯一关键词 faraway-needle 在这里"));
      } else if (i % 2 === 1) {
        entries.push(makeUser(i, `用户消息 ${String(i)}`));
      } else {
        entries.push(makeAssistant(i, `助手回复 ${String(i)}`));
      }
    }
    const view = makeView(entries);

    const { container } = render(
      <Conversation
        session={stubSession("session-virtual-find")}
        view={view}
        openUrl={vi.fn()}
        cwd="Z:\\nocturne"
        subscribeEvents={noopSubscribe}
        images={createAttachmentImageSource()}
        busy={false}
        virtualize
        enableFind
      />,
    );

    // 初始粘底：seq=5 不在渲染范围内
    expect(container.querySelector('[data-session-seq="5"]')).toBeNull();
    expect(screen.queryByRole("button", { name: "回到最新消息" })).toBeNull();

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true, cancelable: true }),
      );
    });
    const input = screen.getByRole("textbox", { name: "搜索会话" });
    fireEvent.change(input, { target: { value: "faraway-needle" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(container.querySelector('[data-session-seq="5"]')).not.toBeNull();
      expect(scrollIntoViewMock).toHaveBeenCalledWith({ block: "center" });
    });
    expect(screen.getByText("1/1")).toBeTruthy();
    // 跳转后 follow 为 false，出现「回到最新消息」按钮
    expect(screen.getByRole("button", { name: "回到最新消息" })).toBeTruthy();
  });

  it("有对话区单行选区时 Ctrl+F 预填选区，无选区重开保留上次搜索词", () => {
    const view = makeView([
      makeUser(1, "先检查 worktree 状态"),
      makeAssistant(2, "没有问题，worktree 已就绪"),
    ]);

    const { container } = render(
      <div className="mainpane">
        <Conversation
          session={stubSession("session-prefill")}
          view={view}
          openUrl={vi.fn()}
          cwd="Z:\\nocturne"
          subscribeEvents={noopSubscribe}
          images={createAttachmentImageSource()}
          busy={false}
          enableFind
        />
      </div>,
    );

    const textNode = container.querySelector(".u-text")?.firstChild;
    expect(textNode).not.toBeNull();
    const range = document.createRange();
    range.setStart(textNode as Node, 4);
    range.setEnd(textNode as Node, 12);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true, cancelable: true }),
      );
    });
    const input = screen.getByRole<HTMLInputElement>("textbox", { name: "搜索会话" });
    expect(input.value).toBe("worktree");
    expect(screen.getByText("1/2")).toBeTruthy();

    // Esc 关闭后清除选区，再次 Ctrl+F 保留上次搜索词
    fireEvent.keyDown(input, { key: "Escape" });
    selection?.removeAllRanges();
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true, cancelable: true }),
      );
    });
    const reopened = screen.getByRole<HTMLInputElement>("textbox", { name: "搜索会话" });
    expect(reopened.value).toBe("worktree");
    expect(screen.getByText("1/2")).toBeTruthy();
  });
});
