/**
 * Hook 会话快照写入辅助（hooks.md、context.md 第 3/6 节）：
 * 执行 SessionStart / SubagentStart，并与有效历史中的当前快照逐字对比，
 * 仅在有变化（或原非空现为空）时写入 `hook.context` 持久事件。
 */
import type { HookCallInput, HookRunner } from "../permission/index.js";
import { hookContextEntriesEqual, type HookContextSnapshotPoint } from "../protocol/index.js";
import type { Session } from "../session/index.js";

function isSessionHealthy(session: Session): boolean {
  return session.health === "ok";
}

export async function runHookContextSnapshot(
  session: Session,
  hooks: HookRunner | undefined,
  point: HookContextSnapshotPoint,
  input: HookCallInput,
  signal?: AbortSignal,
): Promise<void> {
  if (hooks === undefined || !isSessionHealthy(session)) return;
  const output = await hooks.run(point, input, signal).catch(() => undefined);
  if (output === undefined || signal?.aborted === true || !isSessionHealthy(session)) return;
  const next = output.contextEntries ?? [];
  const current = session.state().hookContext?.[point] ?? [];
  if (hookContextEntriesEqual(current, next)) return;
  await session.emit("hook.context", {
    point,
    ...(input.source !== undefined ? { source: input.source } : {}),
    entries: next,
  });
}
