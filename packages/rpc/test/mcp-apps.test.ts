/**
 * MCP Apps 三个本地 RPC 方法往返测试（ADR-0101 第 7 节）：
 * session.listAppSurfaces / session.readAppResource / session.callAppTool
 * 用最小 McpConnector 驱动真实的示例插件 stdio 服务器进程，不引入 @nocturne/mcp 依赖。
 */
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  createPlatform,
  createRuntime,
  FakeProvider,
  loadConfig,
  type McpAppToolMeta,
  type McpConnector,
  type Runtime,
} from "@nocturne/core";
import { createMemoryTransportPair, createRpcClient } from "@nocturne/rpc/client";
import { createRpcServer } from "@nocturne/rpc/server";
import { createProcessCleanup } from "../../../scripts/test/process-cleanup.mjs";
import { cleanupTmp, tmpDir } from "./harness.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const DEMO_FIXTURE_DIR = path.resolve(here, "../../mcp/test/fixtures/mcp-apps-demo");
const processes = createProcessCleanup();

afterEach(async () => {
  await processes.cleanup();
  cleanupTmp();
});

function createStdioDemoConnector(serverScript: string, pluginId: string): McpConnector {
  return {
    probe: async () => ({ ok: true, durationMs: 1, tools: [], stderrTail: [] }),
    open: async () => {
      const child = spawn(process.execPath, [serverScript], {
        stdio: ["pipe", "pipe", "ignore"],
      });
      const rl = createInterface({ input: child.stdout });
      let nextId = 1;
      const pending = new Map<
        number,
        { resolve: (v: unknown) => void; reject: (e: Error) => void }
      >();
      rl.on("line", (line) => {
        if (!line.trim()) return;
        const msg = JSON.parse(line) as {
          id?: number;
          result?: unknown;
          error?: { message?: string };
        };
        if (typeof msg.id === "number") {
          const waiter = pending.get(msg.id);
          if (waiter !== undefined) {
            pending.delete(msg.id);
            if (msg.error !== undefined) waiter.reject(new Error(msg.error.message ?? "rpc error"));
            else waiter.resolve(msg.result);
          }
        }
      });
      const rpc = (method: string, params: Record<string, unknown>) =>
        new Promise<unknown>((resolve, reject) => {
          const id = nextId++;
          pending.set(id, { resolve, reject });
          child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
        });

      await rpc("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {
          extensions: {
            "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] },
          },
        },
        clientInfo: { name: "nocturne-rpc-test", version: "0.0.0" },
      });
      const listed = (await rpc("tools/list", {})) as {
        tools: {
          name: string;
          annotations?: { readOnlyHint?: boolean };
          _meta?: {
            ui?: { resourceUri?: string; visibility?: ("model" | "app")[]; surface?: string };
          };
        }[];
      };
      const metaByTool = new Map<string, McpAppToolMeta>();
      for (const tool of listed.tools) {
        metaByTool.set(tool.name, {
          name: tool.name,
          readOnly: tool.annotations?.readOnlyHint === true,
          visibility: tool._meta?.ui?.visibility ?? ["model", "app"],
          ...(tool._meta?.ui?.resourceUri !== undefined
            ? { resourceUri: tool._meta.ui.resourceUri }
            : {}),
          ...(tool._meta?.ui?.surface !== undefined ? { surface: tool._meta.ui.surface } : {}),
        });
      }

      return {
        startup: async () => undefined,
        tools: () => [],
        status: () => [
          {
            name: "demo",
            transport: "stdio",
            state: "ready",
            toolCount: 1,
            restarts: 0,
            origin: "plugin",
            pluginId,
          },
        ],
        reconcile: async () => undefined,
        applyPendingTools: () => ({ add: [], remove: [] }),
        listServerTools: (serverId) => (serverId === "demo" ? [...metaByTool.values()] : undefined),
        getAppToolMeta: (serverId, toolName) =>
          serverId === "demo" ? metaByTool.get(toolName) : undefined,
        ensurePluginServerReady: async (serverId) => {
          if (serverId !== "demo") throw new Error("server_not_found");
        },
        readAppResource: async (serverId, uri) => {
          if (serverId !== "demo") throw new Error("server_not_found");
          const res = (await rpc("resources/read", { uri })) as {
            contents: { uri: string; mimeType: string; text?: string }[];
          };
          const first = res.contents[0];
          if (first === undefined || first.text === undefined) throw new Error("empty_resource");
          return {
            uri: first.uri,
            mimeType: first.mimeType as "text/html;profile=mcp-app",
            html: first.text,
            bytes: Buffer.byteLength(first.text, "utf8"),
          };
        },
        callAppTool: async (serverId, tool, args) => {
          if (serverId !== "demo") throw new Error("server_not_found");
          return (await rpc("tools/call", { name: tool, arguments: args })) as {
            content: unknown[];
            structuredContent?: Record<string, unknown>;
            isError?: boolean;
          };
        },
        close: async () => {
          rl.close();
          child.kill();
        },
      };
    },
  };
}

