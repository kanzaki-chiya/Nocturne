/**
 * JSON-RPC 2.0 报文形状、错误码与按行编解码（ADR-0044 第 1 节、docs/protocols/rpc.md）。
 * 客户端与服务端共用；纯函数，不依赖 Node 内置模块。
 */

/** 第一版协议版本：整数，握手时必须与服务端完全一致 */
export const RPC_PROTOCOL_VERSION = 1;

export type RpcId = string | number;

export interface RpcRequest {
  jsonrpc: "2.0";
  id: RpcId;
  method: string;
  params?: unknown;
}

export interface RpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface RpcSuccess {
  jsonrpc: "2.0";
  id: RpcId;
  result: unknown;
}

/** 数据里的字符串错误码与错误类名：与进程内 `error.code` / `error.name` 等价 */
export interface RpcErrorData {
  code?: string;
  name?: string;
}

export interface RpcErrorObject {
  code: number;
  message: string;
  data?: RpcErrorData;
}

export interface RpcFailure {
  jsonrpc: "2.0";
  /** 请求无法解析（解析错误、无效请求）时为 null */
  id: RpcId | null;
  error: RpcErrorObject;
}

export type RpcMessage = RpcRequest | RpcNotification | RpcSuccess | RpcFailure;

/** JSON-RPC 保留码与实现定义区间（-32000..-32099）内的固定值 */
export const RPC_ERROR = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  /** 其他未归类的 Core 错误 */
  serverError: -32000,
  /** RuntimeCommandError（events.md 第 7 节拒绝原因码在 data.code） */
  commandRejected: -32001,
  /** SessionError */
  sessionError: -32002,
  /** ProviderLoginError */
  loginError: -32003,
  /** RPC 层自身的状态错误：未握手、版本不符、会话已打开、服务端关闭中 */
  protocolError: -32004,
} as const;

/** 标准码对应的字符串错误码（响应没带 data.code 时客户端用它） */
export const RPC_CODE_NAMES: Readonly<Record<number, string>> = {
  [RPC_ERROR.parseError]: "parse_error",
  [RPC_ERROR.invalidRequest]: "invalid_request",
  [RPC_ERROR.methodNotFound]: "method_not_found",
  [RPC_ERROR.invalidParams]: "invalid_params",
  [RPC_ERROR.internalError]: "internal_error",
  [RPC_ERROR.serverError]: "server_error",
  [RPC_ERROR.commandRejected]: "command_rejected",
  [RPC_ERROR.sessionError]: "session_error",
  [RPC_ERROR.loginError]: "login_error",
  [RPC_ERROR.protocolError]: "protocol_error",
};

/** 一条报文编码成一行（JSON.stringify 不产生裸换行） */
export function encodeMessage(message: RpcMessage): string {
  return JSON.stringify(message);
}

export type ParsedLine =
  { kind: "message"; message: Record<string, unknown> } | { kind: "error"; failure: RpcFailure };

function failure(id: RpcId | null, code: number, message: string): RpcFailure {
  const name = RPC_CODE_NAMES[code];
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(name !== undefined ? { data: { code: name } } : {}) },
  };
}

/** 把一行解析成对象；解析失败或不是单个对象时给出可直接回复的错误 */
export function parseLine(line: string): ParsedLine {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { kind: "error", failure: failure(null, RPC_ERROR.parseError, "报文不是合法 JSON") };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {
      kind: "error",
      failure: failure(null, RPC_ERROR.invalidRequest, "报文必须是单个 JSON 对象（不支持批量）"),
    };
  }
  return { kind: "message", message: value as Record<string, unknown> };
}

/** 报文里的 id 合法性：字符串或整数 */
export function isRpcId(value: unknown): value is RpcId {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

export function invalidRequestFailure(id: RpcId | null, message: string): RpcFailure {
  return failure(id, RPC_ERROR.invalidRequest, message);
}
