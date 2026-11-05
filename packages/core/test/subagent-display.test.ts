import { describe, expect, it } from "vitest";
import { subagentProfile, subagentResultLine, subagentRowInfo } from "../src/protocol/index.js";
import type { ToolEntry } from "../src/protocol/index.js";

describe("subagent display identity", () => {
  it("临时参数在启动前显示，实际结果与进度优先", () => {
    const entry = {
      name: "task",
      input: { profile: "quick", model: "p/m", effort: "high" },
      liveOutput: "",
    } as ToolEntry;
    expect(subagentRowInfo(entry)).toMatchObject({
      profile: "quick",
      model: "p/m",
      effort: "high",
    });
    expect(subagentRowInfo({ ...entry, liveOutput: "子代理模型：p/m · low" })).toMatchObject({
      model: "p/m",
      effort: "low",
    });
  });
  it.each([
    [{ preset: "explore" }, "explore"],
    [{ preset: "explore", profile: "default" }, "explore"],
    [{ profile: "quick" }, "quick"],
    [{ profile: "default" }, ""],
    [{}, ""],
  ])("uses the supplied preset and omits the default fallback: %s", (input, expected) => {
    expect(subagentProfile(input)).toBe(expected);
    const entry = { name: "task", input, liveOutput: "" } as ToolEntry;
    expect(subagentRowInfo(entry).profile).toBe(expected || undefined);
  });

  it("result cards have no default label or dangling separator", () => {
    const result = { childSessionId: "child", callId: "call", status: "ok" as const };
    expect(subagentResultLine({ ...result, profile: "explore" })).toBe("explore · 完成");
    expect(subagentResultLine({ ...result, profile: "default" })).toBe("完成");
    expect(subagentResultLine(result)).toBe("完成");
  });
});
