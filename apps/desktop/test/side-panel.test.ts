/** 右侧面板的纯逻辑（ADR-0060）：宽度、标签恢复、快速打开、变更汇总、地址栏、终端 shell。 */
import { describe, expect, it } from "vitest";
import type { TurnChanges } from "@nocturne/core/protocol";

import {
  buildChangeTree,
  clampPanelWidth,
  collectChanges,
  dirName,
  fileTabLabel,
  groupChanges,
  isNetworkPath,
  moveTab,
  nextActiveAfterClose,
  PANEL_MAX_WIDTH,
  PANEL_MIN_WIDTH,
  panelOverlays,
  parseAddress,
  parseStoredTabs,
  projectFits,
  rankQuickOpen,
  relativeTo,
  restoreTabs,
  sessionChangeTotals,
  storedTabs,
  terminalShell,
  type FileTab,
  type PanelTab,
} from "../src/side-panel";

const file = (id: string, path: string, extra?: Partial<FileTab>): FileTab => ({
  id,
  kind: "file",
  workspace: "Z:\\p",
  absolutePath: `Z:\\p\\${path}`,
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
  it("恢复文件与变更标签和选中项；新标签页、终端与定位计数不存", () => {
    const tabs: PanelTab[] = [
      { id: "n", kind: "new" },
      { id: "c", kind: "changes", focusSeq: 3, focusNonce: 2 },
      file("f", "a.ts", { line: 4, focusNonce: 9 }),
      { id: "t", kind: "terminal", cwd: "Z:\\p", label: "p" },
    ];
    const stored = storedTabs(tabs);
    expect(stored).toEqual([
      { id: "c", kind: "changes" },
      { id: "f", kind: "file", workspace: "Z:\\p", absolutePath: "Z:\\p\\a.ts", line: 4 },
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
    expect(restored.tabs[0]).toMatchObject({ kind: "file", absolutePath: "Z:\\p\\deleted.ts" });
  });
  it("第 1 轮存下的文件标签（带 sessionId / relativePath）照常恢复；工作区外的没有 workspace", () => {
    expect(
      parseStoredTabs([
        {
          id: "old",
          kind: "file",
          workspace: "Z:\\p",
          sessionId: "s1",
          absolutePath: "Z:\\p\\a.ts",
          relativePath: "a.ts",
        },
        { id: "out", kind: "file", absolutePath: "D:\\notes\\x.md" },
        { id: "rel", kind: "file", absolutePath: "a.ts" },
      ]),
    ).toEqual([
      { id: "old", kind: "file", workspace: "Z:\\p", absolutePath: "Z:\\p\\a.ts" },
      { id: "out", kind: "file", absolutePath: "D:\\notes\\x.md" },
    ]);
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
    const files = groupChanges(collectChanges(turns, [1, 7]));
    const tree = buildChangeTree(files, (f) => f.path.replace("Z:\\p\\", ""));
    expect(tree.children.map((c) => (c.kind === "dir" ? `${c.name}/` : c.name))).toEqual([
      "src/",
      "README.md",
    ]);
  });
  it("同一文件多轮合并成一行：行数合计未撤销的轮，展开按新到旧列出各轮", () => {
    const multi = [
      { seq: 1, files: [{ path: "Z:\\p\\a.ts", added: 3, removed: 1, status: "added" }] },
      { seq: 4, files: [{ path: "Z:\\p\\a.ts", added: 9, removed: 9 }], reverted: { at: 1 } },
      {
        seq: 7,
        files: [
          { path: "Z:\\p\\a.ts", added: 2, removed: 5 },
          { path: "Z:\\p\\b.ts", added: 1, removed: 0 },
        ],
      },
    ] as unknown as TurnChanges[];
    const files = groupChanges(collectChanges(multi, [1, 4, 7]));
    expect(files.map((f) => f.path)).toEqual(["Z:\\p\\a.ts", "Z:\\p\\b.ts"]);
    const [a, b] = files;
    expect(a).toMatchObject({ added: 5, removed: 6, status: "added", reverted: false });
    expect(a?.rounds.map((r) => [r.round, r.reverted])).toEqual([
      [3, false],
      [2, true],
      [1, false],
    ]);
    expect(b?.rounds).toHaveLength(1);
    // 全部撤销时合计全部并标记
    const allReverted = groupChanges(
      collectChanges(
        [
          { seq: 2, files: [{ path: "x", added: 1, removed: 2 }], reverted: { at: 1 } },
        ] as unknown as TurnChanges[],
        [2],
      ),
    );
    expect(allReverted[0]).toMatchObject({ added: 1, removed: 2, reverted: true });
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
    expect(parseAddress("\\\\server\\share\\a.html", undefined).kind).toBe("invalid");
    expect(parseAddress("poster.html", undefined).kind).toBe("invalid");
  });
});

describe("文件标签的路径显示", () => {
  it("工作区内显示项目名与相对路径，工作区外显示所在目录名", () => {
    expect(fileTabLabel({ absolutePath: "Z:\\p\\src\\a.ts", workspace: "Z:\\p" })).toEqual({
      name: "a.ts",
      scope: "p",
      path: "src/a.ts",
    });
    expect(fileTabLabel({ absolutePath: "D:\\notes\\week\\x.md" })).toEqual({
      name: "x.md",
      scope: "week",
      path: "x.md",
    });
    expect(relativeTo("Z:\\p", "z:\\P\\a.ts")).toBe("a.ts");
    expect(relativeTo("Z:\\p", "Z:\\pp\\a.ts")).toBeUndefined();
    expect(dirName("D:\\notes\\x.md")).toBe("D:\\notes");
  });
  it("网络路径只按词法判断", () => {
    expect(isNetworkPath("\\\\127.0.0.1\\c$\\x")).toBe(true);
    expect(isNetworkPath("//host/share")).toBe(true);
    expect(isNetworkPath("\\\\?\\UNC\\host\\share")).toBe(true);
    expect(isNetworkPath("\\\\?\\C:\\x")).toBe(false);
    expect(isNetworkPath("C:\\x")).toBe(false);
  });
});

describe("窄标签的项目名", () => {
  it("文件名之后放得下整个项目名才显示", () => {
    expect(projectFits(120, 50, 40)).toBe(true);
    expect(projectFits(90, 50, 40)).toBe(false);
    expect(projectFits(96, 50, 40)).toBe(true);
  });
});

describe("终端默认 shell", () => {
  const shells = [
    {
      kind: "powershell",
      name: "Windows PowerShell",
      executable: "C:\\W\\powershell.exe",
      available: true,
    },
    { kind: "cmd", name: "cmd", executable: "C:\\W\\cmd.exe", available: true },
    { kind: "bash", name: "Git Bash", executable: "C:\\Git\\bin\\bash.exe", available: true },
    { kind: "pwsh", name: "PowerShell 7", available: false },
  ];
  it("按 auto 顺序选第一个可用的；换过的仍可用就保留", () => {
    expect(terminalShell(shells)?.kind).toBe("bash");
    expect(terminalShell(shells, "c:\\w\\CMD.exe")?.kind).toBe("cmd");
    expect(terminalShell(shells, "C:\\gone\\pwsh.exe")?.kind).toBe("bash");
    expect(terminalShell([])).toBeUndefined();
  });
});
