// @vitest-environment jsdom
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSessionView,
  formatPageCommentsBlock,
  type FileAttachment,
  type PageCommentsInput,
  type PageCommentsSnapshot,
  type PendingInputItem,
  type SessionPage,
  type UserEntry,
} from "@nocturne/core/protocol";

import { createAttachmentImageSource } from "../src/attachment-images";
import { Composer, type ComposerSubmit } from "../src/Composer";
import { Conversation } from "../src/Conversation";
import { InlinePage, PagePane } from "../src/InlinePage";
import {
  addDraftPageComment,
  removeDraftPageComment,
  removeDraftPageCommentGroup,
  updateDraftPageComment,
  type DraftPageComment,
  type DraftPageCommentGroup,
} from "../src/page-comments";

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

const twoVersionPage: SessionPage = {
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
};

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

function Harness({
  onSubmitted,
  supportsImageInput,
  page = twoVersionPage,
  pendingInputs = [],
  onSend = vi.fn(async () => undefined),
  onResolve = vi.fn(async () => undefined),
}: {
  onSubmitted?: (payload: ComposerSubmit) => void;
  supportsImageInput?: () => Promise<boolean>;
  page?: SessionPage;
  pendingInputs?: PendingInputItem[];
  onSend?: (input: PageCommentsInput) => Promise<void>;
  onResolve?: (id: string) => Promise<void>;
}) {
  const [selectedVersion, setSelectedVersion] = useState<number | undefined>(1);
  const [groups, setGroups] = useState<DraftPageCommentGroup[]>([]);
  const [session] = useState(() => makeFakeSession());

  return (
    <div>
      <PagePane
        page={page}
        selectedVersion={selectedVersion}
        session={session}
        onSelectVersion={setSelectedVersion}
        comments={{
          itemsForVersion: (version) =>
            groups.find((g) => g.page === "page-1" && g.version === version)?.comments ?? [],
          onAdd: (version, title, item: DraftPageComment) => {
            setGroups((prev) =>
              addDraftPageComment(prev, { page: "page-1", version, title }, item),
            );
          },
          onUpdate: (version, id, note) => {
            setGroups((prev) => updateDraftPageComment(prev, "page-1", version, id, note));
          },
          onDelete: (version, id) => {
            setGroups((prev) => removeDraftPageComment(prev, "page-1", version, id));
          },
          pendingInputs,
          onSend,
          onResolve,
          supportsImageInput,
        }}
      />
      <Composer
        variant="session"
        running={false}
        fileRefs={null}
        pickImages={vi.fn(async () => [])}
        onSlash={vi.fn(async () => false)}
        pageComments={groups}
        onRemovePageComments={(pageId, version) => {
          setGroups((prev) => removeDraftPageCommentGroup(prev, pageId, version));
        }}
        onSubmit={(input) => {
          onSubmitted?.(input);
          const pc = input.pageComments;
          if (pc !== undefined) {
            setGroups((prev) => removeDraftPageCommentGroup(prev, pc.page, pc.version));
          }
          return true;
        }}
        onInterrupt={vi.fn()}
      />
    </div>
  );
}

function must<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) throw new Error(`missing ${label}`);
  return value;
}

