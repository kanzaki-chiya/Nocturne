/**
 * 后台子代理结果消息（ADR-0073 §3、§6）的客户端显示辅助：TUI 与桌面端共用，
 * 不显示 `<subagent-result>` 外壳。
 */
import type { SubagentResult } from "./events.js";
import type { ViewEntry, ToolEntry } from "./view.js";

export function subagentProfile(
  input: { profile?: unknown; preset?: unknown } | undefined,
): string {
  return typeof input?.profile === "string"
    ? input.profile
    : typeof input?.preset === "string"
      ? input.preset
      : "default";
}

/** 启动回执不代表任务完成；有结果消息时以结果状态为准。 */
export function backgroundToolStatus(
  entry: ToolEntry,
  entries: readonly ViewEntry[],
): string | undefined {
  const output = entry.result?.output as { background?: unknown } | undefined;
  if (entry.name !== "task" || output?.background !== true) return undefined;
  const result = entries.find(
    (item) => item.kind === "user" && item.subagent?.callId === entry.callId,
  );
  return result?.kind === "user" && result.subagent
    ? subagentResultStatus(result.subagent.status)
    : "后台运行中";
}

/** 去掉给模型看的 `<subagent-result …>` 头尾，只留正文；带改动时再去掉末尾给模型的合并说明（ADR-0075 §5） */
export function subagentResultText(text: string, hasChanges = false): string {
  const body = text
    .replace(/^<subagent-result[^>]*>\r?\n?/u, "")
    .replace(/\r?\n?<\/subagent-result>$/u, "");
  return hasChanges ? body.replace(/\r?\n\r?\nChanges \(\d+ files?\):\r?\n[\s\S]*$/u, "") : body;
}

export function subagentResultStatus(status: SubagentResult["status"]): string {
  return { ok: "完成", error: "失败", timeout: "超时", cancelled: "已取消", interrupted: "已中断" }[
    status
  ];
}

export interface PendingBackgroundSubagent {
  callId: string;
  childSessionId: string;
  profile: string;
  task: string;
}

/**
 * 从视图推导已启动、结果尚未写入对话的后台子代理（ADR-0073 §6）。远程连接不能用
 * subagent.list（观察方法只限本机），手机端据此列出可取消项；进程重启后这些条目
 * 已不在运行，取消会报 invalid_command。
 */
export function pendingBackgroundSubagents(
  entries: readonly ViewEntry[],
): PendingBackgroundSubagent[] {
  const delivered = new Set<string>();
  for (const entry of entries)
    if (entry.kind === "user" && entry.subagent !== undefined) delivered.add(entry.subagent.callId);
  return entries.flatMap((entry) => {
    if (entry.kind !== "tool" || entry.name !== "task" || delivered.has(entry.callId)) return [];
    const output = entry.result?.output as
      { background?: unknown; childSessionId?: unknown } | undefined;
    if (output?.background !== true || typeof output.childSessionId !== "string") return [];
    const input = entry.input as
      { profile?: unknown; preset?: unknown; task?: unknown } | undefined;
    return [
      {
        callId: entry.callId,
        childSessionId: output.childSessionId,
        profile: subagentProfile(input),
        task: typeof input?.task === "string" ? input.task : "",
      },
    ];
  });
}

/** `<档位> · <状态>`；补报条目或缺档位时按 default */
export function subagentApplyLine(output: unknown): string {
  const value = output as { files?: unknown[]; conflicts?: unknown[] } | undefined;
  return (value?.conflicts?.length ?? 0) > 0
    ? `有冲突 · ${value?.conflicts?.length ?? 0} 个文件`
    : `并回子代理改动 · ${value?.files?.length ?? 0} 个文件`;
}

export function subagentResultLine(result: SubagentResult): string {
  return `${result.profile ?? "default"} · ${subagentResultStatus(result.status)}${result.changes ? ` · 改动 ${result.changes.files.length} 个文件 · ${result.changes.branch}` : ""}`;
}
