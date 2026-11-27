/**
 * @nocturne/core 公开入口（modules.md 第 3 节"core/index（公开 API）"）。
 * 客户端看到的全部能力都经由这里；进程内与将来的 RPC 客户端共用同一份语义（ADR-0002）。
 */
import { z } from "zod";
import { INSTRUCTION_FILE_LIMIT } from "./agent/subdir-instructions.js";
import {
  BackgroundShells,
  observerOutput,
  type BackgroundShellTask,
} from "./tools/background-shell.js";
import { createShellTool } from "./tools/builtin/shell.js";
import { shellTaskTools } from "./tools/builtin/shell-tasks.js";
import {
  replaySessionView,
  subjectKindSchema,
  type GrantWorkspace,
  type ProjectTrustDescription,
  type GrantsChangedPayload,
  type PendingPermission,
  type SubagentPendingPermission,
} from "./protocol/index.js";
import { McpSettingsError, validateMcpEntry } from "./config/mcp.js";
import type {
  McpProbeInput,
  McpProbeResult,
  McpSaveInput,
  McpServerOverview,
} from "./protocol/index.js";

import {
  attachChildPermissionForwarder,
  createSubagentLauncher,
  createSubagentLimiter,
  DEFAULT_TURN_CONFIG,
  runHookContextSnapshot,
  runTurn,
  runRoleCall,
  cleanTitle,
  TITLE_SYSTEM_PROMPT,
  formatTitleUserMessage,
  type ChildPermissionForwarder,
  type SubagentPermissionsDeps,
  type TurnConfig,
  type TurnDeps,
} from "./agent/index.js";
import {
  buildContext,
  attachmentsToLoad,
  runSummaryWithFallback,
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
  DecisionModelConfig,
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
  truncateSubagentTableDescription,
  GOAL_CHECK_DISCLOSURE_PREF,
  parseGoalCheckAccepted,
  type HooksDescription,
  type PluginOverview,
  type PluginsDescription,
  type ProjectSubagentsDescription,
  type SessionAppSurface,
  type SkillImportInput,
  type SkillImportOutput,
  type SkillsDescription,
  type SkillInvocation,
  type SkillSnapshot,
} from "./protocol/index.js";
import {
  applyToolMetaToPluginSurfaces,
  installLocalPlugin as installLocalPluginInStore,
  resolveActivePluginSkillDirs,
  resolvePlugins,
  setPluginEnabled as setPluginEnabledInStore,
  uninstallPlugin as uninstallPluginInStore,
  type ActivePluginsResolution,
} from "./plugins/index.js";
import {
  commitSkillImport,
  createSkillDiscoveryCache,
  previewSkillImport,
  renderSkill,
  skillCatalog,
} from "./skills/index.js";
import {
  GEMINI_DECISION_ENDPOINTS,
  JEV_ENDPOINTS,
  decisionModelFromJevReviewer,
  decisionModelRecipient,
  resolveEffectiveDecisionModel,
  defaultJevReviewer,
  fetchGeminiDecisionModels,
  fetchJevModels,
  resolveGeminiDecisionConnection,
  resolveJevConnection,
} from "./config/reviewer.js";
// ADR-0035 §5：编辑工具的模型默认表（config 层纯数据）注入 provider 解析
import { defaultEditToolForModel } from "./config/edit-tool.js";
import { createDiagnostics } from "./diagnostics/index.js";
import {
  clearMemoryDir,
  deleteMemoryEntry,
  describeMemoryStore,
  isDefaultMemoryWorkspace,
  readMemoryEntry,
  resolveMemoryScopeDir,
  snapshotMemoryContext,
  writeMemoryEntry,
} from "./memory/index.js";
import { createHookRunner, type HookRunnerEntry } from "./hooks/index.js";
import { appendInputHistory, readInputHistory } from "./input-history.js";
import { createUsageStats } from "./usage/index.js";
import type { CreateSuiteInput, SuiteRecord, UpdateSuiteInput } from "./protocol/suite.js";
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
import { assertSafeSessionId, readLogReadonly } from "./session/readonly-log.js";
import { rewindTargets, restoreCheckpointFiles } from "./session/rewind.js";
import { createTurnChanges } from "./session/turn-changes.js";
import { createPageStorage, prunePageData, requireSessionPage } from "./session/page-data.js";
import { createPagePermissionGate } from "./permission/page.js";
import { createPageModelCalls } from "./agent/page-model.js";
import {
  type ReviewerSampleInfo,
  type ReviewerSampleResult,
  createAttendance,
  createRulePolicy,
  createModelSecurityReviewer,
  createJevSecurityReviewer,
  createGeminiDecisionReviewer,
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
  type PermissionRespondOutcome,
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
  gitRepository,
  gitCurrentBranch,
  gitWorkspaceBranches,
  gitWorktrees,
  gitSwitchBranch,
  prepareSessionBranchWorktree,
  resolveWorktreeRootPath,
  registerManagedWorktree,
  touchManagedWorktree,
  unregisterManagedWorktree,
  setManagedWorktreePinned,
  describeManagedWorktrees,
  deleteManagedWorktrees,
  pruneExcessManagedWorktrees,
  restoreWorktreeRecoverySnapshot,
  type ManagedWorktreeInspector,
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
  ClearMemoryInput,
  CommandRejectCode,
  CommandErrorDetail,
  ContentBlock,
  DeleteMemoryInput,
  Diagnostics,
  Grant,
  HookEntry,
  HookPoint,
  DurableEvent,
  DurablePayload,
  McpToolSearchMode,
  MemoryContextSnapshot,
  MemoryDescription,
  MemoryEntry,
  MemoryScope,
  MemorySettings,
  ModelPricing,
  ModelRef,
  PageModelInput,
  PagePermissionReply,
  PendingInputMode,
  PendingInputsSnapshot,
  PermissionReply,
  PermissionSubject,
  PricingSource,
  QuestionReply,
  ReadMemoryInput,
  ReasoningEffort,
  ReasoningEffortLevel,
  RuntimeEvent,
  RewindTarget,
  RewindMode,
  SessionClient,
  SessionRewoundPayload,
  SessionSchedule,
  SubagentObservation,
  SubagentObserver,
  SessionReadSnapshot,
  SessionSnapshotObserver,
  SubagentSummary,
  EnsembleUnmergedWorktree,
  TurnEndReason,
  TurnChanges,
  TurnChangeDiff,
  WorkspaceBranches,
  ManagedWorktreesDescription,
  StartReviewInput,
  StartReviewResult,
  WorktreeCleanupResult,
  WorktreeRestoreResult,
} from "./protocol/index.js";
import {
  buildReviewPrompt,
  DEFAULT_GIT_CONFIG,
  DEFAULT_LOOP_GUARD,
  DEFAULT_WORKTREE_CONFIG,
  deriveSessionPages,
  isMemoryScope,
  isValidMemoryName,
  normalizePermissionPreset,
} from "./protocol/index.js";
import type { FileRefResolution, LocalFileContent } from "./protocol/file-refs.js";
import { resolveFileRefs } from "./tools/file-refs.js";
import { buildFileIndex, type FileIndexEntry } from "./tools/file-index.js";
import {
  isReasoningEffort,
  preparedContent,
  REASONING_EFFORT_ORDER,
  type PreparedInput,
} from "./protocol/index.js";
import { PendingInputs, type PendingInputPatch } from "./pending-inputs.js";
import { validateSettingsPatch } from "./config/settings.js";
import {
  discoverProjectSubagents,
  resolveSubagentProfile,
  toProjectSubagentOverview,
  type PluginSubagentDefinition,
  type ProjectSubagentDefinition,
} from "./config/index.js";
import { BackgroundSubagents, backgroundAdmission } from "./agent/background-subagents.js";
import {
  applyWorktreeChanges,
  checkpointWorktreeTurn,
  createWorktree,
  isWorktreeOnBranch,
  markWorktreeApplied,
  readWorktreeDiff,
  resetWorktreeToCommit,
  inspectWorktreeRepository,
  listWorktreeRecords,
  cleanupMergedWorktrees,
  removeWorktree,
  settleWorktree,
  worktreeCurrentHead,
  type WorktreeRecord,
} from "./agent/worktree.js";
import {
  createEnsembleController,
  ENSEMBLE_MAESTRO_TOOL_NAMES,
  type EnsembleController,
} from "./ensemble/index.js";
import {
  createSuiteController,
  createSuiteStore,
  isValidSuiteId,
  newSuiteId,
  SUITE_COORDINATOR_TOOL_NAMES,
  type SuiteController,
} from "./suites/index.js";
import {
  residentCallId,
  residentKindOf,
  type ResidentChildOpenSpec,
  type ResidentChildSession,
  type ResidentKind,
  type ResidentWorktreeOps,
} from "./resident/index.js";
import {
  checkExpectedHead,
  createApplySubagentChangesTool,
  ExpectedHeadMismatchError,
} from "./tools/builtin/apply-subagent-changes.js";
import { createUpdateGoalTool, UPDATE_GOAL_TOOL_NAME } from "./tools/builtin/update-goal.js";
import { DEFAULT_REVIEW_CONFIDENCE } from "./permission/reviewer-questions.js";
import {
  effectiveEvents,
  formatQuotesBlock,
  PAGE_COMMENT_ID_PATTERN,
  isWorkModeName,
  normalizeQuoteText,
  PAGE_COMMENT_TEXT_MAX_CHARS,
  workModeCommandName,
  workModeOrigins,
  type GoalStatus,
  type MessageQuote,
  type PageCommentsInput,
  type PageCommentsSnapshot,
  type PageLibraryListResult,
  type PageLibraryProjectsResult,
  type PlanConfig,
  type WorkModeName,
  type WorkModeSnapshot,
} from "./protocol/index.js";
import { DEFAULT_MAX_MODEL_CHARS, truncateModelContent, truncationNote } from "./tools/budget.js";
import { writeSpill } from "./tools/spill.js";
import {
  checkGoalWithDecision,
  checkGoalWithSmol,
  createGoalReporter,
  goalCheckUnavailable,
  goalContinuation,
  goalResumeBody,
  planApprovedBody,
  workModeBlock,
  workModeBody,
} from "./work-modes/index.js";
import {
  createPageLibrary,
  createSessionStore,
  createSubagentObservation,
  createSubagentRegistry,
  newSessionId,
  searchSessions,
  readLocalFile,
  readSessionAttachment,
  resolveFileRef,
  SessionError,
  type ReadAttachmentResult,
  type Session,
  type SessionRecovery,
  type SessionSearchOptions,
  type SessionSearchResult,
  type SessionState,
  type SessionStore,
  type SessionSummary,
} from "./session/index.js";
import {
  builtinTools,
  createAttachmentStore,
  createImageProcessor,
  createMcpOnDemandTools,
  createPolicyGate,
  ImageCorruptError,
  ImageTooLargeError,
  createQuestionBroker,
  createReadStateStore,
  createTaskTool,
  createSwitchWorktreeTool,
  createSkillTool,
  createMemoryTools,
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
  type McpAppResourceResult,
  type McpAppToolCallResult,
  type McpAppToolMeta,
  type McpConnector,
  type McpServerConfig,
  type McpServerStatus,
  type McpSession,
  type PermissionGate,
  type PluginMcpCacheKey,
  type ScheduleAccess,
  type ToolDefinition,
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
  /** Turn 配置覆盖（maxSteps / retryLimit / retryBaseDelayMs / retryMaxDelayMs） */
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
  shell?: { background: boolean } | undefined;
  /** ADR-0049：外部 agent 连接器；Core 只负责委派、权限和共享并发限制。 */
  externalAgents?: ExternalAgentConnector | undefined;
  /** ADR-0100：随发行包分发的内置插件目录（宿主显式传入；缺省时无内置插件） */
  builtinPluginsDir?: string | undefined;
  /** ADR-0096 第二期：注入 Codex / Claude 插件根目录（测试与嵌入方用） */
  plugins?:
    | {
        codexHome?: string | undefined;
        claudeHome?: string | undefined;
      }
    | undefined;
}

