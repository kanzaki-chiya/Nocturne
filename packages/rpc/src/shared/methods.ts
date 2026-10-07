import type {
  SkillImportInput,
  SkillImportOutput,
  SkillInvocation,
  SkillsDescription,
} from "@nocturne/core";
/**
 * 方法表：每个 RPC 方法的参数与结果类型（ADR-0044 第 4 节、docs/protocols/rpc.md）。
 * 服务端按它做类型检查地实现，客户端按它生成类型化调用；对 @nocturne/core 只有类型导入。
 *
 * 线上约定：`undefined` 以 `null` 表示（JSON 没有 undefined）；二进制用 base64 字符串。
 */
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
  AddProviderInput,
  AddProviderResult,
  BuiltContext,
  ContentBlock,
  CreateSessionOptions,
  FileIndexEntry,
  FileRefResolution,
  ImageMimeType,
  JevEndpoint,
  JevReviewerConfig,
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
  RuntimeEvent,
  RuntimeSession,
  SessionRewoundPayload,
  SessionState,
  SessionSummary,
  SettingItem,
  SettingsPatch,
  TurnEndReason,
} from "@nocturne/core";

export interface InitializeParams {
  /** 客户端实现的协议版本；与服务端不一致直接报错（第一版不做向下兼容） */
  protocolVersion: number;
  clientName: string;
  capabilities: {
    /** 客户端能否回复权限与提问请求；false 时权限请求按非交互规则处理 */
    interactive: boolean;
  };
}

export interface InitializeResult {
  protocolVersion: number;
  nocturneVersion: string;
  /** 会话日志目录（只读信息）；服务端不知道时缺省 */
  sessionsDir?: string;
}

/** createSession / resumeSession 的结果：会话已打开，事件要另行 session.subscribe */
export interface SessionOpened {
  sessionId: string;
  meta: SessionState["meta"];
  config: SessionState["config"];
  /** 打开时聚合的警告（配置降级、未信任项目配置等） */
  warnings: string[];
  /** 打开时执行的恢复修复汇总；无修复则缺省 */
  recovery?: NonNullable<RuntimeSession["recovery"]>;
  /** 打开时日志里最后一个持久事件的 seq */
  lastSeq: number;
}

/** `session.state` 的结果：SessionState 去掉可由持久事件折叠得到的 history 与进程内 Map */
export type SessionStateSummary = Omit<SessionState, "history" | "unsettledCalls">;

/** `session.describeContext` 的结果：去掉发给模型的整份请求，只留报告与判定 */
export type ContextSummary = Omit<BuiltContext, "request">;

export interface WireAttachment {
  /** base64（标准字母表，带填充） */
  data: string;
  mimeType: ImageMimeType;
  label?: string;
}

export interface SessionParams {
  sessionId: string;
}

/**
 * `provider.prepareProvider` 的表单（= AddProviderInput 去掉 modelId；
 * 手填模型 ID 在确认后由 `provider.commitProvider` 的 manualModelId 传入）。
 * credential 是判别联合，含 `{ kind: "apiKey", key }` 的密钥明文。
 */
export type PrepareProviderParams = Omit<AddProviderInput, "modelId">;

/** `provider.describeProviders` 的结果：列表 + providers.json 损坏/版本不符的人读说明 */
export interface ProvidersDescribed {
  providers: ProviderOverview[];
  setupWarning?: string;
}

/** 账号凭据的保存位置（无系统凭据后端时由客户端显式选择后传入，没有默认值） */
export type LoginAccountStorage = "plaintext" | "memory";

/**
 * `login.start` / `login.startDraft` 的结果：浏览器由客户端打开，服务端不打开。
 * `manualInput === "none"` 是设备码登录，用户在浏览器确认，不用粘贴。
 */
export interface LoginStarted {
  loginId: string;
  authorizeUrl: string;
  manualInput: "callback-url" | "code" | "none";
  /** 设备码登录时展示，供用户在浏览器核对；不含令牌 */
  userCode?: string;
  /** 本次登录等待的截止时刻（Unix 毫秒），到时服务端以 timeout 结束；客户端倒计时以它为准 */
  expiresAt: number;
}

