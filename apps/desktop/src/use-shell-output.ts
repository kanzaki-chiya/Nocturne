import { useEffect, useRef, useState } from "react";
import type { BackgroundShellTask } from "@nocturne/core/protocol";
import type { RpcSession } from "@nocturne/rpc/client";

export type ShellSession = Pick<RpcSession, "shellOutput" | "shellKill">;

/** 每个显示区持有独立偏移；单次在途读取合并后续更新，失效后不接受旧响应。 */
export function useShellOutput(
  session: ShellSession | undefined,
  taskId: string,
  task: BackgroundShellTask | undefined,
  enabled: boolean,
) {
  const [output, setOutput] = useState<{ text: string; task?: BackgroundShellTask }>({ text: "" });
  const request = useRef<(target: string) => void>(() => undefined);
  const target = `${task?.outputChars ?? 0}:${task?.status ?? ""}`;
  const latest = useRef(target);
  latest.current = target;
  useEffect(() => {
    if (!session || !enabled) return;
    setOutput({ text: "" });
    let active = true;
    let busy = false;
    let dirty = false;
    let end: number | undefined;
    let previous: string | undefined;
    let text = "";
    const read = async () => {
      if (busy) return;
      busy = true;
      try {
        while (dirty) {
          dirty = false;
          const next = await session.shellOutput(taskId, end);
          if (!active) return;
          text = (end === undefined || next.start !== end ? next.text : text + next.text).slice(
            -200000,
          );
          end = next.end;
          setOutput({ text, task: next.task });
        }
      } catch {
        // 断线或任务不再可读时，已读内容仍可回看；下一次任务更新再尝试。
      } finally {
        busy = false;
      }
    };
    request.current = (next) => {
      if (next === previous) return;
      previous = next;
      dirty = true;
      void read();
    };
    request.current(latest.current);
    return () => {
      active = false;
      request.current = () => undefined;
    };
  }, [session, taskId, enabled]);
  useEffect(() => {
    request.current(target);
  }, [target]);
  const current = task?.endedAt ? task : output.task?.endedAt ? output.task : (task ?? output.task);
  return { text: output.text, task: current };
}
