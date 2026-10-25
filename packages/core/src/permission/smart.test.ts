import { describe, expect, it, vi } from "vitest";
import {
  createRulePolicy,
  PERMISSION_PRESET_NAMES,
  presetRules,
  createPolicyGate,
  grantFromSubject,
} from "./index.js";
import type { PermissionSubject } from "../protocol/index.js";

const ctx = { workspaceRoot: "C:/ws", caseSensitive: false, nocturneHome: "C:/home" };
const edit = (path: string): PermissionSubject => ({ kind: "edit", target: path, resolved: path });
const shell = (target: string): PermissionSubject => ({ kind: "shell", target });

describe("ADR-0036 预设", () => {
  it.each(PERMISSION_PRESET_NAMES)("%s 普通主体矩阵", (preset) => {
    const p = createRulePolicy({ ...ctx, preset, presetContext: ctx });
    const broad = ["guarded", "bypass"].includes(preset);
    expect(
      p.evaluate([{ kind: "read", target: "C:/ws/a", resolved: "C:/ws/a" }]).decision.action,
    ).toBe("allow");
    expect(p.evaluate([edit("C:/ws/a")]).decision.action).toBe(
      preset === "read-only" ? "deny" : preset === "default" ? "ask" : "allow",
    );
    expect(p.evaluate([edit("C:/outside/a")]).decision.action).toBe(
      preset === "read-only" ? "deny" : preset === "bypass" ? "allow" : "ask",
    );
    // ADR-0057：smart 的 shell / network / mcp 不再宽放行；只读白名单与 readOnlyHint 另走 smart-routes.test.ts
    for (const subject of [
      shell("git status"),
      { kind: "network", target: "https://example.test" } as const,
      { kind: "mcp", target: "s/t" } as const,
    ])
      expect(p.evaluate([subject]).decision.action).toBe(
        broad || (preset === "smart" && subject.target === "git status") ? "allow" : "ask",
      );
  });
  it("只由用户确认依赖结构化标记，与显示 label 无关", () => {
    const baseRules = presetRules("smart", ctx).map((rule) => ({
      ...rule,
      label: rule.userOnly ? "renamed" : "预设：授权数据",
    }));
    const policy = createRulePolicy({ ...ctx, baseRules });
    for (const path of ["C:/ws/.nocturne/config.json", "C:/home/settings.json"])
      expect(policy.evaluate([edit(path)])).toMatchObject({
        decision: { action: "ask" },
        userOnly: true,
      });
    expect(policy.evaluate([edit("C:/ws/.git/config")])).toMatchObject({
      decision: { action: "ask" },
      userOnly: false,
    });
  });
  it("smart 与 guarded 只在 shell / network / mcp 三条宽规则上不同（ADR-0057）", () => {
    const smart = presetRules("smart", ctx);
    const guarded = presetRules("guarded", ctx);
    expect(smart).toHaveLength(guarded.length);
    const differing = smart.filter(
      (rule, i) => JSON.stringify(rule) !== JSON.stringify(guarded[i]),
    );
    expect(differing.map((rule) => [rule.kind, rule.action])).toEqual([
      ["shell", "ask"],
      ["network", "ask"],
      ["mcp", "ask"],
    ]);
  });
  it("bypass 撤销四类降级，保留授权数据、凭据与显式规则", () => {
    const p = createRulePolicy({
      ...ctx,
      preset: "bypass",
      presetContext: ctx,
      protectedPaths: { lexical: ["C:/home/credentials.json"] },
      rules: [
        { origin: "user", rule: { kind: "shell", pattern: "ask *", action: "ask" } },
        { origin: "cli", rule: { kind: "shell", pattern: "deny *", action: "deny" } },
      ],
    });
    for (const subject of [
      edit("C:/outside/a"),
      edit("C:/ws/.git/config"),
      shell("rm -rf build"),
      shell("pwsh -EncodedCommand abc"),
    ])
      expect(p.evaluate([subject]).decision.action).toBe("allow");
    for (const path of [
      "C:/ws/.nocturne/config.json",
      "C:/home/config.json",
      "C:/home/settings.json",
      "C:/home/trust.json",
      "C:/home/providers.json",
      "C:/home/grants/x",
      "C:/home/schedules.json",
      "C:/home/schedules/history/t.jsonl",
    ])
      expect(p.evaluate([edit(path)]).decision.action).toBe("ask");
    expect(p.evaluate([edit("C:/home/credentials.json")]).decision.action).toBe("deny");
    expect(p.evaluate([shell("cat credentials.json")]).decision.action).toBe("ask");
    expect(p.evaluate([shell("ask something")]).decision.action).toBe("ask");
    expect(p.evaluate([shell("deny something")]).decision.action).toBe("deny");
  });
});

