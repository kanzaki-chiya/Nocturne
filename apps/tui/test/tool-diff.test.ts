/**
 * 全屏布局中的文件改动展示（tui.md §4 diff 展示）：edit/覆盖 write 渲染
 * output.diff 的行号、折行、折叠及旧日志兼容。
 */
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { createElement } from "react";

import type { ToolEntry } from "@nocturne/core/protocol";

import { layoutEntry } from "../src/lines.js";
import { diffSummary, layoutDiffRow, parseDiff } from "../src/diff-format.js";
import { selCopyText } from "../src/selection.js";
import { ToolRow } from "../src/components/tool-row.js";
import { TodoPanel } from "../src/components/todo-panel.js";
import { TuiEnvContext } from "../src/env.js";
import { todoSnapshotWindow } from "../src/todo-format.js";
import { palettes } from "../src/theme.js";

const entry = (input: unknown, output: unknown, modelContent: string): ToolEntry => ({
  kind: "tool",
  key: "t:1",
  turnId: "turn-1",
  callId: "c1",
  name: "edit",
  seq: 1,
  status: "ok",
  input,
  subjects: [],
  permission: undefined,
  resolution: undefined,
  liveOutput: "",
  result: {
    status: "ok",
    modelContent,
    output,
    error: undefined,
    truncated: false,
    spillPath: undefined,
    durationMs: 5,
  },
});

describe("清单快照窗口", () => {
  const list = (done: number, total = 10) =>
    Array.from({ length: total }, (_, i) => ({
      text: `第${i + 1}步`,
      status:
        i < done
          ? ("completed" as const)
          : i === done
            ? ("in_progress" as const)
            : ("pending" as const),
    }));
  const texts = (done: number, total = 10) => {
    const w = todoSnapshotWindow(list(done, total));
    return [w.shown.map((item) => item.text).join(","), w.after];
  };

  it("从最近完成项起连同其后两项，只数窗口之后的项", () => {
    expect(texts(0)).toEqual(["第1步,第2步,第3步", 7]);
    expect(texts(3)).toEqual(["第3步,第4步,第5步", 5]);
    expect(texts(9)).toEqual(["第8步,第9步,第10步", 0]);
    expect(texts(10)).toEqual(["第8步,第9步,第10步", 0]);
    expect(texts(1, 2)).toEqual(["第1步,第2步", 0]);
  });

  it("固定区全部完成时显示最后几项，不再提示另有；进行中时只数其后未显示的项", () => {
    const panel = (done: number) => {
      const frame = render(
        createElement(
          TuiEnvContext.Provider,
          { value: { ascii: true, animated: false } },
          createElement(TodoPanel, { items: list(done), width: 40, height: 10 }),
        ),
      );
      const out = frame.lastFrame() ?? "";
      frame.unmount();
      return out;
    };
    const finished = panel(10);
    expect(finished).toContain("[x] 第10步");
    expect(finished).toContain("[x] 第4步");
    expect(finished).not.toContain("第3步");
    expect(finished).not.toContain("另有");
    const mid = panel(2);
    expect(mid).toContain("[x] 第2步");
    expect(mid).toContain("[>] 第3步");
    expect(mid).toContain("[ ] 第7步");
    expect(mid).not.toContain("第1步");
    expect(mid).not.toContain("第8步");
    expect(mid).toContain("另有 3 项");
    // 窗口已能延伸到末尾时显示到最后一项，不留「另有」
    const late = panel(4);
    expect(late).toContain("[x] 第4步");
    expect(late).toContain("[ ] 第10步");
    expect(late).not.toContain("另有");
  }, 15000);

  it("对话流里的快照只列三项并提示另有项数", () => {
    const tool: ToolEntry = {
      ...entry({}, { items: list(3) }, "updated"),
      name: "todo_write",
    };
    const plain = layoutEntry(tool, 60, false)
      .map((line) => line.text)
      .join("\n");
    expect(plain).toContain("✅ 第3步");
    expect(plain).toContain("🟦 第4步");
    expect(plain).toContain("⬜ 第5步");
    expect(plain).not.toContain("第2步");
    expect(plain).not.toContain("第6步");
    expect(plain).toContain("… 另有 5 项");
  });
});

it("真实 diff 删除行只显示一个删除标记", () => {
  const row = parseDiff("@@ -1,1 +1,1 @@\n-const accent = 'old'\n+const accent = 'iris'")[0];
  if (row === undefined) throw new Error("删除行未被解析");
  expect(row).toMatchObject({ mark: "-", body: "const accent = 'old'" });
  const line = layoutDiffRow("diff", row, 60, false, palettes.dark)[0];
  expect(line?.text).toContain("- const accent = 'old'");
  expect(line?.text).not.toContain("- -const");
});

