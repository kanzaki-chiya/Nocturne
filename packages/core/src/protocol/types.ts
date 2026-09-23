/**
 * 公共数据类型（docs/protocols/events.md 第 4 节）。
 * 只包含类型，不包含任何行为或 I/O。
 */

/** 模型引用：Provider 名 + Provider 内模型 id */
export interface ModelRef {
  provider: string;
  model: string;
}

export type ContentBlock =
  | { type: "text"; text: string }
  | {
      type: "reasoning";
      text: string;
      /** providerData 只能回传给该 Provider（context.md 第 7 节） */
      provider?: string | undefined;
      providerData?: unknown;
    };

/** 一次工具调用的引用。callId 由 Runtime 分配、会话内唯一 */
export interface ToolCallRef {
  callId: string;
  /** Provider 返回的原始 ID，仅用于回传该 Provider，业务逻辑不得依赖 */
  providerCallId?: string | undefined;
  name: string;
  /** 参数解析失败时为空 */
  input?: unknown;
  /** 参数解析失败时的原文 */
  rawInput?: string | undefined;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number | undefined;
  cacheWriteTokens?: number | undefined;
  reasoningTokens?: number | undefined;
}

export type SubjectKind = "read" | "edit" | "shell" | "network" | "mcp";

/** 工具声明的、未解析的权限主体（tool-api.md 第 1 节；permissionSubjects 纯函数产出） */
export interface SubjectRequest {
  kind: SubjectKind;
  /** 词法规范化后的目标（绝对路径、命令字符串、URL） */
  target: string;
}

export type SubjectWhere = "workspace" | "outside";

/** 解析后的权限主体（permissions.md 第 2 节） */
export interface PermissionSubject {
  kind: SubjectKind;
  /** 工具给出的目标（规范化后的路径、命令、URL） */
  target: string;
  /** 路径类主体：解析符号链接 / junction 后的真实路径 */
  resolved?: string | undefined;
  where?: SubjectWhere | undefined;
}

export type PermissionAction = "allow" | "ask" | "deny";

export type PermissionSource = "user" | "rule" | "grant" | "non_interactive" | "cancelled";

/** permission.requested 中提供给客户端的选项（permissions.md 第 7 节） */
export type PermissionOption =
  "allow_once" | "allow_session" | "allow_project" | "deny" | "deny_stop";

/** Provider 流式响应的结束原因（provider-api.md 第 4 节） */
export type FinishReason = "stop" | "tool_calls" | "length" | "content_filter" | "other";

/**
 * 工具输入的 JSON Schema（tool-api.md：inputSchema）。
 * 该 Schema 同时发给模型并用于运行时校验（AJV）。
 */
export type JsonSchema = Record<string, unknown>;

/** 模型可见的工具规格（tool-api.md 第 4 节）：由 tools 产出，经 ModelRequest 交给 Provider */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}
