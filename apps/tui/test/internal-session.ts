import type { RuntimeSession } from "@nocturne/core";
import type { EphemeralEvent, EphemeralPayload } from "@nocturne/core/protocol";

/** 测试里直接往会话日志发事件用的最小内部接口（公开 RuntimeSession 不暴露它） */
export interface InternalSession {
  emit(type: string, payload: unknown, options?: unknown): Promise<unknown>;
  emitEphemeral<T extends EphemeralEvent["type"]>(
    type: T,
    payload: EphemeralPayload<T>,
    options?: { turnId?: string },
  ): unknown;
}

/** 经 createRuntime 挂在 RuntimeSession 上的 Symbol.for 属性取内部 Session */
export function internalSession(session: RuntimeSession): InternalSession {
  const inner = (session as unknown as Record<symbol, InternalSession | undefined>)[
    Symbol.for("nocturne.core.internalSession")
  ];
  if (inner === undefined) throw new Error("不是由 createRuntime 创建的 RuntimeSession");
  return inner;
}
