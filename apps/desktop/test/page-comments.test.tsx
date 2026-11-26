// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSessionView,
  formatPageCommentsBlock,
  type FileAttachment,
  type PageCommentsSnapshot,
  type SessionPage,
  type UserEntry,
} from "@nocturne/core/protocol";

import { createAttachmentImageSource } from "../src/attachment-images";
import { Conversation } from "../src/Conversation";
import { InlinePage, PagePane } from "../src/InlinePage";

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
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function makePageFile(file: string, title: string, version: number): FileAttachment {
  return {
    type: "file",
    file,
    bytes: 64,
    sha256: "a".repeat(64),
    label: `${title}.html`,
    mimeType: "text/html",
    source: "upload",
    inline: { title, page: "page-1", version, display: "panel" },
  };
}

function makeFakeSession() {
  return {
    id: "sess-1",
    readAttachment: vi.fn(async (file: string) => ({
      data: new TextEncoder().encode(`<!doctype html><html><body><h1>${file}</h1></body></html>`),
      mimeType: "text/html",
      bytes: 64,
    })),
  };
}

const legacyCommentedPage: SessionPage = {
  page: "page-1",
  title: "Agent Loop",
  display: "panel",
  versions: [
    {
      version: 1,
      title: "Agent Loop",
      file: makePageFile("file-1.html", "Agent Loop", 1),
      seq: 2,
    },
    {
      version: 2,
      title: "Agent Loop",
      file: makePageFile("file-2.html", "Agent Loop", 2),
      seq: 5,
    },
  ],
  comments: [
    {
      id: "c1",
      version: 1,
      seq: 3,
      time: "2026-11-24T10:00:00.000Z",
      path: "body > h1",
      text: "file-1.html",
      x: 42,
      y: 28,
      note: "放大标题字号",
      pending: false,
      resolved: false,
      replies: [
        {
          by: "model",
          text: "已经把标题调整为 28px。",
          version: 2,
          seq: 4,
          time: "2026-11-24T10:01:00.000Z",
        },
      ],
    },
  ],
};

function installMockIframeSource(iframe: HTMLIFrameElement): {
  messages: unknown[];
  fakeWin: Window;
} {
  const messages: unknown[] = [];
  const fakeWin = {
    postMessage: (msg: unknown) => {
      messages.push(msg);
    },
  } as unknown as Window;
  Object.defineProperty(iframe, "contentWindow", {
    configurable: true,
    value: fakeWin,
  });
  return { messages, fakeWin };
}

function dispatchFromIframe(fakeWin: Window, data: unknown) {
  act(() => {
    window.dispatchEvent(new MessageEvent("message", { data, source: fakeWin }));
  });
}

