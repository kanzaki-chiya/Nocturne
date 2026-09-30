/**
 * Provider 请求头的公共规则（ADR-0031 §2、§3）：
 * - 所有请求（三种协议的 stream 与 fetchModels）的 User-Agent 以
 *   `nocturne/<version>` 开头；AI SDK 在其后追加的 `ai-sdk/...` 后缀保留。
 * - 请求携带 sessionId 且条目声明 sessionHeader 时写 `<sessionHeader>:
 *   <sessionId>`；两者缺一不写；fetchModels 不属于会话，不发送。
 * - 条目 headers 里的同名头（大小写不敏感）优先于这两条规则。
 */
import { NOCTURNE_VERSION } from "../version.js";

/** 默认 User-Agent 基值：`nocturne/<version>`（版本同 Runtime 上报） */
export function nocturneUserAgent(version: string = NOCTURNE_VERSION): string {
  return `nocturne/${version}`;
}

/** 静态 headers 中是否已声明同名头（大小写不敏感） */
export function hasStaticHeader(
  headers: Record<string, string> | undefined,
  name: string,
): boolean {
  if (headers === undefined) return false;
  const wanted = name.toLowerCase();
  return Object.keys(headers).some((k) => k.toLowerCase() === wanted);
}

/**
 * 合并 User-Agent 进请求头集：条目 headers 里已写 UA（不区分大小写）时
 * 以用户的写法为准，否则前置 `nocturne/<version>`。
 */
export function withUserAgent(
  headers: Record<string, string> | undefined,
  userAgent: string = nocturneUserAgent(),
): Record<string, string> {
  if (hasStaticHeader(headers, "user-agent")) return { ...headers };
  return { "User-Agent": userAgent, ...(headers ?? {}) };
}

/**
 * 本会话请求的会话标识头（ADR-0031 §3）：sessionId 与条目 sessionHeader
 * 同时存在且静态 headers 未声明同名头时返回 `{ <sessionHeader>: sessionId }`，
 * 否则返回 undefined（发送方不附带任何会话头）。
 */
export function sessionRequestHeaders(
  entry: {
    sessionHeader?: string | undefined;
    headers?: Record<string, string> | undefined;
  },
  sessionId: string | undefined,
): Record<string, string> | undefined {
  const name = entry.sessionHeader;
  if (name === undefined || name === "" || sessionId === undefined) return undefined;
  if (hasStaticHeader(entry.headers, name)) return undefined;
  return { [name]: sessionId };
}
