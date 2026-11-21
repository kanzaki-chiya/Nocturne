import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSessionView,
  type AssistantEntry,
  type SessionView,
  type UserEntry,
  type ViewEntry,
} from "@nocturne/core/protocol";
import type { RpcSession } from "@nocturne/rpc/client";

import { Conversation } from "../src/Conversation";
import { createAttachmentImageSource } from "../src/attachment-images";
import {
  computeTurnTickLayout,
  extractConversationTurns,
  findCurrentTurnIndex,
  firstLineOfUserEntry,
  RAIL_CLOSE_DELAY_MS,
  stepTurnIndex,
} from "../src/turn-rail";

function stubSession(id = "session-turn"): RpcSession {
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

function makeAssistant(seq: number, text: string): AssistantEntry {
  return {
    kind: "assistant",
    key: `a:${String(seq)}`,
    turnId: `turn-${String(seq)}`,
    messageId: `msg-${String(seq)}`,
    seq,
    time: "2026-11-21T10:00:00.000Z",
    text,
    reasoning: "",
    toolCalls: [],
    model: { provider: "fake", model: "fake-1" },
    usage: undefined,
    finishReason: "stop",
  };
}

function makeView(entries: ViewEntry[]): SessionView {
  const view = createSessionView();
  view.entries = entries;
  view.lastSeq = entries.at(-1)?.seq ?? 0;
  return view;
}

const scrollIntoViewMock = vi.fn();

beforeEach(() => {
  scrollIntoViewMock.mockReset();
  Element.prototype.scrollIntoView = scrollIntoViewMock;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("turn-rail 纯函数", () => {
  it("提取新 Turn 用户消息并排除插话、子代理结果、后台任务、合奏帖子、组曲汇报与 Runtime 模式消息", () => {
    const entries: ViewEntry[] = [
      makeUser(1, "\n  第一轮标题\n第二行详情"),
      makeAssistant(2, "回复 1"),
      makeUser(3, "运行中插话", { steer: true }),
      makeUser(4, "子代理返回", {
        subagent: {
          childSessionId: "c1",
          callId: "call-1",
          status: "ok",
        },
      }),
      makeUser(5, "后台命令结果", {
        backgroundShell: {
          taskId: "t1",
          callId: "call-2",
          status: "exited",
          exitCode: 0,
        },
      }),
      makeUser(6, "合奏留言", {
        ensemble: {
          from: "reviewer",
          fromKind: "member",
          postNumber: 1,
        },
      }),
      makeUser(7, "组曲汇报", {
        suiteReport: {
          threadId: "th-1",
          turnId: "turn-7",
          status: "idle",
        },
      }),
      makeUser(8, "自动目标核对", {
        workMode: { name: "goal", body: "check", source: "runtime" },
      }),
      makeUser(9, "第二轮标题"),
      makeAssistant(10, "回复 2"),
      makeUser(11, "第三轮用户执行方式", {
        content: [
          { type: "text", text: "第三轮用户执行方式" },
          { type: "text", text: "plan snapshot" },
        ],
        workMode: { name: "plan", body: "plan body" },
      }),
    ];

    const turns = extractConversationTurns(entries);
    expect(turns).toEqual([
      { seq: 1, entryIndex: 0, label: "第一轮标题" },
      { seq: 9, entryIndex: 8, label: "第二轮标题" },
      { seq: 11, entryIndex: 10, label: "第三轮用户执行方式" },
    ]);
  });

  it("firstLineOfUserEntry 在无正文时回退为委派名、附件名或图片标记", () => {
    expect(firstLineOfUserEntry(makeUser(1, "", { delegate: { agent: "codex", task: "" } }))).toBe(
      "/codex",
    );
    expect(
      firstLineOfUserEntry(
        makeUser(2, "", {
          attachments: [
            {
              type: "image",
              file: "img.png",
              mimeType: "image/png",
              bytes: 10,
              sha256: "abc",
              source: "paste",
            },
          ],
        }),
      ),
    ).toBe("[图片]");
  });

  it("findCurrentTurnIndex 与 stepTurnIndex 准确映射与夹紧", () => {
    const turns = [
      { seq: 1, entryIndex: 0, label: "一" },
      { seq: 3, entryIndex: 2, label: "二" },
      { seq: 5, entryIndex: 4, label: "三" },
    ];
    expect(findCurrentTurnIndex(turns, 0)).toBe(0);
    expect(findCurrentTurnIndex(turns, 1)).toBe(0);
    expect(findCurrentTurnIndex(turns, 2)).toBe(1);
    expect(findCurrentTurnIndex(turns, 5)).toBe(2);
    expect(findCurrentTurnIndex([], 0)).toBe(-1);

    expect(stepTurnIndex(0, 3, -1)).toBe(0);
    expect(stepTurnIndex(0, 3, 1)).toBe(1);
    expect(stepTurnIndex(2, 3, 1)).toBe(2);
    expect(stepTurnIndex(2, 3, -1)).toBe(1);
    expect(stepTurnIndex(0, 0, 1)).toBe(-1);
  });

  it("computeTurnTickLayout 少轮等间距，多轮不超过容器高度的 60% 并按比例分布", () => {
    const small = computeTurnTickLayout(5, 800);
    expect(small.trackHeight).toBe(5 * 2 + 4 * 7);
    expect(small.tops).toEqual([0, 9, 18, 27, 36]);

    const huge = computeTurnTickLayout(100, 700);
    // 700 * 0.6 = 420, minus 16px vertical padding = 404px
    expect(huge.trackHeight).toBe(404);
    expect(huge.tops[0]).toBe(0);
    expect(huge.tops[99]).toBe(402);
  });
});

describe("Conversation 轮次导航组件与快捷键", () => {
  const noopSubscribe = () => () => undefined;

  it("少于 3 轮时不渲染轮次导航", () => {
    const view = makeView([
      makeUser(1, "第一轮"),
      makeAssistant(2, "答 1"),
      makeUser(3, "第二轮"),
      makeAssistant(4, "答 2"),
    ]);

    render(
      <Conversation
        session={stubSession("s-two")}
        view={view}
        openUrl={vi.fn()}
        cwd="Z:\\nocturne"
        subscribeEvents={noopSubscribe}
        images={createAttachmentImageSource()}
        busy={false}
        enableTurnNav
      />,
    );

    expect(screen.queryByRole("navigation", { name: "轮次" })).toBeNull();
  });

  it("3 轮及以上时渲染导航；悬停展开列表、点击跳到对应 seq、离开 150ms 后收起", async () => {
    vi.useFakeTimers();
    const view = makeView([
      makeUser(1, "第一轮提问\n详细说明"),
      makeAssistant(2, "回复 1"),
      makeUser(3, "第二轮提问"),
      makeAssistant(4, "回复 2"),
      makeUser(5, "第三轮提问"),
      makeAssistant(6, "回复 3"),
    ]);

    render(
      <Conversation
        session={stubSession("s-three")}
        view={view}
        openUrl={vi.fn()}
        cwd="Z:\\nocturne"
        subscribeEvents={noopSubscribe}
        images={createAttachmentImageSource()}
        busy={false}
        enableTurnNav
      />,
    );

    const nav = screen.getByRole("navigation", { name: "轮次" });
    expect(screen.queryByRole("button", { name: "第一轮提问" })).toBeNull();

    // 悬停展开
    fireEvent.mouseEnter(nav);
    const firstBtn = screen.getByRole("button", { name: "第一轮提问" });
    expect(screen.getByRole("button", { name: "第二轮提问" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "第三轮提问" })).toBeTruthy();

    // 点击第一轮跳到 seq=1
    fireEvent.click(firstBtn);
    act(() => {
      vi.advanceTimersByTime(32);
    });
    expect(scrollIntoViewMock).toHaveBeenCalledWith({ block: "center" });
    expect(firstBtn.classList.contains("on")).toBe(true);

    // 离开后 150ms 收起
    fireEvent.mouseLeave(nav);
    act(() => {
      vi.advanceTimersByTime(RAIL_CLOSE_DELAY_MS - 10);
    });
    expect(screen.queryByRole("button", { name: "第一轮提问" })).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(20);
    });
    expect(screen.queryByRole("button", { name: "第一轮提问" })).toBeNull();
  });

  it("Alt+↑ / Alt+↓ 按轮跳转，输入框补全列表打开时不接管", () => {
    const view = makeView([
      makeUser(1, "第一轮"),
      makeAssistant(2, "答 1"),
      makeUser(3, "第二轮"),
      makeAssistant(4, "答 2"),
      makeUser(5, "第三轮"),
      makeAssistant(6, "答 3"),
    ]);

    const { rerender } = render(
      <div className="mainpane">
        <Conversation
          session={stubSession("s-alt")}
          view={view}
          openUrl={vi.fn()}
          cwd="Z:\\nocturne"
          subscribeEvents={noopSubscribe}
          images={createAttachmentImageSource()}
          busy={false}
          enableTurnNav
        />
        <div className="composer">
          <textarea aria-label="消息输入" />
        </div>
      </div>,
    );

    const textarea = screen.getByLabelText("消息输入");
    textarea.focus();

    // 初始在最后一轮（索引 2），按 Alt+↑ 跳到第二轮（索引 1）
    const upEvent = new KeyboardEvent("keydown", {
      key: "ArrowUp",
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      textarea.dispatchEvent(upEvent);
    });
    expect(upEvent.defaultPrevented).toBe(true);

    const nav = screen.getByRole("navigation", { name: "轮次" });
    fireEvent.mouseEnter(nav);
    expect(screen.getByRole("button", { name: "第二轮" }).classList.contains("on")).toBe(true);

    // 按 Alt+↓ 回到第三轮（索引 2）
    const downEvent = new KeyboardEvent("keydown", {
      key: "ArrowDown",
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      textarea.dispatchEvent(downEvent);
    });
    expect(downEvent.defaultPrevented).toBe(true);
    expect(screen.getByRole("button", { name: "第三轮" }).classList.contains("on")).toBe(true);

    // 补全列表打开时不接管 Alt+↑
    rerender(
      <div className="mainpane">
        <Conversation
          session={stubSession("s-alt")}
          view={view}
          openUrl={vi.fn()}
          cwd="Z:\\nocturne"
          subscribeEvents={noopSubscribe}
          images={createAttachmentImageSource()}
          busy={false}
          enableTurnNav
        />
        <div className="composer">
          <div role="listbox" className="composer-popup" />
          <textarea aria-label="消息输入" />
        </div>
      </div>,
    );
    const blockedEvent = new KeyboardEvent("keydown", {
      key: "ArrowUp",
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      screen.getByLabelText("消息输入").dispatchEvent(blockedEvent);
    });
    expect(blockedEvent.defaultPrevented).toBe(false);
    expect(screen.getByRole("button", { name: "第三轮" }).classList.contains("on")).toBe(true);
  });

  it("虚拟化 320 条消息时点击第 1 轮会渲染该轮、滚到可见并关闭粘底跟随", async () => {
    const entries: ViewEntry[] = [];
    for (let i = 1; i <= 320; i += 1) {
      if (i % 2 === 1) entries.push(makeUser(i, `轮次标题 ${String((i + 1) / 2)}`));
      else entries.push(makeAssistant(i, `助手回复 ${String(i / 2)}`));
    }
    const view = makeView(entries);

    const { container } = render(
      <Conversation
        session={stubSession("s-virtual-turn")}
        view={view}
        openUrl={vi.fn()}
        cwd="Z:\\nocturne"
        subscribeEvents={noopSubscribe}
        images={createAttachmentImageSource()}
        busy={false}
        virtualize
        enableTurnNav
      />,
    );

    expect(container.querySelector('[data-session-seq="1"]')).toBeNull();
    const nav = screen.getByRole("navigation", { name: "轮次" });
    fireEvent.mouseEnter(nav);
    fireEvent.click(screen.getByRole("button", { name: "轮次标题 1" }));

    await waitFor(() => {
      expect(container.querySelector('[data-session-seq="1"]')).not.toBeNull();
      expect(scrollIntoViewMock).toHaveBeenCalledWith({ block: "center" });
    });
    expect(screen.getByRole("button", { name: "回到最新消息" })).toBeTruthy();
  });
});
