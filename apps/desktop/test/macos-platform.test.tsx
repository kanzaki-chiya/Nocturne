/**
 * macOS 桌面端平台分支测试（ADR-0110 第 4、7 节）：覆盖平台判定、WindowFrame、
 * 每处改到的快捷键在 Windows 与 macOS 下的行为、<Kbd> 格式化、终端登录 shell、
 * 不可用设置项的隐藏，以及 terminal-view 的 copy/copy-keep 选区清理逻辑。
 */
import {
  createEvent,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionView, type UserEntry } from "@nocturne/core/protocol";
import type { RpcClient, RpcSession } from "@nocturne/rpc/client";

import { App, shouldBlockGlobalRefresh } from "../src/App";
import { createAttachmentImageSource } from "../src/attachment-images";
import { BrowserSettingsPage, type BrowsingDataHost } from "../src/BrowserSettingsPage";
import { Composer, type ComposerProps } from "../src/Composer";
import { Conversation } from "../src/Conversation";
import { FileOpenButton, type FileOpenActions } from "../src/FileOpenMenu";
import type { AgentBrowserHost, DesktopHost, TerminalHost } from "../src/host";
import { TitlebarSlot } from "../src/PanelChrome";
import { useSidePanel } from "../src/PanelHost";
import {
  formatShortcut,
  hasPrimaryMod,
  hasPrimaryModOrMetaOnOther,
  isMacOS,
  setPlatformForTest,
} from "../src/platform";
import { createPrefsStore } from "../src/prefs";
import type { SettingItem } from "../src/rpc-types";
import { buildSessionTree } from "../src/session-tree";
import { SettingsPage } from "../src/SettingsPage";
import { Sidebar, type SidebarProps } from "../src/Sidebar";
import { SidePanel } from "../src/SidePanel";
import { mergeMacLoginShell, TerminalPane, terminalShells } from "../src/TerminalPane";
import { WindowFrame } from "../src/WindowFrame";
import { fakeServer, withInit } from "./fake-server";

const xtermHandlers: ((event: KeyboardEvent) => boolean)[] = [];
let xtermHasSelection = false;

vi.mock("@xterm/xterm", () => ({
  Terminal: class MockTerminal {
    unicode = { activeVersion: "" };
    options: Record<string, unknown> = {};
    loadAddon() {
      return undefined;
    }
    open() {
      return undefined;
    }
    attachCustomKeyEventHandler(fn: (event: KeyboardEvent) => boolean) {
      xtermHandlers.push(fn);
    }
    hasSelection() {
      return xtermHasSelection;
    }
    onData() {
      return { dispose: () => undefined };
    }
    onResize() {
      return { dispose: () => undefined };
    }
    write() {
      return undefined;
    }
    focus() {
      return undefined;
    }
    getSelection() {
      return xtermHasSelection ? "selected" : "";
    }
    clearSelection() {
      return undefined;
    }
    paste() {
      return undefined;
    }
    clear() {
      return undefined;
    }
    reset() {
      return undefined;
    }
    dispose() {
      return undefined;
    }
    modes = { mouseTrackingMode: "none" };
    cols = 80;
    rows = 24;
  },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class MockFitAddon {
    fit() {
      return undefined;
    }
  },
}));

vi.mock("@xterm/addon-unicode11", () => ({
  Unicode11Addon: class MockUnicode11Addon {
    readonly name = "unicode11";
  },
}));

const stubMatchMedia = () => {
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
};

afterEach(() => {
  cleanup();
  setPlatformForTest(null);
  xtermHandlers.length = 0;
  xtermHasSelection = false;
  vi.unstubAllGlobals();
});

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k) => map.get(k) ?? null,
    key: (i) => [...map.keys()][i] ?? null,
    removeItem: (k) => {
      map.delete(k);
    },
    setItem: (k, v) => {
      map.set(k, v);
    },
  };
}

function minimalHost(overrides: Partial<DesktopHost> = {}): DesktopHost {
  return {
    invoke: vi.fn(async (cmd: string) => {
      if (cmd === "plugin:window|is_maximized") return false;
      if (cmd === "node_probe")
        return {
          ok: true,
          selected: { path: "node", version: "24.0.0", source: "path" },
          attempts: [],
        };
      if (cmd === "plain_workspace") return "Z:/plain";
      return undefined;
    }),
    createChannel: () =>
      ({ onmessage: null }) as unknown as ReturnType<DesktopHost["createChannel"]>,
    openUrl: vi.fn(async () => undefined),
    openPath: vi.fn(async () => undefined),
    revealItem: vi.fn(async () => undefined),
    homeDir: vi.fn(async () => "/Users/test"),
    pickFolder: vi.fn(async () => null),
    pickImages: vi.fn(async () => []),
    onCloseRequested: vi.fn(() => () => undefined),
    quitApp: vi.fn(async () => undefined),
    cancelQuit: vi.fn(async () => undefined),
    relaunch: vi.fn(async () => undefined),
    appVersion: vi.fn(async () => "0.59.0"),
    checkUpdate: vi.fn(async () => null),
    detectEditors: vi.fn(async () => ({ vscode: false, cursor: false })),
    openInEditor: vi.fn(async () => undefined),
    note: vi.fn(),
    notify: vi.fn(async () => ({ shown: true })),
    dismissNotification: vi.fn(async () => undefined),
    requestAttention: vi.fn(async () => undefined),
    onNotificationActivated: vi.fn(() => () => undefined),
    ...overrides,
  };
}

