/**
 * 开头混合附件的 context→provider 端到端保序回归（r1126n-fix2）。
 * 放在 agent 层：agent-deps 允许同时依赖 context（buildContext 投影）与
 * provider（openai-compatible 适配器），core 内 provider/context 各自的依赖方向
 * 都不允许互相串联实现模块。这里用 buildContext 的真实输出驱动 provider，
 * 不手工伪造预期输入——projection 的 afterBlock 值完全由实现计算。
 */
import { describe, expect, it } from "vitest";

import type { HistoryEntry, ImageAttachment } from "../protocol/index.js";
import { buildContext, type BuildContextInput } from "../context/index.js";
import type { ModelInfo, ModelStreamEvent } from "../provider/index.js";
import { createOpenAICompatibleProvider } from "../provider/adapters/openai-compatible.js";

const envWithKey = (name: string) => (name === "TEST_OAI_KEY" ? "sk-test" : undefined);

const visionModel: ModelInfo = {
  ref: { provider: "test", model: "gpt-x" },
  contextWindow: 100_000,
  maxOutputTokens: 8_000,
  capabilities: {
    toolCalls: true,
    parallelToolCalls: true,
    reasoning: "none",
    imageInput: true,
    promptCache: false,
    editTool: "edit",
  },
};

const baseInput = (over: Partial<BuildContextInput> = {}): BuildContextInput => ({
  history: [],
  model: visionModel,
  tools: [{ name: "read", description: "read a file", inputSchema: { type: "object" } }],
  instructions: { project: [] },
  environment: {
    os: "Windows 11",
    shell: "pwsh",
    cwd: "C:\\ws",
    workspaceRoot: "C:\\ws",
    sessionDate: "2025-01-01",
  },
  ...over,
});

const att = (sha: string): ImageAttachment => ({
  type: "image",
  file: `img-${sha}.png`,
  mimeType: "image/png",
  bytes: 29,
  sha256: sha,
  width: 2,
  height: 3,
  source: "paste",
});

const dataOf = (...shas: string[]): ReadonlyMap<string, string> =>
  new Map(shas.map((s) => [s, Buffer.from(`bytes-of-${s}`).toString("base64")]));

function sseFetch(events: object[], capture?: { body?: Record<string, unknown> }) {
  return async (_input: unknown, init?: RequestInit): Promise<Response> => {
    if (capture !== undefined) {
      capture.body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    }
    const payload = `${events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("")}data: [DONE]\n\n`;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(payload));
        c.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };
}

const doneChunk = [
  {
    id: "c1",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: { role: "assistant", content: "ok" } }],
  },
  {
    id: "c1",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  },
];

function config() {
  return {
    id: "oai",
    type: "openai-compatible",
    baseURL: "https://api.test/v1",
    apiKeyEnv: "TEST_OAI_KEY",
    models: { "gpt-x": {} },
  } as const;
}

/** 缺图占位在 wire parts 中的指纹 */
const PLACEHOLDER = "[image unavailable: attachment file missing]";

/** 提取 wire 中第一条 user 消息的 content parts 形状：占位/文本/各图（按 base64 指纹） */
function wireShape(capture: { body?: Record<string, unknown> }): string[] {
  const msgs = capture.body?.["messages"] as Record<string, unknown>[];
  const user = msgs.find((m) => Array.isArray(m["content"]));
  const parts = user?.["content"] as Record<string, unknown>[];
  return parts.map((part) => {
    if (part["type"] === "image_url") {
      const url = String((part["image_url"] as Record<string, unknown>)?.["url"] ?? "");
      if (url.includes(Buffer.from("bytes-of-valid-blue").toString("base64"))) return "blue";
      if (url.includes(Buffer.from("bytes-of-valid-red").toString("base64"))) return "red";
      return "image";
    }
    const text = String(part["text"]);
    return text === PLACEHOLDER ? "placeholder" : `text:${text}`;
  });
}

describe("开头混合附件 context→provider 端到端保序（r1126n-fix2）", () => {
  const buildAndSend = async (
    attachments: ImageAttachment[],
    content: { type: "text"; text: string }[],
  ) => {
    const history: HistoryEntry[] = [
      {
        kind: "user",
        seq: 1,
        turnId: "t",
        messageId: "u1",
        content,
        attachments,
      },
    ];
    const built = buildContext(
      baseInput({ history, attachmentData: dataOf("valid-blue", "valid-red") }),
    );
    // 用 buildContext 的真实输出直接驱动 provider——afterBlock 全由实现计算，不伪造
    const capture: { body?: Record<string, unknown> } = {};
    const p = createOpenAICompatibleProvider(config(), envWithKey, sseFetch(doneChunk, capture));
    const events: ModelStreamEvent[] = [];
    for await (const ev of p.stream(built.request, new AbortController().signal)) events.push(ev);
    return capture;
  };

  it("开头反向 [缺图,有效蓝图,A]：wire 为 占位/蓝图/A（蓝图不错位到占位前）", async () => {
    // 缺图先提交（数据缺失变占位）、蓝图后提交（有效）。缺图占位插到开头占 textParts[0]，
    // 蓝图应在占位之后。修复前蓝图留 -1 leading 桶，错位到占位前。
    const capture = await buildAndSend(
      [
        { ...att("missing-red"), afterBlock: -1 }, // 先提交，sha 无数据 → 占位
        { ...att("valid-blue"), afterBlock: -1 }, // 后提交，数据齐全 → 图片
      ],
      [{ type: "text", text: "A" }],
    );
    expect(wireShape(capture)).toEqual(["placeholder", "blue", "text:A"]);
  });

  it("开头正向 [有效蓝图,缺图,A]：wire 为 蓝图/占位/A（蓝图在占位前）", async () => {
    // 蓝图先提交（有效）、缺图后提交（占位）。蓝图在占位前——afterBlock 保持 -1 leading。
    const capture = await buildAndSend(
      [
        { ...att("valid-blue"), afterBlock: -1 }, // 先提交，数据齐全 → 图片
        { ...att("missing-red"), afterBlock: -1 }, // 后提交，sha 无数据 → 占位
      ],
      [{ type: "text", text: "A" }],
    );
    expect(wireShape(capture)).toEqual(["blue", "placeholder", "text:A"]);
  });

  it("开头纯附件一缺一在 [缺图,有效蓝图]：wire 为 占位/蓝图（有效图在占位后）", async () => {
    // 纯附件无文本块。缺图先提交变占位、蓝图后提交有效——占位在前、蓝图在后。
    const capture = await buildAndSend(
      [
        { ...att("missing-red"), afterBlock: -1 }, // 先提交 → 占位
        { ...att("valid-blue"), afterBlock: -1 }, // 后提交 → 图片
      ],
      [],
    );
    expect(wireShape(capture)).toEqual(["placeholder", "blue"]);
  });

  it("开头纯附件一在一缺 [有效蓝图,缺图]：wire 为 蓝图/占位（有效图在占位前）", async () => {
    const capture = await buildAndSend(
      [
        { ...att("valid-blue"), afterBlock: -1 }, // 先提交 → 图片
        { ...att("missing-red"), afterBlock: -1 }, // 后提交 → 占位
      ],
      [],
    );
    expect(wireShape(capture)).toEqual(["blue", "placeholder"]);
  });
});
