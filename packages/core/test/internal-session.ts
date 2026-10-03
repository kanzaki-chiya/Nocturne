import type { RuntimeSession } from "../src/index.js";
import type { Session } from "../src/session/index.js";

/**
 * 取 RuntimeSession 背后的内部 Session：公开类型不再暴露它（ADR-0044 第 1 步），
 * 测试经 createRuntime 挂上的 Symbol.for 属性直接发事件、读日志路径。
 */
export function internalSession(session: RuntimeSession): Session {
  const inner = (session as unknown as Record<symbol, Session | undefined>)[
    Symbol.for("nocturne.core.internalSession")
  ];
  if (inner === undefined) throw new Error("不是由 createRuntime 创建的 RuntimeSession");
  return inner;
}
