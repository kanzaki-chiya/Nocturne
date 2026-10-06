/**
 * @nocturne/core 公开入口（modules.md 第 3 节"core/index（公开 API）"）。
 * 客户端看到的全部能力都经由这里；进程内与将来的 RPC 客户端共用同一份语义（ADR-0002）。
 */
import { createHash } from "node:crypto";
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
  JevEndpoint,
  JevReviewerConfig,
  ModelRole,
} from "./config/index.js";
import { MODEL_ROLES } from "./config/index.js";
import {
  type SkillsDescription,
  type SkillInvocation,
  type SkillSnapshot,
} from "./protocol/index.js";
import { discoverSkills, renderSkill, skillCatalog } from "./skills/index.js";
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
import { createCheckpointRecorder } from "./session/checkpoints.js";
import { rewindTargets, restoreCheckpointFiles } from "./session/rewind.js";
import {
  createRulePolicy,
  createModelSecurityReviewer,
  createJevSecurityReviewer,
  type SecurityReviewer,
  isPermissionPresetName,
  type PermissionPolicy,
} from "./permission/index.js";
import {
  createPlatform,
  createShellResolver,
  detectShells,
  fsErrorCode,
  isShellKind,
  parseShellSpec,
  specFromConfigFields,
  type DetectedShell,
  type Platform,
  type ShellSpec,
} from "./platform/index.js";
import {
  clampReasoningEffort,
  createEntryProvider,
  externalAuthPath,
  createProviderRegistry,
  nocturneUserAgent,
  UnknownModelError,
  type AuthResolver,
  type CredentialResolver,
  type ModelInfo,
  type ModelOverride,
  type Provider,
  type ProviderConfig,
  type ProviderRegistry,
  type ResolvedModel,
} from "./provider/index.js";
import { resolveProviderAuth } from "./provider-oauth.js";
import type {
  CommandRejectCode,
  ContentBlock,
  Diagnostics,
  Grant,
  HookEntry,
  HookPoint,
  DurableEvent,
  ImageAttachment,
  ImageMimeType,
  ModelRef,
  PermissionReply,
  QuestionReply,
  ReasoningEffort,
  ReasoningEffortLevel,
  RuntimeEvent,
  RewindTarget,
  RewindMode,
  SessionRewoundPayload,
  TurnEndReason,
} from "./protocol/index.js";
import { IMAGE_MAX_BYTES, IMAGE_MAX_EDGE, parseImageSize, sniffImageMime } from "./tools/image.js";
import { normalizePermissionPreset } from "./protocol/index.js";
import { resolveFileRefs } from "./tools/file-refs.js";
import { buildFileIndex, type FileIndexEntry } from "./tools/file-index.js";
import { isReasoningEffort, REASONING_EFFORT_ORDER } from "./protocol/index.js";
import { validateSettingsPatch } from "./config/settings.js";
import {
  createSessionStore,
  SessionError,
  type Session,
  type SessionRecovery,
  type SessionState,
  type SessionStore,
  type SessionSummary,
} from "./session/index.js";
import {
  builtinTools,
  createAttachmentStore,
  createPolicyGate,
  createQuestionBroker,
  createReadStateStore,
  createTaskTool,
  createSkillTool,
  createToolExecutor,
  createToolRegistry,
  type ExecutionEnvironment,
  type HookRunner,
  type McpConnector,
  type McpServerConfig,
  type McpServerStatus,
  type McpSession,
  type PermissionGate,
  type ToolRegistry,
} from "./tools/index.js";
import { NOCTURNE_VERSION } from "./protocol/version.js";

