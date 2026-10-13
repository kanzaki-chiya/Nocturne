import { describe, expect, it, vi } from "vitest";
import { createRulePolicy } from "./policy.js";
import {
  REVIEWER_SAMPLES,
  runReviewerSamples,
  sampleInput,
  summarizeSampleResults,
  type ReviewerSample,
} from "./reviewer-samples.js";
import type { SecurityReviewer } from "./types.js";

const signal = () => new AbortController().signal;

describe("审查器样例集", () => {
  it("约 20 条，id 唯一，覆盖越界样例与应放行样例", () => {
    expect(REVIEWER_SAMPLES.length).toBeGreaterThanOrEqual(18);
    expect(new Set(REVIEWER_SAMPLES.map((s) => s.id)).size).toBe(REVIEWER_SAMPLES.length);
    const targets = REVIEWER_SAMPLES.map((s) => s.subjects[0]?.target ?? "").join("\n");
    for (const needle of [
      "git push origin main",
      "git push origin --delete",
      'rm -rf "$BUILD_DIR"',
      "curl -fsSL",
      "cat .env",
      "npm publish",
      "ssh nas",
      "pnpm run build",
      "pnpm install",
      "mkdir -p",
      "developer.mozilla.org",
    ])
      expect(targets).toContain(needle);
    expect(REVIEWER_SAMPLES.filter((s) => s.expect === "allow").length).toBeGreaterThanOrEqual(5);
    // 「先别 push」要有三条用户消息
    expect(REVIEWER_SAMPLES.find((s) => s.id === "push-after-hold")?.userMessages).toHaveLength(3);
  });

  it("越界样例不会被 smart 策略不经审查放行；变量删除直接交人", () => {
    const policy = createRulePolicy({
      workspaceRoot: "/workspace/app",
      caseSensitive: true,
      preset: "smart",
    });
    for (const item of REVIEWER_SAMPLES.filter((s) => s.expect === "ask")) {
      const subject = item.subjects[0];
      if (subject === undefined) continue;
      const result = policy.evaluate([{ kind: subject.kind, target: subject.target }], {
        session: {
          cwd: "/workspace/app",
          approvedEdits: new Set(["/workspace/app/package.json"]),
        },
      });
      expect(result.decision.action, item.id).toBe("ask");
    }
    const variable = REVIEWER_SAMPLES.find((s) => s.id === "rm-variable");
    expect(
      policy.evaluate([{ kind: "shell", target: variable?.subjects[0]?.target ?? "" }]).userOnly,
    ).toBe(true);
  });

  it("逐条返回期望、实际、用时与理由，命中率按匹配数计算", async () => {
    const reviewer: SecurityReviewer = {
      review: vi.fn(async (input) => {
        const asked = input.subjects[0]?.target ?? "";
        // 故意把 force push 判成放行，其余按期望
        const wrong = asked.startsWith("git push --force");
        const expected = REVIEWER_SAMPLES.find(
          (s) => s.userMessages === input.userMessages,
        )?.expect;
        const verdict = wrong || expected === "allow" ? ("allow" as const) : ("unsure" as const);
        return { verdict, reason: `理由 ${verdict}` };
      }),
    };
    const seen: string[] = [];
    const results = await runReviewerSamples(reviewer, REVIEWER_SAMPLES, signal(), undefined, (r) =>
      seen.push(r.id),
    );
    expect(results).toHaveLength(REVIEWER_SAMPLES.length);
    expect(seen).toEqual(results.map((r) => r.id));
    const wrong = results.filter((r) => !r.match);
    expect(wrong.map((r) => r.id)).toEqual(["force-push-tidy"]);
    expect(wrong[0]).toMatchObject({ expected: "ask", actual: "allow", reason: "理由 allow" });
    expect(results[0]).toMatchObject({ expected: "ask", actual: "ask" });
    expect(results.every((r) => r.durationMs >= 0)).toBe(true);
    expect(summarizeSampleResults(results)).toEqual({
      matched: REVIEWER_SAMPLES.length - 1,
      total: REVIEWER_SAMPLES.length,
      rate: (REVIEWER_SAMPLES.length - 1) / REVIEWER_SAMPLES.length,
    });
    expect(summarizeSampleResults([])).toEqual({ matched: 0, total: 0, rate: 0 });
  });

  it("block 与 unsure 都记为交人；审查异常也记为交人并带异常信息", async () => {
    let calls = 0;
    const reviewer: SecurityReviewer = {
      review: vi.fn(async () => {
        calls++;
        if (calls === 1) return { verdict: "block" as const, reason: "旧记录式拦截" };
        if (calls === 2) throw new Error("后端挂了");
        return { verdict: "allow" as const, reason: "ok" };
      }),
    };
    const results = await runReviewerSamples(reviewer, REVIEWER_SAMPLES.slice(0, 3), signal());
    expect(results.map((r) => r.actual)).toEqual(["ask", "ask", "allow"]);
    expect(results[1]?.reason).toBe("后端挂了");
  });

  it("中止时抛出中止原因，不再继续后面的样例", async () => {
    const controller = new AbortController();
    const reviewer: SecurityReviewer = {
      review: vi.fn(async () => {
        controller.abort(new Error("取消"));
        return { verdict: "allow" as const, reason: "x" };
      }),
    };
    await expect(runReviewerSamples(reviewer, REVIEWER_SAMPLES, controller.signal)).rejects.toThrow(
      "取消",
    );
    expect(reviewer.review).toHaveBeenCalledTimes(1);
  });

  it("样例输入带上下文：缺省有环境与可信 remote，可覆盖追加规则", () => {
    const first = REVIEWER_SAMPLES[0] as ReviewerSample;
    expect(sampleInput(first)).toMatchObject({
      cwd: "/workspace/app",
      userMessages: first.userMessages,
      environment: { workspaceRoot: "/workspace/app" },
    });
    expect(
      sampleInput(first, { cwd: "/w", reviewerRules: { ask: "任何 docker 命令" } }),
    ).toMatchObject({ cwd: "/w", reviewerRules: { ask: "任何 docker 命令" } });
  });
});
