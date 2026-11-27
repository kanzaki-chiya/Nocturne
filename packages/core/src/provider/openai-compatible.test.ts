/**
 * openai-compatible 适配器契约测试（离线）：stub fetch 注入 Chat Completions SSE，
 * 覆盖 toolChoice 映射与推理冲突处置（provider-api.md 第 3 节）。
 */
import { describe, expect, it } from "vitest";

import { classifyStreamErrorKind, toProviderError } from "./adapters/ai-sdk-common.js";
import {
  createOpenAICompatibleProvider,
  type OpenAICompatibleConfig,
} from "./adapters/openai-compatible.js";
import { ProviderError } from "./errors.js";
import type { ModelRequest, ModelStreamEvent } from "./types.js";

const envWithKey = (name: string) => (name === "TEST_OAI_KEY" ? "sk-test" : undefined);

function config(overrides: Partial<OpenAICompatibleConfig> = {}): OpenAICompatibleConfig {
  return {
    id: "oai",
    type: "openai-compatible",
    baseURL: "https://api.test/v1",
    apiKeyEnv: "TEST_OAI_KEY",
    models: { "gpt-x": {} },
    ...overrides,
  };
}

function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    model: "gpt-x",
    system: [{ text: "sys" }],
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    tools: [
      {
        name: "finish",
        description: "提交结果",
        inputSchema: { type: "object", properties: { result: { type: "string" } } },
      },
    ],
    maxOutputTokens: 1024,
    ...overrides,
  };
}

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

/** 返回 finish 工具调用的流（toolChoice 请求下 SDK 强制校验调用存在） */
const finishCallChunk = [
  {
    id: "c1",
    object: "chat.completion.chunk",
    choices: [
      {
        index: 0,
        delta: {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "call_1",
              type: "function",
              function: { name: "finish", arguments: '{"result":"done"}' },
            },
          ],
        },
      },
    ],
  },
  {
    id: "c1",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  },
];

async function collect(p: ReturnType<typeof createOpenAICompatibleProvider>, req: ModelRequest) {
  const events: ModelStreamEvent[] = [];
  for await (const ev of p.stream(req, new AbortController().signal)) events.push(ev);
  return events;
}

describe("openai-compatible 适配器：toolChoice", () => {
  it("流式请求带 stream_options.include_usage（部分服务不带就不返回用量）", async () => {
    const capture: { body?: Record<string, unknown> } = {};
    const p = createOpenAICompatibleProvider(
      config(),
      envWithKey,
      sseFetch(finishCallChunk, capture),
    );
    await collect(p, request());
    expect(capture.body?.["stream_options"]).toEqual({ include_usage: true });
  });

  it("toolChoice 映射为具体 tool_choice（function 指定名）", async () => {
    const capture: { body?: Record<string, unknown> } = {};
    const p = createOpenAICompatibleProvider(
      config(),
      envWithKey,
      sseFetch(finishCallChunk, capture),
    );
    await collect(p, request({ toolChoice: { name: "finish" } }));
    expect(capture.body?.["tool_choice"]).toEqual({
      type: "function",
      function: { name: "finish" },
    });
  });

  it("providerOptions 里可识别的推理键 + toolChoice：本轮移除推理键并保留 tool_choice", async () => {
    const capture: { body?: Record<string, unknown> } = {};
    const records: { kind: string; data: Record<string, unknown> }[] = [];
    const p = createOpenAICompatibleProvider(
      config({
        providerOptions: { reasoningEffort: "high", other: "keep" },
        diagnostics: { record: (kind, data) => records.push({ kind, data: data ?? {} }) },
      }),
      envWithKey,
      sseFetch(finishCallChunk, capture),
    );
    await collect(p, request({ toolChoice: { name: "finish" } }));
    // 推理键本轮移除（兜底轮临时关闭），其余键保留；tool_choice 正常下发
    const body = capture.body ?? {};
    expect(Object.keys(body).some((k) => k.toLowerCase().includes("reasoning"))).toBe(false);
    expect(body["tool_choice"]).toEqual({
      type: "function",
      function: { name: "finish" },
    });
    expect(records.some((r) => r.kind === "provider.unsupported_capability")).toBe(true);
    expect(
      records.find((r) => r.kind === "provider.unsupported_capability")?.data["resolution"],
    ).toBe("disabled_reasoning");
  });

  it("归一化 reasoningEffort + toolChoice：无法安全关闭 → 丢弃 tool_choice", async () => {
    const capture: { body?: Record<string, unknown> } = {};
    const records: { kind: string; data: Record<string, unknown> }[] = [];
    const p = createOpenAICompatibleProvider(
      config({
        diagnostics: { record: (kind, data) => records.push({ kind, data: data ?? {} }) },
      }),
      envWithKey,
      sseFetch(doneChunk, capture),
    );
    await collect(p, request({ toolChoice: { name: "finish" }, reasoningEffort: "high" }));
    // tool_choice 被丢弃：SDK 默认的 "auto" 不算具体指定（body 里没有 function 指定名）
    const tc = capture.body?.["tool_choice"];
    expect(tc === undefined || tc === "auto").toBe(true);
    expect(
      records.find((r) => r.kind === "provider.unsupported_capability")?.data["resolution"],
    ).toBe("dropped_tool_choice");
  });

  it("无 toolChoice 时行为不变（回归）", async () => {
    const capture: { body?: Record<string, unknown> } = {};
    const p = createOpenAICompatibleProvider(
      config({ providerOptions: { reasoningEffort: "high" } }),
      envWithKey,
      sseFetch(doneChunk, capture),
    );
    const events = await collect(p, request());
    // 无 toolChoice：SDK 可能发默认 "auto"，绝不能出现具体指定
    const tc = capture.body?.["tool_choice"];
    expect(tc === undefined || tc === "auto").toBe(true);
    expect(Object.keys(capture.body ?? {}).some((k) => k.toLowerCase().includes("reasoning"))).toBe(
      true,
    );
    expect(events.at(-1)).toMatchObject({ type: "finish" });
  });
});

