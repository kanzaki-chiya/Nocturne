/**
 * 配置层类型（config.md 第 1、2、6 节）。
 * 本模块只做加载、校验、合并、标注来源；规则的解释在 permission，
 * Provider 配置的解释在 provider（config 不依赖它们，字段形状按
 * RuntimeOptions.providerConfigs 的元素对齐，由 core/index 装配时分发）。
 */
import type {
  AnnotatedRule,
  EditToolKind,
  Grant,
  HookEntry,
  HookPoint,
  McpServerEntry,
  ModelProtocol,
  ModelRef,
  PermissionPresetName,
  PermissionRule,
  ReasoningEffort,
  ReasoningEffortLevel,
} from "../protocol/index.js";

export type { AnnotatedRule };
export type { HookEntry, HookPoint, McpServerEntry };

/** Provider 条目中模型能力的覆盖形状（对齐 provider 的 ModelOverride） */
export interface ModelOverrideShape {
  displayName?: string | undefined;
  contextWindow?: number | undefined;
  maxOutputTokens?: number | undefined;
  capabilities?:
    | {
        toolCalls?: boolean | undefined;
        parallelToolCalls?: boolean | undefined;
        reasoning?: "none" | "hidden" | "visible" | undefined;
        /** 逐模型可用思考档位声明（ADR-0018）；schema 校验只含合法档位 */
        reasoningEffort?: ReasoningEffortLevel[] | undefined;
        imageInput?: boolean | undefined;
        promptCache?: boolean | undefined;
        /** 编辑工具选择（ADR-0035 §5）：未声明时按内置默认表取值 */
        editTool?: EditToolKind | undefined;
      }
    | undefined;
  /**
   * 上游声明的按量价格（USD / 每百万 token，provider-api.md 第 2 节）。
   * 只在上游或配置明确声明时存在；界面未声明时留空。
   */
  pricing?: { input?: number | undefined; output?: number | undefined } | undefined;
  /**
   * 手写协议指定（ADR-0026 第 2 节，最高优先级）：声明后不再按
   * endpoints 推导或条目 type 回落。
   */
  protocol?: ModelProtocol | undefined;
  /**
   * 上游 supported_endpoints 的保存位（ADR-0026 第 2 节）；
   * 手写配置也可声明，数据层面与上游同位。
   */
  endpoints?: string[] | undefined;
}

/** userModels 中单个模型的用户编辑（ADR-0024 第 1 节；ADR-0035 起八个可编辑字段） */
export interface UserModelEntry {
  displayName?: string | undefined;
  contextWindow?: number | undefined;
  maxOutputTokens?: number | undefined;
  capabilities?:
    | {
        reasoning?: "none" | "hidden" | "visible" | undefined;
        imageInput?: boolean | undefined;
        /** 逐模型可用思考档位；空数组 = 明确无可用档位 */
        reasoningEffort?: ReasoningEffortLevel[] | undefined;
        /** 用户编辑的编辑工具选择（ADR-0035 §5） */
        editTool?: EditToolKind | undefined;
      }
    | undefined;
  /** 用户编辑的协议指定（ADR-0026 第 7 节）；高于 endpoints 推导、低于手写 */
  protocol?: ModelProtocol | undefined;
}

/**
 * 声明式 Provider 配置条目（config.md 第 2 节：
 * 形状即 RuntimeOptions.providerConfigs 的元素）。
 * 凭据值不允许出现——只允许 apiKeyEnv 指向环境变量名（v0.2 起可选，
 * 缺省时经凭据索引/系统后端解析，见 provider-setup.md 第 3 节）。
 */
