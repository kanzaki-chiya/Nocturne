import { expect, it, vi } from "vitest";
import type { Runtime, RuntimeSession } from "@nocturne/core";
import type { DurableEvent, UsageStats } from "@nocturne/core/protocol";
import { runSlashCommand } from "../src/commands.js";

it("CLI /cost shows current session and 30-day totals without model calls", async () => {
  const envelope = { sessionId: "s", time: "2026-10-09T00:00:00Z" };
  const events: DurableEvent[] = [
    {
      ...envelope,
      seq: 1,
      type: "session.created",
      payload: {
        formatVersion: 1,
        nocturneVersion: "test",
        cwd: ".",
        workspaceRoot: ".",
        model: { provider: "p", model: "m" },
        permissionPreset: "default",
      },
    },
    { ...envelope, seq: 2, type: "turn.started", turnId: "t", payload: { turnIndex: 1 } },
    {
      ...envelope,
      seq: 3,
      type: "turn.completed",
      turnId: "t",
      payload: {
        reason: "done",
        steps: 1,
        usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 800 },
      },
    },
  ];
  const stats: UsageStats = {
    totals: {
      inputTokens: 5000,
      outputTokens: 1000,
      cost: { input: 1, cacheRead: 1, cacheWrite: 1, output: 2, total: 5 },
    },
    sessions: 3,
    turns: 4,
    subagentTurns: 1,
    daily: [],
    models: [],
    tools: [],
    skills: [],
    unpricedModels: [],
    skippedFiles: 0,
  };
  const usageStats = vi.fn(async () => stats);
  const runtime = { usageStats, listModels: () => [] } as unknown as Runtime;
  const session = { durableEvents: () => events } as unknown as RuntimeSession;
  const print = vi.fn();
  expect(await runSlashCommand("/cost", session, runtime, { print })).toBe("handled");
  const text = print.mock.calls[0]?.[0] as string;
  expect(text).toContain("当前会话");
  expect(text).toContain("p/m · 1 Turns");
  expect(text).toContain("未计价");
  expect(text).toContain("近 30 天");
  expect(text).toContain("合计 6,000 tokens · $5.00");
  expect(usageStats).toHaveBeenCalledWith({ days: 30 });
});