describe("历史面板页面只读讨论串与对话历史回放（ADR-0125）", () => {
  it("历史面板不提供新建评论或回复入口，但保留只读讨论串查看、本地解决与版本切换", async () => {
    const onResolve = vi.fn(async () => undefined);
    const onSelectVersion = vi.fn();
    const session = makeFakeSession();

    const { container } = render(
      <PagePane
        page={legacyCommentedPage}
        selectedVersion={2}
        session={session}
        onSelectVersion={onSelectVersion}
        comments={{ onResolve }}
      />,
    );

    const iframe = await waitFor(() => {
      const el = container.querySelector<HTMLIFrameElement>("iframe.page-pane-frame");
      if (!el) throw new Error("iframe not mounted");
      return el;
    });
    const { messages, fakeWin } = installMockIframeSource(iframe);
    dispatchFromIframe(fakeWin, { type: "nocturne:inline-html:ready" });

    // 工具栏不再有评论模式按钮，只保留版本切换与下载
    expect(screen.queryByRole("button", { name: "评论" })).toBeNull();
    expect(screen.getByRole("button", { name: "下载" })).toBeTruthy();

    // 空壳收到 commentMode=false 和历史未解决圆点（v1 评论在 v2 跨版重定位展示）
    const modeMsg = messages.find(
      (m): m is { type: string; enabled: boolean } =>
        typeof m === "object" &&
        m !== null &&
        (m as { type?: string }).type === "nocturne:inline-html:comment-mode",
    );
    expect(modeMsg?.enabled).toBe(false);

    const pinsMsg = messages.find(
      (m): m is { type: string; id: string; pins: { id: string; relocate?: boolean }[] } =>
        typeof m === "object" &&
        m !== null &&
        (m as { type?: string }).type === "nocturne:inline-html:comment-pins",
    );
    expect(pinsMsg?.pins).toMatchObject([{ id: "c1", relocate: true }]);

    // 点击历史圆点：弹出只读讨论串（含历史用户评论与模型回复、无回复框、保留解决按钮）
    dispatchFromIframe(fakeWin, {
      type: "nocturne:inline-html:comment-pin-click",
      id: pinsMsg?.id ?? "",
      pinId: "c1",
      viewportX: 100,
      viewportY: 120,
    });

    const dialog = await screen.findByRole("dialog", { name: "评论" });
    expect(dialog.textContent).toContain("放大标题字号");
    expect(dialog.textContent).toContain("已经把标题调整为 28px。");
    expect(screen.queryByLabelText("回复")).toBeNull();
    expect(screen.queryByRole("button", { name: "发送" })).toBeNull();

    // 可本地标记解决旧讨论串
    fireEvent.click(screen.getByRole("button", { name: "解决" }));
    await waitFor(() => expect(onResolve).toHaveBeenCalledWith("c1"));
  });

  it("内嵌图表不显示评论按钮", async () => {
    const session = makeFakeSession();
    const inlineFile: FileAttachment = {
      ...makePageFile("file-inline.html", "内嵌图", 1),
      inline: { title: "内嵌图", page: "page-2", version: 1, display: "inline" },
    };
    render(
      <InlinePage file={inlineFile} session={session} renderFallback={() => <div>fallback</div>} />,
    );
    await waitFor(() => expect(session.readAttachment).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "评论" })).toBeNull();
  });

  it("对话历史气泡保留历史华彩标签与历史页面评论标签，并隐藏尾部英文块", () => {
    const snapshot: PageCommentsSnapshot = {
      page: "page-1",
      version: 2,
      title: "Agent Loop",
      comments: [
        {
          id: "c1",
          path: "body > h1",
          text: "Agent Loop",
          x: 42,
          y: 28,
          note: "放大标题字号",
        },
      ],
    };
    const cadenzaEntry: UserEntry = {
      kind: "user",
      key: "user-1",
      seq: 1,
      turnId: "t1",
      content: [
        { type: "text", text: "做个架构图" },
        {
          type: "text",
          text: '<work-mode name="cadenza">\nUse render_html with display: "panel".\n</work-mode>',
        },
      ],
      workMode: { name: "cadenza", body: 'Use render_html with display: "panel".' },
    };
    const commentEntry: UserEntry = {
      kind: "user",
      key: "user-2",
      seq: 2,
      turnId: "t2",
      content: [
        { type: "text", text: "请按评论修改" },
        { type: "text", text: formatPageCommentsBlock(snapshot) },
      ],
      pageComments: snapshot,
    };
    const view = {
      ...createSessionView(),
      entries: [cadenzaEntry, commentEntry],
    };
    const images = createAttachmentImageSource();

    const { container } = render(
      <Conversation
        readOnly={{ frozen: false }}
        session={{ ...makeFakeSession(), readOnly: true }}
        view={view}
        images={images}
        cwd="/ws"
        openUrl={vi.fn()}
        busy={false}
        subscribeEvents={() => vi.fn()}
      />,
    );

    expect(container.textContent).toContain("华彩");
    expect(container.textContent).toContain("做个架构图");
    expect(container.textContent).toContain("请按评论修改");
    expect(container.textContent).toContain("Agent Loop v2 · 1");
    expect(container.textContent).not.toContain("<page-comments");
    expect(container.textContent).not.toContain("<work-mode");
  });
});
