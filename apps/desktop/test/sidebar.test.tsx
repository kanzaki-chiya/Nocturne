import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Sidebar, type SidebarProps } from "../src/Sidebar";
import type { SessionTree } from "../src/session-tree";

const noop = () => undefined;

const emptyTree: SessionTree = { pinned: [], chats: { rows: [], moreCount: 0 }, projects: [] };

function props(overrides?: Partial<SidebarProps>): SidebarProps {
  return {
    tree: emptyTree,
    pinnedIds: new Set(),
    selectedId: null,
    collapsed: new Set(),
    expanded: new Set(),
    chatsExpanded: false,
    onSelectSession: noop,
    onToggleCollapse: noop,
    onToggleExpand: noop,
    onToggleChats: noop,
    onToggleAllProjects: noop,
    onPin: noop,
    onUnpin: noop,
    onHideProject: noop,
    onOpenProject: noop,
    ...overrides,
  };
}

afterEach(cleanup);

describe("Sidebar", () => {
  it("「＋ 新会话」置灰不可点（aria-disabled + title），无 Ctrl+N 提示", () => {
    render(<Sidebar {...props()} />);
    const add = screen.getByText("新会话").closest("button");
    expect(add?.getAttribute("aria-disabled")).toBe("true");
    expect(add?.title).toBe("第 2 步实现");
    expect(screen.queryByText(/Ctrl\+N/)).toBeNull();
  });

  it("没有对话会话时不渲染「对话」标题", () => {
    const { container } = render(<Sidebar {...props()} />);
    expect(screen.queryByText("对话")).toBeNull();
    expect(container.querySelectorAll(".h4row h4")).toHaveLength(1);
  });

  it("有对话会话时渲染「对话」平铺区与「展开显示」", () => {
    const tree: SessionTree = {
      pinned: [],
      chats: {
        rows: [{ id: "c1", title: "闲聊", meta: "现在", locked: false, status: "idle" }],
        moreCount: 3,
      },
      projects: [],
    };
    render(<Sidebar {...props({ tree })} />);
    expect(screen.getByText("对话")).toBeTruthy();
    expect(screen.getByText("闲聊")).toBeTruthy();
    expect(screen.getByText("展开显示（还有 3 个）")).toBeTruthy();
  });

  it("点「…」调用全部折叠/展开回调；「＋」调用打开项目", () => {
    const onToggleAllProjects = vi.fn();
    const onOpenProject = vi.fn();
    render(<Sidebar {...props({ onToggleAllProjects, onOpenProject })} />);
    fireEvent.click(screen.getByTitle("全部展开"));
    expect(onToggleAllProjects).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTitle("打开项目…"));
    expect(onOpenProject).toHaveBeenCalledTimes(1);
  });

  it("不再渲染左栏底部的「＋ 打开项目…」行", () => {
    render(<Sidebar {...props()} />);
    expect(screen.queryByText("打开项目…", { selector: ".nav .item" })).toBeNull();
  });

  it("项目行的「＋」置灰且点击不触发折叠切换", () => {
    const onToggleCollapse = vi.fn();
    const tree: SessionTree = {
      pinned: [],
      chats: { rows: [], moreCount: 0 },
      projects: [
        {
          key: "z:\\repo",
          name: "repo",
          path: "Z:\\repo",
          count: 1,
          sessions: [{ id: "s1", title: "会话", meta: "现在", locked: false, status: "idle" }],
          moreCount: 0,
          manual: false,
        },
      ],
    };
    const { container } = render(<Sidebar {...props({ tree, onToggleCollapse })} />);
    const gadd = container.querySelector<HTMLElement>(".gadd");
    expect(gadd).not.toBeNull();
    expect(gadd?.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(gadd as HTMLElement);
    expect(onToggleCollapse).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("repo"));
    expect(onToggleCollapse).toHaveBeenCalledWith("z:\\repo");
  });
});
