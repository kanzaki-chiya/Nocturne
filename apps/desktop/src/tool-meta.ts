/**
 * 工具行的展示名（DESIGN.md §8「工具行用中文名称」）：内置工具、Ensemble 工具与 MCP 工具
 * 显示给用户的名称。桌面端、手机网页与子代理面板共用；只含纯数据与纯函数，不依赖 React。
 */
import { noteItemsFromCompletion, type NoteItem, type ToolEntry } from "@nocturne/core/protocol";

export const TOOL_META: Record<string, string> = {
  todo_write: "任务清单",
  note_write: "笔记",
  update_goal: "目标",
  render_html: "页面",
  Artifact: "作品",
  ArtifactData: "作品数据",
  ArtifactComments: "作品评论",
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
  shell_output: "命令输出",
  shell_kill: "停止命令",
  web_fetch: "读取网页",
  web_search: "网页搜索",
  subagent: "子代理",
  task: "子代理",
  finish: "提交结果",
  ask_user: "提问",
  schedule: "定时任务",
  mcp_search: "搜索 MCP 工具",
  mcp_call: "调用 MCP 工具",
  ensemble_init: "合奏",
  ensemble_add_member: "添加",
  ensemble_post: "发帖",
  ensemble_read: "留言板",
  ensemble_overview: "概览",
  ensemble_change_model: "换模型",
  ensemble_remove_member: "移除",
  ensemble_end: "结束",
  ensemble_checkout: "检出",
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

/** 从成功的 `note_write` 工具条目提取更新后的完整笔记列表。 */
export function noteItemsFromEntry(
  entry: Pick<ToolEntry, "name" | "target" | "status" | "result">,
): NoteItem[] | undefined {
  const name = entry.target?.name ?? entry.name ?? "";
  if (name !== "note_write" || entry.status !== "ok") return undefined;
  const output = entry.result?.output;
  const strict = noteItemsFromCompletion({ name, status: entry.status, output });
  if (strict !== undefined) return strict;
  if (output === null || typeof output !== "object" || Array.isArray(output)) return undefined;
  const raw = (output as { notes?: unknown }).notes;
  if (!Array.isArray(raw)) return undefined;
  const out: NoteItem[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
    const { n, text } = item as { n?: unknown; text?: unknown };
    if (typeof n === "number" && Number.isInteger(n) && n >= 1 && typeof text === "string") {
      out.push({ n, text });
    }
  }
  return out;
}

/** 从 `note_write` 输入提取首条新增笔记的单行摘要；只删除或无有效文本时返回空串。 */
export function noteFirstAddedText(input: unknown): string {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return "";
  const add = (input as { add?: unknown }).add;
  if (!Array.isArray(add)) return "";
  for (const item of add) {
    if (typeof item !== "string") continue;
    const singleLine = item.trim().replace(/\r?\n+/g, " ");
    if (singleLine !== "") return singleLine;
  }
  return "";
}

/** `note_write` 工具行参数摘要：成功取 `output.notes.length` 构成「N 条」，有 `add` 时附首条新增原文。 */
export function noteWriteSummary(
  entry: Pick<ToolEntry, "name" | "target" | "status" | "input" | "result">,
): { count: string; note: string; text: string } | undefined {
  const name = entry.target?.name ?? entry.name ?? "";
  if (name !== "note_write") return undefined;
  const notes = noteItemsFromEntry(entry);
  const count = notes !== undefined ? `${notes.length} 条` : "";
  const rawInput = entry.target !== undefined ? entry.target.input : entry.input;
  const note = noteFirstAddedText(rawInput);
  const text = count !== "" && note !== "" ? `${count} ${note}` : count || note;
  return { count, note, text };
}
