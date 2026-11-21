import type {
  HookEntry,
  HookPoint,
  McpServerEntry,
  PluginHost,
  PluginOverview,
  ReasoningEffort,
} from "../protocol/index.js";

export const SUPPORTED_PLUGIN_HOOK_POINTS = new Set<string>([
  "SessionStart",
  "UserPromptSubmit",
  "SubagentStart",
  "SessionEnd",
]);

export type PluginManifestKind = "nocturne" | "codex" | "claude";

/** 插件 Hook 的运行时元数据（仅 Core 内部使用，不写入用户 config.json schema） */
export interface PluginHookSpec {
  /** "<name>@<marketplace>" */
  pluginLabel: string;
  host: PluginHost;
  /** native：自有清单 9 点位 Nocturne 契约；compat：Codex/Claude 4 点位兼容翻译 */
  mode: "native" | "compat";
  /** 兼容清单下的实际宿主调用规则 */
  compatHost?: "codex" | "claude" | undefined;
  pluginRoot: string;
  pluginDataDir: string;
  /** 本平台实际选用的原始命令文本（未展开占位符） */
  rawCommand: string;
  /** exec 形式的参数数组（未展开占位符）；自有清单与 Claude exec 形式使用 */
  rawArgs?: string[] | undefined;
  /** Claude shell 形式的 shell 字段 */
  shell?: "bash" | "powershell" | undefined;
}

export type PluginHookEntry = HookEntry & { plugin: PluginHookSpec };

export interface PluginSkillDir {
  path: string;
  /** "<name>@<marketplace>" */
  plugin: string;
  pluginDisplayName: string;
  pluginIcon?: string | undefined;
}

export interface PluginMcpServerSpec {
  id: string;
  pluginId: string;
  pluginLabel: string;
  pluginRoot: string;
  pluginDataDir: string;
  entry: McpServerEntry;
  /** 启用插件解析出的 MCP 工具缓存键（内置用 version，已安装用 fingerprint） */
  cache?:
    | {
        pluginId: string;
        keyKind: "version" | "fingerprint";
        keyValue: string;
      }
    | undefined;
}

export interface PluginSubagentSpec {
  /** 档位 id：`<插件 name>:<子代理 name>` */
  id: string;
  /** 子代理名（frontmatter name） */
  name: string;
  /** 来源插件 id，如 `nocturne:pptx@builtin` */
  pluginId: string;
  /** 来源插件 name，如 `pptx` */
  pluginName: string;
  /** 来源插件显示名，如 `演示文档` */
  pluginDisplayName: string;
  /** `<name>@<marketplace>` */
  pluginLabel: string;
  description: string;
  /** 角色说明正文（已去首尾空白，非空，<= 10,000 字） */
  prompt: string;
  effort?: ReasoningEffort | undefined;
  tools?: readonly string[] | undefined;
}

export interface DiscoveredPlugin {
  overview: Omit<PluginOverview, "state">;
  hooks: Partial<Record<HookPoint, PluginHookEntry[]>>;
  skillDirs: PluginSkillDir[];
  mcpServers: PluginMcpServerSpec[];
  agents: PluginSubagentSpec[];
  /** 未解析 realpath 前的原始根目录（用于检测根自身是否为符号链接） */
  rawRoot: string;
}

export interface PluginDiscoveryOptions {
  nocturneHome: string;
  builtinPluginsDir?: string | undefined;
  codexHome?: string | undefined;
  claudeHome?: string | undefined;
  /** 覆写 ${NOCTURNE_NODE}（缺省 process.execPath） */
  nodePath?: string | undefined;
  /** 配置文件与注入的 MCP 服务器名集合（小写），用于标记插件同名冲突 */
  reservedMcpIds?: ReadonlySet<string> | undefined;
}
