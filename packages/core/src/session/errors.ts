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
  | "invalid_command"
  /** 会话被另一个进程持锁（ADR-0009） */
  | "session_locked"
  /** 只读观察（rpc.md 4.1）：session id 不是安全的单文件名标识 */
  | "invalid_session_id"
  /** 只读观察：指定的 child 不是该 parent 的直接子会话（含把顶层会话当 child） */
  | "subagent_parent_mismatch"
  /** 只读观察：afterSeq 超过读到的持久高水位 */
  | "invalid_after_seq"
  /** 只读读取日志时的 I/O 错误（不含文件不存在） */
  | "session_read_failed"
  /** 附件文件名不安全或落盘路径是链接 */
  | "invalid_attachment_file"
  /** 本会话的持久事件未登记该图片文件 */
  | "attachment_not_found"
  /** 已登记附件缺失 */
  | "attachment_missing"
  /** 附件读取发生其他 I/O 错误 */
  | "attachment_read_failed"
  /** 附件字节大小或 sha256 与日志引用不符 */
  | "attachment_corrupt"
  /** runtime.readFile：相对路径，或含 ..、控制字符、备用数据流、设备名（ADR-0060） */
  | "invalid_file_path"
  /** runtime.readFile：UNC 等网络路径，或链接指向网络位置；不访问，直接拒绝 */
  | "file_network_path"
  | "file_not_found"
  /** runtime.readFile：目录或其他非普通文件 */
  | "file_not_regular"
  /** runtime.readFile：超过 READ_FILE_MAX_BYTES，不截断返回 */
  | "file_too_large"
  /** runtime.readFile：不是文本也不是可显示的图片 */
  | "file_binary"
  /** runtime.readFile：总时限内没读完（映射的网络盘主机离线等），可重试 */
  | "file_read_timeout"
  | "file_read_failed";

export class SessionError extends Error {
  readonly code: SessionErrorCode;
  constructor(code: SessionErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SessionError";
    this.code = code;
  }
}