function composerProps(overrides: Partial<ComposerProps> = {}): ComposerProps {
  return {
    running: false,
    fileRefs: null,
    pickImages: vi.fn(async () => []),
    onSubmit: vi.fn(async () => true),
    onInterrupt: vi.fn(),
    onSlash: vi.fn(async () => true),
    controls: {
      model: {
        value: "test/m",
        label: "m",
        groups: [{ label: "模型", options: [{ value: "test/m", label: "m" }] }],
        onSelect: vi.fn(),
      },
      effort: {
        value: "off",
        label: "off",
        groups: [{ label: "思考", options: [{ value: "off", label: "off" }] }],
        onSelect: vi.fn(),
      },
      preset: {
        value: "default",
        label: "默认",
        groups: [{ label: "权限", options: [{ value: "default", label: "默认" }] }],
        onSelect: vi.fn(),
      },
    },
    ...overrides,
  };
}

function sidebarProps(overrides: Partial<SidebarProps> = {}): SidebarProps {
  const tree = buildSessionTree(
    [
      {
        id: "s1",
        firstText: "会话一",
        cwd: "/repo",
        createdAt: "2026-11-22T00:00:00.000Z",
        mtimeMs: 1_700_000_000_000,
      },
      {
        id: "s2",
        firstText: "会话二",
        cwd: "/repo",
        createdAt: "2026-11-22T00:01:00.000Z",
        mtimeMs: 1_700_000_060_000,
      },
    ],
    { pinned: [], projects: [], projectSort: "activity", hidden: [] },
    { plainWorkspace: null, collapsed: new Set() },
  );
  const noop = () => undefined;
  return {
    tree,
    pinnedIds: new Set(),
    selectedId: null,
    collapsed: new Set(),
    onSelectSession: noop,
    onToggleCollapse: noop,
    onExpandProject: noop,
    onCollapseProject: noop,
    onExpandChats: noop,
    onCollapseChats: noop,
    projectSort: "activity",
    hiddenProjects: [],
    onSetSort: noop,
    onMoveProject: noop,
    onPin: noop,
    onUnpin: noop,
    onRename: async () => undefined,
    onArchive: noop,
    onHideProject: noop,
    onRestoreProject: noop,
    onOpenProject: noop,
    onNewSession: noop,
    ...overrides,
  };
}

describe("平台模块与快捷键格式化", () => {
  it("支持测试注入平台，修饰键与 <Kbd> 格式化按平台切换", () => {
    setPlatformForTest("other");
    expect(isMacOS()).toBe(false);
    expect(hasPrimaryMod({ ctrlKey: true, metaKey: false })).toBe(true);
    expect(hasPrimaryMod({ ctrlKey: false, metaKey: true })).toBe(false);
    expect(hasPrimaryModOrMetaOnOther({ ctrlKey: true, metaKey: false })).toBe(true);
    expect(hasPrimaryModOrMetaOnOther({ ctrlKey: false, metaKey: true })).toBe(true);
    expect(formatShortcut("Mod+Shift+G")).toBe("Ctrl+Shift+G");
    expect(formatShortcut("Mod+P")).toBe("Ctrl+P");
    expect(formatShortcut("Mod+`")).toBe("Ctrl+`");

    setPlatformForTest("macos");
    expect(isMacOS()).toBe(true);
    expect(hasPrimaryMod({ ctrlKey: false, metaKey: true })).toBe(true);
    expect(hasPrimaryMod({ ctrlKey: true, metaKey: false })).toBe(false);
    expect(hasPrimaryMod({ ctrlKey: true, metaKey: true })).toBe(false);
    expect(hasPrimaryModOrMetaOnOther({ ctrlKey: false, metaKey: true })).toBe(true);
    expect(hasPrimaryModOrMetaOnOther({ ctrlKey: true, metaKey: false })).toBe(false);
    expect(formatShortcut("Mod+Shift+G")).toBe("⇧⌘G");
    expect(formatShortcut("Mod+P")).toBe("⌘P");
    expect(formatShortcut("Mod+`")).toBe("⌘`");
    expect(formatShortcut("Ctrl+Alt+Shift+Mod+K")).toBe("⌃⌥⇧⌘K");
  });
});

