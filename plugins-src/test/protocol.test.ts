import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgDir = path.resolve(here, "..");
const repoRoot = path.resolve(pkgDir, "..");
const pluginsDir = path.join(repoRoot, "plugins");

interface PluginExpectation {
  name: string;
  displayName: string;
  serverId: string;
  readOnlyTools: string[];
  writeTools: string[];
}

const EXPECTED_PLUGINS: PluginExpectation[] = [
  {
    name: "docx",
    displayName: "Word 文档",
    serverId: "word",
    readOnlyTools: ["read", "render"],
    writeTools: ["create", "edit", "convert"],
  },
  {
    name: "xlsx",
    displayName: "电子表格",
    serverId: "sheets",
    readOnlyTools: ["read", "render"],
    writeTools: ["create", "edit", "recalculate", "convert"],
  },
  {
    name: "pptx",
    displayName: "演示文档",
    serverId: "slides",
    readOnlyTools: ["read", "render"],
    writeTools: ["create", "edit", "convert"],
  },
  {
    name: "pdf",
    displayName: "PDF",
    serverId: "pdf",
    readOnlyTools: ["read", "render"],
    writeTools: ["create", "merge", "split"],
  },
];

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

class StdioRpcClient {
  readonly proc: ChildProcess;
  private nextId = 1;
  private readonly pending = new Map<number, (msg: JsonRpcResponse) => void>();

  constructor(scriptPath: string, env: NodeJS.ProcessEnv = process.env) {
    this.proc = spawn(process.execPath, [scriptPath], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    if (!this.proc.stdout) {
      throw new Error("Child process stdout pipe is unavailable");
    }
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
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    });
    return new Promise<JsonRpcResponse>((resolve, reject) => {
      this.pending.set(id, resolve);
      this.proc.stdin?.write(`${payload}\n`, "utf8", (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  notify(method: string, params?: Record<string, unknown>): void {
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      method,
      ...(params !== undefined ? { params } : {}),
    });
    this.proc.stdin?.write(`${payload}\n`, "utf8");
  }

  closeStdinAndWaitExit(): Promise<number | null> {
    return new Promise<number | null>((resolve) => {
      if (this.proc.exitCode !== null) {
        resolve(this.proc.exitCode);
        return;
      }
      this.proc.once("exit", (code) => resolve(code));
      this.proc.stdin?.end();
    });
  }
}

function listFilesRecursive(dir: string, base = dir): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...listFilesRecursive(full, base));
    } else {
      results.push(path.relative(base, full).replace(/\\/g, "/"));
    }
  }
  return results.sort();
}

beforeAll(() => {
  const allBuilt = EXPECTED_PLUGINS.every((p) =>
    existsSync(path.join(pluginsDir, p.name, "server.mjs")),
  );
  if (!allBuilt) {
    execFileSync(process.execPath, [path.join(pkgDir, "scripts", "build.mjs")], {
      cwd: pkgDir,
      stdio: "inherit",
    });
  }
});