describe("openai-compatible 适配器：reasoningEffort 映射（ADR-0018 §3）", () => {
  const noReasoningKeys = (body: Record<string, unknown>) =>
    Object.keys(body).filter((k) => k === "reasoning_effort" || k === "reasoning");

  it.each(["minimal", "low", "medium", "high", "xhigh", "max"] as const)(
    "openai 格式：档位 %s 原样写入 reasoning_effort（max 也原样发送）",
    async (level) => {
      const capture: { body?: Record<string, unknown> } = {};
      const p = createOpenAICompatibleProvider(config(), envWithKey, sseFetch(doneChunk, capture));
      await collect(p, request({ reasoningEffort: level }));
      expect(capture.body?.["reasoning_effort"]).toBe(level);
    },
  );

  it("openrouter 格式（thinking.format）：写入 reasoning.effort，不发 reasoning_effort", async () => {
    const capture: { body?: Record<string, unknown> } = {};
    const p = createOpenAICompatibleProvider(
      config({ thinking: { format: "openrouter" } }),
      envWithKey,
      sseFetch(doneChunk, capture),
    );
    await collect(p, request({ reasoningEffort: "max" }));
    expect(capture.body?.["reasoning"]).toEqual({ effort: "max" });
    expect(capture.body?.["reasoning_effort"]).toBeUndefined();
  });

  it("不带档位：请求体不出现任何思考字段", async () => {
    const capture: { body?: Record<string, unknown> } = {};
    const p = createOpenAICompatibleProvider(config(), envWithKey, sseFetch(doneChunk, capture));
    await collect(p, request());
    expect(noReasoningKeys(capture.body ?? {})).toEqual([]);
  });

  it("归一化字段覆盖同名 providerOptions 键（归一化胜出）", async () => {
    const capture: { body?: Record<string, unknown> } = {};
    const p = createOpenAICompatibleProvider(
      config({ providerOptions: { reasoning_effort: "minimal", other: "keep" } }),
      envWithKey,
      sseFetch(doneChunk, capture),
    );
    await collect(p, request({ reasoningEffort: "high" }));
    expect(capture.body?.["reasoning_effort"]).toBe("high");
    // 其余 providerOptions 键正常透传
    expect(capture.body?.["other"]).toBe("keep");
  });

  it("连字符 provider id：providerOptions 写入驼峰命名空间（SDK 首选键）", async () => {
    const capture: { body?: Record<string, unknown> } = {};
    const p = createOpenAICompatibleProvider(
      config({ id: "my-p", providerOptions: { other: "keep" } }),
      envWithKey,
      sseFetch(doneChunk, capture),
    );
    await collect(p, request({ reasoningEffort: "high" }));
    expect(capture.body?.["reasoning_effort"]).toBe("high");
    expect(capture.body?.["other"]).toBe("keep");
  });

  it("openrouter 格式与既有 reasoning 对象键合并（effort 覆盖，其余保留）", async () => {
    const capture: { body?: Record<string, unknown> } = {};
    const p = createOpenAICompatibleProvider(
      config({
        thinking: { format: "openrouter" },
        providerOptions: { reasoning: { exclude: true, effort: "low" } },
      }),
      envWithKey,
      sseFetch(doneChunk, capture),
    );
    await collect(p, request({ reasoningEffort: "xhigh" }));
    expect(capture.body?.["reasoning"]).toEqual({ exclude: true, effort: "xhigh" });
  });
});