describe("WindowFrame 标题栏结构", () => {
  it("Windows 渲染自绘三钮且无 macOS 让位类", () => {
    setPlatformForTest("other");
    const { container } = render(
      <WindowFrame host={minimalHost()}>
        <div className="body" />
      </WindowFrame>,
    );
    const header = container.querySelector(".window-titlebar");
    expect(header?.classList.contains("is-macos")).toBe(false);
    expect(container.querySelector(".window-controls")).not.toBeNull();
    expect(screen.getByRole("button", { name: "最小化" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "最大化" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "关闭" })).toBeTruthy();
  });

  it("macOS 不渲染自绘窗口按钮并在品牌区左侧预留系统按钮空间", () => {
    setPlatformForTest("macos");
    const { container } = render(
      <WindowFrame host={minimalHost()}>
        <div className="body" />
      </WindowFrame>,
    );
    const header = container.querySelector(".window-titlebar");
    expect(header?.classList.contains("is-macos")).toBe(true);
    expect(container.querySelector(".window-controls")).toBeNull();
    expect(screen.queryByRole("button", { name: "最小化" })).toBeNull();
    expect(screen.queryByRole("button", { name: "最大化" })).toBeNull();
    expect(screen.queryByRole("button", { name: "关闭" })).toBeNull();
    expect(container.querySelector(".window-brand")?.textContent).toContain("Nocturne");
  });
});

describe("全局刷新拦截（App.tsx shouldBlockGlobalRefresh）", () => {
  it("Windows 拦截 Ctrl+R 且放行 Cmd+R", () => {
    setPlatformForTest("other");
    expect(
      shouldBlockGlobalRefresh(new KeyboardEvent("keydown", { key: "r", ctrlKey: true }), false),
    ).toBe(true);
    expect(
      shouldBlockGlobalRefresh(new KeyboardEvent("keydown", { key: "r", metaKey: true }), false),
    ).toBe(false);
  });

  it("macOS 拦截 Cmd+R 且放行 Ctrl+R", () => {
    setPlatformForTest("macos");
    expect(
      shouldBlockGlobalRefresh(new KeyboardEvent("keydown", { key: "r", metaKey: true }), false),
    ).toBe(true);
    expect(
      shouldBlockGlobalRefresh(new KeyboardEvent("keydown", { key: "r", ctrlKey: true }), false),
    ).toBe(false);
  });
});

describe("App 全局快捷键（Ctrl+Alt+Esc 与 Ctrl+K / Cmd+K）", () => {
  it("Windows 响应 Ctrl+Alt+Esc 与 Ctrl+K", () => {
    setPlatformForTest("other");
    render(<App host={minimalHost()} />);

    const esc = createEvent.keyDown(window, { key: "Escape", ctrlKey: true, altKey: true });
    fireEvent(window, esc);
    expect(esc.defaultPrevented).toBe(true);

    const k = createEvent.keyDown(window, { key: "k", ctrlKey: true });
    fireEvent(window, k);
    expect(k.defaultPrevented).toBe(true);
  });

  it("macOS 不注册 Ctrl+Alt+Esc，搜索仅响应 Cmd+K 而不响应 Ctrl+K", () => {
    setPlatformForTest("macos");
    render(<App host={minimalHost()} />);

    const esc = createEvent.keyDown(window, { key: "Escape", ctrlKey: true, altKey: true });
    fireEvent(window, esc);
    expect(esc.defaultPrevented).toBe(false);

    const ctrlK = createEvent.keyDown(window, { key: "k", ctrlKey: true });
    fireEvent(window, ctrlK);
    expect(ctrlK.defaultPrevented).toBe(false);

    const cmdK = createEvent.keyDown(window, { key: "k", metaKey: true });
    fireEvent(window, cmdK);
    expect(cmdK.defaultPrevented).toBe(true);
  });
});

