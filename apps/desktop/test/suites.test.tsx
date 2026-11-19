// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatSuiteThreadReport,
  replaySessionView,
  type DurableEvent,
  type MemoryDescription,
  type MemoryEntry,
  type MemoryEntryMeta,
  type SuiteRecord,
  type SuiteThreadView,
  type SuiteView,
} from "@nocturne/core/protocol";
import type { RpcSession } from "@nocturne/rpc/client";

import { Conversation } from "../src/Conversation";
import { createAttachmentImageSource } from "../src/attachment-images";
import { Sidebar, type SidebarProps } from "../src/Sidebar";
import type { SessionTree } from "../src/session-tree";
import { SuitePane } from "../src/SuitePane";
import { SuitesPage } from "../src/SuitesPage";
import { SuiteThreadPane } from "../src/SuiteThreadPane";
import { fakeServer, withInit } from "./fake-server";

afterEach(cleanup);

const emptyTree: SessionTree = {
  pinned: [],
  chats: { rows: [], moreCount: 0 },
  scheduled: { rows: [], moreCount: 0 },
  projects: [],
  newProjectKeys: [],
};

function sidebarProps(overrides?: Partial<SidebarProps>): SidebarProps {
  return {
    tree: emptyTree,
    pinnedIds: new Set(),
    selectedId: null,
    collapsed: new Set(),
    onSelectSession: vi.fn(),
    onToggleCollapse: vi.fn(),
    onExpandProject: vi.fn(),
    onCollapseProject: vi.fn(),
    onExpandChats: vi.fn(),
    onCollapseChats: vi.fn(),
    projectSort: "activity",
    hiddenProjects: [],
    onSetSort: vi.fn(),
    onMoveProject: vi.fn(),
    onPin: vi.fn(),
    onUnpin: vi.fn(),
    onRename: async () => undefined,
    onArchive: vi.fn(),
    onHideProject: vi.fn(),
    onRestoreProject: vi.fn(),
    onOpenProject: vi.fn(),
    onNewSession: vi.fn(),
    ...overrides,
  };
}

function makeSuite(overrides: Partial<SuiteRecord> = {}): SuiteRecord {
  return {
    version: 1,
    id: "suite-1",
    name: "插件兼容",
    goal: "完成插件发现与桌面端面板",
    workspaces: ["Z:/nocturne"],
    instructions: "本地只跑相关测试",
    coordinatorSessionId: "coord-1",
    threadDefaults: {},
    createdAt: "2026-11-19T00:00:00.000Z",
    ...overrides,
  };
}

function makeThread(threadId: string, overrides: Partial<SuiteThreadView> = {}): SuiteThreadView {
  return {
    threadId,
    childSessionId: `child-${threadId}`,
    title: `线程 ${threadId}`,
    task: `任务 ${threadId}`,
    workspace: "Z:/nocturne",
    model: { provider: "anthropic", model: "claude-opus-5.5" },
    preset: "general",
    isolated: false,
    status: "idle",
    group: "idle",
    resolved: false,
    hasUnmergedWorktree: false,
    hasPendingQuestion: false,
    pendingPermissions: [],
    ...overrides,
  };
}

function makeSuiteView(threads: SuiteThreadView[]): SuiteView {
  return {
    suiteId: "suite-1",
    threads,
    needsAttentionThreads: threads
      .filter((t) => t.group === "needs_attention")
      .map((t) => t.threadId),
  };
}

describe("侧栏组曲入口与分组", () => {
  it("顶部「组曲」入口显示等你处理总数，无等待时不显示数字，且无组曲时隐藏分组", () => {
    const { rerender } = render(
      <Sidebar
        {...sidebarProps({
          suites: [],
          suiteNeedsAttentionCount: 0,
        })}
      />,
    );

    const topEntry = screen.getByRole("button", { name: "组曲" });
    expect(topEntry.querySelector(".meta")).toBeNull();
    expect(screen.queryByRole("navigation", { name: "组曲" })).toBeNull();

    rerender(
      <Sidebar
        {...sidebarProps({
          suites: [
            {
              id: "suite-1",
              name: "插件兼容",
              coordinatorSessionId: "coord-1",
              needsAttentionCount: 3,
            },
            {
              id: "suite-2",
              name: "v0.54 发版",
              coordinatorSessionId: "coord-2",
              needsAttentionCount: 0,
            },
          ],
          suiteNeedsAttentionCount: 3,
          suitesOpen: true,
        })}
      />,
    );

    const updatedTop = screen.getByRole("button", { name: /组曲/ });
    expect(updatedTop.getAttribute("aria-current")).toBe("page");
    expect(updatedTop.querySelector(".meta")?.textContent).toBe("3");

    const groupNav = screen.getByRole("navigation", { name: "组曲" });
    const row1 = within(groupNav).getByRole("button", { name: /插件兼容/ });
    const row2 = within(groupNav).getByRole("button", { name: /v0\.54 发版/ });
    expect(row1.querySelector(".meta")?.textContent).toBe("3");
    expect(row2.querySelector(".meta")).toBeNull();
  });
});

