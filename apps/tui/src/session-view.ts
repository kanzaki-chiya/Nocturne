/**
 * SessionView 接线（view.md §6）：先回放持久日志，再订阅实时事件，
 * 两者汇合进同一个 reducer——TUI 不做自有投影。
 * session 对象变化（/resume 切换）时重建视图。
 */
import { useEffect, useReducer, useRef, useState } from "react";

import type { RuntimeSession } from "@nocturne/core";
import {
  reduceSessionView,
  replaySessionView,
  type PendingInputsSnapshot,
  type SessionView,
} from "@nocturne/core/protocol";

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

/**
 * 待发输入快照（ADR-0070 §6）：临时状态不写日志、`input.pending` 不回放，
 * 所以切换会话时先取一次当前快照，之后随事件整份覆盖。
 */
export function usePendingInputs(session: RuntimeSession): PendingInputsSnapshot {
  const [snapshot, setSnapshot] = useState<PendingInputsSnapshot>({ items: [], paused: false });
  useEffect(() => {
    let active = true;
    setSnapshot({ items: [], paused: false });
    void Promise.resolve(session.pendingInputs())
      .then((next) => {
        if (active) setSnapshot(next);
      })
      .catch(() => undefined);
    const off = session.subscribe((event) => {
      if (event.type === "input.pending") setSnapshot(event.payload);
    });
    return () => {
      active = false;
      off();
    };
  }, [session]);
  return snapshot;
}
