// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatSuiteThreadReport,
  type RuntimeEvent,
  type SuiteRecord,
  type SuiteThreadView,
} from "@nocturne/core/protocol";
import {
  createMemoryTransportPair,
  createRpcClient,
  type RpcSession,
  type SessionOpened,
} from "@nocturne/rpc/client";

import { PhoneApp } from "../src/web/App";
import { PhoneSessions } from "../src/web/sessions";
import { memoryStorage } from "../src/web/storage";
import { PanelHarness, panelContext, panelFixture } from "./phone-panel-fixtures";

const shared = vi.hoisted(() => ({
  connect: undefined as ((client: unknown, relay: unknown) => Promise<void>) | undefined,
}));
vi.mock("../src/web/connection", () => ({
  PhoneConnection: class {
    state = "online";
    message = "";
    constructor(options: { connected: typeof shared.connect }) {
      shared.connect = options.connected;
    }
    start = vi.fn();
    stop = vi.fn();
    visibility = vi.fn();
  },
}));

let root: Root | undefined;

const fakeSession = (methods: Record<string, unknown>): RpcSession =>
  new Proxy(methods, {
    get: (target, key) => {
      if (typeof key === "symbol" || key === "then") return undefined;
      if (key in target) return target[key];
      return () => Promise.reject(new Error(`未实现 ${key}`));
    },
  }) as unknown as RpcSession;

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

async function mountPhoneApp(setup: {
  suites: SuiteRecord[];
  openSuite?: (id: string) => Promise<{ session: RpcSession; opened: SessionOpened }>;
  openChild?: (childSessionId: string) => { session: RpcSession; opened: SessionOpened };
}) {
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));

  const [transport] = createMemoryTransportPair();
  const client = createRpcClient(transport, { clientName: "test-phone-suites" });
  const storage = memoryStorage();
  await storage.putHost({
    hostId: "host",
    hostPub: "pub",
    name: "电脑 1",
    pairedAt: 1,
    origin: "https://relay.example",
  });
  await storage.identity();

  vi.spyOn(client.runtime, "listSessions").mockResolvedValue([]);
  vi.spyOn(client.runtime, "listSuites").mockImplementation(async () => setup.suites);
  vi.spyOn(client.runtime, "listModels").mockResolvedValue([]);
  const { openSuite, openChild } = setup;
  if (openSuite !== undefined) {
    vi.spyOn(client.runtime, "openSuite").mockImplementation(async (id) => openSuite(id));
  }
  const origCall = client.call.bind(client);
  vi.spyOn(client, "call").mockImplementation(((method: string, params: unknown) => {
    if (method === "session.open" && openChild !== undefined) {
      const childId = (params as { sessionId: string }).sessionId;
      const { session, opened } = openChild(childId);
      vi.spyOn(client, "session").mockImplementation((id) =>
        id === childId ? session : ({ id } as unknown as RpcSession),
      );
      return Promise.resolve(opened);
    }
    return origCall(method as never, params as never);
  }) as typeof client.call);

  const host = document.createElement("div");
  document.body.append(host);
  const mounted = createRoot(host);
  root = mounted;
  await act(async () => {
    mounted.render(<PhoneApp storage={storage} />);
  });
  await vi.waitFor(() => expect(shared.connect).toBeDefined());
  await act(async () => {
    await shared.connect?.(client, undefined);
  });

  return { client, host };
}

