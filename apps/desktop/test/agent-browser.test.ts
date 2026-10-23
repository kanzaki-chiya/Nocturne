/**
 * 面板浏览器 · 桌面内置的前端状态（desktop-browser.md 第 6、7 节）：
 * agent 标签的新建、活动、空闲、接管、交回、关闭，以及离屏布局上报。
 */
import { afterEach, expect, it, vi } from "vitest";

import {
  AgentBrowserStore,
  EMPTY_SNAPSHOT,
  activeAgent,
  agentPanelTabId,
  agentTabsFor,
  syncAgentTabs,
  withoutAgentTabs,
} from "../src/agent-browser";
import type {
  AgentBrowserHost,
  AgentTabInfo,
  AgentUiState,
  AgentWatchMessage,
  AgentWatchSnapshot,
} from "../src/host";
import { restoreSessionPanel, storeSessionPanel, type SessionPanel } from "../src/side-panel";

const OFFSCREEN_X = -20000;

function info(over: Partial<AgentTabInfo> = {}): AgentTabInfo {
  return {
    tabId: "tab-1",
    rootSessionId: "root",
    actorSessionId: "root",
    title: "测试页",
    url: "http://127.0.0.1:9/",
    live: true,
    pinned: true,
    state: "agent",
    child: false,
    ...over,
  };
}

function panel(tabs: SessionPanel["tabs"] = [], activeId = ""): SessionPanel {
  return { open: true, tabs, activeId, treeWidth: 240, wrap: true, recent: [] };
}

