import type { SessionView } from "@nocturne/core/protocol";
import type { RpcSession } from "@nocturne/rpc/client";

/** 订阅后校准；请求期间收到的实时事件优先于快照。 */
export async function syncShellSnapshot(session: RpcSession, view: SessionView): Promise<void> {
  const before = new Map(view.backgroundShells.map((task) => [task.taskId, task]));
  const snapshot = await session.shellTasks();
  for (const task of snapshot) {
    const index = view.backgroundShells.findIndex((item) => item.taskId === task.taskId);
    const current = view.backgroundShells[index];
    if (current && current !== before.get(task.taskId)) continue;
    if (index < 0) view.backgroundShells.push(task);
    else view.backgroundShells[index] = task;
  }
  view.revision += 1;
}