afterEach(async () => {
  await act(() => root?.unmount());
  root = undefined;
  cleanup();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("手机组曲入口与只读列表页", () => {
  it("首页有「组曲」行且点进只读列表页，空列表不出现说明文字", async () => {
    await mountPhoneApp({ suites: [] });

    const rows = Array.from(document.querySelectorAll(".phone-row"));
    const labels = rows.map((el) => el.textContent?.trim());
    const scheduleIndex = labels.findIndex((text) => text === "定时任务");
    const suiteIndex = labels.findIndex((text) => text === "组曲");
    expect(scheduleIndex).toBeGreaterThanOrEqual(0);
    expect(suiteIndex).toBe(scheduleIndex + 1);

    const suiteRow = rows[suiteIndex];
    if (suiteRow === undefined) throw new Error("未找到组曲入口行");
    await act(async () => {
      fireEvent.click(suiteRow);
    });
    await vi.waitFor(() => {
      expect(document.querySelector("header h1")?.textContent).toBe("组曲");
    });

    // 只读：没有新建按钮、没有行菜单、空列表不出现说明文字
    expect(screen.queryByRole("button", { name: "新建" })).toBeNull();
    const listSection = document.querySelector(".phone-suites");
    expect(listSection?.textContent?.trim()).toBe("");
  });

  it("有组曲时列表页只读（无新建与行菜单），点击组曲行进入指挥会话页", async () => {
    const suite = makeSuite();
    const openSuiteCalls: string[] = [];
    const coordSession = fakeSession({
      id: "coord-1",
      describeContext: async () => panelContext,
      describeSkills: async () => ({ skills: [] }),
      describeExternalAgents: async () => ({ agents: [] }),
      shellInfo: async () => ({ effective: { kind: "pwsh" } }),
      visionInfo: async () => ({ imageInput: false, available: true, model: "claude-opus-5.5" }),
      pendingInputs: async () => ({ items: [], paused: false }),
      turnChanges: async () => [],
      listGrants: async () => [],
      close: async () => undefined,
      subscribe: async (fn: (event: RuntimeEvent) => void) => {
        fn({
          type: "suite.thread_started",
          sessionId: "coord-1",
          seq: 1,
          time: "2026-11-19T00:01:00.000Z",
          payload: {
            threadId: "t1",
            childSessionId: "child-t1",
            title: "修复图标",
            task: "补齐图标导出",
            workspace: "Z:/nocturne",
            model: { provider: "anthropic", model: "claude-opus-5.5" },
            preset: "general",
            isolated: false,
          },
        } as RuntimeEvent);
        return { lastSeq: 1, unsubscribe: vi.fn() };
      },
    });

    await mountPhoneApp({
      suites: [suite],
      openSuite: async (id) => {
        openSuiteCalls.push(id);
        return {
          session: coordSession,
          opened: {
            sessionId: "coord-1",
            meta: { cwd: "Z:/nocturne", workspaceRoot: "Z:/nocturne" },
            warnings: [],
            lastSeq: 1,
          } as unknown as SessionOpened,
        };
      },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "组曲" }));
    });
    await vi.waitFor(() => {
      expect(screen.getByText("插件兼容")).toBeTruthy();
    });

    expect(screen.queryByRole("button", { name: "新建" })).toBeNull();
    expect(screen.queryByRole("button", { name: "插件兼容 操作" })).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /插件兼容/ }));
    });
    await vi.waitFor(() => {
      expect(openSuiteCalls).toEqual(["suite-1"]);
      expect(document.querySelector("header h1")?.textContent).toBe("插件兼容");
    });

    // 「…」菜单不出现分叉，消息流中也不提供分叉
    const moreBtn = screen.getByRole("button", { name: "会话菜单" });
    await act(async () => {
      fireEvent.click(moreBtn);
    });
    const menu = screen.getByRole("dialog", { name: "会话菜单" });
    expect(within(menu).queryByRole("menuitemradio", { name: /分叉/ })).toBeNull();
  });
});

