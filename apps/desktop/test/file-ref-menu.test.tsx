/**
 * Windows 桌面端会话正文文件引用右键菜单专项测试（ADR-0124）：
 * 五项顺序、相对/绝对路径复制、打开与定位分派（含目录/HTML/面板/系统默认/编辑器带行号）、
 * 二级菜单推荐数 0/1/3/4+、过期异步查询隔离、取消原生选择器、受保护扩展名、工作区外边界、
 * 键盘操作、悬停跨菜单、边缘定位以及不改 Nocturne 默认偏好。
 */
import { createSessionView, type AssistantEntry } from "@nocturne/core/protocol";
import type { RpcSession } from "@nocturne/rpc/client";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAttachmentImageSource } from "../src/attachment-images";
import { Conversation, type FileLinkHooks } from "../src/Conversation";
import {
  buildOpenWithEntries,
  createFileLinkHooks,
  type FileRefPanelController,
} from "../src/FileRefMenu";
import type { DesktopHost, FileApp, FileAppList } from "../src/host";
import {
  formatShortcut,
  hasPrimaryMod,
  hasPrimaryModOrMetaOnOther,
  isMacOS,
  isWindows,
  setPlatformForTest,
} from "../src/platform";
import { createPrefsStore, type FileOpener } from "../src/prefs";
import { createTauriHost } from "../src/tauri-host";

const ICON = "data:image/png;base64,iVBORw0KGgo=";

function app(id: string, name: string, extra: Partial<FileApp> = {}): FileApp {
  return { id, name, isDefault: false, ...extra };
}

function appList(overrides: Partial<FileAppList> = {}): FileAppList {
  return { apps: [], launchesCode: false, failed: false, editorIcons: {}, ...overrides };
}

function assistant(text: string): AssistantEntry {
  return {
    kind: "assistant",
    key: "assistant-1",
    seq: 1,
    turnId: "turn-1",
    messageId: "msg-1",
    time: "2026-11-26T04:00:00.000Z",
    text,
    reasoning: "",
    toolCalls: [],
    model: { provider: "test", model: "model" },
    usage: undefined,
    finishReason: "stop",
  };
}

interface ResolveEntry {
  input: string;
  absolutePath: string;
  relativePath?: string | undefined;
  withinWorkspace: boolean;
  exists: boolean;
  isDirectory: boolean;
}

function makeHooks(overrides: Partial<FileLinkHooks> = {}) {
  return {
    open: vi.fn(async () => undefined),
    outsideOpenable: vi.fn(() => false),
    editors: vi.fn(() => ({ vscode: true, cursor: false })),
    openInEditor: vi.fn(async () => undefined),
    openFolder: vi.fn(async () => undefined),
    copy: vi.fn(async () => undefined),
    reveal: vi.fn(async () => undefined),
    previewsHtml: vi.fn(() => false),
    viewSource: vi.fn(async () => undefined),
    listFileApps: vi.fn(async () => appList()),
    openFileWithApp: vi.fn(async () => undefined),
    openFileWithDialog: vi.fn(async () => undefined),
    ...overrides,
  };
}

function mountConversation(
  text: string,
  fileLinks: FileLinkHooks,
  resolveFiles: (paths: string[]) => Promise<ResolveEntry[]>,
) {
  const view = createSessionView();
  view.entries = [assistant(text)];
  const session = {
    id: "s-win-file-ref",
    readAttachment: vi.fn(),
    respondPermission: vi.fn(),
    respondSubagentPermission: vi.fn(),
    respondQuestion: vi.fn(),
    resolveFiles: vi.fn(resolveFiles),
  } as unknown as RpcSession;
  return render(
    <Conversation
      view={view}
      session={session}
      cwd="Z:\\project"
      busy={false}
      images={createAttachmentImageSource()}
      subscribeEvents={() => () => undefined}
      openUrl={vi.fn()}
      fileLinks={fileLinks}
    />,
  );
}

/** 仅返回直接归属指定 menu 的 menuitem 标签（排除嵌套子菜单项） */
function directItemLabels(menu: HTMLElement): string[] {
  return [...menu.querySelectorAll<HTMLElement>('[role^="menuitem"]')]
    .filter((item) => item.closest('[role="menu"]') === menu)
    .map((item) => item.textContent ?? "");
}

/** 仅返回直接归属指定 menu 的分隔线数量 */
function directSeparators(menu: HTMLElement): HTMLElement[] {
  return [...menu.querySelectorAll<HTMLElement>("hr.menu-sep")].filter(
    (sep) => sep.closest('[role="menu"]') === menu,
  );
}

beforeEach(() => {
  setPlatformForTest("windows");
});

