/**
 * 会话内 /resume 切换（cli.md 第 4 节、tui.md 第 3 节）。
 * 会话打开逻辑只在这里有一份：REPL 与 TUI 都注入同一个 switcher。
 * 流程约束：先打开新会话（锁冲突/日志损坏/跨目录被拒时留在原会话），
 * 成功后才关闭旧会话释放锁；Turn 进行中拒绝切换。
 */
import { RuntimeCommandError } from "@nocturne/core";
import type { Platform, Runtime, RuntimeSession } from "@nocturne/core";

/** 当前会话持有槽：切换成功时换入新会话；关闭权归调用方 */
export interface SessionHolder {
  current: RuntimeSession;
}

export type SwitchResult =
  | { kind: "ok"; session: RuntimeSession }
  /** Turn 进行中（含待决权限）：先中断再切换 */
  | { kind: "busy" }
  /** 目标会话绑定其他目录：客户端确认后带 allowForeign 重试 */
  | { kind: "foreign"; workspaceRoot: string }
  | { kind: "error"; message: string };

export type SessionSwitcher = (
  id: string,
  opts?: { allowForeign?: boolean },
) => Promise<SwitchResult>;

/**
 * 恢复失败时的 CLI 用法提示（sessions.md 4.2）：Core 只给中性说明，
 * `--model` 这类客户端用法由 CLI 自己补——仅恢复路径的 invalid_model
 * 给提示，新建会话的同名错误不影响（模型本就是显式传入的）。
 */
export function resumeFailureHint(e: unknown, resuming: boolean): string | undefined {
  return resuming && e instanceof RuntimeCommandError && e.code === "invalid_model"
    ? "加 --model <id> 指定替代模型"
    : undefined;
}

export type NewSessionFn = () => Promise<SwitchResult>;

export function createNewSession(deps: { runtime: Runtime; holder: SessionHolder }): NewSessionFn {
  const { runtime, holder } = deps;
  return async () => {
    const current = holder.current;
    if (current.state().openTurn !== undefined) return { kind: "busy" };
    const config = current.state().config;
    let next: RuntimeSession;
    try {
      next = await runtime.createSession({
        model: runtime.defaultModel() ?? config.model,
        ...(runtime.describeSettings().length === 0
          ? {
              permissionPreset: config.permissionPreset,
              reasoningEffort: config.reasoningEffort,
            }
          : {}),
      });
    } catch (e) {
      return { kind: "error", message: e instanceof Error ? e.message : String(e) };
    }
    holder.current = next;
    try {
      await current.close();
    } catch {
      // 新会话已经建立；旧锁由进程退出兜底。
    }
    return { kind: "ok", session: next };
  };
}

export function createSessionSwitcher(deps: {
  runtime: Runtime;
  platform: Platform;
  cwd: string;
  holder: SessionHolder;
}): SessionSwitcher {
  const { runtime, platform, cwd, holder } = deps;
  return async (id, opts) => {
    const current = holder.current;
    if (id === current.id) return { kind: "error", message: "已在该会话中" };
    if (current.state().openTurn !== undefined) return { kind: "busy" };

    let next: RuntimeSession;
    try {
      next = await runtime.resumeSession(id);
    } catch (e) {
      return { kind: "error", message: e instanceof Error ? e.message : String(e) };
    }

    // 跨目录：沿用启动时的确认规则（默认拒绝；确认后 allowForeign 重试）
    const root = next.state().meta.workspaceRoot;
    if (opts?.allowForeign !== true && !platform.paths.equals(root, cwd)) {
      await next.close();
      return { kind: "foreign", workspaceRoot: root };
    }

    // 先换入再关闭旧会话：旧锁保持到新会话锁已建立之后
    holder.current = next;
    try {
      await current.close();
    } catch {
      // 旧会话关闭失败不影响切换结果（锁文件由进程退出兜底）
    }
    return { kind: "ok", session: next };
  };
}

/** 打开会话后的提示行：恢复修复摘要 + 聚合警告（REPL/TUI/启动共用口径） */
export function sessionOpenNotes(session: RuntimeSession): string[] {
  const notes: string[] = [];
  const r = session.recovery;
  if (r !== undefined) {
    const parts: string[] = [];
    if (r.truncatedTail !== undefined) parts.push(`损坏尾部已截断（另存 ${r.truncatedTail}）`);
    if (r.interruptedCalls > 0) parts.push(`${r.interruptedCalls} 个未完成调用标记为 interrupted`);
    if (r.recoveredTurns > 0)
      parts.push(`${r.recoveredTurns} 个未完成 Turn 已按 process_exited 收束`);
    if (parts.length > 0) notes.push(`会话恢复时已修复：${parts.join("；")}`);
  }
  notes.push(...session.warnings);
  return notes;
}