describe("桌面面板页面讨论串（ADR-0115）", () => {
  it("发送按钮交付单条评论，待发圆点只显示加载圈", async () => {
    const onSend = vi.fn(async (_input: PageCommentsInput) => undefined);
    const rendered = render(<Harness onSend={onSend} />);
    const dispatch = await connectCommentFrame();
    fireEvent.click(screen.getByRole("button", { name: "评论" }));
    dispatch({
      type: "nocturne:inline-html:comment-pick",
      path: "body > #entry",
      text: "入口",
      x: 40,
      y: 60,
      viewportX: 40,
      viewportY: 60,
      hasVisibleText: true,
    });
    const dialog = screen.getByRole("dialog", { name: "评论" });
    expect(
      within(dialog)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["取消", "添加", "发送"]);
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "加粗" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "发送" }));
    await waitFor(() => expect(onSend).toHaveBeenCalledOnce());
    const submitted = must(onSend.mock.calls[0]?.[0], "sent comment");
    expect(submitted).toEqual({
      page: "page-1",
      title: "Agent Loop",
      version: 1,
      comments: [{ path: "body > #entry", text: "入口", x: 40, y: 60, note: "加粗" }],
    });
    rendered.rerender(
      <Harness
        onSend={onSend}
        pendingInputs={[
          {
            id: "pi-1",
            mode: "steer",
            text: "",
            createdAt: "2026-11-24T11:00:00Z",
            attachments: 0,
            paused: false,
            pageComments: {
              page: submitted.page,
              title: submitted.title,
              version: submitted.version,
              count: 1,
              items: submitted.comments,
            },
          },
        ]}
      />,
    );
    dispatch({
      type: "nocturne:inline-html:comment-pin-click",
      pinId: "pi-1:0",
      viewportX: 40,
      viewportY: 60,
    });
    const thread = screen.getByRole("dialog", { name: "评论" });
    expect(within(thread).getByText("加粗")).toBeTruthy();
    expect(thread.querySelector('[aria-busy="true"]')).toBeTruthy();
    expect(within(thread).queryByRole("textbox")).toBeNull();
  });

  it("展示往来、发送续回并解决讨论，解决后移除圆点和计数", async () => {
    const time = "2026-11-24T11:00:00Z";
    const page: SessionPage = {
      ...twoVersionPage,
      comments: [
        {
          id: "c1",
          path: "#entry",
          text: "入口",
          x: 40,
          y: 60,
          note: "加粗",
          version: 1,
          seq: 3,
          time,
          pending: false,
          resolved: false,
          replies: [{ by: "model", text: "已经加粗。", version: 2, seq: 6, time }],
        },
      ],
    };
    const onSend = vi.fn(async (_input: PageCommentsInput) => undefined);
    const onResolve = vi.fn(async (_id: string) => undefined);
    const { container, rerender } = render(
      <Harness page={page} onSend={onSend} onResolve={onResolve} />,
    );
    const dispatch = await connectCommentFrame();
    const open = () =>
      dispatch({
        type: "nocturne:inline-html:comment-pin-click",
        pinId: "c1",
        viewportX: 40,
        viewportY: 60,
      });
    open();
    const dialog = screen.getByRole("dialog", { name: "评论" });
    for (const text of ["你", "Nocturne", "v1", "v2", "已经加粗。"])
      expect(within(dialog).getByText(text)).toBeTruthy();
    expect(dialog.querySelectorAll("time")).toHaveLength(2);
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "强调色" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "发送" }));
    await waitFor(() =>
      expect(onSend.mock.calls[0]?.[0].comments).toEqual([{ replyTo: "c1", note: "强调色" }]),
    );
    const resolve = within(dialog).getByRole("button", { name: "解决" });
    expect(resolve.getAttribute("title")).toBe("解决");
    fireEvent.click(resolve);
    await waitFor(() => expect(onResolve).toHaveBeenCalledWith("c1"));
    rerender(
      <Harness
        page={{
          ...page,
          comments: page.comments?.map((thread) => ({ ...thread, resolved: true })),
        }}
        onSend={onSend}
        onResolve={onResolve}
      />,
    );
    expect(container.querySelector(".page-pane-comment-count")).toBeNull();
    open();
    expect(screen.queryByRole("dialog", { name: "评论" })).toBeNull();
  });
});

async function connectCommentFrame() {
  const iframe = (await screen.findByTitle("Agent Loop")) as HTMLIFrameElement;
  const win = must(iframe.contentWindow, "contentWindow");
  const post = vi.spyOn(win, "postMessage").mockImplementation(() => undefined);
  const dispatch = (data: Record<string, unknown>) =>
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { source: win, data }));
    });
  dispatch({ type: "nocturne:inline-html:ready" });
  const message = post.mock.calls
    .map(([data]) => data as { type: string; id: string })
    .find((data) => data.type === "nocturne:inline-html:render");
  const id = must(message, "frame render").id;
  return (data: Record<string, unknown>) => dispatch({ ...data, id });
}