function hostOf(snapshot: AgentWatchSnapshot = EMPTY_SNAPSHOT) {
  const ui: AgentUiState[] = [];
  const presented: Parameters<AgentBrowserHost["presented"]>[0][] = [];
  const control: { tabId: string; action: "takeover" | "return" | "close" }[] = [];
  let onMessage: ((message: AgentWatchMessage) => void) | undefined;
  const host: AgentBrowserHost = {
    watch: vi.fn(async (listener) => {
      onMessage = listener;
      return snapshot;
    }),
    uiState: vi.fn(async (next) => {
      ui.push(next);
    }),
    presented: vi.fn(async (input) => {
      presented.push(input);
    }),
    control: vi.fn(async (tabId, action) => {
      control.push({ tabId, action });
      return { revision: 2, state: action === "takeover" ? "taken_over" : "agent" };
    }),
    setEnabled: vi.fn(async (enabled) => ({ enabled, restartRequired: enabled })),
  };
  return {
    host,
    ui,
    presented,
    control,
    push(message: AgentWatchMessage) {
      onMessage?.(message);
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

it("标签状态流转：新建、活动、空闲、接管、交回、关闭", () => {
  const base = panel([{ id: "new", kind: "new" }], "new");
  const created = syncAgentTabs(base, [info()]);
  expect(created.tabs.map((tab) => tab.id)).toEqual(["new", agentPanelTabId("tab-1")]);
  const agent = created.tabs[1];
  expect(agent?.kind === "browser" && agent.agent?.state).toBe("agent");

  const busy = syncAgentTabs(created, [info({ state: "busy", operation: "click" })]);
  expect(busy).not.toBe(created);
  const busyTab = busy.tabs[1];
  expect(busyTab?.kind === "browser" ? busyTab.agent?.operation : undefined).toBe("click");

  const idle = syncAgentTabs(busy, [info()]);
  const idleTab = idle.tabs[1];
  expect(idleTab?.kind === "browser" ? idleTab.agent?.state : undefined).toBe("agent");
  expect(idleTab?.kind === "browser" ? idleTab.agent?.operation : "missing").toBeUndefined();

  const taken = syncAgentTabs(idle, [info({ state: "taken_over" })]);
  expect(activeAgent({ ...taken, activeId: agentPanelTabId("tab-1") })?.state).toBe("taken_over");

  const returned = syncAgentTabs(taken, [info({ state: "agent" })]);
  expect(activeAgent({ ...returned, activeId: agentPanelTabId("tab-1") })?.state).toBe("agent");

  const closed = syncAgentTabs(returned, []);
  expect(closed.tabs.map((tab) => tab.id)).toEqual(["new"]);
  expect(closed.activeId).toBe("new");
});

it("外壳关掉当前标签时，选中项落到剩下的标签上", () => {
  const open = syncAgentTabs(panel(), [info(), info({ tabId: "tab-2", title: "第二页" })]);
  const current = { ...open, activeId: agentPanelTabId("tab-1") };
  const next = syncAgentTabs(current, [info({ tabId: "tab-2", title: "第二页" })]);
  expect(next.activeId).toBe(agentPanelTabId("tab-2"));
});

it("没有变化时返回同一个面板；agent 标签不进本机偏好", () => {
  const open = syncAgentTabs(
    panel([{ id: "file", kind: "file", absolutePath: "Z:\\a.ts" }], "file"),
    [info()],
  );
  expect(syncAgentTabs(open, [info()])).toBe(open);
  const stored = storeSessionPanel(open);
  expect(stored.tabs.map((tab) => tab.kind)).toEqual(["file"]);
  const restored = restoreSessionPanel(stored, () => "fresh");
  expect(restored.tabs.some((tab) => tab.kind === "browser" && tab.agent !== undefined)).toBe(
    false,
  );
});

it("只合入当前会话还活着的标签；切走后别的会话残留被清掉", () => {
  const snapshot = {
    ...EMPTY_SNAPSHOT,
    tabs: [
      info(),
      info({ tabId: "other", rootSessionId: "other" }),
      info({ tabId: "gone", live: false }),
    ],
  };
  expect(agentTabsFor(snapshot, "root").map((tab) => tab.tabId)).toEqual(["tab-1"]);
  expect(agentTabsFor(snapshot, null)).toEqual([]);
  const mixed = syncAgentTabs(panel(), [info(), info({ tabId: "other", rootSessionId: "other" })]);
  const cleaned = withoutAgentTabs(mixed);
  expect(cleaned.tabs).toEqual([]);
  expect(withoutAgentTabs(panel([{ id: "new", kind: "new" }], "new"))).toEqual(
    panel([{ id: "new", kind: "new" }], "new"),
  );
});

it("切走时记住选中的 agent 标签：切回来还活着就仍选中，已经关了就改选剩下的", () => {
  const shown = {
    ...syncAgentTabs(panel([{ id: "new", kind: "new" }], "new"), [info()]),
    activeId: agentPanelTabId("tab-1"),
  };
  const away = withoutAgentTabs(shown);
  expect(away.tabs.map((tab) => tab.id)).toEqual(["new"]);
  // 偏好里不存不存在的选中项
  expect(storeSessionPanel(away).activeTab).toBeUndefined();

  const back = syncAgentTabs(away, [info()]);
  expect(back.activeId).toBe(agentPanelTabId("tab-1"));
  expect(activeAgent(back)?.tabId).toBe("tab-1");

  const closedMeanwhile = syncAgentTabs(away, []);
  expect(closedMeanwhile.activeId).toBe("new");
  expect(activeAgent(closedMeanwhile)).toBeUndefined();
});

it("watch 通道：快照、活动文案、过期修订被丢掉，present 只确认一次", async () => {
  const fake = hostOf({ ...EMPTY_SNAPSHOT, shellGeneration: 3, revision: 1, enabled: true });
  const store = new AgentBrowserStore(fake.host);
  const seen: number[] = [];
  store.subscribe(() => {
    seen.push(store.getVersion());
  });
  const presented: string[] = [];
  store.onPresent((present) => {
    presented.push(present.tabId);
  });
  store.start();
  await vi.waitFor(() => {
    expect(store.enabled()).toBe(true);
  });

  fake.push({
    kind: "tabs",
    shellGeneration: 3,
    revision: 2,
    tabs: [info({ state: "agent" })],
  });
  expect(store.tabs()).toHaveLength(1);

  fake.push({
    kind: "operation",
    shellGeneration: 3,
    revision: 3,
    tabId: "tab-1",
    operationId: "op-1",
    state: "started",
    operation: "click",
  });
  expect(store.tabs()[0]?.operation).toBe("click");
  fake.push({
    kind: "operation",
    shellGeneration: 3,
    revision: 4,
    tabId: "tab-1",
    operationId: "op-1",
    state: "completed",
    operation: "click",
  });
  expect(store.tabs()[0]?.operation).toBeUndefined();

  fake.push({
    kind: "tabs",
    shellGeneration: 3,
    revision: 1,
    tabs: [info({ tabId: "stale" })],
  });
  expect(store.tabs().map((tab) => tab.tabId)).toEqual(["tab-1"]);

  fake.push({
    kind: "present",
    shellGeneration: 3,
    revision: 5,
    operationId: "op-9",
    tabId: "tab-1",
  });
  expect(presented).toEqual(["tab-1"]);
  expect(store.takePendingPresent()).toEqual({ operationId: "op-9", tabId: "tab-1" });
  expect(store.takePendingPresent()).toBeUndefined();
  expect(seen.length).toBeGreaterThan(0);
  store.dispose();
});

it("接管、交回、关闭各自调用对应的外壳命令", async () => {
  const fake = hostOf();
  const store = new AgentBrowserStore(fake.host);
  await expect(store.control("tab-1", "takeover")).resolves.toBe("taken_over");
  await expect(store.control("tab-1", "return")).resolves.toBe("agent");
  await expect(store.control("tab-1", "close")).resolves.toBe("agent");
  expect(fake.control).toEqual([
    { tabId: "tab-1", action: "takeover" },
    { tabId: "tab-1", action: "return" },
    { tabId: "tab-1", action: "close" },
  ]);
  const missing = new AgentBrowserStore(undefined);
  await expect(missing.control("tab-1", "takeover")).resolves.toBeUndefined();
});

it("不可见时上报的 UI 状态没有布局：离屏位置由外壳计算，不是 hide", async () => {
  const fake = hostOf({ ...EMPTY_SNAPSHOT, shellGeneration: 4, revision: 8, enabled: true });
  const store = new AgentBrowserStore(fake.host);
  await store.uiState({
    shellGeneration: 4,
    revision: 8,
    route: "session",
    sessionId: "root",
    panelOpen: true,
    activeTabId: "new",
    covered: false,
  });
  await store.uiState({
    shellGeneration: 4,
    revision: 8,
    route: "settings",
    panelOpen: false,
    covered: false,
  });
  expect(fake.ui).toHaveLength(2);
  expect(fake.ui.every((item) => item.layout === undefined)).toBe(true);
  expect(JSON.stringify(fake.ui)).not.toContain("hide");
  expect(JSON.stringify(fake.ui)).not.toContain(String(OFFSCREEN_X));
});