describe("SuitesPage 组曲列表页", () => {
  it("空列表时仅显示「新建」按钮，不显示说明文字", async () => {
    const f = fakeServer(
      withInit({
        "suites.list": () => [],
      }),
    );
    await f.initialize();
    render(
      <SuitesPage
        client={f.client}
        workspaces={[{ path: "Z:/nocturne", label: "nocturne" }]}
        onOpenSuite={vi.fn()}
      />,
    );

    const region = screen.getByRole("region", { name: "组曲" });
    await waitFor(() => {
      const empty = region.querySelector(".empty");
      expect(empty).not.toBeNull();
      expect(empty?.textContent?.trim()).toBe("新建");
    });

    f.close();
  });

  it("支持新建、编辑组曲与归档前确认", async () => {
    let list: SuiteRecord[] = [];
    const onChanged = vi.fn();
    const onOpenSuite = vi.fn();
    const f = fakeServer(
      withInit({
        "suites.list": () => list,
        "suites.create": (params: Record<string, unknown>) => {
          const created = makeSuite({
            id: "suite-new",
            name: String(params.name ?? ""),
            goal: typeof params.goal === "string" ? params.goal : undefined,
            workspaces: Array.isArray(params.workspaces)
              ? (params.workspaces as string[])
              : ["Z:/nocturne"],
            instructions: typeof params.instructions === "string" ? params.instructions : "",
          });
          list = [created];
          return created;
        },
        "suites.update": (params: Record<string, unknown>) => {
          list = list.map((item) =>
            item.id === params.id
              ? {
                  ...item,
                  ...(typeof params.name === "string" ? { name: params.name } : {}),
                  ...(params.goal === null
                    ? { goal: undefined }
                    : typeof params.goal === "string"
                      ? { goal: params.goal }
                      : {}),
                  ...(Array.isArray(params.workspaces)
                    ? { workspaces: params.workspaces as string[] }
                    : {}),
                  ...(typeof params.instructions === "string"
                    ? { instructions: params.instructions }
                    : {}),
                }
              : item,
          );
          return list[0];
        },
        "suites.archive": (params: Record<string, unknown>) => {
          list = list.filter((item) => item.id !== params.id);
          return null;
        },
      }),
    );
    await f.initialize();

    render(
      <SuitesPage
        client={f.client}
        workspaces={[
          { path: "Z:/nocturne", label: "nocturne" },
          { path: "Z:/mockups", label: "nocturne-mockups" },
        ]}
        onOpenSuite={onOpenSuite}
        onChanged={onChanged}
      />,
    );

    // 1. 新建组曲
    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: "新建" }).length).toBeGreaterThan(0);
    });
    const [headerNew] = screen.getAllByRole("button", { name: "新建" });
    if (headerNew === undefined) throw new Error("未找到新建按钮");
    fireEvent.click(headerNew);

    const createDlg = screen.getByRole("dialog", { name: "新建组曲" });
    fireEvent.change(within(createDlg).getByLabelText("名称"), { target: { value: "三期联调" } });
    fireEvent.change(within(createDlg).getByLabelText("目标"), { target: { value: "跑通端到端" } });
    fireEvent.change(within(createDlg).getByLabelText("说明"), {
      target: { value: "只跑相关测试" },
    });
    fireEvent.click(within(createDlg).getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "新建组曲" })).toBeNull();
      expect(screen.getByText("三期联调")).toBeTruthy();
      expect(screen.getByText("跑通端到端")).toBeTruthy();
    });
    expect(f.calls.find((c) => c.method === "suites.create")?.params).toEqual({
      name: "三期联调",
      goal: "跑通端到端",
      workspaces: ["Z:/nocturne"],
      instructions: "只跑相关测试",
    });

    // 2. 编辑组曲
    fireEvent.click(screen.getByRole("button", { name: "三期联调 操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "编辑" }));

    const editDlg = screen.getByRole("dialog", { name: "编辑组曲" });
    fireEvent.change(within(editDlg).getByLabelText("名称"), { target: { value: "三期总览" } });
    fireEvent.click(within(editDlg).getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "编辑组曲" })).toBeNull();
      expect(screen.getByText("三期总览")).toBeTruthy();
    });
    expect(f.calls.find((c) => c.method === "suites.update")?.params).toEqual({
      id: "suite-new",
      name: "三期总览",
      goal: "跑通端到端",
      workspaces: ["Z:/nocturne"],
      instructions: "只跑相关测试",
    });

    // 3. 归档前确认：取消不调 RPC，确认后调 suites.archive
    fireEvent.click(screen.getByRole("button", { name: "三期总览 操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "归档" }));

    const cancelConfirm = screen.getByRole("dialog", { name: "归档 三期总览？" });
    fireEvent.click(within(cancelConfirm).getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("dialog", { name: "归档 三期总览？" })).toBeNull();
    expect(f.calls.filter((c) => c.method === "suites.archive")).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "三期总览 操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "归档" }));
    const confirmDlg = screen.getByRole("dialog", { name: "归档 三期总览？" });
    fireEvent.click(within(confirmDlg).getByRole("button", { name: "归档" }));

    await waitFor(() => {
      expect(f.calls.filter((c) => c.method === "suites.archive")).toHaveLength(1);
    });
    expect(onChanged).toHaveBeenCalled();

    f.close();
  });
});