export interface ProviderEntryConfig {
  id: string;
  /** 适配器类型；缺省 openai-compatible */
  type?: "openai-compatible" | "anthropic" | undefined;
  baseURL?: string | undefined;
  /** 环境变量名（不是凭据值）；可选——未声明时凭据经凭据索引/系统后端解析 */
  apiKeyEnv?: string | undefined;
  models?: Record<string, ModelOverrideShape> | undefined;
  allowUndeclaredModels?: boolean | undefined;
  providerOptions?: Record<string, unknown> | undefined;
  headers?: Record<string, string> | undefined;
  /**
   * 会话标识请求头名（ADR-0031 §3）：值为请求头名称（如
   * "x-opencode-session"）；请求带 sessionId 时写 `<sessionHeader>:
   * <sessionId>`，headers 里同名静态头优先；未声明不发送。
   */
  sessionHeader?: string | undefined;
  /**
   * models.dev 服务商键（ADR-0031 §4）：如 "opencode-go"；声明后
   * models.dev 缓存/快照中该服务商的逐模型 npm 原文映射为 endpoints，
   * 以 models.dev 层身份参与逐字段合并（优先级低于上游）。未声明
   * 的条目不受影响。
   */
  modelsDevProvider?: string | undefined;
  /**
   * 思考参数格式由预设填写；budgets 覆盖 Anthropic 默认预算。
   * levels/source 仅为旧配置兼容读取，运行时忽略并在写回时清除。
   */
  thinking?:
    | {
        format?: "openai" | "openrouter" | undefined;
        levels?: ReasoningEffortLevel[] | undefined;
        source?: "user" | undefined;
        budgets?: Partial<Record<ReasoningEffortLevel, number>> | undefined;
      }
    | undefined;
  /**
   * 逐模型用户编辑（ADR-0024 第 1 节）：「编辑模型」/`/provider model` 写入，
   * 只在向导层 providers.json 有意义——合并时作为独立"用户编辑"层参与
   * 逐字段合并（高于上游、低于手写配置）。高层条目里的同名字段只作数据。
   */
  userModels?: Record<string, UserModelEntry> | undefined;
  /**
   * models 字段的来源标注（provider-setup.md 第 7 节）：向导 /
   * `/provider refresh` 写入上游列表时标记 "upstream" 并记录 fetchedAt。
   * 手写条目不携带这两个字段。
   */
  source?: "upstream" | undefined;
  /** ISO 8601 获取时间（仅 source="upstream"） */
  fetchedAt?: string | undefined;
}

/** Turn 参数覆盖（结构与 agent 的 TurnConfig 对齐，config 不依赖 agent） */
export interface TurnOverrides {
  maxSteps?: number | undefined;
  retryLimit?: number | undefined;
  retryBaseDelayMs?: number | undefined;
  firstEventTimeoutMs?: number | undefined;
  idleTimeoutMs?: number | undefined;
}

export type JevEndpoint = "opencode-zen" | "typesafe" | "custom";
export type ReviewerCredential = { provider: string } | { env: string } | { stored: true };
export interface JevReviewerConfig {
  backend: "jev";
  endpoint: JevEndpoint;
  baseURL?: string | undefined;
  model: string;
  credential: ReviewerCredential;
  minConfidence?: number | undefined;
}
export type SecurityReviewerConfig =
  { backend: "model"; model: ModelRef } | { backend: "off" } | JevReviewerConfig;

/** 各层配置字段共用的 schema（config.md 第 2 节）；程序从不改写 config.json */
export interface ConfigFile {
  /** false 时只使用本地 models.dev 数据，不联网刷新 */
  modelsDev?: false | undefined;
  model?: string | undefined;
  /** 会话默认思考档位（ADR-0018 第 4 节）：七档中性值之一 */
  reasoningEffort?: ReasoningEffort | undefined;
  /**
   * shell 选择（ADR-0022 第 2 节）：auto | pwsh | powershell | bash | cmd | sh。
   * 经通用配置链后写优先，保留 shell 声明边界（ADR-0034）；
   * 未声明时由平台自动选择。
   */
  shell?: string | undefined;
  /** 非标准安装位置的可执行文件；种类仍由 shell 决定（ADR-0022） */
  shellPath?: string | undefined;
  providers?: ProviderEntryConfig[] | undefined;
  permission?: { reviewer?: SecurityReviewerConfig | undefined } | undefined;
  permissions?:
    | {
        preset?: PermissionPresetName | undefined;
        rules?: PermissionRule[] | undefined;
      }
    | undefined;
  turn?: TurnOverrides | undefined;
  /** Hook 配置（hooks.md 第 2 节）：事件点 → 条目数组，层间追加 */
  hooks?: Partial<Record<HookPoint, HookEntry[]>> | undefined;
  /** MCP 配置（mcp.md 第 2 节）：servers 按名字逐条合并 */
  mcp?:
    | {
        servers?: Record<string, McpServerEntry> | undefined;
      }
    | undefined;
}

