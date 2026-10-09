import { expect, it, vi } from "vitest";
import type { Runtime, RuntimeSession } from "@nocturne/core";
import { createSessionView, type UsageStats } from "@nocturne/core/protocol";
import { runSlash } from "../src/commands.js";

it("TUI /cost shows current session and 30-day model totals", async () => {
  const view = createSessionView();
  view.config.model = { provider: "p", model: "m" };
  view.turnCount = 2;
  view.usage = { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 800 };
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
    models: [
      {
        model: { provider: "ocx", model: "xai/grok-4.7" },
        turns: 1,
        inputTokens: 1000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 100,
        cacheHitRate: 0,
        pricing: { input: 2, output: 6 },
        pricingSource: "vendor",
        cost: { input: 0.002, cacheRead: 0, cacheWrite: 0, output: 0.0006, total: 0.0026 },
      },
    ],
    tools: [],
    skills: [],
    unpricedModels: [],
    skippedFiles: 0,
  };
  const usageStats = vi.fn(async () => stats);
  const runtime = {
    usageStats,
    listModels: () => [{ ref: view.config.model, pricing: { input: 2, output: 8 } }],
  } as unknown as Runtime;
  const result = await runSlash("/cost", {} as RuntimeSession, undefined, { runtime, view });
  expect(result.kind).toBe("message");
  if (result.kind !== "message") throw new Error("expected cost text");
  expect(result.text).toContain("当前会话");
  expect(result.text).toContain("p/m · 2 Turns");
  expect(result.text).toContain("80.0%");
  expect(result.text).toContain("近 30 天");
  expect(result.text).toContain("合计 6,000 tokens · $5.00");
  expect(result.text).toContain("设置 › 用量");
  expect(result.text).toContain("ocx/xai/grok-4.7 · 1,100 tokens · $0.00（厂商价）");
  expect(result.text).toContain(
    "厂商价：按模型厂商官方 API 价估算，不代表代理或中转服务的实际收费",
  );
  expect(usageStats).toHaveBeenCalledWith({ days: 30 });
});
