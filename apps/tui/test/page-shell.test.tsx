/**
 * PageShell 组件测试（ADR-0045）：页头/双栏/底部布局、窄屏与矮屏退化、
 * 焦点切换、打字即过滤、ASCII 与鼠标。纯布局函数一并断言。
 */
import { render } from "ink-testing-library";
import { createElement } from "react";
import stringWidth from "string-width";
import { describe, expect, it, vi } from "vitest";

import { PageShell, type PageShellProps } from "../src/components/page/page-shell.js";
import {
  LEFT_W,
  pageLayout,
  planColumns,
  scrollTop,
  type ShellRow,
} from "../src/components/page/layout.js";
import type { DialogMouseFrame } from "../src/components/dialog/mouse.js";
import { TuiEnvContext } from "../src/env.js";

const GROUPS = [
  { id: "a", label: "会话默认" },
  { id: "b", label: "界面" },
  { id: "c", label: "执行" },
];
const ROWS: ShellRow[] = [
  {
    id: "preset",
    group: "a",
    cells: [{ text: "默认权限预设" }, { text: "smart", arrows: true }],
    trail: [{ text: "设置", tone: "muted" }],
  },
  {
    id: "reviewer",
    group: "a",
    cells: [{ text: "安全审查" }, { text: "Jev · zen" }],
    trail: [{ text: "设置", tone: "muted" }],
  },
  {
    id: "theme",
    group: "b",
    cells: [{ text: "主题" }, { text: "深色", arrows: true }],
    trail: [{ text: "默认", tone: "muted" }],
  },
  {
    id: "shell",
    group: "c",
    cells: [{ text: "Shell" }, { text: "pwsh" }],
    trail: [{ text: "设置", tone: "muted" }],
  },
];

const pause = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

function shell(overrides: Partial<PageShellProps> = {}, ascii = false) {
  const props: PageShellProps = {
    title: ["设置"],
    subtitle: "默认值对新会话生效",
    rows: ROWS,
    groups: GROUPS,
    sidebar: { items: GROUPS.map((g) => ({ id: g.id, label: g.label })), mode: "jump" },
    arrows: "adjust",
    describe: (row) =>
      row
        ? [
            [
              { text: row.id, tone: "secondary" },
              { text: "  说明", tone: "muted" },
            ],
          ]
        : [],
    hints: [
      ["↑↓", "移动"],
      ["Esc", "返回"],
    ],
    width: 80,
    height: 20,
    active: true,
    onClose: vi.fn(),
    ...overrides,
  };
  const ui = render(
    createElement(
      TuiEnvContext.Provider,
      { value: { ascii, animated: false } },
      createElement(PageShell, props),
    ),
  );
  return { ui, props };
}

const lines = (frame: string | undefined) => (frame ?? "").split("\n");
async function press(ui: ReturnType<typeof render>, data: string) {
  const before = ui.lastFrame();
  ui.stdin.write(data);
  await vi.waitFor(() => expect(ui.lastFrame()).not.toBe(before), { timeout: 2000, interval: 10 });
  await pause(10);
}
const selectedLine = (frame: string | undefined) => lines(frame).find((l) => l.includes("▌"));

describe("pageLayout", () => {
  it("完整形态：标题、说明、空行、列表、细线、两行说明、空行、提示", () => {
    const l = pageLayout({ width: 96, height: 26, sidebar: true, hasQuery: false });
    expect(l).toMatchObject({
      narrow: false,
      showSub: true,
      showExplain: true,
      bodyRow: 3,
      bodyH: 18,
      ruleRow: 21,
      explainRow: 22,
      hintRow: 25,
    });
  });
  it("高度不足依次去掉说明行、说明区", () => {
    const noSub = pageLayout({ width: 96, height: 11, sidebar: true, hasQuery: false });
    expect(noSub.showSub).toBe(false);
    expect(noSub.showExplain).toBe(true);
    const bare = pageLayout({ width: 96, height: 8, sidebar: true, hasQuery: false });
    expect(bare.showSub).toBe(false);
    expect(bare.showExplain).toBe(false);
    expect(bare.bodyRow + bare.bodyH).toBe(bare.hintRow);
  });
  it("宽度小于 72 列折叠左栏为分组条", () => {
    const l = pageLayout({ width: 71, height: 26, sidebar: true, hasQuery: false });
    expect(l.narrow).toBe(true);
    expect(l.stripRow).toBe(3);
    expect(l.bodyRow).toBe(4);
    expect(pageLayout({ width: 72, height: 26, sidebar: true, hasQuery: false }).narrow).toBe(
      false,
    );
  });
});

