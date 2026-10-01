import { useEffect, useReducer, useRef } from "react";
import type { RuntimeSession } from "@nocturne/core";
import { estimateTokens, type RuntimeEvent } from "@nocturne/core/protocol";

export interface GenerationSpeed {
  messageId?: string;
  started?: number;
  ended?: number;
  text: string;
  tokens?: number | undefined;
}

/** 只记录本次订阅收到的事件，历史消息没有可用的到达时间。 */
export function recordSpeed(state: GenerationSpeed, event: RuntimeEvent, now: number): boolean {
  if (event.type === "message.assistant.delta") {
    const { messageId, delta } = event.payload;
    if (delta === "") return false;
    const first = state.messageId !== messageId;
    if (first) {
      state.messageId = messageId;
      state.started = now;
      delete state.ended;
      delete state.tokens;
      state.text = "";
    }
    state.text += delta;
    return first;
  }
  if (event.type === "message.assistant" && state.messageId === event.payload.messageId) {
    state.ended = now;
    state.tokens = event.payload.usage?.outputTokens;
    return true;
  }
  return false;
}

export function formatSpeed(state: GenerationSpeed, now: number): string | undefined {
  if (state.started === undefined) return undefined;
  const seconds = ((state.ended ?? now) - state.started) / 1000;
  if (seconds < 0.5) return undefined;
  const estimated = state.tokens === undefined;
  return `${estimated ? "~" : ""}${Math.round((state.tokens ?? estimateTokens(state.text)) / seconds)} tok/s`;
}

export function useGenerationSpeed(session: RuntimeSession): string | undefined {
  const ref = useRef<
    { session: RuntimeSession; state: GenerationSpeed; label?: string | undefined } | undefined
  >(undefined);
  if (ref.current?.session !== session) ref.current = { session, state: { text: "" } };
  const current = ref.current;
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const publish = (now: number): void => {
    current.label = formatSpeed(current.state, now);
    bump();
  };
  useEffect(
    () =>
      session.subscribe((event) => {
        const now = Date.now();
        if (recordSpeed(current.state, event, now)) publish(now);
      }),
    [session],
  );
  const active = current.state.started !== undefined && current.state.ended === undefined;
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      publish(Date.now());
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, [active, session]);
  return current.label;
}
