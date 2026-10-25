/**
 * @nocturne/core 公开入口（modules.md 第 3 节"core/index（公开 API）"）。
 * 客户端看到的全部能力都经由这里；进程内与将来的 RPC 客户端共用同一份语义（ADR-0002）。
 */
import { z } from "zod";
import { McpSettingsError, validateMcpEntry } from "./config/mcp.js";
import type {
  McpProbeInput,
  McpProbeResult,
  McpSaveInput,
  McpServerOverview,
} from "./protocol/index.js";

import {
  createSubagentLauncher,
  createSubagentLimiter,
  DEFAULT_TURN_CONFIG,
  runTurn,
  runRoleCall,
  cleanTitle,
  type TurnConfig,
  type TurnDeps,
} from "./agent/index.js";
import {
  buildContext,
  attachmentsToLoad,
  runSummaryCall,
  type BuiltContext,
  type EnvironmentInfo,
  type InstructionFile,
  type InstructionSet,
} from "./context/index.js";
import type {
  ProviderEntryConfig,
  ProviderOverview,
  RuntimeConfig,
  SettingItem,
  SettingsPatch,
  ToggleImpact,
  JevEndpoint,
  JevReviewerConfig,
  ModelRole,
} from "./config/index.js";
import {
  ExternalAgentSettingsError,
  validateExternalAgentConfig,
  type ExternalAgentConfig,
  type ExternalAgentOverview,
  type ExternalAgentProbeInput,
  type ExternalAgentProbeResult,
  type ExternalAgentSaveInput,
  type ExternalAgentsDescription,
} from "./config/index.js";
import { MODEL_ROLES } from "./config/index.js";
import {
  type SkillImportInput,
  type SkillImportOutput,
  type SkillsDescription,
  type SkillInvocation,
  type SkillSnapshot,
} from "./protocol/index.js";
import {
  commitSkillImport,
  createSkillDiscoveryCache,
  previewSkillImport,
  renderSkill,
  skillCatalog,
} from "./skills/index.js";
import {
  defaultJevReviewer,
  fetchJevModels,
  JEV_ENDPOINTS,
  resolveJevConnection,
} from "./config/reviewer.js";
// ADR-0035 §5：编辑工具的模型默认表（config 层纯数据）注入 provider 解析
import { defaultEditToolForModel } from "./config/edit-tool.js";
import { createDiagnostics } from "./diagnostics/index.js";
import { createHookRunner } from "./hooks/index.js";
import { appendInputHistory, readInputHistory } from "./input-history.js";
import { createUsageStats } from "./usage/index.js";
import type { UsageStats } from "./protocol/index.js";
import type {
  ScheduleChangedPayload,
  ScheduleHistoryEntry,
  ScheduleListResult,
  ScheduleRunNowResult,
  ScheduleSaveInput,
  ScheduledTask,
  ScheduleTaskOverview,
} from "./protocol/schedule.js";
import {
  createScheduler,
  createScheduleStore,
  ScheduleError,
  type RunContext,
  type RunOutcome,
} from "./schedule/index.js";
import { createCheckpointRecorder } from "./session/checkpoints.js";
import { rewindTargets, restoreCheckpointFiles } from "./session/rewind.js";
import { createTurnChanges } from "./session/turn-changes.js";
import {
  type ReviewerSampleInfo,
  type ReviewerSampleResult,
  createAttendance,
  createRulePolicy,
  createModelSecurityReviewer,
  createJevSecurityReviewer,
  createReviewFacts,
  projectNotesFrom,
  readTrustedRemotes,
  REVIEWER_SAMPLES,
  runReviewerSamples,
  type GitRunner,
  type ReviewInputSources,
  type SecurityReviewer,
  UNATTENDED_DENY_HINT,
  isPermissionPresetName,
  type PermissionPolicy,
} from "./permission/index.js";
import {
  createPlatform,
  createShellResolver,
  detectShells,
  isShellKind,
  parseShellSpec,
  specFromConfigFields,
  type DetectedShell,
  type Platform,
  type ShellSpec,
} from "./platform/index.js";
import {
  clampReasoningEffort,
  CONTEXT_WINDOW_FALLBACK,
  createEntryProvider,
  externalAuthPath,
  applyDisabled,
  createProviderRegistry,
  MAX_OUTPUT_FALLBACK,
  nocturneUserAgent,
  UnknownModelError,
  type AuthResolver,
  type CredentialResolver,
  type DisabledModels,
  type ModelInfo,
  type ModelOverride,
  type Provider,
  type ProviderConfig,
  type ProviderRegistry,
  type ResolvedModel,
} from "./provider/index.js";
import { resolveProviderAuth } from "./provider-oauth.js";
import type {
  AgentDelegation,
  CommandRejectCode,
  CommandErrorDetail,
  ContentBlock,
  Diagnostics,
  Grant,
  HookEntry,
  HookPoint,
  DurableEvent,
  ImageMimeType,
  McpToolSearchMode,
  ModelRef,
  PermissionReply,
  PermissionSubject,
  QuestionReply,
  ReasoningEffort,
  ReasoningEffortLevel,
  RuntimeEvent,
  RewindTarget,
  RewindMode,
  SessionRewoundPayload,
  SessionSchedule,
  SubagentObservation,
  SubagentObserver,
  SubagentSummary,
  TurnEndReason,
  TurnChanges,
  TurnChangeDiff,
} from "./protocol/index.js";
import { IMAGE_MAX_BYTES, IMAGE_MAX_EDGE, parseImageSize, sniffImageMime } from "./tools/image.js";
import { DEFAULT_LOOP_GUARD, normalizePermissionPreset } from "./protocol/index.js";
import type { FileRefResolution, LocalFileContent } from "./protocol/file-refs.js";
import { resolveFileRefs } from "./tools/file-refs.js";
import { buildFileIndex, type FileIndexEntry } from "./tools/file-index.js";
import { isReasoningEffort, REASONING_EFFORT_ORDER } from "./protocol/index.js";
import { validateSettingsPatch } from "./config/settings.js";
import { resolveSubagentProfile } from "./config/subagent-profiles.js";
import {
  createSessionStore,
  createSubagentObservation,
  createSubagentRegistry,
  readLocalFile,
  readSessionAttachment,
  resolveFileRef,
  SessionError,
  type ReadAttachmentResult,
  type Session,
  type SessionRecovery,
  type SessionState,
  type SessionStore,
  type SessionSummary,
} from "./session/index.js";
import {
  builtinTools,
  createAttachmentStore,
  createMcpOnDemandTools,
  createPolicyGate,
  createQuestionBroker,
  createReadStateStore,
  createTaskTool,
  createSkillTool,
  createToolExecutor,
  createToolRegistry,
  MCP_CALL_TOOL_NAME,
  MCP_SEARCH_TOOL_NAME,
  resolveSubjects,
  shouldEnableMcpToolSearch,
  type ExternalAgentConnector,
  type ExternalAgentRequest,
  type SubagentLauncher,
  type ToolContext,
  type ExecutionEnvironment,
  type HookRunner,
  type McpConnector,
  type McpServerConfig,
  type McpServerStatus,
  type McpSession,
  type PermissionGate,
  type ScheduleAccess,
  type ToolRegistry,
} from "./tools/index.js";
import { NOCTURNE_VERSION } from "./protocol/version.js";

/** 命令被拒绝时抛出的错误；code 即 events.md 第 7 节的拒绝原因码 */
export class RuntimeCommandError extends Error {
  readonly code: CommandRejectCode;
  /**
   * 结构化补充（ADR-0054 §3）：如 invalid_model 携带
   * `{ disabled: "provider" | "model", model: { provider, model } }`，
   * 让客户端区分「已停用」与「已删除」。经 RPC 原样并入 error.data。
   */
  readonly detail?: CommandErrorDetail | undefined;
  constructor(code: CommandRejectCode, message: string, detail?: CommandErrorDetail) {
    super(message);
    this.name = "RuntimeCommandError";
    this.code = code;
    this.detail = detail;
  }
}

/**
 * RuntimeSession 上挂内部 Session 的属性键：不在公开类型里，客户端拿不到；
 * 只供各包测试经 Symbol.for 取用（直接发事件、读日志路径）。
 */
const INTERNAL_SESSION = Symbol.for("nocturne.core.internalSession");

/** 指令文件大小上限（context.md 6.2：每项注入内容都有上限） */
const INSTRUCTION_FILE_LIMIT = 64 * 1024;
const DEFAULT_PERMISSION_PRESET = "default";
const delegateSchema = z.object({
  agent: z.string().trim().min(1),
  task: z.string().trim().min(1),
});

export interface RuntimeOptions {
  /** 工作区 cwd（会话内工具执行的默认目录） */
  cwd: string;
  /** 工作区根；默认与 cwd 相同（取 realpath） */
  workspaceRoot?: string | undefined;
  /** 会话日志目录；默认 <NOCTURNE_HOME>/sessions */
  sessionsDir?: string | undefined;
  /** 直接注入的 Provider 实例（如 FakeProvider） */
  providers?: Provider[] | undefined;
  /** 声明式 Provider 配置（openai-compatible 与 anthropic） */
  providerConfigs?: ProviderConfig[] | undefined;
  /** 模型能力覆盖（providers.md 第 3 节配置形态） */
  modelOverrides?: Record<string, Record<string, ModelOverride>> | undefined;
  /**
   * 权限策略；默认 Phase 2 的 default 预设（permissions.md 第 6 节：
   * 工作区内读允许，其余 ask）
   */
  policy?: PermissionPolicy | undefined;
  /**
   * 是否有能回复权限请求的客户端（permissions.md 第 7 节）。
   * false/缺省：ask 一律结算为 deny（source: "non_interactive"）。
   */
  interactive?: boolean | undefined;
  /**
   * 是否在本进程里运行定时任务调度器（ADR-0064）；缺省 false，只有桌面端拉起的后台传 true。
   * false 时任务仍可增删改，只是不会自动触发。
   */
  scheduler?: boolean | undefined;
  /** 权限层选项（Phase 2 最小形态，不含可配置规则） */
  permissions?: RuntimePermissionsOptions | undefined;
  /** 指令集；默认自动收集 <NOCTURNE_HOME>/AGENTS.md 与项目各级 AGENTS.md */
  instructions?: InstructionSet | undefined;
  /**
   * 分层配置（config.md）：loadConfig 的产物；缺省时 Runtime 行为与 Phase 2 相同
   * （无用户/项目配置、无 trust、无持久化 Grant）
   */
  config?: RuntimeConfig | undefined;
  /** Turn 配置覆盖（maxSteps / retryLimit / retryBaseDelayMs） */
  turn?: Partial<TurnConfig> | undefined;
  /**
   * MCP 连接器（modules.md：Core 不依赖 mcp，装配方注入；packages/mcp
   * 提供 createMcpConnector）。缺省时已配置的服务器降级为警告。
   */
  mcp?: McpConnector | undefined;
  /** 不经配置文件直接注入的 MCP 服务器（测试与嵌入方用） */
  mcpServers?: McpServerConfig[] | undefined;
  /** ADR-0067 §4：MCP 工具按需加载模式覆盖（缺省读配置或 "auto"） */
  mcpToolSearch?: McpToolSearchMode | undefined;
  /**
   * 不经配置文件直接注入的 Hook 条目（测试与嵌入方用；hooks.md）；
   * 与配置层 hooks 合并时排在前。项目配置 hooks 段未信任时已整段剔除。
   */
  hooks?: Partial<Record<HookPoint, HookEntry[]>> | undefined;
  /**
   * 诊断通道（observability.md）：enabled 后写 JSONL；file 缺省写
   * <NOCTURNE_HOME>/logs/debug-*.jsonl，"-" 写 stderr。未启用零开销。
   */
  debug?: { enabled?: boolean | undefined; file?: string | undefined } | undefined;
  /** 写入 session.created 的 Runtime 版本 */
  version?: string | undefined;
  /**
   * 子代理（subagent.md）：缺省即启用默认值；enabled=false 时 task 不注册。
   * 用户级开关是权限规则 `subagent * → deny`。
   */
  subagent?: RuntimeSubagentOptions | undefined;
  /** ADR-0049：外部 agent 连接器；Core 只负责委派、权限和共享并发限制。 */
  externalAgents?: ExternalAgentConnector | undefined;
}

export interface RuntimeSubagentOptions {
  enabled?: boolean | undefined;
  /** 允许的最大会话深度（顶层 0），默认 1 */
  maxDepth?: number | undefined;
  /** Runtime 级并存子会话上限，默认 4 */
  maxConcurrent?: number | undefined;
  /** 子会话单 Turn 步数上限，默认 50 */
  maxStepsPerTurn?: number | undefined;
  /** 缺 finish 时的总轮次上限（首轮 + 催促），默认 3 */
  maxAttempts?: number | undefined;
  /** task 默认超时（毫秒），默认 600_000 */
  timeoutMs?: number | undefined;
}

export interface RuntimePermissionsOptions {
  /** 测试或嵌入方注入；子会话沿用同一实例。 */
  reviewer?: SecurityReviewer | undefined;
  /**
   * 命令行允许（permissions.md 第 7 节）：最终判定为 ask 的调用自动批准。
   * 只提升 ask；不覆盖 deny，不绕过输入校验与路径限制，由权限层完成。
   * CLI 的 --yes 注入这里。
   */
  autoApproveAsk?: boolean | undefined;
}

export interface CreateSessionOptions {
  /** "provider/model" 或 ModelRef */
  model: string | ModelRef;
  /**
   * 会话工作目录（ADR-0051：桌面端单后台按会话传工作区）；
   * 缺省为 Runtime 启动目录。语义与 createRuntime 的 cwd 相同。
   */
  cwd?: string | undefined;
  /**
   * 会话工作区根；显式 cwd 时缺省取其真实路径，否则沿用 Runtime 的
   * workspaceRoot。项目配置、权限、指令都按它加载。
   */
  workspaceRoot?: string | undefined;
  permissionPreset?: string | undefined;
  /**
   * 会话初始思考档位（ADR-0018）；缺省取配置的默认档位
   * （reasoningEffort 顶层字段），再缺省视为 off
   */
  reasoningEffort?: ReasoningEffort | undefined;
  /**
   * 会话级交互（ADR-0064）：缺省沿用 Runtime 的 `interactive`。Runtime 交互时可设 `false`
   * 开出无人值守会话（调度器用）：会话里剩余 `ask` 直接拒绝（`non_interactive`），
   * `ask_user` 以 `not_interactive` 结算；客户端提交第二条用户消息后转为交互且不再变回。
   * 非交互的 Runtime 里设 `true` 不生效。仅无人值守会话带 `schedule` 时才能在
   * 重新打开后保持这一状态（来源写入日志），所以调度器之外不要单独使用 `false`。
   */
  interactive?: boolean | undefined;
  /** 定时任务来源（ADR-0064）：写入 `session.created.schedule`，只由调度器传 */
  schedule?: SessionSchedule | undefined;
}

export interface SubmitInput {
  text?: string | undefined;
  content?: ContentBlock[] | undefined;
  /** 图片字节由 Core 落盘，事件只保存引用 */
  attachments?:
    { data: Uint8Array; mimeType: ImageMimeType; label?: string | undefined }[] | undefined;
  /** 技能调用（skills.md 第 2 节）：Core 校验后把正文快照附到用户消息 */
  skill?: SkillInvocation | undefined;
  /** 外部 agent 点名；与 skill 互斥，任务原文随 message.user 固定。 */
  delegate?: AgentDelegation | undefined;
}

export type { ReadAttachmentResult };

export interface RuntimeSession {
  describeSkills(): SkillsDescription;
  describeExternalAgents(): Promise<ExternalAgentsDescription>;
  rewindTargets(): Promise<RewindTarget[]>;
  turnChanges(): Promise<TurnChanges[]>;
  turnChangeDiff(seq: number, path: string): Promise<TurnChangeDiff>;
  rewind(targetSeq: number, mode: RewindMode): Promise<SessionRewoundPayload["files"]>;
  readonly id: string;
  state(): SessionState;
  /**
   * 本会话已写入日志的全部持久化事件（旧→新）。客户端用它按
   * protocol 的 reducer 回放视图，再 subscribe 接实时事件（view.md 第 6 节）。
   */
  durableEvents(): readonly DurableEvent[];
  /** 只读取本会话持久事件登记的图片附件；每次从磁盘校验大小与 sha256。 */
  readAttachment(file: string): Promise<ReadAttachmentResult>;
  /** 订阅会话事件（durable + ephemeral），返回退订函数 */
  subscribe(listener: (event: RuntimeEvent) => void): () => void;
  /** 当前工作区的持久输入历史（旧→新）。读取失败时警告并返回空列表。 */
  readInputHistory(): Promise<string[]>;
  /** 记录一条原文；写盘失败发 runtime.warning，不阻断输入。 */
  recordInputHistory(text: string): Promise<void>;
  /** 工作区 @ 补全索引，首次请求建立，每个 Turn 后失效。 */
  fileIndex(): Promise<FileIndexEntry[]>;
  /**
   * 回答内文件引用存在性检查（U-09，方案 A）：按工作区解析路径，
   * 只读（stat 跟随链接），不产生事件。越界路径照常返回绝对路径
   * 与 exists，由客户端决定只给复制/显示入口。
   */
  resolveFiles(paths: string[]): Promise<FileRefResolution[]>;
  /** 提交一个 Turn；Turn 结束时 resolve（events.md 第 7 节） */
  submit(input: SubmitInput): Promise<TurnEndReason>;
  /** 中断运行中的 Turn；无运行中 Turn 时无操作 */
  interrupt(): void;
  /**
   * 回复 permission.requested（events.md 第 7 节）。
   * 没有匹配的等待中请求时以 unknown_request 拒绝；reply.remember 生成
   * 对应范围的 Grant（permissions.md 5.4）。
   */
  respondPermission(requestId: string, reply: PermissionReply): Promise<void>;
  /**
   * 回复 question.requested（events.md 第 7 节，ADR-0032）。
   * 没有匹配的等待中请求时以 unknown_request 拒绝；回复与问题不匹配
   * （条数不符、未知 label、单选多项）以 invalid_reply 拒绝且请求保持等待。
   */
  respondQuestion(requestId: string, reply: QuestionReply): Promise<void>;
  /**
   * 切换模型（events.md 第 7 节）：会话空闲时生效，写入
   * session.config_changed；未知 provider/model 拒绝 invalid_model。
   */
  setModel(model: string | ModelRef): Promise<void>;
  /**
   * 切换权限预设（events.md 第 7 节，ADR-0036 修订）：Turn 进行中、
   * 压缩进行中都可切换，立即重建策略、从下一次权限求值起生效；
   * 已在等待确认的权限请求保持原样。写入 session.config_changed；
   * 未知预设名拒绝 invalid_command。
   */
  setPermissionPreset(name: string): Promise<void>;
  /**
   * 切换思考档位（events.md 第 7 节，ADR-0018）：立即写入
   * session.config_changed，下一个 Turn 生效（Turn 进行中允许——
   * 本 Turn 请求沿用 Turn 开始快照）。
   * 档位必须在当前模型声明的可用集合内（off 恒可用），否则
   * 拒绝 invalid_command。
   */
  setReasoningEffort(level: string): Promise<void>;
  /**
   * 当前 shell 解析结果（ADR-0022）：selected 是生效层声明的选择
   * （"auto" 或种类名），effective 是实际执行的 shell；显式选择不可用
   * 时 error 给出可选项。生效层为 env/config 时 overriddenBy 给出该
   * 来源——此时写入 settings.json 的选择不生效（无论它当前是否有值）。
   */
  shellInfo(): SessionShellInfo;
  visionInfo(): { imageInput: boolean; available: boolean; model: string | undefined };
  /** 本机探测到的全部 shell 种类（含未安装的；/shell 列表的数据来源） */
  listShells(): readonly DetectedShell[];
  /**
   * 切换 shell（ADR-0022 第 4 节）：kind 为 "auto" 或种类名
   * （pwsh | powershell | bash | cmd | sh）。目标种类未安装（或 auto
   * 解不出可用 shell）时以 invalid_command 拒绝并列出可选项，不写
   * settings.json、不产生事件。写入 settings.json（无配置层时仅本
   * 会话内生效），下一次 shell 调用起生效，Turn 进行中也可切换；
   * 实际生效变化且未被上层覆盖时写 session.config_changed 的 shell 字段。
   */
  setShell(kind: string): Promise<void>;
  /**
   * 当前思考档位信息（TUI 状态栏、CLI /effort 的数据来源）：
   * current = 持久化意图按当前模型就近降档后的值；
   * effective = 本 Turn 实际生效的快照档（Turn 外 = current）。
   * Turn 中切档后两者不同 → 新档位下一 Turn 生效（ADR-0018 §3）。
   * available = 当前模型声明的可用集合（空 = 不可切换；off 恒可用不计入）。
   */
  reasoningEffortInfo(): {
    current: ReasoningEffort;
    effective: ReasoningEffort;
    available: ReasoningEffortLevel[];
  };
  /**
   * 手动压缩（context.md 6.2/6.6）：一次模型调用生成 L2 摘要，
   * 写入 context.compacted(kind="summary")。Turn 进行中拒绝 session_busy，
   * 已有压缩进行中拒绝 compaction_in_progress，被中断拒绝
   * compaction_interrupted；失败不写任何事件、历史不变。
   */
  compact(): Promise<void>;
  /** 当前上下文构建结果与报告（cli.md /context 命令的数据来源） */
  describeContext(): BuiltContext;
  /** 本会话 MCP 服务器状态（mcp.md 第 5 节；未配置/未启用时为空数组） */
  mcpServers(): readonly McpServerStatus[];
  /** 打开会话时聚合的警告（配置降级、未信任项目配置等），供客户端展示 */
  readonly warnings: readonly string[];
  /** 打开时执行的恢复修复汇总（sessions.md 第 6 节）；无修复则 undefined */
  readonly recovery?: SessionRecovery | undefined;
  close(): Promise<void>;
}