import type { GateTurnContext, SecurityReviewer, ReviewResult } from "./types.js";
import { createModelSecurityReviewer, parseReview } from "./reviewer.js";
import { FakeProvider } from "../provider/index.js";

function setup(
  verdict: ReviewResult["verdict"] = "allow",
  interactive = false,
  extra: Parameters<typeof createPolicyGate>[1] = {},
  policyOptions: Partial<Parameters<typeof createRulePolicy>[0]> = {},
) {
  const reviewer: SecurityReviewer = {
    review: vi.fn(async () => ({ verdict, reason: "测试理由" })),
  };
  const events: { type: string; payload: unknown }[] = [];
  const turn: GateTurnContext = {
    turnId: "t",
    events: {
      emit: async (type, payload) => {
        events.push({ type, payload });
      },
      emitEphemeral: vi.fn(),
    },
  };
  const policy = createRulePolicy({
    ...ctx,
    preset: "smart",
    presetContext: ctx,
    ...policyOptions,
  });
  const gate = createPolicyGate(policy, {
    interactive,
    caseSensitive: false,
    preset: () => "smart",
    reviewer: () => reviewer,
    ...extra,
  });
  return { reviewer, events, turn, gate };
}
const signal = () => new AbortController().signal;
async function requested(events: { type: string; payload: unknown }[]) {
  await vi.waitFor(() => expect(events.some((e) => e.type === "permission.requested")).toBe(true));
  return events.find((e) => e.type === "permission.requested")?.payload as {
    requestId: string;
    options: string[];
    reason: string;
  };
}