describe("openai-compatible 适配器：图片（ADR-0023）", () => {
  const png = { mimeType: "image/png" as const, data: "aVZCT1I=" };

  it("tool 消息带图：tool 仍是纯文本，批末插入一条 user 消息（image_url + 标注行）", async () => {
    const capture: { body?: Record<string, unknown> } = {};
    const p = createOpenAICompatibleProvider(config(), envWithKey, sseFetch(doneChunk, capture));
    await collect(
      p,
      request({
        messages: [
          { role: "user", content: [{ type: "text", text: "go" }] },
          {
            role: "assistant",
            content: [{ type: "text", text: "" }],
            toolCalls: [
              { callId: "c1", name: "read" },
              { callId: "c2", name: "read" },
            ],
          },
          {
            role: "tool",
            callId: "c1",
            name: "read",
            content: "r1",
            isError: false,
            images: [png],
          },
          {
            role: "tool",
            callId: "c2",
            name: "read",
            content: "r2",
            isError: false,
            images: [png],
          },
          { role: "assistant", content: [{ type: "text", text: "done" }], toolCalls: [] },
        ],
      }),
    );
    const msgs = capture.body?.["messages"] as Record<string, unknown>[];
    // 两条 tool 之后、下一条 assistant 之前，恰好一条图片 user 消息
    expect(msgs.map((m) => m["role"])).toEqual([
      "system",
      "user",
      "assistant",
      "tool",
      "tool",
      "user",
      "assistant",
    ]);
    expect(msgs[3]?.["content"]).toBe("r1");
    expect(msgs[4]?.["content"]).toBe("r2");
    expect(msgs[5]?.["content"]).toEqual([
      { type: "text", text: "Image from tool call c1 (read):" },
      { type: "image_url", image_url: { url: "data:image/png;base64,aVZCT1I=" } },
      { type: "text", text: "Image from tool call c2 (read):" },
      { type: "image_url", image_url: { url: "data:image/png;base64,aVZCT1I=" } },
    ]);
    // base64 不得以 JSON.stringify 形式出现在 tool content 里
    expect(JSON.stringify(capture.body)).not.toContain('"type":"image-data"');
  });

  it("工具结果后紧跟用户消息：图片 user 消息在 tool 之后、原用户消息之前", async () => {
    const capture: { body?: Record<string, unknown> } = {};
    const p = createOpenAICompatibleProvider(config(), envWithKey, sseFetch(doneChunk, capture));
    await collect(
      p,
      request({
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "" }],
            toolCalls: [{ callId: "c1", name: "read" }],
          },
          { role: "tool", callId: "c1", name: "read", content: "r", isError: false, images: [png] },
          { role: "user", content: [{ type: "text", text: "然后呢" }] },
        ],
      }),
    );
    const msgs = capture.body?.["messages"] as Record<string, unknown>[];
    expect(msgs.map((m) => m["role"])).toEqual(["system", "assistant", "tool", "user", "user"]);
    expect((msgs[3]?.["content"] as unknown[])[0]).toEqual({
      type: "text",
      text: "Image from tool call c1 (read):",
    });
    expect(msgs[4]?.["content"]).toBe("然后呢");
  });

  it("用户消息自带图片 → image_url 部件；无图片回归不变", async () => {
    const capture: { body?: Record<string, unknown> } = {};
    const p = createOpenAICompatibleProvider(config(), envWithKey, sseFetch(doneChunk, capture));
    await collect(
      p,
      request({
        messages: [{ role: "user", content: [{ type: "text", text: "look" }], images: [png] }],
      }),
    );
    const msgs = capture.body?.["messages"] as Record<string, unknown>[];
    expect(msgs[1]?.["content"]).toEqual([
      { type: "text", text: "look" },
      { type: "image_url", image_url: { url: "data:image/png;base64,aVZCT1I=" } },
    ]);

    const noImg: { body?: Record<string, unknown> } = {};
    const p2 = createOpenAICompatibleProvider(config(), envWithKey, sseFetch(doneChunk, noImg));
    await collect(p2, request());
    const noImgMsgs = noImg.body?.["messages"] as Record<string, unknown>[];
    expect(noImgMsgs.map((m) => m["role"])).toEqual(["system", "user"]);
    expect(noImgMsgs[1]?.["content"]).toBe("hi");
  });

  it("用户图片带 afterBlock：image_url 部件穿插到对应文本块之后，不默认堆到末尾", async () => {
    const capture: { body?: Record<string, unknown> } = {};
    const p = createOpenAICompatibleProvider(config(), envWithKey, sseFetch(doneChunk, capture));
    await collect(
      p,
      request({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "text A" },
              { type: "text", text: "text B" },
              { type: "text", text: "text C" },
            ],
            images: [
              { ...png, afterBlock: 0 },
              { ...png, afterBlock: 1 },
            ],
          },
        ],
      }),
    );
    const msgs = capture.body?.["messages"] as Record<string, unknown>[];
    const parts = msgs[1]?.["content"] as Record<string, unknown>[];
    const shape = parts.map((part) =>
      part["type"] === "image_url" ? "image" : `text:${String(part["text"])}`,
    );
    expect(shape).toEqual(["text:text A", "image", "text:text B", "image", "text:text C"]);
  });

  it("用户图片混合位置：带位置的穿插、无位置的追加末尾", async () => {
    const capture: { body?: Record<string, unknown> } = {};
    const p = createOpenAICompatibleProvider(config(), envWithKey, sseFetch(doneChunk, capture));
    await collect(
      p,
      request({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "text A" },
              { type: "text", text: "text B" },
            ],
            images: [{ ...png, afterBlock: 0 }, png],
          },
        ],
      }),
    );
    const msgs = capture.body?.["messages"] as Record<string, unknown>[];
    const parts = msgs[1]?.["content"] as Record<string, unknown>[];
    const shape = parts.map((part) =>
      part["type"] === "image_url" ? "image" : `text:${String(part["text"])}`,
    );
    expect(shape).toEqual(["text:text A", "image", "text:text B", "image"]);
  });

  // 两个不同指纹的图片（data 不同），用于在 wire 上区分 image1/image2 的身份与顺序
  const pngRed = { mimeType: "image/png" as const, data: "UkVE" }; // "RED"
  const pngBlue = { mimeType: "image/png" as const, data: "QkxVRQ==" }; // "BLUE"
  const imgFingerprint = (part: Record<string, unknown> | undefined): string => {
    if (part === undefined) return "";
    const url = (part["image_url"] as { url?: string } | undefined)?.url ?? "";
    return url;
  };

  it("前置图片（afterBlock=-1）：image_url 部件在第 0 个文本块之前，不堆到文字后", async () => {
    const capture: { body?: Record<string, unknown> } = {};
    const p = createOpenAICompatibleProvider(config(), envWithKey, sseFetch(doneChunk, capture));
    await collect(
      p,
      request({
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "lead text" }],
            images: [{ ...pngRed, afterBlock: -1 }],
          },
        ],
      }),
    );
    const msgs = capture.body?.["messages"] as Record<string, unknown>[];
    const parts = msgs[1]?.["content"] as Record<string, unknown>[];
    const shape = parts.map((part) =>
      part["type"] === "image_url" ? "image" : `text:${String(part["text"])}`,
    );
    // 图片在最前，不是文字后
    expect(shape).toEqual(["image", "text:lead text"]);
    // 指纹：是红图
    expect(imgFingerprint(parts[0])).toContain("UkVE");
  });

  it("纯图片（无文本块）：afterBlock=-1 的两张图都输出且不丢失，同槽保持顺序", async () => {
    const capture: { body?: Record<string, unknown> } = {};
    const p = createOpenAICompatibleProvider(config(), envWithKey, sseFetch(doneChunk, capture));
    await collect(
      p,
      request({
        messages: [
          {
            role: "user",
            content: [],
            images: [
              { ...pngRed, afterBlock: -1 },
              { ...pngBlue, afterBlock: -1 },
            ],
          },
        ],
      }),
    );
    const msgs = capture.body?.["messages"] as Record<string, unknown>[];
    const parts = msgs[1]?.["content"] as Record<string, unknown>[];
    const images = parts.filter((part) => part["type"] === "image_url");
    // 空 textParts 时两张图都必须输出（不丢图），红前蓝后
    expect(images.length).toBe(2);
    expect(imgFingerprint(images[0])).toContain("UkVE");
    expect(imgFingerprint(images[1])).toContain("QkxVRQ");
  });

  it("末尾越界位置（afterBlock ≥ 文本块数）：图片追加到末尾，不丢失", async () => {
    const capture: { body?: Record<string, unknown> } = {};
    const p = createOpenAICompatibleProvider(config(), envWithKey, sseFetch(doneChunk, capture));
    await collect(
      p,
      request({
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "only text" }],
            images: [{ ...pngRed, afterBlock: 5 }],
          },
        ],
      }),
    );
    const msgs = capture.body?.["messages"] as Record<string, unknown>[];
    const parts = msgs[1]?.["content"] as Record<string, unknown>[];
    const shape = parts.map((part) =>
      part["type"] === "image_url" ? "image" : `text:${String(part["text"])}`,
    );
    // 越界位置追加到末尾（文字之后）
    expect(shape).toEqual(["text:only text", "image"]);
  });

  it("混合交错序列指纹核对：image1(红)/textA/image2(蓝) wire 顺序与身份", async () => {
    const capture: { body?: Record<string, unknown> } = {};
    const p = createOpenAICompatibleProvider(config(), envWithKey, sseFetch(doneChunk, capture));
    await collect(
      p,
      request({
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "text A" }],
            images: [
              { ...pngRed, afterBlock: -1 },
              { ...pngBlue, afterBlock: 0 },
            ],
          },
        ],
      }),
    );
    const msgs = capture.body?.["messages"] as Record<string, unknown>[];
    const parts = msgs[1]?.["content"] as Record<string, unknown>[];
    // 逐 part 断言类型、顺序与图片指纹身份：红在 textA 前、蓝在 textA 后
    expect(parts.length).toBe(3);
    expect(parts[0]?.["type"]).toBe("image_url");
    expect(imgFingerprint(parts[0])).toContain("UkVE");
    expect(parts[1]?.["type"]).toBe("text");
    expect(parts[1]?.["text"]).toBe("text A");
    expect(parts[2]?.["type"]).toBe("image_url");
    expect(imgFingerprint(parts[2])).toContain("QkxVRQ");
  });

  it("端到端 context→provider：缺图占位膨胀后有效蓝图不错位（对旧实现失败）", async () => {
    // r1126n-fix2 问题2 的确定性回归（provider 半段）：buildContext 投影缺图占位后 textParts
    // 索引膨胀为 [A,占位,B,C]（占位 idx1），有效蓝图的 afterBlock 被一致重映射为 2（指向 B）。
    // 这里喂入与 buildContext 投影等价的消息（context 半段的重映射值由 context.test.ts 钉住，
    // 依赖方向禁止 provider→context 串联两个实现模块），核对适配器按重映射索引穿插为
    // [A,占位,B,蓝图,C]——若 afterBlock 仍是原始索引 1（旧实现），蓝图被插到占位后、B 前而错位。
    const capture: { body?: Record<string, unknown> } = {};
    const p = createOpenAICompatibleProvider(config(), envWithKey, sseFetch(doneChunk, capture));
    await collect(
      p,
      request({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "A" },
              { type: "text", text: "[image unavailable: attachment file missing]" },
              { type: "text", text: "B" },
              { type: "text", text: "C" },
            ],
            images: [{ ...pngBlue, afterBlock: 2 }],
          },
        ],
      }),
    );
    const msgs = capture.body?.["messages"] as Record<string, unknown>[];
    const parts = msgs[1]?.["content"] as Record<string, unknown>[];
    // 逐 part 核对类型与顺序：A / 缺图占位 / B / 蓝图 / C
    const shape = parts.map((part) =>
      part["type"] === "image_url" ? "image" : `text:${String(part["text"])}`,
    );
    expect(shape).toEqual([
      "text:A",
      "text:[image unavailable: attachment file missing]",
      "text:B",
      "image",
      "text:C",
    ]);
    // 蓝图指纹身份确认：image part 是 valid-blue（BLUE），且在 B 之后
    const imagePart = parts.find((part) => part["type"] === "image_url");
    expect(imgFingerprint(imagePart)).toContain("QkxVRQ");
    // 蓝图的位置：在 text:B（索引2）之后、text:C 之前——不在 B 之前
    const blueIdx = parts.findIndex((part) => part["type"] === "image_url");
    const bIdx = parts.findIndex((part) => part["text"] === "B");
    const cIdx = parts.findIndex((part) => part["text"] === "C");
    expect(blueIdx).toBeGreaterThan(bIdx);
    expect(blueIdx).toBeLessThan(cIdx);
  });

  it("端到端：同锚点混合附件蓝图先缺图后——wire 为 A/蓝图/占位/B（蓝图不错位到占位后）", async () => {
    // r1126n-fix2 同锚点保序（provider 半段）：原 [A,有效蓝图,缺图,B]，两图同 afterBlock=0，
    // 蓝图先提交。投影 textParts=[A,占位,B]，蓝图正确 afterBlock=0（context 半段钉住）。
    // 适配器应穿插为 A/蓝图/占位/B——蓝图在缺图占位之前，而非被机械错位到占位后。
    const capture: { body?: Record<string, unknown> } = {};
    const p = createOpenAICompatibleProvider(config(), envWithKey, sseFetch(doneChunk, capture));
    await collect(
      p,
      request({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "A" },
              { type: "text", text: "[image unavailable: attachment file missing]" },
              { type: "text", text: "B" },
            ],
            images: [{ ...pngBlue, afterBlock: 0 }],
          },
        ],
      }),
    );
    const msgs = capture.body?.["messages"] as Record<string, unknown>[];
    const parts = msgs[1]?.["content"] as Record<string, unknown>[];
    const shape = parts.map((part) =>
      part["type"] === "image_url" ? "image" : `text:${String(part["text"])}`,
    );
    // 蓝图在 A 之后、缺图占位之前
    expect(shape).toEqual([
      "text:A",
      "image",
      "text:[image unavailable: attachment file missing]",
      "text:B",
    ]);
    expect(imgFingerprint(parts.find((part) => part["type"] === "image_url"))).toContain("QkxVRQ");
  });

  it("端到端：同锚点混合附件缺图先蓝图后——wire 为 A/占位/蓝图/B（蓝图在占位后）", async () => {
    // 相反排列：原 [A,缺图,有效蓝图,B]，两图同 afterBlock=0，缺图先提交。
    // 蓝图正确 afterBlock=1（插到占位 idx1 之后），适配器穿插为 A/占位/蓝图/B。
    const capture: { body?: Record<string, unknown> } = {};
    const p = createOpenAICompatibleProvider(config(), envWithKey, sseFetch(doneChunk, capture));
    await collect(
      p,
      request({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "A" },
              { type: "text", text: "[image unavailable: attachment file missing]" },
              { type: "text", text: "B" },
            ],
            images: [{ ...pngBlue, afterBlock: 1 }],
          },
        ],
      }),
    );
    const msgs = capture.body?.["messages"] as Record<string, unknown>[];
    const parts = msgs[1]?.["content"] as Record<string, unknown>[];
    const shape = parts.map((part) =>
      part["type"] === "image_url" ? "image" : `text:${String(part["text"])}`,
    );
    // 蓝图在缺图占位之后、B 之前
    expect(shape).toEqual([
      "text:A",
      "text:[image unavailable: attachment file missing]",
      "image",
      "text:B",
    ]);
    expect(imgFingerprint(parts.find((part) => part["type"] === "image_url"))).toContain("QkxVRQ");
  });

  it("端到端 context→provider：压缩重注入保留原任务图片/文字对应关系（对旧实现失败）", async () => {
    // r1126n-fix2 问题1 的确定性回归（provider 半段）：压缩重注入在 content 前插 MARK
    // 前缀，original 附件 afterBlock 平移（N→N+1，-1→0）后按位置穿插。原任务
    // [红图(开头),「请看左图」,蓝图(请看左图后),「请看右图」] 的投影为：
    // content [MARK, 请看左图, 请看右图]（MARK 占索引 0），images red afterBlock=0
    // （MARK 后、请看左图前）、blue afterBlock=1（请看左图后）。这里喂入与该投影等价的
    // 消息——context 半段的平移值由 context.test.ts 钉住，依赖方向禁止 provider→context
    // 串联两个实现模块。核对适配器按平移后索引穿插为 MARK / 红图 / 请看左图 / 蓝图 /
    // 请看右图——红在左图前、蓝在左图后，而非剥掉位置变成两段文字后跟两图。
    const mark =
      "[当前 Turn 开始时的用户请求（原文）]\n它被上面的摘要覆盖后重新附在这里，不是新的请求。";
    const capture: { body?: Record<string, unknown> } = {};
    const p = createOpenAICompatibleProvider(config(), envWithKey, sseFetch(doneChunk, capture));
    await collect(
      p,
      request({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: mark },
              { type: "text", text: "请看左图" },
              { type: "text", text: "请看右图" },
            ],
            images: [
              { ...pngRed, afterBlock: 0 },
              { ...pngBlue, afterBlock: 1 },
            ],
          },
        ],
      }),
    );
    const msgs = capture.body?.["messages"] as Record<string, unknown>[];
    const parts = msgs[1]?.["content"] as Record<string, unknown>[];
    // 逐 part 核对：MARK / 红图 / 请看左图 / 蓝图 / 请看右图——红在左图前、蓝在左图后
    const shape = parts.map((part) =>
      part["type"] === "image_url"
        ? imgFingerprint(part).includes("UkVE")
          ? "red"
          : "blue"
        : `text:${String(part["text"]).slice(0, 12)}`,
    );
    const redIdx = shape.indexOf("red");
    const blueIdx = shape.indexOf("blue");
    const leftIdx = parts.findIndex((part) => part["text"] === "请看左图");
    const rightIdx = parts.findIndex((part) => part["text"] === "请看右图");
    expect(redIdx).toBeGreaterThanOrEqual(0);
    expect(blueIdx).toBeGreaterThanOrEqual(0);
    expect(leftIdx).toBeGreaterThanOrEqual(0);
    expect(rightIdx).toBeGreaterThanOrEqual(0);
    // 红图在「请看左图」前；蓝图在「请看左图」后、「请看右图」前
    expect(redIdx).toBeLessThan(leftIdx);
    expect(blueIdx).toBeGreaterThan(leftIdx);
    expect(blueIdx).toBeLessThan(rightIdx);
  });
});

