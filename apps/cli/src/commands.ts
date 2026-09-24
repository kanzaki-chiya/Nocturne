/**
 * 斜杠命令分发（cli.md 第 4 节）。纯逻辑层：依赖注入 session/runtime/io，
 * 离线测试不需要真实终端。REPL 内命令错误只显示，不退出进程。
 */
import type { Runtime, RuntimeSession } from "@nocturne/core";
import { RuntimeCommandError } from "@nocturne/core";

import { normalizeModelRef } from "./config.js";

export interface CommandIo {
  print(text: string): void;
}

export type CommandOutcome = "handled" | "exit" | "unknown";

const SLASH_HELP = `斜杠命令：
  /help          列出命令与快捷键
  /model         显示当前模型与可用模型
  /model <id>    会话内切换模型
  /preset        显示当前权限预设
  /preset <name> 会话内切换权限预设（read-only | default | auto-edit | full-access）
  /context       显示上下文组成（分区与 token 估算）
  /compact       手动压缩上下文（L2 摘要）
  /resume        列出会话并输入编号切换；空行取消
  /resume <id>   直接切换到指定会话
  /exit, /quit   退出
快捷键：Ctrl+C 中断当前 Turn（空闲时退出）；Ctrl+D 退出。`;

export async function runSlashCommand(
  line: string,
  session: RuntimeSession,
  runtime: Runtime,
  io: CommandIo,
): Promise<CommandOutcome> {
  const [cmd, ...rest] = line.trim().split(/\s+/);
  switch (cmd) {
    case "/help":
      io.print(SLASH_HELP);
      return "handled";
    case "/exit":
    case "/quit":
      return "exit";
    case "/model": {
      if (rest.length === 0) {
        const cur = session.state().config.model;
        const models = runtime
          .listModels()
          .map((m) => `${m.ref.provider}/${m.ref.model}`)
          .join("\n  ");
        io.print(`当前模型：${cur.provider}/${cur.model}\n可用模型：\n  ${models}`);
        return "handled";
      }
      // 归一化与 --model 同规则（cli.md §4）
      const raw = rest.join(" ");
      const current = session.state().config.model.provider;
      const norm = normalizeModelRef(raw, current);
      if (!norm.ok) {
        io.print(`! ${norm.problem}`);
        return "handled";
      }
      try {
        await session.setModel(norm.ref);
        // session.config_changed 事件会渲染确认行
      } catch (e) {
        io.print(`! ${errorText(e)}`);
      }
      return "handled";
    }
    case "/preset": {
      const current = session.state().config.permissionPreset;
      if (rest.length === 0) {
        io.print(
          `当前权限预设：${current}\n可用预设：read-only | default | auto-edit | full-access`,
        );
        return "handled";
      }
      try {
        await session.setPermissionPreset(rest.join(" "));
        // session.config_changed 事件会渲染确认行
      } catch (e) {
        io.print(`! ${errorText(e)}`);
      }
      return "handled";
    }
    case "/context": {
      const { report, overBudget } = session.describeContext();
      const lines = report.sections.map(
        (s) =>
          `  ${s.name.padEnd(12)} ${String(s.chars).padStart(7)} chars  ~${s.estimatedTokens} tok  ${s.source}${s.truncated === true ? "  [已截断]" : ""}`,
      );
      io.print(
        [
          "上下文组成：",
          ...lines,
          `  ${"─".repeat(40)}`,
          `  合计 ~${report.estimatedTokens} / ${report.budgetTokens} tok${overBudget ? "  [超预算]" : ""}`,
        ].join("\n"),
      );
      return "handled";
    }
    case "/compact": {
      try {
        await session.compact();
        // context.compacted(kind="summary") 事件渲染确认行
      } catch (e) {
        io.print(`! ${errorText(e)}`);
      }
      return "handled";
    }
    default:
      io.print(`未知命令 ${cmd}；/help 列出可用命令`);
      return "unknown";
  }
}

function errorText(e: unknown): string {
  if (e instanceof RuntimeCommandError) return `${e.code}: ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}
