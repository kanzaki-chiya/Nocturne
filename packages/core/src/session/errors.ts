/** 会话错误码（sessions.md、events.md 第 8 节） */
export type SessionErrorCode =
  /** 日志包含更高版本格式或不认识的事件类型，拒绝恢复 */
  | "session_log_newer"
  /** 日志中间损坏、seq 不连续或倒序 */
  | "session_log_corrupt"
  /** 写入失败后会话进入 failed，除 close 外命令都拒绝 */
  | "session_failed"
  | "session_closed"
  | "session_not_found"
  /** 会话被另一个进程持锁（ADR-0009） */
  | "session_locked";

export class SessionError extends Error {
  readonly code: SessionErrorCode;
  constructor(code: SessionErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SessionError";
    this.code = code;
  }
}