// ADR-0070：插话紧跟工具结果。Chat Completions 用独立的 role=tool 消息承载结果，
// 随后跟一条 role=user 是合法序列，不需要合并。
it("工具结果后紧跟的用户文本是独立的 role=user 消息", async () => {
  const capture: { body?: Record<string, unknown> } = {};
  const p = createOpenAICompatibleProvider(config(), envWithKey, sseFetch(doneChunk, capture));
  await p
    .stream(
      request({
        messages: [
          { role: "user", content: [{ type: "text", text: "做个页面" }] },
          {
            role: "assistant",
            content: [],
            toolCalls: [{ callId: "c1", name: "read", input: { path: "a.ts" } }],
          },
          { role: "tool", callId: "c1", name: "read", content: "file body", isError: false },
          { role: "user", content: [{ type: "text", text: "改成蓝色" }] },
        ],
        tools: [{ name: "read", description: "读文件", inputSchema: { type: "object" } }],
      }),
      new AbortController().signal,
    )
    [Symbol.asyncIterator]()
    .next();
  expect(capture.body?.messages).toEqual([
    { role: "system", content: "sys" },
    { role: "user", content: "做个页面" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "c1", type: "function", function: { name: "read", arguments: '{"path":"a.ts"}' } },
      ],
    },
    { role: "tool", tool_call_id: "c1", content: "file body" },
    { role: "user", content: "改成蓝色" },
  ]);
});

