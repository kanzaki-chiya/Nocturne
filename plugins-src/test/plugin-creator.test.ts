import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";
import { createPlatform, createRuntime, loadConfig, type Runtime } from "@nocturne/core";

import {
  createPluginCreatorServer,
  PLUGIN_CREATOR_TOOLS,
  type CheckPluginOutput,
} from "../src/servers/plugin-creator.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgDir = path.resolve(here, "..");
const repoRoot = path.resolve(pkgDir, "..");
const builtPluginDir = path.join(repoRoot, "plugins", "plugin-creator");
const examplesDocPath = path.join(
  pkgDir,
  "manifests",
  "plugin-creator",
  "skills",
  "plugin-creator",
  "references",
  "hooks-and-mcp-examples.md",
);

const tmpDirs: string[] = [];
const openRuntimes: Runtime[] = [];
const spawnedProcs: ChildProcess[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function writeFiles(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content, "utf8");
  }
}

function parseCheckText(result: { content: { type: string; text?: string }[] }): CheckPluginOutput {
  const first = result.content[0];
  if (first?.type !== "text" || typeof first.text !== "string") {
    throw new Error("Expected JSON text content from check_plugin");
  }
  return JSON.parse(first.text) as CheckPluginOutput;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

class StdioMcpClient {
  readonly proc: ChildProcess;
  private nextId = 1;
  private readonly pending = new Map<number, (msg: JsonRpcResponse) => void>();

  constructor(scriptPath: string) {
    this.proc = spawn(process.execPath, [scriptPath], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    spawnedProcs.push(this.proc);
    if (!this.proc.stdout) throw new Error("Child stdout unavailable");
    const rl = createInterface({ input: this.proc.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      const msg = JSON.parse(trimmed) as JsonRpcResponse;
      if (typeof msg.id === "number") {
        const resolver = this.pending.get(msg.id);
        if (resolver) {
          this.pending.delete(msg.id);
          resolver(msg);
        }
      }
    });
  }

  request(method: string, params?: Record<string, unknown>): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      this.pending.set(id, resolve);
      this.proc.stdin?.write(`${payload}\n`, (err) => {
        if (err) reject(err);
      });
    });
  }

  notify(method: string, params?: Record<string, unknown>): void {
    this.proc.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  async close(): Promise<void> {
    if (this.proc.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      this.proc.once("exit", () => {
        resolve();
      });
      this.proc.stdin?.end();
      this.proc.kill();
    });
  }
}

