/**
 * 自有插件 MCP 服务器端到端测试（ADR-0100 第 2 节）：
 * 夹具插件通过 `${NOCTURNE_NODE}` 启动最小 stdio MCP 服务器，
 * 在真实会话里调用工具并验证权限主体为 `mcp <server>/<tool>`。
 */
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
