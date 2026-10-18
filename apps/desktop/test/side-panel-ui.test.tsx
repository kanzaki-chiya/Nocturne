/**
 * 右侧面板界面（ADR-0060 及修订）：文件标签的读取结果与超时重试、新标签页、标签关闭、
 * 快速打开、终端标签（默认 shell 跟随设置、Shell 下拉、退出与重新启动、右键复制粘贴、
 * 剪贴板失败提示、别的会话的终端后台保留）、变更（按文件合并、分隔条、换行、Windows 路径）、
 * 窄标签隐藏项目名。
 */
import { readFileSync } from "node:fs";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { LocalFileContent, TurnChangeDiff, TurnChanges } from "@nocturne/core/protocol";
import { RpcError } from "@nocturne/rpc/client";

import type { TerminalHost, TerminalMessage } from "../src/host";
import { QuickOpen, SessionOverview } from "../src/PanelChrome";
import { SidePanel, type SidePanelProps } from "../src/SidePanel";
import type { FileTab, PanelTab, TerminalTab } from "../src/side-panel";

// xterm 在 jsdom 里画不出来：换成只记录写入的假终端
const written: string[] = [];
const pasted: string[] = [];
const focused = { count: 0 };
/** 假终端的选区与鼠标上报模式，测试里直接改 */
const term = { selection: "", mouseTracking: false, cleared: 0 };
vi.mock("../src/terminal-view", () => ({
  mountTerminal: () => ({
    write: (data: string) => {
      written.push(data);
    },
    fit: () => undefined,
    size: () => ({ cols: 100, rows: 30 }),
    focus: () => {
      focused.count += 1;
    },
    selection: () => term.selection,
    clearSelection: () => {
      term.selection = "";
      term.cleared += 1;
    },
    mouseTracking: () => term.mouseTracking,
    paste: (text: string) => {
      pasted.push(text);
    },
    clear: () => {
      written.length = 0;
    },
    dispose: () => undefined,
  }),
}));

afterEach(() => {
  cleanup();
  term.selection = "";
  term.mouseTracking = false;
  term.cleared = 0;
});

const fileTab: FileTab = {
  id: "f",
  kind: "file",
  workspace: "Z:\\proj",
  absolutePath: "Z:\\proj\\gone.ts",
};

function props(overrides: Partial<SidePanelProps>): SidePanelProps {
  return {
    tabs: [],
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
    },
    terminals: undefined,
    loadShells: vi.fn(async () => ({ shells: [], setting: undefined })),
    onShellChange: vi.fn(),
    ...overrides,
  };
}

it("恢复的文件已被删除：显示「文件已不存在」", async () => {
  const readFile = vi.fn(async () => {
    throw new RpcError("file_not_found", "not found", -32002);
  });
  render(<SidePanel {...props({ tabs: [fileTab], activeId: "f", readFile })} />);
  expect(await screen.findByText("文件已不存在")).toBeTruthy();
  expect(readFile).toHaveBeenCalledWith("Z:\\proj\\gone.ts");
  expect(screen.getByRole("tab", { name: /gone\.ts/ }).textContent).toContain("proj");
});

it("工作区外的文件：按绝对路径读取，标签与面包屑显示所在目录名", async () => {
  const tab: FileTab = { id: "o", kind: "file", absolutePath: "D:\\notes\\weekly\\plan.md" };
  const readFile = vi.fn(async () => ({
    kind: "text" as const,
    absolutePath: tab.absolutePath,
    text: "# 计划",
    bytes: 8,
  }));
  render(<SidePanel {...props({ tabs: [tab], activeId: "o", readFile })} />);
  await waitFor(() => {
    expect(readFile).toHaveBeenCalledWith("D:\\notes\\weekly\\plan.md");
  });
  expect(screen.getByRole("tab", { name: /plan\.md/ }).textContent).toContain("weekly");
  expect(document.querySelector(".sp-crumb-project")?.textContent).toBe("weekly");
});

it("网络路径被拒绝时给出说明；后台重新连上（readerKey 变化）会重读", async () => {
  const readFile = vi.fn(async () => {
    throw new RpcError("file_network_path", "network", -32002);
  });
  const p = props({ tabs: [fileTab], activeId: "f", readFile });
  const view = render(<SidePanel {...p} />);
  expect(await screen.findByText("不读取网络路径上的文件")).toBeTruthy();
  view.rerender(<SidePanel {...p} readerKey="2" />);
  await waitFor(() => {
    expect(readFile).toHaveBeenCalledTimes(2);
  });
});