/** 一层合并后的结果（config.md 第 1 节） */
export interface ResolvedConfig {
  providerThinkingWarnings?: string[] | undefined;
  model?: string | undefined;
  permissionPreset?: PermissionPresetName | undefined;
  permissionReviewer?: SecurityReviewerConfig | undefined;
  /** 会话默认思考档位（ADR-0018）：未配置时 undefined（off 语义） */
  reasoningEffort?: ReasoningEffort | undefined;
  /** 手写 config.json 层的 shell 选择原文（ADR-0022）；未配置时 undefined */
  shell?: string | undefined;
  /** 手写 config.json 层的 shellPath 原文（ADR-0022） */
  shellPath?: string | undefined;
  /** 可信规则序列，按层序排列（后写优先）：user < project < env < cli */
  rules: AnnotatedRule[];
  /**
   * 未信任项目配置中仅收紧方向（ask / deny）的规则，origin 恒为
   * "project-untrusted"；与可信结果取更严格者（permissions.md 5.2）
   */
  untrustedRules: AnnotatedRule[];
  providers: ProviderEntryConfig[];
  turn: TurnOverrides;
  /** 合并后的 Hook 条目：按层序追加（user → project） */
  hooks: Partial<Record<HookPoint, HookEntry[]>>;
  /** 合并后的 MCP 服务器（带来源标注）；项目层只在信任时并入 */
  mcpServers: {
    name: string;
    origin: "user" | "project";
    entry: McpServerEntry;
    /** 定义该条目的配置文件所在目录（相对路径的解析基点） */
    dir?: string | undefined;
  }[];
  /** 加载与降级过程中产生的警告（人读说明） */
  warnings: string[];
}

/** 项目 Grant 的持久化句柄（config.md 第 4 节）；权限层只面对内存集合 */
export interface GrantStore {
  list(): Grant[];
  /** 追加一条并原子重写文件；失败时抛错，由调用方降级为会话 Grant */
  add(grant: Grant): Promise<void>;
}

export interface WorkspaceConfig {
  /** base + 项目层（按信任裁剪）后的合并结果 */
  resolved: ResolvedConfig;
  /** 项目配置的存在性与信任状态（未信任时 CLI 提示 nctrn trust） */
  projectConfig: { present: boolean; trusted: boolean; path?: string | undefined };
  /** 工作区项目 Grant（含持久化） */
  grants: GrantStore;
}

/** 命令行参数层输入（apps/cli 把解析结果原样传入） */
export interface CliConfigArgs {
  model?: string | undefined;
  apiType?: string | undefined;
  baseUrl?: string | undefined;
  apiKeyEnv?: string | undefined;
}

// ── 凭据与向导配置（provider-setup.md 第 2、3、6 节） ──────

/** 凭据后端标识（界面提示与测试断言用） */
export type CredentialBackend = "dpapi" | "keychain" | "libsecret" | "memory" | "none";

/**
 * 统一凭据存储接口（provider-setup.md 第 3 节）。
 * 密钥不以明文落盘：交给操作系统后端（DPAPI / 钥匙串 / Secret Service），
 * credentials.json 索引只记录后端与密文元数据。get 结果在实现内按
 * providerId 缓存，set/delete 使对应条目失效。
 */
export interface CredentialStore {
  /** 取出该服务商的密钥；索引无此 id 或后端取出失败时返回 undefined */
  get(providerId: string): Promise<string | undefined>;
  /** 写入/更新密钥并登记索引；后端不可用时拒绝 */
  set(providerId: string, key: string): Promise<void>;
  /** 删除密钥与索引条目；不存在时无操作 */
  delete(providerId: string): Promise<void>;
  /** 索引中是否登记了该服务商（不解密、不起子进程；describeProviders 用） */
  has(providerId: string): boolean;
  /** 当前后端标识 */
  backend(): CredentialBackend;
}

