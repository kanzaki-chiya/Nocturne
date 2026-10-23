/**
 * agent 标签的界面（desktop-browser.md 第 7 节）：
 * 徽标与活动状态、接管/交回按钮、离屏不上报位置、浮层不截 agent 标签。
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { AgentBrowserPane } from "../src/AgentBrowserPane";
import type { AgentTabInfo, BrowserBounds, BrowserHost } from "../src/host";
import { SidePanel, type SidePanelProps } from "../src/SidePanel";
import { BrowserPool } from "../src/browser-pool";
import type { BrowserTab, PanelTab } from "../src/side-panel";

const rect = (width: number, height: number) =>
  ({
    x: 0,
    y: 0,
    width,
    height,
    top: 0,
    left: 900,
    right: 900 + width,
    bottom: height,
    toJSON: () => ({}),
  }) as DOMRect;

function info(over: Partial<AgentTabInfo> = {}): AgentTabInfo {
  return {
    tabId: "tab-1",
    rootSessionId: "root",
    actorSessionId: "root",
    title: "本地测试页",
    url: "http://127.0.0.1:9/page",
    live: true,
    pinned: true,
    state: "agent",
    child: false,
    ...over,
  };
}

function agentTab(over: Partial<AgentTabInfo> = {}): BrowserTab {
  const agent = info(over);
  return { id: `agent:${agent.tabId}`, kind: "browser", url: agent.url, title: agent.title, agent };
}

function props(overrides: Partial<SidePanelProps>): SidePanelProps {
  return {
    tabs: [],
    panes: [],
    activeId: "",
    overlay: false,
    width: 520,
    onActivate: vi.fn(),
    onCloseTab: vi.fn(),
    onMoveTab: vi.fn(),
    onNewTab: vi.fn(),
    onResize: vi.fn(),
    onOpenChanges: vi.fn(),
    onQuickOpen: vi.fn(),
    onOpenTerminal: vi.fn(),
    onAddress: vi.fn(async () => undefined),
    changes: undefined,
    canOpenFiles: true,
    readFile: vi.fn(),
    readerKey: "1",
    fileActions: {
      externalLabel: "用 VS Code 打开",
      openExternal: vi.fn(async () => undefined),
      reveal: vi.fn(async () => undefined),
      openInBrowser: vi.fn(async () => undefined),
      browserLabel: "在系统浏览器打开",
    },
    terminals: undefined,
    loadShells: vi.fn(async () => ({ shells: [], setting: undefined })),
    onShellChange: vi.fn(),
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("接管和交回按钮调用各自的动作；接管后界面写明控制权在用户手里", () => {
  const onControl = vi.fn();
  const view = render(
    <AgentBrowserPane
      info={info()}
      visible
      onSlot={vi.fn()}
      onControl={onControl}
      onClose={vi.fn()}
    />,
  );
  expect(screen.getByText("agent 控制中")).toBeTruthy();
  expect(screen.getByText(/点网页或「接管」会立即撤销/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "接管" }));
  expect(onControl).toHaveBeenCalledWith("tab-1", "takeover");

  view.rerender(
    <AgentBrowserPane
      info={info({ state: "taken_over" })}
      visible
      onSlot={vi.fn()}
      onControl={onControl}
      onClose={vi.fn()}
    />,
  );
  expect(screen.getByText("已被你接管")).toBeTruthy();
  expect(screen.getByText(/你已接管：直接操作网页/)).toBeTruthy();
  expect(screen.queryByText(/点网页或「接管」会立即撤销/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "交给 agent" }));
  expect(onControl).toHaveBeenLastCalledWith("tab-1", "return");
});

it("子代理标签显示子代理徽标；已关闭的标签不能再接管", () => {
  const onClose = vi.fn();
  render(
    <AgentBrowserPane
      info={info({ child: true, actorSessionId: "child-1", state: "ended", live: false })}
      visible
      onSlot={vi.fn()}
      onControl={vi.fn()}
      onClose={onClose}
    />,
  );
  expect(screen.getByText("子代理")).toBeTruthy();
  expect(screen.getByText("已关闭")).toBeTruthy();
  expect((screen.getByRole("button", { name: "接管" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText("标签已关闭")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "关闭 agent 标签" }));
  expect(onClose).toHaveBeenCalledWith("tab-1");
  // 占位区里的移除按钮同样传外壳 tabId，不是面板里带 `agent:` 前缀的 id
  onClose.mockClear();
  fireEvent.click(screen.getByRole("button", { name: "移除已关闭的标签" }));
  expect(onClose).toHaveBeenCalledWith("tab-1");
});

it("可见时上报占位区；不可见时不上报，也不发 hide", () => {
  const onSlot = vi.fn();
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(rect(480, 640));
  const view = render(
    <AgentBrowserPane
      info={info()}
      visible
      onSlot={onSlot}
      onControl={vi.fn()}
      onClose={vi.fn()}
    />,
  );
  expect(onSlot).toHaveBeenCalledWith("tab-1", { x: 900, y: 0, width: 480, height: 640 });
  onSlot.mockClear();
  view.rerender(
    <AgentBrowserPane
      info={info()}
      visible={false}
      onSlot={onSlot}
      onControl={vi.fn()}
      onClose={vi.fn()}
    />,
  );
  expect(onSlot).not.toHaveBeenCalled();
});

it("离屏的 agent 标签有动作时，标签栏徽标显示活动状态", () => {
  const tabs: PanelTab[] = [agentTab({ state: "busy", operation: "type" })];
  const view = render(<SidePanel {...props({ tabs, panes: tabs, activeId: tabs[0]?.id ?? "" })} />);
  const dot = screen.getByLabelText("agent 正在操作");
  expect(dot.className).toContain("busy");
  expect(screen.getByRole("tab").className).toContain("busy");
  view.rerender(
    <SidePanel
      {...props({
        tabs: [agentTab({ state: "agent" })],
        panes: [agentTab({ state: "agent" })],
        activeId: "agent:tab-1",
      })}
    />,
  );
  expect(screen.getByLabelText("agent 控制中").className).not.toContain("busy");
  expect(screen.getByRole("tab").className).not.toContain("busy");
});

it("浮层遮挡只截用户的浏览器标签；agent 标签不进浏览器池、也不截图", async () => {
  const layouts: (BrowserBounds | null)[] = [];
  const host: BrowserHost = {
    create: vi.fn(async () => 7),
    navigate: vi.fn(async () => undefined),
    layout: vi.fn(async (_id, bounds) => {
      layouts.push(bounds);
    }),
    action: vi.fn(async () => undefined),
    capture: vi.fn(async () => new Uint8Array([1, 2, 3])),
    destroy: vi.fn(async () => undefined),
  };
  const pool = new BrowserPool(host, {
    onUrl: () => undefined,
    onTitle: () => undefined,
    onNewWindow: () => undefined,
    onShortcut: () => undefined,
  });
  const native = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.classList.contains("sp-browser-slot")) return rect(480, 640);
    if (this.getAttribute("role") === "dialog") return rect(200, 200);
    return native.call(this);
  });
  const user: BrowserTab = { id: "user", kind: "browser", url: "https://example.test/" };
  const agent = agentTab({ state: "busy" });
  const onSlot = vi.fn();
  const shown = agent.agent ?? info({ state: "busy" });
  const agents = {
    tabs: new Map([["tab-1", shown]]),
    onSlot,
    onControl: vi.fn(),
    onClose: vi.fn(),
  };
  const view = render(
    <SidePanel
      {...props({
        tabs: [user, agent],
        panes: [user, agent],
        activeId: user.id,
        browsers: pool,
        agents,
      })}
    />,
  );
  await act(async () => {
    await Promise.resolve();
  });
  // 当前是用户标签：只有它进浏览器池；离屏的 agent 标签不上报位置
  expect(host.create).toHaveBeenCalledTimes(1);
  expect(onSlot).not.toHaveBeenCalled();

  // 浮层盖住用户标签的占位区：截图只打到这个 webview
  document.body.insertAdjacentHTML("beforeend", '<div role="dialog"></div>');
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(host.capture).toHaveBeenCalledTimes(1);
  expect(host.capture).toHaveBeenCalledWith(7);

  // 切到 agent 标签：上报真实位置，不新建 webview，也不再截图
  view.rerender(
    <SidePanel
      {...props({
        tabs: [user, agent],
        panes: [user, agent],
        activeId: agent.id,
        browsers: pool,
        agents,
      })}
    />,
  );
  await act(async () => {
    await Promise.resolve();
  });
  expect(onSlot).toHaveBeenCalledWith(
    "tab-1",
    expect.objectContaining({ width: 480, height: 640 }),
  );
  expect(host.create).toHaveBeenCalledTimes(1);
  expect(host.capture).toHaveBeenCalledTimes(1);
  // 用户标签切走后走 hide（bounds 为 null）；agent 标签没有这条命令
  expect(layouts.some((item) => item === null)).toBe(true);
  pool.dispose();
});
