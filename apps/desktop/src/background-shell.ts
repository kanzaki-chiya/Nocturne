import type {
  BackgroundShellTask,
  SessionView,
  ToolEntry,
  UserEntry,
} from "@nocturne/core/protocol";

import { elapsedText } from "./subagent-panel";

type ShellView = Pick<SessionView, "entries" | "backgroundShells">;

export function shellStatus(task: { status: string; exitCode?: number | undefined }): string {
  if (task.status === "running") return "运行中";
  return task.exitCode === undefined ? "" : `退出码 ${String(task.exitCode)}`;
}

export function shellToolStatus(entry: ToolEntry, view: ShellView): string | undefined {
  const output = entry.result?.output as { background?: unknown } | undefined;
  if (entry.name !== "shell" || output?.background !== true) return undefined;
  const task = view.backgroundShells.find((item) => item.callId === entry.callId);
  const delivered = view.entries.find(
    (item): item is UserEntry =>
      item.kind === "user" && item.backgroundShell?.callId === entry.callId,
  )?.backgroundShell;
  const state = task ?? delivered;
  return state === undefined || state.status === "running" ? "后台" : shellStatus(state);
}

export function shellResultSummary(entry: UserEntry, view: ShellView): string {
  const meta = entry.backgroundShell;
  if (meta === undefined) return "";
  const task = view.backgroundShells.find((item) => item.taskId === meta.taskId);
  const tool = view.entries.find(
    (item): item is ToolEntry => item.kind === "tool" && item.callId === meta.callId,
  );
  const input = tool?.input as { name?: unknown; command?: unknown } | undefined;
  const name = task?.name ?? (typeof input?.name === "string" ? input.name : "");
  const command = task?.command ?? (typeof input?.command === "string" ? input.command : "");
  const duration = shellDuration(task);
  return [name || command.split(/\r?\n/)[0], shellStatus(meta), duration]
    .filter(Boolean)
    .join(" · ");
}

function shellDuration(task: BackgroundShellTask | undefined): string {
  if (task?.endedAt === undefined) return "";
  return elapsedText(Date.parse(task.endedAt) - Date.parse(task.startedAt));
}

export function shellResultText(text: string): string {
  return text.replace(/^<shell-result\b[^>]*>\r?\n?/, "").replace(/\r?\n?<\/shell-result>\s*$/, "");
}