describe("Composer 快捷键（Ctrl+R / Cmd+R 与 Ctrl+Shift+V / Cmd+Shift+V）", () => {
  const longText = "x".repeat(35000);
  const pasteLong = (input: HTMLElement) => {
    const ev = createEvent.paste(input, {
      clipboardData: {
        files: [],
        getData: (type: string) => (type === "text/plain" ? longText : ""),
        items: [],
      },
    });
    fireEvent(input, ev);
    return ev;
  };

  it("Windows 用 Ctrl+R 开历史、Ctrl+Shift+V 标记纯文本粘贴", () => {
    const createUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:mock");
    const revokeUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    try {
      setPlatformForTest("other");
      render(<Composer {...composerProps()} />);
      const input = screen.getByRole("textbox");

      fireEvent.keyDown(input, { key: "r", metaKey: true });
      expect(screen.queryByRole("listbox")).toBeNull();

      fireEvent.keyDown(input, { key: "r", ctrlKey: true });
      expect(screen.getByRole("listbox")).toBeTruthy();

      fireEvent.keyDown(input, { key: "Escape" });
      // 不按修饰键直接粘贴长文本会被折叠为粘贴片段（拦默认）
      expect(pasteLong(input).defaultPrevented).toBe(true);

      // Ctrl+Shift+V 进入纯文本粘贴路径（不拦默认）
      fireEvent.keyDown(input, { key: "V", ctrlKey: true, shiftKey: true });
      expect(pasteLong(input).defaultPrevented).toBe(false);
    } finally {
      createUrl.mockRestore();
      revokeUrl.mockRestore();
    }
  });

  it("macOS 用 Cmd+R 开历史、Cmd+Shift+V 标记纯文本粘贴，Ctrl 组合不占用", () => {
    const createUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:mock");
    const revokeUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    try {
      setPlatformForTest("macos");
      render(<Composer {...composerProps()} />);
      const input = screen.getByRole("textbox");

      fireEvent.keyDown(input, { key: "r", ctrlKey: true });
      expect(screen.queryByRole("listbox")).toBeNull();

      fireEvent.keyDown(input, { key: "r", metaKey: true });
      expect(screen.getByRole("listbox")).toBeTruthy();
      fireEvent.keyDown(input, { key: "Escape" });

      // macOS 下 Ctrl+Shift+V 不进入纯文本粘贴路径，长文本仍被折叠（拦默认）
      fireEvent.keyDown(input, { key: "V", ctrlKey: true, shiftKey: true });
      expect(pasteLong(input).defaultPrevented).toBe(true);

      // Cmd+Shift+V 进入纯文本粘贴路径（不拦默认）
      fireEvent.keyDown(input, { key: "V", metaKey: true, shiftKey: true });
      expect(pasteLong(input).defaultPrevented).toBe(false);
    } finally {
      createUrl.mockRestore();
      revokeUrl.mockRestore();
    }
  });
});

describe("Conversation 页内查找（Ctrl+F / Cmd+F）", () => {
  const makeConversation = () => {
    const view = createSessionView();
    const entry: UserEntry = {
      kind: "user",
      key: "u:1",
      turnId: "t1",
      seq: 1,
      content: [{ type: "text", text: "hello world" }],
      attachments: [],
      fileRefs: [],
    };
    view.entries.push(entry);
    const session = {
      id: "s-find",
      readAttachment: vi.fn(),
      respondPermission: vi.fn(),
      respondSubagentPermission: vi.fn(),
      respondQuestion: vi.fn(),
    } as unknown as RpcSession;
    return (
      <Conversation
        view={view}
        session={session}
        cwd="/repo"
        busy={false}
        images={createAttachmentImageSource()}
        subscribeEvents={() => () => undefined}
        enableFind
        openUrl={vi.fn()}
      />
    );
  };

  it("Windows 用 Ctrl+F 打开查找栏", () => {
    setPlatformForTest("other");
    render(makeConversation());
    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    expect(screen.getByRole("textbox", { name: "搜索会话" })).toBeTruthy();
  });

  it("macOS 仅用 Cmd+F 打开查找栏，Ctrl+F 不拦截", () => {
    setPlatformForTest("macos");
    render(makeConversation());
    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    expect(screen.queryByRole("textbox", { name: "搜索会话" })).toBeNull();
    fireEvent.keyDown(window, { key: "f", metaKey: true });
    expect(screen.getByRole("textbox", { name: "搜索会话" })).toBeTruthy();
  });
});

