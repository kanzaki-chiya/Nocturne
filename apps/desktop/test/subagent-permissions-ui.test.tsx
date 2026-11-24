import { act } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSessionView,
  reduceSessionView,
  type RuntimeEvent,
  type SessionView,
  type SubagentObserver,
  type SubagentPendingPermission,
} from "@nocturne/core/protocol";
import type { RpcClient, RpcSession } from "@nocturne/rpc/client";

import { createAttachmentImageSource } from "../src/attachment-images";
import { Conversation } from "../src/Conversation";
import type { OpenConversation } from "../src/conversations";
import type { DesktopHost } from "../src/host";
import { emptyOutgoing } from "../src/outgoing";
import { SessionOverview, TitlebarSlot } from "../src/PanelChrome";
import { useSidePanel, type SidePanelController } from "../src/PanelHost";
import { createPrefsStore } from "../src/prefs";
import { SidePanel } from "../src/SidePanel";
import { SubagentPane } from "../src/SubagentPane";
import { SubagentWatcher } from "../src/subagent-watch";
import { SessionScreen } from "../src/web/SessionScreen";
import { PhoneSessions } from "../src/web/sessions";
import { PanelHarness, panelFixture } from "./phone-panel-fixtures";
import {
  assistantMessage,
  summary,
  taskEntry,
  toolStarted,
  userMessage,
} from "./subagent-fixtures";
import { fileOpenActionsStub } from "./file-actions-fixture";