/** 命令被拒绝时抛出的错误；code 即 events.md 第 7 节的拒绝原因码 */
export class RuntimeCommandError extends Error {
  readonly code: CommandRejectCode;
  constructor(code: CommandRejectCode, message: string) {
    super(message);
    this.name = "RuntimeCommandError";
    this.code = code;
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
  permissionPreset?: string | undefined;
  /**
   * 会话初始思考档位（ADR-0018）；缺省取配置的默认档位
   * （reasoningEffort 顶层字段），再缺省视为 off
   */
  reasoningEffort?: ReasoningEffort | undefined;
}

export interface SubmitInput {
  text?: string | undefined;
  content?: ContentBlock[] | undefined;
  /** 图片字节由 Core 落盘，事件只保存引用 */
  attachments?:
    { data: Uint8Array; mimeType: ImageMimeType; label?: string | undefined }[] | undefined;
  /** 技能调用（skills.md 第 2 节）：Core 校验后把正文快照附到用户消息 */
  skill?: SkillInvocation | undefined;
}

/** 本会话已登记并通过磁盘完整性校验的图片附件。 */
export interface ReadAttachmentResult {
  data: Uint8Array;
  mimeType: ImageMimeType;
  bytes: number;
}

export interface RuntimeSession {
  describeSkills(): SkillsDescription;
  rewindTargets(): Promise<RewindTarget[]>;
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
   * 切换权限预设（events.md 第 7 节）：会话空闲时生效，写入
   * session.config_changed；未知预设名拒绝 invalid_command。
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
  describeSkills(input?: { workspaceRoot?: string | undefined }): Promise<SkillsDescription>;
  setSkillEnabled(input: { name: string; enabled: boolean }): Promise<{ affectedSessions: number }>;
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
  describeModelRoles(): ModelRoleInfo[];
  setModelRole(role: ModelRole, ref: string | null): Promise<SettingItem[]>;
  describeSettings(): SettingItem[];
  updateSettings(patch: SettingsPatch, options?: { reviewerKey: string }): Promise<SettingItem[]>;
  listReviewerProviders(): Promise<ProviderOverview[]>;
  defaultReviewer(endpoint: JevEndpoint, baseURL?: string): Promise<JevReviewerConfig>;
  listReviewerModels(
    reviewer: JevReviewerConfig,
    signal?: AbortSignal,
  ): Promise<{ models: string[]; warning?: string }>;
  setDefaultModel(model: string, reasoningEffort: ReasoningEffort | null): Promise<SettingItem[]>;
  createSession(options: CreateSessionOptions): Promise<RuntimeSession>;
  resumeSession(id: string, options?: ResumeSessionOptions): Promise<RuntimeSession>;
  forkSession(id: string, options?: { targetSeq?: number }): Promise<string>;
  listSessions(filter?: {
    cwd?: string | undefined;
    /** 默认 false：子会话（session.created.parent 存在）不进列表 */
    includeSubagents?: boolean | undefined;
  }): Promise<SessionSummary[]>;
  /** 当前工作区已配置 Provider 声明的模型清单（含已加载的可信项目层） */
  listModels(): ModelInfo[];
  /**
   * 用新的基础层配置重建运行时级 Provider 注册表（provider-setup.md
   * 第 6 节）；已打开会话在下一次空闲边界重建会话级注册表。不产生
   * 持久事件，不触发 SessionEnd/SessionStart Hook；MCP 按配置增量更新。
   */
  updateProviders(config: RuntimeConfig): Promise<void>;
  /** 分层合并后的默认模型（模型选择页"默认模型"标记）；无法解析时 undefined */
  defaultModel(): ModelRef | undefined;
  /** recent-models.json 当前内容（新→旧，最多 10 条）；无 config 时为空 */
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
    timeoutMs: options.subagent?.timeoutMs ?? 600_000,
  };
  const subagentLimiter = createSubagentLimiter(subagentLimits.maxConcurrent);

  const store: SessionStore = createSessionStore({ platform, sessionsDir });

  /**
   * 已打开会话的"providers 待重建"标记回调（updateProviders →
   * 各会话在下一次空闲边界 rebuildProviders；close 时移除）
   */
  const markProvidersDirty = new Set<() => void>();
  const reconcileMcp = new Set<() => Promise<void>>();
  const refreshSkills = new Set<(rescan: boolean) => Promise<void>>();
  const sessionSkillModels = new Map<
    string,
    { workspaceRoot: string; contextWindow: () => number | undefined }
  >();
  const openForkers = new Map<string, (targetSeq?: number) => Promise<string>>();
  let settingsPending = Promise.resolve();

  const interactive = options.interactive === true;

  const instructions =
    options.instructions ?? (await loadInstructions(platform, workspaceRoot, cwd));
  const detectedShells = await detectShells(platform);

