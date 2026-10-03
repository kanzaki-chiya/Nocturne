import { useEffect, useReducer, useRef } from "react";

import type { RuntimeSession } from "@nocturne/core";
import type { RuntimeEvent } from "@nocturne/core/protocol";

export interface ReasoningPart {
  text: string;
  started?: number;
  ended?: number;
  active: boolean;
}

export type ReasoningMap = Map<string, ReasoningPart[]>;

/** 日志只提供内容顺序；本次运行的时长仅来自实际收到的增量。 */
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

export function useReasoning(session: RuntimeSession): { parts: ReasoningMap; now: number } {
  const ref = useRef<{ session: RuntimeSession; parts: ReasoningMap } | undefined>(undefined);
  if (ref.current?.session !== session) {
    const parts: ReasoningMap = new Map();
    for (const event of session.durableEvents()) {
      if (event.type === "message.assistant") recordReasoning(parts, event);
    }
    ref.current = { session, parts };
  }
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const [now, tick] = useReducer(() => Date.now(), Date.now());
  const current = ref.current;
  const active = [...current.parts.values()].some((p) => p.at(-1)?.active);
  useEffect(
    () =>
      session.subscribe((event) => {
        if (recordReasoning(current.parts, event)) bump();
      }),
    [session],
  );
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      tick();
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, [active, session]);
  return { parts: ref.current.parts, now };
}

export function reasoningLabel(
  part: ReasoningPart,
  now: number,
  ascii: boolean,
  expanded = false,
  fullscreen = false,
): string {
  const mark = ascii ? "*" : "∴";
  const seconds =
    part.started === undefined
      ? ""
      : ` ${Math.floor(Math.max(0, (part.ended ?? now) - part.started) / 1000)}s`;
  return `${mark} ${part.active ? "思考中" : part.started === undefined ? "思考" : "思考了"}${seconds}${expanded ? "" : fullscreen ? "（单击或 Ctrl+O 展开）" : "（Ctrl+O 展开）"}`;
}