it("读取超时：提示所在磁盘可能不可用，「重试」重新读取", async () => {
  const readFile = vi
    .fn<(path: string) => Promise<LocalFileContent>>()
    .mockRejectedValueOnce(new RpcError("file_read_timeout", "读取超时", -32002))
    .mockResolvedValueOnce({
      kind: "text",
      absolutePath: "Z:\\proj\\gone.ts",
      text: "ok",
      bytes: 2,
    });
  render(<SidePanel {...props({ tabs: [fileTab], activeId: "f", readFile })} />);
  expect(await screen.findByText("读取超时，所在磁盘可能不可用")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  await waitFor(() => {
    expect(readFile).toHaveBeenCalledTimes(2);
  });
  await waitFor(() => {
    expect(screen.queryByText("读取超时，所在磁盘可能不可用")).toBeNull();
  });
});

it("二进制或过大文件只给外部打开与资源管理器", async () => {
  const readFile = vi.fn(async () => {
    throw new RpcError("file_too_large", "too large", -32002);
  });
  const p = props({ tabs: [fileTab], activeId: "f", readFile });
  render(<SidePanel {...p} />);
  expect(await screen.findByText("文件超过 2 MB，面板里不显示")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "在资源管理器中显示" }));
  expect(p.fileActions.reveal).toHaveBeenCalledWith("Z:\\proj\\gone.ts");
  expect(screen.getByRole("button", { name: "在外部编辑器打开" })).toBeTruthy();
});

it("HTML 文件头部有「在系统浏览器打开」", async () => {
  const tab: FileTab = { ...fileTab, absolutePath: "Z:\\proj\\a.html" };
  const readFile = vi.fn(async () => ({
    kind: "text" as const,
    absolutePath: tab.absolutePath,
    text: "<p>hi</p>",
    bytes: 9,
  }));
  const p = props({ tabs: [tab], activeId: "f", readFile });
  render(<SidePanel {...p} />);
  fireEvent.click(await screen.findByRole("button", { name: "在系统浏览器打开" }));
  expect(p.fileActions.openInBrowser).toHaveBeenCalledWith("Z:\\proj\\a.html");
});

