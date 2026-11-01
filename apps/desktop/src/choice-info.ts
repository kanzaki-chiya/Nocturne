/**
 * 权限预设与思考档位的中文名：设置页下拉、输入框的权限与思考档位菜单都从这里取
 *（预设语义见 docs/architecture/permissions.md 第 6 节）。
 */
import { PERMISSION_PRESET_NAMES, type PermissionPresetName } from "@nocturne/core/protocol";

import type { DropdownOption } from "./Dropdown";

const PRESET_INFO: Record<PermissionPresetName, string> = {
  "read-only": "只读",
  default: "默认",
  "auto-edit": "自动编辑",
  guarded: "守护",
  smart: "智能",
  bypass: "全部放行",
};

/** 危险项：排在分隔线之后，用警告色 */
const RISKY_PRESETS: ReadonlySet<string> = new Set<PermissionPresetName>(["bypass"]);

const EFFORT_INFO: Record<string, string> = {
  off: "关闭",
  minimal: "极少",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "很高",
  max: "最高",
};

export function presetOption(name: string): DropdownOption {
  const tag = (PRESET_INFO as Record<string, string | undefined>)[name];
  return {
    value: name,
    label: name,
    ...(tag !== undefined ? { tag } : {}),
    ...(RISKY_PRESETS.has(name) ? { risk: true } : {}),
  };
}

export function presetOptions(): DropdownOption[] {
  return PERMISSION_PRESET_NAMES.map(presetOption);
}

export function effortOption(level: string): DropdownOption {
  const tag = EFFORT_INFO[level];
  return {
    value: level,
    label: level,
    ...(tag !== undefined ? { tag } : {}),
  };
}
