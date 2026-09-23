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

export interface CliArgs {
  /** -p/--print：非交互模式 */
  print: boolean;
  /** -p 后的内联 prompt；省略时 main 从 stdin 读 */
  prompt?: string | undefined;
  model?: string | undefined;
  apiType?: string | undefined;
  baseUrl?: string | undefined;
  apiKeyEnv?: string | undefined;
  yes: boolean;
  help: boolean;
  version: boolean;
}

export const HELP_TEXT = `nctrn — Nocturne CLI

用法：
  nctrn                        交互模式（REPL）
  nctrn -p "<prompt>"          非交互模式：执行一次 Turn 后退出
  nctrn -p                     非交互模式：prompt 从 stdin 读取

参数：
  -p, --print [prompt]   非交互模式；值省略时读 stdin
      --model <id>       模型 id（覆盖 NOCTURNE_MODEL）
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
  if (!print && positionals.length > 0) {
    throw new UsageError(`未知的位置参数：${positionals[0]}`);
  }

  return {
    print,
    prompt: print && positionals.length > 0 ? positionals.join(" ") : undefined,
    model: values.model,
    apiType: values["api-type"],
    baseUrl: values["base-url"],
    apiKeyEnv: values["api-key-env"],
    yes: values.yes,
    help: values.help,
    version: values.version,
  };
}