it("新标签页：有终端能力时「终端」可点，没有时置灰", () => {
  const tabs: PanelTab[] = [{ id: "n", kind: "new" }];
  const p = props({ tabs, activeId: "n", terminals: fakeTerminals().host });
  const view = render(<SidePanel {...p} />);
  const terminal = screen.getByRole("button", { name: /^终端/ });
  expect((terminal as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(terminal);
  expect(p.onOpenTerminal).toHaveBeenCalled();
  // 没有打开的会话时「变更」不可点
  expect((screen.getByRole("button", { name: /^变更/ }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: /^文件/ }));
  expect(p.onQuickOpen).toHaveBeenCalled();
  view.rerender(<SidePanel {...p} terminals={undefined} />);
  expect((screen.getByRole("button", { name: /^终端/ }) as HTMLButtonElement).disabled).toBe(true);
});

/** 假终端宿主：记下每次 open 的参数和消息回调，测试里手动推输出、退出 */
function fakeTerminals() {
  const opened: { id: number; shell: string; cwd: string; push: (m: TerminalMessage) => void }[] =
    [];
  const closed: number[] = [];
  let next = 1;
  const host: TerminalHost = {
    open: vi.fn(async ({ shell, cwd }, onMessage) => {
      const id = next++;
      opened.push({ id, shell, cwd, push: onMessage });
      return id;
    }),
    write: vi.fn(async () => undefined),
    resize: vi.fn(async () => undefined),
    close: vi.fn(async (id: number) => {
      closed.push(id);
    }),
    readClipboard: vi.fn(async () => "echo 剪贴板"),
    writeClipboard: vi.fn(async (_text: string) => undefined),
  };
  return { host, opened, closed };
}

const SHELLS = [
  { kind: "pwsh", name: "PowerShell 7", executable: "C:\\pwsh\\pwsh.exe", available: true },
  { kind: "bash", name: "Git Bash", executable: "C:\\Git\\bin\\bash.exe", available: true },
  { kind: "cmd", name: "cmd", executable: "C:\\Windows\\System32\\cmd.exe", available: true },
  { kind: "sh", name: "sh", executable: "C:\\Git\\usr\\bin\\sh.exe", available: true },
  { kind: "powershell", name: "Windows PowerShell", available: false },
];

const termTab: TerminalTab = { id: "t", kind: "terminal", cwd: "Z:\\proj", label: "proj" };

it("终端：按 auto 规则开 pwsh，输出写进终端；进程退出显示退出码，「重新启动」再开", async () => {
  const fake = fakeTerminals();
  const p = props({
    tabs: [termTab],
    activeId: "t",
    terminals: fake.host,
    loadShells: vi.fn(async () => ({ shells: SHELLS, setting: undefined })),
  });
  render(<SidePanel {...p} />);
  await waitFor(() => {
    expect(fake.opened).toHaveLength(1);
  });
  expect(fake.opened[0]).toMatchObject({ shell: "C:\\pwsh\\pwsh.exe", cwd: "Z:\\proj" });
  expect(fake.host.open).toHaveBeenCalledWith(
    { shell: "C:\\pwsh\\pwsh.exe", cwd: "Z:\\proj", cols: 100, rows: 30 },
    expect.any(Function),
  );
  act(() => {
    fake.opened[0]?.push({ kind: "output", data: "PS Z:\\proj> " });
  });
  expect(written.join("")).toContain("PS Z:\\proj> ");
  act(() => {
    fake.opened[0]?.push({ kind: "exit", code: 7 });
  });
  expect(await screen.findByText("进程已退出（代码 7）")).toBeTruthy();
  const before = focused.count;
  fireEvent.click(screen.getByRole("button", { name: "重新启动" }));
  // 按钮随横条消失，焦点交回终端
  expect(focused.count).toBeGreaterThan(before);
  await waitFor(() => {
    expect(fake.opened).toHaveLength(2);
  });
  await waitFor(() => {
    expect(screen.queryByText("进程已退出（代码 7）")).toBeNull();
  });
});

async function openTerminal(overrides: Partial<SidePanelProps> = {}) {
  const fake = fakeTerminals();
  const p = props({
    tabs: [termTab],
    activeId: "t",
    terminals: fake.host,
    loadShells: vi.fn(async () => ({ shells: SHELLS, setting: undefined })),
    ...overrides,
  });
  const view = render(<SidePanel {...p} />);
  await waitFor(() => {
    expect(fake.opened).toHaveLength(1);
  });
  return { fake, p, view };
}

it("终端右键（Windows Terminal 规则）：没有选区时粘贴，由外壳读剪贴板，不弹菜单", async () => {
  const { fake } = await openTerminal();
  pasted.length = 0;
  const body = screen.getByLabelText("终端");
  const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
  body.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  await waitFor(() => {
    expect(pasted).toEqual(["echo 剪贴板"]);
  });
  expect(fake.host.readClipboard).toHaveBeenCalledTimes(1);
  expect(fake.host.writeClipboard).not.toHaveBeenCalled();
  expect(screen.queryByRole("menu")).toBeNull();
});

it("终端右键：有选区时复制（外壳写剪贴板）并清掉选区，不粘贴", async () => {
  const { fake } = await openTerminal();
  pasted.length = 0;
  term.selection = "npm test";
  fireEvent.contextMenu(screen.getByLabelText("终端"));
  await waitFor(() => {
    expect(fake.host.writeClipboard).toHaveBeenCalledWith("npm test");
  });
  expect(term.cleared).toBe(1);
  expect(fake.host.readClipboard).not.toHaveBeenCalled();
  expect(pasted).toEqual([]);
});

it("终端右键：程序开了鼠标上报（Claude Code 等）时什么都不做，交给程序", async () => {
  const { fake } = await openTerminal();
  pasted.length = 0;
  term.mouseTracking = true;
  term.selection = "selected";
  fireEvent.contextMenu(screen.getByLabelText("终端"));
  await act(async () => {
    await Promise.resolve();
  });
  expect(fake.host.readClipboard).not.toHaveBeenCalled();
  expect(fake.host.writeClipboard).not.toHaveBeenCalled();
  expect(term.cleared).toBe(0);
  expect(pasted).toEqual([]);
});

it("终端复制失败时给出看得见的提示", async () => {
  const { fake } = await openTerminal();
  vi.mocked(fake.host.writeClipboard).mockRejectedValueOnce(new Error("剪贴板被占用"));
  term.selection = "abc";
  fireEvent.contextMenu(screen.getByLabelText("终端"));
  expect((await screen.findByRole("alert")).textContent).toContain("复制失败：剪贴板被占用");
});

it("终端默认 shell 跟随设置里的 Shell；设置的 shell 没安装时退回 auto", async () => {
  const bash = await openTerminal({
    loadShells: vi.fn(async () => ({ shells: SHELLS, setting: "bash" })),
  });
  expect(bash.fake.opened[0]?.shell).toBe("C:\\Git\\bin\\bash.exe");
  // 下拉显示的是这个 shell，没有把设置写回去
  expect(screen.getByRole("combobox", { name: "Shell" }).textContent).toContain("Git Bash");
  expect(bash.p.onShellChange).not.toHaveBeenCalled();
  bash.view.unmount();
  const missing = await openTerminal({
    loadShells: vi.fn(async () => ({ shells: SHELLS, setting: "powershell" })),
  });
  expect(missing.fake.opened[0]?.shell).toBe("C:\\pwsh\\pwsh.exe");
  missing.view.unmount();
  const byPath = await openTerminal({
    loadShells: vi.fn(async () => ({
      shells: SHELLS,
      setting: "c:\\windows\\system32\\CMD.exe",
    })),
  });
  expect(byPath.fake.opened[0]?.shell).toBe("C:\\Windows\\System32\\cmd.exe");
});

it("别的会话的终端作为隐藏标签页挂着：不在标签栏、不可见、进程不结束", async () => {
  const other: TerminalTab = { id: "o", kind: "terminal", cwd: "Z:\\other", label: "other" };
  const { fake, p, view } = await openTerminal();
  // 切到另一个会话：当前标签换成新标签页，原来的终端留在 panes 里
  const next: PanelTab[] = [{ id: "n", kind: "new" }];
  view.rerender(<SidePanel {...p} tabs={next} activeId="n" panes={[termTab, ...next]} />);
  expect(screen.queryByRole("tab", { name: /终端/ })).toBeNull();
  expect(fake.closed).toEqual([]);
  const pane = view.container.querySelector<HTMLElement>(".sp-term")?.parentElement;
  expect(pane?.hidden).toBe(true);
  // 另一个会话也开了终端：两个进程并存
  view.rerender(<SidePanel {...p} tabs={[other]} activeId="o" panes={[termTab, other]} />);
  await waitFor(() => {
    expect(fake.opened).toHaveLength(2);
  });
  expect(fake.closed).toEqual([]);
  // 会话被删除：它的终端从 panes 里拿掉即结束进程
  view.rerender(<SidePanel {...p} tabs={[other]} activeId="o" panes={[other]} />);
  await waitFor(() => {
    expect(fake.closed).toEqual([1]);
  });
});

it("终端 Shell 下拉只列外壳认可且已安装的 shell；选了交给面板换 shell", async () => {
  const fake = fakeTerminals();
  const p = props({
    tabs: [termTab],
    activeId: "t",
    terminals: fake.host,
    loadShells: vi.fn(async () => ({ shells: SHELLS, setting: undefined })),
  });
  render(<SidePanel {...p} />);
  await waitFor(() => {
    expect(fake.opened).toHaveLength(1);
  });
  fireEvent.click(screen.getByRole("combobox", { name: "Shell" }));
  const list = await screen.findByRole("listbox");
  const names = within(list)
    .getAllByRole("option")
    .map((o) => o.textContent ?? "");
  expect(names.some((n) => n.includes("Git Bash"))).toBe(true);
  expect(names.some((n) => n.includes("cmd"))).toBe(true);
  // sh.exe 外壳不认，未安装的 Windows PowerShell 也不列
  expect(names.some((n) => n.startsWith("sh"))).toBe(false);
  expect(names.some((n) => n.includes("Windows PowerShell"))).toBe(false);
  fireEvent.click(within(list).getByRole("option", { name: /Git Bash/ }));
  expect(p.onShellChange).toHaveBeenCalledWith("t", "C:\\Git\\bin\\bash.exe");
});

it("终端换了 shell：结束旧进程，在同一标签开新进程；关闭标签结束进程", async () => {
  const fake = fakeTerminals();
  const p = props({
    tabs: [termTab],
    activeId: "t",
    terminals: fake.host,
    loadShells: vi.fn(async () => ({ shells: SHELLS, setting: undefined })),
  });
  const view = render(<SidePanel {...p} />);
  await waitFor(() => {
    expect(fake.opened).toHaveLength(1);
  });
  view.rerender(<SidePanel {...p} tabs={[{ ...termTab, shell: "C:\\Git\\bin\\bash.exe" }]} />);
  await waitFor(() => {
    expect(fake.opened).toHaveLength(2);
  });
  expect(fake.closed).toEqual([1]);
  expect(fake.opened[1]?.shell).toBe("C:\\Git\\bin\\bash.exe");
  // 旧进程迟到的输出不进新屏幕
  act(() => {
    fake.opened[0]?.push({ kind: "output", data: "stale" });
  });
  expect(written.join("")).not.toContain("stale");
  view.rerender(<SidePanel {...p} tabs={[]} activeId="" />);
  await waitFor(() => {
    expect(fake.closed).toEqual([1, 2]);
  });
});

it("面板收起时终端仍挂着，不结束进程", async () => {
  const fake = fakeTerminals();
  const p = props({
    tabs: [termTab],
    activeId: "t",
    terminals: fake.host,
    loadShells: vi.fn(async () => ({ shells: SHELLS, setting: undefined })),
  });
  const view = render(<SidePanel {...p} />);
  await waitFor(() => {
    expect(fake.opened).toHaveLength(1);
  });
  view.rerender(<SidePanel {...p} hidden />);
  expect(view.container.querySelector<HTMLElement>(".side-panel")?.hidden).toBe(true);
  expect(fake.closed).toEqual([]);
});

it("变更：同一文件多轮合并成一行，展开列出各轮，点轮次定位到那一轮的差异", async () => {
  const turns = new Map<number, TurnChanges>([
    [1, { seq: 1, files: [{ path: "Z:\\proj\\src\\a.ts", added: 3, removed: 1 }] } as TurnChanges],
    [
      5,
      {
        seq: 5,
        files: [
          { path: "Z:\\proj\\src\\a.ts", added: 2, removed: 2 },
          { path: "Z:\\proj\\b.ts", added: 1, removed: 0 },
        ],
      } as TurnChanges,
    ],
  ]);
  const scrolled: string[] = [];
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this.getAttribute("data-change-key") ?? "");
  };
  const tabs: PanelTab[] = [{ id: "c", kind: "changes" }];
  render(
    <SidePanel
      {...props({
        tabs,
        activeId: "c",
        changes: {
          workspace: "Z:\\proj",
          turns,
          userSeqs: [1, 5],
          loadDiff: vi.fn(async () => ({ diff: "" })),
        },
      })}
    />,
  );
  expect(screen.getByText("本会话 · 2 轮 · 2 个文件")).toBeTruthy();
  const tree = screen.getByRole("complementary", { name: "改动的文件" });
  const row = within(tree).getByRole("button", { name: /a\.ts/ });
  // 一行，合计 +5 −3
  expect(within(tree).getAllByRole("button", { name: /a\.ts/ })).toHaveLength(1);
  expect(row.textContent).toContain("2 轮");
  expect(row.textContent).toContain("+5");
  expect(row.textContent).toContain("−3");
  fireEvent.click(row);
  const first = within(tree).getByRole("button", { name: /第 1 轮/ });
  expect(within(tree).getByRole("button", { name: /第 2 轮/ })).toBeTruthy();
  fireEvent.click(first);
  expect(scrolled.at(-1)).toBe("1:Z:\\proj\\src\\a.ts");
  // 差异区仍按轮各一段
  expect(screen.getAllByRole("region", { name: /a\.ts 第 \d 轮/ })).toHaveLength(2);
});

