import {
  estimateTokens,
  generationMs,
  MIN_GENERATION_MS,
  type AssistantTiming,
  type SessionView,
  type Usage,
} from "@nocturne/core/protocol";

/**
 * 状态栏速度段（ADR-0038 §4 同口径，ADR-0053 修订 2026-10-11）：只追踪本次打开后
 * 亲眼看到流式增量的步骤；历史消息没有到达时间，切换或恢复会话后首次生成前不显示。
 */
export interface StepSpeed {
  messageId: string;
  /** 客户端收到首个增量的时刻（ms） */
  started: number;
  /** 客户端看到完整 message.assistant 的时刻 */
  ended?: number | undefined;
  /** 本步正文与推理增量 */
  text: string;
  usage?: Usage | undefined;
  timing?: AssistantTiming | undefined;
}

export interface SpeedDisplay {
  label: string;
  /** 流式期间 */
  live: boolean;
  estimated: boolean;
  /** 流式期间已用时长（ms） */
  elapsedMs?: number | undefined;
  /** 本步结束后的明细 */
  detail?:
    | {
        outputTokens?: number | undefined;
        reasoningTokens?: number | undefined;
        ttftMs?: number | undefined;
        generationMs?: number | undefined;
        durationMs?: number | undefined;
      }
    | undefined;
}

/** 按当前视图推进速度状态；同一视图重复调用结果不变。ignore 为打开会话时已在流式的消息。 */
export function trackStepSpeed(
  state: StepSpeed | undefined,
  view: SessionView,
  now: number,
  ignore: ReadonlySet<string> = new Set(),
): StepSpeed | undefined {
  let next = state;
  if (next !== undefined && next.ended === undefined) {
    const id = next.messageId;
    const entry = view.entries.findLast((e) => e.kind === "assistant" && e.messageId === id);
    if (entry?.kind === "assistant")
      next = { ...next, ended: now, usage: entry.usage, timing: entry.timing };
  }
  const live = view.live.assistants.at(-1);
  if (live === undefined || ignore.has(live.messageId)) return next;
  const text = live.text + live.reasoning;
  if (text === "") return next;
  if (next?.messageId !== live.messageId) return { messageId: live.messageId, started: now, text };
  if (next.ended === undefined && next.text !== text) return { ...next, text };
  return next;
}

export function describeStepSpeed(
  state: StepSpeed | undefined,
  now: number,
): SpeedDisplay | undefined {
  if (state === undefined) return undefined;
  if (state.ended === undefined) {
    const elapsedMs = now - state.started;
    if (elapsedMs < MIN_GENERATION_MS) return undefined;
    const rate = Math.round(estimateTokens(state.text) / (elapsedMs / 1000));
    return { label: `~${rate} tok/s`, live: true, estimated: true, elapsedMs };
  }
  const generation = state.timing === undefined ? undefined : generationMs(state.timing);
  const output = state.usage?.outputTokens;
  const detail = {
    outputTokens: output,
    reasoningTokens: state.usage?.reasoningTokens,
    ttftMs: state.timing?.ttftMs,
    generationMs: generation,
    durationMs: state.timing?.durationMs,
  };
  // 有计时用服务商口径；没有就退回客户端测得的首个增量到完成
  const ms =
    output !== undefined && generation !== undefined ? generation : state.ended - state.started;
  if (ms < MIN_GENERATION_MS) return undefined;
  const estimated = output === undefined;
  const rate = Math.round((output ?? estimateTokens(state.text)) / (ms / 1000));
  return { label: `${estimated ? "~" : ""}${rate} tok/s`, live: false, estimated, detail };
}

/** 小于 10 秒保留一位小数，否则取整 */
export function formatSeconds(ms: number): string {
  const s = ms / 1000;
  return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
}
