/**
 * `nctrn acp` 真实 CLI 子进程协议集成测试（ADR-0120 §4 第 1 项）。
 *
 * 启动真实构建产物 `apps/cli/dist/main.js acp`，接脚本化本地 OpenAI 兼容 HTTP Provider
 * 与临时 stdio / Streamable HTTP MCP 服务器，覆盖：
 * - 握手与能力声明；stdout 每一帧均为合法 JSON-RPC 2.0
 * - 无可用模型时的可操作配置错误（指引 nctrn setup）
 * - 宿主 cwd、连续两轮上下文延续、文本与工具增量卡片及最终响应严格排序
 * - 权限审批批准/拒绝（拒绝后零执行）与已有拒绝规则
 * - 宿主 MCP（空列表、stdio + Streamable HTTP 双会话同名隔离、拒绝零执行、凭据零泄露、不落盘配置）
 * - 宿主 MCP 同名冲突与部分启动失败后的进程/会话锁清理
 * - 运行中 session/cancel 取消后本会话可继续且另一会话不受影响
 * - 连接 EOF 断开后待审操作零执行、释放 MCP 进程与锁、保留正常会话日志与宿主目录
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { listenFetchSafe } from "../../../scripts/test/ports.mjs";
import { createProcessCleanup, removeTempDirs } from "../../../scripts/test/process-cleanup.mjs";
import { ensureCliBuilt } from "./ensure-cli-build.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const cliEntry = path.join(repoRoot, "apps/cli/dist/main.js");
const fakeHostMcp = path.join(here, "fixtures/fake-host-mcp.mjs");

interface ScriptedToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

interface ProviderReply {
  textParts?: string[];
  toolCalls?: ScriptedToolCall[];
}

type ProviderHandlerResult = ProviderReply | Promise<ProviderReply>;

interface RecordedProviderRequest {
  body: Record<string, unknown>;
  rawBody: string;
}

interface AcpSessionUpdateNotification {
  sessionId: string;
  update: {
    sessionUpdate: string;
    toolCallId?: string;
    kind?: string;
    status?: string;
    locations?: { path: string; line?: number }[];
    content?: { type: string; text?: string } | unknown[];
    [key: string]: unknown;
  };
}

interface AcpPermissionRequest {
  sessionId: string;
  toolCall: {
    toolCallId: string;
    name?: string;
    title?: string;
    kind?: string;
    locations?: { path: string; line?: number }[];
    rawInput?: unknown;
  };
  options: { optionId: string; name: string; kind: string }[];
}

interface JsonRpcErrorPayload {
  code: number;
  message: string;
  data?: unknown;
}

let providerServer: Server;
let providerBaseUrl = "";
let providerHandler: (req: RecordedProviderRequest) => ProviderHandlerResult = () => ({
  textParts: ["default reply"],
});
const providerRequests: RecordedProviderRequest[] = [];

const temps: string[] = [];
const processes = createProcessCleanup();
const closers: (() => Promise<void>)[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readAllFilesUnder(dir: string): string {
  if (!existsSync(dir)) return "";
  let combined = "";
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      combined += readAllFilesUnder(full);
    } else if (st.isFile()) {
      combined += `\n--- ${full} ---\n${readFileSync(full, "utf8")}`;
    }
  }
  return combined;
}

function findLockFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) found.push(...findLockFiles(full));
    else if (entry.endsWith(".lock")) found.push(full);
  }
  return found;
}

function messagesOf(req: RecordedProviderRequest): {
  role?: string;
  content?: unknown;
  tool_call_id?: string;
}[] {
  return Array.isArray(req.body.messages)
    ? (req.body.messages as { role?: string; content?: unknown; tool_call_id?: string }[])
    : [];
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === "object" && part !== null && "text" in part
          ? String((part as { text?: unknown }).text ?? "")
          : "",
      )
      .join("");
  }
  return "";
}

function latestUserText(req: RecordedProviderRequest): string {
  const msgs = messagesOf(req);
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    if (msgs[i]?.role === "user") return messageText(msgs[i]?.content);
  }
  return "";
}

function latestToolMessage(req: RecordedProviderRequest): string | undefined {
  const msgs = messagesOf(req);
  const last = msgs.at(-1);
  return last?.role === "tool" ? messageText(last.content) : undefined;
}

function toolNamesOf(req: RecordedProviderRequest): string[] {
  if (!Array.isArray(req.body.tools)) return [];
  return req.body.tools
    .map((t) =>
      typeof t === "object" && t !== null && "function" in t
        ? String((t as { function?: { name?: unknown } }).function?.name ?? "")
        : "",
    )
    .filter(Boolean);
}

/** 轻量 Streamable HTTP MCP 夹具（JSON 响应模式，支持多会话并发与自定义 Authorization 头检查） */
async function createHttpHostMcpFixture() {
  const calls: { authorization: string | undefined; args: Record<string, unknown> }[] = [];
  const seenHeaders: IncomingHttpHeaders[] = [];

  const httpServer = createServer((req, res) => {
    seenHeaders.push(req.headers);
    if (req.method === "DELETE") {
      res.writeHead(200);
      res.end();
      return;
    }
    if (req.method === "GET") {
      res.writeHead(405);
      res.end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) {
        res.writeHead(202);
        res.end();
        return;
      }
      const msg = JSON.parse(raw) as {
        id?: string | number;
        method?: string;
        params?: { name?: string; arguments?: Record<string, unknown>; protocolVersion?: string };
      };
      const sessionIdHeader =
        (Array.isArray(req.headers["mcp-session-id"])
          ? req.headers["mcp-session-id"][0]
          : req.headers["mcp-session-id"]) ?? randomUUID();

      if (msg.method === "notifications/initialized") {
        res.writeHead(202, { "mcp-session-id": sessionIdHeader });
        res.end();
        return;
      }
      if (msg.method === "initialize") {
        res.writeHead(200, {
          "content-type": "application/json",
          "mcp-session-id": sessionIdHeader,
        });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              protocolVersion: msg.params?.protocolVersion ?? "2025-03-26",
              capabilities: { tools: {} },
              serverInfo: { name: "host-http-orch", version: "1.0.0" },
            },
          }),
        );
        return;
      }
      if (msg.method === "tools/list") {
        res.writeHead(200, {
          "content-type": "application/json",
          "mcp-session-id": sessionIdHeader,
        });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              tools: [
                {
                  name: "check_auth",
                  description: "只读检查宿主 HTTP 凭据隔离",
                  annotations: { readOnlyHint: true },
                  inputSchema: {
                    type: "object",
                    properties: { label: { type: "string" } },
                  },
                },
              ],
            },
          }),
        );
        return;
      }
      if (msg.method === "tools/call") {
        const auth = req.headers.authorization;
        const args = msg.params?.arguments ?? {};
        calls.push({ authorization: auth, args });
        res.writeHead(200, {
          "content-type": "application/json",
          "mcp-session-id": sessionIdHeader,
        });
        // 故意回显 Authorization，验证 Nocturne MCP 脱敏层将其从模型上下文与日志抹除
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              content: [
                {
                  type: "text",
                  text: `http-ok label=${String(args.label ?? "")} raw=${String(auth ?? "")}`,
                },
              ],
            },
          }),
        );
        return;
      }
      res.writeHead(200, {
        "content-type": "application/json",
        "mcp-session-id": sessionIdHeader,
      });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32601, message: `unknown method: ${String(msg.method)}` },
        }),
      );
    });
  });

  const port = await listenFetchSafe(httpServer);
  closers.push(() => new Promise<void>((resolve) => httpServer.close(() => resolve())));
  return { url: `http://127.0.0.1:${port}/mcp`, calls, seenHeaders };
}

interface SpawnedAcp {
  proc: ChildProcessWithoutNullStreams;
  nocturneHome: string;
  isoHome: string;
  stdoutLines: string[];
  stderrText: () => string;
  updates: AcpSessionUpdateNotification[];
  permissions: AcpPermissionRequest[];
  request: <T = Record<string, unknown>>(method: string, params: unknown) => Promise<T>;
  notify: (method: string, params: unknown) => void;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  closeStdin: () => void;
}