function changesProps(overrides: Partial<SidePanelProps> = {}): SidePanelProps {
  const turns = new Map<number, TurnChanges>([
    [
      1,
      {
        seq: 1,
        files: [
          {
            path: "Z:\\proj\\docs\\a-very-long-file-name-for-truncation.md",
            added: 12,
            removed: 3,
          },
          { path: "Z:\\nocturne-mockups\\report.md", added: 4, removed: 0 },
        ],
      } as TurnChanges,
    ],
  ]);
  return props({
    tabs: [{ id: "c", kind: "changes" }],
    activeId: "c",
    changes: {
      workspace: "Z:\\proj",
      turns,
      userSeqs: [1],
      loadDiff: vi.fn(async () => ({ diff: "@@ -1 +1 @@\n-old\n+new line" }) as TurnChangeDiff),
    },
    ...overrides,
  });
}

it("变更分隔条：拖动调整文件树宽度（松手才保存），← → 键调整，夹在 180–420px", () => {
  const onTreeWidth = vi.fn();
  const view = render(<SidePanel {...changesProps({ treeWidth: 260, onTreeWidth })} />);
  const split = screen.getByRole("separator", { name: "调整文件树宽度" });
  expect(split.getAttribute("aria-valuenow")).toBe("260");
  expect(split.getAttribute("aria-valuemin")).toBe("180");
  expect(split.getAttribute("aria-valuemax")).toBe("420");
  const grid = view.container.querySelector<HTMLElement>(".sp-changes");
  // jsdom 没有指针捕获
  split.setPointerCapture = () => undefined;
  split.hasPointerCapture = () => false;
  fireEvent.pointerDown(split, { clientX: 500, pointerId: 1 });
  fireEvent.pointerMove(split, { clientX: 440, pointerId: 1 });
  expect(split.getAttribute("aria-valuenow")).toBe("320");
  expect(grid?.style.getPropertyValue("--sp-tree-width")).toBe("320px");
  expect(onTreeWidth).not.toHaveBeenCalled();
  // 拖过头：夹在上限
  fireEvent.pointerMove(split, { clientX: 0, pointerId: 1 });
  fireEvent.pointerUp(split, { clientX: 0, pointerId: 1 });
  expect(onTreeWidth).toHaveBeenLastCalledWith(420);
  view.rerender(<SidePanel {...changesProps({ treeWidth: 420, onTreeWidth })} />);
  fireEvent.keyDown(split, { key: "ArrowLeft" });
  expect(onTreeWidth).toHaveBeenLastCalledWith(420);
  fireEvent.keyDown(split, { key: "ArrowRight" });
  expect(onTreeWidth).toHaveBeenLastCalledWith(404);
  view.rerender(<SidePanel {...changesProps({ treeWidth: 190, onTreeWidth })} />);
  fireEvent.keyDown(split, { key: "ArrowRight" });
  expect(onTreeWidth).toHaveBeenLastCalledWith(180);
});

