/**
 * 右侧面板的会话接线（ADR-0060 修订 2026-10-18（二））：每个会话一套面板、没有会话时
 * 面板与快捷键都不可用、切换会话终端不结束、会话被删除时结束终端并清掉记录、
 * 旧全局标签一次性迁移、重启后按会话恢复。
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { RpcClient } from "@nocturne/rpc/client";

import type { OpenConversation } from "../src/conversations";
import type { DesktopHost, TerminalHost, TerminalMessage } from "../src/host";
import { useSidePanel, type SidePanelController } from "../src/PanelHost";
import { TitlebarSlot } from "../src/PanelChrome";
import { createPrefsStore, PREFS_KEY, type PrefsStore } from "../src/prefs";

vi.mock("../src/terminal-view", () => ({
  mountTerminal: () => ({
    write: () => undefined,
    fit: () => undefined,
    size: () => ({ cols: 80, rows: 24 }),
    focus: () => undefined,
    selection: () => "",
    clearSelection: () => undefined,
    mouseTracking: () => false,
    paste: () => undefined,
    clear: () => undefined,
    dispose: () => undefined,
  }),
}));

afterEach(cleanup);

function memoryStorage(initial?: Record<string, string>): Storage & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial ?? {}));
  return {
    data,
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

function fakeTerminals() {
  const opened: { id: number; cwd: string; push: (m: TerminalMessage) => void }[] = [];
  const closed: number[] = [];
  let next = 1;
  const host: TerminalHost = {
    open: vi.fn(async ({ cwd }, onMessage) => {
      const id = next++;
      opened.push({ id, cwd, push: onMessage });
      return id;
    }),
    write: vi.fn(async () => undefined),
    resize: vi.fn(async () => undefined),
    close: vi.fn(async (id: number) => {
      closed.push(id);
    }),
    readClipboard: vi.fn(async () => ""),
    writeClipboard: vi.fn(async () => undefined),
  };
  return { host, opened, closed };
}

const rpc = {
  runtime: {
    listShells: vi.fn(async () => [
      { kind: "pwsh", name: "PowerShell 7", executable: "C:\\P\\pwsh.exe", available: true },
    ]),
    describeSettings: vi.fn(async () => [{ key: "shell", effective: "auto" }]),
  },
} as unknown as RpcClient;

function conversation(id: string, workspace: string): OpenConversation {
  return {
    session: { id, fileIndex: async () => [] },
    workspace,
    view: { entries: [] },
    turnChanges: new Map(),
  } as unknown as OpenConversation;
}

interface HarnessProps {
  prefs: PrefsStore;
  host: DesktopHost;
  sessionId: string | null;
  sessions: readonly { id: string; mtimeMs: number }[] | undefined;
  openIds?: ReadonlySet<string>;
  settingsOpen?: boolean;
  controller?: { current: SidePanelController | null };
}

function Panel(props: HarnessProps) {
  const active =
    props.sessionId === null ? undefined : conversation(props.sessionId, `Z:\\${props.sessionId}`);
  const panel = useSidePanel({
    prefs: props.prefs,
    host: props.host,
    sessionId: props.sessionId,
    active,
    sessionCwd: undefined,
    sessions: props.sessions,
    openIds: props.openIds ?? new Set(props.sessionId === null ? [] : [props.sessionId]),
    loadDiff: vi.fn(),
    editors: { vscode: false, cursor: false },
    settingsOpen: props.settingsOpen ?? false,
    plainKey: null,
    client: undefined,
    ensureClient: async () => rpc,
  });
  if (props.controller !== undefined) props.controller.current = panel;
  return (
    <div className="body" ref={panel.bodyRef}>
      <nav className="sidebar" />
      <main className={`mainpane${panel.mainClass}`}>
        <textarea aria-label="输入框" />
      </main>
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

function setup(storage = memoryStorage()) {
  const terminals = fakeTerminals();
  const host = {
    terminals: terminals.host,
    openPath: vi.fn(async () => undefined),
    openUrl: vi.fn(async () => undefined),
    revealItem: vi.fn(async () => undefined),
    openInEditor: vi.fn(async () => undefined),
  } as unknown as DesktopHost;
  return { storage, prefs: createPrefsStore(storage), host, terminals };
}

function stored(storage: Storage): Record<string, unknown> {
  return JSON.parse(storage.getItem(PREFS_KEY) ?? "{}") as Record<string, unknown>;
}

function press(init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  window.dispatchEvent(event);
  return event;
}

const panelEl = () => document.querySelector<HTMLElement>(".side-panel");

it("没有会话（首页）：面板不显示，标题栏按钮置灰，面板快捷键不响应", () => {
  const { prefs, host, terminals } = setup();
  render(<Harness prefs={prefs} host={host} sessionId={null} sessions={[]} />);
  expect(panelEl()?.hidden).toBe(true);
  const button = screen.getByRole("button", { name: "右侧面板" });
  expect((button as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "会话概览" }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  for (const init of [
    { key: "b", ctrlKey: true },
    { key: "t", ctrlKey: true },
    { key: "p", ctrlKey: true },
    { key: "`", code: "Backquote", ctrlKey: true },
  ]) {
    // 浏览器默认行为（Ctrl+P 打印）照样拦下，但面板什么都不做
    expect(press(init).defaultPrevented).toBe(true);
  }
  expect(panelEl()?.hidden).toBe(true);
  expect(screen.queryAllByRole("tab")).toHaveLength(0);
  expect(terminals.host.open).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("每个会话一套面板：切换会话换内容，终端在后台继续；会话被删除时结束终端并清掉记录", async () => {
  const { storage, prefs, host, terminals } = setup();
  const controller = { current: null as SidePanelController | null };
  const sessions = [
    { id: "a", mtimeMs: 1 },
    { id: "b", mtimeMs: 2 },
  ];
  const view = render(
    <Harness prefs={prefs} host={host} sessionId="a" sessions={sessions} controller={controller} />,
  );
  // 会话刚有：面板关着
  expect(panelEl()?.hidden).toBe(true);
  act(() => {
    press({ key: "`", code: "Backquote", ctrlKey: true });
  });
  expect(panelEl()?.hidden).toBe(false);
  await waitFor(() => {
    expect(terminals.opened).toHaveLength(1);
  });
  expect(terminals.opened[0]?.cwd).toBe("Z:\\a");

  // 切到 b：b 的面板（关着、没有终端）；a 的终端不结束
  view.rerender(
    <Harness prefs={prefs} host={host} sessionId="b" sessions={sessions} controller={controller} />,
  );
  expect(panelEl()?.hidden).toBe(true);
  expect(terminals.closed).toEqual([]);
  act(() => {
    controller.current?.openFile("Z:\\b\\notes.md");
  });
  expect(panelEl()?.hidden).toBe(false);
  expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual([
    expect.stringContaining("notes.md"),
  ]);
  expect(terminals.opened).toHaveLength(1);

  // 切回 a：还是那个终端（没有重开进程），没有 b 的文件
  view.rerender(
    <Harness prefs={prefs} host={host} sessionId="a" sessions={sessions} controller={controller} />,
  );
  const tabs = screen.getAllByRole("tab").map((t) => t.textContent ?? "");
  expect(tabs).toHaveLength(1);
  expect(tabs[0]).toContain("终端");
  expect(terminals.opened).toHaveLength(1);
  expect(terminals.closed).toEqual([]);

  // 存储：按会话记，终端不存
  const saved = stored(storage).panelSessions as Record<string, { tabs: { kind: string }[] }>;
  expect(saved.a?.tabs).toEqual([]);
  expect(saved.b?.tabs.map((t) => t.kind)).toEqual(["file"]);

  // a 被删除（列表里没了，也不再打开）：结束它的终端、清掉记录
  view.rerender(
    <Harness
      prefs={prefs}
      host={host}
      sessionId="b"
      sessions={[{ id: "b", mtimeMs: 2 }]}
      openIds={new Set(["b"])}
      controller={controller}
    />,
  );
  await waitFor(() => {
    expect(terminals.closed).toEqual([1]);
  });
  const after = stored(storage).panelSessions as Record<string, unknown>;
  expect(Object.keys(after)).toEqual(["b"]);
});

it("刚建好的会话还没进列表时不当作被删除", async () => {
  const { prefs, host, terminals } = setup();
  const view = render(<Harness prefs={prefs} host={host} sessionId="new" sessions={[]} />);
  act(() => {
    press({ key: "`", code: "Backquote", ctrlKey: true });
  });
  await waitFor(() => {
    expect(terminals.opened).toHaveLength(1);
  });
  // 列表刷新了但还没有它；它是打开着的
  view.rerender(
    <Harness prefs={prefs} host={host} sessionId="new" sessions={[{ id: "x", mtimeMs: 1 }]} />,
  );
  await act(async () => {
    await Promise.resolve();
  });
  expect(terminals.closed).toEqual([]);
});

it("旧全局标签只迁移一次，给最近活动的会话；重启后按会话恢复「文件」「变更」", () => {
  const storage = memoryStorage({
    [PREFS_KEY]: JSON.stringify({
      panelOpen: true,
      panelTabs: [
        { id: "c", kind: "changes" },
        { id: "f", kind: "file", workspace: "Z:\\y", absolutePath: "Z:\\y\\a.ts" },
      ],
      panelActiveTab: "f",
    }),
  });
  const first = setup(storage);
  const sessions = [
    { id: "x", mtimeMs: 1 },
    { id: "y", mtimeMs: 5 },
  ];
  // 列表还没到：不迁移
  const view = render(
    <Harness prefs={first.prefs} host={first.host} sessionId="y" sessions={undefined} />,
  );
  expect(stored(storage).panelSessionsMigrated).toBeUndefined();
  view.rerender(
    <Harness prefs={first.prefs} host={first.host} sessionId="y" sessions={sessions} />,
  );
  const saved = stored(storage);
  expect(saved.panelSessionsMigrated).toBe(true);
  expect(saved.panelTabs).toBeUndefined();
  expect(saved.panelOpen).toBeUndefined();
  expect(Object.keys(saved.panelSessions as object)).toEqual(["y"]);
  expect(panelEl()?.hidden).toBe(false);
  expect(screen.getAllByRole("tab")).toHaveLength(2);
  expect(screen.getByRole("tab", { selected: true }).textContent).toContain("a.ts");
  view.unmount();

  // 重启：同一份存储再读一遍，x 没有面板，y 恢复原样；不会再迁移一次
  const second = setup(storage);
  const again = render(
    <Harness prefs={second.prefs} host={second.host} sessionId="x" sessions={sessions} />,
  );
  expect(panelEl()?.hidden).toBe(true);
  again.rerender(
    <Harness prefs={second.prefs} host={second.host} sessionId="y" sessions={sessions} />,
  );
  expect(panelEl()?.hidden).toBe(false);
  expect(screen.getAllByRole("tab").map((t) => t.textContent ?? "")).toEqual([
    expect.stringContaining("变更"),
    expect.stringContaining("a.ts"),
  ]);
  expect(Object.keys(stored(storage).panelSessions as object)).toEqual(["y"]);
});

it("面板宽度全局；Ctrl+B 只开关当前会话的面板", () => {
  const { prefs, host } = setup();
  const sessions = [
    { id: "a", mtimeMs: 1 },
    { id: "b", mtimeMs: 2 },
  ];
  const view = render(<Harness prefs={prefs} host={host} sessionId="a" sessions={sessions} />);
  act(() => {
    press({ key: "b", ctrlKey: true });
  });
  expect(panelEl()?.hidden).toBe(false);
  const width = panelEl()?.style.width;
  view.rerender(<Harness prefs={prefs} host={host} sessionId="b" sessions={sessions} />);
  expect(panelEl()?.hidden).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "右侧面板" }));
  expect(panelEl()?.hidden).toBe(false);
  expect(panelEl()?.style.width).toBe(width);
  act(() => {
    press({ key: "b", ctrlKey: true });
  });
  expect(panelEl()?.hidden).toBe(true);
  view.rerender(<Harness prefs={prefs} host={host} sessionId="a" sessions={sessions} />);
  expect(panelEl()?.hidden).toBe(false);
});

it("设置页：不渲染面板，按钮置灰，面板快捷键与 Esc 都不响应；回到会话恢复原状，终端不受影响", async () => {
  const { prefs, host, terminals } = setup();
  const sessions = [{ id: "a", mtimeMs: 1 }];
  const view = render(<Harness prefs={prefs} host={host} sessionId="a" sessions={sessions} />);
  act(() => {
    press({ key: "`", code: "Backquote", ctrlKey: true });
  });
  await waitFor(() => {
    expect(terminals.opened).toHaveLength(1);
  });
  expect(panelEl()?.hidden).toBe(false);

  view.rerender(
    <Harness prefs={prefs} host={host} sessionId="a" sessions={sessions} settingsOpen />,
  );
  expect(panelEl()?.hidden).toBe(true);
  expect((screen.getByRole("button", { name: "右侧面板" }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  expect((screen.getByRole("button", { name: "会话概览" }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  act(() => {
    for (const init of [
      { key: "b", ctrlKey: true },
      { key: "t", ctrlKey: true },
      { key: "p", ctrlKey: true },
      { key: "`", code: "Backquote", ctrlKey: true },
      { key: "Escape" },
    ])
      press(init);
  });
  expect(panelEl()?.hidden).toBe(true);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(terminals.opened).toHaveLength(1);
  expect(terminals.closed).toEqual([]);

  view.rerender(<Harness prefs={prefs} host={host} sessionId="a" sessions={sessions} />);
  expect(panelEl()?.hidden).toBe(false);
  expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual([
    expect.stringContaining("终端"),
  ]);
  expect(terminals.opened).toHaveLength(1);
});

it("Esc 开关概览浮层：焦点在空闲输入框里也行；别处已处理的 Esc 不算；没有会话不开", () => {
  const { prefs, host } = setup();
  const sessions = [{ id: "a", mtimeMs: 1 }];
  const view = render(<Harness prefs={prefs} host={host} sessionId="a" sessions={sessions} />);
  const overview = () => screen.queryByRole("dialog", { name: "会话概览" });
  const field = screen.getByRole("textbox", { name: "输入框" });
  field.focus();
  act(() => {
    fireEvent.keyDown(field, { key: "Escape" });
  });
  expect(overview()).not.toBeNull();
  act(() => {
    fireEvent.keyDown(field, { key: "Escape" });
  });
  expect(overview()).toBeNull();
  // 输入框的补全、中断等先处理了（preventDefault）：浮层不动
  field.addEventListener("keydown", (event) => {
    event.preventDefault();
  });
  act(() => {
    fireEvent.keyDown(field, { key: "Escape" });
  });
  expect(overview()).toBeNull();
  view.rerender(<Harness prefs={prefs} host={host} sessionId={null} sessions={sessions} />);
  act(() => {
    press({ key: "Escape" });
  });
  expect(overview()).toBeNull();
});

it("概览浮层：让位后对话区仍 ≥480px 才停靠，否则盖在对话上", () => {
  let bodyWidth = 1200;
  const rect = vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: HTMLElement) {
      const width = this.classList.contains("body")
        ? bodyWidth
        : this.classList.contains("sidebar")
          ? 236
          : 0;
      return { width, height: 0, x: 0, y: 0, top: 0, left: 0, right: width, bottom: 0 } as DOMRect;
    });
  const observers: (() => void)[] = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        observers.push(callback);
      }
      observe() {
        return undefined;
      }
      disconnect() {
        return undefined;
      }
    },
  );
  try {
    const { prefs, host } = setup();
    prefs.update({ overviewOpen: true });
    render(
      <Harness prefs={prefs} host={host} sessionId="a" sessions={[{ id: "a", mtimeMs: 1 }]} />,
    );
    const main = () => document.querySelector("main");
    const pop = () => document.querySelector(".ovpop");
    expect(main()?.classList.contains("ov-docked")).toBe(true);
    expect(pop()?.classList.contains("docked")).toBe(true);
    // 236 + 300 + 480 = 1016：差 1px 就改成覆盖
    bodyWidth = 1015;
    act(() => {
      for (const measure of observers) measure();
    });
    expect(main()?.classList.contains("ov-docked")).toBe(false);
    expect(pop()?.classList.contains("docked")).toBe(false);
    bodyWidth = 1016;
    act(() => {
      for (const measure of observers) measure();
    });
    expect(main()?.classList.contains("ov-docked")).toBe(true);
  } finally {
    rect.mockRestore();
    vi.unstubAllGlobals();
  }
});

it("开着的会话被删除（列过又不见了）也整套清理：结束终端、删掉记录", async () => {
  const { storage, prefs, host, terminals } = setup();
  const sessions = [
    { id: "a", mtimeMs: 1 },
    { id: "b", mtimeMs: 2 },
  ];
  const view = render(<Harness prefs={prefs} host={host} sessionId="a" sessions={sessions} />);
  act(() => {
    press({ key: "`", code: "Backquote", ctrlKey: true });
  });
  await waitFor(() => {
    expect(terminals.opened).toHaveLength(1);
  });
  view.rerender(<Harness prefs={prefs} host={host} sessionId="b" sessions={sessions} />);
  // a 还在打开的会话里（例如后台已退出的会话关不掉），但列表里没了
  view.rerender(
    <Harness
      prefs={prefs}
      host={host}
      sessionId="b"
      sessions={[{ id: "b", mtimeMs: 2 }]}
      openIds={new Set(["a", "b"])}
    />,
  );
  await waitFor(() => {
    expect(terminals.closed).toEqual([1]);
  });
  expect(Object.keys((stored(storage).panelSessions ?? {}) as object)).not.toContain("a");
});
