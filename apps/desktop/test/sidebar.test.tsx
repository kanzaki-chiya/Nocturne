import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Sidebar, type SidebarProps } from "../src/Sidebar";
import type { SessionTree } from "../src/session-tree";

const noop = () => undefined;

const emptyTree: SessionTree = {
  pinned: [],
  chats: { rows: [], moreCount: 0 },
  scheduled: { rows: [], moreCount: 0 },
  projects: [],
  newProjectKeys: [],
};

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
    onMoveProject: noop,
    onPin: noop,
    onUnpin: noop,
    onRename: async () => undefined,
    onHideProject: noop,
    onRestoreProject: noop,
    onOpenProject: noop,
    onNewSession: noop,
    ...overrides,
  };
}

afterEach(cleanup);

describe("Sidebar", () => {
  it("设置导航把「外部 agent」改名为「子代理」，点击进入同一页", () => {
    const onOpenPage = vi.fn();
    render(<Sidebar {...props({ page: "general", onOpenPage })} />);
    const nav = screen.getByRole("navigation", { name: "设置" });
    expect(nav.textContent).not.toContain("外部 agent");
    fireEvent.click(screen.getByRole("button", { name: "子代理" }));
    expect(onOpenPage).toHaveBeenCalledWith("agents");
  });

  it("新会话下方是定时任务入口，显示启用数", () => {
    const onOpenSchedules = vi.fn();
    const { container } = render(
      <Sidebar {...props({ enabledScheduleCount: 3, onOpenSchedules, schedulesOpen: true })} />,
    );
    const buttons = [...container.querySelectorAll(".shead + .nav .item, .nav .item")];
    const labels = buttons.map((button) => button.textContent ?? "");
    const scheduleAt = labels.findIndex((label) => label.includes("定时任务"));
    const createAt = labels.findIndex((label) => label.includes("新会话"));
    expect(createAt).toBeGreaterThanOrEqual(0);
    expect(scheduleAt).toBeGreaterThan(createAt);
    const entry = screen.getByRole("button", { name: /定时任务/ });
    expect(entry.textContent).toContain("3");
    expect(entry.getAttribute("aria-current")).toBe("page");
    fireEvent.click(entry);
    expect(onOpenSchedules).toHaveBeenCalledOnce();
  });

  it("有定时任务会话时渲染独立分组，不和对话混在一起", () => {
    const tree: SessionTree = {
      ...emptyTree,
      scheduled: {
        rows: [
          {
            id: "s1",
            title: "每日提交汇总 · 10-25 09:00",
            meta: "现在",
            locked: false,
            status: "idle",
          },
        ],
        moreCount: 2,
      },
    };
    render(<Sidebar {...props({ tree })} />);
    const group = screen.getByRole("navigation", { name: "定时任务会话" });
    expect(group.textContent).toContain("每日提交汇总 · 10-25 09:00");
    expect(screen.getByText("展开显示（还有 2 个）")).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "对话" })).toBeNull();
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
      scheduled: { rows: [], moreCount: 0 },
      projects: [],
      newProjectKeys: [],
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
    const items = [...document.querySelectorAll(".ctxmenu.sub")][0]?.querySelectorAll("button");
    expect([...(items ?? [])].map((b) => b.textContent?.replace("✓", ""))).toEqual([
      "手动",
      "名称",
      "最近活动",
    ]);
    expect(screen.getByText("名称").querySelector(".ck")?.textContent).toBe("✓");
    expect(screen.getByText("手动").querySelector(".ck")?.textContent).toBe("");
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
    scheduled: { rows: [], moreCount: 0 },
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
    newProjectKeys: [],
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

  it("置顶后重命名预填全选，Enter 提交；同名和空串分别处理", async () => {
    const onRename = vi.fn(async () => undefined);
    render(<Sidebar {...props({ tree: rowTree, onRename })} />);
    fireEvent.click(screen.getAllByRole("button", { name: "会话菜单" })[0] as HTMLElement);
    expect([...document.querySelectorAll(".ctxmenu button")].map((b) => b.textContent)).toEqual([
      "置顶",
      "重命名",
    ]);
    fireEvent.click(screen.getByText("重命名"));
    const field = screen.getByRole("textbox", { name: "重命名会话" }) as HTMLInputElement;
    expect(field.value).toBe("一号会话");
    expect(field.selectionStart).toBe(0);
    expect(field.selectionEnd).toBe(field.value.length);
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onRename).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole("button", { name: "会话菜单" })[0] as HTMLElement);
    fireEvent.click(screen.getByText("重命名"));
    fireEvent.change(screen.getByRole("textbox", { name: "重命名会话" }), {
      target: { value: "" },
    });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "重命名会话" }), { key: "Enter" });
    await waitFor(() => expect(onRename).toHaveBeenCalledWith("s1", ""));
  });

  it("Escape 取消且 blur 不提交，IME Enter 不提交，正常 blur 提交", async () => {
    const onRename = vi.fn(async () => undefined);
    render(<Sidebar {...props({ tree: rowTree, onRename })} />);
    const start = () => {
      fireEvent.click(screen.getAllByRole("button", { name: "会话菜单" })[0] as HTMLElement);
      fireEvent.click(screen.getByText("重命名"));
      return screen.getByRole("textbox", { name: "重命名会话" });
    };
    let field = start();
    fireEvent.change(field, { target: { value: "取消" } });
    fireEvent.keyDown(field, { key: "Escape" });
    expect(onRename).not.toHaveBeenCalled();
    field = start();
    fireEvent.change(field, { target: { value: "新名字" } });
    fireEvent.compositionStart(field);
    fireEvent.keyDown(field, { key: "Enter", isComposing: true });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onRename).not.toHaveBeenCalled();
    fireEvent.compositionEnd(field);
    fireEvent.keyDown(field, { key: "Enter", keyCode: 229 });
    expect(onRename).not.toHaveBeenCalled();
    fireEvent.blur(field);
    await waitFor(() => expect(onRename).toHaveBeenCalledExactlyOnceWith("s1", "新名字"));
  });

  it("重命名失败保持原标题，在原行报错；锁冲突用明确文案", async () => {
    const onRename = vi.fn().mockRejectedValue({ code: "session_locked" });
    render(<Sidebar {...props({ tree: rowTree, onRename })} />);
    fireEvent.contextMenu(screen.getByText("一号会话"));
    fireEvent.click(screen.getByText("重命名"));
    const field = screen.getByRole("textbox", { name: "重命名会话" });
    fireEvent.change(field, { target: { value: "失败名字" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe("这个会话正在别处打开，关掉后再改名"),
    );
    expect(screen.getByText("一号会话")).toBeTruthy();
    expect(screen.queryByText("失败名字")).toBeNull();
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

  const projectNode = (name: string) => ({
    key: `z:/${name}`,
    name,
    path: `Z:/${name}`,
    count: 0,
    sessions: [],
    moreCount: 0,
    manual: true,
  });
  /** jsdom 的拖放事件没有 dataTransfer，给一个最小替身 */
  const dataTransfer = () => ({ setData: vi.fn(), effectAllowed: "", dropEffect: "" });
  const threeProjects: SessionTree = {
    ...emptyTree,
    projects: [projectNode("a"), projectNode("b"), projectNode("c")],
  };

  it("排序菜单在手动模式勾选「手动」", () => {
    render(<Sidebar {...props({ projectSort: "manual" })} />);
    fireEvent.click(screen.getByTitle("项目菜单"));
    expect(screen.getByText("手动").querySelector(".ck")?.textContent).toBe("✓");
    expect(screen.getByText("名称").querySelector(".ck")?.textContent).toBe("");
  });

  it("手动模式右键项目「上移」「下移」回调插入位置，首项、末项对应项置灰", () => {
    const onMoveProject = vi.fn();
    render(<Sidebar {...props({ tree: threeProjects, projectSort: "manual", onMoveProject })} />);
    const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;

    fireEvent.contextMenu(screen.getByText("a"));
    expect(button("上移").disabled).toBe(true);
    expect(button("下移").disabled).toBe(false);
    fireEvent.click(button("下移"));
    expect(onMoveProject).toHaveBeenLastCalledWith("z:/a", 2);

    fireEvent.contextMenu(screen.getByText("c"));
    expect(button("下移").disabled).toBe(true);
    fireEvent.click(button("上移"));
    expect(onMoveProject).toHaveBeenLastCalledWith("z:/c", 1);

    fireEvent.contextMenu(screen.getByText("b"));
    expect(button("上移").disabled).toBe(false);
    expect(button("下移").disabled).toBe(false);
    expect(screen.getByText("从列表移除")).toBeTruthy();
  });

  it("名称、最近活动模式不显示上移下移，项目标题不可拖动", () => {
    for (const projectSort of ["name", "activity"] as const) {
      const { container } = render(<Sidebar {...props({ tree: threeProjects, projectSort })} />);
      fireEvent.contextMenu(screen.getByText("a"));
      expect(screen.getByText("从列表移除")).toBeTruthy();
      expect(screen.queryByText("上移")).toBeNull();
      expect(screen.queryByText("下移")).toBeNull();
      expect(container.querySelector('.gh[draggable="true"]')).toBeNull();
      cleanup();
    }
  });

  it("手动模式拖动项目标题：dragstart → dragover 显示指示线 → drop 回调新位置", () => {
    const onMoveProject = vi.fn();
    const onToggleCollapse = vi.fn();
    const { container } = render(
      <Sidebar
        {...props({ tree: threeProjects, projectSort: "manual", onMoveProject, onToggleCollapse })}
      />,
    );
    const groups = [...container.querySelectorAll(".grp")];
    const header = groups[0]?.querySelector(".gh");
    if (header === null || header === undefined) throw new Error("缺少项目标题");
    expect(header.getAttribute("draggable")).toBe("true");
    fireEvent.dragStart(header, { dataTransfer: dataTransfer() });
    // jsdom 的 rect 全为 0：clientY 0 落在下半区 → 插到 c 后面（可见下标 3）
    const target = groups[2];
    if (target === undefined) throw new Error("缺少目标项目");
    fireEvent.dragOver(target, { clientY: 0, dataTransfer: dataTransfer() });
    expect(target.classList.contains("drop-after")).toBe(true);
    fireEvent.drop(target, { clientY: 0, dataTransfer: dataTransfer() });
    expect(onMoveProject).toHaveBeenCalledWith("z:/a", 3);
    expect(container.querySelector(".drop-after, .drop-before, .dragging")).toBeNull();
    expect(onToggleCollapse).not.toHaveBeenCalled();
  });

  it("拖到原位置不回调", () => {
    const onMoveProject = vi.fn();
    const { container } = render(
      <Sidebar {...props({ tree: threeProjects, projectSort: "manual", onMoveProject })} />,
    );
    const groups = [...container.querySelectorAll(".grp")];
    const header = groups[0]?.querySelector(".gh");
    if (header === null || header === undefined) throw new Error("缺少项目标题");
    fireEvent.dragStart(header, { dataTransfer: dataTransfer() });
    // 落在 a 自己的下半区 → 插入下标 1，等于原位
    const self = groups[0];
    if (self === undefined) throw new Error("缺少项目");
    fireEvent.dragOver(self, { clientY: 0, dataTransfer: dataTransfer() });
    expect(container.querySelector(".drop-after, .drop-before")).toBeNull();
    fireEvent.drop(self, { clientY: 0, dataTransfer: dataTransfer() });
    expect(onMoveProject).not.toHaveBeenCalled();
  });
});