it("变更换行：默认换行，卡片头「换行」切换并交给面板记住；关掉后差异不换行", async () => {
  const onWrap = vi.fn();
  const view = render(<SidePanel {...changesProps({ onWrap })} />);
  await waitFor(() => {
    expect(view.container.querySelector(".diff-body")).not.toBeNull();
  });
  expect(view.container.querySelector(".diff-body")?.classList.contains("diff-wrap")).toBe(true);
  const toggle = screen.getAllByRole("button", { name: "换行" })[0];
  expect(toggle?.getAttribute("aria-pressed")).toBe("true");
  if (toggle !== undefined) fireEvent.click(toggle);
  expect(onWrap).toHaveBeenCalledWith(false);
  view.rerender(<SidePanel {...changesProps({ onWrap, wrap: false })} />);
  expect(view.container.querySelector(".diff-body")?.classList.contains("diff-wrap")).toBe(false);
  expect(screen.getAllByRole("button", { name: "换行" })[0]?.getAttribute("aria-pressed")).toBe(
    "false",
  );
});

it("变更：Windows 工作区用反斜杠，工作区外分组是 Z:\\nocturne-mockups，悬停显示完整路径", () => {
  render(<SidePanel {...changesProps()} />);
  const tree = screen.getByRole("complementary", { name: "改动的文件" });
  expect(within(tree).getByText("Z:\\nocturne-mockups")).toBeTruthy();
  const row = within(tree).getByRole("button", { name: /a-very-long-file-name/ });
  expect(row.getAttribute("title")).toContain(
    "Z:\\proj\\docs\\a-very-long-file-name-for-truncation.md",
  );
  // 增减行数完整保留在行尾
  expect(row.querySelector(".sp-counts")?.textContent).toBe("+12−3");
  const heads = [...document.querySelectorAll<HTMLElement>(".sp-change-path")].map(
    (node) => node.textContent,
  );
  expect(heads).toContain("docs\\a-very-long-file-name-for-truncation.md");
  expect(heads).toContain("Z:\\nocturne-mockups\\report.md");
});