/** RuntimeSession.shellInfo 的返回（ADR-0022 第 2、4 节） */
export interface SessionShellInfo {
  /** 生效层声明的选择："auto" 或种类名 */
  selected: string;
  /** 生效选择的来源层：NOCTURNE_SHELL / config.json / settings.json / 自动 */
  source: "env" | "config" | "settings" | "auto";
  /** 实际执行的 shell；显式选择不可用时缺省（error 给出原因与可选项） */
  effective?: { kind: string; name: string; path: string } | undefined;
  error?: string | undefined;
  /** 生效层为 env/config 时的覆盖来源（settings 写入不生效的提示） */
  overriddenBy?: "env" | "config" | undefined;
}

export interface ResumeSessionOptions {
  /** 会话记录的模型无法解析时，以该模型替代（写入 session.config_changed） */
  model?: string | ModelRef | undefined;
  /** --force-unlock：先删除锁文件再走正常打开流程（ADR-0009） */
  force?: boolean | undefined;
}

export interface Runtime {
  /** 定时任务列表（ADR-0064）：带下次运行时间、上次结果、是否在运行，以及调度器状态 */
  listSchedules(): Promise<ScheduleListResult>;
  /** 新建（不带 id）或整体替换（带 id）；字段非法抛 `ScheduleError`（带 `field`，客户端据此标到输入框） */
  saveSchedule(input: ScheduleSaveInput): Promise<ScheduleTaskOverview>;
  /** 删除任务及其历史；已有会话不动；任务不存在时不报错 */
  deleteSchedule(input: { id: string }): Promise<void>;
  /**
   * 立即运行（trigger: manual）；上一次未结束或名额已满时返回 `started: false` 与原因；
   * 本进程没有运行调度器、或运行没能开始时抛 `ScheduleError`
   */
  runSchedule(input: { id: string }): Promise<ScheduleRunNowResult>;
  scheduleHistory(input: { id: string }): Promise<ScheduleHistoryEntry[]>;
  /** 任务列表、启停、运行状态变化的易失通知（`schedule.changed`）；返回取消订阅函数 */
  onScheduleChanged(listener: (payload: ScheduleChangedPayload) => void): () => void;
  /** 停止调度器：中止运行中的任务、释放锁文件；后台退出前调用 */
  stopScheduler(): Promise<void>;
  describeSkills(input?: { workspaceRoot?: string | undefined }): Promise<SkillsDescription>;
  setSkillEnabled(input: { name: string; enabled: boolean }): Promise<{ affectedSessions: number }>;
  /**
   * 导入技能（skills.md 第 7 节，ADR-0048 修订 U-08）：只支持本地文件夹。
   * `mode: "preview"` 只扫描校验、不写任何东西；`mode: "commit"` 按逐项
   * 决定写入，成功后刷新已打开会话的技能目录。目标只有用户级与当前
   * 工作区两处（`target: "project"` 时用 `workspaceRoot ??` 当前工作区）。
   */
  importSkills(input: SkillImportInput): Promise<SkillImportOutput>;
  describeMcpServers(input?: {
    workspaceRoot?: string | undefined;
  }): Promise<{ servers: McpServerOverview[]; warnings: string[] }>;
  saveMcpServer(input: McpSaveInput): Promise<McpServerOverview>;
  deleteMcpServer(input: { id: string; workspaceRoot?: string | undefined }): Promise<void>;
  setMcpServerEnabled(input: {
    id: string;
    enabled: boolean;
    workspaceRoot?: string | undefined;
  }): Promise<void>;
  probeMcpServer(input: McpProbeInput): Promise<McpProbeResult>;
  describeExternalAgents(input?: {
    workspaceRoot?: string | undefined;
  }): Promise<ExternalAgentsDescription>;
  saveExternalAgent(input: ExternalAgentSaveInput): Promise<ExternalAgentOverview>;
  deleteExternalAgent(input: { name: string }): Promise<void>;
  setExternalAgentEnabled(input: { name: string; enabled: boolean }): Promise<void>;
  probeExternalAgent(input: ExternalAgentProbeInput): Promise<ExternalAgentProbeResult>;
  /**
   * 启停服务商（ADR-0054 §3）：写 settings.json 的 disabledProviders（专用读写，
   * 用户级；项目配置不能启停）。停用的服务商不从注册表移除，其模型在下一次
   * 解析起带 unavailable + disabled；已打开会话在下一空闲边界重解析。
   */
  setProviderEnabled(input: { provider: string; enabled: boolean }): Promise<void>;
  /** 批量启停某服务商下的模型（ADR-0054 §3，供「全部启用 / 停用」） */
  setModelsEnabled(input: { provider: string; models: string[]; enabled: boolean }): Promise<void>;
  /**
   * 停用前的影响面（ADR-0054 §3）：受影响的已打开会话数、默认模型是否
   * 落入停用集合、受影响的模型角色。`models` 省略时按整个服务商计算。
   */
  describeToggleImpact(input: { provider: string; models?: string[] | undefined }): ToggleImpact;
  /**
   * workspaceRoot（ADR-0051）：下列方法的 `input?.workspaceRoot`/`options?.workspaceRoot`
   * 指定按哪个工作区合并配置层；缺省为 Runtime 启动目录。指定的工作区须已加载
   * （同工作区有会话打开，或先经 RuntimeConfig.forWorkspace 加载——RPC 服务端
   * 在派发前自动加载），否则只看到不含项目层的合并结果。
   */
  describeModelRoles(input?: { workspaceRoot?: string | undefined }): ModelRoleInfo[];
  setModelRole(
    role: ModelRole,
    ref: string | null,
    options?: { workspaceRoot?: string | undefined },
  ): Promise<SettingItem[]>;
  describeSettings(input?: { workspaceRoot?: string | undefined }): SettingItem[];
  listShells(input?: { workspaceRoot?: string | undefined }): Promise<readonly DetectedShell[]>;
  /**
   * 面板「文件」标签读取本机文件（ADR-0060 第 3 节及 2026-10-18 修订）：只收绝对路径，
   * 不依赖会话、不限工作区；UNC 等网络路径与链接到网络位置的路径直接拒绝、不访问。
   * 只读普通文件，返回文本或图片，超过 READ_FILE_MAX_BYTES 报 file_too_large。
   * 不是 agent 工具，不经权限层。
   */
  readFile(path: string): Promise<LocalFileContent>;
  setShellSetting(
    kind: string,
    input?: { workspaceRoot?: string | undefined },
  ): Promise<SettingItem[]>;
  updateSettings(
    patch: SettingsPatch,
    options?: { reviewerKey?: string; workspaceRoot?: string | undefined },
  ): Promise<SettingItem[]>;
  listReviewerProviders(input?: {
    workspaceRoot?: string | undefined;
  }): Promise<ProviderOverview[]>;
  defaultReviewer(
    endpoint: JevEndpoint,
    baseURL?: string,
    input?: { workspaceRoot?: string | undefined },
  ): Promise<JevReviewerConfig>;
  listReviewerModels(
    reviewer: JevReviewerConfig,
    signal?: AbortSignal,
    input?: { workspaceRoot?: string | undefined },
  ): Promise<{ models: string[]; warning?: string }>;
  /** 内置审查样例的说明与期望（ADR-0057 §8），供设置页逐条检查 */
  listReviewerSamples(): ReviewerSampleInfo[];
  /**
   * 用当前**已保存**的审查器配置（含追加规则）跑一条内置样例；离线样例，
   * 不经过会话。审查器关闭或模型不可用时以 invalid_command / invalid_model 拒绝；
   * 审查失败或超时（30 秒）记为「交人」并带原因，不抛错。
   */
  testReviewerSample(
    sampleId: string,
    signal?: AbortSignal,
    input?: { workspaceRoot?: string | undefined },
  ): Promise<ReviewerSampleResult>;
  setDefaultModel(
    model: string,
    reasoningEffort: ReasoningEffort | null,
    options?: { workspaceRoot?: string | undefined },
  ): Promise<SettingItem[]>;
  createSession(options: CreateSessionOptions): Promise<RuntimeSession>;
  resumeSession(id: string, options?: ResumeSessionOptions): Promise<RuntimeSession>;
  forkSession(id: string, options?: { targetSeq?: number }): Promise<string>;
  /**
   * 只读发现父会话的直接内置子会话（含已结束，ADR-0060 第 4 轮、rpc.md 4.1）：
   * 登记簿里的活动项 ∪ 日志 `session.created.parent` 映射。不打开会话、不取锁、不修复。
   */
  listSubagents(input: { parentSessionId: string }): Promise<SubagentSummary[]>;
  /**
   * 只读观察一个直接子会话：运行中直接接已提交事件（先监听、后取前缀、按 seq 去重），
   * 否则读固定日志快照；自然结束经 onEnd 至多一次。返回的观察对象不是 RuntimeSession，
   * 没有任何命令入口。`signal` 可取消建立和实时阶段的观察，返回后也可用 unsubscribe。
   */
  observeSubagent(
    input: {
      parentSessionId: string;
      childSessionId: string;
      afterSeq?: number | undefined;
      signal?: AbortSignal | undefined;
    },
    observer: SubagentObserver,
  ): Promise<SubagentObservation>;
  /** 读取子会话自己的持久事件登记过的图片附件，复用附件路径/哈希校验，不打开 child */
  readSubagentAttachment(input: {
    parentSessionId: string;
    childSessionId: string;
    file: string;
  }): Promise<ReadAttachmentResult>;
  listSessions(filter?: {
    cwd?: string | undefined;
    /** 默认 false：子会话（session.created.parent 存在）不进列表 */
    includeSubagents?: boolean | undefined;
  }): Promise<SessionSummary[]>;
  /** 已配置 Provider 声明的模型清单（含已加载的可信项目层）；input.workspaceRoot 见上 */
  listModels(input?: {
    workspaceRoot?: string | undefined;
    /** ADR-0054 §3：true 时包含停用模型（带 disabled），供服务商页使用；默认过滤 */
    includeDisabled?: boolean | undefined;
  }): ModelInfo[];
  usageStats(input: { days?: number }): Promise<UsageStats>;
  /**
   * 用新的基础层配置重建运行时级 Provider 注册表（provider-setup.md
   * 第 6 节）；已打开会话在下一次空闲边界重建会话级注册表。不产生
   * 持久事件，不触发 SessionEnd/SessionStart Hook；MCP 按配置增量更新。
   */
  updateProviders(config: RuntimeConfig): Promise<void>;
  /** 分层合并后的默认模型（模型选择页"默认模型"标记）；无法解析时 undefined */
  defaultModel(input?: { workspaceRoot?: string | undefined }): ModelRef | undefined;
  /** recent-models.json 当前内容（新→旧，最多 10 条）；全局偏好，无工作区维度 */
  listRecentModels(): ModelRef[];
  /** 读取机器维护的字符串偏好；未注入 RuntimeConfig 时返回 undefined。 */
  getPreference(key: string): string | undefined;
  /** 原子保存或删除偏好；未注入 RuntimeConfig 时拒绝。 */
  setPreference(key: string, value: string | undefined): Promise<void>;
}

export interface ModelRoleInfo {
  role: ModelRole;
  configured: string | undefined;
  model: string | undefined;
  source: SettingItem["source"];
  available: boolean;
}

function resolveModelRole(
  registry: ProviderRegistry,
  ref: string | undefined,
  role: ModelRole,
): ResolvedModel | undefined {
  if (ref === undefined) return undefined;
  const parsed = parseModelRef(ref);
  const provider = registry.providers().find((p) => p.id === parsed.provider);
  if (!provider?.models().some((m) => m.ref.model === parsed.model)) return undefined;
  const resolved = registry.resolve(parsed);
  if (
    resolved.model.unavailable !== undefined ||
    (role === "vision" && !resolved.model.capabilities.imageInput)
  )
    return undefined;
  return resolved;
}

function parseModelRef(model: string | ModelRef): ModelRef {
  if (typeof model !== "string") return model;
  const i = model.indexOf("/");
  if (i <= 0 || i === model.length - 1) {
    throw new RuntimeCommandError(
      "invalid_command",
      `model 必须是 "provider/model" 形式，收到: ${model}`,
    );
  }
  return { provider: model.slice(0, i), model: model.slice(i + 1) };
}

/**
 * ADR-0054 §3：停用导致的 invalid_model 携带结构化 `disabled` 与模型引用，
 * 让客户端区分「已停用」（可重新启用）与「已删除」。非停用原因时为普通错误。
 */
function invalidModelError(message: string, model?: ModelInfo): RuntimeCommandError {
  return new RuntimeCommandError(
    "invalid_model",
    message,
    model?.disabled !== undefined
      ? {
          disabled: model.disabled,
          model: { provider: model.ref.provider, model: model.ref.model },
          ...(model.providerDisabled === true ? { providerDisabled: true as const } : {}),
        }
      : undefined,
  );
}

/**
 * 恢复会话时会话模型已停用（ADR-0054 §3）：与「未知模型」走同一条路——
 * 没有替代模型时以 invalid_model 拒绝，有替代模型时先写 session.config_changed。
 */
class DisabledSessionModelError extends Error {
  constructor(readonly model: ModelInfo) {
    super(model.unavailable?.reason ?? "会话模型已停用");
    this.name = "DisabledSessionModelError";
  }
}

/**
 * ProviderEntryConfig → 路由 Provider（ADR-0026 §4）：条目一个实例，
 * 内部按模型的生效协议分发到三种适配器。
 */
function instantiateProvider(
  entry: ProviderEntryConfig,
  env: (n: string) => string | undefined,
  diagnostics: Diagnostics | undefined,
  credentials: CredentialResolver | undefined,
  userAgent: string,
  authResolver?: AuthResolver,
) {
  return createEntryProvider(
    {
      id: entry.id,
      ...(entry.type !== undefined ? { type: entry.type } : {}),
      ...(entry.baseURL !== undefined ? { baseURL: entry.baseURL } : {}),
      apiKeyEnv: entry.apiKeyEnv,
      auth: entry.auth,
      modelHeader: entry.modelHeader,
      ...(authResolver !== undefined ? { authResolver } : {}),
      ...(credentials !== undefined ? { credentials } : {}),
      ...(entry.models !== undefined
        ? { models: entry.models as Record<string, ModelOverride> }
        : {}),
      ...(entry.allowUndeclaredModels !== undefined
        ? { allowUndeclaredModels: entry.allowUndeclaredModels }
        : {}),
      ...(entry.providerOptions !== undefined ? { providerOptions: entry.providerOptions } : {}),
      ...(entry.headers !== undefined ? { headers: entry.headers } : {}),
      ...(entry.sessionHeader !== undefined ? { sessionHeader: entry.sessionHeader } : {}),
      editToolDefault: defaultEditToolForModel,
      userAgent,
      ...(entry.thinking !== undefined ? { thinking: entry.thinking } : {}),
      ...(diagnostics !== undefined ? { diagnostics } : {}),
    },
    env,
  );
}

