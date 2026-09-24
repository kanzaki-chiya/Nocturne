/**
 * 真实 Anthropic 服务冒烟测试（workflow.md：与默认测试集分离）。
 * 运行：pnpm test:smoke；需要环境变量：
 *   NOCTURNE_SMOKE_ANTHROPIC_API_KEY  服务凭据（只从环境变量读取）
 *   NOCTURNE_SMOKE_ANTHROPIC_MODEL    模型 id，例如 claude-sonnet-4-5
 *   NOCTURNE_SMOKE_ANTHROPIC_BASE_URL 可选，默认 api.anthropic.com
 * 未设置时跳过。仅在不含敏感信息的测试工作区中运行——工作区内容会发给模型服务。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createRuntime } from "../src/index.js";
import { createAnthropicProvider, type Provider } from "../src/provider/index.js";
import type { RuntimeEvent } from "../src/protocol/index.js";

const API_KEY = process.env.NOCTURNE_SMOKE_ANTHROPIC_API_KEY;
const MODEL = process.env.NOCTURNE_SMOKE_ANTHROPIC_MODEL;
const THINKING_MODEL = process.env.NOCTURNE_SMOKE_ANTHROPIC_THINKING_MODEL;
const BASE_URL = process.env.NOCTURNE_SMOKE_ANTHROPIC_BASE_URL;
const PROVIDER_ID = "smoke-anthropic";

const configured = API_KEY !== undefined && MODEL !== undefined;

const tmpRoots: string[] = [];
afterEach(() => {
  for (const r of tmpRoots.splice(0)) rmSync(r, { recursive: true, force: true });
});
const makeTmp = (p: string) => {
  const d = mkdtempSync(path.join(tmpdir(), p));
  tmpRoots.push(d);
  return d;
};

async function openSession(cwd: string) {
  const runtime = await createRuntime({
    cwd,
    sessionsDir: makeTmp("nct-smoke-sessions-"),
    providerConfigs: [
      {
        id: PROVIDER_ID,
        type: "anthropic",
        ...(BASE_URL !== undefined ? { baseURL: BASE_URL } : {}),
        apiKeyEnv: "NOCTURNE_SMOKE_ANTHROPIC_API_KEY",
        models: { [MODEL ?? ""]: {} },
      },
    ],
    permissions: { autoApproveAsk: true },
  });
  const session = await runtime.createSession({
    model: `${PROVIDER_ID}/${MODEL ?? ""}`,
  });
  const events: RuntimeEvent[] = [];
  session.subscribe((e) => {
    events.push(e);
  });
  return { session, events };
}

describe.skipIf(!configured)("anthropic 冒烟（真实服务）", () => {
  it("完整 Turn：submit 返回 done，收到流式文本与 turn.completed", async () => {
    const { session, events } = await openSession(makeTmp("nct-smoke-ws-"));

    const reason = await session.submit({
      text: "只回复单词 ok，不要调用任何工具。",
    });

    expect(reason).toBe("done");
    expect(
      events.some((e) => e.type === "message.assistant.delta" && e.payload.kind === "text"),
    ).toBe(true);
    expect(events.some((e) => e.type === "turn.completed")).toBe(true);
    await session.close();
  });

  it("工具往返：模型调用 read，工具结果回到模型后 Turn 完成", async () => {
    const cwd = makeTmp("nct-smoke-ws-");
    const token = `NCT-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
    writeFileSync(path.join(cwd, "secret.txt"), `口令：${token}\n`);
    const { session, events } = await openSession(cwd);

    const reason = await session.submit({
      text: "用 read 工具读取当前目录下的 secret.txt，然后原样回复文件里的口令（只回复口令本身）。",
    });

    expect(reason).toBe("done");
    const completed = events.filter((e) => e.type === "tool.completed");
    expect(completed.some((e) => e.payload.name === "read" && e.payload.status === "ok")).toBe(
      true,
    );
    const finalText = events
      .filter((e) => e.type === "message.assistant")
      .flatMap((e) => e.payload.content)
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");
    expect(finalText).toContain(token);
    await session.close();
  });

  it("子代理往返：父 task、子 finish、父侧得到结果", async () => {
    const { session, events } = await openSession(makeTmp("nct-smoke-ws-"));
    const token = `NCT-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
    const reason = await session.submit({
      text: `请调用 task 工具，任务写成“调用 finish 工具返回 ${token}”。收到子代理结果后，只回复该结果。`,
    });
    expect(reason).toBe("done");
    expect(
      events.some(
        (e) =>
          e.type === "tool.completed" && e.payload.name === "task" && e.payload.status === "ok",
      ),
    ).toBe(true);
    expect(
      events
        .filter((e) => e.type === "message.assistant")
        .flatMap((e) => e.payload.content)
        .some((b) => b.type === "text" && b.text.includes(token)),
    ).toBe(true);
    await session.close();
  });

  it.skipIf(THINKING_MODEL === undefined)(
    "扩展思考：缺 finish 后催促，带历史 thinking 的兜底轮强制 finish 被真实服务接受",
    async () => {
      const base = createAnthropicProvider({
        id: PROVIDER_ID,
        type: "anthropic",
        ...(BASE_URL !== undefined ? { baseURL: BASE_URL } : {}),
        apiKeyEnv: "NOCTURNE_SMOKE_ANTHROPIC_API_KEY",
        models: { [THINKING_MODEL ?? ""]: {} },
        providerOptions: { thinking: { type: "enabled", budgetTokens: 1024 } },
      });
      let childAttempts = 0;
      let childReasoning = 0;
      let forcedWithThinkingHistory = false;
      const provider: Provider = {
        id: base.id,
        type: base.type,
        models: () => base.models(),
        async *stream(request, signal) {
          const child = request.tools.some((t) => t.name === "finish");
          if (child) childAttempts++;
          if (child && request.toolChoice?.name === "finish") {
            forcedWithThinkingHistory = request.messages.some(
              (m) => m.role === "assistant" && m.content.some((b) => b.type === "reasoning"),
            );
          }
          // 前两轮故意不向真实服务提供 finish，稳定触发产品原有的催促与兜底路径。
          const forwarded = child && childAttempts < 3 ? { ...request, tools: [] } : request;
          for await (const event of base.stream(forwarded, signal)) {
            if (child && event.type === "reasoning_delta") childReasoning++;
            yield event;
          }
        },
      };
      const runtime = await createRuntime({
        cwd: makeTmp("nct-smoke-ws-"),
        sessionsDir: makeTmp("nct-smoke-sessions-"),
        providers: [provider],
        permissions: { autoApproveAsk: true },
        subagent: { maxAttempts: 3 },
      });
      const session = await runtime.createSession({ model: `${PROVIDER_ID}/${THINKING_MODEL}` });
      const events: RuntimeEvent[] = [];
      session.subscribe((e) => events.push(e));
      expect(
        await session.submit({
          text: "调用 task 完成任务：计算 17 + 25，子代理用 finish 返回结果。",
        }),
      ).toBe("done");
      expect(childAttempts).toBe(3);
      expect(childReasoning).toBeGreaterThan(0);
      expect(forcedWithThinkingHistory).toBe(true);
      expect(
        events.some(
          (e) =>
            e.type === "tool.completed" && e.payload.name === "task" && e.payload.status === "ok",
        ),
      ).toBe(true);
      await session.close();
    },
  );
});
