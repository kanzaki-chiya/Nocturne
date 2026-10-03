/**
 * 思考强度（reasoningEffort，ADR-0018）核心行为测试：
 * 声明链优先级、就近降档、Anthropic 预算计算、事件 schema 与持久化、
 * Runtime 的 setReasoningEffort/reasoningEffortInfo/切换模型降档提示、
 * Turn 请求组装与子代理继承。全部离线（FakeProvider）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createRuntime, type Runtime, type RuntimeSession } from "../src/index.js";
import {
  decodeDurableEvent,
  encodeDurableEvent,
  isReasoningEffort,
  normalizeReasoningEffortLevels,
  REASONING_EFFORT_LEVELS,
  REASONING_EFFORT_ORDER,
  type DurableEvent,
  type ReasoningEffortLevel,
  type RuntimeEvent,
} from "../src/protocol/index.js";
import {
  ANTHROPIC_EFFORT_BUDGETS,
  ANTHROPIC_MIN_BUDGET,
  ANTHROPIC_OUTPUT_MARGIN,
  clampReasoningEffort,
  planAnthropicThinking,
  resolveReasoningEfforts,
} from "../src/provider/reasoning.js";
import {
  FakeProvider,
  ProviderError,
  type FakeScript,
  type ModelInfo,
} from "../src/provider/index.js";

const tmpRoots: string[] = [];
afterEach(() => {
  for (const r of tmpRoots.splice(0)) rmSync(r, { recursive: true, force: true });
});
const makeTmp = (p: string) => {
  const d = mkdtempSync(path.join(tmpdir(), p));
  tmpRoots.push(d);
  return d;
};

// ── 档位常量与归一化 ──────────────────────────────────────

describe("档位常量", () => {
  it("七档固定且不含 auto；LEVELS 不含 off，ORDER 以 off 起首", () => {
    expect(REASONING_EFFORT_LEVELS).toEqual(["minimal", "low", "medium", "high", "xhigh", "max"]);
    expect(REASONING_EFFORT_ORDER).toEqual(["off", ...REASONING_EFFORT_LEVELS]);
    expect(isReasoningEffort("auto")).toBe(false);
    expect(isReasoningEffort("off")).toBe(true);
    expect(isReasoningEffort("xhigh")).toBe(true);
  });

  it("normalizeReasoningEffortLevels：去重、按序、剔除非法值；undefined/空分别保留语义", () => {
    expect(normalizeReasoningEffortLevels(["max", "low", "bogus", "low"])).toEqual(["low", "max"]);
    expect(normalizeReasoningEffortLevels(undefined)).toBeUndefined();
    // 显式空数组 = 明确无档位（声明链语义的载体）
    expect(normalizeReasoningEffortLevels([])).toEqual([]);
  });
});

// ── 声明链（ADR-0018 §2）─────────────────────────────────

describe("resolveReasoningEfforts 声明链", () => {
  it("推理为否无档位；支持推理时逐模型声明优先，否则推导全档", () => {
    expect(
      resolveReasoningEfforts({ reasoning: "none", reasoningEffort: ["low"] }),
    ).toBeUndefined();
    expect(
      resolveReasoningEfforts({ reasoning: "visible", reasoningEffort: ["low", "high"] }),
    ).toEqual(["low", "high"]);
    expect(resolveReasoningEfforts({ reasoning: "visible", reasoningEffort: [] })).toEqual([]);
    expect(resolveReasoningEfforts({ reasoning: "visible" })).toEqual([...REASONING_EFFORT_LEVELS]);
    expect(resolveReasoningEfforts({ reasoning: "hidden" })).toEqual([...REASONING_EFFORT_LEVELS]);
    expect(resolveReasoningEfforts({ reasoning: "none" })).toBeUndefined();
  });

  it("同系列不同型号的最高档按各自声明（gpt-5.5 到 xhigh 的论据形态）", () => {
    const gpt55 = resolveReasoningEfforts({
      reasoning: "visible",
      reasoningEffort: ["low", "medium", "high", "xhigh"],
    });
    const gpt56 = resolveReasoningEfforts({
      reasoning: "visible",
      reasoningEffort: ["low", "medium", "high", "xhigh", "max"],
    });
    expect(gpt55).not.toContain("max");
    expect(gpt56).toContain("max");
  });
});

// ── 就近降档（ADR-0018 §4）───────────────────────────────

describe("clampReasoningEffort", () => {
  const all = [...REASONING_EFFORT_LEVELS];

  it("命中原档 / 就近降档 / 都比它高取最低档", () => {
    expect(clampReasoningEffort("high", all)).toBe("high");
    expect(clampReasoningEffort("max", ["low", "medium", "high", "xhigh"])).toBe("xhigh");
    expect(clampReasoningEffort("low", ["high", "xhigh"])).toBe("high");
    expect(clampReasoningEffort("minimal", all)).toBe("minimal");
  });

  it("off / 无可用集合 → undefined（发送侧省略思考参数）", () => {
    expect(clampReasoningEffort("off", all)).toBeUndefined();
    expect(clampReasoningEffort(undefined, all)).toBeUndefined();
    expect(clampReasoningEffort("high", undefined)).toBeUndefined();
    expect(clampReasoningEffort("high", [])).toBeUndefined();
  });
});

// ── Anthropic 预算（ADR-0018 §3）────────────────────────

describe("planAnthropicThinking", () => {
  it("默认预算表与 omp 一致；max → 32768", () => {
    expect(ANTHROPIC_EFFORT_BUDGETS).toEqual({
      minimal: 1024,
      low: 4096,
      medium: 8192,
      high: 16384,
      xhigh: 32768,
      max: 32768,
    });
    const plan = planAnthropicThinking("max", 128_000, undefined);
    expect(plan).toEqual({ budgetTokens: 32_768, maxTokens: 128_000 });
  });

  it("未声明输出上限：max_tokens 抬升到 预算+余量", () => {
    const plan = planAnthropicThinking("high", undefined, undefined);
    expect(plan).toEqual({ budgetTokens: 16_384, maxTokens: 16_384 + ANTHROPIC_OUTPUT_MARGIN });
  });

  it("声明上限放不下 预算+余量：压低预算；压到下限以下 → undefined", () => {
    // 声明 8192：high 预算 16384 压到 8192-1024=7168
    expect(planAnthropicThinking("high", 8192, undefined)).toEqual({
      budgetTokens: 7168,
      maxTokens: 8192,
    });
    // 声明 1024：压到 0 < MIN → undefined（本轮不发送 thinking）
    expect(planAnthropicThinking("minimal", 1024, undefined)).toBeUndefined();
    // 恰好容得下协议下限：1024 预算 + 1024 余量 = 2048
    expect(planAnthropicThinking("minimal", 2048, undefined)).toEqual({
      budgetTokens: ANTHROPIC_MIN_BUDGET,
      maxTokens: 2048,
    });
  });

  it("budgets 覆盖表生效；非法值回落默认表", () => {
    expect(planAnthropicThinking("low", 64_000, { low: 2048 })).toEqual({
      budgetTokens: 2048,
      maxTokens: 64_000,
    });
    // 覆盖预算超出声明上限：max_tokens 不抬升（声明值即 wireMax），预算被压低
    expect(planAnthropicThinking("max", 64_000, { max: 100_000 })).toEqual({
      budgetTokens: 64_000 - ANTHROPIC_OUTPUT_MARGIN,
      maxTokens: 64_000,
    });
    expect(planAnthropicThinking("low", 64_000, { low: -5 })).toEqual({
      budgetTokens: 4096,
      maxTokens: 64_000,
    });
  });
});

// ── 事件 schema 与持久化 ────────────────────────────────

describe("协议层：reasoningEffort 字段", () => {
  const base = {
    type: "session.created" as const,
    sessionId: "s1",
    seq: 1,
    time: "2025-01-01T00:00:00.000Z",
    payload: {
      formatVersion: 1,
      nocturneVersion: "0.0.0",
      cwd: "/w",
      workspaceRoot: "/w",
      model: { provider: "p", model: "m" },
      permissionPreset: "default",
    },
  };

  it("session.created/config_changed 接受合法档位、拒绝非法档位", () => {
    const ok = encodeDurableEvent({
      ...base,
      payload: { ...base.payload, reasoningEffort: "high" },
    });
    const decoded = decodeDurableEvent(ok);
    expect(decoded.payload).toMatchObject({ reasoningEffort: "high" });

    const changed: DurableEvent = {
      type: "session.config_changed",
      sessionId: "s1",
      seq: 2,
      time: "2025-01-01T00:00:01.000Z",
      payload: { reasoningEffort: "off" },
    };
    expect(decodeDurableEvent(encodeDurableEvent(changed)).payload).toMatchObject({
      reasoningEffort: "off",
    });

    const bad = { ...base, payload: { ...base.payload, reasoningEffort: "ultra" } };
    expect(() => decodeDurableEvent(JSON.stringify(bad))).toThrow();
  });
});

// ── Runtime 接线 ────────────────────────────────────────

function collect(session: RuntimeSession): RuntimeEvent[] {
  const events: RuntimeEvent[] = [];
  session.subscribe((e) => {
    events.push(e);
  });
  return events;
}

const STOP: FakeScript = [
  { type: "text_delta", text: "ok" },
  { type: "finish", reason: "stop" },
];

async function makeRuntime(
  provider: FakeProvider,
): Promise<{ runtime: Runtime; sessionsDir: string }> {
  const ws = makeTmp("nct-re-ws-");
  const sessionsDir = makeTmp("nct-re-sessions-");
  const runtime = await createRuntime({
    cwd: ws,
    sessionsDir,
    providers: [provider],
  });
  return { runtime, sessionsDir };
}

describe("Runtime：思考档位", () => {
  it("createSession 初始档位写入 session.created；resumeSession 还原", async () => {
    const { runtime } = await makeRuntime(new FakeProvider({}));
    const s = await runtime.createSession({ model: "fake/fake-1", reasoningEffort: "high" });
    expect(s.state().config.reasoningEffort).toBe("high");
    const created = s.durableEvents().find((e) => e.type === "session.created");
    expect(created?.type === "session.created" && created.payload.reasoningEffort).toBe("high");
    const id = s.id;
    await s.close();

    const resumed = await runtime.resumeSession(id);
    expect(resumed.state().config.reasoningEffort).toBe("high");
    await resumed.close();
  });

  it("createSession 缺省视为 off：字段缺省、info.current=off", async () => {
    const { runtime } = await makeRuntime(new FakeProvider({}));
    const s = await runtime.createSession({ model: "fake/fake-1" });
    expect(s.state().config.reasoningEffort).toBeUndefined();
    const info = s.reasoningEffortInfo();
    expect(info.current).toBe("off");
    // FakeProvider 默认模型 reasoning:"visible" → 推导全档
    expect(info.available).toEqual([...REASONING_EFFORT_LEVELS]);
    await s.close();
  });

  it("setReasoningEffort：合法档位写 config_changed；非法/未声明档位拒绝", async () => {
    const provider = new FakeProvider({ scripts: [STOP] });
    const { runtime } = await makeRuntime(provider);
    const s = await runtime.createSession({ model: "fake/fake-1" });
    const events = collect(s);

    await s.setReasoningEffort("xhigh");
    expect(s.state().config.reasoningEffort).toBe("xhigh");
    const changed = events.find((e) => e.type === "session.config_changed");
    expect(changed?.type === "session.config_changed" && changed.payload.reasoningEffort).toBe(
      "xhigh",
    );

    await expect(s.setReasoningEffort("ultra")).rejects.toMatchObject({
      code: "invalid_command",
    });
    // FakeProvider 推导全档 → max 在可用集合内
    await s.setReasoningEffort("max");
    expect(s.state().config.reasoningEffort).toBe("max");
    await s.setReasoningEffort("off");
    expect(s.state().config.reasoningEffort).toBe("off");
    await s.close();
  });

  it("未声明档位的模型：available 为空、setReasoningEffort(off 以外) 拒绝、info.current=off", async () => {
    const noReasoning: ModelInfo = {
      ref: { provider: "fake", model: "plain" },
      contextWindow: 128_000,
      maxOutputTokens: 8192,
      capabilities: {
        toolCalls: true,
        parallelToolCalls: true,
        reasoning: "none",
        imageInput: false,
        promptCache: false,
        editTool: "edit",
      },
    };
    const provider = new FakeProvider({ models: [noReasoning] });
    const { runtime } = await makeRuntime(provider);
    const s = await runtime.createSession({ model: "fake/plain", reasoningEffort: "high" });
    // 记录 high 但模型无档位：生效值 off，直接设置非 off 档位拒绝
    const info = s.reasoningEffortInfo();
    expect(info.current).toBe("off");
    expect(info.available).toEqual([]);
    await expect(s.setReasoningEffort("low")).rejects.toMatchObject({
      code: "invalid_command",
    });
    await s.close();
  });

  it("切换模型就近降档提示：记录档不改、生效档降档、发 runtime.warning", async () => {
    const full = (id: string, caps: ModelInfo["capabilities"]): ModelInfo => ({
      ref: { provider: "fake", model: id },
      contextWindow: 128_000,
      maxOutputTokens: 8192,
      capabilities: caps,
    });
    const caps = (efforts: ReasoningEffortLevel[]): ModelInfo["capabilities"] => ({
      toolCalls: true,
      parallelToolCalls: true,
      reasoning: "visible",
      imageInput: false,
      promptCache: false,
      editTool: "edit",
      reasoningEffort: efforts,
    });
    const provider = new FakeProvider({
      models: [
        full("wide", caps(["minimal", "low", "medium", "high", "xhigh", "max"])),
        full("narrow", caps(["low", "medium"])),
        full("plain", {
          toolCalls: true,
          parallelToolCalls: true,
          reasoning: "none",
          imageInput: false,
          promptCache: false,
          editTool: "edit",
        }),
      ],
    });
    const { runtime } = await makeRuntime(provider);
    const s = await runtime.createSession({ model: "fake/wide", reasoningEffort: "max" });
    const events = collect(s);

    // max → narrow（最高 medium）：生效档降为 medium，记录档保持 max
    await s.setModel("fake/narrow");
    expect(s.state().config.reasoningEffort).toBe("max");
    expect(s.reasoningEffortInfo().current).toBe("medium");
    const warn = events.find(
      (e) => e.type === "runtime.warning" && e.payload.code === "reasoning_effort_clamped",
    );
    expect(warn?.type === "runtime.warning" && warn.payload.message).toContain("medium");

    // narrow → plain（无档位）：视为 off
    await s.setModel("fake/plain");
    expect(s.reasoningEffortInfo().current).toBe("off");
    await s.close();
  });

  it("Turn 请求携带就近降档后的档位；每一步都带", async () => {
    const provider = new FakeProvider({
      scripts: [
        [
          {
            type: "tool_call",
            toolCallId: "c1",
            name: "read",
            input: { path: "a.txt" },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        STOP,
      ],
    });
    const { runtime, sessionsDir } = await makeRuntime(provider);
    const s = await runtime.createSession({ model: "fake/fake-1", reasoningEffort: "high" });
    const reason = await s.submit({ text: "两步" });
    expect(reason).toBe("done");
    // 每一步模型请求都带归一化档位（FakeProvider 全档 → 原样 high）
    expect(provider.requests.map((r) => r.reasoningEffort)).toEqual(["high", "high"]);
    void sessionsDir;
    await s.close();
  });

  it("Turn 中途切档：本 Turn 请求保持快照档位，下一 Turn 生效（ADR-0018 §3）", async () => {
    // Anthropic 要求同一助手回合（含工具循环）单一思考模式——
    // 中途切档只写持久化配置，本 Turn 后续请求仍用 Turn 开始时的快照
    const ref: { s?: RuntimeSession } = {};
    const midTurn: { current: string; effective: string }[] = [];
    const provider = new FakeProvider({
      handler: async (req, callIndex) => {
        if (callIndex === 0 && ref.s !== undefined) {
          // 第一个请求已发出（快照档在请求体上）；此刻切档模拟工具循环中改配置
          await ref.s.setReasoningEffort("max");
          const info = ref.s.reasoningEffortInfo();
          midTurn.push({ current: info.current, effective: info.effective });
          return [
            { type: "tool_call", toolCallId: "c1", name: "read", input: { path: "a.txt" } },
            { type: "finish", reason: "tool_calls" },
          ];
        }
        return STOP;
      },
    });
    const { runtime } = await makeRuntime(provider);
    const s = await runtime.createSession({ model: "fake/fake-1", reasoningEffort: "low" });
    ref.s = s;
    await s.submit({ text: "两步" });

    // 本 Turn 两次请求都用快照档 low；新意图 max 已持久化但未生效
    expect(provider.requests.map((r) => r.reasoningEffort)).toEqual(["low", "low"]);
    expect(s.state().config.reasoningEffort).toBe("max");
    // Turn 内查询：current=新意图 max、effective=快照 low → 状态栏"下一轮生效"的依据
    expect(midTurn).toEqual([{ current: "max", effective: "low" }]);
    // Turn 结束后 effective 回到 current
    expect(s.reasoningEffortInfo().effective).toBe("max");

    // 下一 Turn 生效：请求携带 max
    await s.submit({ text: "再来" });
    expect(provider.requests.map((r) => r.reasoningEffort)).toEqual(["low", "low", "max"]);
    await s.close();
  });

  it("子代理继承父档位；finish 兜底轮不携带档位", async () => {
    // 父调 task → 子会话（finish 工具存在）→ 子代理第一轮不回 finish，
    // 兜底轮 toolChoice=finish 的请求不带 reasoningEffort
    const requests: { effort: string | undefined; toolChoice: unknown }[] = [];
    const provider = new FakeProvider({
      handler: (req) => {
        requests.push({ effort: req.reasoningEffort, toolChoice: req.toolChoice });
        const isChild = req.tools.some((t) => t.name === "finish");
        if (!isChild) {
          // 父会话：首轮调 task，task 结果回来后收尾
          const sawToolResult = req.messages.some((m) => m.role === "tool");
          if (!sawToolResult) {
            return [
              { type: "tool_call", toolCallId: "task-1", name: "task", input: { task: "go" } },
              { type: "finish", reason: "tool_calls" },
            ];
          }
          return [
            { type: "text_delta", text: "parent done" },
            { type: "finish", reason: "stop" },
          ];
        }
        // 子代理：第一轮不回 finish → 兜底轮；兜底轮强制 finish
        if (req.toolChoice !== undefined) {
          return [
            {
              type: "tool_call",
              toolCallId: "f1",
              name: "finish",
              input: { result: "child done" },
            },
            { type: "finish", reason: "tool_calls" },
          ];
        }
        return [
          { type: "text_delta", text: "thinking without finish" },
          { type: "finish", reason: "stop" },
        ];
      },
    });
    const { runtime } = await makeRuntime(provider);
    const s = await runtime.createSession({ model: "fake/fake-1", reasoningEffort: "low" });
    const reason = await s.submit({ text: "派生子代理" });
    expect(reason).toBe("done");
    // 兜底轮（toolChoice 存在）不携带档位；其余子代理请求带继承的 low
    const fallback = requests.find((r) => r.toolChoice !== undefined);
    const normal = requests.filter((r) => r.toolChoice === undefined);
    expect(fallback?.effort).toBeUndefined();
    expect(normal.length).toBeGreaterThan(0);
    expect(normal.every((r) => r.effort === "low")).toBe(true);
    await s.close();
  });

  it("档位相关 400：turn.completed 错误含档位定向提示", async () => {
    const provider = new FakeProvider({
      scripts: [
        [
          {
            type: "throw",
            error: new ProviderError({
              kind: "invalid_request",
              message: "reasoning_effort 'max' is not supported",
              status: 400,
            }),
          },
        ],
      ],
    });
    const { runtime } = await makeRuntime(provider);
    const s = await runtime.createSession({ model: "fake/fake-1", reasoningEffort: "max" });
    const events = collect(s);
    const reason = await s.submit({ text: "boom" });
    expect(reason).toBe("error");
    const end = events.find((e) => e.type === "turn.completed");
    const msg = end?.type === "turn.completed" ? (end.payload.error?.message ?? "") : "";
    expect(msg).toContain("不支持档位 max");
    expect(msg).toContain("/provider thinking");
    await s.close();
  });
});
