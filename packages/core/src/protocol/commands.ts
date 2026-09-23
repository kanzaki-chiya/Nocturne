/**
 * 客户端命令（docs/protocols/events.md 第 7 节）。
 * 命令不写入日志，其效果以事件体现。
 */
import type { ContentBlock, ModelRef } from "./types.js";

/** 客户端对 permission.requested 的回答（permissions.md 第 7 节） */
export interface PermissionReply {
  decision: "allow" | "deny";
  /** decision = deny 时可用：拒绝并停止当前 Turn */
  stop?: boolean | undefined;
  /** decision = allow 时可用：授予会话 / 项目级 Grant */
  remember?: "session" | "project" | undefined;
  /** 拒绝时可附带给模型的反馈 */
  feedback?: string | undefined;
}

export type ClientCommand =
  | { type: "submit"; content: ContentBlock[] }
  | { type: "interrupt" }
  | { type: "respondPermission"; requestId: string; reply: PermissionReply }
  | { type: "setModel"; model: ModelRef }
  | { type: "compact" }
  | { type: "close" };

/**
 * 命令被拒绝的原因码（events.md 第 7 节）。
 * 进程内调用以带 code 的错误报告，将来 RPC 序列化为响应字段。
 */
export type CommandRejectCode =
  | "session_busy"
  | "unknown_request"
  | "session_failed"
  | "invalid_command"
  | "invalid_model"
  | "compaction_in_progress"
  | "compaction_interrupted"
  | "compaction_failed";
