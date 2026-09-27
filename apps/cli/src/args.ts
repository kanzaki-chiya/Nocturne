/**
 * 命令行参数解析（cli.md 第 2 节）。
 * 只用 node:util 的 parseArgs；未知参数/缺值抛 UsageError → 退出码 2。
 */
import { parseArgs as nodeParseArgs } from "node:util";

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/** trust / untrust / setup 子命令（trust 写 trust.json；setup 走配置向导） */
export type CliCommand = "trust" | "untrust" | "setup";

export interface CliArgs {
  /** -p/--print：非交互模式 */
  print: boolean;
  /** --tui：显式选终端界面（与 -p、--cli 互斥；需要 TTY；TTY 下本为默认） */
  tui: boolean;
  /** --inline：TUI 走普通屏幕/行内模式（<Static> 回滚区，不开鼠标；与 --cli、-p 互斥） */
  inline: boolean;
  /** --cli：强制行式 REPL（与 --tui、-p 互斥；非 TTY 时本就为行式） */
  cli: boolean;
  /** -p 后的内联 prompt；省略时 main 从 stdin 读 */
  prompt?: string | undefined;
  model?: string | undefined;
  apiType?: string | undefined;
  baseUrl?: string | undefined;
  apiKeyEnv?: string | undefined;
  /** -c/--continue：恢复当前目录最近的会话 */
  continueSession: boolean;
  /** --resume <id>：恢复指定会话 */
  resume?: string | undefined;
  /** --sessions：列出会话后退出 */
  sessions: boolean;
  /** --force-unlock：恢复前先删残留锁 */
  forceUnlock: boolean;
  /** --preset <name>：新建会话的权限预设 */
  preset?: string | undefined;
  yes: boolean;
  /** --debug：启用诊断 JSONL（等价 NOCTURNE_DEBUG=1） */
  debug: boolean;
  /** --debug-file <path>：诊断输出文件；"-" 写 stderr */
  debugFile?: string | undefined;
  help: boolean;
  version: boolean;
  /** trust / untrust / setup 子命令 */
  command?: CliCommand | undefined;
}

export const HELP_TEXT = `nctrn — Nocturne CLI

用法：
  nctrn                        交互模式：TTY 默认打开 TUI，新建会话
  nctrn --cli                  行式 REPL：新建会话
  nctrn --tui                  显式选择 TUI（TTY 下本为默认；与 --cli 互斥）
  nctrn --inline               TUI 普通屏幕模式：回滚区渲染，不开鼠标（与 --cli、-p 互斥）
  nctrn -p "<prompt>"          非交互模式：执行一次 Turn 后退出
  nctrn -p                     非交互模式：prompt 从 stdin 读取
  nctrn -c, --continue         恢复当前目录最近的会话
  nctrn --resume <id>          恢复指定会话
  nctrn --sessions             列出会话后退出
  nctrn trust | untrust        信任/取消信任当前目录后退出
  nctrn setup                  服务商配置：TTY 打开服务商页；--cli 用行式向导

参数：
  -p, --print [prompt]   非交互模式；值省略时读 stdin
      --cli              行式 REPL（与 --tui、-p、--sessions 互斥）
      --tui              终端界面模式；与 --cli、-p、--sessions 互斥；非 TTY 时退出码 2
      --inline           TUI 普通屏幕/行内模式：<Static> 回滚区、页面临时备用屏、
                         不开鼠标上报；与 --cli、-p、--sessions 互斥；非 TTY 时退出码 2
  -c, --continue         恢复绑定到当前目录的最近会话（没有则新建）
      --resume <id>      恢复指定会话；可与 --model、-p 组合
      --sessions         列出全部会话（id、时间、目录、模型、锁状态）
      --force-unlock     恢复前先删除残留锁（确认持有者已退出再用）
      --preset <name>    权限预设：read-only | default | auto-edit | full-access
                         （仅新建会话；恢复会话以日志为准，用 /preset 切换）
      --model <id>       模型 id（覆盖 NOCTURNE_MODEL 与配置文件）
      --api-type <type>  openai-compatible（默认）| anthropic
      --base-url <url>   Provider 端点（覆盖 NOCTURNE_BASE_URL）
      --api-key-env <名> 读取凭据的环境变量名
  -y, --yes              自动批准需要确认的操作
      --debug            启用诊断输出（等价 NOCTURNE_DEBUG=1）
      --debug-file <p>   诊断输出文件；"-" 写 stderr（等价 NOCTURNE_DEBUG_FILE）
                         缺省写 <NOCTURNE_HOME>/logs/debug-*.jsonl
  -h, --help             打印本帮助
  -v, --version          打印版本
`;

