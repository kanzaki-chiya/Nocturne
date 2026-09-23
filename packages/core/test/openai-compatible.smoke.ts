/**
 * 真实 OpenAI 兼容服务冒烟测试（workflow.md：与默认测试集分离）。
 * 运行：pnpm test:smoke；需要环境变量：
 *   NOCTURNE_SMOKE_BASE_URL  例如 https://api.deepseek.com/v1
 *   NOCTURNE_SMOKE_API_KEY   服务凭据（只从环境变量读取）
 *   NOCTURNE_SMOKE_MODEL     模型 id，例如 deepseek-chat
 * 未设置时跳过。仅在不含敏感信息的测试工作区中运行——工作区内容会发给模型服务。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createRuntime } from "../src/index.js";
import type { RuntimeEvent } from "../src/protocol/index.js";

const BASE_URL = process.env.NOCTURNE_SMOKE_BASE_URL;
const API_KEY = process.env.NOCTURNE_SMOKE_API_KEY;
const MODEL = process.env.NOCTURNE_SMOKE_MODEL;
const PROVIDER_ID = "smoke";

const configured = BASE_URL !== undefined && API_KEY !== undefined && MODEL !== undefined;

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
        baseURL: BASE_URL ?? "",
        apiKeyEnv: "NOCTURNE_SMOKE_API_KEY",
        models: { [MODEL ?? ""]: {} },
      },
    ],
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

describe.skipIf(!configured)("openai-compatible 冒烟（真实服务）", () => {
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
    const assistant = events.find((e) => e.type === "message.assistant");
    expect(
      assistant?.type === "message.assistant" && assistant.payload.content.length,
    ).toBeGreaterThan(0);
    await session.close();
  });

  it("工具往返：模型调用 read，工具结果回到模型后 Turn 完成", async () => {
    const cwd = makeTmp("nct-smoke-ws-");
    const token = `NCT-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
    writeFileSync(
      path.join(cwd, "secret.txt"),
      `口令：${token}
`,
    );
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
});
