import type { HookEntry, HookPoint, PluginHost, PluginOverview } from "../protocol/index.js";

export const SUPPORTED_PLUGIN_HOOK_POINTS = new Set<string>([
  "SessionStart",
  "UserPromptSubmit",
  "SubagentStart",
  "SessionEnd",
]);

/** 插件 Hook 的运行时元数据（仅 Core 内部使用，不写入用户 config.json schema） */
export interface PluginHookSpec {
  /** "<name>@<marketplace>" */
  pluginLabel: string;
  host: PluginHost;
  pluginRoot: string;
  pluginDataDir: string;
  /** 本平台实际选用的原始命令文本（未展开占位符） */
  rawCommand: string;
  /** Claude exec 形式的参数数组（未展开占位符）；存在时走 exec 形式 */
  rawArgs?: string[] | undefined;
  /** Claude shell 形式的 shell 字段 */
  shell?: "bash" | "powershell" | undefined;
}

export type PluginHookEntry = HookEntry & { plugin: PluginHookSpec };

export interface PluginSkillDir {
  path: string;
  /** "<name>@<marketplace>" */
  plugin: string;
}

export interface DiscoveredPlugin {
  overview: Omit<PluginOverview, "state">;
  hooks: Partial<Record<HookPoint, PluginHookEntry[]>>;
  skillDirs: PluginSkillDir[];
  /** 未解析 realpath 前的原始根目录（用于检测根自身是否为符号链接） */
  rawRoot: string;
}

export interface PluginDiscoveryOptions {
  nocturneHome: string;
  codexHome?: string | undefined;
  claudeHome?: string | undefined;
}