describe("planColumns / scrollTop", () => {
  it("名称列按全页最长名称对齐，放不下时只压缩第一列", () => {
    const plan = planColumns(ROWS, 60, false);
    expect(plan.widths[0]).toBe(12);
    const tight = planColumns(ROWS, 20, false);
    expect(tight.widths[0]).toBeLessThan(12);
    expect(tight.widths[1]).toBe(plan.widths[1]);
  });
  it("光标是组内第一项时连组名一起露出", () => {
    expect(scrollTop(10, 5, 4, 6, 30)).toBe(4);
    expect(scrollTop(0, 9, undefined, 6, 30)).toBe(4);
    expect(scrollTop(0, 0, undefined, 6, 3)).toBe(0);
  });
});

describe("PageShell 布局", () => {
  it("页头、双栏、竖线、选中样式与底部", () => {
    const { ui } = shell({ count: "4 项" });
    const rows = lines(ui.lastFrame());
    expect(rows[0]).toBe("设置  4 项");
    expect(rows[1]).toBe("默认值对新会话生效");
    // 左栏 18 列含竖线；右栏组名与条目
    expect(rows[3]?.startsWith("  会话默认")).toBe(true);
    expect(stringWidth(rows[3]?.slice(0, rows[3].indexOf("│")) ?? "")).toBe(LEFT_W - 1);
    const sel = selectedLine(ui.lastFrame());
    expect(sel).toContain("▌ 默认权限预设");
    expect(sel).toContain("‹ smart ›");
    expect(sel?.trimEnd().endsWith("设置")).toBe(true);
    // 细线在竖线位置画成 ┴
    const rule = rows.find((l) => l.startsWith("─"));
    expect(rule?.[LEFT_W - 1]).toBe("┴");
    // 说明区与提示行（键与动作成对，对间两格）
    expect(
      rows.some((l) => l.startsWith("默认权限预设  说明") || l.startsWith("preset  说明")),
    ).toBe(true);
    expect(rows.at(-1)).toBe("↑↓ 移动  Esc 返回");
    ui.unmount();
  });

  it("双栏时只有获得焦点的栏画选中样式", async () => {
    const { ui } = shell();
    expect(lines(ui.lastFrame()).filter((l) => l.includes("▌"))).toHaveLength(1);
    await press(ui, "\t");
    const marked = lines(ui.lastFrame()).filter((l) => l.includes("▌"));
    expect(marked).toHaveLength(1);
    expect(marked[0]?.startsWith("▌ 会话默认")).toBe(true);
    ui.unmount();
  });

  it("左栏移动：右栏光标跳到该组首项；Enter 回到右栏", async () => {
    const { ui } = shell();
    await press(ui, "\t");
    await press(ui, "\x1b[B");
    expect(lines(ui.lastFrame()).filter((l) => l.includes("▌"))).toHaveLength(1);
    await press(ui, "\x1b[B");
    await press(ui, "\r");
    expect(selectedLine(ui.lastFrame())).toContain("Shell");
    ui.unmount();
  });

  it("窄屏左栏折叠成 ‹ 分组 ›，Tab 切换分组", async () => {
    const { ui } = shell({ width: 60 });
    const rows = lines(ui.lastFrame());
    expect(rows.some((l) => l.includes("│"))).toBe(false);
    expect(rows[3]).toBe("‹ 会话默认 ›");
    await press(ui, "\t");
    expect(lines(ui.lastFrame())[3]).toBe("‹ 界面 ›");
    expect(selectedLine(ui.lastFrame())).toContain("主题");
    ui.unmount();
  });

  it("矮屏去掉说明行，再去掉说明区，始终保留标题、列表和提示", () => {
    const a = shell({ height: 10 });
    const rowsA = lines(a.ui.lastFrame());
    expect(rowsA).not.toContain("默认值对新会话生效");
    expect(rowsA.some((l) => l.startsWith("─"))).toBe(true);
    a.ui.unmount();
    const b = shell({ height: 7 });
    const rowsB = lines(b.ui.lastFrame());
    expect(rowsB[0]).toBe("设置");
    expect(rowsB.some((l) => l.startsWith("─"))).toBe(false);
    expect(rowsB.at(-1)).toBe("↑↓ 移动  Esc 返回");
    expect(selectedLine(b.ui.lastFrame())).toBeDefined();
    b.ui.unmount();
  });

  it("ASCII：> 代替 ▌，- 与 + 画细线，< > 代替 ‹ ›", () => {
    const { ui } = shell({}, true);
    const frame = ui.lastFrame() ?? "";
    expect(frame).not.toMatch(/[▌│─┴‹›]/);
    expect(frame).toContain("> 默认权限预设");
    expect(frame).toContain("< smart >");
    const rule = lines(frame).find((l) => l.startsWith("-"));
    expect(rule?.[LEFT_W - 1]).toBe("+");
    ui.unmount();
  });
});

