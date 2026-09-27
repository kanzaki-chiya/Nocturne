/**
 * 全屏布局中的文件改动展示（tui.md §4 diff 展示）：edit/覆盖 write 渲染
 * output.diff，新建文件按 content 铺成 + 行，过长折叠为头尾 + 省略计数。
 */
import { describe, expect, it } from "vitest";

import type { ToolEntry } from "@nocturne/core/protocol";

import { layoutEntry } from "../src/lines.js";

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

describe("工具行 diff", () => {
  it("edit：摘要行 + 红绿 diff，不显示 @@ 头", () => {
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
    expect(texts[1]).toBe("已修改 a.js（替换 1 处，现 3 行）");
    expect(texts.slice(2)).toEqual(["ctx", "-old", "+new"]);
    expect(lines[3]?.color).toBe("red");
    expect(lines[4]?.color).toBe("green");
    expect(lines[2]?.dim).toBe(true);
  });

  it("新建文件：按 content 铺成 + 行，过长折叠", () => {
    const content = Array.from({ length: 30 }, (_, i) => `line${i + 1}`).join("\n");
    const lines = layoutEntry(
      entry({ path: "b.js", content }, { created: true }, "已创建 b.js（30 行）"),
      80,
      false,
    );
    const texts = lines.map((l) => l.text.trim());
    expect(texts[2]).toBe("+line1");
    expect(texts).toContain("… 省略 20 行");
    expect(texts.at(-1)).toBe("+line30");
    expect(lines.at(-1)?.color).toBe("green");
  });

  it("出错的调用不显示 diff", () => {
    const e = entry({ path: "a.js" }, { diff: "@@ a.js @@\n-x\n+y" }, "old 未出现");
    const lines = layoutEntry({ ...e, status: "error" }, 80, false);
    expect(lines.map((l) => l.text.trim())).not.toContain("+y");
  });
});