export async function createRuntime(options: RuntimeOptions): Promise<Runtime> {
  const platform = createPlatform();
  const { fs, paths } = platform;
  // currentConfig 在 updateProviders 时整体替换（provider-setup.md 第 6 节）
  let config = options.config;

  const cwd = paths.resolve(options.cwd, ".");
  const workspaceRoot = await platform.resolveReal(options.workspaceRoot ?? cwd);
  await config?.forWorkspace(workspaceRoot);
  const sessionsDir =
    options.sessionsDir !== undefined
      ? paths.resolve(options.sessionsDir, ".")
      : (config?.sessionsDir ?? paths.join(platform.nocturneHome(), "sessions"));
  await fs.mkdir(sessionsDir);
  const nocturneHome = config?.nocturneHome ?? platform.nocturneHome();
  let historyWrite = Promise.resolve();

  // 诊断通道（observability.md）：未启用时 no-op；sink 故障降级 + 警告进会话。
  // 先于 Provider 装配创建——适配器经 config.diagnostics 记录能力降级
  const sinkWarnings: { code: string; message: string }[] = [];
  const diagnostics = createDiagnostics({
    platform,
    enabled: options.debug?.enabled,
    file: options.debug?.file === "-" ? undefined : options.debug?.file,
    logsDir: paths.join(config?.nocturneHome ?? platform.nocturneHome(), "logs"),
    writeLine:
      options.debug?.file === "-" ? (line) => process.stderr.write(`${line}\n`) : undefined,
    warn: (code, message) => sinkWarnings.push({ code, message }),
  });

  /**
   * 凭据解析器（provider-setup.md 第 3 节）：适配器在请求时经它取
   * 凭据存储中的密钥；引用 currentConfig 的 store——updateProviders
   * 换 config 后解析器自动指向新存储。
   */
  const credentialResolver: CredentialResolver = (providerId) =>
    config?.credentials.get(providerId) ?? Promise.resolve(undefined);
  const reviewerCredentials = (
    providers: readonly Pick<ProviderEntryConfig, "id" | "auth" | "apiKeyEnv">[],
  ) => {
    const store = config?.credentials;
    if (store === undefined || config === undefined) return undefined;
    return {
      ...store,
      get: (id: string) => {
        const entry = providers.find((provider) => provider.id === id);
        if (entry === undefined) return store.get(id);
        return entryAuth(entry).token(new AbortController().signal);
      },
    };
  };
  function entryAuth(entry: Pick<ProviderEntryConfig, "id" | "auth" | "apiKeyEnv">) {
    if (config === undefined) {
      throw new Error("缺少运行时配置，无法解析服务商鉴权");
    }
    return resolveProviderAuth(config, {
      id: entry.id,
      ...(entry.auth !== undefined ? { auth: entry.auth } : {}),
      ...(entry.apiKeyEnv !== undefined ? { apiKeyEnv: entry.apiKeyEnv } : {}),
      credentials: credentialResolver,
    });
  }

  /**
   * 当前用户级停用集合（ADR-0054 §3）：读 settings.json 的专用字段。
   * 停用的服务商不从注册表移除——resolve() 会盖章 unavailable + disabled。
   */
  function disabledSet(): DisabledModels {
    return {
      providers: new Set(config?.disabledProviders() ?? []),
      models: new Set(config?.disabledModels() ?? []),
    };
  }

  /**
   * Provider 构造：显式注入 + keepProviders + options.providerConfigs +
   * （有 config 时）合并后的条目。
   * keepProviders：updateProviders 重建时仍被会话引用的旧实例
   * （provider-setup.md 第 6 节），同 id 被新条目覆盖。
   */
  function buildRegistry(
    configProviders: readonly ProviderEntryConfig[],
    keepProviders: readonly Provider[] = [],
  ): ProviderRegistry {
    const env = (n: string) => platform.env(n);
    // ADR-0031 §2：所有 Provider 请求的 UA 以 nocturne/<version> 开头
    const userAgent = nocturneUserAgent(options.version ?? NOCTURNE_VERSION);
    // 同 id 后者覆盖（options.providerConfigs < config 条目，与分层优先级一致）
    const byId = new Map<string, Provider>();
    for (const p of options.providers ?? []) byId.set(p.id, p);
    for (const p of keepProviders) {
      if (!byId.has(p.id)) byId.set(p.id, p);
    }
    for (const c of options.providerConfigs ?? []) {
      // ADR-0026 §4：与 config 条目同一路由 Provider（按模型生效协议分发）
      const authResolver = config === undefined ? undefined : entryAuth(c);
      const instance = createEntryProvider(
        {
          ...c,
          credentials: credentialResolver,
          ...(authResolver !== undefined ? { authResolver } : {}),
          diagnostics,
          userAgent,
          editToolDefault: defaultEditToolForModel,
        },
        env,
      );
      byId.set(instance.id, instance);
    }
    for (const e of configProviders) {
      byId.set(
        e.id,
        instantiateProvider(
          e,
          env,
          diagnostics,
          credentialResolver,
          userAgent,
          config === undefined ? undefined : entryAuth(e),
        ),
      );
    }
    return createProviderRegistry(
      [...byId.values()],
      options.modelOverrides,
      defaultEditToolForModel,
      disabledSet(),
    );
  }

  // 运行时级注册表：注入 + providerConfigs + config 基础层；
  // updateProviders 时整体重建
  let registry: ProviderRegistry = buildRegistry(config?.base.providers ?? []);

  // 子代理（subagent.md 第 3、11 节）：并发信号量是 Runtime 级——
  // 多会话宿主与嵌套派生共享同一批槽位
  const subagentEnabled = options.subagent?.enabled !== false;
  const subagentLimits = {
    maxDepth: options.subagent?.maxDepth ?? 1,
    maxConcurrent: options.subagent?.maxConcurrent ?? 4,
    maxStepsPerTurn: options.subagent?.maxStepsPerTurn ?? 50,
    maxAttempts: options.subagent?.maxAttempts ?? 3,
    // 默认 600_000，上限 3_600_000（subagent.md 第 3 节）；同时是 task 的
    // traits.timeoutMs——执行器兜底与 launcher 计时器共用同一个值
    timeoutMs: Math.min(Math.max(options.subagent?.timeoutMs ?? 600_000, 1), 3_600_000),
  };
  const subagentLimiter = createSubagentLimiter(subagentLimits.maxConcurrent);
  // 观察登记簿与 limiter 同寿命：所有会话、所有嵌套层级的 launcher 共享（rpc.md 4.1）
  const subagentRegistry = createSubagentRegistry();

  const store: SessionStore = createSessionStore({ platform, sessionsDir });
  const subagentObservation = createSubagentObservation({
    platform,
    sessionsDir,
    registry: subagentRegistry,
  });
  const usageStats = createUsageStats({
    platform,
    sessionsDir,
    // 注册表给不出价格（服务商已删除或改名、模型不在清单）时按模型厂商兜底（ADR-0053 修订）
    pricing: (ref) => {
      let model: ReturnType<ProviderRegistry["resolve"]>["model"] | undefined;
      try {
        model = registry.resolve(ref).model;
      } catch {
        model = undefined;
      }
      if (model?.pricing !== undefined) return model;
      const vendor = config?.vendorPricing?.(ref.model);
      return vendor !== undefined ? { pricing: vendor, pricingSource: "vendor" as const } : model;
    },
  });

  /**
   * 已打开会话挂在 Runtime 上的回调（配置广播、技能预算、分叉入口），按会话 id 索引。
   * 会话打开的最后一步整体登记；close 与打开失败共用同一撤销步骤移除（sessions.md 第 4 节）。
   */
  interface OpenSessionHooks {
    shellCurrent(): ReturnType<ReturnType<typeof createShellResolver>["current"]>;
    shellChanged(
      before: ReturnType<ReturnType<typeof createShellResolver>["current"]>,
    ): Promise<void>;
    /** updateProviders 等：标记 providers 待重建，下一次空闲边界 rebuildProviders */
    markProvidersDirty(): void;
    /** 当前会话模型引用（ADR-0054 describeToggleImpact 的影响面计算） */
    currentModel(): ModelRef;
    reconcileMcp(): Promise<void>;
    refreshSkills(rescan: boolean): Promise<void>;
    refreshExternalAgents(): void;
    skillModel: { workspaceRoot: string; contextWindow: () => number | undefined };
    fork(targetSeq?: number): Promise<string>;
    /** 广播到本会话失败时的提示出口 */
    applyFailed(scope: string, error: unknown): void;
  }
  const openSessions = new Map<string, OpenSessionHooks>();
  /** 每次配置广播递增；打开途中错过的广播在登记时补成待应用（下一 Turn 边界生效） */
  let configGeneration = 0;
  /**
   * 向全部已打开会话广播配置变更。逐会话隔离：配置已落盘，单个会话应用失败只在该会话上
   * 发 runtime.warning(config_apply_failed) 并记诊断，不影响其余会话与请求结果（mcp.md 第 4 节）。
   * 返回成功应用的会话数。
   */
  async function broadcast(
    scope: string,
    apply: (hooks: OpenSessionHooks) => Promise<void> | void,
  ): Promise<number> {
    configGeneration++;
    const results = await Promise.all(
      [...openSessions.values()].map(async (hooks) => {
        try {
          await apply(hooks);
          return true;
        } catch (e) {
          hooks.applyFailed(scope, e);
          return false;
        }
      }),
    );
    return results.filter(Boolean).length;
  }
  /** 配置整体变化（重载 / updateProviders）：按原有阶段顺序逐会话隔离广播 */
  async function applyConfigToSessions(): Promise<void> {
    await broadcast("providers", (hooks) => {
      hooks.markProvidersDirty();
    });
    await broadcast("mcp", (hooks) => hooks.reconcileMcp());
    await broadcast("skills", (hooks) => hooks.refreshSkills(true));
    await broadcast("externalAgents", (hooks) => {
      hooks.refreshExternalAgents();
    });
  }
  let settingsPending = Promise.resolve();

  const interactive = options.interactive === true;

  /**
   * 项目指令按会话的工作区/cwd 加载（ADR-0051：一个 Runtime 服务多个工作区）；
   * 同一 (workspaceRoot, cwd) 的会话共用缓存，options.instructions 显式注入时仍优先。
   */
  const instructionCache = new Map<string, Promise<InstructionSet>>();
  function sessionInstructions(ws: string, dir: string): Promise<InstructionSet> {
    const key = `${ws} ${dir}`;
    let cached = instructionCache.get(key);
    if (cached === undefined) {
      cached = loadInstructions(platform, ws, dir).catch((e: unknown) => {
        instructionCache.delete(key);
        throw e;
      });
      instructionCache.set(key, cached);
    }
    return cached;
  }
  const detectedShells = await detectShells(platform);
  const skillCache = createSkillDiscoveryCache(platform);

  type ShellResolution = ReturnType<ReturnType<typeof createShellResolver>["current"]>;
  const shellSwitched = (before: ShellResolution, after: ShellResolution): boolean =>
    after.descriptor !== undefined &&
    after.overriddenBy === undefined &&
    (after.descriptor.kind !== before.descriptor?.kind ||
      after.descriptor.executable !== before.descriptor.executable);

  async function changeShell(
    resolver: ReturnType<typeof createShellResolver>,
    kind: string,
    write: (kind: ShellSpec["kind"]) => Promise<void>,
  ): Promise<{ before: ShellResolution; after: ShellResolution; switched: boolean }> {
    const normalized = kind.trim().toLowerCase();
    if (normalized !== "auto" && !isShellKind(normalized))
      throw new RuntimeCommandError(
        "invalid_command",
        `未知 shell：${kind}（可选：auto | pwsh | powershell | bash | cmd | sh）`,
      );
    const probe = resolver.probe(normalized);
    if (probe.descriptor === undefined)
      throw new RuntimeCommandError(
        "invalid_command",
        probe.error ?? `所选 shell ${normalized} 不可用`,
      );
    const before = resolver.current();
    await write(normalized);
    const after = resolver.current();
    return { before, after, switched: shellSwitched(before, after) };
  }

  async function runtimeShellResolver(root: string) {
    await config?.forWorkspace(root);
    const envValue = platform.env("NOCTURNE_SHELL");
    const current = config?.resolvedSettings(root, envValue);
    const settingsConfig = config;
    const paths = new Map<string, boolean>();
    const envSpec = envValue === undefined ? undefined : parseShellSpec(envValue);
    for (const p of [current?.shellPath, envSpec && "path" in envSpec ? envSpec.path : undefined]) {
      if (p !== undefined) paths.set(p, await platform.fs.exists(p));
    }
    return createShellResolver({
      platform: process.platform,
      envValue,
      detected: detectedShells,
      resolved: settingsConfig
        ? () => {
            const settings = settingsConfig.resolvedSettings(root, envValue);
            const source = settingsConfig
              .describeSettings(root, envValue)
              .find((item) => item.key === "shell")?.source;
            return {
              spec: specFromConfigFields(settings.shell, settings.shellPath),
              source:
                source === "env"
                  ? "env"
                  : source === "settings"
                    ? "settings"
                    : source === "default" || source === undefined
                      ? "auto"
                      : "config",
            };
          }
        : undefined,
      settings: () => undefined,
      pathExists: (p) => paths.get(p) === true,
    });
  }

  async function wrapSession(
    session: Session,
    resume?: { modelOverride?: string | ModelRef | undefined },
    unattended = false,
  ): Promise<RuntimeSession> {
    // 打开途中取得的 Runtime 级登记与外部资源（MCP 连接）按序登记撤销步骤；
    // 打开失败在此逆序撤销，close 复用同一份。会话锁由调用方 session.close() 释放。
    const teardown: (() => Promise<void> | void)[] = [];
    const runTeardown = async (): Promise<void> => {
      for (const step of teardown.splice(0).reverse()) await step();
    };
    try {
      return await assembleSession(session, resume, teardown, runTeardown, unattended);
    } catch (e) {
      await runTeardown().catch(() => undefined);
      throw e;
    }
  }

  async function assembleSession(
    session: Session,
    resume: { modelOverride?: string | ModelRef | undefined } | undefined,
    teardown: (() => Promise<void> | void)[],
    runTeardown: () => Promise<void>,
    unattendedOption: boolean,
  ): Promise<RuntimeSession> {
    const meta = session.state().meta;
    // 会话级非交互（ADR-0064）：带定时任务来源的会话、或创建时声明 interactive:false，
    // 在客户端提交第二条用户消息之前按非交互处理；之后转为交互（permissions.md 第 7 节）
    const unattendedSession = unattendedOption || meta.schedule !== undefined;
    const sessionInteractive = createAttendance({
      runtimeInteractive: interactive,
      unattended: unattendedSession,
      userMessageCount: () =>
        session.durableEvents().filter((event) => event.type === "message.user").length,
    });
    const openedAt = Date.now();
    const openGeneration = configGeneration;

    // 项目层与项目指令都按会话记录的 workspaceRoot/cwd 加载（config.md 第 6 节）
    const ws = config !== undefined ? await config.forWorkspace(meta.workspaceRoot) : undefined;
    const instructions =
      options.instructions ?? (await sessionInstructions(meta.workspaceRoot, meta.cwd));
    const resolved = ws?.resolved;
    diagnostics.record("config.load", {
      sessionId: session.id,
      trusted: ws?.projectConfig.trusted,
      projectConfig: ws?.projectConfig.present === true,
      mcpServers: resolved?.mcpServers.length ?? 0,
      hookPoints: Object.keys(resolved?.hooks ?? {}).length,
      warnings: resolved?.warnings.length ?? 0,
    });
    const warnings: string[] = [...(resolved?.warnings ?? [])];
    let skillDiscovery = await skillCache.discover({
      nocturneHome,
      workspaceRoot: meta.workspaceRoot,
      cwd: meta.cwd,
      config: config?.skillConfig(),
    });
    for (const warning of skillDiscovery.warnings)
      warnings.push(`${warning.path}:${warning.line}：${warning.message}`);
    let catalog = skillCatalog(skillDiscovery.skills, config?.disabledSkills() ?? [], undefined);
    if (ws?.projectConfig.present === true && !ws.projectConfig.trusted) {
      warnings.push(
        `检测到项目配置 ${ws.projectConfig.path ?? ""}，但该工作区未信任——其中仅收紧方向的规则生效；执行 nctrn trust 信任该工作区`,
      );
    }
    for (const w of sinkWarnings) {
      session.emitEphemeral("runtime.warning", w);
    }
    for (const message of warnings) {
      session.emitEphemeral("runtime.warning", { code: "config_warning", message });
    }
    for (const providerId of resolved?.providerThinkingWarnings ?? []) {
      const message = `服务商 ${providerId}：服务商级思考档位已停用，模型能力改由上游与 models.dev 提供，个别模型可在编辑模型里修改`;
      warnings.push(message);
      session.emitEphemeral("runtime.warning", {
        code: "provider_thinking_levels_ignored",
        message,
      });
    }
    for (const message of resolved?.providerAuthWarnings ?? []) {
      warnings.push(message);
      session.emitEphemeral("runtime.warning", { code: "provider_auth_conflict", message });
    }
    // providers.json 损坏/版本不符：被忽略但明确提示（provider-setup.md 第 2 节）
    if (config?.providerSetupWarning !== undefined) {
      session.emitEphemeral("runtime.warning", {
        code: "provider_setup_invalid",
        message: config.providerSetupWarning,
      });
    }
    if (ws?.projectConfig.present === true && !ws.projectConfig.trusted) {
      session.emitEphemeral("runtime.warning", {
        code: "project_config_untrusted",
        message: `项目配置未信任：${ws.projectConfig.path ?? meta.workspaceRoot}`,
      });
    }

    // shell 解析（ADR-0022 第 2 节）：NOCTURNE_SHELL > config.json >
    // settings.json > 自动。env 值与 config 层值在会话打开时快照；
    // settings 层经 config.shellSetting() live 读取，/shell 写盘后下一次
    // shell 调用即生效（不在 Turn 开始快照——scope 组装时按次取值）。
    let memoryShellSpec: ShellSpec | undefined;
    const explicitPaths = new Set<string>();
    const envShellValue = platform.env("NOCTURNE_SHELL");
    if (envShellValue !== undefined) {
      const parsed = parseShellSpec(envShellValue);
      if (parsed.kind !== "auto" && parsed.kind !== "invalid" && parsed.path !== undefined) {
        explicitPaths.add(parsed.path);
      }
    }
    if (resolved?.shellPath !== undefined) explicitPaths.add(resolved.shellPath);
    const initialSetting = config?.shellSetting();
    if (initialSetting?.shellPath !== undefined) explicitPaths.add(initialSetting.shellPath);
    const explicitPathExists = new Map<string, boolean>();
    await Promise.all(
      [...explicitPaths].map(async (p) => {
        explicitPathExists.set(p, await platform.fs.exists(p));
      }),
    );
    const settingsConfig = config;
    const shellResolver = createShellResolver({
      resolved:
        settingsConfig !== undefined
          ? () => {
              const current = settingsConfig.resolvedSettings(meta.workspaceRoot, envShellValue);
              const source =
                settingsConfig
                  .describeSettings(meta.workspaceRoot, envShellValue)
                  .find((item) => item.key === "shell")?.source ?? "default";
              return {
                spec: specFromConfigFields(current.shell, current.shellPath),
                source:
                  source === "env"
                    ? "env"
                    : source === "settings"
                      ? "settings"
                      : source === "default"
                        ? "auto"
                        : "config",
              };
            }
          : undefined,
      platform: process.platform,
      envValue: envShellValue,
      config: specFromConfigFields(resolved?.shell, resolved?.shellPath),
      settings: () =>
        memoryShellSpec ??
        (config !== undefined
          ? specFromConfigFields(config.shellSetting()?.shell, config.shellSetting()?.shellPath)
          : undefined),
      detected: detectedShells,
      // 显式路径在会话打开时已预探测；settings.json 由程序写入，
      // setShell 只允许种类名，不产生会话内新路径
      pathExists: (p) => explicitPathExists.get(p) === true,
      // 非法 NOCTURNE_SHELL：此处发事件早于任何订阅者，客户端看不到——
      // 同时进 session.warnings（CLI/TUI 的打开提示列表渲染它）
      onWarning: (message) => {
        warnings.push(message);
        session.emitEphemeral("runtime.warning", { code: "shell_env_invalid", message });
      },
    });
    // 环境信息在会话打开（新建或恢复）时按当时生效的 shell 生成，之后不变
    // （ADR-0022 第 4 节：中途切换只写 config_changed + 历史说明，不改前缀）
    const environment: EnvironmentInfo = {
      os: process.platform,
      shell: shellResolver.environmentLine(),
      cwd: meta.cwd,
      workspaceRoot: meta.workspaceRoot,
      // 取会话创建时间而非打开时间：恢复时不改写 system，保住其后整段历史的缓存
      sessionDate: meta.createdAt,
    };

    // 会话级 ProviderRegistry：基础层 + 可信项目层的 Provider 条目。
    // updateProviders 后在下一次空闲边界经 rebuildProviders 重建。
    let sessionRegistry =
      config === undefined ? registry : buildRegistry(resolved?.providers ?? []);

    // 权限策略：预设 + 分层规则 + Grant 集合；setPermissionPreset 重建
    const sessionGrants: Grant[] = [];
    const autoApproveAsk = options.permissions?.autoApproveAsk === true;
    // 凭据索引的内置硬拒绝（provider-setup.md 第 4 节）：词法路径与
    // realpath 后的真实路径都进集合（junction/符号链接不能绕过）
    const credentialsIndexLexical = paths.join(nocturneHome, "credentials.json");
    const credentialsIndexResolved = paths.join(
      await platform.resolveReal(nocturneHome),
      "credentials.json",
    );
    const externalPaths = [
      ...(resolved?.providers ?? []),
      ...(options.providerConfigs ?? []),
    ].flatMap((entry) =>
      entry.auth?.kind === "external-file" ? [externalAuthPath(entry.auth.path)] : [],
    );
    const externalResolved = await Promise.all(
      externalPaths.map((path) => platform.resolveReal(path)),
    );
    // presetContext.sessionId 参数化：子会话重建策略时换自己的 id
    // （attachments 目录等规则绑定子会话自己的落盘位置，subagent.md 7.2）
    const buildPolicy = (
      presetName: string,
      policySessionId: string = session.id,
    ): PermissionPolicy =>
      options.policy ??
      createRulePolicy({
        workspaceRoot: meta.workspaceRoot,
        caseSensitive: platform.caseSensitivePaths,
        preset: isPermissionPresetName(presetName) ? presetName : "default",
        presetContext: {
          skillRoots: skillDiscovery.skills.map((s) => s.realPath),
          sessionsDir,
          sessionId: policySessionId,
          nocturneHome,
        },
        rules: resolved?.rules ?? [],
        untrustedRules: resolved?.untrustedRules ?? [],
        protectedPaths: {
          lexical: [credentialsIndexLexical],
          resolved: [credentialsIndexResolved],
        },
        externalCredentialPaths: { lexical: externalPaths, resolved: externalResolved },
        grants: {
          session: sessionGrants,
          ...(ws?.grants !== undefined ? { project: ws.grants } : {}),
        },
        autoApproveAsk,
      });
    let policy = buildPolicy(session.state().config.permissionPreset);
    if (!isPermissionPresetName(session.state().config.permissionPreset)) {
      warnings.push(
        `会话记录的权限预设 "${session.state().config.permissionPreset}" 未知，已回退 default`,
      );
    }
    // HookRunner：注入条目（options.hooks）在前、配置层在后逐点追加；
    // 项目层未信任时 resolved.hooks 已不含项目段（load.ts 整段忽略）。
    // 工厂形态：子会话以同一批条目换自己的 sessionId 重建，并注入
    // subagent 标记让 Hook 区分父子会话（subagent.md 第 10 节）
    const hookEntries: Partial<Record<HookPoint, HookEntry[]>> = {};
    for (const src of [options.hooks, resolved?.hooks]) {
      for (const [point, entries] of Object.entries(src ?? {})) {
        const key = point as HookPoint;
        hookEntries[key] = [...(hookEntries[key] ?? []), ...entries];
      }
    }
    const makeHookRunner = (
      owner: Session,
      subagent?: { parentSessionId: string; parentCallId: string; depth: number },
    ): HookRunner | undefined => {
      if (Object.keys(hookEntries).length === 0) return undefined;
      const inner = createHookRunner({
        hooks: hookEntries,
        platform,
        sessionId: owner.id,
        cwd: meta.cwd,
        workspaceRoot: meta.workspaceRoot,
        warn: (code, message) => owner.emitEphemeral("runtime.warning", { code, message }),
        diagnostics,
      });
      if (subagent === undefined) return inner;
      return {
        run: (point, input, signal) => inner.run(point, { ...input, subagent }, signal),
      };
    };
    const hookRunner = makeHookRunner(session);

    let modelReviewer: SecurityReviewer | undefined;
    let reviewerKey: string | undefined;
    const getReviewer = (): SecurityReviewer | undefined => {
      if (options.permissions?.reviewer !== undefined) return options.permissions.reviewer;
      const selected =
        config === undefined
          ? resolved?.permissionReviewer
          : config.resolvedSettings(meta.workspaceRoot).permissionReviewer;
      if (!selected || selected.backend === "off") return undefined;
      const key = JSON.stringify(selected);
      if (key !== reviewerKey) {
        reviewerKey = key;
        if (selected.backend === "jev") {
          modelReviewer = createJevSecurityReviewer({
            ...resolveJevConnection(
              selected,
              config?.resolvedSettings(meta.workspaceRoot).providers ?? resolved?.providers ?? [],
              reviewerCredentials(
                config?.resolvedSettings(meta.workspaceRoot).providers ?? resolved?.providers ?? [],
              ),
              (name) => platform.env(name),
            ),
            sessionId: session.id,
          });
        } else {
          const ref = selected.model;
          // ADR-0054 §3：审查小模型同样尊重 unavailable——停用/不可用时按未配置处理
          const resolvedReviewer = sessionRegistry.resolve(ref);
          modelReviewer =
            resolvedReviewer.model.unavailable !== undefined
              ? undefined
              : {
                  backend: "model",
                  model: ref,
                  review: (input, signal) =>
                    createModelSecurityReviewer(resolvedReviewer, session.id).review(input, signal),
                };
        }
      }
      return modelReviewer;
    };
    // 审查输入的来源（ADR-0057 §7）：gate 在送审时取值并按预算裁剪
    const userMessages = () =>
      session.state().history.flatMap((entry) => {
        if (entry.kind !== "user") return [];
        // @ 引用的文件/目录快照附在消息尾部；审查只读取用户亲自输入的部分。
        const snapshots =
          (entry.fileRefs?.filter((ref) => ref.kind !== "image").length ?? 0) +
          (entry.skill ? 1 : 0);
        return [
          entry.content
            .slice(0, entry.content.length - snapshots)
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join(""),
        ];
      });
    const runGit: GitRunner = async (args, signal) => {
      try {
        const child = platform.process.spawn("git", args, {
          cwd: meta.cwd,
          signal,
          timeoutMs: 5_000,
          env: { GIT_OPTIONAL_LOCKS: "0" },
        });
        let out = "";
        for await (const chunk of child.stdout) out += chunk;
        const exit = await child.wait();
        return exit.code === 0 ? out : undefined;
      } catch {
        return undefined;
      }
    };
    // 会话开始时读一次 git remote；拿不到就是空列表。smart 会话立刻开读，其他预设首次需要时再读
    let remotesRead: Promise<string[]> | undefined;
    const trustedRemotes = () =>
      (remotesRead ??= readTrustedRemotes(runGit, new AbortController().signal));
    if (session.state().config.permissionPreset === "smart") void trustedRemotes();
    // 关闭会话时等读取结束，避免 git 子进程还占着工作目录
    teardown.push(async () => {
      await remotesRead;
    });
    const reviewSources: ReviewInputSources = {
      userMessages,
      projectNotes: () =>
        projectNotesFrom([
          ...(instructions.user ? [instructions.user] : []),
          ...instructions.project,
        ]),
      trustedRemotes,
      facts: createReviewFacts({ git: runGit, trustedRemotes }),
      reviewerRules: () =>
        config === undefined
          ? resolved?.permissionReviewerRules
          : config.resolvedSettings(meta.workspaceRoot).permissionReviewerRules,
      environment: { workspaceRoot: meta.workspaceRoot, nocturneHome },
    };
    let warnedMissingReviewer = false;
    const warnMissingReviewer = () => {
      if (
        session.state().config.permissionPreset !== "smart" ||
        getReviewer() !== undefined ||
        warnedMissingReviewer
      )
        return;
      warnedMissingReviewer = true;
      const message = "未设置安全审查，去 /settings 设置";
      warnings.push(message);
      session.emitEphemeral("runtime.warning", { code: "permission_reviewer_missing", message });
    };
    warnMissingReviewer();

    // gate 按会话持有：等待中的权限请求与会话绑定，respondPermission 按会话路由；
    // 经委托读取当前 policy，使 setPermissionPreset 立即生效
    const gate: PermissionGate = createPolicyGate(
      { evaluate: (subjects, evaluationOptions) => policy.evaluate(subjects, evaluationOptions) },
      {
        interactive: sessionInteractive,
        ...(unattendedSession ? { nonInteractiveDenyHint: UNATTENDED_DENY_HINT } : {}),
        preset: () => session.state().config.permissionPreset,
        reviewer: () => {
          warnMissingReviewer();
          return getReviewer();
        },
        cwd: meta.cwd,
        ...reviewSources,
        caseSensitive: platform.caseSensitivePaths,
        grants: { session: sessionGrants, project: ws?.grants },
        hooks: hookRunner,
      },
    );
    // 提问通道（ADR-0032）按会话持有：等待中的请求与会话绑定，
    // respondQuestion 按 requestId 路由；非交互时 ask 立即不可用
    const questions = createQuestionBroker({ interactive: sessionInteractive });
    // 会话级工具注册表：内置工具 ∪ MCP 工具（mcp.md 第 4、5 节）。
    // MCP 服务器在会话打开时并行启动；list_changed / 重连带来的工具集变化
    // 先暂存，在 submit() 的 Turn 边界经 applyPendingTools() 应用。
    const tools: ToolRegistry = createToolRegistry();
    // ADR-0064 第 7 节：定时任务发起的会话不提供改写定时任务的工具（按特性，不按名字）
    for (const tool of builtinTools()) {
      if (meta.schedule !== undefined && tool.traits.mutatesSchedule === true) continue;
      tools.register(tool);
    }
    const loadedSkills = new Map<string, string>();
    const installSkills = () => {
      catalog = skillCatalog(
        skillDiscovery.skills,
        config?.disabledSkills() ?? [],
        model.model.contextWindow,
        "session-model",
      );
      tools.unregister("skill");
      if (catalog.text) {
        const enabled = skillDiscovery.skills.map((s, i) => ({ ...s, ...catalog.skills[i] }));
        tools.register(
          createSkillTool(
            enabled,
            () =>
              session
                .state()
                .history.filter((h) => h.kind === "compaction" && h.compactKind === "summary")
                .length,
            loadedSkills,
          ),
        );
      }
    };
    let pendingSkillRescan = false;
    let pendingSkillEnable = false;
    const applySkills = async () => {
      if (!pendingSkillRescan && !pendingSkillEnable) return;
      if (pendingSkillRescan)
        skillDiscovery = await skillCache.discover({
          nocturneHome,
          workspaceRoot: meta.workspaceRoot,
          cwd: meta.cwd,
          config: config?.skillConfig(),
        });
      pendingSkillRescan = false;
      pendingSkillEnable = false;
      installSkills();
      policy = buildPolicy(session.state().config.permissionPreset);
    };
    const refreshSessionSkills = async (rescan: boolean) => {
      pendingSkillRescan ||= rescan;
      pendingSkillEnable = true;
      if (!busy() && compactController === undefined) await applySkills();
    };
    const executor = createToolExecutor(tools);

    // MCP：RuntimeOptions.mcpServers（注入）∪ 配置层 mcpServers（项目层仅信任时并入）
    const mcpServerConfigs: McpServerConfig[] = [
      ...(options.mcpServers ?? []),
      ...(resolved?.mcpServers ?? []).map((s) => ({
        ...s.entry,
        name: s.name,
        origin: s.origin,
        dir: s.dir,
      })),
    ].filter((s) => s.enabled !== false);
    let mcpSession: McpSession | undefined;
    let pendingMcp = false;
    let mcpUpdate: Promise<void> = Promise.resolve();
    let mcpOnDemand = false;
    let omittedMcpToolCount = 0;
    const registeredMcpNames = new Set<string>();
    const warnedMcpConflicts = new Set<string>();

    const syncMcpToolsRegistry = (): void => {
      for (const name of registeredMcpNames) {
        tools.unregister(name);
      }
      registeredMcpNames.clear();
      tools.unregister(MCP_SEARCH_TOOL_NAME);
      tools.unregister(MCP_CALL_TOOL_NAME);

      const currentMcpTools = mcpSession?.tools() ?? [];
      const mode =
        config?.resolvedSettings(meta.workspaceRoot).mcpToolSearch ??
        resolved?.mcpToolSearch ??
        options.mcpToolSearch ??
        "auto";
      mcpOnDemand = shouldEnableMcpToolSearch(currentMcpTools, mode);
      if (mcpOnDemand) {
        omittedMcpToolCount = currentMcpTools.length;
        const readyServers = [
          ...new Set([
            ...mcpServerConfigs.map((s) => s.name),
            ...(mcpSession?.status() ?? []).filter((s) => s.state === "ready").map((s) => s.name),
          ]),
        ];
        const pair = createMcpOnDemandTools(currentMcpTools, readyServers);
        tools.register(pair.searchTool);
        tools.register(pair.callTool);
      } else {
        omittedMcpToolCount = 0;
        for (const tool of currentMcpTools) {
          try {
            tools.register(tool);
            registeredMcpNames.add(tool.name);
          } catch (e) {
            if (!warnedMcpConflicts.has(tool.name)) {
              warnedMcpConflicts.add(tool.name);
              session.emitEphemeral("runtime.warning", {
                code: "mcp_tool_conflict",
                message: `MCP 工具 ${tool.name} 注册失败：${e instanceof Error ? e.message : String(e)}`,
              });
            }
          }
        }
      }
    };

    if (mcpServerConfigs.length > 0 || options.mcp !== undefined) {
      if (options.mcp === undefined) {
        warnings.push(
          `已配置 ${mcpServerConfigs.length} 个 MCP 服务器，但 Runtime 未注入 MCP 连接器（RuntimeOptions.mcp），相关工具不可用`,
        );
      } else {
        try {
          mcpSession = await options.mcp.open({
            servers: mcpServerConfigs,
            cwd: meta.cwd,
            workspaceRoot: meta.workspaceRoot,
            sessionId: session.id,
            platform,
            credentials: config?.credentials,
            emitServer: (p) => session.emitEphemeral("mcp.server", p),
            warn: (code, message) => session.emitEphemeral("runtime.warning", { code, message }),
            diagnostics,
          });
          const opened = mcpSession;
          // MCP 服务器进程树清理（mcp.md 第 5 节）；失败只警告不阻塞关闭
          teardown.push(async () => {
            await mcpUpdate.catch(() => undefined);
            try {
              await opened.close();
            } catch (e) {
              session.emitEphemeral("runtime.warning", {
                code: "mcp_close_failed",
                message: `MCP 关闭异常：${e instanceof Error ? e.message : String(e)}`,
              });
            }
          });
          syncMcpToolsRegistry();
        } catch (e) {
          warnings.push(`MCP 装配失败：${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }

    const applyMcp = (): Promise<void> => {
      mcpUpdate = mcpUpdate
        .catch(() => undefined)
        .then(async () => {
          if (mcpSession === undefined) return;
          if (pendingMcp) {
            pendingMcp = false;
            const next = config
              ? (await config.forWorkspace(meta.workspaceRoot)).resolved.mcpServers
              : [];
            await mcpSession.reconcile([
              ...(options.mcpServers ?? []),
              ...next.map((s) => ({ ...s.entry, name: s.name, origin: s.origin, dir: s.dir })),
            ]);
          }
          const diff = mcpSession.applyPendingTools();
          for (const name of diff.remove) {
            warnedMcpConflicts.delete(name);
          }
          syncMcpToolsRegistry();
        });
      return mcpUpdate;
    };
    const refreshMcp = async (): Promise<void> => {
      pendingMcp = true;
      if (!busy()) await applyMcp();
    };
    /**
     * 等待 MCP 更新链（applyMcp 串行队列）结束；收到中止立即放弃等待。
     * 不取消后台 reconcile：它继续跑完，结果在下一次 Turn 边界照常应用（mcp.md 第 4 节）。
     * 未中止时语义不变：失败仍拒绝并向调用侧传播。
     */
    const awaitMcpIdle = (signal: AbortSignal): Promise<void> => {
      const work = applyMcp();
      if (signal.aborted) {
        void work.catch(() => undefined);
        return Promise.resolve();
      }
      return new Promise<void>((resolve, reject) => {
        const onAbort = (): void => {
          void work.catch(() => undefined);
          resolve();
        };
        signal.addEventListener("abort", onAbort, { once: true });
        work.then(
          () => {
            signal.removeEventListener("abort", onAbort);
            resolve();
          },
          (error: unknown) => {
            signal.removeEventListener("abort", onAbort);
            reject(error instanceof Error ? error : new Error(String(error)));
          },
        );
      });
    };

    // shell 子进程环境剥离的凭据变量（provider-setup.md 第 4 节第 2 条）：
    // 全部 Provider 条目声明的 apiKeyEnv + NOCTURNE_API_KEY /
    // ANTHROPIC_API_KEY 两个默认名——模型驱动的 shell 拿不到密钥。
    // 数组原地更新：updateProviders 后 rebuildProviders 重算同一引用，
    // execEnv/scope 无需重挂
    const computeShellEnvStrip = (
      providers: readonly { apiKeyEnv?: string | undefined }[],
    ): string[] => [
      ...new Set([
        "NOCTURNE_API_KEY",
        "ANTHROPIC_API_KEY",
        // 桌面浏览器启动凭证：后台入口读出即删，shell / 外部进程再拿不到
        "NOCTURNE_DESKTOP_BROWSER_BOOTSTRAP",
        ...Object.values(JEV_ENDPOINTS).map((entry) => entry.env),
        ...(() => {
          const reviewer =
            config?.resolvedSettings(meta.workspaceRoot).permissionReviewer ??
            resolved?.permissionReviewer;
          return reviewer?.backend === "jev" && "env" in reviewer.credential
            ? [reviewer.credential.env]
            : [];
        })(),
        ...providers
          .map((p) => p.apiKeyEnv)
          .filter((n): n is string => n !== undefined && n !== ""),
      ]),
    ];
    const shellEnvStrip = computeShellEnvStrip([
      ...(resolved?.providers ?? []),
      ...(options.providerConfigs ?? []),
    ]);
    const execEnv: ExecutionEnvironment = {
      checkpoint: createCheckpointRecorder(session, platform, sessionsDir),
      platform,
      gate,
      readState: createReadStateStore(paths),
      attachmentsDir: paths.join(sessionsDir, "attachments"),
      // ADR-0023：会话级图片附件存储；B/C 阶段共用同一实例（C 阶段
      // Agent Loop 经 execEnv 取回字节投影进模型请求）
      attachments: createAttachmentStore({
        fs,
        paths,
        attachmentsDir: paths.join(sessionsDir, "attachments"),
        sessionId: session.id,
      }),
      hooks: hookRunner,
      diagnostics,
      shellEnvStrip,
      // ADR-0022：延迟解析——每次工具调用组装 scope 时取当前生效 shell
      shell: shellResolver,
      // ADR-0032：声明 needsUser 的工具经此提问；与权限层相互独立
      askUser: questions,
      // ADR-0064：schedule 工具经此读写任务（校验在 Runtime 一侧）
      schedule: scheduleAccess,
    };
    const turnConfig: TurnConfig = { ...DEFAULT_TURN_CONFIG };
    for (const src of [resolved?.turn, options.turn]) {
      if (src?.maxSteps !== undefined) turnConfig.maxSteps = src.maxSteps;
      if (src?.retryLimit !== undefined) turnConfig.retryLimit = src.retryLimit;
      if (src?.retryBaseDelayMs !== undefined) turnConfig.retryBaseDelayMs = src.retryBaseDelayMs;
      if (src?.firstEventTimeoutMs !== undefined)
        turnConfig.firstEventTimeoutMs = src.firstEventTimeoutMs;
      if (src?.idleTimeoutMs !== undefined) turnConfig.idleTimeoutMs = src.idleTimeoutMs;
      // ADR-0063：重复调用保护（false 关闭；缺省 DEFAULT_LOOP_GUARD）
      if (src?.loopGuard !== undefined) turnConfig.loopGuard = src.loopGuard;
    }

    const resolveSessionModel = (ref: ModelRef): ResolvedModel => sessionRegistry.resolve(ref);
    const unavailableRoles = new Set<string>();
    const warnUnavailableRoles = (
      roles: Partial<Record<ModelRole, string | undefined>> | undefined,
    ): void => {
      for (const role of MODEL_ROLES) {
        const ref = roles?.[role];
        const key = `${role}/${ref}`;
        if (ref !== undefined && resolveModelRole(sessionRegistry, ref, role) === undefined) {
          if (unavailableRoles.has(key)) continue;
          unavailableRoles.add(key);
          const message = `模型角色 ${role} 的模型 ${ref} 不可用，按未配置处理`;
          warnings.push(message);
          session.emitEphemeral("runtime.warning", { code: "model_role_unavailable", message });
        } else {
          unavailableRoles.delete(key);
        }
      }
    };
    warnUnavailableRoles(resolved?.modelRoles);
    let model: ResolvedModel;
    let providersDirty = false;
    /**
     * updateProviders 触发的会话级注册表重建（provider-setup.md 第 6 节）：
     * 在下一次空闲边界（submit / setModel 开头）执行；当前会话正在使用的
     * 服务商若已从配置移除，保留其实例并发出 runtime.warning。
     */
    const rebuildProviders = async (): Promise<void> => {
      if (!providersDirty || config === undefined) return;
      providersDirty = false;
      const wsNew = await config.forWorkspace(meta.workspaceRoot).catch(() => undefined);
      const entries = wsNew?.resolved.providers ?? config.base.providers;
      reviewerKey = undefined;
      // 凭据变量剥离名单随配置重算：向导/手写条目新增的 apiKeyEnv 即时生效
      shellEnvStrip.splice(
        0,
        shellEnvStrip.length,
        ...computeShellEnvStrip([...entries, ...(options.providerConfigs ?? [])]),
      );
      // 当前会话正在使用的 Provider 实例保留在最底层：新配置同 id 覆盖，
      // 配置里消失时旧实例继续供本会话使用（不重启会话、不换锁）
      const inUse = model.provider;
      sessionRegistry = buildRegistry(entries, [inUse]);
      warnUnavailableRoles(wsNew?.resolved.modelRoles ?? config.base.modelRoles);
      if (!entries.some((e) => e.id === inUse.id)) {
        session.emitEphemeral("runtime.warning", {
          code: "provider_in_use",
          message: `服务商 "${inUse.id}" 已从配置移除；本会话继续使用原实例直至结束`,
        });
      }
      try {
        model = resolveSessionModel(session.state().config.model);
        installSkills();
      } catch {
        /* 保留当前可用实例，模型错误仍由下一轮发送路径报告。 */
      }
      // 档位表依赖设置与模型可用性：同一空闲边界重建
      installTask();
    };
    /**
     * 档位就近降档提示（ADR-0018 第 4 节）：会话记录的档位在目标模型
     * 的可用集合中不存在时，发送侧按 clamp 生效——这里发出可见警告；
     * 写入侧不改动（回到旧模型自动恢复原档）。
     */
    const warnIfEffortClamped = (m: ModelInfo): void => {
      const stored = session.state().config.reasoningEffort;
      if (stored === undefined || stored === "off") return;
      const clamped = clampReasoningEffort(stored, m.capabilities.reasoningEffort);
      if (clamped === stored) return;
      session.emitEphemeral("runtime.warning", {
        code: "reasoning_effort_clamped",
        message:
          clamped === undefined
            ? `模型 ${m.ref.provider}/${m.ref.model} 没有可用思考档位，本会话思考档位视为 off`
            : `思考档位 ${stored} 在模型 ${m.ref.provider}/${m.ref.model} 不可用，就近降为 ${clamped}`,
      });
    };
    /**
     * 限额未声明（ADR-0016 2026-10-25 修订）：
     * - 只写真正缺失的项（缺上下文写「上下文按 128000 估算」，缺最大输出写「输出预留按 8192 估算」）；
     * - 只缺最大输出且模型所属协议适配器不会按兜底值发出 max_tokens（requiresMaxOutputTokens !== true）时，
     *   不发会话警告（/context 仍标注）。
     */
    const warnIfCapabilitiesDefaulted = (m: ModelInfo): void => {
      const missingContext = m.contextWindow === undefined;
      const missingMaxOutput = m.maxOutputTokens === undefined;
      if (!missingContext && (!missingMaxOutput || m.requiresMaxOutputTokens !== true)) return;
      const missing: string[] = [];
      const estimates: string[] = [];
      if (missingContext) {
        missing.push("上下文窗口");
        estimates.push(`上下文按 ${CONTEXT_WINDOW_FALLBACK} 估算`);
      }
      if (missingMaxOutput) {
        missing.push("最大输出长度");
        estimates.push(`输出预留按 ${MAX_OUTPUT_FALLBACK} 估算`);
      }
      session.emitEphemeral("runtime.warning", {
        code: "model_capabilities_defaulted",
        message:
          `模型 ${m.ref.provider}/${m.ref.model} 的${missing.join("与")}未由上游或配置声明，` +
          `本地预算按默认值估算（${estimates.join("，")}）；` +
          `可运行 /provider refresh ${m.ref.provider} 或在 config.json 的 models 中声明`,
      });
    };
    try {
      model = resolveSessionModel(session.state().config.model);
      // ADR-0054 §3：恢复会话时会话模型已停用与「未知模型」同路——没有替代
      // 模型时以 invalid_model 拒绝，带替代模型时先写 config_changed 再打开。
      if (resume !== undefined && model.model.disabled !== undefined) {
        throw new DisabledSessionModelError(model.model);
      }
      // ADR-0026 §5：新建会话选到不可用模型即拒绝；恢复会话对协议不可识别
      // 的模型允许打开（不可用由下一轮 submit 在发请求前以同一说明结束）。
      if (resume === undefined && model.model.unavailable !== undefined) {
        throw invalidModelError(model.model.unavailable.reason, model.model);
      }
      warnIfCapabilitiesDefaulted(model.model);
      warnIfEffortClamped(model.model);
    } catch (e) {
      // 会话记录的模型无法解析：携带替代模型时先写 config_changed 再开放（sessions.md 4.2）
      if (
        (e instanceof UnknownModelError || e instanceof DisabledSessionModelError) &&
        resume?.modelOverride !== undefined
      ) {
        const ref = parseModelRef(resume.modelOverride);
        let replacement: ResolvedModel;
        try {
          replacement = resolveSessionModel(ref);
        } catch (inner) {
          throw new RuntimeCommandError(
            "invalid_model",
            `替代模型同样无法解析：${inner instanceof Error ? inner.message : String(inner)}`,
          );
        }
        // 替代模型是显式选择：不可用（含已停用）同样拒绝（ADR-0026 §5、ADR-0054）
        if (replacement.model.unavailable !== undefined) {
          throw invalidModelError(replacement.model.unavailable.reason, replacement.model);
        }
        await session.emit("session.config_changed", { model: ref });
        model = replacement;
        warnIfCapabilitiesDefaulted(replacement.model);
      } else if (e instanceof DisabledSessionModelError) {
        throw invalidModelError(
          resume !== undefined ? `${e.message}；恢复时可指定替代模型` : e.message,
          e.model,
        );
      } else if (e instanceof UnknownModelError) {
        throw new RuntimeCommandError(
          "invalid_model",
          resume !== undefined ? `${e.message}；恢复时可指定替代模型` : e.message,
        );
      } else {
        throw e;
      }
    }

    installSkills();
    // 外部 agent 仅在根会话可用；恢复的子会话也不能暴露外部委派入口。
    const externalConnector = meta.parent === undefined ? options.externalAgents : undefined;
    let enabledExternalAgents: ExternalAgentConfig[] = [];
    let pendingExternalAgents = false;
    const unavailableProfiles = new Set<string>();

    // 子代理（subagent.md 第 3 节）：launcher 捕获本会话装配上下文；
    // task 与内置工具同一注册表——Agent Loop 无工具名分支
    const installTask = (): void => {
      enabledExternalAgents =
        externalConnector === undefined
          ? []
          : structuredClone(
              (config?.base.externalAgents ?? [])
                .filter((agent) => agent.enabled)
                .map(({ origin: _origin, path: _path, ...agent }) => agent),
            );
      const agentSnapshot = enabledExternalAgents;
      const configuredProfiles =
        config?.resolvedSettings(session.state().meta.workspaceRoot).subagentProfiles ?? {};
      const profileSnapshot = Object.entries(configuredProfiles).flatMap(([name, profile]) => {
        if (
          !profile.enabled ||
          agentSnapshot.some((agent) => agent.name.toLowerCase() === name.toLowerCase())
        )
          return [];
        const key = `${name}/${profile.model}`;
        if (
          profile.model !== undefined &&
          resolveModelRole(sessionRegistry, profile.model, "task") === undefined
        ) {
          // 与 model_role_unavailable 同一模式：进 session.warnings 并去重，空闲边界重新评估
          if (!unavailableProfiles.has(key)) {
            unavailableProfiles.add(key);
            const message = `子代理档位 ${name} 的模型 ${profile.model} 不可用，已排除`;
            warnings.push(message);
            session.emitEphemeral("runtime.warning", {
              code: "subagent_profile_unavailable",
              message,
            });
          }
          return [];
        }
        unavailableProfiles.delete(key);
        return [{ ...profile, name }];
      });
      const hasExternalAgents = enabledExternalAgents.length > 0;
      tools.unregister("task");
      if (!subagentEnabled && !hasExternalAgents) return;
      let launcher: SubagentLauncher | undefined;
      if (subagentEnabled)
        launcher = createSubagentLauncher({
          checkpoint: execEnv.checkpoint,
          store,
          sessionsDir,
          platform,
          diagnostics,
          instructions,
          environment,
          profiles: profileSnapshot,
          resolveProfile: (name, currentModel) =>
            resolveSubagentProfile(
              name,
              configuredProfiles,
              (ref) => resolveModelRole(sessionRegistry, ref, "task"),
              currentModel ?? model,
              resolveModelRole(
                sessionRegistry,
                config?.resolvedSettings(session.state().meta.workspaceRoot).modelRoles?.task,
                "task",
              ) ??
                currentModel ??
                model,
            ),
          model: () =>
            resolveModelRole(
              sessionRegistry,
              config?.resolvedSettings(session.state().meta.workspaceRoot).modelRoles?.task,
              "task",
            ) ?? model,
          permissionPreset: () => session.state().config.permissionPreset,
          visionModel: () =>
            resolveModelRole(
              sessionRegistry,
              config?.resolvedSettings(session.state().meta.workspaceRoot).modelRoles?.vision,
              "vision",
            ),
          reviewer: getReviewer,
          reviewSources,
          // 子会话继承父会话的思考档位（ADR-0018 §4；受子模型可用档位约束，
          // 就近降档在 launcher 内完成）
          reasoningEffort: () => session.state().config.reasoningEffort,
          compactionThreshold: () =>
            config?.resolvedSettings(session.state().meta.workspaceRoot).compactionThreshold,
          compactionPruneLimit: () =>
            config?.resolvedSettings(session.state().meta.workspaceRoot).compactionPruneLimit,
          nocturneVersion: options.version ?? NOCTURNE_VERSION,
          turnConfig,
          parentFailedSignal: session.failedSignal,
          // ADR-0031 §3：本会话即根会话（depth 0 launcher 只挂在顶层会话上），
          // 嵌套子代理沿 deps 透传同一个根 ID
          rootSessionId: session.id,
          makePolicy: (childSessionId) =>
            buildPolicy(session.state().config.permissionPreset, childSessionId),
          makeHookRunner,
          mcpTools: () => mcpSession?.tools() ?? [],
          mcpOnDemand: () => mcpOnDemand,
          mcpServers: () => [
            ...new Set([
              ...mcpServerConfigs.map((s) => s.name),
              ...(mcpSession?.status() ?? []).filter((s) => s.state === "ready").map((s) => s.name),
            ]),
          ],
          skills: () => ({
            ...catalog,
            entries: skillDiscovery.skills.map((s, i) => ({ ...s, ...catalog.skills[i] })),
          }),
          shellEnvStrip,
          // 子会话与父会话共用同一 shell 解析（ADR-0022）：切换即时生效；
          // 子会话环境信息的 Shell 行在派生时重新生成
          shell: shellResolver,
          shellLine: () => shellResolver.environmentLine(),
          grants: {
            session: sessionGrants,
            ...(ws?.grants !== undefined ? { project: ws.grants } : {}),
          },
          depth: 0,
          limits: subagentLimits,
          limiter: subagentLimiter,
          registry: subagentRegistry,
        });
      const externalRunner =
        hasExternalAgents && externalConnector !== undefined
          ? {
              agents: agentSnapshot,
              async run(
                request: Pick<ExternalAgentRequest, "agent" | "task" | "timeoutMs">,
                ctx: ToolContext,
              ) {
                const agentConfig = agentSnapshot.find((agent) => agent.name === request.agent);
                if (agentConfig === undefined) {
                  const message = `外部 agent ${request.agent} 未启用`;
                  return {
                    status: "error" as const,
                    modelContent: message,
                    error: { code: "invalid_input", message },
                  };
                }
                if (!subagentLimiter.tryAcquire()) {
                  const message = `子代理并发上限已满（${subagentLimits.maxConcurrent}），请稍后重试`;
                  return {
                    status: "error" as const,
                    modelContent: message,
                    error: { code: "subagent_concurrency", message },
                  };
                }
                try {
                  const externalGate = createPolicyGate(
                    {
                      evaluate: (subjects, evaluationOptions) =>
                        buildPolicy(session.state().config.permissionPreset).evaluate(
                          subjects,
                          evaluationOptions,
                        ),
                    },
                    {
                      interactive: false,
                      preset: () => session.state().config.permissionPreset,
                      reviewer: getReviewer,
                      cwd: meta.cwd,
                      ...reviewSources,
                      caseSensitive: platform.caseSensitivePaths,
                      hooks: hookRunner,
                    },
                  );
                  return await externalConnector.run(
                    agentConfig,
                    {
                      ...request,
                      cwd: meta.workspaceRoot,
                      transcriptPath: paths.join(
                        sessionsDir,
                        "attachments",
                        session.id,
                        "external",
                        `${ctx.callId}.jsonl`,
                      ),
                      async requestPermission(requests) {
                        const subjects: PermissionSubject[] = [];
                        for (const subject of requests) {
                          if (
                            (subject.kind === "read" || subject.kind === "edit") &&
                            subject.target === "*"
                          ) {
                            // ACP 没有 location 时资源未知，不能解析为工作区内的字面路径。
                            subjects.push({ ...subject });
                          } else {
                            subjects.push(...(await resolveSubjects([subject], { platform })));
                          }
                        }
                        // 不给 Turn 事件出口和 Grant 落点：只读继承，判定由 connector 审计。
                        const outcome = await externalGate.check(subjects, ctx.callId, ctx.signal);
                        return {
                          decision: outcome.decision.action === "allow" ? "allow" : "deny",
                          source: outcome.decision.source,
                        };
                      },
                    },
                    ctx,
                  );
                } finally {
                  subagentLimiter.release();
                }
              },
            }
          : undefined;
      tools.register(
        createTaskTool(
          launcher,
          externalRunner,
          subagentLimits.timeoutMs,
          profileSnapshot,
          config?.resolvedSettings(session.state().meta.workspaceRoot).modelRoles?.task,
        ),
      );
    };
    const applyExternalAgents = (): void => {
      if (!pendingExternalAgents) return;
      pendingExternalAgents = false;
      installTask();
    };
    const refreshSessionExternalAgents = (): void => {
      pendingExternalAgents = true;
      if (!busy() && compactController === undefined) applyExternalAgents();
    };
    installTask();

    let controller: AbortController | undefined;
    let fileIndexPromise: Promise<FileIndexEntry[]> | undefined;
    let compactController: AbortController | undefined;
    let turnSettled: Promise<void> | undefined;
    let compactSettled: Promise<void> | undefined;
    let closing = false;
    let rewinding = false;
    let rewindSettled: Promise<void> | undefined;
    const changes = createTurnChanges(session, platform, sessionsDir);
    // 进行中 Turn 的档位快照（ADR-0018 §3）：submit 时对持久化意图
    // 就近降档一次，reasoningEffortInfo().effective 据此报告；
    // Turn 中切档只改 current，effective 维持快照至 Turn 结束
    let activeTurnEffort: ReasoningEffort | undefined;

    const assertUsable = () => {
      if (closing) throw new RuntimeCommandError("session_busy", "会话正在关闭");
      if (session.health !== "ok") {
        throw new RuntimeCommandError("session_failed", "会话已处于 failed 状态");
      }
    };
    const busy = () => controller !== undefined || rewinding;
    const validateForkTarget = (targetSeq?: number) => {
      if (
        targetSeq !== undefined &&
        !session.state().history.some((e) => e.kind === "user" && e.seq === targetSeq)
      )
        throw new RuntimeCommandError("invalid_command", "目标不是当前有效对话中的用户消息");
    };

    // SessionStart Hook（hooks.md）：会话打开完成后触发（新建与恢复都算）
    if (hookRunner !== undefined) {
      await hookRunner
        .run("SessionStart", { resumed: resume !== undefined })
        .catch(() => undefined);
    }
    diagnostics.record("session.open", {
      sessionId: session.id,
      cwd: meta.cwd,
      workspaceRoot: meta.workspaceRoot,
      resumed: resume !== undefined,
      mcpStarting: mcpSession?.status().filter((s) => s.state === "starting").length ?? 0,
      durationMs: Date.now() - openedAt,
    });

    const titleController = new AbortController();
    let titleSettled: Promise<void> | undefined;
    const unsubscribeTitle = session.subscribe((event) => {
      if (
        resume !== undefined ||
        meta.parent !== undefined ||
        event.type !== "message.user" ||
        titleSettled !== undefined ||
        session.durableEvents().some((e) => e.type === "session.titled")
      )
        return;
      const titleModel =
        resolveModelRole(
          sessionRegistry,
          config?.resolvedSettings(meta.workspaceRoot).modelRoles?.smol,
          "smol",
        ) ?? model;
      const text = event.payload.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .slice(0, 2000);
      const signal = AbortSignal.any([titleController.signal, session.failedSignal]);
      titleSettled = (async () => {
        const result = await runRoleCall(
          titleModel,
          {
            purpose: "title",
            model: titleModel.model.ref.model,
            protocol: titleModel.model.protocol,
            system: [{ text: "用与用户相同的语言，生成不超过 20 个字的会话标题，只输出标题。" }],
            messages: [{ role: "user", content: [{ type: "text", text }] }],
            tools: [],
            maxOutputTokens: 100,
            sessionId: session.id,
          },
          signal,
          options.turn?.firstEventTimeoutMs,
          options.turn?.idleTimeoutMs,
        );
        const title = cleanTitle(result.text);
        if (!title) throw new Error("标题为空");
        if (signal.aborted || closing) return;
        // 复用 Session 的单一写入通道，与 Turn 保持统一 seq 和先写后发顺序。
        await session.emit("session.titled", {
          title,
          model: `${titleModel.model.ref.provider}/${titleModel.model.ref.model}`,
          ...(result.usage !== undefined ? { usage: result.usage } : {}),
        });
      })().catch((cause: unknown) => {
        diagnostics.record("session.title_failed", {
          sessionId: session.id,
          error: cause instanceof Error ? cause.message : String(cause),
        });
      });
    });

    const forkOpen = async (targetSeq?: number): Promise<string> => {
      assertUsable();
      if (busy() || compactController !== undefined)
        throw new RuntimeCommandError("session_busy", "请先等待或按 Esc 中断");
      validateForkTarget(targetSeq);
      rewinding = true;
      let settle!: () => void;
      rewindSettled = new Promise((resolve) => {
        settle = resolve;
      });
      try {
        await titleSettled;
        return await store.fork(session, targetSeq);
      } finally {
        rewinding = false;
        settle();
      }
    };

    // 最后一步：登记到 Runtime（此后不再有可能失败的步骤）。打开途中错过的配置广播
    // 补成待应用，在下一次 Turn 边界生效
    if (configGeneration !== openGeneration) {
      providersDirty = true;
      pendingMcp = true;
      pendingSkillRescan = true;
      pendingSkillEnable = true;
      pendingExternalAgents = true;
    }
    const runtimeHooks: OpenSessionHooks = {
      shellCurrent: () => shellResolver.current(),
      shellChanged: async (before) => {
        const after = shellResolver.current();
        if (shellSwitched(before, after) && after.descriptor !== undefined) {
          await session.emit("session.config_changed", {
            shell: { kind: after.descriptor.kind, path: after.descriptor.executable },
          });
        }
      },
      markProvidersDirty: () => {
        providersDirty = true;
      },
      currentModel: () => model.model.ref,
      reconcileMcp: refreshMcp,
      refreshSkills: refreshSessionSkills,
      refreshExternalAgents: refreshSessionExternalAgents,
      skillModel: {
        workspaceRoot: meta.workspaceRoot,
        contextWindow: () => model.model.contextWindow,
      },
      fork: forkOpen,
      applyFailed: (scope, error) => {
        const reason = error instanceof Error ? error.message : String(error);
        diagnostics.record("session.config_apply_failed", {
          sessionId: session.id,
          scope,
          error: reason,
        });
        session.emitEphemeral("runtime.warning", {
          code: "config_apply_failed",
          message: `配置已保存，但未能应用到本会话（${scope}）：${reason}`,
        });
      },
    };
    openSessions.set(session.id, runtimeHooks);
    const detach = (): void => {
      if (openSessions.get(session.id) === runtimeHooks) openSessions.delete(session.id);
    };
    teardown.push(detach);
    teardown.push(subagentRegistry.trackSession(session));
    // 只缓存最近一次 describeContext；键覆盖 seq 与不写事件的 Builder 输入。
    // 返回值和缓存各自深拷贝，避免调用者改到缓存或持久历史。
    let contextCache: { key: string; value: BuiltContext } | undefined;
    const runtimeSession: RuntimeSession = {
      describeSkills: () => ({
        skills: catalog.skills,
        budget: catalog.budget,
        warnings: skillDiscovery.warnings,
        scannedDirs: skillDiscovery.scannedDirs,
        homeDir: skillDiscovery.homeDir,
      }),
      describeExternalAgents: async () =>
        config?.describeExternalAgents({ workspaceRoot: meta.workspaceRoot }) ?? {
          agents: [],
          warnings: [],
        },
      id: session.id,
      durableEvents: () => session.durableEvents(),
      async readAttachment(file) {
        assertUsable();
        return readSessionAttachment(
          platform,
          sessionsDir,
          session.id,
          session.durableEvents(),
          file,
        );
      },
      rewindTargets() {
        assertUsable();
        if (busy() || compactController !== undefined)
          throw new RuntimeCommandError("session_busy", "请先等待或按 Esc 中断");
        return rewindTargets(session, platform, sessionsDir);
      },
      turnChanges() {
        assertUsable();
        return changes.changes();
      },
      async turnChangeDiff(seq, path) {
        assertUsable();
        const result = await changes.diff(seq, path);
        if (!result) throw new RuntimeCommandError("invalid_command", "这一轮没有可用的文件差异");
        return result;
      },
      async rewind(targetSeq, mode) {
        assertUsable();
        if (busy() || compactController !== undefined)
          throw new RuntimeCommandError("session_busy", "请先等待或按 Esc 中断");
        if (
          !["both", "conversation", "files"].includes(mode) ||
          !session.state().history.some((e) => e.kind === "user" && e.seq === targetSeq)
        )
          throw new RuntimeCommandError("invalid_command", "目标不是当前有效对话中的用户消息");
        rewinding = true;
        let settle!: () => void;
        rewindSettled = new Promise((resolve) => {
          settle = resolve;
        });
        try {
          const files =
            mode === "conversation"
              ? []
              : await restoreCheckpointFiles(session, platform, sessionsDir, targetSeq);
          await session.emit("session.rewound", { targetSeq, mode, files });
          if (mode !== "files") loadedSkills.clear();
          await session.flush();
          execEnv.readState = createReadStateStore(paths);
          fileIndexPromise = undefined;
          return files;
        } finally {
          rewinding = false;
          settle();
        }
      },
      state: () => session.state(),
      subscribe: (listener) => session.subscribe(listener),
      async readInputHistory() {
        try {
          await historyWrite;
          return await readInputHistory(platform, nocturneHome, meta.workspaceRoot);
        } catch (e) {
          session.emitEphemeral("runtime.warning", {
            code: "input_history_read_failed",
            message: `读取输入历史失败：${e instanceof Error ? e.message : String(e)}`,
          });
          return [];
        }
      },
      recordInputHistory(text) {
        historyWrite = historyWrite
          .then(() => appendInputHistory(platform, nocturneHome, meta.workspaceRoot, text))
          .catch((e: unknown) => {
            session.emitEphemeral("runtime.warning", {
              code: "input_history_write_failed",
              message: `保存输入历史失败：${e instanceof Error ? e.message : String(e)}`,
            });
          });
        return historyWrite;
      },
      fileIndex() {
        assertUsable();
        fileIndexPromise ??= buildFileIndex(fs, paths, meta.workspaceRoot).catch(
          (error: unknown) => {
            fileIndexPromise = undefined;
            throw error;
          },
        );
        return fileIndexPromise;
      },
      async resolveFiles(inputs) {
        assertUsable();
        const root = await fs.realpath(meta.workspaceRoot).catch(() => meta.workspaceRoot);
        return Promise.all(inputs.map((input) => resolveFileRef(fs, paths, root, input)));
      },
      interrupt() {
        controller?.abort();
        // 压缩是 Turn 之外的会话级活动，interrupt 同样中止它
        compactController?.abort();
      },
      async respondPermission(requestId, reply) {
        if ((await gate.respond?.(requestId, reply)) === true) {
          return;
        }
        throw new RuntimeCommandError("unknown_request", "没有等待中的权限请求");
      },
      respondQuestion(requestId, reply) {
        const outcome = questions.respond(requestId, reply);
        if (outcome === "ok") return Promise.resolve();
        if (outcome === "invalid_reply") {
          return Promise.reject(new RuntimeCommandError("invalid_reply", "回复与待回答问题不匹配"));
        }
        return Promise.reject(new RuntimeCommandError("unknown_request", "没有等待中的提问请求"));
      },
      async submit(input) {
        assertUsable();
        if (busy() || compactController !== undefined) {
          throw new RuntimeCommandError("session_busy", "会话正忙（Turn 或压缩进行中）");
        }
        if (input.skill !== undefined && input.delegate !== undefined)
          throw new RuntimeCommandError("invalid_command", "skill 与 delegate 互斥");
        if (input.delegate !== undefined && !delegateSchema.safeParse(input.delegate).success)
          throw new RuntimeCommandError(
            "invalid_command",
            "delegate.agent 和 delegate.task 必须是非空字符串",
          );
        const content: ContentBlock[] = [
          ...(input.content ?? [{ type: "text", text: input.text ?? "" }]),
        ];
        if (
          input.skill &&
          (typeof input.skill.name !== "string" ||
            !input.skill.name.trim() ||
            (input.skill.arguments !== undefined && typeof input.skill.arguments !== "string"))
        )
          throw new RuntimeCommandError(
            "invalid_command",
            "技能 name 必须是非空字符串，arguments 必须是字符串",
          );
        const ac = new AbortController();
        controller = ac;
        let settleTurn!: () => void;
        turnSettled = new Promise<void>((resolve) => {
          settleTurn = resolve;
        });
        // 空闲边界：controller 先置位（busy 语义立即生效），再重建
        // updateProviders 标记的会话级注册表（provider-setup.md 第 6 节）
        try {
          await awaitMcpIdle(ac.signal);
          await rebuildProviders();
          await applySkills();
          applyExternalAgents();
          let delegation: AgentDelegation | undefined;
          if (input.delegate !== undefined) {
            const agent = enabledExternalAgents.find(
              (entry) => entry.name.toLowerCase() === input.delegate?.agent.toLowerCase(),
            );
            if (agent === undefined)
              throw new RuntimeCommandError(
                "invalid_command",
                `外部 agent ${input.delegate.agent} 不存在或未启用`,
              );
            delegation = { agent: agent.name, task: input.delegate.task };
          }
          // ADR-0026 §5：刷新后条目/模型可能变化——原位重解析拿到最新的
          // 协议与不可用标记（失败沿用旧解析，同一错误仍由 stream 路径报告）
          try {
            model = resolveSessionModel(session.state().config.model);
          } catch {
            // 保留旧解析
          }
          // 会话中的模型变为不可用时，本轮在发请求前以说明结束，不发 HTTP
          if (model.model.unavailable !== undefined) {
            throw invalidModelError(model.model.unavailable.reason, model.model);
          }
          const deps: TurnDeps = {
            prepareTools: async (signal) => {
              if (mcpSession?.status().some((s) => s.state === "starting")) {
                const started = Date.now();
                await mcpSession.startup(signal);
                diagnostics.record("mcp.startup_wait", {
                  sessionId: session.id,
                  durationMs: Date.now() - started,
                  aborted: signal.aborted,
                });
              }
              // Turn 边界恢复尝试（mcp.md 第 4 节）：对 failed 且已过冷却的 HTTP
              // 服务器并行重连一次，最多等 3 秒，超时后台继续；工具仍由随后的
              // awaitMcpIdle → applyPendingTools 在本次边界统一切换。
              if (!signal.aborted) await mcpSession?.prepareTurn?.(signal);
              if (!signal.aborted) await awaitMcpIdle(signal);
            },
            skills: catalog,
            visionModel: () =>
              resolveModelRole(
                sessionRegistry,
                config?.resolvedSettings(session.state().meta.workspaceRoot).modelRoles?.vision,
                "vision",
              ),
            compactionThreshold: config?.resolvedSettings(session.state().meta.workspaceRoot)
              .compactionThreshold,
            compactionPruneLimit: config?.resolvedSettings(session.state().meta.workspaceRoot)
              .compactionPruneLimit,
            session,
            model,
            tools,
            executor,
            execEnv,
            instructions,
            environment,
            config: turnConfig,
            signal: ac.signal,
          };
          // 与 runTurn 入口快照同源：同一瞬时、同一输入（持久化意图 ×
          // 本模型可用集合）——report 给 reasoningEffortInfo().effective
          activeTurnEffort =
            clampReasoningEffort(
              session.state().config.reasoningEffort,
              model.model.capabilities.reasoningEffort,
            ) ?? "off";
          const attachments = [];
          for (const att of input.attachments ?? []) {
            const mimeType = sniffImageMime(att.data);
            const size = mimeType === undefined ? undefined : parseImageSize(att.data, mimeType);
            if (
              mimeType !== att.mimeType ||
              size === undefined ||
              att.data.byteLength > IMAGE_MAX_BYTES ||
              size.width > IMAGE_MAX_EDGE ||
              size.height > IMAGE_MAX_EDGE
            ) {
              throw new RuntimeCommandError("invalid_command", "图片格式或尺寸不符合要求");
            }
            if (execEnv.attachments === undefined) {
              throw new RuntimeCommandError("invalid_command", "附件存储不可用");
            }
            attachments.push(await execEnv.attachments.save({ ...att, source: "paste" }));
          }
          const refs = await resolveFileRefs(content, {
            fs: platform.fs,
            paths: platform.paths,
            cwd: session.state().meta.cwd,
            workspaceRoot: session.state().meta.workspaceRoot,
            readState: execEnv.readState,
            attachments: execEnv.attachments,
            imageInput: model.model.capabilities.imageInput || deps.visionModel?.() !== undefined,
            signal: ac.signal,
          });
          for (const message of refs.warnings) {
            session.emitEphemeral("runtime.warning", { code: "file_reference", message });
          }
          let skillSnapshot: SkillSnapshot | undefined;
          const invocation = input.skill;
          if (invocation) {
            const overview = catalog.skills.find(
              (s) => s.name.toLowerCase() === invocation.name.toLowerCase() && !s.shadowedBy,
            );
            const source = skillDiscovery.skills.find((s) => s.entryPath === overview?.entryPath);
            if (
              !overview ||
              !source ||
              !overview.enabled ||
              overview.commandConflict ||
              overview.fields["user-invocable"] === false
            )
              throw new RuntimeCommandError(
                "invalid_command",
                `技能 ${invocation.name} 不能由用户调用`,
              );
            const body = renderSkill(
              source.body,
              overview,
              invocation,
              meta.workspaceRoot,
              session.id,
            );
            skillSnapshot = { name: overview.name, body };
            const escaped = overview.name
              .replace(/&/g, "&amp;")
              .replace(/"/g, "&quot;")
              .replace(/</g, "&lt;");
            refs.content.push({
              type: "text",
              text: `<skill name="${escaped}">\n${body}\n</skill>`,
            });
          }
          if (delegation !== undefined) {
            refs.content.push({
              type: "text",
              text:
                "用户明确要求委派给指定的外部 agent。请调用 task 工具，" +
                `agent 设为 ${JSON.stringify(delegation.agent)}，将下面的任务原文作为 task 参数，不要改写；` +
                "不要设置 preset、tools 或 outputSchema。委派入口仍遵循正常权限流程。\n任务原文：\n" +
                delegation.task,
            });
          }
          const reason = await runTurn(
            deps,
            refs.content,
            [...attachments, ...refs.attachments],
            refs.fileRefs,
            skillSnapshot,
            delegation,
          );
          if (reason === "failed") {
            throw new RuntimeCommandError("session_failed", "会话持久化失败");
          }
          return reason;
        } finally {
          if (controller === ac) controller = undefined;
          await applySkills().catch((error: unknown) =>
            session.emitEphemeral("runtime.warning", {
              code: "skills_reload_failed",
              message: `技能目录更新失败：${error instanceof Error ? error.message : String(error)}`,
            }),
          );
          const mcpFlush = applyMcp().catch(() =>
            session.emitEphemeral("runtime.warning", {
              code: "mcp_server_failed",
              message: "MCP 热更新失败，请重新加载配置",
            }),
          );
          // 已中止的 Turn 不等重配收尾：后台 reconcile 继续跑，结果下一 Turn 应用；
          // 失败告警仍挂在同一 Promise 上照常发出。
          if (ac.signal.aborted) void mcpFlush;
          else await mcpFlush;
          applyExternalAgents();
          fileIndexPromise = undefined;
          activeTurnEffort = undefined;
          turnSettled = undefined;
          settleTurn();
        }
      },
      async setModel(input) {
        assertUsable();
        if (busy() || compactController !== undefined) {
          throw new RuntimeCommandError("session_busy", "会话正忙，不能切换模型");
        }
        await rebuildProviders();
        const ref = parseModelRef(input);
        let resolved: ResolvedModel;
        try {
          resolved = resolveSessionModel(ref);
        } catch (e) {
          if (e instanceof UnknownModelError) {
            throw new RuntimeCommandError("invalid_model", e.message);
          }
          throw e;
        }
        // Provider 声明了模型清单且启用严格校验时，模型名必须在清单内
        // （events.md：未知 model → invalid_model）
        const declared = resolved.provider.models();
        if (
          resolved.provider.strictModels !== false &&
          declared.length > 0 &&
          !declared.some((m) => m.ref.model === ref.model)
        ) {
          throw new RuntimeCommandError(
            "invalid_model",
            `Provider ${ref.provider} 未声明模型 ${ref.model}`,
          );
        }
        // ADR-0026 §5：不可用模型选中即拒绝（模型页照常列出但不可请求）
        if (resolved.model.unavailable !== undefined) {
          throw invalidModelError(resolved.model.unavailable.reason, resolved.model);
        }
        await session.emit("session.config_changed", { model: ref });
        model = resolved;
        installSkills();
        warnIfCapabilitiesDefaulted(resolved.model);
        warnIfEffortClamped(resolved.model);
        // recent-models.json（provider-setup.md 第 6 节）：写入失败不阻塞切换
        void config?.recordRecentModel(ref).catch((e: unknown) => {
          diagnostics.record("config.recent_models_write_failed", {
            error: e instanceof Error ? e.message : String(e),
          });
        });
      },
      async setPermissionPreset(name) {
        name = normalizePermissionPreset(name);
        assertUsable();
        // ADR-0036 修订：Turn/压缩进行中也可切换，下一次权限求值起按新预设；
        // 已在等待确认的请求由 gate 持有、保持原样
        await rebuildProviders();
        if (!isPermissionPresetName(name)) {
          throw new RuntimeCommandError(
            "invalid_command",
            `未知权限预设：${name}（可选：read-only | default | auto-edit | guarded | smart | bypass）`,
          );
        }
        await session.emit("session.config_changed", { permissionPreset: name });
        policy = buildPolicy(name);
        warnMissingReviewer();
      },
      shellInfo() {
        const res = shellResolver.current();
        return {
          selected: res.selected,
          source: res.source,
          ...(res.descriptor !== undefined
            ? {
                effective: {
                  kind: res.descriptor.kind,
                  name: res.descriptor.name,
                  path: res.descriptor.executable,
                },
              }
            : {}),
          ...(res.error !== undefined ? { error: res.error } : {}),
          ...(res.overriddenBy !== undefined ? { overriddenBy: res.overriddenBy } : {}),
        };
      },
      listShells() {
        return shellResolver.list();
      },
      visionInfo() {
        // ADR-0054：与提交走同一个重建入口的同步版本——会话级注册表只在空闲边界
        // 重建（rebuildProviders），热停用后到下一次提交前是旧的。这里按重建相同的
        // 组成（当前合并层条目 + 在用实例保留 + 最新停用集合）现场重建再解析，
        // 停用后立刻反映；listModels/defaultModel 同为每次现算（读同一来源）。
        const root = session.state().meta.workspaceRoot;
        const resolved = config?.resolvedSettings(root);
        const fresh = buildRegistry(resolved?.providers ?? [], [model.provider]);
        const vision = resolveModelRole(fresh, resolved?.modelRoles?.vision, "vision");
        return {
          imageInput: model.model.capabilities.imageInput,
          available: vision !== undefined,
          model:
            vision !== undefined
              ? `${vision.model.ref.provider}/${vision.model.ref.model}`
              : undefined,
        };
      },
      async setShell(kind) {
        assertUsable();
        const { before, after } = await changeShell(shellResolver, kind, async (normalized) => {
          if (config !== undefined) {
            await config.setShellSetting(normalized ?? "auto");
            memoryShellSpec = undefined;
          } else {
            memoryShellSpec = { kind: normalized };
          }
        });
        await runtimeHooks.shellChanged(before);
        if (after.overriddenBy !== undefined) {
          session.emitEphemeral("runtime.warning", {
            code: "shell_overridden",
            message: `shell 已写入 settings.json，但当前由 ${
              after.overriddenBy === "env" ? "NOCTURNE_SHELL" : "config.json"
            } 指定，移除上层设置后才会生效`,
          });
        }
      },
      async setReasoningEffort(level) {
        assertUsable();
        // ADR-0018：允许 Turn 进行中调用，只改持久化意图、下一个 Turn
        // 生效（本 Turn 请求沿用 submit 时的快照）；
        // 空闲边界顺手应用 updateProviders 的注册表重建（档位集合随之刷新）
        await rebuildProviders();
        const normalized = level.trim().toLowerCase();
        if (!isReasoningEffort(normalized)) {
          throw new RuntimeCommandError(
            "invalid_command",
            `未知思考档位：${level}（可选：${REASONING_EFFORT_ORDER.join(" | ")}）`,
          );
        }
        if (providersDirty) {
          // rebuild 后模型条目可能变化：原模型原位重解析（失败则沿用旧解析，
          // 错误仍由下一次 submit/setModel 的解析路径报告）
          try {
            model = resolveSessionModel(session.state().config.model);
          } catch {
            // 保留旧解析
          }
        }
        const available = model.model.capabilities.reasoningEffort ?? [];
        if (normalized !== "off" && !available.includes(normalized)) {
          throw new RuntimeCommandError(
            "invalid_command",
            `模型 ${model.model.ref.provider}/${model.model.ref.model} 未声明档位 ${normalized}` +
              `（可用：${available.length > 0 ? available.join(" | ") : "无"}；off 恒可用）`,
          );
        }
        await session.emit("session.config_changed", { reasoningEffort: normalized });
      },
      reasoningEffortInfo() {
        const available = model.model.capabilities.reasoningEffort ?? [];
        const current =
          clampReasoningEffort(session.state().config.reasoningEffort, available) ?? "off";
        return { current, effective: activeTurnEffort ?? current, available: [...available] };
      },
      async compact() {
        assertUsable();
        if (busy()) {
          throw new RuntimeCommandError("session_busy", "Turn 运行中，不能压缩");
        }
        if (compactController !== undefined) {
          throw new RuntimeCommandError("compaction_in_progress", "已有压缩在进行中");
        }
        const ac = new AbortController();
        compactController = ac;
        let settleCompact!: () => void;
        compactSettled = new Promise<void>((resolve) => {
          settleCompact = resolve;
        });
        session.emitEphemeral("runtime.status", { status: "compacting" });
        try {
          await rebuildProviders();
          // ADR-0054：会话模型被停用时压缩同样不可用（与 submit 同一说明，不发 HTTP）
          try {
            model = resolveSessionModel(session.state().config.model);
          } catch {
            // 保留旧解析；解析失败由下方 unavailable 检查或请求路径报告
          }
          if (model.model.unavailable !== undefined) {
            throw invalidModelError(model.model.unavailable.reason, model.model);
          }
          const events = session.durableEvents();
          const history = session.state().history;
          const attachmentData = new Map<string, string>();
          for (const ref of attachmentsToLoad(history, model.model, events)) {
            const bytes = await execEnv.attachments?.load(ref);
            if (bytes !== undefined)
              attachmentData.set(ref.sha256, Buffer.from(bytes).toString("base64"));
          }
          const plan = buildContext({
            skills: catalog,
            history,
            todos: session.state().todos,
            model: model.model,
            tools: tools.specs(model.model.capabilities.editTool),
            instructions,
            environment,
            events,
            attachmentData,
            // ADR-0063：压缩计划的预算与 Turn 内一致（只影响说明的计入）
            loopGuard: turnConfig.loopGuard,
            compactionState: { force: true, summaryOnly: true },
          }).compaction;
          if (plan?.summaryRequest === undefined) {
            throw new RuntimeCommandError(
              "compaction_failed",
              "没有可行的压缩边界（历史为空、最新摘要之后没有新内容，或摘要请求在任何边界下都装不进窗口）",
            );
          }
          const request = { ...plan.summaryRequest, sessionId: session.id };
          // context.md 6.6：摘要请求只尝试一轮，不嵌套压缩
          const summaryResult = await runSummaryCall(
            model,
            request,
            ac.signal,
            turnConfig.firstEventTimeoutMs,
            turnConfig.idleTimeoutMs,
          );
          await session.emit(
            "context.compacted",
            {
              kind: "summary",
              throughSeq: plan.throughSeq,
              ...summaryResult,
              model: model.model.ref,
            },
            {},
          );
        } catch (e) {
          if (ac.signal.aborted) {
            // 中断：不写任何事件，历史不变（context.md 6.6）
            throw new RuntimeCommandError("compaction_interrupted", "压缩被中断");
          }
          if (e instanceof RuntimeCommandError) throw e;
          if (e instanceof SessionError) {
            throw new RuntimeCommandError("session_failed", e.message);
          }
          throw new RuntimeCommandError(
            "compaction_failed",
            e instanceof Error ? e.message : String(e),
          );
        } finally {
          compactController = undefined;
          await applySkills().catch((error: unknown) =>
            session.emitEphemeral("runtime.warning", {
              code: "skills_reload_failed",
              message: `技能目录更新失败：${error instanceof Error ? error.message : String(error)}`,
            }),
          );
          applyExternalAgents();
          session.emitEphemeral("runtime.status", { status: "idle" });
          compactSettled = undefined;
          settleCompact();
        }
      },
      warnings,
      recovery: session.recovery,
      describeContext() {
        const events = session.durableEvents();
        const specs = tools.specs(model.model.capabilities.editTool);
        const resolved = config?.resolvedSettings(environment.workspaceRoot);
        const compactionThreshold = resolved?.compactionThreshold;
        const compactionPruneLimit = resolved?.compactionPruneLimit;
        const key = JSON.stringify({
          seq: events.at(-1)?.seq,
          model: model.model,
          tools: specs,
          omittedMcpToolCount,
          skills: catalog,
          instructions,
          environment,
          compactionThreshold,
          compactionPruneLimit,
          loopGuard: turnConfig.loopGuard ?? DEFAULT_LOOP_GUARD,
        });
        if (contextCache?.key === key) return structuredClone(contextCache.value);
        const state = session.state();
        const value = buildContext({
          skills: catalog,
          compactionThreshold,
          compactionPruneLimit,
          omittedMcpTools: omittedMcpToolCount,
          loopGuard: turnConfig.loopGuard,
          history: state.history,
          todos: state.todos,
          model: model.model,
          tools: specs,
          instructions,
          environment,
          events,
        });
        contextCache = { key, value: structuredClone(value) };
        return structuredClone(contextCache.value);
      },
      mcpServers() {
        return mcpSession?.status() ?? [];
      },
      async close() {
        detach();
        closing = true;
        unsubscribeTitle();
        titleController.abort();
        controller?.abort();
        compactController?.abort();
        gate.cancelAll?.();
        questions.cancelAll();
        await Promise.all([turnSettled, compactSettled, titleSettled, rewindSettled]);
        // SessionEnd Hook（hooks.md）：清理开始前运行；失败已在 runner 内降级
        if (hookRunner !== undefined) {
          await hookRunner.run("SessionEnd", { reason: "close" }).catch(() => undefined);
        }
        // 与打开失败共用的撤销步骤：Runtime 级登记、MCP 连接
        await runTeardown();
        await session.close();
      },
    };
    // 内部 Session 句柄只留给各包测试：非导出 Symbol 键，不在 RuntimeSession 类型里
    Object.defineProperty(runtimeSession, INTERNAL_SESSION, { value: session });
    return runtimeSession;
  }

  function requireMcpConfig(): RuntimeConfig {
    if (!config) throw new McpSettingsError("config", "未注入 RuntimeConfig");
    return config;
  }
  async function reloadMcpConfig(): Promise<void> {
    config = await requireMcpConfig().reload();
    registry = buildRegistry(config.base.providers);
    await applyConfigToSessions();
  }
  function mcpInput<T>(schema: z.ZodType<T>, input: unknown): T {
    const parsed = schema.safeParse(input);
    if (!parsed.success)
      throw new McpSettingsError(String(parsed.error.issues[0]?.path[0] ?? "config"), "字段无效");
    return parsed.data;
  }
  function requireExternalAgentConfig(): RuntimeConfig {
    if (!config) throw new ExternalAgentSettingsError("config", "未注入 RuntimeConfig");
    return config;
  }
  function externalAgentInput<T>(schema: z.ZodType<T>, input: unknown): T {
    const parsed = schema.safeParse(input);
    if (!parsed.success)
      throw new ExternalAgentSettingsError(
        String(parsed.error.issues[0]?.path[0] ?? "config"),
        "字段无效",
      );
    return parsed.data;
  }
  const workspaceField = z.string().min(1).optional();
  const idFields = z.object({ id: z.string().min(1), workspaceRoot: workspaceField });

  // ── 定时任务（ADR-0064，schedule.md）：调度器是独立模块，这里只装配「开会话并提交」 ──
  const scheduleListeners = new Set<(payload: ScheduleChangedPayload) => void>();
  const scheduleStore = createScheduleStore({ platform, home: nocturneHome });
  const pad2 = (n: number): string => String(n).padStart(2, "0");
  const WEEKDAY_NAMES = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  const shortStamp = (ms: number): string => {
    const d = new Date(ms);
    return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  };
  const plannedStamp = (ms: number): string => {
    const d = new Date(ms);
    return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${WEEKDAY_NAMES[d.getDay()]} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  };
  /** 补跑时用户消息开头附一行原计划时间（效果图 C）；桌面端据此识别并弱化显示 */
  const catchupPrefix = (scheduledAt: number): string =>
    `原计划 ${plannedStamp(scheduledAt)}，当时 Nocturne 没开，现在补跑。\n`;

  async function runScheduledTask(task: ScheduledTask, ctx: RunContext): Promise<RunOutcome> {
    const root = task.workspace ?? workspaceRoot;
    const rootStat = await fs.stat(root).catch(() => undefined);
    if (rootStat?.type !== "directory") throw new Error("workspace_missing");
    await config?.forWorkspace(root);
    const model = task.model ?? runtime.defaultModel({ workspaceRoot: root });
    if (model === undefined) throw new Error("no_model");
    const startedAt = Date.now();
    let session: RuntimeSession;
    try {
      session = await runtime.createSession({
        model,
        cwd: task.workspace ?? cwd,
        workspaceRoot: root,
        ...(task.permissionPreset !== undefined ? { permissionPreset: task.permissionPreset } : {}),
        ...(task.reasoningEffort !== undefined ? { reasoningEffort: task.reasoningEffort } : {}),
        interactive: false,
        schedule: {
          taskId: task.id,
          scheduledAt: new Date(ctx.scheduledAt).toISOString(),
          trigger: ctx.trigger,
        },
      });
    } catch (e) {
      throw e instanceof RuntimeCommandError ? new Error(e.code) : e;
    }
    try {
      ctx.onSession(session.id);
      // 侧栏标题：「任务名 · 月-日 时:分」；写了 session.titled 就不再让模型生成标题
      const internal = (session as unknown as Record<symbol, Session>)[INTERNAL_SESSION];
      const ref = session.state().config.model;
      await internal?.emit("session.titled", {
        title: `${task.name} · ${shortStamp(ctx.trigger === "catchup" ? startedAt : ctx.scheduledAt)}`,
        model: `${ref.provider}/${ref.model}`,
      });
      const text =
        ctx.trigger === "catchup" ? `${catchupPrefix(ctx.scheduledAt)}${task.prompt}` : task.prompt;
      const submitted = session.submit({ text });
      // submit 同步置位 controller，之后的 interrupt 一定落在这一轮上
      const onAbort = (): void => {
        session.interrupt();
      };
      if (ctx.signal.aborted) onAbort();
      else ctx.signal.addEventListener("abort", onAbort, { once: true });
      let reason: TurnEndReason;
      try {
        reason = await submitted;
      } finally {
        ctx.signal.removeEventListener("abort", onAbort);
      }
      const events = session.durableEvents();
      const denied = events.filter(
        (e) => e.type === "permission.resolved" && e.payload.source === "non_interactive",
      ).length;
      if (reason === "done") return { result: "done", denied };
      if (reason === "aborted") return { result: "aborted", denied };
      const completed = events.findLast((e) => e.type === "turn.completed");
      const code = completed?.type === "turn.completed" ? completed.payload.error?.code : undefined;
      return { result: "error", error: code ?? reason, denied };
    } finally {
      await session.close().catch(() => undefined);
    }
  }

  const scheduler = createScheduler({
    platform,
    home: nocturneHome,
    store: scheduleStore,
    enabled: options.scheduler === true,
    runner: { run: runScheduledTask },
    onChanged: (payload) => {
      for (const listener of scheduleListeners) {
        try {
          listener(payload);
        } catch {
          // 监听方的错误不影响调度
        }
      }
    },
    warn: (code, message) => {
      sinkWarnings.push({ code, message });
      diagnostics.record("schedule.warning", { code, message });
    },
  });
  const scheduleModelCheck = (input: ScheduleSaveInput): void => {
    if (input.model === undefined || typeof input.model !== "string") return;
    const root = workspaceRoot;
    const known = (
      config !== undefined ? buildRegistry(config.resolvedSettings(root).providers) : registry
    )
      .providers()
      .flatMap((p) => p.models())
      .some((m) => `${m.ref.provider}/${m.ref.model}` === input.model);
    if (!known) throw new ScheduleError("model", `模型 ${input.model} 不可用`);
  };
  // Runtime 的 schedule.* 方法与会话里的 schedule 工具共用同一入口
  const scheduleAccess: ScheduleAccess = {
    list: () => scheduler.list(),
    async save(input) {
      // 模型没变就不重新校验：服务商或模型之后被停用时，暂停、改计划这类无关的修改仍要能保存
      const current =
        input.id !== undefined
          ? (await scheduler.list()).tasks.find((t) => t.id === input.id)
          : undefined;
      if (current === undefined || current.model !== input.model) scheduleModelCheck(input);
      return await scheduler.save(input);
    },
    async remove(id) {
      await scheduler.remove(id);
    },
  };

  const runtime: Runtime = {
    listSchedules: () => scheduleAccess.list(),
    saveSchedule: (input) => scheduleAccess.save(input),
    deleteSchedule: (input) => scheduleAccess.remove(input.id),
    runSchedule: (input) => scheduler.runNow(input.id),
    scheduleHistory: (input) => scheduler.history(input.id),
    onScheduleChanged(listener) {
      scheduleListeners.add(listener);
      return () => {
        scheduleListeners.delete(listener);
      };
    },
    stopScheduler: () => scheduler.stop(),
    describeMcpServers: (input = {}) =>
      requireMcpConfig().describeMcpServers(
        mcpInput(z.object({ workspaceRoot: workspaceField }), input),
      ),
    describeExternalAgents: (input = {}) =>
      requireExternalAgentConfig().describeExternalAgents(
        externalAgentInput(z.object({ workspaceRoot: workspaceField }).strict(), input),
      ),
    async saveExternalAgent(input) {
      const parsed = externalAgentInput(
        z
          .object({
            mode: z.enum(["create", "replace"]),
            name: z.string().min(1),
            config: z.unknown(),
          })
          .strict(),
        input,
      );
      const operation = settingsPending.then(async () => {
        const entry = validateExternalAgentConfig({
          ...(typeof parsed.config === "object" && parsed.config !== null ? parsed.config : {}),
          name: parsed.name,
        });
        const result = await requireExternalAgentConfig().saveExternalAgent({
          ...parsed,
          config: entry,
        });
        await reloadMcpConfig();
        return result;
      });
      settingsPending = operation.then(
        () => undefined,
        () => undefined,
      );
      return operation;
    },
    async deleteExternalAgent(input) {
      const parsed = externalAgentInput(z.object({ name: z.string().min(1) }).strict(), input);
      const operation = settingsPending.then(async () => {
        await requireExternalAgentConfig().deleteExternalAgent(parsed);
        await reloadMcpConfig();
      });
      settingsPending = operation.catch(() => undefined);
      return operation;
    },
    async setExternalAgentEnabled(input) {
      const parsed = externalAgentInput(
        z.object({ name: z.string().min(1), enabled: z.boolean() }).strict(),
        input,
      );
      const operation = settingsPending.then(async () => {
        await requireExternalAgentConfig().setExternalAgentEnabled(parsed);
        await reloadMcpConfig();
      });
      settingsPending = operation.catch(() => undefined);
      return operation;
    },
    async probeExternalAgent(input) {
      const parsed = externalAgentInput(
        z.union([
          z.object({ name: z.string().min(1) }).strict(),
          z.object({ config: z.unknown() }).strict(),
        ]),
        input,
      );
      let entry: ExternalAgentConfig;
      if ("name" in parsed) {
        const description = await requireExternalAgentConfig().describeExternalAgents();
        const agent = description.agents.find(
          (candidate) => candidate.name.toLowerCase() === parsed.name.toLowerCase(),
        );
        if (agent === undefined)
          throw new ExternalAgentSettingsError("name", `外部 agent ${parsed.name} 不存在`);
        entry = validateExternalAgentConfig({
          name: agent.name,
          command: agent.command,
          args: agent.args,
          env: agent.env,
          mode: agent.mode,
          configOptions: agent.configOptions,
          description: agent.description,
          enabled: agent.enabled,
        });
      } else {
        entry = validateExternalAgentConfig(parsed.config);
      }
      if (options.externalAgents === undefined)
        return {
          ok: false,
          durationMs: 0,
          configOptions: [],
          error: { code: "external_agent_unavailable", message: "未注入外部 agent connector" },
        };
      return options.externalAgents.probe(entry, { nocturneHome });
    },
    async describeSkills(input = {}) {
      const parsed = z.object({ workspaceRoot: z.string().min(1).optional() }).parse(input);
      const root = parsed.workspaceRoot
        ? await platform.resolveReal(parsed.workspaceRoot)
        : workspaceRoot;
      const current = [...openSessions.values()]
        .map((hooks) => hooks.skillModel)
        .find((s) => paths.equals(s.workspaceRoot, root));
      const window =
        current?.contextWindow() ??
        (() => {
          try {
            const ref = config?.base.model;
            return ref ? registry.resolve(parseModelRef(ref)).model.contextWindow : undefined;
          } catch {
            return undefined;
          }
        })();
      const discovery = await skillCache.discover({
        nocturneHome,
        workspaceRoot: root,
        cwd: root,
        config: config?.skillConfig(),
      });
      const result = skillCatalog(
        discovery.skills,
        config?.disabledSkills() ?? [],
        window,
        current ? "session-model" : "default-model",
      );
      return { ...discovery, skills: result.skills, budget: result.budget };
    },
    async setSkillEnabled(input) {
      const parsed = z
        .object({ name: z.string().trim().min(1), enabled: z.boolean() })
        .strict()
        .parse(input);
      if (!config) throw new RuntimeCommandError("invalid_command", "技能开关需要配置存储");
      await config.setSkillEnabled(parsed.name, parsed.enabled);
      return { affectedSessions: await broadcast("skills", (hooks) => hooks.refreshSkills(false)) };
    },
    async importSkills(input) {
      const base = z.object({
        mode: z.enum(["preview", "commit"]),
        target: z.enum(["user", "project"]),
        workspaceRoot: z.string().min(1).optional(),
      });
      const parsed = z
        .discriminatedUnion("mode", [
          base.extend({
            mode: z.literal("preview"),
            sourceDir: z.string().min(1),
            decisions: z.never().optional(),
          }),
          base.extend({
            mode: z.literal("commit"),
            sourceDir: z.never().optional(),
            decisions: z
              .array(
                z.object({
                  sourcePath: z.string().min(1),
                  name: z.string().min(1).optional(),
                  action: z.enum(["rename", "overwrite", "skip"]),
                }),
              )
              .min(1),
          }),
        ])
        .parse(input) as SkillImportInput;
      const root =
        parsed.workspaceRoot !== undefined
          ? await platform.resolveReal(parsed.workspaceRoot)
          : workspaceRoot;
      const targetDir =
        parsed.target === "user"
          ? paths.join(nocturneHome, "skills")
          : paths.join(root, ".nocturne/skills");
      if (parsed.mode === "preview") {
        const preview = await previewSkillImport(platform, {
          sourceDir: parsed.sourceDir,
          target: parsed.target,
          nocturneHome,
          workspaceRoot: root,
          cwd: root,
          config: config?.skillConfig(),
        });
        return {
          mode: "preview",
          targetDir: preview.targetDir,
          targetLayer: preview.targetLayer,
          candidates: preview.candidates,
        };
      }
      const results = await commitSkillImport(platform, {
        targetDir,
        decisions: parsed.decisions,
      });
      const affectedSessions = await broadcast("skills", (hooks) => hooks.refreshSkills(true));
      return { mode: "commit", targetDir, results, affectedSessions };
    },
    async saveMcpServer(input) {
      const parsed = mcpInput(
        z.object({
          mode: z.enum(["create", "replace"]),
          id: z.string().min(1),
          config: z.unknown(),
          secrets: z.record(z.string(), z.union([z.string(), z.null()])).optional(),
          workspaceRoot: workspaceField,
        }),
        input,
      );
      const operation = settingsPending.then(async () => {
        const result = await requireMcpConfig().saveMcpServer({
          ...parsed,
          config: validateMcpEntry(parsed.config),
        });
        await reloadMcpConfig();
        return result;
      });
      settingsPending = operation.then(
        () => undefined,
        () => undefined,
      );
      return operation;
    },
    async deleteMcpServer(input) {
      const parsed = mcpInput(idFields, input);
      const operation = settingsPending.then(async () => {
        await requireMcpConfig().deleteMcpServer(parsed);
        await reloadMcpConfig();
      });
      settingsPending = operation.catch(() => undefined);
      return operation;
    },
    async setMcpServerEnabled(input) {
      const parsed = mcpInput(idFields.extend({ enabled: z.boolean() }), input);
      const operation = settingsPending.then(async () => {
        await requireMcpConfig().setMcpServerEnabled(parsed);
        await reloadMcpConfig();
      });
      settingsPending = operation.catch(() => undefined);
      return operation;
    },
    async probeMcpServer(input) {
      const parsed = mcpInput(
        z.union([
          idFields.strict(),
          z
            .object({
              config: z.unknown(),
              secrets: z.record(z.string(), z.union([z.string(), z.null()])).optional(),
              workspaceRoot: workspaceField,
              credentialServerId: z.string().min(1).optional(),
            })
            .strict(),
        ]),
        input,
      );
      const cfg = requireMcpConfig();
      const root = parsed.workspaceRoot ?? workspaceRoot;
      let entry;
      let id = "draft";
      let secrets: Record<string, string | null> = {};
      if ("id" in parsed) {
        id = parsed.id;
        const overview = (await cfg.describeMcpServers({ workspaceRoot: root })).servers.find(
          (s) => s.id === id,
        );
        if (!overview?.trusted)
          throw new McpSettingsError("id", "服务器不存在或项目未信任，无法探测");
        entry = (await cfg.forWorkspace(root)).resolved.mcpServers.find(
          (s) => s.name === id,
        )?.entry;
        if (!entry) throw new McpSettingsError("id", "服务器不存在");
      } else {
        entry = validateMcpEntry(parsed.config);
        secrets = parsed.secrets ?? {};
        if (parsed.credentialServerId) {
          const server = (await cfg.describeMcpServers({ workspaceRoot: root })).servers.find(
            (s) => s.id === parsed.credentialServerId,
          );
          if (!server?.editable || !server.trusted)
            throw new McpSettingsError("id", "只能引用程序管理服务器的凭据");
          id = server.id;
        }
      }
      if (!options.mcp) throw new McpSettingsError("config", "MCP 连接器不可用");
      if (
        cfg.credentials.backend() === "none" &&
        Object.values(entry.type === "http" ? (entry.headers ?? {}) : (entry.env ?? {})).some(
          (value) => typeof value !== "string",
        )
      )
        throw new McpSettingsError("secrets", "系统凭据后端不可用，请引用环境变量");
      const probeEntry = entry;
      return options.mcp.probe({
        servers: [{ ...entry, name: id, origin: "app" }],
        cwd: root,
        workspaceRoot: root,
        sessionId: "probe",
        platform,
        credentials: {
          get: (key) => {
            const name = key.slice(`mcp/${id}/`.length);
            const value = Object.entries(secrets).find(
              ([k]) => (probeEntry.type === "http" ? k.toLowerCase() : k) === name,
            )?.[1];
            return value !== undefined || !("id" in parsed || parsed.credentialServerId)
              ? Promise.resolve(value ?? undefined)
              : cfg.credentials.get(key, { fresh: true });
          },
        },
        emitServer: () => undefined,
        warn: () => undefined,
      });
    },
    describeModelRoles(input) {
      const root = input?.workspaceRoot ?? workspaceRoot;
      const settings = config?.describeSettings(root) ?? [];
      const rolesRegistry = buildRegistry(config?.resolvedSettings(root).providers ?? []);
      return MODEL_ROLES.map((role) => {
        const item = settings.find((s) => s.key === `modelRoles.${role}`);
        const resolved = resolveModelRole(rolesRegistry, item?.effective, role);
        return {
          role,
          configured: item?.effective,
          model: resolved
            ? `${resolved.model.ref.provider}/${resolved.model.ref.model}`
            : undefined,
          source: item?.source ?? "default",
          available: resolved !== undefined,
        };
      });
    },
    async setModelRole(role, ref, setOptions) {
      if (!MODEL_ROLES.includes(role))
        throw new RuntimeCommandError("invalid_command", `未知模型角色：${role}`);
      if (config === undefined) throw new Error("未注入 RuntimeConfig，无法保存模型角色");
      const root = setOptions?.workspaceRoot ?? workspaceRoot;
      if (
        ref !== null &&
        resolveModelRole(
          buildRegistry((await config.forWorkspace(root)).resolved.providers),
          ref,
          role,
        ) === undefined
      )
        throw new RuntimeCommandError("invalid_model", `模型角色 ${role} 的模型 ${ref} 不可用`);
      await config.setModelRole(role, ref);
      return config.describeSettings(root);
    },
    describeSettings: (input) => {
      const root = input?.workspaceRoot ?? workspaceRoot;
      const settings = config?.describeSettings(root, platform.env("NOCTURNE_SHELL")) ?? [];
      const models =
        config !== undefined ? buildRegistry(config.resolvedSettings(root).providers) : registry;
      return settings.map((item) => {
        if (
          item.effective === undefined ||
          (item.key !== "defaultModel" && !item.key.startsWith("modelRoles."))
        )
          return item;
        try {
          const disabled = models.resolve(parseModelRef(item.effective)).model.disabled;
          return disabled === undefined ? item : { ...item, disabled };
        } catch {
          return item;
        }
      });
    },
    async listShells(input) {
      return (await runtimeShellResolver(input?.workspaceRoot ?? workspaceRoot)).list();
    },
    readFile(input) {
      return readLocalFile(fs, paths, input);
    },
    async setShellSetting(kind, input) {
      if (config === undefined) throw new Error("未注入 RuntimeConfig，无法保存 Shell");
      const settingsConfig = config;
      const root = input?.workspaceRoot ?? workspaceRoot;
      const resolver = await runtimeShellResolver(root);
      const before = [...openSessions.values()].map((hooks) => ({
        hooks,
        shell: hooks.shellCurrent(),
      }));
      await changeShell(resolver, kind, (value) => settingsConfig.setShellSetting(value ?? "auto"));
      await Promise.all(before.map(({ hooks, shell }) => hooks.shellChanged(shell)));
      return config.describeSettings(root, platform.env("NOCTURNE_SHELL"));
    },
    listReviewerProviders: async (input) =>
      (await config?.describeProviders(input?.workspaceRoot ?? workspaceRoot)) ?? [],
    async defaultReviewer(endpoint, baseURL, input) {
      return defaultJevReviewer(
        endpoint,
        (await config?.describeProviders(input?.workspaceRoot ?? workspaceRoot)) ?? [],
        baseURL,
      );
    },
    async listReviewerModels(reviewer, signal, input) {
      validateSettingsPatch({ "permission.reviewer": reviewer });
      const providers = config
        ? (await config.forWorkspace(input?.workspaceRoot ?? workspaceRoot)).resolved.providers
        : (options.providerConfigs ?? []);
      return fetchJevModels(
        resolveJevConnection(reviewer, providers, reviewerCredentials(providers), (name) =>
          platform.env(name),
        ),
        JEV_ENDPOINTS[reviewer.endpoint].model,
        signal,
        JEV_ENDPOINTS[reviewer.endpoint].modelFilter,
      );
    },
    listReviewerSamples: () =>
      REVIEWER_SAMPLES.map(({ id, title, expect }) => ({ id, title, expect })),
    async testReviewerSample(sampleId, signal, input) {
      if (config === undefined) throw new Error("未注入 RuntimeConfig，无法读取审查器设置");
      const sample = REVIEWER_SAMPLES.find((item) => item.id === sampleId);
      if (sample === undefined)
        throw new RuntimeCommandError("invalid_command", `未知的审查样例 ${sampleId}`);
      const root = input?.workspaceRoot ?? workspaceRoot;
      await config.forWorkspace(root);
      const settings = config.resolvedSettings(root);
      const selected = settings.permissionReviewer;
      if (selected === undefined || selected.backend === "off")
        throw new RuntimeCommandError("invalid_command", "安全审查未配置或已关闭");
      let reviewer: SecurityReviewer;
      if (selected.backend === "jev") {
        reviewer = createJevSecurityReviewer({
          ...resolveJevConnection(
            selected,
            settings.providers,
            reviewerCredentials(settings.providers),
            (name) => platform.env(name),
          ),
          sessionId: "reviewer-samples",
        });
      } else {
        const resolvedReviewer = buildRegistry(settings.providers).resolve(selected.model);
        if (resolvedReviewer.model.unavailable !== undefined)
          throw invalidModelError(
            resolvedReviewer.model.unavailable.reason,
            resolvedReviewer.model,
          );
        reviewer = createModelSecurityReviewer(resolvedReviewer, "reviewer-samples");
      }
      const timeout = AbortSignal.timeout(30_000);
      const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
      const started = Date.now();
      try {
        const [result] = await runReviewerSamples(reviewer, [sample], combined, {
          cwd: root,
          environment: { workspaceRoot: root, nocturneHome },
          ...(settings.permissionReviewerRules !== undefined
            ? { reviewerRules: settings.permissionReviewerRules }
            : {}),
        });
        if (result === undefined) throw new Error("审查没有返回结果");
        return result;
      } catch (error) {
        if (signal?.aborted === true) throw error;
        // 超时：与生产路径一致，按交人记录
        return {
          id: sample.id,
          title: sample.title,
          expected: sample.expect,
          actual: "ask",
          match: sample.expect === "ask",
          durationMs: Date.now() - started,
          reason: timeout.aborted ? "审查超时（30 秒）" : "审查失败",
        };
      }
    },
    updateSettings(patch, settingsOptions) {
      const operation = settingsPending.then(async () => {
        if (config === undefined) throw new Error("未注入 RuntimeConfig，无法保存设置");
        validateSettingsPatch(patch);
        const root = settingsOptions?.workspaceRoot ?? workspaceRoot;
        await config.forWorkspace(root);
        const roleRegistry = buildRegistry(config.resolvedSettings(root).providers);
        for (const role of MODEL_ROLES) {
          const ref = patch[`modelRoles.${role}`];
          if (ref != null && resolveModelRole(roleRegistry, ref, role) === undefined)
            throw new RuntimeCommandError("invalid_model", `模型角色 ${role} 的模型 ${ref} 不可用`);
        }
        const previousKey =
          settingsOptions?.reviewerKey !== undefined
            ? await config.credentials.get("reviewer")
            : undefined;
        if (settingsOptions?.reviewerKey !== undefined) {
          const reviewer = patch["permission.reviewer"];
          if (
            reviewer?.backend !== "jev" ||
            !("stored" in reviewer.credential) ||
            settingsOptions.reviewerKey.trim() === ""
          )
            throw new Error("单独密钥只用于凭据库存储的 Jev 审查器");
          await config.setCredential("reviewer", settingsOptions.reviewerKey);
        }
        try {
          await config.updateSettings(patch);
        } catch (error) {
          if (settingsOptions?.reviewerKey !== undefined) {
            if (previousKey !== undefined) await config.setCredential("reviewer", previousKey);
            else await config.credentials.delete("reviewer");
          }
          throw error;
        }
        await broadcast("providers", (hooks) => {
          hooks.markProvidersDirty();
        });
        return config.describeSettings(root);
      });
      settingsPending = operation.then(
        () => undefined,
        () => undefined,
      );
      return operation;
    },
    async setDefaultModel(model, effort, setOptions) {
      if (config === undefined) throw new Error("未注入 RuntimeConfig，无法保存默认模型");
      const root = setOptions?.workspaceRoot ?? workspaceRoot;
      const resolved = buildRegistry((await config.forWorkspace(root)).resolved.providers).resolve(
        parseModelRef(model),
      );
      // ADR-0054 §3：默认模型不能指向已停用模型（停用后按未设置处理，不再新设）
      if (resolved.model.unavailable !== undefined) {
        throw invalidModelError(resolved.model.unavailable.reason, resolved.model);
      }
      const levels = resolved.model.capabilities.reasoningEffort ?? [];
      if (effort !== null && effort !== "off" && !levels.includes(effort)) {
        throw new RuntimeCommandError(
          "invalid_command",
          `模型不支持档位 ${effort}（可选：${["off", ...levels].join(" | ")}）`,
        );
      }
      await config.setDefaultModel(model, effort);
      return config.describeSettings(root);
    },
    async createSession(opts) {
      // 会话级工作区（ADR-0051）：未指定目录时保留 Runtime 的 cwd 和工作区根
      const sessionCwd = opts.cwd !== undefined ? paths.resolve(opts.cwd, ".") : cwd;
      const sessionRoot = await platform.resolveReal(
        opts.workspaceRoot ?? (opts.cwd !== undefined ? sessionCwd : workspaceRoot),
      );
      const defaults =
        config !== undefined ? (await config.forWorkspace(sessionRoot)).resolved : undefined;
      const preset = normalizePermissionPreset(
        opts.permissionPreset ?? defaults?.permissionPreset ?? DEFAULT_PERMISSION_PRESET,
      );
      if (!isPermissionPresetName(preset)) {
        throw new RuntimeCommandError(
          "invalid_command",
          `未知权限预设：${preset}（可选：read-only | default | auto-edit | guarded | smart | bypass）`,
        );
      }
      // 模型解析在 wrapSession 内进行（会话级注册表含项目层条目）；
      // 失败时关闭已创建的会话，避免遗留打开的日志
      const initialEffort = opts.reasoningEffort ?? defaults?.reasoningEffort;
      if (initialEffort !== undefined && !isReasoningEffort(initialEffort)) {
        throw new RuntimeCommandError(
          "invalid_command",
          `未知思考档位：${initialEffort}（可选：${REASONING_EFFORT_ORDER.join(" | ")}）`,
        );
      }
      const session = await store.create({
        cwd: sessionCwd,
        workspaceRoot: sessionRoot,
        model: parseModelRef(opts.model),
        permissionPreset: preset,
        nocturneVersion: options.version ?? NOCTURNE_VERSION,
        ...(initialEffort !== undefined ? { reasoningEffort: initialEffort } : {}),
        ...(opts.schedule !== undefined ? { schedule: opts.schedule } : {}),
      });
      try {
        const wrapped = await wrapSession(session, undefined, opts.interactive === false);
        // recent-models.json：新建会话记录初始模型（provider-setup.md 第 6 节）
        void config?.recordRecentModel(session.state().config.model).catch((e: unknown) => {
          diagnostics.record("config.recent_models_write_failed", {
            error: e instanceof Error ? e.message : String(e),
          });
        });
        return wrapped;
      } catch (e) {
        await session.close().catch(() => undefined);
        throw e;
      }
    },
    async resumeSession(id, resumeOpts) {
      const session = await store.load(id, { force: resumeOpts?.force });
      try {
        return await wrapSession(session, { modelOverride: resumeOpts?.model });
      } catch (e) {
        await session.close().catch(() => undefined);
        throw e;
      }
    },
    listSessions: (filter) => store.list(filter),
    listSubagents: (input) => subagentObservation.list(input),
    observeSubagent: (input, observer) => subagentObservation.observe(input, observer),
    readSubagentAttachment: (input) => subagentObservation.readAttachment(input),
    usageStats,
    async forkSession(id, forkOptions) {
      const open = openSessions.get(id);
      if (open !== undefined) return open.fork(forkOptions?.targetSeq);
      const source = await store.load(id);
      try {
        const target = forkOptions?.targetSeq;
        if (
          target !== undefined &&
          !source.state().history.some((e) => e.kind === "user" && e.seq === target)
        )
          throw new RuntimeCommandError("invalid_command", "目标不是当前有效对话中的用户消息");
        return await store.fork(source, target);
      } finally {
        await source.close();
      }
    },
    listModels: (input) => {
      const disabled = disabledSet();
      const models = (
        config !== undefined
          ? buildRegistry(config.resolvedSettings(input?.workspaceRoot ?? workspaceRoot).providers)
          : registry
      )
        .providers()
        .flatMap((p) => p.models())
        .map((model) => applyDisabled(model, disabled));
      // ADR-0054 §3：默认不返回停用模型（含服务商停用）；服务商页用 includeDisabled
      return input?.includeDisabled === true
        ? models
        : models.filter((model) => model.disabled === undefined);
    },
    async updateProviders(newConfig) {
      // 重建服务商注册表并按会话工作区增量更新 MCP；不动会话日志和 Hook。
      config = newConfig;
      // 配置整体替换后项目指令缓存一并失效（ADR-0051：缓存按工作区存活至本次配置代际）
      instructionCache.clear();
      registry = buildRegistry(newConfig.base.providers);
      await applyConfigToSessions();
    },
    async setProviderEnabled(input) {
      if (config === undefined)
        throw new RuntimeCommandError("invalid_command", "服务商开关需要配置存储");
      const parsed = z
        .object({ provider: z.string().trim().min(1), enabled: z.boolean() })
        .strict()
        .parse(input);
      await config.setProviderEnabled(parsed.provider, parsed.enabled);
      // 写盘成功后重建运行时级注册表；已打开会话在下一空闲边界重解析（不沿用旧实例）
      registry = buildRegistry(config.base.providers);
      await broadcast("providers", (hooks) => {
        hooks.markProvidersDirty();
      });
    },
    async setModelsEnabled(input) {
      if (config === undefined)
        throw new RuntimeCommandError("invalid_command", "模型开关需要配置存储");
      const parsed = z
        .object({
          provider: z.string().trim().min(1),
          models: z.array(z.string().trim().min(1)).min(1),
          enabled: z.boolean(),
        })
        .strict()
        .parse(input);
      await config.setModelsEnabled(parsed.provider, parsed.models, parsed.enabled);
      registry = buildRegistry(config.base.providers);
      await broadcast("providers", (hooks) => {
        hooks.markProvidersDirty();
      });
    },
    describeToggleImpact(input) {
      const provider = z.string().trim().min(1).parse(input.provider);
      const models = input.models;
      const hit = (ref: ModelRef): boolean =>
        models === undefined || models.length === 0
          ? ref.provider === provider
          : ref.provider === provider && models.includes(ref.model);
      let affectedSessions = 0;
      for (const hooks of openSessions.values()) {
        if (hit(hooks.currentModel())) affectedSessions++;
      }
      const roots = new Set([
        workspaceRoot,
        ...[...openSessions.values()].map((hooks) => hooks.skillModel.workspaceRoot),
      ]);
      const settings = [...roots].map((root) => config?.resolvedSettings(root));
      let defaultModel = false;
      const roles = new Set<ModelRole>();
      for (const item of settings) {
        if (item?.model !== undefined && item.model !== "") {
          try {
            defaultModel ||= hit(parseModelRef(item.model));
          } catch {
            // 非法引用：不影响判定
          }
        }
        for (const role of MODEL_ROLES) {
          const ref = item?.modelRoles?.[role];
          if (ref === undefined) continue;
          try {
            if (hit(parseModelRef(ref))) roles.add(role);
          } catch {
            // 非法引用：不影响判定
          }
        }
      }
      return {
        affectedSessions,
        defaultModel,
        roles: MODEL_ROLES.filter((role) => roles.has(role)),
      };
    },
    defaultModel(input) {
      const root = input?.workspaceRoot ?? workspaceRoot;
      const model = config?.resolvedSettings(root).model;
      if (model === undefined || model === "") return undefined;
      let ref: ModelRef;
      try {
        ref = parseModelRef(model);
      } catch {
        return undefined;
      }
      // ADR-0054 §3：停用即不可用——经注册表解析拿 disabled 盖章后按未设置处理
      // （设置值本身保留，重新启用立即恢复；不另设停用集合判定）。
      try {
        const resolved = (
          config !== undefined ? buildRegistry(config.resolvedSettings(root).providers) : registry
        ).resolve(ref);
        return resolved.model.disabled !== undefined ? undefined : ref;
      } catch {
        // 服务商未声明（手写配置指向不存在的条目）：保持原行为照常返回引用，
        // 不可用由使用处（createSession/setModel）拦截。
        return ref;
      }
    },
    listRecentModels: () => config?.recentModels() ?? [],
    getPreference: (key) => config?.getPreference(key),
    setPreference: (key, value) =>
      config !== undefined
        ? config.setPreference(key, value)
        : Promise.reject(new Error("未注入 RuntimeConfig，无法保存偏好")),
  };
  // 调度器在 Runtime 装配完成后启动（启动时先做一次补跑检查）；失败只警告，不让 createRuntime 失败
  if (options.scheduler === true) {
    await scheduler.start().catch((e: unknown) => {
      sinkWarnings.push({
        code: "schedule_start_failed",
        message: `定时任务调度器启动失败：${e instanceof Error ? e.message : String(e)}`,
      });
    });
  }
  for (const w of scheduleStore.warnings)
    sinkWarnings.push({ code: "schedule_config", message: w });
  return runtime;
}

/** 收集用户级与项目级 AGENTS.md（context.md 第 3 节第 3 项） */
async function loadInstructions(
  platform: Platform,
  workspaceRoot: string,
  cwd: string,
): Promise<InstructionSet> {
  const { fs, paths } = platform;

  const readFile = async (source: string): Promise<InstructionFile | undefined> => {
    const stat = await fs.stat(source).catch(() => undefined);
    if (stat?.type !== "file") return undefined;
    const text = await fs.readTextFile(source);
    if (text.length <= INSTRUCTION_FILE_LIMIT) {
      return { source, content: text };
    }
    return { source, content: text.slice(0, INSTRUCTION_FILE_LIMIT), truncated: true };
  };

  const user = await readFile(paths.join(platform.nocturneHome(), "AGENTS.md"));

  // workspaceRoot → cwd 路径上的各级目录（自顶向下）
  const dirs: string[] = [workspaceRoot];
  if (paths.isWithin(cwd, workspaceRoot) && !paths.equals(cwd, workspaceRoot)) {
    const rel = paths.relative(workspaceRoot, cwd);
    let cur = workspaceRoot;
    for (const seg of rel.split(/[\\/]+/).filter((s) => s.length > 0)) {
      cur = paths.join(cur, seg);
      dirs.push(cur);
    }
  } else if (!paths.equals(cwd, workspaceRoot)) {
    dirs.push(cwd);
  }

  const project: InstructionFile[] = [];
  for (const dir of dirs) {
    const file = await readFile(paths.join(dir, "AGENTS.md"));
    if (file !== undefined) project.push(file);
  }
  return { ...(user !== undefined ? { user } : {}), project };
}

// 公共契约类型与工具再导出：客户端只需要 @nocturne/core 与 @nocturne/core/protocol
export * from "./protocol/index.js";
export { McpSettingsError } from "./config/mcp.js";
export { ScheduleError } from "./schedule/index.js";
export type {
  AnthropicConfig,
  ModelInfo,
  ModelRequest,
  OpenAICompatibleConfig,
  Provider,
  ProviderConfig,
  ResolvedModel,
} from "./provider/index.js";
export type { InstructionSet, EnvironmentInfo, BuiltContext } from "./context/index.js";
export * from "./config/index.js";
export type { SessionState, SessionSummary } from "./session/index.js";
export {
  FakeProvider,
  clampReasoningEffort,
  normalizeModelRef,
  type FakeScript,
  type FakeHandler,
} from "./provider/index.js";
// 服务商向导两件套（provider-setup.md 第 6 节）：CLI/TUI 共用
export {
  BUILTIN_MODEL_CATALOG,
  fetchModels,
  listProviderPresets,
  ProviderUpstreamError,
  type FetchModelsRequest,
  type ProviderPreset,
  type UpstreamModelInfo,
} from "./provider/index.js";
export { SessionError } from "./session/index.js";
export {
  createPlatform,
  configureEnvProxy,
  type Clipboard,
  SHELL_KINDS,
  type DetectedShell,
  type PathOps,
  type PipeProcess,
  type PipeSpawnOptions,
  type Platform,
  type ShellKind,
} from "./platform/index.js";
export { IMAGE_MAX_BYTES, IMAGE_MAX_EDGE, parseImageSize, sniffImageMime } from "./tools/image.js";
export { completeFileRefs, type FileCompletion, type FileIndexEntry } from "./tools/file-index.js";
export {
  READ_FILE_MAX_BYTES,
  READ_FILE_TIMEOUT_MS,
  RESOLVE_FILE_TIMEOUT_MS,
  splitCodeRef,
  type FileRefResolution,
  type ParsedFileRef,
  type LocalFileContent,
  type LocalImageMimeType,
} from "./protocol/file-refs.js";
// MCP / Hook 装配点类型（modules.md：注入方是 apps；实现位于 packages/mcp）
export type {
  HookCallInput,
  ExternalAgentConnector,
  ExternalAgentInfo,
  ExternalAgentOutcome,
  ExternalAgentOutput,
  ExternalAgentPermissionDecision,
  ExternalAgentRequest,
  HookInput,
  HookOutput,
  HookRunner,
  McpConnector,
  McpOpenScope,
  McpServerConfig,
  McpServerStatus,
  McpSession,
  McpToolDiff,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from "./tools/index.js";

export type {
  SecurityReviewer,
  ReviewFacts,
  ReviewInput,
  ReviewResult,
  ReviewerRules,
  ReviewSubject,
  ReviewerSample,
  ReviewerSampleContext,
  ReviewerSampleResult,
} from "./permission/index.js";
export {
  decideFromAnswers,
  REVIEWER_SAMPLES,
  runReviewerSamples,
  summarizeSampleResults,
} from "./permission/index.js";
export type { ReviewerSampleInfo } from "./permission/index.js";

export {
  startProviderLogin,
  startDraftProviderLogin,
  discardDraftLogin,
  logoutProvider,
  type DraftLoginTarget,
  ProviderLoginError,
  type ProviderLoginErrorCode,
  type ProviderLoginOptions,
} from "./provider-login.js";
export { fetchProviderModels } from "./provider-oauth.js";
// 服务商配置数据接口（ADR-0044 第 6 节，provider-setup.md 第 6 节）
export {
  addProvider,
  prepareProvider,
  commitProvider,
  discardProvider,
  probeSetupProviderModels,
  updateSetupProvider,
  type PrepareProviderResult,
  type PreparedModelSummary,
  type ProbeSetupProviderParams,
  type UpdateSetupProviderPatch,
  type UpdateSetupProviderResult,
  credentialBackendLabel,
  describeAccountStorage,
  describeProviderSetup,
  ProviderSetupError,
  setupCredentialNotice,
  setupCredentialStep,
  setupFieldStep,
  type AccountStorageOption,
  type AccountStorageSetup,
  type AddProviderInput,
  type AddProviderOptions,
  type AddProviderResult,
  type CredentialMethodKind,
  type ProviderCredentialInput,
  type ProviderCredentialMethod,
  type ProviderCredentialSetup,
  type ProviderSetupDescription,
  type ProviderSetupField,
  type ProviderSetupFieldName,
  type ProviderSetupNotice,
} from "./provider-setup.js";
export {
  commitSkillImport,
  previewSkillImport,
  rewriteSkillName,
  SKILL_IMPORT_SIZE_LIMIT_BYTES,
  SkillImportError,
  type SkillImportCandidate,
  type SkillImportCandidateView,
  type SkillImportDecision,
  type SkillImportDecisionView,
  type SkillImportInput,
  type SkillImportOutput,
  type SkillImportPreview,
  type SkillImportResult,
  type SkillImportResultView,
} from "./skills/import.js";
export {
  createMcpOnDemandTools,
  estimateMcpToolsTokens,
  MAX_MCP_SEARCH_RESULTS,
  MCP_CALL_TOOL_NAME,
  MCP_SEARCH_TOOL_NAME,
  MCP_TOOL_SEARCH_AUTO_THRESHOLD,
  mcpServerOfTool,
  searchMcpTools,
  shouldEnableMcpToolSearch,
  tokenizeMcpQuery,
  type McpSearchMatch,
  type McpSearchOutput,
  type ToolDispatchResult,
} from "./tools/index.js";
