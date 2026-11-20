/**
 * MCP Apps 宿主 Core + MCP 连接层端到端测试（ADR-0101 第 2、3、4 节）。
 * 使用真实示例插件 stdio 服务器（test/fixtures/mcp-apps-demo），验证：
 * - 能力协商只对插件服务器声明，配置服务器 initialize 报文与 main 逐字节一致；
 * - visibility 过滤（模型工具列表、mcp_search、/context 工具计数、specs 稳定）；
 * - 缓存格式升级后旧 schemaVersion: 1 缓存视为未命中并重建；
 * - tool.completed.ui、resources/read（text/blob/安全约束/按需启动）；
 * - callAppTool（只读放行、非只读拒绝 app_tool_not_allowed、跨服务器拒绝、visibility 限制、不写日志、不触发 Hook）；
 * - open.tool 指向非只读工具时该 surface 不参与文件打开且插件 warnings 有记录。
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  createPlatform,
  createRuntime,
  FakeProvider,
  loadConfig,
  type FakeScript,
  type Runtime,
  type RuntimeSession,
} from "@nocturne/core";
import type { ToolCompletedPayload } from "@nocturne/core/protocol";
import { createProcessCleanup, removeTempDirs } from "../../../scripts/test/process-cleanup.mjs";
import { createMcpConnector } from "../src/connector.js";
import { pluginMcpCacheFileName } from "../src/plugin-cache.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const DEMO_FIXTURE_DIR = path.join(here, "fixtures", "mcp-apps-demo");

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

const INIT_CAPTURE_SERVER = `
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const captureFile = process.env.CAPTURE_INIT_FILE;
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\\n");
}
rl.on("line", (line) => {
  if (!line.trim()) return;
  const req = JSON.parse(line);
  if (req.method === "initialize") {
    if (captureFile) appendFileSync(captureFile, JSON.stringify(req.params) + "\\n");
    send({
      jsonrpc: "2.0",
      id: req.id,
      result: {
        protocolVersion: req.params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: "capture-srv", version: "1.0.0" },
      },
    });
  } else if (req.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: req.id,
      result: {
        tools: [
          {
            name: "ro_tool",
            description: "read-only tool",
            inputSchema: { type: "object", properties: {} },
            annotations: { readOnlyHint: true },
            _meta: { ui: { visibility: ["model", "app"] } },
          },
          {
            name: "model_only_tool",
            description: "model-only tool",
            inputSchema: { type: "object", properties: {} },
            annotations: { readOnlyHint: true },
            _meta: { ui: { visibility: ["model"] } },
          },
          {
            name: "write_open_tool",
            description: "non-readonly tool",
            inputSchema: { type: "object", properties: { path: { type: "string" } } },
            annotations: { readOnlyHint: false },
            _meta: { ui: { visibility: ["app"] } },
          },
        ],
      },
    });
  } else if (req.method === "resources/read") {
    const uri = req.params?.uri;
    if (uri === "ui://bad/mime.html") {
      send({
        jsonrpc: "2.0",
        id: req.id,
        result: { contents: [{ uri, mimeType: "text/html", text: "<h1>wrong mime</h1>" }] },
      });
    } else if (uri === "ui://bad/oversize.html") {
      send({
        jsonrpc: "2.0",
        id: req.id,
        result: {
          contents: [
            { uri, mimeType: "text/html;profile=mcp-app", text: "x".repeat(8 * 1024 * 1024 + 16) },
          ],
        },
      });
    } else {
      send({
        jsonrpc: "2.0",
        id: req.id,
        result: {
          contents: [{ uri, mimeType: "text/html;profile=mcp-app", text: "<h1>ok</h1>" }],
        },
      });
    }
  } else if (req.method === "tools/call") {
    send({
      jsonrpc: "2.0",
      id: req.id,
      result: { content: [{ type: "text", text: "ok:" + String(req.params?.name) }] },
    });
  } else if (req.id !== undefined) {
    send({ jsonrpc: "2.0", id: req.id, result: {} });
  }
});
`;

async function createDemoEnv(options?: {
  configExtra?: Record<string, unknown>;
  enableBuiltin?: boolean;
  scripts?: FakeScript[];
  permissionPreset?: "default" | "read-only" | "bypass";
}) {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "nct-mcp-apps-")));
  tmpRoots.push(root);
  const nocturneHome = path.join(root, "home");
  const codexHome = path.join(root, "codex");
  const claudeHome = path.join(root, "claude");
  const ws = path.join(root, "ws");
  const builtinDir = path.join(root, "builtin");
  mkdirSync(nocturneHome, { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(claudeHome, { recursive: true });
  mkdirSync(ws, { recursive: true });
  mkdirSync(builtinDir, { recursive: true });

  const demoDir = path.join(builtinDir, "mcp-apps-demo");
  cpSync(DEMO_FIXTURE_DIR, demoDir, { recursive: true });

  writeFileSync(
    path.join(nocturneHome, "config.json"),
    JSON.stringify({
      modelsDev: false,
      skills: { sources: { agents: false, claude: false } },
      ...(options?.configExtra ?? {}),
    }),
  );

  const openRuntime = async (
    scripts: FakeScript[] = options?.scripts ?? [
      [
        { type: "text_delta", text: "ok" },
        { type: "finish", reason: "stop" },
      ],
    ],
  ) => {
    const plat = {
      ...basePlatform,
      homeDir: () => root,
      nocturneHome: () => nocturneHome,
    };
    const provider = new FakeProvider({ scripts });
    const config = await loadConfig(plat, { nocturneHome });
    const rt = await createRuntime({
      config,
      cwd: ws,
      sessionsDir: path.join(nocturneHome, "sessions"),
      providers: [provider],
      mcp: createMcpConnector(),
      builtinPluginsDir: builtinDir,
      plugins: { codexHome, claudeHome },
    });
    openRuntimes.push(rt);
    if (options?.enableBuiltin !== false) {
      await rt.setPluginEnabled({ id: "nocturne:mcp-apps-demo@builtin", enabled: true });
    }
    return { rt, provider };
  };

  return { root, nocturneHome, codexHome, claudeHome, ws, builtinDir, demoDir, openRuntime };
}

describe("MCP Apps 能力协商、可见性、缓存、资源与页面调用（ADR-0101）", () => {
  it("能力声明只对插件服务器发送；配置服务器 initialize 报文与 main 逐字节一致", async () => {
    const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "nct-mcp-init-")));
    tmpRoots.push(root);
    const nocturneHome = path.join(root, "home");
    const codexHome = path.join(root, "codex");
    const claudeHome = path.join(root, "claude");
    const ws = path.join(root, "ws");
    const builtinDir = path.join(root, "builtin");
    const pluginDir = path.join(builtinDir, "cap-kit");
    mkdirSync(path.join(pluginDir, ".nocturne-plugin"), { recursive: true });
    mkdirSync(nocturneHome, { recursive: true });
    mkdirSync(codexHome, { recursive: true });
    mkdirSync(claudeHome, { recursive: true });
    mkdirSync(ws, { recursive: true });

    const pluginCapture = path.join(root, "plugin-init.jsonl");
    const configCapture = path.join(root, "config-init.jsonl");
    const srvScript = path.join(pluginDir, "srv.mjs");
    writeFileSync(srvScript, INIT_CAPTURE_SERVER);
    writeFileSync(
      path.join(pluginDir, ".nocturne-plugin", "plugin.json"),
      JSON.stringify({
        name: "cap-kit",
        version: "1.0.0",
        mcpServers: {
          psrv: {
            command: "${NOCTURNE_NODE}",
            args: ["${PLUGIN_ROOT}/srv.mjs"],
            env: { CAPTURE_INIT_FILE: pluginCapture },
          },
        },
      }),
    );

    const cfgScript = path.join(root, "cfg-srv.mjs");
    writeFileSync(cfgScript, INIT_CAPTURE_SERVER);
    writeFileSync(
      path.join(nocturneHome, "config.json"),
      JSON.stringify({
        modelsDev: false,
        skills: { sources: { agents: false, claude: false } },
        mcp: {
          servers: {
            csrv: {
              command: process.execPath,
              args: [cfgScript],
              env: { CAPTURE_INIT_FILE: configCapture },
            },
          },
        },
      }),
    );

    const plat = {
      ...basePlatform,
      homeDir: () => root,
      nocturneHome: () => nocturneHome,
    };
    const config = await loadConfig(plat, { nocturneHome });
    const rt = await createRuntime({
      config,
      cwd: ws,
      sessionsDir: path.join(nocturneHome, "sessions"),
      providers: [
        new FakeProvider({
          scripts: [
            [
              { type: "text_delta", text: "ok" },
              { type: "finish", reason: "stop" },
            ],
          ],
        }),
      ],
      mcp: createMcpConnector(),
      builtinPluginsDir: builtinDir,
      plugins: { codexHome, claudeHome },
    });
    openRuntimes.push(rt);
    await rt.setPluginEnabled({ id: "nocturne:cap-kit@builtin", enabled: true });

    const session = await rt.createSession({ model: "fake/fake-model" });
    openSessions.push(session);
    await session.submit({ text: "init" });

    const pluginInit = JSON.parse(readFileSync(pluginCapture, "utf8").trim()) as {
      capabilities: Record<string, unknown>;
      clientInfo: Record<string, unknown>;
      protocolVersion: string;
    };
    const configInit = JSON.parse(readFileSync(configCapture, "utf8").trim()) as {
      capabilities: Record<string, unknown>;
      clientInfo: Record<string, unknown>;
      protocolVersion: string;
    };

    expect(pluginInit.capabilities).toEqual({
      extensions: {
        "io.modelcontextprotocol/ui": {
          mimeTypes: ["text/html;profile=mcp-app"],
        },
      },
    });
    // 配置服务器 capabilities 为空对象（与 main 逐字节一致，不含 extensions）
    expect(JSON.stringify(configInit.capabilities)).toBe("{}");
  });

  it("visibility 不含 model 的工具不进模型列表、mcp_search 与 /context 计数，且 specs 逐字节稳定", async () => {
    const env = await createDemoEnv({
      configExtra: {
        mcp: { toolSearch: "always" },
      },
      scripts: [
        [
          {
            type: "tool_call",
            toolCallId: "s1",
            name: "mcp_search",
            input: { query: "demo" },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        [
          { type: "text_delta", text: "searched" },
          { type: "finish", reason: "stop" },
        ],
      ],
    });
    const { rt, provider } = await env.openRuntime();
    const session = await rt.createSession({
      model: "fake/fake-model",
      permissionPreset: "bypass",
    });
    openSessions.push(session);

    // 跑 mcp_search：会等待 MCP 初始化完成，且只能搜到 show_demo，不能搜到 app-only 工具
    const searchOutputs: string[] = [];
    session.subscribe((ev) => {
      if (ev.type === "tool.completed" && ev.payload.name === "mcp_search") {
        searchOutputs.push(ev.payload.modelContent);
      }
    });
    const reason = await session.submit({ text: "search demo tools" });
    expect(reason).toBe("done");
    expect(searchOutputs).toHaveLength(1);
    expect(searchOutputs[0]).toContain("mcp__demo__show_demo");
    expect(searchOutputs[0]).not.toContain("open_demo_file");
    expect(searchOutputs[0]).not.toContain("fetch_app_stats");
    expect(searchOutputs[0]).not.toContain("mutate_demo_state");

    const ctx1 = session.describeContext();
    const ctx2 = session.describeContext();
    // specs 在工具集不变时逐字节稳定
    expect(JSON.stringify(ctx1.request.tools)).toBe(JSON.stringify(ctx2.request.tools));
    // /context 工具段注明「MCP 按需，1 个工具未列出」（只计 1 个模型可见工具，不含 3 个 app-only 工具）
    const toolsSection = ctx1.report.sections.find((s) => s.name === "tools");
    expect(toolsSection?.source).toContain("MCP 按需，1 个工具未列出");

    const allToolNames = (ctx1.request.tools ?? []).map((t) => t.name);
    expect(allToolNames).not.toContain("mcp__demo__open_demo_file");
    expect(allToolNames).not.toContain("mcp__demo__fetch_app_stats");
    expect(allToolNames).not.toContain("mcp__demo__mutate_demo_state");

    // 关闭 toolSearch（全量暴露模式）下，检查模型工具列表与 /context 工具计数
    await session.close();
    await rt.close();

    writeFileSync(
      path.join(env.nocturneHome, "config.json"),
      JSON.stringify({
        modelsDev: false,
        skills: { sources: { agents: false, claude: false } },
        mcp: { toolSearch: "never" },
      }),
    );
    const { rt: rtOff, provider: providerOff } = await env.openRuntime([
      [
        { type: "text_delta", text: "plain" },
        { type: "finish", reason: "stop" },
      ],
    ]);
    const sessionOff = await rtOff.createSession({ model: "fake/fake-model" });
    openSessions.push(sessionOff);
    await sessionOff.submit({ text: "hello" });
    const ctxOff1 = sessionOff.describeContext();
    const ctxOff2 = sessionOff.describeContext();
    expect(JSON.stringify(ctxOff1.request.tools)).toBe(JSON.stringify(ctxOff2.request.tools));
    const mcpNames = (ctxOff1.request.tools ?? [])
      .map((t) => t.name)
      .filter((n) => n.startsWith("mcp__demo__"));
    expect(mcpNames).toEqual(["mcp__demo__show_demo"]);
    // /context 工具计数（describeContext().request.tools）只计入 1 个模型可见 MCP 工具，不含 3 个 app-only 工具
    expect((ctxOff1.request.tools ?? []).filter((t) => t.name.startsWith("mcp__")).length).toBe(1);

    const reqTools = (providerOff.requests[0]?.tools ?? []).map((t) => t.name);
    expect(reqTools.filter((n) => n.startsWith("mcp__demo__"))).toEqual(["mcp__demo__show_demo"]);
    expect(provider.requests.length).toBeGreaterThan(0);
  });

  it("旧格式缓存（schemaVersion: 1）视为未命中，开会话时启动服务器并重建 v2 缓存", async () => {
    const env = await createDemoEnv();
    const cacheDir = path.join(env.nocturneHome, "plugins", "cache", "mcp-tools");
    mkdirSync(cacheDir, { recursive: true });
    const cacheFile = path.join(
      cacheDir,
      pluginMcpCacheFileName("nocturne:mcp-apps-demo@builtin", "demo"),
    );
    // 写入 main 版本格式的 v1 缓存（无 ui 元数据）
    writeFileSync(
      cacheFile,
      JSON.stringify({
        schemaVersion: 1,
        pluginId: "nocturne:mcp-apps-demo@builtin",
        serverId: "demo",
        keyKind: "version",
        keyValue: "1.0.0",
        cachedAt: "2026-11-01T00:00:00.000Z",
        tools: [
          {
            name: "show_demo",
            description: "stale v1",
            inputSchema: { type: "object" },
          },
        ],
      }),
    );

    const { rt } = await env.openRuntime();
    const session = await rt.createSession({ model: "fake/fake-model" });
    openSessions.push(session);
    await session.submit({ text: "trigger-init" });

    // v1 缓存未命中 → 立即启动服务器，状态为 ready（不是 standby）
    expect(session.mcpServers()).toMatchObject([{ name: "demo", state: "ready" }]);
    const rebuilt = JSON.parse(readFileSync(cacheFile, "utf8")) as {
      schemaVersion: number;
      tools: {
        name: string;
        ui?: { resourceUri?: string; visibility?: string[]; surface?: string };
      }[];
    };
    expect(rebuilt.schemaVersion).toBe(2);
    const showTool = rebuilt.tools.find((t) => t.name === "show_demo");
    expect(showTool?.ui).toEqual({
      resourceUri: "ui://demo/viewer.html",
      surface: "demo-viewer",
      visibility: ["model", "app"],
    });
    const statsTool = rebuilt.tools.find((t) => t.name === "fetch_app_stats");
    expect(statsTool?.ui?.visibility).toEqual(["app"]);
  });

  it("端到端：tool.completed.ui、readAppResource（含 text/blob/standby/拦截）、callAppTool（只读/非只读/无日志无Hook）、listAppSurfaces", async () => {
    const hookLogFile = path.join(
      realpathSync.native(mkdtempSync(path.join(tmpdir(), "nct-mcp-apps-hook-"))),
      "hooks.log",
    );
    tmpRoots.push(path.dirname(hookLogFile));
    const hookScript = path.join(path.dirname(hookLogFile), "hook.mjs");
    writeFileSync(
      hookScript,
      `import { appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(hookLogFile)}, "hit\\n");`,
    );

    const env = await createDemoEnv({
      configExtra: {
        hooks: {
          PreToolUse: [{ command: process.execPath, args: [hookScript] }],
          PostToolUse: [{ command: process.execPath, args: [hookScript] }],
        },
        permissions: {
          rules: [
            // 即使显式 allow 写入工具，页面调用非只读工具也必须被拒
            { action: "allow", kind: "mcp", pattern: "demo/mutate_demo_state" },
          ],
        },
      },
      scripts: [
        [
          {
            type: "tool_call",
            toolCallId: "t1",
            name: "mcp__demo__show_demo",
            input: { title: "测试文档", note: "来自模型" },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        [
          { type: "text_delta", text: "已在面板中展示" },
          { type: "finish", reason: "stop" },
        ],
      ],
    });

    const { rt } = await env.openRuntime();
    const session = await rt.createSession({
      model: "fake/fake-model",
      permissionPreset: "bypass",
    });
    openSessions.push(session);

    // 1) 列出 surface
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
    expect(surfaces[0]?.icon).toMatch(/^data:image\/svg\+xml;base64,/);

    // 2) 模型调用 show_demo → tool.completed 带 ui 元数据与 structured output
    const completedEvents: ToolCompletedPayload[] = [];
    session.subscribe((ev) => {
      if (ev.type === "tool.completed") completedEvents.push(ev.payload);
    });
    await session.submit({ text: "打开示例" });
    expect(completedEvents).toHaveLength(1);
    expect(completedEvents[0]?.ui).toEqual({
      pluginId: "nocturne:mcp-apps-demo@builtin",
      serverId: "demo",
      resourceUri: "ui://demo/viewer.html",
      surface: "demo-viewer",
    });
    expect(completedEvents[0]?.output).toMatchObject({
      structured: { title: "测试文档", note: "来自模型" },
    });

    // 记录模型调用后的会话日志条数（内存 + 磁盘 JSONL）与 Hook 触发次数
    const sessionLogPath = path.join(env.nocturneHome, "sessions", `${session.id}.jsonl`);
    const readLogLineCount = () =>
      readFileSync(sessionLogPath, "utf8").trim().split("\n").filter(Boolean).length;
    const eventsBeforeAppCall = readLogLineCount();
    const seqBeforeAppCall = session.state().lastSeq;
    expect(seqBeforeAppCall).toBeGreaterThan(0);
    const hookHitsBefore = existsSync(hookLogFile)
      ? readFileSync(hookLogFile, "utf8").trim().split("\n").filter(Boolean).length
      : 0;
    expect(hookHitsBefore).toBeGreaterThanOrEqual(1);

    // 3) 读取 ui:// 页面资源（text 与 base64 blob）
    const htmlRes = await session.readAppResource({
      pluginId: "nocturne:mcp-apps-demo@builtin",
      serverId: "demo",
      uri: "ui://demo/viewer.html",
    });
    expect(htmlRes.mimeType).toBe("text/html;profile=mcp-app");
    expect(htmlRes.html).toContain("ui/initialize");

    const blobRes = await session.readAppResource({
      pluginId: "nocturne:mcp-apps-demo@builtin",
      serverId: "demo",
      uri: "ui://demo/blob.html",
    });
    expect(blobRes.html).toBe(htmlRes.html);

    // 拒绝非 ui:// URI
    await expect(
      session.readAppResource({
        pluginId: "nocturne:mcp-apps-demo@builtin",
        serverId: "demo",
        uri: "file:///etc/passwd",
      }),
    ).rejects.toThrow(/ui:\/\//);

    // 4) 页面调用页面专用只读工具成功（返回原始 CallToolResult）
    const statsRes = await session.callAppTool({
      pluginId: "nocturne:mcp-apps-demo@builtin",
      serverId: "demo",
      tool: "fetch_app_stats",
      arguments: { section: "overview" },
    });
    expect(statsRes.isError).not.toBe(true);
    expect(statsRes.structuredContent).toEqual({ count: 1, section: "overview", status: "ok" });

    // 5) 页面调用非只读工具：即便在 bypass 预设 + 显式 allow 规则下也必须被拒（app_tool_not_allowed）
    await expect(
      session.callAppTool({
        pluginId: "nocturne:mcp-apps-demo@builtin",
        serverId: "demo",
        tool: "mutate_demo_state",
        arguments: { value: "boom" },
      }),
    ).rejects.toMatchObject({ code: "app_tool_not_allowed" });

    // 6) 跨服务器调用被拒
    await expect(
      session.callAppTool({
        pluginId: "nocturne:mcp-apps-demo@builtin",
        serverId: "other-server",
        tool: "fetch_app_stats",
        arguments: {},
      }),
    ).rejects.toThrow();

    // 7) 页面调用不写会话日志、不触发 Hook
    expect(readLogLineCount()).toBe(eventsBeforeAppCall);
    expect(session.state().lastSeq).toBe(seqBeforeAppCall);
    const hookHitsAfter = existsSync(hookLogFile)
      ? readFileSync(hookLogFile, "utf8").trim().split("\n").filter(Boolean).length
      : 0;
    expect(hookHitsAfter).toBe(hookHitsBefore);

    // 8) 新会话缓存命中 standby，不启动进程；readAppResource 按需启动服务器
    await session.close();
    await rt.close();
    const { rt: rt2 } = await env.openRuntime();
    const session2 = await rt2.createSession({
      model: "fake/fake-model",
      permissionPreset: "default",
    });
    openSessions.push(session2);
    expect(session2.mcpServers()).toMatchObject([{ name: "demo", state: "standby" }]);

    const onDemandRes = await session2.readAppResource({
      pluginId: "nocturne:mcp-apps-demo@builtin",
      serverId: "demo",
      uri: "ui://demo/viewer.html",
    });
    expect(onDemandRes.html).toContain("示例面板");
    expect(session2.mcpServers()).toMatchObject([{ name: "demo", state: "ready" }]);

    // default 预设下页面调用只读工具不弹确认、直接成功
    const roDefaultRes = await session2.callAppTool({
      pluginId: "nocturne:mcp-apps-demo@builtin",
      serverId: "demo",
      tool: "fetch_app_stats",
      arguments: { section: "default-preset" },
    });
    expect(roDefaultRes.structuredContent).toMatchObject({
      section: "default-preset",
      status: "ok",
    });
  });

  it("readAppResource 拒绝错误 mimeType 与超过 8 MiB；callAppTool 拒绝 visibility 不含 app；open.tool 非只读时跳过并记 warning", async () => {
    const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "nct-mcp-apps-edge-")));
    tmpRoots.push(root);
    const nocturneHome = path.join(root, "home");
    const codexHome = path.join(root, "codex");
    const claudeHome = path.join(root, "claude");
    const ws = path.join(root, "ws");
    const builtinDir = path.join(root, "builtin");
    const pluginDir = path.join(builtinDir, "edge-kit");
    mkdirSync(path.join(pluginDir, ".nocturne-plugin"), { recursive: true });
    mkdirSync(nocturneHome, { recursive: true });
    mkdirSync(codexHome, { recursive: true });
    mkdirSync(claudeHome, { recursive: true });
    mkdirSync(ws, { recursive: true });

    writeFileSync(path.join(pluginDir, "srv.mjs"), INIT_CAPTURE_SERVER);
    writeFileSync(
      path.join(pluginDir, ".nocturne-plugin", "plugin.json"),
      JSON.stringify({
        name: "edge-kit",
        version: "1.0.0",
        mcpServers: {
          edge: { command: "${NOCTURNE_NODE}", args: ["${PLUGIN_ROOT}/srv.mjs"] },
        },
        ui: {
          surfaces: [
            {
              id: "bad-open",
              title: "写入打开不应生效",
              server: "edge",
              resourceUri: "ui://edge/ok.html",
              open: { tool: "write_open_tool", fileTypes: [".edge"] },
            },
          ],
        },
      }),
    );
    writeFileSync(
      path.join(nocturneHome, "config.json"),
      JSON.stringify({ modelsDev: false, skills: { sources: { agents: false, claude: false } } }),
    );

    const plat = {
      ...basePlatform,
      homeDir: () => root,
      nocturneHome: () => nocturneHome,
    };
    const config = await loadConfig(plat, { nocturneHome });
    const rt = await createRuntime({
      config,
      cwd: ws,
      sessionsDir: path.join(nocturneHome, "sessions"),
      providers: [
        new FakeProvider({
          scripts: [
            [
              { type: "text_delta", text: "ok" },
              { type: "finish", reason: "stop" },
            ],
          ],
        }),
      ],
      mcp: createMcpConnector(),
      builtinPluginsDir: builtinDir,
      plugins: { codexHome, claudeHome },
    });
    openRuntimes.push(rt);
    await rt.setPluginEnabled({ id: "nocturne:edge-kit@builtin", enabled: true });

    const session = await rt.createSession({ model: "fake/fake-model" });
    openSessions.push(session);
    await session.submit({ text: "init-edge" });

    // 1) open.tool 指向非只读工具：surface 不带 open，且插件 warnings 有记录
    const surfaces = await session.listAppSurfaces();
    expect(surfaces).toHaveLength(1);
    expect(surfaces[0]?.open).toBeUndefined();
    const desc = await rt.describePlugins();
    const edgePlugin = desc.plugins.find((p) => p.id === "nocturne:edge-kit@builtin");
    expect(edgePlugin?.warnings.some((w) => w.includes("write_open_tool"))).toBe(true);

    // 2) readAppResource 拒绝错误 mimeType 与超 8 MiB
    await expect(
      session.readAppResource({
        pluginId: "nocturne:edge-kit@builtin",
        serverId: "edge",
        uri: "ui://bad/mime.html",
      }),
    ).rejects.toThrow(/mimeType|text\/html;profile=mcp-app/);

    await expect(
      session.readAppResource({
        pluginId: "nocturne:edge-kit@builtin",
        serverId: "edge",
        uri: "ui://bad/oversize.html",
      }),
    ).rejects.toThrow(/8 MiB|上限/);

    // 3) callAppTool 拒绝 visibility 不含 "app" 的工具
    await expect(
      session.callAppTool({
        pluginId: "nocturne:edge-kit@builtin",
        serverId: "edge",
        tool: "model_only_tool",
        arguments: {},
      }),
    ).rejects.toThrow(/不允许页面调用/);
  });
});