/**
 * `login.completed` 通知：登录完成或失败（取消以 `cancelled` 报告）。
 * `loginId` 与对应 start 响应里的一致；通知绝不先于 start 响应到达。
 */
export interface LoginCompleted {
  loginId: string;
  /** 成功：只含 providerId 与可选账号描述，不含令牌 */
  result?: { providerId: string; account?: string };
  /** 失败：ProviderLoginError 的固定文案；其他异常一律 { code: "failed" } */
  error?: { code: string; message: string };
  /**
   * 无系统凭据后端的 OpenRouter 登录：一次性显示的密钥与环境变量名，
   * 只出现在这一条通知里（设置环境变量的命令文本由客户端生成）。不进诊断。
   */
  unstoredKey?: { key: string; envName: string };
  /** 登录成功但随后的配置重载失败时的提示 */
  warning?: string;
}

type Ret<K extends keyof RuntimeSession> = RuntimeSession[K] extends (...args: never[]) => infer R
  ? Awaited<R>
  : never;

/** 方法名 → 参数与结果 */
export interface RpcMethods {
  "agents.describeExternalAgents": {
    params: { workspaceRoot?: string | undefined };
    result: ExternalAgentsDescription;
  };
  "agents.saveExternalAgent": { params: ExternalAgentSaveInput; result: ExternalAgentOverview };
  "agents.deleteExternalAgent": { params: { name: string }; result: null };
  "agents.setExternalAgentEnabled": { params: { name: string; enabled: boolean }; result: null };
  "agents.probeExternalAgent": {
    params: ExternalAgentProbeInput;
    result: ExternalAgentProbeResult;
  };
  "session.describeExternalAgents": { params: SessionParams; result: ExternalAgentsDescription };
  "skills.describeSkills": {
    params: { workspaceRoot?: string | undefined };
    result: SkillsDescription;
  };
  "skills.setSkillEnabled": {
    params: { name: string; enabled: boolean };
    result: { affectedSessions: number };
  };
  /**
   * 导入技能（U-08）：预检返回候选与冲突，执行时带逐项决定。
   * 签名照 skills.* 现有风格；写入经 Core，客户端不直接写技能目录。
   */
  "skills.importSkills": {
    params: SkillImportInput;
    result: SkillImportOutput;
  };
  "session.describeSkills": { params: SessionParams; result: SkillsDescription };
  initialize: { params: InitializeParams; result: InitializeResult };
  shutdown: { params: Record<string, never>; result: null };

