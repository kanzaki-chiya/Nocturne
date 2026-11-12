/**
 * 工具行的展示名（DESIGN.md §8「工具行用中文名称」）：内置工具、Swarm 工具与 MCP 工具
 * 显示给用户的名称。桌面端、手机网页与子代理面板共用；只含纯数据与纯函数，不依赖 React。
 */
import type { ToolEntry } from "@nocturne/core/protocol";

export const TOOL_META: Record<string, string> = {
  todo_write: "任务清单",
  render_html: "页面",
  skill: "技能",
  read: "读取",
  grep: "搜索",
  glob: "查找文件",
  edit: "编辑",
  write: "写入",
  apply_patch: "应用补丁",
  apply_subagent_changes: "并回子代理改动",
  switch_worktree: "切换工作树",
  shell: "命令",
  web_fetch: "读取网页",
  web_search: "网页搜索",
  subagent: "子代理",
  task: "子代理",
  ask_user: "提问",
  schedule: "定时任务",
  mcp_search: "搜索 MCP 工具",
  swarm_init: "Swarm",
  swarm_add_member: "添加",
  swarm_post: "发帖",
  swarm_change_model: "换模型",
  swarm_remove_member: "移除",
  swarm_end: "结束",
  swarm_checkout: "检出",
};

const MCP_NAME_PREFIX = "mcp__";

/**
 * MCP 工具的展示名：与权限主体、设置页一致的 `server/tool`。
 * 结构化来源优先——subjects 里 kind 为 "mcp" 的主体 target 就是 `server/tool`；
 * 没有 subjects（如实时工具行）时从注册名 `mcp__<server>__<tool>` 解析，去掉前缀。
 */
export function mcpToolLabel(name: string, subjects?: ToolEntry["subjects"]): string | undefined {
  if (name.startsWith("mcp__computer__")) return "电脑操控";
  const subject = subjects?.find((entry) => entry.kind === "mcp");
  if (subject !== undefined) return subject.target;
  if (!name.startsWith(MCP_NAME_PREFIX)) return undefined;
  const rest = name.slice(MCP_NAME_PREFIX.length);
  const sep = rest.indexOf("__");
  if (sep > 0) return `${rest.slice(0, sep)}/${rest.slice(sep + 2)}`;
  return rest === "" ? undefined : rest;
}

export function toolMeta(name: string, subjects?: ToolEntry["subjects"]): { label: string } {
  const known = TOOL_META[name];
  if (known !== undefined) return { label: known };
  const mcp = mcpToolLabel(name, subjects);
  if (mcp !== undefined) return { label: mcp };
  return { label: name };
}
