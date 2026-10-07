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
    projectSort: "activity",
    hiddenProjects: [],
    onSetSort: noop,
    onPin: noop,
    onUnpin: noop,
    onHideProject: noop,
    onRestoreProject: noop,
    onOpenProject: noop,
    onNewSession: noop,
    ...overrides,
  };
}

afterEach(cleanup);

describe("Sidebar", () => {
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

  it("点「…」弹出项目菜单：排序选项标当前值并回调 onSetSort；「＋」调用打开项目", () => {
    const onSetSort = vi.fn();
    const onOpenProject = vi.fn();
    render(<Sidebar {...props({ projectSort: "name", onSetSort, onOpenProject })} />);
    fireEvent.click(screen.getByTitle("项目菜单"));
    expect(screen.getByText("排序")).toBeTruthy();
    expect(screen.getByText("已移除的项目…")).toBeTruthy();
    expect(screen.getByText("名称").querySelector(".ck")?.textContent).toBe("✓");
    expect(screen.getByText("最近活动").querySelector(".ck")?.textContent).toBe("");
    fireEvent.click(screen.getByText("最近活动"));
    expect(onSetSort).toHaveBeenCalledWith("activity");
    fireEvent.click(screen.getByTitle("打开项目…"));
    expect(onOpenProject).toHaveBeenCalledTimes(1);
  });

  it("「已移除的项目…」列出隐藏项目，点击逐个恢复", () => {
    const onRestoreProject = vi.fn();
    const hiddenProjects = [
      { path: "Z:\\old\\alpha", name: "alpha" },
      { path: "Z:\\old\\beta", name: "beta" },
    ];
    render(<Sidebar {...props({ hiddenProjects, onRestoreProject })} />);
    fireEvent.click(screen.getByTitle("项目菜单"));
    fireEvent.click(screen.getByText("beta"));
    expect(onRestoreProject).toHaveBeenCalledWith("Z:\\old\\beta");
  });

  it("没有已移除的项目时菜单显示空提示", () => {
    render(<Sidebar {...props({ hiddenProjects: [] })} />);
    fireEvent.click(screen.getByTitle("项目菜单"));
    expect(screen.getByText("（没有已移除的项目）")).toBeTruthy();
  });

  it("不再渲染左栏底部的「＋ 打开项目…」行", () => {
    render(<Sidebar {...props()} />);
    expect(screen.queryByText("打开项目…", { selector: ".nav .item" })).toBeNull();
  });

  const rowTree: SessionTree = {
    pinned: [],
    chats: {
      rows: [{ id: "s1", title: "一号会话", meta: "昨天", locked: false, status: "idle" }],
      moreCount: 0,
    },
    projects: [
      {
        key: "Z:/proj",
        name: "proj",
        path: "Z:/proj",
        count: 1,
        sessions: [{ id: "s2", title: "项目会话", meta: "现在", locked: false, status: "idle" }],
        moreCount: 0,
        manual: false,
      },
    ],
  };

  it("会话行「…」与右键打开同一个置顶菜单（F-02）", () => {
    const onPin = vi.fn();
    render(<Sidebar {...props({ tree: rowTree, onPin })} />);
    // 「…」点击：与右键同款菜单
    const menuBtn = screen.getAllByRole("button", { name: "会话菜单" })[0];
    if (menuBtn === undefined) throw new Error("会话行缺少「…」菜单按钮");
    fireEvent.click(menuBtn);
    expect(screen.getByText("置顶")).toBeTruthy();
    fireEvent.click(screen.getByText("置顶"));
    expect(onPin).toHaveBeenCalledWith("s1");
    // 右键路径仍可用且菜单一致
    fireEvent.contextMenu(screen.getByText("一号会话"));
    expect(screen.getByText("置顶")).toBeTruthy();
  });

  it("会话行「…」可键盘操作：真实按钮可聚焦，打开菜单后焦点进菜单项（F-02）", () => {
    render(<Sidebar {...props({ tree: rowTree })} />);
    const btn = screen.getAllByRole("button", { name: "会话菜单" })[0];
    if (btn === undefined) throw new Error("会话行缺少「…」菜单按钮");
    // 原生 <button>：Tab 可达，Enter/Space 派发 click（jsdom 不模拟按键→click，聚焦可达性即键盘入口）
    btn.focus();
    expect(document.activeElement).toBe(btn);
    fireEvent.click(btn);
    const item = screen.getByText("置顶");
    expect(item).toBeTruthy();
    // 菜单项自动聚焦：Enter 直接选中，Esc 关闭
    expect(document.activeElement).toBe(item);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByText("置顶")).toBeNull();
  });

  it("项目行「…」与右键打开同一个「从列表移除」菜单（F-02）", () => {
    const onHideProject = vi.fn();
    render(<Sidebar {...props({ tree: rowTree, onHideProject })} />);
    fireEvent.click(screen.getByRole("button", { name: "项目菜单" }));
    expect(screen.getByText("从列表移除")).toBeTruthy();
    fireEvent.click(screen.getByText("从列表移除"));
    expect(onHideProject).toHaveBeenCalledWith("Z:/proj");
    fireEvent.contextMenu(screen.getByText("proj"));
    expect(screen.getByText("从列表移除")).toBeTruthy();
  });
});
