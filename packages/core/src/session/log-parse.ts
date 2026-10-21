/**
 * 会话日志字节 → 持久事件（sessions.md 第 4 节第 2、3 步的纯解析部分）。
 * 打开会话的 store.load 与只读观察共用；本文件不做任何写入，
 * 尾部处理（另存、截断）由调用方决定。
 */
import {
  decodeDurableEvent,
  EventParseError,
  LOG_FORMAT_VERSION,
  type DurableEvent,
} from "../protocol/index.js";
import { SessionError } from "./errors.js";

export interface ParsedLog {
  events: DurableEvent[];
  /** 损坏尾部的起始字节偏移；没有损坏尾部为 -1 */
  tailStart: number;
}

/**
 * 按 \n 切行逐行校验。损坏尾部：文件不以换行符结束，或最后一行无法解析为合法事件。
 * 中间损坏、seq 不连续、不认识的持久事件类型一律抛 SessionError，不跳过坏行。
 */
export function parseLogBytes(buf: Uint8Array): ParsedLog {
  const lineOffsets: { start: number; end: number }[] = [];
  let cursor = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) {
      lineOffsets.push({ start: cursor, end: i });
      cursor = i + 1;
    }
  }
  const endsClean = buf.length > 0 && buf[buf.length - 1] === 0x0a;
  if (cursor < buf.length) {
    // 最后一行无结尾换行符：写入中断过，无论内容是否可解析都按尾部处理
    lineOffsets.push({ start: cursor, end: buf.length });
  }

  const events: DurableEvent[] = [];
  let tailStart = -1;
  if (!endsClean && lineOffsets.length > 0) {
    // 未终止的最后一行无条件视为损坏尾部
    tailStart = lineOffsets.at(-1)?.start ?? -1;
    lineOffsets.pop();
  }
  for (let i = 0; i < lineOffsets.length; i++) {
    const range = lineOffsets[i];
    if (range === undefined) break;
    const { start, end } = range;
    const line = new TextDecoder().decode(buf.subarray(start, end));
    if (line === "") {
      throw new SessionError("session_log_corrupt", `日志第 ${i + 1} 行为空`);
    }
    let event: DurableEvent;
    try {
      event = decodeDurableEvent(line);
    } catch (e) {
      if (e instanceof EventParseError && e.code === "unknown_event_type") {
        throw new SessionError(
          "session_log_newer",
          `日志包含不认识的持久化事件类型: ${e.message}`,
          { cause: e },
        );
      }
      if (i === lineOffsets.length - 1 && tailStart === -1) {
        // 已终止但无法解析的最后一行同样算损坏尾部（sessions.md 第 4 节）
        tailStart = start;
        break;
      }
      throw new SessionError("session_log_corrupt", `日志第 ${i + 1} 行无法解析`, { cause: e });
    }
    if (event.seq !== events.length + 1) {
      throw new SessionError(
        "session_log_corrupt",
        `日志 seq 不连续：第 ${i + 1} 行 seq=${event.seq}，期望 ${events.length + 1}`,
      );
    }
    events.push(event);
  }
  return { events, tailStart };
}

/** 首条必须是 session.created，且格式版本不高于当前支持 */
export function assertLogHead(events: readonly DurableEvent[]): void {
  const first = events[0];
  if (first?.type !== "session.created") {
    throw new SessionError("session_log_corrupt", "日志第一行不是 session.created");
  }
  if (first.payload.formatVersion > LOG_FORMAT_VERSION) {
    throw new SessionError(
      "session_log_newer",
      `日志格式版本 ${first.payload.formatVersion} 高于支持的 ${LOG_FORMAT_VERSION}`,
    );
  }
}
