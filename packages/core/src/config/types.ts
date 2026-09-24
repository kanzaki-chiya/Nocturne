/**
 * 配置层类型（config.md 第 1、2、6 节）。
 * 本模块只做加载、校验、合并、标注来源；规则的解释在 permission，
 * Provider 配置的解释在 provider（config 不依赖它们，字段形状按
 * RuntimeOptions.providerConfigs 的元素对齐，由 core/index 装配时分发）。
 */
import type {
  AnnotatedRule,
  Grant,
  HookEntry,
  HookPoint,
  McpServerEntry,
  PermissionPresetName,
  PermissionRule,
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
        reasoningEffort?: string[] | undefined;
        imageInput?: boolean | undefined;
        promptCache?: boolean | undefined;
      }
    | undefined;
}

/**
 * 声明式 Provider 配置条目（config.md 第 2 节：
 * 形状即 RuntimeOptions.providerConfigs 的元素）。
 * 凭据值不允许出现——只允许 apiKeyEnv 指向环境变量名。
 */
export interface ProviderEntryConfig {
  id: string;
  /** 适配器类型；缺省 openai-compatible */
  type?: "openai-compatible" | "anthropic" | undefined;
  baseURL?: string | undefined;
  /** 环境变量名（不是凭据值） */
  apiKeyEnv: string;
  models?: Record<string, ModelOverrideShape> | undefined;
  allowUndeclaredModels?: boolean | undefined;
  providerOptions?: Record<string, unknown> | undefined;
  headers?: Record<string, string> | undefined;
}

/** Turn 参数覆盖（结构与 agent 的 TurnConfig 对齐，config 不依赖 agent） */
export interface TurnOverrides {
  maxSteps?: number | undefined;
  retryLimit?: number | undefined;
  retryBaseDelayMs?: number | undefined;
  firstEventTimeoutMs?: number | undefined;
  idleTimeoutMs?: number | undefined;
}

/** 各层配置文件共用的 schema（config.md 第 2 节）；程序从不改写这些文件 */
export interface ConfigFile {
  model?: string | undefined;
  providers?: ProviderEntryConfig[] | undefined;
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
  model?: string | undefined;
  permissionPreset?: PermissionPresetName | undefined;
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
  base: ResolvedConfig;
  forWorkspace(workspaceRoot: string): Promise<WorkspaceConfig>;
  /** nctrn trust / untrust：原子写 <NOCTURNE_HOME>/trust.json */
  setWorkspaceTrusted(workspaceRoot: string, trusted: boolean): Promise<void>;
}

export interface LoadConfigOptions {
  cliArgs?: CliConfigArgs | undefined;
  /** 测试注入；缺省取 platform.nocturneHome() */
  nocturneHome?: string | undefined;
  /** 测试注入环境变量读取器；缺省 platform.env */
  env?: ((name: string) => string | undefined) | undefined;
}
