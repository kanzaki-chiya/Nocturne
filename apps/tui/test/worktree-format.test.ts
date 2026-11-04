import { render } from "ink-testing-library";
import { createElement } from "react";
import { expect, it } from "vitest";
import type { ToolEntry } from "@nocturne/core/protocol";
import { ToolRow } from "../src/components/tool-row.js";
import { summarizeToolInput } from "../src/format.js";
import { layoutEntry } from "../src/lines.js";

function makeSwitchEntry(inputPath: string, currentOutput?: string): ToolEntry {
  return {
    kind: "tool",
    key: "sw",
    callId: "sw-1",
    turnId: "turn-1",
    seq: 1,
    time: "2026-11-04",
    name: "switch_worktree",
    input: { path: inputPath },
    subjects: [],
    target: undefined,
    permission: { action: "allow", source: "rule", rule: undefined },
    status: currentOutput !== undefined ? "ok" : "running",
    liveOutput: "",
    result:
      currentOutput !== undefined
        ? {
            status: "ok",
            modelContent: `Switched working directory to ${currentOutput}.`,
            output: { current: currentOutput, branch: "main" },
            durationMs: 12,
          }
        : undefined,
    review: undefined,
    resolution: undefined,
  } as ToolEntry;
}

it("switch_worktree summarizes the destination directory on Windows and POSIX", () => {
  expect(summarizeToolInput("switch_worktree", { path: "Z:\\repo-wt\\" })).toBe("repo-wt");
  expect(summarizeToolInput("switch_worktree", { path: "/repos/repo/" })).toBe("repo");
  expect(summarizeToolInput("switch_worktree", { path: "." }, { current: "Z:\\project\\" })).toBe(
    "project",
  );
  expect(
    summarizeToolInput("switch_worktree", { path: ".." }, { current: "/repos/project/" }),
  ).toBe("project");
});

it("TUI tool rows prefer result output.current for '.', '..', and trailing separators, and fall back to input before completion", () => {
  for (const [inputPath, currentOutput, expected] of [
    [".", "Z:\\project", "project"],
    ["..", "Z:\\project\\", "project"],
    ["../repo-wt/", "/repos/repo-wt/", "repo-wt"],
  ] as const) {
    const completed = makeSwitchEntry(inputPath, currentOutput);
    const screen = render(createElement(ToolRow, { entry: completed, width: 120 }));
    expect(screen.lastFrame()).toContain(`切换工作树 · ${expected}`);
    screen.unmount();

    const lines = layoutEntry(completed, 120, false)
      .map((line) => line.text)
      .join("\n");
    expect(lines).toContain(`切换工作树 • ${expected}`);
  }

  const running = makeSwitchEntry("../pending-wt/");
  const runningScreen = render(createElement(ToolRow, { entry: running, width: 120 }));
  expect(runningScreen.lastFrame()).toContain("切换工作树 · pending-wt");
  runningScreen.unmount();

  const runningLines = layoutEntry(running, 120, false)
    .map((line) => line.text)
    .join("\n");
  expect(runningLines).toContain("切换工作树 • pending-wt");
});
