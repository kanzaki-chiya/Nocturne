/**
 * `nctrn acp`：ACP Agent 服务端入口（ADR-0120 §1–3）。
 *
 * 复用 CLI 的配置加载、Runtime 装配与 MCP 连接器，通过 stdin/stdout 上的
 * Agent Client Protocol（NDJSON）为 Paseo 等外部宿主提供服务。
 * stdout 只写协议帧，其余日志与诊断一律走 stderr。
 * stdin EOF、stdout 断线（EPIPE）或终止信号都走同一套清理：中断在途 turn，
 * 关闭本进程持有的会话（刷盘、释放会话锁与宿主/配置 MCP 进程），关闭 Runtime 并退出。
 */
import type { Readable, Writable } from "node:stream";

import { createAcpConnector } from "@nocturne/acp";
import { createAcpAgentServer, createAcpStdioStream } from "@nocturne/acp/agent";
import {
  createRuntime,
  RuntimeCommandError,
  type ModelRef,
  type Platform,
  type Runtime,
  type RuntimeConfig,
} from "@nocturne/core";
import { createMcpConnector } from "@nocturne/mcp";

import type { CliArgs } from "./args.js";
import { resolveBuiltinPluginsDir } from "./builtin-plugins.js";
import { effectiveProviderId, makeConfigLoader, normalizeModelRef } from "./config.js";

export interface AcpIo {
  stdin: Readable;
  stdout: Writable;
  stderr: Writable;
}

export interface RunAcpOptions {
  args: CliArgs;
  platform: Platform;
  cwd: string;
  version: string;
  io: AcpIo;
  /** 收到终止信号时的挂钩（测试注入；默认监听进程信号） */
  onTerminate?: ((handler: () => void) => () => void) | undefined;
}

/** 把 console 输出改道到 stderr：stdout 被 ACP 协议帧独占，任何依赖库都不能污染它 */
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

function defaultOnTerminate(handler: () => void): () => void {
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const s of signals) process.on(s, handler);
  return () => {
    for (const s of signals) process.off(s, handler);
  };
}

function hasProviderCredentials(
  provider: RuntimeConfig["base"]["providers"][number],
  runtimeConfig: RuntimeConfig,
  env: (name: string) => string | undefined,
): boolean {
  if (provider.auth !== undefined && provider.auth.kind !== "apiKey") return true;
  const envKey =
    provider.apiKeyEnv !== undefined && env(provider.apiKeyEnv) !== ""
      ? env(provider.apiKeyEnv)
      : undefined;
  return envKey !== undefined || runtimeConfig.credentials.has(provider.id);
}

function checkProviderReady(
  providerId: string,
  providers: readonly RuntimeConfig["base"]["providers"][number][],
  runtimeConfig: RuntimeConfig,
  env: (name: string) => string | undefined,
): string | undefined {
  const provider = providers.find((p) => p.id === providerId);
  if (provider === undefined) {
    return `Provider "${providerId}" 未配置`;
  }
  const type = provider.type ?? "openai-compatible";
  if (type === "openai-compatible" && (provider.baseURL === undefined || provider.baseURL === "")) {
    return `Provider "${providerId}" 缺少 baseURL`;
  }
  if (!hasProviderCredentials(provider, runtimeConfig, env)) {
    return provider.apiKeyEnv !== undefined
      ? `缺少凭据：环境变量 ${provider.apiKeyEnv} 未设置，凭据存储中也没有 "${provider.id}" 的密钥`
      : `缺少凭据：Provider "${provider.id}" 未配置密钥`;
  }
  return undefined;
}

function splitModelRef(ref: string): ModelRef {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) {
    throw new RuntimeCommandError("invalid_model", `模型引用必须是 "provider/model" 形式：${ref}`);
  }
  return { provider: ref.slice(0, slash), model: ref.slice(slash + 1) };
}

