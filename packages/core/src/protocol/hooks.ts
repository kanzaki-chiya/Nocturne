import type { HookPoint } from "./types.js";

/** Hook 事件点规范顺序（hooks.md 第 1 节） */
export const HOOK_POINTS: readonly HookPoint[] = [
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "TurnStart",
  "TurnEnd",
  "UserPromptSubmit",
  "SessionStart",
  "SubagentStart",
  "SessionEnd",
];

/** 支持工具名通配符 `matcher` 的事件点（hooks.md 第 2 节） */
export const TOOL_HOOK_POINTS: readonly HookPoint[] = [
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
];

export function isToolHookPoint(point: HookPoint): boolean {
  return point === "PreToolUse" || point === "PermissionRequest" || point === "PostToolUse";
}

export const DEFAULT_HOOK_TIMEOUT_MS = 5_000;
export const MAX_HOOK_TIMEOUT_MS = 60_000;

export type HookOrigin = "user" | "project";

export interface HookOverview {
  point: HookPoint;
  /** 仅工具相关点位（PreToolUse / PermissionRequest / PostToolUse）有效 */
  matcher?: string | undefined;
  command: string;
  args: string[];
  /** 生效超时毫秒数（已应用缺省 5000 与上限 60000） */
  timeoutMs: number;
  origin: HookOrigin;
  /** 来源配置文件路径（用户级 config.json 或项目级 .nocturne/config.json） */
  path: string;
  /** 用户级恒为 true；项目级按 trust.json 判定，false 表示未信任（不生效） */
  trusted: boolean;
}

export interface HooksDescription {
  hooks: HookOverview[];
  warnings: string[];
}