describe("Conversation 汇报行", () => {
  it("将带 suiteReport 的用户消息渲染为汇报行而非用户气泡，点击打开对应线程", () => {
    const events: DurableEvent[] = [
      {
        seq: 1,
        sessionId: "coord-1",
        time: "2026-11-19T00:59:00.000Z",
        type: "session.created",
        payload: {
          cwd: "Z:/nocturne",
          workspaceRoot: "Z:/nocturne",
          model: { provider: "anthropic", model: "claude-opus-5.5" },
          permissionPreset: "auto-edit",
          formatVersion: 1,
          nocturneVersion: "test",
          suite: { id: "suite-1", role: "coordinator" },
        },
      },
      {
        seq: 2,
        sessionId: "coord-1",
        time: "2026-11-19T01:00:00.000Z",
        type: "suite.thread_started",
        payload: {
          threadId: "t1",
          childSessionId: "child-t1",
          title: "Core 插件发现",
          task: "扫描目录",
          workspace: "Z:/nocturne",
          model: { provider: "anthropic", model: "claude-opus-5.5" },
          preset: "general",
          isolated: true,
        },
      },
      {
        seq: 3,
        sessionId: "coord-1",
        time: "2026-11-19T01:01:00.000Z",
        type: "suite.thread_reported",
        payload: {
          threadId: "t1",
          childSessionId: "child-t1",
          turnId: "turn-1",
          status: "idle",
          report: "已提交 49a9de71\n补充细节",
          summaryLine: "已提交 49a9de71",
          hasUnmergedWorktree: true,
        },
      },
      {
        seq: 4,
        sessionId: "coord-1",
        time: "2026-11-19T01:01:01.000Z",
        type: "message.user",
        payload: {
          messageId: "msg-1",
          content: [
            {
              type: "text",
              text: formatSuiteThreadReport({
                threadId: "t1",
                title: "Core 插件发现",
                status: "idle",
                body: "已提交 49a9de71\n补充细节",
              }),
            },
          ],
          suiteReport: {
            threadId: "t1",
            turnId: "turn-1",
            status: "idle",
          },
        },
      },
    ];
    const view = replaySessionView(events);

    const onOpenSuiteThread = vi.fn();
    const fakeSession = {
      id: "coord-1",
      readAttachment: vi.fn(),
      resolveFiles: vi.fn(async () => []),
    } as unknown as RpcSession;

    const { container } = render(
      <Conversation
        session={fakeSession}
        view={view}
        openUrl={vi.fn()}
        cwd="Z:/nocturne"
        subscribeEvents={() => () => undefined}
        images={createAttachmentImageSource()}
        busy={false}
        onOpenSuiteThread={onOpenSuiteThread}
      />,
    );

    expect(container.querySelector(".msg.user")).toBeNull();
    const row = container.querySelector<HTMLButtonElement>(".suite-report-row");
    if (row === null) throw new Error("未找到汇报行");
    expect(row.textContent).toContain("Core 插件发现");
    expect(row.textContent).toContain("已提交 49a9de71");
    expect(row.querySelector(".suite-dot.merge")).not.toBeNull();

    fireEvent.click(row);
    expect(onOpenSuiteThread).toHaveBeenCalledWith("t1");
  });
});

