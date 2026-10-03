/**
 * SessionView 接线（view.md §6）：先回放持久日志，再订阅实时事件，
 * 两者汇合进同一个 reducer——TUI 不做自有投影。
 * session 对象变化（/resume 切换）时重建视图。
 */
import { useEffect, useReducer, useRef } from "react";

import type { RuntimeSession } from "@nocturne/core";
import { reduceSessionView, replaySessionView, type SessionView } from "@nocturne/core/protocol";

export function useSessionView(session: RuntimeSession): SessionView {
  const ref = useRef<{ session: RuntimeSession; view: SessionView } | undefined>(undefined);
  if (ref.current?.session !== session) {
    ref.current = { session, view: replaySessionView(session.durableEvents()) };
  }
  const [, bump] = useReducer((c: number) => c + 1, 0);
  useEffect(() => {
    const current = ref.current;
    if (current === undefined) return;
    return session.subscribe((event) => {
      reduceSessionView(current.view, event);
      bump();
    });
  }, [session]);
  return ref.current.view;
}
