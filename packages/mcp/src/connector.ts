/**
 * MCP 连接器（mcp.md 第 3–5 节）：会话级生命周期。
 * - open() 并行启动全部服务器；单服务器失败降级为 failed，不阻塞会话；
 * - stdio 崩溃惰性重连至多 MAX_RESTARTS 次；HTTP 失败后冷却重连；
 * - tools/list_changed 与重连刷新的工具集先暂存，applyPendingTools()
 *   在 Turn 边界统一应用（mcp.md 第 5 节）；
 * - close() 终止全部服务器进程树。
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createHash } from "node:crypto";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
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
const CLIENT_VERSION = "0.8.1";
const DEFAULT_STARTUP_MS = 15_000;
const MAX_STARTUP_MS = 60_000;
const DEFAULT_CALL_MS = 60_000;
const MAX_CALL_MS = 600_000;
/** stdio 惰性重连上限（超过后记 failed 不再尝试，mcp.md 第 4 节） */
const MAX_RESTARTS = 3;
/** HTTP 重连失败后的冷却时长：冷却期内不再发起连接尝试 */
const HTTP_RETRY_COOLDOWN_MS = 30_000;
/** Turn 边界恢复尝试的最长等待：超时后转入后台，结果下一次 Turn 边界应用 */
const TURN_RECONNECT_WAIT_MS = 3_000;

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
  /**
   * 连接尝试代号：每次 connectServer 开始时自增。在途尝试发布 ready/failed
   * 前必须复核代号与 closed，避免被关闭或重配取代的尝试"复活"旧连接。
   */
  run: number;
  /** 已就本次故障发出过 mcp_server_failed：同一故障期内只警告一次 */
  announced?: boolean | undefined;
  /** HTTP：冷却结束时间戳（Date.now 毫秒）；undefined 表示无冷却 */
  retryAt?: number | undefined;
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

/**
 * 关闭一个运行时（传输 + 客户端 + stdio 进程），不改变服务器条目的状态。
 * HTTP 有会话时先 DELETE（best-effort）；围绕 DELETE 保存/恢复 httpStatus 与
 * code，避免清理请求的状态码污染调用失败分类（并发下为 best-effort）。
 */