/**
 * 交互界面选择（cli.md §2）：stdin/stdout 均 TTY 时默认 TUI；
 * --cli 强制行式；--tui 显式 TUI；非 TTY 自动行式（显式 --tui 报用法错 2）。
 * 与 -p 无关：print 模式不走这里。
 */
export function resolveUiMode(
  args: Pick<CliArgs, "cli" | "tui" | "inline">,
  interactive: boolean,
): "tui" | "repl" | { error: string } {
  if ((args.tui || args.inline) && !interactive) {
    return { error: "--tui/--inline 需要交互式终端；请用 nctrn 或 nctrn -p <prompt>" };
  }
  return interactive && !args.cli ? "tui" : "repl";
}

export function parseArgs(argv: readonly string[]): CliArgs {
  let result;
  try {
    result = nodeParseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        print: { type: "boolean", short: "p", default: false },
        tui: { type: "boolean", default: false },
        inline: { type: "boolean", default: false },
        cli: { type: "boolean", default: false },
        model: { type: "string" },
        "api-type": { type: "string" },
        "base-url": { type: "string" },
        "api-key-env": { type: "string" },
        continue: { type: "boolean", short: "c", default: false },
        resume: { type: "string" },
        sessions: { type: "boolean", default: false },
        "force-unlock": { type: "boolean", default: false },
        preset: { type: "string" },
        yes: { type: "boolean", short: "y", default: false },
        debug: { type: "boolean", default: false },
        "debug-file": { type: "string" },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", short: "v", default: false },
      },
    });
  } catch (e) {
    throw new UsageError(e instanceof Error ? e.message : String(e));
  }

  const { values, positionals } = result;
  const print = values.print;

  // trust / untrust / setup 子命令：唯一合法的位置参数（且不与 -p 混用）
  let command: CliCommand | undefined;
  if (positionals.length > 0) {
    const first = positionals[0];
    if (
      !print &&
      (first === "trust" || first === "untrust" || first === "setup") &&
      positionals.length === 1
    ) {
      command = first;
    } else if (!print) {
      throw new UsageError(`未知的位置参数：${first}`);
    }
  }

  const continueSession = values.continue;
  const resume = values.resume;
  const tui = values.tui;
  const inline = values.inline;
  const cli = values.cli;
  if (continueSession && resume !== undefined) {
    throw new UsageError("--continue 与 --resume 不能同时使用");
  }
  if (tui && cli) {
    throw new UsageError("--tui 与 --cli 互斥：交互界面只能二选一（TTY 下默认 TUI）");
  }
  if (tui && print) {
    throw new UsageError("--tui 与 -p/--print 互斥：TUI 需要交互式终端");
  }
  if (inline && cli) {
    throw new UsageError("--inline 与 --cli 互斥：--inline 是 TUI 的普通屏幕模式");
  }
  if (inline && print) {
    throw new UsageError("--inline 与 -p/--print 互斥：TUI 需要交互式终端");
  }
  if (cli && print) {
    throw new UsageError("--cli 与 -p/--print 互斥：-p 本身就是非交互模式");
  }
  if (
    command !== undefined &&
    (continueSession || resume !== undefined || values.sessions || tui || inline)
  ) {
    throw new UsageError(`${command} 子命令不接受会话选项`);
  }
  if (command !== undefined && command !== "setup" && cli) {
    throw new UsageError(`${command} 子命令不接受 --cli`);
  }
  if (
    command === "setup" &&
    (values.model !== undefined ||
      values["api-type"] !== undefined ||
      values["base-url"] !== undefined ||
      values["api-key-env"] !== undefined ||
      values.preset !== undefined ||
      values["force-unlock"])
  ) {
    throw new UsageError("setup 子命令不接受模型或服务商参数（向导内交互式配置）");
  }
  if (
    values.sessions &&
    (continueSession || resume !== undefined || print || tui || inline || cli)
  ) {
    throw new UsageError(
      "--sessions 是独立的只读命令，不能与恢复、执行或 --tui/--inline/--cli 组合",
    );
  }
  if (values["force-unlock"] && !continueSession && resume === undefined) {
    throw new UsageError("--force-unlock 只能与 --resume / --continue 搭配");
  }
  if (values.preset !== undefined && (continueSession || resume !== undefined)) {
    throw new UsageError("--preset 只在新建会话时可用；恢复会话请用 /preset 切换");
  }

  return {
    print,
    tui,
    inline,
    cli,
    prompt: print && positionals.length > 0 ? positionals.join(" ") : undefined,
    model: values.model,
    apiType: values["api-type"],
    baseUrl: values["base-url"],
    apiKeyEnv: values["api-key-env"],
    continueSession,
    resume,
    sessions: values.sessions,
    forceUnlock: values["force-unlock"],
    preset: values.preset,
    yes: values.yes,
    debug: values.debug,
    debugFile: values["debug-file"],
    help: values.help,
    version: values.version,
    command,
  };
}
