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

export type SubjectKind = "read" | "edit" | "shell" | "network" | "mcp" | "subagent";

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

/**
 * 判定来源（permissions.md 5.5、hooks.md）：`hook` 表示 PreToolUse /
 * PermissionRequest Hook 的判定进入了最终决定（收紧，或经信任的 Hook 放行 ask）。
 */
export type PermissionSource = "user" | "rule" | "grant" | "hook" | "non_interactive" | "cancelled";

/** 权限预设名（permissions.md 第 6 节） */
export type PermissionPresetName = "read-only" | "default" | "auto-edit" | "full-access";

/**
 * 一条权限规则（permissions.md 第 2、5 节）。
 * `kind` 缺省或 "*" 匹配全部类别；`label` 是给人看的短说明，
 * 命中时进入规则解释文本与 permission.resolved.rule。
 */
export interface PermissionRule {
  kind?: SubjectKind | "*" | undefined;
  /**
   * 匹配模式：路径类为 glob（相对模式拼接到 workspaceRoot 之下），
   * shell / network / mcp 为字符串通配符（permissions.md 5.1）
   */
  pattern: string;
  action: PermissionAction;
  /** 只匹配该范围的主体；缺省匹配全部范围 */
  where?: SubjectWhere | undefined;
  /** 人读短说明（如"受保护路径""修改 Nocturne 授权配置"） */
  label?: string | undefined;
}

/**
 * 用户对具体请求授予的授权（permissions.md 5.4）：只精确匹配。
 * 会话级 Grant 存会话内存；项目级 Grant 落盘到用户数据目录（config.md 第 4 节）。
 */
export interface Grant {
  kind: SubjectKind;
  /** 授权键：路径类为解析后的真实路径（canonical），shell 为完整命令字符串 */
  target: string;
  /** ISO 8601 */
  createdAt: string;
}

/** 命中规则的来源层（permissions.md 5.3 的 matchedRule.origin） */
export type RuleOrigin =
  "preset" | "user" | "project" | "project-untrusted" | "cli" | "grant" | "default";

/**
 * 命中规则的可解释信息（permissions.md 5.3）：
 * `rule` 为规则本体（Grant / 兜底 ask 没有本体时缺省），
 * `description` 是人读说明（"预设 default 第 3 条""用户配置第 1 条"……）。
 */
export interface RuleHit {
  origin: RuleOrigin;
  /** 该来源内的序号（1 起）；preset / grant / default 缺省 */
  index?: number | undefined;
  rule?: PermissionRule | undefined;
  description: string;
}

/** 带来源标注的权限规则：config 合并产物，permission 求值输入 */
export interface AnnotatedRule {
  rule: PermissionRule;
  origin: RuleOrigin;
}

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

/** tool.completed.status（events.md 第 3.1 节） */
export type ToolCallStatus =
  | "ok"
  | "error"
  | "denied"
  | "cancelled"
  /** 仅恢复修复产生 */
  | "interrupted";

/**
 * 会话历史条目：持久化事件折叠出的投影（sessions.md），
 * session 与 context 共用同一份定义，避免两份漂移。
 */
export type HistoryEntry =
  | {
      kind: "user";
      seq: number;
      turnId: string;
      messageId: string;
      content: ContentBlock[];
    }
  | {
      kind: "assistant";
      seq: number;
      turnId: string;
      messageId: string;
      model: ModelRef;
      content: ContentBlock[];
      toolCalls: ToolCallRef[];
      usage: Usage | undefined;
      finishReason: FinishReason | "aborted";
    }
  | {
      kind: "tool";
      seq: number;
      turnId: string;
      callId: string;
      name: string;
      status: ToolCallStatus;
      modelContent: string;
      /**
       * 参数摘要（来自 tool.started.input 的折叠，events.md 第 8 节兼容字段）；
       * L1 修剪后用作占位说明的一部分（context.md 6.5）
       */
      inputSummary?: string | undefined;
    }
  | {
      kind: "compaction";
      seq: number;
      turnId: string | undefined;
      compactKind: "prune" | "summary";
      throughSeq: number;
      summary: string | undefined;
    };

// ── Hooks（hooks.md）─────────────────────────────────────

/** Hook 事件点（hooks.md 第 1 节） */
export type HookPoint =
  | "PreToolUse"
  | "PostToolUse"
  | "PermissionRequest"
  | "TurnStart"
  | "TurnEnd"
  | "SessionStart"
  | "SessionEnd";

/**
 * 一条 Hook 配置（hooks.md 第 2 节）：外部命令，stdin 传 JSON、stdout 返回 JSON。
 * `matcher` 只用于 PreToolUse / PostToolUse / PermissionRequest，
 * 为工具名的字符串通配符（与权限规则同一套匹配），缺省或 "*" 匹配全部。
 */
export interface HookEntry {
  matcher?: string | undefined;
  command: string;
  args?: string[] | undefined;
  /** 毫秒；缺省 5000，硬上限 60000 */
  timeoutMs?: number | undefined;
}

// ── MCP（mcp.md 第 2 节）─────────────────────────────────

/**
 * 一个 MCP stdio 服务器配置（mcp.md 第 2 节）。
 * env 值支持 `${NAME}` 展开；未配置 env 时子进程只拿到平台白名单基线
 * 环境（不含 Provider API Key 等敏感变量）。
 */
export interface McpServerEntry {
  command: string;
  args?: string[] | undefined;
  env?: Record<string, string> | undefined;
  /** 相对路径按该层配置文件所在目录解析（config.md） */
  cwd?: string | undefined;
  /** 缺省 true */
  enabled?: boolean | undefined;
  /** 启动 + initialize + tools/list 超时；缺省 15000，上限 60000 */
  startupTimeoutMs?: number | undefined;
  /** 单次 tools/call 超时；缺省 120000，上限 600000 */
  callTimeoutMs?: number | undefined;
}

// ── 诊断（observability.md）─────────────────────────────

/**
 * 诊断通道（observability.md 第 3 节）：各模块写入 JSONL 记录；
 * 未启用时注入 no-op。写入方负责脱敏（密钥、Authorization、env 值不落盘）。
 */
export interface Diagnostics {
  record(kind: string, data?: Record<string, unknown>): void;
}
