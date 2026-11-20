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
  fileTypes: string[];
  readOnlyTools: string[];
  writeTools: string[];
}

const EXPECTED_PLUGINS: PluginExpectation[] = [
  {
    name: "docx",
    displayName: "Word 文档",
    serverId: "word",
    fileTypes: [".docx", ".doc", ".odt", ".rtf"],
    readOnlyTools: ["read", "render", "show_in_viewer", "read_document", "viewer_asset"],
    writeTools: ["create", "edit", "convert"],
  },
  {
    name: "xlsx",
    displayName: "电子表格",
    serverId: "sheets",
    fileTypes: [".xlsx", ".xls", ".ods"],
    readOnlyTools: ["read", "render", "show_in_viewer", "read_document", "viewer_asset"],
    writeTools: ["create", "edit", "recalculate", "convert"],
  },
  {
    name: "pptx",
    displayName: "演示文档",
    serverId: "slides",
    fileTypes: [".pptx", ".ppt", ".odp"],
    readOnlyTools: ["read", "render", "show_in_viewer", "read_document", "viewer_asset"],
    writeTools: ["create", "edit", "convert"],
  },
  {
    name: "pdf",
    displayName: "PDF",
    serverId: "pdf",
    fileTypes: [".pdf"],
    readOnlyTools: ["read", "render", "show_in_viewer", "read_document", "viewer_asset"],
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
      const topAndCoreFiles = files.filter((f) => !f.startsWith("viewer-assets/"));
      expect(topAndCoreFiles).toEqual(
        [
          ".nocturne-plugin/plugin.json",
          "engine.py",
          "icon.svg",
          "server.mjs",
          `skills/${spec.name}/SKILL.md`,
          "viewer.html",
        ].sort(),
      );

      // Viewer HTML size must stay within ADR-0101 8 MiB cap
      const viewerHtmlBytes = statSync(path.join(dir, "viewer.html")).size;
      expect(viewerHtmlBytes).toBeGreaterThan(100_000);
      expect(viewerHtmlBytes).toBeLessThanOrEqual(8 * 1024 * 1024);

      // Packaged viewer-assets must include manifest, cmaps, Foxit fonts, and wasm — never LiberationSans (GPL-2.0)
      const assetFiles = files.filter((f) => f.startsWith("viewer-assets/"));
      expect(assetFiles).toContain("viewer-assets/manifest.json");
      expect(assetFiles).toContain("viewer-assets/cmaps/UniGB-UCS2-H.bcmap");
      expect(assetFiles).toContain("viewer-assets/standard_fonts/FoxitSerif.pfb");
      expect(assetFiles).toContain("viewer-assets/wasm/jbig2.wasm");
      expect(assetFiles).toContain("viewer-assets/wasm/openjpeg.wasm");
      expect(assetFiles.some((f) => f.includes("LiberationSans"))).toBe(false);
      expect(assetFiles.some((f) => f.includes("node_modules"))).toBe(false);

      // Verify manifest structure including ui.surfaces
      const manifest = JSON.parse(
        readFileSync(path.join(dir, ".nocturne-plugin", "plugin.json"), "utf8"),
      ) as {
        name: string;
        version: string;
        description: string;
        mcpServers: Record<string, { command: string; args: string[] }>;
        interface: { displayName: string; composerIcon: string };
        ui?: {
          surfaces?: {
            id: string;
            title: string;
            server: string;
            resourceUri: string;
            open?: { tool: string; fileTypes: string[] };
          }[];
        };
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
      expect(manifest.ui?.surfaces).toEqual([
        {
          id: "viewer",
          title: spec.displayName,
          server: spec.serverId,
          resourceUri: `ui://${spec.serverId}/viewer.html`,
          open: {
            tool: "show_in_viewer",
            fileTypes: spec.fileTypes,
          },
        },
      ]);

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

        // 2. tools/list and readOnlyHint + _meta.ui accuracy
        const listRes = await client.request("tools/list");
        expect(listRes.error).toBeUndefined();
        const tools = (listRes.result?.tools ?? []) as {
          name: string;
          annotations?: { readOnlyHint?: boolean };
          _meta?: {
            ui?: {
              resourceUri?: string;
              surface?: string;
              visibility?: string[];
            };
          };
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

        const showTool = tools.find((t) => t.name === "show_in_viewer");
        expect(showTool?._meta?.ui).toEqual({
          resourceUri: `ui://${spec.serverId}/viewer.html`,
          surface: "viewer",
          visibility: ["model", "app"],
        });
        expect(tools.find((t) => t.name === "read_document")?._meta?.ui).toEqual({
          visibility: ["app"],
        });
        expect(tools.find((t) => t.name === "viewer_asset")?._meta?.ui).toEqual({
          visibility: ["app"],
        });

        // 2b. resources/list & resources/read for viewer.html
        const resList = await client.request("resources/list");
        expect(resList.error).toBeUndefined();
        const resources = (resList.result?.resources ?? []) as {
          uri: string;
          mimeType: string;
        }[];
        expect(resources).toEqual([
          expect.objectContaining({
            uri: `ui://${spec.serverId}/viewer.html`,
            mimeType: "text/html;profile=mcp-app",
          }),
        ]);

        const resRead = await client.request("resources/read", {
          uri: `ui://${spec.serverId}/viewer.html`,
        });
        expect(resRead.error).toBeUndefined();
        const contents = (resRead.result?.contents ?? []) as {
          uri: string;
          mimeType: string;
          text?: string;
        }[];
        expect(contents[0]?.uri).toBe(`ui://${spec.serverId}/viewer.html`);
        expect(contents[0]?.mimeType).toBe("text/html;profile=mcp-app");
        expect(contents[0]?.text?.includes("<!doctype html>")).toBe(true);

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