describe("PanelHost 面板快捷键与 SidePanel <Kbd>", () => {
  const STABLE_SESSIONS = [{ id: "s1", mtimeMs: 1_700_000_000_000 }] as const;
  const STABLE_OPEN_IDS = new Set(["s1"]);
  const STABLE_EDITORS = { vscode: false, cursor: false } as const;
  const STABLE_ACTIVE = {
    session: { id: "s1", fileIndex: async () => [] },
    workspace: "/repo",
    view: { entries: [], pendingSubagentPermissions: [] },
    turnChanges: new Map(),
  };
  const STABLE_RPC = {
    runtime: {
      listFiles: vi.fn(async () => []),
      listShells: vi.fn(async () => []),
      describeSettings: vi.fn(async () => []),
      listSubagentWorktrees: vi.fn(async () => []),
      readFile: vi.fn(),
    },
  } as unknown as RpcClient;
  const ensureStableRpc = async () => STABLE_RPC;

  function PanelHarness({
    prefs,
    host,
  }: {
    prefs: ReturnType<typeof createPrefsStore>;
    host: DesktopHost;
  }) {
    const panel = useSidePanel({
      host,
      prefs,
      sessionId: "s1",
      active: STABLE_ACTIVE as never,
      sessions: STABLE_SESSIONS,
      openIds: STABLE_OPEN_IDS,
      sessionCwd: "/repo",
      loadDiff: vi.fn(),
      plainKey: null,
      client: undefined,
      ensureClient: ensureStableRpc,
      settingsOpen: false,
      editors: STABLE_EDITORS,
    });
    return (
      <TitlebarSlot.Provider value={null}>
        <div className="body" ref={panel.bodyRef}>
          {panel.mainOverlays}
          {panel.panel}
        </div>
      </TitlebarSlot.Provider>
    );
  }

  it("Windows 用 Ctrl+B / Ctrl+P 触发面板快捷键", async () => {
    setPlatformForTest("other");
    const prefs = createPrefsStore(memoryStorage());
    prefs.update({ panelSessionsMigrated: true, panelSessions: { s1: { open: false, tabs: [] } } });
    const { container } = render(<PanelHarness prefs={prefs} host={minimalHost()} />);

    fireEvent.keyDown(window, { key: "b", ctrlKey: true });
    await waitFor(() =>
      expect(container.querySelector<HTMLElement>(".side-panel")?.hidden).toBe(false),
    );
    fireEvent.keyDown(window, { key: "p", ctrlKey: true });
    expect(await screen.findByRole("combobox", { name: "搜索文件" })).toBeTruthy();
  });

  it("macOS 用 Cmd+B / Cmd+P 触发面板快捷键，Ctrl+B / Ctrl+P 不触发", async () => {
    setPlatformForTest("macos");
    const prefs = createPrefsStore(memoryStorage());
    prefs.update({ panelSessionsMigrated: true, panelSessions: { s1: { open: false, tabs: [] } } });
    const { container } = render(<PanelHarness prefs={prefs} host={minimalHost()} />);

    fireEvent.keyDown(window, { key: "b", ctrlKey: true });
    expect(container.querySelector<HTMLElement>(".side-panel")?.hidden).toBe(true);
    fireEvent.keyDown(window, { key: "p", ctrlKey: true });
    expect(screen.queryByRole("combobox", { name: "搜索文件" })).toBeNull();

    fireEvent.keyDown(window, { key: "b", metaKey: true });
    await waitFor(() =>
      expect(container.querySelector<HTMLElement>(".side-panel")?.hidden).toBe(false),
    );
    fireEvent.keyDown(window, { key: "p", metaKey: true });
    expect(await screen.findByRole("combobox", { name: "搜索文件" })).toBeTruthy();
  });

  it("SidePanel <Kbd> 在 Windows 显示 Ctrl 组合，在 macOS 显示 ⌘ ⇧ 符号", () => {
    const baseProps = {
      width: 480,
      overlay: false,
      tabs: [{ id: "new", kind: "new" as const }],
      activeId: "new",
      canOpenFiles: true,
      changes: {
        workspace: "/repo",
        turns: new Map(),
        userSeqs: [],
        loadDiff: vi.fn(),
      },
      onActivate: vi.fn(),
      onCloseTab: vi.fn(),
      onMoveTab: vi.fn(),
      onNewTab: vi.fn(),
      onResize: vi.fn(),
      onOpenChanges: vi.fn(),
      onQuickOpen: vi.fn(),
      onOpenTerminal: vi.fn(),
      onAddress: vi.fn(async () => undefined),
      readFile: vi.fn(),
      readerKey: "1",
      fileActions: {
        listApps: vi.fn(async () => ({
          apps: [],
          launchesCode: false,
          failed: true,
          editorIcons: {},
        })),
        openWithApp: vi.fn(async () => undefined),
        openDefault: vi.fn(async () => undefined),
        editors: { vscode: false, cursor: false },
        openInEditor: vi.fn(async () => undefined),
        reveal: vi.fn(async () => undefined),
        copy: vi.fn(async () => undefined),
        openInBrowser: vi.fn(async () => undefined),
        browserLabel: "在浏览器打开",
        openExternal: vi.fn(async () => undefined),
      },
      terminals: {
        open: vi.fn(),
        write: vi.fn(),
        resize: vi.fn(),
        close: vi.fn(),
        readClipboard: vi.fn(),
        writeClipboard: vi.fn(),
      },
      onShellChange: vi.fn(),
      loadShells: vi.fn(async () => ({ shells: [], setting: undefined })),
    };

    setPlatformForTest("other");
    const win = render(<SidePanel {...baseProps} />);
    expect(win.container.textContent).toContain("Ctrl+Shift+G");
    expect(win.container.textContent).toContain("Ctrl+P");
    expect(win.container.textContent).toContain("Ctrl+`");
    win.unmount();

    setPlatformForTest("macos");
    const mac = render(<SidePanel {...baseProps} />);
    expect(mac.container.textContent).toContain("⇧⌘G");
    expect(mac.container.textContent).toContain("⌘P");
    expect(mac.container.textContent).toContain("⌘`");
  });
});

