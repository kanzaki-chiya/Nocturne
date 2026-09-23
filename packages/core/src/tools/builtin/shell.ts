/**
 * shell 工具（tools.md 第 6 节）：经系统 shell 执行非交互式命令。
 * 合并 stdout/stderr 为按到达顺序的单一输出并截断；返回退出码；
 * 超时或中断时终止整个进程树（platform/process 负责，Windows 实测记录见 tools.md）。
 */
import { resolveRealPath } from "../../platform/index.js";
import type { SubjectRequest } from "../../protocol/index.js";
import type { ToolDefinition } from "../types.js";

interface ShellInput {
  command: string;
  /** 超时（毫秒），默认 120s，上限 10min */
  timeoutMs?: number;
  /** 工作目录（默认会话 cwd）；解析后必须位于工作区内 */
  cwd?: string;
}

interface ShellOutput {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  killed: boolean;
  durationMs: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
/** 缓冲上限：头 64k + 尾 64k，超出丢弃中间（modelContent 再经统一预算截断） */
const BUFFER_HALF = 64_000;

/** 头尾保留的合并缓冲：超限丢弃中段但继续排空管道（防止子进程阻塞） */
class OutputBuffer {
  private head = "";
  private tail = "";
  /** 丢弃的字符数 */
  dropped = 0;

  push(chunk: string): void {
    if (this.head.length < BUFFER_HALF) {
      this.head += chunk;
      if (this.head.length > BUFFER_HALF) {
        this.tail = this.head.slice(BUFFER_HALF) + this.tail;
        this.head = this.head.slice(0, BUFFER_HALF);
      }
      return;
    }
    this.tail += chunk;
    if (this.tail.length > BUFFER_HALF) {
      const over = this.tail.length - BUFFER_HALF;
      this.dropped += over;
      this.tail = this.tail.slice(over);
    }
  }

  text(): string {
    if (this.dropped === 0) return this.head + this.tail;
    return `${this.head}\n…[已省略 ${this.dropped} 字符]…\n${this.tail}`;
  }
}

export const shellTool: ToolDefinition<ShellInput, ShellOutput> = {
  name: "shell",
  description:
    "经系统 shell 执行非交互式命令（Windows: cmd /c；POSIX: /bin/sh -c）。合并 stdout/stderr 输出并截断，返回退出码。超时或中断会终止整个进程树。",
  inputSchema: {
    type: "object",
    required: ["command"],
    properties: {
      command: { type: "string", minLength: 1, description: "要执行的命令行" },
      timeoutMs: {
        type: "integer",
        minimum: 1,
        maximum: MAX_TIMEOUT_MS,
        description: `超时毫秒数，默认 ${DEFAULT_TIMEOUT_MS}，上限 ${MAX_TIMEOUT_MS}`,
      },
      cwd: { type: "string", description: "工作目录（须位于工作区内），默认会话 cwd" },
    },
    additionalProperties: false,
  },
  // traits.timeoutMs 是执行器的兜底超时；命令超时由 spawn 的 timeoutMs 先行触发
  traits: {
    mutates: true,
    concurrencySafe: false,
    timeoutMs: MAX_TIMEOUT_MS + 30_000,
  },

  permissionSubjects(input: ShellInput): SubjectRequest[] {
    return [{ kind: "shell", target: input.command }];
  },

  async execute(input, ctx) {
    // cwd：默认会话 cwd；指定时经 realpath 解析后必须在工作区内（junction/符号链接计入）
    let cwd = ctx.cwd;
    if (input.cwd !== undefined) {
      const lexical = ctx.paths.resolve(ctx.cwd, input.cwd);
      const real = await resolveRealPath(ctx.fs, ctx.paths, lexical);
      if (!ctx.paths.isWithin(ctx.workspaceRoot, real)) {
        return {
          status: "error",
          modelContent: `cwd 解析到工作区外：${input.cwd} → ${real}`,
          error: { code: "invalid_input", message: "cwd 必须位于工作区内" },
        };
      }
      const stat = await ctx.fs.stat(real).catch(() => undefined);
      if (stat?.type !== "directory") {
        return {
          status: "error",
          modelContent: `cwd 不是目录：${real}`,
          error: { code: "invalid_input", message: "cwd 不是目录" },
        };
      }
      cwd = real;
    }

    const timeoutMs = Math.min(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    const startedAt = Date.now();
    const proc = ctx.process.spawnShell(input.command, {
      cwd,
      signal: ctx.signal,
      timeoutMs,
    });

    const buf = new OutputBuffer();
    const pump = async (
      stream: AsyncIterable<string>,
      name: "stdout" | "stderr",
    ): Promise<void> => {
      for await (const chunk of stream) {
        buf.push(chunk);
        ctx.progress(chunk, name);
      }
    };
    const [exit] = await Promise.all([
      proc.wait(),
      pump(proc.stdout, "stdout"),
      pump(proc.stderr, "stderr"),
    ]);

    const durationMs = Date.now() - startedAt;
    const output: ShellOutput = {
      exitCode: exit.code,
      signal: exit.signal,
      timedOut: exit.timedOut,
      killed: exit.killed,
      durationMs,
    };
    const body = buf.text();

    if (exit.timedOut) {
      return {
        status: "error",
        modelContent: `命令超过 ${timeoutMs}ms 超时，进程树已终止\n${body}`,
        output,
        error: { code: "timeout", message: `命令超过 ${timeoutMs}ms 超时` },
      };
    }
    if (exit.killed || ctx.signal.aborted) {
      return {
        status: "error",
        modelContent: `命令被中断，进程树已终止\n${body}`,
        output,
        error: { code: "cancelled", message: "命令被中断" },
      };
    }
    return {
      status: "ok",
      modelContent:
        body +
        (body.endsWith("\n") || body === "" ? "" : "\n") +
        `[exit code ${exit.code ?? "null"}${exit.signal !== null ? `, signal ${exit.signal}` : ""}]`,
      output,
    };
  },
};
