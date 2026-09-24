/**
 * 斜杠命令分发（tui.md §3）：命令名与 CLI 一致，交互形态按 TUI 适配
 * （/model、/resume 弹列表选择器；/context、/help 弹可滚动面板）。
 * 不共享 CLI 的渲染代码（cli.md §1）；语义参数（模型归一化等）走 core 公开 API。
 */
import { normalizeModelRef, type RuntimeSession } from "@nocturne/core";

export type OverlayName = "model" | "context" | "help" | "resume";

export type SlashResult =
  | { kind: "overlay"; name: OverlayName }
  | { kind: "message"; text: string }
  | { kind: "exit" }
  /** 已静默处理（确认行由 session.config_changed 事件渲染） */
  | { kind: "none" };

const HELP_TEXT = `斜杠命令：
  /help          本帮助
  /model         弹出模型列表选择器（↑↓ + Enter，Esc 取消）
  /model <id>    直接切换模型
  /preset        显示当前权限预设
  /preset <name> 切换权限预设（read-only | default | auto-edit | full-access）
  /context       上下文组成面板（Esc/Enter 关闭，↑↓ 滚动）
  /compact       手动压缩上下文（L2 摘要）
  /resume        弹出会话列表选择器；/resume <id> 直接切换
  /exit, /quit   退出
快捷键：a/s/p/d/x 权限确认（d 进反馈行，Enter 发送、Esc 返回）；
Ctrl+C 中断（空闲时退出）；Ctrl+D 退出。`;

export async function runSlash(line: string, session: RuntimeSession): Promise<SlashResult> {
  const [cmd, ...rest] = line.trim().split(/\s+/);
  const arg = rest.join(" ").trim();
  switch (cmd) {
    case "/help":
      return { kind: "overlay", name: "help" };
    case "/exit":
    case "/quit":
      return { kind: "exit" };
    case "/model": {
      if (arg === "") return { kind: "overlay", name: "model" };
      const norm = normalizeModelRef(arg, session.state().config.model.provider);
      if (!norm.ok) return { kind: "message", text: `! ${norm.problem}` };
      try {
        await session.setModel(norm.ref);
        return { kind: "none" };
      } catch (e) {
        return { kind: "message", text: `! ${errText(e)}` };
      }
    }
    case "/preset": {
      if (arg === "") {
        return {
          kind: "message",
          text: `当前权限预设：${session.state().config.permissionPreset}\n可用：read-only | default | auto-edit | full-access`,
        };
      }
      try {
        await session.setPermissionPreset(arg);
        return { kind: "none" };
      } catch (e) {
        return { kind: "message", text: `! ${errText(e)}` };
      }
    }
    case "/context":
      return { kind: "overlay", name: "context" };
    case "/compact": {
      try {
        await session.compact();
        return { kind: "none" };
      } catch (e) {
        return { kind: "message", text: `! ${errText(e)}` };
      }
    }
    case "/resume":
      // 会话切换（switchSession 回调注入）在后续提交接入
      return { kind: "message", text: "! /resume 会话切换将在后续提交接入" };
    default:
      return { kind: "message", text: `未知命令 ${cmd}；/help 列出可用命令` };
  }
}

export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function helpLines(): string[] {
  return HELP_TEXT.split("\n");
}

/** /context 面板内容（与 CLI /context 同口径的分区报告） */
export function contextLines(session: RuntimeSession): string[] {
  const { report, overBudget } = session.describeContext();
  const lines = report.sections.map(
    (s) =>
      `  ${s.name.padEnd(12)} ${String(s.chars).padStart(7)} chars  ~${s.estimatedTokens} tok  ${s.source}${s.truncated === true ? "  [已截断]" : ""}`,
  );
  return [
    "上下文组成：",
    ...lines,
    `  ${"─".repeat(40)}`,
    `  合计 ~${report.estimatedTokens} / ${report.budgetTokens} tok${overBudget ? "  [超预算]" : ""}`,
  ];
}