describe("PageShell 按键", () => {
  it("←→ 在 adjust 模式下改值；focus 模式下切栏", async () => {
    const onAdjust = vi.fn();
    const a = shell({ onAdjust });
    a.ui.stdin.write("\x1b[C");
    a.ui.stdin.write("\x1b[D");
    await pause();
    expect(onAdjust.mock.calls).toEqual([
      ["preset", 1],
      ["preset", -1],
    ]);
    a.ui.unmount();
    const b = shell({ arrows: "focus" });
    await press(b.ui, "\x1b[D");
    expect(selectedLine(b.ui.lastFrame())?.startsWith("▌ 会话默认")).toBe(true);
    await press(b.ui, "\x1b[C");
    expect(selectedLine(b.ui.lastFrame())).toContain("默认权限预设");
    b.ui.unmount();
  });

  it("Enter 执行；↓ 移动并在末尾回绕", async () => {
    const onActivate = vi.fn();
    const { ui } = shell({ onActivate });
    ui.stdin.write("\r");
    await pause();
    expect(onActivate).toHaveBeenCalledWith("preset");
    for (let i = 0; i < 4; i++) await press(ui, "\x1b[B");
    expect(selectedLine(ui.lastFrame())).toContain("默认权限预设");
    ui.unmount();
  });

  it("打字即过滤，Esc 先清空查询再返回", async () => {
    const onClose = vi.fn();
    const { ui } = shell({ onClose });
    await press(ui, "主");
    const rows = lines(ui.lastFrame());
    expect(rows[2]).toContain("过滤: 主");
    expect(rows.some((l) => l.includes("安全审查"))).toBe(false);
    expect(selectedLine(ui.lastFrame())).toContain("主题");
    await press(ui, "\x7f");
    expect(lines(ui.lastFrame()).some((l) => l.includes("安全审查"))).toBe(true);
    await press(ui, "s");
    await press(ui, "\x1b");
    expect(lines(ui.lastFrame())[2]).not.toContain("过滤");
    expect(onClose).not.toHaveBeenCalled();
    ui.stdin.write("\x1b");
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1), { timeout: 1000 });
    ui.unmount();
  });

  it("页面叠了对话框（active=false）时不收键", async () => {
    const onClose = vi.fn();
    const { ui } = shell({ active: false, onClose });
    ui.stdin.write("\x1b");
    ui.stdin.write("a");
    await pause(60);
    expect(onClose).not.toHaveBeenCalled();
    expect(lines(ui.lastFrame())[2]).not.toContain("过滤");
    ui.unmount();
  });

  it("onKey 先于内置按键，notice 显示在说明区", async () => {
    const onKey = vi.fn((_input: string, key: { delete: boolean }) => key.delete);
    const { ui } = shell({
      onKey: onKey as PageShellProps["onKey"],
      notice: { text: "保存失败：disk", tone: "error" },
    });
    expect(ui.lastFrame()).toContain("保存失败：disk");
    ui.stdin.write("\x1b[3~");
    await pause();
    expect(onKey).toHaveBeenCalled();
    expect(lines(ui.lastFrame())[2]).not.toContain("过滤");
    ui.unmount();
  });
});

describe("PageShell 鼠标", () => {
  it("登记行与侧栏命中框；单击选中，再单击执行", async () => {
    let frame: DialogMouseFrame | undefined;
    const onActivate = vi.fn();
    const { ui } = shell({
      onMouseFrame: (f) => {
        frame = f;
      },
      onActivate,
    });
    await vi.waitFor(() => expect(frame).toBeDefined());
    const ids = frame?.boxes.map((b) => b.id) ?? [];
    expect(ids).toContain("row:theme");
    expect(ids).toContain("side:b");
    const click = (id: string) => {
      frame?.click(id, { type: "release", x: 1, y: 1, button: 0 } as never);
    };
    click("row:theme");
    await vi.waitFor(() => expect(selectedLine(ui.lastFrame())).toContain("主题"));
    await pause();
    click("row:theme");
    expect(onActivate).toHaveBeenCalledWith("theme");
    ui.unmount();
  });
});