function spawnAcpCli(options: {
  configureModel?: boolean;
  configExtra?: Record<string, unknown>;
  /** 完整替换 scripted 服务商的 models 声明（默认仅 e2e-model 无推理档位） */
  modelsConfig?: Record<string, unknown>;
  userMcpJson?: Record<string, unknown>;
  extraArgs?: string[];
  /** 复用已有的隔离 home（A/B 进程共享同一 NOCTURNE_HOME 的跨进程恢复测试） */
  isoHome?: string;
  onPermission?: (
    req: AcpPermissionRequest,
  ) => Promise<"allow_once" | "reject_once" | "cancel" | "hang">;
  /** elicitation/create 宿主处理器（r1126l）：返回 action 与可选 content */
  onElicitation?: (
    req: Record<string, unknown>,
  ) => Promise<{ action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> }>;
  /** 捕获到的 elicitation 请求（如果有 onElicitation 则同数组被填充） */
  elicitations?: Record<string, unknown>[];
}): SpawnedAcp {
  const isoHome = options.isoHome ?? makeTempDir("nctrn-acp-iso-");
  const nocturneHome = path.join(isoHome, "nocturne-home");
  const codexHome = path.join(isoHome, "codex-home");
  const claudeDir = path.join(isoHome, "claude-dir");
  mkdirSync(nocturneHome, { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(claudeDir, { recursive: true });

  if (options.configureModel !== false) {
    writeFileSync(
      path.join(nocturneHome, "config.json"),
      JSON.stringify(
        {
          model: "scripted/e2e-model",
          providers: [
            {
              id: "scripted",
              type: "openai-compatible",
              baseURL: providerBaseUrl,
              apiKeyEnv: "NOCTURNE_ACP_TEST_KEY",
              models: options.modelsConfig ?? {
                "e2e-model": { contextWindow: 128_000, maxOutputTokens: 4096 },
              },
            },
          ],
          ...options.configExtra,
        },
        null,
        2,
      ),
    );
  }
  if (options.userMcpJson !== undefined) {
    writeFileSync(
      path.join(nocturneHome, "mcp.json"),
      JSON.stringify(options.userMcpJson, null, 2),
    );
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: isoHome,
    USERPROFILE: isoHome,
    NOCTURNE_HOME: nocturneHome,
    CODEX_HOME: codexHome,
    CLAUDE_CONFIG_DIR: claudeDir,
    NOCTURNE_ACP_TEST_KEY: "dummy-local-provider-key",
    HTTP_PROXY: "",
    HTTPS_PROXY: "",
    ALL_PROXY: "",
    http_proxy: "",
    https_proxy: "",
    all_proxy: "",
  };
  delete env.NOCTURNE_MODEL;
  delete env.NOCTURNE_BASE_URL;
  delete env.NOCTURNE_API_TYPE;
  delete env.NOCTURNE_API_KEY_ENV;

  const proc = processes.trackChild(
    spawn(process.execPath, [cliEntry, "acp", ...(options.extraArgs ?? [])], {
      cwd: isoHome,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    }),
  );

  const stdoutLines: string[] = [];
  const updates: AcpSessionUpdateNotification[] = [];
  const permissions: AcpPermissionRequest[] = [];
  let stderrBuf = "";
  proc.stderr.on("data", (chunk: Buffer) => {
    stderrBuf += chunk.toString("utf8");
  });

  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (err: JsonRpcErrorPayload) => void }
  >();

  const sendRaw = (frame: unknown) => {
    if (!proc.stdin.destroyed && !proc.stdin.writableEnded) {
      proc.stdin.write(`${JSON.stringify(frame)}\n`);
    }
  };

  const rl = createInterface({ input: proc.stdout, crlfDelay: Infinity });
  rl.on("line", (line) => {
    if (line.length === 0) return;
    stdoutLines.push(line);
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    // 响应
    if ("id" in msg && !("method" in msg)) {
      const id = Number(msg.id);
      const slot = pending.get(id);
      if (slot === undefined) return;
      pending.delete(id);
      if ("error" in msg && msg.error !== undefined) {
        slot.reject(msg.error as JsonRpcErrorPayload);
      } else {
        slot.resolve(msg.result);
      }
      return;
    }
    // 通知：session/update
    if (msg.method === "session/update" && !("id" in msg)) {
      updates.push(msg.params as AcpSessionUpdateNotification);
      return;
    }
    // Agent 向宿主发起的请求：session/request_permission
    if (msg.method === "session/request_permission" && "id" in msg) {
      const reqId = msg.id;
      const reqParams = msg.params as AcpPermissionRequest;
      permissions.push(reqParams);
      void (async () => {
        const decision = (await options.onPermission?.(reqParams)) ?? "reject_once";
        if (decision === "hang") return;
        const outcome =
          decision === "cancel"
            ? { outcome: "cancelled" }
            : { outcome: "selected", optionId: decision };
        sendRaw({ jsonrpc: "2.0", id: reqId, result: { outcome } });
      })();
      return;
    }
    // Agent 向宿主发起的请求：elicitation/create（r1126l 第三阶段）
    if (msg.method === "elicitation/create" && "id" in msg) {
      const reqId = msg.id;
      const reqParams = msg.params as Record<string, unknown>;
      options.elicitations?.push(reqParams);
      void (async () => {
        const decision = (await options.onElicitation?.(reqParams)) ?? { action: "cancel" };
        const result: Record<string, unknown> = { action: decision.action };
        if (decision.content !== undefined) result.content = decision.content;
        sendRaw({ jsonrpc: "2.0", id: reqId, result });
      })();
      return;
    }
  });

  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    proc.once("exit", (code, signal) => {
      for (const slot of pending.values()) {
        slot.reject({
          code: -32000,
          message: `process exited (code=${String(code)}, signal=${String(signal)}): ${stderrBuf}`,
        });
      }
      pending.clear();
      resolve({ code, signal });
    });
  });

  const request = <T = Record<string, unknown>>(method: string, params: unknown): Promise<T> => {
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      sendRaw({ jsonrpc: "2.0", id, method, params });
    });
  };

  const notify = (method: string, params: unknown): void => {
    sendRaw({ jsonrpc: "2.0", method, params });
  };

  closers.push(async () => {
    rl.close();
    if (!proc.stdin.destroyed) proc.stdin.end();
    await Promise.race([exit, new Promise((r) => setTimeout(r, 3000))]);
  });

  return {
    proc,
    nocturneHome,
    isoHome,
    stdoutLines,
    stderrText: () => stderrBuf,
    updates,
    permissions,
    request,
    notify,
    exit,
    closeStdin: () => {
      if (!proc.stdin.destroyed) proc.stdin.end();
    },
  };
}

function assertAllStdoutLinesValidJsonRpc(lines: readonly string[]): void {
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines) {
    const parsed = JSON.parse(line) as { jsonrpc?: unknown };
    expect(parsed.jsonrpc).toBe("2.0");
  }
}

beforeAll(async () => {
  await ensureCliBuilt(repoRoot);
  providerServer = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      if (req.method === "GET" && req.url === "/v1/models") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "e2e-model", context_length: 128_000 }] }));
        return;
      }
      const rawBody = Buffer.concat(chunks).toString("utf8");
      const body = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
      const record: RecordedProviderRequest = { body, rawBody };
      providerRequests.push(record);

      void (async () => {
        // 后台自动生成会话标题请求不带 tools，直接返回简短标题，不干扰测试脚本状态。
        // handler 可返回 Promise（可控延迟），用于在途压缩取消等需要挂起 provider 的场景。
        const reply = await (toolNamesOf(record).length === 0
          ? { textParts: ["acp-test-title"] }
          : providerHandler(record));
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const emit = (delta: Record<string, unknown>, finish?: string) => {
        res.write(
          `data: ${JSON.stringify({
            id: "acp-e2e",
            object: "chat.completion.chunk",
            created: 1,
            model: "e2e-model",
            choices: [{ index: 0, delta, finish_reason: finish ?? null }],
          })}\n\n`,
        );
      };
      // OpenAI 流式 stream_options.include_usage 语义：finish chunk 后追加一个
      // choices:[] 的 chunk 携带非零 usage——核实合成 provider 能让 turn.completed.usage 非零。
      const emitUsage = () => {
        res.write(
          `data: ${JSON.stringify({
            id: "acp-e2e",
            object: "chat.completion.chunk",
            created: 1,
            model: "e2e-model",
            choices: [],
            usage: { prompt_tokens: 1234, completion_tokens: 56, total_tokens: 1290 },
          })}\n\n`,
        );
      };

      if (reply.toolCalls && reply.toolCalls.length > 0) {
        emit({ role: "assistant" });
        reply.toolCalls.forEach((tc, index) => {
          emit({
            tool_calls: [
              {
                index,
                id: tc.id,
                type: "function",
                function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
              },
            ],
          });
        });
        emit({}, "tool_calls");
        emitUsage();
      } else {
        emit({ role: "assistant" });
        for (const part of reply.textParts ?? ["ok"]) {
          emit({ content: part });
        }
        emit({}, "stop");
        emitUsage();
      }
      res.end("data: [DONE]\n\n");
      })().catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });
  });
  providerBaseUrl = `http://127.0.0.1:${await listenFetchSafe(providerServer)}/v1`;
}, 180_000);

afterAll(async () => {
  await new Promise<void>((resolve) => providerServer.close(() => resolve()));
});

afterEach(async () => {
  providerRequests.length = 0;
  providerHandler = () => ({ textParts: ["default reply"] });
  while (closers.length > 0) {
    const fn = closers.pop();
    await fn?.().catch(() => undefined);
  }
  await processes.cleanup();
  await removeTempDirs(temps.splice(0));
});

