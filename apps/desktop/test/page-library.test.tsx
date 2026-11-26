// @vitest-environment jsdom
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntime, FakeProvider } from "@nocturne/core";
import {
  createSessionView,
  encodeDurableEvent,
  reduceSessionView,
  type DurableEvent,
  type PageLibraryItem,
  type PageLibraryListResult,
  type PageLibraryProjectsResult,
} from "@nocturne/core/protocol";
import type { RpcClient, RpcSession } from "@nocturne/rpc/client";

import type { OpenConversation } from "../src/conversations";
import type { DesktopHost } from "../src/host";
import { formatPageUpdatedAt, PageLibraryPage, type PageLibraryApi } from "../src/PageLibraryPage";
import { useSidePanel } from "../src/PanelHost";
import { createPrefsStore } from "../src/prefs";
import { Sidebar, type SidebarProps } from "../src/Sidebar";
import type { SessionTree } from "../src/session-tree";
import { ICON_DATA } from "../src/ui";

const tmpDirs: string[] = [];
function makeTmp(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  cleanup();
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

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

const emptyTree: SessionTree = {
  pinned: [],
  chats: { rows: [], moreCount: 0 },
  scheduled: { rows: [], moreCount: 0 },
  projects: [],
  newProjectKeys: [],
};

function sidebarProps(overrides: Partial<SidebarProps> = {}): SidebarProps {
  return {
    tree: emptyTree,
    pinnedIds: new Set(),
    selectedId: null,
    collapsed: new Set(),
    projectSort: "manual",
    hiddenProjects: [],
    onSelectSession: vi.fn(),
    onToggleCollapse: vi.fn(),
    onExpandProject: vi.fn(),
    onCollapseProject: vi.fn(),
    onExpandChats: vi.fn(),
    onCollapseChats: vi.fn(),
    onSetSort: vi.fn(),
    onMoveProject: vi.fn(),
    onPin: vi.fn(),
    onUnpin: vi.fn(),
    onRename: vi.fn(async () => undefined),
    onArchive: vi.fn(),
    onHideProject: vi.fn(),
    onRestoreProject: vi.fn(),
    onOpenProject: vi.fn(),
    onNewSession: vi.fn(),
    ...overrides,
  };
}

describe("项目页面库桌面端（ADR-0114）", () => {
  it("侧栏「页面」入口位于「组曲」下方，点击切换主区且高亮状态互斥", () => {
    const onOpenPages = vi.fn();
    const tree: SessionTree = {
      ...emptyTree,
      chats: {
        rows: [{ id: "s1", title: "会话一", meta: "现在", locked: false, status: "idle" }],
        moreCount: 0,
      },
    };
    const { container } = render(
      <Sidebar
        {...sidebarProps({
          tree,
          selectedId: "s1",
          pagesOpen: true,
          onOpenPages,
        })}
      />,
    );

    const topButtons = [...container.querySelectorAll(".side > .nav .item")];
    const labels = topButtons.map((b) => b.textContent?.trim() ?? "");
    const suitesIdx = labels.findIndex((l) => l.includes("组曲"));
    const pagesIdx = labels.findIndex((l) => l === "页面");
    expect(suitesIdx).toBeGreaterThanOrEqual(0);
    expect(pagesIdx).toBe(suitesIdx + 1);

    const pagesBtn = topButtons[pagesIdx] as HTMLElement;
    expect(pagesBtn.className).toContain("on");
    expect(pagesBtn.getAttribute("aria-current")).toBe("page");
    expect(pagesBtn.querySelector("svg path")?.getAttribute("d")).toBe(ICON_DATA.file.d);

    // 页面库打开时，会话列表中的当前会话行不再高亮
    const sessionRow = screen.getByRole("button", { name: /会话一/ });
    expect(sessionRow.className).not.toContain("on");

    fireEvent.click(pagesBtn);
    expect(onOpenPages).toHaveBeenCalledOnce();
  });

  it("置顶分组、右键菜单（置顶/取消置顶与 prefs 持久化）、搜索过滤、项目切换与空态", async () => {
    const now = new Date();
    const todayIso = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      10,
      52,
      0,
    ).toISOString();
    const oldIso = new Date(2026, 9, 15, 9, 0, 0).toISOString();
    expect(formatPageUpdatedAt(todayIso, now)).toBe("10:52");
    expect(formatPageUpdatedAt(oldIso, now)).toBe("10-15");

    const alphaItems: PageLibraryItem[] = [
      {
        origin: { sessionId: "s-a", page: "page-1" },
        originKey: "s-a/page-1",
        sessionId: "s-c",
        sessionTitle: "会话C-接着改",
        page: "page-1",
        ref: "s-c/page-1",
        title: "订单看板",
        version: 3,
        file: "file-3.html",
        updatedAt: todayIso,
        projectKey: "k-alpha",
        hasUnresolvedComments: true,
      },
      {
        origin: { sessionId: "s-b", page: "page-1" },
        originKey: "s-b/page-1",
        sessionId: "s-b",
        sessionTitle: "性能分析会话",
        page: "page-1",
        ref: "s-b/page-1",
        title: "延迟分布图",
        version: 1,
        file: "file-1.html",
        updatedAt: oldIso,
        projectKey: "k-alpha",
      },
    ];
    const chatItems: PageLibraryItem[] = [
      {
        origin: { sessionId: "s-chat", page: "page-1" },
        originKey: "s-chat/page-1",
        sessionId: "s-chat",
        sessionTitle: "随手记",
        page: "page-1",
        ref: "s-chat/page-1",
        title: "日常记账",
        version: 2,
        file: "file-2.html",
        updatedAt: oldIso,
        projectKey: "__default__",
      },
    ];

    const api: PageLibraryApi = {
      listPageProjects: vi.fn(async (): Promise<PageLibraryProjectsResult> => ({
        currentProjectKey: "k-alpha",
        currentProjectName: "repo-alpha",
        currentProjectIsDefault: false,
        projects: [
          {
            key: "k-alpha",
            name: "repo-alpha",
            isDefault: false,
            pageCount: 2,
            updatedAt: todayIso,
          },
          {
            key: "__default__",
            name: "对话",
            isDefault: true,
            pageCount: 1,
            updatedAt: oldIso,
          },
        ],
      })),
      listPages: vi.fn(async (input): Promise<PageLibraryListResult> => {
        if (input?.projectKey === "__default__") {
          return { projectKey: "__default__", items: chatItems };
        }
        return { projectKey: "k-alpha", items: alphaItems };
      }),
    };

    const storage = memoryStorage();
    const prefs = createPrefsStore(storage);
    const onOpenPage = vi.fn();

    function Harness() {
      const [, setTick] = useState(0);
      const pinnedSet = new Set(prefs.get().pinnedPages ?? []);
      return (
        <PageLibraryPage
          api={api}
          currentWorkspaceRoot="Z:\\repo-alpha"
          pinnedOriginKeys={pinnedSet}
          onPin={(originKey) => {
            const cur = prefs.get().pinnedPages ?? [];
            prefs.update({ pinnedPages: cur.includes(originKey) ? cur : [originKey, ...cur] });
            setTick((t) => t + 1);
          }}
          onUnpin={(originKey) => {
            const next = (prefs.get().pinnedPages ?? []).filter((k) => k !== originKey);
            prefs.update({ pinnedPages: next.length > 0 ? next : undefined });
            setTick((t) => t + 1);
          }}
          onOpenPage={onOpenPage}
        />
      );
    }

    const { container } = render(<Harness />);
    await waitFor(() => {
      expect(screen.getByText("订单看板")).toBeTruthy();
      expect(screen.getByText("延迟分布图")).toBeTruthy();
    });

    expect(screen.getByText("订单看板").nextElementSibling?.className).toBe("plib-comment-dot");
    expect(screen.getByText("延迟分布图").nextElementSibling).toBeNull();

    // 初始全部在「最近」组，没有「置顶」组
    expect(screen.queryByLabelText("置顶")).toBeNull();
    const recentSec = screen.getByLabelText("最近");
    expect(within(recentSec).getAllByRole("button")).toHaveLength(2);
    expect(screen.getByText("v3")).toBeTruthy();
    expect(screen.getByText("10:52")).toBeTruthy();
    expect(screen.getByText("10-15")).toBeTruthy();

    // 右键「延迟分布图」-> 点击「置顶」
    fireEvent.contextMenu(screen.getByRole("button", { name: /延迟分布图/ }), {
      clientX: 120,
      clientY: 160,
    });
    const pinMenuItem = screen.getByRole("menuitem", { name: "置顶" });
    fireEvent.click(pinMenuItem);

    // 「延迟分布图」进入「置顶」组，图标换成 pin，且写入 prefs 持久化
    const pinnedSec = screen.getByLabelText("置顶");
    const pinnedRow = within(pinnedSec).getByRole("button", { name: /延迟分布图/ });
    expect(pinnedRow.querySelector("svg path")?.getAttribute("d")).toBe(ICON_DATA.pin.d);
    expect(createPrefsStore(storage).get().pinnedPages).toEqual(["s-b/page-1"]);

    // 再次右键 -> 菜单变为「取消置顶」
    fireEvent.contextMenu(pinnedRow, { clientX: 120, clientY: 160 });
    fireEvent.click(screen.getByRole("menuitem", { name: "取消置顶" }));
    expect(screen.queryByLabelText("置顶")).toBeNull();
    expect(createPrefsStore(storage).get().pinnedPages).toBeUndefined();

    // 搜索过滤：按会话标题与页面标题匹配
    const search = screen.getByRole("searchbox", { name: "搜索" });
    fireEvent.change(search, { target: { value: "性能分析" } });
    expect(screen.getByText("延迟分布图")).toBeTruthy();
    expect(screen.queryByText("订单看板")).toBeNull();

    // 无匹配时列表体不渲染任何空态说明文字（只剩标题栏）
    fireEvent.change(search, { target: { value: "不存在的关键词" } });
    expect(container.querySelector(".plib-body")).toBeNull();

    // 清空搜索并切到「对话」项目
    fireEvent.change(search, { target: { value: "" } });
    const projCombo = screen.getByRole("combobox", { name: "项目" });
    fireEvent.click(projCombo);
    fireEvent.click(screen.getByRole("option", { name: "对话" }));
    await waitFor(() => {
      expect(screen.getByText("日常记账")).toBeTruthy();
    });
    expect(screen.queryByText("订单看板")).toBeNull();

    // 点击一行回调该项
    fireEvent.click(screen.getByRole("button", { name: /日常记账/ }));
    expect(onOpenPage).toHaveBeenCalledWith(chatItems[0]);
  });

  it("点击一行切到目标会话并打开面板页面标签到最新版", async () => {
    const makeView = (sessionId: string, title: string, version: number) => {
      const created: DurableEvent = {
        type: "session.created",
        sessionId,
        seq: 1,
        time: "2026-11-24T01:00:00.000Z",
        payload: {
          formatVersion: 1,
          nocturneVersion: "0.0.0-test",
          cwd: "Z:\\repo-alpha",
          workspaceRoot: "Z:\\repo-alpha",
          model: { provider: "fake", model: "m" },
          permissionPreset: "default",
        },
      };
      const view = createSessionView();
      reduceSessionView(view, created);
      for (let v = 1; v <= version; v++) {
        reduceSessionView(view, {
          type: "tool.completed",
          sessionId,
          seq: v + 1,
          turnId: `t-${v}`,
          time: `2026-11-24T01:0${v}:00.000Z`,
          payload: {
            callId: `c-${v}`,
            name: "render_html",
            status: "ok",
            modelContent: "ok",
            files: [
              {
                type: "file",
                file: `file-${v}.html`,
                sha256: "a".repeat(64),
                bytes: 32,
                mimeType: "text/html",
                label: `${title}.html`,
                source: "upload",
                inline: { title, page: "page-1", version: v, display: "panel" },
              },
            ],
          },
        });
      }
      return view;
    };

    const viewA = makeView("sess-a", "旧会话图", 1);
    const viewB = makeView("sess-b", "目标面板图", 2);
    const makeConv = (id: string, view: ReturnType<typeof makeView>): OpenConversation =>
      ({
        session: {
          id,
          readAttachment: vi.fn(async () => ({
            data: new TextEncoder().encode("<h1>HTML</h1>"),
            mimeType: "text/html",
          })),
          getPageData: vi.fn(async () => undefined),
          setPageData: vi.fn(async () => undefined),
          deletePageData: vi.fn(async () => undefined),
          listPageDataKeys: vi.fn(async () => []),
          callPageModel: vi.fn(async () => ({ text: "" })),
          stopPageModel: vi.fn(async () => undefined),
          respondPagePermission: vi.fn(async () => undefined),
        } as unknown as RpcSession,
        client: {} as unknown as RpcClient,
        workspace: "Z:\\repo-alpha",
        view,
        ruleEligibleCalls: new Set(),
        warnings: [],
      }) as unknown as OpenConversation;

    const convs: Record<string, OpenConversation> = {
      "sess-a": makeConv("sess-a", viewA),
      "sess-b": makeConv("sess-b", viewB),
    };

    const targetItem: PageLibraryItem = {
      origin: { sessionId: "sess-b", page: "page-1" },
      originKey: "sess-b/page-1",
      sessionId: "sess-b",
      sessionTitle: "会话B",
      page: "page-1",
      ref: "sess-b/page-1",
      title: "目标面板图",
      version: 2,
      file: "file-2.html",
      updatedAt: "2026-11-24T01:02:00.000Z",
      projectKey: "k-alpha",
    };

    const api: PageLibraryApi = {
      listPageProjects: async () => ({
        currentProjectKey: "k-alpha",
        currentProjectName: "repo-alpha",
        currentProjectIsDefault: false,
        projects: [
          {
            key: "k-alpha",
            name: "repo-alpha",
            isDefault: false,
            pageCount: 1,
            updatedAt: "2026-11-24T01:02:00.000Z",
          },
        ],
      }),
      listPages: async () => ({
        projectKey: "k-alpha",
        items: [targetItem],
      }),
    };

    const prefs = createPrefsStore(memoryStorage());
    const host = makeHost();

    function Integrated() {
      const [selectedId, setSelectedId] = useState<string>("sess-a");
      const [pagesOpen, setPagesOpen] = useState(true);
      const active = convs[selectedId];
      const sidePanel = useSidePanel({
        host,
        prefs,
        sessionId: selectedId,
        active,
        sessionCwd: "Z:\\repo-alpha",
        sessions: [
          { id: "sess-a", cwd: "Z:\\repo-alpha" },
          { id: "sess-b", cwd: "Z:\\repo-alpha" },
        ] as never,
        openIds: new Set(["sess-a", "sess-b"]),
        loadDiff: vi.fn(async () => ({}) as never),
        editors: { vscode: false, cursor: false },
        settingsOpen: pagesOpen,
        plainKey: null,
        client: undefined,
        ensureClient: vi.fn(async () => ({}) as RpcClient),
        images: {} as never,
        fileLinks: {} as never,
      });

      return (
        <div>
          <div data-testid="selected-session">{selectedId}</div>
          <div data-testid="active-page">
            {sidePanel.activePage
              ? `${sidePanel.activePage.page}@v${sidePanel.activePage.version}`
              : "none"}
          </div>
          {pagesOpen && (
            <PageLibraryPage
              api={api}
              currentWorkspaceRoot="Z:\\repo-alpha"
              pinnedOriginKeys={new Set()}
              onPin={() => undefined}
              onUnpin={() => undefined}
              onOpenPage={(item) => {
                setPagesOpen(false);
                sidePanel.openPage(item.page, undefined, item.sessionId);
                setSelectedId(item.sessionId);
              }}
            />
          )}
        </div>
      );
    }

    render(<Integrated />);
    const row = await screen.findByRole("button", { name: /目标面板图/ });
    await act(async () => {
      fireEvent.click(row);
    });

    await waitFor(() => {
      expect(screen.getByTestId("selected-session").textContent).toBe("sess-b");
      expect(screen.getByTestId("active-page").textContent).toBe("page-1@v2");
    });
  });

  it("集成真实 Core Runtime：历史面板页仍可浏览，新生成的内嵌图表不出现在页面库列表里", async () => {
    const root = makeTmp("nct-desk-plib-");
    const home = path.join(root, "home");
    const sessionsDir = path.join(home, "sessions");
    const ws = path.join(root, "my-project");
    mkdirSync(ws, { recursive: true });

    // 写入升级前格式的历史面板会话夹具
    const legacyId = "legacy-panel-sess";
    const legacyAttachDir = path.join(sessionsDir, "attachments", legacyId);
    mkdirSync(legacyAttachDir, { recursive: true });
    const legacyHtml = "<!doctype html><html><body><h1>可见面板页</h1></body></html>";
    writeFileSync(path.join(legacyAttachDir, "file-1.html"), legacyHtml, "utf8");
    const legacyEvents: DurableEvent[] = [
      {
        type: "session.created",
        sessionId: legacyId,
        seq: 1,
        time: "2026-11-23T10:00:00.000Z",
        payload: {
          formatVersion: 1,
          nocturneVersion: "0.68.0",
          cwd: ws,
          workspaceRoot: ws,
          model: { provider: "fake", model: "fake-model" },
          permissionPreset: "default",
        },
      },
      {
        type: "tool.completed",
        sessionId: legacyId,
        seq: 2,
        turnId: "t-legacy",
        time: "2026-11-23T10:00:01.000Z",
        payload: {
          callId: "c-legacy",
          name: "render_html",
          status: "ok",
          modelContent: "ok",
          durationMs: 5,
          files: [
            {
              type: "file",
              file: "file-1.html",
              sha256: createHash("sha256").update(legacyHtml, "utf8").digest("hex"),
              bytes: Buffer.byteLength(legacyHtml),
              mimeType: "text/html",
              label: "可见面板页.html",
              source: "upload",
              inline: { title: "可见面板页", page: "page-1", version: 1, display: "panel" },
            },
          ],
        },
      },
    ];
    writeFileSync(
      path.join(sessionsDir, `${legacyId}.jsonl`),
      `${legacyEvents.map((e) => encodeDurableEvent(e)).join("\n")}\n`,
      "utf8",
    );

    const provider = new FakeProvider({
      handler: (req) => {
        const hasTool = req.messages.some((m) => m.role === "tool");
        if (!hasTool) {
          return [
            {
              type: "tool_call",
              toolCallId: "t2",
              name: "render_html",
              input: { title: "隐藏内嵌页", html: "<p>inline</p>" },
            },
            { type: "finish", reason: "tool_calls" },
          ];
        }
        return [
          { type: "text_delta", text: "done" },
          { type: "finish", reason: "stop" },
        ];
      },
    });

    const prevHome = process.env.NOCTURNE_HOME;
    process.env.NOCTURNE_HOME = home;
    const runtime = await createRuntime({
      cwd: ws,
      workspaceRoot: ws,
      sessionsDir,
      providers: [provider],
    });
    try {
      const sess = await runtime.createSession({
        model: "fake/fake-model",
        cwd: ws,
        workspaceRoot: ws,
        permissionPreset: "read-only",
      });
      await sess.submit({ text: "画一张内嵌图表" });
      await sess.close();

      render(
        <PageLibraryPage
          api={runtime}
          currentWorkspaceRoot={ws}
          pinnedOriginKeys={new Set()}
          onPin={() => undefined}
          onUnpin={() => undefined}
          onOpenPage={() => undefined}
        />,
      );

      await waitFor(() => {
        expect(screen.getByText("可见面板页")).toBeTruthy();
      });
      expect(screen.queryByText("隐藏内嵌页")).toBeNull();
    } finally {
      await runtime.close();
      if (prevHome === undefined) delete process.env.NOCTURNE_HOME;
      else process.env.NOCTURNE_HOME = prevHome;
    }
  });
});
