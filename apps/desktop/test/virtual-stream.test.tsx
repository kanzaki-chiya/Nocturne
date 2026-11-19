import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSessionView,
  type AssistantEntry,
  type FileAttachment,
  type PendingPermission,
  type PendingQuestion,
  type SessionView,
  type ToolEntry,
  type UserEntry,
  type ViewEntry,
} from "@nocturne/core/protocol";
import type { RpcSession } from "@nocturne/rpc/client";

import { Conversation, QuestionCard } from "../src/Conversation";
import { createAttachmentImageSource } from "../src/attachment-images";
import {
  buildVirtualOffsets,
  buildVirtualSegments,
  computeVirtualRange,
  estimateEntryHeight,
} from "../src/virtual-stream";

function stubSession(id = "session-virtual"): RpcSession {
  return {
    id,
    readAttachment: vi.fn(() =>
      Promise.resolve({
        data: new TextEncoder().encode("<html><body><h1>Chart</h1></body></html>"),
        mimeType: "text/html",
        bytes: 40,
      }),
    ),
    respondPermission: vi.fn(() => Promise.resolve()),
    respondSubagentPermission: vi.fn(() => Promise.resolve()),
    respondQuestion: vi.fn(() => Promise.resolve()),
  } as unknown as RpcSession;
}

function makeUser(seq: number, text: string): UserEntry {
  return {
    kind: "user",
    key: `u:${String(seq)}`,
    turnId: `turn-${String(seq)}`,
    seq,
    content: [{ type: "text", text }],
    attachments: [],
    fileRefs: [],
  };
}

function makeAssistant(seq: number, text: string, reasoning = ""): AssistantEntry {
  return {
    kind: "assistant",
    key: `a:${String(seq)}`,
    turnId: `turn-${String(seq)}`,
    messageId: `msg-${String(seq)}`,
    seq,
    time: "2026-11-19T10:00:00.000Z",
    text,
    reasoning,
    toolCalls: [],
    model: { provider: "fake", model: "fake-1" },
    usage: undefined,
    finishReason: "stop",
  };
}

function makeTool(seq: number, label: string, files?: FileAttachment[]): ToolEntry {
  return {
    kind: "tool",
    key: `t:call-${String(seq)}`,
    turnId: `turn-${String(seq)}`,
    callId: `call-${String(seq)}`,
    name: files ? "render_html" : "read",
    seq,
    completedSeq: seq,
    status: "ok",
    input: files ? { title: label, html: "<h1>Hi</h1>" } : { path: `src/${label}.ts` },
    subjects: [],
    permission: undefined,
    resolution: undefined,
    liveOutput: "",
    result: {
      status: "ok",
      durationMs: 12,
      output: files ? { title: label, file: files[0]?.file } : { path: `src/${label}.ts` },
      error: undefined,
      truncated: false,
      spillPath: undefined,
      modelContent: `detail body for ${label}`,
      ...(files ? { files } : {}),
    },
  };
}

function buildLongView(count: number, extra?: (i: number) => ViewEntry | undefined): SessionView {
  const view = createSessionView();
  const entries: ViewEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    const seq = i + 1;
    const custom = extra?.(i);
    if (custom !== undefined) {
      entries.push(custom);
      continue;
    }
    if (i % 4 === 0) entries.push(makeUser(seq, `用户消息 ${String(seq)}`));
    else if (i % 4 === 1) entries.push(makeTool(seq, `file-${String(seq)}`));
    else if (i % 4 === 2)
      entries.push(makeAssistant(seq, `助手回复 ${String(seq)}`, `思考过程 ${String(seq)}`));
    else entries.push(makeTool(seq, `tool-${String(seq)}`));
  }
  view.entries = entries;
  view.lastSeq = count;
  return view;
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
  cleanup();
});

describe("virtual-stream 纯算法", () => {
  it("followBottom 模式只取底部视口加缓冲窗口，严格升序构建分段且不回收常驻项", () => {
    const view = buildLongView(200);
    const keys = view.entries.map((e) => e.key);
    const offsets = buildVirtualOffsets(view.entries, keys, new Map());
    const range = computeVirtualRange({
      offsets,
      count: view.entries.length,
      scrollTop: 0,
      viewportHeight: 844,
      followBottom: true,
    });
    expect(range.end).toBe(199);
    expect(range.start).toBeGreaterThan(150);
    expect(range.end - range.start + 1).toBeLessThan(50);

    const segments = buildVirtualSegments({
      count: view.entries.length,
      range,
      pinnedIndices: [25],
      offsets,
    });
    const indices = segments
      .filter((s): s is { kind: "item"; index: number } => s.kind === "item")
      .map((s) => s.index);
    expect(indices[0]).toBe(25);
    expect(indices).toEqual([...indices].sort((a, b) => a - b));
    expect(segments.some((s) => s.kind === "spacer" && s.height > 0)).toBe(true);
    const firstEntry = view.entries[0];
    if (!firstEntry) throw new Error("expected first entry");
    expect(estimateEntryHeight(firstEntry)).toBeGreaterThan(0);
  });
});

