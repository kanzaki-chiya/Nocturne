/**
 * 子代理的面板接线（ADR-0060 修订（五））：概览分组、标签身份与去重、重启恢复、
 * 只观察显示中的标签并在切走/设置/隐藏/关闭时退订、目录查询的前台与设置条件、
 * 由浏览器切过来先藏后切。
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import type { SubagentSummary, ToolEntry, RuntimeEvent } from "@nocturne/core/protocol";
import type { RpcClient } from "@nocturne/rpc/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { OpenConversation } from "../src/conversations";
import type { BrowserHost, BrowserMessage, DesktopHost } from "../src/host";
import { TitlebarSlot } from "../src/PanelChrome";
import { useSidePanel, type SidePanelController } from "../src/PanelHost";
import { createPrefsStore, PREFS_KEY, type PrefsStore } from "../src/prefs";
import {
  assistantMessage,
  externalEntry,
  settled,
  summary,
  taskEntry,
  userMessage,
} from "./subagent-fixtures";
import type { SubagentObservation, SubagentObserver } from "@nocturne/core/protocol";

beforeEach(() => {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  // 与 panel-host.test 一致：面板里的终端不在这里测
  vi.stubGlobal("matchMedia", undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
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

/** 假后台：listSubagents / observeSubagent / readSubagentAttachment / onEvent */
function fakeBackend() {
  const state = {
    list: [] as SubagentSummary[],
    listCalls: [] as string[],
    subscriptions: [] as {
      parentSessionId: string;
      childSessionId: string;
      afterSeq: number | undefined;
      observer: SubagentObserver;
      unsubscribed: boolean;
    }[],
    listeners: new Set<(sessionId: string, event: RuntimeEvent) => void>(),
  };
  const client = {
    runtime: {
      listSubagentWorktrees: vi.fn(async () => []),
      deleteSubagentWorktree: vi.fn(async () => undefined),
      readSubagentDiff: vi.fn(async () => ""),
      listSubagents: vi.fn(async (parent: string | { parentSessionId: string }) => {
        state.listCalls.push(typeof parent === "string" ? parent : parent.parentSessionId);
        return state.list;
      }),
      observeSubagent: vi.fn(
        async (
          input: { parentSessionId: string; childSessionId: string; afterSeq?: number | undefined },
          observer: SubagentObserver,
        ): Promise<SubagentObservation> => {
          const sub = {
            parentSessionId: input.parentSessionId,
            childSessionId: input.childSessionId,
            afterSeq: input.afterSeq,
            observer,
            unsubscribed: false,
          };
          state.subscriptions.push(sub);
          return {
            lastSeq: 0,
            summary: state.list.find((s) => s.childSessionId === input.childSessionId) ?? summary(),
            mode: "live",
            unsubscribe: () => {
              sub.unsubscribed = true;
            },
          };
        },
      ),
      readSubagentAttachment: vi.fn(),
    },
    onEvent: (listener: (sessionId: string, event: RuntimeEvent) => void) => {
      state.listeners.add(listener);
      return () => {
        state.listeners.delete(listener);
      };
    },
  } as unknown as RpcClient;
  return {
    client,
    state,
    emit: (sessionId: string, event: unknown) => {
      for (const listener of [...state.listeners]) listener(sessionId, event as RuntimeEvent);
    },
  };
}

function conversation(id: string, entries: ToolEntry[]): OpenConversation {
  return {
    session: { id, fileIndex: async () => [] },
    workspace: `Z:\\${id}`,
    view: { entries, revision: entries.length },
    turnChanges: new Map(),
  } as unknown as OpenConversation;
}

interface HarnessProps {
  prefs: PrefsStore;
  host: DesktopHost;
  sessionId: string | null;
  client: RpcClient | undefined;
  entries?: ToolEntry[];
  sessions?: readonly { id: string; mtimeMs: number }[];
  settingsOpen?: boolean;
  controller?: { current: SidePanelController | null };
}

function Panel(props: HarnessProps) {
  const active =
    props.sessionId === null ? undefined : conversation(props.sessionId, props.entries ?? []);
  const panel = useSidePanel({
    prefs: props.prefs,
    host: props.host,
    sessionId: props.sessionId,
    active,
    sessionCwd: undefined,
    sessions:
      props.sessions ?? (props.sessionId === null ? [] : [{ id: props.sessionId, mtimeMs: 1 }]),
    openIds: new Set(props.sessionId === null ? [] : [props.sessionId]),
    loadDiff: vi.fn(),
    editors: { vscode: false, cursor: false },
    settingsOpen: props.settingsOpen ?? false,
    plainKey: null,
    client: props.client,
    ensureClient: async () => {
      throw new Error("不应拉起后台");
    },
  });
  if (props.controller !== undefined) props.controller.current = panel;
  return (
    <div className="body" ref={panel.bodyRef}>
      <nav className="sidebar" />
      <main className={`mainpane${panel.mainClass}`} />
      {panel.mainOverlays}
      {panel.panel}
    </div>
  );
}

