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
  | "session_locked"
  /** 附件文件名不安全或落盘路径是链接 */
  | "invalid_attachment_file"
  /** 本会话的持久事件未登记该图片文件 */
  | "attachment_not_found"
  /** 已登记附件缺失 */
  | "attachment_missing"
  /** 附件读取发生其他 I/O 错误 */
  | "attachment_read_failed"
  /** 附件字节大小或 sha256 与日志引用不符 */
  | "attachment_corrupt";

export class SessionError extends Error {
  readonly code: SessionErrorCode;
  constructor(code: SessionErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SessionError";
    this.code = code;
  }
}