describe("Sidebar 多选点击与不可用设置项隐藏", () => {
  it("Windows 用 Ctrl+点击多选，设置导航包含「电脑操控」", () => {
    setPlatformForTest("other");
    const onSelectSession = vi.fn();
    render(<Sidebar {...sidebarProps({ onSelectSession })} />);
    fireEvent.click(screen.getByText("会话一"), { ctrlKey: true });
    expect(onSelectSession).not.toHaveBeenCalled();

    cleanup();
    render(<Sidebar {...sidebarProps({ page: "general" })} />);
    const nav = screen.getByRole("navigation", { name: "设置" });
    expect(within(nav).getByRole("button", { name: "电脑操控" })).toBeTruthy();
  });

  it("macOS 仅 Cmd+点击多选（Ctrl+点击留给系统），设置导航不出现「电脑操控」", () => {
    setPlatformForTest("macos");
    const onSelectSession = vi.fn();
    render(<Sidebar {...sidebarProps({ onSelectSession })} />);
    fireEvent.click(screen.getByText("会话一"), { ctrlKey: true });
    expect(onSelectSession).toHaveBeenCalledWith("s1");

    onSelectSession.mockClear();
    fireEvent.click(screen.getByText("会话二"), { metaKey: true });
    expect(onSelectSession).not.toHaveBeenCalled();

    cleanup();
    render(<Sidebar {...sidebarProps({ page: "general" })} />);
    const nav = screen.getByRole("navigation", { name: "设置" });
    expect(within(nav).queryByRole("button", { name: "电脑操控" })).toBeNull();
    expect(within(nav).getByRole("button", { name: "浏览器" })).toBeTruthy();
  });
});

describe("BrowserSettingsPage 在 macOS 隐藏 agent 浏览分组", () => {
  const agentHost: AgentBrowserHost = {
    watch: vi.fn(async () => ({ shellGeneration: 0, revision: 0, enabled: false, tabs: [] })),
    uiState: vi.fn(async () => undefined),
    presented: vi.fn(async () => undefined),
    control: vi.fn(async () => ({ revision: 0 })),
    dialog: vi.fn(async () => undefined),
    setEnabled: vi.fn(async (enabled: boolean) => ({ enabled, restartRequired: false })),
    status: vi.fn(async () => ({ enabled: false, restartRequired: false })),
  };

  it("macOS 不渲染 Agent 浏览器分组与 Agent 浏览数据行，保留我的浏览且不显示占用大小", async () => {
    setPlatformForTest("macos");
    const host: BrowsingDataHost = {
      sizes: vi.fn(async () => ({ user: 2048, agent: 4096 })),
      clear: vi.fn(async () => 0),
    };
    render(
      <BrowserSettingsPage
        prefs={createPrefsStore(memoryStorage())}
        agentBrowser={agentHost}
        browsingData={host}
        relaunch={vi.fn(async () => undefined)}
        version={1}
      />,
    );
    expect(screen.queryByRole("region", { name: "Agent 浏览器" })).toBeNull();
    const dataGroup = screen.getByRole("region", { name: "浏览数据" });
    expect(within(dataGroup).getByText("我的浏览")).toBeTruthy();
    expect(within(dataGroup).queryByText("Agent 浏览")).toBeNull();
    expect(dataGroup.querySelector(".val")).toBeNull();
    expect(dataGroup.textContent).not.toMatch(/\b\d+(?:\.\d+)?\s*(?:B|KB|MB|GB)\b/);
    expect(host.sizes).not.toHaveBeenCalled();

    fireEvent.click(within(dataGroup).getByRole("button", { name: "清除…" }));
    const dialog = screen.getByRole("alertdialog", { name: "清除我的浏览数据" });
    fireEvent.click(within(dialog).getByRole("button", { name: "清除" }));
    await waitFor(() => {
      expect(host.clear).toHaveBeenCalledWith("user");
    });
    expect(dataGroup.querySelector(".val")).toBeNull();
  });
});

