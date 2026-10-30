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

/** trust / untrust / setup / rpc / mcp / grants 子命令（trust 写 trust.json；setup 走配置向导；rpc 是 RPC 服务端；mcp 是对外 MCP 服务器桥） */
export type CliCommand = "trust" | "untrust" | "setup" | "rpc" | "mcp" | "grants";

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
  /** --stdio：RPC 服务端走 stdin/stdout（rpc 子命令必需，ADR-0044） */
  stdio: boolean;
  /** --scheduler：rpc 后台里运行定时任务调度器（ADR-0064；只有桌面端拉起的后台传） */
  scheduler: boolean;
  /** --agent-pipe：rpc 后台监听本机外部 agent 管道（ADR-0074；只有桌面端拉起的后台传） */
  agentPipe: boolean;
  /** --name <label>：mcp 子命令可选桥身份槽名称（ADR-0074） */
  mcpName?: string | undefined;
  help: boolean;
  version: boolean;
  /** trust / untrust / setup / rpc / mcp 子命令 */
  command?: CliCommand | undefined;
  grantsAction?: "list" | "revoke" | undefined;
  grantsIndex?: number | undefined;
  grantsAll?: boolean | undefined;
  workspace?: string | undefined;
}

export const HELP_TEXT = `nctrn — Nocturne CLI

用法：
  nctrn                        交互模式：TTY 默认打开 TUI，新建会话
  nctrn --cli                  行式 REPL：新建会话
  nctrn --tui                  显式选择 TUI（TTY 下本为默认；与 --cli 互斥）
  nctrn --inline               TUI 普通屏幕模式：回滚区渲染，不开鼠标（与 --cli、-p 互斥）
  nctrn -p "<prompt>"          非交互模式：执行一轮后退出
  nctrn -p                     非交互模式：prompt 从 stdin 读取
  nctrn -c, --continue         恢复当前目录最近的会话
  nctrn --resume <id>          恢复指定会话
  nctrn --sessions             列出会话后退出
  nctrn grants [list] [--workspace <dir>]  查看项目授权
  nctrn grants revoke <编号|--all> [--workspace <dir>]  撤销项目授权
  nctrn trust | untrust        信任/取消信任当前目录后退出
  nctrn setup                  服务商配置：TTY 打开服务商页；--cli 用行式向导
  nctrn rpc --stdio            RPC 服务端：stdin/stdout 上的 JSON-RPC（桌面端等进程外客户端使用）
  nctrn rpc --stdio --scheduler  同上，并在本进程里运行定时任务调度器（桌面端后台用）
  nctrn rpc --stdio --agent-pipe 同上，并监听本机外部 agent 管道（桌面端后台用）
  nctrn mcp [--name <label>]   对外 MCP 服务器桥（stdio，连接桌面端后台驱动会话）

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
      --preset <name>    权限预设：read-only | default | auto-edit | guarded | smart | bypass
                         （仅新建会话；恢复会话以日志为准，用 /preset 切换）
      --model <id>       模型 id（覆盖 NOCTURNE_MODEL 与配置文件）
      --api-type <type>  openai-compatible（默认）| anthropic
      --base-url <url>   Provider 端点（覆盖 NOCTURNE_BASE_URL）
      --api-key-env <名> 读取凭据的环境变量名
      --stdio            rpc 子命令的传输：从 stdin 读、向 stdout 写 JSON-RPC，诊断走 stderr
      --scheduler        rpc 子命令：在本进程里运行定时任务调度器（同一 NOCTURNE_HOME 只有一个调度器）
      --agent-pipe       rpc 子命令：在本进程里监听本机外部 agent 管道（桌面端后台使用）
      --name <label>     mcp 子命令：指定独立桥身份槽名称（保存在 <NOCTURNE_HOME>/mcp-bridge/<label>.json）
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
        workspace: { type: "string" },
        all: { type: "boolean", default: false },
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
        stdio: { type: "boolean", default: false },
        scheduler: { type: "boolean", default: false },
        "agent-pipe": { type: "boolean", default: false },
        name: { type: "string" },
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

  // trust / untrust / setup / rpc 子命令：唯一合法的位置参数（且不与 -p 混用）
  let command: CliCommand | undefined;
  let grantsAction: "list" | "revoke" | undefined;
  let grantsIndex: number | undefined;
  if (positionals.length > 0) {
    const first = positionals[0];
    if (
      !print &&
      (first === "trust" ||
        first === "untrust" ||
        first === "setup" ||
        first === "rpc" ||
        first === "mcp") &&
      positionals.length === 1
    ) {
      command = first;
    } else if (!print && first === "grants") {
      command = "grants";
      const action = positionals[1] ?? "list";
      if (action === "list" && positionals.length <= 2 && !values.all) grantsAction = "list";
      else if (
        action === "revoke" &&
        ((values.all && positionals.length === 2) ||
          (!values.all && positionals.length === 3 && /^[1-9]\d*$/.test(positionals[2] ?? "")))
      ) {
        grantsAction = "revoke";
        if (!values.all) grantsIndex = Number(positionals[2]);
      } else
        throw new UsageError("用法：nctrn grants [list] | revoke <编号|--all> [--workspace <dir>]");
    } else if (!print) {
      throw new UsageError(`未知的位置参数：${first}`);
    }
  }

  if (command !== "grants" && (values.workspace !== undefined || values.all))
    throw new UsageError("--workspace / --all 只能与 grants 搭配");
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
  if (command === "rpc") {
    if (!values.stdio) {
      throw new UsageError("rpc 子命令目前只支持 --stdio 传输：nctrn rpc --stdio");
    }
    if (print || cli || values.yes || values.preset !== undefined) {
      throw new UsageError(
        "rpc 子命令不接受 -p、--cli、--yes 与 --preset（会话与权限由客户端决定）",
      );
    }
  } else if (values.stdio) {
    throw new UsageError("--stdio 只能与 rpc 子命令搭配：nctrn rpc --stdio");
  }
  if (values.scheduler && command !== "rpc") {
    throw new UsageError("--scheduler 只能与 rpc 子命令搭配：nctrn rpc --stdio --scheduler");
  }
  if (values["agent-pipe"] && command !== "rpc") {
    throw new UsageError("--agent-pipe 只能与 rpc 子命令搭配：nctrn rpc --stdio --agent-pipe");
  }
  if (values.name !== undefined && command !== "mcp") {
    throw new UsageError("--name 只能与 mcp 子命令搭配：nctrn mcp --name <label>");
  }
  if (
    command === "mcp" &&
    (print ||
      cli ||
      values.yes ||
      values.preset !== undefined ||
      values.model !== undefined ||
      values["api-type"] !== undefined ||
      values["base-url"] !== undefined ||
      values["api-key-env"] !== undefined ||
      values["force-unlock"])
  ) {
    throw new UsageError("mcp 子命令只接受可选的 --name <label>");
  }
  if (command !== undefined && command !== "setup" && command !== "rpc" && cli) {
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
    stdio: values.stdio,
    scheduler: values.scheduler,
    agentPipe: values["agent-pipe"],
    mcpName: values.name,
    debug: values.debug,
    debugFile: values["debug-file"],
    help: values.help,
    version: values.version,
    command,
    grantsAction,
    grantsIndex,
    grantsAll: command === "grants" ? values.all : undefined,
    workspace: values.workspace,
  };
}
