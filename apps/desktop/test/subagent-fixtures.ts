/**
 * 子代理测试夹具：摘要、父 task 工具行、子会话事件。不依赖 React。
 */
import type {
  RuntimeEvent,
  SubagentObservation,
  SubagentObserver,
  SubagentReadEnd,
  SubagentSummary,
  ToolEntry,
} from "@nocturne/core/protocol";

import type { WatchRuntime } from "../src/subagent-watch";

export function summary(over: Partial<SubagentSummary> = {}): SubagentSummary {
  return {
    parentSessionId: "p",
    callId: "call-1",
    childSessionId: "child-1",
    profile: "default",
    taskSummary: "审查登录模块",
    startedAt: "2026-10-21T00:00:00.000Z",
    state: "running",
    ...over,
  };
}

export function taskEntry(over: Partial<ToolEntry> = {}): ToolEntry {
  return {
    kind: "tool",
    key: "t:call-1",
    turnId: "turn-1",
    callId: "call-1",
    name: "task",
    seq: 3,
    status: "running",
    input: { task: "审查登录模块", profile: "default" },
    subjects: [{ kind: "subagent", target: "general" }],
    permission: undefined,
    resolution: undefined,
    liveOutput: "",
    result: undefined,
    ...over,
  };
}

export function settled(
  status: "ok" | "error" | "cancelled" | "interrupted" | "denied",
  over: Partial<NonNullable<ToolEntry["result"]>> = {},
): NonNullable<ToolEntry["result"]> {
  return {
    status,
    modelContent: "",
    output: undefined,
    error: status === "error" ? { code: "subagent_failed", message: "子代理失败" } : undefined,
    truncated: false,
    spillPath: undefined,
    durationMs: 12_000,
    ...over,
  };
}

export function externalEntry(agent = "claude", over: Partial<ToolEntry> = {}): ToolEntry {
  return taskEntry({
    callId: "ext-1",
    key: "t:ext-1",
    input: { task: "外部 agent 的任务", agent },
    subjects: [{ kind: "subagent", target: `external:${agent}` }],
    ...over,
  });
}

let time = 0;
/** 子会话的持久事件（seq 由调用方给） */
export function durable(
  type: string,
  seq: number,
  payload: unknown,
  sessionId = "child-1",
  turnId = "turn-1",
): RuntimeEvent {
  time += 1;
  return {
    type,
    seq,
    sessionId,
    turnId,
    time: new Date(Date.UTC(2026, 9, 21, 0, 0, time)).toISOString(),
    payload,
  } as unknown as RuntimeEvent;
}

export const userMessage = (seq: number, text: string, sessionId = "child-1") =>
  durable(
    "message.user",
    seq,
    { messageId: `user-${String(seq)}`, content: [{ type: "text", text }] },
    sessionId,
  );

export const toolStarted = (
  seq: number,
  callId: string,
  name: string,
  input: unknown,
  sessionId = "child-1",
) =>
  durable(
    "tool.started",
    seq,
    {
      callId,
      name,
      input,
      subjects: [],
      permission: { action: "allow", source: "preset" },
    },
    sessionId,
  );

export const toolCompleted = (
  seq: number,
  callId: string,
  name: string,
  status: "ok" | "error" | "denied",
  modelContent = "完成",
  sessionId = "child-1",
  error?: { code: string; message: string },
) =>
  durable(
    "tool.completed",
    seq,
    { callId, name, status, modelContent, ...(error !== undefined ? { error } : {}) },
    sessionId,
  );

export const assistantMessage = (seq: number, text: string, sessionId = "child-1") =>
  durable(
    "message.assistant",
    seq,
    {
      messageId: `assistant-${String(seq)}`,
      content: [{ type: "text", text }],
      finishReason: "stop",
    },
    sessionId,
  );

export function endOf(over: Partial<SubagentReadEnd> = {}): SubagentReadEnd {
  return {
    lastSeq: 0,
    summary: summary({ state: "ended" }),
    source: "snapshot",
    tailIgnored: false,
    ...over,
  };
}

interface Subscription {
  input: { parentSessionId: string; childSessionId: string; afterSeq?: number | undefined };
  observer: SubagentObserver;
  unsubscribed: boolean;
  /** 解决 observeSubagent 的 promise */
  resolve(observation?: Partial<Omit<SubagentObservation, "unsubscribe">>): void;
  reject(error: unknown): void;
}

/** 假 runtime：每次 observeSubagent 记一条订阅，由测试决定何时回事件、何时让 promise 落定 */
export function fakeObserveRuntime(options: { autoResolve?: boolean } = {}) {
  const subscriptions: Subscription[] = [];
  const runtime: WatchRuntime = {
    observeSubagent(input, observer) {
      return new Promise<SubagentObservation>((resolve, reject) => {
        const entry: Subscription = {
          input,
          observer,
          unsubscribed: false,
          resolve: (observation = {}) => {
            resolve({
              lastSeq: observation.lastSeq ?? 0,
              summary: observation.summary ?? summary(),
              mode: observation.mode ?? "live",
              unsubscribe: () => {
                entry.unsubscribed = true;
              },
            });
          },
          reject,
        };
        subscriptions.push(entry);
        if (options.autoResolve === true) entry.resolve();
      });
    },
  };
  return { runtime, subscriptions };
}