describe("打开菜单与文件引用在 macOS 显示「访达」", () => {
  it("macOS「打开」菜单显示「在访达中显示」，不出现「资源管理器」", async () => {
    setPlatformForTest("macos");
    const reveal = vi.fn(async () => undefined);
    const actions: FileOpenActions = {
      listApps: vi.fn(async () => ({
        apps: [
          { id: "app-1", name: "Visual Studio Code", isDefault: true },
          { id: "app-2", name: "文本编辑", isDefault: false },
        ],
        launchesCode: false,
        failed: false,
        editorIcons: {},
      })),
      openWithApp: vi.fn(async () => undefined),
      openDefault: vi.fn(async () => undefined),
      editors: { vscode: true, cursor: false },
      openInEditor: vi.fn(async () => undefined),
      reveal,
      copy: vi.fn(async () => undefined),
      openInBrowser: vi.fn(async () => undefined),
      browserLabel: "在浏览器标签打开",
    };
    render(
      <FileOpenButton
        path="/Users/me/proj/src/a.ts"
        line={12}
        missing={false}
        html={false}
        relativePath="src/a.ts"
        onSaveAs={vi.fn()}
        wrap={true}
        onWrap={vi.fn()}
        actions={actions}
        onError={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "打开方式" }));
    const menu = await screen.findByRole("menu", { name: "打开方式" });
    expect(within(menu).getByRole("menuitem", { name: "在访达中显示" })).toBeTruthy();
    expect(menu.textContent).toContain("访达");
    expect(menu.textContent).not.toContain("资源管理器");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "在访达中显示" }));
    await waitFor(() => {
      expect(reveal).toHaveBeenCalledWith("/Users/me/proj/src/a.ts");
    });
  });

  it("macOS 对话内文件引用右键菜单显示「访达」，不出现「资源管理器」", async () => {
    setPlatformForTest("macos");
    const view = createSessionView();
    view.entries = [
      {
        kind: "assistant",
        key: "assistant-1",
        seq: 1,
        turnId: "turn-1",
        messageId: "message-1",
        time: "2026-11-22T02:00:00.000Z",
        text: "看 `src/a.ts:12`",
        reasoning: "",
        toolCalls: [],
        model: { provider: "test", model: "model" },
        usage: undefined,
        finishReason: "stop",
      },
    ];
    const session = {
      id: "s-file-ref",
      readAttachment: vi.fn(),
      respondPermission: vi.fn(),
      respondSubagentPermission: vi.fn(),
      respondQuestion: vi.fn(),
      resolveFiles: vi.fn(async (paths: string[]) =>
        paths.map((input) => ({
          input,
          exists: true,
          withinWorkspace: true,
          isDirectory: false,
          absolutePath: `/Users/me/proj/${input}`,
        })),
      ),
    } as unknown as RpcSession;
    const reveal = vi.fn(async () => undefined);
    render(
      <Conversation
        view={view}
        session={session}
        cwd="/Users/me/proj"
        busy={false}
        images={createAttachmentImageSource()}
        subscribeEvents={() => () => undefined}
        openUrl={vi.fn()}
        fileLinks={{
          open: vi.fn(async () => undefined),
          outsideOpenable: () => true,
          editors: () => ({ vscode: true, cursor: false }),
          openInEditor: vi.fn(async () => undefined),
          openFolder: vi.fn(async () => undefined),
          copy: vi.fn(async () => undefined),
          reveal,
        }}
      />,
    );
    const link = await screen.findByRole("button", { name: "src/a.ts:12" });
    fireEvent.contextMenu(link);
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: "访达" })).toBeTruthy();
    expect(menu.textContent).not.toContain("资源管理器");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "访达" }));
    await waitFor(() => {
      expect(reveal).toHaveBeenCalledWith("/Users/me/proj/src/a.ts");
    });
  });
});

