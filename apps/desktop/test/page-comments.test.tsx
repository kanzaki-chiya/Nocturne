// @vitest-environment jsdom
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
}: {
  onSubmitted?: (payload: ComposerSubmit) => void;
  supportsImageInput?: () => Promise<boolean>;
}) {
  const [selectedVersion, setSelectedVersion] = useState<number | undefined>(1);
  const [groups, setGroups] = useState<DraftPageCommentGroup[]>([]);
  const [session] = useState(() => makeFakeSession());

  return (
    <div>
      <PagePane
        page={twoVersionPage}
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