  "runtime.listSessions": {
    params: { cwd?: string; includeSubagents?: boolean };
    result: SessionSummary[];
  };
  "runtime.createSession": { params: CreateSessionOptions; result: SessionOpened };
  "runtime.resumeSession": {
    params: { sessionId: string; model?: string | ModelRef; force?: boolean };
    result: SessionOpened;
  };
  "runtime.forkSession": {
    params: { sessionId: string; targetSeq?: number };
    /** 新会话 id；会话本身未打开，要用 resumeSession 打开 */
    result: { sessionId: string };
  };
  /**
   * workspaceRoot（ADR-0051）：下列运行时级查询/写方法可携带 workspaceRoot，
   * 指定按哪个工作区合并配置层；缺省为后台启动目录。旧客户端不传不受影响。
   */
  "runtime.listModels": {
    params: { workspaceRoot?: string | undefined };
    result: ModelInfo[];
  };
  "runtime.defaultModel": {
    params: { workspaceRoot?: string | undefined };
    result: ModelRef | null;
  };
  "runtime.listRecentModels": { params: Record<string, never>; result: ModelRef[] };
  "runtime.describeSettings": {
    params: { workspaceRoot?: string | undefined };
    result: SettingItem[];
  };
  "runtime.updateSettings": {
    params: { patch: SettingsPatch; reviewerKey?: string; workspaceRoot?: string | undefined };
    result: SettingItem[];
  };
  "runtime.setDefaultModel": {
    params: {
      model: string;
      reasoningEffort: ReasoningEffort | null;
      workspaceRoot?: string | undefined;
    };
    result: SettingItem[];
  };
  "runtime.describeModelRoles": {
    params: { workspaceRoot?: string | undefined };
    result: ModelRoleInfo[];
  };
  "runtime.setModelRole": {
    params: { role: ModelRole; ref: string | null; workspaceRoot?: string | undefined };
    result: SettingItem[];
  };
  "runtime.getPreference": { params: { key: string }; result: string | null };
  "runtime.setPreference": {
    params: { key: string; value?: string | null };
    result: null;
  };
  "runtime.listReviewerProviders": {
    params: { workspaceRoot?: string | undefined };
    result: ProviderOverview[];
  };
  /**
   * 从磁盘重新加载配置（服务商与设置）并替换 Runtime 的注册表，随后推
   * runtime.providersChanged；用于另一个进程改了配置文件之后同步。
   */
  "mcp.describeMcpServers": {
    params: { workspaceRoot?: string | undefined };
    result: { servers: McpServerOverview[]; warnings: string[] };
  };
  "mcp.saveMcpServer": { params: McpSaveInput; result: McpServerOverview };
  "mcp.deleteMcpServer": {
    params: { id: string; workspaceRoot?: string | undefined };
    result: null;
  };
  "mcp.setMcpServerEnabled": {
    params: { id: string; enabled: boolean; workspaceRoot?: string | undefined };
    result: null;
  };
  "mcp.probeMcpServer": { params: McpProbeInput; result: McpProbeResult };
  "runtime.reloadConfig": { params: Record<string, never>; result: null };
  "runtime.defaultReviewer": {
    params: { endpoint: JevEndpoint; baseURL?: string; workspaceRoot?: string | undefined };
    result: JevReviewerConfig;
  };
  "runtime.listReviewerModels": {
    params: { reviewer: JevReviewerConfig; workspaceRoot?: string | undefined };
    result: { models: string[]; warning?: string };
  };

  // 服务商配置（provider-setup.md 第 6 节、docs/protocols/rpc.md 3.3）：
  // 只读描述 + 两阶段提交；写操作由服务端串行执行"变更 → 重载 →
  // runtime.providersChanged 通知"，响应在通知之后到达。
  "provider.listProviderPresets": { params: Record<string, never>; result: ProviderPreset[] };
  "provider.describeProviders": {
    params: { workspaceRoot?: string | undefined };
    result: ProvidersDescribed;
  };
  "provider.describeProviderSetup": {
    params: { presetId: string };
    result: ProviderSetupDescription;
  };
  "provider.describeAccountStorage": {
    params: { providerId: string };
    result: AccountStorageSetup | null;
  };
  "provider.prepareProvider": {
    params: PrepareProviderParams;
    result: PrepareProviderResult;
  };
  "provider.commitProvider": {
    params: { draftId: string; manualModelId?: string };
    result: AddProviderResult;
  };
  "provider.discardProvider": { params: { draftId: string }; result: null };
  "provider.setCredential": { params: { providerId: string; key: string }; result: null };
  "provider.listModelSettings": {
    params: { providerId: string; workspaceRoot?: string | undefined };
    result: ModelSettingsView[];
  };
  "provider.saveModelSettings": {
    params: {
      providerId: string;
      modelId: string;
      patch: ModelSettingsPatch;
      workspaceRoot?: string | undefined;
    };
    result: null;
  };
  "provider.refreshUpstreamLimits": {
    params: { providerId: string };
    result: { warning: string | null };
  };
  "provider.refreshModelsDev": {
    params: Record<string, never>;
    result: { warning: string | null };
  };
  "provider.removeSetupProvider": { params: { providerId: string }; result: null };
  "provider.logoutProvider": { params: { providerId: string }; result: null };
  // 编辑自定义服务商（U-07）：读条目原文给编辑表单预填；
  // probe 用候选配置获取模型列表（不写任何东西）；
  // update 走 saveSetupProvider 的 replace 模式。
  "provider.describeSetupProvider": {
    params: { providerId: string };
    result: ProviderEntryConfig | null;
  };
  "provider.probeSetupProviderModels": {
    params: {
      providerId: string;
      type: "openai-compatible" | "anthropic";
      baseURL?: string;
      headers?: Record<string, string>;
    };
    result: { models: UpstreamModelEntry[] };
  };
  "provider.updateSetupProvider": {
    params: { providerId: string; patch: UpdateSetupProviderPatch };
    result: UpdateSetupProviderResult;
  };

