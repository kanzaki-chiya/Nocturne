import type { SkillImportInput, SkillImportOutput, SkillsDescription } from "@nocturne/core";
/**
 * RPC 客户端（ADR-0044）：类型化封装。运行时只依赖 `@nocturne/core/protocol`，
 * 对 `@nocturne/core` 只有类型导入（由 dependency-cruiser 规则强制），桌面端前端
 * 打包不会带进 Node 代码。
 */
import {
  createSessionView,
  reduceSessionView,
  type SessionView,
  type RuntimeEvent,
  type SubagentObservation,
  type SubagentObserver,
  type SubagentSummary,
  type UsageStats,
} from "@nocturne/core/protocol";
import type {
  ExternalAgentOverview,
  ExternalAgentProbeInput,
  ExternalAgentProbeResult,
  ExternalAgentSaveInput,
  ExternalAgentsDescription,
  McpProbeInput,
  McpProbeResult,
  McpSaveInput,
  McpServerOverview,
  AccountStorageSetup,
  AddProviderResult,
  CreateSessionOptions,
  FileIndexEntry,
  FileRefResolution,
  JevEndpoint,
  JevReviewerConfig,
  ReviewerSampleInfo,
  ReviewerSampleResult,
  ModelInfo,
  ModelRef,
  ModelRole,
  ModelRoleInfo,
  ModelSettingsPatch,
  ModelSettingsView,
  PermissionReply,
  PrepareProviderResult,
  ProviderEntryConfig,
  ProviderOverview,
  ProviderPreset,
  ProviderSetupDescription,
  UpdateSetupProviderPatch,
  UpdateSetupProviderResult,
  UpstreamModelEntry,
  QuestionReply,
  ReasoningEffort,
  RewindMode,
  RewindTarget,
  SessionRewoundPayload,
  ReadAttachmentResult,
  SessionSummary,
  LocalFileContent,
  SettingItem,
  SettingsPatch,
  SubmitInput,
  ToggleImpact,
  TurnEndReason,
} from "@nocturne/core";

import {
  encodeMessage,
  isRpcId,
  parseLine,
  RPC_CODE_NAMES,
  RPC_PROTOCOL_VERSION,
  type RpcErrorObject,
  type RpcId,
} from "../shared/jsonrpc.js";
import type {
  ContextSummary,
  InitializeResult,
  LoginCompleted,
  LoginStarted,
  PrepareProviderParams,
  ProvidersDescribed,
  RpcMethodName,
  RpcParams,
  RpcResult,
  RpcServerNotifications,
  SessionOpened,
  SessionStateSummary,
} from "../shared/methods.js";
import type { LineTransport } from "../shared/transport.js";

/**
 * 调用失败。`code` 是进程内错误的字符串码（`session_busy`、`unknown_request` 等，
 * 来自响应的 `data.code`），客户端按它分支，与进程内按 `error.code` 分支等价；
 * `message` 是原文案；`rpcCode` 是 JSON-RPC 数字码。
 */
export class RpcError extends Error {
  readonly code: string;
  readonly rpcCode: number;
  /** 原始错误类名（RuntimeCommandError、SessionError……） */
  readonly errorName: string | undefined;
  /** ProviderSetupError 的表单字段名（-32005，data.field）；客户端据此标输入框 */
  readonly field: string | undefined;
  /** ADR-0054：invalid_model 的停用来源（data.disabled），供「重新启用」入口判断 */
  readonly disabled: "provider" | "model" | undefined;
  /** ADR-0054：不可用的模型引用（data.model） */
  readonly model: ModelRef | undefined;
  /**
   * ADR-0054 §3 双重停用（data.providerDisabled）：disabled === "model" 且其服务商
   * 也被停用时为 true；一键重新启用需同时恢复服务商与模型
   */
  readonly providerDisabled: boolean | undefined;

  constructor(
    code: string,
    message: string,
    rpcCode = 0,
    errorName?: string,
    field?: string,
    disabled?: "provider" | "model",
    model?: ModelRef,
    providerDisabled?: boolean,
  ) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.rpcCode = rpcCode;
    this.errorName = errorName;
    this.field = field;
    this.disabled = disabled;
    this.model = model;
    this.providerDisabled = providerDisabled;
  }

  static fromObject(error: RpcErrorObject): RpcError {
    return new RpcError(
      error.data?.code ?? RPC_CODE_NAMES[error.code] ?? "server_error",
      error.message,
      error.code,
      error.data?.name,
      error.data?.field,
      error.data?.disabled,
      error.data?.model,
      error.data?.providerDisabled,
    );
  }
}

export interface RpcClientOptions {
  clientName: string;
  /** 能否回复权限与提问请求，默认 true；false 时服务端按非交互规则处理 */
  interactive?: boolean;
}

export type EventListener = (event: RuntimeEvent) => void;

export interface SubscribeOptions {
  /** 只要 seq 大于它的持久事件的回放；默认 0（全部） */
  afterSeq?: number;
}

export interface Subscription {
  /** 回放与实时衔接完成时已推送的最后一个持久事件的 seq */
  lastSeq: number;
  /** 停止交付并通知服务端停推（已被后来的订阅替换时无操作） */
  unsubscribe(): Promise<void>;
}

