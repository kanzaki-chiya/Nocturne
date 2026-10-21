/**
 * 只读读取会话日志（rpc.md 4.1 第 5 点）：固定字节快照，供子会话观察使用。
 * 与 store.load 的区别：不取锁、不截断、不另存尾部、不追加恢复事件、不建目录；
 * 不完整或无法解析的最后一行只在内存中略过。中间损坏、seq 空洞/倒序、
 * sessionId 不匹配、不支持的版本、未知持久事件类型一律报错，不跳过坏行拼接后文。
 */
import type { DurableEvent } from "../protocol/index.js";
import { fsErrorCode, type FileSystem } from "../platform/index.js";
import { SessionError } from "./errors.js";
import { assertLogHead, parseLogBytes } from "./log-parse.js";

export interface ReadonlyLog {
  events: DurableEvent[];
  /** 略过了不完整或无法解析的最后一行 */
  tailIgnored: boolean;
  /** 读取时的文件字节数（缓存指纹用） */
  size: number;
}

/** 会话 id 作为文件名使用前的校验：非空、至多 128 个 ASCII 字母/数字/下划线/连字符 */
export function assertSafeSessionId(id: unknown, label = "sessionId"): asserts id is string {
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
    throw new SessionError("invalid_session_id", `${label} 不是合法的会话标识`);
  }
}

export async function readLogReadonly(
  fs: FileSystem,
  path: string,
  sessionId: string,
): Promise<ReadonlyLog> {
  let buf: Uint8Array;
  try {
    buf = await fs.readFile(path);
  } catch (e) {
    const code = fsErrorCode(e);
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw new SessionError("session_not_found", `会话不存在: ${sessionId}`);
    }
    throw new SessionError("session_read_failed", `读取会话日志失败: ${sessionId}`, { cause: e });
  }
  const { events, tailStart } = parseLogBytes(buf);
  assertLogHead(events);
  if (events.some((event) => event.sessionId !== sessionId)) {
    throw new SessionError("session_log_corrupt", `日志中的 sessionId 与 ${sessionId} 不一致`);
  }
  return { events, tailIgnored: tailStart >= 0, size: buf.length };
}
