/**
 * 自有插件 MCP 服务器端到端测试（ADR-0100 第 2 节）：
 * 夹具插件通过 `${NOCTURNE_NODE}` 启动最小 stdio MCP 服务器，
 * 在真实会话里调用工具并验证权限主体为 `mcp <server>/<tool>`。
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPlatform,
  createRuntime,
  FakeProvider,
  loadConfig,
  type Runtime,
  type RuntimeSession,
} from "@nocturne/core";
import { createProcessCleanup, removeTempDirs } from "../../../scripts/test/process-cleanup.mjs";
import { createMcpConnector } from "../src/connector.js";
import { pluginMcpCacheFileName } from "../src/plugin-cache.js";

const processes = createProcessCleanup();
const basePlatform = processes.platform(createPlatform());
const tmpRoots: string[] = [];
const openRuntimes: Runtime[] = [];
const openSessions: RuntimeSession[] = [];

afterEach(async () => {
  for (const s of openSessions.splice(0)) {
    await s.close().catch(() => undefined);
  }
  for (const rt of openRuntimes.splice(0)) {
    await rt.close().catch(() => undefined);
  }
  await processes.cleanup();
  await removeTempDirs(tmpRoots.splice(0));
});

const MINIMAL_STDIO_MCP_SERVER = `
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\\n");
}
rl.on("line", (line) => {
  if (!line.trim()) return;
  const req = JSON.parse(line);
  if (req.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: req.id,
      result: {
        protocolVersion: req.params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "fixture-echo", version: "0.1.0" },
      },
    });
  } else if (req.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: req.id,
      result: {
        tools: [
          {
            name: "ping",
            description: "echo message",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string" } },
              required: ["text"],
            },
            annotations: { readOnlyHint: true },
          },
        ],
      },
    });
  } else if (req.method === "tools/call") {
    const text = req.params?.arguments?.text ?? "";
    const root = process.env.FIXTURE_PLUGIN_ROOT ?? "";
    send({
      jsonrpc: "2.0",
      id: req.id,
      result: {
        content: [{ type: "text", text: "pong:" + text + "|root:" + (root.length > 0) }],
      },
    });
  } else if (req.id !== undefined) {
    send({ jsonrpc: "2.0", id: req.id, result: {} });
  }
});
`;

describe("插件 stdio MCP 服务器端到端", () => {
  it("用 ${NOCTURNE_NODE} 启动最小 stdio 服务器，调用工具且权限主体为 mcp <server>/<tool>", async () => {
    const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "nct-plugin-mcp-")));
    tmpRoots.push(root);
    const nocturneHome = path.join(root, "home");
    const codexHome = path.join(root, "codex");
    const claudeHome = path.join(root, "claude");
    const ws = path.join(root, "ws");
    const builtinDir = path.join(root, "builtin");
    const pluginDir = path.join(builtinDir, "echo-plugin");
    mkdirSync(path.join(pluginDir, ".nocturne-plugin"), { recursive: true });
    mkdirSync(nocturneHome, { recursive: true });
    mkdirSync(codexHome, { recursive: true });
    mkdirSync(claudeHome, { recursive: true });
    mkdirSync(ws, { recursive: true });

    writeFileSync(path.join(pluginDir, "server.mjs"), MINIMAL_STDIO_MCP_SERVER);
    writeFileSync(
      path.join(pluginDir, ".nocturne-plugin", "plugin.json"),
      JSON.stringify({
        name: "echo-plugin",
        version: "1.0.0",
        mcpServers: {
          echo: {
            command: "${NOCTURNE_NODE}",
            args: ["${PLUGIN_ROOT}/server.mjs"],
            env: { FIXTURE_PLUGIN_ROOT: "${PLUGIN_ROOT}" },
          },
        },
      }),
    );

    // 未配放行规则，交互会话触发 permission.requested，核对权限主体为 mcp echo/ping
    writeFileSync(
      path.join(nocturneHome, "config.json"),
      JSON.stringify({
        modelsDev: false,
        skills: { sources: { agents: false, claude: false } },
      }),
    );

    const plat = {
      ...basePlatform,
      homeDir: () => root,
      nocturneHome: () => nocturneHome,
    };
    const config = await loadConfig(plat, { nocturneHome });
    const provider = new FakeProvider({
      scripts: [
        [
          {
            type: "tool_call",
            toolCallId: "call-1",
            name: "mcp__echo__ping",
            input: { text: "hello" },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        [
          { type: "text_delta", text: "done" },
          { type: "finish", reason: "stop" },
        ],
      ],
    });
    const rt = await createRuntime({
      cwd: ws,
      sessionsDir: path.join(nocturneHome, "sessions"),
      config,
      interactive: true,
      mcp: createMcpConnector(),
      providers: [provider],
      builtinPluginsDir: builtinDir,
      plugins: { codexHome, claudeHome },
    });
    openRuntimes.push(rt);
    const s = await rt.createSession({ model: "fake/fake-model" });
    openSessions.push(s);

    const completed: { status?: unknown; modelContent?: unknown }[] = [];
    const requestedSubjects: { kind: string; target: string }[][] = [];
    s.subscribe((e) => {
      if (e.type === "permission.requested") {
        requestedSubjects.push(
          e.payload.subjects.map((sub) => ({ kind: sub.kind, target: sub.target })),
        );
        void s.respondPermission(e.payload.requestId, { decision: "allow" });
      }
      if (e.type === "tool.completed") {
        completed.push(e.payload as { status?: unknown; modelContent?: unknown });
      }
    });

    await s.submit({ text: "ping echo" });
    expect(completed).toHaveLength(1);
    expect(completed[0]?.status).toBe("ok");
    expect(String(completed[0]?.modelContent)).toContain("pong:hello|root:true");
    expect(requestedSubjects).toEqual([[{ kind: "mcp", target: "echo/ping" }]]);

    // 关闭插件后空闲会话的 MCP 服务器随之移除；再开启后恢复
    expect(s.mcpServers().map((m) => m.name)).toEqual(["echo"]);
    await rt.setPluginEnabled({ id: "nocturne:echo-plugin@builtin", enabled: false });
    expect(s.mcpServers().map((m) => m.name)).toEqual([]);
    await rt.setPluginEnabled({ id: "nocturne:echo-plugin@builtin", enabled: true });
    expect(s.mcpServers().map((m) => m.name)).toEqual(["echo"]);
  });
});

const DYNAMIC_STDIO_MCP_SERVER = `
import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const bootLog = process.env.FIXTURE_BOOT_LOG;
if (bootLog) appendFileSync(bootLog, "boot\\n");
const toolsFile = process.env.FIXTURE_TOOLS_FILE;
const serverName = process.env.FIXTURE_SERVER_NAME || "fixture-lazy";

function readTools() {
  return JSON.parse(readFileSync(toolsFile, "utf8"));
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\\n");
}
rl.on("line", (line) => {
  if (!line.trim()) return;
  const req = JSON.parse(line);
  if (req.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: req.id,
      result: {
        protocolVersion: req.params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: serverName, version: "1.0.0" },
      },
    });
  } else if (req.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: req.id,
      result: { tools: readTools() },
    });
  } else if (req.method === "tools/call") {
    const name = req.params?.name ?? "";
    const text = req.params?.arguments?.text ?? "";
    send({
      jsonrpc: "2.0",
      id: req.id,
      result: {
        content: [{ type: "text", text: serverName + ":" + name + ":" + text }],
      },
    });
  } else if (req.id !== undefined) {
    send({ jsonrpc: "2.0", id: req.id, result: {} });
  }
});
`;

function bootCount(bootLog: string): number {
  if (!existsSync(bootLog)) return 0;
  return readFileSync(bootLog, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim() === "boot").length;
}

const PING_TOOL = {
  name: "ping",
  description: "echo ping",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
  },
  annotations: { readOnlyHint: true },
};

const EXTRA_TOOL = {
  name: "extra",
  description: "extra tool",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
  },
  annotations: { readOnlyHint: false },
};

const OBSOLETE_TOOL = {
  name: "obsolete",
  description: "tool to be removed",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string" } },
  },
  annotations: { readOnlyHint: true },
};

async function createLazyEnv(options?: {
  version?: string;
  tools?: readonly Record<string, unknown>[];
  configMcpServers?: Record<string, Record<string, unknown>>;
}) {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "nct-plugin-lazy-")));
  tmpRoots.push(root);
  const nocturneHome = path.join(root, "home");
  const codexHome = path.join(root, "codex");
  const claudeHome = path.join(root, "claude");
  const ws = path.join(root, "ws");
  const builtinDir = path.join(root, "builtin");
  const pluginDir = path.join(builtinDir, "lazy-kit");
  mkdirSync(path.join(pluginDir, ".nocturne-plugin"), { recursive: true });
  mkdirSync(nocturneHome, { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(claudeHome, { recursive: true });
  mkdirSync(ws, { recursive: true });

  const bootLog = path.join(root, "plugin-boots.log");
  const toolsFile = path.join(root, "plugin-tools.json");
  writeFileSync(toolsFile, JSON.stringify(options?.tools ?? [PING_TOOL]));
  writeFileSync(path.join(pluginDir, "server.mjs"), DYNAMIC_STDIO_MCP_SERVER);
  writeFileSync(
    path.join(pluginDir, ".nocturne-plugin", "plugin.json"),
    JSON.stringify({
      name: "lazy-kit",
      version: options?.version ?? "1.0.0",
      mcpServers: {
        lazy: {
          command: "${NOCTURNE_NODE}",
          args: ["${PLUGIN_ROOT}/server.mjs"],
          env: {
            FIXTURE_BOOT_LOG: bootLog,
            FIXTURE_TOOLS_FILE: toolsFile,
            FIXTURE_SERVER_NAME: "fixture-lazy",
          },
        },
      },
    }),
  );

  writeFileSync(
    path.join(nocturneHome, "config.json"),
    JSON.stringify({
      modelsDev: false,
      skills: { sources: { agents: false, claude: false } },
      ...(options?.configMcpServers !== undefined
        ? { mcp: { servers: options.configMcpServers } }
        : {}),
    }),
  );

  const plat = {
    ...basePlatform,
    homeDir: () => root,
    nocturneHome: () => nocturneHome,
  };
  const cacheDir = path.join(nocturneHome, "plugins", "cache", "mcp-tools");
  const cacheFile = path.join(
    cacheDir,
    pluginMcpCacheFileName("nocturne:lazy-kit@builtin", "lazy"),
  );

  const openRuntime = async (scripts: ConstructorParameters<typeof FakeProvider>[0]["scripts"]) => {
    const config = await loadConfig(plat, { nocturneHome });
    const provider = new FakeProvider({ scripts });
    const rt = await createRuntime({
      cwd: ws,
      sessionsDir: path.join(nocturneHome, "sessions"),
      config,
      interactive: true,
      permissions: { autoApproveAsk: true },
      mcp: createMcpConnector(),
      providers: [provider],
      builtinPluginsDir: builtinDir,
      plugins: { codexHome, claudeHome },
    });
    openRuntimes.push(rt);
    return { rt, provider };
  };

  return {
    root,
    nocturneHome,
    codexHome,
    claudeHome,
    ws,
    builtinDir,
    pluginDir,
    bootLog,
    toolsFile,
    cacheDir,
    cacheFile,
    plat,
    openRuntime,
  };
}

describe("插件 MCP 按需启动与工具缓存（ADR-0100 修订第 4 节）", () => {
  it("缓存未命中时启动并写缓存；缓存命中时会话打开不启动进程、工具定义一致，首次调用才启动", async () => {
    const env = await createLazyEnv({ tools: [PING_TOOL, EXTRA_TOOL] });

    // 1) 首次会话：缓存未命中 → 启动服务器、写缓存、会话内保持 ready
    const run1 = await env.openRuntime([
      [
        { type: "text_delta", text: "ok1" },
        { type: "finish", reason: "stop" },
      ],
    ]);
    const s1 = await run1.rt.createSession({ model: "fake/fake-model" });
    openSessions.push(s1);
    await s1.submit({ text: "hello" });

    expect(bootCount(env.bootLog)).toBe(1);
    expect(s1.mcpServers()).toMatchObject([{ name: "lazy", state: "ready", toolCount: 2 }]);
    expect(existsSync(env.cacheFile)).toBe(true);
    const cachedJson = JSON.parse(readFileSync(env.cacheFile, "utf8")) as {
      schemaVersion: number;
      pluginId: string;
      serverId: string;
      keyKind: string;
      keyValue: string;
      serverInfo?: { name: string; version: string };
      tools: { name: string; annotations?: { readOnlyHint?: boolean } }[];
    };
    expect(cachedJson).toMatchObject({
      schemaVersion: 1,
      pluginId: "nocturne:lazy-kit@builtin",
      serverId: "lazy",
      keyKind: "version",
      keyValue: "1.0.0",
      serverInfo: { name: "fixture-lazy", version: "1.0.0" },
    });
    expect(cachedJson.tools.map((t) => t.name)).toEqual(["ping", "extra"]);
    const startedRequestTools = run1.provider.requests[0]?.tools;
    expect(startedRequestTools).toBeDefined();
    await s1.close();
    await run1.rt.close();

    // 2) 第二次会话：缓存命中 → 不启动进程，状态为 standby，工具已注册且请求工具定义逐字节一致
    const run2 = await env.openRuntime([
      [
        { type: "text_delta", text: "no-tool" },
        { type: "finish", reason: "stop" },
      ],
      [
        {
          type: "tool_call",
          toolCallId: "c1",
          name: "mcp__lazy__ping",
          input: { text: "wake" },
        },
        { type: "finish", reason: "tool_calls" },
      ],
      [
        { type: "text_delta", text: "woke" },
        { type: "finish", reason: "stop" },
      ],
    ]);
    const s2 = await run2.rt.createSession({ model: "fake/fake-model" });
    openSessions.push(s2);

    expect(bootCount(env.bootLog)).toBe(1);
    expect(s2.mcpServers()).toMatchObject([
      { name: "lazy", state: "standby", toolCount: 2, restarts: 0 },
    ]);

    const serverStates: string[] = [];
    const completed: { status?: unknown; modelContent?: unknown }[] = [];
    s2.subscribe((e) => {
      if (e.type === "mcp.server" && e.payload.name === "lazy") {
        serverStates.push(e.payload.state);
      }
      if (e.type === "tool.completed") {
        completed.push(e.payload as { status?: unknown; modelContent?: unknown });
      }
    });

    // 不用工具的 Turn：进程依然不启动，工具定义与启动后完全一致，无不可用说明
    await s2.submit({ text: "chat only" });
    expect(bootCount(env.bootLog)).toBe(1);
    expect(s2.mcpServers()[0]?.state).toBe("standby");
    expect(JSON.stringify(run2.provider.requests[0]?.tools)).toBe(
      JSON.stringify(startedRequestTools),
    );
    expect(JSON.stringify(run2.provider.requests[0]?.messages)).not.toContain(
      "[Environment change]",
    );

    // 3) 命中后第一次调用：启动进程、状态 starting → ready、restarts 为 0、返回正确结果
    await s2.submit({ text: "call ping" });
    expect(bootCount(env.bootLog)).toBe(2);
    expect(serverStates).toEqual(["starting", "ready"]);
    expect(s2.mcpServers()).toMatchObject([
      { name: "lazy", state: "ready", toolCount: 2, restarts: 0 },
    ]);
    expect(completed).toHaveLength(1);
    expect(completed[0]?.status).toBe("ok");
    expect(String(completed[0]?.modelContent)).toContain("fixture-lazy:ping:wake");
  });

  it("工具列表变化：首次调用后更新缓存，本 Turn 保持旧工具集，新工具在下一个边界生效", async () => {
    const env = await createLazyEnv({ tools: [PING_TOOL] });

    // 预热缓存（仅 ping）
    const warmup = await env.openRuntime([
      [
        { type: "text_delta", text: "warm" },
        { type: "finish", reason: "stop" },
      ],
    ]);
    const sw = await warmup.rt.createSession({ model: "fake/fake-model" });
    openSessions.push(sw);
    await sw.submit({ text: "warm" });
    await sw.close();
    await warmup.rt.close();

    // 服务器侧新增 extra 工具
    writeFileSync(env.toolsFile, JSON.stringify([PING_TOOL, EXTRA_TOOL]));

    const run = await env.openRuntime([
      [
        {
          type: "tool_call",
          toolCallId: "c1",
          name: "mcp__lazy__ping",
          input: { text: "first" },
        },
        { type: "finish", reason: "tool_calls" },
      ],
      [
        { type: "text_delta", text: "turn1 done" },
        { type: "finish", reason: "stop" },
      ],
      [
        {
          type: "tool_call",
          toolCallId: "c2",
          name: "mcp__lazy__extra",
          input: { text: "second" },
        },
        { type: "finish", reason: "tool_calls" },
      ],
      [
        { type: "text_delta", text: "turn2 done" },
        { type: "finish", reason: "stop" },
      ],
    ]);
    const s = await run.rt.createSession({ model: "fake/fake-model" });
    openSessions.push(s);
    const completed: { name?: unknown; status?: unknown; modelContent?: unknown }[] = [];
    s.subscribe((e) => {
      if (e.type === "tool.completed") {
        completed.push(e.payload as { name?: unknown; status?: unknown; modelContent?: unknown });
      }
    });

    await s.submit({ text: "turn 1" });
    // Turn 1 内两次请求都不包含新工具 extra（保持 Turn 内稳定）
    const req1Names = (run.provider.requests[0]?.tools ?? []).map((t) => t.name);
    const req2Names = (run.provider.requests[1]?.tools ?? []).map((t) => t.name);
    expect(req1Names).toContain("mcp__lazy__ping");
    expect(req1Names).not.toContain("mcp__lazy__extra");
    expect(req2Names).toEqual(req1Names);

    // 磁盘缓存已更新为 [ping, extra]
    const updatedCache = JSON.parse(readFileSync(env.cacheFile, "utf8")) as {
      tools: { name: string }[];
    };
    expect(updatedCache.tools.map((t) => t.name)).toEqual(["ping", "extra"]);

    // Turn 2（下一个 MCP 边界）：新工具 extra 已生效并可调用
    await s.submit({ text: "turn 2" });
    const req3Names = (run.provider.requests[2]?.tools ?? []).map((t) => t.name);
    expect(req3Names).toContain("mcp__lazy__extra");
    expect(completed.find((c) => c.name === "mcp__lazy__extra")).toMatchObject({
      status: "ok",
    });
    expect(String(completed.find((c) => c.name === "mcp__lazy__extra")?.modelContent)).toContain(
      "fixture-lazy:extra:second",
    );
  });

  it("被调用的工具已消失时返回 mcp_tool_missing，且缓存同步更新", async () => {
    const env = await createLazyEnv({ tools: [PING_TOOL, OBSOLETE_TOOL] });

    const warmup = await env.openRuntime([
      [
        { type: "text_delta", text: "warm" },
        { type: "finish", reason: "stop" },
      ],
    ]);
    const sw = await warmup.rt.createSession({ model: "fake/fake-model" });
    openSessions.push(sw);
    await sw.submit({ text: "warm" });
    await sw.close();
    await warmup.rt.close();

    // 服务器移除 obsolete 工具
    writeFileSync(env.toolsFile, JSON.stringify([PING_TOOL]));

    const run = await env.openRuntime([
      [
        {
          type: "tool_call",
          toolCallId: "c1",
          name: "mcp__lazy__obsolete",
          input: { text: "gone" },
        },
        { type: "finish", reason: "tool_calls" },
      ],
      [
        { type: "text_delta", text: "handled" },
        { type: "finish", reason: "stop" },
      ],
    ]);
    const s = await run.rt.createSession({ model: "fake/fake-model" });
    openSessions.push(s);
    const errors: { code?: unknown; message?: unknown }[] = [];
    s.subscribe((e) => {
      if (e.type === "tool.completed" && e.payload.status === "error") {
        errors.push(e.payload.error ?? {});
      }
    });

    await s.submit({ text: "call obsolete" });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("mcp_tool_missing");

    const updatedCache = JSON.parse(readFileSync(env.cacheFile, "utf8")) as {
      tools: { name: string }[];
    };
    expect(updatedCache.tools.map((t) => t.name)).toEqual(["ping"]);
  });

  it("内置插件版本变更或已安装插件指纹变更时缓存失效", async () => {
    const env = await createLazyEnv({ version: "1.0.0", tools: [PING_TOOL] });

    // A) 内置插件预热 1.0.0 缓存
    const warm1 = await env.openRuntime([
      [
        { type: "text_delta", text: "ok" },
        { type: "finish", reason: "stop" },
      ],
    ]);
    const sw1 = await warm1.rt.createSession({ model: "fake/fake-model" });
    openSessions.push(sw1);
    await sw1.submit({ text: "warm" });
    expect(bootCount(env.bootLog)).toBe(1);
    await sw1.close();
    await warm1.rt.close();

    // 内置插件版本升到 2.0.0 → 缓存失效，打开新会话立即启动并重写缓存
    writeFileSync(
      path.join(env.pluginDir, ".nocturne-plugin", "plugin.json"),
      JSON.stringify({
        name: "lazy-kit",
        version: "2.0.0",
        mcpServers: {
          lazy: {
            command: "${NOCTURNE_NODE}",
            args: ["${PLUGIN_ROOT}/server.mjs"],
            env: {
              FIXTURE_BOOT_LOG: env.bootLog,
              FIXTURE_TOOLS_FILE: env.toolsFile,
              FIXTURE_SERVER_NAME: "fixture-lazy",
            },
          },
        },
      }),
    );

    const run2 = await env.openRuntime([
      [
        { type: "text_delta", text: "ok2" },
        { type: "finish", reason: "stop" },
      ],
    ]);
    const s2 = await run2.rt.createSession({ model: "fake/fake-model" });
    openSessions.push(s2);
    await s2.submit({ text: "v2" });
    expect(bootCount(env.bootLog)).toBe(2);
    expect(s2.mcpServers()[0]?.state).toBe("ready");
    const v2Cache = JSON.parse(readFileSync(env.cacheFile, "utf8")) as { keyValue: string };
    expect(v2Cache.keyValue).toBe("2.0.0");
    await s2.close();
    await run2.rt.close();

    // B) 本地安装插件：按指纹失效
    const localBootLog = path.join(env.root, "local-boots.log");
    const localDir = path.join(
      env.nocturneHome,
      "plugins",
      "installed",
      "local",
      "inst-kit",
      "1.0.0",
    );
    mkdirSync(path.join(localDir, ".nocturne-plugin"), { recursive: true });
    writeFileSync(path.join(localDir, "server.mjs"), DYNAMIC_STDIO_MCP_SERVER);
    writeFileSync(path.join(localDir, "note.txt"), "v1");
    writeFileSync(
      path.join(localDir, ".nocturne-plugin", "plugin.json"),
      JSON.stringify({
        name: "inst-kit",
        version: "1.0.0",
        mcpServers: {
          inst: {
            command: "${NOCTURNE_NODE}",
            args: ["${PLUGIN_ROOT}/server.mjs"],
            env: {
              FIXTURE_BOOT_LOG: localBootLog,
              FIXTURE_TOOLS_FILE: env.toolsFile,
              FIXTURE_SERVER_NAME: "fixture-inst",
            },
          },
        },
      }),
    );

    const localRun1 = await env.openRuntime([
      [
        { type: "text_delta", text: "ok" },
        { type: "finish", reason: "stop" },
      ],
    ]);
    await localRun1.rt.setPluginEnabled({ id: "nocturne:inst-kit@local", enabled: true });
    const ls1 = await localRun1.rt.createSession({ model: "fake/fake-model" });
    openSessions.push(ls1);
    await ls1.submit({ text: "warm local" });
    expect(bootCount(localBootLog)).toBe(1);
    await ls1.close();
    await localRun1.rt.close();

    // 确认未改动时命中缓存不启动
    const localRunHit = await env.openRuntime([
      [
        { type: "text_delta", text: "hit" },
        { type: "finish", reason: "stop" },
      ],
    ]);
    const lsHit = await localRunHit.rt.createSession({ model: "fake/fake-model" });
    openSessions.push(lsHit);
    expect(lsHit.mcpServers().find((m) => m.name === "inst")?.state).toBe("standby");
    expect(bootCount(localBootLog)).toBe(1);
    await lsHit.close();
    await localRunHit.rt.close();

    // 修改插件内容并重新确认启用（指纹变化，版本号未变）→ 缓存失效，新会话重新启动
    writeFileSync(path.join(localDir, "note.txt"), "v2-changed");
    const localRun2 = await env.openRuntime([
      [
        { type: "text_delta", text: "miss" },
        { type: "finish", reason: "stop" },
      ],
    ]);
    await localRun2.rt.setPluginEnabled({ id: "nocturne:inst-kit@local", enabled: true });
    const ls2 = await localRun2.rt.createSession({ model: "fake/fake-model" });
    openSessions.push(ls2);
    await ls2.submit({ text: "after fingerprint change" });
    expect(bootCount(localBootLog)).toBe(2);
    expect(ls2.mcpServers().find((m) => m.name === "inst")?.state).toBe("ready");
  });

  it("缓存文件损坏时按未命中处理，不报错并重建有效缓存", async () => {
    const env = await createLazyEnv({ tools: [PING_TOOL] });
    mkdirSync(env.cacheDir, { recursive: true });
    writeFileSync(env.cacheFile, "{broken-json!!!");

    const run = await env.openRuntime([
      [
        { type: "text_delta", text: "recovered" },
        { type: "finish", reason: "stop" },
      ],
    ]);
    const s = await run.rt.createSession({ model: "fake/fake-model" });
    openSessions.push(s);
    const warnings: { code: string; message: string }[] = [];
    s.subscribe((e) => {
      if (e.type === "runtime.warning") warnings.push(e.payload);
    });

    await s.submit({ text: "go" });
    expect(bootCount(env.bootLog)).toBe(1);
    expect(s.mcpServers()).toMatchObject([{ name: "lazy", state: "ready", toolCount: 1 }]);
    expect(warnings).toEqual([]);
    const rebuilt = JSON.parse(readFileSync(env.cacheFile, "utf8")) as {
      schemaVersion: number;
      tools: { name: string }[];
    };
    expect(rebuilt.schemaVersion).toBe(1);
    expect(rebuilt.tools.map((t) => t.name)).toEqual(["ping"]);
  });

  it("配置文件里的 MCP 服务器仍在会话打开时启动，与缓存命中的插件共存时工具顺序逐字节一致", async () => {
    const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "nct-plugin-cfg-")));
    tmpRoots.push(root);
    const cfgScript = path.join(root, "cfg-server.mjs");
    const cfgBootLog = path.join(root, "cfg-boots.log");
    const cfgToolsFile = path.join(root, "cfg-tools.json");
    writeFileSync(cfgScript, DYNAMIC_STDIO_MCP_SERVER);
    writeFileSync(cfgToolsFile, JSON.stringify([EXTRA_TOOL]));

    const env = await createLazyEnv({
      tools: [PING_TOOL],
      configMcpServers: {
        cfg_srv: {
          command: process.execPath,
          args: [cfgScript],
          env: {
            FIXTURE_BOOT_LOG: cfgBootLog,
            FIXTURE_TOOLS_FILE: cfgToolsFile,
            FIXTURE_SERVER_NAME: "fixture-cfg",
          },
        },
      },
    });

    // 1) 冷启动（无缓存）：两者都启动，记录请求里的完整工具定义与顺序
    const cold = await env.openRuntime([
      [
        { type: "text_delta", text: "cold" },
        { type: "finish", reason: "stop" },
      ],
    ]);
    const sCold = await cold.rt.createSession({ model: "fake/fake-model" });
    openSessions.push(sCold);
    await sCold.submit({ text: "cold" });
    expect(bootCount(cfgBootLog)).toBe(1);
    expect(bootCount(env.bootLog)).toBe(1);
    const coldTools = cold.provider.requests[0]?.tools;
    await sCold.close();
    await cold.rt.close();

    // 2) 热启动（插件命中缓存）：配置文件里的 cfg_srv 仍在会话打开时立刻启动，插件 lazy 保持 standby
    const warm = await env.openRuntime([
      [
        { type: "text_delta", text: "warm" },
        { type: "finish", reason: "stop" },
      ],
    ]);
    const sWarm = await warm.rt.createSession({ model: "fake/fake-model" });
    openSessions.push(sWarm);

    // 不发任何消息，仅打开会话：配置服务器 cfg_srv 自动启动，插件服务器 lazy 仍为 standby 且未起进程
    await vi.waitFor(() => {
      expect(sWarm.mcpServers().find((m) => m.name === "cfg_srv")?.state).toBe("ready");
    });
    expect(bootCount(cfgBootLog)).toBe(2);
    expect(bootCount(env.bootLog)).toBe(1);
    expect(sWarm.mcpServers().find((m) => m.name === "lazy")?.state).toBe("standby");

    // 缓存目录下只应存在插件服务器的缓存，不应存在配置服务器的缓存
    expect(readdirSync(env.cacheDir).filter((f) => f.includes("cfg_srv"))).toEqual([]);

    await sWarm.submit({ text: "warm" });
    expect(bootCount(env.bootLog)).toBe(1);
    expect(JSON.stringify(warm.provider.requests[0]?.tools)).toBe(JSON.stringify(coldTools));

    // 删除临时目录中可能残留的辅助文件验证清理
    rmSync(cfgBootLog, { force: true });
  });
});
