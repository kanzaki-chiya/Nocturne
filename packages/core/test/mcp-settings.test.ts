import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPlatform,
  createCredentialStore,
  loadConfig,
  createRuntime,
  FakeProvider,
} from "../src/index.js";
import { parseConfigFile } from "../src/config/schema.js";
import { mergeLayers } from "../src/config/merge.js";
import type { CredentialStore } from "../src/config/types.js";
import type { McpServerConfig } from "../src/tools/types.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function setup() {
  const home = await mkdtemp(path.join(tmpdir(), "nct-mcp-settings-"));
  roots.push(home);
  const platform = createPlatform();
  const credentials = (await createCredentialStore(platform, home, { backend: "memory" })).store;
  const config = await loadConfig(platform, {
    nocturneHome: home,
    credentials,
    env: () => undefined,
  });
  return { home, platform, credentials, config };
}
const stdio = { command: "node", env: { API_TOKEN: { stored: true as const } } };

describe("MCP schema、层与凭据事务", () => {
  it("混写与非法 URL 逐条忽略并警告，保留合法条目", () => {
    const file = parseConfigFile(
      {
        mcp: {
          servers: {
            good: { command: "node" },
            mixed: { command: "node", url: "https://example.com" },
            unsafe: { type: "http", url: "http://example.com/mcp" },
            lookalike: { type: "http", url: "http://127.evil.example/mcp" },
            loopback: { type: "http", url: "http://127.2.3.4/mcp" },
            ipv6: { type: "http", url: "http://[::1]/mcp" },
          },
        },
      },
      "config.json",
    );
    expect(Object.keys(file.mcp?.servers ?? {})).toEqual(["good", "loopback", "ipv6"]);
    expect(file.mcpWarnings).toHaveLength(3);
    expect(() =>
      parseConfigFile(
        {
          mcp: {
            servers: {
              bad: {
                type: "http",
                url: "https://example.com",
                headers: { Authorization: "Bearer test-token-123" },
              },
            },
          },
        },
        "config.json",
      ),
    ).toThrow(/内联凭据/);
    expect(() =>
      parseConfigFile({ providers: [{ id: "mcp/srv", type: "openai-compatible" }] }, "config.json"),
    ).toThrow();
  });
  it("手写层高于 app，切换类型整条替换", () => {
    const merged = mergeLayers([
      { kind: "app", file: { mcp: { servers: { server: stdio } } } },
      {
        kind: "user",
        file: { mcp: { servers: { server: { type: "http", url: "https://example.com/mcp" } } } },
      },
    ]).resolved;
    expect(merged.mcpServers[0]).toEqual({
      name: "server",
      origin: "user",
      entry: { type: "http", url: "https://example.com/mcp" },
    });
  });
  it("stored 引用无明文落盘，大小写重名拒绝，切换类型与删除清理凭据", async () => {
    const { config, credentials, home } = await setup();
    await config.saveMcpServer({
      mode: "create",
      id: "server",
      config: stdio,
      secrets: { API_TOKEN: "test-token-123" },
    });
    expect(await credentials.get("mcp/server/API_TOKEN")).toBe("test-token-123");
    const text = await readFile(path.join(home, "mcp.json"), "utf8");
    expect(text).not.toContain("test-token-123");
    expect(JSON.stringify(await config.describeMcpServers())).not.toContain("test-token-123");
    await expect(
      config.saveMcpServer({ mode: "create", id: "SERVER", config: { command: "node" } }),
    ).rejects.toMatchObject({ field: "id" });
    await config.saveMcpServer({
      mode: "replace",
      id: "server",
      config: {
        type: "http",
        url: "https://example.com/mcp",
        headers: { Authorization: { stored: true } },
      },
      secrets: { Authorization: "test-token-456" },
    });
    expect(await credentials.get("mcp/server/API_TOKEN")).toBeUndefined();
    expect(await credentials.get("mcp/server/authorization")).toBe("test-token-456");
    await config.deleteMcpServer({ id: "server" });
    expect(await credentials.get("mcp/server/authorization")).toBeUndefined();
  });
  it("配置写失败恢复原密钥、移除新密钥；后端 none 拒绝 stored", async () => {
    const { home, config, credentials, platform } = await setup();
    await config.saveMcpServer({
      mode: "create",
      id: "server",
      config: stdio,
      secrets: { API_TOKEN: "test-token-old" },
    });
    const rename = vi
      .spyOn(platform.fs, "rename")
      .mockRejectedValue(new Error("test write failure"));
    await expect(
      config.saveMcpServer({
        mode: "replace",
        id: "server",
        config: { ...stdio, env: { API_TOKEN: { stored: true }, OTHER_TOKEN: { stored: true } } },
        secrets: { API_TOKEN: "test-token-new", OTHER_TOKEN: "test-token-other" },
      }),
    ).rejects.toThrow("保存失败");
    rename.mockRestore();
    expect(await credentials.get("mcp/server/API_TOKEN")).toBe("test-token-old");
    expect(await credentials.get("mcp/server/OTHER_TOKEN")).toBeUndefined();
    const none: CredentialStore = { ...credentials, backend: () => "none" };
    const disabled = await loadConfig(platform, {
      nocturneHome: home,
      credentials: none,
      env: () => undefined,
    });
    await expect(
      disabled.saveMcpServer({ mode: "create", id: "other", config: stdio }),
    ).rejects.toMatchObject({ field: "secrets" });
  });
  it("损坏文件降级，单条无效不影响其他服务器，未信任项目拒绝探测", async () => {
    const { home, platform, credentials } = await setup();
    await writeFile(path.join(home, "mcp.json"), "broken");
    let config = await loadConfig(platform, {
      nocturneHome: home,
      credentials,
      env: () => undefined,
    });
    expect(config.base.warnings.join()).toContain("mcp_config_invalid");
    await writeFile(
      path.join(home, "mcp.json"),
      JSON.stringify({
        version: 1,
        servers: { good: { command: "node" }, bad: { type: "http", url: "file:///bad" } },
      }),
    );
    config = await config.reload();
    expect(config.base.mcpServers.map((s) => s.name)).toEqual(["good"]);
    const ws = path.join(home, "ws");
    await mkdir(path.join(ws, ".nocturne"), { recursive: true });
    await writeFile(
      path.join(ws, ".nocturne/config.json"),
      JSON.stringify({ mcp: { servers: { untrusted: { command: "bad-command" } } } }),
    );
    const probe = vi.fn(async () => ({ ok: true, tools: [], durationMs: 0 }));
    const runtime = await createRuntime({
      cwd: ws,
      config,
      providers: [new FakeProvider({ scripts: [] })],
      mcp: {
        probe,
        open: async () => ({
          tools: () => [],
          status: () => [],
          reconcile: async () => undefined,
          applyPendingTools: () => ({ add: [], remove: [] }),
          close: async () => undefined,
        }),
      },
    });
    await expect(
      runtime.probeMcpServer({ id: "untrusted", workspaceRoot: ws }),
    ).rejects.toMatchObject({ field: "id" });
    expect(probe).not.toHaveBeenCalled();
    await expect(
      runtime.saveMcpServer({
        mode: "create",
        id: "UNTRUSTED",
        config: { command: "node" },
        workspaceRoot: ws,
      }),
    ).rejects.toMatchObject({ field: "id" });
  });
  it("Turn 内保存暂存到结束边界，空闲重载立即 reconcile", async () => {
    const { config, home } = await setup();
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reconcile = vi.fn(async (_servers: readonly McpServerConfig[]) => undefined);
    const provider = new FakeProvider({
      handler: async () => {
        entered();
        await hold;
        return [{ type: "finish", reason: "stop" }];
      },
    });
    const runtime = await createRuntime({
      cwd: home,
      config,
      providers: [provider],
      mcp: {
        probe: async () => ({ ok: true, durationMs: 0, tools: [] }),
        open: async () => ({
          tools: () => [],
          status: () => [],
          reconcile,
          applyPendingTools: () => ({ add: [], remove: [] }),
          close: async () => undefined,
        }),
      },
    });
    const session = await runtime.createSession({ model: "fake/fake-1" });
    try {
      const turn = session.submit({ text: "test" });
      await started;
      await runtime.saveMcpServer({ mode: "create", id: "new", config: { command: "node" } });
      expect(reconcile).not.toHaveBeenCalled();
      release();
      await turn;
      expect(reconcile).toHaveBeenCalledOnce();
      expect(reconcile.mock.calls[0]?.[0]).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "new" })]),
      );
      await runtime.setMcpServerEnabled({ id: "new", enabled: false });
      expect(reconcile).toHaveBeenCalledTimes(2);
    } finally {
      release();
      await session.close();
    }
  });
});
