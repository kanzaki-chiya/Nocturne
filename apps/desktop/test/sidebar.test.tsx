import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Sidebar, type SidebarProps } from "../src/Sidebar";
import {
  buildSessionTree,
  DEFAULT_LIMIT,
  EXPAND_STEP,
  type SessionSummary,
  type SessionTree,
} from "../src/session-tree";

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

  it("设置导航在「MCP」之后包含「插件」，点击进入 plugins 页", () => {
    const onOpenPage = vi.fn();
    render(<Sidebar {...props({ page: "general", onOpenPage })} />);
    const nav = screen.getByRole("navigation", { name: "设置" });
    const labels = [...nav.querySelectorAll("button")].map((b) => b.textContent?.trim());
    const mcpIdx = labels.indexOf("MCP");
    const pluginsIdx = labels.indexOf("插件");
    expect(mcpIdx).toBeGreaterThanOrEqual(0);
    expect(pluginsIdx).toBe(mcpIdx + 1);
    fireEvent.click(within(nav).getByRole("button", { name: "插件" }));
    expect(onOpenPage).toHaveBeenCalledWith("plugins");
  });

  it("设置导航在「技能」之前包含「记忆」，点击进入 memory 页", () => {
    const onOpenPage = vi.fn();
    render(<Sidebar {...props({ page: "general", onOpenPage })} />);
    const nav = screen.getByRole("navigation", { name: "设置" });
    const labels = [...nav.querySelectorAll("button")].map((b) => b.textContent?.trim());
    const memoryIdx = labels.indexOf("记忆");
    const skillsIdx = labels.indexOf("技能");
    expect(memoryIdx).toBeGreaterThanOrEqual(0);
    expect(skillsIdx).toBe(memoryIdx + 1);
    fireEvent.click(within(nav).getByRole("button", { name: "记忆" }));
    expect(onOpenPage).toHaveBeenCalledWith("memory");
  });

  it("新会话下方是定时任务入口，显示启用数", () => {
    const onOpenSchedules = vi.fn();
    const { container } = render(
      <Sidebar {...props({ enabledScheduleCount: 3, onOpenSchedules, schedulesOpen: true })} />,
    );
    const buttons = [...container.querySelectorAll(".nav .item")];
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
      "归档",
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

  it("会话菜单在重命名后提供「归档」，点击立即归档且不再显示菜单", () => {
    const onArchive = vi.fn();
    render(<Sidebar {...props({ tree: rowTree, onArchive })} />);
    fireEvent.click(screen.getAllByRole("button", { name: "会话菜单" })[0] as HTMLElement);
    fireEvent.click(screen.getByText("归档"));
    expect(onArchive).toHaveBeenCalledWith("s1");
    expect(screen.queryByText("归档")).toBeNull();
  });

  it("运行中、等待确认和别处持有的会话禁用「归档」", () => {
    const running: SessionTree = {
      ...emptyTree,
      chats: {
        rows: [
          { id: "run", title: "运行会话", meta: "现在", locked: false, status: "running" },
          { id: "wait", title: "等待会话", meta: "现在", locked: false, status: "pending" },
          { id: "locked", title: "锁定会话", meta: "现在", locked: true, status: "idle" },
          { id: "idle", title: "空闲会话", meta: "现在", locked: false, status: "idle" },
        ],
        moreCount: 0,
      },
    };
    const onArchive = vi.fn();
    render(<Sidebar {...props({ tree: running, onArchive })} />);
    const archiveFor = (title: string) => {
      const row = screen.getByText(title).closest(".irow");
      if (row === null) throw new Error("缺少会话行");
      const menu = row.querySelector<HTMLButtonElement>(".imenu");
      if (menu === null) throw new Error("缺少会话菜单");
      fireEvent.click(menu);
      return screen.getByRole("button", { name: "归档" }) as HTMLButtonElement;
    };
    expect(archiveFor("运行会话").disabled).toBe(true);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(archiveFor("等待会话").disabled).toBe(true);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(archiveFor("锁定会话").disabled).toBe(true);
    fireEvent.keyDown(document, { key: "Escape" });
    const idle = archiveFor("空闲会话");
    expect(idle.disabled).toBe(false);
    fireEvent.click(idle);
    expect(onArchive).toHaveBeenCalledWith("idle");
  });

  it("设置导航顺序：常规、外观、服务商、模型、子代理、记忆、技能、MCP、插件、浏览器、电脑操控、授权、远程、已归档的会话、用量、后台日志", () => {
    render(<Sidebar {...props({ page: "general" })} />);
    const nav = screen.getByRole("navigation", { name: "设置" });
    const labels = [...nav.querySelectorAll("button.item")].map((button) => button.textContent);
    expect(labels).toEqual([
      "常规",
      "外观",
      "服务商",
      "模型",
      "子代理",
      "记忆",
      "技能",
      "MCP",
      "插件",
      "浏览器",
      "电脑操控",
      "授权",
      "远程",
      "已归档的会话",
      "用量",
      "后台日志",
    ]);
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

  it("外部 agent 创建的会话在标题旁显示来源小图标，悬停属性为 agent 名称且不加文字标签（ADR-0074 §5）", () => {
    const tree: SessionTree = {
      ...emptyTree,
      chats: {
        rows: [
          {
            id: "s-agent",
            title: "重构登录流程",
            meta: "现在",
            locked: false,
            status: "idle",
            client: { kind: "agent", deviceId: "ag-1", name: "Claude Code" },
          },
        ],
        moreCount: 0,
      },
    };
    const { container } = render(<Sidebar {...props({ tree })} />);
    const icon = container.querySelector(".session-client-icon");
    expect(icon).not.toBeNull();
    expect(icon?.getAttribute("title")).toBe("Claude Code");
    expect(icon?.getAttribute("aria-label")).toBe("Claude Code");
    const row = container.querySelector(".irow");
    expect(row?.getAttribute("data-client-name")).toBe("Claude Code");
    expect(row?.textContent).not.toContain("Claude Code");
  });

  it("不渲染侧栏品牌头，会话行不显示状态点与时间，仅保留待确认/出错/已完成标签", () => {
    const tree: SessionTree = {
      ...emptyTree,
      chats: {
        rows: [
          { id: "c1", title: "普通会话", meta: "昨天", locked: false, status: "idle" },
          { id: "c2", title: "待确认会话", meta: "刚刚", locked: false, status: "pending" },
        ],
        moreCount: 0,
      },
    };
    const { container } = render(<Sidebar {...props({ tree })} />);
    expect(container.querySelector(".shead")).toBeNull();
    expect(container.querySelectorAll(".irow .dot")).toHaveLength(0);
    expect(container.querySelectorAll(".irow .meta")).toHaveLength(0);
    expect(screen.queryByText("昨天")).toBeNull();
    expect(screen.queryByText("刚刚")).toBeNull();
    expect(screen.getByText("待确认")).toBeTruthy();
  });

  it("运行中会话行（含选中行与置顶/项目/定时任务组）在末尾显示转圈且不加文字说明；待确认优先于转圈", () => {
    const tree: SessionTree = {
      ...emptyTree,
      pinned: [
        {
          id: "p-run",
          title: "置顶运行",
          meta: "",
          locked: false,
          status: "running",
          project: "alpha",
        },
      ],
      chats: {
        rows: [
          { id: "c-run", title: "当前运行", meta: "", locked: false, status: "running" },
          { id: "c-pend", title: "等待确认", meta: "", locked: false, status: "pending" },
          { id: "c-idle", title: "空闲会话", meta: "", locked: false, status: "idle" },
        ],
        moreCount: 0,
      },
      projects: [
        {
          key: "beta",
          name: "beta",
          path: "/beta",
          count: 1,
          sessions: [
            { id: "proj-run", title: "项目运行", meta: "", locked: false, status: "running" },
          ],
          moreCount: 0,
          manual: false,
        },
      ],
      scheduled: {
        rows: [{ id: "s-run", title: "定时运行", meta: "", locked: false, status: "running" }],
        moreCount: 0,
      },
    };
    const { container } = render(<Sidebar {...props({ tree, selectedId: "c-run" })} />);
    const spins = container.querySelectorAll(".irow .row-spin");
    expect(spins).toHaveLength(4);
    for (const spin of spins) {
      expect(spin.getAttribute("aria-label")).toBe("运行中");
      expect(spin.textContent).toBe("");
      expect(spin.getAttribute("title")).toBeNull();
    }
    const pendingRow = screen.getByText("等待确认").closest(".irow");
    expect(pendingRow?.querySelector(".row-spin")).toBeNull();
    expect(pendingRow?.textContent).toContain("待确认");
    const idleRow = screen.getByText("空闲会话").closest(".irow");
    expect(idleRow?.querySelector(".row-spin")).toBeNull();
    expect(idleRow?.querySelector(".tag")).toBeNull();
  });

  it("分批展开：点一次多 20 个，不足 20 时全部显示且按钮消失，「收起」回到 5 个", () => {
    const WS = "Z:\\plain";
    const NOW = new Date("2026-10-04T12:00:00").getTime();
    const mk = (id: string, cwd: string, i: number, sched = false): SessionSummary => ({
      id,
      createdAt: "2026-10-01T00:00:00Z",
      cwd,
      workspaceRoot: cwd,
      model: { provider: "p", model: "m" },
      mtimeMs: NOW - i * 1000,
      firstText: `会话-${id}`,
      ...(sched
        ? {
            schedule: {
              taskId: "t1",
              scheduledAt: "2026-10-04T11:00:00Z",
              trigger: "schedule" as const,
            },
          }
        : {}),
    });
    const sessions: SessionSummary[] = [
      ...Array.from({ length: 30 }, (_, i) => mk(`c${i}`, WS, i)),
      ...Array.from({ length: 30 }, (_, i) => mk(`p${i}`, "Z:\\repo", i)),
      ...Array.from({ length: 30 }, (_, i) => mk(`s${i}`, "Z:\\repo", i, true)),
    ];

    function PagedHarness() {
      const [chatsLimit, setChatsLimit] = useState(DEFAULT_LIMIT);
      const [scheduledLimit, setScheduledLimit] = useState(DEFAULT_LIMIT);
      const [projectLimits, setProjectLimits] = useState<ReadonlyMap<string, number>>(
        () => new Map(),
      );
      const tree = buildSessionTree(
        sessions,
        { pinned: [], projects: [], hidden: [] },
        {
          plainWorkspace: WS,
          chatsLimit,
          scheduledLimit,
          projectLimits,
          collapsed: new Set(),
          now: NOW,
        },
      );
      return (
        <Sidebar
          {...props({
            tree,
            onExpandChats: () => {
              setChatsLimit((n) => n + EXPAND_STEP);
            },
            onCollapseChats: () => {
              setChatsLimit(DEFAULT_LIMIT);
            },
            onExpandScheduled: () => {
              setScheduledLimit((n) => n + EXPAND_STEP);
            },
            onCollapseScheduled: () => {
              setScheduledLimit(DEFAULT_LIMIT);
            },
            onExpandProject: (key) => {
              setProjectLimits((map) => {
                const next = new Map(map);
                next.set(key, (next.get(key) ?? DEFAULT_LIMIT) + EXPAND_STEP);
                return next;
              });
            },
            onCollapseProject: (key) => {
              setProjectLimits((map) => {
                const next = new Map(map);
                next.delete(key);
                return next;
              });
            },
          })}
        />
      );
    }

    const { container } = render(<PagedHarness />);
    const chatsNav = container.querySelector(".tree > .nav") as HTMLElement;
    const schedNav = screen.getByRole("navigation", { name: "定时任务会话" });
    const projNav = container.querySelector(".grp .nav.sub") as HTMLElement;

    // 初始各 5 条，无「收起」
    expect(chatsNav.querySelectorAll(".irow")).toHaveLength(5);
    expect(within(chatsNav).getByText("展开显示（还有 25 个）")).toBeTruthy();
    expect(within(chatsNav).queryByText("收起")).toBeNull();

    expect(schedNav.querySelectorAll(".irow")).toHaveLength(5);
    expect(within(schedNav).getByText("展开显示（还有 25 个）")).toBeTruthy();
    expect(within(schedNav).queryByText("收起")).toBeNull();

    expect(projNav.querySelectorAll(".irow")).toHaveLength(5);
    expect(within(projNav).getByText("展开显示（还有 25 个）")).toBeTruthy();
    expect(within(projNav).queryByText("收起")).toBeNull();

    // 对话、定时任务、项目各自点一次：变成 25 条，显示「还有 5 个」和「收起」
    fireEvent.click(within(chatsNav).getByText("展开显示（还有 25 个）"));
    expect(chatsNav.querySelectorAll(".irow")).toHaveLength(25);
    expect(within(chatsNav).getByText("展开显示（还有 5 个）")).toBeTruthy();
    expect(within(chatsNav).getByText("收起")).toBeTruthy();

    fireEvent.click(within(schedNav).getByText("展开显示（还有 25 个）"));
    expect(schedNav.querySelectorAll(".irow")).toHaveLength(25);
    expect(within(schedNav).getByText("展开显示（还有 5 个）")).toBeTruthy();
    expect(within(schedNav).getByText("收起")).toBeTruthy();

    fireEvent.click(within(projNav).getByText("展开显示（还有 25 个）"));
    expect(projNav.querySelectorAll(".irow")).toHaveLength(25);
    expect(within(projNav).getByText("展开显示（还有 5 个）")).toBeTruthy();
    expect(within(projNav).getByText("收起")).toBeTruthy();

    // 再点一次：剩余 5 个不足 20，全部显示且「展开显示」消失
    fireEvent.click(within(projNav).getByText("展开显示（还有 5 个）"));
    expect(projNav.querySelectorAll(".irow")).toHaveLength(30);
    expect(within(projNav).queryByText(/展开显示/)).toBeNull();
    expect(within(projNav).getByText("收起")).toBeTruthy();

    // 点「收起」回到 5 个
    fireEvent.click(within(projNav).getByText("收起"));
    expect(projNav.querySelectorAll(".irow")).toHaveLength(5);
    expect(within(projNav).getByText("展开显示（还有 25 个）")).toBeTruthy();
    expect(within(projNav).queryByText("收起")).toBeNull();

    fireEvent.click(within(chatsNav).getByText("收起"));
    expect(chatsNav.querySelectorAll(".irow")).toHaveLength(5);
    fireEvent.click(within(schedNav).getByText("收起"));
    expect(schedNav.querySelectorAll(".irow")).toHaveLength(5);
  });

  const multiTree = (): SessionTree => ({
    ...emptyTree,
    pinned: [
      { id: "pin-1", title: "置顶一", meta: "", locked: false, status: "idle", project: "alpha" },
      { id: "pin-2", title: "置顶二", meta: "", locked: false, status: "idle", project: "alpha" },
    ],
    chats: {
      rows: [
        { id: "chat-1", title: "对话一", meta: "", locked: false, status: "idle" },
        { id: "chat-2", title: "对话二", meta: "", locked: false, status: "running" },
        { id: "chat-3", title: "对话三", meta: "", locked: false, status: "pending" },
        { id: "chat-4", title: "对话四", meta: "", locked: false, status: "idle" },
      ],
      moreCount: 0,
    },
    projects: [
      {
        key: "alpha",
        name: "alpha",
        path: "Z:\\alpha",
        count: 2,
        sessions: [
          { id: "proj-1", title: "项目一", meta: "", locked: false, status: "idle" },
          { id: "proj-2", title: "项目二", meta: "", locked: false, status: "idle" },
        ],
        moreCount: 0,
        manual: false,
      },
    ],
    scheduled: {
      rows: [
        { id: "sched-1", title: "定时一", meta: "", locked: false, status: "idle" },
        { id: "sched-2", title: "定时二", meta: "", locked: false, status: "idle" },
      ],
      moreCount: 0,
    },
  });

  const rowBtn = (title: string): HTMLButtonElement => {
    const btn = screen.getByText(title).closest("button");
    if (!(btn instanceof HTMLButtonElement)) {
      throw new Error(`Expected button row for "${title}"`);
    }
    return btn;
  };

  it("Ctrl/Cmd 加选与取消、普通单击清空多选并打开会话", () => {
    const onSelectSession = vi.fn();
    render(<Sidebar {...props({ tree: multiTree(), selectedId: "chat-1", onSelectSession })} />);

    const pin1 = rowBtn("置顶一");
    const chat4 = rowBtn("对话四");
    const proj1 = rowBtn("项目一");
    const sched1 = rowBtn("定时一");

    fireEvent.click(pin1, { ctrlKey: true });
    fireEvent.click(chat4, { metaKey: true });
    fireEvent.click(proj1, { ctrlKey: true });
    fireEvent.click(sched1, { ctrlKey: true });

    expect(onSelectSession).not.toHaveBeenCalled();
    expect(pin1.classList.contains("msel")).toBe(true);
    expect(chat4.classList.contains("msel")).toBe(true);
    expect(proj1.classList.contains("msel")).toBe(true);
    expect(sched1.classList.contains("msel")).toBe(true);

    // 再 Ctrl 单击取消其中一行
    fireEvent.click(chat4, { ctrlKey: true });
    expect(chat4.classList.contains("msel")).toBe(false);
    expect(pin1.classList.contains("msel")).toBe(true);

    // 普通单击清空多选并打开会话
    fireEvent.click(sched1);
    expect(onSelectSession).toHaveBeenCalledTimes(1);
    expect(onSelectSession).toHaveBeenCalledWith("sched-1");
    expect(pin1.classList.contains("msel")).toBe(false);
    expect(proj1.classList.contains("msel")).toBe(false);
    expect(sched1.classList.contains("msel")).toBe(false);
  });

  it("Shift 范围选只在同组已显示行内生效，跨组只选被点的行", () => {
    const onSelectSession = vi.fn();
    render(<Sidebar {...props({ tree: multiTree(), onSelectSession })} />);

    const chat1 = rowBtn("对话一");
    const chat2 = rowBtn("对话二");
    const chat3 = rowBtn("对话三");
    const chat4 = rowBtn("对话四");
    const proj1 = rowBtn("项目一");
    const proj2 = rowBtn("项目二");

    // 先 Ctrl 选中 chat1 作为锚点，再 Shift 选到 chat4
    fireEvent.click(chat1, { ctrlKey: true });
    fireEvent.click(chat4, { shiftKey: true });
    expect(chat1.classList.contains("msel")).toBe(true);
    expect(chat2.classList.contains("msel")).toBe(true);
    expect(chat3.classList.contains("msel")).toBe(true);
    expect(chat4.classList.contains("msel")).toBe(true);

    // 跨组 Shift 点击 proj2：清空之前范围，只选中 proj2
    fireEvent.click(proj2, { shiftKey: true });
    expect(chat1.classList.contains("msel")).toBe(false);
    expect(chat4.classList.contains("msel")).toBe(false);
    expect(proj1.classList.contains("msel")).toBe(false);
    expect(proj2.classList.contains("msel")).toBe(true);
    expect(onSelectSession).not.toHaveBeenCalled();
  });

  it("Esc 清空多选，焦点在输入框里时不处理", () => {
    render(
      <div>
        <input aria-label="草稿输入框" />
        <Sidebar {...props({ tree: multiTree() })} />
      </div>,
    );

    const chat1 = rowBtn("对话一");
    const chat4 = rowBtn("对话四");
    fireEvent.click(chat1, { ctrlKey: true });
    fireEvent.click(chat4, { ctrlKey: true });
    expect(chat1.classList.contains("msel")).toBe(true);
    expect(chat4.classList.contains("msel")).toBe(true);

    // 焦点在输入框时不清空
    const input = screen.getByLabelText("草稿输入框");
    input.focus();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(chat1.classList.contains("msel")).toBe(true);
    expect(chat4.classList.contains("msel")).toBe(true);

    // 焦点离开输入框后 Esc 清空
    input.blur();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(chat1.classList.contains("msel")).toBe(false);
    expect(chat4.classList.contains("msel")).toBe(false);
  });

  it("批量菜单统计不含运行中与待确认；N 为 0 时禁用；在未选中行上右键回到单个菜单", () => {
    const { container } = render(
      <Sidebar {...props({ tree: multiTree(), archiveBlocked: new Set(["chat-4"]) })} />,
    );

    const chat1 = rowBtn("对话一");
    const chat2 = rowBtn("对话二"); // running
    const chat3 = rowBtn("对话三"); // pending
    const proj1 = rowBtn("项目一");

    // 选中 running + pending -> N = 0 禁用且有悬停原因
    fireEvent.click(chat2, { ctrlKey: true });
    fireEvent.click(chat3, { ctrlKey: true });
    fireEvent.contextMenu(chat2, { clientX: 20, clientY: 30 });
    const zeroBtn = screen.getByRole("button", { name: "归档 0 个会话" }) as HTMLButtonElement;
    expect(zeroBtn.disabled).toBe(true);
    expect(zeroBtn.getAttribute("title")).toBeTruthy();

    // 关闭菜单，再加选 chat1 与 archiveBlocked 的 chat4 -> N = 1
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(chat1, { ctrlKey: true });
    const chat4 = rowBtn("对话四");
    fireEvent.click(chat4, { ctrlKey: true });
    const chat1MenuBtn = within(chat1.closest(".irow") as HTMLElement).getByRole("button", {
      name: "会话菜单",
    });
    fireEvent.click(chat1MenuBtn);
    const oneBtn = screen.getByRole("button", { name: "归档 1 个会话" }) as HTMLButtonElement;
    expect(oneBtn.disabled).toBe(false);
    expect(container.querySelectorAll(".ctxmenu button")).toHaveLength(1);

    // 在未选中的行上右键：清空多选，弹出单个会话菜单
    fireEvent.contextMenu(proj1, { clientX: 40, clientY: 50 });
    expect(chat1.classList.contains("msel")).toBe(false);
    expect(screen.queryByText(/归档 .* 个会话/)).toBeNull();
    expect(screen.getByRole("button", { name: "置顶" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "重命名" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "归档" })).toBeTruthy();
  });

  it("批量归档逐个调用并跳过不可归档行，部分失败时其余照常归档并最终清空多选", async () => {
    const calls: string[] = [];
    const onArchive = vi.fn(async (id: string) => {
      calls.push(id);
      if (id === "pin-1") throw new Error("archive failed");
    });

    render(<Sidebar {...props({ tree: multiTree(), onArchive })} />);

    const pin1 = rowBtn("置顶一");
    const chat1 = rowBtn("对话一");
    const chat2 = rowBtn("对话二"); // running
    const proj1 = rowBtn("项目一");

    fireEvent.click(pin1, { ctrlKey: true });
    fireEvent.click(chat1, { ctrlKey: true });
    fireEvent.click(chat2, { ctrlKey: true });
    fireEvent.click(proj1, { ctrlKey: true });

    fireEvent.contextMenu(chat1, { clientX: 10, clientY: 20 });
    fireEvent.click(screen.getByRole("button", { name: "归档 3 个会话" }));

    await waitFor(() => {
      expect(calls).toEqual(["pin-1", "chat-1", "proj-1"]);
    });
    expect(pin1.classList.contains("msel")).toBe(false);
    expect(chat1.classList.contains("msel")).toBe(false);
    expect(chat2.classList.contains("msel")).toBe(false);
    expect(proj1.classList.contains("msel")).toBe(false);
  });
});
