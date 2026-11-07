import type { BackgroundShellTask, ToolEntry, UserEntry, ViewEntry } from "@nocturne/core/protocol";
import { formatDuration } from "./format.js";

export function shellToolStatus(
  entry: ToolEntry,
  entries: readonly ViewEntry[],
  tasks: readonly BackgroundShellTask[] = [],
): string | undefined {
  const output = entry.result?.output as { background?: unknown } | undefined;
  if (entry.name !== "shell" || output?.background !== true) return undefined;
  const task = tasks.find((item) => item.callId === entry.callId);
  const result = entries.find(
    (item): item is UserEntry =>
      item.kind === "user" && item.backgroundShell?.callId === entry.callId,
  )?.backgroundShell;
  if (task?.status === "running") return "后台";
  const status = task ?? result;
  return status ? `${status.status} ${status.exitCode ?? ""}`.trim() : "后台";
}

export function shellResultLine(
  entry: UserEntry,
  entries: readonly ViewEntry[],
  tasks: readonly BackgroundShellTask[] = [],
): string {
  const result = entry.backgroundShell;
  if (!result) return "";
  const task = tasks.find((item) => item.taskId === result.taskId);
  const tool = entries.find(
    (item): item is ToolEntry => item.kind === "tool" && item.callId === result.callId,
  );
  const input = tool?.input as { command?: string } | undefined;
  const command = (task?.command ?? input?.command ?? result.taskId).split(/\r?\n/)[0];
  const duration = task?.endedAt
    ? formatDuration(Date.parse(task.endedAt) - Date.parse(task.startedAt))
    : "";
  return [command, result.status, result.exitCode, duration]
    .filter((item) => item !== undefined && item !== "")
    .join(" · ");
}

export function shellResultText(text: string): string {
  const start = text.indexOf(">\n");
  const end = text.lastIndexOf("\n</shell-result>");
  return start < 0 || end < start ? text : text.slice(start + 2, end);
}