/** 与进程内 `RuntimeSession` 同名的方法，全部异步化；`sessionId` 已绑定 */
export interface RpcSession {
  describeSkills(): Promise<SkillsDescription>;
  describeExternalAgents(): Promise<ExternalAgentsDescription>;
  readonly id: string;
  /**
   * 订阅：先回放 afterSeq 之后的持久事件，再接实时事件（持久与临时都推）。
   * 同一会话同一时刻只有一路订阅，再次调用替换之前的监听器；需要多个消费者时用 `RpcClient.onEvent` 分发。
   */
  subscribe(listener: EventListener, options?: SubscribeOptions): Promise<Subscription>;
  readAttachment(file: string): Promise<ReadAttachmentResult>;
  /** 挂到 Turn 结束，结果与进程内 `submit()` 的 resolve 时机相同 */
  submit(input: SubmitInput): Promise<TurnEndReason>;
  /** 中断运行中的 Turn（通知，无应答）；submit 随后以 aborted 返回 */
  interrupt(): void;
  respondPermission(requestId: string, reply: PermissionReply): Promise<void>;
  respondQuestion(requestId: string, reply: QuestionReply): Promise<void>;
  setModel(model: string | ModelRef): Promise<void>;
  setPermissionPreset(name: string): Promise<void>;
  setReasoningEffort(level: string): Promise<void>;
  setShell(kind: string): Promise<void>;
  compact(): Promise<void>;
  rewindTargets(): Promise<RewindTarget[]>;
  turnChanges(): Promise<RpcResult<"session.turnChanges">>;
  turnChangeDiff(seq: number, path: string): Promise<RpcResult<"session.turnChangeDiff">>;
  rewind(targetSeq: number, mode: RewindMode): Promise<SessionRewoundPayload["files"]>;
  state(): Promise<SessionStateSummary>;
  describeContext(): Promise<ContextSummary>;
  reasoningEffortInfo(): Promise<RpcResult<"session.reasoningEffortInfo">>;
  shellInfo(): Promise<RpcResult<"session.shellInfo">>;
  listShells(): Promise<RpcResult<"session.listShells">>;
  visionInfo(): Promise<RpcResult<"session.visionInfo">>;
  mcpServers(): Promise<RpcResult<"session.mcpServers">>;
  fileIndex(): Promise<FileIndexEntry[]>;
  /**
   * 回答内文件引用存在性检查（U-09，方案 A）：只读，按工作区解析路径。
   * 越界路径照常返回绝对路径与 exists，由客户端决定入口。
   */
  resolveFiles(paths: string[]): Promise<FileRefResolution[]>;
  readInputHistory(): Promise<string[]>;
  recordInputHistory(text: string): Promise<void>;
  close(): Promise<void>;
}

