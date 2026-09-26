/**
 * runTui 注入项的类型（tui.md §3）：会话打开逻辑在 CLI 侧只有一份，
 * TUI 通过回调请求切换，不直接打开会话。
 */
import type { RuntimeSession } from "@nocturne/core";

export type SessionSwitchResult =
  | { kind: "ok"; session: RuntimeSession }
  /** Turn 进行中（含待决权限）：提示先中断 */
  | { kind: "busy" }
  /** 目标会话绑定其他目录：确认对话框同意后带 allowForeign 重试 */
  | { kind: "foreign"; workspaceRoot: string }
  | { kind: "error"; message: string };

export type SwitchSessionFn = (
  id: string,
  opts?: { allowForeign?: boolean },
) => Promise<SessionSwitchResult>;

export type NewSessionFn = () => Promise<SessionSwitchResult>;