describe("ADR-0036 审查闸门", () => {
  it.each([true, false])("三种结论，interactive=%s", async (interactive) => {
    for (const verdict of ["allow", "block", "unsure"] as const) {
      const { gate, events, turn } = setup(verdict, interactive);
      const operation = gate.check([edit("C:/outside/a")], "call", signal(), turn);
      if (verdict === "unsure" && interactive) {
        const request = await requested(events);
        expect(request.reason).toContain("审查：交给你确认 — 测试理由");
        expect(events.map((e) => e.type).slice(0, 2)).toEqual([
          "permission.reviewed",
          "permission.requested",
        ]);
        await gate.respond?.(request.requestId, { decision: "allow" });
      }
      const result = await operation;
      expect(result.decision.action).toBe(
        verdict === "allow" || (verdict === "unsure" && interactive) ? "allow" : "deny",
      );
      expect(result.decision.source).toBe(
        verdict === "unsure" ? (interactive ? "user" : "non_interactive") : "reviewer",
      );
    }
  });
  it.each(["allow", "block", "unsure"] as const)("只缓存 allow：%s", async (verdict) => {
    const { gate, reviewer, events, turn } = setup(verdict);
    await gate.check([edit("C:/outside/a")], "a", signal(), turn);
    await gate.check([edit("c:/OUTSIDE/a")], "b", signal(), turn);
    expect(reviewer.review).toHaveBeenCalledTimes(verdict === "allow" ? 1 : 2);
    expect(
      events
        .filter((e) => e.type === "permission.reviewed")
        .map((e) => (e.payload as { cached: boolean }).cached),
    ).toEqual([false, verdict === "allow"]);
    await gate.check([edit("C:/outside/other")], "c", signal(), turn);
    expect(reviewer.review).toHaveBeenCalledTimes(verdict === "allow" ? 2 : 3);
  });
  it.each(["同一轮", "下一轮"])("依赖用户授权的放行在%s再次送审，追加限制生效", async (scope) => {
    let requestedByUser = true;
    const reviewer: SecurityReviewer = {
      review: vi.fn(async () =>
        parseReview(
          JSON.stringify({
            requested: requestedByUser,
            destroys: false,
            credentials: false,
            exfiltrates: false,
            weakens: false,
            crosses: true,
            opaque: false,
            reason: requestedByUser ? "用户要求推送" : "用户要求先别 push",
          }),
        ),
      ),
    };
    const { gate, events, turn } = setup("allow", false, { reviewer: () => reviewer });
    const subjects = [shell("git push origin main")];
    expect((await gate.check(subjects, "a", signal(), turn)).decision.action).toBe("allow");
    requestedByUser = false;
    const nextTurn = scope === "同一轮" ? turn : { ...turn, turnId: "next" };
    expect((await gate.check(subjects, "b", signal(), nextTurn)).decision).toMatchObject({
      action: "deny",
      source: "non_interactive",
    });
    expect(reviewer.review).toHaveBeenCalledTimes(2);
    expect(
      events.filter((e) => e.type === "permission.reviewed").map((e) => e.payload),
    ).toMatchObject([
      { verdict: "allow", cached: false },
      { verdict: "unsure", cached: false },
    ]);
    expect(events.some((e) => "cacheable" in (e.payload as object))).toBe(false);
  });
  it("风险题全否的放行仍缓存，第二次事件 cached 为 true", async () => {
    const reviewer: SecurityReviewer = {
      review: vi.fn(async () =>
        parseReview(
          JSON.stringify({
            requested: false,
            destroys: false,
            credentials: false,
            exfiltrates: false,
            weakens: false,
            crosses: false,
            opaque: false,
            reason: "无风险",
          }),
        ),
      ),
    };
    const { gate, events, turn } = setup("allow", false, { reviewer: () => reviewer });
    const subjects = [{ kind: "network", target: "example.test" } as const];
    await gate.check(subjects, "a", signal(), turn);
    await gate.check(subjects, "b", signal(), { ...turn, turnId: "next" });
    expect(reviewer.review).toHaveBeenCalledOnce();
    expect(
      events.filter((e) => e.type === "permission.reviewed").map((e) => e.payload),
    ).toMatchObject([
      { verdict: "allow", cached: false },
      { verdict: "allow", cached: true },
    ]);
  });
  it("自定义审查器未返回 cacheable 时照旧缓存", async () => {
    const { gate, reviewer, events, turn } = setup();
    const subjects = [shell("git push origin main")];
    await gate.check(subjects, "a", signal(), turn);
    await gate.check(subjects, "b", signal(), { ...turn, turnId: "next" });
    expect(reviewer.review).toHaveBeenCalledOnce();
    expect(events.filter((e) => e.type === "permission.reviewed").at(-1)?.payload).toMatchObject({
      cached: true,
    });
  });
  it.each(["error", "timeout", "invalid"])("%s 降级 unsure", async (failure) => {
    const reviewer: SecurityReviewer = {
      review: vi.fn(async () => {
        if (failure === "error") throw new Error("backend failed");
        if (failure === "timeout")
          return await new Promise<ReviewResult>(() => {
            /* pending until gate aborts */
          });
        return { verdict: "oops", reason: "invalid" } as unknown as ReviewResult;
      }),
    };
    const { gate, events, turn } = setup("allow", false, {
      reviewer: () => reviewer,
      reviewTimeoutMs: 5,
    });
    const result = await gate.check([edit("C:/outside/a")], "a", signal(), turn);
    expect(result.decision).toMatchObject({ action: "deny", source: "non_interactive" });
    expect(events.find((e) => e.type === "permission.reviewed")?.payload).toMatchObject({
      verdict: "unsure",
    });
  });
  it("中止审查按 cancelled 结算，不记审查放行", async () => {
    const reviewer: SecurityReviewer = {
      review: vi.fn(
        async () =>
          await new Promise<ReviewResult>(() => {
            /* pending until gate aborts */
          }),
      ),
    };
    const { gate, events, turn } = setup("allow", false, { reviewer: () => reviewer });
    const controller = new AbortController();
    const operation = gate.check([edit("C:/outside/a")], "a", controller.signal, turn);
    controller.abort();
    expect(await operation).toMatchObject({ cancelled: true, decision: { source: "cancelled" } });
    expect(events).toEqual([]);
  });
  it("关闭会话也取消正在审查的请求", async () => {
    const reviewer: SecurityReviewer = {
      review: vi.fn(
        async () =>
          await new Promise<ReviewResult>(() => {
            /* pending until gate aborts */
          }),
      ),
    };
    const { gate, turn } = setup("allow", false, { reviewer: () => reviewer });
    const operation = gate.check([edit("C:/outside/a")], "a", signal(), turn);
    gate.cancelAll?.();
    expect(await operation).toMatchObject({ cancelled: true });
  });
  it.each(["grant", "yes", "hook"])("%s 在审查之前生效", async (kind) => {
    const { gate, reviewer, turn } = setup(
      "block",
      false,
      kind === "hook" ? { hooks: { run: async () => ({ action: "allow" }) } } : {},
      kind === "grant"
        ? { grants: { session: [grantFromSubject(edit("C:/outside/a"), false)] } }
        : kind === "yes"
          ? { autoApproveAsk: true }
          : {},
    );
    expect((await gate.check([edit("C:/outside/a")], "a", signal(), turn)).decision.action).toBe(
      "allow",
    );
    expect(reviewer.review).not.toHaveBeenCalled();
  });
  it("只由用户确认的主体与 Hook 强制 ask 都不经审查", async () => {
    const { gate, reviewer, turn } = setup(
      "allow",
      false,
      {},
      {
        rules: [
          { origin: "user", rule: { kind: "shell", pattern: "user *", action: "ask" } },
          { origin: "project", rule: { kind: "shell", pattern: "project *", action: "ask" } },
          { origin: "cli", rule: { kind: "shell", pattern: "cli *", action: "ask" } },
        ],
      },
    );
    for (const subject of [
      edit("C:/home/config.json"),
      edit("C:/home/settings.json"),
      edit("C:/home/providers.json"),
      edit("C:/home/trust.json"),
      edit("C:/home/grants/a"),
      edit("C:/ws/.nocturne/config.json"),
      shell("cat credentials.json"),
      shell("user do"),
      shell("project do"),
      shell("cli do"),
    ]) {
      expect((await gate.check([subject], "a", signal(), turn)).decision.source).toBe(
        "non_interactive",
      );
    }
    expect(
      (await gate.check([edit("C:/outside/a")], "a", signal(), turn, { forceAsk: true })).decision
        .source,
    ).toBe("non_interactive");
    expect(reviewer.review).not.toHaveBeenCalled();
  });
  it("混合主体只要有用户专属 ask 就不调审查器", async () => {
    const { gate, reviewer, turn } = setup();
    await gate.check([edit("C:/outside/a"), edit("C:/ws/.nocturne/a")], "a", signal(), turn);
    expect(reviewer.review).not.toHaveBeenCalled();
  });
  it("审查合并 ask 主体，带全部用户消息（单条截断），无工具细节", async () => {
    const { gate, reviewer, turn } = setup("allow", false, {
      cwd: "C:/ws",
      userMessages: () => ["old", "a".repeat(3000), "b", "c"],
    });
    await gate.check(
      [
        { ...edit("C:/outside/a"), detail: "secret tool output" },
        edit("C:/ws/.git/config"),
        edit("C:/ws/allowed"),
      ],
      "a",
      signal(),
      turn,
    );
    const input = vi.mocked(reviewer.review).mock.calls[0]?.[0];
    expect(input?.subjects.map((s) => s.target)).toEqual(["C:/outside/a", "C:/ws/.git/config"]);
    expect(JSON.stringify(input)).not.toContain("secret tool output");
    expect(input?.userMessages).toEqual(["old", "a".repeat(2000), "b", "c"]);
    expect(input?.cwd).toBe("C:/ws");
  });
  it("用户消息超出预算：保留第一条和最近几条，中间标注省略", async () => {
    const messages = Array.from({ length: 10 }, (_, i) => `${String(i)}`.padEnd(2000, "x"));
    const { gate, reviewer, turn } = setup("allow", false, { userMessages: () => messages });
    await gate.check([edit("C:/outside/a")], "a", signal(), turn);
    const sent = vi.mocked(reviewer.review).mock.calls[0]?.[0].userMessages ?? [];
    expect(sent[0]).toBe(messages[0]);
    expect(sent[1]).toMatch(/^（省略 \d+ 条）$/);
    expect(sent.at(-1)).toBe(messages.at(-1));
    expect(sent.filter((text) => text.length === 2000).length).toBe(3);
  });
  it("项目说明、可信 remote、环境与追加规则随审查输入送出", async () => {
    const { gate, reviewer, turn } = setup("allow", false, {
      projectNotes: () => "项目约定：不要推送",
      trustedRemotes: async () => ["origin https://example.test/a.git"],
      environment: { workspaceRoot: "C:/ws", nocturneHome: "C:/home" },
      reviewerRules: () => ({ ask: "任何 docker 命令" }),
    });
    await gate.check([edit("C:/outside/a")], "a", signal(), turn);
    expect(vi.mocked(reviewer.review).mock.calls[0]?.[0]).toMatchObject({
      projectNotes: "项目约定：不要推送",
      trustedRemotes: ["origin https://example.test/a.git"],
      environment: { workspaceRoot: "C:/ws", nocturneHome: "C:/home" },
      reviewerRules: { ask: "任何 docker 命令" },
    });
  });
  it("facts 注入：带事实送审；查询失败时审查照常进行", async () => {
    const withFacts = setup("allow", false, {
      facts: async () => ({ push: { remote: "origin", branch: "main", trusted: true } }),
    });
    await withFacts.gate.check([edit("C:/outside/a")], "a", signal(), withFacts.turn);
    expect(vi.mocked(withFacts.reviewer.review).mock.calls[0]?.[0].facts).toEqual({
      push: { remote: "origin", branch: "main", trusted: true },
    });

    const failing = setup("allow", false, {
      facts: async () => {
        throw new Error("git 不可用");
      },
      trustedRemotes: async () => {
        throw new Error("读取失败");
      },
    });
    const result = await failing.gate.check([edit("C:/outside/a")], "a", signal(), failing.turn);
    expect(result.decision).toMatchObject({ action: "allow", source: "reviewer" });
    const sent = vi.mocked(failing.reviewer.review).mock.calls[0]?.[0];
    expect(sent?.facts).toBeUndefined();
    expect(sent?.trustedRemotes).toEqual([]);
  });
  it("smart 未配置审查器、其他预设都不调审查", async () => {
    for (const preset of PERMISSION_PRESET_NAMES) {
      const { gate, reviewer, turn } = setup("allow", false, {
        preset: () => preset,
        ...(preset === "smart" ? { reviewer: () => undefined } : {}),
      });
      expect((await gate.check([edit("C:/outside/a")], "a", signal(), turn)).decision.source).toBe(
        "non_interactive",
      );
      expect(reviewer.review).not.toHaveBeenCalled();
    }
  });
  it.each([edit("C:/outside/a"), shell("rm -rf build"), shell("pwsh -EncodedCommand abc")])(
    "危险 ask 只给一次性选项：$target",
    async (subject) => {
      const { gate, events, turn } = setup("unsure", true);
      const operation = gate.check([subject], "a", signal(), turn);
      const request = await requested(events);
      expect(request.options).toEqual(["allow_once", "deny", "deny_stop"]);
      expect(
        await gate.respond?.(request.requestId, { decision: "allow", remember: "session" }),
      ).toBe(false);
      expect(
        await gate.respond?.(request.requestId, { decision: "allow", remember: "project" }),
      ).toBe(false);
      await gate.respond?.(request.requestId, { decision: "deny", stop: true });
      expect(await operation).toMatchObject({ stopTurn: true });
    },
  );
  it("普通确认仍有长期选项", async () => {
    const { gate, events, turn } = setup(
      "unsure",
      true,
      { preset: () => "default" },
      { preset: "default" },
    );
    const operation = gate.check([edit("C:/ws/a")], "a", signal(), turn);
    const request = await requested(events);
    expect(request.options).toEqual([
      "allow_once",
      "allow_session",
      "allow_project",
      "deny",
      "deny_stop",
    ]);
    await gate.respond?.(request.requestId, { decision: "allow" });
    await operation;
  });
});

