/**
 * 服务商 / 模型启停的纯文案（ADR-0054 §5）：
 * 停用前的页内确认要列出「受影响的打开会话数 / 默认模型 / 模型角色」，
 * 由 Core `describeToggleImpact` 返回（TUI 不自行判断谁在用）。
 * 只依赖 @nocturne/core 的类型，不加载 Ink。
 */
import type { ToggleImpact } from "@nocturne/core";

/** 模型角色中文名（describeToggleImpact 的角色列表） */
export const TOGGLE_ROLE_LABELS: Record<ToggleImpact["roles"][number], string> = {
  task: "default 档位模型",
  vision: "看图模型",
  smol: "轻量模型",
};

/** 影响面是否非空：非空才需要停用前确认（ADR-0054 §5） */
export function hasToggleImpact(impact: ToggleImpact): boolean {
  return impact.affectedSessions > 0 || impact.defaultModel || impact.roles.length > 0;
}

/** 停用确认行：`停用 <对象> 会影响：<片段> — y 确认 / n 取消` */
export function toggleConfirmText(subject: string, impact: ToggleImpact): string {
  const parts: string[] = [];
  if (impact.affectedSessions > 0) parts.push(`${impact.affectedSessions} 个打开的会话`);
  if (impact.defaultModel) parts.push("默认模型");
  for (const role of impact.roles) parts.push(TOGGLE_ROLE_LABELS[role]);
  return `停用${subject}会影响：${parts.length > 0 ? parts.join("、") : "无"} — y 确认 / n 取消`;
}
