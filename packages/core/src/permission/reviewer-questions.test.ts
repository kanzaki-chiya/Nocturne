import { describe, expect, it } from "vitest";
import {
  REVIEW_QUESTIONS,
  buildJevQuestions,
  buildReviewSystemPrompt,
  decideFromAnswers,
  formatAskReason,
  parseModelReview,
  promptContextFromInput,
  stateForReview,
  resolveJevAnswers,
} from "./reviewer-questions.js";
import type { ReviewAnswers } from "./reviewer-questions.js";

const allNo: ReviewAnswers = {
  requested: false,
  destroys: false,
  credentials: false,
  exfiltrates: false,
  weakens: false,
  crosses: false,
  opaque: false,
};

const toJson = (patch: Partial<ReviewAnswers>, reason = "理由") =>
  JSON.stringify({ ...allNo, ...patch, reason });

describe("七题判定 decideFromAnswers", () => {
  it("Q2–Q7 全否放行", () => {
    expect(decideFromAnswers(allNo)).toBe("allow");
  });
  it("Q1 为真放行（含 Q6 为是）", () => {
    expect(decideFromAnswers({ ...allNo, requested: true, crosses: true })).toBe("allow");
  });
  it("Q1 为否且任一风险题为是交人", () => {
    for (const key of [
      "destroys",
      "credentials",
      "exfiltrates",
      "weakens",
      "crosses",
      "opaque",
    ] as const) {
      expect(decideFromAnswers({ ...allNo, [key]: true })).toBe("ask");
    }
  });
  it("交人理由列出是题与用户未要求", () => {
    expect(formatAskReason({ ...allNo, crosses: true }, "推到外部")).toBe(
      "会推送、发布、远程写或以你的身份对外发言，用户未点名要求：推到外部",
    );
  });
});

