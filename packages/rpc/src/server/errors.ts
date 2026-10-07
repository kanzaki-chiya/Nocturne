import {
  ProviderLoginError,
  ProviderSetupError,
  McpSettingsError,
  ExternalAgentSettingsError,
  RuntimeCommandError,
  SessionError,
  SkillImportError,
} from "@nocturne/core";

import { RPC_ERROR, type RpcErrorObject } from "../shared/jsonrpc.js";
import { InvalidParamsError } from "./params.js";

/** RPC 层自身的状态错误（未握手、版本不符、会话已打开、服务端关闭中……） */
export class RpcProtocolError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "RpcProtocolError";
    this.code = code;
  }
}

/** 请求的方法不存在 */
export class MethodNotFoundError extends Error {
  constructor(method: string) {
    super(`未知方法：${method}`);
    this.name = "MethodNotFoundError";
  }
}

/**
 * Core 抛出的错误 → JSON-RPC error（ADR-0044 第 4 节）：
 * `code` 取固定区间值，`data.code` 带原来的字符串错误码，`message` 是原文案。
 */
export function toRpcError(error: unknown): RpcErrorObject {
  if (error instanceof InvalidParamsError) {
    return {
      code: RPC_ERROR.invalidParams,
      message: error.message,
      data: { code: "invalid_params", name: error.name },
    };
  }
  if (error instanceof MethodNotFoundError) {
    return {
      code: RPC_ERROR.methodNotFound,
      message: error.message,
      data: { code: "method_not_found", name: error.name },
    };
  }
  if (error instanceof RpcProtocolError) {
    return {
      code: RPC_ERROR.protocolError,
      message: error.message,
      data: { code: error.code, name: error.name },
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : undefined;
  const stringCode =
    typeof error === "object" &&
    error !== null &&
    typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : undefined;
  const data = {
    ...(stringCode !== undefined ? { code: stringCode } : {}),
    ...(name !== undefined ? { name } : {}),
  };
  if (error instanceof RuntimeCommandError) {
    return { code: RPC_ERROR.commandRejected, message, data };
  }
  if (error instanceof SessionError) return { code: RPC_ERROR.sessionError, message, data };
  if (error instanceof ProviderLoginError) return { code: RPC_ERROR.loginError, message, data };
  if (
    error instanceof ProviderSetupError ||
    error instanceof McpSettingsError ||
    error instanceof ExternalAgentSettingsError ||
    error instanceof SkillImportError
  ) {
    // 字段名让客户端把错误标到对应输入框（ADR-0044 第 6 节）
    return {
      code: RPC_ERROR.providerSetupError,
      message,
      data: { code: "invalid_field", name: error.name, field: error.field },
    };
  }
  return { code: RPC_ERROR.serverError, message, data };
}
