// @vitest-environment jsdom
import { createRef } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildStandaloneInlineHtml,
  createSessionView,
  type FileAttachment,
  type SessionView,
  type ToolEntry,
} from "@nocturne/core/protocol";
import type { EventListener, RpcSession } from "@nocturne/rpc/client";

import { createAttachmentImageSource } from "../src/attachment-images";
import { Conversation, type ReadOnlyConversationProps } from "../src/Conversation";
import { ImageViewerProvider, type ImageViewerControl, type SaveFileFn } from "../src/ImageViewer";
import {
  INLINE_PAGE_CAPTURE_MAX_BYTES,
  INLINE_PAGE_CAPTURE_TIMEOUT_MS,
  INLINE_PAGE_COLLAPSE_HEIGHT,
  INLINE_PAGE_MAX_HEIGHT,
  INLINE_PAGE_MIN_HEIGHT,
  InlinePage,
} from "../src/InlinePage";

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => "blob:inline-dl");
  URL.revokeObjectURL = vi.fn();
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe = vi.fn();
      disconnect = vi.fn();
    },
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.theme;
});

function makeFile(opts: {
  file?: string;
  label?: string;
  inlineTitle?: string;
  bytes?: number;
}): FileAttachment {
  return {
    type: "file",
    file: opts.file ?? "file-1.html",
    bytes: opts.bytes ?? 64,
    sha256: "a".repeat(64),
    label: opts.label ?? "各包测试耗时.html",
    mimeType: "text/html",
    source: "upload",
    ...(opts.inlineTitle !== undefined ? { inline: { title: opts.inlineTitle } } : {}),
  };
}

function makeToolEntry(opts: {
  name?: string;
  status?: ToolEntry["status"];
  input?: unknown;
  files?: FileAttachment[];
  error?: { code: string; message: string };
}): ToolEntry {
  const status = opts.status ?? "ok";
  return {
    kind: "tool",
    key: "t:call-1",
    turnId: "turn-1",
    callId: "call-1",
    name: opts.name ?? "render_html",
    seq: 2,
    completedSeq: 3,
    status,
    input: opts.input ?? { title: "各包测试耗时", html: "<h1>Chart</h1>" },
    subjects: [],
    permission: undefined,
    resolution: undefined,
    liveOutput: "",
    result:
      status === "running"
        ? undefined
        : {
            status: status === "ok" ? "ok" : "error",
            modelContent: "done",
            output: { title: "各包测试耗时", file: "file-1.html", bytes: 64 },
            error: opts.error,
            truncated: false,
            spillPath: undefined,
            ...(opts.files !== undefined ? { files: opts.files } : {}),
            durationMs: 12,
          },
  };
}

function makeConversationProps(
  view: SessionView,
  readAttachment?: RpcSession["readAttachment"],
): ReadOnlyConversationProps {
  const fn =
    readAttachment ??
    vi.fn(async () => ({
      data: new TextEncoder().encode("<!doctype html><html><body><h1>Chart</h1></body></html>"),
      mimeType: "text/html",
      bytes: 55,
    }));
  const images = createAttachmentImageSource();
  return {
    session: {
      id: "s-inline",
      readOnly: true,
      readAttachment: fn,
    },
    view,
    cwd: "Z:\\proj",
    openUrl: vi.fn(),
    subscribeEvents: () => () => undefined,
    images,
    busy: false,
    readOnly: { frozen: false },
  };
}

function collectVisibleTextNodes(root: Element): string[] {
  const texts: string[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node !== null) {
    const val = node.nodeValue?.trim() ?? "";
    if (val !== "") {
      texts.push(val);
    }
    node = walker.nextNode();
  }
  return texts;
}