describe("共享提示词", () => {
  it("七题编号连续 1–7，键齐全", () => {
    expect(REVIEW_QUESTIONS.map((q) => q.number)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(REVIEW_QUESTIONS.map((q) => q.key).sort()).toEqual(
      [
        "credentials",
        "crosses",
        "destroys",
        "exfiltrates",
        "opaque",
        "requested",
        "weakens",
      ].sort(),
    );
  });
  it("模型提示词含环境、七题依据与 JSON 输出要求", () => {
    const prompt = buildReviewSystemPrompt({
      workspaceRoot: "C:/ws",
      nocturneHome: "C:/home",
      trustedRemotes: "origin\tgit@example.test:a.git",
    });
    expect(prompt).toContain("C:/ws");
    expect(prompt).toContain("git push");
    expect(prompt).toContain('"requested"');
    expect(prompt).toContain("只答题不给结论");
  });
  it("追加规则原样拼入、单段最多 1000 字", () => {
    const prompt = buildReviewSystemPrompt({
      reviewerRules: { ask: `交人规则 ${"x".repeat(2000)}`, allow: "放行规则" },
    });
    expect(prompt).toContain("用户追加：以下情况交人");
    expect(prompt).toContain("用户追加：以下情况放行");
    expect(prompt).not.toContain("x".repeat(1001));
  });
  it("Jev 七个编号 choice 题、criteria 为 yes/no", () => {
    const questions = buildJevQuestions();
    expect(Object.keys(questions).sort()).toEqual(["1", "2", "3", "4", "5", "6", "7"]);
    for (const question of Object.values(questions)) {
      expect(question.type).toBe("choice");
      expect(Object.keys(question.criteria).sort()).toEqual(["no", "yes"]);
    }
  });
  it("从审查输入取环境、可信 remote 与追加规则，缺失时回退到 cwd", () => {
    expect(promptContextFromInput({ cwd: "C:/ws" })).toMatchObject({
      workspaceRoot: "C:/ws",
      reviewerRules: undefined,
    });
    expect(
      promptContextFromInput({
        cwd: "C:/ws",
        environment: { workspaceRoot: "C:/root", nocturneHome: "C:/home" },
        trustedRemotes: ["origin"],
        reviewerRules: { ask: "a", allow: "b" },
      }),
    ).toEqual({
      workspaceRoot: "C:/root",
      nocturneHome: "C:/home",
      trustedRemotes: ["origin"],
      reviewerRules: { ask: "a", allow: "b" },
    });
  });
  it("送审的 state 不重复环境与追加规则", () => {
    const state = stateForReview({
      subjects: [],
      cwd: "C:/ws",
      userMessages: ["push"],
      environment: { workspaceRoot: "C:/ws", nocturneHome: "C:/home" },
      reviewerRules: { ask: "a" },
      trustedRemotes: ["origin u"],
    });
    expect(state).toEqual({
      subjects: [],
      cwd: "C:/ws",
      userMessages: ["push"],
      trustedRemotes: ["origin u"],
    });
  });
});

describe("模型输出解析 parseModelReview", () => {
  it("全否放行", () => {
    expect(parseModelReview(toJson({}))).toEqual({ verdict: "allow", reason: "理由" });
  });
  it("Q1 为真放行", () => {
    expect(parseModelReview(toJson({ requested: true, crosses: true }))).toMatchObject({
      verdict: "allow",
    });
  });
  it("风险题为是交人并列出标签", () => {
    const result = parseModelReview(toJson({ crosses: true }, "推了分支"));
    expect(result.verdict).toBe("unsure");
    expect(result.reason).toContain("会推送");
    expect(result.reason).toContain("用户未点名要求");
    expect(result.reason).toContain("推了分支");
  });
  it("容忍代码块包裹", () => {
    expect(parseModelReview(`\`\`\`json\n${toJson({})}\n\`\`\``).verdict).toBe("allow");
  });
  it.each([
    "ALLOW\n理由",
    '{"requested": false, "reason": "缺字段"}',
    '{"requested": false, "destroys": "no", "credentials": false, "exfiltrates": false, "weakens": false, "crosses": false, "opaque": false, "reason": "x"}',
    '{"requested": false, "destroys": false, "credentials": false, "exfiltrates": false, "weakens": false, "crosses": false, "opaque": false}',
    '{"requested": false, "destroys": false, "credentials": false, "exfiltrates": false, "weakens": false, "crosses": false, "opaque": false, "reason": 1}',
    "[]",
  ])("格式错误交人：%s", (text) => {
    expect(parseModelReview(text)).toEqual({ verdict: "unsure", reason: "审查输出格式错误" });
  });
});

describe("Jev 七题答案归一 resolveJevAnswers", () => {
  const yes = (n = 0.9) => ({ choice: "yes", confidence: n });
  const no = (n = 0.9) => ({ choice: "no", confidence: n });
  it("对象与数组两种形式", () => {
    const objectForm = {
      "1": no(),
      "2": no(),
      "3": no(),
      "4": no(),
      "5": no(),
      "6": no(),
      "7": no(),
    };
    const arrayForm = [no(), no(), no(), no(), no(), no(), no()];
    for (const raw of [objectForm, arrayForm]) {
      const result = resolveJevAnswers(raw, 0.7);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(decideFromAnswers(result.resolved.answers)).toBe("allow");
        expect(result.resolved.lowConfidenceKeys).toEqual([]);
      }
    }
  });
  it("低置信度 Q1 取否、其余取是", () => {
    const result = resolveJevAnswers(
      { "1": yes(0.5), "2": no(0.5), "3": no(), "4": no(), "5": no(), "6": no(), "7": no() },
      0.7,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolved.answers).toMatchObject({ requested: false, destroys: true });
      expect(result.resolved.lowConfidenceKeys).toEqual([1, 2]);
      expect(decideFromAnswers(result.resolved.answers)).toBe("ask");
    }
  });
  it.each([
    null,
    {},
    { "1": yes() },
    [{ choice: "yes" }],
    {
      "1": no(),
      "2": no(),
      "3": no(),
      "4": no(),
      "5": no(),
      "6": no(),
      "7": { choice: "allow", confidence: 0.9 },
    },
    {
      "1": no(),
      "2": no(),
      "3": no(),
      "4": no(),
      "5": no(),
      "6": no(),
      "7": { choice: "yes", confidence: 1.1 },
    },
  ])("非法答案解析失败：%j", (raw) => {
    expect(resolveJevAnswers(raw, 0.7).ok).toBe(false);
  });
});