describe("SuitePane 右侧组曲面板", () => {
  it("按五组归约渲染线程，隐藏空组，默认折叠已完成，并支持右键完成/重开", async () => {
    const resolveThread = vi.fn(async () => undefined);
    const suiteView = makeSuiteView([
      makeThread("t-attn", {
        title: "插件页",
        group: "needs_attention",
        pendingPermissions: [
          {
            requestId: "req-1",
            callId: "call-1",
            reason: "执行命令",
            subjects: [{ kind: "shell", target: "pnpm typecheck" }],
            options: [],
          },
        ],
      }),
      makeThread("t-run", {
        title: "文案轮换",
        status: "working",
        group: "running",
        toolActivity: { tool: "shell", detail: "vitest run" },
      }),
      makeThread("t-merge", {
        title: "resident 重构",
        group: "unmerged",
        hasUnmergedWorktree: true,
        lastReportLine: "+412 -389 · 14 个文件",
      }),
      makeThread("t-done", {
        title: "文档同步",
        group: "resolved",
        resolved: true,
        lastReportLine: "已更新",
      }),
    ]);

    const onOpenThread = vi.fn();
    render(
      <SuitePane
        suiteId="suite-1"
        suiteRecord={makeSuite()}
        suiteView={suiteView}
        session={{ resolveThread }}
        client={undefined}
        openUrl={vi.fn()}
        onOpenThread={onOpenThread}
        onUpdateSuite={vi.fn()}
      />,
    );

    // 四个非空组显示，空的「空闲」隐藏
    const attnGroup = screen.getByRole("group", { name: "等你处理 1" });
    expect(within(attnGroup).getByText("插件页")).toBeTruthy();
    expect(within(attnGroup).getByText("等待确认 · pnpm typecheck")).toBeTruthy();

    const runGroup = screen.getByRole("group", { name: "进行中 1" });
    expect(within(runGroup).getByText("文案轮换")).toBeTruthy();

    const mergeGroup = screen.getByRole("group", { name: "待并回 1" });
    expect(within(mergeGroup).getByText("resident 重构")).toBeTruthy();
    expect(within(mergeGroup).getByText("+412 -389 · 14 个文件")).toBeTruthy();

    expect(screen.queryByRole("group", { name: /^空闲/ })).toBeNull();

    // 「已完成」默认折叠
    const resolvedGroup = screen.getByRole("group", { name: "已完成 1" });
    const toggle = within(resolvedGroup).getByRole("button", { name: /已完成/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(within(resolvedGroup).queryByText("文档同步")).toBeNull();

    // 点击「已完成」展开
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(within(resolvedGroup).getByText("文档同步")).toBeTruthy();

    // 左键点击线程打开线程标签
    fireEvent.click(within(mergeGroup).getByRole("button", { name: /resident 重构/ }));
    expect(onOpenThread).toHaveBeenCalledWith(expect.objectContaining({ threadId: "t-merge" }));

    // 右键未完成线程 -> 完成
    fireEvent.contextMenu(within(mergeGroup).getByRole("button", { name: /resident 重构/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "完成" }));
    expect(resolveThread).toHaveBeenCalledWith({ thread: "t-merge" });

    // 右键已完成线程 -> 重开
    fireEvent.contextMenu(within(resolvedGroup).getByRole("button", { name: /文档同步/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "重开" }));
    expect(resolveThread).toHaveBeenCalledWith({ thread: "t-done", reopen: true });
  });

  it("说明标签未改时禁用按钮，保存调用 updateSuite", async () => {
    const onUpdateSuite = vi.fn(async (input) =>
      makeSuite({ instructions: input.instructions ?? "" }),
    );
    render(
      <SuitePane
        suiteId="suite-1"
        suiteRecord={makeSuite({ instructions: "初始说明" })}
        suiteView={makeSuiteView([])}
        session={{ resolveThread: vi.fn() }}
        client={undefined}
        openUrl={vi.fn()}
        onOpenThread={vi.fn()}
        onUpdateSuite={onUpdateSuite}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "说明" }));
    const textarea = screen.getByRole("textbox", { name: "说明" }) as HTMLTextAreaElement;
    const cancelBtn = screen.getByRole("button", { name: "取消" }) as HTMLButtonElement;
    const saveBtn = screen.getByRole("button", { name: "保存" }) as HTMLButtonElement;

    expect(textarea.value).toBe("初始说明");
    expect(cancelBtn.disabled).toBe(true);
    expect(saveBtn.disabled).toBe(true);

    fireEvent.change(textarea, { target: { value: "更新后的说明" } });
    expect(cancelBtn.disabled).toBe(false);
    expect(saveBtn.disabled).toBe(false);

    fireEvent.click(cancelBtn);
    expect(textarea.value).toBe("初始说明");
    expect(cancelBtn.disabled).toBe(true);
    expect(saveBtn.disabled).toBe(true);

    fireEvent.change(textarea, { target: { value: "最终说明" } });
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(onUpdateSuite).toHaveBeenCalledWith({ id: "suite-1", instructions: "最终说明" });
    });
  });

  it("记忆标签列组曲范围条目并支持详情与删除确认", async () => {
    let entries: MemoryEntryMeta[] = [
      {
        name: "verify-cmd",
        description: "只跑相关测试",
        type: "project",
        updatedAt: "2026-11-19T04:00:00.000Z",
      },
    ];
    const detailEntry: MemoryEntry = {
      scope: "suite",
      name: "verify-cmd",
      description: "只跑相关测试",
      type: "project",
      updatedAt: "2026-11-19T04:00:00.000Z",
      content: "运行 `pnpm --filter @nocturne/desktop exec vitest run`",
      raw: "运行 `pnpm --filter @nocturne/desktop exec vitest run`",
    };

    const f = fakeServer(
      withInit({
        "memory.describeMemory": (): MemoryDescription => ({
          global: { enabled: true, dir: "C:/nocturne/memory/global", entries: [], warnings: [] },
          suite: {
            enabled: true,
            dir: "C:/nocturne/memory/suites/suite-1",
            entries,
            warnings: [],
          },
          otherProjects: [],
        }),
        "memory.readMemory": () => detailEntry,
        "memory.deleteMemory": (params: Record<string, unknown>) => {
          entries = entries.filter((item) => item.name !== params.name);
          return null;
        },
      }),
    );
    await f.initialize();

    render(
      <SuitePane
        suiteId="suite-1"
        suiteRecord={makeSuite()}
        suiteView={makeSuiteView([])}
        session={{ resolveThread: vi.fn() }}
        client={f.client}
        openUrl={vi.fn()}
        openDirectory={vi.fn(async () => undefined)}
        onOpenThread={vi.fn()}
        onUpdateSuite={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "记忆" }));
    expect(await screen.findByText("verify-cmd")).toBeTruthy();
    expect(screen.getByText("只跑相关测试")).toBeTruthy();
    expect(f.calls.find((c) => c.method === "memory.describeMemory")?.params).toEqual({
      suiteId: "suite-1",
    });

    fireEvent.click(screen.getByText("verify-cmd"));
    expect(await screen.findByText("运行")).toBeTruthy();
    expect(f.calls.find((c) => c.method === "memory.readMemory")?.params).toEqual({
      scope: "suite",
      key: "suite-1",
      name: "verify-cmd",
    });

    // 取消删除不调用 deleteMemory
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    const cancelDlg = screen.getByRole("dialog", { name: "删除 verify-cmd？" });
    fireEvent.click(within(cancelDlg).getByRole("button", { name: "取消" }));
    expect(f.calls.filter((c) => c.method === "memory.deleteMemory")).toHaveLength(0);

    // 确认删除调用 deleteMemory({ scope: "suite", key: "suite-1", name: "verify-cmd" })
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    const confirmDlg = screen.getByRole("dialog", { name: "删除 verify-cmd？" });
    fireEvent.click(within(confirmDlg).getByRole("button", { name: "删除" }));

    expect(await screen.findByRole("status")).toHaveProperty("textContent", "✓ 已删除 verify-cmd");
    expect(await screen.findByText("没有记忆")).toBeTruthy();
    expect(f.calls.filter((c) => c.method === "memory.deleteMemory").map((c) => c.params)).toEqual([
      { scope: "suite", key: "suite-1", name: "verify-cmd" },
    ]);

    f.close();
  });
});

