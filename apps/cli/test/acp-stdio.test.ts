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
import { execSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
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
let providerHandler: (req: RecordedProviderRequest) => ProviderReply = () => ({
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
  userMcpJson?: Record<string, unknown>;
  extraArgs?: string[];
  onPermission?: (
    req: AcpPermissionRequest,
  ) => Promise<"allow_once" | "reject_once" | "cancel" | "hang">;
}): SpawnedAcp {
  const isoHome = makeTempDir("nctrn-acp-iso-");
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
              models: {
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
  execSync("pnpm build", { cwd: repoRoot, stdio: "pipe" });
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

      // 后台自动生成会话标题请求不带 tools，直接返回简短标题，不干扰测试脚本状态
      const reply =
        toolNamesOf(record).length === 0
          ? { textParts: ["acp-test-title"] }
          : providerHandler(record);
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
      } else {
        emit({ role: "assistant" });
        for (const part of reply.textParts ?? ["ok"]) {
          emit({ content: part });
        }
        emit({}, "stop");
      }
      res.end("data: [DONE]\n\n");
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
    expect(initUnconf.agentCapabilities.loadSession).toBe(false);
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
});
