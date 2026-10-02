/**
 * ProviderError（provider-api.md 第 5 节）。
 * Agent Loop 只依据 kind 与 retryable 决策，不解析 providerMessage。
 */
export type ProviderErrorKind =
  | "auth"
  | "rate_limit"
  | "overloaded"
  | "context_overflow"
  | "invalid_request"
  | "content_filter"
  | "network"
  | "timeout"
  | "server"
  | "unknown";

const RETRYABLE_KINDS: ReadonlySet<ProviderErrorKind> = new Set([
  "rate_limit",
  "overloaded",
  "network",
  "timeout",
  "server",
]);

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;
  readonly status: number | undefined;
  /** 原始错误信息（已去除凭据），用于日志与界面 */
  readonly providerMessage: string | undefined;

  constructor(args: {
    kind: ProviderErrorKind;
    message: string;
    retryable?: boolean | undefined;
    retryAfterMs?: number | undefined;
    status?: number | undefined;
    providerMessage?: string | undefined;
    cause?: unknown;
  }) {
    super(args.message, { cause: args.cause });
    this.name = "ProviderError";
    this.kind = args.kind;
    this.retryable = args.retryable ?? RETRYABLE_KINDS.has(args.kind);
    this.retryAfterMs = args.retryAfterMs;
    this.status = args.status;
    this.providerMessage = args.providerMessage;
  }
}

/** 构造 ProviderError 的便捷断言 */
export function isProviderError(e: unknown): e is ProviderError {
  return e instanceof ProviderError;
}

/** 安全的鉴权错误：不携带上游响应或凭据。 */
export class ProviderAuthError extends ProviderError {
  constructor(message: string, status?: number) {
    super({ kind: "auth", message, retryable: false, status });
    this.name = "ProviderAuthError";
  }
}

function safeExplanation(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length === 0 || text.length > 300) return undefined;
  if (/bearer|token|secret|password|authorization|sk-|eyJ/i.test(text)) return undefined;
  return text;
}

/** 受约束 Responses 通道的错误，不保留上游正文或 SDK 的请求信息。 */
export function constrainedResponseError(status: number | undefined, body: unknown): ProviderError {
  const record = (value: unknown): Record<string, unknown> =>
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const root = record(body);
  const detail = root.detail;
  const code = record(root.error).code ?? record(detail).code ?? detail ?? root.code;
  const mappings: Record<
    string,
    { status: number; kind: ProviderErrorKind; message: string; retryable: boolean }
  > = {
    subscription_sharing_usage_limit_exceeded: {
      status: 429,
      kind: "rate_limit",
      message: "ChatGPT 套餐额度已用完，稍后再试或换模型",
      retryable: false,
    },
    subscription_sharing_user_not_eligible: {
      status: 403,
      kind: "auth",
      message: "该 ChatGPT 账号的套餐不支持第三方应用调用",
      retryable: false,
    },
    subscription_sharing_unsupported_capability: {
      status: 400,
      kind: "invalid_request",
      message: "该功能不支持经 ChatGPT 账号调用，请调整模型或请求参数",
      retryable: false,
    },
    subscription_sharing_usage_unavailable: {
      status: 503,
      kind: "server",
      message: "ChatGPT 额度服务暂不可用",
      retryable: true,
    },
  };
  const mapping =
    typeof code === "string" && Object.hasOwn(mappings, code) ? mappings[code] : undefined;
  const explanation =
    code === "subscription_sharing_unsupported_capability"
      ? (safeExplanation(record(root.error).message) ?? safeExplanation(record(detail).message))
      : undefined;
  if (mapping !== undefined && (status === undefined || status === mapping.status)) {
    return new ProviderError(
      explanation === undefined
        ? mapping
        : { ...mapping, message: `${mapping.message}（${explanation}）` },
    );
  }
  const kind: ProviderErrorKind =
    status === 401 || status === 403
      ? "auth"
      : status === 429
        ? "rate_limit"
        : status === 408
          ? "timeout"
          : status !== undefined && status >= 500
            ? "server"
            : status !== undefined && status >= 400
              ? "invalid_request"
              : "network";
  // 未映射的 4xx 附上游说明（经脱敏过滤），否则无从判断是哪个参数被拒
  const upstream =
    status !== undefined && status >= 400 && status < 500
      ? (safeExplanation(record(root.error).message) ??
        safeExplanation(record(detail).message) ??
        safeExplanation(typeof detail === "string" ? detail : undefined))
      : undefined;
  const param = safeExplanation(record(root.error).param);
  return new ProviderError({
    kind,
    status,
    message:
      upstream === undefined
        ? "服务商请求失败，请稍后重试或调整请求"
        : `服务商拒绝请求（${upstream}${param === undefined ? "" : `；参数 ${param}`}）`,
  });
}

/** 中止错误：signal 中止时抛出 name === "AbortError" 的错误（provider-api.md 第 4 节） */
export function abortError(): Error {
  const e = new Error("The operation was aborted");
  e.name = "AbortError";
  return e;
}