/** 向导写入的 <NOCTURNE_HOME>/providers.json（provider-setup.md 第 2 节） */
export interface ProviderSetupFile {
  version: 1;
  /** 默认模型，"provider/model" 形式；只在向导里选择"设为默认"时写入 */
  model?: string | undefined;
  providers?: ProviderEntryConfig[] | undefined;
}

/** /provider 列表条目（不含密钥；provider-setup.md 第 1 节） */
export interface ProviderOverview {
  id: string;
  type: "openai-compatible" | "anthropic";
  /** baseURL 的主机名；无 baseURL（Anthropic 官方端点）时为 undefined */
  host?: string | undefined;
  /** 密钥来源：凭据文件 / 环境变量（envName 给出变量名）/ 缺失 */
  keySource: "credential" | "env" | "missing";
  /** keySource="env" 或条目声明了 apiKeyEnv 时的变量名 */
  keyEnvName?: string | undefined;
  /** 定义该条目的最高层（后写优先的胜出者） */
  origin: "setup" | "user" | "project" | "env" | "cli";
  /** 向导条目被更高层同名条目覆盖（/provider 标注"被 config.json 覆盖"） */
  overridden: boolean;
  /** 声明的模型数 */
  modelCount: number;
  /** 条目可由向导管理（写入 providers.json）；其他层的条目只读 */
  managed: boolean;
}

/** 上游模型信息（provider-setup.md 第 7 节字段映射的产物；纯数据） */
export interface UpstreamModelEntry {
  id: string;
  displayName?: string | undefined;
  contextWindow?: number | undefined;
  maxOutputTokens?: number | undefined;
  pricing?: { input?: number | undefined; output?: number | undefined } | undefined;
  capabilities?:
    | {
        reasoning?: "none" | "hidden" | "visible" | undefined;
        imageInput?: boolean | undefined;
      }
    | undefined;
  /** 上游 supported_endpoints 原文（ADR-0026 第 2 节；协议推导的输入事实） */
  endpoints?: string[] | undefined;
}

/** 内置模型目录查询（provider 层 BUILTIN_MODEL_CATALOG 的注入点——config 不依赖 provider） */
export type BuiltinModelLookup = (
  providerId: string,
  modelId: string,
) =>
  | {
      displayName?: string | undefined;
      contextWindow?: number | undefined;
      maxOutputTokens?: number | undefined;
      capabilities?:
        | {
            reasoning?: "none" | "hidden" | "visible" | undefined;
            imageInput?: boolean | undefined;
            /** 内置目录声明的编辑工具（ADR-0035 §5） */
            editTool?: EditToolKind | undefined;
          }
        | undefined;
    }
  | undefined;

/**
 * 上游模型列表获取器（provider 模块的 fetchModels 注入点——
 * config 不依赖 provider，上游字段映射的解释在 provider 层）。
 */
export type UpstreamFetch = (
  entry: ProviderEntryConfig,
  key: string | undefined,
  signal?: AbortSignal,
) => Promise<UpstreamModelEntry[]>;

// ── 模型设置编辑（ADR-0024 第 2、3 节） ─────────────────────

/** 单个字段生效值的来源标注（编辑页/CLI 问答显示用） */
export type ModelFieldSource =
  | { kind: "modelsDev" }
  | { kind: "upstream" }
  | { kind: "user" }
  | { kind: "config"; layer: "user" | "project" | "env" | "cli"; path?: string | undefined }
  | { kind: "builtin" }
  | { kind: "default" }
  /** reasoningEffort：由 reasoning ≠ "none" 推导的全档；protocol：由 endpoints 推导 */
  | { kind: "derived" }
  /** 仅 protocol（ADR-0026 第 2 节）：回落到服务商条目 type */
  | { kind: "entryType" };

/** 一个可编辑字段：生效值、来源、可否在编辑页修改、当前用户编辑值 */
export interface ModelField<T> {
  value: T | undefined;
  source: ModelFieldSource;
  editable: boolean;
  /** userModels 中该字段的用户编辑值（未编辑为 undefined） */
  userValue?: T | undefined;
  /**
   * 清空用户编辑后回落到的值（= userModels 层不参与合并时的生效值；
   * 编辑页「跟随」行的灰色提示）
   */
  lowerValue?: T | undefined;
}

