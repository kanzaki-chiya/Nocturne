/**
 * 斜杠命令分发（cli.md 第 4 节）。纯逻辑层：依赖注入 session/runtime/io，
 * 离线测试不需要真实终端。REPL 内命令错误只显示，不退出进程。
 */
import type { Runtime, RuntimeSession } from "@nocturne/core";
import { RuntimeCommandError } from "@nocturne/core";

export interface CommandIo {
  print(text: string): void;
}

export type CommandOutcome = "handled" | "exit" | "unknown";

const SLASH_HELP = `斜杠命令：
  /help          列出命令与快捷键
  /model         显示当前模型与可用模型
  /model <id>    会话内切换模型
  /context       显示上下文组成（分区与 token 估算）
  /compact       手动压缩上下文（L2 摘要）
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
      // 归一化与 --model 同规则（cli.md §4）：
      // 前缀 = 当前 Provider 剥掉；前缀是另一种 api-type 时报错；
      // 其余含斜杠的值与裸 id 都按当前 Provider 下的模型 id 处理
      const raw = rest.join(" ");
      const current = session.state().config.model.provider;
      let bare = raw;
      const slash = raw.indexOf("/");
      if (slash > 0) {
        const prefix = raw.slice(0, slash);
        if (prefix === current) {
          bare = raw.slice(slash + 1);
        } else if (prefix === "openai-compatible" || prefix === "anthropic") {
          io.print(`! 模型前缀 ${prefix} 与当前 Provider ${current} 不一致`);
          return "handled";
        }
      }
      try {
        await session.setModel(`${current}/${bare}`);
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
