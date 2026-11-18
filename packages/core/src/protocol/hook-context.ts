/**
 * Hook 上下文注入的共享常量、快照类型与格式化纯函数（hooks.md、context.md）。
 * protocol 层只含纯计算，供 hooks / session / context / agent 共用。
 */

export const MAX_HOOK_CONTEXT_ENTRY_CHARS = 10_000;
export const MAX_HOOK_CONTEXT_TOTAL_CHARS = 30_000;

export type HookContextSnapshotPoint = "SessionStart" | "SubagentStart";
export type HookContextPoint = HookContextSnapshotPoint | "UserPromptSubmit";

export interface HookContextEntry {
  hook: string;
  text: string;
  truncated?: number | undefined;
}

export interface HookContextSnapshot {
  SessionStart?: readonly HookContextEntry[] | undefined;
  SubagentStart?: readonly HookContextEntry[] | undefined;
}

const HOOK_CONTEXT_SYSTEM_PREAMBLE =
  "The following context was provided by user-configured hooks at session start:";

/** 把同一事件点的 Hook 上下文条目格式化为 `<hook-context point="…">` 块。 */
export function formatHookContextEntries(
  point: HookContextPoint,
  entries: readonly HookContextEntry[],
): string {
  return entries
    .map((entry) => `<hook-context point="${point}">\n${entry.text}\n</hook-context>`)
    .join("\n");
}

/** 组装 system section `hookContext` 文本（英文前言 + 各快照条目）；无内容返回 undefined。 */
export function formatHookContextSystem(
  snapshot: HookContextSnapshot | undefined,
): { text: string; count: number } | undefined {
  if (snapshot === undefined) return undefined;
  const blocks: string[] = [];
  let count = 0;
  for (const point of ["SessionStart", "SubagentStart"] as const) {
    const entries = snapshot[point];
    if (entries === undefined || entries.length === 0) continue;
    blocks.push(formatHookContextEntries(point, entries));
    count += entries.length;
  }
  if (count === 0) return undefined;
  return {
    text: `${HOOK_CONTEXT_SYSTEM_PREAMBLE}\n\n${blocks.join("\n")}`,
    count,
  };
}

/** 逐字比较两组 Hook 上下文条目是否完全一致，用于会话快照去重。 */
export function hookContextEntriesEqual(
  a: readonly HookContextEntry[],
  b: readonly HookContextEntry[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const left = a[i];
    const right = b[i];
    if (left === undefined || right === undefined) return false;
    if (
      left.hook !== right.hook ||
      left.text !== right.text ||
      left.truncated !== right.truncated
    ) {
      return false;
    }
  }
  return true;
}
