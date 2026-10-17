/** 右侧面板的纯逻辑（ADR-0060）：宽度、标签恢复、快速打开、变更汇总、地址栏。 */
import { describe, expect, it } from "vitest";
import type { TurnChanges } from "@nocturne/core/protocol";

import {
  buildChangeTree,
  clampPanelWidth,
  collectChanges,
  moveTab,
  nextActiveAfterClose,
  PANEL_MAX_WIDTH,
  PANEL_MIN_WIDTH,
  panelOverlays,
  parseAddress,
  rankQuickOpen,
  restoreTabs,
  sessionChangeTotals,
  storedTabs,
  type FileTab,
  type PanelTab,
} from "../src/side-panel";

const file = (id: string, path: string, extra?: Partial<FileTab>): FileTab => ({
  id,
  kind: "file",
  workspace: "Z:\\p",
  sessionId: "s1",
  absolutePath: `Z:\\p\\${path}`,
  relativePath: path,
  ...extra,
});

describe("面板宽度", () => {
  it("夹在上下限之间；窗口窄时上限让出对话区", () => {
    expect(clampPanelWidth(100)).toBe(PANEL_MIN_WIDTH);
    expect(clampPanelWidth(5000)).toBe(PANEL_MAX_WIDTH);
    expect(clampPanelWidth(Number.NaN)).toBe(520);
    expect(clampPanelWidth(900, 700)).toBe(540);
  });
  it("对话区不足 480px 时覆盖", () => {
    expect(panelOverlays(1400, 236, 520)).toBe(false);
    expect(panelOverlays(1100, 236, 520)).toBe(true);
  });
});

describe("标签恢复", () => {
  it("恢复文件与变更标签和选中项；新标签页与定位计数不存", () => {
    const tabs: PanelTab[] = [
      { id: "n", kind: "new" },
      { id: "c", kind: "changes", focusSeq: 3, focusNonce: 2 },
      file("f", "a.ts", { line: 4, focusNonce: 9 }),
    ];
    const stored = storedTabs(tabs);
    expect(stored).toEqual([
      { id: "c", kind: "changes" },
      {
        id: "f",
        kind: "file",
        workspace: "Z:\\p",
        sessionId: "s1",
        absolutePath: "Z:\\p\\a.ts",
        relativePath: "a.ts",
        line: 4,
      },
    ]);
    const restored = restoreTabs(stored, "f", () => "fresh");
    expect(restored.activeId).toBe("f");
    expect(restored.tabs.map((t) => t.kind)).toEqual(["changes", "file"]);
  });
  it("没有存过标签时给一个新标签页；选中项丢失时选第一个", () => {
    expect(restoreTabs(undefined, undefined, () => "x")).toEqual({
      tabs: [{ id: "x", kind: "new" }],
      activeId: "x",
    });
    expect(restoreTabs([{ id: "c", kind: "changes" }], "gone", () => "x").activeId).toBe("c");
  });
  it("文件已删除的标签照样恢复，由文件标签读取时显示「文件已不存在」", () => {
    const restored = restoreTabs(storedTabs([file("f", "deleted.ts")]), "f", () => "x");
    expect(restored.tabs).toHaveLength(1);
    expect(restored.tabs[0]).toMatchObject({ kind: "file", relativePath: "deleted.ts" });
  });
  it("拖动排序与关闭后的选中项", () => {
    const tabs = [file("a", "a"), file("b", "b"), file("c", "c")];
    expect(moveTab(tabs, "c", "a").map((t) => t.id)).toEqual(["c", "a", "b"]);
    expect(nextActiveAfterClose(tabs, "b", "b")).toBe("c");
    expect(nextActiveAfterClose(tabs, "c", "c")).toBe("b");
    expect(nextActiveAfterClose(tabs, "a", "c")).toBe("c");
  });
});

describe("快速打开排名", () => {
  const entries = [
    { path: "src/poster.css", kind: "file" as const },
    { path: "archive/poster-old.css", kind: "file" as const },
    { path: "maiyu-bakery-poster.html", kind: "file" as const },
    { path: "src/", kind: "directory" as const },
    { path: "docs/composer.md", kind: "file" as const },
  ];
  it("文件名前缀 > 文件名包含 > 路径按顺序匹配；不列目录", () => {
    expect(rankQuickOpen("pos", entries).map((h) => h.path)).toEqual([
      "src/poster.css",
      "archive/poster-old.css",
      "docs/composer.md",
      "maiyu-bakery-poster.html",
    ]);
    expect(rankQuickOpen("src", entries).some((h) => h.path === "src/")).toBe(false);
    expect(rankQuickOpen("pos", entries)[0]).toEqual({
      path: "src/poster.css",
      name: "poster.css",
      dir: "src/",
    });
  });
});

describe("变更汇总", () => {
  const turns = [
    { seq: 1, files: [{ path: "Z:\\p\\src\\a.ts", added: 3, removed: 1 }], untrackedCalls: 0 },
    {
      seq: 7,
      files: [
        { path: "Z:\\p\\src\\b.ts", added: 2, removed: 0 },
        { path: "Z:\\p\\README.md", added: 1, removed: 1 },
      ],
      untrackedCalls: 0,
    },
  ] as unknown as TurnChanges[];
  it("新的一轮在前，轮次按用户消息编号；累计行数", () => {
    const items = collectChanges(turns, [1, 7]);
    expect(items.map((i) => [i.round, i.path])).toEqual([
      [2, "Z:\\p\\README.md"],
      [2, "Z:\\p\\src\\b.ts"],
      [1, "Z:\\p\\src\\a.ts"],
    ]);
    expect(sessionChangeTotals(turns)).toEqual({ added: 6, removed: 2, files: 3 });
  });
  it("按目录折叠的文件树：目录在前", () => {
    const items = collectChanges(turns, [1, 7]);
    const tree = buildChangeTree(items, (i) => i.path.replace("Z:\\p\\", ""));
    expect(tree.children.map((c) => (c.kind === "dir" ? `${c.name}/` : c.name))).toEqual([
      "src/",
      "README.md",
    ]);
  });
});

describe("地址栏", () => {
  it("网址、裸域名、本机地址、HTML 路径；其他拒绝", () => {
    expect(parseAddress("https://example.com/a", undefined)).toEqual({
      kind: "url",
      url: "https://example.com/a",
    });
    expect(parseAddress("example.com", undefined)).toEqual({
      kind: "url",
      url: "https://example.com/",
    });
    expect(parseAddress("localhost:5173", undefined)).toEqual({
      kind: "url",
      url: "http://localhost:5173/",
    });
    expect(parseAddress("poster.html", "Z:\\p")).toEqual({
      kind: "path",
      path: "Z:\\p\\poster.html",
    });
    expect(parseAddress("D:\\site\\index.html", undefined)).toEqual({
      kind: "path",
      path: "D:\\site\\index.html",
    });
    expect(parseAddress("file:///D:/site/index.html", undefined)).toEqual({
      kind: "path",
      path: "D:/site/index.html",
    });
    expect(parseAddress("随便写点什么", undefined).kind).toBe("invalid");
    expect(parseAddress("poster.html", undefined).kind).toBe("invalid");
  });
});