async function resolveWorkspaceModel(
  runtime: Runtime,
  runtimeConfig: RuntimeConfig,
  workspaceRoot: string,
  explicitModel: string | undefined,
  env: (name: string) => string | undefined,
): Promise<ModelRef | undefined> {
  const { resolved } = await runtimeConfig.forWorkspace(workspaceRoot);
  const candidate =
    explicitModel !== undefined
      ? splitModelRef(explicitModel)
      : runtime.defaultModel({ workspaceRoot });

  if (candidate !== undefined) {
    const problem = checkProviderReady(candidate.provider, resolved.providers, runtimeConfig, env);
    if (problem !== undefined) {
      throw new RuntimeCommandError("invalid_model", problem);
    }
    return candidate;
  }

  // 未显式设置默认模型时，回退到首个已就绪（配置与凭据完整）的可用模型
  const available = runtime
    .listModels({ workspaceRoot })
    .filter((m) => m.unavailable === undefined);
  for (const model of available) {
    if (
      checkProviderReady(model.ref.provider, resolved.providers, runtimeConfig, env) === undefined
    ) {
      return model.ref;
    }
  }
  return undefined;
}

/** 运行 ACP Agent 服务端直到连接关闭或收到终止信号；返回退出码 */
export async function runAcpStdio(options: RunAcpOptions): Promise<number> {
  const { args, platform, cwd, io } = options;
  const restoreConsole = redirectConsoleToStderr(io.stderr);
  let runtime: Runtime | undefined;
  try {
    const env = (name: string): string | undefined => platform.env(name);
    const cliOrEnvModel =
      args.model !== undefined && args.model !== "" ? args.model : env("NOCTURNE_MODEL");
    let explicitModel: string | undefined;
    if (cliOrEnvModel !== undefined && cliOrEnvModel !== "") {
      const normalized = normalizeModelRef(cliOrEnvModel, effectiveProviderId(args, env));
      if (!normalized.ok) {
        io.stderr.write(`配置错误：\n  - ${normalized.problem}\n`);
        return 2;
      }
      explicitModel = normalized.ref;
    }

    const runtimeConfig = await makeConfigLoader(args, platform, env)();
    for (const w of runtimeConfig.base.warnings) io.stderr.write(`! ${w}\n`);

    const debugEnabled = args.debug || /^(1|true|yes|on)$/i.test(env("NOCTURNE_DEBUG") ?? "");
    const builtinPluginsDir = resolveBuiltinPluginsDir();
    runtime = await createRuntime({
      cwd,
      config: runtimeConfig,
      interactive: true,
      scheduler: false,
      subagent: { background: true },
      shell: { background: true },
      permissions: { autoApproveAsk: false },
      mcp: createMcpConnector(),
      externalAgents: createAcpConnector(platform),
      ...(builtinPluginsDir !== undefined ? { builtinPluginsDir } : {}),
      debug: {
        enabled: debugEnabled,
        file: args.debugFile ?? env("NOCTURNE_DEBUG_FILE"),
      },
    });
    const activeRuntime = runtime;

    const server = createAcpAgentServer({
      runtime: activeRuntime,
      platform,
      version: options.version,
      ...(args.preset !== undefined ? { permissionPreset: args.preset } : {}),
      resolveModel: (workspaceRoot) =>
        resolveWorkspaceModel(activeRuntime, runtimeConfig, workspaceRoot, explicitModel, env),
      diagnostics: debugEnabled
        ? (record) => {
            io.stderr.write(`[acp] ${JSON.stringify(record)}\n`);
          }
        : undefined,
    });

    const stream = createAcpStdioStream(io.stdin, io.stdout, () => {
      void server.close();
    });
    const unhookTerminate = (options.onTerminate ?? defaultOnTerminate)(() => {
      void server.close();
    });
    try {
      await server.serve(stream);
    } finally {
      unhookTerminate();
      await server.close();
    }
    return 0;
  } catch (e) {
    io.stderr.write(`! ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  } finally {
    if (runtime !== undefined) {
      await runtime.close().catch(() => undefined);
    }
    restoreConsole();
  }
}
