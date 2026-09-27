/**
 * MCP 连接器（mcp.md 第 3–5 节）：会话级生命周期。
 * - open() 并行启动全部服务器；单服务器失败降级为 failed，不阻塞会话；
 * - 崩溃惰性重连（每会话每服务器至多 MAX_RESTARTS 次）；
 * - tools/list_changed 与重连刷新的工具集先暂存，applyPendingTools()
 *   在 Turn 边界统一应用（mcp.md 第 5 节）；
 * - close() 终止全部服务器进程树。
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
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
  McpToolDiff,
  PipeProcess,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from "@nocturne/core";

import { mcpToolName } from "./names.js";
import { StdioPipeTransport } from "./transport.js";

const CLIENT_NAME = "nocturne";
const CLIENT_VERSION = "0.4.0";
const DEFAULT_STARTUP_MS = 15_000;
const MAX_STARTUP_MS = 60_000;
const DEFAULT_CALL_MS = 120_000;
const MAX_CALL_MS = 600_000;
const MAX_RESTARTS = 3;

interface ServerRuntime {
  proc: PipeProcess;
  transport: StdioPipeTransport;
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
}

function err(code: string, message: string): ToolResult {
  return { status: "error", modelContent: message, error: { code, message } };
}

/** ${NAME} 展开；未定义变量展开为空串并告警（mcp.md 第 2 节） */
function expandEnv(
  env: Record<string, string> | undefined,
  scope: McpOpenScope,
  server: string,
): Record<string, string> | undefined {
  if (env === undefined) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    const expanded = value.replaceAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => {
      const v = scope.platform.env(name);
      if (v === undefined) {
        scope.warn(
          "mcp_env_missing",
          `MCP 服务器 ${server}: env.${key} 引用的环境变量 ${name} 未定义，已展开为空串`,
        );
        return "";
      }
      return v;
    });
    out[key] = expanded;
  }
  return out;
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
  let cursor: string | undefined;
  do {
    const res = await client.listTools(cursor !== undefined ? { cursor } : {});
    for (const tool of res.tools) {
      const def = wrapTool(scope, st, tool, new Set(defs.keys()));
      defs.set(def.name, def);
    }
    cursor = res.nextCursor;
  } while (cursor !== undefined);
  return defs;
}

/** 启动/重连一台服务器：spawn → initialize → tools/list；失败写 st.error 并抛出 */
async function connectServer(scope: McpOpenScope, st: Server): Promise<void> {
  const startupMs = Math.min(st.cfg.startupTimeoutMs ?? DEFAULT_STARTUP_MS, MAX_STARTUP_MS);
  const cwd =
    st.cfg.cwd !== undefined
      ? scope.platform.paths.isAbsolute(st.cfg.cwd)
        ? st.cfg.cwd
        : scope.platform.paths.resolve(st.cfg.dir ?? scope.cwd, st.cfg.cwd)
      : scope.cwd;
  const proc = scope.platform.process.spawnPipe(st.cfg.command, st.cfg.args ?? [], {
    cwd,
    envMode: "minimal",
    env: expandEnv(st.cfg.env, scope, st.cfg.name),
  });
  const transport = new StdioPipeTransport(proc);
  const client = new Client({ name: CLIENT_NAME, version: CLIENT_VERSION }, { capabilities: {} });
  const runtime: ServerRuntime = { proc, transport, client };
  st.runtime = runtime;
  // 进程退出/管道关闭即视为崩溃；st.runtime 换防后旧 runtime 的 close 不生效
  transport.onclose = () => {
    if (st.runtime !== runtime || st.closed) return;
    st.state = "crashed";
    st.error = "进程已退出或管道已关闭";
    scope.emitServer({ name: st.cfg.name, state: "crashed", error: st.error });
    scope.diagnostics?.record("mcp.event", {
      server: st.cfg.name,
      state: "crashed",
      error: st.error,
    });
    scope.warn(
      "mcp_server_crashed",
      `MCP 服务器 ${st.cfg.name} 连接断开（${transport.stderrText().trim().slice(0, 300) || "进程退出"}）；下一次调用将尝试重连`,
    );
  };
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    st.refreshing ??= refreshTools(scope, st).finally(() => {
      st.refreshing = undefined;
    });
  });
  try {
    await timeout(
      (async () => {
        await client.connect(transport);
        st.staged = await fetchToolDefs(scope, st);
      })(),
      startupMs,
      `MCP 服务器 ${st.cfg.name} 启动`,
    );
  } catch (e) {
    st.runtime = undefined;
    await proc.kill().catch(() => undefined);
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
      st.error = toolError(e);
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
  const name = mcpToolName(st.cfg.name, tool.name, taken);
  const remote = tool.name;
  const callMs = Math.min(st.cfg.callTimeoutMs ?? DEFAULT_CALL_MS, MAX_CALL_MS);
  return {
    name,
    description: tool.description ?? tool.title ?? `MCP 工具 ${st.cfg.name}/${remote}`,
    inputSchema: tool.inputSchema,
    traits: {
      // readOnlyHint 是服务器自己声明的标注（不可信）：只决定能否进入
      // explore 工具集（subagent.md 第 6 节），放行仍由权限层逐项判断
      mutates: tool.annotations?.readOnlyHint !== true,
      concurrencySafe: false,
      timeoutMs: callMs + 30_000,
    },
    permissionSubjects() {
      // 权限主体固定为 mcp <server>/<tool>（mcp.md 第 7 节）
      return [{ kind: "mcp", target: `${st.cfg.name}/${remote}` }];
    },
    async execute(_input: unknown, ctx: ToolContext): Promise<ToolResult> {
      if (ctx.signal.aborted) return err("cancelled", "调用已被中断");
      let client: Client;
      try {
        client = await ensureClient(scope, st);
      } catch (e) {
        return err("mcp_unavailable", toolError(e));
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
          tool: remote,
          callId: ctx.callId,
          durationMs: Date.now() - startedAt,
          isError: isErrorResult(res),
        });
        const { text, output } = mapContent(res);
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
          return err("timeout", `MCP 工具 ${remote} 超过 ${callMs}ms 超时`);
        }
        if (st.state !== "ready") {
          return err("mcp_server_crashed", `MCP 服务器 ${st.cfg.name} 连接中断：${toolError(e)}`);
        }
        return err("tool_error", `MCP 工具 ${remote} 调用失败：${toolError(e)}`);
      }
    },
  };
}

