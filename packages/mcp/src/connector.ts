/**
 * MCP 连接器（mcp.md 第 3–5 节）：会话级生命周期。
 * - open() 并行启动全部服务器；单服务器失败降级为 failed，不阻塞会话；
 * - 崩溃惰性重连（每会话每服务器至多 MAX_RESTARTS 次）；
 * - tools/list_changed 与重连刷新的工具集先暂存，applyPendingTools()
 *   在 Turn 边界统一应用（mcp.md 第 5 节）；
 * - close() 终止全部服务器进程树。
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createHash } from "node:crypto";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  ToolListChangedNotificationSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type {
  McpConnector,
  McpOpenScope,
  McpServerConfig,
  McpServerStatus,
  McpSession,
  McpToolDiff,
  McpProbeResult,
  McpValue,
  PipeProcess,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from "@nocturne/core";

import { mcpToolName } from "./names.js";
import { StdioPipeTransport } from "./transport.js";

const CLIENT_NAME = "nocturne";
const CLIENT_VERSION = "0.7.3";
const DEFAULT_STARTUP_MS = 15_000;
const MAX_STARTUP_MS = 60_000;
const DEFAULT_CALL_MS = 60_000;
const MAX_CALL_MS = 600_000;
const MAX_RESTARTS = 3;

interface ServerRuntime {
  proc?: PipeProcess | undefined;
  transport: StdioPipeTransport | StreamableHTTPClientTransport;
  client: Client;
}

interface Server {
  cfg: McpServerConfig;
  state: McpServerStatus["state"];
  error?: string | undefined;
  restarts: number;
  runtime?: ServerRuntime | undefined;
  /** 当前注册进会话的工具（注册名 → 定义） */
  tools: Map<string, ToolDefinition>;
  /** Turn 边界待应用的工具集（list_changed / 重连刷新的暂存） */
  staged?: Map<string, ToolDefinition> | undefined;
  refreshing?: Promise<void> | undefined;
  restarting?: Promise<boolean> | undefined;
  closed: boolean;
  controller?: AbortController | undefined;
  fingerprint?: string | undefined;
  code?: NonNullable<McpProbeResult["error"]>["code"] | undefined;
  httpStatus?: number | undefined;
  stderrTail?: string[] | undefined;
  secrets: string[];
  listed?: McpProbeResult["tools"] | undefined;
}

function err(code: string, message: string): ToolResult {
  return { status: "error", modelContent: message, error: { code, message } };
}

/** ${NAME} 展开；未定义变量展开为空串并告警（mcp.md 第 2 节） */
async function expandEnv(
  env: Record<string, McpValue> | undefined,
  scope: McpOpenScope,
  st: Server,
): Promise<Record<string, string> | undefined> {
  if (env === undefined) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string") {
      const id = `mcp/${st.cfg.name}/${st.cfg.type === "http" ? key.toLowerCase() : key}`;
      const secret = await scope.credentials?.get(id, { fresh: true });
      if (secret === undefined) {
        st.code = "mcp_secret_missing";
        st.error = `MCP 服务器 ${st.cfg.name} 缺少凭据 ${key}`;
        throw new Error(`MCP 服务器 ${st.cfg.name} 缺少凭据 ${key}`);
      }
      st.secrets.push(secret);
      out[key] = secret;
      continue;
    }
    const expanded = value.replaceAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => {
      const v = scope.platform.env(name);
      if (v === undefined) {
        scope.warn(
          "mcp_env_missing",
          `MCP 服务器 ${st.cfg.name}: ${key} 引用的环境变量 ${name} 未定义，已展开为空串`,
        );
        return "";
      }
      return v;
    });
    out[key] = expanded;
    if (expanded !== value) st.secrets.push(expanded);
  }
  return out;
}

function safeText(st: Server, text: string): string {
  for (const secret of st.secrets) if (secret) text = text.replaceAll(secret, "***");
  return text.replace(/(authorization|token|password|secret|api[_-]?key)\s*[:=]\s*\S+/gi, "$1=***");
}

