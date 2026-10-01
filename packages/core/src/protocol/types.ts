/**
 * 公共数据类型（docs/protocols/events.md 第 4 节）。
 * 只包含类型，不包含任何行为或 I/O。
 */

/** 模型引用：Provider 名 + Provider 内模型 id */
export interface ModelRef {
  provider: string;
  model: string;
}

// ── 服务协议（ADR-0026）───────────────────────────────────

/**
 * Nocturne 已接入的服务协议：openai-compatible（Chat Completions）、
 * anthropic（Messages）与 openai-responses（Responses；ADR-0031 §1）。
 * Provider 条目的 type 同时是默认协议。
 */
export type ModelProtocol = "openai-compatible" | "anthropic" | "openai-responses";

/**
 * 模型的生效协议（ADR-0026 §1）：三种可用协议之一；
 * "unavailable" = 上游声明的接口无一可识别，
 * 该模型继续出现在清单中但不可发请求。
 */
export type EffectiveProtocol = ModelProtocol | "unavailable";

/** 协议对应的接口路径（按末尾比较；ADR-0026 §3、ADR-0031 §1） */
export const PROTOCOL_ENDPOINTS: Record<ModelProtocol, string> = {
  "openai-compatible": "/chat/completions",
  anthropic: "/messages",
  "openai-responses": "/responses",
};

/** 接口路径归一化：小写、去尾斜杠、保证前导斜杠——按末尾比较 */
function normalizeEndpoint(endpoint: string): string {
  const norm = endpoint.trim().toLowerCase().replace(/\/+$/, "");
  return norm.startsWith("/") ? norm : `/${norm}`;
}

/**
 * 由上游 supported_endpoints 推导生效协议（ADR-0026 §2 + ADR-0031 §1）：
 * 1. 条目 type 对应的接口在列表中 → 条目 type；
 * 2. 含 /chat/completions → openai-compatible；
 * 3. 含 /messages → anthropic；
 * 4. 含 /responses → openai-responses；
 * 5. 否则（全部无法识别）→ "unavailable"。
 * 未声明/空列表 → undefined（按未声明处理，交给调用方继续回落）。
 * 比较按路径末尾（/v1/messages ≡ /messages）。
 */
export function deriveProtocolFromEndpoints(
  endpoints: readonly string[] | undefined,
  entryType: ModelProtocol,
): EffectiveProtocol | undefined {
  if (endpoints === undefined || endpoints.length === 0) return undefined;
  const norms = endpoints.map(normalizeEndpoint);
  const has = (path: string) => norms.some((n) => n.endsWith(path));
  if (has(PROTOCOL_ENDPOINTS[entryType])) return entryType;
  if (has(PROTOCOL_ENDPOINTS["openai-compatible"])) return "openai-compatible";
  if (has(PROTOCOL_ENDPOINTS.anthropic)) return "anthropic";
  if (has(PROTOCOL_ENDPOINTS["openai-responses"])) return "openai-responses";
  return "unavailable";
}

/**
 * 生效协议的最终解析（ADR-0026 §2 优先级）：
 * 显式声明（手写 models.<id>.protocol 或用户编辑）> endpoints 推导 > 条目 type。
 */
export function resolveEffectiveProtocol(
  declared: ModelProtocol | undefined,
  endpoints: readonly string[] | undefined,
  entryType: ModelProtocol,
): EffectiveProtocol {
  return declared ?? deriveProtocolFromEndpoints(endpoints, entryType) ?? entryType;
}

/**
 * 不可用说明（ADR-0026 §5）：模型列表标注、setModel 拒绝、Turn 报错与
 * 模型编辑页共用同一文本，并指向补救方式（编辑页/CLI 手动指定协议）。
 */
