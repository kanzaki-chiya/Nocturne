/**
 * `nctrn rpc --stdio`：RPC 服务端入口（ADR-0044 第 2、7 节、docs/protocols/rpc.md）。
 *
 * 复用 CLI 的配置加载、代理与 MCP 装配，把 Runtime 经 stdin/stdout 上的 JSON-RPC 交给
 * 进程外客户端。stdout 只写 JSON-RPC 报文，其余输出一律走 stderr。stdin 关闭
 * （客户端退出或崩溃）、`shutdown` 请求、收到终止信号都走同一套清理：中断运行中的 Turn，
 * 关闭全部会话（刷盘、释放会话锁；会话关闭时 MCP 服务器进程随之清理），然后退出。
 */
import type { Readable, Writable } from "node:stream";

import { createRuntime, type Platform } from "@nocturne/core";
import { createMcpConnector } from "@nocturne/mcp";
import { createRpcServer, createStdioTransport } from "@nocturne/rpc/server";

import type { CliArgs } from "./args.js";
import { collectConfig, makeConfigLoader } from "./config.js";

export interface RpcIo {
  stdin: Readable;
  stdout: Writable;
  stderr: Writable;
}

export interface RunRpcOptions {
  args: CliArgs;
  platform: Platform;
  cwd: string;
  version: string;
  io: RpcIo;
  /** 收到终止信号时的挂钩（测试注入；默认监听进程信号） */
  onTerminate?: ((handler: () => void) => () => void) | undefined;
}

/** 把 console 输出改道到 stderr：stdout 被协议独占，任何依赖库误写都不能污染它 */
function redirectConsoleToStderr(stderr: Writable): () => void {
  const originals = {
    log: console.log,
    info: console.info,
    debug: console.debug,
  };
  const write = (...parts: unknown[]): void => {
    stderr.write(`${parts.map((p) => (typeof p === "string" ? p : String(p))).join(" ")}\n`);
  };
  console.log = write;
  console.info = write;
  console.debug = write;
  return () => {
    console.log = originals.log;
    console.info = originals.info;
    console.debug = originals.debug;
  };
}

/** 运行 RPC 服务端直到客户端断开或请求关闭；返回退出码 */
export async function runRpcStdio(options: RunRpcOptions): Promise<number> {
  const { args, platform, cwd, io } = options;
  const restoreConsole = redirectConsoleToStderr(io.stderr);
  try {
    // 与 trust/setup 一致：不要求已有模型或服务商——桌面端首次启动时还没配置，
    // 之后经配置相关方法补齐；已声明却无法解析的配置照常报错（退出码 2）
    const collected = await collectConfig(args, platform, undefined, { requireModel: false });
    if (!collected.ok) {
      io.stderr.write(`配置错误：\n${collected.problems.map((p) => `  - ${p}`).join("\n")}\n`);
      return 2;
    }
    for (const w of collected.config.warnings) io.stderr.write(`! ${w}\n`);

    const debugEnabled = args.debug || /^(1|true|yes|on)$/i.test(process.env.NOCTURNE_DEBUG ?? "");
    const runtimeConfig = collected.config.runtime;
    const { sessionsDir } = runtimeConfig;

    const server = createRpcServer({
      nocturneVersion: options.version,
      createRuntime: async ({ interactive }) => {
        const runtime = await createRuntime({
          cwd,
          config: runtimeConfig,
          interactive,
          permissions: { autoApproveAsk: false },
          mcp: createMcpConnector(),
          debug: {
            enabled: debugEnabled,
            file: args.debugFile ?? process.env.NOCTURNE_DEBUG_FILE,
          },
        });
        return {
          runtime,
          sessionsDir,
          // 服务商配置经 RPC 开放（rpc.md 3.3）：变更方法后服务端串行重载，
          // 等价 CLI 的 updateProviders(await reloadConfig())
          providerConfig: {
            config: runtimeConfig,
            reload: makeConfigLoader(args, platform),
            workspaceRoot: cwd,
          },
        };
      },
      // 诊断只含方法名与结果，从不含参数（参数里可能有密钥明文）
      diagnostics: debugEnabled
        ? (record) => {
            io.stderr.write(`[rpc] ${JSON.stringify(record)}\n`);
          }
        : undefined,
    });

    const transport = createStdioTransport(io.stdin, io.stdout);
    const terminate = (options.onTerminate ?? defaultOnTerminate)(() => {
      // 终止信号等同于客户端断开：走同一套清理
      transport.close();
    });
    try {
      await server.serve(transport);
    } finally {
      terminate();
    }
    return 0;
  } catch (e) {
    io.stderr.write(`! ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  } finally {
    restoreConsole();
  }
}

function defaultOnTerminate(handler: () => void): () => void {
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const s of signals) process.on(s, handler);
  return () => {
    for (const s of signals) process.off(s, handler);
  };
}
