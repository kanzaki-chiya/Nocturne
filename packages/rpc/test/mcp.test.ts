import { afterEach, expect, it } from "vitest";
import { cleanupTmp, connectWithConfig } from "./harness.js";
afterEach(cleanupTmp);

it("mcp 五个方法往返、字段错误与凭据不进入响应", async () => {
  const h = await connectWithConfig({
    mcp: {
      probe: async (scope) => {
        expect(await scope.credentials?.get("mcp/fake/TEST_TOKEN")).toBe("test-token-123");
        return { ok: true, durationMs: 1, tools: [{ name: "echo" }], stderrTail: [] };
      },
      open: async () => ({
        startup: async () => undefined,
        tools: () => [],
        status: () => [],
        reconcile: async () => undefined,
        applyPendingTools: () => ({ add: [], remove: [] }),
        close: async () => undefined,
      }),
    },
  });
  try {
    expect(await h.client.runtime.describeMcpServers()).toMatchObject({ servers: [] });
    const server = await h.client.runtime.saveMcpServer({
      mode: "create",
      id: "fake",
      config: { command: "node", env: { TEST_TOKEN: { stored: true } } },
      secrets: { TEST_TOKEN: "test-token-123" },
    });
    expect(server).toMatchObject({
      id: "fake",
      origin: "app",
      editable: true,
      env: [{ name: "TEST_TOKEN", kind: "stored", stored: "set" }],
    });
    expect(h.wire.join()).not.toContain("test-token-123");
    await expect(
      h.client.runtime.saveMcpServer({ mode: "create", id: "FAKE", config: { command: "node" } }),
    ).rejects.toMatchObject({ rpcCode: -32005, field: "id" });
    await h.client.runtime.setMcpServerEnabled({ id: "fake", enabled: false });
    expect((await h.client.runtime.describeMcpServers()).servers[0]?.enabled).toBe(false);
    expect(await h.client.runtime.probeMcpServer({ id: "fake" })).toMatchObject({
      ok: true,
      tools: [{ name: "echo" }],
    });
    await expect(h.client.runtime.probeMcpServer({ id: "missing" })).rejects.toMatchObject({
      rpcCode: -32005,
      field: "id",
    });
    expect(h.wire.join()).not.toContain("test-token-123");
    await h.client.runtime.deleteMcpServer({ id: "fake" });
    expect((await h.client.runtime.describeMcpServers()).servers).toEqual([]);
    expect(await h.credentials.get("mcp/fake/TEST_TOKEN")).toBeUndefined();
  } finally {
    await h.client.shutdown();
    await h.served;
  }
});