describe("模型审查后端（七题 JSON）", () => {
  const json = (patch: Record<string, boolean>, reason = "理由") =>
    JSON.stringify({
      requested: false,
      destroys: false,
      credentials: false,
      exfiltrates: false,
      weakens: false,
      crosses: false,
      opaque: false,
      ...patch,
      reason,
    });
  it("全否放行；Q1 为真时 Q6 为是仍放行", () => {
    expect(parseReview(json({}))).toEqual({ verdict: "allow", reason: "理由", cacheable: true });
    expect(parseReview(json({ requested: true, crosses: true }))).toMatchObject({
      verdict: "allow",
      cacheable: false,
    });
  });
  it("风险题为是且 Q1 为否交人，理由列出是题", () => {
    const result = parseReview(json({ crosses: true }, "推了分支"));
    expect(result.verdict).toBe("unsure");
    expect(result.reason).toContain("会推送");
    expect(result.reason).toContain("用户未点名要求");
  });
  it("容忍代码块包裹", () => {
    expect(parseReview(`\`\`\`json\n${json({})}\n\`\`\``).verdict).toBe("allow");
  });
  it.each([
    "ALLOW\n理由",
    '{"requested": false, "reason": "缺字段"}',
    '{"requested": false, "destroys": "no", "credentials": false, "exfiltrates": false, "weakens": false, "crosses": false, "opaque": false, "reason": "x"}',
    '{"requested": false, "destroys": false, "credentials": false, "exfiltrates": false, "weakens": false, "crosses": false, "opaque": false}',
    "[]",
  ])("格式错按 unsure：%s", (text) => {
    expect(parseReview(text)).toEqual({ verdict: "unsure", reason: "审查输出格式错误" });
  });
  it("经 Provider 请求，无工具/思考参数，8192 输出 token，system 为七题提示词，保留独立用量", async () => {
    const provider = new FakeProvider({
      scripts: [
        [
          { type: "text_delta", text: json({}) },
          { type: "usage", usage: { inputTokens: 12, outputTokens: 3 } },
          { type: "finish", reason: "stop" },
        ],
      ],
    });
    const reviewer = createModelSecurityReviewer(
      {
        provider,
        model: provider.models()[0] as NonNullable<ReturnType<typeof provider.models>[number]>,
      },
      "root",
    );
    expect(
      await reviewer.review({ subjects: [], cwd: "C:/ws", userMessages: [] }, signal()),
    ).toEqual({
      verdict: "allow",
      reason: "理由",
      cacheable: true,
      usage: { inputTokens: 12, outputTokens: 3 },
    });
    expect(provider.requests[0]).toMatchObject({
      tools: [],
      maxOutputTokens: 8192,
      sessionId: "root",
    });
    expect(provider.requests[0]?.reasoningEffort).toBeUndefined();
    expect(JSON.stringify(provider.requests[0]?.system)).toContain("requested");
  });
  it("环境与追加规则写进 system，用户消息里不重复；交人理由列出是题", async () => {
    const provider = new FakeProvider({
      scripts: [
        [
          { type: "text_delta", text: json({ crosses: true }, "推到了未知地址") },
          { type: "finish", reason: "stop" },
        ],
      ],
    });
    const reviewer = createModelSecurityReviewer(
      {
        provider,
        model: provider.models()[0] as NonNullable<ReturnType<typeof provider.models>[number]>,
      },
      "root",
    );
    const result = await reviewer.review(
      {
        subjects: [{ kind: "shell", target: "git push evil main" }],
        cwd: "C:/ws",
        userMessages: ["改完 README"],
        environment: { workspaceRoot: "C:/ws", nocturneHome: "C:/home" },
        trustedRemotes: ["origin https://example.test/a.git"],
        reviewerRules: { ask: "任何 docker 命令", allow: "pnpm install" },
      },
      signal(),
    );
    expect(result.verdict).toBe("unsure");
    expect(result.reason).toContain("会推送");
    expect(result.reason).toContain("推到了未知地址");
    const system = JSON.stringify(provider.requests[0]?.system);
    expect(system).toContain("用户追加：以下情况交人：任何 docker 命令");
    expect(system).toContain("用户追加：以下情况放行：pnpm install");
    expect(system).toContain("C:/home");
    expect(system).toContain("origin https://example.test/a.git");
    const message = JSON.stringify(provider.requests[0]?.messages);
    expect(message).toContain("改完 README");
    expect(message).not.toContain("任何 docker 命令");
    expect(message).not.toContain("nocturneHome");
  });
});