it("窄标签：项目名放不下整段隐藏，放得下照常显示", () => {
  const pending = (): Promise<LocalFileContent> => new Promise(() => undefined);
  const sizes = { label: 60, name: 50, project: 30 };
  const widths = (el: Element) =>
    el.classList.contains("sp-tab-label")
      ? sizes.label
      : el.classList.contains("sp-tab-name")
        ? sizes.name
        : el.classList.contains("sp-tab-project")
          ? sizes.project
          : 0;
  const client = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    return widths(this);
  });
  const scroll = vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    return widths(this);
  });
  try {
    const { container, unmount } = render(
      <SidePanel
        {...props({
          tabs: [fileTab],
          activeId: "f",
          readFile: pending,
        })}
      />,
    );
    expect(container.querySelector(".sp-tab-label")?.classList.contains("no-project")).toBe(true);
    unmount();
    sizes.label = 120;
    const wide = render(
      <SidePanel
        {...props({
          tabs: [fileTab],
          activeId: "f",
          readFile: pending,
        })}
      />,
    );
    expect(wide.container.querySelector(".sp-tab-label")?.classList.contains("no-project")).toBe(
      false,
    );
  } finally {
    client.mockRestore();
    scroll.mockRestore();
  }
});

it("标签栏：关闭按钮与新标签按钮", () => {
  const tabs: PanelTab[] = [{ id: "n", kind: "new" }];
  const p = props({ tabs, activeId: "n" });
  render(<SidePanel {...p} />);
  fireEvent.click(screen.getByRole("button", { name: "关闭 新标签页" }));
  expect(p.onCloseTab).toHaveBeenCalledWith("n");
  fireEvent.click(screen.getByRole("button", { name: "新标签页" }));
  expect(p.onNewTab).toHaveBeenCalled();
});

