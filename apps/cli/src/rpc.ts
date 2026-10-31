/**
 * `nctrn rpc --stdio`：RPC 服务端入口（ADR-0044 第 2、7 节、docs/protocols/rpc.md）。
 *
 * 复用 CLI 的配置加载、代理与 MCP 装配，把 Runtime 经 stdin/stdout 上的 JSON-RPC 交给
 * 进程外客户端。stdout 只写 JSON-RPC 报文，其余输出一律走 stderr。stdin 关闭
 * （客户端退出或崩溃）、`shutdown` 请求、收到终止信号都走同一套清理：中断运行中的 Turn，
 * 关闭全部会话（刷盘、释放会话锁；会话关闭时 MCP 服务器进程随之清理），然后退出。
 */
import type { Readable, Writable } from "node:stream";

import { createAcpConnector } from "@nocturne/acp";
import { createRuntime, type Platform } from "@nocturne/core";
import { createMcpConnector, type RuntimeMcpSource } from "@nocturne/mcp";
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
    warn: console.warn,
    error: console.error,
  };
  const write = (...parts: unknown[]): void => {
    stderr.write(`${parts.map((p) => (typeof p === "string" ? p : String(p))).join(" ")}\n`);
  };
  console.log = write;
  console.info = write;
  console.debug = write;
  console.warn = write;
  console.error = write;
  return () => {
    console.log = originals.log;
    console.info = originals.info;
    console.debug = originals.debug;
    console.warn = originals.warn;
    console.error = originals.error;
  };
}

/** 运行 RPC 服务端直到客户端断开或请求关闭；返回退出码 */
export async function runRpcStdio(options: RunRpcOptions): Promise<number> {
  const { args, platform, cwd, io } = options;
  const restoreConsole = redirectConsoleToStderr(io.stderr);
  // 桌面浏览器启动凭证（desktop-browser.md 第 1 节）：进程专属环境字段，读出后立即删除，
  // 不进 shellEnvStrip/子进程/日志；无该字段时（CLI/TUI 自行启动）无内置来源。
  const bootstrap = takeDesktopBrowserBootstrap();
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
      agentPipe: args.agentPipe,
      remote: {
        home: runtimeConfig.nocturneHome,
        credentials: runtimeConfig.credentials,
        diagnostics: (state) => {
          io.stderr.write(`[remote] ${state}\n`);
        },
      },
      createRuntime: async ({ interactive }) => {
        const runtime = await createRuntime({
          cwd,
          config: runtimeConfig,
          interactive,
          scheduler: args.scheduler,
          subagent: { background: true },
          permissions: { autoApproveAsk: false },
          mcp:
            bootstrap === undefined
              ? createMcpConnector()
              : createMcpConnector({ runtimeServers: [createDesktopBrowserSource(bootstrap)] }),
          externalAgents: createAcpConnector(platform),
          debug: {
            enabled: debugEnabled,
            file: args.debugFile ?? process.env.NOCTURNE_DEBUG_FILE,
          },
        });
        return {
          runtime,
          sessionsDir,
          // 后台退出前停调度器：中止运行中的定时任务、释放锁文件
          dispose: () => runtime.stopScheduler(),
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

interface DesktopBrowserBootstrap {
  version: 1;
  port: number;
  secret: string;
}

/**
 * 读出并删除进程专属的桌面浏览器启动凭证（desktop-browser.md 第 1 节）。
 * 字段只在本进程内存短暂存在，不进 argv/日志/前端；解析失败视为无来源。
 */
function takeDesktopBrowserBootstrap(): DesktopBrowserBootstrap | undefined {
  const raw = process.env.NOCTURNE_DESKTOP_BROWSER_BOOTSTRAP;
  if (raw === undefined) return undefined;
  delete process.env.NOCTURNE_DESKTOP_BROWSER_BOOTSTRAP;
  try {
    const parsed = JSON.parse(raw) as { version?: unknown; port?: unknown; secret?: unknown };
    if (parsed.version !== 1) return undefined;
    if (typeof parsed.port !== "number" || !Number.isInteger(parsed.port) || parsed.port <= 0) {
      return undefined;
    }
    if (typeof parsed.secret !== "string" || parsed.secret.length === 0) return undefined;
    return { version: 1, port: parsed.port, secret: parsed.secret };
  } catch {
    return undefined;
  }
}

/**
 * 桌面内置浏览器运行时来源：经回环 HTTP 取每根会话独立 bearer，不写 mcp.json。
 * bootstrap 口令只用于 /bindings 获取绑定；MCP 调用只用绑定 bearer。凭据只放内存，
 * 经 credentials.get 注入请求头，不进 URL/日志/模型。直连 127.0.0.1，不走代理、不跟随重定向。
 */
function createDesktopBrowserSource(bootstrap: DesktopBrowserBootstrap): RuntimeMcpSource {
  const base = `http://127.0.0.1:${bootstrap.port}`;
  return {
    open: async (scope) => {
      const binding = await fetchBinding(base, bootstrap.secret, scope.sessionId);
      if (binding === undefined) {
        // 无绑定时提供空来源：不断开会话，仅无桌面浏览器工具
        return {
          servers: [],
          credentials: { get: () => Promise.resolve(undefined) },
          callerMetadata: true,
          close: () => Promise.resolve(),
        };
      }
      const bearer = binding.bearer;
      const bindingId = binding.bindingId;
      let released = false;
      return {
        servers: [
          {
            name: "desktop_browser",
            origin: "app",
            type: "http",
            url: `${base}/mcp/${bindingId}`,
            headers: { authorization: { stored: true } },
          },
        ],
        credentials: {
          get: (id) =>
            Promise.resolve(
              id === "mcp/desktop_browser/authorization" && !released
                ? `Bearer ${bearer}`
                : undefined,
            ),
        },
        callerMetadata: true,
        close: () => {
          if (released) return Promise.resolve();
          released = true;
          return fetch(`${base}/bindings/${encodeURIComponent(bindingId)}`, {
            method: "DELETE",
            headers: { authorization: `Bearer ${bearer}` },
          }).then(
            () => undefined,
            () => undefined,
          );
        },
      };
    },
  };
}

async function fetchBinding(
  base: string,
  secret: string,
  rootSessionId: string,
): Promise<{ bindingId: string; bearer: string } | undefined> {
  try {
    const res = await fetch(`${base}/bindings`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
      body: JSON.stringify({ rootSessionId }),
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { bindingId?: unknown; bearer?: unknown };
    if (typeof body.bindingId !== "string" || typeof body.bearer !== "string") return undefined;
    if (body.bindingId.length === 0 || body.bearer.length === 0) return undefined;
    return { bindingId: body.bindingId, bearer: body.bearer };
  } catch {
    return undefined;
  }
}
