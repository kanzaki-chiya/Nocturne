import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createRuntime, createPlatform, loadConfig } from "../src/index.js";
import { FakeProvider, type FakeScript } from "../src/provider/index.js";
import { estimateCost, type DurableEvent, type Usage } from "../src/protocol/index.js";
import { createUsageStats } from "../src/usage/index.js";

const usage: Usage = {
  inputTokens: 1_000_000,
  outputTokens: 100_000,
  cacheReadTokens: 800_000,
  cacheWriteTokens: 100_000,
};

describe("estimateCost", () => {
  it("separates cached read/write, uncached input and output", () => {
    expect(estimateCost(usage, { input: 2, output: 8, cacheRead: 0.25, cacheWrite: 3 })).toEqual({
      input: 0.2,
      cacheRead: 0.2,
      cacheWrite: 0.3,
      output: 0.8,
      total: 1.5,
    });
  });
  it("falls back to input price for missing cache prices", () => {
    expect(estimateCost(usage, { input: 2, output: 8 })?.total).toBe(2.8);
  });
  it("selects highest eligible tier and inherits missing fields", () => {
    expect(
      estimateCost(usage, {
        input: 2,
        output: 8,
        tiers: [
          { aboveInputTokens: 1_000_001, input: 100 },
          { aboveInputTokens: 500_000, input: 4 },
          { aboveInputTokens: 100_000, output: 99 },
        ],
      })?.total,
    ).toBe(4.8);
  });
  it("does not invent undeclared prices", () => {
    expect(estimateCost(usage, undefined)).toBeUndefined();
  });
});