export interface RuntimeSubagentOptions {
  /** ADR-0073：宿主是否开启后台子代理（非交互宿主关闭），默认关闭 */
  background?: boolean | undefined;
  /** 每个父会话运行中的后台子代理上限，默认 3 */
  maxBackground?: number | undefined;
  enabled?: boolean | undefined;
  /** 允许的最大会话深度（顶层 0），默认 1 */
  maxDepth?: number | undefined;
  /** Runtime 级并存子会话上限，默认 4 */
  maxConcurrent?: number | undefined;
  /** 子会话单 Turn 步数上限，未设置时不限 */
  maxStepsPerTurn?: number | undefined;
  /** 缺 finish 时的总轮次上限（首轮 + 催促），默认 3 */
  maxAttempts?: number | undefined;
  /** task 显式超时（毫秒），未设置时不设超时 */
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

/**
 * 仅本会话有效的宿主注入 MCP 服务器（ADR-0120 §3）。
 * 不写入用户/项目 MCP 配置，不授予项目额外信任；凭据由 `credentials` 仅内存提供且按会话隔离。
 */
export interface SessionMcpInjection {
  servers: readonly McpServerConfig[];
  /** 仅对应本对象中宿主服务器的内存凭据查找器（键为 `mcp/<name>/<key>`） */
  credentials?: { get(id: string): Promise<string | undefined> } | undefined;
  /**
   * 为 true 时：同名冲突（不区分大小写）立即报错；建会话时等待宿主服务器初始启动完成，
   * 任一宿主服务器启动失败即报错并释放已分配资源。
   */
  strict?: boolean | undefined;
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
  /** 子会话父关联（仅进程内子代理或测试使用；RPC 不暴露） */
  parent?: { sessionId: string; callId: string } | undefined;
  /** 定时任务来源（ADR-0064）：写入 `session.created.schedule`，只由调度器传 */
  schedule?: SessionSchedule | undefined;
  /** 外部 agent 来源（ADR-0074 §5）：写入 `session.created.client`，只由 RPC 服务端在 `agent` 连接上填入 */
  client?: SessionClient | undefined;
  /** 新会话目标分支（ADR-0085）：定位已有工作树或在 `<repo>-wt/<branch>` 创建工作树并切入 */
  branch?: { name: string; create?: boolean | undefined } | undefined;
  /** 仅本会话有效的宿主注入 MCP 服务器（ADR-0120 §3；进程内使用，RPC 不暴露） */
  sessionMcp?: SessionMcpInjection | undefined;
}

import {
  attachmentReferences,
  saveInputAttachments,
  validateAttachmentInputs,
} from "./tools/file-attachments.js";

export interface SubmitInput {
  text?: string | undefined;
  content?: ContentBlock[] | undefined;
  /** 图片字节由 Core 落盘，事件只保存引用 */
  attachments?:
    | {
        data: Uint8Array;
        mimeType: string;
        label?: string | undefined;
        source?: "paste" | "upload" | "answer" | undefined;
        /**
         * 交错位置提示（ADR-0127 第四阶段）：该图片在 content 文本块序列中
         * 插入到第 N 个块（0-based）之后；缺省 = 末尾追加（旧行为）。
         */
        afterBlock?: number | undefined;
      }[]
    | undefined;
  /** 技能调用（skills.md 第 2 节）：Core 校验后把正文快照附到用户消息 */
  skill?: SkillInvocation | undefined;
  /** 外部 agent 点名；与 skill 互斥，任务原文随 message.user 固定。 */
  delegate?: AgentDelegation | undefined;
  /** 执行方式（ADR-0076）：与 skill、delegate 互斥，正文为任务，不得为空 */
  workMode?: WorkModeName | undefined;
  /** 面板页面评论（ADR-0113）：随用户消息持久化并追加英文评论块给模型 */
  pageComments?: PageCommentsInput | undefined;
  /** 引用回复片段（ADR-0116）：随用户消息持久化并在 content 最前面加入引用文本块 */
  quotes?: MessageQuote[] | undefined;
}

export type { ReadAttachmentResult };

export interface RuntimeSession {
  shellTasks(): BackgroundShellTask[];
  shellOutput(taskId: string, offset?: number): ReturnType<BackgroundShells["observe"]>;
  shellKill(taskId: string): Promise<void>;
  listGrants(): Grant[];
  revokeGrant(input: {
    kind: Grant["kind"];
    target: string;
    match?: Grant["match"] | undefined;
  }): Promise<void>;
  revokeAllGrants(): Promise<void>;
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
  getPageData(page: string, key: string): Promise<unknown>;
  setPageData(page: string, key: string, value: unknown): Promise<void>;
  deletePageData(page: string, key: string): Promise<void>;
  listPageDataKeys(page: string): Promise<string[]>;
  callPageModel(page: string, input: PageModelInput, signal?: AbortSignal): Promise<string>;
  respondPagePermission(page: string, requestId: string, reply: PagePermissionReply): Promise<void>;
  stopPageModel(page: string): void;
  resolvePageComment(page: string, comment: string): Promise<void>;
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
  /**
   * 提交一条待发输入（ADR-0070）：Turn 进行中入列——插话在安全点并入当前
   * Turn，排队在 done 之后开新 Turn；空闲时与 submit 等价，立即开始并返回
   * `queued: false`（id 只是对齐用的标记，不会出现在待发列表里）。暂停中提交
   * 追加到队尾并恢复。子会话拒绝 `invalid_command`。
   */
  enqueueInput(
    mode: PendingInputMode,
    input: SubmitInput,
  ): Promise<{ id: string; queued: boolean }>;
  /**
   * 编辑待发输入（ADR-0070 §5）：只替换文本，附件、`@` 引用与技能快照随原
   * 提交保留；条目已被消费时拒绝 `input_consumed`。
   */
  updateInput(id: string, patch: PendingInputPatch): Promise<void>;
  /** 撤回待发输入；条目已被消费时拒绝 `input_consumed` */
  cancelInput(id: string): Promise<void>;
  /** 解除暂停（ADR-0070 §4）；空闲时立即发出队首，Turn 进行中交给结束边界 */
  resumeInputs(): Promise<void>;
  /**
   * 停止目标（ADR-0076 §4.5）：写 `status: "stopped"`，进行中的 Turn 不再续跑。
   * 没有目标时 `invalid_command`；目标不是 active 时无操作。
   */
  stopGoal(): Promise<void>;
  /** 取消目标，立即中断当前 Turn，并持久清除目标。 */
  cancelGoal(): Promise<void>;
  /**
   * 继续目标（ADR-0076 §4.5）：目标不是 active 时写回 active，轮数重算，时长累计。
   * 会话空闲时立即开新 Turn 并在它结束时返回；Turn 或压缩进行中只改状态。
   * 没有目标时 `invalid_command`。
   */
  resumeGoal(): Promise<void>;
  /**
   * 批准计划（ADR-0076 §5）：恢复进入计划模式前的预设（原本只读时用 default）、
   * 退出计划模式，并开新 Turn 按计划实施，在它结束时返回。会话忙时
   * `session_busy`；不在计划模式时 `invalid_command`。
   */
  approvePlan(): Promise<void>;
  /** 放弃计划（ADR-0076 §5）：恢复进入前的预设并退出计划模式，不开 Turn */
  cancelPlan(): Promise<void>;
  /** 在当前活动 Ensemble 的共享留言板发帖（ADR-0089 §10）；不 @ 任何人时默认 @指挥 */
  postToEnsemble(input: { text: string }): Promise<{ number: number; recipients: string[] }>;
  /** 移除当前活动 Ensemble 中的指定成员（ADR-0089 §4、§10）；有未并回提交时拒绝 */
  removeEnsembleMember(input: string | { name: string }): Promise<void>;
  /** 结束当前活动 Ensemble（ADR-0089 §1、§11）：停止全部成员，返回未并回的独立工作树分支列表 */
  endEnsemble(): Promise<{ unmerged: EnsembleUnmergedWorktree[] }>;
  /** 组曲总览：标记指定线程完成或重新打开（ADR-0097 §3.6） */
  resolveThread(input: { thread: string; reopen?: boolean | undefined }): Promise<void>;
  /** 组曲总览：用户绕过指挥直接向线程发消息（ADR-0097 §3.6） */
  sendToThread(input: { thread: string; text: string }): Promise<void>;
  /**
   * 待发输入的当前快照。待发输入是临时状态、不写日志，`input.pending` 不回放，
   * 新附加的客户端用它在订阅后对齐（view.md 第 6 节）。
   */
  pendingInputs(): PendingInputsSnapshot;
  /** 中断运行中的 Turn；无运行中 Turn 时无操作 */
  interrupt(): void;
  /**
   * 回复 permission.requested（events.md 第 7 节）。
   * 没有匹配的等待中请求时以 unknown_request 拒绝；回复选项或模式校验失败以 invalid_reply
   * 拒绝且请求保持等待；reply.remember 生成对应范围的 Grant（permissions.md 5.4）。
   */
  respondPermission(requestId: string, reply: PermissionReply): Promise<void>;
  /**
   * 回复当前父会话下等待中的子代理权限请求（由 subagent.permissions 聚合到父会话）。
   * 仅校验本父会话活动转发池中对应 childSessionId 与 requestId，不匹配以 unknown_request 拒绝；
   * 选项或模式校验失败以 invalid_reply 拒绝且请求保持等待。
   */
  respondSubagentPermission(
    childSessionId: string,
    requestId: string,
    reply: PermissionReply,
  ): Promise<void>;
  /**
   * 回复 question.requested（events.md 第 7 节，ADR-0032）。
   * 没有匹配的等待中请求时以 unknown_request 拒绝；回复与问题不匹配
   * （条数不符、未知 label、单选多项）以 invalid_reply 拒绝且请求保持等待。
   */
  respondQuestion(requestId: string, reply: QuestionReply): Promise<void>;
  /**
   * 宿主挂起等待中的提问（ADR-0127 第三阶段）：把请求结算为 handoff_suspended，
   * 当前 Turn 继续按工具结果推进，宿主在下一轮用普通文本把用户答案带回。
   * 仅用于宿主不能结构化提问、但已把问题完整展示给用户的场景；
   * 用户明确拒绝走 respondQuestion 的 declined，取消/断连走 interrupt。
   * 没有匹配的等待中请求时以 unknown_request 拒绝。
   */
  questionSuspend(requestId: string): Promise<void>;
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
  /** 读取本会话插件 MCP 服务器的 ui:// 页面资源（ADR-0101 第 2、7 节；仅本地开放） */
  readAppResource(input: {
    pluginId: string;
    serverId: string;
    uri: string;
  }): Promise<McpAppResourceResult>;
  /** 以页面来源调用同服务器只读工具（ADR-0101 第 3、7 节；不写日志、不触发 Hook；仅本地开放） */
  callAppTool(input: {
    pluginId: string;
    serverId: string;
    tool: string;
    arguments?: Record<string, unknown> | undefined;
  }): Promise<McpAppToolCallResult>;
  /** 列出本会话当前已启用插件的可用面板 surface（ADR-0101 第 4、5、7 节；仅本地开放） */
  listAppSurfaces(): Promise<SessionAppSurface[]>;
  /** 打开会话时聚合的警告（配置降级、未信任项目配置等），供客户端展示 */
  readonly warnings: readonly string[];
  /** 打开时执行的恢复修复汇总（sessions.md 第 6 节）；无修复则 undefined */
  readonly recovery?: SessionRecovery | undefined;
  /** 没有执行中（含准备、收尾）的 Turn，也没有尚未完成交付的后台工作。 */
  isIdle(): boolean;
  /** 进入上述空闲状态时通知；不立即回调，返回取消订阅函数。 */
  onIdle(listener: () => void): () => void;
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
  /** 仅本会话有效的宿主注入 MCP 服务器（ADR-0120 §3、ADR-0127 第二阶段；进程内使用，RPC 不暴露） */
  sessionMcp?: SessionMcpInjection | undefined;
  /**
   * 恢复资格校验（ADR-0127 第二阶段；进程内使用，RPC 不暴露）。
   * 在取得会话锁、读取持久化状态之后，装配宿主 MCP、绑定工具或投递任何历史之前调用；
   * 校验抛错则关闭会话、释放锁，不向宿主绑定任何工具。校验与恢复在同一把锁内，
   * 读取到的 `state()` 即最终恢复所用的同一份会话状态（无读改竞态）。
   * 用于按宿主归属/工作区决定是否允许恢复，ACP `session/load` 经此拒绝外来会话。
   * 携带本回调的恢复要求独占并校验目标：从进入 Core 起只走取锁、校验、包装的路径，
   * 不查询、打开或借用活动合奏/组曲的共享成员（那些快路径返回的是托管 proxy，
   * 会绕过本校验，且解析本身可能打开尚未在用的成员会话）。
   */
  validate?: ((state: SessionState) => void | Promise<void>) | undefined;
}

export interface Runtime {
  workspaceBranches(input: { workspace: string }): Promise<WorkspaceBranches>;
  switchBranch(input: { workspace: string; branch: string; create?: boolean }): Promise<void>;
  listSessionGrants(input: { sessionId: string }): Grant[];
  revokeSessionGrant(input: {
    sessionId: string;
    kind: Grant["kind"];
    target: string;
    match?: Grant["match"] | undefined;
  }): Promise<void>;
  revokeAllSessionGrants(input: { sessionId: string }): Promise<void>;
  listGrantWorkspaces(): Promise<GrantWorkspace[]>;
  listGrants(input: { workspace: string }): Promise<Grant[]>;
  revokeGrant(input: {
    workspace: string;
    kind: Grant["kind"];
    target: string;
    match?: Grant["match"] | undefined;
  }): Promise<void>;
  revokeAllGrants(input: { workspace: string }): Promise<void>;
  describeProject(input: { workspace: string }): Promise<ProjectTrustDescription>;
  setWorkspaceTrusted(input: { workspace: string; trusted: boolean }): Promise<void>;
  onGrantsChanged(listener: (payload: GrantsChangedPayload) => void): () => void;
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
  /** 关闭 Runtime 持有的后台资源（调度器与图片处理 worker，ADR-0090） */
  close(): Promise<void>;
  describeSkills(input?: { workspaceRoot?: string | undefined }): Promise<SkillsDescription>;
  setSkillEnabled(input: { name: string; enabled: boolean }): Promise<{ affectedSessions: number }>;
  describeProjectSubagents(input?: {
    workspaceRoot?: string | undefined;
  }): Promise<ProjectSubagentsDescription>;
  describePlugins(): Promise<PluginsDescription>;
  setPluginEnabled(input: { id: string; enabled: boolean }): Promise<{ affectedSessions: number }>;
  installLocalPlugin(input: { path: string }): Promise<PluginOverview>;
  uninstallPlugin(input: { id: string }): Promise<{ affectedSessions: number }>;
  /** 长期记忆管理（ADR-0098 §7） */
  describeMemory(input?: {
    workspaceRoot?: string | undefined;
    suiteId?: string | undefined;
  }): Promise<MemoryDescription>;
  readMemory(input: ReadMemoryInput): Promise<MemoryEntry>;
  deleteMemory(input: DeleteMemoryInput): Promise<void>;
  clearMemory(input: ClearMemoryInput): Promise<void>;
  /** 记忆文件变化通知（写入/删除/清空后触发，供 RPC 推送 runtime.providersChanged） */
  onMemoryChanged(listener: () => void): () => void;
  /** 组曲管理（ADR-0097 §3.6） */
  listSuites(filter?: { includeArchived?: boolean | undefined }): Promise<SuiteRecord[]>;
  createSuite(input: CreateSuiteInput): Promise<SuiteRecord>;
  updateSuite(input: UpdateSuiteInput): Promise<SuiteRecord>;
  archiveSuite(id: string): Promise<void>;
  openSuite(id: string, options?: ResumeSessionOptions): Promise<RuntimeSession>;
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
  describeHooks(input?: { workspaceRoot?: string | undefined }): Promise<HooksDescription>;
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
    options?: {
      reviewerKey?: string;
      decisionModelKey?: string;
      workspaceRoot?: string | undefined;
    },
  ): Promise<SettingItem[]>;
  listReviewerProviders(input?: {
    workspaceRoot?: string | undefined;
  }): Promise<ProviderOverview[]>;
  defaultReviewer(
    endpoint: JevEndpoint,
    baseURL?: string,
    input?: { workspaceRoot?: string | undefined },
  ): Promise<JevReviewerConfig>;
  listDecisionModels(
    decisionModel: DecisionModelConfig,
    signal?: AbortSignal,
    input?: { workspaceRoot?: string | undefined },
  ): Promise<{ models: string[]; warning?: string }>;
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
  renameSession(id: string, title: string): Promise<void>;
  /**
   * 归档根会话（ADR-0080）：写 `<id>.archive.json` 旁路，不写事件、不改日志 mtime。
   * 子会话 `invalid_command`；Turn/压缩/回退/关闭/后台子代理/待发输入/外部锁
   * 返回 `session_busy`。
   */
  archiveSession(id: string): Promise<void>;
  /** 恢复归档；只删旁路，不改日志与摘要 mtime（ADR-0080）。 */
  unarchiveSession(id: string): Promise<void>;
  /** 会话列表可见状态变化（归档、恢复与 submit 自动恢复）；返回取消订阅函数。 */
  onSessionsChanged(listener: () => void): () => void;
  /** 取消本父会话运行中的后台子代理，结果照常交付 cancelled（ADR-0073 §4） */
  cancelSubagent(input: { parentSessionId: string; childSessionId: string }): Promise<void>;
  listSubagentWorktrees(input: { parentSessionId: string }): Promise<WorktreeRecord[]>;
  deleteSubagentWorktree(input: { parentSessionId: string; childSessionId: string }): Promise<void>;
  describeManagedWorktrees(): Promise<ManagedWorktreesDescription>;
  setManagedWorktreePinned(input: {
    id: string;
    pinned: boolean;
  }): Promise<{ id: string; pinned: boolean }>;
  deleteManagedWorktrees(input: {
    ids: string[];
    saveSnapshot?: boolean | undefined;
  }): Promise<WorktreeCleanupResult>;
  pruneManagedWorktrees(): Promise<WorktreeCleanupResult>;
  restoreWorktreeSnapshot(input: {
    snapshotId: string;
    targetPath?: string | undefined;
    branch?: string | undefined;
  }): Promise<WorktreeRestoreResult>;
  startReview(input: StartReviewInput): Promise<StartReviewResult>;
  readSubagentDiff(input: {
    parentSessionId: string;
    childSessionId: string;
    file: string;
  }): Promise<string>;
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
  /**
   * 顶层会话只读快照观察（ADR-0099、rpc.md 4.2）：不打开会话、不取锁、不修复日志；
   * 会话已在本 Runtime 打开时直接读取内存持久事件，否则读取固定字节快照并按批次交付 `seq > afterSeq` 的持久事件。
   * 子会话拒绝（`invalid_command`），请走 `observeSubagent`。
   */
  observeSession(
    input: {
      sessionId: string;
      afterSeq?: number | undefined;
      signal?: AbortSignal | undefined;
    },
    observer: SessionSnapshotObserver,
  ): Promise<SessionReadSnapshot>;
  /** 读取顶层会话持久事件登记过的附件，不打开会话、不取锁；子会话拒绝 */
  readSessionAttachment(input: { sessionId: string; file: string }): Promise<ReadAttachmentResult>;
  listSessions(filter?: {
    cwd?: string | undefined;
    /** 默认 false：子会话（session.created.parent 存在）不进列表 */
    includeSubagents?: boolean | undefined;
    /** 默认 false：组曲指挥会话不进列表（ADR-0097） */
    includeSuiteCoordinators?: boolean | undefined;
    /** 默认 false：已归档会话不进列表（ADR-0080） */
    includeArchived?: boolean | undefined;
  }): Promise<SessionSummary[]>;
  /** 无索引地搜索本机会话标题与有效正文；默认排除子会话与已归档会话。 */
  searchSessions(query: string, options?: SessionSearchOptions): Promise<SessionSearchResult[]>;
  /** 按项目列出顶层会话（含已归档）中的面板页面，按来源合并为最近副本（ADR-0114）。 */
  listPages(input?: {
    projectKey?: string | undefined;
    workspaceRoot?: string | undefined;
  }): Promise<PageLibraryListResult>;
  /** 列出包含面板页面的项目，以及当前工作区对应的项目信息（ADR-0114）。 */
  listPageProjects(input?: {
    workspaceRoot?: string | undefined;
  }): Promise<PageLibraryProjectsResult>;
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

/** ADR-0070：待发输入的方式；RPC 传来的值按运行时校验，避免信任客户端类型 */
function isPendingInputMode(value: unknown): value is PendingInputMode {
  return value === "steer" || value === "queue";
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

function includeClaudeProjectSubagents(
  skillsConfig: { sources?: { claude?: boolean | undefined } | undefined } | undefined,
): boolean {
  return skillsConfig?.sources?.claude !== false;
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
  const decisionConnection = (
    model: DecisionModelConfig,
    providers: readonly ProviderEntryConfig[],
    sessionId: string,
    minConfidence: number = DEFAULT_REVIEW_CONFIDENCE,
    legacyStoredKey = false,
  ) => {
    const credentials = reviewerCredentials(providers);
    const env = (name: string) => platform.env(name);
    return model.source === "gemini"
      ? {
          ...resolveGeminiDecisionConnection(model, credentials, env, minConfidence),
          source: model.source,
        }
      : {
          ...resolveJevConnection(
            { ...model, minConfidence },
            providers,
            credentials,
            env,
            "decision-model",
            legacyStoredKey ? "reviewer" : undefined,
          ),
          source: model.source,
          sessionId,
        };
  };
  const buildDecisionReviewer = (
    decisionModel: DecisionModelConfig | undefined,
    minConfidence: number,
    providers: readonly ProviderEntryConfig[],
    sessionId: string,
  ): SecurityReviewer => {
    if (decisionModel === undefined) {
      return {
        backend: "decision",
        review() {
          return Promise.resolve({ verdict: "unsure" as const, reason: "决策模型未设置" });
        },
      };
    }
    const connection = decisionConnection(decisionModel, providers, sessionId, minConfidence);
    return connection.source === "gemini"
      ? createGeminiDecisionReviewer(connection)
      : createJevSecurityReviewer(connection);
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
    maxStepsPerTurn: options.subagent?.maxStepsPerTurn,
    maxAttempts: options.subagent?.maxAttempts ?? 3,
    timeoutMs: options.subagent?.timeoutMs,
  };
  const subagentLimiter = createSubagentLimiter(subagentLimits.maxConcurrent);
  // 观察登记簿与 limiter 同寿命：所有会话、所有嵌套层级的 launcher 共享（rpc.md 4.1）
  const subagentRegistry = createSubagentRegistry();
  const backgroundSubagents = new BackgroundSubagents();

  const store: SessionStore = createSessionStore({
    platform,
    sessionsDir,
    onTitleDiagnostic: (sessionId, reason) => {
      diagnostics.record("session.title_sidecar_invalid", { sessionId, reason });
    },
    onArchiveDiagnostic: (sessionId, reason, error) => {
      diagnostics.record(
        reason === "invalid_sidecar"
          ? "session.archive_sidecar_invalid"
          : reason === "write_failed"
            ? "session.archive_write_failed"
            : "session.unarchive_failed",
        { sessionId, reason, ...(error !== undefined ? { error } : {}) },
      );
    },
    onActivityDiagnostic: (sessionId, reason, error) => {
      diagnostics.record(
        reason === "invalid_sidecar"
          ? "session.activity_sidecar_invalid"
          : reason === "write_failed"
            ? "session.activity_write_failed"
            : "session.activity_delete_failed",
        { sessionId, reason, ...(error !== undefined ? { error } : {}) },
      );
    },
  });
  const suiteStore = createSuiteStore(platform, nocturneHome);
  const subagentObservation = createSubagentObservation({
    platform,
    sessionsDir,
    registry: subagentRegistry,
    isResidentParent: (parent) => residentKindOf(parent?.callId) !== undefined,
  });
  const resolvePricing = (
    reg: ProviderRegistry,
    ref: ModelRef,
  ):
    | { pricing?: ModelPricing | undefined; pricingSource?: PricingSource | undefined }
    | undefined => {
    let model: ReturnType<ProviderRegistry["resolve"]>["model"] | undefined;
    try {
      model = reg.resolve(ref).model;
    } catch {
      model = undefined;
    }
    if (model?.pricing !== undefined) return model;
    const vendor = config?.vendorPricing?.(ref.model);
    return vendor !== undefined ? { pricing: vendor, pricingSource: "vendor" as const } : model;
  };
  const usageStats = createUsageStats({
    platform,
    sessionsDir,
    // 注册表给不出价格（服务商已删除或改名、模型不在清单）时按模型厂商兜底（ADR-0053 修订）
    pricing: (ref) => resolvePricing(registry, ref),
  });

  /**
   * 已打开会话挂在 Runtime 上的回调（配置广播、技能预算、分叉入口），按会话 id 索引。
   * 会话打开的最后一步整体登记；close 与打开失败共用同一撤销步骤移除（sessions.md 第 4 节）。
   */
  interface OpenSessionHooks {
    workspace: string;
    currentCwd(): string;
    repositoryFor(cwd: string): string;
    branchBusy(): boolean;
    pumpPending(): void;
    grantWarning(message: string): void;
    shellCurrent(): ReturnType<ReturnType<typeof createShellResolver>["current"]>;
    shellChanged(
      before: ReturnType<ReturnType<typeof createShellResolver>["current"]>,
    ): Promise<void>;
    /** updateProviders 等：标记 providers 待重建，下一次空闲边界 rebuildProviders */
    markProvidersDirty(): void;
    /** 当前会话模型引用（ADR-0054 describeToggleImpact 的影响面计算） */
    currentModel(): ModelRef;
    reconcileMcp(): Promise<void>;
    listMcpServerTools?(serverId: string): readonly McpAppToolMeta[] | undefined;
    refreshSkills(rescan: boolean): Promise<void>;
    refreshExternalAgents(): void;
    skillModel: { workspaceRoot: string; contextWindow: () => number | undefined };
    fork(targetSeq?: number): Promise<string>;
    rename(title: string): Promise<void>;
    /** 已打开会话的归档写入；忙判定与异步互斥在会话闭包里（ADR-0080） */
    archive(archivedAt: string): Promise<void>;
    /** 已打开会话的恢复：只校验根会话并删除旁路，不判断忙（ADR-0080） */
    unarchive(): Promise<void>;
    durableEvents(): readonly DurableEvent[];
    /** 若 childSessionId 属于本会话活动 Ensemble 的未移除成员，返回其共享托管会话句柄（ADR-0089 §8、§10） */
    ensembleMember?(childSessionId: string): Promise<RuntimeSession | undefined>;
    /** 当前活动 Ensemble 中未移除的独立工作树成员 childSessionId 集合 */
    ensembleActiveIsolatedChildIds?(): ReadonlySet<string>;
    /** 若 childSessionId 属于本组曲指挥会话的线程，返回其共享托管会话句柄（ADR-0097） */
    suiteThread?(childSessionId: string): Promise<RuntimeSession | undefined>;
    /** 当前组曲指挥会话中独立工作树线程 childSessionId 集合 */
    suiteActiveIsolatedChildIds?(): ReadonlySet<string>;
    /** 同步更新打开的组曲指挥会话持有的 SuiteRecord */
    updateSuiteRecord?(record: SuiteRecord): void;
    /** 组曲指挥或任意线程是否正在运行（供 archiveSuite 忙检查） */
    suiteCoordinatorBusy?(): boolean;
    /** 广播到本会话失败时的提示出口 */
    applyFailed(scope: string, error: unknown): void;
  }
  const openSessions = new Map<string, OpenSessionHooks>();
  const pageLibrary = createPageLibrary({
    platform,
    store,
    sessionsDir,
    nocturneHome,
    defaultWorkspaceRoot: workspaceRoot,
    getOpenSessionEvents: (id) => openSessions.get(id)?.durableEvents(),
  });
  const managedWorktreeInspector: ManagedWorktreeInspector = {
    async isActive(entry) {
      if (entry.kind === "subagent" && entry.childSessionId) {
        if (subagentRegistry.find(entry.childSessionId) !== undefined) return true;
        for (const hooks of openSessions.values()) {
          if (hooks.ensembleActiveIsolatedChildIds?.().has(entry.childSessionId)) return true;
          if (hooks.suiteActiveIsolatedChildIds?.().has(entry.childSessionId)) return true;
        }
        return false;
      }
      const targetReal = await platform.resolveReal(entry.worktreePath);
      for (const hooks of openSessions.values()) {
        const activeCwd = await platform.resolveReal(hooks.currentCwd());
        if (paths.equals(targetReal, activeCwd) || paths.isWithin(targetReal, activeCwd)) {
          return true;
        }
      }
      return false;
    },
    async sessionInfo(sessionId) {
      const summaries = await store.list({ includeArchived: true }).catch(() => []);
      const found = summaries.find((s) => s.id === sessionId);
      if (!found) {
        return { title: sessionId, exists: false };
      }
      const trimmed = found.firstText?.trim();
      const title = trimmed !== undefined && trimmed !== "" ? trimmed : sessionId;
      return {
        title,
        exists: true,
        lastActivityAt: found.lastUserMs ?? found.mtimeMs,
      };
    },
    worktreeConfig() {
      const resolved = config?.resolvedSettings().worktree ?? DEFAULT_WORKTREE_CONFIG;
      return {
        subagentRoot: resolved.subagentRoot,
        autoDelete: resolved.autoDelete,
        keepCount: resolved.keepCount,
      };
    },
  };
  const maybePruneManagedWorktrees = async (): Promise<void> => {
    try {
      await pruneExcessManagedWorktrees(sessionsDir, managedWorktreeInspector);
    } catch (cause) {
      diagnostics.record("worktree.auto_prune_failed", {
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  };
  const branchSwitches = new Set<string>();
  const directoryKey = (path: string) => platform.paths.canonicalize(path);
  const switching = (path: string) =>
    [...branchSwitches].some((root) => platform.paths.equals(root, path));
  const branchBusy = (root: string): boolean =>
    branchSwitches.has(directoryKey(root)) ||
    [...openSessions.values()].some(
      (hooks) => platform.paths.equals(root, hooks.workspace) && hooks.branchBusy(),
    ) ||
    subagentRegistry.activeAll().some((child) => {
      if (!child.background) return false;
      const created = child.durableEvents()[0];
      if (created?.type !== "session.created") return false;
      const parent = openSessions.get(child.parentSessionId);
      return parent !== undefined
        ? platform.paths.equals(root, parent.repositoryFor(created.payload.cwd))
        : platform.paths.isWithin(root, created.payload.cwd);
    });
  /**
   * 会话列表可见状态变化（ADR-0080）：归档/恢复与 submit 自动恢复。
   * 只带信号不带内容；RPC Hub 订阅后并入 `runtime.sessionsChanged` 的 300 ms 合并窗口。
   */
  const sessionsChangedListeners = new Set<() => void>();
  const notifySessionsChanged = (): void => {
    for (const listener of sessionsChangedListeners) {
      try {
        listener();
      } catch {
        /* 监听者不能阻断归档或发送。 */
      }
    }
  };
  const grantsListeners = new Set<(payload: GrantsChangedPayload) => void>();
  const grantLists = new Map<string, Grant[]>();
  const grantsChanged = (payload: GrantsChangedPayload): void => {
    for (const listener of grantsListeners) {
      try {
        listener(payload);
      } catch {
        /* 监听者不能阻断授权操作。 */
      }
    }
  };
  const memoryChangedListeners = new Set<() => void>();
  const notifyMemoryChanged = (): void => {
    for (const listener of memoryChangedListeners) {
      try {
        listener();
      } catch {
        /* 监听者不能阻断记忆操作。 */
      }
    }
  };
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
  const pluginDiscoveryOptions = {
    nocturneHome,
    ...(options.builtinPluginsDir !== undefined
      ? { builtinPluginsDir: options.builtinPluginsDir }
      : {}),
    ...(options.plugins?.codexHome !== undefined ? { codexHome: options.plugins.codexHome } : {}),
    ...(options.plugins?.claudeHome !== undefined
      ? { claudeHome: options.plugins.claudeHome }
      : {}),
  };
  const collectReservedMcpIds = (
    configServers: readonly { name: string }[] | undefined,
  ): Set<string> => {
    const ids = new Set<string>();
    for (const s of options.mcpServers ?? []) ids.add(s.name.toLowerCase());
    for (const s of configServers ?? []) ids.add(s.name.toLowerCase());
    return ids;
  };
  const imageProcessor = createImageProcessor();

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

  interface ResidentChildAssemblyOptions {
    kind: ResidentKind;
    parentSessionId: string;
    rootSessionId: string;
    name: string;
    preset: "general" | "explore";
    worktreePath?: string | undefined;
    extraTools: ToolDefinition[];
    basePrompt(): string;
    parentGrants: Grant[];
    isActive(): boolean;
    onTurnLifecycle: ResidentChildOpenSpec["onTurnLifecycle"];
    permissions?:
      | {
          parentCallId: string;
          profile: string;
          taskSummary: string;
          register: SubagentPermissionsDeps["register"];
          clearChild: (childSessionId: string) => void;
        }
      | undefined;
  }

  interface ResidentChildInternalControls {
    isBusy(): boolean;
    hasActivePendingInputs(): boolean;
    deliverInput(input: PreparedInput, forcePaused?: boolean): Promise<void>;
    resumeFromModelChange(modelKey: string): Promise<void>;
    setModelAndEffort(modelRef: ModelRef, effort?: ReasoningEffort): Promise<void>;
    interruptAndWait(): Promise<void>;
    clearPendingInputs(): void;
  }

  const RESIDENT_CHILD_CONTROLS = Symbol("nocturne.residentChildControls");

  async function wrapSession(
    session: Session,
    resume?: { modelOverride?: string | ModelRef | undefined },
    unattended = false,
    residentChild?: ResidentChildAssemblyOptions,
    sessionMcp?: SessionMcpInjection,
  ): Promise<RuntimeSession> {
    // 打开途中取得的 Runtime 级登记与外部资源（MCP 连接）按序登记撤销步骤；
    // 打开失败在此逆序撤销，close 复用同一份。会话锁由调用方 session.close() 释放。
    const teardown: (() => Promise<void> | void)[] = [];
    const runTeardown = async (): Promise<void> => {
      for (const step of teardown.splice(0).reverse()) await step();
    };
    try {
      return await assembleSession(
        session,
        resume,
        teardown,
        runTeardown,
        unattended,
        residentChild,
        sessionMcp,
      );
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
    residentChild?: ResidentChildAssemblyOptions,
    sessionMcp?: SessionMcpInjection,
  ): Promise<RuntimeSession> {
    const meta = session.state().meta;
    const isSuiteCoordinator = meta.suite?.role === "coordinator";
    const suiteId = meta.suite?.id;
    const residentKind = residentKindOf(meta.parent?.callId);
    const isResidentChild = residentChild !== undefined || residentKind !== undefined;
    const isTaskSubagent = meta.parent !== undefined && !isResidentChild;
    const memoryPolicy = isTaskSubagent
      ? ({ inject: false, read: false, write: false } as const)
      : ({
          inject: true,
          read: true,
          write:
            !isResidentChild &&
            meta.client?.kind !== "agent" &&
            meta.schedule === undefined &&
            interactive &&
            !unattendedOption,
        } as const);
    const memorySwitches: MemorySettings = config?.memoryConfig() ?? {
      global: true,
      project: true,
    };
    const hasProjectMemoryScope = !(await isDefaultMemoryWorkspace(
      platform,
      nocturneHome,
      meta.workspaceRoot,
    ));
    const availableMemoryScopes: MemoryScope[] = [
      ...(memorySwitches.global ? (["global"] as const) : []),
      ...(memorySwitches.project && hasProjectMemoryScope ? (["project"] as const) : []),
      ...(suiteId !== undefined ? (["suite"] as const) : []),
    ];
    let memorySnapshot: MemoryContextSnapshot | undefined;
    const refreshMemorySnapshot = async (): Promise<void> => {
      if (!memoryPolicy.inject || availableMemoryScopes.length === 0) {
        memorySnapshot = undefined;
        return;
      }
      memorySnapshot = await snapshotMemoryContext(platform, nocturneHome, {
        scopes: availableMemoryScopes,
        workspaceRoot: meta.workspaceRoot,
        ...(suiteId !== undefined ? { suiteId } : {}),
        writable: memoryPolicy.write,
      });
    };
    await refreshMemorySnapshot();
    const projectCwd = await platform.resolveReal(meta.cwd);
    const projectRepository = (await gitRepository(projectCwd)) ?? projectCwd;
    const repositoryFor = (cwd: string) =>
      paths.equals(cwd, meta.cwd)
        ? projectRepository
        : paths.resolve(cwd, paths.relative(projectCwd, projectRepository));
    const branchWatchPath = () =>
      repositoryFor(session.state().config.worktree?.current ?? meta.cwd);
    const currentCwd = () => session.state().config.worktree?.current ?? meta.cwd;
    const currentWorkspaceRoot = () => {
      const worktree = session.state().config.worktree;
      return worktree === undefined
        ? meta.workspaceRoot
        : paths.resolve(worktree.current, paths.relative(projectCwd, meta.workspaceRoot));
    };
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
    const pluginResolution = await resolvePlugins(platform, {
      ...pluginDiscoveryOptions,
      reservedMcpIds: collectReservedMcpIds(resolved?.mcpServers),
    });
    const warnings: string[] = [...(resolved?.warnings ?? []), ...pluginResolution.warnings];
    let skillDiscovery = await skillCache.discover({
      nocturneHome,
      workspaceRoot: meta.workspaceRoot,
      cwd: projectCwd,
      config: config?.skillConfig(),
      pluginSkillDirs: pluginResolution.skillDirs,
    });
    for (const warning of skillDiscovery.warnings)
      warnings.push(`${warning.path}:${warning.line}：${warning.message}`);
    let catalog = skillCatalog(skillDiscovery.skills, config?.disabledSkills() ?? [], undefined);
    let projectSubagentsDiscovery = await discoverProjectSubagents(platform, {
      workspaceRoot: meta.workspaceRoot,
      cwd: projectCwd,
      includeClaude: includeClaudeProjectSubagents(config?.skillConfig()),
    });
    warnings.push(...projectSubagentsDiscovery.warnings);
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
    const warnedPluginMcpConflicts = new Set<string>();
    for (const conflict of pluginResolution.mcpConflicts) {
      const key = `${conflict.pluginId}:${conflict.serverId}`;
      warnedPluginMcpConflicts.add(key);
      const message = `插件 ${conflict.pluginLabel} 的 MCP 服务器 "${conflict.serverId}" 与已有配置同名，已跳过`;
      warnings.push(message);
      session.emitEphemeral("runtime.warning", {
        code: "plugin_mcp_conflict",
        message,
      });
    }
    for (const changed of pluginResolution.changedPlugins) {
      const message = `插件 ${changed.name}@${changed.marketplace}（${changed.id}）内容已变化，已停用；请重新启用后生效`;
      warnings.push(message);
      session.emitEphemeral("runtime.warning", {
        code: "plugin_changed",
        message,
      });
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
    let grantRootId = session.id;
    let grantParent = meta.parent?.sessionId;
    while (grantParent !== undefined && subagentRegistry.liveSession(grantParent) !== undefined) {
      grantRootId = grantParent;
      grantParent = subagentRegistry.liveSession(grantParent)?.state().meta.parent?.sessionId;
    }
    const sessionGrants: Grant[] = residentChild?.parentGrants ?? grantLists.get(grantRootId) ?? [];
    grantLists.set(grantRootId, sessionGrants);
    if (grantRootId === session.id && residentChild === undefined)
      teardown.push(() => {
        grantLists.delete(grantRootId);
      });
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
    const attachmentsRootReal = await platform.resolveReal(paths.join(sessionsDir, "attachments"));
    const ownAttachmentsReal = paths.join(attachmentsRootReal, session.id);
    let projectPageFiles: string[] = await pageLibrary.listProjectPanelPageFiles({
      workspaceRoot: currentWorkspaceRoot(),
      excludeSessionId: session.id,
    });
    const refreshProjectPageFiles = async (): Promise<void> => {
      projectPageFiles = await pageLibrary.listProjectPanelPageFiles({
        workspaceRoot: currentWorkspaceRoot(),
        excludeSessionId: session.id,
      });
    };
    // presetContext.sessionId 参数化：子会话重建策略时换自己的 id
    // （attachments 目录等规则绑定子会话自己的落盘位置，subagent.md 7.2）
    const buildPolicy = (
      presetName: string,
      policySessionId: string = session.id,
      isolatedWorkspace?: string,
      worktree?: { root: string; cwd: string },
    ): PermissionPolicy =>
      options.policy ??
      createRulePolicy({
        workspaceRoot: isolatedWorkspace ?? currentWorkspaceRoot(),
        ...(worktree ? { worktree } : {}),
        caseSensitive: platform.caseSensitivePaths,
        preset: isPermissionPresetName(presetName) ? presetName : "default",
        presetContext: {
          skillRoots: skillDiscovery.skills
            .filter((s) => s.layout !== "file")
            .map((s) => s.realPath),
          skillFiles: skillDiscovery.skills
            .filter((s) => s.layout === "file")
            .map((s) => s.realPath),
          projectPageFiles,
          sessionsDir,
          sessionId: policySessionId,
          nocturneHome,
        },
        rules: [
          ...(resolved?.rules ?? []).filter(
            (entry) =>
              !(
                config?.appPermissions !== undefined &&
                entry.origin === "user" &&
                entry.rule.kind === "app"
              ),
          ),
          ...(config?.appPermissions?.list().map((rule) => ({ origin: "user" as const, rule })) ??
            []),
        ],
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
    const residentWorktreePolicy =
      residentChild?.worktreePath !== undefined
        ? { root: residentChild.worktreePath, cwd: meta.cwd }
        : undefined;
    let policy = buildPolicy(
      session.state().config.permissionPreset,
      session.id,
      residentChild?.worktreePath !== undefined ? meta.workspaceRoot : undefined,
      residentWorktreePolicy,
    );
    if (!isPermissionPresetName(session.state().config.permissionPreset)) {
      warnings.push(
        `会话记录的权限预设 "${session.state().config.permissionPreset}" 未知，已回退 default`,
      );
    }
    // HookRunner：注入条目（options.hooks）在前、配置层在后逐点追加；
    // 项目层未信任时 resolved.hooks 已不含项目段（load.ts 整段忽略）。
    // 工厂形态：子会话以同一批条目换自己的 sessionId 重建，并注入
    // subagent 标记让 Hook 区分父子会话（subagent.md 第 10 节）
    const hookEntries: Partial<Record<HookPoint, HookRunnerEntry[]>> = {};
    for (const src of [options.hooks, resolved?.hooks, pluginResolution.hooks]) {
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
        get cwd() {
          return owner === session ? currentCwd() : owner.state().meta.cwd;
        },
        get workspaceRoot() {
          return owner === session ? currentWorkspaceRoot() : owner.state().meta.workspaceRoot;
        },
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
      const wsSettings =
        config === undefined ? resolved : config.resolvedSettings(meta.workspaceRoot);
      const selected = wsSettings?.permissionReviewer;
      if (!selected || selected.backend === "off") return undefined;
      const decisionModel = selected.backend === "decision" ? wsSettings.decisionModel : undefined;
      const key = JSON.stringify([selected, decisionModel]);
      if (key !== reviewerKey) {
        reviewerKey = key;
        const providers = wsSettings.providers;
        if (selected.backend === "decision") {
          modelReviewer = buildDecisionReviewer(
            decisionModel,
            selected.minConfidence ?? 0.7,
            providers,
            session.id,
          );
        } else if (selected.backend === "jev") {
          modelReviewer = createJevSecurityReviewer({
            ...resolveJevConnection(selected, providers, reviewerCredentials(providers), (name) =>
              platform.env(name),
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
        // @ 引用的文件/目录快照附在消息尾部，引用块在首部；审查只读取用户亲自输入的部分。
        const start = entry.quotes?.length ? 1 : 0;
        const snapshots =
          (entry.fileRefs?.filter((ref) => ref.kind !== "image").length ?? 0) +
          (entry.skill ? 1 : 0) +
          (entry.pageComments ? 1 : 0);
        return [
          entry.content
            .slice(start, Math.max(start, entry.content.length - snapshots))
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join(""),
        ];
      });
    const runGit: GitRunner = async (args, signal) => {
      try {
        const child = platform.process.spawn("git", args, {
          cwd: currentCwd(),
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
      environment: {
        get workspaceRoot() {
          return currentWorkspaceRoot();
        },
        nocturneHome,
      },
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

    const isolatedWorktreesRoot = await platform.resolveReal(paths.join(sessionsDir, "worktrees"));
    let knownWorktreeRoots: string[] = [];
    const readAvailableWorktreeRoots = async (): Promise<string[]> => {
      const rawList = await gitWorktrees(projectCwd);
      const realList = await Promise.all(rawList.map((p) => platform.resolveReal(p)));
      return realList.filter((p) => !paths.isWithin(isolatedWorktreesRoot, p));
    };
    if (resume !== undefined) {
      const current = session.state().config.worktree?.current;
      if (current !== undefined && !paths.equals(current, projectCwd)) {
        const stat = await fs.stat(current).catch(() => undefined);
        if (stat?.type !== "directory") {
          const branch = (await gitCurrentBranch(projectCwd)) ?? undefined;
          const prevBranch = session.state().config.branch;
          await session.emit("session.config_changed", {
            worktree: {
              current: projectCwd,
              previous: current,
              ...(branch !== undefined ? { branch } : {}),
            },
            ...(branch !== undefined
              ? {
                  branch: {
                    current: branch,
                    ...(prevBranch !== undefined && prevBranch !== branch
                      ? { previous: prevBranch }
                      : {}),
                  },
                }
              : {}),
          });
        }
      }
    }
    if (session.state().config.worktree !== undefined) {
      knownWorktreeRoots = await readAvailableWorktreeRoots();
    }
    const activeWorktrees = () =>
      session.state().config.worktree !== undefined && knownWorktreeRoots.length > 0
        ? { current: currentCwd(), roots: knownWorktreeRoots }
        : undefined;
    const saveAppPermissions = async (subjects: PermissionSubject[]) => {
      const store = config?.appPermissions;
      if (store === undefined || subjects.some((subject) => subject.appUnresolved === true))
        throw new Error("用户规则存储不可用");
      for (const subject of subjects)
        await store.set(
          subject.target,
          "allow",
          subject.app === undefined
            ? undefined
            : { name: subject.app.name, icon: subject.app.icon },
        );
    };
    // 经委托读取当前 policy，使 setPermissionPreset 立即生效
    let residentPermForwarder: ChildPermissionForwarder | undefined;
    const gate: PermissionGate = createPolicyGate(
      {
        evaluate: (subjects, evaluationOptions) => {
          policy = buildPolicy(
            session.state().config.permissionPreset,
            session.id,
            residentChild?.worktreePath !== undefined ? meta.workspaceRoot : undefined,
            residentWorktreePolicy,
          );
          return policy.evaluate(subjects, evaluationOptions);
        },
      },
      {
        interactive: sessionInteractive,
        ...(unattendedSession ? { nonInteractiveDenyHint: UNATTENDED_DENY_HINT } : {}),
        preset: () => session.state().config.permissionPreset,
        reviewer: () => {
          warnMissingReviewer();
          return getReviewer();
        },
        get cwd() {
          return currentCwd();
        },
        ...reviewSources,
        caseSensitive: platform.caseSensitivePaths,
        grants: { session: sessionGrants, project: ws?.grants },
        saveAppPermissions,
        hooks: hookRunner,
        worktrees: activeWorktrees,
        beforeEvaluate: async (subjects) => {
          const needsRefresh = subjects.some((s) => {
            if (s.kind !== "read") return false;
            const candidate = s.resolved ?? s.target;
            return (
              paths.isWithin(candidate, attachmentsRootReal) &&
              !paths.isWithin(candidate, ownAttachmentsReal)
            );
          });
          if (needsRefresh) {
            await refreshProjectPageFiles();
          }
        },
        ...(residentChild?.permissions !== undefined
          ? {
              onPendingSettled: (requestId: string) => {
                residentPermForwarder?.onPendingSettled(requestId);
              },
            }
          : {}),
      },
    );
    if (residentChild?.permissions !== undefined) {
      const perms = residentChild.permissions;
      residentPermForwarder = attachChildPermissionForwarder({
        child: session,
        gate,
        permissions: {
          register: perms.register,
          clearChild: perms.clearChild,
        },
        parentCallId: perms.parentCallId,
        profile: perms.profile,
        taskSummary: perms.taskSummary,
        workspaceRoot: () => meta.workspaceRoot,
      });
      teardown.push(() => residentPermForwarder?.dispose());
    }
    // 提问通道（ADR-0032）按会话持有：等待中的请求与会话绑定，
    // respondQuestion 按 requestId 路由；非交互时 ask 立即不可用
    const questions = createQuestionBroker({ interactive: sessionInteractive });
    // 会话级工具注册表：内置工具 ∪ MCP 工具（mcp.md 第 4、5 节）。
    // MCP 服务器在会话打开时并行启动；list_changed / 重连带来的工具集变化
    // 先暂存，在主 Turn 开始或用户插话写入后经 applyPendingTools() 应用（ADR-0086）。
    const tools: ToolRegistry = createToolRegistry();
    // ADR-0064 第 7 节：定时任务发起的会话不提供改写定时任务的工具（按特性，不按名字）
    for (const tool of builtinTools()) {
      if (meta.schedule !== undefined && tool.traits.mutatesSchedule === true) continue;
      if (residentChild?.preset === "explore" && tool.traits.mutates) continue;
      if (isSuiteCoordinator && tool.traits.editTool !== undefined) continue;
      if (
        (meta.parent !== undefined || meta.schedule !== undefined) &&
        tool.traits.mainSessionOnly === true
      )
        continue;
      tools.register(tool);
    }
    if (residentChild !== undefined) {
      for (const extra of residentChild.extraTools) {
        tools.unregister(extra.name);
        tools.register(extra);
      }
    }
    if (memoryPolicy.read) {
      const memoryTools = createMemoryTools({
        availableScopes: availableMemoryScopes,
        async readMemory(scope, name) {
          const targetDir = await resolveMemoryScopeDir(platform, nocturneHome, {
            scope,
            ...(scope === "suite" ? { key: suiteId } : { workspaceRoot: meta.workspaceRoot }),
          });
          if (targetDir === undefined) {
            return {
              ok: false,
              code: "memory_not_found",
              message: `Memory "${name}" was not found in ${scope} scope.`,
            };
          }
          return readMemoryEntry(platform, targetDir.dir, scope, name);
        },
        async writeMemory(input) {
          const targetDir = await resolveMemoryScopeDir(platform, nocturneHome, {
            scope: input.scope,
            ...(input.scope === "suite" ? { key: suiteId } : { workspaceRoot: meta.workspaceRoot }),
          });
          if (targetDir === undefined) {
            throw new Error(`Memory scope "${input.scope}" is not available for this workspace.`);
          }
          const entry = await writeMemoryEntry(
            platform,
            {
              dir: targetDir.dir,
              scope: input.scope,
              ...(targetDir.projectPath !== undefined
                ? { projectPath: targetDir.projectPath }
                : {}),
            },
            input,
          );
          notifyMemoryChanged();
          return entry;
        },
        async deleteMemory(scope, name) {
          const targetDir = await resolveMemoryScopeDir(platform, nocturneHome, {
            scope,
            ...(scope === "suite" ? { key: suiteId } : { workspaceRoot: meta.workspaceRoot }),
          });
          if (targetDir === undefined) return false;
          const deleted = await deleteMemoryEntry(platform, targetDir.dir, name);
          if (deleted) notifyMemoryChanged();
          return deleted;
        },
      });
      tools.register(memoryTools.read);
      if (memoryPolicy.write) {
        tools.register(memoryTools.write);
        tools.register(memoryTools.delete);
      }
    }
    if (meta.parent === undefined) {
      tools.register(
        createSwitchWorktreeTool({
          async switchWorktree(rawTarget) {
            const repoRoot = await gitRepository(projectCwd);
            if (repoRoot === null) throw new Error("Project directory is not a git repository");
            const repoReal = await platform.resolveReal(repoRoot);
            const subRel = paths.relative(repoReal, projectCwd);
            const available = await readAvailableWorktreeRoots();
            knownWorktreeRoots = available;
            const resolvedInput = await platform.resolveReal(
              paths.resolve(currentCwd(), rawTarget),
            );
            const customSubagentRoot = resolveWorktreeRootPath(
              config?.resolvedSettings(meta.workspaceRoot).worktree?.subagentRoot,
            );
            const customSubagentRootReal =
              customSubagentRoot !== undefined
                ? await platform.resolveReal(customSubagentRoot)
                : undefined;
            if (
              paths.isWithin(isolatedWorktreesRoot, resolvedInput) ||
              (customSubagentRootReal !== undefined &&
                paths.isWithin(customSubagentRootReal, resolvedInput))
            )
              throw new Error(
                `Cannot switch into isolated subagent worktree under ${customSubagentRootReal && paths.isWithin(customSubagentRootReal, resolvedInput) ? customSubagentRootReal : isolatedWorktreesRoot}. Available worktrees: ${available.join(", ")}`,
              );
            const matchedRoot = available.find((wt) => paths.equals(wt, resolvedInput));
            if (matchedRoot === undefined)
              throw new Error(
                `Target is not an available git worktree of this repository. Available worktrees: ${available.join(", ")}`,
              );
            const targetCwd = subRel ? paths.resolve(matchedRoot, subRel) : matchedRoot;
            const stat = await fs.stat(targetCwd).catch(() => undefined);
            if (stat?.type !== "directory")
              throw new Error(`Target worktree is missing subdirectory ${subRel}: ${targetCwd}`);
            const realTarget = await fs.realpath(targetCwd);
            const previous = await platform.resolveReal(currentCwd());
            const branch = (await gitCurrentBranch(realTarget)) ?? undefined;
            const prevBranch = session.state().config.branch;
            if (!paths.equals(previous, realTarget)) {
              fileIndexPromise = undefined;
              await session.emit("session.config_changed", {
                worktree: {
                  current: realTarget,
                  previous,
                  ...(branch !== undefined ? { branch } : {}),
                },
                ...(branch !== undefined
                  ? {
                      branch: {
                        current: branch,
                        ...(prevBranch !== undefined && prevBranch !== branch
                          ? { previous: prevBranch }
                          : {}),
                      },
                    }
                  : {}),
              });
              policy = buildPolicy(session.state().config.permissionPreset);
            }
            void touchManagedWorktree(sessionsDir, realTarget, session.id).catch(() => undefined);
            return { current: realTarget, ...(branch !== undefined ? { branch } : {}) };
          },
        }),
      );
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
      const didRescan = pendingSkillRescan;
      if (pendingSkillRescan) {
        skillDiscovery = await skillCache.discover({
          nocturneHome,
          workspaceRoot: meta.workspaceRoot,
          cwd: projectCwd,
          config: config?.skillConfig(),
          pluginSkillDirs: await resolveActivePluginSkillDirs(platform, pluginDiscoveryOptions),
        });
        projectSubagentsDiscovery = await discoverProjectSubagents(platform, {
          workspaceRoot: meta.workspaceRoot,
          cwd: projectCwd,
          includeClaude: includeClaudeProjectSubagents(config?.skillConfig()),
        });
      }
      pendingSkillRescan = false;
      pendingSkillEnable = false;
      installSkills();
      policy = buildPolicy(session.state().config.permissionPreset);
      if (didRescan) refreshSessionExternalAgents();
    };
    const refreshSessionSkills = async (rescan: boolean) => {
      pendingSkillRescan ||= rescan;
      pendingSkillEnable = true;
      if (!busy() && compactController === undefined) await applySkills();
    };
    const executor = createToolExecutor(tools, {
      sensitiveForModel: (subjects) => policy.sensitiveForModel?.(subjects) ?? subjects.length > 0,
    });

    // MCP：RuntimeOptions.mcpServers（注入）∪ 配置层 mcpServers（项目层仅信任时并入）∪ 已启用插件 mcpServers
    let sessionPlugins: ActivePluginsResolution = pluginResolution;
    await Promise.all(
      pluginResolution.mcpServers.map((s) =>
        platform.fs.mkdir(s.pluginDataDir).catch(() => undefined),
      ),
    );
    const configuredMcpServerConfigs: McpServerConfig[] = [
      ...(options.mcpServers ?? []),
      ...(resolved?.mcpServers ?? []).map((s) => ({
        ...s.entry,
        name: s.name,
        origin: s.origin,
        dir: s.dir,
      })),
      ...pluginResolution.mcpServers.map((s) => ({
        ...s.entry,
        name: s.id,
        origin: "plugin" as const,
        pluginId: s.pluginId,
        ...(s.cache !== undefined ? { pluginCache: s.cache } : {}),
      })),
    ].filter((s) => s.enabled !== false);
    const hostMcpServers: McpServerConfig[] = (sessionMcp?.servers ?? [])
      .filter((s) => s.enabled !== false)
      .map((s) => ({ ...s, origin: "host" as const }));
    const strictHostMcp = sessionMcp?.strict === true && hostMcpServers.length > 0;
    if (strictHostMcp) {
      if (options.mcp === undefined) {
        throw new RuntimeCommandError(
          "invalid_command",
          "MCP 连接器不可用，无法接入宿主 MCP 服务器",
        );
      }
      const existingNames = new Set(configuredMcpServerConfigs.map((s) => s.name.toLowerCase()));
      const seenHostNames = new Set<string>();
      for (const hostServer of hostMcpServers) {
        const key = hostServer.name.toLowerCase();
        if (seenHostNames.has(key)) {
          throw new RuntimeCommandError(
            "invalid_command",
            `宿主 MCP 服务器名称重复：${hostServer.name}`,
          );
        }
        seenHostNames.add(key);
        if (existingNames.has(key)) {
          throw new RuntimeCommandError(
            "invalid_command",
            `宿主 MCP 服务器名称与当前会话已有 MCP 配置冲突：${hostServer.name}`,
          );
        }
      }
    }
    const mcpServerConfigs: McpServerConfig[] = [...configuredMcpServerConfigs, ...hostMcpServers];
    let mcpSession: McpSession | undefined;
    const recordMcpAvailability = async (signal: AbortSignal): Promise<void> => {
      if (signal.aborted || meta.parent !== undefined || mcpSession === undefined) return;
      const previous = session.state().mcpAvailability ?? {};
      const changes: NonNullable<DurablePayload<"session.config_changed">["mcp"]> = [];
      for (const status of mcpSession.status()) {
        if (status.state === "stopped") continue;
        const available = status.state === "ready" || status.state === "standby";
        if (available === (previous[status.name] ?? true)) continue;
        changes.push({
          server: status.name,
          available,
          ...(!available
            ? {
                reason: (status.state === "starting"
                  ? "startup timed out"
                  : (status.error ?? "unknown reason")
                ).slice(0, 200),
                ...(status.autoRetry !== undefined ? { autoRetry: status.autoRetry } : {}),
              }
            : {}),
        });
      }
      if (changes.length === 0) return;
      await session.emit("session.config_changed", { mcp: changes });
    };
    let pendingMcp = false;
    let mcpUpdate: Promise<void> = Promise.resolve();
    /** 本批 takeSteers 是否含用户插话（不含子代理结果与后台命令）。 */
    let userSteerBoundary = false;
    let mcpOnDemand = false;
    let omittedMcpToolCount = 0;
    const activeMcpTools = new Map<string, ReturnType<McpSession["tools"]>[number]>();
    const registeredMcpNames = new Set<string>();
    const warnedMcpConflicts = new Set<string>();

    const syncMcpToolsRegistry = (): void => {
      for (const name of registeredMcpNames) {
        tools.unregister(name);
      }
      registeredMcpNames.clear();
      tools.unregister(MCP_SEARCH_TOOL_NAME);
      tools.unregister(MCP_CALL_TOOL_NAME);

      const currentMcpTools = [...activeMcpTools.values()].filter(
        (tool) => !(residentChild?.preset === "explore" && tool.traits.mutates),
      );
      const mode =
        config?.resolvedSettings(meta.workspaceRoot).mcpToolSearch ??
        resolved?.mcpToolSearch ??
        options.mcpToolSearch ??
        "auto";
      mcpOnDemand =
        shouldEnableMcpToolSearch(currentMcpTools, mode) ||
        (mode === "always" && (mcpSession?.status().length ?? 0) > 0);
      if (mcpOnDemand) {
        omittedMcpToolCount = currentMcpTools.length;
        const readyServers = (mcpSession?.status() ?? [])
          .filter((s) => s.state === "ready" || s.state === "standby")
          .map((s) => s.name);
        const pair = createMcpOnDemandTools(
          currentMcpTools,
          readyServers,
          () => mcpSession?.status() ?? [],
          async (server, signal) => {
            const diff = (await mcpSession?.recoverTools?.(server, signal)) ?? {
              add: [],
              remove: [],
            };
            if (!signal?.aborted) {
              for (const name of diff.remove) activeMcpTools.delete(name);
              for (const tool of diff.add) activeMcpTools.set(tool.name, tool);
              omittedMcpToolCount = activeMcpTools.size;
            }
            return diff;
          },
        );
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
            pluginMcpCacheDir: paths.join(nocturneHome, "plugins", "cache", "mcp-tools"),
            credentials: config?.credentials,
            ...(sessionMcp?.credentials !== undefined
              ? { hostCredentials: sessionMcp.credentials }
              : {}),
            ...(strictHostMcp ? { strictHostMcp: true } : {}),
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
          if (strictHostMcp) {
            if (opened.startupHost !== undefined) {
              await opened.startupHost();
            } else {
              await opened.startup();
            }
            const statusByName = new Map(
              opened.status().map((item) => [item.name.toLowerCase(), item]),
            );
            const failed = hostMcpServers.flatMap((hostServer) => {
              const st = statusByName.get(hostServer.name.toLowerCase());
              if (st?.state === "ready") return [];
              const reason = st?.error ?? (st ? `状态为 ${st.state}` : "未启动");
              return [`${hostServer.name}: ${reason}`];
            });
            if (failed.length > 0) {
              throw new RuntimeCommandError(
                "invalid_command",
                `宿主 MCP 服务器启动失败：${failed.join("；")}`,
              );
            }
            const diff = opened.applyPendingTools();
            for (const name of diff.remove) {
              activeMcpTools.delete(name);
              warnedMcpConflicts.delete(name);
            }
            for (const tool of diff.add) {
              activeMcpTools.set(tool.name, tool);
            }
          }
          for (const tool of mcpSession.tools()) {
            activeMcpTools.set(tool.name, tool);
          }
          syncMcpToolsRegistry();
        } catch (e) {
          if (strictHostMcp) {
            throw e instanceof RuntimeCommandError
              ? e
              : new RuntimeCommandError(
                  "invalid_command",
                  e instanceof Error ? e.message : String(e),
                );
          }
          warnings.push(`MCP 装配失败：${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }

    const applyMcp = (): Promise<void> => {
      mcpUpdate = mcpUpdate
        .catch(() => undefined)
        .then(async () => {
          if (pendingMcp) {
            pendingMcp = false;
            const next = config
              ? (await config.forWorkspace(meta.workspaceRoot)).resolved.mcpServers
              : [];
            const nextPlugins = await resolvePlugins(platform, {
              ...pluginDiscoveryOptions,
              reservedMcpIds: collectReservedMcpIds(next),
            });
            const currentConflictKeys = new Set<string>();
            for (const conflict of nextPlugins.mcpConflicts) {
              const key = `${conflict.pluginId}:${conflict.serverId}`;
              currentConflictKeys.add(key);
              if (!warnedPluginMcpConflicts.has(key)) {
                warnedPluginMcpConflicts.add(key);
                session.emitEphemeral("runtime.warning", {
                  code: "plugin_mcp_conflict",
                  message: `插件 ${conflict.pluginLabel} 的 MCP 服务器 "${conflict.serverId}" 与已有配置同名，已跳过`,
                });
              }
            }
            for (const oldKey of [...warnedPluginMcpConflicts]) {
              if (!currentConflictKeys.has(oldKey)) warnedPluginMcpConflicts.delete(oldKey);
            }
            await Promise.all(
              nextPlugins.mcpServers.map((s) =>
                platform.fs.mkdir(s.pluginDataDir).catch(() => undefined),
              ),
            );
            sessionPlugins = nextPlugins;
            refreshSessionExternalAgents();
            if (mcpSession !== undefined) {
              await mcpSession.reconcile([
                ...(options.mcpServers ?? []),
                ...next.map((s) => ({ ...s.entry, name: s.name, origin: s.origin, dir: s.dir })),
                ...nextPlugins.mcpServers.map((s) => ({
                  ...s.entry,
                  name: s.id,
                  origin: "plugin" as const,
                  pluginId: s.pluginId,
                  ...(s.cache !== undefined ? { pluginCache: s.cache } : {}),
                })),
              ]);
            }
          }
          if (mcpSession === undefined) return;
          const diff = mcpSession.applyPendingTools();
          for (const name of diff.remove) {
            activeMcpTools.delete(name);
            warnedMcpConflicts.delete(name);
          }
          for (const tool of diff.add) {
            activeMcpTools.set(tool.name, tool);
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
    /**
     * 主 Turn 开始与用户插话后共用的 MCP 边界（ADR-0086）：
     * prepareTurn → applyMcp（applyPendingTools + 模式判定）→ 可用性说明。
     * 中止只放弃等待。没有变化时 recordMcpAvailability 不写事件。
     */
    const prepareMcpBoundary = async (signal: AbortSignal): Promise<void> => {
      // 每次等待后再读 signal：await 期间可能中止，不能把 aborted 收窄后当成常量。
      if (!signal.aborted) await mcpSession?.prepareTurn?.(signal);
      if (!signal.aborted) await awaitMcpIdle(signal);
      if (!signal.aborted) await recordMcpAvailability(signal);
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
        ...Object.values(GEMINI_DECISION_ENDPOINTS).map((entry) => entry.env),
        ...(() => {
          const current = config?.resolvedSettings(meta.workspaceRoot);
          const reviewer = current?.permissionReviewer ?? resolved?.permissionReviewer;
          const decisionModel = current?.decisionModel ?? resolved?.decisionModel;
          const envs: string[] = [];
          if (reviewer?.backend === "jev" && "env" in reviewer.credential) {
            envs.push(reviewer.credential.env);
          }
          if (decisionModel !== undefined && "env" in decisionModel.credential) {
            envs.push(decisionModel.credential.env);
          }
          return envs;
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
    const backgroundShells = new BackgroundShells({
      platform,
      sessionsDir,
      sessionId: session.id,
      deliver: (input) => deliverBackgroundResult(input),
      settled: () => {
        notifyIdle();
      },
      updated: (task) => session.emitEphemeral("shell.task_updated", { task }),
      stopped: async (result) => {
        await session.emit("shell.task_stopped", result);
      },
    });
    const sessionCloseController = new AbortController();
    const execEnv: ExecutionEnvironment = {
      currentDirectory: () => ({ cwd: currentCwd(), workspaceRoot: currentWorkspaceRoot() }),
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
        processor: imageProcessor,
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
      // ADR-0095：读取当前会话持久化笔记
      notes: () => session.state().notes,
      // ADR-0109：读取当前会话有效历史页面列表
      pages: () => session.state().pages,
      // ADR-0114：主会话访问同项目面板页面库（供 list_pages 与 render_html 跨会话接着改）
      ...(residentChild === undefined
        ? {
            projectPages: {
              listPages: async () => {
                const items = await pageLibrary.listPagesWithPaths({
                  workspaceRoot: currentWorkspaceRoot(),
                });
                await refreshProjectPageFiles();
                return items.map((item) => ({
                  ref: item.ref,
                  origin: item.origin,
                  sessionId: item.sessionId,
                  sessionTitle: item.sessionTitle,
                  page: item.page,
                  title: item.title,
                  version: item.version,
                  updatedAt: item.updatedAt,
                  path: item.path,
                }));
              },
              resolvePage: (ref: string) =>
                pageLibrary.resolveCrossSessionPage({
                  workspaceRoot: currentWorkspaceRoot(),
                  ref,
                }),
            },
          }
        : {}),
    };
    const turnConfig: TurnConfig = { ...DEFAULT_TURN_CONFIG };
    for (const src of [resolved?.turn, options.turn]) {
      if (src?.maxSteps !== undefined) turnConfig.maxSteps = src.maxSteps;
      if (src?.retryLimit !== undefined) turnConfig.retryLimit = src.retryLimit;
      if (src?.retryBaseDelayMs !== undefined) turnConfig.retryBaseDelayMs = src.retryBaseDelayMs;
      if (src?.retryMaxDelayMs !== undefined) turnConfig.retryMaxDelayMs = src.retryMaxDelayMs;
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
    const warnedProjectPluginConflicts = new Set<string>();

    // 子代理（subagent.md 第 3 节）：launcher 捕获本会话装配上下文；
    // task 与内置工具同一注册表——Agent Loop 无工具名分支
    let worktreeChain: Promise<void> = Promise.resolve();
    function runWorktreeTask<T>(fn: () => Promise<T>): Promise<T> {
      const next = worktreeChain.then(fn, fn);
      worktreeChain = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    }
    let ensembleController: EnsembleController | undefined;
    let ensembleTurnStarting = false;
    const isEnsembleMaestroActive = (): boolean =>
      Boolean(ensembleController?.isActive()) || ensembleTurnStarting;
    let suiteController: SuiteController | undefined;
    const allActiveIsolatedChildIds = (): ReadonlySet<string> | undefined => {
      if (isSuiteCoordinator) return suiteController?.activeIsolatedChildIds();
      return ensembleController?.activeIsolatedChildIds();
    };

    const scheduleWorktreeCleanup = (): void => {
      if (closing) return;
      void runWorktreeTask(async () => {
        if (closing) return;
        await cleanupMergedWorktrees(sessionsDir, session.id, allActiveIsolatedChildIds());
      }).catch((cause: unknown) => {
        if (closing) return;
        session.emitEphemeral("runtime.warning", {
          code: "worktree_cleanup_failed",
          message: String(cause),
        });
      });
    };

    interface ForwardedPermissionEntry {
      snapshot: SubagentPendingPermission;
      respond: (reply: PermissionReply) => Promise<PermissionRespondOutcome>;
      cancel: () => void;
    }
    const forwardedByRequestId = new Map<string, ForwardedPermissionEntry>();
    let forwardedOrderSeq = 0;
    const emitSubagentPermissions = () => {
      if (session.health !== "ok") return;
      const pending = [...forwardedByRequestId.values()]
        .map((entry) => ({ ...entry.snapshot }))
        .sort((a, b) => a.order - b.order);
      session.emitEphemeral("subagent.permissions", { pending });
    };
    const forwardedPermissions = {
      register(input: {
        childSessionId: string;
        parentCallId: string;
        profile: string;
        taskSummary: string;
        request: Omit<PendingPermission, "seq">;
        respond: (reply: PermissionReply) => Promise<PermissionRespondOutcome>;
        cancel: () => void;
      }): () => void {
        const order = ++forwardedOrderSeq;
        const afterSeq = session.state().lastSeq;
        const snapshot: SubagentPendingPermission = {
          ...input.request,
          childSessionId: input.childSessionId,
          parentCallId: input.parentCallId,
          profile: input.profile,
          taskSummary: input.taskSummary,
          afterSeq,
          order,
        };
        forwardedByRequestId.set(input.request.requestId, {
          snapshot,
          respond: input.respond,
          cancel: input.cancel,
        });
        emitSubagentPermissions();
        let removed = false;
        return () => {
          if (removed) return;
          removed = true;
          if (forwardedByRequestId.delete(input.request.requestId)) {
            emitSubagentPermissions();
          }
        };
      },
      clearChild(childSessionId: string) {
        let changed = false;
        for (const [reqId, entry] of [...forwardedByRequestId.entries()]) {
          if (entry.snapshot.childSessionId === childSessionId) {
            forwardedByRequestId.delete(reqId);
            changed = true;
          }
        }
        if (changed) emitSubagentPermissions();
      },
      cancelWaiting(): boolean {
        const entries = [...forwardedByRequestId.values()];
        if (entries.length === 0) return false;
        for (const entry of entries) {
          entry.cancel();
        }
        return true;
      },
      snapshots(): SubagentPendingPermission[] {
        return [...forwardedByRequestId.values()]
          .map((entry) => ({ ...entry.snapshot }))
          .sort((a, b) => a.order - b.order);
      },
      async respond(
        childSessionId: string,
        requestId: string,
        reply: PermissionReply,
      ): Promise<PermissionRespondOutcome> {
        const entry = forwardedByRequestId.get(requestId);
        if (entry?.snapshot.childSessionId !== childSessionId) {
          return "unknown_request";
        }
        return await entry.respond(reply);
      },
    };

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
      const pricingForModel = (modelStr: string | undefined): ModelPricing | undefined => {
        let ref: ModelRef;
        if (modelStr !== undefined) {
          try {
            ref = parseModelRef(modelStr);
          } catch {
            return undefined;
          }
        } else {
          ref = model.model.ref;
        }
        return resolvePricing(sessionRegistry, ref)?.pricing;
      };
      const resolvedSettingsNow = config?.resolvedSettings(session.state().meta.workspaceRoot);
      const defaultTaskModel = resolvedSettingsNow?.modelRoles?.task;
      const defaultTaskPricing = pricingForModel(defaultTaskModel);
      const configuredProfiles = resolvedSettingsNow?.subagentProfiles ?? {};
      const configuredPluginModels = resolvedSettingsNow?.pluginSubagentModels ?? {};
      const projectSubagents: Record<string, ProjectSubagentDefinition> = Object.fromEntries(
        projectSubagentsDiscovery.active.map((agent) => [
          agent.id,
          {
            id: agent.id,
            name: agent.name,
            source: agent.source,
            path: agent.path,
            relativePath: agent.relativePath,
            description: agent.description,
            prompt: agent.prompt,
            ...(agent.effort !== undefined ? { effort: agent.effort } : {}),
            ...(agent.tools !== undefined ? { tools: agent.tools } : {}),
            ...(agent.disallowedTools !== undefined
              ? { disallowedTools: agent.disallowedTools }
              : {}),
          },
        ]),
      );
      const effectivePluginAgents = sessionPlugins.agents.filter((agent) => {
        if (projectSubagents[agent.id] === undefined) return true;
        if (!warnedProjectPluginConflicts.has(agent.id)) {
          warnedProjectPluginConflicts.add(agent.id);
          const message = `插件 ${agent.pluginLabel} 的子代理 ${agent.id} 与项目子代理同名，已跳过`;
          warnings.push(message);
          session.emitEphemeral("runtime.warning", {
            code: "config_warning",
            message,
          });
        }
        return false;
      });
      const pluginSubagents: Record<string, PluginSubagentDefinition> = Object.fromEntries(
        effectivePluginAgents.map((agent) => [
          agent.id,
          {
            id: agent.id,
            pluginId: agent.pluginId,
            pluginName: agent.pluginName,
            pluginDisplayName: agent.pluginDisplayName,
            description: agent.description,
            prompt: agent.prompt,
            ...(agent.effort !== undefined ? { effort: agent.effort } : {}),
            ...(agent.tools !== undefined ? { tools: agent.tools } : {}),
          },
        ]),
      );
      const userProfileSnapshot = Object.entries(configuredProfiles).flatMap(([name, profile]) => {
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
        const pricing = pricingForModel(profile.model);
        return [{ ...profile, name, ...(pricing !== undefined ? { pricing } : {}) }];
      });
      const defaultTaskAvailable =
        defaultTaskModel !== undefined
          ? resolveModelRole(sessionRegistry, defaultTaskModel, "task") !== undefined
          : model.model.unavailable === undefined;
      const defaultTaskLabel =
        defaultTaskModel ?? `${model.model.ref.provider}/${model.model.ref.model}`;
      const projectProfileSnapshot = projectSubagentsDiscovery.active.flatMap((agent) => {
        const key = `${agent.id}/${defaultTaskLabel}`;
        if (!defaultTaskAvailable) {
          if (!unavailableProfiles.has(key)) {
            unavailableProfiles.add(key);
            const message = `子代理档位 ${agent.id} 的模型 ${defaultTaskLabel} 不可用，已排除`;
            warnings.push(message);
            session.emitEphemeral("runtime.warning", {
              code: "subagent_profile_unavailable",
              message,
            });
          }
          return [];
        }
        unavailableProfiles.delete(key);
        return [
          {
            name: agent.id,
            description: truncateSubagentTableDescription(agent.description),
            enabled: true,
            ...(defaultTaskModel !== undefined ? { model: defaultTaskModel } : {}),
            ...(agent.effort !== undefined ? { effort: agent.effort } : {}),
            ...(defaultTaskPricing !== undefined ? { pricing: defaultTaskPricing } : {}),
          },
        ];
      });
      const pluginProfileSnapshot = effectivePluginAgents.flatMap((agent) => {
        const configuredModel = configuredPluginModels[agent.id];
        const key = `${agent.id}/${configuredModel}`;
        if (
          configuredModel !== undefined &&
          resolveModelRole(sessionRegistry, configuredModel, "task") === undefined
        ) {
          if (!unavailableProfiles.has(key)) {
            unavailableProfiles.add(key);
            const message = `子代理档位 ${agent.id} 的模型 ${configuredModel} 不可用，已排除`;
            warnings.push(message);
            session.emitEphemeral("runtime.warning", {
              code: "subagent_profile_unavailable",
              message,
            });
          }
          return [];
        }
        unavailableProfiles.delete(key);
        const effectiveModel = configuredModel ?? defaultTaskModel;
        const pricing =
          configuredModel !== undefined ? pricingForModel(configuredModel) : defaultTaskPricing;
        return [
          {
            name: agent.id,
            description: agent.description,
            enabled: true,
            ...(effectiveModel !== undefined ? { model: effectiveModel } : {}),
            ...(agent.effort !== undefined ? { effort: agent.effort } : {}),
            ...(pricing !== undefined ? { pricing } : {}),
          },
        ];
      });
      // 选择表顺序：default → 用户档位 → 项目子代理 → 插件子代理 → 外部 agent（ADR-0105、ADR-0108）
      const profileSnapshot = [
        ...userProfileSnapshot,
        ...projectProfileSnapshot,
        ...pluginProfileSnapshot,
      ];
      const hasExternalAgents = enabledExternalAgents.length > 0;
      // ADR-0073 §4、§5：宿主开启时只在顶层交互会话可用；子会话与定时任务会话不出现该字段
      if (
        (options.shell?.background === true || isSuiteCoordinator) &&
        meta.parent === undefined &&
        meta.schedule === undefined
      ) {
        tools.unregister("shell");
        tools.register(createShellTool(backgroundShells));
        for (const tool of shellTaskTools(backgroundShells)) {
          tools.unregister(tool.name);
          tools.register(tool);
        }
      }
      const backgroundEnabled =
        options.subagent?.background === true &&
        meta.parent === undefined &&
        meta.schedule === undefined;
      tools.unregister("apply_subagent_changes");
      if (backgroundEnabled || isSuiteCoordinator) {
        const lookup = (id: string) => {
          const events = effectiveEvents(session.durableEvents());
          const changes = events
            .flatMap((event) =>
              event.type === "message.user" &&
              event.payload.subagent?.childSessionId === id &&
              event.payload.subagent.changes
                ? [event.payload.subagent.changes]
                : [],
            )
            .at(-1);
          if (changes) {
            const applied = events.some(
              (event) =>
                event.type === "tool.completed" &&
                event.payload.name === "apply_subagent_changes" &&
                event.payload.status === "ok" &&
                (event.payload.output as { id?: string } | undefined)?.id === id,
            );
            return {
              changes,
              repository: currentWorkspaceRoot(),
              applied,
              residentKind: undefined as ResidentKind | undefined,
            };
          }
          const ensembleFound = ensembleController?.lookupMemberWorktreeSync(id);
          if (ensembleFound !== undefined) {
            return { ...ensembleFound, residentKind: "ensemble" as const };
          }
          const suiteFound = suiteController?.lookupThreadWorktreeSync(id);
          if (suiteFound !== undefined) {
            return { ...suiteFound, residentKind: "suite" as const };
          }
          return undefined;
        };
        tools.register(
          createApplySubagentChangesTool({
            lookup,
            async apply(id, mode, expectedHead) {
              const { applied, residentKind, head } = await runWorktreeTask(async () => {
                const result = lookup(id);
                if (!result || result.applied)
                  throw new Error("No unapplied isolated changes found");
                const headError = checkExpectedHead(id, result.changes.head, expectedHead);
                if (headError !== undefined) throw new ExpectedHeadMismatchError(headError);
                const repository =
                  result.residentKind !== undefined
                    ? result.repository
                    : await inspectWorktreeRepository(currentWorkspaceRoot());
                const out = await applyWorktreeChanges(repository, result.changes, mode);
                if (result.residentKind === undefined) {
                  await removeWorktree(
                    {
                      repository,
                      worktree: result.changes.worktree,
                      branch: result.changes.branch,
                    },
                    false,
                  ).catch((cause: unknown) =>
                    session.emitEphemeral("runtime.warning", {
                      code: "worktree_cleanup_failed",
                      message: String(cause),
                    }),
                  );
                }
                return {
                  applied: out,
                  residentKind: result.residentKind,
                  head: result.changes.head,
                };
              });
              if (residentKind === "ensemble") {
                await ensembleController?.onMemberWorktreeApplied(id, head);
              } else if (residentKind === "suite") {
                await suiteController?.onThreadWorktreeApplied(id, head);
              }
              return applied;
            },
          }),
        );
      }
      for (const spec of tools.specs()) {
        if (tools.get(spec.name)?.traits.spawnsSubagent === true) {
          tools.unregister(spec.name);
        }
      }
      if (residentChild !== undefined || isEnsembleMaestroActive() || isSuiteCoordinator) return;
      if (!subagentEnabled && !hasExternalAgents) return;
      let launcher: SubagentLauncher | undefined;
      if (subagentEnabled)
        launcher = createSubagentLauncher({
          background: backgroundEnabled
            ? {
                lifecycle: backgroundSubagents,
                max: options.subagent?.maxBackground ?? 3,
                deliver: (input) => deliverBackgroundResult(input),
              }
            : undefined,
          checkpoint: execEnv.checkpoint,
          store,
          sessionsDir,
          imageProcessor,
          platform,
          diagnostics,
          instructions,
          environment,
          profiles: profileSnapshot,
          defaultModel: defaultTaskModel,
          defaultPricing: defaultTaskPricing,
          availableModels: () =>
            sessionRegistry.providers().flatMap((provider) =>
              provider.models().flatMap((info) => {
                const id = `${info.ref.provider}/${info.ref.model}`;
                return resolveModelRole(sessionRegistry, id, "task") === undefined ? [] : [id];
              }),
            ),
          resolveModel: (ref) => resolveModelRole(sessionRegistry, ref, "task"),
          resolveProfile: (name, currentModel) => {
            const taskRole = config?.resolvedSettings(session.state().meta.workspaceRoot).modelRoles
              ?.task;
            const effectiveCurrent = currentModel ?? model;
            const resolvedTaskRole = resolveModelRole(sessionRegistry, taskRole, "task");
            if (
              projectSubagents[name] !== undefined &&
              taskRole === undefined &&
              effectiveCurrent.model.unavailable !== undefined
            ) {
              return undefined;
            }
            return resolveSubagentProfile(
              name,
              configuredProfiles,
              (ref) => resolveModelRole(sessionRegistry, ref, "task"),
              effectiveCurrent,
              resolvedTaskRole ?? effectiveCurrent,
              pluginSubagents,
              configuredPluginModels,
              projectSubagents,
              taskRole,
            );
          },
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
          trusted: ws?.projectConfig.trusted === true,
          warning: (code, message) => session.emitEphemeral("runtime.warning", { code, message }),
          makePolicy: (childSessionId, workspaceRoot, worktree) =>
            buildPolicy(
              session.state().config.permissionPreset,
              childSessionId,
              workspaceRoot,
              worktree,
            ),
          makeHookRunner,
          mcpTools: () => [...activeMcpTools.values()],
          mcpOnDemand: () => mcpOnDemand,
          mcpServers: () => [
            ...new Set([
              ...mcpServerConfigs.map((s) => s.name),
              ...(mcpSession?.status() ?? [])
                .filter((s) => s.state === "ready" || s.state === "standby")
                .map((s) => s.name),
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
          worktrees: activeWorktrees,
          worktreeOptions: () => {
            const resolved = config?.resolvedSettings(session.state().meta.workspaceRoot);
            return {
              subagentRoot: resolved?.worktree?.subagentRoot,
              branchPrefix: resolved?.git?.branchPrefix,
              fetchBeforeCreate: resolved?.worktree?.fetchBeforeCreate,
            };
          },
          onWorktreeCreated: async (record) => {
            await registerManagedWorktree(sessionsDir, {
              kind: "subagent",
              repository: record.repository,
              worktreePath: record.worktree,
              branch: record.branch,
              ownsBranch: true,
              sessionId: record.parentSessionId,
              childSessionId: record.childSessionId,
            }).catch(() => undefined);
          },
          onWorktreeSettled: async (record, kept) => {
            if (!kept) {
              await unregisterManagedWorktree(
                sessionsDir,
                `subagent:${record.childSessionId}`,
              ).catch(() => undefined);
            } else {
              await maybePruneManagedWorktrees();
            }
          },
          depth: 0,
          limits: subagentLimits,
          limiter: subagentLimiter,
          registry: subagentRegistry,
          permissions: {
            interactive: sessionInteractive,
            saveAppPermissions,
            register: (input) => forwardedPermissions.register(input),
            clearChild: (childSessionId) => {
              forwardedPermissions.clearChild(childSessionId);
            },
            onGrantChanged: (remember) => {
              grantsChanged(
                remember === "project" || remember === "pattern"
                  ? { workspace: meta.workspaceRoot }
                  : { sessionId: grantRootId },
              );
            },
          },
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
                      cwd: currentCwd(),
                      ...reviewSources,
                      caseSensitive: platform.caseSensitivePaths,
                      hooks: hookRunner,
                      worktrees: activeWorktrees,
                    },
                  );
                  return await externalConnector.run(
                    agentConfig,
                    {
                      ...request,
                      cwd: currentWorkspaceRoot(),
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
          defaultTaskModel,
          backgroundEnabled && launcher !== undefined
            ? (input) => backgroundAdmission({ ...input, isolation: "none" })
            : undefined,
          defaultTaskPricing,
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
    let fileIndexRoot: string | undefined;
    let compactController: AbortController | undefined;
    let turnSettled: Promise<void> | undefined;
    let compactSettled: Promise<void> | undefined;
    let closing = false;
    let rewinding = false;
    let rewindSettled: Promise<void> | undefined;
    /** 归档旁路写入/删除进行中；与 submit 的 Turn 启动互相排斥（ADR-0080） */
    let archiving = false;
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
    const assertPageUsable = () => {
      assertUsable();
      if (rewinding) throw new RuntimeCommandError("session_busy", "会话正在回退或分叉");
    };
    const pageStorage = createPageStorage(platform, sessionsDir, session);
    const pagePermission = createPagePermissionGate({
      sessionId: session.id,
      policy: () => policy,
      emit: (request) => session.emitEphemeral("page.permission_requested", request),
      grant: async (grant) => {
        if (!ws) throw new SessionError("page_model_failed", "项目授权存储不可用");
        await ws.grants.add(grant);
        grantsChanged({ workspace: meta.workspaceRoot });
      },
    });
    const pageModels = createPageModelCalls({
      session,
      model: () =>
        resolveModelRole(
          sessionRegistry,
          config?.resolvedSettings(meta.workspaceRoot).modelRoles?.smol,
          "smol",
        ) ?? model,
      permission: (page, title, modelName, signal) =>
        pagePermission.check(page, title, modelName, signal),
      firstEventTimeoutMs: options.turn?.firstEventTimeoutMs,
      idleTimeoutMs: options.turn?.idleTimeoutMs,
    });
    let pageCleanupNeeded = false;
    const cleanPageData = async () => {
      const kept = new Set(deriveSessionPages(session.durableEvents()).map(({ page }) => page));
      await prunePageData(platform, sessionsDir, session.id, kept);
      pageCleanupNeeded = false;
    };
    const busy = () => controller !== undefined || rewinding || archiving;
    const compacting = () => compactController !== undefined;
    const idleListeners = new Set<() => void>();
    const isIdle = () =>
      controller === undefined &&
      backgroundSubagents.count(session.id) === 0 &&
      backgroundShells.count() === 0 &&
      !(ensembleController?.hasRunningWork() ?? false) &&
      !(suiteController?.hasRunningWork() ?? false);
    const notifyIdle = () => {
      if (closing || !isIdle()) return;
      for (const listener of idleListeners) {
        try {
          listener();
        } catch {
          // 宿主监听失败不影响任务收束。
        }
      }
    };
    const assertBranchNotSwitching = () => {
      if (switching(branchWatchPath()))
        throw new RuntimeCommandError("session_busy", "工作目录正在切换分支");
    };
    const recordBranch = async (): Promise<void> => {
      const current = await gitCurrentBranch(currentCwd());
      if (current === null || controller?.signal.aborted) return;
      const previous = session.state().config.branch;
      if (previous !== current)
        await session.emit("session.config_changed", {
          branch: { current, ...(previous !== undefined ? { previous } : {}) },
        });
    };
    const validateForkTarget = (targetSeq?: number) => {
      if (
        targetSeq !== undefined &&
        // ADR-0070 §7：插话不是回退目标
        !session
          .state()
          .history.some(
            (e) =>
              e.kind === "user" &&
              e.seq === targetSeq &&
              e.steer !== true &&
              e.ensembleQuietReminder !== true,
          )
      )
        throw new RuntimeCommandError("invalid_command", "目标不是当前有效对话中的用户消息");
    };

    // 待发输入（ADR-0070）：会话内存中的运行态，不写日志。每次变化把完整快照发成
    // 临时事件 input.pending；新附加的客户端经 pendingInputs() 取当前快照。
    const pendingInputStore = new PendingInputs((snapshot) =>
      session.emitEphemeral("input.pending", snapshot),
    );
    /** 子会话不参与待发输入（ADR-0070 §5）；活动 Ensemble 常驻成员除外（ADR-0089 §6、§10） */
    const assertMainSession = () => {
      if (meta.parent !== undefined)
        throw new RuntimeCommandError("invalid_command", "子会话不能收发待发输入");
    };
    const assertSubmittableSession = () => {
      const kind = residentKindOf(meta.parent?.callId);
      if (kind !== undefined && !residentChild?.isActive()) {
        throw new RuntimeCommandError(
          "invalid_command",
          kind === "suite" ? "线程已关闭" : "合奏成员已移除或合奏已结束",
        );
      }
    };
    const assertInputQueueAllowed = () => {
      assertSubmittableSession();
      if (meta.parent !== undefined && !residentChild?.isActive()) {
        throw new RuntimeCommandError("invalid_command", "子会话不能收发待发输入");
      }
    };
    /**
     * 已打开会话的归档写入（ADR-0080）。复用 Turn/压缩/回退/关闭/后台子代理/待发输入
     * 的忙判定；`archiving` 占忙，与 startTurns 同步置位的 controller 互斥，异步旁路不会和 Turn 交错。
     */
    const setArchived = async (archivedAt: string): Promise<void> => {
      assertUsable();
      if (meta.parent !== undefined)
        throw new RuntimeCommandError("invalid_command", "子会话不能归档或恢复");
      if (
        busy() ||
        compacting() ||
        closing ||
        backgroundSubagents.count(session.id) > 0 ||
        pendingInputStore.snapshot().items.length > 0
      )
        throw new RuntimeCommandError("session_busy", "会话正忙，不能归档");
      archiving = true;
      try {
        await store.setArchivedAt(session.id, archivedAt);
      } finally {
        archiving = false;
      }
    };
    /** 已打开会话的恢复（ADR-0080）：只校验 ID 与根会话，删除旁路，不判断忙。 */
    const unarchiveOpen = async (): Promise<void> => {
      if (meta.parent !== undefined)
        throw new RuntimeCommandError("invalid_command", "子会话不能归档或恢复");
      await store.removeArchivedAt(session.id);
    };
    /** submit 前无条件删除归档旁路；失败只记诊断（store 内），不挡发送。 */
    const restoreArchivedForSubmit = async (): Promise<boolean> => {
      try {
        return await store.removeArchivedAt(session.id);
      } catch {
        return false;
      }
    };
    /**
     * 后台子代理结果交付（ADR-0073 §3）：正文按工具结果同样的预算截断落盘，再作为
     * mode=subagent 的待发输入；空闲且未暂停时立即开新 Turn，运行中留给安全点。
     */
    let subagentDelivery = Promise.resolve();
    const deliverBackgroundResult = (input: PreparedInput): Promise<void> => {
      subagentDelivery = subagentDelivery.then(() => enqueueBackgroundResult(input));
      return subagentDelivery;
    };
    const enqueueBackgroundResult = async (input: PreparedInput): Promise<void> => {
      const block = input.content[0];
      const callId = input.subagent?.callId;
      if (block?.type === "text" && callId !== undefined) {
        const budget = truncateModelContent(block.text, DEFAULT_MAX_MODEL_CHARS);
        if (budget.truncated && budget.span !== undefined) {
          let spillPath: string | undefined;
          try {
            spillPath = await writeSpill({
              fs,
              paths,
              attachmentsDir: paths.join(sessionsDir, "attachments"),
              sessionId: session.id,
              callId: `${callId}-result`,
              content: block.text,
            });
          } catch {
            // 与工具结果相同：落盘失败降级为普通截断
          }
          block.text = `${budget.text}\n${truncationNote(block.text, budget.span, DEFAULT_MAX_MODEL_CHARS, spillPath)}`;
        }
      }
      if (closing || session.health !== "ok") return;
      pendingInputStore.add(input.backgroundShell ? "shell" : "subagent", input);
      // 不等开启的 Turn 结束：后台任务在交付后即收束，不占并发计数
      void pumpQueue().catch(() => {
        pendingInputStore.pauseAll();
      });
    };
    /**
     * 用户提交的执行方式输入（ADR-0076 §1）：只有它们在 Turn 开始前触发模式副作用。
     * Runtime 自己写的模式消息（继续目标、批准计划）同样带 workMode，但不在这里。
     */
    const workModeStarts = new WeakSet<PreparedInput>();
    /**
     * 准备一条提交内容：附件落盘、`@` 引用与技能正文固定成快照块。普通提交与
     * 待发输入共用——待发输入在被消费时不再读盘或重新解析。
     */
    const prepareInput = async (
      input: SubmitInput,
      signal: AbortSignal,
    ): Promise<PreparedInput> => {
      if (input.skill !== undefined && input.delegate !== undefined)
        throw new RuntimeCommandError("invalid_command", "skill 与 delegate 互斥");
      // ADR-0076 §1：执行方式与技能、委派互斥，正文就是任务
      if (input.workMode !== undefined) {
        if (!isWorkModeName(input.workMode))
          throw new RuntimeCommandError(
            "invalid_command",
            `未知执行方式：${String(input.workMode)}`,
          );
        if (input.skill !== undefined || input.delegate !== undefined)
          throw new RuntimeCommandError("invalid_command", "workMode 与 skill、delegate 互斥");
        if (meta.parent !== undefined)
          throw new RuntimeCommandError("invalid_command", "子会话不能使用执行方式");
        // ADR-0076 §6：/fugue 依赖后台子代理
        if (
          input.workMode === "fugue" &&
          (!subagentEnabled || options.subagent?.background !== true || meta.schedule !== undefined)
        )
          throw new RuntimeCommandError("invalid_command", "当前环境不支持后台子代理");
        // ADR-0089 §1：/ensemble 依赖后台子代理、子代理启用且非无人值守/定时任务，同时至多一个活动 Ensemble
        if (input.workMode === "ensemble") {
          if (isSuiteCoordinator) {
            throw new RuntimeCommandError("invalid_command", "组曲指挥会话不能启动合奏");
          }
          if (
            !subagentEnabled ||
            options.subagent?.background !== true ||
            meta.schedule !== undefined ||
            unattendedOption
          ) {
            throw new RuntimeCommandError("invalid_command", "当前环境不支持合奏");
          }
          if (ensembleController?.isActive()) {
            throw new RuntimeCommandError(
              "invalid_command",
              "当前会话已有进行中的合奏，请先结束当前合奏",
            );
          }
        }
        const task = (input.content ?? [{ type: "text", text: input.text ?? "" }])
          .map((block) => (block.type === "text" ? block.text : ""))
          .join("")
          .trim();
        if (task === "")
          throw new RuntimeCommandError(
            "invalid_command",
            `/${workModeCommandName(input.workMode)} 需要写明任务`,
          );
      }
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
      let pageComments: PageCommentsSnapshot | undefined;
      const commentScreenshotInputs: NonNullable<SubmitInput["attachments"]> = [];
      const commentScreenshotIndices = new Set<number>();
      if (input.pageComments !== undefined) {
        const raw = input.pageComments;
        if (
          typeof raw.page !== "string" ||
          raw.page.trim() === "" ||
          !Number.isInteger(raw.version) ||
          raw.version < 1 ||
          typeof raw.title !== "string" ||
          !Array.isArray(raw.comments) ||
          raw.comments.length === 0
        ) {
          throw new RuntimeCommandError("invalid_command", "pageComments 参数不合法");
        }
        const items = raw.comments.map((item, idx) => {
          if (item.replyTo !== undefined) {
            if (
              typeof item.replyTo !== "string" ||
              !new RegExp(PAGE_COMMENT_ID_PATTERN).test(item.replyTo) ||
              typeof item.note !== "string" ||
              item.note.trim() === ""
            ) {
              throw new RuntimeCommandError("invalid_command", "无效的评论回复");
            }
            const thread = session
              .state()
              .pages.find((page) => page.page === raw.page.trim())
              ?.comments?.find((comment) => comment.id === item.replyTo);
            if (thread === undefined || thread.resolved)
              throw new RuntimeCommandError("invalid_command", "评论不存在或已解决");
            return { replyTo: item.replyTo, note: item.note.trim() };
          }
          if (
            typeof item.path !== "string" ||
            typeof item.text !== "string" ||
            typeof item.x !== "number" ||
            !Number.isFinite(item.x) ||
            typeof item.y !== "number" ||
            !Number.isFinite(item.y) ||
            typeof item.note !== "string" ||
            item.note.trim() === ""
          ) {
            throw new RuntimeCommandError(
              "invalid_command",
              `pageComments.comments[${idx}] 不合法`,
            );
          }
          const trimmedText = item.text.trim().slice(0, PAGE_COMMENT_TEXT_MAX_CHARS);
          const trimmedNote = item.note.trim();
          // ADR-0113：无可见文字元素且当前模型支持图片输入时，附带点击处周围截图
          if (
            item.screenshot !== undefined &&
            trimmedText === "" &&
            model.model.capabilities.imageInput
          ) {
            commentScreenshotIndices.add(idx);
            commentScreenshotInputs.push({
              data: item.screenshot.data,
              mimeType: item.screenshot.mimeType,
              label:
                item.screenshot.label ??
                `page-comment-${raw.page.trim()}-v${raw.version}-${idx + 1}.png`,
              source: "paste",
            });
          }
          return {
            path: item.path,
            text: trimmedText,
            x: Math.round(item.x),
            y: Math.round(item.y),
            note: trimmedNote,
          };
        });
        pageComments = {
          page: raw.page.trim(),
          version: raw.version,
          title: raw.title,
          comments: items,
        };
      }
      const combinedAttachmentInputs = [...(input.attachments ?? []), ...commentScreenshotInputs];
      const attachmentError = validateAttachmentInputs(combinedAttachmentInputs);
      if (attachmentError) throw new RuntimeCommandError("invalid_command", attachmentError);
      if (combinedAttachmentInputs.length && !execEnv.attachments)
        throw new RuntimeCommandError("invalid_command", "附件存储不可用");
      const saveAttachments = async () => {
        if (!execEnv.attachments) return { attachments: [], files: [] };
        try {
          return await saveInputAttachments(
            execEnv.attachments,
            combinedAttachmentInputs,
            false,
            effectiveSignal,
          );
        } catch (err) {
          if (effectiveSignal.aborted) throw err;
          if (err instanceof ImageTooLargeError || err instanceof ImageCorruptError) {
            throw new RuntimeCommandError("invalid_command", err.message);
          }
          throw err;
        }
      };
      const effectiveSignal = AbortSignal.any([signal, sessionCloseController.signal]);
      const { attachments, files } = await saveAttachments();
      const refs = await resolveFileRefs(content, {
        fs: platform.fs,
        paths: platform.paths,
        cwd: currentCwd(),
        workspaceRoot: currentWorkspaceRoot(),
        readState: execEnv.readState,
        attachments: execEnv.attachments,
        imageInput:
          model.model.capabilities.imageInput ||
          resolveModelRole(
            sessionRegistry,
            config?.resolvedSettings(session.state().meta.workspaceRoot).modelRoles?.vision,
            "vision",
          ) !== undefined,
        signal: effectiveSignal,
      });
      for (const message of refs.warnings) {
        session.emitEphemeral("runtime.warning", { code: "file_reference", message });
      }
      // 追加块（@ 引用、技能正文、委派指令）与用户正文分开保存：编辑待发输入
      // 的文本时只替换正文，快照块原样保留
      const appended = refs.content.slice(content.length);
      let skillSnapshot: SkillSnapshot | undefined;
      let skillInvocation: SkillInvocation | undefined;
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
        const body = renderSkill(source.body, overview, invocation, meta.workspaceRoot, session.id);
        skillSnapshot = { name: overview.name, body };
        skillInvocation = {
          name: overview.name,
          ...(invocation.arguments !== undefined ? { arguments: invocation.arguments } : {}),
        };
        const escaped = overview.name
          .replace(/&/g, "&amp;")
          .replace(/"/g, "&quot;")
          .replace(/</g, "&lt;");
        appended.push({
          type: "text",
          text: `<skill name="${escaped}">\n${body}\n</skill>`,
        });
      }
      if (delegation !== undefined) {
        appended.push({
          type: "text",
          text:
            "用户明确要求委派给指定的外部 agent。请调用 task 工具，" +
            `agent 设为 ${JSON.stringify(delegation.agent)}，将下面的任务原文作为 task 参数，不要改写；` +
            "不要设置 preset、tools 或 outputSchema。委派入口仍遵循正常权限流程。\n任务原文：\n" +
            delegation.task,
        });
      }
      if (attachments.length + refs.attachments.length + files.length > 10)
        throw new RuntimeCommandError("invalid_command", "每条消息最多 10 个附件");
      if (files.length)
        appended.push({
          type: "text",
          text: attachmentReferences(files, (file) =>
            platform.paths.join(sessionsDir, "attachments", session.id, file),
          ),
        });
      let workMode: WorkModeSnapshot | undefined;
      if (input.workMode !== undefined) {
        const gitRepository =
          input.workMode === "fugue" || input.workMode === "ensemble"
            ? await inspectWorktreeRepository(currentWorkspaceRoot()).then(
                () => true,
                () => false,
              )
            : undefined;
        workMode = {
          name: input.workMode,
          body: workModeBody(input.workMode, {
            maxBackground: options.subagent?.maxBackground ?? 3,
            gitRepository,
          }),
        };
        appended.push({ type: "text", text: workModeBlock(workMode.name, workMode.body) });
      }
      let quotes: MessageQuote[] | undefined;
      let prepended: ContentBlock[] | undefined;
      if (input.quotes !== undefined) {
        if (!Array.isArray(input.quotes)) {
          throw new RuntimeCommandError("invalid_command", "quotes 参数必须是数组");
        }
        if (input.quotes.length > 0) {
          quotes = input.quotes.map((item, idx) => {
            if (typeof item !== "object" || typeof item.text !== "string") {
              throw new RuntimeCommandError("invalid_command", `quotes[${idx}] 不合法`);
            }
            const normalized = normalizeQuoteText(item.text);
            if (normalized === "") {
              throw new RuntimeCommandError("invalid_command", `quotes[${idx}].text 不能为空`);
            }
            if (item.seq !== undefined && (!Number.isInteger(item.seq) || item.seq < 1)) {
              throw new RuntimeCommandError("invalid_command", `quotes[${idx}].seq 必须是正整数`);
            }
            return {
              text: normalized,
              ...(item.seq !== undefined ? { seq: item.seq } : {}),
            };
          });
          prepended = [{ type: "text", text: formatQuotesBlock(quotes) }];
        }
      }
      const prepared: PreparedInput = {
        ...(commentScreenshotIndices.size > 0
          ? { pageCommentScreenshotIndices: commentScreenshotIndices }
          : {}),
        ...(prepended !== undefined ? { prepended } : {}),
        content,
        appended,
        ...(files.length ? { files } : {}),
        attachments: [...attachments, ...refs.attachments],
        fileRefs: refs.fileRefs,
        ...(skillSnapshot !== undefined ? { skill: skillSnapshot } : {}),
        ...(skillInvocation !== undefined ? { skillInvocation } : {}),
        ...(delegation !== undefined ? { delegate: delegation } : {}),
        ...(workMode !== undefined ? { workMode } : {}),
        ...(pageComments !== undefined ? { pageComments } : {}),
        ...(quotes !== undefined ? { quotes } : {}),
      };
      if (workMode !== undefined) workModeStarts.add(prepared);
      return prepared;
    };
    // ── 目标模式（ADR-0076 §4）：状态在 config_changed.goal，由这里写入 ──
    let clearingGoal = false;
    const writeGoal = async (status: GoalStatus, reason?: string): Promise<void> => {
      if (clearingGoal) return;
      const goal = session.state().goal;
      if (goal === undefined) return;
      await session.emit("session.config_changed", {
        goal: {
          objective: goal.objective,
          status,
          ...(reason !== undefined ? { reason } : {}),
        },
      });
    };
    const goalReporter = createGoalReporter({
      goal: () => session.state().goal,
      events: () => session.durableEvents(),
      sensitive: (subjects) => policy.sensitiveForModel?.(subjects) ?? subjects.length > 0,
      toolName: UPDATE_GOAL_TOOL_NAME,
      write: writeGoal,
      check: () => {
        const settings = config?.resolvedSettings(meta.workspaceRoot) ?? resolved;
        switch (settings?.goalCheck?.backend) {
          case "smol": {
            const smol =
              resolveModelRole(sessionRegistry, settings.modelRoles?.smol, "smol") ?? model;
            return (input, signal) => checkGoalWithSmol(input, smol, signal);
          }
          case "decision": {
            const selected = resolveEffectiveDecisionModel(
              settings.decisionModel,
              settings.permissionReviewer,
            );
            if (!selected)
              return () => Promise.resolve(goalCheckUnavailable("decision", "决策模型未设置"));
            const { id } = decisionModelRecipient(selected);
            const accepted = parseGoalCheckAccepted(
              config?.getPreference(GOAL_CHECK_DISCLOSURE_PREF),
            );
            if (!accepted.has(id)) {
              return () =>
                Promise.resolve(goalCheckUnavailable("decision", "尚未确认目标核对的数据外发说明"));
            }
            const connection = decisionConnection(
              selected,
              settings.providers,
              session.id,
              DEFAULT_REVIEW_CONFIDENCE,
              settings.decisionModel === undefined,
            );
            return (input, signal) =>
              checkGoalWithDecision(input, connection, DEFAULT_REVIEW_CONFIDENCE, signal);
          }
          default:
            return undefined;
        }
      },
    });
    const updateGoalTool = createUpdateGoalTool({
      active: () => session.state().goal?.status === "active",
      report: (input, callId, signal) => goalReporter.report(input, callId, signal),
    });
    /** update_goal 只在目标为 active 时注册（§4.2），在 Turn 边界与续跑时按状态装卸 */
    const installGoalTool = () => {
      tools.unregister(updateGoalTool.name);
      const { goal, plan } = session.state();
      if (goal?.status === "active" && plan === undefined && meta.parent === undefined) {
        tools.register(updateGoalTool);
      }
    };
    const goalInput = (body: string): PreparedInput => ({
      content: [],
      appended: [{ type: "text", text: workModeBlock("goal", body) }],
      workMode: { name: "goal", body, source: "runtime" },
    });
    // ── 计划模式（ADR-0076 §5）：预设与 plan 写在同一条 config_changed ──
    const writePlanPreset = async (preset: string, plan: PlanConfig | null): Promise<void> => {
      const name = isPermissionPresetName(preset) ? preset : "default";
      await session.emit("session.config_changed", { permissionPreset: name, plan });
      policy = buildPolicy(name);
      warnMissingReviewer();
    };
    /** 退出计划模式时恢复的预设：进入前就是只读时改用 default */
    const planExitPreset = (plan: PlanConfig): string =>
      plan.restorePreset === "read-only" ? "default" : plan.restorePreset;
    const requirePlan = (): PlanConfig => {
      const plan = session.state().plan;
      if (plan === undefined) throw new RuntimeCommandError("invalid_command", "不在计划模式");
      return plan;
    };
    /** 执行方式在新 Turn 开始前的副作用（§1）：排队取出的输入同样走这里 */
    const applyWorkModeStart = async (prepared: PreparedInput): Promise<void> => {
      const started = workModeStarts.has(prepared) ? prepared.workMode?.name : undefined;
      if (started === "plan") {
        // 已在计划模式时保留最初要恢复的预设
        const state = session.state();
        const restorePreset =
          state.plan?.restorePreset ?? (state.config.permissionPreset || "default");
        await writePlanPreset("read-only", { restorePreset });
      }
      if (started === "goal") {
        const objective = prepared.content
          .flatMap((block) => (block.type === "text" ? [block.text] : []))
          .join("\n")
          .trim();
        if (session.state().goal !== undefined)
          await session.emit("session.config_changed", { goal: null });
        await session.emit("session.config_changed", {
          goal: {
            objective,
            status: "active",
          },
        });
      }
      if (started === "ensemble") {
        ensembleTurnStarting = true;
        syncEnsembleTools();
      }
      installGoalTool();
    };
    /** 安全点 2 的续跑判断（§4.3）；子会话不接 */
    const continueGoal = async (): Promise<PreparedInput | undefined> => {
      const next = goalContinuation(session.state().goal, {
        backgroundRunning: backgroundSubagents.count(session.id),
        queued: pendingInputStore
          .snapshot()
          .items.some((item) => item.mode === "queue" && !item.paused),
        planning: session.state().plan !== undefined,
        nowMs: Date.now(),
      });
      if (next.kind === "none") return undefined;
      if (next.kind === "blocked") {
        await writeGoal("blocked", next.reason);
        installGoalTool();
        return undefined;
      }
      installGoalTool();
      return goalInput(next.body);
    };
    /**
     * Ensemble 期间指挥工具集收窄与恢复（ADR-0089 §2）：
     * 按工具声明的 `tool.traits.editTool` 特性卸载/恢复改文件工具（write/edit/apply_patch），
     * 不在 Agent Loop 中按工具名写分支；同时装卸指挥的 Ensemble 工具。
     */
    const syncEnsembleTools = (): void => {
      if (meta.parent !== undefined || isSuiteCoordinator) return;
      for (const name of ENSEMBLE_MAESTRO_TOOL_NAMES) {
        tools.unregister(name);
      }
      if (isEnsembleMaestroActive()) {
        for (const tool of builtinTools()) {
          if (tool.traits.editTool !== undefined) {
            tools.unregister(tool.name);
          }
        }
        tools.unregister("task");
        if (ensembleController !== undefined) {
          for (const tool of ensembleController.maestroTools()) {
            tools.register(tool);
          }
        }
      } else {
        // 已注册的不重新注册：工具顺序影响请求前缀（恢复会话时也会走到这里）
        for (const tool of builtinTools()) {
          if (tool.traits.editTool !== undefined && tools.get(tool.name) === undefined) {
            tools.register(tool);
          }
        }
        installTask();
      }
    };

    const memberProxies = new Map<string, RuntimeSession>();

    const openResidentChild = async (
      spec: ResidentChildOpenSpec,
      isParentActive: () => boolean = () => true,
    ): Promise<ResidentChildSession> => {
      let childRaw: Session;
      if (spec.create) {
        childRaw = await store.create({
          id: spec.childSessionId,
          cwd: spec.cwd,
          workspaceRoot: spec.workspaceRoot,
          model: spec.model,
          permissionPreset: session.state().config.permissionPreset,
          nocturneVersion: options.version ?? NOCTURNE_VERSION,
          ...(spec.reasoningEffort !== undefined ? { reasoningEffort: spec.reasoningEffort } : {}),
          parent: { sessionId: session.id, callId: residentCallId(spec.kind, spec.name) },
          ...(spec.suite !== undefined ? { suite: spec.suite } : {}),
        });
      } else {
        childRaw = await store.load(spec.childSessionId);
      }
      let childActive = true;
      let wrappedChild: RuntimeSession;
      try {
        wrappedChild = await wrapSession(
          childRaw,
          { modelOverride: spec.model },
          unattendedOption,
          {
            kind: spec.kind,
            parentSessionId: session.id,
            rootSessionId: grantRootId,
            name: spec.name,
            preset: spec.preset,
            worktreePath: spec.worktreePath,
            extraTools: spec.extraTools,
            basePrompt: () => spec.basePrompt(),
            parentGrants: sessionGrants,
            isActive: () => childActive && isParentActive(),
            onTurnLifecycle: spec.onTurnLifecycle,
            ...(sessionInteractive()
              ? {
                  permissions: {
                    parentCallId: residentCallId(spec.kind, spec.name),
                    profile: spec.preset,
                    taskSummary: spec.name,
                    register: (input) => forwardedPermissions.register(input),
                    clearChild: (childSessionId) => {
                      forwardedPermissions.clearChild(childSessionId);
                    },
                  },
                }
              : {}),
          },
        );
      } catch (e) {
        await childRaw.close().catch(() => undefined);
        throw e;
      }
      const controls = (
        wrappedChild as unknown as Record<symbol, ResidentChildInternalControls | undefined>
      )[RESIDENT_CHILD_CONTROLS];
      if (controls === undefined) {
        await wrappedChild.close().catch(() => undefined);
        throw new Error("Missing ResidentChildInternalControls");
      }

      // 创建不关闭底层会话的共享外部代理句柄（供 runtime.resumeSession / RPC 使用）
      const proxy: RuntimeSession = {
        ...wrappedChild,
        close: () => Promise.resolve(),
      };
      Object.defineProperty(proxy, INTERNAL_SESSION, { value: childRaw });
      memberProxies.set(spec.childSessionId, proxy);

      return {
        id: spec.childSessionId,
        isBusy: () => controls.isBusy(),
        hasActivePendingInputs: () => controls.hasActivePendingInputs(),
        deliverInput: (input, forcePaused) => controls.deliverInput(input, forcePaused),
        resumeFromModelChange: (modelKey) => controls.resumeFromModelChange(modelKey),
        setModelAndEffort: (modelRef, effort) => controls.setModelAndEffort(modelRef, effort),
        interruptAndWait: () => controls.interruptAndWait(),
        clearPendingInputs: () => {
          controls.clearPendingInputs();
        },
        subscribe: (listener) => wrappedChild.subscribe(listener),
        durableEvents: () => wrappedChild.durableEvents(),
        closeUnderlying: async () => {
          childActive = false;
          memberProxies.delete(spec.childSessionId);
          await wrappedChild.close();
        },
      };
    };

    const residentWorktreeOps = (
      parentSessionId: string,
      activeIsolatedChildIds?: () => ReadonlySet<string> | undefined,
    ): ResidentWorktreeOps => ({
      inspectRepository: (dir) => inspectWorktreeRepository(dir),
      create: (input) =>
        runWorktreeTask(async () => {
          const resolved = config?.resolvedSettings(session.state().meta.workspaceRoot);
          const record = await createWorktree({
            childSessionId: input.childSessionId,
            parentSessionId,
            repository: input.repository,
            sessionsDir,
            cwd: input.cwd,
            workspaceRoot: input.workspaceRoot,
            task: input.task,
            trusted: ws?.projectConfig.trusted === true,
            ...(resolved?.worktree?.subagentRoot
              ? { subagentRoot: resolved.worktree.subagentRoot }
              : {}),
            ...(resolved?.git?.branchPrefix ? { branchPrefix: resolved.git.branchPrefix } : {}),
            ...(resolved?.worktree?.fetchBeforeCreate === true ? { fetchBeforeCreate: true } : {}),
          });
          await registerManagedWorktree(sessionsDir, {
            kind: "subagent",
            repository: record.repository,
            worktreePath: record.worktree,
            branch: record.branch,
            ownsBranch: true,
            sessionId: parentSessionId,
            childSessionId: record.childSessionId,
          }).catch(() => undefined);
          return record;
        }),
      loadRecord: async (childSessionId) => {
        const list = await listWorktreeRecords(sessionsDir, parentSessionId);
        return list.find((r) => r.childSessionId === childSessionId);
      },
      listParentRecords: () => listWorktreeRecords(sessionsDir, parentSessionId),
      checkpoint: (record, msg) => runWorktreeTask(() => checkpointWorktreeTurn(record, msg)),
      currentHead: (wtPath) => worktreeCurrentHead(wtPath),
      isOnBranch: (record) => isWorktreeOnBranch(record),
      resetToCommit: (wtPath, sha) => runWorktreeTask(() => resetWorktreeToCommit(wtPath, sha)),
      markApplied: (record, appliedHead) => markWorktreeApplied(record, appliedHead),
      remove: (record, removeBranch) => runWorktreeTask(() => removeWorktree(record, removeBranch)),
      cleanupMerged: () =>
        runWorktreeTask(() =>
          cleanupMergedWorktrees(sessionsDir, parentSessionId, activeIsolatedChildIds?.()),
        ),
    });

    if (meta.parent === undefined && meta.schedule === undefined) {
      const deliverEnsembleToMaestro = (
        input: PreparedInput,
        forcePaused = false,
      ): Promise<void> => {
        if (closing || session.health !== "ok") return Promise.resolve();
        pendingInputStore.add("ensemble", input, forcePaused);
        if (forcePaused) return Promise.resolve();
        void pumpQueue().catch(() => {
          pendingInputStore.pauseAll();
        });
        return Promise.resolve();
      };

      ensembleController = createEnsembleController({
        maestroSessionId: session.id,
        newChildSessionId: () => newSessionId(),
        isClosing: () => closing,
        currentDirectory: () => ({ cwd: currentCwd(), workspaceRoot: currentWorkspaceRoot() }),
        maestroModel: () => model,
        maestroEffort: () => session.state().config.reasoningEffort,
        enabledModels: () => {
          const disabled = disabledSet();
          return sessionRegistry
            .providers()
            .flatMap((p) => p.models())
            .map((m) => applyDisabled(m, disabled))
            .filter((m) => m.disabled === undefined && m.unavailable === undefined)
            .map((m) => ({
              provider: m.ref.provider,
              model: m.ref.model,
              ...(m.displayName !== undefined ? { name: m.displayName } : {}),
            }));
        },
        availableProfiles: () => {
          const configured =
            config?.resolvedSettings(session.state().meta.workspaceRoot).subagentProfiles ?? {};
          return Object.entries(configured).flatMap(([name, profile]) => {
            if (!profile.enabled) return [];
            if (
              profile.model !== undefined &&
              resolveModelRole(sessionRegistry, profile.model, "task") === undefined
            ) {
              return [];
            }
            return [{ ...profile, name }];
          });
        },
        externalAgentNames: () => {
          const names = new Set<string>();
          for (const a of config?.base.externalAgents ?? []) {
            names.add(a.name);
          }
          return names;
        },
        resolveEnabledModel: (ref) => {
          try {
            const resolvedModel = sessionRegistry.resolve(ref);
            const disabled = applyDisabled(resolvedModel.model, disabledSet());
            if (disabled.disabled !== undefined || disabled.unavailable !== undefined) {
              return undefined;
            }
            return resolvedModel;
          } catch {
            return undefined;
          }
        },
        pricing: (modelKey) => {
          let ref: ModelRef;
          if (modelKey !== undefined) {
            try {
              ref = parseModelRef(modelKey);
            } catch {
              return undefined;
            }
          } else {
            ref = model.model.ref;
          }
          return resolvePricing(sessionRegistry, ref)?.pricing;
        },
        durableEvents: () => session.durableEvents(),
        readChildDurableEvents: async (childSessionId) => {
          const logFile = paths.join(sessionsDir, `${childSessionId}.jsonl`);
          const { events } = await readLogReadonly(fs, logFile, childSessionId);
          return events;
        },
        emitDurable: (type, payload) => session.emit(type, payload),
        emitEphemeral: (type, payload) => session.emitEphemeral(type, payload),
        deliverToMaestro: deliverEnsembleToMaestro,
        clearMaestroEnsembleInputs: () => {
          pendingInputStore.dropMode("ensemble");
        },
        isMaestroBusy: () => busy() || compacting(),
        hasMaestroPendingActive: () =>
          pendingInputStore.snapshot().items.some((item) => !item.paused),
        syncMaestroTools: syncEnsembleTools,
        notifyMaestroIdle: notifyIdle,
        openMemberSession: (spec) =>
          openResidentChild(spec, () => Boolean(ensembleController?.isActive())),
        worktrees: residentWorktreeOps(session.id, () =>
          ensembleController?.activeIsolatedChildIds(),
        ),
        commandError: (code, message) => new RuntimeCommandError(code, message),
      });
    }

    const syncSuiteTools = (): void => {
      if (!isSuiteCoordinator || suiteController === undefined) return;
      for (const name of SUITE_COORDINATOR_TOOL_NAMES) {
        tools.unregister(name);
      }
      for (const tool of suiteController.coordinatorTools()) {
        tools.register(tool);
      }
    };

    if (isSuiteCoordinator && suiteId !== undefined) {
      const loadedSuite = await suiteStore.get(suiteId);
      const suiteRecord = loadedSuite ?? {
        version: 1 as const,
        id: suiteId,
        name: suiteId,
        workspaces: [meta.workspaceRoot],
        instructions: "",
        coordinatorSessionId: session.id,
        threadDefaults: {},
        createdAt: meta.createdAt,
      };
      const deliverSuiteReportToCoordinator = (
        input: PreparedInput,
        forcePaused = false,
      ): Promise<void> => {
        if (closing || session.health !== "ok") return Promise.resolve();
        pendingInputStore.add("suite", input, forcePaused);
        if (forcePaused) return Promise.resolve();
        void pumpQueue().catch(() => {
          pendingInputStore.pauseAll();
        });
        return Promise.resolve();
      };
      suiteController = createSuiteController({
        suite: suiteRecord,
        coordinatorSessionId: session.id,
        newChildSessionId: () => newSessionId(),
        isClosing: () => closing,
        currentDirectory: () => ({ cwd: currentCwd(), workspaceRoot: currentWorkspaceRoot() }),
        pathsEqual: (a, b) => paths.equals(a, b),
        coordinatorModel: () => model,
        coordinatorEffort: () => session.state().config.reasoningEffort,
        enabledModels: () => {
          const disabled = disabledSet();
          return sessionRegistry
            .providers()
            .flatMap((p) => p.models())
            .map((m) => applyDisabled(m, disabled))
            .filter((m) => m.disabled === undefined && m.unavailable === undefined)
            .map((m) => ({
              provider: m.ref.provider,
              model: m.ref.model,
              ...(m.displayName !== undefined ? { name: m.displayName } : {}),
            }));
        },
        availableProfiles: () => {
          const configured =
            config?.resolvedSettings(session.state().meta.workspaceRoot).subagentProfiles ?? {};
          return Object.entries(configured).flatMap(([name, profile]) => {
            if (!profile.enabled) return [];
            if (
              profile.model !== undefined &&
              resolveModelRole(sessionRegistry, profile.model, "task") === undefined
            ) {
              return [];
            }
            return [{ ...profile, name }];
          });
        },
        externalAgentNames: () => {
          const names = new Set<string>();
          for (const a of config?.base.externalAgents ?? []) {
            names.add(a.name);
          }
          return names;
        },
        resolveEnabledModel: (ref) => {
          try {
            const resolvedModel = sessionRegistry.resolve(ref);
            const disabled = applyDisabled(resolvedModel.model, disabledSet());
            if (disabled.disabled !== undefined || disabled.unavailable !== undefined) {
              return undefined;
            }
            return resolvedModel;
          } catch {
            return undefined;
          }
        },
        pricing: (modelKey) => {
          let ref: ModelRef;
          if (modelKey !== undefined) {
            try {
              ref = parseModelRef(modelKey);
            } catch {
              return undefined;
            }
          } else {
            ref = model.model.ref;
          }
          return resolvePricing(sessionRegistry, ref)?.pricing;
        },
        durableEvents: () => session.durableEvents(),
        readChildDurableEvents: async (childSessionId) => {
          const logFile = paths.join(sessionsDir, `${childSessionId}.jsonl`);
          const { events } = await readLogReadonly(fs, logFile, childSessionId);
          return events;
        },
        emitDurable: (type, payload) => session.emit(type, payload),
        emitEphemeral: (type, payload) => session.emitEphemeral(type, payload),
        deliverToCoordinator: deliverSuiteReportToCoordinator,
        notifyCoordinatorIdle: notifyIdle,
        openThreadSession: (spec) => openResidentChild(spec, () => !closing),
        worktrees: residentWorktreeOps(session.id, () => suiteController?.activeIsolatedChildIds()),
        commandError: (code, message) => new RuntimeCommandError(code, message),
      });
    }

    /**
     * 设置 Turn 控制器并跑一个或连续多个 Turn（ADR-0070 §3：`done` 结束后取队首
     * 一条排队输入作为新 Turn；其他结束原因把剩余条目全部转排队并暂停）。
     */
    const startTurns = async (
      ac: AbortController,
      first: () => Promise<PreparedInput>,
    ): Promise<TurnEndReason> => {
      assertBranchNotSwitching();
      if (archiving) throw new RuntimeCommandError("session_busy", "会话正在归档");
      controller = ac;
      let settleTurn!: () => void;
      turnSettled = new Promise<void>((resolve) => {
        settleTurn = resolve;
      });
      let idleTurnId: string | undefined;
      let heldSubagentSlot = false;
      // 空闲边界：controller 先置位（busy 语义立即生效），再重建
      // updateProviders 标记的会话级注册表（provider-setup.md 第 6 节）
      try {
        if (pageCleanupNeeded) await cleanPageData();
        if (residentChild !== undefined) {
          residentChild.onTurnLifecycle.onSlotWaitStart();
          heldSubagentSlot = await subagentLimiter.acquire(ac.signal);
          if (!heldSubagentSlot) {
            pendingInputStore.pauseAll();
            return "aborted";
          }
        }
        let prepare: (() => Promise<PreparedInput>) | undefined = first;
        let reason: TurnEndReason | "failed" = "done";
        while (prepare !== undefined) {
          pendingInputStore.turnStarted();
          await awaitMcpIdle(ac.signal);
          await rebuildProviders();
          await applySkills();
          applyExternalAgents();
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
          // 归档旁路在首个输入准备前删除；此时 controller 已占用，并发的
          // archiveSession 只能看到 busy，接续的下一轮不重复处理（ADR-0080）。
          if (prepare === first) {
            const restored = await restoreArchivedForSubmit();
            if (restored) notifySessionsChanged();
          }
          const prepared = await prepare();
          prepare = undefined;
          await recordBranch().catch(() => undefined);
          await applyWorkModeStart(prepared);
          const isNonUserMessage =
            prepared.subagent !== undefined ||
            prepared.backgroundShell !== undefined ||
            prepared.ensemble !== undefined ||
            prepared.ensembleQuietReminder === true ||
            prepared.suiteReport !== undefined ||
            prepared.workMode?.source === "runtime";
          const userPrompt = isNonUserMessage
            ? false
            : {
                text: prepared.content
                  .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
                  .map((b) => b.text)
                  .join("\n"),
                ...(prepared.skillInvocation !== undefined
                  ? { skill: prepared.skillInvocation }
                  : {}),
              };
          const deps: TurnDeps = {
            userPrompt,
            deferIdle: (turnId) => {
              idleTurnId = turnId;
            },
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
              // 与用户插话后同一条边界（ADR-0086）：prepareTurn、暂存切换、可用性说明。
              await prepareMcpBoundary(signal);
            },
            // ADR-0070 §2：安全点取走插话；取走即从列表移除并广播快照。
            // 用户插话（mode steer）置位，供 afterSteers 复用上面的 MCP 边界；
            // 子代理结果与后台命令不是用户输入，不置位。
            takeSteers: () => {
              userSteerBoundary = pendingInputStore
                .snapshot()
                .items.some((item) => item.mode === "steer" && !item.paused);
              return pendingInputStore.takeSteers();
            },
            afterSteers: async (signal) => {
              const refresh = userSteerBoundary;
              userSteerBoundary = false;
              if (!refresh || meta.parent !== undefined) return;
              await prepareMcpBoundary(signal);
            },
            // ADR-0127 第三阶段返工：宿主挂起的提问（handoff_suspended）使本 turn
            // 有序收尾——交还控制、不再发起下一次推理或执行依赖答复的批内后续调用。
            // broker 在 suspend 结算时登记 turnId；这里按结果语义（非工具名）判定，
            // 与 loop guard / shouldFinish 注入点同一手法，不写工具名分支。
            shouldFinish: (_state, turnId) =>
              turnId !== undefined && questions.isTurnSuspended(turnId),
            // ADR-0076 §4.3：目标模式在 Turn 想结束时决定是否续跑
            ...(meta.parent === undefined ? { continueTurn: continueGoal } : {}),
            ...(residentChild !== undefined
              ? {
                  basePrompt: residentChild.basePrompt(),
                  rootSessionId: residentChild.rootSessionId,
                }
              : suiteController !== undefined
                ? {
                    basePrompt: suiteController.basePrompt(),
                  }
                : {}),
            skills: catalog,
            memory: () => memorySnapshot,
            gitPreferences: () => config?.resolvedSettings(session.state().meta.workspaceRoot).git,
            refreshMemory: refreshMemorySnapshot,
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
          reason = await runTurn(
            deps,
            preparedContent(prepared),
            prepared.attachments ?? [],
            prepared.fileRefs,
            prepared.skill,
            prepared.delegate,
            prepared.files,
            prepared.subagent,
            prepared.workMode,
            prepared.backgroundShell,
            prepared.ensemble,
            prepared.ensembleQuietReminder,
            prepared.suiteReport,
            prepared.pageComments,
            prepared.pageCommentScreenshotIndices,
            prepared.quotes,
          );
          if (ensembleTurnStarting) {
            ensembleTurnStarting = false;
            syncEnsembleTools();
          }
          // ADR-0076 §4.5：用户中断即停止目标，之后的普通对话不被核对说明接管
          if (reason === "aborted" && session.state().goal?.status === "active")
            await writeGoal("stopped", "interrupted");
          // ADR-0070 §4：非 done 结束把剩余条目全部转排队并暂停，不自动发送
          if (reason !== "done") pendingInputStore.pauseAll();
          if (reason === "failed") {
            throw new RuntimeCommandError("session_failed", "会话持久化失败");
          }
          if (residentChild !== undefined) {
            const lastCompleted = session
              .durableEvents()
              .findLast((ev) => ev.type === "turn.completed");
            const lastErr =
              lastCompleted?.type === "turn.completed" ? lastCompleted.payload.error : undefined;
            await residentChild.onTurnLifecycle.onTurnCompleted(
              reason,
              lastErr !== undefined ? { code: lastErr.code, message: lastErr.message } : undefined,
            );
          }
          if (reason !== "done") break;
          pendingInputStore.turnDone();
          const head = pendingInputStore.takeQueueHead();
          if (head !== undefined) prepare = () => Promise.resolve(head);
        }
        return reason;
      } finally {
        if (heldSubagentSlot) {
          subagentLimiter.release();
        }
        if (ensembleTurnStarting) {
          ensembleTurnStarting = false;
          syncEnsembleTools();
        }
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
        if (controller === ac) controller = undefined;
        settleTurn();
        scheduleWorktreeCleanup();
        // 清理期间仍可入列。释放 busy 与重新取队首之间没有异步间隙；
        // pumpQueue 同步取走条目并重新占用 controller，避免遗漏或并发启动。
        const pumped = await pumpQueue();
        if (
          !pumped &&
          !busy() &&
          compactController === undefined &&
          session.health === "ok" &&
          idleTurnId !== undefined
        )
          session.emitEphemeral("runtime.status", { status: "idle" }, { turnId: idleTurnId });
        if (!pumped && !busy() && compactController === undefined && session.health === "ok") {
          ensembleController?.onMaestroTurnSettled();
        }
        notifyIdle();
      }
    };
    /** 空闲时未暂停的插话也按排队发出；忙时留给安全点或 Turn 结束 */
    const pumpQueue = async (): Promise<boolean> => {
      if (
        busy() ||
        compactController !== undefined ||
        closing ||
        session.health !== "ok" ||
        switching(branchWatchPath())
      )
        return false;
      const head = pendingInputStore.takeQueueHead();
      if (head === undefined) return false;
      const ac = new AbortController();
      await startTurns(ac, () => Promise.resolve(head));
      return true;
    };

    if (suiteController !== undefined) {
      await suiteController.initializeFromLog();
      syncSuiteTools();
    }

    // ADR-0073 §4 & ADR-0089 §7：重启不复活后台子代理，恢复 Ensemble 骨架与缺失提及（暂停待发，不自动唤醒）
    if (resume !== undefined && meta.parent === undefined) {
      if (ensembleController !== undefined) {
        await ensembleController.initializeFromLog();
        syncEnsembleTools();
      }
      await cleanupMergedWorktrees(sessionsDir, session.id, allActiveIsolatedChildIds()).catch(
        (cause: unknown) =>
          session.emitEphemeral("runtime.warning", {
            code: "worktree_cleanup_failed",
            message: String(cause),
          }),
      );
      const retained = await listWorktreeRecords(sessionsDir, session.id);
      const recovered = backgroundSubagents.recover(
        session.durableEvents(),
        meta.forkedFrom?.seq ?? 0,
      );
      for (const input of recovered) {
        const record = retained.find(
          (record) => record.childSessionId === input.subagent?.childSessionId,
        );
        if (record && input.subagent) {
          try {
            input.subagent.changes = await settleWorktree(record);
          } catch (cause) {
            session.emitEphemeral("runtime.warning", {
              code: "worktree_cleanup_failed",
              message: String(cause),
            });
          }
        }
      }
      recovered.push(
        ...backgroundShells.recover(session.durableEvents(), meta.forkedFrom?.seq ?? 0),
      );
      if (recovered.length > 0) {
        pendingInputStore.pauseAll();
        for (const input of recovered)
          pendingInputStore.add(input.backgroundShell ? "shell" : "subagent", input);
      }
    }
    // SessionStart Hook（hooks.md）：会话新建、恢复与分叉打开后触发
    if (hookRunner !== undefined) {
      let source: "startup" | "resume" | "fork" = "startup";
      if (resume !== undefined) {
        const events = session.durableEvents();
        const forkRewind = events.findLast(
          (e) => e.type === "session.rewound" && e.payload.fork === true,
        );
        const forkBoundarySeq =
          meta.forkedFrom !== undefined ? (forkRewind?.seq ?? meta.forkedFrom.seq) : undefined;
        const isFreshFork =
          forkBoundarySeq !== undefined && (events.at(-1)?.seq ?? 0) <= forkBoundarySeq;
        source = isFreshFork ? "fork" : "resume";
      }
      await runHookContextSnapshot(session, hookRunner, "SessionStart", {
        resumed: resume !== undefined,
        source,
      });
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
      if (event.type === "permission.resolved" && event.payload.remember !== undefined) {
        grantsChanged(
          event.payload.remember === "project" || event.payload.remember === "pattern"
            ? { workspace: meta.workspaceRoot }
            : { sessionId: grantRootId },
        );
      }
      if (
        resume !== undefined ||
        meta.parent !== undefined ||
        event.type !== "message.user" ||
        event.payload.ensembleQuietReminder === true ||
        event.payload.suiteReport !== undefined ||
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
        .join("\n");
      const signal = AbortSignal.any([titleController.signal, session.failedSignal]);
      titleSettled = (async () => {
        const result = await runRoleCall(
          titleModel,
          {
            purpose: "title",
            model: titleModel.model.ref.model,
            protocol: titleModel.model.protocol,
            system: [{ text: TITLE_SYSTEM_PROMPT }],
            messages: [
              { role: "user", content: [{ type: "text", text: formatTitleUserMessage(text) }] },
            ],
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
        await session.emitGeneratedTitle({
          title,
          source: "generated",
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
      assertBranchNotSwitching();
      if (isSuiteCoordinator) {
        throw new RuntimeCommandError("invalid_command", "组曲指挥会话不支持分叉");
      }
      if (busy() || compactController !== undefined)
        throw new RuntimeCommandError("session_busy", "请先等待或按 Esc 中断");
      validateForkTarget(targetSeq);
      rewinding = true;
      let settle!: () => void;
      rewindSettled = new Promise((resolve) => {
        settle = resolve;
      });
      try {
        await Promise.all([titleSettled, pageStorage.drain()]);
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
      get workspace() {
        return branchWatchPath();
      },
      currentCwd,
      repositoryFor,
      branchBusy: () =>
        busy() ||
        compacting() ||
        closing ||
        (ensembleController?.hasWorkspaceMembers() ?? false) ||
        (suiteController?.hasWorkspaceThreads() ?? false),
      pumpPending: () => {
        void pumpQueue().catch(() => {
          pendingInputStore.pauseAll();
        });
      },
      grantWarning: (message) =>
        session.emitEphemeral("runtime.warning", { code: "grants_invalid", message }),
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
      listMcpServerTools: (serverId) => mcpSession?.listServerTools?.(serverId),
      refreshSkills: refreshSessionSkills,
      refreshExternalAgents: refreshSessionExternalAgents,
      skillModel: {
        workspaceRoot: meta.workspaceRoot,
        contextWindow: () => model.model.contextWindow,
      },
      fork: forkOpen,
      archive: setArchived,
      unarchive: unarchiveOpen,
      durableEvents: () => session.durableEvents(),
      ensembleMember: async (childSessionId) => {
        if (!ensembleController?.isActive()) return undefined;
        const opened = await ensembleController.openOrGetMemberBySessionId(childSessionId);
        if (!opened?.active) return undefined;
        return memberProxies.get(childSessionId);
      },
      ensembleActiveIsolatedChildIds: () =>
        ensembleController?.activeIsolatedChildIds() ?? new Set(),
      suiteThread: async (childSessionId) => {
        if (suiteController === undefined) return undefined;
        const opened = await suiteController.openOrGetThreadBySessionId(childSessionId);
        if (!opened?.active) return undefined;
        return memberProxies.get(childSessionId);
      },
      suiteActiveIsolatedChildIds: () => suiteController?.activeIsolatedChildIds() ?? new Set(),
      updateSuiteRecord: (record) => {
        suiteController?.updateSuiteRecord(record);
      },
      suiteCoordinatorBusy: () =>
        busy() || compacting() || closing || (suiteController?.hasRunningWork() ?? false),
      rename: async (title) => {
        assertUsable();
        if (meta.parent !== undefined)
          throw new RuntimeCommandError("invalid_command", "子会话不能改名");
        await session.emit("session.titled", { title, source: "user" });
      },
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
    const recoveredAt = new Date().toISOString();
    const runtimeSession: RuntimeSession = {
      shellTasks() {
        assertUsable();
        const tasks = backgroundShells.list();
        const known = new Set(tasks.map((task) => task.taskId));
        for (const task of replaySessionView(session.durableEvents()).backgroundShells) {
          if (!known.has(task.taskId))
            tasks.push(
              task.status === "running"
                ? { ...task, status: "interrupted", endedAt: recoveredAt }
                : task,
            );
        }
        return tasks;
      },
      async shellOutput(taskId, offset) {
        assertUsable();
        if (offset !== undefined && (!Number.isInteger(offset) || offset < 0))
          throw new RuntimeCommandError("invalid_command", "offset must be a non-negative integer");
        if (backgroundShells.list().some((task) => task.taskId === taskId))
          return backgroundShells.observe(taskId, offset);
        const task = runtimeSession.shellTasks().find((item) => item.taskId === taskId);
        if (!task) throw new RuntimeCommandError("invalid_command", `未知后台任务：${taskId}`);
        const text = await platform.fs.readTextFile(task.logPath).catch(() => "");
        return observerOutput(task, text, offset);
      },
      async shellKill(taskId) {
        assertUsable();
        try {
          await backgroundShells.kill(taskId, "user");
        } catch (cause) {
          throw new RuntimeCommandError("invalid_command", String(cause));
        }
      },
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
      async getPageData(page, key) {
        assertPageUsable();
        return pageStorage.get(page, key);
      },
      async setPageData(page, key, value) {
        assertPageUsable();
        if (pageCleanupNeeded)
          throw new SessionError("page_storage_failed", "页面数据清理尚未完成");
        await pageStorage.set(page, key, value);
      },
      async deletePageData(page, key) {
        assertPageUsable();
        await pageStorage.delete(page, key);
      },
      async listPageDataKeys(page) {
        assertPageUsable();
        return pageStorage.keys(page);
      },
      async callPageModel(page, input, signal) {
        assertPageUsable();
        return pageModels.call(requireSessionPage(session, page), input, signal);
      },
      respondPagePermission(page, requestId, reply) {
        const result = pagePermission.respond(page, requestId, reply);
        if (result === "unknown_request")
          return Promise.reject(new RuntimeCommandError(result, "页面确认请求已结束或不存在"));
        if (result === "invalid_reply")
          return Promise.reject(new RuntimeCommandError(result, "无效的页面确认回复"));
        return Promise.resolve();
      },
      stopPageModel(page) {
        requireSessionPage(session, page);
        pageModels.stop(page);
      },
      async resolvePageComment(page, comment) {
        assertPageUsable();
        await session.emit("page.comment_resolved", { page, comment });
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
        assertBranchNotSwitching();
        assertUsable();
        if (busy() || compactController !== undefined)
          throw new RuntimeCommandError("session_busy", "请先等待或按 Esc 中断");
        if (
          !["both", "conversation", "files"].includes(mode) ||
          // ADR-0070 §7：插话不是回退目标
          !session
            .state()
            .history.some((e) => e.kind === "user" && e.seq === targetSeq && e.steer !== true)
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
          // ADR-0073 §4：回退到启动调用之前的后台子代理取消且不交付
          if (mode !== "files") {
            const kept = new Set<string>();
            for (const event of session.durableEvents())
              if (event.seq < targetSeq && event.type === "tool.started")
                kept.add(event.payload.callId);
            await backgroundSubagents.discard(session.id, kept);
            await backgroundShells.discard(kept);
            pendingInputStore.dropSubagents(kept);
          }
          // ADR-0076 §2：回退到设定目标、进入计划的那条消息之前（含它本身），模式随之撤回
          const events = session.durableEvents();
          const origins = mode === "files" ? undefined : workModeOrigins(events);
          if (origins !== undefined) {
            await Promise.all([pageModels.stopAll(), pageStorage.drain()]);
            const kept = new Set(
              deriveSessionPages(
                effectiveEvents(events).filter((event) => event.seq < targetSeq),
              ).map(({ page }) => page),
            );
            const pageTargets = new Set(
              deriveSessionPages(events)
                .filter(({ page }) => !kept.has(page))
                .map(({ page }) => `${session.id}/${page}`),
            );
            const grants = ws?.grants;
            const removed =
              grants
                ?.list()
                .filter((grant) => grant.kind === "page" && pageTargets.has(grant.target)) ?? [];
            for (const grant of removed) await grants?.remove("page", grant.target);
            if (removed.length > 0) grantsChanged({ workspace: meta.workspaceRoot });
          }
          await session.emit("session.rewound", { targetSeq, mode, files });
          if (origins !== undefined) {
            pageCleanupNeeded = true;
            await cleanPageData();
          }
          if (mode !== "files" && forwardedByRequestId.size > 0) emitSubagentPermissions();
          if (origins !== undefined) {
            const goal = session.state().goal;
            if (
              goal !== undefined &&
              goal.status !== "stopped" &&
              origins.goal !== undefined &&
              targetSeq <= origins.goal
            )
              await writeGoal("stopped", "rewound");
            const plan = session.state().plan;
            if (plan !== undefined && origins.plan !== undefined && targetSeq <= origins.plan)
              await writePlanPreset(plan.restorePreset, null);
            if (ensembleController?.isActive()) {
              const ensembleSeq = ensembleController.createdSeq();
              const ensembleOrigin = origins.ensemble;
              if (
                (ensembleSeq !== undefined && targetSeq <= ensembleSeq) ||
                (ensembleOrigin !== undefined && targetSeq <= ensembleOrigin)
              ) {
                await ensembleController.endOnRewind();
              } else {
                await ensembleController.syncOnRewind();
              }
            } else if (ensembleController !== undefined) {
              await ensembleController.syncOnRewind();
            }
            installGoalTool();
          }
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
      subscribe: (listener) => {
        const unsub = session.subscribe(listener);
        for (const task of runtimeSession.shellTasks()) {
          listener({
            type: "shell.task_updated",
            sessionId: session.id,
            runId: session.runId,
            eseq: 0,
            afterSeq: session.state().lastSeq,
            time: recoveredAt,
            payload: { task },
          });
        }
        for (const memberSnap of ensembleController?.memberSnapshots() ?? []) {
          listener({
            type: "ensemble.member_updated",
            sessionId: session.id,
            runId: session.runId,
            eseq: 0,
            afterSeq: session.state().lastSeq,
            time: new Date().toISOString(),
            payload: memberSnap,
          });
        }
        for (const threadSnap of suiteController?.threadSnapshots() ?? []) {
          listener({
            type: "suite.thread_updated",
            sessionId: session.id,
            runId: session.runId,
            eseq: 0,
            afterSeq: session.state().lastSeq,
            time: new Date().toISOString(),
            payload: threadSnap,
          });
        }
        const subagentPermsSnap = forwardedPermissions.snapshots();
        if (subagentPermsSnap.length > 0) {
          listener({
            type: "subagent.permissions",
            sessionId: session.id,
            runId: session.runId,
            eseq: 0,
            afterSeq: session.state().lastSeq,
            time: new Date().toISOString(),
            payload: { pending: subagentPermsSnap },
          });
        }
        return unsub;
      },
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
        const root = session.state().config.worktree?.current ?? meta.workspaceRoot;
        if (fileIndexRoot !== root) fileIndexPromise = undefined;
        fileIndexRoot = root;
        fileIndexPromise ??= buildFileIndex(fs, paths, root).catch((error: unknown) => {
          fileIndexPromise = undefined;
          throw error;
        });
        return fileIndexPromise;
      },
      async resolveFiles(inputs) {
        assertUsable();
        const currentRoot = session.state().config.worktree?.current ?? meta.workspaceRoot;
        const root = await fs.realpath(currentRoot).catch(() => currentRoot);
        return Promise.all(inputs.map((input) => resolveFileRef(fs, paths, root, input)));
      },
      interrupt() {
        const wasBusy = busy();
        controller?.abort();
        // 压缩是 Turn 之外的会话级活动，interrupt 同样中止它
        compactController?.abort();
        const hadWaitingSubagent = forwardedPermissions.cancelWaiting();
        if (!wasBusy && hadWaitingSubagent) {
          pendingInputStore.pauseAll();
        }
      },
      listGrants: () => runtime.listSessionGrants({ sessionId: session.id }),
      revokeGrant: (input) => runtime.revokeSessionGrant({ sessionId: session.id, ...input }),
      revokeAllGrants: () => runtime.revokeAllSessionGrants({ sessionId: session.id }),
      async respondPermission(requestId, reply) {
        const outcome =
          gate.respondDetailed !== undefined
            ? await gate.respondDetailed(requestId, reply)
            : (await gate.respond?.(requestId, reply)) === true
              ? "ok"
              : "unknown_request";
        if (outcome === "ok") {
          return;
        }
        if (outcome === "invalid_reply") {
          throw new RuntimeCommandError("invalid_reply", "权限回复与待确认请求不匹配");
        }
        throw new RuntimeCommandError("unknown_request", "没有等待中的权限请求");
      },
      async respondSubagentPermission(childSessionId, requestId, reply) {
        const outcome = await forwardedPermissions.respond(childSessionId, requestId, reply);
        if (outcome === "ok") {
          return;
        }
        if (outcome === "invalid_reply") {
          throw new RuntimeCommandError("invalid_reply", "子代理权限回复与待确认请求不匹配");
        }
        throw new RuntimeCommandError("unknown_request", "没有等待中的子代理权限请求");
      },
      respondQuestion(requestId, reply) {
        const outcome = questions.respond(requestId, reply);
        if (outcome === "ok") return Promise.resolve();
        if (outcome === "invalid_reply") {
          return Promise.reject(new RuntimeCommandError("invalid_reply", "回复与待回答问题不匹配"));
        }
        return Promise.reject(new RuntimeCommandError("unknown_request", "没有等待中的提问请求"));
      },
      questionSuspend(requestId) {
        const outcome = questions.suspend(requestId);
        if (outcome === "ok") return Promise.resolve();
        return Promise.reject(new RuntimeCommandError("unknown_request", "没有等待中的提问请求"));
      },
      async submit(input) {
        assertUsable();
        assertSubmittableSession();
        if (busy() || compactController !== undefined) {
          throw new RuntimeCommandError("session_busy", "会话正忙（Turn 或压缩进行中）");
        }
        // ADR-0089 §5、§10：用户直接向暂停中的常驻子会话发消息时恢复运行
        if (residentChild !== undefined && pendingInputStore.snapshot().paused) {
          const prepared = await prepareInput(input, new AbortController().signal);
          pendingInputStore.add("queue", prepared);
          pendingInputStore.resume();
          const head = pendingInputStore.takeQueueHead();
          if (head === undefined) return "done";
          const ac = new AbortController();
          return await startTurns(ac, () => Promise.resolve(head));
        }
        // controller 必须同步置位：之后的 interrupt 一定落在这一轮上。
        const ac = new AbortController();
        return await startTurns(ac, () => prepareInput(input, ac.signal));
      },
      async enqueueInput(mode, input) {
        assertUsable();
        assertInputQueueAllowed();
        if (!isPendingInputMode(mode))
          throw new RuntimeCommandError("invalid_command", "mode 只能是 steer 或 queue");
        // ADR-0076 §1：插话并入当前 Turn，不能中途换执行方式
        if (mode === "steer" && input.workMode !== undefined)
          throw new RuntimeCommandError("invalid_command", "执行方式不能作为插话发送");
        // 暂停中提交 = 追加到队尾并恢复（ADR-0070 §4）。没有进行中的 Turn 可以
        // 插话，因此一律作为排队追加，避免越过队首抢在暂停队列之前
        if (pendingInputStore.snapshot().paused) {
          const prepared = await prepareInput(input, new AbortController().signal);
          const id = pendingInputStore.add("queue", prepared);
          pendingInputStore.resume();
          void pumpQueue().catch((cause: unknown) => {
            session.emitEphemeral("runtime.warning", {
              code: "input_queue_failed",
              message: `待发输入没能发出：${cause instanceof Error ? cause.message : String(cause)}`,
            });
          });
          return { id, queued: true };
        }
        // Turn 进行中：进入待发列表，由安全点（插话）或 Turn 结束（排队）消费
        if (busy()) {
          const prepared = await prepareInput(input, new AbortController().signal);
          assertUsable();
          if (busy()) return { id: pendingInputStore.add(mode, prepared), queued: true };
          if (pendingInputStore.snapshot().paused) {
            const id = pendingInputStore.add("queue", prepared);
            pendingInputStore.resume();
            void pumpQueue().catch(() => {
              pendingInputStore.pauseAll();
            });
            return { id, queued: true };
          }
          const ac = new AbortController();
          await startTurns(ac, () => Promise.resolve(prepared));
          return { id: pendingInputStore.nextId(), queued: false };
        }
        if (compacting()) {
          // 压缩不占 Turn：等它收尾后按普通提交立即开始（ADR-0070 §1 空闲路径）
          await compactSettled;
          assertUsable();
          if (busy() || compacting()) {
            const prepared = await prepareInput(input, new AbortController().signal);
            return { id: pendingInputStore.add(mode, prepared), queued: true };
          }
        }
        // 空闲：按普通提交立即开始。返回的 id 只是对齐用的标记，不会出现在待发列表里
        const ac = new AbortController();
        await startTurns(ac, () => prepareInput(input, ac.signal));
        return { id: pendingInputStore.nextId(), queued: false };
      },
      updateInput: (id, patch) =>
        Promise.resolve().then(async () => {
          assertUsable();
          assertInputQueueAllowed();
          if (patch.mode !== undefined && !isPendingInputMode(patch.mode))
            throw new RuntimeCommandError("invalid_command", "mode 只能是 steer 或 queue");
          const outcome = pendingInputStore.update(id, patch);
          if (outcome === "readonly")
            throw new RuntimeCommandError("invalid_command", "子代理结果不能编辑");
          if (outcome === "work_mode")
            throw new RuntimeCommandError("invalid_command", "执行方式不能作为插话发送");
          if (outcome === "empty_task")
            throw new RuntimeCommandError("invalid_command", "执行方式需要写明任务");
          if (outcome === "consumed")
            throw new RuntimeCommandError("input_consumed", "这条待发输入已经发出");
          await pumpQueue();
        }),
      cancelInput: (id) =>
        Promise.resolve().then(async () => {
          assertUsable();
          assertInputQueueAllowed();
          const result = pendingInputStore.shellResult(id);
          if (pendingInputStore.cancel(id) === "consumed")
            throw new RuntimeCommandError("input_consumed", "这条待发输入已经发出");
          if (result) await session.emit("shell.result_discarded", result);
        }),
      async resumeInputs() {
        assertUsable();
        assertInputQueueAllowed();
        pendingInputStore.resume();
        // 空闲时立即发出队首；Turn 进行中留给它的结束边界（ADR-0070 §3）
        await pumpQueue();
      },
      async stopGoal() {
        assertUsable();
        assertMainSession();
        const goal = session.state().goal;
        if (goal === undefined) throw new RuntimeCommandError("invalid_command", "没有目标");
        if (goal.status !== "active") return;
        goalReporter.stop();
        await writeGoal("stopped", "user");
      },
      async resumeGoal() {
        assertUsable();
        assertMainSession();
        const goal = session.state().goal;
        if (goal === undefined) throw new RuntimeCommandError("invalid_command", "没有目标");
        if (goal.status === "active") return;
        await writeGoal("active");
        // 进行中的 Turn 在安全点 2 接手；空闲时用一条说明开新 Turn
        if (busy() || compactController !== undefined) return;
        const ac = new AbortController();
        await startTurns(ac, () => Promise.resolve(goalInput(goalResumeBody(goal.objective))));
      },
      async cancelGoal() {
        assertUsable();
        assertMainSession();
        if (session.state().goal === undefined)
          throw new RuntimeCommandError("invalid_command", "没有目标");
        clearingGoal = true;
        try {
          goalReporter.stop();
          controller?.abort();
          await session.emit("session.config_changed", { goal: null });
        } finally {
          clearingGoal = false;
        }
      },
      async approvePlan() {
        assertUsable();
        assertMainSession();
        if (busy() || compactController !== undefined)
          throw new RuntimeCommandError("session_busy", "会话正忙，不能批准计划");
        const plan = requirePlan();
        await writePlanPreset(planExitPreset(plan), null);
        const body = planApprovedBody();
        const ac = new AbortController();
        await startTurns(ac, () =>
          Promise.resolve({
            content: [{ type: "text", text: "批准" }],
            appended: [{ type: "text", text: workModeBlock("plan", body) }],
            workMode: { name: "plan", body, source: "runtime" },
          }),
        );
      },
      async cancelPlan() {
        assertUsable();
        assertMainSession();
        const plan = requirePlan();
        await writePlanPreset(plan.restorePreset, null);
      },
      async postToEnsemble(input) {
        assertUsable();
        assertMainSession();
        if (ensembleController === undefined) {
          throw new RuntimeCommandError("invalid_command", "当前会话没有进行中的合奏");
        }
        return await ensembleController.postFromUser(input);
      },
      async removeEnsembleMember(input) {
        assertUsable();
        assertMainSession();
        if (ensembleController === undefined) {
          throw new RuntimeCommandError("invalid_command", "当前会话没有进行中的合奏");
        }
        const name = typeof input === "string" ? input : input.name;
        await ensembleController.removeMemberFromUser(name);
      },
      async endEnsemble() {
        assertUsable();
        assertMainSession();
        if (ensembleController === undefined) {
          throw new RuntimeCommandError("invalid_command", "当前会话没有进行中的合奏");
        }
        return await ensembleController.endFromUser();
      },
      async resolveThread(input) {
        assertUsable();
        assertMainSession();
        if (suiteController === undefined) {
          throw new RuntimeCommandError("invalid_command", "当前会话不是组曲指挥会话");
        }
        await suiteController.resolveThreadFromUser(input);
      },
      async sendToThread(input) {
        assertUsable();
        assertMainSession();
        if (suiteController === undefined) {
          throw new RuntimeCommandError("invalid_command", "当前会话不是组曲指挥会话");
        }
        await suiteController.sendToThreadFromUser(input);
      },
      pendingInputs: () => pendingInputStore.snapshot(),
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
        // default 档位跟随当前模型时，选择表里的价格要换成新模型的
        installTask();
        syncEnsembleTools();
        syncSuiteTools();
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
        assertBranchNotSwitching();
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
          const state = session.state();
          const history = state.history;
          const attachmentData = new Map<string, string>();
          for (const ref of attachmentsToLoad(history, model.model, events)) {
            const bytes = await execEnv.attachments?.load(ref);
            if (bytes !== undefined)
              attachmentData.set(ref.sha256, Buffer.from(bytes).toString("base64"));
          }
          const gitPreferences = config?.resolvedSettings(environment.workspaceRoot).git;
          const plan = buildContext({
            ...(memorySnapshot !== undefined ? { memory: memorySnapshot } : {}),
            ...(gitPreferences !== undefined ? { gitPreferences } : {}),
            skills: catalog,
            ...(state.hookContext !== undefined ? { hookContext: state.hookContext } : {}),
            history,
            todos: state.todos,
            notes: state.notes,
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
          // context.md 6.6：沿用前缀失败（非中断）时以同一 throughSeq 退回文本转录再试一次，不嵌套压缩
          const summaryResult = await runSummaryWithFallback({
            model,
            plan,
            history,
            sessionId: session.id,
            signal: ac.signal,
            firstEventTimeoutMs: turnConfig.firstEventTimeoutMs,
            idleTimeoutMs: turnConfig.idleTimeoutMs,
            diagnostics,
          });
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
          await runHookContextSnapshot(
            session,
            hookRunner,
            "SessionStart",
            { resumed: false, source: "compact" },
            ac.signal,
          );
          await refreshMemorySnapshot();
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
        const gitPreferences = resolved?.git;
        const residentBasePrompt = residentChild?.basePrompt() ?? suiteController?.basePrompt();
        const key = JSON.stringify({
          seq: events.at(-1)?.seq,
          model: model.model,
          tools: specs,
          omittedMcpToolCount,
          memory: memorySnapshot,
          skills: catalog,
          instructions,
          environment,
          gitPreferences,
          compactionThreshold,
          compactionPruneLimit,
          loopGuard: turnConfig.loopGuard ?? DEFAULT_LOOP_GUARD,
          basePrompt: residentBasePrompt,
        });
        if (contextCache?.key === key) return structuredClone(contextCache.value);
        const state = session.state();
        const value = buildContext({
          ...(memorySnapshot !== undefined ? { memory: memorySnapshot } : {}),
          ...(gitPreferences !== undefined ? { gitPreferences } : {}),
          skills: catalog,
          ...(state.hookContext !== undefined ? { hookContext: state.hookContext } : {}),
          compactionThreshold,
          compactionPruneLimit,
          omittedMcpTools: omittedMcpToolCount,
          loopGuard: turnConfig.loopGuard,
          history: state.history,
          todos: state.todos,
          notes: state.notes,
          model: model.model,
          tools: specs,
          instructions,
          environment,
          events,
          ...(residentBasePrompt !== undefined ? { basePrompt: residentBasePrompt } : {}),
        });
        contextCache = { key, value: structuredClone(value) };
        return structuredClone(contextCache.value);
      },
      mcpServers() {
        return mcpSession?.status() ?? [];
      },
      async readAppResource(input) {
        assertUsable();
        const pluginId = typeof input.pluginId === "string" ? input.pluginId.trim() : "";
        const serverId = typeof input.serverId === "string" ? input.serverId.trim() : "";
        const uri = typeof input.uri === "string" ? input.uri.trim() : "";
        if (pluginId === "" || serverId === "" || uri === "") {
          throw new RuntimeCommandError("invalid_command", "缺少 pluginId、serverId 或 uri");
        }
        if (!uri.startsWith("ui://") || uri.length <= "ui://".length) {
          throw new RuntimeCommandError("invalid_resource_uri", `只允许读取 ui:// 资源：${uri}`);
        }
        if (mcpSession?.readAppResource === undefined) {
          throw new RuntimeCommandError("mcp_unavailable", "当前会话未启用 MCP 连接器");
        }
        if (!busy()) await applyMcp();
        const activeServer = sessionPlugins.mcpServers.find(
          (s) => s.pluginId === pluginId && s.id === serverId,
        );
        if (activeServer === undefined) {
          throw new RuntimeCommandError(
            "plugin_unavailable",
            `插件 ${pluginId} 的服务器 "${serverId}" 未启用或不可用`,
          );
        }
        await mcpSession.startup(sessionCloseController.signal);
        try {
          return await mcpSession.readAppResource(serverId, uri, sessionCloseController.signal);
        } catch (e) {
          const code =
            typeof e === "object" &&
            e !== null &&
            typeof (e as { code?: unknown }).code === "string"
              ? (e as { code: CommandRejectCode }).code
              : "resource_read_failed";
          throw new RuntimeCommandError(code, e instanceof Error ? e.message : String(e));
        }
      },
      async callAppTool(input) {
        assertUsable();
        const pluginId = typeof input.pluginId === "string" ? input.pluginId.trim() : "";
        const serverId = typeof input.serverId === "string" ? input.serverId.trim() : "";
        const toolName = typeof input.tool === "string" ? input.tool.trim() : "";
        if (pluginId === "" || serverId === "" || toolName === "" || toolName.includes("/")) {
          throw new RuntimeCommandError("invalid_command", "缺少合法的 pluginId、serverId 或 tool");
        }
        if (mcpSession?.callAppTool === undefined || mcpSession.getAppToolMeta === undefined) {
          throw new RuntimeCommandError("mcp_unavailable", "当前会话未启用 MCP 连接器");
        }
        if (!busy()) await applyMcp();
        const activeServer = sessionPlugins.mcpServers.find(
          (s) => s.pluginId === pluginId && s.id === serverId,
        );
        if (activeServer === undefined) {
          throw new RuntimeCommandError(
            "plugin_unavailable",
            `插件 ${pluginId} 的服务器 "${serverId}" 未启用或不可用`,
          );
        }
        await mcpSession.startup(sessionCloseController.signal);
        const evaluateAppTool = (meta: McpAppToolMeta) => {
          if (!meta.visibility.includes("app")) {
            throw new RuntimeCommandError(
              "app_tool_not_allowed",
              `工具 ${serverId}/${toolName} 不允许页面调用`,
            );
          }
          const evalRes = policy.evaluate(
            [
              {
                kind: "mcp",
                target: `${serverId}/${toolName}`,
                ...(meta.readOnly ? { readOnly: true } : {}),
              },
            ],
            { caller: { kind: "app", serverId } },
          );
          if (evalRes.decision.action !== "allow") {
            throw new RuntimeCommandError(
              (evalRes.decision.errorCode as CommandRejectCode | undefined) ?? "permission_denied",
              evalRes.decision.reason,
            );
          }
        };
        let meta = mcpSession.getAppToolMeta(serverId, toolName);
        if (meta === undefined && mcpSession.ensurePluginServerReady !== undefined) {
          try {
            await mcpSession.ensurePluginServerReady(serverId, sessionCloseController.signal);
          } catch (e) {
            const code =
              typeof e === "object" &&
              e !== null &&
              typeof (e as { code?: unknown }).code === "string"
                ? (e as { code: CommandRejectCode }).code
                : "mcp_unavailable";
            throw new RuntimeCommandError(code, e instanceof Error ? e.message : String(e));
          }
          meta = mcpSession.getAppToolMeta(serverId, toolName);
        }
        if (meta === undefined) {
          throw new RuntimeCommandError(
            "mcp_tool_missing",
            `MCP 工具 ${serverId}/${toolName} 不存在`,
          );
        }
        // 启动前按当前已知元数据经权限层判定：拒绝时不拉起 standby 服务器
        evaluateAppTool(meta);
        // 拉起服务器后再以实时 tools/list 复核权限，防止过期缓存绕过只读或可见性约束
        if (mcpSession.ensurePluginServerReady !== undefined) {
          try {
            await mcpSession.ensurePluginServerReady(serverId, sessionCloseController.signal);
          } catch (e) {
            const code =
              typeof e === "object" &&
              e !== null &&
              typeof (e as { code?: unknown }).code === "string"
                ? (e as { code: CommandRejectCode }).code
                : "mcp_unavailable";
            throw new RuntimeCommandError(code, e instanceof Error ? e.message : String(e));
          }
          const liveMeta = mcpSession.getAppToolMeta(serverId, toolName);
          if (liveMeta === undefined) {
            throw new RuntimeCommandError(
              "mcp_tool_missing",
              `MCP 工具 ${serverId}/${toolName} 已不存在`,
            );
          }
          evaluateAppTool(liveMeta);
        }
        try {
          return await mcpSession.callAppTool(
            serverId,
            toolName,
            input.arguments ?? {},
            sessionCloseController.signal,
          );
        } catch (e) {
          const code =
            typeof e === "object" &&
            e !== null &&
            typeof (e as { code?: unknown }).code === "string"
              ? (e as { code: CommandRejectCode }).code
              : "tool_error";
          throw new RuntimeCommandError(code, e instanceof Error ? e.message : String(e));
        }
      },
      async listAppSurfaces() {
        assertUsable();
        if (!busy()) await applyMcp();
        if (mcpSession !== undefined) {
          await mcpSession.startup(sessionCloseController.signal);
        }
        const activeServers = new Set(
          sessionPlugins.mcpServers.map((s) => `${s.pluginId}\0${s.id}`),
        );
        const enabledPlugins = sessionPlugins.plugins
          .filter((p) => p.state === "on" && (p.surfaces?.length ?? 0) > 0)
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        const result: SessionAppSurface[] = [];
        for (const plugin of enabledPlugins) {
          const rawSurfaces = (plugin.surfaces ?? []).filter((s) =>
            activeServers.has(`${plugin.id}\0${s.server}`),
          );
          if (rawSurfaces.length === 0) continue;
          const toolsByServer = new Map<string, readonly McpAppToolMeta[]>();
          for (const s of rawSurfaces) {
            if (s.open === undefined || toolsByServer.has(s.server)) continue;
            const listed = mcpSession?.listServerTools?.(s.server);
            if (listed !== undefined) toolsByServer.set(s.server, listed);
          }
          const surfaceWarnings: string[] = [];
          const validated = applyToolMetaToPluginSurfaces(
            `${plugin.name}@${plugin.marketplace}`,
            rawSurfaces,
            toolsByServer,
            surfaceWarnings,
          );
          for (const s of validated) {
            result.push({
              pluginId: plugin.id,
              pluginName: plugin.displayName ?? plugin.name,
              ...(plugin.icon !== undefined ? { icon: plugin.icon } : {}),
              id: s.id,
              title: s.title,
              serverId: s.server,
              resourceUri: s.resourceUri,
              ...(s.open !== undefined ? { open: s.open } : {}),
            });
          }
        }
        return result;
      },
      isIdle,
      onIdle(listener) {
        idleListeners.add(listener);
        return () => idleListeners.delete(listener);
      },
      async close() {
        idleListeners.clear();
        detach();
        closing = true;
        sessionCloseController.abort();
        unsubscribeTitle();
        titleController.abort();
        controller?.abort();
        compactController?.abort();
        gate.cancelAll?.();
        forwardedPermissions.cancelWaiting();
        questions.cancelAll();
        await backgroundSubagents.discard(session.id);
        await backgroundShells.discard();
        await ensembleController?.dispose();
        await suiteController?.dispose();
        await Promise.all([
          turnSettled,
          compactSettled,
          titleSettled,
          rewindSettled,
          pageModels.stopAll(),
          pageStorage.drain(),
        ]);
        // 父工具可能正在创建 child；等父 Turn 退出后再收束这期间登记的后台任务。
        await backgroundSubagents.discard(session.id);
        await backgroundShells.discard();
        await ensembleController?.dispose();
        await suiteController?.dispose();
        await worktreeChain;
        // SessionEnd Hook（hooks.md）：清理开始前运行；失败已在 runner 内降级
        if (hookRunner !== undefined) {
          await hookRunner.run("SessionEnd", { reason: "close" }).catch(() => undefined);
        }
        // 与打开失败共用的撤销步骤：Runtime 级登记、MCP 连接
        await runTeardown();
        await session.close();
      },
    };
    teardown.push(backgroundSubagents.onSettled(session.id, notifyIdle));
    if (residentChild !== undefined) {
      const controls: ResidentChildInternalControls = {
        isBusy: () => busy() || compacting(),
        hasActivePendingInputs: () =>
          pendingInputStore.snapshot().items.some((item) => !item.paused),
        deliverInput: (input, forcePaused = false) => {
          if (closing || session.health !== "ok") return Promise.resolve();
          if (!forcePaused) {
            pendingInputStore.resume();
          }
          pendingInputStore.add(residentChild.kind, input, forcePaused);
          if (forcePaused) return Promise.resolve();
          void pumpQueue().catch(() => {
            pendingInputStore.pauseAll();
          });
          return Promise.resolve();
        },
        resumeFromModelChange: (modelKey) => {
          if (closing || session.health !== "ok") return Promise.resolve();
          pendingInputStore.resume();
          if (pendingInputStore.snapshot().items.some((item) => !item.paused)) {
            void pumpQueue().catch(() => {
              pendingInputStore.pauseAll();
            });
            return Promise.resolve();
          }
          if (!busy() && !compacting()) {
            const prefix = residentChild.kind === "suite" ? "[Suite]" : "[Ensemble]";
            const resumePrompt = `${prefix} Your model was switched to ${modelKey} after the previous turn failed. Continue your task from where you left off.`;
            pendingInputStore.add(residentChild.kind, {
              content: [{ type: "text", text: resumePrompt }],
              appended: [],
            });
            void pumpQueue().catch(() => {
              pendingInputStore.pauseAll();
            });
          }
          return Promise.resolve();
        },
        setModelAndEffort: async (modelRef, effort) => {
          await rebuildProviders();
          const resolvedNext = resolveSessionModel(modelRef);
          await session.emit("session.config_changed", {
            model: modelRef,
            ...(effort !== undefined ? { reasoningEffort: effort } : {}),
          });
          model = resolvedNext;
          installSkills();
        },
        interruptAndWait: async () => {
          controller?.abort();
          compactController?.abort();
          gate.cancelAll?.();
          questions.cancelAll();
          await Promise.all([turnSettled, compactSettled]);
        },
        clearPendingInputs: () => {
          pendingInputStore.dropMode("ensemble");
        },
      };
      Object.defineProperty(runtimeSession, RESIDENT_CHILD_CONTROLS, { value: controls });
    }
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

  const grantWorkspace = (input: { workspace: string }): string =>
    z.string().min(1).parse(input.workspace);
  const grantConfig = (): RuntimeConfig => {
    if (config === undefined)
      throw new RuntimeCommandError("invalid_command", "授权管理需要配置存储");
    return config;
  };
  const sessionGrantRoot = (sessionId: string): string => {
    z.string().min(1).parse(sessionId);
    let current = subagentRegistry.liveSession(sessionId);
    if (current === undefined) throw new RuntimeCommandError("invalid_command", "没有打开的会话");
    for (;;) {
      const parentId = current.state().meta.parent?.sessionId;
      if (parentId === undefined) break;
      const parent = subagentRegistry.liveSession(parentId);
      if (parent === undefined) break;
      current = parent;
    }
    return current.id;
  };
  const resolveMemoryTarget = async (input: {
    scope: string;
    key?: string | undefined;
    workspaceRoot?: string | undefined;
    name?: string | undefined;
  }): Promise<{ scope: MemoryScope; dir: string }> => {
    if (!isMemoryScope(input.scope)) {
      throw new RuntimeCommandError("invalid_command", `未知记忆范围：${input.scope}`);
    }
    if (input.name !== undefined && !isValidMemoryName(input.name)) {
      throw new RuntimeCommandError(
        "invalid_command",
        `记忆名称无效 "${input.name}"（须匹配 ^[a-z0-9][a-z0-9-]*$）`,
      );
    }
    const target = await resolveMemoryScopeDir(platform, nocturneHome, {
      scope: input.scope,
      ...(input.key !== undefined ? { key: input.key } : {}),
      ...(input.key === undefined && input.scope === "project"
        ? {
            workspaceRoot:
              input.workspaceRoot !== undefined
                ? await platform.resolveReal(input.workspaceRoot)
                : workspaceRoot,
          }
        : {}),
    }).catch((e: unknown) => {
      throw new RuntimeCommandError("invalid_command", e instanceof Error ? e.message : String(e));
    });
    if (target === undefined) {
      throw new RuntimeCommandError("invalid_command", "默认工作区没有项目记忆范围");
    }
    return { scope: input.scope, dir: target.dir };
  };
  const runtime: Runtime = {
    async workspaceBranches({ workspace }) {
      const root = await gitRepository(workspace);
      if (root === null) return { current: null, branches: [], busy: false };
      try {
        return { ...(await gitWorkspaceBranches(workspace, root)), busy: branchBusy(root) };
      } catch {
        return { current: null, branches: [], busy: branchBusy(root) };
      }
    },
    async switchBranch({ workspace, branch, create = false }) {
      const root = await gitRepository(workspace);
      if (root === null) throw new RuntimeCommandError("invalid_command", "工作目录不是 Git 仓库");
      const key = directoryKey(root);
      if (branchBusy(root)) throw new RuntimeCommandError("session_busy", "工作目录正忙");
      branchSwitches.add(key);
      try {
        await gitSwitchBranch(workspace, branch, create);
      } finally {
        branchSwitches.delete(key);
        for (const hooks of openSessions.values()) {
          if (platform.paths.isWithin(root, hooks.workspace)) hooks.pumpPending();
        }
      }
    },
    listSessionGrants({ sessionId }) {
      return (grantLists.get(sessionGrantRoot(sessionId)) ?? []).map((grant) => ({ ...grant }));
    },
    revokeSessionGrant(input) {
      const root = sessionGrantRoot(input.sessionId);
      const kind = subjectKindSchema.parse(input.kind);
      const target = z.string().min(1).parse(input.target);
      const match = z.literal("pattern").optional().parse(input.match);
      const entries = grantLists.get(root) ?? [];
      for (let i = entries.length - 1; i >= 0; i--) {
        if (
          entries[i]?.kind === kind &&
          entries[i]?.target === target &&
          entries[i]?.match === match
        )
          entries.splice(i, 1);
      }
      grantsChanged({ sessionId: root });
      return Promise.resolve();
    },
    revokeAllSessionGrants({ sessionId }) {
      const root = sessionGrantRoot(sessionId);
      grantLists.get(root)?.splice(0);
      grantsChanged({ sessionId: root });
      return Promise.resolve();
    },
    listGrantWorkspaces: () =>
      grantConfig().listGrantWorkspaces(
        [...openSessions.values()].map((hooks) => hooks.skillModel.workspaceRoot),
        (message) => {
          for (const hooks of openSessions.values()) hooks.grantWarning(message);
          diagnostics.record("grants.warning", { message });
        },
      ),
    async listGrants(input) {
      return (await grantConfig().forWorkspace(grantWorkspace(input))).grants.list();
    },
    async revokeGrant(input) {
      const workspace = grantWorkspace(input);
      const kind = subjectKindSchema.parse(input.kind);
      const target = z.string().min(1).parse(input.target);
      const match = z.literal("pattern").optional().parse(input.match);
      await (await grantConfig().forWorkspace(workspace)).grants.remove(kind, target, match);
      grantsChanged({ workspace });
    },
    async revokeAllGrants(input) {
      const workspace = grantWorkspace(input);
      await (await grantConfig().forWorkspace(workspace)).grants.clear();
      grantsChanged({ workspace });
    },
    describeProject: (input) => grantConfig().describeProject(grantWorkspace(input)),
    async setWorkspaceTrusted(input) {
      const workspace = grantWorkspace(input);
      await grantConfig().setWorkspaceTrusted(workspace, z.boolean().parse(input.trusted));
      grantsChanged({ workspace });
    },
    onGrantsChanged(listener) {
      grantsListeners.add(listener);
      return () => {
        grantsListeners.delete(listener);
      };
    },
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
    close: async () => {
      await Promise.all([scheduler.stop(), imageProcessor.close()]);
    },
    describeMcpServers: (input = {}) =>
      requireMcpConfig().describeMcpServers(
        mcpInput(z.object({ workspaceRoot: workspaceField }), input),
      ),
    describeHooks: (input = {}) => {
      const parsed = z.object({ workspaceRoot: workspaceField }).parse(input);
      return config !== undefined
        ? config.describeHooks(parsed)
        : Promise.resolve({ hooks: [], warnings: [] });
    },
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
        pluginSkillDirs: await resolveActivePluginSkillDirs(platform, pluginDiscoveryOptions),
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
    async describeProjectSubagents(input = {}) {
      const parsed = z.object({ workspaceRoot: z.string().min(1).optional() }).parse(input);
      const root = parsed.workspaceRoot
        ? await platform.resolveReal(parsed.workspaceRoot)
        : workspaceRoot;
      const discovery = await discoverProjectSubagents(platform, {
        workspaceRoot: root,
        cwd: root,
        includeClaude: includeClaudeProjectSubagents(config?.skillConfig()),
      });
      return {
        agents: discovery.agents.map(toProjectSubagentOverview),
        warnings: discovery.warnings,
      };
    },
    async describePlugins() {
      const res = await resolvePlugins(platform, {
        ...pluginDiscoveryOptions,
        reservedMcpIds: collectReservedMcpIds(config?.base.mcpServers),
      });
      const cacheDir = paths.join(nocturneHome, "plugins", "cache", "mcp-tools");
      const cacheByServer = new Map<string, PluginMcpCacheKey>();
      for (const s of res.mcpServers) {
        if (s.cache !== undefined) cacheByServer.set(`${s.pluginId}\0${s.id}`, s.cache);
      }
      const plugins = await Promise.all(
        res.plugins.map(async (plugin) => {
          const surfaces = plugin.surfaces ?? [];
          if (!surfaces.some((s) => s.open !== undefined)) return plugin;
          const toolsByServer = new Map<string, readonly McpAppToolMeta[]>();
          for (const s of surfaces) {
            if (s.open === undefined || toolsByServer.has(s.server)) continue;
            let tools: readonly McpAppToolMeta[] | undefined;
            for (const hooks of openSessions.values()) {
              tools = hooks.listMcpServerTools?.(s.server);
              if (tools !== undefined) break;
            }
            if (tools === undefined && options.mcp?.readPluginCachedTools !== undefined) {
              const cacheKey = cacheByServer.get(`${plugin.id}\0${s.server}`);
              if (cacheKey !== undefined) {
                tools = await options.mcp.readPluginCachedTools(
                  platform,
                  cacheDir,
                  s.server,
                  cacheKey,
                );
              }
            }
            if (tools !== undefined) toolsByServer.set(s.server, tools);
          }
          if (toolsByServer.size === 0) return plugin;
          const nextWarnings = [...plugin.warnings];
          const nextSurfaces = applyToolMetaToPluginSurfaces(
            `${plugin.name}@${plugin.marketplace}`,
            surfaces,
            toolsByServer,
            nextWarnings,
          );
          return { ...plugin, surfaces: nextSurfaces, warnings: nextWarnings };
        }),
      );
      return { plugins, warnings: res.warnings };
    },
    async describeMemory(input) {
      const parsed = z
        .object({
          workspaceRoot: z.string().min(1).optional(),
          suiteId: z.string().min(1).optional(),
        })
        .strict()
        .parse(input ?? {});
      if (parsed.suiteId !== undefined && !isValidSuiteId(parsed.suiteId)) {
        throw new RuntimeCommandError("invalid_command", `无效的 suiteId：${parsed.suiteId}`);
      }
      const root =
        parsed.workspaceRoot !== undefined
          ? await platform.resolveReal(parsed.workspaceRoot)
          : workspaceRoot;
      const switches = config?.memoryConfig() ?? { global: true, project: true };
      return describeMemoryStore(platform, nocturneHome, {
        workspaceRoot: root,
        switches,
        ...(parsed.suiteId !== undefined ? { suiteId: parsed.suiteId } : {}),
      });
    },
    async readMemory(input) {
      const parsed = z
        .object({
          scope: z.string().min(1),
          key: z.string().min(1).optional(),
          workspaceRoot: z.string().min(1).optional(),
          name: z.string().min(1),
        })
        .strict()
        .parse(input);
      const target = await resolveMemoryTarget(parsed);
      const res = await readMemoryEntry(platform, target.dir, target.scope, parsed.name);
      if (!res.ok) {
        throw new RuntimeCommandError("invalid_command", res.message);
      }
      return res.entry;
    },
    async deleteMemory(input) {
      const parsed = z
        .object({
          scope: z.string().min(1),
          key: z.string().min(1).optional(),
          workspaceRoot: z.string().min(1).optional(),
          name: z.string().min(1),
        })
        .strict()
        .parse(input);
      const target = await resolveMemoryTarget(parsed);
      const deleted = await deleteMemoryEntry(platform, target.dir, parsed.name);
      if (deleted) notifyMemoryChanged();
    },
    async clearMemory(input) {
      const parsed = z
        .object({
          scope: z.string().min(1),
          key: z.string().min(1).optional(),
          workspaceRoot: z.string().min(1).optional(),
        })
        .strict()
        .parse(input);
      const target = await resolveMemoryTarget(parsed);
      await clearMemoryDir(platform, target.dir, target.scope);
      notifyMemoryChanged();
    },
    onMemoryChanged(listener) {
      memoryChangedListeners.add(listener);
      return () => {
        memoryChangedListeners.delete(listener);
      };
    },
    listSuites: (filter) => suiteStore.list(filter),
    async createSuite(input) {
      const name = typeof input.name === "string" ? input.name.trim() : "";
      if (name === "") {
        throw new RuntimeCommandError("invalid_command", "组曲名称不能为空");
      }
      if (!Array.isArray(input.workspaces) || input.workspaces.length === 0) {
        throw new RuntimeCommandError("invalid_command", "组曲至少需要一个工作区");
      }
      const workspaces: string[] = [];
      for (const ws of input.workspaces) {
        if (typeof ws !== "string" || ws.trim() === "") {
          throw new RuntimeCommandError("invalid_command", "工作区路径不能为空");
        }
        const resolvedWs = await platform.resolveReal(ws);
        if (!workspaces.some((existing) => paths.equals(existing, resolvedWs))) {
          workspaces.push(resolvedWs);
        }
      }
      const primaryWorkspace = workspaces[0];
      if (primaryWorkspace === undefined) {
        throw new RuntimeCommandError("invalid_command", "组曲至少需要一个工作区");
      }
      const defaults =
        config !== undefined ? (await config.forWorkspace(primaryWorkspace)).resolved : undefined;
      const preset = normalizePermissionPreset(
        input.permissionPreset ?? defaults?.permissionPreset ?? DEFAULT_PERMISSION_PRESET,
      );
      if (!isPermissionPresetName(preset)) {
        throw new RuntimeCommandError(
          "invalid_command",
          `未知权限预设：${preset}（可选：read-only | default | auto-edit | guarded | smart | bypass）`,
        );
      }
      const initialEffort = input.reasoningEffort ?? defaults?.reasoningEffort;
      if (initialEffort !== undefined && !isReasoningEffort(initialEffort)) {
        throw new RuntimeCommandError(
          "invalid_command",
          `未知思考档位：${initialEffort}（可选：${REASONING_EFFORT_ORDER.join(" | ")}）`,
        );
      }
      const wsRegistry = config !== undefined ? buildRegistry(defaults?.providers ?? []) : registry;
      const disabled = disabledSet();
      const rawModel =
        input.model ??
        defaults?.model ??
        wsRegistry
          .providers()
          .flatMap((p) => p.models())
          .map((m) => applyDisabled(m, disabled))
          .find((m) => m.disabled === undefined && m.unavailable === undefined)?.ref;
      if (rawModel === undefined || rawModel === "") {
        throw new RuntimeCommandError("invalid_model", "未指定 model 且未找到可用的默认模型");
      }
      let modelRef: ModelRef;
      try {
        modelRef = parseModelRef(rawModel);
        const resolvedModel = wsRegistry.resolve(modelRef);
        const checked = applyDisabled(resolvedModel.model, disabled);
        if (checked.unavailable !== undefined) {
          throw invalidModelError(checked.unavailable.reason, checked);
        }
      } catch (e) {
        if (e instanceof UnknownModelError) {
          throw new RuntimeCommandError("invalid_model", e.message);
        }
        throw e;
      }

      const threadDefaults = input.threadDefaults ?? {};
      if (
        threadDefaults.reasoningEffort !== undefined &&
        !isReasoningEffort(threadDefaults.reasoningEffort)
      ) {
        throw new RuntimeCommandError(
          "invalid_command",
          `threadDefaults.reasoningEffort 无效：${String(threadDefaults.reasoningEffort)}`,
        );
      }
      if (
        threadDefaults.preset !== undefined &&
        threadDefaults.preset !== "general" &&
        threadDefaults.preset !== "explore"
      ) {
        throw new RuntimeCommandError(
          "invalid_command",
          `threadDefaults.preset 无效：${threadDefaults.preset}`,
        );
      }

      const suiteId = newSuiteId();
      const coordRaw = await store.create({
        cwd: primaryWorkspace,
        workspaceRoot: primaryWorkspace,
        model: modelRef,
        permissionPreset: preset,
        nocturneVersion: options.version ?? NOCTURNE_VERSION,
        ...(initialEffort !== undefined ? { reasoningEffort: initialEffort } : {}),
        suite: { id: suiteId, role: "coordinator" },
      });
      await coordRaw.close();

      const record: SuiteRecord = {
        version: 1,
        id: suiteId,
        name,
        ...(input.goal !== undefined && input.goal.trim() !== ""
          ? { goal: input.goal.trim() }
          : {}),
        workspaces,
        instructions: input.instructions ?? "",
        coordinatorSessionId: coordRaw.id,
        threadDefaults: {
          ...(threadDefaults.model !== undefined ? { model: threadDefaults.model } : {}),
          ...(threadDefaults.reasoningEffort !== undefined
            ? { reasoningEffort: threadDefaults.reasoningEffort }
            : {}),
          ...(threadDefaults.preset !== undefined ? { preset: threadDefaults.preset } : {}),
          ...(threadDefaults.isolated !== undefined ? { isolated: threadDefaults.isolated } : {}),
        },
        createdAt: new Date().toISOString(),
      };
      await suiteStore.save(record);
      return record;
    },
    async updateSuite(input) {
      if (!isValidSuiteId(input.id)) {
        throw new RuntimeCommandError("invalid_command", `组曲不存在：${input.id}`);
      }
      const patch: Omit<UpdateSuiteInput, "id"> = {};
      if (input.name !== undefined) {
        const trimmed = input.name.trim();
        if (trimmed === "") {
          throw new RuntimeCommandError("invalid_command", "组曲名称不能为空");
        }
        patch.name = trimmed;
      }
      if (input.goal !== undefined) {
        patch.goal =
          input.goal === null ? null : input.goal.trim() === "" ? null : input.goal.trim();
      }
      if (input.workspaces !== undefined) {
        if (!Array.isArray(input.workspaces) || input.workspaces.length === 0) {
          throw new RuntimeCommandError("invalid_command", "组曲至少需要一个工作区");
        }
        const resolvedWorkspaces: string[] = [];
        for (const ws of input.workspaces) {
          if (typeof ws !== "string" || ws.trim() === "") {
            throw new RuntimeCommandError("invalid_command", "工作区路径不能为空");
          }
          const real = await platform.resolveReal(ws);
          if (!resolvedWorkspaces.some((existing) => paths.equals(existing, real))) {
            resolvedWorkspaces.push(real);
          }
        }
        patch.workspaces = resolvedWorkspaces;
      }
      if (input.instructions !== undefined) {
        patch.instructions = input.instructions;
      }
      if (input.threadDefaults !== undefined) {
        if (
          input.threadDefaults.reasoningEffort !== undefined &&
          !isReasoningEffort(input.threadDefaults.reasoningEffort)
        ) {
          throw new RuntimeCommandError(
            "invalid_command",
            `threadDefaults.reasoningEffort 无效：${String(input.threadDefaults.reasoningEffort)}`,
          );
        }
        if (
          input.threadDefaults.preset !== undefined &&
          input.threadDefaults.preset !== "general" &&
          input.threadDefaults.preset !== "explore"
        ) {
          throw new RuntimeCommandError(
            "invalid_command",
            `threadDefaults.preset 无效：${input.threadDefaults.preset}`,
          );
        }
        patch.threadDefaults = input.threadDefaults;
      }
      const updated = await suiteStore.update(input.id, patch);
      if (updated === undefined) {
        throw new RuntimeCommandError("invalid_command", `组曲不存在：${input.id}`);
      }
      openSessions.get(updated.coordinatorSessionId)?.updateSuiteRecord?.(updated);
      return updated;
    },
    async archiveSuite(id) {
      if (!isValidSuiteId(id)) {
        throw new RuntimeCommandError("invalid_command", `组曲不存在：${id}`);
      }
      const existing = await suiteStore.get(id);
      if (existing === undefined) {
        throw new RuntimeCommandError("invalid_command", `组曲不存在：${id}`);
      }
      if (openSessions.get(existing.coordinatorSessionId)?.suiteCoordinatorBusy?.()) {
        throw new RuntimeCommandError("session_busy", "组曲指挥或线程正忙，不能归档");
      }
      if (existing.archivedAt !== undefined) return;
      await suiteStore.update(id, { archivedAt: new Date().toISOString() });
    },
    async openSuite(id, resumeOpts) {
      if (!isValidSuiteId(id)) {
        throw new RuntimeCommandError("invalid_command", `组曲不存在：${id}`);
      }
      const existing = await suiteStore.get(id);
      if (existing === undefined) {
        throw new RuntimeCommandError("invalid_command", `组曲不存在：${id}`);
      }
      return await runtime.resumeSession(existing.coordinatorSessionId, resumeOpts);
    },
    async setPluginEnabled(input) {
      const parsed = z
        .object({ id: z.string().min(1), enabled: z.boolean() })
        .strict()
        .parse(input);
      try {
        await setPluginEnabledInStore(platform, {
          ...pluginDiscoveryOptions,
          id: parsed.id,
          enabled: parsed.enabled,
        });
      } catch (e) {
        throw new RuntimeCommandError(
          "invalid_command",
          e instanceof Error ? e.message : String(e),
        );
      }
      const affectedSessions = await broadcast("skills", (hooks) => hooks.refreshSkills(true));
      await broadcast("mcp", (hooks) => hooks.reconcileMcp());
      return { affectedSessions };
    },
    async installLocalPlugin(input) {
      const parsed = z
        .object({ path: z.string().min(1) })
        .strict()
        .parse(input);
      let overview: PluginOverview;
      try {
        overview = await installLocalPluginInStore(platform, {
          ...pluginDiscoveryOptions,
          reservedMcpIds: collectReservedMcpIds(config?.base.mcpServers),
          path: parsed.path,
        });
      } catch (e) {
        throw new RuntimeCommandError(
          "invalid_command",
          e instanceof Error ? e.message : String(e),
        );
      }
      await broadcast("skills", (hooks) => hooks.refreshSkills(true));
      await broadcast("mcp", (hooks) => hooks.reconcileMcp());
      return overview;
    },
    async uninstallPlugin(input) {
      const parsed = z
        .object({ id: z.string().min(1) })
        .strict()
        .parse(input);
      const deactivate = async (): Promise<number> => {
        const affectedSessions = await broadcast("skills", (hooks) => hooks.refreshSkills(true));
        await broadcast("mcp", (hooks) => hooks.reconcileMcp());
        return affectedSessions;
      };
      try {
        return await uninstallPluginInStore(platform, {
          ...pluginDiscoveryOptions,
          id: parsed.id,
          onDeactivate: deactivate,
        });
      } catch (e) {
        throw new RuntimeCommandError(
          "invalid_command",
          e instanceof Error ? e.message : String(e),
        );
      }
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
    async listDecisionModels(decisionModel, signal, input) {
      validateSettingsPatch({ decisionModel });
      const providers = config
        ? (await config.forWorkspace(input?.workspaceRoot ?? workspaceRoot)).resolved.providers
        : (options.providerConfigs ?? []);
      if (decisionModel.source === "gemini") {
        return fetchGeminiDecisionModels(
          resolveGeminiDecisionConnection(decisionModel, reviewerCredentials(providers), (name) =>
            platform.env(name),
          ),
          GEMINI_DECISION_ENDPOINTS[decisionModel.endpoint].model,
          signal,
          GEMINI_DECISION_ENDPOINTS[decisionModel.endpoint].modelFilter,
        );
      }
      return fetchJevModels(
        resolveJevConnection(
          decisionModel,
          providers,
          reviewerCredentials(providers),
          (name) => platform.env(name),
          "decision-model",
          "reviewer",
        ),
        JEV_ENDPOINTS[decisionModel.endpoint].model,
        signal,
        JEV_ENDPOINTS[decisionModel.endpoint].modelFilter,
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
      if (selected.backend === "decision") {
        if (settings.decisionModel === undefined)
          throw new RuntimeCommandError("invalid_model", "决策模型未设置");
        reviewer = buildDecisionReviewer(
          settings.decisionModel,
          selected.minConfidence ?? 0.7,
          settings.providers,
          "reviewer-samples",
        );
      } else if (selected.backend === "jev") {
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
        const currentItems = config.describeSettings(root);
        const savedReviewer = currentItems.find((item) => item.key === "permission.reviewer")
          ?.reviewer?.saved;
        const savedDecisionModel = currentItems.find((item) => item.key === "decisionModel")
          ?.decisionModel?.saved;
        const effectivePatch: SettingsPatch = { ...patch };
        let migrateStoredKey = false;
        let deleteLegacyReviewerKey = false;
        if (savedReviewer?.backend === "jev") {
          if (
            patch["permission.reviewer"] !== undefined &&
            savedDecisionModel === undefined &&
            patch.decisionModel === undefined
          ) {
            effectivePatch.decisionModel = decisionModelFromJevReviewer(savedReviewer);
            if ("stored" in savedReviewer.credential) {
              migrateStoredKey = settingsOptions?.decisionModelKey === undefined;
              deleteLegacyReviewerKey = true;
            }
          }
          if (patch.decisionModel !== undefined && patch["permission.reviewer"] === undefined) {
            effectivePatch["permission.reviewer"] = {
              backend: "decision",
              ...(savedReviewer.minConfidence !== undefined
                ? { minConfidence: savedReviewer.minConfidence }
                : {}),
            };
            if ("stored" in savedReviewer.credential) {
              if (
                patch.decisionModel !== null &&
                "stored" in patch.decisionModel.credential &&
                settingsOptions?.decisionModelKey === undefined
              ) {
                migrateStoredKey = true;
              }
              deleteLegacyReviewerKey = true;
            }
          }
        }
        if (effectivePatch !== patch) validateSettingsPatch(effectivePatch);
        const previousReviewerKey =
          settingsOptions?.reviewerKey !== undefined
            ? await config.credentials.get("reviewer")
            : undefined;
        if (settingsOptions?.reviewerKey !== undefined) {
          const reviewer = effectivePatch["permission.reviewer"];
          if (
            reviewer?.backend !== "jev" ||
            !("stored" in reviewer.credential) ||
            settingsOptions.reviewerKey.trim() === ""
          )
            throw new Error("单独密钥只用于凭据库存储的 Jev 审查器");
          await config.setCredential("reviewer", settingsOptions.reviewerKey);
        }
        const needDecisionKeyWrite =
          settingsOptions?.decisionModelKey !== undefined || migrateStoredKey;
        const previousDecisionKey = needDecisionKeyWrite
          ? await config.credentials.get("decision-model")
          : undefined;
        let wroteDecisionKey = false;
        if (settingsOptions?.decisionModelKey !== undefined) {
          const dm = effectivePatch.decisionModel;
          if (
            dm == null ||
            !("stored" in dm.credential) ||
            settingsOptions.decisionModelKey.trim() === ""
          ) {
            if (settingsOptions.reviewerKey !== undefined) {
              if (previousReviewerKey !== undefined)
                await config.setCredential("reviewer", previousReviewerKey);
              else await config.credentials.delete("reviewer");
            }
            throw new Error("单独密钥只用于凭据库存储的决策模型");
          }
          await config.setCredential("decision-model", settingsOptions.decisionModelKey);
          wroteDecisionKey = true;
        } else if (migrateStoredKey && previousDecisionKey === undefined) {
          const legacyKey = await config.credentials.get("reviewer");
          if (legacyKey !== undefined) {
            await config.setCredential("decision-model", legacyKey);
            wroteDecisionKey = true;
          }
        }
        try {
          await config.updateSettings(effectivePatch);
        } catch (error) {
          if (settingsOptions?.reviewerKey !== undefined) {
            if (previousReviewerKey !== undefined)
              await config.setCredential("reviewer", previousReviewerKey);
            else await config.credentials.delete("reviewer");
          }
          if (wroteDecisionKey) {
            if (previousDecisionKey !== undefined)
              await config.setCredential("decision-model", previousDecisionKey);
            else await config.credentials.delete("decision-model");
          }
          throw error;
        }
        if (deleteLegacyReviewerKey && effectivePatch["permission.reviewer"]?.backend !== "jev") {
          await config.credentials.delete("reviewer").catch(() => undefined);
        }
        await broadcast("providers", (hooks) => {
          hooks.markProvidersDirty();
        });
        if (
          Object.keys(patch).some(
            (key) => key.startsWith("subagents.") || key === "modelRoles.task",
          )
        ) {
          await broadcast("externalAgents", (hooks) => {
            hooks.refreshExternalAgents();
          });
        }
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
      const preparedWorktree =
        opts.branch !== undefined
          ? await prepareSessionBranchWorktree({
              projectCwd: sessionCwd,
              branch: opts.branch.name,
              create: opts.branch.create === true,
              sessionRoot: defaults?.worktree?.sessionRoot,
              fetchBeforeCreate: defaults?.worktree?.fetchBeforeCreate,
            })
          : undefined;
      const session = await store.create({
        cwd: sessionCwd,
        workspaceRoot: sessionRoot,
        model: parseModelRef(opts.model),
        permissionPreset: preset,
        nocturneVersion: options.version ?? NOCTURNE_VERSION,
        ...(initialEffort !== undefined ? { reasoningEffort: initialEffort } : {}),
        ...(opts.parent !== undefined ? { parent: opts.parent } : {}),
        ...(opts.schedule !== undefined ? { schedule: opts.schedule } : {}),
        ...(opts.client !== undefined ? { client: opts.client } : {}),
      });
      try {
        if (preparedWorktree !== undefined) {
          const previous = await platform.resolveReal(sessionCwd);
          await session.emit("session.config_changed", {
            worktree: {
              current: preparedWorktree.targetCwd,
              previous,
              branch: preparedWorktree.branch,
            },
            branch: {
              current: preparedWorktree.branch,
            },
          });
          if (preparedWorktree.createdWorktreeRoot !== undefined) {
            await registerManagedWorktree(sessionsDir, {
              kind: "session",
              repository: preparedWorktree.repository,
              worktreePath: preparedWorktree.createdWorktreeRoot,
              branch: preparedWorktree.branch,
              ownsBranch: preparedWorktree.ownsBranch,
              sessionId: session.id,
            }).catch(() => undefined);
          }
        }
        const wrapped = await wrapSession(
          session,
          undefined,
          opts.interactive === false,
          undefined,
          opts.sessionMcp,
        );
        if (preparedWorktree?.createdWorktreeRoot !== undefined) {
          await maybePruneManagedWorktrees();
        }
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
      // 携带 validate 的恢复要求独占并校验目标：从进入 Core 起只走取锁、校验、
      // 包装的路径，不查询/打开/借用共享成员（ADR-0127 第二阶段收尾）——共享成员
      // 快路径返回的是托管 proxy，会跳过 validate；且 openOrGetMemberBySessionId
      // 本身可能打开尚未在用的成员会话。是否为合格顶层会话正是 validate 的职责，
      // 不能由快路径截胡。无 validate 的调用方（桌面等）保持共享行为不变。
      if (resumeOpts?.validate === undefined) {
        for (const hooks of openSessions.values()) {
          const sharedMember = await hooks.ensembleMember?.(id);
          if (sharedMember !== undefined) return sharedMember;
          const sharedThread = await hooks.suiteThread?.(id);
          if (sharedThread !== undefined) return sharedThread;
        }
      }
      const session = await store.load(id, { force: resumeOpts?.force });
      try {
        // 资格校验（ADR-0127 第二阶段）：锁已持有、状态已读取，但尚未装配宿主 MCP、
        // 绑定工具或投递历史。校验抛错走下方 catch 关闭会话释放锁，不绑定任何宿主工具。
        if (resumeOpts?.validate !== undefined) {
          await resumeOpts.validate(session.state());
        }
        return await wrapSession(
          session,
          { modelOverride: resumeOpts?.model },
          false,
          undefined,
          resumeOpts?.sessionMcp,
        );
      } catch (e) {
        await session.close().catch(() => undefined);
        throw e;
      }
    },
    async archiveSession(id) {
      const open = openSessions.get(id);
      try {
        if (open !== undefined) await open.archive(new Date().toISOString());
        else await store.archiveClosed(id);
      } catch (error) {
        if (error instanceof SessionError) {
          if (error.code === "session_locked")
            throw new RuntimeCommandError("session_busy", "会话被另一个进程占用");
          if (error.code === "invalid_command")
            throw new RuntimeCommandError("invalid_command", error.message);
        }
        throw error;
      }
      notifySessionsChanged();
    },
    async unarchiveSession(id) {
      const open = openSessions.get(id);
      try {
        if (open !== undefined) await open.unarchive();
        else await store.unarchiveClosed(id);
      } catch (error) {
        if (error instanceof SessionError && error.code === "invalid_command") {
          throw new RuntimeCommandError("invalid_command", error.message);
        }
        throw error;
      }
      notifySessionsChanged();
    },
    onSessionsChanged(listener) {
      sessionsChangedListeners.add(listener);
      return () => {
        sessionsChangedListeners.delete(listener);
      };
    },
    listSessions: (filter) => store.list(filter),
    searchSessions: (query, options) =>
      searchSessions(platform, store, sessionsDir, query, options),
    listPages: (input) => pageLibrary.listPages(input),
    listPageProjects: (input) => pageLibrary.listProjects(input),
    cancelSubagent(input) {
      if (!backgroundSubagents.cancel(input.parentSessionId, input.childSessionId))
        return Promise.reject(new RuntimeCommandError("invalid_command", "没有运行中的后台子代理"));
      return Promise.resolve();
    },
    async readSubagentDiff(input) {
      const record = (await listWorktreeRecords(sessionsDir, input.parentSessionId)).find(
        (record) => record.childSessionId === input.childSessionId,
      );
      if (!record?.changes)
        throw new RuntimeCommandError("invalid_command", "没有保留的子代理改动");
      return readWorktreeDiff(record.repository, record.changes, input.file);
    },
    async listSubagentWorktrees(input) {
      const records = await listWorktreeRecords(sessionsDir, input.parentSessionId);
      if (records.length === 0) return records;
      const events =
        openSessions.get(input.parentSessionId)?.durableEvents() ??
        (await readLogReadonly(
          platform.fs,
          platform.paths.resolve(sessionsDir, `${input.parentSessionId}.jsonl`),
          input.parentSessionId,
        )
          .then((log) => log.events)
          .catch(() => []));
      const activeResidentIds = new Set(
        openSessions.get(input.parentSessionId)?.ensembleActiveIsolatedChildIds?.() ?? [],
      );
      for (const id of openSessions.get(input.parentSessionId)?.suiteActiveIsolatedChildIds?.() ??
        []) {
        activeResidentIds.add(id);
      }
      const replayed = replaySessionView(events);
      const ensembleView = replayed.ensemble;
      if (ensembleView?.status === "active") {
        for (const member of ensembleView.members) {
          if (member.status !== "removed" && member.isolated) {
            activeResidentIds.add(member.childSessionId);
          }
        }
      }
      if (replayed.suite !== undefined) {
        for (const thread of replayed.suite.threads) {
          if (thread.isolated) {
            activeResidentIds.add(thread.childSessionId);
          }
        }
      }
      const visible = records.filter((record) => !activeResidentIds.has(record.childSessionId));
      if (visible.length === 0) return visible;
      const appliedIds = new Set(
        effectiveEvents(events).flatMap((event) =>
          event.type === "tool.completed" &&
          event.payload.name === "apply_subagent_changes" &&
          event.payload.status === "ok" &&
          typeof (event.payload.output as { id?: unknown } | undefined)?.id === "string"
            ? [(event.payload.output as { id: string }).id]
            : [],
        ),
      );
      return visible.map((record) =>
        record.applied || appliedIds.has(record.childSessionId)
          ? { ...record, applied: true }
          : record,
      );
    },
    async deleteSubagentWorktree(input) {
      const record = (await listWorktreeRecords(sessionsDir, input.parentSessionId)).find(
        (record) => record.childSessionId === input.childSessionId,
      );
      if (!record) throw new RuntimeCommandError("invalid_command", "没有保留的工作树");
      const ensembleActive =
        openSessions
          .get(input.parentSessionId)
          ?.ensembleActiveIsolatedChildIds?.()
          .has(input.childSessionId) === true;
      const suiteActive =
        openSessions
          .get(input.parentSessionId)
          ?.suiteActiveIsolatedChildIds?.()
          .has(input.childSessionId) === true;
      if (subagentRegistry.find(input.childSessionId) || ensembleActive || suiteActive)
        throw new RuntimeCommandError("invalid_command", "子代理仍在运行");
      await removeWorktree(record, true);
      await unregisterManagedWorktree(sessionsDir, `subagent:${input.childSessionId}`).catch(
        () => undefined,
      );
    },
    async describeManagedWorktrees() {
      return describeManagedWorktrees(sessionsDir, managedWorktreeInspector);
    },
    async setManagedWorktreePinned(input) {
      const id = z.string().trim().min(1).parse(input.id);
      const pinned = z.boolean().parse(input.pinned);
      return setManagedWorktreePinned(sessionsDir, id, pinned);
    },
    async deleteManagedWorktrees(input) {
      const ids = z.array(z.string().trim().min(1)).parse(input.ids);
      const saveSnapshot =
        input.saveSnapshot === undefined ? undefined : z.boolean().parse(input.saveSnapshot);
      return deleteManagedWorktrees(sessionsDir, managedWorktreeInspector, {
        ids,
        reason: "manual",
        ...(saveSnapshot !== undefined ? { saveSnapshot } : {}),
      });
    },
    async pruneManagedWorktrees() {
      return pruneExcessManagedWorktrees(sessionsDir, managedWorktreeInspector);
    },
    async restoreWorktreeSnapshot(input) {
      const snapshotId = z.string().trim().min(1).parse(input.snapshotId);
      const targetPath =
        input.targetPath !== undefined
          ? z.string().trim().min(1).parse(input.targetPath)
          : undefined;
      const branch =
        input.branch !== undefined ? z.string().trim().min(1).parse(input.branch) : undefined;
      return restoreWorktreeRecoverySnapshot(sessionsDir, {
        snapshotId,
        ...(targetPath !== undefined ? { targetPath } : {}),
        ...(branch !== undefined ? { branch } : {}),
      });
    },
    async startReview(input) {
      const open = input.sessionId !== undefined ? openSessions.get(input.sessionId) : undefined;
      const effectiveCwd =
        input.cwd !== undefined
          ? paths.resolve(input.cwd, ".")
          : open !== undefined
            ? open.currentCwd()
            : cwd;
      const effectiveRoot = await platform.resolveReal(
        open !== undefined ? open.skillModel.workspaceRoot : effectiveCwd,
      );
      const resolvedSettings =
        config !== undefined ? (await config.forWorkspace(effectiveRoot)).resolved : undefined;
      const gitPrefs = resolvedSettings?.git ?? DEFAULT_GIT_CONFIG;
      const presentation = input.presentation ?? gitPrefs.reviewView;
      const prompt = buildReviewPrompt(input.prompt, { reviewView: presentation });

      if (presentation === "inline" && input.sessionId !== undefined) {
        return {
          presentation: "inline",
          sessionId: input.sessionId,
          createdSession: false,
          prompt,
        };
      }

      const explicitModel = input.model?.trim();
      const defaultRef =
        explicitModel && explicitModel !== ""
          ? parseModelRef(explicitModel)
          : open !== undefined
            ? open.currentModel()
            : runtime.defaultModel({ workspaceRoot: effectiveRoot });
      const modelRef: ModelRef =
        defaultRef ??
        registry.providers()[0]?.models()[0]?.ref ??
        (() => {
          throw new RuntimeCommandError("invalid_command", "没有可用模型，无法发起独立审查会话");
        })();
      const preset = normalizePermissionPreset(
        resolvedSettings?.permissionPreset ?? DEFAULT_PERMISSION_PRESET,
      );
      const initialEffort = resolvedSettings?.reasoningEffort;
      const created = await store.create({
        cwd: effectiveCwd,
        workspaceRoot: effectiveRoot,
        model: modelRef,
        permissionPreset: isPermissionPresetName(preset) ? preset : DEFAULT_PERMISSION_PRESET,
        nocturneVersion: options.version ?? NOCTURNE_VERSION,
        ...(initialEffort !== undefined && isReasoningEffort(initialEffort)
          ? { reasoningEffort: initialEffort }
          : {}),
      });
      try {
        await created.emit("session.titled", { title: "代码审查", source: "user" });
      } finally {
        await created.close();
      }
      notifySessionsChanged();
      return {
        presentation: "separate",
        sessionId: created.id,
        createdSession: true,
        prompt,
      };
    },
    listSubagents: (input) => subagentObservation.list(input),
    observeSubagent: (input, observer) => subagentObservation.observe(input, observer),
    readSubagentAttachment: (input) => subagentObservation.readAttachment(input),
    async observeSession(input, observer) {
      assertSafeSessionId(input.sessionId);
      const isAborted = (): boolean => input.signal?.aborted === true;
      const abortError = (): Error => {
        const reason: unknown = input.signal?.reason;
        return reason instanceof Error ? reason : new Error("会话观察已取消");
      };
      if (isAborted()) throw abortError();
      const open = openSessions.get(input.sessionId);
      let events: readonly DurableEvent[];
      let tailIgnored = false;
      if (open !== undefined) {
        events = [...open.durableEvents()];
      } else {
        const snapshot = await readLogReadonly(
          fs,
          paths.resolve(sessionsDir, `${input.sessionId}.jsonl`),
          input.sessionId,
        );
        events = snapshot.events;
        tailIgnored = snapshot.tailIgnored;
      }
      if (isAborted()) throw abortError();
      const first = events[0];
      if (first?.type !== "session.created") {
        throw new SessionError("session_log_corrupt", "日志第一行不是 session.created");
      }
      if (first.payload.parent !== undefined) {
        throw new RuntimeCommandError("invalid_command", "子会话请通过父会话观察");
      }
      const highWater = events.at(-1)?.seq ?? 0;
      const start = input.afterSeq ?? 0;
      if (!Number.isSafeInteger(start) || start < 0 || start > highWater) {
        throw new SessionError(
          "invalid_after_seq",
          `afterSeq ${String(start)} 超出范围（0..${String(highWater)}）`,
        );
      }
      const replay = start === 0 ? events : events.filter((event) => event.seq > start);
      const OBSERVE_REPLAY_CHUNK = 256;
      for (let i = 0; i < replay.length; i += OBSERVE_REPLAY_CHUNK) {
        if (isAborted()) throw abortError();
        for (const event of replay.slice(i, i + OBSERVE_REPLAY_CHUNK)) {
          if (isAborted()) throw abortError();
          try {
            observer.onEvent(event);
          } catch {
            // 观察者异常不影响服务端
          }
        }
        if (i + OBSERVE_REPLAY_CHUNK < replay.length) {
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
        }
      }
      if (isAborted()) throw abortError();
      return {
        sessionId: input.sessionId,
        lastSeq: highWater,
        cwd: first.payload.cwd,
        workspaceRoot: first.payload.workspaceRoot,
        openHere: open !== undefined,
        tailIgnored,
      };
    },
    async readSessionAttachment(input) {
      assertSafeSessionId(input.sessionId);
      const open = openSessions.get(input.sessionId);
      const events =
        open !== undefined
          ? open.durableEvents()
          : (
              await readLogReadonly(
                fs,
                paths.resolve(sessionsDir, `${input.sessionId}.jsonl`),
                input.sessionId,
              )
            ).events;
      const first = events[0];
      if (first?.type !== "session.created") {
        throw new SessionError("session_log_corrupt", "日志第一行不是 session.created");
      }
      if (first.payload.parent !== undefined) {
        throw new RuntimeCommandError("invalid_command", "子会话请通过父会话观察");
      }
      return readSessionAttachment(platform, sessionsDir, input.sessionId, events, input.file);
    },
    usageStats,
    async forkSession(id, forkOptions) {
      const open = openSessions.get(id);
      if (open !== undefined) return open.fork(forkOptions?.targetSeq);
      const source = await store.load(id);
      try {
        if (source.state().meta.suite?.role === "coordinator") {
          throw new RuntimeCommandError("invalid_command", "组曲指挥会话不支持分叉");
        }
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
    async renameSession(id, title) {
      const cleaned = cleanTitle(title);
      const open = openSessions.get(id);
      if (open !== undefined) await open.rename(cleaned);
      else await store.renameClosed(id, cleaned);
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
export type { PendingInputPatch } from "./pending-inputs.js";
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
export type {
  SessionSearchOptions,
  SessionSearchRange,
  SessionSearchResult,
  SessionState,
  SessionSummary,
} from "./session/index.js";
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
  type ProviderPresetGroup,
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
export {
  IMAGE_MAX_BYTES,
  IMAGE_MAX_PIXELS,
  parseImageSize,
  sniffImageMime,
} from "./tools/image.js";
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
  McpAppResourceResult,
  McpAppToolCallResult,
  McpAppToolMeta,
  McpConnector,
  McpOpenScope,
  McpServerConfig,
  McpServerStatus,
  McpSession,
  McpToolDiff,
  PluginMcpCacheKey,
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
  checkLocalPluginDirectory,
  type LocalPluginCheckOptions,
  type LocalPluginCheckResult,
} from "./plugins/check.js";
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