/** listModelSettings 返回的逐模型视图 */
export interface ModelSettingsView {
  providerId: string;
  modelId: string;
  /** 服务商条目不在 providers.json：整页只读 */
  readonly: boolean;
  /** 只读时的说明（如 "该服务商定义在 <path>，请编辑该文件"） */
  readonlyHint?: string | undefined;
  fields: {
    displayName: ModelField<string>;
    contextWindow: ModelField<number>;
    maxOutputTokens: ModelField<number>;
    reasoning: ModelField<"none" | "hidden" | "visible">;
    imageInput: ModelField<boolean>;
    reasoningEffort: ModelField<ReasoningEffortLevel[]>;
    /**
     * 生效协议（ADR-0026 第 7 节）：value 为生效的协议；
     * 推导结果为 unavailable 时 value 为 undefined、unavailable 给出原因。
     */
    protocol: ModelField<ModelProtocol>;
    /** 编辑工具（ADR-0035 §5）：value 恒有值（默认表兜底） */
    editTool: ModelField<EditToolKind>;
  };
  /** 模型当前不可用时的原因（协议推导为 unavailable，ADR-0026 第 5 节） */
  unavailable?: { reason: string } | undefined;
}

/**
 * saveModelSettings 的补丁：键存在才处理——
 * undefined 值保留现状（不写），null 清除该字段的用户编辑，其余写为用户编辑。
 */
export type ModelSettingsPatch = {
  [K in keyof ModelSettingsView["fields"]]?: ModelSettingsView["fields"][K]["value"] | null;
};

export interface SettingItem {
  reviewer?: {
    effective: SecurityReviewerConfig | undefined;
    saved: SecurityReviewerConfig | undefined;
  };
  key: "permission.reviewer" | "permissions.preset" | "reasoningEffort" | "shell" | "defaultModel";
  effective: string | undefined;
  source: "default" | "setup" | "settings" | "user" | "project" | "env" | "cli";
  saved: string | undefined;
  overridden: boolean;
  readonly?: true;
}

/** 默认档位随默认模型经 setDefaultModel 成对保存，不在此单独修改（ADR-0034 修订） */
export type SettingsPatch = Partial<{
  "permissions.preset": PermissionPresetName | null;
  "permission.reviewer": SecurityReviewerConfig | null;
}>;

/**
 * loadConfig 的产物（config.md 第 6 节）。
 * base 不含项目层；forWorkspace 按会话 workspaceRoot 加载项目层与 Grant。
 */
export interface RuntimeConfig {
  readonly nocturneHome: string;
  readonly sessionsDir: string;
  /** 工具输出落盘根目录（sessionsDir 推导，tools.md 第 4 节） */
  readonly attachmentsDir: string;
  readonly grantsDir: string;
  /** providers.json 损坏/版本不符时的人读说明（runtime.warning 的 provider_setup_invalid） */
  readonly providerSetupWarning?: string | undefined;
  base: ResolvedConfig;
  forWorkspace(workspaceRoot: string): Promise<WorkspaceConfig>;
  /** nctrn trust / untrust：原子写 <NOCTURNE_HOME>/trust.json */
  setWorkspaceTrusted(workspaceRoot: string, trusted: boolean): Promise<void>;