describe("MCP Apps 本地 RPC 方法往返（ADR-0101 第 7 节）", () => {
  it("session.listAppSurfaces / readAppResource / callAppTool 经真实示例服务器往返", async () => {
    const root = tmpDir("nct-rpc-mcp-apps-");
    const home = path.join(root, "home");
    const codexHome = path.join(root, "codex");
    const claudeHome = path.join(root, "claude");
    const ws = path.join(root, "ws");
    const builtinDir = path.join(root, "builtin");
    mkdirSync(home, { recursive: true });
    mkdirSync(codexHome, { recursive: true });
    mkdirSync(claudeHome, { recursive: true });
    mkdirSync(ws, { recursive: true });
    mkdirSync(builtinDir, { recursive: true });
    const installedDemo = path.join(builtinDir, "mcp-apps-demo");
    cpSync(DEMO_FIXTURE_DIR, installedDemo, { recursive: true });
    writeFileSync(
      path.join(home, "config.json"),
      JSON.stringify({ modelsDev: false, skills: { sources: { agents: false, claude: false } } }),
    );

    const basePlat = processes.platform(createPlatform());
    const plat = {
      ...basePlat,
      homeDir: () => root,
      nocturneHome: () => home,
    };
    const config = await loadConfig(plat, { nocturneHome: home });
    let runtime: Runtime | undefined;
    const server = createRpcServer({
      nocturneVersion: "0.0.0-test",
      createRuntime: async () => {
        runtime = await createRuntime({
          cwd: ws,
          sessionsDir: path.join(home, "sessions"),
          config,
          providers: [new FakeProvider({ scripts: [] })],
          mcp: createStdioDemoConnector(
            path.join(installedDemo, "server.mjs"),
            "nocturne:mcp-apps-demo@builtin",
          ),
          builtinPluginsDir: builtinDir,
          plugins: { codexHome, claudeHome },
        });
        return {
          runtime,
          providerConfig: {
            config,
            reload: () => Promise.resolve(config),
            workspaceRoot: ws,
          },
        };
      },
    });

    const [clientTransport, serverTransport] = createMemoryTransportPair();
    const served = server.serve(serverTransport);
    const client = createRpcClient(clientTransport, { clientName: "test" });
    await client.initialize();

    await client.runtime.setPluginEnabled({
      id: "nocturne:mcp-apps-demo@builtin",
      enabled: true,
    });

    const { session } = await client.runtime.createSession({ model: "fake/fake-model", cwd: ws });

    const surfaces = await session.listAppSurfaces();
    expect(surfaces).toHaveLength(1);
    expect(surfaces[0]).toMatchObject({
      pluginId: "nocturne:mcp-apps-demo@builtin",
      serverId: "demo",
      id: "demo-viewer",
      title: "示例面板",
      resourceUri: "ui://demo/viewer.html",
      open: { tool: "open_demo_file", fileTypes: [".nctdemo"] },
    });

    const resource = await session.readAppResource({
      pluginId: "nocturne:mcp-apps-demo@builtin",
      serverId: "demo",
      uri: "ui://demo/viewer.html",
    });
    expect(resource.uri).toBe("ui://demo/viewer.html");
    expect(resource.mimeType).toBe("text/html;profile=mcp-app");
    expect(resource.html).toContain("示例面板");

    const roResult = await session.callAppTool({
      pluginId: "nocturne:mcp-apps-demo@builtin",
      serverId: "demo",
      tool: "fetch_app_stats",
      arguments: { section: "rpc" },
    });
    expect(roResult.structuredContent).toEqual({ count: 1, section: "rpc", status: "ok" });

    await expect(
      session.callAppTool({
        pluginId: "nocturne:mcp-apps-demo@builtin",
        serverId: "demo",
        tool: "mutate_demo_state",
        arguments: { value: "deny" },
      }),
    ).rejects.toMatchObject({ code: "app_tool_not_allowed" });

    await client.shutdown();
    await served;
  });
});