beforeEach(() => {
  vi.stubGlobal("matchMedia", undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function subagentPermission(
  overrides: Partial<SubagentPendingPermission> = {},
): SubagentPendingPermission {
  return {
    requestId: "sub-req-1",
    callId: "child-call-1",
    toolName: "shell",
    childSessionId: "child-1",
    parentCallId: "task-1",
    profile: "explore",
    taskSummary: "检查依赖方向",
    afterSeq: 2,
    order: 1,
    reason: "ask",
    subjects: [{ kind: "shell", target: "pnpm test" }],
    options: ["allow_once", "allow_session", "allow_project", "allow_always", "deny"],
    ...overrides,
  };
}

function fakeSession(overrides: Partial<RpcSession> = {}): RpcSession {
  return new Proxy(
    {
      id: "parent-1",
      respondPermission: vi.fn(async () => undefined),
      respondSubagentPermission: vi.fn(async () => undefined),
      respondQuestion: vi.fn(async () => undefined),
      readAttachment: vi.fn(async () => ({ data: new Uint8Array(), mimeType: "image/png" })),
      ...overrides,
    },
    {
      get(target, key) {
        if (key in target) return target[key as keyof typeof target];
        if (key === "then") return undefined;
        return () => Promise.resolve([]);
      },
    },
  ) as unknown as RpcSession;
}

describe("父会话转发确认卡与桌面 UI 集成", () => {
  it("父对话复用同一确认卡按钮与来源（档位 · 任务摘要），点击调用 respondSubagentPermission", async () => {
    const view = createSessionView();
    view.pendingSubagentPermissions = [subagentPermission()];
    const respondSubagentPermission = vi.fn(async () => undefined);
    const respondPermission = vi.fn(async () => undefined);
    const session = fakeSession({ respondSubagentPermission, respondPermission });

    const { container } = render(
      <Conversation
        session={session}
        view={view}
        openUrl={vi.fn()}
        cwd="Z:/project"
        subscribeEvents={() => () => undefined}
        images={createAttachmentImageSource()}
        busy={false}
      />,
    );

    const card = screen.getByRole("region", { name: "权限确认" });
    const header = card.querySelector(".ask-t");
    expect(header?.textContent).toContain("explore · 检查依赖方向");
    expect(header?.querySelector(".ask-source")?.getAttribute("title")).toBe(
      "explore · 检查依赖方向",
    );
    // 不增加新徽标或多余说明文字
    expect(card.querySelector(".badge, .subagent-badge")).toBeNull();
    expect(screen.getByRole("button", { name: /允许一次/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /本会话允许/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /本项目允许/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /始终允许/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /拒绝/ })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /本会话允许/ }));
    await waitFor(() => {
      expect(respondSubagentPermission).toHaveBeenCalledWith("child-1", "sub-req-1", {
        decision: "allow",
        remember: "session",
      });
    });
    expect(respondPermission).not.toHaveBeenCalled();
    expect(container.querySelector(".ask-t")?.textContent).not.toContain("来自子代理");
  });

  it("并发子请求与父请求按到达顺序混排，独立回应且快捷键不双触发", async () => {
    const view = createSessionView();
    view.pendingPermission = {
      requestId: "parent-req",
      callId: "parent-call",
      toolName: "edit",
      seq: 5,
      reason: "ask",
      subjects: [{ kind: "edit", target: "src/parent.ts" }],
      options: ["allow_once", "deny"],
    };
    view.pendingSubagentPermissions = [
      subagentPermission({
        requestId: "sub-req-early",
        childSessionId: "child-early",
        parentCallId: "task-early",
        profile: "",
        taskSummary: "先到的子代理",
        afterSeq: 2,
        order: 1,
        subjects: [{ kind: "shell", target: "git status" }],
      }),
      subagentPermission({
        requestId: "sub-req-late",
        childSessionId: "child-late",
        parentCallId: "task-late",
        profile: "deep",
        taskSummary: "后到的子代理",
        afterSeq: 6,
        order: 1,
        subjects: [{ kind: "shell", target: "pnpm lint" }],
      }),
    ];
    const respondSubagentPermission = vi.fn(async () => undefined);
    const respondPermission = vi.fn(async () => undefined);
    const session = fakeSession({ respondSubagentPermission, respondPermission });

    render(
      <Conversation
        session={session}
        view={view}
        openUrl={vi.fn()}
        cwd="Z:/project"
        subscribeEvents={() => () => undefined}
        images={createAttachmentImageSource()}
        busy={false}
      />,
    );

    const cards = screen.getAllByRole("region", { name: "权限确认" });
    expect(cards).toHaveLength(3);
    expect(cards[0]?.textContent).toContain("先到的子代理");
    expect(cards[0]?.textContent).toContain("git status");
    expect(cards[1]?.textContent).toContain("src/parent.ts");
    expect(cards[2]?.textContent).toContain("deep · 后到的子代理");
    expect(cards[2]?.textContent).toContain("pnpm lint");

    // 聚焦第三张卡并按 1：只触发第三张卡，不误触发首卡或父卡
    fireEvent.focus(cards[2] as HTMLElement);
    (cards[2] as HTMLElement).focus();
    fireEvent.keyDown(window, { key: "1" });
    await waitFor(() => {
      expect(respondSubagentPermission).toHaveBeenCalledTimes(1);
    });
    expect(respondSubagentPermission).toHaveBeenCalledWith("child-late", "sub-req-late", {
      decision: "allow",
    });
    expect(respondPermission).not.toHaveBeenCalled();

    // 焦点不在任何卡上时按 1：仅触发首张卡（child-early）
    (cards[2] as HTMLElement).blur();
    fireEvent.keyDown(window, { key: "1" });
    await waitFor(() => {
      expect(respondSubagentPermission).toHaveBeenCalledTimes(2);
    });
    expect(respondSubagentPermission).toHaveBeenLastCalledWith("child-early", "sub-req-early", {
      decision: "allow",
    });
    expect(respondPermission).not.toHaveBeenCalled();
  });

  it("前台与后台 task 行在子代理等待确认时显示警告色，结算后清除", () => {
    const view = createSessionView();
    const events: RuntimeEvent[] = [
      userMessage(1, "跑子代理"),
      {
        type: "turn.started",
        sessionId: "parent-1",
        seq: 2,
        turnId: "t1",
        time: "2026-10-12T10:00:00.000Z",
        payload: { turnIndex: 1 },
      },
      {
        type: "tool.started",
        sessionId: "parent-1",
        seq: 3,
        turnId: "t1",
        time: "2026-10-12T10:00:01.000Z",
        payload: {
          callId: "task-fg",
          name: "task",
          input: { profile: "explore", task: "前台任务" },
          permission: { action: "allow", source: "rule" },
          subjects: [],
        },
      },
      {
        type: "tool.started",
        sessionId: "parent-1",
        seq: 4,
        turnId: "t1",
        time: "2026-10-12T10:00:02.000Z",
        payload: {
          callId: "task-bg",
          name: "task",
          input: { profile: "quick", task: "后台任务", background: true },
          permission: { action: "allow", source: "rule" },
          subjects: [],
        },
      },
      {
        type: "tool.completed",
        sessionId: "parent-1",
        seq: 5,
        turnId: "t1",
        time: "2026-10-12T10:00:03.000Z",
        payload: {
          callId: "task-bg",
          name: "task",
          status: "ok",
          output: { background: true, childSessionId: "child-bg" },
          modelContent: "started",
        },
      },
    ];
    for (const ev of events) reduceSessionView(view, ev);
    view.pendingSubagentPermissions = [
      subagentPermission({
        requestId: "r-fg",
        childSessionId: "child-fg",
        parentCallId: "task-fg",
      }),
      subagentPermission({
        requestId: "r-bg",
        childSessionId: "child-bg",
        parentCallId: "task-bg",
      }),
    ];

    const session = fakeSession();
    const { container, rerender } = render(
      <Conversation
        session={session}
        view={view}
        openUrl={vi.fn()}
        cwd="Z:/project"
        subscribeEvents={() => () => undefined}
        images={createAttachmentImageSource()}
        busy
      />,
    );

    const warnTools = container.querySelectorAll("article.tool.warn");
    expect(warnTools).toHaveLength(2);
    expect(container.querySelectorAll(".tool-res.tool-wait.warn")).toHaveLength(2);

    const cleared: SessionView = { ...view, pendingSubagentPermissions: [] };
    rerender(
      <Conversation
        session={session}
        view={cleared}
        openUrl={vi.fn()}
        cwd="Z:/project"
        subscribeEvents={() => () => undefined}
        images={createAttachmentImageSource()}
        busy
      />,
    );
    expect(container.querySelectorAll("article.tool.warn")).toHaveLength(0);
    expect(container.querySelectorAll(".tool-res.tool-wait.warn")).toHaveLength(0);
    expect(screen.getByText("后台运行中")).toBeTruthy();
  });

  it("概览子行与右子代理标签等待时显示警告色，右子面板复用同一确认卡可响应", async () => {
    const child = summary({
      childSessionId: "child-1",
      callId: "task-1",
      profile: "explore",
      taskSummary: "检查样式",
    });
    const pending = [
      subagentPermission({
        requestId: "r-nested",
        // 嵌套后代 childSessionId 不同但 parentCallId 相同：概览与标签同样命中警告色
        childSessionId: "grandchild-1",
        parentCallId: "task-1",
      }),
    ];

    const { container: ovContainer, rerender: rerenderOverview } = render(
      <TitlebarSlot.Provider value={null}>
        <SessionOverview
          project="nocturne"
          workspace="Z:/project"
          totals={{ added: 0, removed: 0, files: 0 }}
          rightOffset={0}
          onOpenChanges={vi.fn()}
          subagents={{
            running: [child],
            external: [],
            onOpen: vi.fn(),
            pendingPermissions: pending,
          }}
        />
      </TitlebarSlot.Provider>,
    );
    expect(ovContainer.querySelector(".ovpop-agent.warn")).not.toBeNull();
    expect(ovContainer.querySelector(".ovpop-agent-summary.warn")).not.toBeNull();

    rerenderOverview(
      <TitlebarSlot.Provider value={null}>
        <SessionOverview
          project="nocturne"
          workspace="Z:/project"
          totals={{ added: 0, removed: 0, files: 0 }}
          rightOffset={0}
          onOpenChanges={vi.fn()}
          subagents={{
            running: [child],
            external: [],
            onOpen: vi.fn(),
            pendingPermissions: [],
          }}
        />
      </TitlebarSlot.Provider>,
    );
    expect(ovContainer.querySelector(".ovpop-agent.warn")).toBeNull();

    const watcher = new SubagentWatcher();
    const runtime = {
      observeSubagent: vi.fn(async (_input, observer) => {
        observer.onEvent(userMessage(1, "检查样式"));
        return { lastSeq: 1, summary: child, mode: "live" as const, unsubscribe: vi.fn() };
      }),
      readSubagentAttachment: vi.fn(),
    };
    const onRespondPermission = vi.fn(async () => undefined);
    const { container: panelContainer, rerender: rerenderPanel } = render(
      <SidePanel
        tabs={[
          {
            id: "tab-sub",
            kind: "subagent",
            childSessionId: "child-1",
            parentCallId: "task-1",
            profile: "explore",
            taskSummary: "检查样式",
          },
        ]}
        activeId="tab-sub"
        overlay={false}
        width={420}
        onActivate={vi.fn()}
        onCloseTab={vi.fn()}
        onMoveTab={vi.fn()}
        onNewTab={vi.fn()}
        onResize={vi.fn()}
        onOpenChanges={vi.fn()}
        onQuickOpen={vi.fn()}
        onOpenTerminal={vi.fn()}
        onAddress={async () => undefined}
        changes={undefined}
        canOpenFiles={false}
        readFile={vi.fn()}
        readerKey="1"
        fileActions={{
          ...fileOpenActionsStub(),
          openExternal: vi.fn(),
          reveal: vi.fn(),
          openInBrowser: vi.fn(),
          browserLabel: "浏览器",
        }}
        terminals={undefined}
        loadShells={vi.fn()}
        onShellChange={vi.fn()}
        subagents={{
          watcher,
          runtime,
          parentSessionId: "parent-1",
          summaryFor: () => child,
          parentEntryFor: () => undefined,
          images: createAttachmentImageSource(),
          openUrl: vi.fn(),
          pendingPermissions: pending,
          respondPermission: onRespondPermission,
        }}
      />,
    );

    const tabEl = panelContainer.querySelector('[data-tab-id="tab-sub"]');
    expect(tabEl?.classList.contains("warn")).toBe(true);
    await screen.findByRole("region", { name: "权限确认" });
    fireEvent.click(screen.getByRole("button", { name: /允许一次/ }));
    await waitFor(() => {
      expect(onRespondPermission).toHaveBeenCalledWith("grandchild-1", "r-nested", {
        decision: "allow",
      });
    });

    rerenderPanel(
      <SidePanel
        tabs={[
          {
            id: "tab-sub",
            kind: "subagent",
            childSessionId: "child-1",
            parentCallId: "task-1",
            profile: "explore",
            taskSummary: "检查样式",
          },
        ]}
        activeId="tab-sub"
        overlay={false}
        width={420}
        onActivate={vi.fn()}
        onCloseTab={vi.fn()}
        onMoveTab={vi.fn()}
        onNewTab={vi.fn()}
        onResize={vi.fn()}
        onOpenChanges={vi.fn()}
        onQuickOpen={vi.fn()}
        onOpenTerminal={vi.fn()}
        onAddress={async () => undefined}
        changes={undefined}
        canOpenFiles={false}
        readFile={vi.fn()}
        readerKey="1"
        fileActions={{
          ...fileOpenActionsStub(),
          openExternal: vi.fn(),
          reveal: vi.fn(),
          openInBrowser: vi.fn(),
          browserLabel: "浏览器",
        }}
        terminals={undefined}
        loadShells={vi.fn()}
        onShellChange={vi.fn()}
        subagents={{
          watcher,
          runtime,
          parentSessionId: "parent-1",
          summaryFor: () => child,
          parentEntryFor: () => undefined,
          images: createAttachmentImageSource(),
          openUrl: vi.fn(),
          pendingPermissions: [],
          respondPermission: onRespondPermission,
        }}
      />,
    );
    expect(
      panelContainer.querySelector('[data-tab-id="tab-sub"]')?.classList.contains("warn"),
    ).toBe(false);
    expect(screen.queryByRole("region", { name: "权限确认" })).toBeNull();
    watcher.dispose();
  });

  it("SubagentPane 在加载中/读取失败/无正文时仍显示并可响应父转发的确认卡，且透传 shellKind", async () => {
    const pending = [
      subagentPermission({
        requestId: "r-empty",
        childSessionId: "child-1",
        subjects: [{ kind: "shell", target: "pnpm test" }],
      }),
    ];
    const onRespondPermission = vi.fn(async () => undefined);

    // 1. 加载中（observeSubagent 尚未返回任何事件，watcher 已预建空 view）
    const loadingWatcher = new SubagentWatcher();
    const loadingRuntime = {
      observeSubagent: vi.fn(() => new Promise<never>(() => undefined)),
      readSubagentAttachment: vi.fn(),
    };
    const { rerender, unmount } = render(
      <SubagentPane
        tab={{
          id: "t-loading",
          kind: "subagent",
          childSessionId: "child-1",
          parentCallId: "task-1",
          profile: "explore",
          taskSummary: "加载中任务",
        }}
        parentSessionId="parent-1"
        visible
        watcher={loadingWatcher}
        runtime={loadingRuntime}
        summary={undefined}
        parentEntry={undefined}
        workspace="Z:/project"
        images={createAttachmentImageSource()}
        openUrl={vi.fn()}
        pendingPermissions={pending}
        onRespondPermission={onRespondPermission}
        shellKind="pwsh"
      />,
    );
    expect(screen.getByText("正在读取子代理过程…")).toBeTruthy();
    const loadingCard = screen.getByRole("region", { name: "权限确认" });
    expect(loadingCard.textContent).toContain("pwsh › pnpm test");
    fireEvent.click(within(loadingCard).getByRole("button", { name: /允许一次/ }));
    await waitFor(() => {
      expect(onRespondPermission).toHaveBeenCalledWith("child-1", "r-empty", {
        decision: "allow",
      });
    });

    // 2. 读取失败（无内容但父仍有 pending）
    const errorWatcher = new SubagentWatcher();
    const errorRuntime = {
      observeSubagent: vi.fn(async () => {
        throw new Error("读取失败");
      }),
      readSubagentAttachment: vi.fn(),
    };
    rerender(
      <SubagentPane
        tab={{
          id: "t-error",
          kind: "subagent",
          childSessionId: "child-1",
          parentCallId: "task-1",
          profile: "explore",
          taskSummary: "失败任务",
        }}
        parentSessionId="parent-1"
        visible
        watcher={errorWatcher}
        runtime={errorRuntime}
        summary={undefined}
        parentEntry={undefined}
        workspace="Z:/project"
        images={createAttachmentImageSource()}
        openUrl={vi.fn()}
        pendingPermissions={pending}
        onRespondPermission={onRespondPermission}
        shellKind="pwsh"
      />,
    );
    await screen.findByText(/无法读取子代理/);
    expect(screen.getByRole("region", { name: "权限确认" }).textContent).toContain(
      "pwsh › pnpm test",
    );

    // 3. 空日志已收尾（closed 且无内容，父仍有 pending）
    const closedWatcher = new SubagentWatcher();
    const closedRuntime = {
      observeSubagent: vi.fn(async (_input: unknown, observer: SubagentObserver) => {
        observer.onEnd?.({
          lastSeq: 0,
          summary: summary({ state: "running" }),
          source: "snapshot",
          tailIgnored: false,
        });
        return {
          lastSeq: 0,
          summary: summary({ state: "running" }),
          mode: "live" as const,
          unsubscribe: vi.fn(),
        };
      }),
      readSubagentAttachment: vi.fn(),
    };
    rerender(
      <SubagentPane
        tab={{
          id: "t-closed",
          kind: "subagent",
          childSessionId: "child-1",
          parentCallId: "task-1",
          profile: "explore",
          taskSummary: "空日志任务",
        }}
        parentSessionId="parent-1"
        visible
        watcher={closedWatcher}
        runtime={closedRuntime}
        summary={undefined}
        parentEntry={undefined}
        workspace="Z:/project"
        images={createAttachmentImageSource()}
        openUrl={vi.fn()}
        pendingPermissions={pending}
        onRespondPermission={onRespondPermission}
        shellKind="bash"
      />,
    );
    await screen.findByText("这个子代理没有可显示的内容");
    expect(screen.getByRole("region", { name: "权限确认" }).textContent).toContain(
      "bash › pnpm test",
    );

    unmount();
    loadingWatcher.dispose();
    errorWatcher.dispose();
    closedWatcher.dispose();
  });

  it("SubagentPane 无实时转发请求时不渲染确认卡", () => {
    const watcher = new SubagentWatcher();
    render(
      <SubagentPane
        tab={{
          id: "t1",
          kind: "subagent",
          childSessionId: "child-1",
          parentCallId: "task-1",
          profile: "explore",
          taskSummary: "只读",
        }}
        parentSessionId="parent-1"
        visible
        watcher={watcher}
        runtime={undefined}
        summary={undefined}
        parentEntry={undefined}
        workspace="Z:/project"
        images={createAttachmentImageSource()}
        openUrl={vi.fn()}
        pendingPermissions={[]}
        onRespondPermission={vi.fn()}
      />,
    );
    expect(screen.queryByRole("region", { name: "权限确认" })).toBeNull();
    watcher.dispose();
  });

  it("PanelHost 不额外触发 shellInfo 请求，且切换会话时不泄漏上一会话的 shellKind", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const data = new Map<string, string>();
    const storage: Storage = {
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
    const prefs = createPrefsStore(storage);
    const host = {
      openUrl: vi.fn(),
      readClipboard: vi.fn(async () => ""),
      writeClipboard: vi.fn(async () => undefined),
    } as unknown as DesktopHost;
    const shellInfoA = vi.fn(async () => ({ selected: "pwsh", effective: { kind: "pwsh" } }));
    const shellInfoB = vi.fn(async () => ({ selected: "bash", effective: { kind: "bash" } }));
    const pendingA = [
      subagentPermission({
        requestId: "r-a",
        childSessionId: "child-a",
        parentCallId: "task-a",
        subjects: [{ kind: "shell", target: "echo a" }],
      }),
    ];
    const pendingB = [
      subagentPermission({
        requestId: "r-b",
        childSessionId: "child-b",
        parentCallId: "task-b",
        subjects: [{ kind: "shell", target: "echo b" }],
      }),
    ];
    const sumA = summary({
      parentSessionId: "sess-a",
      childSessionId: "child-a",
      callId: "task-a",
      profile: "explore",
      taskSummary: "任务 A",
    });
    const sumB = summary({
      parentSessionId: "sess-b",
      childSessionId: "child-b",
      callId: "task-b",
      profile: "explore",
      taskSummary: "任务 B",
    });
    const entryA = taskEntry({ callId: "task-a" });
    const entryB = taskEntry({ callId: "task-b" });
    const convA = {
      session: { id: "sess-a", fileIndex: async () => [], shellInfo: shellInfoA },
      workspace: "Z:/a",
      view: {
        ...createSessionView(),
        entries: [entryA],
        pendingSubagentPermissions: pendingA,
      },
      turnChanges: new Map(),
    } as unknown as OpenConversation;
    const convB = {
      session: { id: "sess-b", fileIndex: async () => [], shellInfo: shellInfoB },
      workspace: "Z:/b",
      view: {
        ...createSessionView(),
        entries: [entryB],
        pendingSubagentPermissions: pendingB,
      },
      turnChanges: new Map(),
    } as unknown as OpenConversation;
    const client = {
      runtime: {
        listShells: vi.fn(async () => []),
        describeSettings: vi.fn(async () => []),
        listSubagents: vi.fn(async (arg: string | { parentSessionId: string }) => {
          const parentSessionId = typeof arg === "string" ? arg : arg.parentSessionId;
          return parentSessionId === "sess-a" ? [sumA] : [sumB];
        }),
        listSubagentWorktrees: vi.fn(async () => []),
        observeSubagent: vi.fn(async () => ({
          lastSeq: 0,
          summary: summary({ state: "running" }),
          mode: "live" as const,
          unsubscribe: vi.fn(),
        })),
        readSubagentAttachment: vi.fn(),
      },
      onEvent: () => () => undefined,
    } as unknown as RpcClient;

    const controller: { current: SidePanelController | null } = { current: null };
    function PanelHarness({
      sessionId,
      active,
      shellKind,
    }: {
      sessionId: string;
      active: OpenConversation;
      shellKind?: string | undefined;
    }) {
      const panel = useSidePanel({
        prefs,
        host,
        sessionId,
        active,
        sessionCwd: undefined,
        sessions: [
          { id: "sess-a", mtimeMs: 1 },
          { id: "sess-b", mtimeMs: 2 },
        ],
        openIds: new Set(["sess-a", "sess-b"]),
        loadDiff: vi.fn(),
        editors: { vscode: false, cursor: false },
        settingsOpen: false,
        plainKey: null,
        client,
        ensureClient: async () => {
          throw new Error("不应拉起后台");
        },
        shellKind,
      });
      controller.current = panel;
      return (
        <div ref={panel.bodyRef}>
          {panel.mainOverlays}
          {panel.panel}
        </div>
      );
    }

    const { rerender, unmount } = render(
      <TitlebarSlot.Provider value={null}>
        <PanelHarness sessionId="sess-a" active={convA} shellKind="pwsh" />
      </TitlebarSlot.Provider>,
    );
    await waitFor(() =>
      expect(controller.current?.subagentLinks?.link(entryA)).toEqual({
        kind: "ready",
        childSessionId: "child-a",
      }),
    );
    act(() => {
      controller.current?.subagentLinks?.open("child-a");
    });
    const cardA = await screen.findByRole("region", { name: "权限确认" });
    expect(cardA.textContent).toContain("pwsh › echo a");

    // 切到会话 B 且 controls 尚未返回（shellKind=undefined）：不得泄漏 sess-a 的 pwsh
    rerender(
      <TitlebarSlot.Provider value={null}>
        <PanelHarness sessionId="sess-b" active={convB} shellKind={undefined} />
      </TitlebarSlot.Provider>,
    );
    await waitFor(() =>
      expect(controller.current?.subagentLinks?.link(entryB)).toEqual({
        kind: "ready",
        childSessionId: "child-b",
      }),
    );
    act(() => {
      controller.current?.subagentLinks?.open("child-b");
    });
    const cardB = await screen.findByRole("region", { name: "权限确认" });
    expect(cardB.textContent).toContain("shell › echo b");
    expect(cardB.textContent).not.toContain("pwsh ›");

    // 会话 B controls 就绪后同步更新为 bash
    rerender(
      <TitlebarSlot.Provider value={null}>
        <PanelHarness sessionId="sess-b" active={convB} shellKind="bash" />
      </TitlebarSlot.Provider>,
    );
    await waitFor(() => {
      expect(screen.getByRole("region", { name: "权限确认" }).textContent).toContain(
        "bash › echo b",
      );
    });
    expect(shellInfoA).not.toHaveBeenCalled();
    expect(shellInfoB).not.toHaveBeenCalled();
    unmount();
  });
});

describe("手机端会话确认卡、侧栏子行警告色与通知目标", () => {
  it("手机侧栏子行等待确认显示警告色，进入子代理详情可同卡回应且隐藏持久授权", async () => {
    const agent = summary({
      childSessionId: "child-1",
      callId: "task-1",
      profile: "explore",
      taskSummary: "手机侧栏子任务",
    });
    const fixture = panelFixture({ agents: [agent] });
    fixture.entry.view.pendingSubagentPermissions = [
      subagentPermission({
        requestId: "mob-req-1",
        childSessionId: "child-1",
        parentCallId: "task-1",
      }),
    ];
    const respondSubagentPermission = vi.fn(async () => undefined);
    fixture.entry.session.respondSubagentPermission = respondSubagentPermission;
    fixture.runtime.observeSubagent.mockImplementation(async (_input, observer) => {
      observer.onEvent(userMessage(1, "手机侧栏子任务"));
      observer.onEvent(toolStarted(2, "c1", "shell", { command: "pnpm test" }));
      observer.onEvent(assistantMessage(3, "正在执行"));
      return { lastSeq: 3, summary: agent, mode: "live", unsubscribe: vi.fn() };
    });

    const { container } = render(<PanelHarness fixture={fixture} />);
    await screen.findByText("手机侧栏子任务");
    const row = container.querySelector(".phone-panel-row.warn");
    expect(row).not.toBeNull();
    expect(row?.querySelector(".phone-panel-summary.warn")).not.toBeNull();

    fireEvent.click(row as HTMLElement);
    const card = await screen.findByRole("region", { name: "权限确认" });
    expect(within(card).getByRole("button", { name: /允许一次/ })).toBeTruthy();
    expect(within(card).getByRole("button", { name: /本会话允许/ })).toBeTruthy();
    expect(within(card).queryByRole("button", { name: /本项目允许/ })).toBeNull();
    expect(within(card).queryByRole("button", { name: /始终允许/ })).toBeNull();

    fireEvent.click(within(card).getByRole("button", { name: /^拒绝$/ }));
    fireEvent.click(within(card).getByRole("button", { name: "发送拒绝" }));
    await waitFor(() => {
      expect(respondSubagentPermission).toHaveBeenCalledWith("child-1", "mob-req-1", {
        decision: "deny",
      });
    });
  });

  it("手机 SessionScreen 底部抽屉渲染子代理转发确认卡并按到达顺序推进", async () => {
    const view = createSessionView();
    view.pendingSubagentPermissions = [
      subagentPermission({
        requestId: "mob-1",
        childSessionId: "child-1",
        profile: "explore",
        taskSummary: "第一条子请求",
        afterSeq: 1,
        order: 1,
      }),
      subagentPermission({
        requestId: "mob-2",
        childSessionId: "child-2",
        profile: "deep",
        taskSummary: "第二条子请求",
        afterSeq: 2,
        order: 1,
      }),
    ];
    const respondSubagentPermission = vi.fn(async () => undefined);
    const session = fakeSession({ respondSubagentPermission });
    const client = {
      runtime: new Proxy({}, { get: () => () => Promise.resolve([]) }),
      onEvent: () => () => undefined,
      onNotification: () => () => undefined,
    } as unknown as RpcClient;
    const sessions = new PhoneSessions(vi.fn());
    const entry = {
      session,
      client,
      workspace: "Z:/work",
      view,
      warnings: [],
      dead: false,
      listeners: new Set<() => void>(),
      turnChanges: new Map(),
      changeDiffs: new Map(),
      pendingInputs: { items: [], paused: false },
      outgoing: emptyOutgoing(),
      busy: false,
    };

    const { rerender } = render(
      <SessionScreen
        entry={entry}
        connected
        images={createAttachmentImageSource()}
        openUrl={vi.fn()}
        onError={vi.fn()}
        onChanged={vi.fn()}
        sessions={sessions}
        onForked={vi.fn()}
        plain
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "权限面板" });
    expect(dialog.textContent).toContain("explore · 第一条子请求");
    expect(dialog.querySelector(".ask-t .ask-source")?.getAttribute("title")).toBe(
      "explore · 第一条子请求",
    );
    expect(within(dialog).queryByRole("button", { name: /本项目允许/ })).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: /允许一次/ }));
    await waitFor(() => {
      expect(respondSubagentPermission).toHaveBeenCalledWith("child-1", "mob-1", {
        decision: "allow",
      });
    });
    // 快照更新移除第一条后立即露出队列里的下一条
    entry.view = {
      ...view,
      pendingSubagentPermissions: view.pendingSubagentPermissions.slice(1),
    };
    rerender(
      <SessionScreen
        entry={entry}
        connected
        images={createAttachmentImageSource()}
        openUrl={vi.fn()}
        onError={vi.fn()}
        onChanged={vi.fn()}
        sessions={sessions}
        onForked={vi.fn()}
        plain
      />,
    );
    expect(screen.getByRole("dialog", { name: "权限面板" }).textContent).toContain(
      "deep · 第二条子请求",
    );
  });

  it("PhoneSessions.attentionTarget 优先返回存在子代理待确认的会话", async () => {
    const sessions = new PhoneSessions(vi.fn());
    const idleView = createSessionView();
    const subPendingView = createSessionView();
    subPendingView.pendingSubagentPermissions = [subagentPermission()];
    (sessions as unknown as { list: { id: string }[] }).list = [{ id: "s1" }, { id: "s2" }];
    sessions.opened.set("s1", { view: idleView, dead: false } as never);
    sessions.opened.set("s2", { view: subPendingView, dead: false } as never);
    await expect(sessions.attentionTarget()).resolves.toBe("s2");
  });
});