describe("nctrn acp 真实 CLI 子进程集成（ADR-0120 §4 第 1 项）", () => {
  it("握手、无模型配置错误、两轮上下文延续、工具卡片与 stdout 纯净性", async () => {
    const ws = makeTempDir("nctrn-acp-ws-");
    writeFileSync(path.join(ws, "note.txt"), "hello-from-host-cwd\n");

    // 1) 未配置模型时：握手成功，session/new 返回可操作错误指引 nctrn setup
    const unconfigured = spawnAcpCli({ configureModel: false });
    const initUnconf = await unconfigured.request<{
      protocolVersion: number;
      agentCapabilities: {
        loadSession?: boolean;
        mcpCapabilities?: { http?: boolean; sse?: boolean; acp?: boolean };
      };
    }>("initialize", { protocolVersion: 1 });
    expect(initUnconf.protocolVersion).toBe(1);
    expect(initUnconf.agentCapabilities.loadSession).toBe(true);
    expect(initUnconf.agentCapabilities.mcpCapabilities).toMatchObject({
      http: true,
      sse: false,
      acp: false,
    });
    await expect(
      unconfigured.request("session/new", { cwd: ws, mcpServers: [] }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("nctrn setup"),
    });
    unconfigured.closeStdin();
    expect((await unconfigured.exit).code).toBe(0);
    assertAllStdoutLinesValidJsonRpc(unconfigured.stdoutLines);

    // 2) 配置模型 + 空 mcpServers：两轮对话、只读工具卡片、更新严格早于最终响应
    const child = spawnAcpCli({});
    providerHandler = (req) => {
      const toolOut = latestToolMessage(req);
      const user = latestUserText(req);
      if (user.includes("read-note") && toolOut === undefined) {
        return {
          toolCalls: [{ id: "call_read_1", name: "read", arguments: { path: "note.txt" } }],
        };
      }
      if (toolOut !== undefined && toolOut.includes("hello-from-host-cwd")) {
        return { textParts: ["第一轮读到：", "hello-from-host-cwd"] };
      }
      if (user.includes("turn-two")) {
        const sawTurnOne = req.rawBody.includes("hello-from-host-cwd");
        return { textParts: [sawTurnOne ? "上下文延续确认" : "缺少上下文"] };
      }
      return { textParts: ["unexpected"] };
    };

    await child.request("initialize", { protocolVersion: 1 });
    const { sessionId } = await child.request<{ sessionId: string }>("session/new", {
      cwd: ws,
      mcpServers: [],
    });

    const res1 = await child.request<{ stopReason: string }>("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "请执行 read-note" }],
    });
    expect(res1).toEqual({ stopReason: "end_turn" });

    // 工具开始与结束共用同一 toolCallId，提供 read 类型与 locations，且最终响应晚于最后一条 update
    const toolStart = child.updates.find(
      (u) => u.sessionId === sessionId && u.update.sessionUpdate === "tool_call",
    );
    const toolDone = child.updates.find(
      (u) =>
        u.sessionId === sessionId &&
        u.update.sessionUpdate === "tool_call_update" &&
        u.update.status === "completed",
    );
    expect(toolStart?.update).toMatchObject({
      sessionUpdate: "tool_call",
      title: "read note.txt",
      kind: "read",
      locations: [{ path: expect.stringContaining("note.txt") }],
    });
    expect(toolDone?.update).toMatchObject({
      sessionUpdate: "tool_call_update",
      toolCallId: toolStart?.update.toolCallId,
      status: "completed",
    });

    const parsedStdout = child.stdoutLines.map((l) => JSON.parse(l) as Record<string, unknown>);
    const lastUpdateIdx = parsedStdout.reduce(
      (acc, msg, i) => (msg.method === "session/update" ? i : acc),
      -1,
    );
    const promptRespIdx = parsedStdout.findIndex(
      (msg) =>
        "result" in msg &&
        typeof msg.result === "object" &&
        msg.result !== null &&
        "stopReason" in msg.result,
    );
    expect(lastUpdateIdx).toBeGreaterThanOrEqual(0);
    expect(promptRespIdx).toBeGreaterThan(lastUpdateIdx);

    // 第二轮续聊
    const countBeforeTurn2 = child.updates.length;
    const res2 = await child.request<{ stopReason: string }>("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "请执行 turn-two" }],
    });
    expect(res2).toEqual({ stopReason: "end_turn" });
    const turn2Text = child.updates
      .slice(countBeforeTurn2)
      .filter((u) => u.update.sessionUpdate === "agent_message_chunk")
      .map((u) => {
        const content = u.update.content;
        return content && !Array.isArray(content) && content.type === "text"
          ? (content.text ?? "")
          : "";
      })
      .join("");
    expect(turn2Text).toBe("上下文延续确认");

    child.closeStdin();
    expect((await child.exit).code).toBe(0);
    assertAllStdoutLinesValidJsonRpc(child.stdoutLines);
  }, 60_000);

  it("权限审批：拒绝后零执行、批准后落盘、已有拒绝规则不弹窗直接拦截", async () => {
    const ws = makeTempDir("nctrn-acp-perm-");
    const child = spawnAcpCli({
      configExtra: {
        permissions: {
          rules: [
            { kind: "edit", pattern: "**/blocked.txt", action: "deny", label: "禁止写受保护文件" },
          ],
        },
      },
      onPermission: async (req) => {
        const loc = req.toolCall.locations?.[0]?.path ?? "";
        if (loc.endsWith("approved.txt")) return "allow_once";
        return "reject_once";
      },
    });

    providerHandler = (req) => {
      const toolOut = latestToolMessage(req);
      const user = latestUserText(req);
      if (toolOut !== undefined) {
        return { textParts: [`done:${toolOut.slice(0, 40)}`] };
      }
      if (user.includes("write-denied")) {
        return {
          toolCalls: [
            {
              id: "call_w_deny",
              name: "write",
              arguments: { path: "denied.txt", content: "must-not-exist" },
            },
          ],
        };
      }
      if (user.includes("write-approved")) {
        return {
          toolCalls: [
            {
              id: "call_w_allow",
              name: "write",
              arguments: { path: "approved.txt", content: "approved-payload" },
            },
          ],
        };
      }
      if (user.includes("write-blocked")) {
        return {
          toolCalls: [
            {
              id: "call_w_block",
              name: "write",
              arguments: { path: "blocked.txt", content: "blocked-payload" },
            },
          ],
        };
      }
      return { textParts: ["noop"] };
    };

    await child.request("initialize", { protocolVersion: 1 });
    const { sessionId } = await child.request<{ sessionId: string }>("session/new", {
      cwd: ws,
      mcpServers: [],
    });

    // 1) 拒绝：磁盘零写入
    expect(
      await child.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: "write-denied" }],
      }),
    ).toEqual({ stopReason: "end_turn" });
    expect(existsSync(path.join(ws, "denied.txt"))).toBe(false);
    expect(child.permissions.length).toBe(1);
    expect(child.permissions[0]?.options.map((o) => o.kind)).toEqual(["allow_once", "reject_once"]);
    expect(child.permissions[0]?.toolCall).toMatchObject({
      name: "write",
      title: "write denied.txt",
      kind: "edit",
      rawInput: { path: "denied.txt", content: "must-not-exist" },
    });
    const deniedCallId = child.permissions[0]?.toolCall.toolCallId;
    expect(
      child.updates.filter(
        (u) => u.update.toolCallId === deniedCallId && u.update.sessionUpdate === "tool_call",
      ),
    ).toHaveLength(1);
    expect(
      child.updates.some(
        (u) =>
          u.update.toolCallId === deniedCallId &&
          u.update.sessionUpdate === "tool_call_update" &&
          u.update.status === "failed",
      ),
    ).toBe(true);

    // 2) 批准：真实落盘，且同一 toolCallId 仅发一次 tool_call，后续走 tool_call_update
    expect(
      await child.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: "write-approved" }],
      }),
    ).toEqual({ stopReason: "end_turn" });
    expect(readFileSync(path.join(ws, "approved.txt"), "utf8")).toBe("approved-payload");
    expect(child.permissions.length).toBe(2);
    expect(child.permissions[1]?.toolCall).toMatchObject({
      name: "write",
      title: "write approved.txt",
      kind: "edit",
    });
    const approvedCallId = child.permissions[1]?.toolCall.toolCallId;
    expect(
      child.updates.filter(
        (u) => u.update.toolCallId === approvedCallId && u.update.sessionUpdate === "tool_call",
      ),
    ).toHaveLength(1);
    expect(
      child.updates.some(
        (u) =>
          u.update.toolCallId === approvedCallId &&
          u.update.sessionUpdate === "tool_call_update" &&
          u.update.status === "completed",
      ),
    ).toBe(true);

    // 3) 已有 deny 规则：不向宿主弹窗，直接拒绝且零写入
    expect(
      await child.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: "write-blocked" }],
      }),
    ).toEqual({ stopReason: "end_turn" });
    expect(existsSync(path.join(ws, "blocked.txt"))).toBe(false);
    expect(child.permissions.length).toBe(2);

    child.closeStdin();
    expect((await child.exit).code).toBe(0);
    assertAllStdoutLinesValidJsonRpc(child.stdoutLines);
  }, 60_000);

  it("双会话同名宿主 MCP（stdio + Streamable HTTP）隔离、拒绝零执行、凭据零泄露且不落盘", async () => {
    const wsA = makeTempDir("nctrn-acp-wsa-");
    const wsB = makeTempDir("nctrn-acp-wsb-");
    const logDir = makeTempDir("nctrn-acp-mcplog-");
    const callLogA = path.join(logDir, "calls-a.jsonl");
    const callLogB = path.join(logDir, "calls-b.jsonl");
    const httpMcp = await createHttpHostMcpFixture();

    const secretStdioA = "stdio-secret-alpha-901";
    const secretStdioB = "stdio-secret-beta-902";
    const secretHttpA = "http-secret-alpha-801";
    const secretHttpB = "http-secret-beta-802";

    let rejectNextDispatchForA = true;
    let sessionIdA = "";
    const child = spawnAcpCli({
      onPermission: async (req) => {
        if (req.sessionId === sessionIdA && rejectNextDispatchForA) {
          rejectNextDispatchForA = false;
          return "reject_once";
        }
        return "allow_once";
      },
    });

    providerHandler = (req) => {
      const user = latestUserText(req);
      const toolOut = latestToolMessage(req);
      const tools = toolNamesOf(req);
      if (toolOut !== undefined) {
        return { textParts: [`result:${toolOut}`] };
      }
      if (user.includes("call-stdio")) {
        expect(tools).toContain("mcp__orch__dispatch");
        return {
          toolCalls: [
            {
              id: `call_stdio_${randomUUID().slice(0, 6)}`,
              name: "mcp__orch__dispatch",
              arguments: { task: user },
            },
          ],
        };
      }
      if (user.includes("call-http")) {
        expect(tools).toContain("mcp__orch_http__check_auth");
        return {
          toolCalls: [
            {
              id: `call_http_${randomUUID().slice(0, 6)}`,
              name: "mcp__orch_http__check_auth",
              arguments: { label: user },
            },
          ],
        };
      }
      return { textParts: ["ok"] };
    };

    await child.request("initialize", { protocolVersion: 1 });
    const sA = await child.request<{ sessionId: string }>("session/new", {
      cwd: wsA,
      mcpServers: [
        {
          name: "orch",
          command: process.execPath,
          args: [fakeHostMcp],
          env: [
            { name: "SESSION_TAG", value: "alpha" },
            { name: "ORCH_API_TOKEN", value: secretStdioA },
            { name: "NOCTURNE_TEST_CALL_LOG", value: callLogA },
          ],
        },
        {
          type: "http",
          name: "orch_http",
          url: httpMcp.url,
          headers: [{ name: "Authorization", value: `Bearer ${secretHttpA}` }],
        },
      ],
    });
    sessionIdA = sA.sessionId;

    const sB = await child.request<{ sessionId: string }>("session/new", {
      cwd: wsB,
      mcpServers: [
        {
          name: "orch",
          command: process.execPath,
          args: [fakeHostMcp],
          env: [
            { name: "SESSION_TAG", value: "beta" },
            { name: "ORCH_API_TOKEN", value: secretStdioB },
            { name: "NOCTURNE_TEST_CALL_LOG", value: callLogB },
          ],
        },
        {
          type: "http",
          name: "orch_http",
          url: httpMcp.url,
          headers: [{ name: "Authorization", value: `Bearer ${secretHttpB}` }],
        },
      ],
    });
    const sessionIdB = sB.sessionId;
    expect(sessionIdA).not.toBe(sessionIdB);

    // 1) A 会话首次调宿主工具被拒绝：MCP 服务器端零执行，且审批卡片显示真实宿主工具名
    await child.request("session/prompt", {
      sessionId: sessionIdA,
      prompt: [{ type: "text", text: "call-stdio denied-first" }],
    });
    expect(existsSync(callLogA)).toBe(false);
    expect(child.permissions[0]?.toolCall).toMatchObject({
      name: "mcp__orch__dispatch",
      title: "mcp__orch__dispatch",
    });

    // 2) A 与 B 并发调用同名 stdio 和 HTTP 宿主工具：各自落到各自实例与凭据
    const [rA1, rB1] = await Promise.all([
      child.request("session/prompt", {
        sessionId: sessionIdA,
        prompt: [{ type: "text", text: "call-stdio for-A" }],
      }),
      child.request("session/prompt", {
        sessionId: sessionIdB,
        prompt: [{ type: "text", text: "call-stdio for-B" }],
      }),
    ]);
    expect(rA1).toEqual({ stopReason: "end_turn" });
    expect(rB1).toEqual({ stopReason: "end_turn" });

    await Promise.all([
      child.request("session/prompt", {
        sessionId: sessionIdA,
        prompt: [{ type: "text", text: "call-http for-A" }],
      }),
      child.request("session/prompt", {
        sessionId: sessionIdB,
        prompt: [{ type: "text", text: "call-http for-B" }],
      }),
    ]);

    // 核对 stdio 隔离：A 仅执行 A 的任务，B 仅执行 B 的任务
    const callsA = readFileSync(callLogA, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { tag: string; args: { task: string }; hasToken: boolean });
    const callsB = readFileSync(callLogB, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { tag: string; args: { task: string }; hasToken: boolean });
    expect(callsA).toHaveLength(1);
    expect(callsA[0]).toMatchObject({ tag: "alpha", hasToken: true });
    expect(callsA[0]?.args.task).toContain("for-A");
    expect(callsB).toHaveLength(1);
    expect(callsB[0]).toMatchObject({ tag: "beta", hasToken: true });
    expect(callsB[0]?.args.task).toContain("for-B");

    // 核对 HTTP 凭据按会话严格隔离
    expect(
      httpMcp.calls.some(
        (c) =>
          c.authorization === `Bearer ${secretHttpA}` &&
          String(c.args.label ?? "").includes("for-A"),
      ),
    ).toBe(true);
    expect(
      httpMcp.calls.some(
        (c) =>
          c.authorization === `Bearer ${secretHttpB}` &&
          String(c.args.label ?? "").includes("for-B"),
      ),
    ).toBe(true);

    // 核对 session/update 严格按 sessionId 隔离（A 的文本不含 beta，B 的文本不含 alpha）
    const textFor = (sid: string) =>
      child.updates
        .filter((u) => u.sessionId === sid && u.update.sessionUpdate === "agent_message_chunk")
        .map((u) => {
          const content = u.update.content;
          return content && !Array.isArray(content) && content.type === "text"
            ? (content.text ?? "")
            : "";
        })
        .join("");
    expect(textFor(sessionIdA)).toContain("tag=alpha");
    expect(textFor(sessionIdA)).not.toContain("tag=beta");
    expect(textFor(sessionIdB)).toContain("tag=beta");
    expect(textFor(sessionIdB)).not.toContain("tag=alpha");

    child.closeStdin();
    expect((await child.exit).code).toBe(0);
    assertAllStdoutLinesValidJsonRpc(child.stdoutLines);

    // 核对所有敏感凭据从未进入 stdout、stderr、模型请求上下文或会话磁盘日志
    const allSurfaces = [
      child.stdoutLines.join("\n"),
      child.stderrText(),
      providerRequests.map((r) => r.rawBody).join("\n"),
      readAllFilesUnder(child.nocturneHome),
    ].join("\n");
    for (const secret of [secretStdioA, secretStdioB, secretHttpA, secretHttpB]) {
      expect(allSurfaces).not.toContain(secret);
    }

    // 宿主 MCP 不落盘用户/项目 mcp.json，不自动授予项目信任
    expect(existsSync(path.join(child.nocturneHome, "mcp.json"))).toBe(false);
    expect(existsSync(path.join(wsA, ".nocturne", "mcp.json"))).toBe(false);
    expect(existsSync(path.join(wsB, ".nocturne", "mcp.json"))).toBe(false);
    expect(existsSync(path.join(child.nocturneHome, "trust.json"))).toBe(false);
  }, 60_000);

  it("宿主 MCP 同名冲突与部分启动失败时明确报错并回收已启动进程与锁", async () => {
    const ws = makeTempDir("nctrn-acp-partial-");
    const pidDir = makeTempDir("nctrn-acp-pid-");
    const healthyPidFile = path.join(pidDir, "healthy.pid");

    const child = spawnAcpCli({
      userMcpJson: {
        version: 1,
        servers: {
          existing_srv: {
            command: process.execPath,
            args: [fakeHostMcp],
          },
        },
      },
    });
    await child.request("initialize", { protocolVersion: 1 });

    // 1) 与用户配置重名（不区分大小写）明确报错
    await expect(
      child.request("session/new", {
        cwd: ws,
        mcpServers: [
          { name: "EXISTING_SRV", command: process.execPath, args: [fakeHostMcp], env: [] },
        ],
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("冲突"),
    });

    // 2) 部分启动失败：一个健康 stdio + 一个立即失败 stdio -> 报错并回收健康进程与会话锁
    await expect(
      child.request("session/new", {
        cwd: ws,
        mcpServers: [
          {
            name: "healthy_srv",
            command: process.execPath,
            args: [fakeHostMcp],
            env: [{ name: "NOCTURNE_TEST_PID_FILE", value: healthyPidFile }],
          },
          {
            name: "broken_srv",
            command: process.execPath,
            args: [fakeHostMcp, "--fail"],
            env: [],
          },
        ],
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("broken_srv"),
    });

    if (existsSync(healthyPidFile)) {
      const healthyPid = Number(readFileSync(healthyPidFile, "utf8").trim());
      expect(Number.isInteger(healthyPid)).toBe(true);
      await vi.waitFor(() => expect(isPidAlive(healthyPid)).toBe(false), { timeout: 5000 });
    }
    expect(findLockFiles(path.join(child.nocturneHome, "sessions"))).toEqual([]);

    child.closeStdin();
    expect((await child.exit).code).toBe(0);
    assertAllStdoutLinesValidJsonRpc(child.stdoutLines);
  }, 60_000);

  it("运行中 session/cancel 中止工具并可继续下一轮，另一会话不受影响", async () => {
    const wsA = makeTempDir("nctrn-acp-cancela-");
    const wsB = makeTempDir("nctrn-acp-cancelb-");
    const child = spawnAcpCli({
      onPermission: async () => "allow_once",
    });

    providerHandler = (req) => {
      const user = latestUserText(req);
      const toolOut = latestToolMessage(req);
      if (toolOut !== undefined) return { textParts: ["after-tool"] };
      if (user.includes("run-slow")) {
        return {
          toolCalls: [{ id: "call_slow_1", name: "mcp__orch__slow_op", arguments: { ms: 20_000 } }],
        };
      }
      if (user.includes("after-cancel")) return { textParts: ["取消后恢复正常"] };
      if (user.includes("ping-b")) return { textParts: ["会话B正常"] };
      return { textParts: ["ok"] };
    };

    await child.request("initialize", { protocolVersion: 1 });
    const sA = await child.request<{ sessionId: string }>("session/new", {
      cwd: wsA,
      mcpServers: [{ name: "orch", command: process.execPath, args: [fakeHostMcp], env: [] }],
    });
    const sB = await child.request<{ sessionId: string }>("session/new", {
      cwd: wsB,
      mcpServers: [],
    });

    const slowPrompt = child.request("session/prompt", {
      sessionId: sA.sessionId,
      prompt: [{ type: "text", text: "run-slow" }],
    });

    await vi.waitFor(
      () =>
        expect(
          child.updates.some(
            (u) =>
              u.sessionId === sA.sessionId &&
              ((u.update.sessionUpdate === "tool_call" && u.update.status === "in_progress") ||
                (u.update.sessionUpdate === "tool_call_update" &&
                  u.update.status === "in_progress")),
          ),
        ).toBe(true),
      { timeout: 10_000 },
    );

    child.notify("session/cancel", { sessionId: sA.sessionId });
    const cancelledRes = await slowPrompt;
    expect(cancelledRes).toEqual({ stopReason: "cancelled" });

    // 工具已收束为 failed
    expect(
      child.updates.some(
        (u) =>
          u.sessionId === sA.sessionId &&
          u.update.sessionUpdate === "tool_call_update" &&
          u.update.status === "failed",
      ),
    ).toBe(true);

    // 取消后原会话可继续接受下一轮，且另一会话正常可用
    expect(
      await child.request("session/prompt", {
        sessionId: sA.sessionId,
        prompt: [{ type: "text", text: "after-cancel" }],
      }),
    ).toEqual({ stopReason: "end_turn" });

    expect(
      await child.request("session/prompt", {
        sessionId: sB.sessionId,
        prompt: [{ type: "text", text: "ping-b" }],
      }),
    ).toEqual({ stopReason: "end_turn" });

    child.closeStdin();
    expect((await child.exit).code).toBe(0);
    assertAllStdoutLinesValidJsonRpc(child.stdoutLines);
  }, 60_000);

  it("EOF 断开时待审操作零执行，清理宿主 MCP 进程与会话锁，保留正常日志与宿主目录", async () => {
    const ws = makeTempDir("nctrn-acp-eof-");
    const pidDir = makeTempDir("nctrn-acp-eofpid-");
    const mcpPidFile = path.join(pidDir, "mcp.pid");

    const permArrived = Promise.withResolvers<undefined>();
    const child = spawnAcpCli({
      onPermission: async () => {
        permArrived.resolve(undefined);
        return "hang";
      },
    });

    providerHandler = (req) => {
      const user = latestUserText(req);
      if (user.includes("hello-turn")) return { textParts: ["logged-reply"] };
      if (user.includes("need-approval")) {
        return {
          toolCalls: [
            {
              id: "call_eof_write",
              name: "write",
              arguments: { path: "eof-must-not-write.txt", content: "should-never-exist" },
            },
          ],
        };
      }
      return { textParts: ["ok"] };
    };

    await child.request("initialize", { protocolVersion: 1 });
    const { sessionId } = await child.request<{ sessionId: string }>("session/new", {
      cwd: ws,
      mcpServers: [
        {
          name: "orch",
          command: process.execPath,
          args: [fakeHostMcp],
          env: [{ name: "NOCTURNE_TEST_PID_FILE", value: mcpPidFile }],
        },
      ],
    });

    const mcpPid = Number(readFileSync(mcpPidFile, "utf8").trim());
    expect(isPidAlive(mcpPid)).toBe(true);

    // 先跑一轮正常对话，确认会话日志落盘
    expect(
      await child.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: "hello-turn" }],
      }),
    ).toEqual({ stopReason: "end_turn" });

    // 第二轮进入待审状态后直接关闭 stdin（EOF）
    const pendingPrompt = child.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "need-approval" }],
    });
    void pendingPrompt.catch(() => undefined);

    await permArrived.promise;
    child.closeStdin();

    const exitResult = await child.exit;
    expect(exitResult.code).toBe(0);

    // 待审写盘不得执行；宿主 MCP 子进程已清理；会话锁已释放；正常日志与宿主目录保留
    expect(existsSync(path.join(ws, "eof-must-not-write.txt"))).toBe(false);
    await vi.waitFor(() => expect(isPidAlive(mcpPid)).toBe(false), { timeout: 5000 });
    expect(findLockFiles(path.join(child.nocturneHome, "sessions"))).toEqual([]);
    expect(existsSync(path.join(child.nocturneHome, "sessions", `${sessionId}.jsonl`))).toBe(true);
    expect(existsSync(ws)).toBe(true);
    assertAllStdoutLinesValidJsonRpc(child.stdoutLines);
  }, 60_000);

  it("session/new 报告真实 configOptions，set_config_option 切换模型与档位直达 provider 请求", async () => {
    const ws = makeTempDir("nctrn-acp-confopt-");
    const child = spawnAcpCli({
      modelsConfig: {
        "e2e-model": {
          contextWindow: 128_000,
          maxOutputTokens: 4096,
          capabilities: { reasoning: "visible", reasoningEffort: ["low", "high"] },
        },
        "org/deep-model": {
          contextWindow: 128_000,
          maxOutputTokens: 4096,
          capabilities: { reasoning: "visible", reasoningEffort: ["medium", "xhigh", "max"] },
        },
        "plain-model": { contextWindow: 128_000, maxOutputTokens: 4096 },
      },
    });

    providerHandler = () => ({ textParts: ["cfg-reply"] });
    await child.request("initialize", { protocolVersion: 1 });

    // 1) 默认会话：configOptions 报告完整目录（含多段斜杠 ID）与 e2e-model 的档位
    const s1 = await child.request<{
      sessionId: string;
      configOptions?: {
        id: string;
        category?: string;
        currentValue?: string;
        options?: { value: string; name: string }[];
      }[];
    }>("session/new", { cwd: ws, mcpServers: [] });
    expect(s1.configOptions).toBeDefined();
    const modelOpt = s1.configOptions?.find((o) => o.id === "model");
    expect(modelOpt).toMatchObject({ category: "model", currentValue: "scripted/e2e-model" });
    const modelValues = modelOpt?.options?.map((o) => o.value) ?? [];
    expect(modelValues).toContain("scripted/e2e-model");
    expect(modelValues).toContain("scripted/org/deep-model");
    expect(modelValues).toContain("scripted/plain-model");
    const effortOpt = s1.configOptions?.find((o) => o.id === "thought_level");
    expect(effortOpt).toMatchObject({ category: "thought_level", currentValue: "off" });
    expect(effortOpt?.options?.map((o) => o.value)).toEqual(["off", "low", "high"]);

    // 2) 第一轮（默认模型、off 档）：请求体为 e2e-model 且不带思考参数
    providerRequests.length = 0;
    expect(
      await child.request("session/prompt", {
        sessionId: s1.sessionId,
        prompt: [{ type: "text", text: "turn-default" }],
      }),
    ).toEqual({ stopReason: "end_turn" });
    const defaultReq = providerRequests.find((r) => latestUserText(r).includes("turn-default"));
    expect(defaultReq?.body.model).toBe("e2e-model");
    expect(defaultReq?.body).not.toHaveProperty("reasoning_effort");
    expect(defaultReq?.body).not.toHaveProperty("reasoning");

    // 3) 切到含多段斜杠的 org/deep-model：回报完整配置，档位集合刷新
    const switched = await child.request<{
      configOptions: {
        id: string;
        currentValue?: string;
        options?: { value: string }[];
      }[];
    }>("session/set_config_option", {
      sessionId: s1.sessionId,
      configId: "model",
      value: "scripted/org/deep-model",
    });
    expect(switched.configOptions.find((o) => o.id === "model")?.currentValue).toBe(
      "scripted/org/deep-model",
    );
    const deepEffort = switched.configOptions.find((o) => o.id === "thought_level");
    expect(deepEffort?.options?.map((o) => o.value)).toEqual(["off", "medium", "xhigh", "max"]);

    // 4) 切 xhigh 档位后下一轮：请求体为 org/deep-model + reasoning_effort=xhigh
    await child.request("session/set_config_option", {
      sessionId: s1.sessionId,
      configId: "thought_level",
      value: "xhigh",
    });
    providerRequests.length = 0;
    expect(
      await child.request("session/prompt", {
        sessionId: s1.sessionId,
        prompt: [{ type: "text", text: "turn-deep" }],
      }),
    ).toEqual({ stopReason: "end_turn" });
    const deepReq = providerRequests.find((r) => latestUserText(r).includes("turn-deep"));
    expect(deepReq?.body.model).toBe("org/deep-model");
    expect(deepReq?.body.reasoning_effort).toBe("xhigh");

    // 5) 非法值保留原配置：未声明模型、未知档位、未知配置项
    await expect(
      child.request("session/set_config_option", {
        sessionId: s1.sessionId,
        configId: "model",
        value: "scripted/ghost-model",
      }),
    ).rejects.toMatchObject({ code: -32602 });
    await expect(
      child.request("session/set_config_option", {
        sessionId: s1.sessionId,
        configId: "thought_level",
        value: "high",
      }),
    ).rejects.toMatchObject({ code: -32602 });
    await expect(
      child.request("session/set_config_option", {
        sessionId: s1.sessionId,
        configId: "unknown_option",
        value: "whatever",
      }),
    ).rejects.toMatchObject({ code: -32602 });

    // 原配置未变：下一轮仍是 org/deep-model + xhigh
    providerRequests.length = 0;
    expect(
      await child.request("session/prompt", {
        sessionId: s1.sessionId,
        prompt: [{ type: "text", text: "turn-unchanged" }],
      }),
    ).toEqual({ stopReason: "end_turn" });
    const unchangedReq = providerRequests.find((r) => latestUserText(r).includes("turn-unchanged"));
    expect(unchangedReq?.body.model).toBe("org/deep-model");
    expect(unchangedReq?.body.reasoning_effort).toBe("xhigh");

    // 6) 双会话隔离：第二个会话用默认模型；无档位模型不出 thought_level
    const s2 = await child.request<{
      sessionId: string;
      configOptions?: { id: string; currentValue?: string }[];
    }>("session/new", { cwd: ws, mcpServers: [] });
    const s2Model = s2.configOptions?.find((o) => o.id === "model");
    expect(s2Model?.currentValue).toBe("scripted/e2e-model");
    await child.request("session/set_config_option", {
      sessionId: s2.sessionId,
      configId: "model",
      value: "scripted/plain-model",
    });
    const s2After = await child.request<{
      configOptions: { id: string; currentValue?: string }[];
    }>("session/set_config_option", {
      sessionId: s2.sessionId,
      configId: "thought_level",
      value: "off",
    });
    // plain-model 无声明档位 → 不出现 thought_level 选择器
    expect(s2After.configOptions.some((o) => o.id === "thought_level")).toBe(false);

    providerRequests.length = 0;
    await child.request("session/prompt", {
      sessionId: s2.sessionId,
      prompt: [{ type: "text", text: "turn-plain" }],
    });
    const plainReq = providerRequests.find((r) => latestUserText(r).includes("turn-plain"));
    expect(plainReq?.body.model).toBe("plain-model");
    expect(plainReq?.body).not.toHaveProperty("reasoning_effort");

    // s1 的选择不受影响：s1 再发一轮仍是 org/deep-model + xhigh
    providerRequests.length = 0;
    await child.request("session/prompt", {
      sessionId: s1.sessionId,
      prompt: [{ type: "text", text: "turn-s1-final" }],
    });
    const s1FinalReq = providerRequests.find((r) => latestUserText(r).includes("turn-s1-final"));
    expect(s1FinalReq?.body.model).toBe("org/deep-model");
    expect(s1FinalReq?.body.reasoning_effort).toBe("xhigh");

    // 7) 旧宿主路径：第三个会话忽略 configOptions 直接 prompt，仍按默认模型运行
    const s3 = await child.request<{ sessionId: string }>("session/new", {
      cwd: ws,
      mcpServers: [],
    });
    providerRequests.length = 0;
    expect(
      await child.request("session/prompt", {
        sessionId: s3.sessionId,
        prompt: [{ type: "text", text: "turn-legacy" }],
      }),
    ).toEqual({ stopReason: "end_turn" });
    const legacyReq = providerRequests.find((r) => latestUserText(r).includes("turn-legacy"));
    expect(legacyReq?.body.model).toBe("e2e-model");

    child.closeStdin();
    expect((await child.exit).code).toBe(0);
    assertAllStdoutLinesValidJsonRpc(child.stdoutLines);
  }, 60_000);

  it("混合图片与文本附件：真实 provider 请求按 text A/image1/text B/image2/text C 顺序投影", async () => {
    // 1x1 PNG（与 page-comments 测试同源的有效字节）
    const PNG_B64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
    const ws = makeTempDir("nctrn-acp-mixed-");
    const child = spawnAcpCli({
      modelsConfig: {
        "e2e-model": {
          contextWindow: 128_000,
          maxOutputTokens: 4096,
          capabilities: { imageInput: true },
        },
      },
    });
    providerHandler = () => ({ textParts: ["mixed-reply"] });
    await child.request("initialize", { protocolVersion: 1 });
    const { sessionId } = await child.request<{ sessionId: string }>("session/new", {
      cwd: ws,
      mcpServers: [],
    });

    providerRequests.length = 0;
    const res = await child.request<{ stopReason: string }>("session/prompt", {
      sessionId,
      prompt: [
        { type: "text", text: "text A" },
        { type: "image", data: PNG_B64, mimeType: "image/png" },
        { type: "text", text: "text B" },
        { type: "image", data: PNG_B64, mimeType: "image/png" },
        { type: "text", text: "text C" },
      ],
    });
    expect(res).toEqual({ stopReason: "end_turn" });

    // 找到携带本轮输入的主推理请求（带 tools；标题生成请求不带 tools 须排除），
    // 断言 user 消息 content parts 的交错顺序
    const req = providerRequests.find(
      (r) => toolNamesOf(r).length > 0 && latestUserText(r).includes("text A"),
    );
    expect(req).toBeDefined();
    const userMsg = messagesOf(req as RecordedProviderRequest)
      .filter((m) => m.role === "user")
      .at(-1);
    expect(userMsg).toBeDefined();
    // 多 part 时 openai-compatible 序列化为数组；逐 part 断言类型与顺序
    const content = userMsg?.content;
    expect(Array.isArray(content)).toBe(true);
    const parts = content as { type?: string; text?: string; image_url?: { url?: string } }[];
    const shape = parts.map((p) => {
      if (p.type === "text") return `text:${p.text ?? ""}`;
      if (p.type === "image_url") return "image";
      return `other:${String(p.type)}`;
    });
    expect(shape).toEqual(["text:text A", "image", "text:text B", "image", "text:text C"]);
    // 图片内容指纹：data URL 携带 PNG base64
    const imageUrls = parts
      .filter((p) => p.type === "image_url")
      .map((p) => p.image_url?.url ?? "");
    expect(imageUrls.length).toBe(2);
    for (const url of imageUrls) {
      expect(url.startsWith("data:image/png;base64,")).toBe(true);
      expect(url).toContain(PNG_B64);
    }

    child.closeStdin();
    expect((await child.exit).code).toBe(0);
    assertAllStdoutLinesValidJsonRpc(child.stdoutLines);
  }, 60_000);

  it("附件错误与边界：不支持模型/坏 base64/非图片二进制明确拒绝且不提交残缺，两会话隔离", async () => {
    const PNG_B64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
    const ws = makeTempDir("nctrn-acp-att-err-");
    // vision-model 支持图片；plain 默认不支持
    const child = spawnAcpCli({
      modelsConfig: {
        "e2e-model": { contextWindow: 128_000, maxOutputTokens: 4096 },
        "vision-model": {
          contextWindow: 128_000,
          maxOutputTokens: 4096,
          capabilities: { imageInput: true },
        },
      },
    });
    providerHandler = () => ({ textParts: ["att-reply"] });
    await child.request("initialize", { protocolVersion: 1 });

    // ══ 会话一：默认 e2e-model 不支持图片 → image_input_unsupported，不提交残缺 ══
    const s1 = await child.request<{ sessionId: string }>("session/new", {
      cwd: ws,
      mcpServers: [],
    });
    await child.request("session/set_config_option", {
      sessionId: s1.sessionId,
      configId: "model",
      value: "scripted/e2e-model",
    });
    providerRequests.length = 0;
    await expect(
      child.request("session/prompt", {
        sessionId: s1.sessionId,
        prompt: [
          { type: "text", text: "带图" },
          { type: "image", data: PNG_B64, mimeType: "image/png" },
        ],
      }),
    ).rejects.toMatchObject({
      code: -32602,
      data: expect.objectContaining({ code: "image_input_unsupported" }),
    });
    // 部分失败不提交：未发出任何带 tools 的主推理请求
    expect(providerRequests.filter((r) => toolNamesOf(r).length > 0).length).toBe(0);

    // 坏 base64 / 空图片 / 非图片二进制资源：均 -32602 且不提交
    await expect(
      child.request("session/prompt", {
        sessionId: s1.sessionId,
        prompt: [{ type: "image", data: "", mimeType: "image/png" }],
      }),
    ).rejects.toMatchObject({ code: -32602 });
    await expect(
      child.request("session/prompt", {
        sessionId: s1.sessionId,
        prompt: [
          {
            type: "resource",
            resource: { uri: "file:///a.bin", blob: "AAAA", mimeType: "application/octet-stream" },
          },
        ],
      }),
    ).rejects.toMatchObject({ code: -32602 });
    await expect(
      child.request("session/prompt", {
        sessionId: s1.sessionId,
        prompt: [{ type: "audio", data: "AAAA", mimeType: "audio/wav" }],
      }),
    ).rejects.toMatchObject({ code: -32602 });

    // ══ 会话二：vision-model 支持图片 → 内嵌文本资源保序进入请求 ══
    const s2 = await child.request<{ sessionId: string }>("session/new", {
      cwd: ws,
      mcpServers: [],
    });
    await child.request("session/set_config_option", {
      sessionId: s2.sessionId,
      configId: "model",
      value: "scripted/vision-model",
    });
    providerRequests.length = 0;
    const r2 = await child.request<{ stopReason: string }>("session/prompt", {
      sessionId: s2.sessionId,
      prompt: [
        { type: "text", text: "EMBED-START" },
        {
          type: "resource",
          resource: {
            uri: "file:///src/snippet.ts",
            text: "SNIPPET-BODY-42",
            mimeType: "text/x-typescript",
          },
        },
        { type: "text", text: "EMBED-END" },
      ],
    });
    expect(r2).toEqual({ stopReason: "end_turn" });
    const embedReq = providerRequests.find(
      (r) => toolNamesOf(r).length > 0 && latestUserText(r).includes("EMBED-START"),
    );
    expect(embedReq).toBeDefined();
    const embedUser = messagesOf(embedReq as RecordedProviderRequest)
      .filter((m) => m.role === "user")
      .at(-1);
    const embedText = messageText(embedUser?.content);
    // 内嵌文本资源快照进入请求（保序：START 在 snippet 前、END 在后）
    expect(embedText).toContain("SNIPPET-BODY-42");
    expect(embedText.indexOf("EMBED-START")).toBeLessThan(embedText.indexOf("SNIPPET-BODY-42"));
    expect(embedText.indexOf("SNIPPET-BODY-42")).toBeLessThan(embedText.indexOf("EMBED-END"));

    // ══ 两会话隔离：会话一（e2e-model）仍不支持图片，不受会话二切模型影响 ══
    providerRequests.length = 0;
    await expect(
      child.request("session/prompt", {
        sessionId: s1.sessionId,
        prompt: [
          { type: "text", text: "s1-again" },
          { type: "image", data: PNG_B64, mimeType: "image/png" },
        ],
      }),
    ).rejects.toMatchObject({
      data: expect.objectContaining({ code: "image_input_unsupported" }),
    });
    expect(providerRequests.filter((r) => toolNamesOf(r).length > 0).length).toBe(0);
    // 会话二纯文本下一轮正常（会话隔离互不干扰）
    const r2b = await child.request<{ stopReason: string }>("session/prompt", {
      sessionId: s2.sessionId,
      prompt: [{ type: "text", text: "s2-plain-next" }],
    });
    expect(r2b).toEqual({ stopReason: "end_turn" });

    child.closeStdin();
    expect((await child.exit).code).toBe(0);
    assertAllStdoutLinesValidJsonRpc(child.stdoutLines);
  }, 60_000);

  it("执行进度与命令发现：真实 stdio 长任务核对 plan/usage/commands 顺序与归属", async () => {
    const ws = makeTempDir("nctrn-acp-progress-");
    const child = spawnAcpCli({});
    // 可控长任务：第一轮调用 todo_write，第二轮回复完成。
    providerHandler = (req) => {
      const toolOut = latestToolMessage(req);
      const user = latestUserText(req);
      if (user.includes("track-work") && toolOut === undefined) {
        return {
          toolCalls: [
            {
              id: "call_todo_1",
              name: "todo_write",
              arguments: {
                items: [
                  { text: "设计", status: "completed" },
                  { text: "实现", status: "in_progress" },
                  { text: "验证", status: "pending" },
                ],
              },
            },
          ],
        };
      }
      return { textParts: ["work done"] };
    };
    // plan/usage 进度事件需声明能力：plan 是 UNSTABLE 能力，须显式声明才发送
    await child.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { plan: {}, session: { compaction: {} } },
    });
    const { sessionId } = await child.request<{ sessionId: string }>("session/new", {
      cwd: ws,
      mcpServers: [],
    });

    // 命令发现：session/new 后立即发布，归属本 session，只含可工作的 /compact
    const commandsUpdate = child.updates.find(
      (u) => u.sessionId === sessionId && u.update.sessionUpdate === "available_commands_update",
    );
    expect(commandsUpdate).toBeDefined();
    const cmds =
      (commandsUpdate?.update as { availableCommands?: { name: string }[] }).availableCommands ??
      [];
    expect(cmds.map((c) => c.name)).toContain("compact");
    expect(cmds.map((c) => c.name)).not.toContain("model");

    const res = await child.request<{ stopReason: string }>("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "请 track-work" }],
    });
    expect(res.stopReason).toBe("end_turn");

    // plan 更新：完整清单替换，归属本 session，状态逐项映射
    const planUpdates = child.updates.filter(
      (u) => u.sessionId === sessionId && u.update.sessionUpdate === "plan",
    );
    expect(planUpdates.length).toBeGreaterThanOrEqual(1);
    const entries =
      (planUpdates[0]?.update as { entries?: { content: string; status: string }[] }).entries ?? [];
    expect(entries.map((e) => [e.content, e.status])).toEqual([
      ["设计", "completed"],
      ["实现", "in_progress"],
      ["验证", "pending"],
    ]);

    // usage_update：turn 结束后发布，归属本 session，used/size 为真实水位
    const usageUpdates = child.updates.filter(
      (u) => u.sessionId === sessionId && u.update.sessionUpdate === "usage_update",
    );
    expect(usageUpdates.length).toBeGreaterThanOrEqual(1);
    const usage = usageUpdates[0]?.update as unknown as {
      used: number;
      size: number;
      _meta?: { inputTokens?: number; outputTokens?: number };
    };
    expect(usage.used).toBeGreaterThanOrEqual(0);
    expect(usage.size).toBeGreaterThan(0);
    expect(usage.used).toBeLessThanOrEqual(usage.size);
    // 合成 provider 返回非零 usage（SSE include_usage 每次推理 1234/56）——核实 turn.completed.usage
    // 非零并累计进 usage_update._meta（端到端链路灯芯：provider usage → Core turn → ACP update）。
    // 本轮含两次推理（todo_write 工具轮 + 工具结果后的完成轮），每次 1234/56，累计 2468/112。
    // 关键断言：inputTokens 非零且为每次用量的整数倍——证明 usage 字段真实流入而非恒 0。
    expect(usage._meta?.inputTokens).toBeGreaterThan(0);
    expect((usage._meta?.inputTokens ?? 0) % 1234).toBe(0);
    expect(usage._meta?.outputTokens).toBeGreaterThan(0);
    expect((usage._meta?.outputTokens ?? 0) % 56).toBe(0);

    // 事件顺序与归属：available_commands 早于 plan，plan 早于 usage（turn 结束才发）。
    // 全部归属同一 sessionId。
    const order = child.updates
      .filter((u) => u.sessionId === sessionId)
      .map((u) => u.update.sessionUpdate);
    const cmdIdx = order.indexOf("available_commands_update");
    const planIdx = order.indexOf("plan");
    const usageIdx = order.indexOf("usage_update");
    expect(cmdIdx).toBeGreaterThanOrEqual(0);
    expect(planIdx).toBeGreaterThan(cmdIdx);
    expect(usageIdx).toBeGreaterThan(planIdx);

    child.closeStdin();
    expect((await child.exit).code).toBe(0);
    assertAllStdoutLinesValidJsonRpc(child.stdoutLines);
  }, 60_000);

  it("/compact 命令真实 stdio：压缩配对 compaction_update 且不进入模型推理", async () => {
    const ws = makeTempDir("nctrn-acp-compact-");
    const child = spawnAcpCli({});
    // 所有请求（含压缩的摘要请求）都返回文本——压缩需要模型完成摘要。
    providerHandler = () => ({ textParts: ["reply text for compaction boundary"] });
    // compaction 是 UNSTABLE 能力，须显式声明才发送 compaction_update
    await child.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { session: { compaction: {} } },
    });
    const { sessionId } = await child.request<{ sessionId: string }>("session/new", {
      cwd: ws,
      mcpServers: [],
    });
    // 先跑一轮产生历史
    const r1 = await child.request<{ stopReason: string }>("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "start some work" }],
    });
    expect(r1.stopReason).toBe("end_turn");
    expect(
      child.updates.filter(
        (u) => u.sessionId === sessionId && u.update.sessionUpdate === "compaction_update",
      ).length,
    ).toBe(0);
    const requestsBeforeCompact = providerRequests.length;

    // 发 /compact 命令（Paseo toAcpPrompt 形式）
    providerRequests.length = 0;
    const r2 = await child.request<{ stopReason: string }>("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "/compact" }],
    });
    expect(r2.stopReason).toBe("end_turn");
    const compactionUpdates = child.updates
      .filter((u) => u.sessionId === sessionId && u.update.sessionUpdate === "compaction_update")
      .map((u) => u.update as unknown as { compactionId: string; status: string });
    const started = compactionUpdates.find((u) => u.status === "in_progress");
    const terminal = compactionUpdates.find(
      (u) => u.status === "completed" || u.status === "cancelled" || u.status === "failed",
    );
    // 压缩开始必有终态配对（completed 或 cancelled），同一 compactionId
    expect(started).toBeDefined();
    expect(terminal).toBeDefined();
    expect(terminal?.compactionId).toBe(started?.compactionId);
    // "/compact" 不作为用户输入进入新一轮推理
    const sawCompactAsUserInput = providerRequests.some((r) =>
      latestUserText(r).trim().startsWith("/compact"),
    );
    expect(sawCompactAsUserInput).toBe(false);
    void requestsBeforeCompact;

    child.closeStdin();
    expect((await child.exit).code).toBe(0);
    assertAllStdoutLinesValidJsonRpc(child.stdoutLines);
  }, 60_000);

  it("/compact 真实 stdio 在途压缩可被 session/cancel 中断：取消发生在结束前，宿主无残留进行中", async () => {
    const ws = makeTempDir("nctrn-acp-compact-cancel-");
    const child = spawnAcpCli({});
    // 可控在途压缩：摘要请求（user 块含「压缩为摘要」）返回一个永不 resolve 的 Promise，
    // provider SSE 响应被无限挂起——压缩保持在途。普通对话请求立即返回。
    const summaryGate = Promise.withResolvers<ProviderReply>();
    let summaryRequested = false;
    providerHandler = (req) => {
      const user = latestUserText(req);
      if (user.includes("压缩为摘要")) {
        summaryRequested = true;
        return summaryGate.promise;
      }
      return { textParts: ["normal reply"] };
    };
    await child.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { session: { compaction: {} } },
    });
    const { sessionId } = await child.request<{ sessionId: string }>("session/new", {
      cwd: ws,
      mcpServers: [],
    });
    // 先跑一轮产生历史（压缩需要可行边界）
    const r1 = await child.request<{ stopReason: string }>("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "start some work" }],
    });
    expect(r1.stopReason).toBe("end_turn");

    // 发 /compact——摘要请求挂起，压缩在途
    const compactPromise = child.request<{ stopReason: string }>("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "/compact" }],
    });
    // 等压缩开始（compaction_update in_progress 投递到 wire）
    await vi.waitFor(
      () => {
        const started = child.updates.some(
          (u) =>
            u.sessionId === sessionId &&
            u.update.sessionUpdate === "compaction_update" &&
            (u.update as { status?: string }).status === "in_progress",
        );
        if (!started) throw new Error("compaction not yet started on wire");
      },
      { timeout: 8000 },
    );
    // 确认摘要请求确实发出（压缩真的在途，而非尚未开始）
    await vi.waitFor(
      () => {
        if (!summaryRequested) throw new Error("summary request not yet sent");
      },
      { timeout: 8000 },
    );

    // 在压缩结束前发 session/cancel（通知）——中断在途压缩
    child.notify("session/cancel", { sessionId });
    // compact 的 prompt 请求按 cancelled 收尾：取消发生在压缩结束前
    // （若取消无效，压缩会无限挂起，此 Promise 永不 resolve，测试超时失败）
    const res = await compactPromise;
    expect(res.stopReason).toBe("cancelled");
    // 清理挂起的 provider 请求，避免资源泄漏
    summaryGate.resolve({ textParts: ["summary-after-cancel"] });

    // 宿主无残留进行中状态：in_progress 必须有同 compactionId 的 cancelled 终态配对
    await vi.waitFor(
      () => {
        const ups = child.updates
          .filter((u) => u.sessionId === sessionId && u.update.sessionUpdate === "compaction_update")
          .map((u) => u.update as unknown as { compactionId: string; status: string });
        if (!ups.some((u) => u.status === "cancelled")) {
          throw new Error("cancelled terminal not yet on wire");
        }
      },
      { timeout: 8000 },
    );
    const ups = child.updates
      .filter((u) => u.sessionId === sessionId && u.update.sessionUpdate === "compaction_update")
      .map((u) => u.update as unknown as { compactionId: string; status: string });
    const started = ups.find((u) => u.status === "in_progress");
    const cancelled = ups.find((u) => u.status === "cancelled");
    expect(started).toBeDefined();
    expect(cancelled).toBeDefined();
    expect(cancelled?.compactionId).toBe(started?.compactionId);
    // 压缩被中断不写 context.compacted——无 completed
    expect(ups.some((u) => u.status === "completed")).toBe(false);

    // 下一轮正常使用：会话未被取消的压缩破坏
    const next = await child.request<{ stopReason: string }>("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "continue after cancel" }],
    });
    expect(next.stopReason).toBe("end_turn");

    child.closeStdin();
    expect((await child.exit).code).toBe(0);
    assertAllStdoutLinesValidJsonRpc(child.stdoutLines);
  }, 60_000);
});