function statusOf(st: Server): McpServerStatus {
  return {
    name: st.cfg.name,
    state: st.state,
    toolCount: st.tools.size,
    error: st.error,
    restarts: st.restarts,
  };
}

export function createMcpConnector(): McpConnector {
  return {
    async open(scope) {
      const servers: Server[] = scope.servers.map((cfg) => ({
        cfg,
        state: "starting",
        restarts: 0,
        tools: new Map(),
        closed: false,
      }));
      // 并行启动；单服务器失败只影响自身（降级为无该服务器工具）
      await Promise.all(
        servers.map(async (st) => {
          scope.emitServer({ name: st.cfg.name, state: "starting" });
          scope.diagnostics?.record("mcp.event", {
            server: st.cfg.name,
            state: "starting",
          });
          try {
            await connectServer(scope, st);
            st.tools = st.staged ?? new Map<string, ToolDefinition>();
            st.staged = undefined;
            st.state = "ready";
            scope.emitServer({
              name: st.cfg.name,
              state: "ready",
              toolCount: st.tools.size,
            });
            scope.diagnostics?.record("mcp.event", {
              server: st.cfg.name,
              state: "ready",
              toolCount: st.tools.size,
            });
          } catch (e) {
            st.state = "failed";
            st.error = toolError(e);
            scope.emitServer({ name: st.cfg.name, state: "failed", error: st.error });
            scope.diagnostics?.record("mcp.event", {
              server: st.cfg.name,
              state: "failed",
              error: st.error,
            });
            scope.warn("mcp_server_failed", `MCP 服务器 ${st.cfg.name} 启动失败：${st.error}`);
          }
        }),
      );

      return {
        tools() {
          return servers.flatMap((st) => [...st.tools.values()]);
        },
        status() {
          return servers.map(statusOf);
        },
        applyPendingTools(): McpToolDiff {
          const diff: McpToolDiff = { add: [], remove: [] };
          for (const st of servers) {
            if (st.staged === undefined) continue;
            const staged = st.staged;
            st.staged = undefined;
            for (const name of st.tools.keys()) {
              if (!staged.has(name)) diff.remove.push(name);
            }
            for (const [name, def] of staged) {
              if (!st.tools.has(name)) diff.add.push(def);
            }
            st.tools = staged;
          }
          return diff;
        },
        async close() {
          await Promise.all(
            servers.map(async (st) => {
              st.closed = true;
              st.state = "stopped";
              const runtime = st.runtime;
              st.runtime = undefined;
              if (runtime === undefined) return;
              try {
                await runtime.client.close();
              } catch {
                // 关闭失败只影响进程清理，kill 兜底
              }
              try {
                await runtime.proc.kill();
              } catch {
                // 已退出
              }
            }),
          );
        },
      };
    },
  };
}