describe("SuiteThreadPane 组曲线程标签", () => {
  it("底部输入框发送走 coordinatorSession.sendToThread 而非子会话 submit", async () => {
    const f = fakeServer(
      withInit({
        "session.open": {
          sessionId: "child-t1",
          meta: {
            id: "child-t1",
            cwd: "Z:/nocturne",
            workspaceRoot: "Z:/nocturne",
            formatVersion: 1,
            nocturneVersion: "test",
          },
          config: { model: { provider: "anthropic", model: "claude-opus-5.5" } },
          warnings: [],
          lastSeq: 0,
        },
        "session.subscribe": { lastSeq: 0 },
        "session.pendingInputs": { items: [], paused: false },
        "session.describeSkills": {
          skills: [],
          warnings: [],
          budget: {},
          scannedDirs: [],
          homeDir: "C:/home",
        },
        "session.describeExternalAgents": { agents: [], warnings: [] },
        "session.shellInfo": {
          selected: "auto",
          source: "auto",
          effective: { kind: "pwsh", name: "PowerShell 7", path: "pwsh" },
        },
        "session.readInputHistory": { entries: [] },
        "session.recordInputHistory": null,
        "session.fileIndex": [],
        "session.close": null,
      }),
    );

    const sendToThread = vi.fn(async () => undefined);
    const { container } = render(
      <SuiteThreadPane
        threadId="t1"
        childSessionId="child-t1"
        coordinatorSession={{ sendToThread }}
        workspace="Z:/nocturne"
        ensureClient={async () => {
          await f.initialize();
          return f.client;
        }}
        images={createAttachmentImageSource()}
        openUrl={vi.fn()}
        pickImages={vi.fn(async () => [])}
      />,
    );

    const textarea = await waitFor(() => {
      const el = container.querySelector(".composer textarea");
      expect(el).not.toBeNull();
      return el as HTMLTextAreaElement;
    });

    fireEvent.change(textarea, { target: { value: "请先跑 typecheck" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => {
      expect(sendToThread).toHaveBeenCalledWith({
        thread: "t1",
        text: "请先跑 typecheck",
      });
    });
    expect(f.calls.filter((c) => c.method === "session.submit")).toHaveLength(0);

    // 线程标签不提供附件入口
    expect(screen.queryByRole("button", { name: "添加文件" })).toBeNull();

    // 空白文本按发送不调用 sendToThread 也不出错误提示
    sendToThread.mockClear();
    fireEvent.change(textarea, { target: { value: "   " } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(sendToThread).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();

    f.close();
  });

  it("保存组曲期间工作区下拉禁用提示为「正在处理」", async () => {
    let releaseCreate!: () => void;
    const createGate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    const f = fakeServer(
      withInit({
        "suites.list": () => [],
        "suites.create": async () => {
          await createGate;
          return makeSuite({ id: "suite-busy", name: "保存中" });
        },
      }),
    );
    await f.initialize();

    render(
      <SuitesPage
        client={f.client}
        workspaces={[{ path: "Z:/nocturne", label: "nocturne" }]}
        onOpenSuite={vi.fn()}
      />,
    );

    const [headerNew] = await screen.findAllByRole("button", { name: "新建" });
    if (headerNew === undefined) throw new Error("未找到新建按钮");
    fireEvent.click(headerNew);

    const dlg = screen.getByRole("dialog", { name: "新建组曲" });
    fireEvent.change(within(dlg).getByLabelText("名称"), { target: { value: "保存中" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "保存" }));

    await waitFor(() => {
      const workspaceTrigger = within(dlg).getByRole("combobox", { name: "工作区" });
      expect((workspaceTrigger as HTMLButtonElement).disabled).toBe(true);
      expect(workspaceTrigger.getAttribute("title")).toBe("正在处理");
    });

    releaseCreate();
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "新建组曲" })).toBeNull();
    });
    f.close();
  });
});
