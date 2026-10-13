import { describe, expect, it } from "vitest";

import { createSessionView, type ViewEntry } from "@nocturne/core/protocol";
import { interleaveClient } from "../src/client-lines.js";
import { layoutEntry, transcriptBlocks } from "../src/lines.js";
import { subagentModel } from "../src/format.js";
import type { ToolEntry } from "@nocturne/core/protocol";

const line = (id: number, after: number) => ({ id, text: `! 提示${id}`, after });

describe("本地提示行定位", () => {
  it("task 摘要显示实际执行模型，旧结果和普通工具保持兼容", () => {
    const entry = { name: "task", result: { output: { model: "fake/child" } } } as ToolEntry;
    expect(subagentModel(entry)).toBe(" [fake/child]");
    expect(subagentModel({ ...entry, name: "read" })).toBe("");
    expect(subagentModel({ ...entry, result: undefined })).toBe("");
  });
  it("task 摘要显示档位、实际模型与强度；运行中从进度行取模型", () => {
    const done = {
      name: "task",
      input: { task: "找调用点", profile: "quick", reason: "只读即可" },
      liveOutput: "",
      result: { output: { model: "fake/cheap", reasoningEffort: "low" } },
    } as unknown as ToolEntry;
    expect(subagentModel(done)).toBe(" [quick] [fake/cheap · low]");
    const running = {
      name: "task",
      input: { task: "找调用点", profile: "deep" },
      liveOutput: "子代理模型：fake/strong · high\n",
      result: undefined,
    } as unknown as ToolEntry;
    expect(subagentModel(running)).toBe(" [deep] [fake/strong · high]");
  });
  it("task 工具行：标题带档位与模型，下一行显示选择理由；旧调用无档位行", () => {
    const tool = (input: Record<string, unknown>) =>
      ({
        kind: "tool",
        key: "t1",
        name: "task",
        status: "ok",
        input,
        subjects: [],
        liveOutput: "",
        result: {
          status: "ok",
          modelContent: "done",
          output: { model: "fake/cheap", reasoningEffort: "low" },
        },
      }) as unknown as ToolEntry;
    const text = (entry: ToolEntry) =>
      layoutEntry(entry, 120, false)
        .map((l) => l.text)
        .join("\n");
    const current = text(tool({ task: "找调用点", profile: "quick", reason: "只读即可" }));
    // 渲染层统一把 · 换成 •（format.ts 字形映射）
    expect(current).toContain("task [quick] [fake/cheap • low] 找调用点");
    expect(current).toContain("  选择理由：只读即可");
    const legacy = text(tool({ task: "旧任务" }));
    expect(legacy).toContain("task [fake/cheap • low] 旧任务");
    expect(legacy).not.toContain("选择理由");
  });
  it("按推入时的条目数插在条目之间，其余排在最后", () => {
    const out = interleaveClient(
      ["a", "b", "c"],
      0,
      [line(2, 3), line(0, 0), line(1, 2)],
      (e) => [e],
      (l) => `#${l.id}`,
    );
    expect(out).toEqual(["#0", "a", "b", "#1", "c", "#2"]);
    // base 偏移：活动区的 tail 从第 base 条开始
    expect(
      interleaveClient(
        ["c"],
        2,
        [line(1, 2)],
        (e) => [e],
        (l) => `#${l.id}`,
      ),
    ).toEqual(["#1", "c"]);
  });

  it("全屏块表里提示行随条目滚走，推入后才有的条目排在它下面", () => {
    const entries = ["e0", "e1"].map((key) => ({ kind: "notice", key }) as unknown as ViewEntry);
    const blocks = transcriptBlocks({
      welcome: [],
      notices: [],
      frozen: [],
      entries,
      hide: () => false,
      live: createSessionView(),
      clientLines: [line(0, 1), line(1, 2)],
      ascii: false,
    });
    expect(blocks.map((b) => b.key)).toEqual([
      "welcome",
      "e0",
      "client:0",
      "e1",
      "live",
      "client:1",
    ]);
  });
});