describe("桌面面板页面评论交互（ADR-0113）", () => {
  it("评论模式开关、添加/编辑/删除评论、切版本只显示该版圆点、标签展示与空输入框发送", async () => {
    const submitted: ComposerSubmit[] = [];
    render(<Harness onSubmitted={(p) => submitted.push(p)} />);

    const iframe = (await screen.findByTitle("Agent Loop")) as HTMLIFrameElement;
    const win = must(iframe.contentWindow, "contentWindow");
    const posted: Record<string, unknown>[] = [];
    vi.spyOn(win, "postMessage").mockImplementation((msg: unknown) => {
      posted.push(msg as Record<string, unknown>);
    });

    // 模拟空壳 ready，触发宿主发 render 并记下 instanceId
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { type: "nocturne:inline-html:ready" },
          source: win,
        }),
      );
    });
    const renderMsg = posted.find((m) => m.type === "nocturne:inline-html:render");
    expect(renderMsg).toBeDefined();
    const instId = String(renderMsg?.id);

    // 1. 打开评论模式
    const commentBtn = screen.getByRole("button", { name: "评论" });
    expect(commentBtn.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(commentBtn);
    expect(commentBtn.getAttribute("aria-pressed")).toBe("true");
    expect(posted).toContainEqual(
      expect.objectContaining({
        type: "nocturne:inline-html:comment-mode",
        id: instId,
        enabled: true,
      }),
    );

    // 2. 模拟在页面点击位置 -> 弹出无 placeholder 的输入框 -> 添加评论
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: {
            type: "nocturne:inline-html:comment-pick",
            id: instId,
            path: "body > #box-1",
            text: "工具执行",
            x: 120,
            y: 180,
            hasVisibleText: true,
            viewportX: 120,
            viewportY: 180,
          },
          source: win,
        }),
      );
    });
    const dialog = screen.getByRole("dialog", { name: "评论" });
    const textarea = must(dialog.querySelector("textarea"), "textarea");
    expect(textarea.getAttribute("placeholder")).toBeNull();
    const addBtn = within(dialog).getByRole("button", { name: "添加" });
    expect((addBtn as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(textarea, { target: { value: "改成两行" } });
    fireEvent.click(addBtn);

    // 输入框上方出现标签「Agent Loop v1 · 1」
    expect(screen.getByText("Agent Loop v1 · 1")).toBeTruthy();
    // 同步圆点给空壳
    const lastPinsV1 = [...posted]
      .reverse()
      .find((m) => m.type === "nocturne:inline-html:comment-pins");
    expect(lastPinsV1?.pins).toHaveLength(1);
    const pinId = must((lastPinsV1?.pins as { id: string }[])[0], "pin").id;

    // 3. 点击已有圆点可修改内容
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: {
            type: "nocturne:inline-html:comment-pin-click",
            id: instId,
            pinId,
            viewportX: 120,
            viewportY: 180,
          },
          source: win,
        }),
      );
    });
    const editInput = must(
      screen.getByRole("dialog", { name: "评论" }).querySelector("textarea"),
      "edit textarea",
    );
    expect(editInput.value).toBe("改成两行");
    fireEvent.change(editInput, { target: { value: "改成两行并左对齐" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    // 4. 切换到 v2：只显示 v2 的圆点（0 个），但输入框标签仍保留 v1 的
    fireEvent.click(screen.getByRole("button", { name: "下一版本" }));
    await waitFor(() => {
      expect(screen.getByText("2 / 2")).toBeTruthy();
    });
    const iframeV2 = (await screen.findByTitle("Agent Loop")) as HTMLIFrameElement;
    const winV2 = must(iframeV2.contentWindow, "contentWindow v2");
    const postedV2: Record<string, unknown>[] = [];
    vi.spyOn(winV2, "postMessage").mockImplementation((msg: unknown) => {
      postedV2.push(msg as Record<string, unknown>);
    });
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { type: "nocturne:inline-html:ready" },
          source: winV2,
        }),
      );
    });
    const pinsV2 = [...postedV2]
      .reverse()
      .find((m) => m.type === "nocturne:inline-html:comment-pins");
    expect(pinsV2?.pins).toEqual([]);
    expect(screen.getByText("Agent Loop v1 · 1")).toBeTruthy();

    // 5. 输入框为空时仍可发送；发送后清空评论与标签
    const sendBtn = screen.getByRole("button", { name: "发送" }) as HTMLButtonElement;
    expect(sendBtn.disabled).toBe(false);
    fireEvent.click(sendBtn);

    await waitFor(() => {
      expect(submitted).toHaveLength(1);
    });
    expect(submitted[0]?.text).toBe("");
    expect(submitted[0]?.pageComments).toEqual({
      page: "page-1",
      version: 1,
      title: "Agent Loop",
      comments: [
        {
          path: "body > #box-1",
          text: "工具执行",
          x: 120,
          y: 180,
          note: "改成两行并左对齐",
        },
      ],
    });
    expect(screen.queryByText("Agent Loop v1 · 1")).toBeNull();
  });

  it("点击标签 × 可移除全部未发送评论，点击编辑弹窗「删除」可删单条评论", async () => {
    render(<Harness />);
    const iframe = (await screen.findByTitle("Agent Loop")) as HTMLIFrameElement;
    const win = must(iframe.contentWindow, "contentWindow");
    const posted: Record<string, unknown>[] = [];
    vi.spyOn(win, "postMessage").mockImplementation((msg: unknown) => {
      posted.push(msg as Record<string, unknown>);
    });
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { type: "nocturne:inline-html:ready" },
          source: win,
        }),
      );
    });
    const instId = String(posted.find((m) => m.type === "nocturne:inline-html:render")?.id);

    // 添加两条评论
    for (const note of ["第一条", "第二条"]) {
      act(() => {
        window.dispatchEvent(
          new MessageEvent("message", {
            data: {
              type: "nocturne:inline-html:comment-pick",
              id: instId,
              path: "body > #box",
              text: "块",
              x: 40,
              y: 50,
              hasVisibleText: true,
              viewportX: 40,
              viewportY: 50,
            },
            source: win,
          }),
        );
      });
      const dlg = screen.getByRole("dialog", { name: "评论" });
      fireEvent.change(must(dlg.querySelector("textarea"), "textarea"), {
        target: { value: note },
      });
      fireEvent.click(within(dlg).getByRole("button", { name: "添加" }));
    }
    expect(screen.getByText("Agent Loop v1 · 2")).toBeTruthy();

    // 删除第一条
    const pins = [...posted].reverse().find((m) => m.type === "nocturne:inline-html:comment-pins")
      ?.pins as { id: string }[];
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: {
            type: "nocturne:inline-html:comment-pin-click",
            id: instId,
            pinId: must(pins[0], "first pin").id,
            viewportX: 40,
            viewportY: 50,
          },
          source: win,
        }),
      );
    });
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    expect(screen.getByText("Agent Loop v1 · 1")).toBeTruthy();

    // 点标签 × 清掉剩余评论
    fireEvent.click(screen.getByRole("button", { name: "移除评论" }));
    expect(screen.queryByText("Agent Loop v1 · 1")).toBeNull();
  });

  it("用户消息渲染评论标签且不展示追加给模型的英文块", () => {
    const snapshot: PageCommentsSnapshot = {
      page: "page-1",
      version: 2,
      title: "Agent Loop",
      comments: [{ path: "body > #x", text: "节点", x: 10, y: 20, note: "放大字号" }],
    };
    const userEntry: UserEntry = {
      kind: "user",
      key: "u:1",
      seq: 1,
      turnId: "t1",
      content: [
        { type: "text", text: "顺便换浅色" },
        { type: "text", text: formatPageCommentsBlock(snapshot) },
      ],
      pageComments: snapshot,
    };
    const view = { ...createSessionView(), entries: [userEntry] };
    render(
      <Conversation
        session={{ id: "s1", readOnly: true, readAttachment: vi.fn() }}
        readOnly={{ frozen: false }}
        view={view}
        busy={false}
        subscribeEvents={() => () => undefined}
        cwd="Z:\\proj"
        openUrl={vi.fn()}
        images={createAttachmentImageSource()}
      />,
    );

    const msg = screen.getByRole("article", { name: "用户消息" });
    expect(within(msg).getByText("Agent Loop v2 · 1")).toBeTruthy();
    expect(within(msg).getByText("顺便换浅色")).toBeTruthy();
    expect(screen.queryByText(/<page-comments/)).toBeNull();
  });

  it("内嵌页面（InlinePage）不出现评论按钮", async () => {
    const file: FileAttachment = {
      type: "file",
      file: "file-inline.html",
      bytes: 40,
      sha256: "b".repeat(64),
      label: "小图.html",
      mimeType: "text/html",
      source: "upload",
      inline: { title: "小图", display: "inline" },
    };
    render(
      <InlinePage
        file={file}
        session={makeFakeSession()}
        renderFallback={() => <div>fallback</div>}
      />,
    );
    await screen.findByTitle("小图");
    expect(screen.queryByRole("button", { name: "评论" })).toBeNull();
  });
});
