/**
 * 页面版本与右侧面板交互测试（ADR-0109）：
 * - 桌面端：面板页面入口行、选中样式、内嵌页面「在面板打开」、版本切换与箭头置灰、
 *   面板页面实时新版本自动打开与回放不自动打开、停在旧版本不跳转、下载当前版本、panelSessions 只存打开标记。
 * - 手机端：面板页面入口行打开全屏遮罩、全屏遮罩版本切换与箭头置灰、内嵌页面不显示「在面板打开」且全屏可切版本。
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSessionView,
  reduceSessionView,
  type DurableEvent,
  type FileAttachment,
  type SessionView,
} from "@nocturne/core/protocol";
import type { RpcClient, RpcSession } from "@nocturne/rpc/client";

import { Conversation } from "../src/Conversation";
import type { OpenConversation } from "../src/conversations";
import type { DesktopHost } from "../src/host";
import { ImageViewerProvider, type SaveFileFn } from "../src/ImageViewer";
import { useSidePanel, type SidePanelController } from "../src/PanelHost";
import { TitlebarSlot } from "../src/PanelChrome";
import { createPrefsStore, PREFS_KEY, type PrefsStore } from "../src/prefs";
import { parseStoredTabs, storedTabs } from "../src/side-panel";

afterEach(cleanup);

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k) => data.get(k) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (k) => {
      data.delete(k);
    },
    setItem: (k, v) => {
      data.set(k, v);
    },
  };
}

function makeHost(): DesktopHost {
  return {
    name: "test",
    backendArgs: () => [],
    openUrl: vi.fn(async () => undefined),
    pickDirectory: vi.fn(async () => null),
    pickImages: vi.fn(async () => []),
    setWindowTitle: vi.fn(),
    notify: vi.fn(),
    isWindowFocused: () => true,
    onFocusChange: () => () => undefined,
    openPath: vi.fn(async () => undefined),
    revealInFolder: vi.fn(async () => undefined),
    openInEditor: vi.fn(async () => undefined),
    detectEditors: vi.fn(async () => []),
    note: vi.fn(),
    saveFile: vi.fn(async () => undefined),
  } as unknown as DesktopHost;
}

function makeHtmlAttachment(opts: {
  file: string;
  title: string;
  page?: string;
  version?: number;
  display?: "inline" | "panel";
}): FileAttachment {
  return {
    type: "file",
    file: opts.file,
    bytes: 64,
    sha256: `${opts.file}-sha`.padEnd(64, "0").slice(0, 64),
    label: `${opts.title}.html`,
    mimeType: "text/html",
    source: "upload",
    inline: {
      title: opts.title,
      ...(opts.page !== undefined ? { page: opts.page } : {}),
      ...(opts.version !== undefined ? { version: opts.version } : {}),
      ...(opts.display !== undefined ? { display: opts.display } : {}),
    },
  };
}

function makeToolCompletedEvent(
  seq: number,
  callId: string,
  file: FileAttachment,
): DurableEvent<"tool.completed"> {
  return {
    seq,
    sessionId: "sess-1",
    turnId: `turn-${seq}`,
    time: "2026-11-21T00:00:00.000Z",
    type: "tool.completed",
    payload: {
      callId,
      name: "render_html",
      status: "ok",
      modelContent: "ok",
      durationMs: 10,
      files: [file],
    },
  };
}

function buildView(files: FileAttachment[]): SessionView {
  const view = createSessionView();
  reduceSessionView(view, {
    seq: 1,
    sessionId: "sess-1",
    time: "2026-11-21T00:00:00.000Z",
    type: "session.created",
    payload: {
      cwd: "/ws",
      workspaceRoot: "/ws",
      model: { provider: "fake", model: "m" },
      permissionPreset: "default",
      formatVersion: 1,
      nocturneVersion: "0.58.0",
    },
  });
  files.forEach((f, idx) => {
    reduceSessionView(view, makeToolCompletedEvent(idx + 2, `call-${idx + 1}`, f));
  });
  return view;
}

interface DesktopHarnessProps {
  initialView: SessionView;
  htmlMap: Record<string, string>;
  prefs: PrefsStore;
  saveFile?: SaveFileFn;
  onController?: (ctrl: SidePanelController) => void;
  onPushEvent?: (fn: (ev: DurableEvent, live: boolean) => void) => void;
}

function DesktopHarness({
  initialView,
  htmlMap,
  prefs,
  saveFile,
  onController,
  onPushEvent,
}: DesktopHarnessProps) {
  const [view, setView] = useState<SessionView>(initialView);
  const [, setTick] = useState(0);
  const sessionRef = useRef<RpcSession>({
    id: "sess-1",
    readAttachment: vi.fn(async (file: string) => ({
      data: new TextEncoder().encode(htmlMap[file] ?? "<p>missing</p>"),
      mimeType: "text/html",
    })),
  } as unknown as RpcSession);

  const active: OpenConversation = {
    session: sessionRef.current,
    view,
    workspace: "/ws",
    turnChanges: new Map(),
    pendingInputs: { items: [], paused: false },
    outgoing: { items: [], keys: new Map() },
    warnings: [],
  } as unknown as OpenConversation;

  const sidePanel = useSidePanel({
    prefs,
    host: makeHost(),
    sessionId: "sess-1",
    active,
    sessionCwd: "/ws",
    sessions: [],
    openIds: new Set(["sess-1"]),
    loadDiff: vi.fn(async () => ({ diff: "", binary: false, truncated: false })),
    editors: { vscode: false, cursor: false },
    settingsOpen: false,
    plainKey: "plain",
    client: undefined as unknown as RpcClient,
    ensureClient: vi.fn(),
    images: {
      url: () => undefined,
      subscribe: () => () => undefined,
      preview: () => undefined,
    } as unknown as Parameters<typeof useSidePanel>[0]["images"],
    fileLinks: undefined,
    shellKind: "pwsh",
    resolveAppIcon: undefined,
    suites: [],
    suitesVersion: 0,
    onUpdateSuite: undefined,
    openDirectory: undefined,
    onAppMessage: undefined,
  });

  onController?.(sidePanel);
  const sidePanelRef = useRef(sidePanel);
  sidePanelRef.current = sidePanel;
  const viewRef = useRef(view);
  viewRef.current = view;

  onPushEvent?.((ev, live) => {
    const next = structuredClone(viewRef.current);
    reduceSessionView(next, ev);
    setView(next);
    setTick((n) => n + 1);
    if (live && ev.type === "tool.completed" && ev.payload.status === "ok") {
      const f = ev.payload.files?.[0];
      const inlinePage = f?.inline?.page;
      if (inlinePage !== undefined) {
        const p = next.pages.find((item) => item.page === inlinePage);
        if (p?.display === "panel") {
          sidePanelRef.current.onLivePanelPage("sess-1", p.page);
        }
      }
    }
  });

  const noopSub = () => () => undefined;

  return (
    <ImageViewerProvider saveFile={saveFile}>
      <TitlebarSlot value={null}>
        <div className={`body${sidePanel.bodyClass}`} ref={sidePanel.bodyRef}>
          <div className={`main${sidePanel.mainClass}`}>
            {sidePanel.mainOverlays}
            <Conversation
              session={sessionRef.current}
              view={view}
              openUrl={() => undefined}
              cwd="/ws"
              subscribeEvents={noopSub}
              images={
                {
                  url: () => undefined,
                  subscribe: () => () => undefined,
                  preview: () => undefined,
                } as unknown as Parameters<typeof Conversation>[0]["images"]
              }
              busy={false}
              onOpenPage={sidePanel.openPage}
              activePage={sidePanel.activePage}
            />
          </div>
          {sidePanel.panel}
        </div>
      </TitlebarSlot>
    </ImageViewerProvider>
  );
}

describe("桌面端页面版本与右侧面板（ADR-0109）", () => {
  it("面板页面渲染为入口行、点击打开对应版本、版本切换与箭头置灰、选中样式同步、下载当前版", async () => {
    const storage = memoryStorage();
    const prefs = createPrefsStore(storage);
    prefs.update({ panelSessionsMigrated: true });
    const saveFile = vi.fn<SaveFileFn>(async () => undefined);

    const f1 = makeHtmlAttachment({
      file: "file-1.html",
      title: "每周提交看板",
      page: "page-1",
      version: 1,
      display: "panel",
    });
    const f2 = makeHtmlAttachment({
      file: "file-2.html",
      title: "每周提交看板",
      page: "page-1",
      version: 2,
      display: "panel",
    });
    const htmlMap = {
      "file-1.html": "<h1>V1 CONTENT</h1>",
      "file-2.html": "<h1>V2 CONTENT</h1>",
    };

    const { container } = render(
      <DesktopHarness
        initialView={buildView([f1, f2])}
        htmlMap={htmlMap}
        prefs={prefs}
        saveFile={saveFile}
      />,
    );

    // 回放历史时不自动打开面板
    expect(container.querySelector(".side-panel")?.hasAttribute("hidden")).toBe(true);
    // 面板页面不原地渲染 iframe，渲染为两条入口行
    expect(container.querySelector(".inline-page")).toBeNull();
    const entryRows = Array.from(container.querySelectorAll<HTMLButtonElement>(".page-entry-row"));
    expect(entryRows).toHaveLength(2);
    expect(entryRows[0]?.textContent).toContain("每周提交看板");
    expect(entryRows[0]?.textContent).toContain("v1");
    expect(entryRows[1]?.textContent).toContain("v2");
    expect(entryRows[0]?.classList.contains("is-active")).toBe(false);
    expect(entryRows[1]?.classList.contains("is-active")).toBe(false);

    // 点击 v1 入口行：打开右侧面板并定位到第 1 版，v1 入口行选中，左箭头置灰、右箭头可用
    const [firstEntry, secondEntry] = entryRows;
    if (!firstEntry || !secondEntry) throw new Error("expected 2 entry rows");
    fireEvent.click(firstEntry);
    expect(container.querySelector(".side-panel")?.hasAttribute("hidden")).toBe(false);
    expect(screen.getByRole("tab", { name: /每周提交看板/ })).toBeDefined();
    expect(screen.queryByRole("button", { name: /^全屏$/ })).toBeNull();
    expect(container.querySelector(".page-ver-count")?.textContent).toBe("1 / 2");
    expect(screen.getByRole("button", { name: "上一版本" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "下一版本" }).hasAttribute("disabled")).toBe(false);
    expect(firstEntry.classList.contains("is-active")).toBe(true);
    expect(firstEntry.getAttribute("aria-current")).toBe("true");
    expect(secondEntry.classList.contains("is-active")).toBe(false);

    // 等待第 1 版加载完成并下载：下载的是 v1 内容
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "下载" }).hasAttribute("disabled")).toBe(false);
    });
    fireEvent.click(screen.getByRole("button", { name: "下载" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "下载为 HTML" }));
    await waitFor(() => {
      expect(saveFile).toHaveBeenCalledTimes(1);
    });
    expect(new TextDecoder().decode(saveFile.mock.calls[0]?.[0].bytes)).toBe("<h1>V1 CONTENT</h1>");

    // 点击「下一版本」切到第 2 版：右箭头置灰、左箭头可用、v2 入口行选中
    fireEvent.click(screen.getByRole("button", { name: "下一版本" }));
    expect(container.querySelector(".page-ver-count")?.textContent).toBe("2 / 2");
    expect(screen.getByRole("button", { name: "上一版本" }).hasAttribute("disabled")).toBe(false);
    expect(screen.getByRole("button", { name: "下一版本" }).hasAttribute("disabled")).toBe(true);
    expect(firstEntry.classList.contains("is-active")).toBe(false);
    expect(secondEntry.classList.contains("is-active")).toBe(true);

    // 等待第 2 版加载完成并下载：下载的是 v2 内容
    await waitFor(() => {
      expect(container.querySelector<HTMLIFrameElement>(".page-pane-frame")).not.toBeNull();
    });
    fireEvent.click(screen.getByRole("button", { name: "下载" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "下载为 HTML" }));
    await waitFor(() => {
      expect(saveFile).toHaveBeenCalledTimes(2);
    });
    expect(new TextDecoder().decode(saveFile.mock.calls[1]?.[0].bytes)).toBe("<h1>V2 CONTENT</h1>");

    // panelSessions 只存打开标记，不存版本号或 HTML 内容
    const rawPrefs = JSON.parse(storage.getItem(PREFS_KEY) ?? "{}") as {
      panelSessions?: Record<string, { tabs: Record<string, unknown>[] }>;
    };
    const savedPageTabs = rawPrefs.panelSessions?.["sess-1"]?.tabs.filter((t) => t.kind === "page");
    expect(savedPageTabs).toHaveLength(1);
    const savedFirst = savedPageTabs?.[0];
    if (!savedFirst) throw new Error("expected saved page tab");
    expect(Object.keys(savedFirst).sort()).toEqual(["id", "kind", "page"]);
    expect(savedFirst.page).toBe("page-1");
  });

  it("桌面内嵌页面原地渲染，浮动工具栏只提供全屏", async () => {
    const storage = memoryStorage();
    const prefs = createPrefsStore(storage);
    prefs.update({ panelSessionsMigrated: true });

    const f1 = makeHtmlAttachment({
      file: "file-1.html",
      title: "对比表",
      page: "page-1",
      version: 1,
      display: "inline",
    });
    let pushEvent: ((ev: DurableEvent, live: boolean) => void) | undefined;

    const { container } = render(
      <DesktopHarness
        initialView={buildView([])}
        htmlMap={{
          "file-1.html": "<h1>INLINE V1</h1>",
          "file-2.html": "<h1>INLINE V2</h1>",
        }}
        prefs={prefs}
        onPushEvent={(fn) => {
          pushEvent = fn;
        }}
      />,
    );

    // 实时收到内嵌页面 v1：不自动打开面板
    act(() => {
      pushEvent?.(makeToolCompletedEvent(2, "c1", f1), true);
    });
    expect(container.querySelector(".side-panel")?.hasAttribute("hidden")).toBe(true);
    await waitFor(() => {
      expect(container.querySelector(".inline-page iframe")).not.toBeNull();
    });

    const toolbar = container.querySelector(".inline-page-tools");
    expect(
      [...(toolbar?.querySelectorAll("button") ?? [])].map((btn) => btn.getAttribute("aria-label")),
    ).toEqual(["全屏"]);
  });

  it("恢复会话时移除旧版存下的内嵌页面标签", async () => {
    const prefs = createPrefsStore(memoryStorage());
    prefs.update({
      panelSessionsMigrated: true,
      panelSessions: {
        "sess-1": {
          open: true,
          activeTab: "old-tab",
          tabs: [{ id: "old-tab", kind: "page", page: "page-1" }],
        },
      },
    });
    const inline = makeHtmlAttachment({
      file: "file-1.html",
      title: "对比表",
      page: "page-1",
      version: 1,
      display: "inline",
    });
    const { container } = render(
      <DesktopHarness
        initialView={buildView([inline])}
        htmlMap={{ "file-1.html": "<h1>对比表</h1>" }}
        prefs={prefs}
      />,
    );
    await waitFor(() => expect(container.querySelector(".inline-page iframe")).not.toBeNull());
    expect(screen.queryByRole("tab", { name: /对比表/ })).toBeNull();
    expect(screen.getByRole("tab", { name: "新标签页" })).toBeDefined();
  });

  it("面板页面实时新版本自动打开；停在旧版本时不跳转且 N 加一", async () => {
    const storage = memoryStorage();
    const prefs = createPrefsStore(storage);
    prefs.update({ panelSessionsMigrated: true });

    const f1 = makeHtmlAttachment({
      file: "file-1.html",
      title: "看板",
      page: "page-1",
      version: 1,
      display: "panel",
    });
    const f2 = makeHtmlAttachment({
      file: "file-2.html",
      title: "看板",
      page: "page-1",
      version: 2,
      display: "panel",
    });
    const f3 = makeHtmlAttachment({
      file: "file-3.html",
      title: "看板",
      page: "page-1",
      version: 3,
      display: "panel",
    });
    let pushEvent: ((ev: DurableEvent, live: boolean) => void) | undefined;

    const { container } = render(
      <DesktopHarness
        initialView={buildView([])}
        htmlMap={{
          "file-1.html": "<h1>V1</h1>",
          "file-2.html": "<h1>V2</h1>",
          "file-3.html": "<h1>V3</h1>",
        }}
        prefs={prefs}
        onPushEvent={(fn) => {
          pushEvent = fn;
        }}
      />,
    );

    expect(container.querySelector(".side-panel")?.hasAttribute("hidden")).toBe(true);

    // 实时新建面板页面 v1：自动打开面板显示 1 / 1
    act(() => {
      pushEvent?.(makeToolCompletedEvent(2, "c1", f1), true);
    });
    expect(container.querySelector(".side-panel")?.hasAttribute("hidden")).toBe(false);
    expect(container.querySelector(".page-ver-count")?.textContent).toBe("1 / 1");

    // 实时产生 v2：因正在看最新版，自动更新为 2 / 2
    act(() => {
      pushEvent?.(makeToolCompletedEvent(3, "c2", f2), true);
    });
    expect(container.querySelector(".page-ver-count")?.textContent).toBe("2 / 2");

    // 用户切回旧版 v1（1 / 2）
    fireEvent.click(screen.getByRole("button", { name: "上一版本" }));
    expect(container.querySelector(".page-ver-count")?.textContent).toBe("1 / 2");

    // 实时产生 v3：停在旧版本不跳转，仍显示第 1 版，N 变为 3（1 / 3）
    act(() => {
      pushEvent?.(makeToolCompletedEvent(4, "c3", f3), true);
    });
    expect(container.querySelector(".page-ver-count")?.textContent).toBe("1 / 3");
    const rows = Array.from(container.querySelectorAll(".page-entry-row"));
    expect(rows[0]?.classList.contains("is-active")).toBe(true);
    expect(rows[2]?.classList.contains("is-active")).toBe(false);
  });

  it("storedTabs 与 parseStoredTabs：只存 page 标签的打开标记并按 page 去重", () => {
    const serialized = storedTabs([
      { id: "t1", kind: "page", page: "page-1", version: 2 },
      { id: "t2", kind: "new" },
    ]);
    expect(serialized).toEqual([{ id: "t1", kind: "page", page: "page-1" }]);
    const parsed = parseStoredTabs([
      { id: "t1", kind: "page", page: "page-1", version: 2 },
      { id: "t2", kind: "page", page: "page-1" },
      { id: "t3", kind: "page", page: "" },
    ]);
    expect(parsed).toEqual([{ id: "t1", kind: "page", page: "page-1" }]);
  });
});

describe("手机端页面入口行与全屏遮罩版本切换（ADR-0109）", () => {
  it("手机端面板页面显示入口行，点击进入全屏遮罩并支持版本切换；内嵌页面不加「在面板打开」且全屏可切版本", async () => {
    const f1 = makeHtmlAttachment({
      file: "file-1.html",
      title: "手机看板",
      page: "page-1",
      version: 1,
      display: "panel",
    });
    const f2 = makeHtmlAttachment({
      file: "file-2.html",
      title: "手机看板",
      page: "page-1",
      version: 2,
      display: "panel",
    });
    const in1 = makeHtmlAttachment({
      file: "file-3.html",
      title: "手机内嵌图",
      page: "page-2",
      version: 1,
      display: "inline",
    });
    const in2 = makeHtmlAttachment({
      file: "file-4.html",
      title: "手机内嵌图",
      page: "page-2",
      version: 2,
      display: "inline",
    });
    const htmlMap: Record<string, string> = {
      "file-1.html": "<h1>PANEL V1</h1>",
      "file-2.html": "<h1>PANEL V2</h1>",
      "file-3.html": "<h1>INLINE V1</h1>",
      "file-4.html": "<h1>INLINE V2</h1>",
    };
    const saveFile = vi.fn<SaveFileFn>(async () => undefined);
    const session = {
      id: "sess-mobile",
      readAttachment: vi.fn(async (file: string) => ({
        data: new TextEncoder().encode(htmlMap[file] ?? ""),
        mimeType: "text/html",
      })),
    } as unknown as RpcSession;

    // 手机端 Conversation 不传 onOpenPage / activePage
    const { container } = render(
      <ImageViewerProvider saveFile={saveFile}>
        <Conversation
          session={session}
          view={buildView([f1, f2, in1, in2])}
          openUrl={() => undefined}
          cwd="/ws"
          subscribeEvents={() => () => undefined}
          images={
            {
              url: () => undefined,
              subscribe: () => () => undefined,
              preview: () => undefined,
            } as unknown as Parameters<typeof Conversation>[0]["images"]
          }
          busy={false}
          hidePersistentPermissions
          hideRequests
        />
      </ImageViewerProvider>,
    );

    // 面板页面为入口行，内嵌页面照旧原地渲染且没有「在面板打开」按钮
    const entryRows = Array.from(container.querySelectorAll<HTMLButtonElement>(".page-entry-row"));
    expect(entryRows).toHaveLength(2);
    await waitFor(() => {
      expect(container.querySelectorAll(".inline-page iframe")).toHaveLength(2);
    });
    expect(screen.queryByRole("button", { name: "在面板打开" })).toBeNull();

    // 点击第 2 版入口行进入全屏遮罩：定位到 2 / 2，支持切换到 1 / 2 并下载 v1
    const secondRow = entryRows[1];
    if (!secondRow) throw new Error("expected second entry row");
    fireEvent.click(secondRow);
    const dlg = screen.getByRole("dialog", { name: "手机看板" });
    expect(dlg.querySelector(".page-ver-count")?.textContent).toBe("2 / 2");
    expect(screen.getByRole("button", { name: "下一版本" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "上一版本" }).hasAttribute("disabled")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "上一版本" }));
    expect(dlg.querySelector(".page-ver-count")?.textContent).toBe("1 / 2");
    expect(screen.getByRole("button", { name: "上一版本" }).hasAttribute("disabled")).toBe(true);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "下载" }).hasAttribute("disabled")).toBe(false);
    });
    fireEvent.click(screen.getByRole("button", { name: "下载" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "下载为 HTML" }));
    await waitFor(() => {
      expect(saveFile).toHaveBeenCalledTimes(1);
    });
    expect(new TextDecoder().decode(saveFile.mock.calls[0]?.[0].bytes)).toBe("<h1>PANEL V1</h1>");

    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(screen.queryByRole("dialog")).toBeNull();

    // 内嵌页面的全屏遮罩也有版本切换
    const fullBtns = screen.getAllByRole("button", { name: "全屏" });
    const firstFullBtn = fullBtns[0];
    if (!firstFullBtn) throw new Error("expected fullscreen button");
    fireEvent.click(firstFullBtn);
    const inlineDlg = screen.getByRole("dialog", { name: "手机内嵌图" });
    expect(inlineDlg.querySelector(".page-ver-count")?.textContent).toBe("1 / 2");
    fireEvent.click(screen.getByRole("button", { name: "下一版本" }));
    expect(inlineDlg.querySelector(".page-ver-count")?.textContent).toBe("2 / 2");
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
  });
});