describe("openai-compatible 适配器：流内 error 事件归类（ADR-0055 修订 2026-11-01）", () => {
  const deltaChunks = [
    {
      id: "c1",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: { role: "assistant", content: "先输出第一段，" } }],
    },
    {
      id: "c1",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: { content: "再输出第二段" } }],
    },
  ];

  async function drainWithFailure(p: ReturnType<typeof createOpenAICompatibleProvider>) {
    const received: ModelStreamEvent[] = [];
    let thrown: unknown;
    try {
      for await (const ev of p.stream(request(), new AbortController().signal)) {
        if (ev.type !== "heartbeat") received.push(ev);
      }
    } catch (e) {
      thrown = e;
    }
    return { received, thrown };
  }

  it("流中已出文本增量后收到无状态码 error 事件 → ProviderError(kind=server, retryable=true)", async () => {
    const p = createOpenAICompatibleProvider(
      config(),
      envWithKey,
      sseFetch([
        ...deltaChunks,
        {
          error: {
            message: "Antigravity: connection lost mid-reply (http2: client connection lost)",
          },
        },
      ]),
    );
    const { received, thrown } = await drainWithFailure(p);
    expect(received).toEqual([
      { type: "text_delta", text: "先输出第一段，" },
      { type: "text_delta", text: "再输出第二段" },
    ]);
    expect(thrown).toBeInstanceOf(ProviderError);
    expect(thrown).toMatchObject({
      kind: "server",
      retryable: true,
      message: "Antigravity: connection lost mid-reply (http2: client connection lost)",
    });
  });

  it.each([
    ["context deadline exceeded", "server"],
    ["context canceled", "server"],
    ["unexpected token < in JSON at position 0", "server"],
    ["token refresh failed", "server"],
    ["content-length mismatch", "server"],
    ["Rate limit exceeded: tokens per minute", "server"],
    ["http2: client connection lost", "server"],
    ["This model's maximum context length is 200000 tokens", "context_overflow"],
    ["context_length_exceeded", "context_overflow"],
    ["prompt is too long: 213000 tokens", "context_overflow"],
    ["The input token count exceeds the maximum number of tokens allowed", "context_overflow"],
    ["Output blocked by content filter", "content_filter"],
    ["response stopped by safety settings", "content_filter"],
  ] as const)("流内错误归类：%s → %s", (message, kind) => {
    expect(classifyStreamErrorKind(message)).toBe(kind);
  });

  it("流中无状态码 error 消息含上下文超限 → context_overflow（不可重试）；内容过滤 → content_filter", async () => {
    const overflowProvider = createOpenAICompatibleProvider(
      config(),
      envWithKey,
      sseFetch([
        ...deltaChunks,
        { error: { message: "maximum context length exceeded: 200000 tokens" } },
      ]),
    );
    const overflow = await drainWithFailure(overflowProvider);
    expect(overflow.received).toHaveLength(2);
    expect(overflow.thrown).toBeInstanceOf(ProviderError);
    expect(overflow.thrown).toMatchObject({
      kind: "context_overflow",
      retryable: false,
    });

    const filterProvider = createOpenAICompatibleProvider(
      config(),
      envWithKey,
      sseFetch([...deltaChunks, { error: { message: "Output blocked by content filter" } }]),
    );
    const filtered = await drainWithFailure(filterProvider);
    expect(filtered.thrown).toBeInstanceOf(ProviderError);
    expect(filtered.thrown).toMatchObject({
      kind: "content_filter",
      retryable: false,
    });

    // 请求阶段（toProviderError 直接调用）无状态码且非网络错误时仍保持 unknown
    const reqErr = toProviderError(new Error("some pre-request bug"), undefined);
    expect(reqErr).toBeInstanceOf(ProviderError);
    expect(reqErr).toMatchObject({
      kind: "unknown",
      retryable: false,
    });
  });
});
