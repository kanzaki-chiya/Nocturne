/**
 * Provider 接口与中性请求/事件类型（docs/protocols/provider-api.md）。
 * 适配器外不得出现第三方 SDK 类型（ADR-0005）。
 */
import type {
  ContentBlock,
  EditToolKind,
  FinishReason,
  ImageMimeType,
  ModelProtocol,
  ModelRef,
  ModelPricing,
  PricingSource,
  ReasoningEffortLevel,
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
  /**
   * 该模型的可用思考档位（ADR-0018）：resolve 后的已解析集合
   * （逐模型声明 > reasoning≠"none" 推导全档）。
   * undefined 或空数组 = 无可用档位；off 恒可用，不在此集合中。
   */
  reasoningEffort?: ReasoningEffortLevel[] | undefined;
  imageInput: boolean;
  promptCache: boolean;
  /**
   * 编辑工具选择（ADR-0035 §5）："edit"（默认）= 暴露 edit/write；
   * "apply_patch" = 只暴露 apply_patch。resolve 后恒有值。
   */
  editTool: EditToolKind;
}

export interface ModelInfo {
  ref: ModelRef;
  displayName?: string | undefined;
  /**
   * 输入 + 输出共享的窗口大小。undefined = 上游与配置都未声明
   * （ADR-0016）：本地预算按 128000 估算并发 model_capabilities_defaulted
   */
  contextWindow?: number | undefined;
  /**
   * undefined = 未声明：openai-compatible 请求不带 max_tokens；
   * anthropic 必填故按兜底值发送（ADR-0016）
   */
  maxOutputTokens?: number | undefined;
  /** 每百万 token 的 USD 价格（上游声明换算；provider-setup.md 第 7 节） */
  pricing?: ModelPricing | undefined;
  pricingSource?: PricingSource | undefined;
  capabilities: ModelCapabilities;
  /**
   * 生效协议（ADR-0026 §1）：该模型请求实际使用的服务协议；
   * 只由带协议的适配器/装配层填写（FakeProvider 等不填）。
   */
  protocol?: ModelProtocol | undefined;
  /**
   * 上游声明的服务接口（supported_endpoints 原文；ADR-0026 §2）：
   * 推导生效协议的原始事实，本身不代表可用协议。
   */
  endpoints?: string[] | undefined;
  /**
   * 不可用模型（ADR-0026 §5）：上游声明的接口无一可识别
   * （如只有 /responses）；该模型继续在清单中展示，但不可发请求。
   */
  unavailable?: { reason: string } | undefined;
}

// ── 请求（provider-api.md 第 3 节） ────────────────────────

export interface SystemBlock {
  text: string;
}

/**
 * 一张待发送的图片（ADR-0023）：data 为 base64 编码字节。
 * 由 Context Builder 按模型 imageInput 能力从附件引用投影产生；
 * 适配器负责映射为各自 API 的图片部件。
 */
export interface ModelImage {
  mimeType: ImageMimeType;
  /** base64 编码的图片字节 */
  data: string;
}

export type ModelMessage =
  | { role: "user"; content: ContentBlock[]; images?: ModelImage[] | undefined }
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
      images?: ModelImage[] | undefined;
    };