/** 与进程内 `Runtime` 同名的方法；`undefined` 的返回在线上是 `null`，这里还原 */
export interface RpcRuntime {
  describeExternalAgents(input?: {
    workspaceRoot?: string | undefined;
  }): Promise<ExternalAgentsDescription>;
  saveExternalAgent(input: ExternalAgentSaveInput): Promise<ExternalAgentOverview>;
  deleteExternalAgent(input: { name: string }): Promise<void>;
  setExternalAgentEnabled(input: { name: string; enabled: boolean }): Promise<void>;
  probeExternalAgent(input: ExternalAgentProbeInput): Promise<ExternalAgentProbeResult>;
  describeSkills(input?: { workspaceRoot?: string | undefined }): Promise<SkillsDescription>;
  setSkillEnabled(input: { name: string; enabled: boolean }): Promise<{ affectedSessions: number }>;
  /**
   * 导入技能（U-08）：预检返回候选与冲突，执行时带逐项决定。
   * 写入经 Core，客户端不直接写技能目录。
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
  listSessions(filter?: { cwd?: string; includeSubagents?: boolean }): Promise<SessionSummary[]>;
  usageStats(input: { days?: number }): Promise<UsageStats>;
  /**
   * createSession 可携带 cwd/workspaceRoot（ADR-0051）：单后台模式下
   * 会话按自己的工作区创建；缺省为后台启动目录。
   */
  createSession(
    options: CreateSessionOptions,
  ): Promise<{ opened: SessionOpened; session: RpcSession }>;
  resumeSession(
    id: string,
    options?: { model?: string | ModelRef; force?: boolean },
  ): Promise<{ opened: SessionOpened; session: RpcSession }>;
  forkSession(id: string, options?: { targetSeq?: number }): Promise<string>;
  /**
   * 只读发现父会话的直接内置子会话（含已结束；ADR-0060 第 4 轮，rpc.md 4.1）。
   * 不要求打开父会话。参数既可传 id，也可传与进程内 `Runtime.listSubagents` 相同的对象。
   */
  listSubagents(parent: string | { parentSessionId: string }): Promise<SubagentSummary[]>;
  /** 读取子会话自己的持久事件登记过的图片附件（只读，不打开 child）；字节已解码 */
  readSubagentAttachment(input: {
    parentSessionId: string;
    childSessionId: string;
    file: string;
  }): Promise<ReadAttachmentResult>;
  /**
   * 只读观察一个直接子会话：先交付 afterSeq 之后的持久事件，再接实时（持久与临时都推）。
   * 自然结束时 `observer.onEnd` 至多一次，**可先于本方法的返回**（回放期间结束，或快照读完）；
   * 返回的观察对象不是 RpcSession，没有任何命令入口。同一 (parent, child) 再次观察会替换旧观察，
   * 旧观察的迟到消息被丢弃；连接断开时不回调 onEnd（客户端用 `RpcClient.closed` 感知）。
   * `unsubscribe` 幂等，不产生 onEnd，也不关闭子会话。
   */
  observeSubagent(
    input: { parentSessionId: string; childSessionId: string; afterSeq?: number | undefined },
    observer: SubagentObserver,
  ): Promise<SubagentObservation>;
  /**
   * workspaceRoot（ADR-0051）：下列方法可带 `workspaceRoot` 指定按哪个工作区
   * 合并配置层；缺省为后台启动目录。
   */
  listModels(input?: {
    workspaceRoot?: string | undefined;
    includeDisabled?: boolean | undefined;
  }): Promise<ModelInfo[]>;
  defaultModel(input?: { workspaceRoot?: string | undefined }): Promise<ModelRef | undefined>;
  /** recent-models.json（全局偏好，无工作区维度） */
  listRecentModels(): Promise<ModelRef[]>;
  describeSettings(input?: { workspaceRoot?: string | undefined }): Promise<SettingItem[]>;
  listShells(input?: {
    workspaceRoot?: string | undefined;
  }): Promise<RpcResult<"runtime.listShells">>;
  /** 面板「文件」标签读取本机文件（ADR-0060）：只收绝对路径；图片字节已解码 */
  readFile(path: string): Promise<LocalFileContent>;
  setShellSetting(
    kind: string,
    input?: { workspaceRoot?: string | undefined },
  ): Promise<SettingItem[]>;
  updateSettings(
    patch: SettingsPatch,
    options?: { reviewerKey?: string; workspaceRoot?: string | undefined },
  ): Promise<SettingItem[]>;
  setDefaultModel(
    model: string,
    reasoningEffort: ReasoningEffort | null,
    options?: { workspaceRoot?: string | undefined },
  ): Promise<SettingItem[]>;
  describeModelRoles(input?: { workspaceRoot?: string | undefined }): Promise<ModelRoleInfo[]>;
  setModelRole(
    role: ModelRole,
    ref: string | null,
    options?: { workspaceRoot?: string | undefined },
  ): Promise<SettingItem[]>;
  getPreference(key: string): Promise<string | undefined>;
  setPreference(key: string, value: string | undefined): Promise<void>;
  listReviewerProviders(input?: {
    workspaceRoot?: string | undefined;
  }): Promise<ProviderOverview[]>;
  /** 从磁盘重新加载配置并替换注册表；完成前先收到 onProvidersChanged */
  reloadConfig(): Promise<void>;
  defaultReviewer(
    endpoint: JevEndpoint,
    baseURL?: string,
    input?: { workspaceRoot?: string | undefined },
  ): Promise<JevReviewerConfig>;
  listReviewerModels(
    reviewer: JevReviewerConfig,
    input?: { workspaceRoot?: string | undefined },
  ): Promise<{ models: string[]; warning?: string }>;
  /** 内置审查样例的说明与期望（ADR-0057 §8） */
  listReviewerSamples(): Promise<ReviewerSampleInfo[]>;
  /** 用已保存的审查器配置跑一条样例；客户端逐条调用并自行汇总命中率 */
  testReviewerSample(
    sampleId: string,
    input?: { workspaceRoot?: string | undefined },
  ): Promise<ReviewerSampleResult>;
}

/**
 * 服务商配置（provider-setup.md 第 6 节、rpc.md 3.3）：方法名与 Core 数据接口一致。
 * 写操作由服务端串行执行"变更 → 重载 → providersChanged"，所以响应返回时
 * `runtime.listModels()` 读到的已是新值；响应之前先收到 `onProvidersChanged`。
 */
export interface RpcProvider {
  listProviderPresets(): Promise<ProviderPreset[]>;
  describeProviders(input?: { workspaceRoot?: string | undefined }): Promise<ProvidersDescribed>;
  describeProviderSetup(presetId: string): Promise<ProviderSetupDescription>;
  /** 无系统凭据后端且为账号型登录时返回保存位置描述；否则 undefined */
  describeAccountStorage(providerId: string): Promise<AccountStorageSetup | undefined>;
  /** 校验 + 获取模型列表并暂存草稿（draftId 绑定服务端配置对象，15 分钟过期）；不落盘 */
  prepareProvider(input: PrepareProviderParams): Promise<PrepareProviderResult>;
  /** 保存草稿（可带手填模型 ID）；失败可重试同一 draftId */
  commitProvider(draftId: string, manualModelId?: string): Promise<AddProviderResult>;
  discardProvider(draftId: string): Promise<void>;
  setCredential(providerId: string, key: string): Promise<void>;
  listModelSettings(
    providerId: string,
    input?: { workspaceRoot?: string | undefined },
  ): Promise<ModelSettingsView[]>;
  saveModelSettings(
    providerId: string,
    modelId: string,
    patch: ModelSettingsPatch,
    input?: { workspaceRoot?: string | undefined },
  ): Promise<void>;
  /** 重新获取上游模型列表与限额；返回提示文案或 undefined */
  refreshUpstreamLimits(providerId: string): Promise<string | undefined>;
  /** 刷新 models.dev 缓存；返回提示文案或 undefined */
  refreshModelsDev(): Promise<string | undefined>;
  /** 删除向导条目及凭据；本连接任一会话正在使用时拒绝（provider_in_use） */
  removeSetupProvider(providerId: string): Promise<void>;
  /**
   * 启停服务商（ADR-0054）：写 settings.json 的 disabledProviders；响应之前
   * 先收到 onProvidersChanged，listModels/describeProviders 读到的已是新值。
   */
  setProviderEnabled(provider: string, enabled: boolean): Promise<void>;
  /** 批量启停某服务商下的模型（models 为模型 id） */
  setModelsEnabled(provider: string, models: string[], enabled: boolean): Promise<void>;
  /** 停用前的影响面：受影响的打开会话数、默认模型、模型角色（models 省略 = 整个服务商） */
  describeToggleImpact(provider: string, models?: string[]): Promise<ToggleImpact>;
  logoutProvider(providerId: string): Promise<void>;
  /**
   * 编辑自定义服务商（U-07）：现读 providers.json 条目原文给编辑表单预填；
   * 条目不在向导层时为 null。
   */
  describeSetupProvider(providerId: string): Promise<ProviderEntryConfig | null>;
  /**
   * 用候选配置发一次 GET /models（不写任何东西，凭据按条目现有规则解析）；
   * 失败抛错，由界面决定是否「仍然保存」。
   */
  probeSetupProviderModels(params: {
    providerId: string;
    type: "openai-compatible" | "anthropic";
    baseURL?: string;
    headers?: Record<string, string>;
  }): Promise<{ models: UpstreamModelEntry[] }>;
  /**
   * 保存自定义条目编辑（id 锁定；显示名/Base URL/协议/请求头可改；
   * patch.models 存在时同时更新模型清单）。只对 providers.json 里的自定义条目开放。
   */
  updateSetupProvider(
    providerId: string,
    patch: UpdateSetupProviderPatch,
  ): Promise<UpdateSetupProviderResult>;
}

