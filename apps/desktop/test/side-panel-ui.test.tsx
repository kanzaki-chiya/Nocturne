/** 右侧面板界面（ADR-0060）：文件标签的读取结果、新标签页、标签关闭、快速打开。 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { RpcError } from "@nocturne/rpc/client";

import { QuickOpen } from "../src/PanelChrome";
import { SidePanel, type SidePanelProps } from "../src/SidePanel";
import type { FileTab, PanelTab } from "../src/side-panel";

afterEach(cleanup);

const fileTab: FileTab = {
  id: "f",
  kind: "file",
  workspace: "Z:\\proj",
  sessionId: "s1",
  absolutePath: "Z:\\proj\\gone.ts",
  relativePath: "gone.ts",
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
    onAddress: vi.fn(async () => undefined),
    changes: undefined,
    canOpenFiles: true,
    readFile: vi.fn(),
    readKey: () => "s1",
    fileActions: {
      externalLabel: "用 VS Code 打开",
      openExternal: vi.fn(async () => undefined),
      reveal: vi.fn(async () => undefined),
      openInBrowser: vi.fn(async () => undefined),
    },
    ...overrides,
  };
}

it("恢复的文件已被删除：显示「文件已不存在」", async () => {
  const readFile = vi.fn(async () => {
    throw new RpcError("file_not_found", "not found", -32002);
  });
  render(<SidePanel {...props({ tabs: [fileTab], activeId: "f", readFile })} />);
  expect(await screen.findByText("文件已不存在")).toBeTruthy();
  expect(screen.getByRole("tab", { name: /gone\.ts/ }).textContent).toContain("proj");
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
  const tab: FileTab = { ...fileTab, absolutePath: "Z:\\proj\\a.html", relativePath: "a.html" };
  const readFile = vi.fn(async () => ({
    kind: "text" as const,
    absolutePath: tab.absolutePath,
    relativePath: "a.html",
    text: "<p>hi</p>",
    bytes: 9,
  }));
  const p = props({ tabs: [tab], activeId: "f", readFile });
  render(<SidePanel {...p} />);
  fireEvent.click(await screen.findByRole("button", { name: "在系统浏览器打开" }));
  expect(p.fileActions.openInBrowser).toHaveBeenCalledWith("Z:\\proj\\a.html");
});

it("新标签页：工具列表里终端置灰并注明下个版本提供", () => {
  const tabs: PanelTab[] = [{ id: "n", kind: "new" }];
  const p = props({ tabs, activeId: "n" });
  render(<SidePanel {...p} />);
  expect(screen.getByText("下个版本提供")).toBeTruthy();
  const terminal = screen.getByRole("button", { name: /^终端/ });
  expect((terminal as HTMLButtonElement).disabled).toBe(true);
  // 没有打开的会话时「变更」不可点
  expect((screen.getByRole("button", { name: /^变更/ }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: /^文件/ }));
  expect(p.onQuickOpen).toHaveBeenCalled();
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