it("快速打开：点在对话框外（包括标题栏按钮）就关闭，点在里面不关", () => {
  const onClose = vi.fn();
  render(
    <>
      <button type="button">会话概览</button>
      <QuickOpen
        project="proj"
        load={() => Promise.resolve([])}
        onPick={vi.fn()}
        onClose={onClose}
      />
    </>,
  );
  fireEvent.mouseDown(screen.getByRole("combobox", { name: "搜索文件" }));
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.mouseDown(screen.getByRole("button", { name: "会话概览" }));
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("变更：点哪一轮高亮哪一轮（含「查看变更」定位、重复点同一轮再滚一次）", async () => {
  const turns = new Map<number, TurnChanges>([
    [1, { seq: 1, files: [{ path: "Z:\\proj\\a.ts", added: 1, removed: 1 }] } as TurnChanges],
    [2, { seq: 2, files: [{ path: "Z:\\proj\\a.ts", added: 2, removed: 0 }] } as TurnChanges],
  ]);
  const scrolled: string[] = [];
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this.getAttribute("data-change-seq") ?? "");
  };
  const source = {
    workspace: "Z:\\proj",
    turns,
    userSeqs: [1, 2],
    loadDiff: vi.fn(async () => ({ diff: "" })),
  };
  const view = render(
    <SidePanel
      {...props({
        tabs: [{ id: "c", kind: "changes", focusSeq: 2, focusNonce: 1 }],
        activeId: "c",
        changes: source,
      })}
    />,
  );
  const focusedRounds = () =>
    [...document.querySelectorAll(".sp-change.focus")].map((n) =>
      n.getAttribute("data-change-seq"),
    );
  // 「查看变更」：第 2 轮
  await waitFor(() => {
    expect(scrolled.at(-1)).toBe("2");
  });
  expect(focusedRounds()).toEqual(["2"]);
  const tree = screen.getByRole("complementary", { name: "改动的文件" });
  fireEvent.click(within(tree).getByRole("button", { name: /a\.ts/ }));
  fireEvent.click(within(tree).getByRole("button", { name: /第 1 轮/ }));
  expect(focusedRounds()).toEqual(["1"]);
  expect(scrolled.at(-1)).toBe("1");
  const before = scrolled.length;
  fireEvent.click(within(tree).getByRole("button", { name: /第 1 轮/ }));
  expect(scrolled.length).toBe(before + 1);
  expect(focusedRounds()).toEqual(["1"]);
  fireEvent.click(within(tree).getByRole("button", { name: /第 2 轮/ }));
  expect(focusedRounds()).toEqual(["2"]);
  // 再次「查看变更」第 1 轮（nonce 变了）：高亮跟过去
  view.rerender(
    <SidePanel
      {...props({
        tabs: [{ id: "c", kind: "changes", focusSeq: 1, focusNonce: 2 }],
        activeId: "c",
        changes: source,
      })}
    />,
  );
  await waitFor(() => {
    expect(focusedRounds()).toEqual(["1"]);
  });
});

it("分隔条：按下即获得焦点，之后 ← → Home End 能用；往窄拖到 180 为止", () => {
  const onTreeWidth = vi.fn();
  const onResize = vi.fn();
  render(<SidePanel {...changesProps({ treeWidth: 300, onTreeWidth, onResize })} />);
  const split = screen.getByRole("separator", { name: "调整文件树宽度" });
  split.setPointerCapture = () => undefined;
  split.hasPointerCapture = () => true;
  split.releasePointerCapture = () => undefined;
  (document.activeElement as HTMLElement | null)?.blur();
  fireEvent.pointerDown(split, { clientX: 500, pointerId: 1 });
  expect(document.activeElement).toBe(split);
  // 往右拖 = 变窄，过头夹在下限
  fireEvent.pointerMove(split, { clientX: 560, pointerId: 1 });
  expect(split.getAttribute("aria-valuenow")).toBe("240");
  fireEvent.pointerMove(split, { clientX: 900, pointerId: 1 });
  fireEvent.pointerUp(split, { clientX: 900, pointerId: 1 });
  expect(onTreeWidth).toHaveBeenLastCalledWith(180);
  fireEvent.keyDown(document.activeElement ?? split, { key: "End" });
  expect(onTreeWidth).toHaveBeenLastCalledWith(420);
  fireEvent.keyDown(document.activeElement ?? split, { key: "Home" });
  expect(onTreeWidth).toHaveBeenLastCalledWith(180);

  const panelSplit = screen.getByRole("separator", { name: "调整面板宽度" });
  panelSplit.setPointerCapture = () => undefined;
  panelSplit.releasePointerCapture = () => undefined;
  fireEvent.pointerDown(panelSplit, { clientX: 100, pointerId: 2 });
  expect(document.activeElement).toBe(panelSplit);
  fireEvent.pointerUp(panelSplit, { clientX: 100, pointerId: 2 });
  fireEvent.keyDown(document.activeElement ?? panelSplit, { key: "ArrowRight" });
  expect(onResize).toHaveBeenLastCalledWith(504, true);
});