describe("session/load 真实进程 A/B 交接（ADR-0127 第二阶段）", () => {
  it("进程 A 建会话跑工具轮后退出，进程 B 恢复同 ID：历史恰一份、模型记得决定、新审批走新连接", async () => {
    const ws = makeTempDir("nctrn-acp-ab-");
    const isoHome = makeTempDir("nctrn-acp-abhome-");
    const marker = "AB-MARKER-QUASAR-42";

    // ══ 进程 A：建会话，一轮带工具调用的对话，正常退出 ══
    const childA = spawnAcpCli({ isoHome });
    providerHandler = (req) => {
      const user = latestUserText(req);
      const toolOut = latestToolMessage(req);
      if (toolOut !== undefined) {
        return { textParts: [`the decision is ${marker}`] };
      }
      if (user.includes("remember")) {
        return {
          toolCalls: [{ id: "call_read_a", name: "read", arguments: { path: "note.txt" } }],
        };
      }
      return { textParts: ["a-turn-done"] };
    };
    // 工作区里放一份可读文件，read 工具才有结果
    writeFileSync(path.join(ws, "note.txt"), "synthetic decision log");

    await childA.request("initialize", { protocolVersion: 1 });
    expect(
      (
        await childA.request<{ agentCapabilities: { loadSession: boolean } }>("initialize", {
          protocolVersion: 1,
        })
      ).agentCapabilities.loadSession,
    ).toBe(true);

    const created = await childA.request<{ sessionId: string; configOptions?: unknown }>(
      "session/new",
      { cwd: ws, mcpServers: [] },
    );
    const sessionId = created.sessionId;

    expect(
      await childA.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: "remember this" }],
      }),
    ).toEqual({ stopReason: "end_turn" });

    // 确认工具实际执行过（read 不产生权限请求——read 在默认预设下是只读 allow? 但
    // 至少应观察到 tool_call 更新帧）
    const toolFramesA = childA.updates.filter(
      (u) =>
        u.update.sessionUpdate === "tool_call" || u.update.sessionUpdate === "tool_call_update",
    );
    expect(toolFramesA.length).toBeGreaterThan(0);

    // A 进程退出（正常 EOF——模拟宿主关闭旧 CLI）
    childA.closeStdin();
    expect((await childA.exit).code).toBe(0);
    assertAllStdoutLinesValidJsonRpc(childA.stdoutLines);
    // 锁文件已释放
    expect(findLockFiles(path.join(childA.nocturneHome, "sessions"))).toEqual([]);

    // ══ 进程 B：同一 NOCTURNE_HOME，加载同一 sessionId ══
    const childB = spawnAcpCli({ isoHome });
    const capturedRequests: RecordedProviderRequest[] = [];
    providerHandler = (req) => {
      capturedRequests.push(req);
      return { textParts: ["b-turn-done"] };
    };
    await childB.request("initialize", { protocolVersion: 1 });

    // ══ 错误 cwd 拒绝（在成功恢复之前验证——此时会话未被本连接管理）══
    const otherWs = makeTempDir("nctrn-acp-abother-");
    await expect(
      childB.request("session/load", { sessionId, cwd: otherWs, mcpServers: [] }),
    ).rejects.toMatchObject({ code: -32602 });

    const loadRes = await childB.request<{ configOptions?: unknown }>("session/load", {
      sessionId,
      cwd: ws,
      mcpServers: [],
    });
    expect(loadRes.configOptions).toBeDefined();

    // 历史回放帧：恰一份用户消息、助手决定、终态工具行
    const replay = childB.updates;
    const userChunks = replay.filter((u) => u.update.sessionUpdate === "user_message_chunk");
    expect(userChunks.length).toBe(1);
    expect(
      (userChunks[0]?.update as { content?: { text?: string } }).content?.text ?? "",
    ).toContain("remember this");

    const agentText = replay
      .filter((u) => u.update.sessionUpdate === "agent_message_chunk")
      .map((u) => (u.update as { content?: { text?: string } }).content?.text ?? "")
      .join("");
    expect(agentText).toContain(marker);

    const replayTools = replay.filter((u) => u.update.sessionUpdate === "tool_call");
    expect(replayTools.length).toBeGreaterThan(0);
    for (const t of replayTools) {
      expect(["completed", "failed"]).toContain((t.update as { status?: string }).status);
    }
    // 回放不含权限请求
    expect(childB.permissions.length).toBe(0);

    // ══ 新轮：模型上下文含历史决定（恰一份）══
    expect(
      await childB.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: "what was decided?" }],
      }),
    ).toEqual({ stopReason: "end_turn" });

    const joined = capturedRequests.map((r) => r.rawBody).join("\n");
    const occurrences = joined.split(marker).length - 1;
    expect(occurrences).toBe(1);

    // ══ 重复 load（已在管）拒绝 ══
    await expect(
      childB.request("session/load", { sessionId, cwd: ws, mcpServers: [] }),
    ).rejects.toMatchObject({ code: -32600 });

    childB.closeStdin();
    expect((await childB.exit).code).toBe(0);
    assertAllStdoutLinesValidJsonRpc(childB.stdoutLines);
    expect(findLockFiles(path.join(childB.nocturneHome, "sessions"))).toEqual([]);
  }, 90_000);

  it("非 ACP 会话与不存在 ID 在真实进程间拒绝恢复", async () => {
    const ws = makeTempDir("nctrn-acp-abneg-");
    const isoHome = makeTempDir("nctrn-acp-abneghome-");
    const child = spawnAcpCli({ isoHome });
    providerHandler = () => ({ textParts: ["noop"] });
    await child.request("initialize", { protocolVersion: 1 });

    await expect(
      child.request("session/load", {
        sessionId: "202601010000-deadbeef",
        cwd: ws,
        mcpServers: [],
      }),
    ).rejects.toMatchObject({ code: -32002 });

    child.closeStdin();
    expect((await child.exit).code).toBe(0);
  }, 60_000);

  it("A/B 用不同宿主工具配置：恢复后 B 工具生效、A 不再提供、审批由 B 接收", async () => {
    const ws = makeTempDir("nctrn-acp-abmcp-");
    const isoHome = makeTempDir("nctrn-acp-abmcphome-");
    const logDir = makeTempDir("nctrn-acp-abmcplog-");
    const callLogAlpha = path.join(logDir, "calls-alpha.jsonl");
    const callLogBeta = path.join(logDir, "calls-beta.jsonl");
    const secretAlpha = "alpha-secret-aaaa";
    const secretBeta = "beta-secret-bbbb";

    // ══ 进程 A：注入宿主 MCP "orch"（SESSION_TAG=alpha）建会话 ══
    const childA = spawnAcpCli({ isoHome });
    providerHandler = (req) => {
      const user = latestUserText(req);
      if (user.includes("setup-turn")) {
        return { textParts: ["alpha-turn-done"] };
      }
      return { textParts: ["alpha-fallback"] };
    };
    await childA.request("initialize", { protocolVersion: 1 });
    const created = await childA.request<{ sessionId: string }>("session/new", {
      cwd: ws,
      mcpServers: [
        {
          name: "orch",
          command: process.execPath,
          args: [fakeHostMcp],
          env: [
            { name: "SESSION_TAG", value: "alpha" },
            { name: "ORCH_API_TOKEN", value: secretAlpha },
            { name: "NOCTURNE_TEST_CALL_LOG", value: callLogAlpha },
          ],
        },
      ],
    });
    const sessionId = created.sessionId;
    expect(
      await childA.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: "setup-turn" }],
      }),
    ).toEqual({ stopReason: "end_turn" });
    // A 的连接里有 alpha 宿主工具可用（确认 A 配置确实生效，作为对照基线）；
    // 取最后一个带工具表的请求（排除无 tools 的标题生成等内部 purpose 调用）
    const alphaBaseline = [...providerRequests].reverse().find((r) => toolNamesOf(r).length > 0);
    if (alphaBaseline === undefined) throw new Error("alpha turn produced no tool-bearing request");
    expect(toolNamesOf(alphaBaseline)).toContain("mcp__orch__dispatch");

    childA.closeStdin();
    expect((await childA.exit).code).toBe(0);
    assertAllStdoutLinesValidJsonRpc(childA.stdoutLines);

    // ══ 进程 B：用完全不同的宿主 MCP "betaorch"（SESSION_TAG=beta）恢复同一会话 ══
    const childB = spawnAcpCli({
      isoHome,
      onPermission: async () => "allow_once",
    });
    const capturedB: RecordedProviderRequest[] = [];
    providerHandler = (req) => {
      capturedB.push(req);
      const user = latestUserText(req);
      const toolOut = latestToolMessage(req);
      if (toolOut !== undefined) {
        return { textParts: [`beta-result:${toolOut}`] };
      }
      if (user.includes("dispatch-beta")) {
        return {
          toolCalls: [
            {
              id: `call_beta_${randomUUID().slice(0, 6)}`,
              name: "mcp__betaorch__dispatch",
              arguments: { task: user },
            },
          ],
        };
      }
      return { textParts: ["beta-turn-done"] };
    };
    await childB.request("initialize", { protocolVersion: 1 });
    await childB.request("session/load", {
      sessionId,
      cwd: ws,
      mcpServers: [
        {
          name: "betaorch",
          command: process.execPath,
          args: [fakeHostMcp],
          env: [
            { name: "SESSION_TAG", value: "beta" },
            { name: "ORCH_API_TOKEN", value: secretBeta },
            { name: "NOCTURNE_TEST_CALL_LOG", value: callLogBeta },
          ],
        },
      ],
    });

    // 恢复后新轮：模型收到的工具表含 B 的 betaorch、不再含 A 的 orch
    expect(
      await childB.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: "dispatch-beta run it" }],
      }),
    ).toEqual({ stopReason: "end_turn" });

    const firstTurnReq = capturedB.find((r) => latestUserText(r).includes("dispatch-beta"));
    if (firstTurnReq === undefined) throw new Error("dispatch-beta turn request not captured");
    const tools = toolNamesOf(firstTurnReq);
    expect(tools).toContain("mcp__betaorch__dispatch");
    expect(tools).not.toContain("mcp__orch__dispatch");

    // B 的宿主工具被调用：审批转发到 B 连接（当前宿主），批准后由 B 实例执行
    expect(childB.permissions.length).toBeGreaterThan(0);
    expect(childB.permissions[0]?.toolCall).toMatchObject({ name: "mcp__betaorch__dispatch" });
    // beta 实例的调用日志写入（带 beta 凭据），alpha 实例从未被执行
    expect(existsSync(callLogBeta)).toBe(true);
    const betaCalls = readFileSync(callLogBeta, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(betaCalls[0]).toMatchObject({ tool: "dispatch", tag: "beta", hasToken: true });
    expect(existsSync(callLogAlpha)).toBe(false);

    childB.closeStdin();
    expect((await childB.exit).code).toBe(0);
    assertAllStdoutLinesValidJsonRpc(childB.stdoutLines);
    expect(findLockFiles(path.join(childB.nocturneHome, "sessions"))).toEqual([]);
  }, 90_000);
});