async function closeRuntime(st: Server, runtime: ServerRuntime): Promise<void> {
  const status = st.httpStatus;
  const code = st.code;
  if (runtime.transport instanceof StreamableHTTPClientTransport && runtime.transport.sessionId) {
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

async function stopServer(st: Server): Promise<void> {
  st.closed = true;
  st.run += 1;
  st.controller?.abort();
  const runtime = st.runtime;
  st.runtime = undefined;
  if (runtime === undefined) return;
  await closeRuntime(st, runtime);
}

/**
 * 丢弃本次尝试创建的运行时：既不标记服务器 closed，也不发布任何状态，
 * 用于在途重连已被关闭/重配取代的场景（不得复活旧连接）。
 */
async function discardRuntime(st: Server, runtime: ServerRuntime): Promise<void> {
  if (st.runtime === runtime) st.runtime = undefined;
  await closeRuntime(st, runtime);
}

function requireClient(st: Server): Client {
  const client = st.runtime?.client;
  if (client === undefined) throw new Error(`MCP 服务器 ${st.cfg.name} 重连后客户端缺失`);
  return client;
}

/**
 * 从 Node fetch 的失败链上取错误码：`TypeError("fetch failed")` 的 cause 可能是
 * 单个错误（带 code）或多个地址的 AggregateError（errors[]，可能再嵌套 cause）。
 */
function fetchFailureCode(e: unknown, depth = 0): string | undefined {
  if (depth > 4 || e === null || typeof e !== "object") return undefined;
  if ("code" in e && typeof e.code === "string") return e.code;
  if ("errors" in e && Array.isArray(e.errors) && e.errors.length > 0) {
    const codes = (e.errors as unknown[]).map((item) => fetchFailureCode(item, depth + 1));
    // 多地址连接只有全部失败原因都明确发生在发出请求前，才允许重试。
    if (codes.every((code) => code !== undefined && RETRYABLE_CONNECT_CODES[code])) return codes[0];
    return undefined;
  }
  if ("cause" in e) return fetchFailureCode(e.cause, depth + 1);
  return undefined;
}

/**
 * 连接阶段失败（请求根本没有发出）的 Node/undici 错误码白名单。
 * 只收连接建立阶段的失败：这些情况下服务器不可能执行本次 tools/call，
 * 立即重连并重试不会产生重复副作用。刻意不含 ECONNRESET/超时/HTTP 状态码：
 * 那些可能发生在请求已送达之后，重试会重复执行（mcp.md 第 4 节）。
 */
const RETRYABLE_CONNECT_CODES: Record<string, true> = {
  ECONNREFUSED: true,
  ENOTFOUND: true,
  EAI_AGAIN: true,
  EHOSTUNREACH: true,
  ENETUNREACH: true,
};

/**
 * 判定一次 HTTP tools/call 失败是否可以"立即重连并重试一次"。只有两类明确安全：
 *
 * 1. **会话已失效**：SDK 抛 `StreamableHTTPError(404)`，且本次 POST 确实带了
 *    `mcp-session-id`（`sessionIdAtCall`）。这是服务器清理了旧会话的确定信号，
 *    请求在服务器侧被拒绝、工具不会执行。
 *    SDK 后台 SSE GET 的错误走 transport.onerror，不会成为 callTool 的
 *    rejection；这里判断调用自身抛出的错误，不依据共享的最近 HTTP 状态码。
 *    - 404 但没有会话 id（例如 initialize 阶段）不算会话失效，不重试。
 * 2. **连接阶段失败**：错误链上的 cause 是连接建立阶段的错误码（见
 *    `RETRYABLE_CONNECT_CODES`），说明请求没有发出，重试不会重复执行工具。
 *
 * 其余（超时、连接被重置、HTTP 4xx/5xx、内容类型错误等）一律不重试：服务器可能
 * 已经执行了本次调用。不按服务器名、工具名或 URL 分支。
 */
export function shouldRetryHttpCall(e: unknown, sessionIdAtCall: string | undefined): boolean {
  if (e instanceof StreamableHTTPError && e.code === 404 && sessionIdAtCall !== undefined) {
    return true;
  }
  const code = fetchFailureCode(e);
  return code !== undefined && RETRYABLE_CONNECT_CODES[code] === true;
}

/**
 * HTTP 调用失败的分类原因（写入 `st.error` 与工具结果）。顺序：会话失效 →
 * HTTP 状态码 → 连接阶段错误码 → 超时 → 最近一次 HTTP 状态码 → 原始错误摘要。
 * 导出仅为单元测试覆盖各分支。
 */
export function httpFailureReason(
  e: unknown,
  httpStatus: number | undefined,
  sessionIdAtCall?: string,
): string {
  if (e instanceof StreamableHTTPError && e.code !== undefined && e.code > 0) {
    return e.code === 404 && sessionIdAtCall !== undefined
      ? "会话已失效（HTTP 404）"
      : `HTTP ${e.code}`;
  }
  const code = fetchFailureCode(e);
  if (code !== undefined) {
    switch (code) {
      case "ECONNREFUSED":
        return "连接被拒绝（ECONNREFUSED）";
      case "ENOTFOUND":
      case "EAI_AGAIN":
        return `域名解析失败（${code}）`;
      case "EHOSTUNREACH":
      case "ENETUNREACH":
        return `网络不可达（${code}）`;
      case "ECONNRESET":
        return "连接被重置（ECONNRESET）";
      case "UND_ERR_SOCKET":
        return "连接中断（UND_ERR_SOCKET）";
      case "UND_ERR_CONNECT_TIMEOUT":
        return "请求超时（连接超时）";
      case "UND_ERR_HEADERS_TIMEOUT":
      case "UND_ERR_BODY_TIMEOUT":
        return "请求超时";
      default:
        return `网络错误（${code}）`;
    }
  }
  if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) {
    return "请求超时";
  }
  if (e instanceof Error && /超时|timeout/i.test(e.message)) return "请求超时";
  if (httpStatus !== undefined && httpStatus >= 400) return `HTTP ${httpStatus}`;
  return `请求失败：${toolError(e).slice(0, 200)}`;
}

/**
 * 把 HTTP 服务器标记为 failed：只在**首次进入** failed 时发一次 `mcp.server`、
 * 诊断 `mcp.event`（原始错误 + httpStatus）与 `mcp_server_failed` 警告；已是
 * failed 时只更新原因文本（下一次调用照常触发重连）。
 */
function markHttpFailed(scope: McpOpenScope, st: Server, reason: string, raw: unknown): void {
  if (st.closed || st.state === "stopped") return;
  st.error = safeText(st, reason);
  if (st.state === "failed") return;
  st.state = "failed";
  scope.emitServer({ name: st.cfg.name, state: "failed", error: st.error });
  scope.diagnostics?.record("mcp.event", {
    server: st.cfg.name,
    state: "failed",
    error: safeText(st, diagnosticError(raw)),
    httpStatus: httpStatusOf(raw, st),
  });
  if (st.announced !== true) {
    st.announced = true;
    scope.warn("mcp_server_failed", `MCP 服务器 ${st.cfg.name} 连接失败：${st.error}`);
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

function isCurrentAttempt(st: Server, run: number): boolean {
  return !st.closed && st.run === run;
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

function diagnosticError(e: unknown): string {
  const code = fetchFailureCode(e);
  return code === undefined ? toolError(e) : `${toolError(e)} (${code})`;
}

function httpStatusOf(e: unknown, st: Server): number | undefined {
  return e instanceof StreamableHTTPError && e.code !== undefined && e.code > 0
    ? e.code
    : st.httpStatus;
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

/**
 * 启动/重连一台服务器：spawn → initialize → tools/list；失败写 st.error 并抛出。
 * `run` 是本次尝试的代号：每个发布点都复核 `st.run === run && !st.closed`，
 * 被关闭/重配取代的在途尝试不发布状态、不复活连接（mcp.md 第 4 节）。
 */
async function connectServer(scope: McpOpenScope, st: Server, run: number): Promise<ServerRuntime> {
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
  if (st.closed || st.run !== run || controller.signal.aborted) throw new Error("MCP 启动已取消");
  st.fingerprint = fingerprint(st.cfg, values);
  st.httpStatus = undefined;
  st.code = undefined;
  if (st.cfg.type === "http") st.secrets.push(...Object.values(values ?? {}));
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
          let response: Response;
          try {
            response = await globalThis.fetch(url, request);
          } catch (e) {
            // 连接阶段失败（DNS/拒绝/连接超时）：本跳没有 HTTP 状态码，
            // 清掉上一次请求留下的状态码，避免误导失败分类（并发下 best-effort）
            st.httpStatus = undefined;
            throw e;
          }
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
  if (!isCurrentAttempt(st, run)) {
    // 尝试已被关闭/重配取代：丢弃刚建的运行时，不发布任何状态
    await closeRuntime(st, runtime);
    throw new Error("MCP 启动已取消");
  }
  st.runtime = runtime;
  // 已 ready 的进程退出/管道关闭才视为崩溃；st.runtime 换防后旧 runtime 的 close 不生效。
  // 连接阶段的关闭交给下方 catch 统一报一次启动失败，不再另报崩溃（mcp.md 第 4 节）
  // HTTP 的传输关闭不是进程崩溃：记 failed（下一次调用惰性重连），不发
  // mcp_server_crashed；stdio 保持 crashed + 警告不变（mcp.md 第 4 节）。
  transport.onclose = () => {
    if (st.runtime !== runtime || st.closed || st.state !== "ready") return;
    if (st.cfg.type === "http") {
      markHttpFailed(scope, st, "HTTP 连接已断开", "HTTP transport closed");
      return;
    }
    st.state = "crashed";
    st.error = "进程已退出或管道已关闭";
    scope.emitServer({ name: st.cfg.name, state: st.state, error: st.error });
    scope.diagnostics?.record("mcp.event", {
      server: st.cfg.name,
      state: st.state,
      error: st.error,
      httpStatus: st.httpStatus,
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
        if (!st.closed && st.run === run) st.staged = defs;
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
    controller.abort();
    await discardRuntime(st, runtime);
    if (cancelled && st.run === run) st.closed = true;
    throw e;
  }
  return runtime;
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

/**
 * 惰性重连：失败/崩溃后的下一次调用触发，或由 Turn 边界钩子 prepareTurn 触发。
 * - stdio：每会话至多 MAX_RESTARTS 次（超过记 failed 不再尝试）；
 * - HTTP：不设上限，连续失败计数在成功时清零，失败后进入 30 秒冷却
 *   （冷却期内直接拒绝，不发事件、不警告）；
 * - 并发的重连请求共享同一个 `st.restarting` 尝试（mcp.md 第 4 节）；
 * - 成功是静默的：只发 starting → ready，不警告；失败进入 failed 时警告一次。
 */
async function ensureClient(scope: McpOpenScope, st: Server): Promise<Client> {
  if (st.state === "ready" && st.runtime !== undefined) return st.runtime.client;
  if (st.closed || st.state === "stopped") {
    throw new Error(`MCP 服务器 ${st.cfg.name} 已关闭`);
  }
  if (st.restarting !== undefined) {
    // 已有在途尝试：加入等待，不再发起第二次连接
    if (await st.restarting) return requireClient(st);
    throw new Error(`MCP 服务器 ${st.cfg.name} 不可用：${st.error ?? "重连失败"}`);
  }
  if (st.cfg.type !== "http" && st.restarts >= MAX_RESTARTS) {
    throw new Error(
      `MCP 服务器 ${st.cfg.name} 不可用（${st.error ?? "未知原因"}；已重连 ${st.restarts} 次达到上限）`,
    );
  }
  const now = Date.now();
  if (st.cfg.type === "http" && st.retryAt !== undefined && now < st.retryAt) {
    // 冷却拒绝：不发事件、不警告（mcp.md 第 4 节）
    throw new Error(
      `MCP 服务器 ${st.cfg.name} 暂不可用（${st.error ?? "连接失败"}；重连冷却中，约 ${Math.ceil(
        (st.retryAt - now) / 1000,
      )} 秒后可重试）`,
    );
  }
  const run = ++st.run;
  const attempt = (async (): Promise<boolean> => {
    st.state = "starting";
    st.announced = false;
    if (st.cfg.type !== "http") st.restarts += 1;
    scope.emitServer({ name: st.cfg.name, state: "starting" });
    scope.diagnostics?.record("mcp.event", { server: st.cfg.name, state: "starting" });
    try {
      st.controller?.abort();
      const old = st.runtime;
      st.runtime = undefined;
      if (old) await closeRuntime(st, old);
      if (!isCurrentAttempt(st, run)) return false;
      const runtime = await connectServer(scope, st, run);
      if (!isCurrentAttempt(st, run)) {
        // 在途重连被关闭/重配取代：丢弃本次运行时，不复活旧连接
        await discardRuntime(st, runtime);
        return false;
      }
      // 重连拉到的工具集同样按 Turn 边界生效（mcp.md 第 5 节）：
      // st.tools 保持旧集，staged 在 applyPendingTools() 时切换
      st.state = "ready";
      st.error = undefined;
      st.code = undefined;
      st.announced = false;
      if (st.cfg.type === "http") {
        // 连续重连失败计数成功清零，冷却解除
        st.restarts = 0;
        st.retryAt = undefined;
      }
      const toolCount = st.staged?.size ?? st.tools.size;
      scope.emitServer({ name: st.cfg.name, state: "ready", toolCount });
      scope.diagnostics?.record("mcp.event", {
        server: st.cfg.name,
        state: "ready",
        toolCount,
      });
      return true;
    } catch (e) {
      if (st.run !== run || st.closed) return false;
      const reason =
        st.cfg.type === "http" ? httpFailureReason(e, st.httpStatus) : safeText(st, toolError(e));
      st.state = "failed";
      st.error = safeText(st, reason);
      if (st.cfg.type === "http") {
        st.restarts += 1;
        st.retryAt = Date.now() + HTTP_RETRY_COOLDOWN_MS;
      }
      scope.emitServer({ name: st.cfg.name, state: "failed", error: st.error });
      scope.diagnostics?.record("mcp.event", {
        server: st.cfg.name,
        state: "failed",
        error: safeText(st, diagnosticError(e)),
        httpStatus: httpStatusOf(e, st),
      });
      st.announced = true;
      scope.warn("mcp_server_failed", `MCP 服务器 ${st.cfg.name} 重连失败：${st.error}`);
      return false;
    }
  })();
  st.restarting = attempt;
  try {
    if (!(await attempt)) {
      throw new Error(`MCP 服务器 ${st.cfg.name} 不可用：${st.error ?? "重连失败"}`);
    }
    return requireClient(st);
  } finally {
    if (st.restarting === attempt) st.restarting = undefined;
  }
}

/**
 * 会话失效等场景的强制重建：先丢弃当前运行时（旧会话已不可用），再走一次
 * 重连。不发布 failed，因此成功时调用方只看到 starting → ready。
 * 并发旧调用晚到时仍遵守刚失败的重连所建立的冷却，不能连续发起尝试。
 */
async function forceReconnect(
  scope: McpOpenScope,
  st: Server,
  failedClient: Client,
): Promise<Client> {
  // 另一并发调用已经在恢复（或恢复完毕）时，共用其结果，不销毁新连接。
  if (st.runtime?.client === failedClient && st.restarting === undefined) st.state = "failed";
  return await ensureClient(scope, st);
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

      const recordCallFailure = (raw: unknown, retried = false): void => {
        scope.diagnostics?.record("mcp.call", {
          server: st.cfg.name,
          tool: safeText(st, remote),
          callId: ctx.callId,
          durationMs: Date.now() - startedAt,
          error: safeText(st, diagnosticError(raw)),
          httpStatus: httpStatusOf(raw, st),
          ...(retried ? { retried: true } : {}),
        });
      };

      // 单次调用尝试：成功返回结果；失败把原始错误与本次调用所用会话 id 交回
      //（会话 id 必须是"本次 call"的，不能用重连后的值，见 shouldRetryHttpCall）。
      const attemptCall = async (): Promise<
        | { ok: true; result: ToolResult }
        | { ok: false; error: unknown; sessionIdAtCall: string | undefined }
      > => {
        const transport = st.runtime?.transport;
        const sessionIdAtCall =
          transport instanceof StreamableHTTPClientTransport ? transport.sessionId : undefined;
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
            httpStatus: st.httpStatus,
          });
          const mapped = mapContent(res);
          const text = safeText(st, mapped.text);
          const output = safeOutput(st, mapped.output) as Record<string, unknown>;
          if (isErrorResult(res)) {
            return {
              ok: true,
              result: {
                status: "error",
                modelContent: text === "" ? "MCP 工具返回 isError（无文本）" : text,
                output,
                error: { code: "tool_error", message: text.slice(0, 300) || "isError" },
              },
            };
          }
          return { ok: true, result: { status: "ok", modelContent: text, output } };
        } catch (error) {
          return { ok: false, error, sessionIdAtCall };
        }
      };

      const first = await attemptCall();
      if (first.ok) return first.result;
      if (isAborted(ctx.signal)) return err("cancelled", "调用已被中断");
      // 旧 Client 的其他在途调用会在重连清理时以 Connection closed 结束。
      // 它们不能把新连接/连接尝试记为 failed，也不能再触发一次恢复。
      if (
        st.cfg.type === "http" &&
        st.runtime?.client !== client &&
        !shouldRetryHttpCall(first.error, first.sessionIdAtCall)
      ) {
        recordCallFailure(first.error);
        return err("mcp_unavailable", safeText(st, toolError(first.error)));
      }
      if (isAborted(timeoutSignal)) {
        if (st.cfg.type === "http") markHttpFailed(scope, st, "请求超时", first.error);
        recordCallFailure(first.error);
        return err("timeout", safeText(st, `MCP 工具 ${remote} 超过 ${callMs}ms 超时`));
      }

      if (st.cfg.type !== "http") {
        if (st.state !== "ready") {
          return err("mcp_server_crashed", `MCP 服务器 ${st.cfg.name} 连接中断`);
        }
        recordCallFailure(first.error);
        return err(
          "tool_error",
          safeText(st, `MCP 工具 ${remote} 调用失败：${toolError(first.error)}`),
        );
      }

      // HTTP：只有明确安全的失败才立即重连并重试一次；其余本次返回错误，
      // 下一次调用触发惰性重连（mcp.md 第 4 节）。
      if (shouldRetryHttpCall(first.error, first.sessionIdAtCall)) {
        recordCallFailure(first.error);
        try {
          client = await forceReconnect(scope, st, client);
        } catch (reconnectError) {
          return err("mcp_unavailable", safeText(st, toolError(reconnectError)));
        }
        const second = await attemptCall();
        if (second.ok) return second.result;
        if (isAborted(ctx.signal)) return err("cancelled", "调用已被中断");
        if (st.runtime?.client !== client) {
          recordCallFailure(second.error, true);
          return err("mcp_unavailable", safeText(st, toolError(second.error)));
        }
        if (isAborted(timeoutSignal)) {
          markHttpFailed(scope, st, "请求超时", second.error);
          recordCallFailure(second.error, true);
          return err("timeout", safeText(st, `MCP 工具 ${remote} 超过 ${callMs}ms 超时`));
        }
        const reason = httpFailureReason(second.error, st.httpStatus, second.sessionIdAtCall);
        markHttpFailed(scope, st, reason, second.error);
        recordCallFailure(second.error, true);
        return err("mcp_unavailable", safeText(st, reason));
      }

      const reason = httpFailureReason(first.error, st.httpStatus, first.sessionIdAtCall);
      markHttpFailed(scope, st, reason, first.error);
      recordCallFailure(first.error);
      return err("mcp_unavailable", safeText(st, reason));
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
        run: 0,
      };
      try {
        await connectServer(scope, st, ++st.run);
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
          run: 0,
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
            await connectServer(scope, st, ++st.run);
            if (st.closed) return;
            st.state = "ready";
            st.error = undefined;
            st.announced = false;
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
                : st.cfg.type === "http"
                  ? safeText(st, httpFailureReason(e, st.httpStatus))
                  : "连接失败，请检查服务器配置、连接和凭据";
            if (st.cfg.type === "http") {
              st.restarts += 1;
              st.retryAt = Date.now() + HTTP_RETRY_COOLDOWN_MS;
            }
            scope.emitServer({ name: st.cfg.name, state: "failed", error: st.error });
            scope.diagnostics?.record("mcp.event", {
              server: st.cfg.name,
              state: "failed",
              error: safeText(st, diagnosticError(e)),
              httpStatus: httpStatusOf(e, st),
            });
            if (st.announced !== true) {
              st.announced = true;
              scope.warn(
                st.code === "mcp_secret_missing" ? "mcp_secret_missing" : "mcp_server_failed",
                `MCP 服务器 ${st.cfg.name} 启动失败：${st.error}`,
              );
            }
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
              run: 0,
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
            // 新配置是新故障期：清掉冷却与失败计数/警告标记
            st.retryAt = undefined;
            st.restarts = 0;
            st.announced = false;
            scope.emitServer({ name: cfg.name, state: "starting" });
            try {
              await connectServer(scope, st, ++st.run);
              st.state = "ready";
              st.error = undefined;
            } catch (e) {
              st.state = "failed";
              st.error =
                st.code === "mcp_secret_missing"
                  ? (st.error ?? `MCP 服务器 ${cfg.name} 缺少凭据`)
                  : cfg.type === "http"
                    ? safeText(st, httpFailureReason(e, st.httpStatus))
                    : "连接失败，请检查配置和凭据";
              if (cfg.type === "http") {
                st.restarts += 1;
                st.retryAt = Date.now() + HTTP_RETRY_COOLDOWN_MS;
              }
              st.staged = new Map();
              st.announced = true;
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
        /**
         * Turn 边界恢复（mcp.md 第 4 节）：对 failed 且已过冷却的 HTTP 服务器
         * 并行发起一次重连，最多等 TURN_RECONNECT_WAIT_MS；超时后转入后台继续，
         * 工具仍只在 applyPendingTools() 时切换（本次边界内完成的才本次生效）。
         * 空闲 reconcile 不经过这里，因此不会触发 Turn 外的重试。
         */
        async prepareTurn(signal?: AbortSignal) {
          if (signal?.aborted) return;
          const now = Date.now();
          const targets = servers.filter(
            (st) =>
              st.cfg.type === "http" &&
              st.state === "failed" &&
              !st.closed &&
              (st.retryAt === undefined || st.retryAt <= now),
          );
          if (targets.length === 0) return;
          // 并发共享同一次尝试（st.restarting）；失败已由 ensureClient 记 failed/冷却
          const attempts = Promise.all(
            targets.map((st) => ensureClient(scope, st).catch(() => undefined)),
          ).then(() => undefined);
          void attempts.catch(() => undefined);
          let timer: NodeJS.Timeout | undefined;
          const waited = new Promise<void>((resolve) => {
            timer = setTimeout(resolve, TURN_RECONNECT_WAIT_MS);
            timer.unref();
          });
          let onAbort: (() => void) | undefined;
          const aborted = new Promise<void>((resolve) => {
            if (signal === undefined) return;
            onAbort = () => {
              resolve();
            };
            if (signal.aborted) resolve();
            else signal.addEventListener("abort", onAbort, { once: true });
          });
          try {
            await Promise.race([attempts, waited, aborted]);
          } finally {
            clearTimeout(timer);
            if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
          }
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
