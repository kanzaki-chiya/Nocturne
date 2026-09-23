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

/** 中止错误：signal 中止时抛出 name === "AbortError" 的错误（provider-api.md 第 4 节） */
export function abortError(): Error {
  const e = new Error("The operation was aborted");
  e.name = "AbortError";
  return e;
}
