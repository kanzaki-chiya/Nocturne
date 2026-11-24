import { render } from "ink-testing-library";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import type { ToolEntry } from "@nocturne/core/protocol";
import { layoutEntry } from "../src/lines.js";
import { ToolRow } from "../src/components/tool-row.js";
import { detectTuiEnv, TuiEnvContext } from "../src/env.js";
import { ThemeContext, palettes } from "../src/theme.js";

function goalTool(overrides: Partial<ToolEntry>): ToolEntry {
  return {
    kind: "tool",
    key: "t:goal-1",
    turnId: "turn-1",
    callId: "goal-1",
    name: "update_goal",
    seq: 10,
    status: "ok",
    input: { status: "met" },
    subjects: [],
    permission: undefined,
    resolution: undefined,
    liveOutput: "",
    result: {
      status: "ok",
      modelContent: "Goal marked as met.",
      output: { status: "met" },
      error: undefined,
      truncated: false,
      spillPath: undefined,
      durationMs: 12,
    },
    ...overrides,
  };
}

function renderInline(entry: ToolEntry) {
  return render(
    createElement(
      TuiEnvContext.Provider,
      { value: detectTuiEnv() },
      createElement(
        ThemeContext.Provider,
        { value: palettes.dark },
        createElement(ToolRow, { entry, width: 80 }),
      ),
    ),
  );
}

const layout = (entry: ToolEntry, diffExpanded: boolean) =>
  layoutEntry(entry, 80, false, new Map(), 0, false, diffExpanded, palettes.dark);

describe("TUI update_goal 工具行（ADR-0119）", () => {
  it("goal_unverified：全屏收起为淡色中性行，展开列出未通过项与覆盖缺口", () => {
    const entry = goalTool({
      status: "error",
      input: {
        status: "met",
        checklist: [
          { item: "更新配置", evidence: "已修改" },
          { item: "运行单测", evidence: "已运行" },
        ],
      },
      result: {
        status: "error",
        modelContent: "Goal check failed",
        output: {
          status: "met",
          checklist: [
            { item: "更新配置", evidence: "已修改" },
            { item: "运行单测", evidence: "已运行" },
          ],
          check: {
            backend: "smol",
            result: "rejected",
            items: [
              { index: 1, passed: true },
              { index: 2, passed: false, note: "缺少测试命令输出" },
            ],
            coverage: false,
          },
        },
        error: { code: "goal_unverified", message: "Goal verification failed" },
        truncated: false,
        spillPath: undefined,
        durationMs: 42,
      },
    });

    const collapsed = layout(entry, false);
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0]?.dim).toBe(true);
    expect(collapsed[0]?.text).toContain("update_goal");
    expect(collapsed[0]?.text).toContain("核对未通过");
    expect(collapsed[0]?.text).not.toContain("error");

    const expanded = layout(entry, true);
    const expandedText = expanded.map((line) => line.text).join("\n");
    expect(expandedText).toContain("× 运行单测：缺少测试命令输出");
    expect(expandedText).toContain("× 清单未覆盖目标的全部要求");
    expect(expandedText).not.toContain("更新配置");

    const inline = renderInline(entry);
    const frame = inline.lastFrame() ?? "";
    expect(frame).toContain("核对未通过");
    expect(frame).toContain("× 运行单测：缺少测试命令输出");
    expect(frame).not.toContain("goal_unverified");
    inline.unmount();
  });

  it("核对不可用：全屏收起不加原因，展开显示原因；inline 显示原因", () => {
    const entry = goalTool({
      result: {
        status: "ok",
        modelContent: "Goal marked as met.",
        output: {
          status: "met",
          check: { backend: "decision", result: "unavailable", reason: "决策模型未设置" },
        },
        error: undefined,
        truncated: false,
        spillPath: undefined,
        durationMs: 5,
      },
    });

    const collapsedText = layout(entry, false)
      .map((line) => line.text)
      .join("\n");
    expect(collapsedText).not.toContain("决策模型未设置");

    const expandedText = layout(entry, true)
      .map((line) => line.text)
      .join("\n");
    expect(expandedText).toContain("核对不可用：决策模型未设置");

    const inline = renderInline(entry);
    expect(inline.lastFrame()).toContain("核对不可用：决策模型未设置");
    inline.unmount();
  });

  it("核对通过时不加东西", () => {
    const entry = goalTool({
      result: {
        status: "ok",
        modelContent: "Goal marked as met.",
        output: {
          status: "met",
          check: { backend: "decision", result: "passed" },
        },
        error: undefined,
        truncated: false,
        spillPath: undefined,
        durationMs: 5,
      },
    });

    const expandedText = layout(entry, true)
      .map((line) => line.text)
      .join("\n");
    expect(expandedText).not.toContain("核对");

    const inline = renderInline(entry);
    expect(inline.lastFrame()).not.toContain("核对");
    inline.unmount();
  });
});
