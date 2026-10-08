/**
 * shell 工具（tools.md 第 6 节）：经系统 shell 执行非交互式命令。
 * 合并 stdout/stderr 为按到达顺序的单一输出并截断；返回退出码；
 * 超时或中断时终止进程树中仍可达的后代（platform/process 负责，Windows 实测
 * 记录见 tools.md）；detached 脱离进程树的后台进程可能无法终止。
 */
import { shellTailStages, stageExecutable } from "../../permission/index.js";
import {
  resolveRealPath,
  SHELL_RISK_BY_DIALECT,
  type ShellDescriptor,
} from "../../platform/index.js";
import type { SubjectRequest } from "../../protocol/index.js";
import type { ToolDefinition, ToolScope } from "../types.js";

interface ShellInput {
  command: string;
  /** 超时（毫秒），默认 120s，上限 30min */
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
  /** 超时结算时的上限毫秒数（timeout 错误下必有，供客户端换算秒数） */
  timeoutMs?: number;
  /** 命令已退出但输出管道仍被后台进程占用，读取端已分离时为 true */
  outputDetached?: boolean;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 1_800_000;
/**
 * 输出管道自然收尾的宽限：仅覆盖子进程 exit 到 stdio 关闭的正常间隙，
 * 正常退出时流已结束、立即返回；到期仍被占用说明有后台进程继承了管道。
 */
const PIPE_DRAIN_GRACE_MS = 500;
const ORPHAN_OUTPUT_NOTE =
  "命令已退出，但仍有后台进程占用输出管道，之后的输出未读取；如果启动了服务器等后台进程，它可能仍在运行。";
/** 缓冲上限：头 64k + 尾 64k，超出丢弃中间（modelContent 再经统一预算截断） */
const BUFFER_HALF = 64_000;

/**
 * 末尾分页拒绝（ADR-0021 第 9 条 + ADR-0022 第 7 节）：任一独立命令的
 * 管道末段以分页工具开头时判为输入错误。分页器名单按生效 shell 的
 * 描述符给出（cmd/PowerShell：more、more.com；bash/sh：more、less；
 * PowerShell 另含 Out-Host -Paging / oh -Paging）；未装配 shell 时回退
 * 全量名单。引号包裹的路径、段首赋值/重定向照常识别。
 */
const DEFAULT_PAGER_EXECUTABLES = new Set(["more", "more.com", "less"]);
const TRAILING_PAGER_MESSAGE =
  "命令以分页工具结尾（more/less/Out-Host -Paging）。分页工具会改坏输出编码、可能等待按键卡住；输出会被自动收集，去掉末尾的分页命令后直接执行即可。需要筛选时先重定向到文件再用 grep 工具。";

/**
 * apply_patch 误用拒绝（ADR-0035 §6）：GPT 模型有时把补丁写成
 * `apply_patch <<'EOF' …` 当 shell 命令执行——命令的第一个词是
 * apply_patch 时按 invalid_input 拒绝，与分页器预检同一机制。
 */
const APPLY_PATCH_MESSAGE =
  "`apply_patch` 不是 shell 命令；工具列表里有 `apply_patch` 时请直接调用该工具，并把补丁原文放进 `input`";

function endsWithPager(command: string, shell: ShellDescriptor | undefined): boolean {
  const pagers =
    shell === undefined
      ? DEFAULT_PAGER_EXECUTABLES
      : new Set(shell.pagers.map((name) => name.toLowerCase()));
  for (const stage of shellTailStages(command)) {
    const exe = stageExecutable(stage);
    if (exe === undefined) continue;
    const base = exe.toLowerCase();
    if (pagers.has(base)) return true;
    for (const fp of shell?.flagPagers ?? []) {
      if (base === fp.exe && fp.flag.test(stage)) return true;
    }
  }
  return false;
}

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
  // ADR-0022：描述保持中性、稳定——具体种类与语法见环境信息 Shell 行
  description:
    "经当前会话选定的 shell 执行非交互式命令（种类与语法见环境信息）。合并 stdout/stderr 输出并截断，返回退出码。超时或中断会尝试终止进程树中仍可达的后代；detached 方式脱离进程树的后台进程可能仍在运行。可能卡住的命令（自己写的脚本、交互式可能等待输入的程序、网络请求）：按预计耗时设较短的超时，或在命令里加 timeout（如 timeout 30 python3 test.py；PowerShell/cmd 用对应写法），超时后根据已有输出定位；已知耗时长的命令（全量测试、构建、安装依赖、大型编译）：按预计耗时直接设足，宁可宽一些，一次跑完。",
  inputSchema: {
    type: "object",
    required: ["command"],
    properties: {
      command: { type: "string", minLength: 1, description: "要执行的命令行" },
      timeoutMs: {
        type: "integer",
        minimum: 1,
        maximum: MAX_TIMEOUT_MS,
        description: `超时毫秒数，默认 ${DEFAULT_TIMEOUT_MS}，上限 ${MAX_TIMEOUT_MS}。可能卡住的命令按预计耗时设较短的超时，或在命令里加 timeout，超时后根据已有输出定位；已知耗时长的命令按预计耗时直接设足，宁可宽一些，一次跑完。`,
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

  permissionSubjects(input: ShellInput, scope: ToolScope): SubjectRequest[] {
    // ADR-0022：主体携带执行它的 shell 种类与描述符的高风险元数据；
    // 权限层据此选分词方言并按元数据做风险匹配（不在 tools 层判定）
    const descriptor = scope.shell?.descriptor;
    return [
      {
        kind: "shell",
        target: input.command,
        ...(descriptor !== undefined ? { shell: descriptor.kind, shellRisk: descriptor.risk } : {}),
        shellRiskByDialect: SHELL_RISK_BY_DIALECT,
      },
    ];
  },

  validateInput(input: ShellInput, scope?: ToolScope): string | undefined {
    const first = stageExecutable(input.command);
    if (first?.toLowerCase() === "apply_patch") {
      return APPLY_PATCH_MESSAGE;
    }
    return endsWithPager(input.command, scope?.shell?.descriptor)
      ? TRAILING_PAGER_MESSAGE
      : undefined;
  },

  async execute(input, ctx) {
    // ADR-0022：显式选择的 shell 不可用时报错并列出可选项
    if (ctx.shell !== undefined && ctx.shell.descriptor === undefined) {
      return {
        status: "error",
        modelContent: `无法执行 shell 命令：${ctx.shell.error ?? "当前 shell 不可用"}`,
        error: {
          code: "tool_failed",
          message: ctx.shell.error ?? "当前 shell 不可用",
        },
      };
    }
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
      ...(ctx.shell?.descriptor !== undefined ? { shell: ctx.shell.descriptor } : {}),
      env: { PYTHONUNBUFFERED: process.env.PYTHONUNBUFFERED ?? "1" },
      // 凭据变量不进模型驱动的子进程环境（provider-setup.md 第 4 节）；
      // envStrip 由装配层按 Provider 条目的 apiKeyEnv + 默认名汇总给出
      ...(ctx.shellEnvStrip !== undefined ? { envStrip: ctx.shellEnvStrip } : {}),
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
    const pumps = Promise.all([pump(proc.stdout, "stdout"), pump(proc.stderr, "stderr")]);
    // pump 在 wait 结算前就失败时，错误仍在下方 race/await 处正常传播；
    // 这里只为消除窗口期内的未处理 rejection
    pumps.catch(() => undefined);
    // spawnShell 的 wait() 在 shell 本体 exit 时结算（process.ts）：
    // 继承了输出管道的后台孙进程不阻止退出判定
    const exit = await proc.wait();
    let outputDetached = false;
    let drainTimer: NodeJS.Timeout | undefined;
    try {
      const drained = await Promise.race([
        pumps.then(() => true),
        new Promise<boolean>((resolve) => {
          drainTimer = setTimeout(() => {
            resolve(false);
          }, PIPE_DRAIN_GRACE_MS);
        }),
      ]);
      if (!drained) {
        proc.detachOutput();
        outputDetached = true;
      }
    } finally {
      if (drainTimer !== undefined) clearTimeout(drainTimer);
    }
    await pumps;

    const durationMs = Date.now() - startedAt;
    const output: ShellOutput = {
      exitCode: exit.code,
      signal: exit.signal,
      timedOut: exit.timedOut,
      killed: exit.killed,
      durationMs,
    };
    if (outputDetached) output.outputDetached = true;
    const captured = buf.text();
    // 分离时追加提示行：ok 路径落在 [exit code …] 之前，错误路径在末尾
    const body = outputDetached
      ? captured + (captured.endsWith("\n") || captured === "" ? "" : "\n") + ORPHAN_OUTPUT_NOTE
      : captured;

    if (exit.timedOut) {
      output.timeoutMs = timeoutMs;
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