describe("Conversation 手机虚拟列表行为", () => {
  it("默认（桌面端）不开启虚拟化并完整渲染全部条目；开启 virtualize 时仅渲染尾部窗口并停在底部", () => {
    const view = buildLongView(120);
    const session = stubSession("desktop-session");
    const images = createAttachmentImageSource();

    const desktop = render(
      <Conversation
        session={session}
        view={view}
        openUrl={vi.fn()}
        cwd="Z:/project"
        subscribeEvents={() => () => undefined}
        images={images}
        busy={false}
      />,
    );
    expect(desktop.container.querySelector(".conversation-virtual-list")).toBeNull();
    expect(desktop.container.querySelectorAll("[data-session-seq]").length).toBe(120);
    desktop.unmount();

    const phone = render(
      <Conversation
        session={stubSession("phone-session")}
        view={view}
        openUrl={vi.fn()}
        cwd="Z:/project"
        subscribeEvents={() => () => undefined}
        images={images}
        busy={false}
        virtualize
      />,
    );
    expect(phone.container.querySelector(".conversation-virtual-list")).not.toBeNull();
    const mountedCount = phone.container.querySelectorAll("[data-virtual-index]").length;
    expect(mountedCount).toBeGreaterThan(10);
    expect(mountedCount).toBeLessThan(50);
    expect(phone.container.querySelector('[data-session-seq="120"]')).not.toBeNull();
    expect(phone.container.querySelector('[data-session-seq="1"]')).toBeNull();
  });

  it("流式输出时贴底跟随；用户上滚后不被拉回并显示回到最新消息", () => {
    const view1 = buildLongView(120);
    const session = stubSession("stream-session");
    const images = createAttachmentImageSource();

    const { rerender } = render(
      <Conversation
        session={session}
        view={view1}
        openUrl={vi.fn()}
        cwd="Z:/project"
        subscribeEvents={() => () => undefined}
        images={images}
        busy
        virtualize
      />,
    );
    const region = screen.getByRole("region", { name: "会话消息" });
    mockScrollMetrics(region, { clientHeight: 844, scrollHeight: 8000, scrollTop: 7156 });
    fireEvent.scroll(region);

    // 流式新增内容：仍在跟随状态时贴底
    const view2: SessionView = {
      ...view1,
      entries: [...view1.entries, makeAssistant(121, "流式新内容 A")],
      lastSeq: 121,
    };
    mockScrollMetrics(region, { clientHeight: 844, scrollHeight: 8120, scrollTop: 7156 });
    rerender(
      <Conversation
        session={session}
        view={view2}
        openUrl={vi.fn()}
        cwd="Z:/project"
        subscribeEvents={() => () => undefined}
        images={images}
        busy
        virtualize
      />,
    );
    expect(region.scrollTop).toBe(8120);

    // 用户上滚：取消贴底跟随
    region.scrollTop = 2400;
    fireEvent.scroll(region);
    expect(screen.getByRole("button", { name: "回到最新消息" })).toBeTruthy();

    // 继续流式追加内容：不把用户拉回底部
    const view3: SessionView = {
      ...view2,
      entries: [...view2.entries, makeAssistant(122, "流式新内容 B")],
      lastSeq: 122,
    };
    rerender(
      <Conversation
        session={session}
        view={view3}
        openUrl={vi.fn()}
        cwd="Z:/project"
        subscribeEvents={() => () => undefined}
        images={images}
        busy
        virtualize
      />,
    );
    expect(region.scrollTop).toBe(2400);
  });

  it("往上滚加载旧内容时根据锚点漂移补偿 scrollTop，屏幕内容不跳动", () => {
    const view = buildLongView(120);
    const session = stubSession("anchor-session");
    const images = createAttachmentImageSource();

    const { container } = render(
      <Conversation
        session={session}
        view={view}
        openUrl={vi.fn()}
        cwd="Z:/project"
        subscribeEvents={() => () => undefined}
        images={images}
        busy={false}
        virtualize
      />,
    );
    const region = screen.getByRole("region", { name: "会话消息" });
    const offsets = buildVirtualOffsets(
      view.entries,
      view.entries.map((e) => e.key),
      new Map(),
    );
    const totalHeight = Math.ceil(offsets[view.entries.length] ?? 7000);
    mockScrollMetrics(region, {
      clientHeight: 844,
      scrollHeight: totalHeight,
      scrollTop: totalHeight - 844,
    });
    // 建立底部 previousTop 基线
    fireEvent.scroll(region);

    // 给初始可见窗口里的某个条目模拟稳定布局坐标
    const mountedItems = [...container.querySelectorAll<HTMLElement>("[data-virtual-index]")];
    const anchorEl = mountedItems[2];
    if (!anchorEl) throw new Error("expected mounted anchor item");
    const anchorIndex = Number(anchorEl.dataset.virtualIndex);
    vi.spyOn(region, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 390, 844));

    // 用户上滚 800px，使窗口向上扩展加载更早条目，同时 anchorEl 仍在窗口内
    const targetScrollTop = Math.max(0, totalHeight - 844 - 800);
    region.scrollTop = targetScrollTop;
    let calls = 0;
    vi.spyOn(anchorEl, "getBoundingClientRect").mockImplementation(() => {
      calls += 1;
      // 第 1 次是 onScroll 的 captureAnchor（返回 120），之后是 useLayoutEffect 的 measure + restoreAnchor
      // 模拟上方新挂载的旧条目真实高度比估算高 320px，导致锚点元素下移到 440
      return new DOMRect(0, calls === 1 ? 120 : 440, 390, 60);
    });

    fireEvent.scroll(region);
    expect(
      container.querySelector(`[data-virtual-index="${String(anchorIndex - 5)}"]`),
    ).not.toBeNull();
    expect(region.scrollTop).toBe(targetScrollTop + 320);
  });

  it("已展开的工具详情与思考折叠状态，滚出视口回收再滚回后保持不变", () => {
    const view = buildLongView(120);
    const session = stubSession("state-persist-session");
    const images = createAttachmentImageSource();

    const { container } = render(
      <Conversation
        session={session}
        view={view}
        openUrl={vi.fn()}
        cwd="Z:/project"
        subscribeEvents={() => () => undefined}
        images={images}
        busy={false}
        virtualize
      />,
    );
    const region = screen.getByRole("region", { name: "会话消息" });
    mockScrollMetrics(region, { clientHeight: 844, scrollHeight: 9000, scrollTop: 8156 });
    fireEvent.scroll(region);

    // 在底部窗口展开一条工具（seq 118）和一条思考块（seq 119）
    const toolArticle = container.querySelector<HTMLElement>(
      'article.tool[data-session-seq="118"]',
    );
    if (!toolArticle) throw new Error("expected toolArticle 118");
    const toolToggle = toolArticle.querySelector<HTMLElement>("summary[aria-expanded]");
    if (!toolToggle) throw new Error("expected toolToggle 118");
    expect(toolToggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toolToggle);
    expect(toolToggle.getAttribute("aria-expanded")).toBe("true");

    const assistantArticle = container.querySelector<HTMLElement>(
      'article.a[data-session-seq="119"]',
    );
    if (!assistantArticle) throw new Error("expected assistantArticle 119");
    const thinkToggle = assistantArticle.querySelector<HTMLButtonElement>("button.think-h");
    if (!thinkToggle) throw new Error("expected thinkToggle 119");
    expect(thinkToggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(thinkToggle);
    expect(thinkToggle.getAttribute("aria-expanded")).toBe("true");

    // 滚到最顶部，确认 118 和 119 确实已从 DOM 卸载回收
    region.scrollTop = 0;
    fireEvent.scroll(region);
    expect(container.querySelector('[data-session-seq="118"]')).toBeNull();
    expect(container.querySelector('[data-session-seq="119"]')).toBeNull();

    // 滚回底部，确认 118 和 119 重新挂载后依然保持展开态
    region.scrollTop = 8156;
    fireEvent.scroll(region);
    const restoredTool = container.querySelector<HTMLElement>(
      'article.tool[data-session-seq="118"]',
    );
    expect(
      restoredTool
        ?.querySelector<HTMLElement>("summary[aria-expanded]")
        ?.getAttribute("aria-expanded"),
    ).toBe("true");

    const restoredAssistant = container.querySelector<HTMLElement>(
      'article.a[data-session-seq="119"]',
    );
    expect(
      restoredAssistant
        ?.querySelector<HTMLButtonElement>("button.think-h")
        ?.getAttribute("aria-expanded"),
    ).toBe("true");
  });

  it("内嵌 HTML 页面（render_html）挂载后排除在回收之外，滚出视口再回来 DOM 实例不变不丢状态", async () => {
    const htmlFile: FileAttachment = {
      type: "file",
      file: "chart-115.html",
      bytes: 40,
      sha256: "b".repeat(64),
      label: "图表.html",
      mimeType: "text/html",
      source: "upload",
      inline: { title: "测试内嵌页" },
    };
    const view = buildLongView(120, (i) =>
      i === 114 ? makeTool(115, "测试内嵌页", [htmlFile]) : undefined,
    );
    const session = stubSession("inline-html-session");
    const images = createAttachmentImageSource();

    const { container } = render(
      <Conversation
        session={session}
        view={view}
        openUrl={vi.fn()}
        cwd="Z:/project"
        subscribeEvents={() => () => undefined}
        images={images}
        busy={false}
        virtualize
      />,
    );
    const region = screen.getByRole("region", { name: "会话消息" });
    mockScrollMetrics(region, { clientHeight: 844, scrollHeight: 9000, scrollTop: 8156 });
    fireEvent.scroll(region);

    // 等 InlinePage 加载出 iframe
    const iframeBefore = await waitFor(() => {
      const el = container.querySelector<HTMLIFrameElement>('iframe[title="测试内嵌页"]');
      if (!el) throw new Error("iframe not mounted yet");
      return el;
    });
    // 给 DOM 节点打一个自定义标记以验证未曾卸载重建
    (iframeBefore as unknown as { __aliveToken?: string }).__aliveToken = "kept";

    // 滚到最顶部（普通条目 118 已被回收，但 115 的 InlinePage 仍在 DOM 中常驻）
    region.scrollTop = 0;
    fireEvent.scroll(region);
    expect(container.querySelector('[data-session-seq="118"]')).toBeNull();
    const iframeWhileAway =
      container.querySelector<HTMLIFrameElement>('iframe[title="测试内嵌页"]');
    expect(iframeWhileAway).toBe(iframeBefore);

    // 再滚回底部，iframe 是完全同一个 DOM 节点
    region.scrollTop = 8156;
    fireEvent.scroll(region);
    const iframeAfter = container.querySelector<HTMLIFrameElement>('iframe[title="测试内嵌页"]');
    expect(iframeAfter).toBe(iframeBefore);
    expect((iframeAfter as unknown as { __aliveToken?: string }).__aliveToken).toBe("kept");
  });

  it("searchTarget 跳转到视口外远处的历史消息时自动挂载并定位高亮", async () => {
    const view = buildLongView(120);
    const session = stubSession("jump-session");
    const images = createAttachmentImageSource();
    const scrollIntoViewMock = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoViewMock;

    const { container, rerender } = render(
      <Conversation
        session={session}
        view={view}
        openUrl={vi.fn()}
        cwd="Z:/project"
        subscribeEvents={() => () => undefined}
        images={images}
        busy={false}
        virtualize
      />,
    );
    // 初始时第 5 条不在 DOM 中
    expect(container.querySelector('[data-session-seq="5"]')).toBeNull();

    // 触发跳转到 seq=5
    rerender(
      <Conversation
        session={session}
        view={view}
        openUrl={vi.fn()}
        cwd="Z:/project"
        subscribeEvents={() => () => undefined}
        images={images}
        busy={false}
        searchTarget={{ sessionId: "jump-session", seq: 5, nonce: 1 }}
        virtualize
      />,
    );

    const targetEl = await waitFor(() => {
      const el = container.querySelector('[data-session-seq="5"]');
      if (!el) throw new Error("target element not mounted yet");
      return el;
    });
    expect(targetEl.className).toContain("search-hit");
    await waitFor(() => {
      expect(scrollIntoViewMock).toHaveBeenCalled();
    });
  });

  it("待确认卡片、提问卡片与待发输入预览在虚拟列表下照常显示", () => {
    const view = buildLongView(80);
    const permission: PendingPermission = {
      requestId: "perm-1",
      toolName: "shell",
      callId: "call-perm",
      subjects: [{ kind: "shell", target: "rm -rf /tmp/demo" }],
      reason: "需要确认命令",
      options: ["allow_once", "deny"],
    };
    const question: PendingQuestion = {
      requestId: "q-1",
      callId: "call-q",
      questions: [
        {
          question: "选择部署方式",
          options: [{ label: "本地" }, { label: "远程" }],
        },
      ],
    };
    view.pendingPermission = permission;
    view.pendingQuestion = question;
    const localOutgoing: UserEntry = {
      kind: "user",
      key: "local-outgoing-1",
      turnId: "turn-local",
      seq: 999,
      content: [{ type: "text", text: "刚发出的本地待确认消息预览" }],
      attachments: [],
      fileRefs: [],
    };
    const session = stubSession("cards-session");
    const images = createAttachmentImageSource();

    render(
      <>
        <Conversation
          session={session}
          view={view}
          openUrl={vi.fn()}
          cwd="Z:/project"
          subscribeEvents={() => () => undefined}
          images={images}
          busy={false}
          localEntries={[localOutgoing]}
          virtualize
        />
        <QuestionCard pending={question} session={session} />
      </>,
    );

    expect(screen.getByText("刚发出的本地待确认消息预览")).toBeTruthy();
    expect(screen.getByText(/rm -rf \/tmp\/demo/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /允许一次/ })).toBeTruthy();
    expect(screen.getByText("选择部署方式")).toBeTruthy();
  });
});