describe("ask_user 真实 stdio 客户端（ADR-0127 第三阶段）", () => {
  it("声明 elicitation.form：客户端接到 elicitation/create 并以 accept 回应，provider 后续请求携带所选答案", async () => {
    const ws = makeTempDir("nctrn-acp-ask-eli-");
    const elicitationRequests: Record<string, unknown>[] = [];
    const child = spawnAcpCli({
      elicitations: elicitationRequests,
      onElicitation: async () => ({ action: "accept", content: { q1: "PostgreSQL" } }),
    });

    const captured: RecordedProviderRequest[] = [];
    providerHandler = (req) => {
      captured.push(req);
      const toolOut = latestToolMessage(req);
      if (toolOut !== undefined) {
        return { textParts: [`chosen:${toolOut.slice(0, 80)}`] };
      }
      return {
        toolCalls: [
          {
            id: "call_ask_1",
            name: "ask_user",
            arguments: {
              questions: [
                {
                  question: "用哪个数据库？",
                  header: "选型",
                  options: [{ label: "PostgreSQL", description: "推荐" }, { label: "SQLite" }],
                },
              ],
            },
          },
        ],
      };
    };

    await child.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { elicitation: { form: {} } },
    });
    const { sessionId } = await child.request<{ sessionId: string }>("session/new", {
      cwd: ws,
      mcpServers: [],
    });

    const res = await child.request<{ stopReason: string }>("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "ask" }],
    });
    expect(res.stopReason).toBe("end_turn");
    // elicitation 确实被发起
    expect(elicitationRequests.length).toBe(1);
    const params = elicitationRequests[0] as {
      sessionId?: string;
      message?: string;
      requestedSchema?: { properties?: Record<string, unknown> };
    };
    expect(params.sessionId).toBe(sessionId);
    expect(params.message).toContain("用哪个数据库？");
    expect(params.requestedSchema?.properties?.q1).toMatchObject({ type: "string" });
    // provider 第二轮（tool 消息回写）所看到的工具结果包含所选 label
    const secondReq = captured.find((r) => latestToolMessage(r) !== undefined);
    expect(secondReq).toBeDefined();
    const toolText = latestToolMessage(secondReq ?? ({} as RecordedProviderRequest));
    expect(toolText).toContain("PostgreSQL");
    expect(toolText).not.toContain("用户拒绝回答");

    child.closeStdin();
    expect((await child.exit).code).toBe(0);
    assertAllStdoutLinesValidJsonRpc(child.stdoutLines);
  }, 60_000);

  it("elicitation 响应 decline：provider 看到「用户拒绝回答」；响应 cancel：stopReason cancelled", async () => {
    const ws = makeTempDir("nctrn-acp-ask-decline-");
    const child = spawnAcpCli({
      onElicitation: async () => ({ action: "decline" }),
    });
    const captured: RecordedProviderRequest[] = [];
    providerHandler = (req) => {
      captured.push(req);
      const toolOut = latestToolMessage(req);
      if (toolOut !== undefined) return { textParts: ["ack"] };
      return {
        toolCalls: [
          {
            id: "call_ask_d",
            name: "ask_user",
            arguments: {
              questions: [{ question: "q", options: [{ label: "A" }, { label: "B" }] }],
            },
          },
        ],
      };
    };
    await child.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { elicitation: { form: {} } },
    });
    const { sessionId } = await child.request<{ sessionId: string }>("session/new", {
      cwd: ws,
      mcpServers: [],
    });

    const r1 = await child.request<{ stopReason: string }>("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "ask decline" }],
    });
    expect(r1.stopReason).toBe("end_turn");
    const declineReq = captured.find((r) => latestToolMessage(r) !== undefined);
    expect(latestToolMessage(declineReq ?? ({} as RecordedProviderRequest))).toContain(
      "用户拒绝回答",
    );

    // 第二个会话改为 cancel：本轮以 cancelled 收尾
    const child2 = spawnAcpCli({
      onElicitation: async () => ({ action: "cancel" }),
    });
    providerHandler = (req) => {
      captured.push(req);
      const toolOut = latestToolMessage(req);
      if (toolOut !== undefined) return { textParts: ["ack"] };
      return {
        toolCalls: [
          {
            id: "call_ask_c",
            name: "ask_user",
            arguments: { questions: [{ question: "q2" }] },
          },
        ],
      };
    };
    await child2.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { elicitation: { form: {} } },
    });
    const { sessionId: sid2 } = await child2.request<{ sessionId: string }>("session/new", {
      cwd: ws,
      mcpServers: [],
    });
    const r2 = await child2.request<{ stopReason: string }>("session/prompt", {
      sessionId: sid2,
      prompt: [{ type: "text", text: "ask cancel" }],
    });
    expect(r2.stopReason).toBe("cancelled");

    child.closeStdin();
    child2.closeStdin();
    await child.exit;
    await child2.exit;
  }, 90_000);

  it("未声明 elicitation（Paseo 风格 {}）：问题文本展示、handoff_suspended、下一轮由用户答案继续", async () => {
    const ws = makeTempDir("nctrn-acp-ask-text-");
    const child = spawnAcpCli({});
    const captured: RecordedProviderRequest[] = [];
    providerHandler = (req) => {
      captured.push(req);
      const toolOut = latestToolMessage(req);
      if (toolOut !== undefined) {
        // 下一轮（用户答复后）：模型应看到 handoff_suspended 而非「拒绝回答」
        return { textParts: [`after-handoff:${toolOut.slice(0, 60)}`] };
      }
      return {
        toolCalls: [
          {
            id: "call_ask_t",
            name: "ask_user",
            arguments: {
              questions: [
                {
                  question: "选择策略？",
                  options: [{ label: "策略A" }, { label: "策略B" }],
                },
              ],
            },
          },
        ],
      };
    };
    await child.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
    });
    const { sessionId } = await child.request<{ sessionId: string }>("session/new", {
      cwd: ws,
      mcpServers: [],
    });
    const r1 = await child.request<{ stopReason: string }>("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "ask text" }],
    });
    expect(r1.stopReason).toBe("end_turn");
    // 用户能看到问题（agent_message_chunk 含问题与选项）
    const chunks = child.updates.filter(
      (u) =>
        u.update.sessionUpdate === "agent_message_chunk" &&
        u.update.content !== undefined &&
        typeof u.update.content === "object" &&
        "text" in u.update.content &&
        typeof (u.update.content as { text?: unknown }).text === "string" &&
        ((u.update.content as { text?: string }).text ?? "").includes("选择策略？"),
    );
    expect(chunks.length).toBeGreaterThan(0);
    // ADR-0127 第三阶段返工：handoff_suspended 后本轮有序收尾、不再发起下一次推理——
    // 此时捕获到的只有初始这一次推理请求，ask_user 之后没有第二次推理。
    expect(captured.length).toBe(1);

    // 用户答复（下一轮普通消息）——模型按真实回答继续，
    // 在请求中看到 handoff_suspended 文案而非「用户拒绝回答」。
    const r2 = await child.request<{ stopReason: string }>("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "策略A" }],
    });
    expect(r2.stopReason).toBe("end_turn");
    // 第二轮（用户答复后）的请求里应携带上轮 ask_user 的 handoff 结果——
    // 判定：请求消息中任一 tool 消息含 handoff_suspended 文案（末条是用户答复，不是 tool）。
    const secondReq = captured.find((r) =>
      messagesOf(r).some(
        (m) => m.role === "tool" && messageText(m.content).includes("宿主已把问题展示给用户"),
      ),
    );
    expect(secondReq).toBeDefined();
    const toolText = messagesOf(secondReq as RecordedProviderRequest)
      .filter((m) => m.role === "tool")
      .map((m) => messageText(m.content))
      .join("\n");
    expect(toolText).not.toContain("用户拒绝回答");
    expect(toolText).toContain("宿主已把问题展示给用户");

    child.closeStdin();
    expect((await child.exit).code).toBe(0);
    assertAllStdoutLinesValidJsonRpc(child.stdoutLines);
  }, 60_000);
});
