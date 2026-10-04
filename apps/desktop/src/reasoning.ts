import { useEffect, useReducer, useRef } from "react";

import type { RuntimeEvent } from "@nocturne/core/protocol";

export interface ReasoningPart {
  text: string;
  started?: number;
  ended?: number;
  active: boolean;
}

export type ReasoningMap = Map<string, ReasoningPart[]>;

/**
 * 思考时长簿记（与 TUI reasoning.ts 同一规则）：
 * 时长只来自本次实际收到的增量；message.assistant 持久事件只补内容，
 * 没有计时的历史条目显示「思考」不带秒数。
 */
export function recordReasoning(
  parts: ReasoningMap,
  event: RuntimeEvent,
  now = Date.now(),
): boolean {
  if (event.type === "message.assistant.delta") {
    const { messageId, kind, delta } = event.payload;
    const list = parts.get(messageId) ?? [];
    if (kind === "reasoning" && delta !== "") {
      const last = list.at(-1);
      if (last?.active) last.text += delta;
      else list.push({ text: delta, started: now, active: true });
      parts.set(messageId, list);
      return true;
    }
    const last = list.at(-1);
    if (kind === "text" && last?.active) {
      last.active = false;
      last.ended = now;
      return true;
    }
  }
  if (
    event.type === "tool.input.delta" ||
    event.type === "tool.started" ||
    event.type === "turn.completed"
  ) {
    let changed = false;
    for (const list of parts.values()) {
      const last = list.at(-1);
      if (last?.active) {
        last.active = false;
        last.ended = now;
        changed = true;
      }
    }
    return changed;
  }
  if (event.type === "message.assistant") {
    const previous = parts.get(event.payload.messageId) ?? [];
    const blocks = event.payload.content.filter((c) => c.type === "reasoning" && c.text !== "");
    if (blocks.length === 0) return false;
    parts.set(
      event.payload.messageId,
      blocks.map((block, i) => ({
        text: block.text,
        ...(previous[i]?.started !== undefined ? { started: previous[i].started } : {}),
        ...(previous[i]?.started !== undefined ? { ended: previous[i].ended ?? now } : {}),
        active: false,
      })),
    );
    return true;
  }
  return false;
}

export function useReasoning(
  subscribeEvents: (listener: (event: RuntimeEvent) => void) => () => void,
): { parts: ReasoningMap; now: number } {
  const ref = useRef<ReasoningMap | null>(null);
  ref.current ??= new Map();
  const parts = ref.current;
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const [now, tick] = useReducer(() => Date.now(), Date.now());
  const active = [...parts.values()].some((list) => list.at(-1)?.active);
  useEffect(
    () =>
      subscribeEvents((event) => {
        if (recordReasoning(parts, event)) bump();
      }),
    [subscribeEvents, parts],
  );
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      tick();
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, [active]);
  return { parts, now };
}
