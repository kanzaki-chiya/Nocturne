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
        { date: "2026-10-08", tokens: 120, cost: 0, turns: 1 },
        { date: "2026-10-09", tokens: 60, cost: 0, turns: 0 },
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
