import type { HookPoint } from "./types.js";

export type PluginHost = "nocturne" | "codex" | "claude";

export type PluginState = "off" | "on" | "changed";

export type PluginUnsupportedReason = "point" | "type" | "async" | "user_config";

export type PluginMcpSkipReason = "http" | "stored" | "conflict" | "invalid";

export interface PluginHookOverview {
  point: HookPoint;
  matcher?: string | undefined;
  /** 本平台实际选用的命令文本（未展开占位符） */
  command: string;
}

export interface PluginUnsupportedHook {
  point: string;
  reason: PluginUnsupportedReason;
}

export interface PluginMcpServerOverview {
  id: string;
  /** 命令与参数摘要（未展开占位符）；跳过条目可能省略 */
  command?: string | undefined;
  skipped?: boolean | undefined;
  skipReason?: PluginMcpSkipReason | undefined;
}

export interface PluginUiSurfaceOpen {
  tool: string;
  fileTypes: string[];
}

export interface PluginUiSurfaceOverview {
  id: string;
  title: string;
  server: string;
  resourceUri: string;
  open?: PluginUiSurfaceOpen | undefined;
}

/** 当前会话可用的插件面板 surface（ADR-0101 第 4、5、7 节） */
export interface SessionAppSurface {
  pluginId: string;
  pluginName: string;
  icon?: string | undefined;
  id: string;
  title: string;
  serverId: string;
  resourceUri: string;
  open?: PluginUiSurfaceOpen | undefined;
}

export interface PluginOverview {
  id: string;
  host: PluginHost;
  name: string;
  marketplace: string;
  version: string;
  root: string;
  displayName?: string | undefined;
  description?: string | undefined;
  icon?: string | undefined;
  state: PluginState;
  hooks: PluginHookOverview[];
  unsupported: PluginUnsupportedHook[];
  skills: string[];
  mcpServers: PluginMcpServerOverview[];
  surfaces?: PluginUiSurfaceOverview[] | undefined;
  warnings: string[];
}

export interface PluginsDescription {
  plugins: PluginOverview[];
  warnings: string[];
}
