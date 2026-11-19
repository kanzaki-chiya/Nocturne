import type { HookPoint } from "./types.js";

export type PluginHost = "codex" | "claude";

export type PluginState = "off" | "on" | "changed";

export type PluginUnsupportedReason = "point" | "type" | "async" | "user_config";

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
  warnings: string[];
}

export interface PluginsDescription {
  plugins: PluginOverview[];
  warnings: string[];
}
