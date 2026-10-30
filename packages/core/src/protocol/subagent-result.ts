/**
 * 后台子代理结果消息（ADR-0073 §3、§6）的客户端显示辅助：TUI 与桌面端共用，
 * 不显示 `<subagent-result>` 外壳。
 */
import type { SubagentResult } from "./events.js";
import type { ViewEntry } from "./view.js";

/** 去掉给模型看的 `<subagent-result …>` 头尾，只留正文 */
export function subagentResultText(text: string): string {
  return text
    .replace(/^<subagent-result[^>]*>\r?\n?/u, "")
    .replace(/\r?\n?<\/subagent-result>$/u, "");
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
    const input = entry.input as { profile?: unknown; task?: unknown } | undefined;
    return [
      {
        callId: entry.callId,
        childSessionId: output.childSessionId,
        profile: typeof input?.profile === "string" ? input.profile : "default",
        task: typeof input?.task === "string" ? input.task : "",
      },
    ];
  });
}

/** `<档位> · <状态>`；补报条目或缺档位时按 default */
export function subagentResultLine(result: SubagentResult): string {
  return `${result.profile ?? "default"} · ${subagentResultStatus(result.status)}`;
}