/** 从 references/hooks-and-mcp-examples.md 按小节提取每个示例插件的文件映射 */
function extractReferenceExamples(markdown: string): {
  pluginName: string;
  files: Record<string, string>;
}[] {
  const sections = markdown.split(/^## \d+\.\s+/m).slice(1);
  const examples: { pluginName: string; files: Record<string, string> }[] = [];
  const fileBlockRe = /`([^`\n]+)`：\r?\n\r?\n```[a-zA-Z0-9_-]*\r?\n([\s\S]*?)```/g;

  for (const section of sections) {
    const nameMatch = /`([a-z0-9-]+)`/.exec(section.split(/\r?\n/, 1)[0] ?? "");
    if (!nameMatch?.[1]) continue;
    const files: Record<string, string> = {};
    for (const match of section.matchAll(fileBlockRe)) {
      const relPath = match[1];
      const content = match[2];
      if (relPath !== undefined && content !== undefined) {
        files[relPath] = content;
      }
    }
    if (Object.keys(files).length > 0) {
      examples.push({ pluginName: nameMatch[1], files });
    }
  }
  return examples;
}

afterEach(async () => {
  for (const proc of spawnedProcs.splice(0)) {
    if (proc.exitCode === null) proc.kill();
  }
  for (const rt of openRuntimes.splice(0)) {
    await rt.close().catch(() => undefined);
  }
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("plugin-creator MCP server: check_plugin", () => {
  it("只暴露一个只读工具 check_plugin（readOnlyHint: true）", () => {
    expect(PLUGIN_CREATOR_TOOLS).toHaveLength(1);
    const tool = PLUGIN_CREATOR_TOOLS[0];
    expect(tool?.name).toBe("check_plugin");
    expect(tool?.annotations?.readOnlyHint).toBe(true);
  });

  it("检查最小技能插件：返回 installable=true、id、版本与技能清单，且不写文件", async () => {
    const home = makeTempDir("pc-home-");
    const pluginDir = makeTempDir("pc-min-skill-");
    writeFiles(pluginDir, {
      ".nocturne-plugin/plugin.json": JSON.stringify({
        name: "mini-skill",
        version: "0.2.0",
        description: "最小技能插件",
        skills: "./skills",
      }),
      "skills/hello/SKILL.md": "---\nname: hello\ndescription: 打招呼\n---\n说你好",
    });

    const server = createPluginCreatorServer({ nocturneHome: home });
    const handler = server.handlers.check_plugin;
    expect(handler).toBeDefined();
    if (!handler) return;

    const res = await handler({ path: pluginDir });
    expect(res.isError).not.toBe(true);
    const data = parseCheckText(res);
    expect(data.installable).toBe(true);
    expect(data.errors).toEqual([]);
    expect(data.pluginId).toBe("nocturne:mini-skill@local");
    expect(data.version).toBe("0.2.0");
    expect(data.skills).toEqual(["hello"]);
    expect(data.hooks).toEqual([]);
    expect(data.mcpServers).toEqual([]);
    expect(data.installTimeChecks.some((c) => c.includes("安装时才会检查"))).toBe(true);
    expect(existsSync(path.join(home, "plugins"))).toBe(false);
  });

  it("拒绝非法 name、路径越出根目录与无可用能力", async () => {
    const server = createPluginCreatorServer();
    const handler = server.handlers.check_plugin;
    expect(handler).toBeDefined();
    if (!handler) return;

    // 1. 非法 name
    const badNameDir = makeTempDir("pc-bad-name-");
    writeFiles(badNameDir, {
      ".nocturne-plugin/plugin.json": JSON.stringify({
        name: "Invalid_Name",
        version: "1.0.0",
      }),
      "skills/s/SKILL.md": "---\ndescription: s\n---\nbody",
    });
    const badNameRes = parseCheckText(await handler({ path: badNameDir }));
    expect(badNameRes.installable).toBe(false);
    expect(badNameRes.errors.some((e) => e.includes("只允许小写字母"))).toBe(true);

    // 2. 路径越出根目录
    const escapeDir = makeTempDir("pc-escape-");
    writeFiles(escapeDir, {
      ".nocturne-plugin/plugin.json": JSON.stringify({
        name: "escape-demo",
        version: "1.0.0",
        skills: "./../../outside",
      }),
    });
    const escapeRes = parseCheckText(await handler({ path: escapeDir }));
    expect(escapeRes.installable).toBe(false);
    expect(escapeRes.errors.some((e) => e.includes("越出插件目录"))).toBe(true);

    // 3. 没有任何可用能力
    const emptyDir = makeTempDir("pc-empty-");
    writeFiles(emptyDir, {
      ".nocturne-plugin/plugin.json": JSON.stringify({
        name: "empty-demo",
        version: "1.0.0",
      }),
    });
    const emptyRes = parseCheckText(await handler({ path: emptyDir }));
    expect(emptyRes.installable).toBe(false);
    expect(
      emptyRes.errors.some((e) => e.includes("不包含可用的技能、Hook、MCP 服务器或子代理")),
    ).toBe(true);
  });

  it("列出被跳过的 MCP 条目及其原因，且拒绝相对路径输入", async () => {
    const server = createPluginCreatorServer();
    const handler = server.handlers.check_plugin;
    expect(handler).toBeDefined();
    if (!handler) return;

    const mixedDir = makeTempDir("pc-skipped-mcp-");
    writeFiles(mixedDir, {
      ".nocturne-plugin/plugin.json": JSON.stringify({
        name: "mixed-mcp",
        version: "0.1.0",
        mcpServers: {
          okSrv: { command: "${NOCTURNE_NODE}", args: ["${PLUGIN_ROOT}/ok.mjs"] },
          httpSrv: { type: "http", url: "https://example.com/mcp" },
          storedSrv: {
            command: "${NOCTURNE_NODE}",
            args: ["${PLUGIN_ROOT}/s.mjs"],
            env: { TOKEN: { stored: true } },
          },
        },
      }),
      "ok.mjs": "export {};",
    });

    const data = parseCheckText(await handler({ path: mixedDir }));
    expect(data.installable).toBe(true);
    expect(data.mcpServers).toEqual([
      { id: "okSrv", command: "${NOCTURNE_NODE} ${PLUGIN_ROOT}/ok.mjs" },
      {
        id: "httpSrv",
        command: "https://example.com/mcp",
        skipped: true,
        skipReason: "http",
        skipReasonLabel: "不支持 HTTP",
      },
      {
        id: "storedSrv",
        command: "${NOCTURNE_NODE} ${PLUGIN_ROOT}/s.mjs",
        skipped: true,
        skipReason: "stored",
        skipReasonLabel: "不支持凭据库",
      },
    ]);
    expect(data.skipped).toEqual([
      { kind: "mcp", target: "mcp:httpSrv", reason: "http", reasonLabel: "不支持 HTTP" },
      { kind: "mcp", target: "mcp:storedSrv", reason: "stored", reasonLabel: "不支持凭据库" },
    ]);

    await expect(handler({ path: "relative/plugin" })).rejects.toThrow(/absolute path/i);
  });
});

describe("references 示例端到端：check_plugin → 安装 → 发现 → 启用 → 运行验证", () => {
  it("references/hooks-and-mcp-examples.md 的全部三个示例均通过校验、安装、启用并真实可运行", async () => {
    const markdown = readFileSync(examplesDocPath, "utf8");
    const examples = extractReferenceExamples(markdown);
    expect(examples.map((e) => e.pluginName)).toEqual([
      "hello-skill",
      "hook-guard",
      "text-metrics",
    ]);

    const home = makeTempDir("pc-e2e-home-");
    const ws = makeTempDir("pc-e2e-ws-");
    const sessionsDir = makeTempDir("pc-e2e-sessions-");
    writeFileSync(
      path.join(home, "config.json"),
      JSON.stringify({ modelsDev: false, skills: { sources: { agents: false, claude: false } } }),
      "utf8",
    );

    const platform = createPlatform();
    const config = await loadConfig(platform, { nocturneHome: home, env: () => undefined });
    const rt = await createRuntime({
      cwd: ws,
      sessionsDir,
      config,
      interactive: false,
      plugins: {
        codexHome: path.join(home, "empty-codex"),
        claudeHome: path.join(home, "empty-claude"),
      },
    });
    openRuntimes.push(rt);

    const server = createPluginCreatorServer({ nocturneHome: home });
    const handler = server.handlers.check_plugin;
    expect(handler).toBeDefined();
    if (!handler) return;

    for (const example of examples) {
      const srcDir = path.join(ws, "plugins", example.pluginName);
      writeFiles(srcDir, example.files);

      // 1. check_plugin 校验通过
      const checkRes = parseCheckText(await handler({ path: srcDir }));
      expect(checkRes.installable, example.pluginName).toBe(true);
      expect(checkRes.errors, example.pluginName).toEqual([]);
      expect(checkRes.pluginId).toBe(`nocturne:${example.pluginName}@local`);

      // 2. Core 安装到隔离 NOCTURNE_HOME
      const installed = await rt.installLocalPlugin({ path: srcDir });
      expect(installed.id).toBe(`nocturne:${example.pluginName}@local`);
      expect(installed.state).toBe("off");

      // 3. 启用并确认发现状态为 on
      await rt.setPluginEnabled({ id: installed.id, enabled: true });
      const described = await rt.describePlugins();
      const found = described.plugins.find((p) => p.id === installed.id);
      expect(found?.state).toBe("on");

      // 4. 真实运行 Hook 与 MCP 示例脚本，确认不是空壳
      if (example.pluginName === "hook-guard") {
        const script = path.join(installed.root, "hooks", "guard.mjs");
        const startOut = execFileSync(process.execPath, [script], {
          input: JSON.stringify({ point: "SessionStart" }),
          encoding: "utf8",
        });
        expect(JSON.parse(startOut)).toEqual({
          additionalContext: expect.stringContaining("命令守卫") as unknown,
        });

        const denyOut = execFileSync(process.execPath, [script], {
          input: JSON.stringify({
            point: "PreToolUse",
            tool: "shell",
            input: { command: "rm -rf /" },
          }),
          encoding: "utf8",
        });
        expect(JSON.parse(denyOut)).toMatchObject({ decision: "deny" });
      }

      if (example.pluginName === "text-metrics") {
        const client = new StdioMcpClient(path.join(installed.root, "server.mjs"));
        try {
          const init = await client.request("initialize", {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "test", version: "0.0.1" },
          });
          expect(init.error).toBeUndefined();
          client.notify("notifications/initialized");

          const toolsRes = await client.request("tools/list");
          const tools = (toolsRes.result?.tools ?? []) as { name: string }[];
          expect(tools.map((t) => t.name)).toEqual(["count_text"]);

          const callRes = await client.request("tools/call", {
            name: "count_text",
            arguments: { text: "hello world\nsecond line" },
          });
          expect(callRes.result?.structuredContent).toEqual({
            lines: 2,
            chars: 23,
            words: 4,
          });
        } finally {
          await client.close();
        }
      }
    }
  });

  it("构建后的内置 plugin-creator 服务器可独立通过 stdio 启动并调用 check_plugin", async () => {
    const serverScript = path.join(builtPluginDir, "server.mjs");
    if (!existsSync(serverScript)) {
      execFileSync(process.execPath, [path.join(pkgDir, "scripts", "build.mjs")], {
        cwd: pkgDir,
        stdio: "pipe",
      });
    }
    expect(existsSync(path.join(builtPluginDir, ".nocturne-plugin", "plugin.json"))).toBe(true);
    expect(existsSync(path.join(builtPluginDir, ".nocturne-plugin", "build-id"))).toBe(true);
    expect(existsSync(path.join(builtPluginDir, "icon.svg"))).toBe(true);
    expect(existsSync(path.join(builtPluginDir, "skills", "plugin-creator", "SKILL.md"))).toBe(
      true,
    );
    expect(existsSync(path.join(builtPluginDir, "viewer.html"))).toBe(false);

    const sampleDir = makeTempDir("pc-stdio-sample-");
    writeFiles(sampleDir, {
      ".nocturne-plugin/plugin.json": JSON.stringify({
        name: "stdio-ok",
        version: "0.1.0",
        description: "stdio 冒烟测试",
      }),
      "skills/smoke/SKILL.md": "---\ndescription: smoke\n---\nSmoke body",
    });

    const client = new StdioMcpClient(serverScript);
    try {
      const init = await client.request("initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test", version: "0.0.1" },
      });
      expect(init.error).toBeUndefined();
      client.notify("notifications/initialized");

      const listRes = await client.request("tools/list");
      const tools = (listRes.result?.tools ?? []) as {
        name: string;
        annotations?: { readOnlyHint?: boolean };
      }[];
      expect(tools).toHaveLength(1);
      expect(tools[0]?.name).toBe("check_plugin");
      expect(tools[0]?.annotations?.readOnlyHint).toBe(true);

      const callRes = await client.request("tools/call", {
        name: "check_plugin",
        arguments: { path: sampleDir },
      });
      const content = (callRes.result?.content ?? []) as { type: string; text?: string }[];
      const parsed = parseCheckText({ content });
      expect(parsed.installable).toBe(true);
      expect(parsed.pluginId).toBe("nocturne:stdio-ok@local");
      expect(parsed.skills).toEqual(["smoke"]);
    } finally {
      await client.close();
    }
  });
});