describe("手机组曲指挥页、汇报行与线程页", () => {
  it("汇报行点按进入线程页，线程发送走 sendToThread 且无附件入口，「…」菜单切换完成/重开调 resolveThread", async () => {
    const suite = makeSuite();
    let coordReceive: ((event: RuntimeEvent) => void) | undefined;
    const sendToThread = vi.fn(async () => undefined);
    let seq = 10;
    const resolveThread = vi.fn(async (input: { thread: string; reopen?: boolean }) => {
      coordReceive?.({
        type: input.reopen === true ? "suite.thread_reopened" : "suite.thread_resolved",
        sessionId: "coord-1",
        seq: seq++,
        time: "2026-11-19T00:05:00.000Z",
        payload: {
          threadId: input.thread,
          source: "user",
        },
      } as RuntimeEvent);
    });
    const childSubmit = vi.fn(async () => undefined);
    const childClose = vi.fn(async () => undefined);

    const coordSession = fakeSession({
      id: "coord-1",
      describeContext: async () => panelContext,
      describeSkills: async () => ({ skills: [] }),
      describeExternalAgents: async () => ({ agents: [] }),
      shellInfo: async () => ({ effective: { kind: "pwsh" } }),
      visionInfo: async () => ({ imageInput: false, available: true, model: "claude-opus-5.5" }),
      pendingInputs: async () => ({ items: [], paused: false }),
      turnChanges: async () => [],
      listGrants: async () => [],
      sendToThread,
      resolveThread,
      close: async () => undefined,
      subscribe: async (fn: (event: RuntimeEvent) => void) => {
        coordReceive = fn;
        fn({
          type: "suite.thread_started",
          sessionId: "coord-1",
          seq: 1,
          time: "2026-11-19T00:01:00.000Z",
          payload: {
            threadId: "t1",
            childSessionId: "child-t1",
            title: "补齐协议测试",
            task: "补齐协议层单元测试",
            workspace: "Z:/nocturne",
            model: { provider: "anthropic", model: "claude-opus-5.5" },
            preset: "general",
            isolated: false,
          },
        } as RuntimeEvent);
        fn({
          type: "message.user",
          sessionId: "coord-1",
          seq: 2,
          turnId: "turn-1",
          time: "2026-11-19T00:02:00.000Z",
          payload: {
            messageId: "m-report-1",
            content: [
              {
                type: "text",
                text: formatSuiteThreadReport({
                  threadId: "t1",
                  title: "补齐协议测试",
                  status: "idle",
                  body: "单测全部通过，共 12 条",
                }),
              },
            ],
            suiteReport: {
              threadId: "t1",
              turnId: "turn-1",
              status: "idle",
            },
          },
        } as RuntimeEvent);
        return { lastSeq: 2, unsubscribe: vi.fn() };
      },
    });

    const childSession = fakeSession({
      id: "child-t1",
      describeContext: async () => panelContext,
      describeSkills: async () => ({ skills: [] }),
      describeExternalAgents: async () => ({ agents: [] }),
      shellInfo: async () => ({ effective: { kind: "pwsh" } }),
      visionInfo: async () => ({ imageInput: false, available: true, model: "claude-opus-5.5" }),
      pendingInputs: async () => ({ items: [], paused: false }),
      turnChanges: async () => [],
      listGrants: async () => [],
      fileIndex: async () => [],
      recordInputHistory: async () => undefined,
      submit: childSubmit,
      close: childClose,
      subscribe: async (fn: (event: RuntimeEvent) => void) => {
        fn({
          type: "message.assistant",
          sessionId: "child-t1",
          seq: 1,
          turnId: "ct-1",
          time: "2026-11-19T00:01:30.000Z",
          payload: {
            messageId: "cm-1",
            model: { provider: "anthropic", model: "claude-opus-5.5" },
            content: [{ type: "text", text: "已完成协议层测试。" }],
            toolCalls: [],
            finishReason: "stop",
          },
        } as RuntimeEvent);
        return { lastSeq: 1, unsubscribe: vi.fn() };
      },
    });

    await mountPhoneApp({
      suites: [suite],
      openSuite: async () => ({
        session: coordSession,
        opened: {
          sessionId: "coord-1",
          meta: { cwd: "Z:/nocturne", workspaceRoot: "Z:/nocturne" },
          warnings: [],
          lastSeq: 2,
        } as unknown as SessionOpened,
      }),
      openChild: () => ({
        session: childSession,
        opened: {
          sessionId: "child-t1",
          meta: { cwd: "Z:/nocturne", workspaceRoot: "Z:/nocturne" },
          warnings: [],
          lastSeq: 1,
        } as unknown as SessionOpened,
      }),
    });

    // 进入组曲列表 -> 指挥会话页
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "组曲" }));
    });
    await vi.waitFor(() => expect(screen.getByText("插件兼容")).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /插件兼容/ }));
    });
    await vi.waitFor(() => {
      expect(document.querySelector(".suite-report-row")).not.toBeNull();
    });

    // 点击汇报行进入线程页
    const reportRow = document.querySelector(".suite-report-row");
    if (reportRow === null) throw new Error("未找到汇报行");
    await act(async () => {
      fireEvent.click(reportRow);
    });
    await vi.waitFor(() => {
      expect(document.querySelector("header h1")?.textContent).toBe("补齐协议测试");
      expect(screen.getByText("已完成协议层测试。")).toBeTruthy();
    });

    // 没有附件入口、没有侧边栏按钮、斜杠补全不含执行方式
    expect(screen.queryByRole("button", { name: "添加文件" })).toBeNull();
    expect(screen.queryByRole("button", { name: "侧边栏" })).toBeNull();

    const textarea = screen.getByLabelText("消息") as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.change(textarea, { target: { value: "/plan" } });
    });
    expect(screen.queryByRole("option", { name: /\/plan/ })).toBeNull();

    // 线程页发送调用 sendToThread 而非子会话 submit
    await act(async () => {
      fireEvent.change(textarea, { target: { value: "请补一条边界用例" } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "发送" }));
    });
    await vi.waitFor(() => {
      expect(sendToThread).toHaveBeenCalledWith({
        thread: "t1",
        text: "请补一条边界用例",
      });
    });
    expect(childSubmit).not.toHaveBeenCalled();

    // 「…」菜单「完成」调用 resolveThread({ thread: "t1" })
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "会话菜单" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitemradio", { name: "完成" }));
    });
    await vi.waitFor(() => {
      expect(resolveThread).toHaveBeenCalledWith({ thread: "t1" });
    });

    // 状态变为已完成后，「…」菜单变为「重开」，调用 resolveThread({ thread: "t1", reopen: true })
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "会话菜单" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitemradio", { name: "重开" }));
    });
    await vi.waitFor(() => {
      expect(resolveThread).toHaveBeenLastCalledWith({ thread: "t1", reopen: true });
    });
  });
});