  /** 统一凭据存储（provider-setup.md 第 3 节）；get 结果进程内缓存 */
  readonly credentials: CredentialStore;
  /**
   * 向导写入/更新服务商条目（providers.json）。key 存在时经
   * credentials.set 写入系统后端并登记索引。旧 model 只保留，不再写入。
   * entry.models 携带上游声明的能力/价格字段（第 7 节）。
   */
  saveSetupProvider(entry: ProviderEntryConfig, opts?: { key?: string | undefined }): Promise<void>;
  /** 更新密钥（经 credentials.set；缓存失效后下一次请求即用新密钥） */
  setCredential(providerId: string, key: string): Promise<void>;
  /** 添加/刷新模型列表时更新 models.dev 缓存；失败返回一行提示。 */
  refreshModelsDev(): Promise<string | undefined>;
  /**
   * 模型设置编辑（ADR-0024）：按字段返回生效值/来源/可编辑标记的清单
   * （只含合并结果清单内的模型）。workspaceRoot 决定项目层是否参与。
   */
  listModelSettings(providerId: string, workspaceRoot?: string): Promise<ModelSettingsView[]>;
  /**
   * 模型设置编辑的写入端：patch 应用到 providers.json 条目的 userModels。
   * 校验失败抛 ConfigError("config_invalid") 且不写文件；绝不写 config.json。
   */
  saveModelSettings(
    providerId: string,
    modelId: string,
    patch: ModelSettingsPatch,
    workspaceRoot?: string,
  ): Promise<void>;
  /**
   * 删除向导写入的条目及其凭据。条目不在 providers.json（由更高层
   * 定义或不存在）时抛 ConfigError("config_invalid")，由调用方提示。
   */
  removeSetupProvider(providerId: string): Promise<void>;
  /**
   * /provider 列表数据：逐层合并后的服务商总览（密钥来源、来源层、
   * 模型数、是否被高层覆盖）。给 workspaceRoot 时并入该工作区可信
   * 项目层的条目。
   */
  describeProviders(workspaceRoot?: string): Promise<ProviderOverview[]>;
  /** /provider refresh：重新从上游获取模型列表与限额并写回 providers.json */
  refreshUpstreamLimits(providerId: string): Promise<string | undefined>;
  describeSettings(workspaceRoot?: string, shellEnv?: string): SettingItem[];
  resolvedSettings(workspaceRoot?: string, shellEnv?: string): ResolvedConfig;
  updateSettings(patch: SettingsPatch): Promise<void>;
  setDefaultModel(model: string, reasoningEffort: ReasoningEffort | null): Promise<void>;

  /**
   * settings.json 当前的 shell 层值原文（ADR-0022 第 3 节；live 快照——
   * setShellSetting 写盘后立即可见）。未设置时返回 undefined。
   */
  shellSetting(): { shell?: string | undefined; shellPath?: string | undefined } | undefined;
  /**
   * /shell 的写入端（ADR-0022 第 4 节）：原子写 settings.json。
   * kind 为种类名或 "auto"——auto 时清除 shell/shellPath 字段；
   * 具体种类时写 shell（path 存在时同写 shellPath，否则清除）。
   */
  setShellSetting(kind: string, path?: string): Promise<void>;
  /** settings.json 顶层字符串偏好；无值或非字符串时返回 undefined。 */
  getPreference(key: string): string | undefined;
  /** 原子写入或删除普通偏好；拒绝 shell、shellPath 等保留字段。 */
  setPreference(key: string, value: string | undefined): Promise<void>;
  /** recent-models.json 当前内容（"provider/model" 形式，新→旧，最多 10 条；loadConfig 时预读的缓存） */
  recentModels(): ModelRef[];
  /** setModel/新建会话时记录最近使用（去重、置顶、原子写） */
  recordRecentModel(ref: ModelRef): Promise<void>;
}

export interface LoadConfigOptions {
  /** 测试注入 models.dev fetch；默认使用全局 fetch。 */
  modelsDevFetch?: typeof fetch | undefined;
  cliArgs?: CliConfigArgs | undefined;
  /** 测试注入；缺省取 platform.nocturneHome() */
  nocturneHome?: string | undefined;
  /** 测试注入环境变量读取器；缺省 platform.env */
  env?: ((name: string) => string | undefined) | undefined;
  /** 测试注入凭据存储；缺省按平台探测系统后端 */
  credentials?: CredentialStore | undefined;
  /**
   * /provider refresh 的上游获取实现（core/index 注入 provider 层的
   * fetchModels）；缺省时 refreshUpstreamLimits 拒绝并说明。
   */
  upstreamFetch?: UpstreamFetch | undefined;
  /**
   * 内置模型目录查询（core 侧注入 provider/catalog 的 BUILTIN_MODEL_CATALOG）：
   * listModelSettings 标 "builtin" 来源用；缺省时内置层视为不存在（字段落"默认"）。
   */
  builtinModel?: BuiltinModelLookup | undefined;
}