export function unavailableProtocolReason(endpoints: readonly string[]): string {
  // ADR-0031 §4：models.dev npm 映射的 "npm:<包名>" 标记——
  // 无法识别为已知接口时给出更具体的说明（包名原文列出）。
  const npmPkgs = endpoints.filter((e) => e.startsWith("npm:")).map((e) => e.slice(4));
  if (npmPkgs.length === endpoints.length && npmPkgs.length > 0) {
    return (
      `models.dev 标注该模型使用 ${npmPkgs.join("、")} 对应的接口，` +
      `Nocturne 暂不支持；如确认该模型可用 Chat Completions、Messages ` +
      `或 Responses，可在「编辑模型」或 /provider model 指定协议`
    );
  }
  const list = endpoints.length > 0 ? endpoints.join("、") : "未声明的可识别接口";
  return (
    `该模型没有可用的服务协议：上游只声明了 ${list} 接口，Nocturne 暂不支持；` +
    `如确认该模型可用 Chat Completions、Messages 或 Responses，` +
    `可在「编辑模型」或 /provider model 指定协议`
  );
}

/**
 * 思考强度的中性档位（ADR-0018；provider-api.md 第 2、3 节）。
 * `off` 恒可用（不发送任何思考参数），不在模型的"可用档位"声明集合中；
 * `max` 是通用最高档——openai/openrouter 格式原样发送 "max"，
 * 只有 anthropic 格式换算为 thinking.budget_tokens（默认 32768）。
 * 本轮不做 auto 档。
 */
export const REASONING_EFFORT_LEVELS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ReasoningEffortLevel = (typeof REASONING_EFFORT_LEVELS)[number];
export type ReasoningEffort = "off" | ReasoningEffortLevel;

/**
 * 模型暴露的编辑工具（ADR-0035 §5）：
 * "edit"（默认）= edit + write；"apply_patch" = 只有 apply_patch。
 * 筛选只依据该能力值与工具声明，Agent Loop 不出现工具名/模型名分支。
 */
export type EditToolKind = "edit" | "apply_patch";

/** 档位全局顺序（含 off，循环切换与就近降档用） */
export const REASONING_EFFORT_ORDER: readonly ReasoningEffort[] = [
  "off",
  ...REASONING_EFFORT_LEVELS,
];

const REASONING_EFFORT_LEVEL_SET: ReadonlySet<string> = new Set(REASONING_EFFORT_LEVELS);
const REASONING_EFFORT_SET: ReadonlySet<string> = new Set(REASONING_EFFORT_ORDER);

export function isReasoningEffortLevel(v: string): v is ReasoningEffortLevel {
  return REASONING_EFFORT_LEVEL_SET.has(v);
}

export function isReasoningEffort(v: string): v is ReasoningEffort {
  return REASONING_EFFORT_SET.has(v);
}