  // 登录会话（rpc.md 3.4）：start 返回句柄，完成经 login.completed 通知；
  // 浏览器与授权码粘贴都是客户端的事
  "login.start": {
    params: { providerId: string; accountStorage?: LoginAccountStorage; remote?: boolean };
    result: LoginStarted;
  };
  "login.startDraft": {
    params: {
      presetId: string;
      name: string;
      baseURL?: string;
      accountStorage?: LoginAccountStorage;
      remote?: boolean;
    };
    result: LoginStarted;
  };
  "login.submitManual": { params: { loginId: string; text: string }; result: null };
  "login.cancel": { params: { loginId: string }; result: null };

  "session.subscribe": {
    params: SessionParams & { afterSeq?: number };
    /** 回放与实时衔接已完成时返回；`lastSeq` 是已推送的最后一个持久事件的 seq */
    result: { lastSeq: number };
  };
  "session.unsubscribe": { params: SessionParams; result: null };
  "session.readAttachment": {
    params: SessionParams & { file: string };
    result: { data: string; mimeType: ImageMimeType; bytes: number };
  };
  "session.submit": {
    params: SessionParams & {
      skill?: SkillInvocation;
      delegate?: { agent: string; task: string };
      text?: string;
      content?: ContentBlock[];
      attachments?: WireAttachment[];
    };
    result: TurnEndReason;
  };
  "session.respondPermission": {
    params: SessionParams & { requestId: string; reply: PermissionReply };
    result: null;
  };
  "session.respondQuestion": {
    params: SessionParams & { requestId: string; reply: QuestionReply };
    result: null;
  };
  "session.setModel": { params: SessionParams & { model: string | ModelRef }; result: null };
  "session.setPermissionPreset": { params: SessionParams & { name: string }; result: null };
  "session.setReasoningEffort": { params: SessionParams & { level: string }; result: null };
  "session.setShell": { params: SessionParams & { kind: string }; result: null };
  "session.compact": { params: SessionParams; result: null };
  "session.rewindTargets": { params: SessionParams; result: RewindTarget[] };
  "session.rewind": {
    params: SessionParams & { targetSeq: number; mode: RewindMode };
    result: SessionRewoundPayload["files"];
  };
  "session.state": { params: SessionParams; result: SessionStateSummary };
  "session.describeContext": { params: SessionParams; result: ContextSummary };
  "session.reasoningEffortInfo": { params: SessionParams; result: Ret<"reasoningEffortInfo"> };
  "session.shellInfo": { params: SessionParams; result: Ret<"shellInfo"> };
  "session.listShells": { params: SessionParams; result: Ret<"listShells"> };
  "session.visionInfo": { params: SessionParams; result: Ret<"visionInfo"> };
  "session.mcpServers": { params: SessionParams; result: Ret<"mcpServers"> };
  "session.fileIndex": { params: SessionParams; result: FileIndexEntry[] };
  /**
   * 回答内文件引用存在性检查（U-09，方案 A）：只读，按工作区解析路径；
   * 越界路径照常返回绝对路径与 exists，由客户端决定入口。
   */
  "session.resolveFiles": {
    params: SessionParams & { paths: string[] };
    result: FileRefResolution[];
  };
  "session.readInputHistory": { params: SessionParams; result: string[] };
  "session.recordInputHistory": { params: SessionParams & { text: string }; result: null };
  "session.close": { params: SessionParams; result: null };
}

export type RpcMethodName = keyof RpcMethods;
export type RpcParams<M extends RpcMethodName> = RpcMethods[M]["params"];
export type RpcResult<M extends RpcMethodName> = RpcMethods[M]["result"];