describe("built plugins layout, manifests, icons, and skills", () => {
  it("outputs four self-contained plugin directories without node_modules or extra files", () => {
    const pkgVersion = (
      JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8")) as { version: string }
    ).version;

    for (const spec of EXPECTED_PLUGINS) {
      const dir = path.join(pluginsDir, spec.name);
      expect(existsSync(dir)).toBe(true);
      const files = listFilesRecursive(dir);
      expect(files).toEqual(
        [
          ".nocturne-plugin/plugin.json",
          "engine.py",
          "icon.svg",
          "server.mjs",
          `skills/${spec.name}/SKILL.md`,
        ].sort(),
      );

      // Verify manifest structure
      const manifest = JSON.parse(
        readFileSync(path.join(dir, ".nocturne-plugin", "plugin.json"), "utf8"),
      ) as {
        name: string;
        version: string;
        description: string;
        mcpServers: Record<string, { command: string; args: string[] }>;
        interface: { displayName: string; composerIcon: string };
      };
      expect(manifest.name).toBe(spec.name);
      expect(manifest.version).toBe(pkgVersion);
      expect(manifest.description.length).toBeGreaterThan(0);
      expect(manifest.interface.displayName).toBe(spec.displayName);
      expect(manifest.interface.composerIcon).toBe("./icon.svg");
      expect(manifest.mcpServers[spec.serverId]).toEqual({
        command: "${NOCTURNE_NODE}",
        args: ["${PLUGIN_ROOT}/server.mjs"],
      });

      // Verify SVG icon rules (<= 64 KB, starts with <svg)
      const iconPath = path.join(dir, "icon.svg");
      const iconBytes = statSync(iconPath).size;
      expect(iconBytes).toBeGreaterThan(0);
      expect(iconBytes).toBeLessThanOrEqual(64 * 1024);
      expect(readFileSync(iconPath, "utf8").trimStart().startsWith("<svg")).toBe(true);

      // Verify SKILL.md frontmatter & description length <= 250
      const skillText = readFileSync(path.join(dir, "skills", spec.name, "SKILL.md"), "utf8");
      const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---/.exec(skillText);
      const frontmatter = fmMatch?.[1] ?? "";
      expect(frontmatter.length).toBeGreaterThan(0);
      const descMatch = /^description:\s*(.+)$/m.exec(frontmatter);
      const descText = descMatch?.[1]?.trim() ?? "";
      expect(descText.length).toBeGreaterThan(0);
      expect(descText.length).toBeLessThanOrEqual(250);
      expect(skillText).toContain("https://www.libreoffice.org/download/");
      expect(skillText).toContain("libreoffice_not_found");
      expect(skillText).toContain("libreoffice_uno_unavailable");
    }
  });
});

describe("MCP stdio protocol on built server.mjs", () => {
  it.each(EXPECTED_PLUGINS)(
    "$name ($serverId): initialize, tools/list with readOnlyHint, unknown method error, stdin close exit",
    async (spec) => {
      const serverScript = path.join(pluginsDir, spec.name, "server.mjs");
      const client = new StdioRpcClient(serverScript);

      try {
        // 1. initialize
        const initRes = await client.request("initialize", {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test-client", version: "1.0.0" },
        });
        expect(initRes.error).toBeUndefined();
        const serverInfo = initRes.result?.serverInfo as { name: string; version: string };
        expect(serverInfo.name).toBe(spec.serverId);
        expect(initRes.result?.capabilities).toHaveProperty("tools");

        client.notify("notifications/initialized");

        // 2. tools/list and readOnlyHint accuracy
        const listRes = await client.request("tools/list");
        expect(listRes.error).toBeUndefined();
        const tools = (listRes.result?.tools ?? []) as {
          name: string;
          annotations?: { readOnlyHint?: boolean };
          inputSchema: Record<string, unknown>;
        }[];

        const toolNames = tools.map((t) => t.name).sort();
        expect(toolNames).toEqual([...spec.readOnlyTools, ...spec.writeTools].sort());

        for (const tool of tools) {
          expect(tool.inputSchema.type).toBe("object");
          if (spec.readOnlyTools.includes(tool.name)) {
            expect(tool.annotations?.readOnlyHint, `${spec.name}.${tool.name}`).toBe(true);
          } else {
            expect(tool.annotations?.readOnlyHint, `${spec.name}.${tool.name}`).not.toBe(true);
          }
        }

        // 3. Unknown method returns JSON-RPC error
        const unknownRes = await client.request("nonexistent/method");
        expect(unknownRes.error).toBeDefined();
        expect(unknownRes.error?.code).toBe(-32601);
      } finally {
        // 4. Closing stdin exits server process cleanly
        const exitCode = await client.closeStdinAndWaitExit();
        expect(exitCode).toBe(0);
      }
    },
  );
});
