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

/** trust / untrust 子命令（写 trust.json 后退出） */
export type TrustCommand = "trust" | "untrust";

export interface CliArgs {
  /** -p/--print：非交互模式 */
  print: boolean;
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
  help: boolean;
  version: boolean;
  /** trust / untrust 子命令 */
  command?: TrustCommand | undefined;
}

export const HELP_TEXT = `nctrn — Nocturne CLI

用法：
  nctrn                        交互模式（REPL）：新建会话
  nctrn -p "<prompt>"          非交互模式：执行一次 Turn 后退出
  nctrn -p                     非交互模式：prompt 从 stdin 读取
  nctrn -c, --continue         恢复当前目录最近的会话
  nctrn --resume <id>          恢复指定会话
  nctrn --sessions             列出会话后退出
  nctrn trust | untrust        信任/取消信任当前目录后退出

参数：
  -p, --print [prompt]   非交互模式；值省略时读 stdin
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
  -h, --help             打印本帮助
  -v, --version          打印版本
`;

export function parseArgs(argv: readonly string[]): CliArgs {
  let result;
  try {
    result = nodeParseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        print: { type: "boolean", short: "p", default: false },
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
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", short: "v", default: false },
      },
    });
  } catch (e) {
    throw new UsageError(e instanceof Error ? e.message : String(e));
  }

  const { values, positionals } = result;
  const print = values.print;

  // trust / untrust 子命令：唯一合法的位置参数（且不与 -p 混用）
  let command: TrustCommand | undefined;
  if (positionals.length > 0) {
    const first = positionals[0];
    if (!print && (first === "trust" || first === "untrust") && positionals.length === 1) {
      command = first;
    } else if (!print) {
      throw new UsageError(`未知的位置参数：${first}`);
    }
  }

  const continueSession = values.continue;
  const resume = values.resume;
  if (continueSession && resume !== undefined) {
    throw new UsageError("--continue 与 --resume 不能同时使用");
  }
  if (command !== undefined && (continueSession || resume !== undefined || values.sessions)) {
    throw new UsageError(`${command} 子命令不接受会话选项`);
  }
  if (values.sessions && (continueSession || resume !== undefined || print)) {
    throw new UsageError("--sessions 是独立的只读命令，不能与恢复或执行组合");
  }
  if (values["force-unlock"] && !continueSession && resume === undefined) {
    throw new UsageError("--force-unlock 只能与 --resume / --continue 搭配");
  }
  if (values.preset !== undefined && (continueSession || resume !== undefined)) {
    throw new UsageError("--preset 只在新建会话时可用；恢复会话请用 /preset 切换");
  }

  return {
    print,
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
    help: values.help,
    version: values.version,
    command,
  };
}