/** 纯数据请求：不含重试预算、回调等运行时对象 */
export interface ModelRequest {
  /** 本地诊断用途；适配器不向上游发送。 */
  purpose?: "vision" | "title" | undefined;
  /** Provider 内的模型 id */
  model: string;
  /**
   * 生效协议（ADR-0026 §4）：由 resolve 产出的 ModelInfo.protocol 随请求
   * 带给路由 Provider；缺省 = 未决议，路由按清单盖章/条目 type 回落。
   * 不透明数据——调用方不解释其取值。
   */
  protocol?: ModelProtocol | undefined;
  system: SystemBlock[];
  messages: ModelMessage[];
  tools: ToolSpec[];
  /** undefined = 模型未声明输出上限：适配器自行处理（ADR-0016） */
  maxOutputTokens?: number | undefined;
  /**
   * 本会话生效的思考档位（ADR-0018）：仅装档位值；"off" 用缺省表达
   * （字段不设置 = 请求不携带任何思考参数，disable-mode omit）。
   * Runtime 只在模型声明支持时赋值。
   */
  reasoningEffort?: ReasoningEffortLevel | undefined;
  /** 可缓存前缀的边界提示，适配器自行决定是否使用 */
  cachePrefix?: { systemBlocks: number; messages: number } | undefined;
  /** 来自配置，原样交给适配器，Core 不解释 */
  providerOptions?: Record<string, unknown> | undefined;
  /**
   * 会话标识（ADR-0031 §3）：Runtime 填入会话 ID（子代理填根会话 ID），
   * 不透明数据；条目声明 sessionHeader 时适配器把它写成请求头，
   * openai-responses 另作为 prompt_cache_key 发送；
   * fetchModels 不携带。
   */
  sessionId?: string | undefined;
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
  | { type: "finish"; reason: FinishReason; rawReason?: string | undefined }
  /**
   * 上游已开始响应的存活信号（ADR-0014 修订）：只给流式计时用，
   * timedStream 消费后不向下游转发，不算输出、不影响重试。
   */
  | { type: "heartbeat" };

/** 经 timedStream 过滤后交给 Agent Loop 的事件 */
export type ModelOutputEvent = Exclude<ModelStreamEvent, { type: "heartbeat" }>;

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

/**
 * 凭据解析器（provider-setup.md 第 3 节）：config 层 CredentialStore.get
 * 经装配处注入适配器——provider 不依赖 config，只认这个函数形状。
 * 返回 undefined = 凭据存储中无该服务商密钥。
 */
export type CredentialResolver = (providerId: string) => Promise<string | undefined>;

export type { ProviderAuth } from "../protocol/index.js";

/** 鉴权实现提供的 Responses 通道约束，适配器消费声明。 */
export interface ResponsesRequestConstraints {
  omitFields: readonly string[];
  systemAsInstructions: boolean;
  namespaceTools: boolean;
  requireCompleted: boolean;
  /** 通道要求的会话标识头名；条目未声明 sessionHeader 时使用（ADR-0031 §3 同一规则） */
  sessionHeader?: string | undefined;
  /**
   * 粘性路由头名：上游在响应头里返回该头时记下，同一会话的后续请求原样带回，
   * 让多步请求落到同一后端（缓存只在那里）。上游返回新值时替换。
   */
  stickyRoutingHeader?: string | undefined;
}

export interface AuthResolver {
  token(signal: AbortSignal): Promise<string>;
  invalidate(): Promise<void>;
  readonly unauthorizedMessage?: string | undefined;
  readonly modelFormat?: "siwc" | undefined;
  /** 鉴权通道限定的协议，优先于条目与逐模型声明。 */
  readonly protocol?: ModelProtocol | undefined;
  readonly requestConstraints?: ResponsesRequestConstraints | undefined;
  /**
   * 鉴权通道要求的固定请求头：每次请求覆盖条目里的同名头。
   * 写在通道里而不是只写进预设，条目保存后通道要求变了（如代理版本门）也能跟上。
   */
  readonly requestHeaders?: Readonly<Record<string, string>> | undefined;
}

/**
 * 上游模型列表条目（fetchModels 返回值；provider-setup.md 第 7 节）。
 * 只含上游明确声明的字段；未声明的字段保持 undefined，不猜。
 */
export interface UpstreamModelInfo {
  id: string;
  displayName?: string | undefined;
  contextWindow?: number | undefined;
  maxOutputTokens?: number | undefined;
  pricing?: ModelPricing | undefined;
  /** 仅含上游明确声明的能力位（reasoning / imageInput） */
  capabilities?:
    | { reasoning?: "none" | "hidden" | "visible" | undefined; imageInput?: boolean | undefined }
    | undefined;
  /**
   * 上游声明的服务接口（supported_endpoints 原文，ADR-0026 §2）：
   * 非空才携带；推导协议在运行时装配处完成，这里只保存事实。
   */
  endpoints?: string[] | undefined;
}

/**
 * Provider 条目上的思考兼容开关（ADR-0018 第 2、3 节；providers.md）。
 * 由预设自动填写 format，用户不需要选；levels 是"用户声明"来源的服务商级
 * 档位（/provider thinking 与向导勾选写入）。
 */
export interface ProviderThinkingOptions {
  /**
   * openai-compatible 的思考参数格式（anthropic 条目忽略）：
   * "openai" → Chat Completions 的 reasoning_effort（缺省）；
   * "openrouter" → reasoning: { effort }。
   */
  format?: "openai" | "openrouter" | undefined;
  /** 服务商级可用档位声明（写入时标 source:"user"）；校验后只含合法档位 */
  levels?: readonly string[] | undefined;
  /**
   * levels 的来源标注："user" = 用户在向导里勾选——/provider refresh
   * 不得覆盖它（refresh 只重写 models 字段，本字段天然不受影响）。
   */
  source?: "user" | undefined;
  /** anthropic 档位 → thinking.budget_tokens 覆盖表；未列档位查默认表 */
  budgets?: Record<string, number> | undefined;
}