describe("InlinePage 回复内嵌页面", () => {
  it.each([false, true])("只转发本 iframe 的请求并用宿主绑定页，远程视图为 %s", async (remote) => {
    const file = makeFile({ inlineTitle: "槽位标题" });
    let listener: EventListener | undefined;
    let fail: ((error: Error) => void) | undefined;
    const callPageModel = vi.fn(
      () =>
        new Promise<string>((_, reject) => {
          fail = reject;
        }),
    );
    const stopPageModel = vi.fn(async () => {
      fail?.(new Error("已停止"));
    });
    const setPageData = vi.fn(async () => undefined);
    const session = {
      readAttachment: makeConversationProps(createSessionView()).session.readAttachment,
      onEvent(callback: EventListener) {
        listener = callback;
        return () => {
          listener = undefined;
        };
      },
      setPageData,
      callPageModel,
      stopPageModel,
      respondPagePermission: vi.fn(async () => undefined),
    };
    const { container } = render(
      <InlinePage file={file} session={session} remote={remote} renderFallback={() => null} />,
    );
    const source = await waitFor(() => {
      const frameWindow = container.querySelector("iframe")?.contentWindow;
      if (!frameWindow) throw new Error("页面 iframe 尚未加载");
      return frameWindow;
    });
    const post = vi.spyOn(source, "postMessage");
    const send = (fields: Record<string, unknown>, from: Window = source) => {
      window.dispatchEvent(new MessageEvent("message", { data: fields, source: from }));
    };
    act(() => send({ type: "nocturne:inline-html:ready" }));
    const renderMessage = post.mock.calls.at(-1)?.[0] as { id: string; pageBridge?: boolean };
    expect(renderMessage.pageBridge).toBe(true);
    const request = {
      type: "nocturne:inline-html:request",
      id: renderMessage.id,
      requestId: 1,
      method: "set",
      sessionId: "forged",
      page: "page-99",
      key: "count",
      value: 2,
    };
    act(() => send(request, window));
    expect(setPageData).not.toHaveBeenCalled();
    act(() => send(request));
    await waitFor(() => expect(setPageData).toHaveBeenCalledWith("legacy-file-1.html", "count", 2));
    act(() => send({ ...request, requestId: 2, method: "ask", prompt: "汇总" }));
    expect(callPageModel).toHaveBeenCalledWith("legacy-file-1.html", { prompt: "汇总" });
    const event = {
      type: "page.permission_requested" as const,
      sessionId: "s-inline",
      runId: "run",
      eseq: 1,
      afterSeq: 1,
      time: new Date().toISOString(),
      payload: { page: "page-99", title: "其他页面", model: "fake/fake", requestId: "request" },
    };
    act(() => listener?.(event));
    expect(screen.queryByRole("button", { name: "允许一次" })).toBeNull();
    act(() =>
      listener?.({
        ...event,
        payload: { ...event.payload, page: "legacy-file-1.html", title: "槽位标题" },
      }),
    );
    expect(screen.getByRole("button", { name: "允许一次" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "拒绝" })).toBeTruthy();
    expect(Boolean(screen.queryByRole("button", { name: "这个页面以后都允许" }))).toBe(!remote);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "停止" }));
    });
    expect(stopPageModel).toHaveBeenCalledWith("legacy-file-1.html");
    expect(screen.queryByRole("button", { name: "允许一次" })).toBeNull();
  });
  it("带 inline 标记的工具结果渲染为沙箱页面框并隐藏原工具行，且页面框内无任何可见文本节点", async () => {
    const view = createSessionView();
    view.entries = [
      makeToolEntry({
        files: [makeFile({ inlineTitle: "各包测试耗时" })],
      }),
    ];
    const { container } = render(<Conversation {...makeConversationProps(view)} />);

    const iframe = await waitFor(() => {
      const el = container.querySelector<HTMLIFrameElement>(".inline-page iframe");
      if (!el) throw new Error("missing iframe");
      return el;
    });
    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts");
    expect(iframe.getAttribute("title")).toBe("各包测试耗时");
    // 原工具行与文件卡片都不应出现
    expect(container.querySelector(".tool")).toBeNull();
    expect(container.querySelector(".fcard")).toBeNull();

    const pageBox = container.querySelector(".inline-page");
    if (!pageBox) throw new Error("missing .inline-page");
    expect(collectVisibleTextNodes(pageBox)).toEqual([]);
  });

  it("不带 inline 标记的文件保持文件卡片显示；工具运行中与失败时显示「页面」普通工具行", async () => {
    const view = createSessionView();
    view.entries = [
      {
        kind: "user",
        key: "u:1",
        seq: 1,
        turnId: "turn-1",
        content: [{ type: "text", text: "上传 HTML" }],
        files: [makeFile({ label: "plain.html" })],
      },
      makeToolEntry({
        status: "running",
        input: { title: "生成中图表", html: "<p>1</p>" },
      }),
      {
        ...makeToolEntry({
          status: "error",
          input: { title: "失败页面", html: "<p>bad</p>" },
          error: { code: "invalid_input", message: "html 不能为空" },
        }),
        key: "t:call-2",
        callId: "call-2",
        seq: 4,
      },
    ];
    const { container } = render(<Conversation {...makeConversationProps(view)} />);

    expect(container.querySelector(".inline-page")).toBeNull();
    expect(container.querySelector(".fcard")?.textContent).toContain("plain.html");
    const toolLabels = Array.from(container.querySelectorAll(".tool-name")).map(
      (el) => el.textContent,
    );
    expect(toolLabels).toEqual(["页面", "页面"]);
  });

  it("校验 postMessage 来源与数据形状，夹紧高度范围，高于 420px 时出现展开/收起按钮且仍无可见文本", async () => {
    const view = createSessionView();
    view.entries = [makeToolEntry({ files: [makeFile({ inlineTitle: "高度自适应页" })] })];
    const { container } = render(<Conversation {...makeConversationProps(view)} />);

    const iframe = await waitFor(() => {
      const el = container.querySelector<HTMLIFrameElement>(".inline-page iframe");
      if (!el) throw new Error("missing iframe");
      return el;
    });
    const body = container.querySelector<HTMLDivElement>(".inline-page-body");
    if (!body) throw new Error("missing .inline-page-body");
    const initialHeight = body.style.height;

    // 1. 伪造来源（source !== iframe.contentWindow）不改变高度
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          source: window,
          data: { type: "nocturne:inline-html:resize", height: 300 },
        }),
      );
    });
    expect(body.style.height).toBe(initialHeight);

    // 2. 数据形状错误（NaN、字符串、错误 type、错误 id）不改变高度
    for (const badData of [
      null,
      "300",
      { type: "other", height: 300 },
      { type: "nocturne:inline-html:resize", height: Number.NaN },
      { type: "nocturne:inline-html:resize", height: "300" },
      { type: "nocturne:inline-html:resize", id: "wrong-instance", height: 300 },
    ]) {
      act(() => {
        window.dispatchEvent(
          new MessageEvent("message", {
            source: iframe.contentWindow,
            data: badData,
          }),
        );
      });
    }
    expect(body.style.height).toBe(initialHeight);

    // 3. 极小高度被夹紧至下限，且 <= 420px 时不显示展开按钮
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          source: iframe.contentWindow,
          data: { type: "nocturne:inline-html:resize", height: 5 },
        }),
      );
    });
    expect(body.style.height).toBe(`${INLINE_PAGE_MIN_HEIGHT}px`);
    expect(screen.queryByRole("button", { name: "展开" })).toBeNull();

    // 4. 超大高度（如 999999）被夹紧至 MAX，初始折叠在 420px，出现展开按钮
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          source: iframe.contentWindow,
          data: { type: "nocturne:inline-html:resize", height: 999999 },
        }),
      );
    });
    expect(body.style.height).toBe(`${INLINE_PAGE_COLLAPSE_HEIGHT}px`);
    expect(container.querySelector(".inline-page-fade")).not.toBeNull();

    const expandBtn = screen.getByRole("button", { name: "展开" });
    fireEvent.click(expandBtn);
    expect(body.style.height).toBe(`${INLINE_PAGE_MAX_HEIGHT}px`);
    expect(container.querySelector(".inline-page-fade")).toBeNull();

    const collapseBtn = screen.getByRole("button", { name: "收起" });
    expect(collapseBtn).toBeDefined();
    // 即使在出现展开/收起按钮后，页面框内依然没有任何可见文本节点
    const pageEl = container.querySelector(".inline-page");
    if (!pageEl) throw new Error("missing .inline-page");
    expect(collectVisibleTextNodes(pageEl)).toEqual([]);

    fireEvent.click(collapseBtn);
    expect(body.style.height).toBe(`${INLINE_PAGE_COLLAPSE_HEIGHT}px`);
  });

  it("全屏打开与四种关闭方式（关闭按钮、Esc、遮罩点击、安卓返回控制栈）均归还焦点，且支持下载与主题同步", async () => {
    const view = createSessionView();
    view.entries = [
      makeToolEntry({
        files: [makeFile({ label: "季度统计.html", inlineTitle: "季度统计" })],
      }),
    ];
    const controlRef = createRef<ImageViewerControl | null>();
    const saveFile = vi.fn<SaveFileFn>(async () => undefined);
    const props = makeConversationProps(view);

    const { container } = render(
      <ImageViewerProvider controlRef={controlRef} saveFile={saveFile}>
        <Conversation {...props} />
      </ImageViewerProvider>,
    );

    const inlineIframe = await waitFor(() => {
      const el = container.querySelector<HTMLIFrameElement>(".inline-page iframe");
      if (!el) throw new Error("missing iframe");
      return el;
    });
    if (!inlineIframe.contentWindow) throw new Error("missing contentWindow");
    const postSpy = vi.spyOn(inlineIframe.contentWindow, "postMessage");

    // 切换主题时推送 nocturne:inline-html:theme（只含 colorScheme 与 fontSize）且不卸载原 iframe
    act(() => {
      document.documentElement.dataset.theme = "light";
    });
    await waitFor(() => {
      expect(
        postSpy.mock.calls.some(
          (args) =>
            typeof args[0] === "object" &&
            args[0] !== null &&
            (args[0] as { type?: string }).type === "nocturne:inline-html:theme" &&
            (args[0] as { colorScheme?: string }).colorScheme === "light" &&
            !("theme" in (args[0] as Record<string, unknown>)),
        ),
      ).toBe(true);
    });
    expect(container.querySelector(".inline-page iframe")).toBe(inlineIframe);

    const fullBtn = screen.getByRole("button", { name: "全屏" });

    // 关闭方式 1：点击「关闭」按钮，同时验证全屏内「下载」按钮调用 saveFile
    fullBtn.focus();
    fireEvent.click(fullBtn);
    const dlg1 = screen.getByRole("dialog", { name: "季度统计" });
    expect(dlg1.parentElement).toBe(document.body);
    expect(collectVisibleTextNodes(dlg1)).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "下载" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "下载为 HTML" }));
    await waitFor(() => {
      expect(saveFile).toHaveBeenCalledTimes(1);
    });
    expect(saveFile.mock.calls[0]?.[0]).toMatchObject({
      filename: "季度统计.html",
      mimeType: "text/html;charset=utf-8",
    });

    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(screen.queryByRole("dialog", { name: "季度统计" })).toBeNull();
    expect(document.activeElement).toBe(fullBtn);

    // 关闭方式 2：按 Escape 键
    fireEvent.click(fullBtn);
    expect(screen.getByRole("dialog", { name: "季度统计" })).toBeDefined();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "季度统计" })).toBeNull();
    expect(document.activeElement).toBe(fullBtn);

    // 关闭方式 3：点击遮罩空白处
    fireEvent.click(fullBtn);
    const dlg3 = screen.getByRole("dialog", { name: "季度统计" });
    fireEvent.click(dlg3);
    expect(screen.queryByRole("dialog", { name: "季度统计" })).toBeNull();
    expect(document.activeElement).toBe(fullBtn);

    // 关闭方式 4：安卓返回键控制栈（controlRef.current.close()）
    fireEvent.click(fullBtn);
    expect(controlRef.current?.isOpen).toBe(true);
    act(() => {
      controlRef.current?.close();
    });
    expect(screen.queryByRole("dialog", { name: "季度统计" })).toBeNull();
    expect(document.activeElement).toBe(fullBtn);
  });

  it("全屏下载菜单包含 HTML 与图片两项，Esc 先关闭菜单，「下载为 HTML」保存独立 HTML", async () => {
    const view = createSessionView();
    view.entries = [
      makeToolEntry({
        files: [makeFile({ label: "月报.html", inlineTitle: "月报" })],
      }),
    ];
    const saveFile = vi.fn<SaveFileFn>(async () => undefined);
    const props = makeConversationProps(view);
    render(
      <ImageViewerProvider saveFile={saveFile}>
        <Conversation {...props} />
      </ImageViewerProvider>,
    );

    const fullBtn = await waitFor(() => screen.getByRole("button", { name: "全屏" }));
    fireEvent.click(fullBtn);

    const downloadBtn = screen.getByRole("button", { name: "下载" });
    fireEvent.click(downloadBtn);

    const items = screen.getAllByRole("menuitem");
    expect(items.map((el) => el.textContent?.trim())).toEqual(["下载为 HTML", "下载为图片"]);

    // Esc 仅关闭菜单，不关闭全屏遮罩，焦点回到下载按钮
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByRole("dialog", { name: "月报" })).toBeDefined();
    expect(document.activeElement).toBe(downloadBtn);

    // 再次打开并选择「下载为 HTML」
    fireEvent.click(downloadBtn);
    fireEvent.click(screen.getByRole("menuitem", { name: "下载为 HTML" }));
    await waitFor(() => {
      expect(saveFile).toHaveBeenCalledTimes(1);
    });
    expect(saveFile.mock.calls[0]?.[0]).toMatchObject({
      filename: "月报.html",
      mimeType: "text/html;charset=utf-8",
    });
    expect(new TextDecoder("utf-8").decode(saveFile.mock.calls[0]?.[0].bytes)).toBe(
      buildStandaloneInlineHtml("<!doctype html><html><body><h1>Chart</h1></body></html>"),
    );
  });

  it("「下载为图片」发出 capture 消息、导出期间禁用按钮，并在合法 PNG 回应后保存为 .png", async () => {
    const view = createSessionView();
    view.entries = [
      makeToolEntry({
        files: [makeFile({ label: "季度统计.html", inlineTitle: "季度统计" })],
      }),
    ];
    const saveFile = vi.fn<SaveFileFn>(async () => undefined);
    render(
      <ImageViewerProvider saveFile={saveFile}>
        <Conversation {...makeConversationProps(view)} />
      </ImageViewerProvider>,
    );

    const fullBtn = await waitFor(() => screen.getByRole("button", { name: "全屏" }));
    fireEvent.click(fullBtn);

    const dlg = screen.getByRole("dialog", { name: "季度统计" });
    const fullIframe = dlg.querySelector<HTMLIFrameElement>("iframe");
    if (!fullIframe?.contentWindow) throw new Error("missing fullscreen iframe");
    const postSpy = vi.spyOn(fullIframe.contentWindow, "postMessage");

    const downloadBtn = screen.getByRole("button", { name: "下载" });
    fireEvent.click(downloadBtn);
    fireEvent.click(screen.getByRole("menuitem", { name: "下载为图片" }));

    expect(downloadBtn.hasAttribute("disabled")).toBe(true);
    const captureCall = postSpy.mock.calls.find(
      (args) =>
        typeof args[0] === "object" &&
        args[0] !== null &&
        (args[0] as { type?: string }).type === "nocturne:inline-html:capture",
    );
    expect(captureCall).toBeDefined();
    const { id, requestId } = captureCall?.[0] as { id: string; requestId: string };
    expect(id).toMatch(/^full:/);
    expect(requestId).toBeTruthy();

    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          source: fullIframe.contentWindow,
          data: {
            type: "nocturne:inline-html:captured",
            id,
            requestId,
            png: pngBytes.buffer.slice(0),
          },
        }),
      );
    });

    await waitFor(() => {
      expect(saveFile).toHaveBeenCalledTimes(1);
    });
    expect(downloadBtn.hasAttribute("disabled")).toBe(false);
    expect(downloadBtn.getAttribute("title")).toBe("下载");
    expect(saveFile.mock.calls[0]?.[0]).toMatchObject({
      filename: "季度统计.png",
      mimeType: "image/png",
    });
    expect(Array.from(saveFile.mock.calls[0]?.[0].bytes ?? [])).toEqual(Array.from(pngBytes));
  });

  it("「下载为图片」忽略来源不对、id 不对与 requestId 不对的回应，不保存并提示失败", async () => {
    const view = createSessionView();
    view.entries = [
      makeToolEntry({
        files: [makeFile({ label: "校验.html", inlineTitle: "校验" })],
      }),
    ];
    const saveFile = vi.fn<SaveFileFn>(async () => undefined);
    render(
      <ImageViewerProvider saveFile={saveFile}>
        <Conversation {...makeConversationProps(view)} />
      </ImageViewerProvider>,
    );

    const fullBtn = await waitFor(() => screen.getByRole("button", { name: "全屏" }));
    fireEvent.click(fullBtn);

    const dlg = screen.getByRole("dialog", { name: "校验" });
    const fullIframe = dlg.querySelector<HTMLIFrameElement>("iframe");
    if (!fullIframe?.contentWindow) throw new Error("missing fullscreen iframe");
    const postSpy = vi.spyOn(fullIframe.contentWindow, "postMessage");
    const downloadBtn = screen.getByRole("button", { name: "下载" });
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 8]);

    vi.useFakeTimers();
    try {
      const startCapture = () => {
        postSpy.mockClear();
        fireEvent.click(downloadBtn);
        fireEvent.click(screen.getByRole("menuitem", { name: "下载为图片" }));
        const call = postSpy.mock.calls.find(
          (args) =>
            typeof args[0] === "object" &&
            args[0] !== null &&
            (args[0] as { type?: string }).type === "nocturne:inline-html:capture",
        );
        if (!call) throw new Error("missing capture postMessage");
        return call[0] as { id: string; requestId: string };
      };

      // 1. 来源不对
      const cap1 = startCapture();
      act(() => {
        window.dispatchEvent(
          new MessageEvent("message", {
            source: window,
            data: {
              type: "nocturne:inline-html:captured",
              id: cap1.id,
              requestId: cap1.requestId,
              png: pngBytes.buffer.slice(0),
            },
          }),
        );
      });
      expect(saveFile).not.toHaveBeenCalled();
      expect(downloadBtn.hasAttribute("disabled")).toBe(true);
      act(() => {
        vi.advanceTimersByTime(INLINE_PAGE_CAPTURE_TIMEOUT_MS);
      });
      expect(saveFile).not.toHaveBeenCalled();
      expect(downloadBtn.hasAttribute("disabled")).toBe(false);
      expect(downloadBtn.getAttribute("title")).toBe("导出失败");

      // 2. id 不对
      const cap2 = startCapture();
      act(() => {
        window.dispatchEvent(
          new MessageEvent("message", {
            source: fullIframe.contentWindow,
            data: {
              type: "nocturne:inline-html:captured",
              id: "full:wrong-id",
              requestId: cap2.requestId,
              png: pngBytes.buffer.slice(0),
            },
          }),
        );
      });
      expect(saveFile).not.toHaveBeenCalled();
      expect(downloadBtn.hasAttribute("disabled")).toBe(true);
      act(() => {
        vi.advanceTimersByTime(INLINE_PAGE_CAPTURE_TIMEOUT_MS);
      });
      expect(saveFile).not.toHaveBeenCalled();
      expect(downloadBtn.hasAttribute("disabled")).toBe(false);
      expect(downloadBtn.getAttribute("title")).toBe("导出失败");

      // 3. requestId 不对
      const cap3 = startCapture();
      act(() => {
        window.dispatchEvent(
          new MessageEvent("message", {
            source: fullIframe.contentWindow,
            data: {
              type: "nocturne:inline-html:captured",
              id: cap3.id,
              requestId: "stale-request-id",
              png: pngBytes.buffer.slice(0),
            },
          }),
        );
      });
      expect(saveFile).not.toHaveBeenCalled();
      expect(downloadBtn.hasAttribute("disabled")).toBe(true);
      act(() => {
        vi.advanceTimersByTime(INLINE_PAGE_CAPTURE_TIMEOUT_MS);
      });
      expect(saveFile).not.toHaveBeenCalled();
      expect(downloadBtn.hasAttribute("disabled")).toBe(false);
      expect(downloadBtn.getAttribute("title")).toBe("导出失败");
    } finally {
      vi.useRealTimers();
    }
  });

  it("「下载为图片」拒绝非 PNG、超过 16 MiB 与超时，均不保存且提示失败", async () => {
    const view = createSessionView();
    view.entries = [
      makeToolEntry({
        files: [makeFile({ label: "边界.html", inlineTitle: "边界" })],
      }),
    ];
    const saveFile = vi.fn<SaveFileFn>(async () => undefined);
    render(
      <ImageViewerProvider saveFile={saveFile}>
        <Conversation {...makeConversationProps(view)} />
      </ImageViewerProvider>,
    );

    const fullBtn = await waitFor(() => screen.getByRole("button", { name: "全屏" }));
    fireEvent.click(fullBtn);

    const dlg = screen.getByRole("dialog", { name: "边界" });
    const fullIframe = dlg.querySelector<HTMLIFrameElement>("iframe");
    if (!fullIframe?.contentWindow) throw new Error("missing fullscreen iframe");
    const postSpy = vi.spyOn(fullIframe.contentWindow, "postMessage");
    const downloadBtn = screen.getByRole("button", { name: "下载" });

    vi.useFakeTimers();
    try {
      const startCapture = () => {
        postSpy.mockClear();
        fireEvent.click(downloadBtn);
        fireEvent.click(screen.getByRole("menuitem", { name: "下载为图片" }));
        const call = postSpy.mock.calls.find(
          (args) =>
            typeof args[0] === "object" &&
            args[0] !== null &&
            (args[0] as { type?: string }).type === "nocturne:inline-html:capture",
        );
        if (!call) throw new Error("missing capture postMessage");
        return call[0] as { id: string; requestId: string };
      };

      // 4. 非 PNG 文件头
      const cap1 = startCapture();
      const notPng = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
      act(() => {
        window.dispatchEvent(
          new MessageEvent("message", {
            source: fullIframe.contentWindow,
            data: {
              type: "nocturne:inline-html:captured",
              id: cap1.id,
              requestId: cap1.requestId,
              png: notPng.buffer,
            },
          }),
        );
      });
      expect(saveFile).not.toHaveBeenCalled();
      expect(downloadBtn.hasAttribute("disabled")).toBe(false);
      expect(downloadBtn.getAttribute("title")).toBe("导出失败");

      // 5. 超过 16 MiB
      const cap2 = startCapture();
      const oversized = new Uint8Array(INLINE_PAGE_CAPTURE_MAX_BYTES + 1);
      oversized.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
      act(() => {
        window.dispatchEvent(
          new MessageEvent("message", {
            source: fullIframe.contentWindow,
            data: {
              type: "nocturne:inline-html:captured",
              id: cap2.id,
              requestId: cap2.requestId,
              png: oversized.buffer,
            },
          }),
        );
      });
      expect(saveFile).not.toHaveBeenCalled();
      expect(downloadBtn.hasAttribute("disabled")).toBe(false);
      expect(downloadBtn.getAttribute("title")).toBe("导出失败");

      // 6. 超时（以及超时后迟到的合法回应不再保存）
      const cap3 = startCapture();
      expect(downloadBtn.hasAttribute("disabled")).toBe(true);
      act(() => {
        vi.advanceTimersByTime(INLINE_PAGE_CAPTURE_TIMEOUT_MS);
      });
      expect(saveFile).not.toHaveBeenCalled();
      expect(downloadBtn.hasAttribute("disabled")).toBe(false);
      expect(downloadBtn.getAttribute("title")).toBe("导出失败");

      const latePng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
      act(() => {
        window.dispatchEvent(
          new MessageEvent("message", {
            source: fullIframe.contentWindow,
            data: {
              type: "nocturne:inline-html:captured",
              id: cap3.id,
              requestId: cap3.requestId,
              png: latePng.buffer,
            },
          }),
        );
      });
      expect(saveFile).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("附件读取失败或远程被拒时退回普通文件附件卡片", async () => {
    const view = createSessionView();
    view.entries = [
      makeToolEntry({
        files: [makeFile({ label: "失败回退.html", inlineTitle: "失败回退" })],
      }),
    ];
    const readFail = vi.fn(async () => {
      throw new Error("remote_attachment_denied");
    });
    const { container } = render(<Conversation {...makeConversationProps(view, readFail)} />);

    const fallbackCard = await waitFor(() => {
      const el = container.querySelector<HTMLButtonElement>(".fcard");
      if (!el) throw new Error("missing .fcard");
      return el;
    });
    expect(container.querySelector(".inline-page")).toBeNull();
    expect(fallbackCard.textContent).toContain("失败回退.html");
    expect(fallbackCard.getAttribute("title")).toContain("remote_attachment_denied");
  });
});
