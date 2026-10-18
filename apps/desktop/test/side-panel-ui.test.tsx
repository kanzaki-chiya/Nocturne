/**
 * 右侧面板界面（ADR-0060）：文件标签的读取结果、新标签页、标签关闭、快速打开、
 * 终端标签（Shell 下拉、退出与重新启动）、变更按文件合并、窄标签隐藏项目名。
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { LocalFileContent, TurnChanges } from "@nocturne/core/protocol";
import { RpcError } from "@nocturne/rpc/client";

import type { TerminalHost, TerminalMessage } from "../src/host";
import { QuickOpen } from "../src/PanelChrome";
import { SidePanel, type SidePanelProps } from "../src/SidePanel";
import type { FileTab, PanelTab, TerminalTab } from "../src/side-panel";

// xterm 在 jsdom 里画不出来：换成只记录写入的假终端
const written: string[] = [];
const pasted: string[] = [];
const focused = { count: 0 };
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
    selection: () => "",
    paste: (text: string) => {
      pasted.push(text);
    },
    clear: () => {
      written.length = 0;
    },
    dispose: () => undefined,
  }),
}));

afterEach(cleanup);

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
    listShells: vi.fn(async () => []),
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
    listShells: vi.fn(async () => SHELLS),
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

it("终端右键菜单「粘贴」由外壳读剪贴板（不用 navigator.clipboard，免得 WebView2 弹权限框）", async () => {
  const fake = fakeTerminals();
  const p = props({
    tabs: [termTab],
    activeId: "t",
    terminals: fake.host,
    listShells: vi.fn(async () => SHELLS),
  });
  render(<SidePanel {...p} />);
  await waitFor(() => {
    expect(fake.opened).toHaveLength(1);
  });
  pasted.length = 0;
  fireEvent.contextMenu(screen.getByLabelText("终端"));
  fireEvent.click(await screen.findByText("粘贴"));
  await waitFor(() => {
    expect(pasted).toEqual(["echo 剪贴板"]);
  });
  expect(fake.host.readClipboard).toHaveBeenCalledTimes(1);
});

it("终端 Shell 下拉只列外壳认可且已安装的 shell；选了交给面板换 shell", async () => {
  const fake = fakeTerminals();
  const p = props({
    tabs: [termTab],
    activeId: "t",
    terminals: fake.host,
    listShells: vi.fn(async () => SHELLS),
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
    listShells: vi.fn(async () => SHELLS),
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
    listShells: vi.fn(async () => SHELLS),
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
