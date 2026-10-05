/**
 * 权限预设与思考档位的中文名和一句说明：设置页下拉、状态栏的权限与思考档位菜单
 * 都从这里取，说明只维护这一份（预设语义见 docs/architecture/permissions.md 第 6 节）。
 */
import { PERMISSION_PRESET_NAMES, type PermissionPresetName } from "@nocturne/core/protocol";

import type { DropdownOption } from "./Dropdown";

const PRESET_INFO: Record<PermissionPresetName, { tag: string; description: string }> = {
  "read-only": { tag: "只读", description: "不改文件；命令、联网都要确认" },
  default: { tag: "默认", description: "读工作区放行；改文件和命令都要确认" },
  "auto-edit": { tag: "自动编辑", description: "工作区内改文件放行；命令要确认" },
  guarded: { tag: "守护", description: "工作区内全部放行；工作区外编辑要确认" },
  smart: { tag: "智能", description: "同 guarded，剩余确认先交给安全审查判断" },
  bypass: { tag: "全部放行", description: "只保留凭据等硬拒绝，谨慎使用" },
};

/** 危险项：排在分隔线之后，用警告色 */
const RISKY_PRESETS: ReadonlySet<string> = new Set<PermissionPresetName>(["bypass"]);

const EFFORT_INFO: Record<string, { tag: string; description: string }> = {
  off: { tag: "关闭", description: "不请求思考，回答最快" },
  minimal: { tag: "极少", description: "只做最少的思考" },
  low: { tag: "低", description: "简单问题，响应快" },
  medium: { tag: "中", description: "速度与质量的折中" },
  high: { tag: "高", description: "复杂任务，多想一会儿" },
  xhigh: { tag: "很高", description: "难题，耗时与用量明显增加" },
  max: { tag: "最高", description: "尽可能多地思考，最慢" },
};

export function presetOption(name: string): DropdownOption {
  const info = (PRESET_INFO as Record<string, { tag: string; description: string } | undefined>)[
    name
  ];
  return {
    value: name,
    label: name,
    ...(info !== undefined ? { tag: info.tag, description: info.description } : {}),
    ...(RISKY_PRESETS.has(name) ? { risk: true } : {}),
  };
}

export function presetOptions(): DropdownOption[] {
  return PERMISSION_PRESET_NAMES.map(presetOption);
}

export function effortOption(level: string): DropdownOption {
  const info = EFFORT_INFO[level];
  return {
    value: level,
    label: level,
    ...(info !== undefined ? { tag: info.tag, description: info.description } : {}),
  };
}