describe("Runtime.usageStats", () => {
  it("aggregates two real sessions, subagent turns and tools/skills without turn double counting", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nctrn-usage-"));
    const sessionsDir = path.join(root, "sessions");
    const provider = new FakeProvider({
      handler: (req) => {
        const u: FakeScript = [
          { type: "usage", usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 80 } },
        ];
        if (req.purpose === "title")
          return [
            { type: "text_delta", text: "测试" },
            { type: "finish", reason: "stop" },
          ];
        if (req.tools.some((t) => t.name === "finish"))
          return [
            ...u,
            {
              type: "tool_call",
              toolCallId: "finish",
              name: "finish",
              input: { result: "调查完成" },
            },
            { type: "finish", reason: "tool_calls" },
          ];
        const task = req.messages.some(
          (m) => m.role === "user" && JSON.stringify(m.content).includes("派生"),
        );
        if (task && !req.messages.some((m) => m.role === "tool"))
          return [
            ...u,
            {
              type: "tool_call",
              toolCallId: "task",
              name: "task",
              input: { task: "调查", preset: "explore" },
            },
            { type: "finish", reason: "tool_calls" },
          ];
        return [...u, { type: "text_delta", text: "完成" }, { type: "finish", reason: "stop" }];
      },
    });
    const runtime = await createRuntime({
      cwd: root,
      sessionsDir,
      providers: [provider],
      modelOverrides: { fake: { "fake-model": { pricing: { input: 2, output: 8 } } } },
    });
    const a = await runtime.createSession({ model: "fake/fake-model" });
    const b = await runtime.createSession({ model: "fake/fake-model" });
    try {
      await a.submit({ text: "派生" });
      await b.submit({ text: "普通" });
      await a.close();
      await b.close();
      // Additional persistent skill events exercise both entry paths without needing user skill directories.
      const file = path.join(sessionsDir, `${b.id}.jsonl`);
      const events = (await fs.readFile(file, "utf8"))
        .trimEnd()
        .split("\n")
        .map((l) => JSON.parse(l) as DurableEvent);
      const base = { sessionId: b.id, time: new Date().toISOString() };
      await fs.appendFile(
        file,
        [
          {
            ...base,
            seq: events.length + 1,
            type: "message.user",
            turnId: "skill-turn",
            payload: {
              messageId: "skill-user",
              content: [],
              skill: { name: "example", body: "正文" },
            },
          },
          {
            ...base,
            seq: events.length + 2,
            type: "tool.started",
            turnId: "skill-turn",
            payload: {
              callId: "skill",
              name: "skill",
              input: { name: "example" },
              subjects: [],
              permission: { action: "allow", source: "rule" },
            },
          },
        ]
          .map((e) => JSON.stringify(e) + "\n")
          .join(""),
      );
      const stats = await runtime.usageStats({});
      expect(stats.sessions).toBe(3);
      expect(stats.turns).toBe(3);
      expect(stats.subagentTurns).toBe(1);
      expect(stats.totals.inputTokens).toBe(400);
      expect(stats.totals.outputTokens).toBe(80);
      expect(stats.models[0]).toMatchObject({
        model: { provider: "fake", model: "fake-model" },
        turns: 3,
        inputTokens: 400,
      });
      expect(stats.tools).toEqual(
        expect.arrayContaining([
          { name: "task", count: 1 },
          { name: "finish", count: 1 },
          { name: "skill", count: 1 },
        ]),
      );
      expect(stats.skills).toEqual([{ name: "example", count: 2 }]);
      expect(stats.skippedFiles).toBe(0);
    } finally {
      await a.close();
      await b.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("deduplicates real full, targeted and nested forks, including after source deletion", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nctrn-usage-fork-"));
    const sessionsDir = path.join(root, "sessions");
    const skillName = "usage-fork-fixture";
    const skillDir = path.join(root, ".claude", "skills", skillName);
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      "---\ndescription: usage fixture\n---\nFixture skill",
    );
    const provider = new FakeProvider({
      strictModels: false,
      handler: (_req, index) => [
        { type: "usage", usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 80 } },
        ...(index % 2 === 0
          ? [
              {
                type: "tool_call" as const,
                toolCallId: `skill-${index}`,
                name: "skill",
                input: { name: skillName },
              },
              { type: "finish" as const, reason: "tool_calls" as const },
            ]
          : [
              { type: "text_delta" as const, text: "完成" },
              { type: "finish" as const, reason: "stop" as const },
            ]),
      ],
    });
    const runtime = await createRuntime({
      cwd: await fs.realpath(root),
      sessionsDir,
      providers: [provider],
    });
    const source = await runtime.createSession({ model: "fake/fake-1" });
    const opened = [source];
    try {
      await source.submit({ text: "source first", skill: { name: skillName } });
      await source.submit({ text: "source second", skill: { name: skillName } });
      const targetSeq = source.durableEvents().filter((e) => e.type === "message.user")[1]?.seq;
      if (targetSeq === undefined) throw new Error("missing fork target");
      await source.setModel("fake/other");
      await source.close();
      const baseline = await runtime.usageStats({});
      expect(baseline).toMatchObject({ sessions: 1, turns: 2, skippedFiles: 0 });
      expect(baseline.totals).toMatchObject({
        inputTokens: 400,
        outputTokens: 80,
        cacheReadTokens: 320,
      });
      expect(baseline.tools).toEqual([{ name: "skill", count: 2 }]);
      expect(baseline.skills).toEqual([{ name: skillName, count: 4 }]);
      const fullId = await runtime.forkSession(source.id);
      const targetId = await runtime.forkSession(source.id, { targetSeq });
      const copied = await runtime.usageStats({});
      expect(copied).toEqual({ ...baseline, sessions: 3 });
      const full = await runtime.resumeSession(fullId);
      const targeted = await runtime.resumeSession(targetId);
      opened.push(full, targeted);
      await full.submit({ text: "full fork", skill: { name: skillName } });
      await targeted.submit({ text: "targeted fork", skill: { name: skillName } });
      await full.close();
      await targeted.close();
      const nestedId = await runtime.forkSession(fullId);
      const beforeNested = await runtime.usageStats({});
      expect(beforeNested).toMatchObject({ sessions: 4, turns: 4 });
      expect(beforeNested.totals.inputTokens).toBe(800);
      const nested = await runtime.resumeSession(nestedId);
      opened.push(nested);
      await nested.submit({ text: "nested fork", skill: { name: skillName } });
      await nested.close();
      const result = await runtime.usageStats({});
      expect(result).toMatchObject({ sessions: 4, turns: 5, subagentTurns: 0, skippedFiles: 0 });
      expect(result.totals).toMatchObject({
        inputTokens: 1000,
        outputTokens: 200,
        cacheReadTokens: 800,
      });
      expect(result.tools).toEqual([{ name: "skill", count: 5 }]);
      expect(result.skills).toEqual([{ name: skillName, count: 10 }]);
      expect(result.daily.reduce((sum, d) => sum + d.tokens, 0)).toBe(1200);
      expect(result.daily.reduce((sum, d) => sum + d.turns, 0)).toBe(5);
      expect(result.models.find((m) => m.model.model === "other")?.turns).toBe(3);
      await fs.unlink(path.join(sessionsDir, `${source.id}.jsonl`));
      const withoutSource = await runtime.usageStats({});
      expect(withoutSource).toMatchObject({ sessions: 3, turns: 3, skippedFiles: 0 });
      expect(withoutSource.totals).toMatchObject({
        inputTokens: 600,
        outputTokens: 120,
        cacheReadTokens: 480,
      });
      expect(withoutSource.tools).toEqual([{ name: "skill", count: 3 }]);
      expect(withoutSource.skills).toEqual([{ name: skillName, count: 6 }]);
      expect(withoutSource.daily.reduce((sum, d) => sum + d.tokens, 0)).toBe(720);
      expect(withoutSource.daily.reduce((sum, d) => sum + d.turns, 0)).toBe(3);
      expect(withoutSource.models.map((m) => m.model.model)).toEqual(["other"]);
      expect(["full fork", "targeted fork", "nested fork"]).toContain(
        withoutSource.longestTurn?.sessionTitle,
      );
    } finally {
      for (const session of opened) await session.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("prices providers no longer in config by vendor list price", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "nctrn-usage-vendor-"));
    const sessionsDir = path.join(home, "sessions");
    try {
      await fs.mkdir(path.join(home, "cache"));
      await fs.mkdir(sessionsDir);
      await fs.writeFile(
        path.join(home, "cache", "models-dev.json"),
        JSON.stringify({
          fetchedAt: "2099-01-01T00:00:00Z",
          models: { "xai/grok-4.7": {} },
          providers: { xai: { models: { "grok-4.7": { cost: { input: 2, output: 8 } } } } },
        }),
      );
      const config = await loadConfig(createPlatform(), {
        nocturneHome: home,
        env: () => undefined,
      });
      const base = { sessionId: "s", time: new Date().toISOString() };
      const lines = [
        { provider: "removed", model: "grok-4.7" },
        { provider: "removed", model: "devin/swe-2-max" },
      ].map((model, i) => ({
        ...base,
        seq: i + 2,
        type: "message.assistant",
        payload: {
          messageId: `a${i}`,
          model,
          usage: { inputTokens: 1_000_000, outputTokens: 100_000 },
          content: [],
          toolCalls: [],
          finishReason: "stop",
        },
      }));
      await fs.writeFile(
        path.join(sessionsDir, "s.jsonl"),
        [
          {
            ...base,
            seq: 1,
            type: "session.created",
            payload: {
              formatVersion: 1,
              nocturneVersion: "test",
              cwd: home,
              workspaceRoot: home,
              model: { provider: "removed", model: "grok-4.7" },
              permissionPreset: "default",
            },
          },
          ...lines,
        ]
          .map((e) => JSON.stringify(e) + "\n")
          .join(""),
      );
      const runtime = await createRuntime({
        cwd: home,
        sessionsDir,
        config,
        providers: [new FakeProvider({ scripts: [] })],
      });
      const stats = await runtime.usageStats({});
      expect(stats.models.find((m) => m.model.model === "grok-4.7")).toMatchObject({
        pricing: { input: 2, output: 8 },
        pricingSource: "vendor",
        cost: { total: 2.8 },
      });
      expect(stats.unpricedModels).toEqual([{ provider: "removed", model: "devin/swe-2-max" }]);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("groups local midnight, includes rewound usage, skips corrupt logs and caches unchanged files", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nctrn-usage-cache-"));
    const platform = createPlatform();
    const read = vi.spyOn(platform.fs, "readTextFile");
    const time = new Date(2026, 9, 8, 23, 59).toISOString();
    const next = new Date(2026, 9, 9, 0, 1).toISOString();
    const base = { sessionId: "s", time };
    const model = { provider: "p", model: "m" };
    const events = [
      {
        ...base,
        seq: 1,
        type: "session.created",
        payload: {
          formatVersion: 1,
          nocturneVersion: "test",
          cwd: root,
          workspaceRoot: root,
          model,
          permissionPreset: "default",
        },
      },
      { ...base, seq: 2, type: "turn.started", turnId: "t", payload: { turnIndex: 1 } },
      {
        ...base,
        seq: 3,
        type: "message.assistant",
        turnId: "t",
        payload: {
          messageId: "a",
          model,
          usage: { inputTokens: 100, outputTokens: 20 },
          content: [],
          toolCalls: [],
          finishReason: "stop",
        },
      },
      {
        ...base,
        time: next,
        seq: 4,
        type: "turn.completed",
        turnId: "t",
        payload: { reason: "done", steps: 1, usage: { inputTokens: 100, outputTokens: 20 } },
      },
      {
        ...base,
        time: next,
        seq: 5,
        type: "context.compacted",
        payload: {
          kind: "summary",
          throughSeq: 4,
          summary: "摘要",
          model,
          usage: { inputTokens: 50, outputTokens: 10 },
        },
      },
      {
        ...base,
        seq: 6,
        type: "session.rewound",
        payload: { targetSeq: 2, mode: "conversation", files: [] },
      },
    ];
    try {
      await fs.writeFile(
        path.join(root, "s.jsonl"),
        events.map((e) => JSON.stringify(e) + "\n").join(""),
      );
      await fs.writeFile(path.join(root, "broken.jsonl"), "bad\n");
      const stats = createUsageStats({ platform, sessionsDir: root, pricing: () => undefined });
      const first = await stats({});
      expect(first.daily).toEqual([
        {
          date: "2026-10-08",
          tokens: 120,
          cost: 0,
          turns: 1,
          requests: 1,
          models: [{ model, tokens: 120, requests: 1 }],
        },
        {
          date: "2026-10-09",
          tokens: 60,
          cost: 0,
          turns: 0,
          requests: 1,
          models: [{ model, tokens: 60, requests: 1 }],
        },
      ]);
      expect(first.longestTurn?.durationMs).toBe(120_000);
      expect(first.skippedFiles).toBe(1);
      expect(first.unpricedModels).toEqual([model]);
      expect(read).toHaveBeenCalledTimes(2);
      expect(await stats({})).toEqual(first);
      expect(read).toHaveBeenCalledTimes(2);
      await fs.appendFile(
        path.join(root, "s.jsonl"),
        JSON.stringify({
          ...base,
          seq: 7,
          type: "session.titled",
          payload: { title: "标题", model: "p/m", usage: { inputTokens: 1, outputTokens: 1 } },
        }) + "\n",
      );
      expect((await stats({})).totals.inputTokens).toBe(151);
      expect(read).toHaveBeenCalledTimes(3);
    } finally {
      read.mockRestore();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("usageStats 延迟、性能序列与逐日按模型用量", () => {
  const NOW = new Date(2026, 9, 11, 16, 30).getTime(); // 周日 16:30（本地）
  const m1 = { provider: "p", model: "fast" };
  const m2 = { provider: "p", model: "old" };
  interface Msg {
    at: Date;
    model: { provider: string; model: string };
    usage?: Usage;
    timing?: { ttftMs?: number; durationMs: number };
    sessionId?: string;
  }
  function log(id: string, messages: Msg[], forkedFrom?: string): string {
    const first = messages[0]?.at ?? new Date(NOW);
    const lines: object[] = [
      {
        sessionId: id,
        seq: 1,
        time: first.toISOString(),
        type: "session.created",
        payload: {
          formatVersion: 1,
          nocturneVersion: "test",
          cwd: "/w",
          workspaceRoot: "/w",
          model: m1,
          permissionPreset: "default",
          ...(forkedFrom !== undefined ? { forkedFrom: { sessionId: forkedFrom, seq: 1 } } : {}),
        },
      },
    ];
    messages.forEach((m, i) =>
      lines.push({
        sessionId: m.sessionId ?? id,
        seq: i + 2,
        time: m.at.toISOString(),
        type: "message.assistant",
        turnId: "t",
        payload: {
          messageId: `a${i}`,
          model: m.model,
          content: [{ type: "text", text: "x" }],
          toolCalls: [],
          ...(m.usage !== undefined ? { usage: m.usage } : {}),
          ...(m.timing !== undefined ? { timing: m.timing } : {}),
          finishReason: "stop",
        },
      }),
    );
    return lines.map((l) => JSON.stringify(l) + "\n").join("");
  }
  async function withLogs(
    files: Record<string, string>,
    run: (stats: ReturnType<typeof createUsageStats>, reads: () => number) => Promise<void>,
    pricing: Parameters<typeof createUsageStats>[0]["pricing"] = () => undefined,
  ): Promise<void> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nctrn-usage-latency-"));
    const platform = createPlatform();
    const spy = vi.spyOn(platform.fs, "readTextFile");
    try {
      for (const [name, text] of Object.entries(files))
        await fs.writeFile(path.join(root, `${name}.jsonl`), text);
      await run(
        createUsageStats({ platform, sessionsDir: root, pricing, now: () => NOW }),
        () => spy.mock.calls.length,
      );
    } finally {
      spy.mockRestore();
      await fs.rm(root, { recursive: true, force: true });
    }
  }
  const at = (d: number, h: number, min = 0) => new Date(2026, 9, d, h, min);
  const u = (outputTokens: number, inputTokens = 1000): Usage => ({ inputTokens, outputTokens });

  it("平均耗时、平均 TTFT、按合计算的 Tokens/s 与 500ms 门槛；旧日志只进用量", async () => {
    const text = log("s", [
      { at: at(11, 9), model: m1, usage: u(200), timing: { ttftMs: 1000, durationMs: 3000 } },
      { at: at(11, 9, 30), model: m1, usage: u(400), timing: { ttftMs: 500, durationMs: 4500 } },
      // 生成 400ms：不进 Tokens/s，但计入耗时与 TTFT
      { at: at(11, 10), model: m1, usage: u(50), timing: { ttftMs: 100, durationMs: 500 } },
      // 没有内容事件：只有总耗时
      { at: at(11, 11), model: m1, usage: u(10), timing: { durationMs: 800 } },
      { at: at(11, 12), model: m1, usage: u(999) },
      { at: at(11, 12), model: m2, usage: u(30) },
    ]);
    await withLogs({ s: text }, async (stats) => {
      const result = await stats({ days: 7 });
      const fast = result.models.find((m) => m.model.model === "fast");
      const old = result.models.find((m) => m.model.model === "old");
      expect(fast?.requests).toBe(5);
      expect(fast?.outputTokens).toBe(1659);
      expect(fast?.latency).toEqual({
        samples: 4,
        avgDurationMs: 2200,
        avgTtftMs: 1600 / 3,
        tokensPerSecond: 100, // (200 + 400) ÷ (2s + 4s)，不是逐条平均
        speedSamples: 2,
      });
      expect(old?.latency).toBeUndefined();
      expect(old?.performance).toEqual([]);
      expect(old?.requests).toBe(1);
      expect(fast?.firstUsedAt).toBe(at(11, 9).toISOString());
      expect(fast?.lastUsedAt).toBe(at(11, 12).toISOString());
    });
  });

  it("缓存节省按 estimateCost 口径；未计价模型省略", async () => {
    const text = log("s", [
      {
        at: at(11, 9),
        model: m1,
        usage: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 800_000 },
      },
      { at: at(11, 9), model: m2, usage: u(1) },
    ]);
    await withLogs(
      { s: text },
      async (stats) => {
        const result = await stats({ days: 7 });
        // 全按输入价 $2；实际 0.2M × $2 + 0.8M × $0.2 = $0.56
        expect(result.models.find((m) => m.model.model === "fast")?.cacheSavings).toBeCloseTo(0.72);
        expect(result.models.find((m) => m.model.model === "old")?.cacheSavings).toBeUndefined();
      },
      (ref) =>
        ref.model === "fast"
          ? { pricing: { input: 2, output: 8, cacheRead: 0.2 }, pricingSource: "config" }
          : undefined,
    );
  });

  it("分桶粒度：7 天按小时，8 与 31 天按日，32 天与全部按周", async () => {
    await withLogs({}, async (stats) => {
      expect((await stats({ days: 7 })).performanceGranularity).toBe("hour");
      expect((await stats({ days: 8 })).performanceGranularity).toBe("day");
      expect((await stats({ days: 31 })).performanceGranularity).toBe("day");
      expect((await stats({ days: 32 })).performanceGranularity).toBe("week");
      expect((await stats({})).performanceGranularity).toBe("week");
    });
  });

  it("按小时 / 按日分桶只列有计时的桶，桶内 Tokens/s 按合计算", async () => {
    const text = log("s", [
      { at: at(10, 14, 5), model: m1, usage: u(100), timing: { ttftMs: 200, durationMs: 1200 } },
      { at: at(10, 14, 50), model: m1, usage: u(300), timing: { ttftMs: 400, durationMs: 3400 } },
      { at: at(10, 16), model: m1, usage: u(9) },
      { at: at(11, 9), model: m1, usage: u(50), timing: { ttftMs: 600, durationMs: 1100 } },
    ]);
    await withLogs({ s: text }, async (stats) => {
      const hourly = (await stats({ days: 7 })).models[0]?.performance;
      expect(hourly).toEqual([
        { start: at(10, 14).toISOString(), samples: 2, tokensPerSecond: 100, avgTtftMs: 300 },
        { start: at(11, 9).toISOString(), samples: 1, tokensPerSecond: 100, avgTtftMs: 600 },
      ]);
      const daily = (await stats({ days: 30 })).models[0]?.performance;
      expect(daily?.map((p) => [p.start, p.samples])).toEqual([
        [at(10, 0).toISOString(), 2],
        [at(11, 0).toISOString(), 1],
      ]);
    });
  });

  it("周桶从周一起算；只有计时没有 usage 的消息不算请求", async () => {
    const weekly = log("s", [
      {
        at: new Date(2026, 8, 16, 10),
        model: m1,
        usage: u(1),
        timing: { ttftMs: 100, durationMs: 900 },
      },
      { at: new Date(2026, 8, 20, 23), model: m1, timing: { ttftMs: 300, durationMs: 900 } },
      { at: new Date(2026, 8, 21, 0, 1), model: m1, timing: { ttftMs: 500, durationMs: 900 } },
    ]);
    await withLogs({ s: weekly }, async (stats) => {
      const fast = (await stats({})).models[0];
      expect(fast?.requests).toBe(1);
      expect(fast?.performance.map((p) => [p.start, p.samples, p.avgTtftMs])).toEqual([
        [new Date(2026, 8, 14).toISOString(), 2, 200],
        [new Date(2026, 8, 21).toISOString(), 1, 500],
      ]);
      // 生成 800ms、输出 1 token 的样本进 Tokens/s；没有 usage 的不进
      expect(fast?.performance[0]?.tokensPerSecond).toBe(1 / 0.8);
      expect(fast?.performance[1]?.tokensPerSecond).toBeUndefined();
    });
  });

  it("超过 168 个周桶时只保留最近 168 个", async () => {
    const many = log(
      "many",
      Array.from({ length: 170 }, (_, i) => ({
        at: new Date(2026, 9, 7 - (169 - i) * 7, 12),
        model: m1,
        usage: u(10),
        timing: { ttftMs: 100, durationMs: 900 },
      })),
    );
    await withLogs({ many }, async (stats) => {
      const perf = (await stats({})).models[0]?.performance ?? [];
      expect(perf).toHaveLength(168);
      expect(perf.at(-1)?.start).toBe(new Date(2026, 9, 5).toISOString());
      expect(perf[0]?.start).toBe(new Date(2026, 9, 5 - 167 * 7).toISOString());
    });
  });

  it("逐日按模型拆分之和等于当天合计，范围外日期不拆分", async () => {
    const text = log("s", [
      { at: at(1, 10), model: m1, usage: u(100) },
      { at: at(10, 9), model: m1, usage: u(100) },
      { at: at(10, 10), model: m2, usage: u(500, 2000) },
      { at: at(10, 11), model: m1, usage: u(20) },
    ]);
    await withLogs({ s: text }, async (stats) => {
      const result = await stats({ days: 7 });
      const outside = result.daily.find((d) => d.date === "2026-10-01");
      expect(outside).toEqual({ date: "2026-10-01", tokens: 1100, cost: 0, turns: 0 });
      const day = result.daily.find((d) => d.date === "2026-10-10");
      expect(day?.requests).toBe(3);
      expect(day?.models).toEqual([
        { model: m2, tokens: 2500, requests: 1 },
        { model: m1, tokens: 2120, requests: 2 },
      ]);
      expect(day?.models?.reduce((n, m) => n + m.tokens, 0)).toBe(day?.tokens);
    });
  });

  it("分叉日志复制的计时不计入；缓存命中后新字段不丢", async () => {
    const source = log("src", [
      { at: at(10, 9), model: m1, usage: u(100), timing: { ttftMs: 100, durationMs: 1100 } },
    ]);
    const fork = log(
      "fork",
      [
        {
          at: at(10, 9),
          model: m1,
          usage: u(100),
          timing: { ttftMs: 100, durationMs: 1100 },
          sessionId: "src",
        },
        { at: at(11, 9), model: m1, usage: u(300), timing: { ttftMs: 1000, durationMs: 4000 } },
      ],
      "src",
    );
    await withLogs({ src: source, fork }, async (stats, reads) => {
      const first = await stats({ days: 7 });
      const fast = first.models[0];
      expect(fast?.requests).toBe(2);
      expect(fast?.latency?.samples).toBe(2);
      expect(fast?.performance.map((p) => p.samples)).toEqual([1, 1]);
      expect(reads()).toBe(2);
      const again = await stats({ days: 7 });
      expect(reads()).toBe(2);
      expect(again).toEqual(first);
      expect(again.models[0]?.latency?.tokensPerSecond).toBe(400 / 4);
    });
  });
});
