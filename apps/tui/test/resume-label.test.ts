import { describe, expect, it } from "vitest";

import type { SessionSummary } from "@nocturne/core";

import { resumeLabel } from "../src/resume-label.js";

const now = Date.parse("2026-09-27T12:00:00Z");
const sample: SessionSummary = {
  id: "session-123",
  createdAt: "2026-09-26T12:00:00Z",
  cwd: "C:/repo",
  workspaceRoot: "C:/repo",
  model: { provider: "fake", model: "fake-1" },
  mtimeMs: now - 7 * 60_000,
  firstText: "修复窗口里的长标题以及边界情况，别丢掉后续描述",
};

describe("/resume 摘要行", () => {
  it("分叉标记在窄行中也保留", () => {
    expect(
      resumeLabel({ ...sample, forkedFrom: { sessionId: "original", seq: 2 } }, 25, now),
    ).toMatch(/^分叉  /);
  });
  it("先显示首句与相对时间，后显示会话标识等次要信息", () => {
    const label = resumeLabel(sample, 120, now);
    expect(label).toMatch(/^修复窗口.*7 分钟前  session-123  fake\/fake-1  C:\/repo/);
  });

  it("缺失首句时显示占位，窄宽度时按显示宽度截断", () => {
    expect(resumeLabel({ ...sample, firstText: undefined }, 120, now)).toContain(
      "（暂无用户消息）",
    );
    expect(resumeLabel(sample, 25, now)).toContain("…");
    expect(resumeLabel(sample, 25, now)).not.toContain("\n");
  });
});