function safeOutput(st: Server, value: unknown): unknown {
  if (typeof value === "string") return safeText(st, value);
  if (Array.isArray(value)) return value.map((item: unknown) => safeOutput(st, item));
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [safeText(st, key), safeOutput(st, item)]),
    );
  return value;
}

function fingerprint(cfg: McpServerConfig, values: Record<string, string> | undefined): string {
  const normalized = {
    type: cfg.type ?? "stdio",
    command: cfg.command,
    args: cfg.args ?? [],
    cwd: cfg.cwd ?? "",
    url: cfg.url,
    enabled: cfg.enabled !== false,
    startupTimeoutMs: cfg.startupTimeoutMs ?? DEFAULT_STARTUP_MS,
    callTimeoutMs: cfg.callTimeoutMs ?? DEFAULT_CALL_MS,
    values: Object.entries(values ?? {})
      .map(([key, value]) => [cfg.type === "http" ? key.toLowerCase() : key, value])
      .sort(([a], [b]) => (a ?? "").localeCompare(b ?? "")),
  };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

async function stopServer(st: Server): Promise<void> {
  st.closed = true;
  st.controller?.abort();
  const runtime = st.runtime;
  st.runtime = undefined;
  if (!runtime) return;
  if (runtime.transport instanceof StreamableHTTPClientTransport && runtime.transport.sessionId) {
    const status = st.httpStatus;
    const code = st.code;
    await timeout(runtime.transport.terminateSession(), 2000, "MCP 结束会话").catch(
      () => undefined,
    );
    st.httpStatus = status;
    st.code = code;
  }
  await runtime.client.close().catch(() => undefined);
  await runtime.proc?.kill().catch(() => undefined);
  if (runtime.transport instanceof StdioPipeTransport) {
    await runtime.transport.whenStderrDrained();
    st.stderrTail = safeText(st, runtime.transport.stderrText())
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-20)
      .map((line) => line.slice(0, 300));
  }
}

function timeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const t = new Promise<never>((_r, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} 超时（${ms}ms）`));
    }, ms);
    timer.unref();
  });
  return Promise.race([promise, t]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new Error("MCP 启动已取消");
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => {
      reject(new Error("MCP 启动已取消"));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([promise, cancelled]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

function toolError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function fetchToolDefs(
  scope: McpOpenScope,
  st: Server,
): Promise<Map<string, ToolDefinition>> {
  const client = st.runtime?.client;
  if (client === undefined) throw new Error("客户端未连接");
  const defs = new Map<string, ToolDefinition>();
  st.listed = [];
  let cursor: string | undefined;
  do {
    const res = await client.listTools(cursor !== undefined ? { cursor } : {});
    for (const tool of res.tools) {
      st.listed.push({
        name: safeText(st, tool.name),
        description: tool.description ? safeText(st, tool.description) : undefined,
      });
      const def = wrapTool(scope, st, tool, new Set(defs.keys()));
      defs.set(def.name, def);
    }
    cursor = res.nextCursor;
  } while (cursor !== undefined);
  return defs;
}

/** 启动/重连一台服务器：spawn → initialize → tools/list；失败写 st.error 并抛出 */
async function connectServer(scope: McpOpenScope, st: Server): Promise<void> {
  const started = Date.now();
  const controller = new AbortController();
  st.controller = controller;
  const startupMs = Math.min(st.cfg.startupTimeoutMs ?? DEFAULT_STARTUP_MS, MAX_STARTUP_MS);
  const cwd =
    st.cfg.cwd !== undefined
      ? scope.platform.paths.isAbsolute(st.cfg.cwd)
        ? st.cfg.cwd
        : scope.platform.paths.resolve(scope.workspaceRoot, st.cfg.cwd)
      : scope.cwd;
  let values: Record<string, string> | undefined;
  try {
    values = await abortable(
      timeout(
        expandEnv(st.cfg.type === "http" ? st.cfg.headers : st.cfg.env, scope, st),
        startupMs,
        `MCP 服务器 ${st.cfg.name} 启动`,
      ),
      controller.signal,
    );
  } catch (e) {
    if (e instanceof Error && e.message.includes("超时")) st.code = "startup_timeout";
    throw e;
  }
  if (st.closed || controller.signal.aborted) throw new Error("MCP 启动已取消");
  st.fingerprint = fingerprint(st.cfg, values);
  let proc: PipeProcess | undefined;
  let transport: StdioPipeTransport | StreamableHTTPClientTransport;
  if (st.cfg.type === "http") {
    st.code = "connect_failed";
    transport = new StreamableHTTPClientTransport(new URL(st.cfg.url ?? ""), {
      requestInit: { headers: values ?? {} },
      reconnectionOptions: {
        maxRetries: 0,
        maxReconnectionDelay: 0,
        initialReconnectionDelay: 0,
        reconnectionDelayGrowFactor: 1,
      },
      fetch: async (input, init) => {
        let url = new URL(input);
        const request = { ...init, redirect: "manual" as const };
        for (let hop = 0; hop < 20; hop++) {
          const response = await globalThis.fetch(url, request);
          st.httpStatus = response.status;
          if ([301, 302, 303, 307, 308].includes(response.status)) {
            const location = response.headers.get("location");
            if (!location) return response;
            const next = new URL(location, url);
            await response.body?.cancel();
            if (next.origin !== url.origin) {
              st.code = "http_redirect";
              throw new Error("跨域重定向已拒绝");
            }
            if (
              response.status === 303 ||
              ((response.status === 301 || response.status === 302) && request.method === "POST")
            ) {
              request.method = "GET";
              delete request.body;
            }
            url = next;
            continue;
          }
          if (response.status === 401 || response.status === 403) {
            st.code = "auth_required";
            throw new Error("请检查请求头凭据");
          }
          if (!response.ok && !(request.method === "GET" && response.status === 405))
            st.code = "http_status";
          return response;
        }
        st.code = "http_redirect";
        throw new Error("重定向次数超限");
      },
    });
  } else {
    st.code = "spawn_failed";
    proc = scope.platform.process.spawnPipe(st.cfg.command ?? "", st.cfg.args ?? [], {
      cwd,
      envMode: "minimal",
      env: values,
    });
    if (proc.pid <= 0) {
      await proc.kill();
      throw new Error("spawn failed");
    }
    transport = new StdioPipeTransport(proc);
  }
  const client = new Client({ name: CLIENT_NAME, version: CLIENT_VERSION }, { capabilities: {} });
  const runtime: ServerRuntime = { proc, transport, client };
  st.runtime = runtime;
  // 进程退出/管道关闭即视为崩溃；st.runtime 换防后旧 runtime 的 close 不生效
  transport.onclose = () => {
    if (st.runtime !== runtime || st.closed) return;
    st.state = st.cfg.type === "http" ? "failed" : "crashed";
    st.error = "进程已退出或管道已关闭";
    scope.emitServer({ name: st.cfg.name, state: st.state, error: st.error });
    scope.diagnostics?.record("mcp.event", {
      server: st.cfg.name,
      state: "crashed",
      error: st.error,
    });
    scope.warn("mcp_server_crashed", `MCP 服务器 ${st.cfg.name} 连接断开`);
  };
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    st.refreshing ??= refreshTools(scope, st).finally(() => {
      st.refreshing = undefined;
    });
  });
  try {
    await timeout(
      (async () => {
        await client.connect(transport as Transport, { signal: controller.signal });
        const defs = await fetchToolDefs(scope, st);
        if (!st.closed) st.staged = defs;
      })(),
      Math.max(1, startupMs - (Date.now() - started)),
      `MCP 服务器 ${st.cfg.name} 启动`,
    );
  } catch (e) {
    const cancelled = isAborted(controller.signal);
    if (e instanceof Error && e.message.includes("超时")) st.code = "startup_timeout";
    else if (st.cfg.type !== "http") {
      st.code =
        e instanceof Error && /ENOENT|spawn|找不到|not found/i.test(e.message)
          ? "spawn_failed"
          : "initialize_failed";
    }
    await stopServer(st);
    if (!cancelled) st.closed = false;
    throw e;
  }
}

/** tools/list_changed：重新拉取并暂存，注册表在 Turn 边界再切换 */
async function refreshTools(scope: McpOpenScope, st: Server): Promise<void> {
  if (st.state !== "ready" || st.closed) return;
  try {
    st.staged = await fetchToolDefs(scope, st);
    scope.warn("mcp_tools_changed", `MCP 服务器 ${st.cfg.name} 的工具列表已更新，下一个 Turn 生效`);
  } catch (e) {
    scope.warn(
      "mcp_tools_refresh_failed",
      `MCP 服务器 ${st.cfg.name} 工具列表刷新失败：${toolError(e)}`,
    );
  }
}

/** 惰性重连：崩溃/失败后的下一次调用触发；每会话至多 MAX_RESTARTS 次 */
async function ensureClient(scope: McpOpenScope, st: Server): Promise<Client> {
  if (st.state === "ready" && st.runtime !== undefined) return st.runtime.client;
  if (st.cfg.type === "http") throw new Error("HTTP 连接不可用，请停用后重新启用服务器");
  if (st.closed || st.state === "stopped") {
    throw new Error(`MCP 服务器 ${st.cfg.name} 已关闭`);
  }
  if (st.restarts >= MAX_RESTARTS) {
    throw new Error(
      `MCP 服务器 ${st.cfg.name} 不可用（${st.error ?? "未知原因"}；已重连 ${st.restarts} 次达到上限）`,
    );
  }
  st.restarting ??= (async () => {
    st.restarts += 1;
    st.state = "starting";
    scope.emitServer({ name: st.cfg.name, state: "starting" });
    scope.diagnostics?.record("mcp.event", { server: st.cfg.name, state: "starting" });
    try {
      await connectServer(scope, st);
      // 重连拉到的工具集同样按 Turn 边界生效（mcp.md 第 5 节）：
      // st.tools 保持旧集，staged 在 applyPendingTools() 时切换
      st.state = "ready";
      st.error = undefined;
      scope.emitServer({
        name: st.cfg.name,
        state: "ready",
        toolCount: st.staged?.size ?? st.tools.size,
      });
      scope.diagnostics?.record("mcp.event", {
        server: st.cfg.name,
        state: "ready",
        toolCount: st.staged?.size ?? st.tools.size,
      });
      return true;
    } catch (e) {
      st.state = "failed";
      st.error = safeText(st, toolError(e));
      scope.emitServer({ name: st.cfg.name, state: "failed", error: st.error });
      scope.diagnostics?.record("mcp.event", {
        server: st.cfg.name,
        state: "failed",
        error: st.error,
      });
      scope.warn("mcp_server_failed", `MCP 服务器 ${st.cfg.name} 重连失败：${st.error}`);
      return false;
    }
  })();
  try {
    if (!(await st.restarting)) {
      throw new Error(`MCP 服务器 ${st.cfg.name} 不可用：${st.error ?? "重连失败"}`);
    }
    return (
      st.runtime?.client ??
      (() => {
        throw new Error("重连后客户端缺失");
      })()
    );
  } finally {
    st.restarting = undefined;
  }
}

/** content[] → modelContent + output 元数据（mcp.md 第 6 节结果映射） */
function mapContent(res: CallToolResult | Record<string, unknown>): {
  text: string;
  output: Record<string, unknown>;
} {
  const texts: string[] = [];
  const meta: Record<string, unknown>[] = [];
  const blocks =
    "content" in res && Array.isArray(res.content)
      ? (res.content as CallToolResult["content"])
      : [];
  for (const block of blocks) {
    switch (block.type) {
      case "text":
        texts.push(block.text);
        meta.push({ type: "text" });
        break;
      case "image":
        texts.push(
          `[image: ${block.mimeType}，约 ${Math.round((block.data.length * 3) / 4)} 字节，内容未传回模型]`,
        );
        meta.push({
          type: "image",
          mimeType: block.mimeType,
          approxBytes: Math.round((block.data.length * 3) / 4),
        });
        break;
      case "audio":
        texts.push(`[audio: ${block.mimeType}，内容未传回模型]`);
        meta.push({ type: "audio", mimeType: block.mimeType });
        break;
      case "resource": {
        const r = block.resource;
        if ("text" in r) {
          texts.push(r.text);
        } else {
          texts.push(`[resource: ${r.uri}（${r.mimeType ?? "unknown"}），内容未传回模型]`);
        }
        meta.push({ type: "resource", uri: r.uri, mimeType: r.mimeType });
        break;
      }
      case "resource_link":
        texts.push(`[resource_link: ${block.uri}]`);
        meta.push({ type: "resource_link", uri: block.uri });
        break;
      default:
        texts.push(`[${(block as { type: string }).type}: 内容未传回模型]`);
        meta.push({ type: (block as { type: string }).type });
    }
  }
  // 兼容形态（老服务器返回 {toolResult}）：序列化进文本
  if (
    texts.length === 0 &&
    "toolResult" in res &&
    res.toolResult !== undefined &&
    res.toolResult !== null
  ) {
    texts.push(JSON.stringify(res.toolResult).slice(0, 30_000));
  }
  const output: Record<string, unknown> = { content: meta };
  if ("structuredContent" in res && res.structuredContent !== undefined) {
    output.structured = res.structuredContent;
  }
  return { text: texts.join("\n"), output };
}

function isErrorResult(res: unknown): boolean {
  return (
    typeof res === "object" &&
    res !== null &&
    "isError" in res &&
    (res as { isError?: unknown }).isError === true
  );
}

function wrapTool(
  scope: McpOpenScope,
  st: Server,
  tool: Tool,
  taken: ReadonlySet<string>,
): ToolDefinition {
  const name = mcpToolName(st.cfg.name, safeText(st, tool.name), taken);
  const remote = tool.name;
  const callMs = Math.min(st.cfg.callTimeoutMs ?? DEFAULT_CALL_MS, MAX_CALL_MS);
  return {
    name,
    description: safeText(
      st,
      tool.description ?? tool.title ?? `MCP 工具 ${st.cfg.name}/${remote}`,
    ),
    inputSchema: safeOutput(st, tool.inputSchema) as Tool["inputSchema"],
    // 来源标记：结果图片附件记为 source "mcp"（ADR-0023）
    origin: "mcp",
    traits: {
      // readOnlyHint 是服务器自己声明的标注（不可信）：只决定能否进入
      // explore 工具集（subagent.md 第 6 节），放行仍由权限层逐项判断
      mutates: tool.annotations?.readOnlyHint !== true,
      concurrencySafe: false,
      timeoutMs: callMs + 30_000,
    },
    permissionSubjects() {
      // 权限主体固定为 mcp <server>/<tool>（mcp.md 第 7 节）
      return [{ kind: "mcp", target: safeText(st, `${st.cfg.name}/${remote}`) }];
    },
    async execute(_input: unknown, ctx: ToolContext): Promise<ToolResult> {
      if (ctx.signal.aborted) return err("cancelled", "调用已被中断");
      let client: Client;
      try {
        client = await ensureClient(scope, st);
      } catch (e) {
        return err("mcp_unavailable", safeText(st, toolError(e)));
      }
      const timeoutSignal = AbortSignal.timeout(callMs);
      const combined = AbortSignal.any([ctx.signal, timeoutSignal]);
      const startedAt = Date.now();
      try {
        const res = await client.callTool(
          { name: remote, arguments: _input as Record<string, unknown> },
          undefined,
          { signal: combined, timeout: callMs },
        );
        scope.diagnostics?.record("mcp.call", {
          server: st.cfg.name,
          tool: safeText(st, remote),
          callId: ctx.callId,
          durationMs: Date.now() - startedAt,
          isError: isErrorResult(res),
        });
        const mapped = mapContent(res);
        const text = safeText(st, mapped.text);
        const output = safeOutput(st, mapped.output) as Record<string, unknown>;
        if (isErrorResult(res)) {
          return {
            status: "error",
            modelContent: text === "" ? "MCP 工具返回 isError（无文本）" : text,
            output,
            error: { code: "tool_error", message: text.slice(0, 300) || "isError" },
          };
        }
        return { status: "ok", modelContent: text, output };
      } catch (e) {
        if (isAborted(ctx.signal)) return err("cancelled", "调用已被中断");
        if (timeoutSignal.aborted) {
          return err("timeout", safeText(st, `MCP 工具 ${remote} 超过 ${callMs}ms 超时`));
        }
        if (st.cfg.type === "http") {
          st.state = "failed";
          st.error = "HTTP 请求失败，请检查连接和请求头";
          scope.emitServer({ name: st.cfg.name, state: "failed", error: st.error });
          return err("mcp_unavailable", st.error);
        }
        if (st.state !== "ready") {
          return err("mcp_server_crashed", `MCP 服务器 ${st.cfg.name} 连接中断`);
        }
        return err("tool_error", safeText(st, `MCP 工具 ${remote} 调用失败：${toolError(e)}`));
      }
    },
  };
}

function statusOf(st: Server): McpServerStatus {
  return {
    name: st.cfg.name,
    state: st.state,
    toolCount: st.staged?.size ?? st.tools.size,
    error: st.error,
    restarts: st.restarts,
  };
}

export function createMcpConnector(): McpConnector {
  return {
    async probe(scope) {
      const started = Date.now();
      const cfg = scope.servers[0];
      if (!cfg) throw new Error("缺少服务器");
      const st: Server = {
        cfg,
        state: "starting",
        restarts: 0,
        tools: new Map(),
        closed: false,
        secrets: [],
      };
      try {
        await connectServer(scope, st);
        const info = st.runtime?.client.getServerVersion();
        const tools = st.listed ?? [];
        await stopServer(st);
        return {
          ok: true,
          durationMs: Date.now() - started,
          tools,
          serverInfo: info
            ? { name: safeText(st, info.name), version: safeText(st, info.version) }
            : undefined,
          ...(cfg.type === "http"
            ? { httpStatus: st.httpStatus }
            : { stderrTail: st.stderrTail ?? [] }),
        };
      } catch {
        await stopServer(st);
        return {
          ok: false,
          durationMs: Date.now() - started,
          tools: [],
          error: {
            code: st.code ?? "initialize_failed",
            message:
              st.code === "mcp_secret_missing"
                ? (st.error ?? `服务器 ${cfg.name} 缺少 stored 凭据`)
                : "连接失败，请检查服务器配置、连接和凭据",
          },
          ...(cfg.type === "http"
            ? { httpStatus: st.httpStatus }
            : { stderrTail: st.stderrTail ?? [] }),
        };
      }
    },
    open(scope) {
      const removed: string[] = [];
      const servers: Server[] = scope.servers
        .filter((cfg) => cfg.enabled !== false)
        .map((cfg) => ({
          cfg,
          state: "starting",
          restarts: 0,
          tools: new Map(),
          closed: false,
          secrets: [],
        }));
      // 并行启动；单服务器失败只影响自身（降级为无该服务器工具）
      const initialStartup = Promise.all(
        servers.map(async (st) => {
          scope.emitServer({ name: st.cfg.name, state: "starting" });
          scope.diagnostics?.record("mcp.event", {
            server: st.cfg.name,
            state: "starting",
          });
          try {
            await connectServer(scope, st);
            if (st.closed) return;
            st.state = "ready";
            scope.emitServer({
              name: st.cfg.name,
              state: "ready",
              toolCount: st.staged?.size ?? 0,
            });
            scope.diagnostics?.record("mcp.event", {
              server: st.cfg.name,
              state: "ready",
              toolCount: st.staged?.size ?? 0,
            });
          } catch (e) {
            if (st.closed && st.controller?.signal.aborted) return;
            st.state = "failed";
            st.error =
              st.code === "mcp_secret_missing"
                ? safeText(st, toolError(e))
                : "连接失败，请检查服务器配置、连接和凭据";
            scope.emitServer({ name: st.cfg.name, state: "failed", error: st.error });
            scope.diagnostics?.record("mcp.event", {
              server: st.cfg.name,
              state: "failed",
              error: st.error,
            });
            scope.warn(
              st.code === "mcp_secret_missing" ? "mcp_secret_missing" : "mcp_server_failed",
              `MCP 服务器 ${st.cfg.name} 启动失败：${st.error}`,
            );
          }
        }),
      );

      return Promise.resolve<McpSession>({
        async startup(signal?: AbortSignal) {
          if (signal?.aborted) return;
          let aborted: (() => void) | undefined;
          const cancel = new Promise<void>((resolve) => {
            aborted = () => {
              resolve();
            };
            signal?.addEventListener("abort", aborted, { once: true });
          });
          try {
            await Promise.race([initialStartup, cancel]);
          } finally {
            if (aborted) signal?.removeEventListener("abort", aborted);
          }
        },
        async reconcile(configs: readonly McpServerConfig[]) {
          await initialStartup;
          const wanted = new Map(
            configs.filter((cfg) => cfg.enabled !== false).map((cfg) => [cfg.name, cfg]),
          );
          for (const st of [...servers]) {
            if (wanted.has(st.cfg.name)) continue;
            removed.push(...st.tools.keys());
            await stopServer(st);
            servers.splice(servers.indexOf(st), 1);
            scope.emitServer({ name: st.cfg.name, state: "stopped" });
          }
          for (const cfg of wanted.values()) {
            const signature: Server = {
              cfg,
              state: "starting",
              restarts: 0,
              tools: new Map(),
              closed: false,
              secrets: [],
            };
            const values = await expandEnv(
              cfg.type === "http" ? cfg.headers : cfg.env,
              scope,
              signature,
            ).catch(() => undefined);
            const digest = fingerprint(cfg, values);
            let st = servers.find((s) => s.cfg.name === cfg.name);
            if (st?.fingerprint === digest) continue;
            if (st) await stopServer(st);
            else {
              st = signature;
              servers.push(st);
            }
            st.cfg = cfg;
            st.closed = false;
            st.fingerprint = digest;
            st.state = "starting";
            scope.emitServer({ name: cfg.name, state: "starting" });
            try {
              await connectServer(scope, st);
              st.state = "ready";
              st.error = undefined;
            } catch {
              st.state = "failed";
              st.error =
                st.code === "mcp_secret_missing"
                  ? (st.error ?? `MCP 服务器 ${cfg.name} 缺少凭据`)
                  : "连接失败，请检查配置和凭据";
              st.staged = new Map();
              scope.warn(
                st.code === "mcp_secret_missing" ? st.code : "mcp_server_failed",
                `MCP 服务器 ${cfg.name} 启动失败：${st.error}`,
              );
            }
            scope.emitServer({
              name: cfg.name,
              state: st.state,
              toolCount: st.staged?.size ?? 0,
              error: st.error,
            });
          }
        },
        tools() {
          return servers.flatMap((st) => [...st.tools.values()]);
        },
        status() {
          return servers.map(statusOf);
        },
        applyPendingTools(): McpToolDiff {
          const diff: McpToolDiff = { add: [], remove: removed.splice(0) };
          for (const st of servers) {
            if (st.staged === undefined) continue;
            const staged = st.staged;
            st.staged = undefined;
            for (const name of st.tools.keys()) {
              if (!staged.has(name)) diff.remove.push(name);
            }
            for (const [name, def] of staged) {
              diff.remove.push(name);
              diff.add.push(def);
            }
            st.tools = staged;
          }
          return diff;
        },
        async close() {
          await Promise.all(
            servers.map(async (st) => {
              await stopServer(st);
              st.state = "stopped";
            }),
          );
        },
      });
    },
  };
}
