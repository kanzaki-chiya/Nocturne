/**
 * 客户端命令（docs/protocols/events.md 第 7 节）。
 * 命令不写入日志，其效果以事件体现。
 */
import type { ContentBlock, ModelRef, QuestionAnswer } from "./types.js";

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

/**
 * 客户端对 question.requested 的回答（ADR-0032 §3）：
 * answers 的条数与顺序必须与请求中的 questions 一一对应；
 * `{ declined: true }` 表示用户拒绝回答该题。
 */
export interface QuestionReply {
  answers: QuestionAnswer[];
}

export type ClientCommand =
  | { type: "submit"; content: ContentBlock[] }
  | { type: "interrupt" }
  | { type: "respondPermission"; requestId: string; reply: PermissionReply }
  | { type: "respondQuestion"; requestId: string; reply: QuestionReply }
  | { type: "setModel"; model: ModelRef }
  | { type: "setPermissionPreset"; preset: string }
  /** shell 选择（ADR-0022）："auto" 或支持的种类名 */
  | { type: "setShell"; shell: string }
  | { type: "compact" }
  | { type: "close" };

/**
 * 命令被拒绝的原因码（events.md 第 7 节）。
 * 进程内调用以带 code 的错误报告，将来 RPC 序列化为响应字段。
 */
export type CommandRejectCode =
  | "session_busy"
  | "unknown_request"
  /** respondQuestion 的回复与待回答问题不匹配（ADR-0032 §3），请求保持等待 */
  | "invalid_reply"
  | "session_failed"
  | "invalid_command"
  | "invalid_model"
  | "compaction_in_progress"
  | "compaction_interrupted"
  | "compaction_failed";