/**
 * 登录会话（rpc.md 3.4）：start/startDraft 返回 `authorizeUrl`（浏览器由客户端打开）
 * 与 `loginId`，完成或失败经 `onLoginCompleted` 通知。`remote` 模式不占用本机
 * 回环端口；`accountStorage` 只在服务端没有系统凭据后端时需要。
 */
export interface RpcLogin {
  /** 已保存服务商重新登录/补登；loginId 由服务端生成 */
  start(params: {
    providerId: string;
    accountStorage?: "plaintext" | "memory";
    remote?: boolean;
  }): Promise<LoginStarted>;
  /** 表单里未保存的草稿登录；`name` 必填 */
  startDraft(params: {
    presetId: string;
    name: string;
    baseURL?: string;
    accountStorage?: "plaintext" | "memory";
    remote?: boolean;
  }): Promise<LoginStarted>;
  /** 粘贴回调 URL 或授权码（manualInput 为 "callback-url"/"code" 时） */
  submitManual(loginId: string, text: string): Promise<void>;
  /**
   * 进行中 → 取消（随后收到带 `cancelled` 的 login.completed）；
   * 已完成未提交的草稿登录 → 丢弃暂存凭据（无通知）
   */
  cancel(loginId: string): Promise<void>;
}

export interface RpcClient {
  onNotification<M extends keyof RpcServerNotifications>(
    method: M,
    handler: (params: RpcServerNotifications[M]) => void,
  ): () => void;
  /** 握手：必须是第一个调用；协议版本不一致时抛 `protocol_version_mismatch` */
  initialize(): Promise<InitializeResult>;
  readonly runtime: RpcRuntime;
  /** 服务商配置（provider.* 方法） */
  readonly provider: RpcProvider;
  /** 登录会话（login.* 方法 + login.completed 通知） */
  readonly login: RpcLogin;
  /** 已打开会话的句柄（`createSession`/`resumeSession` 返回的就是它） */
  session(sessionId: string): RpcSession;
  /** 任意方法的类型化调用（上面的封装都建立在它上面） */
  call<M extends RpcMethodName>(method: M, params: RpcParams<M>): Promise<RpcResult<M>>;
  /** 收到任意会话的事件 */
  onEvent(handler: (sessionId: string, event: RuntimeEvent) => void): () => void;
  /**
   * 服务商配置变更完成（Runtime 已用重载后配置重建）：在对应写方法的
   * 响应之前到达一次。桌面端据此刷新服务商/模型相关视图。
   */
  onProvidersChanged(handler: () => void): () => void;
  /** 登录会话完成或失败（含取消）；绝不先于对应 start/startDraft 的返回到达 */
  onLoginCompleted(handler: (notification: LoginCompleted) => void): () => void;
  /** 请求服务端清理并退出，回复后关闭传输 */
  shutdown(): Promise<void>;
  /** 直接关闭传输（服务端按"连接断开"清理） */
  close(): void;
  /** 连接结束（对端关闭、进程退出、本端 close）时 resolve */
  readonly closed: Promise<void>;
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

interface SubagentWatch {
  subscriptionId: string;
  parentSessionId: string;
  childSessionId: string;
  observer: SubagentObserver;
  /** 已退订或被同一 child 的新观察替换 */
  cancelled: boolean;
  /** 已收到 closed */
  ended: boolean;
}

const subagentPairKey = (parentSessionId: string, childSessionId: string): string =>
  `${parentSessionId}\u0000${childSessionId}`;

export function createRpcClient(transport: LineTransport, options: RpcClientOptions): RpcClient {
  let nextId = 1;
  let isClosed = false;
  const pending = new Map<RpcId, Pending>();
  const sessionListeners = new Map<string, Set<EventListener>>();
  const globalListeners = new Set<(sessionId: string, event: RuntimeEvent) => void>();
  const providersChangedListeners = new Set<() => void>();
  const loginCompletedListeners = new Set<(n: LoginCompleted) => void>();
  const notificationListeners = new Map<string, Set<(params: never) => void>>();
  /** 子会话只读观察表：subscriptionId → 观察；pair 表用于「同一 child 再观察替换旧观察」 */
  const subagentWatches = new Map<string, SubagentWatch>();
  const subagentPairs = new Map<string, string>();
  let nextSubscriptionId = 1;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  const connectionClosed = () => new RpcError("connection_closed", "与 Nocturne 后台的连接已断开");

  const dispatchEvent = (sessionId: string, event: RuntimeEvent): void => {
    for (const listener of [...(sessionListeners.get(sessionId) ?? [])]) {
      try {
        listener(event);
      } catch {
        // 订阅者异常不影响其他订阅者（events.md 第 6 节）
      }
    }
    for (const handler of [...globalListeners]) {
      try {
        handler(sessionId, event);
      } catch {
        // 同上
      }
    }
  };

  transport.onLine((line) => {
    if (line.trim() === "") return;
    const parsed = parseLine(line);
    if (parsed.kind === "error") return;
    const message = parsed.message;
    if (typeof message.method === "string" && !isRpcId(message.id)) {
      for (const handler of notificationListeners.get(message.method) ?? []) {
        try {
          handler(message.params as never);
        } catch {
          /* 监听器异常不影响其他监听器 */
        }
      }
    }
    const id = message.id;
    if (isRpcId(id) && ("result" in message || "error" in message)) {
      const entry = pending.get(id);
      if (entry === undefined) return;
      pending.delete(id);
      const error = message.error as RpcErrorObject | undefined;
      if (error !== undefined) entry.reject(RpcError.fromObject(error));
      else entry.resolve(message.result);
      return;
    }
    if (message.method === "event") {
      const params = message.params as { sessionId?: unknown; event?: unknown } | undefined;
      if (typeof params?.sessionId === "string" && typeof params.event === "object") {
        dispatchEvent(params.sessionId, params.event as RuntimeEvent);
      }
    }
    if (message.method === "runtime.providersChanged") {
      for (const handler of [...providersChangedListeners]) {
        try {
          handler();
        } catch {
          // 监听器异常不影响其他监听器
        }
      }
    }
    if (message.method === "login.completed") {
      const params = message.params as LoginCompleted | undefined;
      if (typeof params?.loginId === "string") {
        for (const handler of [...loginCompletedListeners]) {
          try {
            handler(params);
          } catch {
            // 监听器异常不影响其他监听器
          }
        }
      }
    }
  });
  transport.onClose(() => {
    isClosed = true;
    subagentWatches.clear();
    subagentPairs.clear();
    for (const entry of pending.values()) entry.reject(connectionClosed());
    pending.clear();
    resolveClosed();
  });

  const call = <M extends RpcMethodName>(
    method: M,
    params: RpcParams<M>,
  ): Promise<RpcResult<M>> => {
    if (isClosed) return Promise.reject(connectionClosed());
    const id = nextId++;
    return new Promise<RpcResult<M>>((resolve, reject) => {
      pending.set(id, { resolve: resolve, reject });
      try {
        transport.send(encodeMessage({ jsonrpc: "2.0", id, method, params }));
      } catch (error) {
        pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  };

  const dropSubagentWatch = (watch: SubagentWatch): void => {
    if (subagentWatches.get(watch.subscriptionId) === watch) {
      subagentWatches.delete(watch.subscriptionId);
    }
    const pair = subagentPairKey(watch.parentSessionId, watch.childSessionId);
    if (subagentPairs.get(pair) === watch.subscriptionId) subagentPairs.delete(pair);
  };
  // 通知路由：按 subscriptionId 找观察；已替换/已退订/已结束的迟到消息直接丢弃
  const routeSubagent = <M extends "subagent.event" | "subagent.closed">(
    method: M,
    handler: (watch: SubagentWatch, params: RpcServerNotifications[M]) => void,
  ): void => {
    const listeners = notificationListeners.get(method) ?? new Set<(params: never) => void>();
    notificationListeners.set(method, listeners);
    listeners.add((params: RpcServerNotifications[M]) => {
      const watch = subagentWatches.get(params.subscriptionId);
      if (
        watch === undefined ||
        watch.cancelled ||
        watch.ended ||
        watch.parentSessionId !== params.parentSessionId ||
        watch.childSessionId !== params.childSessionId
      )
        return;
      handler(watch, params);
    });
  };
  routeSubagent("subagent.event", (watch, params) => {
    watch.observer.onEvent(params.event);
  });
  routeSubagent("subagent.closed", (watch, params) => {
    // 缓存终止状态：closed 可能先于 subscribe 响应到达，响应后也不能再当作 live
    watch.ended = true;
    dropSubagentWatch(watch);
    watch.observer.onEnd(params.end);
  });

  const notify = (method: string, params: unknown): void => {
    if (isClosed) return;
    transport.send(encodeMessage({ jsonrpc: "2.0", method, params }));
  };

  const sessionHandles = new Map<string, RpcSession>();
  const session = (sessionId: string): RpcSession => {
    const existing = sessionHandles.get(sessionId);
    if (existing !== undefined) return existing;
    const p = { sessionId };
    const handle: RpcSession = {
      id: sessionId,
      async subscribe(listener, subscribeOptions) {
        // 同一会话同一时刻一个订阅：再次订阅替换之前的监听器（重连、换视图时用）。
        // 回放是推给"这一路订阅"的，保留旧监听器会让它收到重复的回放
        const listeners = new Set<EventListener>([listener]);
        sessionListeners.set(sessionId, listeners);
        try {
          const { lastSeq } = await call("session.subscribe", {
            ...p,
            afterSeq: subscribeOptions?.afterSeq ?? 0,
          });
          return {
            lastSeq,
            async unsubscribe() {
              // 已被后来的订阅替换：什么都不做
              if (sessionListeners.get(sessionId) !== listeners) return;
              sessionListeners.delete(sessionId);
              if (!isClosed) await call("session.unsubscribe", p).catch(() => undefined);
            },
          };
        } catch (error) {
          if (sessionListeners.get(sessionId) === listeners) sessionListeners.delete(sessionId);
          throw error;
        }
      },
      async readAttachment(file) {
        const result = await call("session.readAttachment", { ...p, file });
        return { data: decodeBase64(result.data), mimeType: result.mimeType, bytes: result.bytes };
      },
      submit: async (input) => {
        const attachments = input.attachments?.map((a) => ({
          data: encodeBase64(a.data),
          mimeType: a.mimeType,
          ...(a.label !== undefined ? { label: a.label } : {}),
        }));
        return await call("session.submit", {
          ...p,
          ...(input.skill !== undefined ? { skill: input.skill } : {}),
          ...(input.delegate !== undefined ? { delegate: input.delegate } : {}),
          ...(input.text !== undefined ? { text: input.text } : {}),
          ...(input.content !== undefined ? { content: input.content } : {}),
          ...(attachments !== undefined ? { attachments } : {}),
        });
      },
      interrupt: () => {
        notify("session.interrupt", p);
      },
      respondPermission: async (requestId, reply) => {
        await call("session.respondPermission", { ...p, requestId, reply });
      },
      respondQuestion: async (requestId, reply) => {
        await call("session.respondQuestion", { ...p, requestId, reply });
      },
      setModel: async (model) => {
        await call("session.setModel", { ...p, model });
      },
      setPermissionPreset: async (name) => {
        await call("session.setPermissionPreset", { ...p, name });
      },
      setReasoningEffort: async (level) => {
        await call("session.setReasoningEffort", { ...p, level });
      },
      setShell: async (kind) => {
        await call("session.setShell", { ...p, kind });
      },
      compact: async () => {
        await call("session.compact", p);
      },
      rewindTargets: () => call("session.rewindTargets", p),
      turnChanges: () => call("session.turnChanges", p),
      turnChangeDiff: (seq, path) => call("session.turnChangeDiff", { ...p, seq, path }),
      rewind: (targetSeq, mode) => call("session.rewind", { ...p, targetSeq, mode }),
      state: () => call("session.state", p),
      describeContext: () => call("session.describeContext", p),
      reasoningEffortInfo: () => call("session.reasoningEffortInfo", p),
      shellInfo: () => call("session.shellInfo", p),
      listShells: () => call("session.listShells", p),
      visionInfo: () => call("session.visionInfo", p),
      mcpServers: () => call("session.mcpServers", p),
      describeSkills: () => call("session.describeSkills", p),
      describeExternalAgents: () => call("session.describeExternalAgents", p),
      fileIndex: () => call("session.fileIndex", p),
      resolveFiles: (paths) => call("session.resolveFiles", { ...p, paths }),
      readInputHistory: () => call("session.readInputHistory", p),
      recordInputHistory: async (text) => {
        await call("session.recordInputHistory", { ...p, text });
      },
      close: async () => {
        try {
          await call("session.close", p);
        } finally {
          sessionHandles.delete(sessionId);
          sessionListeners.delete(sessionId);
        }
      },
    };
    sessionHandles.set(sessionId, handle);
    return handle;
  };

  const runtime: RpcRuntime = {
    describeExternalAgents: (input = {}) => call("agents.describeExternalAgents", input),
    saveExternalAgent: (input) => call("agents.saveExternalAgent", input),
    deleteExternalAgent: async (input) => {
      await call("agents.deleteExternalAgent", input);
    },
    setExternalAgentEnabled: async (input) => {
      await call("agents.setExternalAgentEnabled", input);
    },
    probeExternalAgent: (input) => call("agents.probeExternalAgent", input),
    describeMcpServers: (input = {}) => call("mcp.describeMcpServers", input),
    describeSkills: (input = {}) => call("skills.describeSkills", input),
    setSkillEnabled: (input) => call("skills.setSkillEnabled", input),
    importSkills: (input) => call("skills.importSkills", input),
    saveMcpServer: (input) => call("mcp.saveMcpServer", input),
    deleteMcpServer: async (input) => {
      await call("mcp.deleteMcpServer", input);
    },
    setMcpServerEnabled: async (input) => {
      await call("mcp.setMcpServerEnabled", input);
    },
    probeMcpServer: (input) => call("mcp.probeMcpServer", input),
    listSessions: (filter) => call("runtime.listSessions", filter ?? {}),
    usageStats: (input) => call("runtime.usageStats", input),
    createSession: async (createOptions) => {
      const opened = await call("runtime.createSession", createOptions);
      return { opened, session: session(opened.sessionId) };
    },
    resumeSession: async (id, resumeOptions) => {
      const opened = await call("runtime.resumeSession", { sessionId: id, ...resumeOptions });
      return { opened, session: session(opened.sessionId) };
    },
    forkSession: async (id, forkOptions) =>
      (await call("runtime.forkSession", { sessionId: id, ...forkOptions })).sessionId,
    listSubagents: (parent) =>
      call("subagent.list", {
        parentSessionId: typeof parent === "string" ? parent : parent.parentSessionId,
      }),
    async readSubagentAttachment(input) {
      const result = await call("subagent.readAttachment", input);
      return { data: decodeBase64(result.data), mimeType: result.mimeType, bytes: result.bytes };
    },
    async observeSubagent(input, observer) {
      const { parentSessionId, childSessionId } = input;
      const subscriptionId = `subagent-${nextSubscriptionId++}`;
      const pair = subagentPairKey(parentSessionId, childSessionId);
      const previous = subagentPairs.get(pair);
      const previousWatch = previous === undefined ? undefined : subagentWatches.get(previous);
      if (previousWatch !== undefined) {
        previousWatch.cancelled = true;
        dropSubagentWatch(previousWatch);
      }
      const watch: SubagentWatch = {
        subscriptionId,
        parentSessionId,
        childSessionId,
        observer: {
          onEvent: (event) => {
            try {
              observer.onEvent(event);
            } catch {
              // 观察者异常不影响其他观察
            }
          },
          onEnd: (end) => {
            try {
              observer.onEnd(end);
            } catch {
              // 同上
            }
          },
        },
        cancelled: false,
        ended: false,
      };
      subagentWatches.set(subscriptionId, watch);
      subagentPairs.set(pair, subscriptionId);
      let info;
      try {
        info = await call("subagent.subscribe", {
          parentSessionId,
          childSessionId,
          subscriptionId,
          ...(input.afterSeq !== undefined ? { afterSeq: input.afterSeq } : {}),
        });
      } catch (error) {
        watch.cancelled = true;
        dropSubagentWatch(watch);
        throw error;
      }
      let unsubscribed = false;
      return {
        lastSeq: info.lastSeq,
        summary: info.summary,
        mode: info.mode,
        unsubscribe() {
          if (unsubscribed) return;
          unsubscribed = true;
          // 已结束或已被替换：服务端表项早已释放，不再发请求
          if (watch.cancelled || watch.ended) return;
          watch.cancelled = true;
          dropSubagentWatch(watch);
          if (!isClosed)
            void call("subagent.unsubscribe", { subscriptionId }).catch(() => undefined);
        },
      };
    },
    listModels: (input) => call("runtime.listModels", input ?? {}),
    defaultModel: async (input) => (await call("runtime.defaultModel", input ?? {})) ?? undefined,
    listRecentModels: () => call("runtime.listRecentModels", {}),
    describeSettings: (input) => call("runtime.describeSettings", input ?? {}),
    listShells: (input) => call("runtime.listShells", input ?? {}),
    async readFile(path) {
      const result = await call("runtime.readFile", { path });
      if (result.kind === "text") return result;
      return { ...result, data: decodeBase64(result.data) };
    },
    setShellSetting: (kind, input) => call("runtime.setShellSetting", { kind, ...input }),
    updateSettings: (patch, updateOptions) =>
      call("runtime.updateSettings", {
        patch,
        ...(updateOptions?.reviewerKey !== undefined
          ? { reviewerKey: updateOptions.reviewerKey }
          : {}),
        ...(updateOptions?.workspaceRoot !== undefined
          ? { workspaceRoot: updateOptions.workspaceRoot }
          : {}),
      }),
    setDefaultModel: (model, reasoningEffort, setOptions) =>
      call("runtime.setDefaultModel", {
        model,
        reasoningEffort,
        ...(setOptions?.workspaceRoot !== undefined
          ? { workspaceRoot: setOptions.workspaceRoot }
          : {}),
      }),
    describeModelRoles: (input) => call("runtime.describeModelRoles", input ?? {}),
    setModelRole: (role, ref, setOptions) =>
      call("runtime.setModelRole", {
        role,
        ref,
        ...(setOptions?.workspaceRoot !== undefined
          ? { workspaceRoot: setOptions.workspaceRoot }
          : {}),
      }),
    getPreference: async (key) => (await call("runtime.getPreference", { key })) ?? undefined,
    setPreference: async (key, value) => {
      await call("runtime.setPreference", { key, value: value ?? null });
    },
    listReviewerProviders: (input) => call("runtime.listReviewerProviders", input ?? {}),
    reloadConfig: async () => {
      await call("runtime.reloadConfig", {});
    },
    defaultReviewer: (endpoint, baseURL, input) =>
      call("runtime.defaultReviewer", {
        endpoint,
        ...(baseURL !== undefined ? { baseURL } : {}),
        ...(input?.workspaceRoot !== undefined ? { workspaceRoot: input.workspaceRoot } : {}),
      }),
    listReviewerModels: (reviewer, input) =>
      call("runtime.listReviewerModels", {
        reviewer,
        ...(input?.workspaceRoot !== undefined ? { workspaceRoot: input.workspaceRoot } : {}),
      }),
    listReviewerSamples: () => call("runtime.listReviewerSamples", {}),
    testReviewerSample: (sampleId, input) =>
      call("runtime.testReviewerSample", {
        sampleId,
        ...(input?.workspaceRoot !== undefined ? { workspaceRoot: input.workspaceRoot } : {}),
      }),
  };

  const provider: RpcProvider = {
    listProviderPresets: () => call("provider.listProviderPresets", {}),
    describeProviders: (input) => call("provider.describeProviders", input ?? {}),
    describeProviderSetup: (presetId) => call("provider.describeProviderSetup", { presetId }),
    describeAccountStorage: async (providerId) =>
      (await call("provider.describeAccountStorage", { providerId })) ?? undefined,
    prepareProvider: (input) => call("provider.prepareProvider", input),
    commitProvider: (draftId, manualModelId) =>
      call("provider.commitProvider", {
        draftId,
        ...(manualModelId !== undefined ? { manualModelId } : {}),
      }),
    discardProvider: async (draftId) => {
      await call("provider.discardProvider", { draftId });
    },
    setCredential: async (providerId, key) => {
      await call("provider.setCredential", { providerId, key });
    },
    listModelSettings: (providerId, input) =>
      call("provider.listModelSettings", {
        providerId,
        ...(input?.workspaceRoot !== undefined ? { workspaceRoot: input.workspaceRoot } : {}),
      }),
    saveModelSettings: async (providerId, modelId, patch, input) => {
      await call("provider.saveModelSettings", {
        providerId,
        modelId,
        patch,
        ...(input?.workspaceRoot !== undefined ? { workspaceRoot: input.workspaceRoot } : {}),
      });
    },
    refreshUpstreamLimits: async (providerId) =>
      (await call("provider.refreshUpstreamLimits", { providerId })).warning ?? undefined,
    refreshModelsDev: async () =>
      (await call("provider.refreshModelsDev", {})).warning ?? undefined,
    removeSetupProvider: async (providerId) => {
      await call("provider.removeSetupProvider", { providerId });
    },
    setProviderEnabled: async (provider, enabled) => {
      await call("provider.setProviderEnabled", { provider, enabled });
    },
    setModelsEnabled: async (provider, models, enabled) => {
      await call("provider.setModelsEnabled", { provider, models, enabled });
    },
    describeToggleImpact: (provider, models) =>
      call("provider.describeToggleImpact", {
        provider,
        ...(models !== undefined ? { models } : {}),
      }),
    logoutProvider: async (providerId) => {
      await call("provider.logoutProvider", { providerId });
    },
    describeSetupProvider: (providerId) => call("provider.describeSetupProvider", { providerId }),
    probeSetupProviderModels: (params) => call("provider.probeSetupProviderModels", params),
    updateSetupProvider: (providerId, patch) =>
      call("provider.updateSetupProvider", { providerId, patch }),
  };

  const login: RpcLogin = {
    start: (params) => call("login.start", params),
    startDraft: (params) => call("login.startDraft", params),
    submitManual: async (loginId, text) => {
      await call("login.submitManual", { loginId, text });
    },
    cancel: async (loginId) => {
      await call("login.cancel", { loginId });
    },
  };

  return {
    onNotification(method, handler) {
      const listeners = notificationListeners.get(method) ?? new Set<(params: never) => void>();
      notificationListeners.set(method, listeners);
      listeners.add(handler);
      return () => {
        listeners.delete(handler);
      };
    },
    async initialize() {
      const result = await call("initialize", {
        protocolVersion: RPC_PROTOCOL_VERSION,
        clientName: options.clientName,
        capabilities: { interactive: options.interactive ?? true },
      });
      if (result.protocolVersion !== RPC_PROTOCOL_VERSION) {
        throw new RpcError(
          "protocol_version_mismatch",
          `协议版本不一致：客户端 ${RPC_PROTOCOL_VERSION}，服务端 ${result.protocolVersion}`,
        );
      }
      return result;
    },
    runtime,
    provider,
    login,
    session,
    call,
    onEvent(handler) {
      globalListeners.add(handler);
      return () => {
        globalListeners.delete(handler);
      };
    },
    onProvidersChanged(handler) {
      providersChangedListeners.add(handler);
      return () => {
        providersChangedListeners.delete(handler);
      };
    },
    onLoginCompleted(handler) {
      loginCompletedListeners.add(handler);
      return () => {
        loginCompletedListeners.delete(handler);
      };
    },
    async shutdown() {
      try {
        await call("shutdown", {});
      } finally {
        transport.close();
      }
    },
    close() {
      transport.close();
    },
    closed,
  };
}

/** 浏览器与 Node 都有 btoa；分块拼接避免大数组展开超出调用栈 */
export function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

export function decodeBase64(text: string): Uint8Array {
  const binary = atob(text);
  const data = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) data[i] = binary.charCodeAt(i);
  return data;
}

export interface SessionViewTracker {
  /** 当前视图；每个事件归约后原地更新 */
  readonly view: SessionView;
  /** 回放与实时衔接已完成时已处理到的最后一个持久事件 seq */
  readonly lastSeq: number;
  stop(): Promise<void>;
}

/**
 * 订阅会话并用 protocol 的同一个 reducer 折叠视图（view.md 第 6 节）；
 * 每处理一个事件调用 `onChange`。重连时用 `afterSeq` 与已有 `view` 续接。
 */
export async function trackSessionView(
  session: RpcSession,
  onChange?: (view: SessionView, event: RuntimeEvent) => void,
  options: SubscribeOptions & { view?: SessionView } = {},
): Promise<SessionViewTracker> {
  const view = options.view ?? createSessionView();
  const subscription = await session.subscribe(
    (event) => {
      reduceSessionView(view, event);
      onChange?.(view, event);
    },
    { afterSeq: options.afterSeq ?? 0 },
  );
  return {
    view,
    lastSeq: subscription.lastSeq,
    stop: () => subscription.unsubscribe(),
  };
}
