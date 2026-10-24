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

import { createRuntime, createPlatform, loadConfig } from "../src/index.js";
import type { RuntimeEvent } from "../src/protocol/index.js";

const API_KEY = process.env.NOCTURNE_SMOKE_OPENCODE_API_KEY;
const BASE_URL = process.env.NOCTURNE_SMOKE_OPENCODE_BASE_URL ?? "https://opencode.ai/zen/go/v1";
const CHAT_MODEL = process.env.NOCTURNE_SMOKE_OPENCODE_CHAT_MODEL;
const MESSAGES_MODEL = process.env.NOCTURNE_SMOKE_OPENCODE_MESSAGES_MODEL;
const RESPONSES_MODEL = process.env.NOCTURNE_SMOKE_OPENCODE_RESPONSES_MODEL;
const GEMINI_MODEL = process.env.NOCTURNE_SMOKE_OPENCODE_GEMINI_MODEL;
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
function captureHeaders(): {
  headers: [string, Headers][];
  bodies: Record<string, unknown>[];
  restore: () => void;
} {
  // 逐次记录（同一端点的多次请求都要检查，不能按 URL 覆盖）
  const headers: [string, Headers][] = [];
  const bodies: Record<string, unknown>[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    if (new URL(url).hostname === new URL(BASE_URL).hostname) {
      headers.push([url, new Headers(init?.headers)]);
      if (url.includes(":streamGenerateContent") && typeof init?.body === "string")
        bodies.push(JSON.parse(init.body) as Record<string, unknown>);
      console.log(`OpenCode request: ${url}`);
    }
    return original(input, init);
  }) as typeof fetch;
  return { headers, bodies, restore: () => (globalThis.fetch = original) };
}

describe.skipIf(!configured)("OpenCode 冒烟（ADR-0031 §5，真实服务）", () => {
  it("三种协议各跑一轮带工具调用的对话，请求都带 x-opencode-session", async () => {
    const ws = makeTmp("nct-smoke-oc-ws-");
    writeFileSync(path.join(ws, "note.txt"), "opencode-smoke-ok");
    const capture = captureHeaders();
    const config = await smokeConfig([
      CHAT_MODEL ?? "",
      MESSAGES_MODEL ?? "",
      RESPONSES_MODEL ?? "",
    ]);
    const runtime = await createRuntime({
      config,
      cwd: ws,
      sessionsDir: makeTmp("nct-smoke-oc-sessions-"),
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

/** 使用真实配置装配路径，验证 models.dev 的协议与地址，而非手写协议绕过。 */
async function smokeConfig(models: string[]) {
  const home = makeTmp("nct-smoke-oc-home-");
  writeFileSync(path.join(home, "config.json"), JSON.stringify({ modelsDev: false }));
  writeFileSync(
    path.join(home, "providers.json"),
    JSON.stringify({
      version: 1,
      providers: [
        {
          id: PROVIDER_ID,
          type: "openai-compatible",
          baseURL: BASE_URL,
          apiKeyEnv: "NOCTURNE_SMOKE_OPENCODE_API_KEY",
          sessionHeader: "x-opencode-session",
          modelsDevProvider: "opencode-go",
          // 目录尚未提供 contributor 别名的能力项；本用例显式声明推理以检验档位传输。
          models: Object.fromEntries(
            models.map((id) => [
              id,
              id === GEMINI_MODEL ? { capabilities: { reasoning: "visible" } } : {},
            ]),
          ),
        },
      ],
    }),
  );
  return loadConfig(createPlatform(), { nocturneHome: home });
}

describe.skipIf(API_KEY === undefined || GEMINI_MODEL === undefined)(
  "OpenCode Gemini 冒烟（ADR-0061）",
  () => {
    it.each(["text", "tools", "thinking"])("%s：原生接口、签名回传、思考档位", async (mode) => {
      const ws = makeTmp("nct-smoke-gemini-ws-");
      writeFileSync(path.join(ws, "note.txt"), "gemini-signature-smoke-ok");
      const capture = captureHeaders();
      const config = await smokeConfig([GEMINI_MODEL ?? ""]);
      const runtime = await createRuntime({
        config,
        cwd: ws,
        sessionsDir: makeTmp("nct-smoke-gemini-sessions-"),
        permissions: { autoApproveAsk: true },
      });
      const session = await runtime.createSession({
        model: `${PROVIDER_ID}/${GEMINI_MODEL}`,
        ...(mode === "thinking" ? { reasoningEffort: "high" as const } : {}),
      });
      const events: RuntimeEvent[] = [];
      session.subscribe((event) => events.push(event));
      try {
        const reason = await session.submit({
          text:
            mode === "tools"
              ? "必须调用 read 工具读取 note.txt，读取成功后只回复文件内容。"
              : "只回复 gemini-smoke-ok。",
        });
        const done = events.find((event) => event.type === "turn.completed");
        expect(reason, JSON.stringify(done?.payload)).toBe("done");
        const requests = capture.headers.filter(([url]) => url.includes(":streamGenerateContent"));
        expect(requests.length).toBeGreaterThanOrEqual(mode === "tools" ? 2 : 1);
        for (const [url, headers] of requests) {
          expect(url).toContain("/inference/go/google/v1beta/models/");
          expect(headers.get("x-opencode-session")).toBeTruthy();
        }
        if (mode === "thinking")
          expect(
            capture.bodies.some(
              (body) =>
                (
                  body.generationConfig as
                    { thinkingConfig?: { thinkingLevel?: string } } | undefined
                )?.thinkingConfig?.thinkingLevel === "high",
            ),
          ).toBe(true);
        if (mode === "tools") {
          const assistant = events.find(
            (event) => event.type === "message.assistant" && event.payload.toolCalls.length > 0,
          );
          expect(
            assistant?.type === "message.assistant" &&
              assistant.payload.toolCalls.some((call) => call.providerData !== undefined),
          ).toBe(true);
          if (assistant?.type === "message.assistant") {
            const signature = (
              assistant.payload.toolCalls[0]?.providerData as
                { google?: { thoughtSignature?: string } } | undefined
            )?.google?.thoughtSignature;
            expect(typeof signature).toBe("string");
            // 只在内存比较，断言信息不含签名与鉴权；避免仅靠占位值通过后续轮。
            expect(
              signature !== undefined &&
                capture.bodies.some((body) => JSON.stringify(body).includes(signature)),
            ).toBe(true);
          }
          expect(
            events.some(
              (event) => event.type === "tool.completed" && event.payload.status === "ok",
            ),
          ).toBe(true);
        }
      } finally {
        capture.restore();
        await session.close();
      }
    });
  },
);
