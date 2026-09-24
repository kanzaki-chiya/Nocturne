/**
 * Provider 接口与中性请求/事件类型（docs/protocols/provider-api.md）。
 * 适配器外不得出现第三方 SDK 类型（ADR-0005）。
 */
import type {
  ContentBlock,
  FinishReason,
  ModelRef,
  ToolCallRef,
  ToolSpec,
  Usage,
} from "../protocol/index.js";

// ── 模型与能力（provider-api.md 第 2 节） ──────────────────

export interface ModelCapabilities {
  toolCalls: boolean;
  parallelToolCalls: boolean;
  /** 不支持 / 有推理但不返回内容 / 返回推理内容 */
  reasoning: "none" | "hidden" | "visible";
  /** 支持的推理强度档位，如 ["low","medium","high"] */
  reasoningEffort?: string[] | undefined;
  imageInput: boolean;
  promptCache: boolean;
}

export interface ModelInfo {
  ref: ModelRef;
  displayName?: string | undefined;
  /** 输入 + 输出共享的窗口大小 */
  contextWindow: number;
  maxOutputTokens: number;
  capabilities: ModelCapabilities;
}

// ── 请求（provider-api.md 第 3 节） ────────────────────────

export interface SystemBlock {
  text: string;
}

export type ModelMessage =
  | { role: "user"; content: ContentBlock[] }
  | {
      role: "assistant";
      content: ContentBlock[];
      toolCalls: ToolCallRef[];
    }
  | {
      role: "tool";
      callId: string;
      name: string;
      content: string;
      isError: boolean;
    };

/** 纯数据请求：不含重试预算、回调等运行时对象 */
export interface ModelRequest {
  /** Provider 内的模型 id */
  model: string;
  system: SystemBlock[];
  messages: ModelMessage[];
  tools: ToolSpec[];
  maxOutputTokens: number;
  /** 仅在模型声明支持该档位时设置 */
  reasoningEffort?: string | undefined;
  /** 可缓存前缀的边界提示，适配器自行决定是否使用 */
  cachePrefix?: { systemBlocks: number; messages: number } | undefined;
  /** 来自配置，原样交给适配器，Core 不解释 */
  providerOptions?: Record<string, unknown> | undefined;
  /**
   * 强制工具选择（provider-api.md 第 3 节）：适配器尽力映射为具体的
   * tool_choice；已知无法表达的组合（如 Anthropic 扩展思考开启时只接受
   * auto/none）丢弃之并记 diagnostics.provider.unsupported_capability，
   * 不得发出明知无效的请求。
   */
  toolChoice?: { name: string } | undefined;
}

// ── 流式事件（provider-api.md 第 4 节） ────────────────────

export type ModelStreamEvent =
  | { type: "text_delta"; text: string }
  | {
      type: "reasoning_delta";
      text: string;
      /**
       * 随推理 delta 附带的 Provider 专有数据（如 Anthropic 签名 delta）。
       * 语义同 reasoning_block.providerData：由 consumeStream 落到当前推理块。
       */
      providerData?: unknown;
    }
  | {
      type: "reasoning_block";
      text: string;
      /** 含签名等专有数据时必须提供，只能回传给同一 Provider */
      providerData?: unknown;
    }
  | { type: "tool_call_delta"; toolCallId: string; name: string; argsDelta: string }
  | {
      type: "tool_call";
      toolCallId: string;
      name: string;
      input?: unknown;
      rawInput?: string | undefined;
    }
  | { type: "usage"; usage: Usage }
  | { type: "finish"; reason: FinishReason; rawReason?: string | undefined };

// ── Provider 与注册表（provider-api.md 第 1 节） ───────────

export interface Provider {
  /** 配置中的名称，如 "deepseek" */
  readonly id: string;
  /** 适配器类型，如 "openai-compatible" */
  readonly type: string;
  /**
   * 严格模型清单（默认 true）：models() 非空时，清单外的模型视为
   * invalid_model。false 时任何模型 id 经 resolve 回退内置目录/保守默认——
   * 供"只有一个 Provider、模型由用户即时指定"的客户端（如 CLI）使用。
   */
  readonly strictModels?: boolean | undefined;
  /** 该 Provider 下可用的模型（内置目录 + 配置合并） */
  models(): ModelInfo[];
  /**
   * 发起一次流式请求。成功的流以且仅以一个 finish 结束；
   * 失败抛出 ProviderError；signal 中止时抛出 name === "AbortError" 的错误。
   */
  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent>;
}

export interface ResolvedModel {
  provider: Provider;
  model: ModelInfo;
}

export interface ProviderRegistry {
  resolve(ref: ModelRef): ResolvedModel;
  providers(): Provider[];
}