describe("TerminalPane macOS 登录 shell 与 terminal-view copy/copy-keep", () => {
  it("terminalShells 在 macOS 放行 zsh/bash/sh/fish，mergeMacLoginShell 将登录 shell 置首去重", () => {
    const raw = [
      { kind: "bash", name: "Bash", executable: "/bin/bash", available: true },
      { kind: "sh", name: "sh", executable: "/bin/sh", available: true },
      { kind: "fish", name: "fish", executable: "/opt/homebrew/bin/fish", available: true },
      { kind: "other", name: "python", executable: "/usr/bin/python3", available: true },
    ];
    expect(terminalShells(raw, false).map((s) => s.kind)).toEqual(["bash"]);
    expect(terminalShells(raw, true).map((s) => s.kind)).toEqual(["bash", "sh", "fish"]);

    const withZsh = mergeMacLoginShell(terminalShells(raw, true), "/bin/zsh");
    expect(withZsh.map((s) => s.executable)).toEqual([
      "/bin/zsh",
      "/bin/bash",
      "/bin/sh",
      "/opt/homebrew/bin/fish",
    ]);

    const withFish = mergeMacLoginShell(terminalShells(raw, true), "/opt/homebrew/bin/fish");
    expect(withFish.map((s) => s.executable)).toEqual([
      "/opt/homebrew/bin/fish",
      "/bin/bash",
      "/bin/sh",
    ]);
  });

  it("TerminalPane 在 macOS 将登录 shell 作为第一项并默认启动", async () => {
    stubMatchMedia();
    setPlatformForTest("macos");
    const opened: string[] = [];
    const host: TerminalHost = {
      open: vi.fn(async ({ shell }) => {
        opened.push(shell);
        return 1;
      }),
      write: vi.fn(async () => undefined),
      resize: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      readClipboard: vi.fn(async () => ""),
      writeClipboard: vi.fn(async () => undefined),
      loginShell: vi.fn(async () => "/bin/zsh"),
    };
    render(
      <TerminalPane
        tab={{ id: "t1", kind: "terminal", cwd: "/repo", label: "repo" }}
        host={host}
        loadShells={vi.fn(async () => ({
          shells: [
            { kind: "bash", name: "Bash", executable: "/bin/bash", available: true },
            { kind: "sh", name: "sh", executable: "/bin/sh", available: true },
          ],
          setting: "auto",
        }))}
        visible
        onShellChange={vi.fn()}
      />,
    );
    await waitFor(() => expect(opened).toEqual(["/bin/zsh"]));
  });

  it("TerminalPane 在 macOS 无可用 shell 时提示 zsh/bash/sh/fish，不含 Windows", async () => {
    stubMatchMedia();
    setPlatformForTest("macos");
    const host: TerminalHost = {
      open: vi.fn(async () => 1),
      write: vi.fn(async () => undefined),
      resize: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      readClipboard: vi.fn(async () => ""),
      writeClipboard: vi.fn(async () => undefined),
      loginShell: vi.fn(async () => null),
    };
    render(
      <TerminalPane
        tab={{ id: "t-empty", kind: "terminal", cwd: "/repo", label: "repo" }}
        host={host}
        loadShells={vi.fn(async () => ({ shells: [], setting: "auto" }))}
        visible
        onShellChange={vi.fn()}
      />,
    );
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("没有找到可用的 shell（zsh、bash、sh、fish）");
    expect(alert.textContent).not.toContain("Windows");
  });

  it("terminal-view 按 copy / copy-keep 动作决定是否清选区（不再直接看 ctrlKey）", async () => {
    stubMatchMedia();
    const { mountTerminal } = await import("../src/terminal-view");
    const onCopy = vi.fn();
    const div = document.createElement("div");
    document.body.appendChild(div);
    mountTerminal(div, { onData: vi.fn(), onResize: vi.fn(), onCopy });
    const handler = xtermHandlers.at(-1);
    expect(handler).toBeDefined();
    if (handler === undefined) return;
    xtermHasSelection = true;

    // Windows: Ctrl+C -> copy -> clear=true；Ctrl+Shift+C -> copy-keep -> clear=false
    setPlatformForTest("other");
    handler(new KeyboardEvent("keydown", { key: "c", ctrlKey: true }));
    handler(new KeyboardEvent("keydown", { key: "C", ctrlKey: true, shiftKey: true }));

    // macOS: Cmd+C -> copy -> clear=true
    setPlatformForTest("macos");
    handler(new KeyboardEvent("keydown", { key: "c", metaKey: true }));

    expect(onCopy.mock.calls).toEqual([[true], [false], [true]]);
    div.remove();
  });
});

describe("SettingsPage macOS 测试通知被拒提示", () => {
  it("macOS 发送测试通知返回 disabled 时提示系统设置 › 通知，不含 Windows", async () => {
    setPlatformForTest("macos");
    const items: SettingItem[] = [
      {
        key: "notifications.enabled",
        effective: "true",
        source: "default",
        saved: undefined,
        overridden: false,
      },
      {
        key: "notifications.doneAfterSeconds",
        effective: "30",
        source: "default",
        saved: undefined,
        overridden: false,
      },
      {
        key: "notifications.sound",
        effective: "true",
        source: "default",
        saved: undefined,
        overridden: false,
      },
    ];
    const server = fakeServer(
      withInit({
        "runtime.describeSettings": items,
        "runtime.listModels": [],
        "runtime.listReviewerProviders": [],
        "runtime.getPreference": null,
        "runtime.listShells": [],
      }),
    );
    try {
      await server.initialize();
      const sendTest = vi.fn(() => Promise.resolve({ shown: false, reason: "disabled" as const }));
      render(
        <SettingsPage
          section="general"
          client={server.client}
          theme="system"
          workspace="/Users/me/Nocturne"
          defaultWorkspace="/Users/me/Nocturne"
          workspaceOverridden={false}
          onThemeChange={() => true}
          fileOpener="panel"
          editors={{ vscode: false, cursor: false }}
          onFileOpenerChange={() => true}
          onWorkspaceChange={() => Promise.resolve(undefined)}
          pickFolder={() => Promise.resolve(null)}
          providersVersion={0}
          notifications={{ sendTest }}
        />,
      );
      const btn = await screen.findByRole("button", { name: "发送测试通知" });
      fireEvent.click(btn);
      const warning = await screen.findByText(
        "macOS 已关闭 Nocturne 的通知，请到 系统设置 › 通知 打开",
      );
      expect(warning.textContent).not.toContain("Windows");
      expect(sendTest).toHaveBeenCalledTimes(1);
    } finally {
      server.close();
    }
  });
});