/** 声明集合归一化：丢弃非法值、去重、按全局档位顺序排序（ADR-0018 第 2 节） */
export function normalizeReasoningEffortLevels(
  levels: readonly string[] | undefined,
): ReasoningEffortLevel[] | undefined {
  if (levels === undefined) return undefined;
  const set = new Set(levels.filter(isReasoningEffortLevel));
  return REASONING_EFFORT_LEVELS.filter((l) => set.has(l));
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

// ── 图片附件（ADR-0023 第 2 节）─────────────────────────────

export type ImageMimeType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

/** 已附带的 @ 引用快照元数据（ADR-0033）。 */
export interface FileRef {
  path: string;
  kind: "file" | "directory" | "image";
  lines?: number | undefined;
  totalLines?: number | undefined;
  chars: number;
  truncated: boolean;
}

/**
 * 图片附件的引用：字节不落进事件与历史，统一存到
 * <attachmentsDir>/<sessionId>/ 下，事件里只有这份元数据。
 * `source` 标记来源：paste（用户粘贴/拖入）、read（内置工具读图）、
 * mcp（MCP 工具结果）。
 */
export interface ImageAttachment {
  type: "image";
  /** 相对 <attachmentsDir>/<sessionId>/ 的文件名，如 "img-3.png" */
  file: string;
  mimeType: ImageMimeType;
  bytes: number;
  /** 小写 hex */
  sha256: string;
  width?: number | undefined;
  height?: number | undefined;
  label?: string | undefined;
  source: "paste" | "read" | "mcp";
}

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

/**
 * 每 shell 种类的高风险命令元数据（ADR-0022 第 1 节：表集中在 platform 的
 * ShellDescriptor，经工具主体随命令透传到权限层）。
 * 纯数据——不含任何权限判定；匹配语义由权限层（permissions.md 5.3）执行。
 * 与 platform/shells.ts 的同名接口结构相同：platform 不能反向依赖 protocol，
 * 两侧各自声明，结构漂移由 tools 层的赋值在编译期暴露。
 */
export interface ShellRiskProfile {
  /** 命令词与模式匹配是否不区分大小写（pwsh / powershell / cmd 为 true） */
  caseInsensitive: boolean;
  /** 段级通配符高风险模式（各 shell 共用基础表，如 "rm -rf *"） */
  basePatterns: readonly string[];
  /** 命令词与开关共存才算高危（cmd：rd/del/erase/rmdir + /s 系开关） */
  switchVerbs?:
    | {
        verbs: readonly string[];
        /** 匹配开关 token 的正则源串（权限层以不区分大小写编译） */
        switchPattern: string;
      }
    | undefined;
  /** 命令词与两个参数共存才算高危（PowerShell：Remove-Item 系 + recurse/force，允许参数前缀缩写） */
  dualParamVerbs?:
    | {
        verbs: readonly string[];
        params: readonly [string, string];
      }
    | undefined;
  /** 恒高危命令词（cmd 的 format；PowerShell 的系统破坏类 cmdlet 与动态执行别名） */
  alwaysVerbs?: readonly string[] | undefined;
}

/** 工具声明的、未解析的权限主体（tool-api.md 第 1 节；permissionSubjects 纯函数产出） */
export interface SubjectRequest {
  kind: SubjectKind;
  /** 词法规范化后的目标（绝对路径、命令字符串、URL） */
  target: string;
  /** 仅供用户查看，不参与规则、Grant 或 Hook 判定（ADR-0033）。 */
  detail?: string | undefined;
  /**
   * shell 主体：执行命令的 shell 种类（ADR-0022 的 ShellKind）。
   * 权限层据此选择分词方言；缺省按 POSIX 保守处理。
   */
  shell?: string | undefined;
  /** shell 主体：生效描述符携带的高风险元数据；缺省时权限层按 POSIX 基础表保守处理 */
  shellRisk?: ShellRiskProfile | undefined;
  /**
   * shell 主体：各方言的高风险元数据（posix / cmd / powershell），供权限层检查
   * `pwsh -c "…"`、`cmd /c "…"`、`bash -c "…"` 这类嵌套调用的命令体
   */
  shellRiskByDialect?: Readonly<Record<string, ShellRiskProfile>> | undefined;
}

export type SubjectWhere = "workspace" | "outside";

/** 解析后的权限主体（permissions.md 第 2 节） */
export interface PermissionSubject {
  kind: SubjectKind;
  /** 工具给出的目标（规范化后的路径、命令、URL） */
  target: string;
  /** 仅供用户查看，不参与规则、Grant 或 Hook 判定（ADR-0033）。 */
  detail?: string | undefined;
  /** 路径类主体：解析符号链接 / junction 后的真实路径 */
  resolved?: string | undefined;
  where?: SubjectWhere | undefined;
  /** shell 主体：执行该命令的 shell 种类（ADR-0022） */
  shell?: string | undefined;
  /** shell 主体：生效描述符携带的高风险元数据（由 tools 层从 ShellDescriptor 透传） */
  shellRisk?: ShellRiskProfile | undefined;
  /** shell 主体：各方言的高风险元数据，用于嵌套 shell 调用的命令体（见 SubjectRequest） */
  shellRiskByDialect?: Readonly<Record<string, ShellRiskProfile>> | undefined;
}

export type PermissionAction = "allow" | "ask" | "deny";

/**
 * 判定来源（permissions.md 5.5、hooks.md）：`hook` 表示 PreToolUse /
 * PermissionRequest Hook 的判定进入了最终决定（收紧，或经信任的 Hook 放行 ask）。
 */
export type PermissionSource =
  "user" | "rule" | "grant" | "hook" | "reviewer" | "non_interactive" | "cancelled";

/** 权限预设名（permissions.md 第 6 节） */
export const PERMISSION_PRESET_NAMES = [
  "read-only",
  "default",
  "auto-edit",
  "guarded",
  "smart",
  "bypass",
] as const;
export type PermissionPresetName = (typeof PERMISSION_PRESET_NAMES)[number];

/** 旧配置与日志的别名只在输入边界归一化。 */
export function normalizePermissionPreset(name: string): string {
  return name === "full-access" ? "guarded" : name;
}

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
  /** 预设中的保护标记：只能由用户确认，显示名称不参与判定。 */
  userOnly?: boolean | undefined;
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
      /** 随用户消息附带的图片引用（ADR-0023）；旧日志无此字段 */
      attachments?: ImageAttachment[] | undefined;
      fileRefs?: FileRef[] | undefined;
    }
  | {
      kind: "assistant";
      seq: number;
      turnId: string;
      messageId: string;
      model: ModelRef;
      /**
       * 产生本条消息的生效协议（ADR-0026 §6）；旧日志无此字段——
       * 缺省时 providerData 回传只比较服务商。
       */
      protocol?: ModelProtocol | undefined;
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
      /** 工具结果附带的图片引用（ADR-0023）；旧日志无此字段 */
      attachments?: ImageAttachment[] | undefined;
    }
  | {
      kind: "compaction";
      seq: number;
      turnId: string | undefined;
      compactKind: "prune" | "summary";
      throughSeq: number;
      summary: string | undefined;
    }
  | {
      /**
       * 会话内环境变更说明（ADR-0022 第 4 节）：由 session.config_changed
       * 的 shell 字段折叠产生，Context Builder 在该位置以 user 消息注入，
       * 让模型知道切换发生在哪一步；恢复会话后旧说明原样保留。
       */
      kind: "note";
      seq: number;
      turnId: string | undefined;
      text: string;
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

// ── 向用户提问（ADR-0032 §1/§2）──────────────────────────

/**
 * ask_user 的一个候选选项（ADR-0032 §1）：label 去首尾空白后非空、
 * 至多 60 字符、同一问题内不可重复；description 至多 200 字符。
 * 客户端始终额外提供「其他」，选项里不得自行加入。
 */
export interface QuestionOption {
  label: string;
  description?: string | undefined;
}

/**
 * ask_user 的一个问题（ADR-0032 §1）：question.requested 临时事件、
 * 工具输入与待回答派生状态共用此形状。
 * options 省略或为空表示自由文本题；multiSelect 为真可多选。
 */
export interface QuestionItem {
  /** 去掉首尾空白后非空，至多 300 字符 */
  question: string;
  /** 短标签（至多 12 字符），界面显示为问题前的小标记 */
  header?: string | undefined;
  /** 2–6 个选项；省略或为空 = 自由文本题 */
  options?: QuestionOption[] | undefined;
  /** true 时同一题可选多个 label */
  multiSelect?: boolean | undefined;
}

/**
 * 一道题的回答（ADR-0032 §2/§3）：selected 是已提供选项的 label，
 * text 是「其他」/自由文本（去首尾空白、至多 2000 字符）；
 * selected 与 text 可同时存在，二者都为空表示该题没答；declined 只表示拒绝本题。
 */
export type QuestionAnswer =
  | { declined: true }
  | {
      /** 已提供选项中被选中的 label 集 */
      selected: string[];
      /** 「其他」自由文本；省略 = 没有文字补充 */
      text?: string | undefined;
    };