/** 客户端→服务端的通知（无 id、无应答） */
export interface RpcClientNotifications {
  "session.interrupt": SessionParams;
}

/** 服务端→客户端的通知 */
export interface RpcServerNotifications {
  event: { sessionId: string; event: RuntimeEvent };
  /**
   * 配置变更方法（provider.commitProvider 等）成功后、响应之前推送：
   * Runtime 的 Provider 注册表已用重载后的配置重建，listModels 等读到的已是新值
   */
  "runtime.providersChanged": Record<string, never>;
  /** 登录会话完成或失败（含取消）；绝不先于对应 login.start/startDraft 的响应到达 */
  "login.completed": LoginCompleted;
}

const METHOD_TABLE: Record<RpcMethodName, true> = {
  initialize: true,
  shutdown: true,
  "runtime.listSessions": true,
  "runtime.createSession": true,
  "runtime.resumeSession": true,
  "runtime.forkSession": true,
  "runtime.listModels": true,
  "runtime.defaultModel": true,
  "runtime.listRecentModels": true,
  "runtime.describeSettings": true,
  "runtime.updateSettings": true,
  "runtime.setDefaultModel": true,
  "runtime.describeModelRoles": true,
  "runtime.setModelRole": true,
  "runtime.getPreference": true,
  "runtime.setPreference": true,
  "runtime.listReviewerProviders": true,
  "runtime.reloadConfig": true,
  "mcp.describeMcpServers": true,
  "agents.describeExternalAgents": true,
  "agents.saveExternalAgent": true,
  "agents.deleteExternalAgent": true,
  "agents.setExternalAgentEnabled": true,
  "agents.probeExternalAgent": true,
  "session.describeExternalAgents": true,
  "skills.describeSkills": true,
  "skills.setSkillEnabled": true,
  "skills.importSkills": true,
  "session.describeSkills": true,
  "mcp.saveMcpServer": true,
  "mcp.deleteMcpServer": true,
  "mcp.setMcpServerEnabled": true,
  "mcp.probeMcpServer": true,
  "runtime.defaultReviewer": true,
  "runtime.listReviewerModels": true,
  "provider.listProviderPresets": true,
  "provider.describeProviders": true,
  "provider.describeProviderSetup": true,
  "provider.describeAccountStorage": true,
  "provider.prepareProvider": true,
  "provider.commitProvider": true,
  "provider.discardProvider": true,
  "provider.setCredential": true,
  "provider.listModelSettings": true,
  "provider.saveModelSettings": true,
  "provider.refreshUpstreamLimits": true,
  "provider.refreshModelsDev": true,
  "provider.removeSetupProvider": true,
  "provider.logoutProvider": true,
  "provider.describeSetupProvider": true,
  "provider.probeSetupProviderModels": true,
  "provider.updateSetupProvider": true,
  "login.start": true,
  "login.startDraft": true,
  "login.submitManual": true,
  "login.cancel": true,
  "session.subscribe": true,
  "session.unsubscribe": true,
  "session.readAttachment": true,
  "session.submit": true,
  "session.respondPermission": true,
  "session.respondQuestion": true,
  "session.setModel": true,
  "session.setPermissionPreset": true,
  "session.setReasoningEffort": true,
  "session.setShell": true,
  "session.compact": true,
  "session.rewindTargets": true,
  "session.rewind": true,
  "session.state": true,
  "session.describeContext": true,
  "session.reasoningEffortInfo": true,
  "session.shellInfo": true,
  "session.listShells": true,
  "session.visionInfo": true,
  "session.mcpServers": true,
  "session.fileIndex": true,
  "session.resolveFiles": true,
  "session.readInputHistory": true,
  "session.recordInputHistory": true,
  "session.close": true,
};

/** 全部请求方法名（`RpcMethods` 增删方法而这里没跟着改，编译失败） */
export const RPC_METHOD_NAMES = Object.keys(METHOD_TABLE) as RpcMethodName[];