it("没有删除行时不写 −0：文件树、diff 卡片头、概览浮层", async () => {
  render(<SidePanel {...changesProps()} />);
  const tree = screen.getByRole("complementary", { name: "改动的文件" });
  const report = within(tree).getByRole("button", { name: /report\.md/ });
  expect(report.querySelector(".sp-counts")?.textContent).toBe("+4");
  const card = screen.getByRole("region", { name: /report\.md 第 1 轮/ });
  expect(card.querySelector(".sp-change-head .sp-counts")?.textContent).toBe("+4");
  expect(card.querySelector(".sp-change-head")?.textContent).not.toContain("−");
  cleanup();
  const overview = (removed: number) =>
    render(
      <SessionOverview
        project="proj"
        workspace="Z:\proj"
        totals={{ added: 7, removed, files: 2 }}
        docked
        rightOffset={0}
        onOpenChanges={vi.fn()}
      />,
    );
  overview(0);
  expect(screen.getByRole("button", { name: /变更/ }).textContent).toBe("变更+7");
  cleanup();
  overview(3);
  expect(screen.getByRole("button", { name: /变更/ }).textContent).toBe("变更+7 −3");
});

it("换行关掉时行号列固定在左侧：sticky、背景不透明（样式表约定）", () => {
  // jsdom 算不出 sticky，直接查样式表（vitest 下 ?raw 的 CSS 是空串）
  const css = readFileSync(`${import.meta.dirname}/../src/side-panel.css`, "utf8");
  const rule = (selector: string) => {
    const at = css.indexOf(`${selector} {`);
    return at < 0 ? "" : css.slice(at, css.indexOf("}", at));
  };
  const gutter = rule(".sp-change .diff-body:not(.diff-wrap) :is(.diff-num, .diff-mark)");
  expect(gutter).toContain("position: sticky");
  expect(gutter).toContain("background: var(--a-panel)");
  expect(rule(".sp-change .diff-body:not(.diff-wrap) .diff-num")).toContain("left: 0");
  // 吸顶的卡片头压在吸左的行号格上面
  const z = (text: string) => Number(/z-index: (\d+)/.exec(text)?.[1]);
  expect(z(rule(".sp-change-head"))).toBeGreaterThan(z(gutter));
  expect(rule(".sp-change .diff-body:not(.diff-wrap) .diff-mark")).toMatch(/left: \S+/);
  // 增删行的行号格：半透明底色叠在不透明的卡片底色上
  expect(
    rule(".sp-change .diff-body:not(.diff-wrap) .diff-row-add :is(.diff-num, .diff-mark)"),
  ).toContain("var(--a-panel)");
});

it("快速打开：空查询时最近打开的在前，其余按路径字母序", async () => {
  render(
    <QuickOpen
      project="proj"
      load={() =>
        Promise.resolve([
          { path: "src/z.ts", kind: "file" as const },
          { path: "b.md", kind: "file" as const },
          { path: "a/c.ts", kind: "file" as const },
          { path: "src/y.ts", kind: "file" as const },
        ])
      }
      recent={["src/y.ts", "b.md"]}
      onPick={vi.fn()}
      onClose={vi.fn()}
    />,
  );
  await waitFor(() => {
    expect(screen.getAllByRole("option")).toHaveLength(4);
  });
  expect(
    screen
      .getAllByRole("option")
      .map(
        (o) =>
          o.querySelector("small")?.textContent +
          (o.querySelector(".qopen-name")?.textContent ?? ""),
      ),
  ).toEqual(["src/y.ts", "./b.md", "a/c.ts", "src/z.ts"]);
});