afterEach(() => {
  cleanup();
  setPlatformForTest(null);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Windows 会话文件引用右键菜单（ADR-0124）", () => {
  it("普通工作区文件：严格五项顺序 + 分隔线，复制相对路径与绝对路径值准确", async () => {
    const hooks = makeHooks({
      listFileApps: vi.fn(async () =>
        appList({ apps: [app("app-notepad", "记事本", { isDefault: true, iconDataUrl: ICON })] }),
      ),
    });
    mountConversation("查看 `src/demo.ts:18-24`", hooks, async (paths) =>
      paths.map((input) => ({
        input,
        absolutePath: "Z:\\project\\src\\demo.ts",
        relativePath: "src\\demo.ts",
        withinWorkspace: true,
        exists: true,
        isDirectory: false,
      })),
    );
    const link = await screen.findByRole("button", { name: "src/demo.ts:18-24" });
    fireEvent.contextMenu(link);
    const menu = await screen.findByRole("menu", { name: "src/demo.ts:18-24" });

    expect(directItemLabels(menu)).toEqual([
      "打开",
      "打开方式",
      "在资源管理器中显示",
      "复制相对路径",
      "复制绝对路径",
    ]);
    expect(directSeparators(menu)).toHaveLength(1);
    // 分隔线位于「在资源管理器中显示」与「复制相对路径」之间
    const children = [...menu.children];
    const sepIdx = children.findIndex((el) => el.tagName === "HR");
    expect(children[sepIdx - 1]?.textContent).toBe("在资源管理器中显示");
    expect(children[sepIdx + 1]?.textContent).toBe("复制相对路径");

    // 「打开」复用左键设置分派并保留行号范围
    fireEvent.click(within(menu).getByRole("menuitem", { name: "打开" }));
    expect(hooks.open).toHaveBeenCalledWith("Z:\\project\\src\\demo.ts", 18, { endLine: 24 });
    expect(hooks.reveal).not.toHaveBeenCalled();

    // 「在资源管理器中显示」调用 reveal
    fireEvent.contextMenu(link);
    fireEvent.click(
      within(await screen.findByRole("menu")).getByRole("menuitem", { name: "在资源管理器中显示" }),
    );
    expect(hooks.reveal).toHaveBeenCalledWith("Z:\\project\\src\\demo.ts");

    // 「复制相对路径」与「复制绝对路径」分别复制对应值
    fireEvent.contextMenu(link);
    fireEvent.click(
      within(await screen.findByRole("menu")).getByRole("menuitem", { name: "复制相对路径" }),
    );
    expect(hooks.copy).toHaveBeenCalledWith("src\\demo.ts");

    fireEvent.contextMenu(link);
    fireEvent.click(
      within(await screen.findByRole("menu")).getByRole("menuitem", { name: "复制绝对路径" }),
    );
    expect(hooks.copy).toHaveBeenCalledWith("Z:\\project\\src\\demo.ts");
  });

  it("没有工作区相对路径时仅提供「复制绝对路径」", async () => {
    const hooks = makeHooks();
    mountConversation("查看 `src/no-rel.txt`", hooks, async (paths) =>
      paths.map((input) => ({
        input,
        absolutePath: "Z:\\project\\src\\no-rel.txt",
        relativePath: undefined,
        withinWorkspace: true,
        exists: true,
        isDirectory: false,
      })),
    );
    fireEvent.contextMenu(await screen.findByRole("button", { name: "src/no-rel.txt" }));
    const menu = await screen.findByRole("menu");
    expect(directItemLabels(menu)).toEqual([
      "打开",
      "打开方式",
      "在资源管理器中显示",
      "复制绝对路径",
    ]);
  });

  it("工作区内 HTML：采用相同五项顺序（不增「查看源码」），「打开」复用预览分派", async () => {
    const hooks = makeHooks({
      previewsHtml: vi.fn(() => true),
      listFileApps: vi.fn(async () =>
        appList({ apps: [app("app-edge", "Microsoft Edge", { isDefault: true })] }),
      ),
    });
    mountConversation("打开 `dist/preview.html`", hooks, async (paths) =>
      paths.map((input) => ({
        input,
        absolutePath: "Z:\\project\\dist\\preview.html",
        relativePath: "dist\\preview.html",
        withinWorkspace: true,
        exists: true,
        isDirectory: false,
      })),
    );
    const link = await screen.findByRole("button", { name: "dist/preview.html" });
    fireEvent.contextMenu(link);
    const menu = await screen.findByRole("menu");
    expect(directItemLabels(menu)).toEqual([
      "打开",
      "打开方式",
      "在资源管理器中显示",
      "复制相对路径",
      "复制绝对路径",
    ]);
    expect(within(menu).queryByRole("menuitem", { name: "查看源码" })).toBeNull();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "打开" }));
    expect(hooks.open).toHaveBeenCalledWith("Z:\\project\\dist\\preview.html", undefined, {
      endLine: undefined,
    });
  });

  it.each([
    {
      name: "0 个推荐应用：仅显示「更多打开方式…」且无多余分隔线",
      apps: [],
      expected: ["更多打开方式…"],
      sepCount: 0,
    },
    {
      name: "1 个推荐应用：1 项 + 分隔线 + 「更多打开方式…」",
      apps: [app("app-1", "记事本", { isDefault: true, iconDataUrl: ICON })],
      expected: ["记事本", "更多打开方式…"],
      sepCount: 1,
    },
    {
      name: "3 个推荐应用：保持返回顺序 + 分隔线 + 「更多打开方式…」",
      apps: [
        app("app-1", "Visual Studio Code", { isDefault: true }),
        app("app-2", "记事本"),
        app("app-3", "写字板"),
      ],
      expected: ["Visual Studio Code", "记事本", "写字板", "更多打开方式…"],
      sepCount: 1,
    },
    {
      name: "4 个以上推荐应用：按返回顺序只取前 3 个 + 分隔线 + 「更多打开方式…」",
      apps: [
        app("app-1", "App One", { isDefault: true }),
        app("app-2", "App Two"),
        app("app-3", "App Three"),
        app("app-4", "App Four"),
        app("app-5", "App Five"),
      ],
      expected: ["App One", "App Two", "App Three", "更多打开方式…"],
      sepCount: 1,
    },
  ])("二级菜单推荐数：$name", async ({ apps, expected, sepCount }) => {
    const hooks = makeHooks({
      listFileApps: vi.fn(async () => appList({ apps })),
    });
    mountConversation("看 `notes/a.txt:7`", hooks, async (paths) =>
      paths.map((input) => ({
        input,
        absolutePath: "Z:\\project\\notes\\a.txt",
        relativePath: "notes\\a.txt",
        withinWorkspace: true,
        exists: true,
        isDirectory: false,
      })),
    );
    fireEvent.contextMenu(await screen.findByRole("button", { name: "notes/a.txt:7" }));
    const menu = await screen.findByRole("menu");
    fireEvent.keyDown(within(menu).getByRole("menuitem", { name: "打开方式" }), {
      key: "ArrowRight",
    });
    const sub = await screen.findByRole("menu", { name: "打开方式" });
    expect(directItemLabels(sub)).toEqual(expected);
    expect(directSeparators(sub)).toHaveLength(sepCount);

    if (apps[0] !== undefined) {
      fireEvent.click(within(sub).getByRole("menuitem", { name: apps[0].name }));
      expect(hooks.openFileWithApp).toHaveBeenCalledWith(
        "Z:\\project\\notes\\a.txt",
        apps[0].id,
        7,
      );
    } else {
      fireEvent.click(within(sub).getByRole("menuitem", { name: "更多打开方式…" }));
      expect(hooks.openFileWithDialog).toHaveBeenCalledWith("Z:\\project\\notes\\a.txt");
    }
  });

  it("过期查询：慢查询 A 晚于新菜单 B 返回时，不把 A 的应用显示在 B 的菜单里", async () => {
    let resolveA!: (value: FileAppList) => void;
    let resolveB!: (value: FileAppList) => void;
    const listFileApps = vi.fn((path: string) => {
      if (path.endsWith("a.txt")) {
        return new Promise<FileAppList>((resolve) => {
          resolveA = resolve;
        });
      }
      return new Promise<FileAppList>((resolve) => {
        resolveB = resolve;
      });
    });
    const hooks = makeHooks({ listFileApps });
    mountConversation("对比 `a.txt` 和 `b.txt`", hooks, async (paths) =>
      paths.map((input) => ({
        input,
        absolutePath: `Z:\\project\\${input}`,
        relativePath: input,
        withinWorkspace: true,
        exists: true,
        isDirectory: false,
      })),
    );
    const linkA = await screen.findByRole("button", { name: "a.txt" });
    const linkB = await screen.findByRole("button", { name: "b.txt" });

    // 先右键 A（查询挂起），未返回前立刻右键 B（旧菜单自动关闭）
    fireEvent.contextMenu(linkA);
    expect(listFileApps).toHaveBeenCalledWith("Z:\\project\\a.txt");
    fireEvent.contextMenu(linkB);
    expect(listFileApps).toHaveBeenCalledWith("Z:\\project\\b.txt");

    // 仅有一个一级菜单（B 的菜单）
    const menus = screen.getAllByRole("menu");
    expect(menus).toHaveLength(1);
    const menuB = menus[0];
    if (menuB === undefined) throw new Error("expected menu B");
    expect(menuB.getAttribute("aria-label")).toBe("b.txt");

    // 尝试展开 B 的「打开方式」，此时 B 仍在等待，A 此时晚到返回
    fireEvent.keyDown(within(menuB).getByRole("menuitem", { name: "打开方式" }), {
      key: "ArrowRight",
    });
    resolveA(appList({ apps: [app("app-only-a", "OnlyForA")] }));
    // 给微任务落盘机会，确认 B 的二级菜单仍未渲染 OnlyForA
    await Promise.resolve();
    expect(screen.queryByRole("menuitem", { name: "OnlyForA" })).toBeNull();

    // B 到达后，二级菜单只展示 B 的推荐应用
    resolveB(appList({ apps: [app("app-only-b", "OnlyForB")] }));
    const subB = await screen.findByRole("menu", { name: "打开方式" });
    expect(directItemLabels(subB)).toEqual(["OnlyForB", "更多打开方式…"]);
    expect(within(subB).queryByRole("menuitem", { name: "OnlyForA" })).toBeNull();
  });

  it("取消原生选择器：菜单正常收起且不显示错误提示", async () => {
    const hooks = makeHooks({
      listFileApps: vi.fn(async () => appList({ apps: [] })),
      openFileWithDialog: vi.fn(async () => undefined),
    });
    mountConversation("查看 `doc/spec.txt`", hooks, async (paths) =>
      paths.map((input) => ({
        input,
        absolutePath: "Z:\\project\\doc\\spec.txt",
        relativePath: "doc\\spec.txt",
        withinWorkspace: true,
        exists: true,
        isDirectory: false,
      })),
    );
    fireEvent.contextMenu(await screen.findByRole("button", { name: "doc/spec.txt" }));
    const menu = await screen.findByRole("menu");
    fireEvent.keyDown(within(menu).getByRole("menuitem", { name: "打开方式" }), {
      key: "ArrowRight",
    });
    const sub = await screen.findByRole("menu", { name: "打开方式" });
    fireEvent.click(within(sub).getByRole("menuitem", { name: "更多打开方式…" }));

    await waitFor(() => {
      expect(hooks.openFileWithDialog).toHaveBeenCalledWith("Z:\\project\\doc\\spec.txt");
    });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("目录：「打开」进入目录、「在资源管理器中显示」选中目录，省略「打开方式」且不查询系统应用", async () => {
    const hooks = makeHooks();
    mountConversation("目录 `packages/core`", hooks, async (paths) =>
      paths.map((input) => ({
        input,
        absolutePath: "Z:\\project\\packages\\core",
        relativePath: "packages\\core",
        withinWorkspace: true,
        exists: true,
        isDirectory: true,
      })),
    );
    const link = await screen.findByRole("button", { name: "packages/core" });
    fireEvent.contextMenu(link);
    const menu = await screen.findByRole("menu");
    expect(directItemLabels(menu)).toEqual([
      "打开",
      "在资源管理器中显示",
      "复制相对路径",
      "复制绝对路径",
    ]);
    expect(within(menu).queryByRole("menuitem", { name: "打开方式" })).toBeNull();
    expect(hooks.listFileApps).not.toHaveBeenCalled();

    fireEvent.click(within(menu).getByRole("menuitem", { name: "打开" }));
    expect(hooks.openFolder).toHaveBeenCalledWith("Z:\\project\\packages\\core");
    expect(hooks.open).not.toHaveBeenCalled();

    fireEvent.contextMenu(link);
    fireEvent.click(
      within(await screen.findByRole("menu")).getByRole("menuitem", { name: "在资源管理器中显示" }),
    );
    expect(hooks.reveal).toHaveBeenCalledWith("Z:\\project\\packages\\core");
  });

  it("工作区外文件：保留现有打开边界，不列「打开方式」且不查询系统应用", async () => {
    // 面板/编辑器模式：允许「打开」，但不给「打开方式」和「复制相对路径」
    const openableHooks = makeHooks({ outsideOpenable: vi.fn(() => true) });
    mountConversation("外部文件 `D:\\outside\\notes.md:4`", openableHooks, async (paths) =>
      paths.map((input) => ({
        input,
        absolutePath: "D:\\outside\\notes.md",
        relativePath: undefined,
        withinWorkspace: false,
        exists: true,
        isDirectory: false,
      })),
    );
    fireEvent.contextMenu(await screen.findByRole("button", { name: "D:\\outside\\notes.md:4" }));
    const openableMenu = await screen.findByRole("menu");
    expect(directItemLabels(openableMenu)).toEqual(["打开", "在资源管理器中显示", "复制绝对路径"]);
    expect(openableHooks.listFileApps).not.toHaveBeenCalled();

    cleanup();

    // 系统默认模式：不给「打开」「打开方式」「复制相对路径」，左键与右键均只开菜单
    const lockedHooks = makeHooks({ outsideOpenable: vi.fn(() => false) });
    mountConversation("系统文件 `C:\\Windows\\notepad.exe`", lockedHooks, async (paths) =>
      paths.map((input) => ({
        input,
        absolutePath: "C:\\Windows\\notepad.exe",
        relativePath: undefined,
        withinWorkspace: false,
        exists: true,
        isDirectory: false,
      })),
    );
    fireEvent.click(await screen.findByRole("button", { name: "C:\\Windows\\notepad.exe" }));
    const lockedMenu = await screen.findByRole("menu");
    expect(directItemLabels(lockedMenu)).toEqual(["在资源管理器中显示", "复制绝对路径"]);
    expect(lockedHooks.listFileApps).not.toHaveBeenCalled();
  });

  it("受保护扩展名（launchesCode）：有安全编辑器时仅列安全编辑器，无原生选择器；无编辑器时省略「打开方式」", async () => {
    // 有 VS Code：二级菜单只有 VS Code，不含「更多打开方式…」
    const hooksWithEditor = makeHooks({
      editors: vi.fn(() => ({ vscode: true, cursor: false })),
      listFileApps: vi.fn(async () =>
        appList({ apps: [], launchesCode: true, editorIcons: { vscode: ICON } }),
      ),
    });
    mountConversation("脚本 `scripts/deploy.ps1:9`", hooksWithEditor, async (paths) =>
      paths.map((input) => ({
        input,
        absolutePath: "Z:\\project\\scripts\\deploy.ps1",
        relativePath: "scripts\\deploy.ps1",
        withinWorkspace: true,
        exists: true,
        isDirectory: false,
      })),
    );
    fireEvent.contextMenu(await screen.findByRole("button", { name: "scripts/deploy.ps1:9" }));
    const menu1 = await screen.findByRole("menu");
    fireEvent.keyDown(within(menu1).getByRole("menuitem", { name: "打开方式" }), {
      key: "ArrowRight",
    });
    const sub1 = await screen.findByRole("menu", { name: "打开方式" });
    expect(directItemLabels(sub1)).toEqual(["VS Code"]);
    expect(within(sub1).queryByRole("menuitem", { name: "更多打开方式…" })).toBeNull();
    fireEvent.click(within(sub1).getByRole("menuitem", { name: "VS Code" }));
    expect(hooksWithEditor.openInEditor).toHaveBeenCalledWith(
      "vscode",
      "Z:\\project\\scripts\\deploy.ps1",
      9,
    );

    cleanup();

    // 无安全编辑器：收起/省略「打开方式」
    const hooksNoEditor = makeHooks({
      editors: vi.fn(() => ({ vscode: false, cursor: false })),
      listFileApps: vi.fn(async () => appList({ apps: [], launchesCode: true })),
    });
    mountConversation("批处理 `scripts/run.bat`", hooksNoEditor, async (paths) =>
      paths.map((input) => ({
        input,
        absolutePath: "Z:\\project\\scripts\\run.bat",
        relativePath: "scripts\\run.bat",
        withinWorkspace: true,
        exists: true,
        isDirectory: false,
      })),
    );
    fireEvent.contextMenu(await screen.findByRole("button", { name: "scripts/run.bat" }));
    const menu2 = await screen.findByRole("menu");
    await waitFor(() => {
      expect(within(menu2).queryByRole("menuitem", { name: "打开方式" })).toBeNull();
    });
    expect(directItemLabels(menu2)).toEqual([
      "打开",
      "在资源管理器中显示",
      "复制相对路径",
      "复制绝对路径",
    ]);
  });

  it("键盘操作：方向键进入/返回、Enter 选择、Esc 逐级关闭、鼠标跨菜单与靠窗边缘定位", async () => {
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(800);
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(600);
    const hooks = makeHooks({
      listFileApps: vi.fn(async () =>
        appList({
          apps: [app("app-1", "记事本", { isDefault: true }), app("app-2", "Visual Studio Code")],
        }),
      ),
    });
    mountConversation("看 `src/keys.ts:5`", hooks, async (paths) =>
      paths.map((input) => ({
        input,
        absolutePath: "Z:\\project\\src\\keys.ts",
        relativePath: "src\\keys.ts",
        withinWorkspace: true,
        exists: true,
        isDirectory: false,
      })),
    );
    const link = await screen.findByRole("button", { name: "src/keys.ts:5" });
    fireEvent.contextMenu(link);
    const primary = await screen.findByRole("menu", { name: "src/keys.ts:5" });

    // 打开后默认聚焦「打开」，ArrowDown 到「打开方式」
    const openItem = within(primary).getByRole("menuitem", { name: "打开" });
    const openWithItem = within(primary).getByRole("menuitem", { name: "打开方式" });
    expect(document.activeElement).toBe(openItem);
    fireEvent.keyDown(openItem, { key: "ArrowDown" });
    expect(document.activeElement).toBe(openWithItem);

    // 模拟靠右边缘定位：二级菜单向左翻折，纵向不超出视口
    vi.spyOn(openWithItem, "getBoundingClientRect").mockReturnValue({
      left: 580,
      right: 780,
      top: 520,
      bottom: 552,
      width: 200,
      height: 32,
      x: 580,
      y: 520,
      toJSON: () => ({}),
    });

    // ArrowRight 进入二级菜单并聚焦首项
    fireEvent.keyDown(openWithItem, { key: "ArrowRight" });
    const sub = await screen.findByRole("menu", { name: "打开方式" });
    const firstApp = within(sub).getByRole("menuitem", { name: "记事本" });
    expect(document.activeElement).toBe(firstApp);
    // 右侧放不下（780+8+240 > 792），向左翻折到 580 - 240 - 8 = 332px
    expect(Number.parseInt(sub.style.left, 10)).toBeLessThan(580);
    expect(Number.parseInt(sub.style.top, 10)).toBeGreaterThanOrEqual(8);

    // ArrowLeft 返回一级菜单并聚焦「打开方式」
    fireEvent.keyDown(firstApp, { key: "ArrowLeft" });
    expect(screen.queryByRole("menu", { name: "打开方式" })).toBeNull();
    expect(document.activeElement).toBe(openWithItem);

    // 再次进入后，Esc 逐级关闭：第一次只关二级菜单，第二次关一级菜单并焦点回文件引用
    fireEvent.keyDown(openWithItem, { key: "ArrowRight" });
    const sub2 = await screen.findByRole("menu", { name: "打开方式" });
    fireEvent.keyDown(within(sub2).getByRole("menuitem", { name: "记事本" }), { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "打开方式" })).toBeNull();
    expect(screen.getByRole("menu", { name: "src/keys.ts:5" })).toBeTruthy();
    expect(document.activeElement).toBe(openWithItem);
    fireEvent.keyDown(openWithItem, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(link);

    // 悬停打开二级菜单 + 鼠标跨菜单 + ArrowDown + Enter 激活
    fireEvent.contextMenu(link);
    const primary2 = await screen.findByRole("menu", { name: "src/keys.ts:5" });
    const trigger2 = within(primary2).getByRole("menuitem", { name: "打开方式" });
    fireEvent.pointerMove(trigger2);
    const sub3 = await screen.findByRole("menu", { name: "打开方式" });
    const entryBox = trigger2.closest(".menu-submenu-entry");
    if (entryBox === null) throw new Error("expected submenu entry box");
    vi.useFakeTimers();
    fireEvent.pointerLeave(entryBox);
    // 跨过间隙在 220ms 宽限内进入子菜单，菜单保持展开
    vi.advanceTimersByTime(100);
    fireEvent.pointerEnter(entryBox);
    vi.advanceTimersByTime(200);
    expect(screen.getByRole("menu", { name: "打开方式" })).toBeTruthy();
    vi.useRealTimers();

    const first = within(sub3).getByRole("menuitem", { name: "记事本" });
    const second = within(sub3).getByRole("menuitem", { name: "Visual Studio Code" });
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(document.activeElement).toBe(second);
    fireEvent.click(second);
    expect(hooks.openFileWithApp).toHaveBeenCalledWith("Z:\\project\\src\\keys.ts", "app-2", 5);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("macOS 平台保持原有菜单行为（显示「访达」、HTML「查看源码」、平铺编辑器）", async () => {
    setPlatformForTest("macos");
    const hooks = makeHooks({
      previewsHtml: vi.fn(() => true),
      editors: vi.fn(() => ({ vscode: true, cursor: false })),
    });
    mountConversation("查看 `web/index.html`", hooks, async (paths) =>
      paths.map((input) => ({
        input,
        absolutePath: "/Users/me/proj/web/index.html",
        relativePath: "web/index.html",
        withinWorkspace: true,
        exists: true,
        isDirectory: false,
      })),
    );
    fireEvent.contextMenu(await screen.findByRole("button", { name: "web/index.html" }));
    const menu = await screen.findByRole("menu");
    expect(directItemLabels(menu)).toEqual([
      "打开",
      "查看源码",
      "访达",
      "VS Code",
      "复制绝对路径",
      "复制相对路径",
    ]);
    expect(hooks.listFileApps).not.toHaveBeenCalled();
  });

  it("App fileLinks 分派：「打开」与左键共用设置（面板、系统默认、编辑器带行号、HTML 预览），选应用与原生选择器不改默认设置", async () => {
    const store = new Map<string, string>();
    const storage: Storage = {
      get length() {
        return store.size;
      },
      clear: () => {
        store.clear();
      },
      key: (index) => [...store.keys()][index] ?? null,
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => {
        store.set(key, value);
      },
      removeItem: (key) => {
        store.delete(key);
      },
    };
    const prefs = createPrefsStore(storage);
    const host = {
      openPath: vi.fn(async () => undefined),
      openInEditor: vi.fn(async () => undefined),
      revealItem: vi.fn(async () => undefined),
      fileApps: {
        list: vi.fn(async () =>
          appList({
            apps: [app("app-notepad", "记事本", { isDefault: true })],
          }),
        ),
        open: vi.fn(async () => undefined),
        openWithDialog: vi.fn(async () => undefined),
      },
    } as unknown as DesktopHost;
    const panel: FileRefPanelController = {
      openFile: vi.fn(),
      previewsHtml: vi.fn((p: string) => p.endsWith(".html")),
      viewSource: vi.fn(),
    };
    const fileLinks = createFileLinkHooks({
      host,
      prefs,
      editors: { vscode: true, cursor: false },
      getPanel: () => panel,
    });

    const mountTarget = (text: string, abs: string, rel: string) =>
      mountConversation(text, fileLinks, async (paths) =>
        paths.map((input) => ({
          input,
          absolutePath: abs,
          relativePath: rel,
          withinWorkspace: true,
          exists: true,
          isDirectory: false,
        })),
      );

    // 1. 缺省 Nocturne 面板（含行号范围）
    mountTarget("看 `src/app.ts:10-15`", "Z:\\project\\src\\app.ts", "src\\app.ts");
    const tsLink = await screen.findByRole("button", { name: "src/app.ts:10-15" });
    fireEvent.click(tsLink);
    fireEvent.contextMenu(tsLink);
    fireEvent.click(
      within(await screen.findByRole("menu")).getByRole("menuitem", { name: "打开" }),
    );
    expect(panel.openFile).toHaveBeenNthCalledWith(1, "Z:\\project\\src\\app.ts", 10, {
      endLine: 15,
    });
    expect(panel.openFile).toHaveBeenNthCalledWith(2, "Z:\\project\\src\\app.ts", 10, {
      endLine: 15,
    });

    // 2. HTML 预览（面板模式下左键与右键「打开」都走 panel.openFile + previewsHtml === true）
    cleanup();
    mountTarget("看 `public/index.html`", "Z:\\project\\public\\index.html", "public\\index.html");
    const htmlLink = await screen.findByRole("button", { name: "public/index.html" });
    expect(fileLinks.previewsHtml("Z:\\project\\public\\index.html")).toBe(true);
    fireEvent.contextMenu(htmlLink);
    fireEvent.click(
      within(await screen.findByRole("menu")).getByRole("menuitem", { name: "打开" }),
    );
    expect(panel.openFile).toHaveBeenLastCalledWith("Z:\\project\\public\\index.html", undefined, {
      endLine: undefined,
    });

    // 3. 系统默认模式
    prefs.update({ fileOpener: "system" as FileOpener });
    fireEvent.click(htmlLink);
    fireEvent.contextMenu(htmlLink);
    fireEvent.click(
      within(await screen.findByRole("menu")).getByRole("menuitem", { name: "打开" }),
    );
    expect(host.openPath).toHaveBeenCalledTimes(2);
    expect(host.openPath).toHaveBeenLastCalledWith("Z:\\project\\public\\index.html");

    // 4. 编辑器带行号模式（VS Code）
    cleanup();
    prefs.update({ fileOpener: "vscode" as FileOpener });
    mountTarget("看 `src/app.ts:42`", "Z:\\project\\src\\app.ts", "src\\app.ts");
    const editorLink = await screen.findByRole("button", { name: "src/app.ts:42" });
    fireEvent.click(editorLink);
    fireEvent.contextMenu(editorLink);
    fireEvent.click(
      within(await screen.findByRole("menu")).getByRole("menuitem", { name: "打开" }),
    );
    expect(host.openInEditor).toHaveBeenCalledTimes(2);
    expect(host.openInEditor).toHaveBeenLastCalledWith("vscode", "Z:\\project\\src\\app.ts", 42);

    // 5. 右键选推荐应用 & 打开原生选择器均不改变 prefs.fileOpener
    fireEvent.contextMenu(editorLink);
    fireEvent.keyDown(
      within(await screen.findByRole("menu")).getByRole("menuitem", { name: "打开方式" }),
      { key: "ArrowRight" },
    );
    fireEvent.click(
      within(await screen.findByRole("menu", { name: "打开方式" })).getByRole("menuitem", {
        name: "记事本",
      }),
    );
    await waitFor(() => {
      expect(host.fileApps?.open).toHaveBeenCalledWith(
        "Z:\\project\\src\\app.ts",
        "app-notepad",
        42,
      );
    });
    expect(prefs.get().fileOpener).toBe("vscode");

    fireEvent.contextMenu(editorLink);
    fireEvent.keyDown(
      within(await screen.findByRole("menu")).getByRole("menuitem", { name: "打开方式" }),
      { key: "ArrowRight" },
    );
    fireEvent.click(
      within(await screen.findByRole("menu", { name: "打开方式" })).getByRole("menuitem", {
        name: "更多打开方式…",
      }),
    );
    await waitFor(() => {
      expect(host.fileApps?.openWithDialog).toHaveBeenCalledWith("Z:\\project\\src\\app.ts");
    });
    expect(prefs.get().fileOpener).toBe("vscode");
  });

  it("真实 userAgent 平台判定：仅 Windows 进增强菜单，macOS 与非 Windows/非 macOS 保留原菜单与原平台标签", async () => {
    setPlatformForTest(null);
    const uaSpy = vi.spyOn(navigator, "userAgent", "get");
    const makeHtmlHooks = () =>
      makeHooks({
        previewsHtml: vi.fn(() => true),
        editors: vi.fn(() => ({ vscode: true, cursor: false })),
        listFileApps: vi.fn(async () =>
          appList({ apps: [app("app-edge", "Microsoft Edge", { isDefault: true })] }),
        ),
      });

    // 1. 真实 Linux（非 Windows、非 macOS）UA：不走 Windows 增强菜单、不出现「更多打开方式…」、保留「资源管理器」与原有功能，快捷键规则不变
    uaSpy.mockReturnValue(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    );
    expect(isWindows()).toBe(false);
    expect(isMacOS()).toBe(false);
    expect(hasPrimaryMod({ ctrlKey: true, metaKey: false })).toBe(true);
    expect(hasPrimaryMod({ ctrlKey: false, metaKey: true })).toBe(false);
    expect(hasPrimaryModOrMetaOnOther({ ctrlKey: false, metaKey: true })).toBe(true);
    expect(formatShortcut("Mod+P")).toBe("Ctrl+P");
    const linuxTauriHost = createTauriHost();
    expect(linuxTauriHost.fileApps?.list).toBeTypeOf("function");
    expect(linuxTauriHost.fileApps?.open).toBeTypeOf("function");
    expect(linuxTauriHost.fileApps?.openWithDialog).toBeUndefined();
    const linuxHooks = makeHtmlHooks();
    mountConversation("查看 `web/index.html`", linuxHooks, async (paths) =>
      paths.map((input) => ({
        input,
        absolutePath: "/home/me/proj/web/index.html",
        relativePath: "web/index.html",
        withinWorkspace: true,
        exists: true,
        isDirectory: false,
      })),
    );
    fireEvent.contextMenu(await screen.findByRole("button", { name: "web/index.html" }));
    const linuxMenu = await screen.findByRole("menu");
    expect(directItemLabels(linuxMenu)).toEqual([
      "打开",
      "查看源码",
      "资源管理器",
      "VS Code",
      "复制绝对路径",
      "复制相对路径",
    ]);
    expect(linuxHooks.listFileApps).not.toHaveBeenCalled();
    fireEvent.click(within(linuxMenu).getByRole("menuitem", { name: "资源管理器" }));
    expect(linuxHooks.reveal).toHaveBeenCalledWith("/home/me/proj/web/index.html");

    // 2. 真实 macOS UA：保留 macOS 原有菜单与「访达」标签，不暴露 Windows picker
    cleanup();
    uaSpy.mockReturnValue(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
    );
    expect(isWindows()).toBe(false);
    expect(isMacOS()).toBe(true);
    expect(hasPrimaryMod({ ctrlKey: false, metaKey: true })).toBe(true);
    expect(hasPrimaryMod({ ctrlKey: true, metaKey: false })).toBe(false);
    expect(formatShortcut("Mod+P")).toBe("⌘P");
    const macTauriHost = createTauriHost();
    expect(macTauriHost.fileApps?.list).toBeTypeOf("function");
    expect(macTauriHost.fileApps?.open).toBeTypeOf("function");
    expect(macTauriHost.fileApps?.openWithDialog).toBeUndefined();
    const macHooks = makeHtmlHooks();
    mountConversation("查看 `web/index.html`", macHooks, async (paths) =>
      paths.map((input) => ({
        input,
        absolutePath: "/Users/me/proj/web/index.html",
        relativePath: "web/index.html",
        withinWorkspace: true,
        exists: true,
        isDirectory: false,
      })),
    );
    fireEvent.contextMenu(await screen.findByRole("button", { name: "web/index.html" }));
    const macMenu = await screen.findByRole("menu");
    expect(directItemLabels(macMenu)).toEqual([
      "打开",
      "查看源码",
      "访达",
      "VS Code",
      "复制绝对路径",
      "复制相对路径",
    ]);
    expect(macHooks.listFileApps).not.toHaveBeenCalled();

    // 3. 真实 Windows UA（Edge WebView2）：进入 Windows 五项增强菜单与原生选择器入口，快捷键保持 Ctrl
    cleanup();
    uaSpy.mockReturnValue(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
    );
    expect(isWindows()).toBe(true);
    expect(isMacOS()).toBe(false);
    expect(hasPrimaryMod({ ctrlKey: true, metaKey: false })).toBe(true);
    expect(formatShortcut("Mod+P")).toBe("Ctrl+P");
    const winTauriHost = createTauriHost();
    expect(winTauriHost.fileApps?.openWithDialog).toBeTypeOf("function");
    const winHooks = makeHtmlHooks();
    mountConversation("查看 `web/index.html`", winHooks, async (paths) =>
      paths.map((input) => ({
        input,
        absolutePath: "Z:\\project\\web\\index.html",
        relativePath: "web\\index.html",
        withinWorkspace: true,
        exists: true,
        isDirectory: false,
      })),
    );
    fireEvent.contextMenu(await screen.findByRole("button", { name: "web/index.html" }));
    const winMenu = await screen.findByRole("menu");
    expect(directItemLabels(winMenu)).toEqual([
      "打开",
      "打开方式",
      "在资源管理器中显示",
      "复制相对路径",
      "复制绝对路径",
    ]);
    await waitFor(() => {
      expect(winHooks.listFileApps).toHaveBeenCalledWith("Z:\\project\\web\\index.html");
    });
    fireEvent.keyDown(within(winMenu).getByRole("menuitem", { name: "打开方式" }), {
      key: "ArrowRight",
    });
    const sub = await screen.findByRole("menu", { name: "打开方式" });
    expect(directItemLabels(sub)).toEqual(["Microsoft Edge", "更多打开方式…"]);

    // 4. 显式注入 "other" 平台：非 Windows、非 macOS，不进 Windows 增强菜单且保留「资源管理器」与原快捷键规则
    cleanup();
    setPlatformForTest("other");
    expect(isWindows()).toBe(false);
    expect(isMacOS()).toBe(false);
    expect(formatShortcut("Mod+Shift+G")).toBe("Ctrl+Shift+G");
    const otherHooks = makeHtmlHooks();
    mountConversation("查看 `web/index.html`", otherHooks, async (paths) =>
      paths.map((input) => ({
        input,
        absolutePath: "/srv/proj/web/index.html",
        relativePath: "web/index.html",
        withinWorkspace: true,
        exists: true,
        isDirectory: false,
      })),
    );
    fireEvent.contextMenu(await screen.findByRole("button", { name: "web/index.html" }));
    const otherMenu = await screen.findByRole("menu");
    expect(directItemLabels(otherMenu)).toEqual([
      "打开",
      "查看源码",
      "资源管理器",
      "VS Code",
      "复制绝对路径",
      "复制相对路径",
    ]);
    expect(otherHooks.listFileApps).not.toHaveBeenCalled();
  });

  it("缺少 openWithDialog（picker）或缺少 fileApps 的宿主不造报错回调，退回原有可用菜单", async () => {
    setPlatformForTest(null);
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
    );
    const store = new Map<string, string>();
    const storage: Storage = {
      get length() {
        return store.size;
      },
      clear: () => {
        store.clear();
      },
      key: (index) => [...store.keys()][index] ?? null,
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => {
        store.set(key, value);
      },
      removeItem: (key) => {
        store.delete(key);
      },
    };
    const prefs = createPrefsStore(storage);
    const panel: FileRefPanelController = {
      openFile: vi.fn(),
      previewsHtml: vi.fn(() => false),
      viewSource: vi.fn(),
    };

    // 1. 有 fileApps.list/open 但缺少 openWithDialog
    const hostWithoutPicker = {
      openPath: vi.fn(async () => undefined),
      openInEditor: vi.fn(async () => undefined),
      revealItem: vi.fn(async () => undefined),
      fileApps: {
        list: vi.fn(async () =>
          appList({ apps: [app("app-notepad", "记事本", { isDefault: true })] }),
        ),
        open: vi.fn(async () => undefined),
      },
    } as unknown as DesktopHost;
    const hooksWithoutPicker = createFileLinkHooks({
      host: hostWithoutPicker,
      prefs,
      editors: { vscode: true, cursor: false },
      getPanel: () => panel,
    });
    expect(hooksWithoutPicker.openFileWithDialog).toBeUndefined();
    expect(
      buildOpenWithEntries(
        appList({ apps: [app("app-notepad", "记事本", { isDefault: true })] }),
        { vscode: true, cursor: false },
        "Z:\\project\\src\\legacy.ts",
        7,
        hooksWithoutPicker,
      ).showPicker,
    ).toBe(false);

    mountConversation("查看 `src/legacy.ts:7`", hooksWithoutPicker, async (paths) =>
      paths.map((input) => ({
        input,
        absolutePath: "Z:\\project\\src\\legacy.ts",
        relativePath: "src\\legacy.ts",
        withinWorkspace: true,
        exists: true,
        isDirectory: false,
      })),
    );
    const link1 = await screen.findByRole("button", { name: "src/legacy.ts:7" });
    fireEvent.contextMenu(link1);
    const menu1 = await screen.findByRole("menu");
    expect(directItemLabels(menu1)).toEqual([
      "打开",
      "资源管理器",
      "VS Code",
      "复制绝对路径",
      "复制相对路径",
    ]);
    expect(hostWithoutPicker.fileApps?.list).not.toHaveBeenCalled();
    fireEvent.click(within(menu1).getByRole("menuitem", { name: "打开" }));
    expect(panel.openFile).toHaveBeenCalledWith("Z:\\project\\src\\legacy.ts", 7, {
      endLine: undefined,
    });
    fireEvent.contextMenu(link1);
    fireEvent.click(
      within(await screen.findByRole("menu")).getByRole("menuitem", { name: "资源管理器" }),
    );
    expect(hostWithoutPicker.revealItem).toHaveBeenCalledWith("Z:\\project\\src\\legacy.ts");
    expect(document.querySelector(".file-ref-error")).toBeNull();

    // 2. 完全没有 fileApps 的旧宿主：不造 list/open/openWithDialog 回调，普通打开与定位照常可用
    cleanup();
    const legacyHost = {
      openPath: vi.fn(async () => undefined),
      openInEditor: vi.fn(async () => undefined),
      revealItem: vi.fn(async () => undefined),
    } as unknown as DesktopHost;
    const legacyHooks = createFileLinkHooks({
      host: legacyHost,
      prefs,
      editors: { vscode: true, cursor: false },
      getPanel: () => panel,
    });
    expect(legacyHooks.listFileApps).toBeUndefined();
    expect(legacyHooks.openFileWithApp).toBeUndefined();
    expect(legacyHooks.openFileWithDialog).toBeUndefined();

    mountConversation("打开 `src/old.ts` 与 `sub/dir`", legacyHooks, async (paths) =>
      paths.map((input) =>
        input === "sub/dir"
          ? {
              input,
              absolutePath: "Z:\\project\\sub\\dir",
              relativePath: "sub\\dir",
              withinWorkspace: true,
              exists: true,
              isDirectory: true,
            }
          : {
              input,
              absolutePath: "Z:\\project\\src\\old.ts",
              relativePath: "src\\old.ts",
              withinWorkspace: true,
              exists: true,
              isDirectory: false,
            },
      ),
    );
    const fileLink = await screen.findByRole("button", { name: "src/old.ts" });
    fireEvent.contextMenu(fileLink);
    const fileMenu = await screen.findByRole("menu");
    expect(directItemLabels(fileMenu)).toEqual([
      "打开",
      "资源管理器",
      "VS Code",
      "复制绝对路径",
      "复制相对路径",
    ]);
    fireEvent.click(within(fileMenu).getByRole("menuitem", { name: "VS Code" }));
    expect(legacyHost.openInEditor).toHaveBeenCalledWith(
      "vscode",
      "Z:\\project\\src\\old.ts",
      undefined,
    );

    const dirLink = await screen.findByRole("button", { name: "sub/dir" });
    fireEvent.contextMenu(dirLink);
    const dirMenu = await screen.findByRole("menu");
    expect(directItemLabels(dirMenu)).toEqual([
      "打开",
      "资源管理器",
      "复制绝对路径",
      "复制相对路径",
    ]);
    fireEvent.click(within(dirMenu).getByRole("menuitem", { name: "打开" }));
    expect(legacyHost.openPath).toHaveBeenCalledWith("Z:\\project\\sub\\dir");
  });
});