describe("手机侧边栏「组曲」区", () => {
  it("五组归约、空组隐藏、「已完成」默认折叠且点开展开、点击线程行触发回调", async () => {
    const fixture = panelFixture();
    const threads: SuiteThreadView[] = [
      makeThread("t-attn", {
        title: "审批发布脚本",
        group: "needs_attention",
        status: "idle",
        pendingPermissions: [
          {
            requestId: "req-1",
            callId: "call-1",
            reason: "执行命令",
            subjects: [{ kind: "shell", target: "pnpm publish" }],
            options: [],
          },
        ],
      }),
      makeThread("t-unmerged", {
        title: "重构侧边栏样式",
        group: "unmerged",
        hasUnmergedWorktree: true,
        lastReportLine: "改动已提交到工作树分支",
      }),
      makeThread("t-idle", {
        title: "核对文档链接",
        group: "idle",
        lastReportLine: "等待下一次指令",
      }),
      makeThread("t-done", {
        title: "拆分数据模型",
        group: "resolved",
        resolved: true,
        lastReportLine: "已并回主干",
      }),
    ];
    fixture.entry.view.suite = {
      suiteId: "suite-1",
      threads,
      needsAttentionThreads: ["t-attn"],
    };

    const onOpenSuiteThread = vi.fn();
    render(<PanelHarness fixture={fixture} onOpenSuiteThread={onOpenSuiteThread} />);

    const section = screen.getByRole("region", { name: "组曲" });
    expect(within(section).getByRole("group", { name: "等你处理 1" })).toBeTruthy();
    expect(within(section).getByRole("group", { name: "待并回 1" })).toBeTruthy();
    expect(within(section).getByRole("group", { name: "空闲 1" })).toBeTruthy();
    expect(within(section).getByRole("group", { name: "已完成 1" })).toBeTruthy();
    // 空组「进行中」不显示
    expect(within(section).queryByText("进行中")).toBeNull();
    // 不出现记忆或说明标签
    expect(within(section).queryByText("记忆")).toBeNull();
    expect(within(section).queryByText("说明")).toBeNull();

    // 「已完成」默认折叠
    const resolvedToggle = within(section).getByRole("button", { name: /已完成/ });
    expect(resolvedToggle.getAttribute("aria-expanded")).toBe("false");
    expect(within(section).queryByText("拆分数据模型")).toBeNull();

    // 点开「已完成」展开
    fireEvent.click(resolvedToggle);
    expect(resolvedToggle.getAttribute("aria-expanded")).toBe("true");
    expect(within(section).getByText("拆分数据模型")).toBeTruthy();

    // 点线程行触发回调
    fireEvent.click(within(section).getByRole("button", { name: /审批发布脚本/ }));
    expect(onOpenSuiteThread).toHaveBeenCalledWith(threads[0]);
  });
});

