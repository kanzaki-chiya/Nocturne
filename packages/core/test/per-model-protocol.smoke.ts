/**
 * ADR-0026 §8 冒烟：同一个 openai-compatible 服务商条目、同一密钥，
 * 两个模型按各自生效协议各跑一轮纯文本对话——
 *   默认协议模型 → <baseURL>/chat/completions（Authorization: Bearer）
 *   手写 protocol:"anthropic" 模型 → <baseURL>/messages（x-api-key + Bearer 双发）
 * 需要环境变量（只从环境变量读取）：
 *   NOCTURNE_SMOKE_ANTHROPIC_API_KEY   网关凭据（两协议共用）
 *   NOCTURNE_SMOKE_ANTHROPIC_BASE_URL  同时提供 /chat/completions 与 /messages 的网关
 *   NOCTURNE_SMOKE_ANTHROPIC_MODEL     Messages 协议模型 id
 *   NOCTURNE_SMOKE_MODEL               Chat Completions 协议模型 id（复用 openai 冒烟变量）
 * 任一缺失即跳过。仅在不含敏感信息的测试工作区中运行。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createRuntime } from "../src/index.js";
import type { RuntimeEvent } from "../src/protocol/index.js";

const API_KEY = process.env.NOCTURNE_SMOKE_ANTHROPIC_API_KEY;
const BASE_URL = process.env.NOCTURNE_SMOKE_ANTHROPIC_BASE_URL;
const MSG_MODEL = process.env.NOCTURNE_SMOKE_ANTHROPIC_MODEL;
const CHAT_MODEL = process.env.NOCTURNE_SMOKE_MODEL;
const PROVIDER_ID = "smoke-dual";

const configured =
  API_KEY !== undefined &&
  BASE_URL !== undefined &&
  MSG_MODEL !== undefined &&
  CHAT_MODEL !== undefined;

const tmpRoots: string[] = [];
afterEach(() => {
  for (const r of tmpRoots.splice(0)) rmSync(r, { recursive: true, force: true });
});
const makeTmp = (p: string) => {
  const d = mkdtempSync(path.join(tmpdir(), p));
  tmpRoots.push(d);
  return d;
};

describe.skipIf(!configured)("按模型协议冒烟（ADR-0026 §8，真实服务）", () => {
  it("同一 openai-compatible 条目：chat 模型走 /chat/completions，anthropic 模型走 /messages", async () => {
    const runtime = await createRuntime({
      cwd: makeTmp("nct-smoke-ws-"),
      sessionsDir: makeTmp("nct-smoke-sessions-"),
      providerConfigs: [
        {
          id: PROVIDER_ID,
          type: "openai-compatible",
          baseURL: BASE_URL ?? "",
          apiKeyEnv: "NOCTURNE_SMOKE_ANTHROPIC_API_KEY",
          models: {
            // 默认协议 = 条目 type → openai-compatible
            [CHAT_MODEL ?? ""]: {},
            // 手写协议 → anthropic（同一条目内跨协议路由）
            [MSG_MODEL ?? ""]: { protocol: "anthropic" },
          },
        },
      ],
      permissions: { autoApproveAsk: true },
    });

    for (const [model, protocol] of [
      [CHAT_MODEL ?? "", "openai-compatible"],
      [MSG_MODEL ?? "", "anthropic"],
    ] as const) {
      const session = await runtime.createSession({ model: `${PROVIDER_ID}/${model}` });
      const events: RuntimeEvent[] = [];
      session.subscribe((e) => events.push(e));
      const reason = await session.submit({
        text: "只回复单词 ok，不要调用任何工具。",
      });
      expect(reason).toBe("done");
      const assistant = events.find((e) => e.type === "message.assistant");
      expect(assistant?.type === "message.assistant" && assistant.payload.protocol).toBe(protocol);
      expect(events.some((e) => e.type === "turn.completed")).toBe(true);
      await session.close();
    }
  });
});