function Harness(props: HarnessProps) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  return (
    <>
      <div ref={setSlot} />
      <TitlebarSlot.Provider value={slot}>
        <Panel {...props} />
      </TitlebarSlot.Provider>
    </>
  );
}

function setup(options: { overview?: boolean; browsers?: BrowserHost } = {}) {
  const storage = memoryStorage();
  const prefs = createPrefsStore(storage);
  if (options.overview === true) prefs.update({ overviewOpen: true });
  const host = {
    openPath: vi.fn(async () => undefined),
    openUrl: vi.fn(async () => undefined),
    revealItem: vi.fn(async () => undefined),
    openInEditor: vi.fn(async () => undefined),
    ...(options.browsers !== undefined ? { browsers: options.browsers } : {}),
  } as unknown as DesktopHost;
  return { storage, prefs, host, backend: fakeBackend() };
}

const flush = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

const overview = () => screen.queryByRole("dialog", { name: "会话概览" });
const group = () => screen.queryByRole("group", { name: "子代理" });
const tabNames = () => screen.queryAllByRole("tab").map((t) => t.textContent ?? "");

it("窗口仍可见但已失焦时停止补查，重新聚焦才恢复", async () => {
  vi.useFakeTimers();
  const { prefs, host, backend } = setup();
  render(
    <Harness
      prefs={prefs}
      host={host}
      sessionId="p"
      client={backend.client}
      entries={[taskEntry()]}
    />,
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(backend.state.listCalls).toEqual(["p"]);
  act(() => {
    fireEvent.blur(window);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(backend.state.listCalls).toEqual(["p"]);
  act(() => {
    fireEvent.focus(window);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(backend.state.listCalls).toEqual(["p", "p"]);
});

it("概览：没有运行中的子代理时整组隐藏；已结束和未收束的不列", async () => {
  const { prefs, host, backend } = setup({ overview: true });
  backend.state.list = [
    summary({ childSessionId: "done", state: "ended" }),
    summary({ childSessionId: "lost", state: "unsealed" }),
  ];
  render(<Harness prefs={prefs} host={host} sessionId="p" client={backend.client} />);
  await flush();
  expect(overview()).toBeTruthy();
  expect(group()).toBeNull();
  expect(backend.state.listCalls).toContain("p");
});

it("概览：列出运行中的内置子代理（档位、摘要、已运行时间）；本地 timer 刷新秒数，不靠查询", async () => {
  vi.useFakeTimers({
    toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"],
  });
  vi.setSystemTime(new Date("2026-10-21T00:00:20.000Z"));
  const { prefs, host, backend } = setup({ overview: true });
  backend.state.list = [
    summary({
      childSessionId: "a",
      profile: "explore",
      taskSummary: "检查依赖方向",
      startedAt: "2026-10-21T00:00:00.000Z",
    }),
  ];
  render(<Harness prefs={prefs} host={host} sessionId="p" client={backend.client} />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  const rows = within(group() as HTMLElement).getAllByRole("button");
  expect(rows).toHaveLength(1);
  expect(rows[0]?.textContent).toContain("explore");
  expect(rows[0]?.textContent).toContain("检查依赖方向");
  expect(rows[0]?.textContent).toContain("20 秒");
  const calls = backend.state.listCalls.length;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  expect(within(group() as HTMLElement).getAllByRole("button")[0]?.textContent).toContain("23 秒");
  // 秒数是本地时钟走出来的：没有新的查询（无未结算 task，也不补查）
  expect(backend.state.listCalls).toHaveLength(calls);
});

it("进入会话查一次（浮层本来开着也只查一次）；之后每次打开浮层再查一次", async () => {
  const { prefs, host, backend } = setup({ overview: true });
  const view = render(<Harness prefs={prefs} host={host} sessionId="p" client={backend.client} />);
  await flush();
  expect(backend.state.listCalls).toEqual(["p"]);
  // 关掉再打开：打开时查询一次
  fireEvent.click(screen.getByRole("button", { name: "会话概览" }));
  await flush();
  expect(overview()).toBeNull();
  expect(backend.state.listCalls).toEqual(["p"]);
  fireEvent.click(screen.getByRole("button", { name: "会话概览" }));
  await flush();
  expect(overview()).toBeTruthy();
  expect(backend.state.listCalls).toEqual(["p", "p"]);
  // 换到另一个会话：重新进入会话查一次
  view.rerender(
    <Harness
      prefs={prefs}
      host={host}
      sessionId="q"
      client={backend.client}
      sessions={[
        { id: "p", mtimeMs: 1 },
        { id: "q", mtimeMs: 2 },
      ]}
    />,
  );
  await flush();
  expect(backend.state.listCalls.at(-1)).toBe("q");
});

it("概览：外部 agent 由父 task 主体识别，不可点击并注明「外部 agent」与「仅主对话进度」", async () => {
  const { prefs, host, backend } = setup({ overview: true });
  render(
    <Harness
      prefs={prefs}
      host={host}
      sessionId="p"
      client={backend.client}
      entries={[externalEntry("claude")]}
    />,
  );
  await flush();
  const box = group() as HTMLElement;
  expect(box.textContent).toContain("claude");
  expect(box.textContent).toContain("外部 agent 的任务");
  expect(box.textContent).toContain("外部 agent仅主对话进度");
  expect(within(box).queryAllByRole("button")).toHaveLength(0);
  // 没有 Nocturne 子会话，也没有观察
  expect(backend.state.subscriptions).toHaveLength(0);
});

it("点击概览里的内置项：面板里打开子代理标签（档位 · 摘要），概览不关；再点同一项只切过去", async () => {
  const { prefs, host, backend } = setup({ overview: true });
  backend.state.list = [
    summary({ childSessionId: "a", profile: "explore", taskSummary: "检查依赖方向" }),
    summary({ childSessionId: "b", profile: "default", taskSummary: "整理日志", callId: "call-2" }),
  ];
  render(<Harness prefs={prefs} host={host} sessionId="p" client={backend.client} />);
  await flush();
  expect(document.querySelector(".side-panel")?.hasAttribute("hidden")).toBe(true);
  const rows = within(group() as HTMLElement).getAllByRole("button");
  fireEvent.click(rows[0] as HTMLElement);
  await flush();
  // 面板打开，概览仍在
  expect(document.querySelector(".side-panel")?.hasAttribute("hidden")).toBe(false);
  expect(overview()).toBeTruthy();
  expect(tabNames()).toEqual([expect.stringContaining("explore · 检查依赖方向")]);
  expect(screen.getByRole("tab", { selected: true }).textContent).toContain("explore");
  // 再点同一项：不重建、不重复
  fireEvent.click(within(group() as HTMLElement).getAllByRole("button")[0] as HTMLElement);
  await flush();
  expect(tabNames()).toHaveLength(1);
  // 另一个 child：新标签
  fireEvent.click(within(group() as HTMLElement).getAllByRole("button")[1] as HTMLElement);
  await flush();
  expect(tabNames()).toEqual([
    expect.stringContaining("explore · 检查依赖方向"),
    expect.stringContaining("default · 整理日志"),
  ]);
  // 只观察当前显示的那一个
  const live = backend.state.subscriptions.filter((s) => !s.unsubscribed);
  expect(live.map((s) => s.childSessionId)).toEqual(["b"]);
});

it("工具行入口：「在面板中查看」打开（或切到）同一个标签；新标签页的工具列表不增加子代理", async () => {
  const { prefs, host, backend } = setup();
  backend.state.list = [summary({ childSessionId: "a", state: "ended" })];
  const controller = { current: null as SidePanelController | null };
  render(
    <Harness
      prefs={prefs}
      host={host}
      sessionId="p"
      client={backend.client}
      controller={controller}
    />,
  );
  await flush();
  const links = controller.current?.subagentLinks;
  expect(links).toBeDefined();
  const entry = taskEntry({ status: "ok", result: settled("ok") });
  expect(links?.link(entry)).toEqual({ kind: "ready", childSessionId: "a" });
  act(() => {
    links?.open("a");
  });
  await flush();
  act(() => {
    links?.open("a");
  });
  await flush();
  expect(tabNames()).toHaveLength(1);
  expect(screen.getByRole("tab", { selected: true }).textContent).toContain(
    "default · 审查登录模块",
  );
  // 新标签页的工具列表仍只有变更、文件、终端
  fireEvent.click(screen.getByRole("button", { name: "新标签页" }));
  const tools = document.querySelectorAll(".sp-tool");
  expect([...tools].map((t) => t.querySelector(".sp-tool-name")?.textContent)).toEqual([
    "变更",
    "文件",
    "终端",
  ]);
  // 没有 child 摘要的不打开
  act(() => {
    links?.open("unknown");
  });
  await flush();
  expect(tabNames().filter((n) => n.includes("default"))).toHaveLength(1);
});

it("没有连着后台时不提供工具行入口", async () => {
  const { prefs, host } = setup();
  const controller = { current: null as SidePanelController | null };
  render(
    <Harness prefs={prefs} host={host} sessionId="p" client={undefined} controller={controller} />,
  );
  await flush();
  expect(controller.current?.subagentLinks).toBeUndefined();
});

it("标签只观察显示时：切走、关面板、进设置都退订，回看按 seq 补读；关标签释放视图", async () => {
  const { prefs, host, backend } = setup();
  backend.state.list = [summary({ childSessionId: "a" })];
  const controller = { current: null as SidePanelController | null };
  const view = render(
    <Harness
      prefs={prefs}
      host={host}
      sessionId="p"
      client={backend.client}
      controller={controller}
    />,
  );
  await flush();
  act(() => {
    controller.current?.subagentLinks?.open("a");
  });
  await flush();
  const subs = backend.state.subscriptions;
  expect(subs).toHaveLength(1);
  expect(subs[0]).toMatchObject({ parentSessionId: "p", childSessionId: "a", afterSeq: undefined });
  act(() => {
    subs[0]?.observer.onEvent(userMessage(1, "任务", "a"));
    subs[0]?.observer.onEvent(assistantMessage(2, "进行中的输出", "a"));
  });
  expect(screen.getByText("进行中的输出")).toBeTruthy();

  // 切到新标签页：退订
  fireEvent.click(screen.getByRole("button", { name: "新标签页" }));
  await flush();
  expect(subs[0]?.unsubscribed).toBe(true);
  // 切回来：用保留的视图，按最后持久 seq 补读
  fireEvent.click(screen.getAllByRole("tab")[0] as HTMLElement);
  await flush();
  expect(subs).toHaveLength(2);
  expect(subs[1]?.afterSeq).toBe(2);
  expect(screen.getByText("进行中的输出")).toBeTruthy();

  // 设置页：退订
  view.rerender(
    <Harness
      prefs={prefs}
      host={host}
      sessionId="p"
      client={backend.client}
      controller={controller}
      settingsOpen
    />,
  );
  await flush();
  expect(subs[1]?.unsubscribed).toBe(true);
  view.rerender(
    <Harness
      prefs={prefs}
      host={host}
      sessionId="p"
      client={backend.client}
      controller={controller}
    />,
  );
  await flush();
  expect(subs).toHaveLength(3);

  // 隐藏面板：退订
  fireEvent.keyDown(window, { key: "b", ctrlKey: true });
  await flush();
  expect(subs[2]?.unsubscribed).toBe(true);
  fireEvent.keyDown(window, { key: "b", ctrlKey: true });
  await flush();
  expect(subs).toHaveLength(4);

  // 切到别的会话：退订（标签属于父会话，不在别的会话里显示）
  view.rerender(
    <Harness
      prefs={prefs}
      host={host}
      sessionId="q"
      client={backend.client}
      controller={controller}
      sessions={[
        { id: "p", mtimeMs: 1 },
        { id: "q", mtimeMs: 2 },
      ]}
    />,
  );
  await flush();
  expect(subs[3]?.unsubscribed).toBe(true);
  expect(tabNames().some((n) => n.includes("审查登录模块"))).toBe(false);
  view.rerender(
    <Harness
      prefs={prefs}
      host={host}
      sessionId="p"
      client={backend.client}
      controller={controller}
      sessions={[
        { id: "p", mtimeMs: 1 },
        { id: "q", mtimeMs: 2 },
      ]}
    />,
  );
  await flush();
  expect(subs).toHaveLength(5);
  expect(subs[4]?.afterSeq).toBe(2);

  // 关标签：退订并释放视图；再打开从 0 重放
  fireEvent.click(screen.getByRole("button", { name: /^关闭 default/ }));
  await flush();
  expect(subs[4]?.unsubscribed).toBe(true);
  act(() => {
    controller.current?.subagentLinks?.open("a");
  });
  await flush();
  expect(subs).toHaveLength(6);
  expect(subs[5]?.afterSeq).toBeUndefined();
});

it("重启恢复：标签、顺序、当前项回来，首次显示从 0 只读回放；父子关系不符时留着标签显示错误和重试", async () => {
  const { prefs, host, backend, storage } = setup();
  prefs.update({
    panelSessions: {
      p: {
        open: true,
        activeTab: "t2",
        tabs: [
          {
            id: "t1",
            kind: "subagent",
            childSessionId: "gone",
            parentCallId: "call-0",
            profile: "default",
            taskSummary: "已删除日志的任务",
          },
          {
            id: "t2",
            kind: "subagent",
            childSessionId: "a",
            parentCallId: "call-1",
            profile: "explore",
            taskSummary: "检查依赖方向",
          },
        ],
      },
    },
  });
  const stored = JSON.parse(storage.getItem(PREFS_KEY) ?? "{}") as { panelSessions?: unknown };
  expect(stored.panelSessions).toBeDefined();
  render(<Harness prefs={prefs} host={host} sessionId="p" client={backend.client} />);
  await flush();
  expect(tabNames()).toEqual([
    expect.stringContaining("default · 已删除日志的任务"),
    expect.stringContaining("explore · 检查依赖方向"),
  ]);
  expect(screen.getByRole("tab", { selected: true }).textContent).toContain("explore");
  expect(backend.state.subscriptions).toHaveLength(1);
  expect(backend.state.subscriptions[0]).toMatchObject({
    childSessionId: "a",
    afterSeq: undefined,
  });

  // 切到日志已丢失的那个：订阅失败 → 标签留着，显示错误和重试，不自动删除
  vi.mocked(backend.client.runtime.observeSubagent).mockRejectedValueOnce(
    Object.assign(new Error("找不到会话"), { code: "session_not_found" }),
  );
  fireEvent.click(screen.getAllByRole("tab")[0] as HTMLElement);
  await flush();
  expect(screen.getByText(/找不到这个子代理的日志/)).toBeTruthy();
  expect(tabNames()).toHaveLength(2);
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  await flush();
  expect(backend.state.subscriptions.at(-1)?.childSessionId).toBe("gone");
});

it("父 task 的 started / progress / completed 触发合并查询；不是 task 的事件不触发", async () => {
  const { prefs, host, backend } = setup();
  render(
    <Harness
      prefs={prefs}
      host={host}
      sessionId="p"
      client={backend.client}
      entries={[taskEntry()]}
    />,
  );
  await flush();
  const base = backend.state.listCalls.length;
  const event = (type: string, payload: object) => ({ type, seq: 1, sessionId: "p", payload });
  // 别的会话的、别的工具的事件：忽略
  backend.emit("other", event("tool.started", { callId: "x", name: "task" }));
  backend.emit("p", event("tool.started", { callId: "x", name: "read" }));
  backend.emit("p", event("tool.progress", { callId: "unknown", stream: "info", chunk: "z" }));
  await flush();
  expect(backend.state.listCalls).toHaveLength(base);
  // 视图里本来就在跑的 task：它的 progress 触发
  backend.emit(
    "p",
    event("tool.progress", { callId: "call-1", stream: "info", chunk: "子代理模型" }),
  );
  await flush();
  expect(backend.state.listCalls.length).toBeGreaterThan(base);
  const afterProgress = backend.state.listCalls.length;
  backend.emit("p", event("tool.started", { callId: "n", name: "task" }));
  await flush();
  expect(backend.state.listCalls.length).toBeGreaterThan(afterProgress);
  const afterStarted = backend.state.listCalls.length;
  backend.emit("p", event("tool.completed", { callId: "n", name: "task", status: "ok" }));
  await flush();
  expect(backend.state.listCalls.length).toBeGreaterThan(afterStarted);
});

it("未结算 task 时每秒补查；窗口后台、进设置、结算后都停止补查", async () => {
  vi.useFakeTimers({
    toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"],
  });
  const { prefs, host, backend } = setup();
  const props = { prefs, host, sessionId: "p", client: backend.client } as const;
  const running = [taskEntry()];
  const view = render(<Harness {...props} entries={running} />);
  const tick = (ms: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  await tick(0);
  const first = backend.state.listCalls.length;
  expect(first).toBeGreaterThanOrEqual(1);
  await tick(3000);
  const polled = backend.state.listCalls.length;
  expect(polled - first).toBeGreaterThanOrEqual(2);
  expect(polled - first).toBeLessThanOrEqual(3);

  // 窗口进后台（document 不可见）：不再补查
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await tick(0);
  const hiddenAt = backend.state.listCalls.length;
  await tick(5000);
  expect(backend.state.listCalls).toHaveLength(hiddenAt);
  // 回到前台：查一次并恢复补查
  visibility.mockReturnValue("visible");
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await tick(0);
  expect(backend.state.listCalls.length).toBeGreaterThan(hiddenAt);
  visibility.mockRestore();

  // 进设置：停止
  view.rerender(<Harness {...props} entries={running} settingsOpen />);
  await tick(0);
  const inSettings = backend.state.listCalls.length;
  await tick(5000);
  expect(backend.state.listCalls).toHaveLength(inSettings);
  view.rerender(<Harness {...props} entries={running} />);
  await tick(0);
  expect(backend.state.listCalls.length).toBeGreaterThan(inSettings);

  // task 结算：不再补查
  view.rerender(
    <Harness {...props} entries={[taskEntry({ status: "ok", result: settled("ok") })]} />,
  );
  await tick(1100);
  const settledAt = backend.state.listCalls.length;
  await tick(5000);
  expect(backend.state.listCalls).toHaveLength(settledAt);
});

it("从浏览器标签切到子代理标签：先藏起网页，再切换", async () => {
  const log: string[] = [];
  const pushes = new Map<number, (m: BrowserMessage) => void>();
  let next = 1;
  const browsers: BrowserHost = {
    create: vi.fn(async (url: string, _bounds, onMessage) => {
      const id = next++;
      pushes.set(id, onMessage);
      log.push(`create ${String(id)} ${url}`);
      return id;
    }),
    navigate: vi.fn(async () => undefined),
    layout: vi.fn(async (id: number, bounds) => {
      log.push(`layout ${String(id)} ${bounds === null ? "hide" : "show"}`);
    }),
    action: vi.fn(async () => undefined),
    capture: vi.fn(async () => new Uint8Array()),
    destroy: vi.fn(async (id: number) => {
      log.push(`destroy ${String(id)}`);
    }),
  };
  const original = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    if (this.classList.contains("sp-browser-slot")) {
      return {
        left: 600,
        top: 80,
        right: 1100,
        bottom: 700,
        width: 500,
        height: 620,
        x: 600,
        y: 80,
        toJSON: () => ({}),
      };
    }
    return original.call(this);
  };
  try {
    const { prefs, host, backend } = setup({ browsers });
    backend.state.list = [summary({ childSessionId: "a" })];
    const controller = { current: null as SidePanelController | null };
    render(
      <Harness
        prefs={prefs}
        host={host}
        sessionId="p"
        client={backend.client}
        controller={controller}
      />,
    );
    await flush();
    act(() => {
      controller.current?.openFile("Z:\\p\\index.html");
    });
    await flush();
    expect(log).toEqual(["create 1 file:///Z:/p/index.html", "layout 1 show"]);
    const before = tabNames();
    act(() => {
      controller.current?.subagentLinks?.open("a");
    });
    // 同步这一刻界面还没换：先等外壳藏好网页
    expect(tabNames()).toEqual(before);
    await flush();
    expect(log.indexOf("layout 1 hide")).toBeGreaterThan(-1);
    expect(tabNames()).toHaveLength(before.length + 1);
    expect(screen.getByRole("tab", { selected: true }).textContent).toContain("default");
    // 从子代理切回浏览器：浏览器重新显示
    fireEvent.click(screen.getAllByRole("tab")[0] as HTMLElement);
    await flush();
    await waitFor(() => {
      expect(log.at(-1)).toBe("layout 1 show");
    });
  } finally {
    HTMLElement.prototype.getBoundingClientRect = original;
  }
});

it("概览变高伸进浏览器区域时，仍由浮层相交检测截图并隐藏网页，不绕开第 3 轮规则", async () => {
  const log: string[] = [];
  const browsers: BrowserHost = {
    create: vi.fn(async (url: string) => {
      log.push(`create ${url}`);
      return 1;
    }),
    navigate: vi.fn(async () => undefined),
    layout: vi.fn(async (_id: number, bounds) => {
      log.push(`layout ${bounds === null ? "hide" : "show"}`);
    }),
    action: vi.fn(async () => undefined),
    capture: vi.fn(async () => new Uint8Array([137, 80, 78, 71])),
    destroy: vi.fn(async () => undefined),
  };
  Object.assign(URL, { createObjectURL: vi.fn(() => "blob:cover"), revokeObjectURL: vi.fn() });
  Object.assign(HTMLImageElement.prototype, { decode: async () => undefined });
  const original = HTMLElement.prototype.getBoundingClientRect;
  const rect = (left: number, top: number, width: number, height: number) =>
    ({
      left,
      top,
      right: left + width,
      bottom: top + height,
      width,
      height,
      x: left,
      y: top,
      toJSON: () => ({}),
    }) as DOMRect;
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    if (this.classList.contains("sp-browser-slot")) return rect(600, 80, 500, 620);
    // 子代理分组出现后概览变高，伸进浏览器区域
    if (this.classList.contains("ovpop")) {
      return this.querySelector(".ovpop-group") === null
        ? rect(20, 38, 300, 100)
        : rect(560, 38, 300, 260);
    }
    return original.call(this);
  };
  try {
    const { prefs, host, backend } = setup({ overview: true, browsers });
    const controller = { current: null as SidePanelController | null };
    const view = render(
      <Harness
        prefs={prefs}
        host={host}
        sessionId="p"
        client={backend.client}
        controller={controller}
      />,
    );
    await flush();
    act(() => {
      controller.current?.openFile("Z:\\p\\index.html");
    });
    await flush();
    expect(log).toContain("layout show");
    expect(backend.client.runtime.listSubagents).toHaveBeenCalled();
    // 子代理开始运行：概览长出「子代理」分组
    backend.state.list = [summary({ childSessionId: "a" })];
    view.rerender(
      <Harness
        prefs={prefs}
        host={host}
        sessionId="p"
        client={backend.client}
        controller={controller}
        entries={[taskEntry()]}
      />,
    );
    await flush();
    await waitFor(() => {
      expect(group()).toBeTruthy();
      expect(browsers.capture).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(log.at(-1)).toBe("layout hide");
    });
  } finally {
    HTMLElement.prototype.getBoundingClientRect = original;
  }
});

it("后台重启（换了连接）：旧订阅作废，从保留的持久 seq 续接并清掉瞬态；没有缓存的从 0", async () => {
  const { prefs, host, backend } = setup();
  backend.state.list = [summary({ childSessionId: "a" })];
  const controller = { current: null as SidePanelController | null };
  const view = render(
    <Harness
      prefs={prefs}
      host={host}
      sessionId="p"
      client={backend.client}
      controller={controller}
    />,
  );
  await flush();
  act(() => {
    controller.current?.subagentLinks?.open("a");
  });
  await flush();
  act(() => {
    backend.state.subscriptions[0]?.observer.onEvent(userMessage(1, "任务", "a"));
    backend.state.subscriptions[0]?.observer.onEvent(assistantMessage(2, "已有内容", "a"));
    backend.state.subscriptions[0]?.observer.onEvent({
      type: "message.assistant.delta",
      sessionId: "a",
      time: "2026-10-21T00:00:00.000Z",
      payload: { messageId: "m3", kind: "text", delta: "半截的流式文字" },
    } as unknown as RuntimeEvent);
  });
  expect(screen.getByText("半截的流式文字")).toBeTruthy();
  const next = fakeBackend();
  next.state.list = backend.state.list;
  view.rerender(
    <Harness
      prefs={prefs}
      host={host}
      sessionId="p"
      client={next.client}
      controller={controller}
    />,
  );
  await flush();
  expect(backend.state.subscriptions[0]?.unsubscribed).toBe(true);
  expect(next.state.subscriptions).toHaveLength(1);
  expect(next.state.subscriptions[0]?.afterSeq).toBe(2);
  // 持久内容保留，瞬态清掉（不补造）
  expect(screen.getByText("已有内容")).toBeTruthy();
  expect(screen.queryByText("半截的流式文字")).toBeNull();
  // 目录也按新连接重查
  expect(next.state.listCalls).toContain("p");
});

it("会话被删除：该会话的子代理观察和视图一并释放", async () => {
  const { prefs, host, backend } = setup();
  backend.state.list = [summary({ childSessionId: "a" })];
  const controller = { current: null as SidePanelController | null };
  const sessions = [
    { id: "p", mtimeMs: 1 },
    { id: "q", mtimeMs: 2 },
  ];
  const view = render(
    <Harness
      prefs={prefs}
      host={host}
      sessionId="p"
      client={backend.client}
      controller={controller}
      sessions={sessions}
    />,
  );
  await flush();
  act(() => {
    controller.current?.subagentLinks?.open("a");
  });
  await flush();
  expect(backend.state.subscriptions).toHaveLength(1);
  // 先看一眼别的会话，再让 p 从列表里消失
  view.rerender(
    <Harness
      prefs={prefs}
      host={host}
      sessionId="q"
      client={backend.client}
      controller={controller}
      sessions={sessions}
    />,
  );
  await flush();
  view.rerender(
    <Harness
      prefs={prefs}
      host={host}
      sessionId="q"
      client={backend.client}
      controller={controller}
      sessions={[{ id: "q", mtimeMs: 2 }]}
    />,
  );
  await flush();
  expect(backend.state.subscriptions[0]?.unsubscribed).toBe(true);
  const saved = JSON.parse(localStorageDump(prefs)) as { panelSessions?: Record<string, unknown> };
  expect(Object.keys(saved.panelSessions ?? {})).not.toContain("p");
});

it("工作树：概览保留项区分已并回与未并回（删除确认文案不同），点击改动文件在面板复用 DiffBody 渲染差异", async () => {
  const { prefs, host, backend } = setup({ overview: true });
  vi.mocked(backend.client.runtime.listSubagentWorktrees).mockResolvedValue([
    {
      childSessionId: "unmerged",
      parentSessionId: "p",
      repository: "Z:\\p",
      worktree: "Z:\\wt\\unmerged",
      branch: "nocturne/unmerged",
      base: "111",
      snapshot: false,
      cwd: "Z:\\wt\\unmerged",
      workspaceRoot: "Z:\\wt\\unmerged",
      task: "unmerged task",
      includeSkipped: false,
      changes: {
        branch: "nocturne/unmerged",
        base: "111",
        head: "222",
        snapshot: false,
        worktree: "Z:\\wt\\unmerged",
        files: [
          { path: "src/a.ts", status: "modified", additions: 2, deletions: 1 },
          { path: "src/b.ts", status: "added", additions: 5, deletions: 0 },
        ],
      },
    },
    {
      childSessionId: "merged",
      parentSessionId: "p",
      repository: "Z:\\p",
      worktree: "Z:\\wt\\merged",
      branch: "nocturne/merged",
      base: "111",
      snapshot: false,
      cwd: "Z:\\wt\\merged",
      workspaceRoot: "Z:\\wt\\merged",
      task: "merged task",
      includeSkipped: false,
      applied: true,
      changes: {
        branch: "nocturne/merged",
        base: "111",
        head: "333",
        snapshot: false,
        worktree: "Z:\\wt\\merged",
        files: [{ path: "src/c.ts", status: "modified", additions: 1, deletions: 1 }],
      },
    },
  ]);
  vi.mocked(backend.client.runtime.readSubagentDiff).mockResolvedValue(
    [
      "diff --git a/src/a.ts b/src/a.ts",
      "index 1111111..2222222 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,2 +1,3 @@",
      " const x = 1;",
      "-const oldVal = 2;",
      "+const newVal = 3;",
      "+const extra = 4;",
      "",
    ].join("\n"),
  );
  const controller = { current: null as SidePanelController | null };
  render(
    <Harness
      prefs={prefs}
      host={host}
      sessionId="p"
      client={backend.client}
      controller={controller}
    />,
  );
  await flush();
  const box = group() as HTMLElement;
  expect(box.textContent).toContain("nocturne/unmerged");
  expect(box.textContent).toContain("改动 2 个文件");
  expect(box.textContent).toContain("nocturne/merged");
  expect(box.textContent).toContain("改动 1 个文件 · 已并回");

  // 未并回项删除确认：显示「其中的改动会丢失」
  fireEvent.click(within(box).getByRole("button", { name: "删除副本与分支 nocturne/unmerged" }));
  await flush();
  expect(screen.getByText("删除副本与分支？")).toBeTruthy();
  expect(screen.getByText("其中的改动会丢失")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  await flush();

  // 已并回项删除确认：不显示「其中的改动会丢失」
  fireEvent.click(within(box).getByRole("button", { name: "删除副本与分支 nocturne/merged" }));
  await flush();
  expect(screen.getByText("删除副本与分支？")).toBeTruthy();
  expect(screen.queryByText("其中的改动会丢失")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "删除" }));
  await flush();
  expect(backend.client.runtime.deleteSubagentWorktree).toHaveBeenCalledWith({
    parentSessionId: "p",
    childSessionId: "merged",
  });

  // 点击子代理改动文件：复用 DiffBody 差异视图组件渲染
  act(() => {
    controller.current?.subagentLinks?.diff?.("unmerged", "src/a.ts");
  });
  await flush();
  expect(backend.client.runtime.readSubagentDiff).toHaveBeenCalledWith({
    parentSessionId: "p",
    childSessionId: "unmerged",
    file: "src/a.ts",
  });
  const diffSection = document.querySelector(".sp-changes-diff .sp-change");
  expect(diffSection).toBeTruthy();
  expect(diffSection?.querySelector(".diff-body")).toBeTruthy();
  expect(diffSection?.textContent).toContain("const newVal = 3;");
  expect(diffSection?.textContent).toContain("+2");
  expect(diffSection?.textContent).toContain("−1");
});

function localStorageDump(prefs: PrefsStore): string {
  return JSON.stringify(prefs.get());
}
