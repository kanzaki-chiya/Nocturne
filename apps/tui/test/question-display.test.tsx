import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { createElement } from "react";
import { createSessionView, reduceSessionView, replaySessionView } from "@nocturne/core/protocol";
import type { DurableEvent, ToolEntry } from "@nocturne/core/protocol";
import { layoutEntry } from "../src/lines.js";
import { ToolRow } from "../src/components/tool-row.js";
import { PermissionDialog, permissionDialogRows } from "../src/components/permission-dialog.js";

describe("ask_user 持久显示", () => {
  it.each([
    {
      status: "ok",
      output: {
        answers: [
          { question: "方案？", selected: ["A", "B"], text: "补充" },
          { question: "时间？", declined: true },
        ],
      },
      expected: ["方案？ → A、B、补充", "时间？ → 拒绝回答"],
    },
    { status: "cancelled", expected: ["已取消"] },
    { status: "error", error: { code: "timeout", message: "timeout" }, expected: ["已超时"] },
    {
      status: "error",
      error: { code: "not_interactive", message: "no tty" },
      expected: ["无法提问（非交互）"],
    },
  ] as const)("$status $expected：两种显示路径与事件重放一致，无 JSON 或重复摘要", (spec) => {
    const events = [
      {
        type: "tool.started",
        sessionId: "s",
        seq: 1,
        time: "t",
        turnId: "turn",
        payload: {
          callId: "q",
          name: "ask_user",
          input: { questions: [{ question: "方案？" }, { question: "时间？" }] },
          subjects: [],
          permission: { action: "allow", source: "default" },
        },
      },
      {
        type: "tool.completed",
        sessionId: "s",
        seq: 2,
        time: "t",
        turnId: "turn",
        payload: {
          callId: "q",
          name: "ask_user",
          status: spec.status,
          modelContent: "问：完整问题\n答：模型用的完整结果",
          ...("output" in spec ? { output: spec.output } : {}),
          ...("error" in spec ? { error: spec.error } : {}),
        },
      },
    ] as DurableEvent[];
    const view = createSessionView();
    for (const event of events) reduceSessionView(view, event);
    const tool = view.entries[0] as ToolEntry;
    const frame = render(createElement(ToolRow, { entry: tool, width: 80 }));
    const text = frame.lastFrame() ?? "";
    expect(text).toContain("? 提问（2 题）");
    for (const answer of spec.expected) expect(text.split(answer)).toHaveLength(2);
    expect(text).not.toContain('"questions"');
    expect(text).not.toContain("模型用的完整结果");
    const lines = layoutEntry(tool, 80, false).map((line) => line.text);
    expect(lines).toEqual([
      "? 提问（2 题）",
      ...spec.expected.map((line) => line.replace("→", ">")),
    ]);
    expect(layoutEntry(replaySessionView(events).entries[0] as ToolEntry, 80, false)).toEqual(
      layoutEntry(tool, 80, false),
    );
    frame.unmount();
  });

  it("权限确认框封顶到一行时仍显示焦点项；不传高度的主题样例仍完整", () => {
    const pending = {
      requestId: "p",
      callId: "c",
      toolName: "shell",
      subjects: [{ kind: "shell", target: "echo preview" }],
      reason: "preview",
      options: ["allow_once", "deny"],
    } as const;
    // PendingPermission 的集合可变；这里保留独立副本。
    const value = { ...pending, subjects: [...pending.subjects], options: [...pending.options] };
    const compact = render(
      createElement(PermissionDialog, {
        pending: value,
        active: false,
        width: 32,
        height: 1,
        onReply: () => undefined,
      }),
    );
    expect(compact.lastFrame()).toContain(">[a] 允许一次");
    expect(compact.lastFrame()?.split("\n")).toHaveLength(1);
    compact.unmount();
    const preview = render(
      createElement(PermissionDialog, {
        pending: value,
        active: false,
        width: 80,
        onReply: () => undefined,
      }),
    );
    expect(preview.lastFrame()).toContain("需要确认");
    expect(preview.lastFrame()).toContain("[d]");
    expect(permissionDialogRows(value, 80)).toBe(7);
    preview.unmount();
  });
});