describe("PhoneSessions 指挥会话生命周期", () => {
  it("有线程在跑或等确认时不释放指挥会话，全部空闲后切走才释放", async () => {
    const [transport] = createMemoryTransportPair();
    const client = createRpcClient(transport, { clientName: "lifetime-suite" });
    let listener: ((event: RuntimeEvent) => void) | undefined;
    const close = vi.fn(async () => undefined);
    const session = {
      id: "coord-1",
      close,
      turnChanges: async () => [],
      pendingInputs: async () => ({ items: [], paused: false }),
      subscribe: async (fn: (event: RuntimeEvent) => void) => {
        listener = fn;
        return { lastSeq: 0, unsubscribe: vi.fn() };
      },
    } as unknown as RpcSession;

    vi.spyOn(client.runtime, "listSessions").mockResolvedValue([]);
    vi.spyOn(client.runtime, "openSuite").mockResolvedValue({
      session,
      opened: {
        sessionId: "coord-1",
        meta: { cwd: "Z:/nocturne" },
        warnings: [],
        lastSeq: 0,
      } as unknown as SessionOpened,
    });

    const sessions = new PhoneSessions(vi.fn());
    await sessions.connected(client);
    const entry = await sessions.openSuite({
      id: "suite-1",
      coordinatorSessionId: "coord-1",
      workspaces: ["Z:/nocturne"],
    });

    // 1. 有线程在跑（status === "working"）时切走：不释放
    entry.view.suite = {
      suiteId: "suite-1",
      threads: [makeThread("t1", { status: "working", group: "running" })],
      needsAttentionThreads: [],
    };
    sessions.setSelected(undefined);
    await Promise.resolve();
    expect(close).not.toHaveBeenCalled();
    expect(sessions.opened.has("coord-1")).toBe(true);

    // 2. 线程改为等权限确认时切走：仍不释放
    entry.view.suite = {
      suiteId: "suite-1",
      threads: [
        makeThread("t1", {
          status: "idle",
          group: "needs_attention",
          pendingPermissions: [
            {
              requestId: "req-1",
              callId: "call-1",
              reason: "执行命令",
              subjects: [{ kind: "shell", target: "pnpm test" }],
              options: [],
            },
          ],
        }),
      ],
      needsAttentionThreads: ["t1"],
    };
    sessions.setSelected(undefined);
    await Promise.resolve();
    expect(close).not.toHaveBeenCalled();

    // 3. 线程改为有待回答提问时切走：仍不释放
    entry.view.suite = {
      suiteId: "suite-1",
      threads: [
        makeThread("t1", {
          status: "idle",
          group: "needs_attention",
          hasPendingQuestion: true,
        }),
      ],
      needsAttentionThreads: ["t1"],
    };
    sessions.setSelected(undefined);
    await Promise.resolve();
    expect(close).not.toHaveBeenCalled();

    // 4. 所有线程恢复空闲且事件到来后：释放指挥会话
    entry.view.suite = {
      suiteId: "suite-1",
      threads: [makeThread("t1", { status: "idle", group: "idle" })],
      needsAttentionThreads: [],
    };
    listener?.({
      type: "runtime.status",
      sessionId: "coord-1",
      time: new Date().toISOString(),
      payload: { status: "idle" },
    } as RuntimeEvent);
    await vi.waitFor(() => {
      expect(close).toHaveBeenCalledTimes(1);
      expect(sessions.opened.has("coord-1")).toBe(false);
    });

    client.close();
  });
});