  async function wrapSession(
    session: Session,
    resume?: { modelOverride?: string | ModelRef | undefined },
  ): Promise<RuntimeSession> {
    const meta = session.state().meta;
    const openedAt = Date.now();

    // 项目层按会话记录的 workspaceRoot 加载（config.md 第 6 节）
    const ws = config !== undefined ? await config.forWorkspace(meta.workspaceRoot) : undefined;
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
    let skillDiscovery = await discoverSkills(platform, {
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
      cwd,
      workspaceRoot,
      // 取会话创建时间而非打开时间：恢复时不改写 system，保住其后整段历史的缓存
      sessionDate: meta.createdAt,
    };

    // 会话级 ProviderRegistry：基础层 + 可信项目层的 Provider 条目。
    // updateProviders 后在下一次空闲边界经 rebuildProviders 重建。
    let sessionRegistry =
      config === undefined ? registry : buildRegistry(resolved?.providers ?? []);

    // 权限策略：预设 + 分层规则 + Grant 集合；setPermissionPreset 重建
    const sessionGrants: Grant[] = [];
    const projectGrants = ws?.grants.list() ?? [];
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
        grants: { session: sessionGrants, project: projectGrants },
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
          modelReviewer = {
            backend: "model",
            model: ref,
            review: (input, signal) =>
              createModelSecurityReviewer(sessionRegistry.resolve(ref), session.id).review(
                input,
                signal,
              ),
          };
        }
      }
      return modelReviewer;
    };
    const recentUserMessages = () =>
      session
        .state()
        .history.flatMap((entry) => {
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
        })
        .slice(-3);
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
        interactive,
        preset: () => session.state().config.permissionPreset,
        reviewer: () => {
          warnMissingReviewer();
          return getReviewer();
        },
        cwd: meta.cwd,
        recentUserMessages,
        caseSensitive: platform.caseSensitivePaths,
        grants: { session: sessionGrants, project: ws?.grants },
        hooks: hookRunner,
      },
    );
    // 提问通道（ADR-0032）按会话持有：等待中的请求与会话绑定，
    // respondQuestion 按 requestId 路由；非交互时 ask 立即不可用
    const questions = createQuestionBroker({ interactive });
    // 会话级工具注册表：内置工具 ∪ MCP 工具（mcp.md 第 4、5 节）。
    // MCP 服务器在会话打开时并行启动；list_changed / 重连带来的工具集变化
    // 先暂存，在 submit() 的 Turn 边界经 applyPendingTools() 应用。
    const tools: ToolRegistry = createToolRegistry();
    for (const tool of builtinTools()) tools.register(tool);
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
        skillDiscovery = await discoverSkills(platform, {
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
    refreshSkills.add(refreshSessionSkills);
    sessionSkillModels.set(session.id, {
      workspaceRoot: meta.workspaceRoot,
      contextWindow: () => model.model.contextWindow,
    });
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
          for (const tool of mcpSession.tools()) {
            try {
              tools.register(tool);
            } catch (e) {
              session.emitEphemeral("runtime.warning", {
                code: "mcp_tool_conflict",
                message: `MCP 工具 ${tool.name} 注册失败：${e instanceof Error ? e.message : String(e)}`,
              });
            }
          }
          for (const s of mcpSession.status()) {
            if (s.state === "failed") {
              warnings.push(`MCP 服务器 ${s.name} 启动失败：${s.error ?? "未知错误"}`);
            }
          }
        } catch (e) {
          warnings.push(`MCP 装配失败：${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }

    let pendingMcp = false;
    let mcpUpdate: Promise<void> = Promise.resolve();
    const applyMcp = (): Promise<void> => {
      mcpUpdate = mcpUpdate
        .catch(() => undefined)
        .then(async () => {
          if (!pendingMcp || mcpSession === undefined) return;
          pendingMcp = false;
          const next = config
            ? (await config.forWorkspace(meta.workspaceRoot)).resolved.mcpServers
            : [];
          await mcpSession.reconcile([
            ...(options.mcpServers ?? []),
            ...next.map((s) => ({ ...s.entry, name: s.name, origin: s.origin, dir: s.dir })),
          ]);
          const diff = mcpSession.applyPendingTools();
          for (const name of diff.remove) tools.unregister(name);
          for (const tool of diff.add) {
            try {
              tools.register(tool);
            } catch {
              session.emitEphemeral("runtime.warning", {
                code: "mcp_tool_conflict",
                message: `MCP 工具 ${tool.name} 注册失败`,
              });
            }
          }
        });
      return mcpUpdate;
    };
    const refreshMcp = async (): Promise<void> => {
      pendingMcp = true;
      if (!busy()) await applyMcp();
    };
    reconcileMcp.add(refreshMcp);

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
    };
    const turnConfig: TurnConfig = { ...DEFAULT_TURN_CONFIG };
    for (const src of [resolved?.turn, options.turn]) {
      if (src?.maxSteps !== undefined) turnConfig.maxSteps = src.maxSteps;
      if (src?.retryLimit !== undefined) turnConfig.retryLimit = src.retryLimit;
      if (src?.retryBaseDelayMs !== undefined) turnConfig.retryBaseDelayMs = src.retryBaseDelayMs;
      if (src?.firstEventTimeoutMs !== undefined)
        turnConfig.firstEventTimeoutMs = src.firstEventTimeoutMs;
      if (src?.idleTimeoutMs !== undefined) turnConfig.idleTimeoutMs = src.idleTimeoutMs;
    }

    const resolveSessionModel = (ref: ModelRef): ResolvedModel => sessionRegistry.resolve(ref);
    for (const role of MODEL_ROLES) {
      const ref = resolved?.modelRoles?.[role];
      if (ref !== undefined && resolveModelRole(sessionRegistry, ref, role) === undefined) {
        const message = `模型角色 ${role} 的模型 ${ref} 不可用，按未配置处理`;
        warnings.push(message);
        session.emitEphemeral("runtime.warning", { code: "model_role_unavailable", message });
      }
    }
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
    /** 限额未声明（ADR-0016）：会话打开与 setModel 时提示默认值来源与补救方式 */
    const warnIfCapabilitiesDefaulted = (m: ModelInfo): void => {
      const missing: string[] = [];
      if (m.contextWindow === undefined) missing.push("上下文窗口");
      if (m.maxOutputTokens === undefined) missing.push("最大输出长度");
      if (missing.length === 0) return;
      session.emitEphemeral("runtime.warning", {
        code: "model_capabilities_defaulted",
        message:
          `模型 ${m.ref.provider}/${m.ref.model} 的${missing.join("与")}未由上游或配置声明，` +
          `本地预算按默认值估算（上下文 128000 / 输出预留 8192）；` +
          `可运行 /provider refresh ${m.ref.provider} 或在 config.json 的 models 中声明`,
      });
    };
    try {
      model = resolveSessionModel(session.state().config.model);
      // ADR-0026 §5：新建会话选到不可用模型即拒绝；恢复会话允许打开
      // （不可用由下一轮 submit 在发请求前以同一说明结束）
      if (resume === undefined && model.model.unavailable !== undefined) {
        throw new RuntimeCommandError("invalid_model", model.model.unavailable.reason);
      }
      warnIfCapabilitiesDefaulted(model.model);
      warnIfEffortClamped(model.model);
    } catch (e) {
      // 会话记录的模型无法解析：携带替代模型时先写 config_changed 再开放（sessions.md 4.2）
      if (e instanceof UnknownModelError && resume?.modelOverride !== undefined) {
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
        // 替代模型是显式选择：不可用同样拒绝（ADR-0026 §5）
        if (replacement.model.unavailable !== undefined) {
          throw new RuntimeCommandError("invalid_model", replacement.model.unavailable.reason);
        }
        await session.emit("session.config_changed", { model: ref });
        model = replacement;
        warnIfCapabilitiesDefaulted(replacement.model);
      } else if (e instanceof UnknownModelError) {
        throw new RuntimeCommandError(
          "invalid_model",
          resume !== undefined
            ? `${e.message}；可携带替代模型恢复（resumeSession 的 model 选项 / CLI --model）`
            : e.message,
        );
      } else {
        throw e;
      }
    }

    // 注册到 updateProviders 的广播集合；close 时移除
    const markDirty = (): void => {
      providersDirty = true;
    };
    markProvidersDirty.add(markDirty);
    installSkills();

    // 子代理（subagent.md 第 3 节）：launcher 捕获本会话装配上下文；
    // task 与内置工具同一注册表——Agent Loop 无工具名分支
    if (subagentEnabled) {
      const launcher = createSubagentLauncher({
        checkpoint: execEnv.checkpoint,
        store,
        sessionsDir,
        platform,
        diagnostics,
        instructions,
        environment,
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
        recentUserMessages,
        // 子会话继承父会话的思考档位（ADR-0018 §4；受子模型可用档位约束，
        // 就近降档在 launcher 内完成）
        reasoningEffort: () => session.state().config.reasoningEffort,
        compactionThreshold: () =>
          config?.resolvedSettings(session.state().meta.workspaceRoot).compactionThreshold,
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
      });
      tools.register(createTaskTool(launcher));
    }

    let controller: AbortController | undefined;
    let fileIndexPromise: Promise<FileIndexEntry[]> | undefined;
    let compactController: AbortController | undefined;
    let turnSettled: Promise<void> | undefined;
    let compactSettled: Promise<void> | undefined;
    let closing = false;
    let rewinding = false;
    let rewindSettled: Promise<void> | undefined;
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

    openForkers.set(session.id, async (targetSeq) => {
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
    });
    const runtimeSession: RuntimeSession = {
      describeSkills: () => ({
        skills: catalog.skills,
        budget: catalog.budget,
        warnings: skillDiscovery.warnings,
        scannedDirs: skillDiscovery.scannedDirs,
        homeDir: skillDiscovery.homeDir,
      }),
      id: session.id,
      durableEvents: () => session.durableEvents(),
      async readAttachment(file) {
        assertUsable();
        if (
          typeof file !== "string" ||
          file.length === 0 ||
          file.includes("..") ||
          /[<>:"/\\|?*\u0000-\u001f]/.test(file) ||
          /[. ]$/.test(file) ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(file)
        ) {
          throw new SessionError("invalid_attachment_file", "附件必须是单个安全文件名");
        }
        // 原始持久日志是授权来源，包含已被回退或压缩隐藏的图片；不沿 parent 回溯。
        let attachment: ImageAttachment | undefined;
        for (const event of session.durableEvents()) {
          if (event.type !== "message.user" && event.type !== "tool.completed") continue;
          attachment = event.payload.attachments?.find((ref) => ref.file === file);
          if (attachment !== undefined) break;
        }
        if (attachment === undefined) {
          throw new SessionError("attachment_not_found", "本会话未登记该图片附件");
        }
        const root = paths.join(sessionsDir, "attachments");
        const dir = paths.join(root, session.id);
        const target = paths.join(dir, file);
        try {
          // 拒绝文件链接、会话目录 junction 与附件根链接；realpath 再检查实际归属。
          if (
            (await fs.lstat(root)).type !== "directory" ||
            (await fs.lstat(dir)).type !== "directory"
          ) {
            throw new SessionError("invalid_attachment_file", "附件目录不能是链接");
          }
          const stat = await fs.lstat(target);
          if (stat.type !== "file") {
            throw new SessionError("invalid_attachment_file", "附件必须是普通文件");
          }
          const realRoot = await fs.realpath(root);
          const realDir = await fs.realpath(dir);
          const realTarget = await fs.realpath(target);
          if (
            !paths.equals(realDir, paths.join(realRoot, session.id)) ||
            !paths.equals(realTarget, paths.join(realDir, file))
          ) {
            throw new SessionError("invalid_attachment_file", "附件路径超出本会话目录");
          }
          if (stat.size !== attachment.bytes) {
            throw new SessionError("attachment_corrupt", "图片附件大小与记录不符");
          }
          // 不走 AttachmentStore.load 的 sha 缓存：落盘文件可能在上次读取后被改动。
          const data = await fs.readFile(realTarget);
          if (
            data.byteLength !== attachment.bytes ||
            createHash("sha256").update(data).digest("hex") !== attachment.sha256
          ) {
            throw new SessionError("attachment_corrupt", "图片附件内容与记录不符");
          }
          return { data, mimeType: attachment.mimeType, bytes: data.byteLength };
        } catch (error) {
          if (error instanceof SessionError) throw error;
          const code = fsErrorCode(error);
          if (code === "ENOENT" || code === "ENOTDIR") {
            throw new SessionError("attachment_missing", "图片附件文件缺失", { cause: error });
          }
          throw new SessionError("attachment_read_failed", "图片附件读取失败", { cause: error });
        }
      },
      rewindTargets() {
        assertUsable();
        if (busy() || compactController !== undefined)
          throw new RuntimeCommandError("session_busy", "请先等待或按 Esc 中断");
        return rewindTargets(session, platform, sessionsDir);
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
        // Turn 边界：应用暂存的 MCP 工具集变化（list_changed / 重连刷新）
        if (mcpSession !== undefined) {
          const diff = mcpSession.applyPendingTools();
          for (const name of diff.remove) tools.unregister(name);
          for (const tool of diff.add) {
            try {
              tools.register(tool);
            } catch (e) {
              session.emitEphemeral("runtime.warning", {
                code: "mcp_tool_conflict",
                message: `MCP 工具 ${tool.name} 注册失败：${e instanceof Error ? e.message : String(e)}`,
              });
            }
          }
        }
        const ac = new AbortController();
        controller = ac;
        let settleTurn!: () => void;
        turnSettled = new Promise<void>((resolve) => {
          settleTurn = resolve;
        });
        // 空闲边界：controller 先置位（busy 语义立即生效），再重建
        // updateProviders 标记的会话级注册表（provider-setup.md 第 6 节）
        try {
          await applyMcp();
          await rebuildProviders();
          await applySkills();
          // ADR-0026 §5：刷新后条目/模型可能变化——原位重解析拿到最新的
          // 协议与不可用标记（失败沿用旧解析，同一错误仍由 stream 路径报告）
          try {
            model = resolveSessionModel(session.state().config.model);
          } catch {
            // 保留旧解析
          }
          // 会话中的模型变为不可用时，本轮在发请求前以说明结束，不发 HTTP
          if (model.model.unavailable !== undefined) {
            throw new RuntimeCommandError("invalid_model", model.model.unavailable.reason);
          }
          const deps: TurnDeps = {
            skills: catalog,
            visionModel: () =>
              resolveModelRole(
                sessionRegistry,
                config?.resolvedSettings(session.state().meta.workspaceRoot).modelRoles?.vision,
                "vision",
              ),
            compactionThreshold: config?.resolvedSettings(session.state().meta.workspaceRoot)
              .compactionThreshold,
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
          const reason = await runTurn(
            deps,
            refs.content,
            [...attachments, ...refs.attachments],
            refs.fileRefs,
            skillSnapshot,
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
          await applyMcp().catch(() =>
            session.emitEphemeral("runtime.warning", {
              code: "mcp_server_failed",
              message: "MCP 热更新失败，请重新加载配置",
            }),
          );
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
          throw new RuntimeCommandError("invalid_model", resolved.model.unavailable.reason);
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
        if (busy() || compactController !== undefined) {
          throw new RuntimeCommandError("session_busy", "会话正忙，不能切换权限预设");
        }
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
        const vision = resolveModelRole(
          sessionRegistry,
          config?.resolvedSettings(session.state().meta.workspaceRoot).modelRoles?.vision,
          "vision",
        );
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
        // ADR-0022 第 4 节：Turn 进行中也可切换，下一次 shell 调用起生效
        const normalized = kind.trim().toLowerCase();
        if (normalized !== "auto" && !isShellKind(normalized)) {
          throw new RuntimeCommandError(
            "invalid_command",
            `未知 shell：${kind}（可选：auto | pwsh | powershell | bash | cmd | sh）`,
          );
        }
        // 先验证目标可执行（含 auto 能解出可用 shell），再动 settings/内存：
        // 不可用的选择不落盘、不发事件、不改变生效 shell
        const probe = shellResolver.probe(normalized);
        if (probe.descriptor === undefined) {
          throw new RuntimeCommandError(
            "invalid_command",
            probe.error ?? `所选 shell ${normalized} 不可用`,
          );
        }
        const before = shellResolver.current();
        if (config !== undefined) {
          // settings.json 原子写（ADR-0022 第 3 节）；写后 live getter 立即生效
          await config.setShellSetting(normalized);
          memoryShellSpec = undefined;
        } else {
          // 无配置层的嵌入用法：仅本会话内存生效
          memoryShellSpec = normalized === "auto" ? { kind: "auto" } : { kind: normalized };
        }
        const after = shellResolver.current();
        // 只在实际生效变化且未被 env/config 覆盖时记历史（ADR-0022 第 4 节）
        const d = after.descriptor;
        const switched =
          d !== undefined &&
          (d.kind !== before.descriptor?.kind || d.executable !== before.descriptor.executable);
        if (switched && after.overriddenBy === undefined) {
          await session.emit("session.config_changed", {
            shell: { kind: d.kind, path: d.executable },
          });
        }
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
          const summary = await runSummaryCall(
            model,
            request,
            ac.signal,
            turnConfig.firstEventTimeoutMs,
            turnConfig.idleTimeoutMs,
          );
          await session.emit(
            "context.compacted",
            { kind: "summary", throughSeq: plan.throughSeq, summary },
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
          session.emitEphemeral("runtime.status", { status: "idle" });
          compactSettled = undefined;
          settleCompact();
        }
      },
      warnings,
      recovery: session.recovery,
      describeContext() {
        const state = session.state();
        return buildContext({
          skills: catalog,
          compactionThreshold: config?.resolvedSettings(state.meta.workspaceRoot)
            .compactionThreshold,
          history: state.history,
          todos: state.todos,
          model: model.model,
          tools: tools.specs(model.model.capabilities.editTool),
          instructions,
          environment,
          events: session.durableEvents(),
        });
      },
      mcpServers() {
        return mcpSession?.status() ?? [];
      },
      async close() {
        refreshSkills.delete(refreshSessionSkills);
        sessionSkillModels.delete(session.id);
        closing = true;
        unsubscribeTitle();
        titleController.abort();
        controller?.abort();
        compactController?.abort();
        gate.cancelAll?.();
        questions.cancelAll();
        await Promise.all([turnSettled, compactSettled, titleSettled, rewindSettled]);
        markProvidersDirty.delete(markDirty);
        openForkers.delete(session.id);
        // SessionEnd Hook（hooks.md）：清理开始前运行；失败已在 runner 内降级
        if (hookRunner !== undefined) {
          await hookRunner.run("SessionEnd", { reason: "close" }).catch(() => undefined);
        }
        if (mcpSession !== undefined) {
          reconcileMcp.delete(refreshMcp);
          await mcpUpdate.catch(() => undefined);
          // MCP 服务器进程树清理（mcp.md 第 5 节）；失败只警告不阻塞关闭
          try {
            await mcpSession.close();
          } catch (e) {
            session.emitEphemeral("runtime.warning", {
              code: "mcp_close_failed",
              message: `MCP 关闭异常：${e instanceof Error ? e.message : String(e)}`,
            });
          }
        }
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
    for (const mark of markProvidersDirty) mark();
    await Promise.all([...reconcileMcp].map((refresh) => refresh()));
    await Promise.all([...refreshSkills].map((refresh) => refresh(true)));
  }
  function mcpInput<T>(schema: z.ZodType<T>, input: unknown): T {
    const parsed = schema.safeParse(input);
    if (!parsed.success)
      throw new McpSettingsError(String(parsed.error.issues[0]?.path[0] ?? "config"), "字段无效");
    return parsed.data;
  }
  const workspaceField = z.string().min(1).optional();
  const idFields = z.object({ id: z.string().min(1), workspaceRoot: workspaceField });
  return {
    describeMcpServers: (input = {}) =>
      requireMcpConfig().describeMcpServers(
        mcpInput(z.object({ workspaceRoot: workspaceField }), input),
      ),
    async describeSkills(input = {}) {
      const parsed = z.object({ workspaceRoot: z.string().min(1).optional() }).parse(input);
      const root = parsed.workspaceRoot
        ? await platform.resolveReal(parsed.workspaceRoot)
        : workspaceRoot;
      const current = [...sessionSkillModels.values()].find((s) =>
        paths.equals(s.workspaceRoot, root),
      );
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
      const discovery = await discoverSkills(platform, {
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
      await Promise.all([...refreshSkills].map((refresh) => refresh(false)));
      return { affectedSessions: refreshSkills.size };
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
    describeModelRoles() {
      const settings = config?.describeSettings(workspaceRoot) ?? [];
      const rolesRegistry = buildRegistry(config?.resolvedSettings(workspaceRoot).providers ?? []);
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
    async setModelRole(role, ref) {
      if (!MODEL_ROLES.includes(role))
        throw new RuntimeCommandError("invalid_command", `未知模型角色：${role}`);
      if (config === undefined) throw new Error("未注入 RuntimeConfig，无法保存模型角色");
      if (
        ref !== null &&
        resolveModelRole(
          buildRegistry(config.resolvedSettings(workspaceRoot).providers),
          ref,
          role,
        ) === undefined
      )
        throw new RuntimeCommandError("invalid_model", `模型角色 ${role} 的模型 ${ref} 不可用`);
      await config.setModelRole(role, ref);
      return config.describeSettings(workspaceRoot);
    },
    describeSettings: () =>
      config?.describeSettings(workspaceRoot, platform.env("NOCTURNE_SHELL")) ?? [],
    listReviewerProviders: async () => (await config?.describeProviders(workspaceRoot)) ?? [],
    async defaultReviewer(endpoint, baseURL) {
      return defaultJevReviewer(
        endpoint,
        (await config?.describeProviders(workspaceRoot)) ?? [],
        baseURL,
      );
    },
    async listReviewerModels(reviewer, signal) {
      validateSettingsPatch({ "permission.reviewer": reviewer });
      const providers = config
        ? (await config.forWorkspace(workspaceRoot)).resolved.providers
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
    updateSettings(patch, settingsOptions) {
      const operation = settingsPending.then(async () => {
        if (config === undefined) throw new Error("未注入 RuntimeConfig，无法保存设置");
        validateSettingsPatch(patch);
        await config.forWorkspace(workspaceRoot);
        const roleRegistry = buildRegistry(config.resolvedSettings(workspaceRoot).providers);
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
        for (const mark of markProvidersDirty) mark();
        return config.describeSettings(workspaceRoot);
      });
      settingsPending = operation.then(
        () => undefined,
        () => undefined,
      );
      return operation;
    },
    async setDefaultModel(model, effort) {
      if (config === undefined) throw new Error("未注入 RuntimeConfig，无法保存默认模型");
      const resolved = buildRegistry(
        (await config.forWorkspace(workspaceRoot)).resolved.providers,
      ).resolve(parseModelRef(model));
      const levels = resolved.model.capabilities.reasoningEffort ?? [];
      if (effort !== null && effort !== "off" && !levels.includes(effort)) {
        throw new RuntimeCommandError(
          "invalid_command",
          `模型不支持档位 ${effort}（可选：${["off", ...levels].join(" | ")}）`,
        );
      }
      await config.setDefaultModel(model, effort);
      return config.describeSettings(workspaceRoot);
    },
    async createSession(opts) {
      const defaults =
        config !== undefined ? (await config.forWorkspace(workspaceRoot)).resolved : undefined;
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
        cwd,
        workspaceRoot,
        model: parseModelRef(opts.model),
        permissionPreset: preset,
        nocturneVersion: options.version ?? NOCTURNE_VERSION,
        ...(initialEffort !== undefined ? { reasoningEffort: initialEffort } : {}),
      });
      try {
        const wrapped = await wrapSession(session);
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
    async forkSession(id, forkOptions) {
      const open = openForkers.get(id);
      if (open !== undefined) return open(forkOptions?.targetSeq);
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
    listModels: () =>
      (config !== undefined
        ? buildRegistry(config.resolvedSettings(workspaceRoot).providers)
        : registry
      )
        .providers()
        .flatMap((p) => p.models()),
    async updateProviders(newConfig) {
      // 重建服务商注册表并按会话工作区增量更新 MCP；不动会话日志和 Hook。
      config = newConfig;
      registry = buildRegistry(newConfig.base.providers);
      for (const mark of markProvidersDirty) mark();
      await Promise.all([...reconcileMcp].map((refresh) => refresh()));
      await Promise.all([...refreshSkills].map((refresh) => refresh(true)));
    },
    defaultModel() {
      const model = config?.resolvedSettings(workspaceRoot).model;
      if (model === undefined || model === "") return undefined;
      try {
        return parseModelRef(model);
      } catch {
        return undefined;
      }
    },
    listRecentModels: () => config?.recentModels() ?? [],
    getPreference: (key) => config?.getPreference(key),
    setPreference: (key, value) =>
      config !== undefined
        ? config.setPreference(key, value)
        : Promise.reject(new Error("未注入 RuntimeConfig，无法保存偏好")),
  };
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
  type PipeProcess,
  type PipeSpawnOptions,
  type Platform,
  type ShellKind,
} from "./platform/index.js";
export { IMAGE_MAX_BYTES, IMAGE_MAX_EDGE, parseImageSize, sniffImageMime } from "./tools/image.js";
export { completeFileRefs, type FileCompletion, type FileIndexEntry } from "./tools/file-index.js";
// MCP / Hook 装配点类型（modules.md：注入方是 apps；实现位于 packages/mcp）
export type {
  HookCallInput,
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
  ReviewInput,
  ReviewResult,
  ReviewSubject,
} from "./permission/index.js";

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
  type PrepareProviderResult,
  type PreparedModelSummary,
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