describe("工具行 diff", () => {
  it("普通屏幕逐次打印完整清单，窄屏 ASCII 无色可辨状态", () => {
    const tool = {
      ...entry(
        {
          items: [
            { text: "第一步", status: "completed" },
            { text: "第二步", status: "in_progress" },
            { text: `第三步${"长".repeat(40)}末尾`, status: "pending" },
          ],
        },
        {
          items: [
            { text: "第一步", status: "completed" },
            { text: "第二步", status: "in_progress" },
            { text: `第三步${"长".repeat(40)}末尾`, status: "pending" },
          ],
        },
        "updated",
      ),
      name: "todo_write",
    };
    const plain = layoutEntry(tool, 25, true)
      .map((line) => line.text)
      .join("\n");
    expect(plain).toContain("+ 任务清单  1/3");
    expect(plain).toContain("[x] 第一");
    expect(plain).toContain("[>] 第二");
    expect(plain).toContain("[ ] 第三");
    expect(plain).not.toContain("todo_write");
    expect(plain).not.toContain('"items"');
    const frame = render(
      createElement(
        TuiEnvContext.Provider,
        { value: { ascii: true, animated: false } },
        createElement(ToolRow, { entry: tool, width: 25 }),
      ),
    );
    expect(frame.lastFrame()).toContain("+ 任务清单  1/3");
    expect(frame.lastFrame()).toContain("[>] 第二步");
    expect(frame.lastFrame()).toContain("末尾");
    frame.unmount();
    expect(
      layoutEntry({ ...entry({}, { items: [] }, "cleared"), name: "todo_write" }, 25, true)
        .map((line) => line.text)
        .join("\n"),
    ).toContain("清空任务清单");
  });

  it("固定清单在窄屏截断长文本，ASCII 状态仍可见", () => {
    const frame = render(
      createElement(
        TuiEnvContext.Provider,
        { value: { ascii: true, animated: false } },
        createElement(TodoPanel, {
          items: [
            { text: "计算总和", status: "completed" },
            { text: `计算结果${"很长".repeat(20)}`, status: "in_progress" },
            { text: "说明结果", status: "pending" },
            { text: "检查结果", status: "pending" },
            { text: "总结", status: "pending" },
          ],
          width: 25,
          height: 4,
        }),
      ),
    );
    const lines = (frame.lastFrame() ?? "").split("\n");
    expect(lines[0]).toBe("任务  1/5");
    expect(lines.join("\n")).toContain("[x] 计算总和");
    expect(lines.join("\n")).toContain("[>] 计算结果");
    expect(lines.join("\n")).not.toContain("说明结果");
    expect(lines.join("\n")).toContain("另有 3 项");
    frame.unmount();
  });

  it("edit：摘要行 + 新旧行号、标记与背景；旧头部不臆造行号", () => {
    const lines = layoutEntry(
      entry(
        { path: "a.js" },
        { diff: "@@ a.js @@\n ctx\n-old\n+new" },
        "已修改 a.js（替换 1 处，现 3 行）",
      ),
      80,
      false,
    );
    const texts = lines.map((l) => l.text.trim());
    expect(texts[1]).toBe("已修改 a.js（替换 1 处，现 3 行）；新增 1 行，删除 1 行");
    expect(texts.slice(2).map((s) => s.replace(/\s+/g, " "))).toEqual(["ctx", "- old", "+ new"]);
    expect(
      layoutDiffRow("red", { mark: "-", body: "old", oldNo: 2 }, 80, true)[0]?.segments?.[0]
        ?.backgroundColor,
    ).toBe(palettes.dark.diffRemoveBg);
    expect(
      layoutDiffRow("green", { mark: "+", body: "new", newNo: 2 }, 80, true)[0]?.segments?.[0]
        ?.backgroundColor,
    ).toBe(palettes.dark.diffAddBg);
    expect(
      layoutDiffRow("plain", { mark: "+", body: "new", newNo: 2 }, 80, false)[0]?.segments?.[0]
        ?.backgroundColor,
    ).toBeUndefined();
    expect(parseDiff("@@ a.js @@\n-old\n+new")).toEqual([
      { mark: "-", body: "old" },
      { mark: "+", body: "new" },
    ]);
    expect(parseDiff("@@ -1,1 +1,1 @@\n--- source\n+++ source")).toEqual([
      { mark: "-", body: "-- source", oldNo: 1 },
      { mark: "+", body: "++ source", newNo: 1 },
    ]);
  });

  it("新建文件：40 行以内完整显示；超过时折 20/20，可展开收起", () => {
    const content = Array.from({ length: 50 }, (_, i) => `line${i + 1}`).join("\n");
    const diff = `@@ -0,0 +1,50 @@\n${content
      .split("\n")
      .map((l) => `+${l}`)
      .join("\n")}`;
    const lines = layoutEntry(
      entry({ path: "b.js", content }, { created: true, diff }, "已创建 b.js（50 行）"),
      80,
      false,
    );
    const texts = lines.map((l) => l.text.trim());
    expect(texts[2]).toMatch(/1 \+ line1$/);
    expect(texts).toContain("… 还有 10 行");
    expect(texts.at(-1)).toMatch(/50 \+ line50$/);
    const expanded = layoutEntry(
      entry({}, { diff }, "已创建 b.js"),
      80,
      false,
      undefined,
      undefined,
      false,
      true,
    );
    expect(expanded.map((l) => l.text).join("\n")).toContain("line25");
    expect(expanded.some((l) => l.key === "t:1:diff:more" && l.text.includes("收起"))).toBe(true);
    expect(lines.map((l) => l.text).join("\n")).not.toContain("line25");
    expect(
      layoutEntry(entry({}, { diff }, "已创建 b.js"), 30, true).some((l) =>
        l.text.includes("... 还有 10 行"),
      ),
    ).toBe(true);
  });

  it("新头部递增新旧行号，窄屏折行复制能拼回源码行", () => {
    const parsed = parseDiff("@@ -2,2 +2,2 @@\n same\n-old\n+new");
    expect(parsed.map(({ oldNo, newNo }) => [oldNo, newNo])).toEqual([
      [2, 2],
      [3, undefined],
      [undefined, 3],
    ]);
    expect(diffSummary(parsed)).toBe("新增 1 行，删除 1 行");
    const row = layoutDiffRow("x", { mark: "+", body: "abcdefghij", newNo: 3 }, 17, false);
    expect(row.length).toBeGreaterThan(1);
    expect(row[1]?.continued).toBe(true);
    expect(row[1]?.text.trim()).not.toMatch(/[+\-]/);
    const copied = selCopyText(row, {
      anchor: { abs: 0, col: 0 },
      head: { abs: row.length - 1, col: row.at(-1)?.text.length ?? 0 },
    });
    expect(copied).toContain("abcdefghij");
  });

  it("工具输出里的终端控制序列被去掉（颜色码不漏到主屏）", () => {
    const e = entry(
      { command: "npm test" },
      {},
      "\x1b[31mFAIL\x1b[39m a\n\x1b]0;title\x07ok\x1b[0m",
    );
    const texts = layoutEntry({ ...e, name: "shell" }, 80, false).map((l) => l.text);
    expect(texts.join("\n")).not.toContain("\x1b");
    expect(texts.map((t) => t.trim())).toContain("FAIL a");
    expect(texts.map((t) => t.trim())).toContain("ok");
  });

  it("普通屏幕完整显示超过 40 行的 diff，旧新建记录可显示且 ASCII 无色可读", () => {
    const diff = `@@ -0,0 +1,45 @@\n${Array.from({ length: 45 }, (_, i) => `+line${i + 1}`).join("\n")}`;
    const tool = entry({ path: "a.ts" }, { diff }, "已创建 a.ts") as Extract<
      ToolEntry,
      { kind: "tool" }
    >;
    const frame = render(
      createElement(
        TuiEnvContext.Provider,
        { value: { ascii: true, animated: false } },
        createElement(ToolRow, { entry: tool, width: 40 }),
      ),
    );
    const shown = frame.lastFrame() ?? "";
    expect(shown).toContain("新增 45 行，删除 0 行");
    expect(shown).toContain("line1");
    expect(shown).toContain("line23");
    expect(shown).toContain("line45");
    expect(shown).not.toContain("还有");
    frame.unmount();
    const legacy = render(
      createElement(
        TuiEnvContext.Provider,
        { value: { ascii: true, animated: false } },
        createElement(ToolRow, {
          entry: entry({ content: "first\nsecond" }, { created: true }, "已创建 a.ts"),
          width: 40,
        }),
      ),
    );
    expect(legacy.lastFrame()).toContain("+ first");
    expect(legacy.lastFrame()).toContain("+ second");
    legacy.unmount();
  });

  it("出错的调用不显示 diff", () => {
    const e = entry({ path: "a.js" }, { diff: "@@ a.js @@\n-x\n+y" }, "old 未出现");
    const lines = layoutEntry({ ...e, status: "error" }, 80, false);
    expect(lines.map((l) => l.text.trim())).not.toContain("+y");
  });

  it("结构化输出省略时只显示省略提示，不提供展开入口", () => {
    const e = entry({}, undefined, "已创建 a.ts\n[结构化 output 超过大小上限，已省略]");
    const lines = layoutEntry(e, 80, false);
    expect(lines.map((l) => l.text).join("\n")).toContain("结构化 output 超过大小上限，已省略");
    expect(lines.some((l) => l.key.endsWith(":diff:more"))).toBe(false);
  });

  it("NO_COLOR 不给 diff 行铺背景，但保留行号和标记", () => {
    const previous = process.env.NO_COLOR;
    process.env.NO_COLOR = "1";
    try {
      const lines = layoutEntry(
        entry({}, { diff: "@@ -1,1 +1,1 @@\n-old\n+new" }, "已修改 a.ts"),
        30,
        false,
      );
      const added = lines.find((l) => l.text.includes("+ new"));
      expect(added?.text).toMatch(/1 \+ new$/);
      expect(added?.segments?.every((s) => s.backgroundColor === undefined)).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = previous;
    }
  });
});
