/**
 * ADR-0031 §5 冒烟：OpenCode Go 预设的真实服务验证——
 * 三种协议的模型各跑一轮带工具调用的对话，断言每个模型请求都带
 * `x-opencode-session` 会话头（不再报 missing x-opencode-session）。
 * 需要环境变量（只从环境变量读取）：
 *   NOCTURNE_SMOKE_OPENCODE_API_KEY          OpenCode 凭据
 *   NOCTURNE_SMOKE_OPENCODE_CHAT_MODEL       Chat Completions 协议模型 id
 *   NOCTURNE_SMOKE_OPENCODE_MESSAGES_MODEL   Messages 协议模型 id
 *   NOCTURNE_SMOKE_OPENCODE_RESPONSES_MODEL  Responses 协议模型 id
 *   NOCTURNE_SMOKE_OPENCODE_BASE_URL         可选，默认 https://opencode.ai/zen/go/v1
 * 任一缺失即跳过。仅在不含敏感信息的测试工作区中运行。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createRuntime } from "../src/index.js";
import type { RuntimeEvent } from "../src/protocol/index.js";

const API_KEY = process.env.NOCTURNE_SMOKE_OPENCODE_API_KEY;
const BASE_URL = process.env.NOCTURNE_SMOKE_OPENCODE_BASE_URL ?? "https://opencode.ai/zen/go/v1";
const CHAT_MODEL = process.env.NOCTURNE_SMOKE_OPENCODE_CHAT_MODEL;
const MESSAGES_MODEL = process.env.NOCTURNE_SMOKE_OPENCODE_MESSAGES_MODEL;
const RESPONSES_MODEL = process.env.NOCTURNE_SMOKE_OPENCODE_RESPONSES_MODEL;
const PROVIDER_ID = "smoke-opencode";

const configured =
  API_KEY !== undefined &&
  CHAT_MODEL !== undefined &&
  MESSAGES_MODEL !== undefined &&
  RESPONSES_MODEL !== undefined;

const tmpRoots: string[] = [];
afterEach(() => {
  for (const r of tmpRoots.splice(0)) rmSync(r, { recursive: true, force: true });
});
const makeTmp = (p: string) => {
  const d = mkdtempSync(path.join(tmpdir(), p));
  tmpRoots.push(d);
  return d;
};

/** 捕获发往服务商的请求头（断言 x-opencode-session 用；密钥不记录） */
function captureHeaders(): { headers: [string, Headers][]; restore: () => void } {
  // 逐次记录（同一端点的多次请求都要检查，不能按 URL 覆盖）
  const headers: [string, Headers][] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith(BASE_URL)) headers.push([url, new Headers(init?.headers)]);
    return original(input, init);
  }) as typeof fetch;
  return { headers, restore: () => (globalThis.fetch = original) };
}

describe.skipIf(!configured)("OpenCode 冒烟（ADR-0031 §5，真实服务）", () => {
  it("三种协议各跑一轮带工具调用的对话，请求都带 x-opencode-session", async () => {
    const ws = makeTmp("nct-smoke-oc-ws-");
    writeFileSync(path.join(ws, "note.txt"), "opencode-smoke-ok");
    const capture = captureHeaders();
    const runtime = await createRuntime({
      cwd: ws,
      sessionsDir: makeTmp("nct-smoke-oc-sessions-"),
      providerConfigs: [
        {
          id: PROVIDER_ID,
          type: "openai-compatible",
          baseURL: BASE_URL,
          apiKeyEnv: "NOCTURNE_SMOKE_OPENCODE_API_KEY",
          sessionHeader: "x-opencode-session",
          // providerConfigs 绕过配置加载，models.dev 服务商层不生效；
          // 逐模型协议由手写 protocol 固定（与 opencode-go 预设形态等价）
          models: {
            [CHAT_MODEL ?? ""]: { protocol: "openai-compatible" },
            [MESSAGES_MODEL ?? ""]: { protocol: "anthropic" },
            [RESPONSES_MODEL ?? ""]: { protocol: "openai-responses" },
          },
        },
      ],
      permissions: { autoApproveAsk: true },
    });

    try {
      for (const [model, endpoint] of [
        [CHAT_MODEL ?? "", "/chat/completions"],
        [MESSAGES_MODEL ?? "", "/messages"],
        [RESPONSES_MODEL ?? "", "/responses"],
      ] as const) {
        const session = await runtime.createSession({ model: `${PROVIDER_ID}/${model}` });
        const events: RuntimeEvent[] = [];
        session.subscribe((e) => events.push(e));
        const reason = await session.submit({
          text: "调用 read 工具读取 note.txt，然后只回复它的内容。",
        });
        // 失败时带上 turn.completed 的错误详情（如网关地区限制 provider_auth），便于区分环境问题
        const done = events.find((e) => e.type === "turn.completed");
        expect(reason, JSON.stringify(done?.payload)).toBe("done");
        // 一轮带工具调用的对话：至少发生一次工具执行
        expect(events.some((e) => e.type === "tool.completed")).toBe(true);
        await session.close();
        // 该模型的每个请求（含工具循环的后续请求）都带会话头，且全对话同值
        const sent = capture.headers.filter(([url]) => url.endsWith(endpoint));
        expect(sent.length).toBeGreaterThan(0);
        const values = new Set(sent.map(([, h]) => h.get("x-opencode-session")));
        expect(values.size).toBe(1);
        expect([...values][0]).toBeTruthy();
      }
    } finally {
      capture.restore();
    }
  });
});
