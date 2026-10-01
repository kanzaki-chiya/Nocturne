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
    const broad = ["guarded", "smart", "bypass"].includes(preset);
    expect(
      p.evaluate([{ kind: "read", target: "C:/ws/a", resolved: "C:/ws/a" }]).decision.action,
    ).toBe("allow");
    expect(p.evaluate([edit("C:/ws/a")]).decision.action).toBe(
      preset === "read-only" ? "deny" : preset === "default" ? "ask" : "allow",
    );
    expect(p.evaluate([edit("C:/outside/a")]).decision.action).toBe(
      preset === "read-only" ? "deny" : preset === "bypass" ? "allow" : "ask",
    );
    for (const subject of [
      shell("git status"),
      { kind: "network", target: "https://example.test" } as const,
      { kind: "mcp", target: "s/t" } as const,
    ])
      expect(p.evaluate([subject]).decision.action).toBe(broad ? "allow" : "ask");
  });
  it("smart 与 guarded 规则序列一致", () => {
    expect(presetRules("smart", ctx)).toEqual(presetRules("guarded", ctx));
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
        expect(request.reason).toContain("审查：拿不准 — 测试理由");
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
  it("审查合并 ask 主体，仅带三个截断的用户消息，无工具细节", async () => {
    const { gate, reviewer, turn } = setup("allow", false, {
      cwd: "C:/ws",
      recentUserMessages: () => ["old", "a".repeat(3000), "b", "c"],
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
    expect(input?.recentUserMessages).toEqual(["a".repeat(2000), "b", "c"]);
    expect(input?.cwd).toBe("C:/ws");
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

describe("模型审查后端", () => {
  it.each(["ALLOW", "BLOCK", "UNSURE"])("解析 %s 首行", (first) => {
    expect(parseReview(`${first}\n理由`)).toEqual({ verdict: first.toLowerCase(), reason: "理由" });
  });
  it.each([
    "ALLOW",
    "ALLOW because",
    "allow\n理由",
    "```\nALLOW\n理由",
    "YES\n理由",
    "__proto__\n理由",
    "constructor\n理由",
  ])("格式错按 unsure：%s", (text) => {
    expect(parseReview(text).verdict).toBe("unsure");
  });
  it("经 Provider 请求，无工具/思考参数，300 输出 token，保留独立用量", async () => {
    const provider = new FakeProvider({
      scripts: [
        [
          { type: "text_delta", text: "ALLOW\n已授权" },
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
      await reviewer.review({ subjects: [], cwd: "C:/ws", recentUserMessages: [] }, signal()),
    ).toEqual({ verdict: "allow", reason: "已授权", usage: { inputTokens: 12, outputTokens: 3 } });
    expect(provider.requests[0]).toMatchObject({
      tools: [],
      maxOutputTokens: 300,
      sessionId: "root",
    });
    expect(provider.requests[0]?.reasoningEffort).toBeUndefined();
  });
});
