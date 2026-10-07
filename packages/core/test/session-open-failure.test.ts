import { mkdtemp, rm } from "node:fs/promises";
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
import type { McpConnector, McpSession } from "../src/tools/types.js";

// 打开失败不留 Runtime 级残留（sessions.md 第 4 节）；配置广播逐会话隔离（mcp.md 第 4 节）

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function setup() {
  const home = await mkdtemp(path.join(tmpdir(), "nct-open-fail-"));
  roots.push(home);
  const platform = createPlatform();
  const credentials = (await createCredentialStore(platform, home, { backend: "memory" })).store;
  const config = await loadConfig(platform, {
    nocturneHome: home,
    credentials,
    env: () => undefined,
  });
  return { home, platform, credentials, config, sessionsDir: path.join(home, "sessions") };
}

function fakeMcpSession(overrides: Partial<McpSession> = {}): McpSession {
  return {
    tools: () => [],
    status: () => [],
    reconcile: async () => undefined,
    applyPendingTools: () => ({ add: [], remove: [] }),
    close: async () => undefined,
    ...overrides,
  };
}

describe("会话打开失败的清理", () => {
  it("恢复因模型无法解析失败后，配置广播正常、不计入会话数、可带替代模型重新打开", async () => {
    const { home, config, sessionsDir } = await setup();
    // 先用一个之后不再存在的服务商建会话
    const before = await createRuntime({
      cwd: home,
      sessionsDir,
      config,
      providers: [new FakeProvider({ id: "gone" })],
    });
    const created = await before.createSession({ model: "gone/fake-1" });
    const id = created.id;
    await created.close();

    const close = vi.fn(async () => undefined);
    const open = vi.fn<McpConnector["open"]>(async () => fakeMcpSession({ close }));
    const runtime = await createRuntime({
      cwd: home,
      sessionsDir,
      config,
      providers: [new FakeProvider({})],
      mcp: { probe: async () => ({ ok: true, durationMs: 0, tools: [] }), open },
    });

    const failure: unknown = await runtime.resumeSession(id).then(
      () => {
        throw new Error("模型无法解析的会话不应恢复成功");
      },
      (e: unknown) => e,
    );
    expect(failure).toMatchObject({ code: "invalid_model" });
    // Core 只给中性说明；--model、resumeSession 是客户端用法，不进 Core 文案
    const failureText = failure instanceof Error ? failure.message : "";
    expect(failureText).toContain("恢复时可指定替代模型");
    expect(failureText).not.toContain("--model");
    expect(failureText).not.toContain("resumeSession");
    // 打开途中已启动的 MCP 连接随失败关闭
    expect(open).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();

    await expect(
      runtime.saveMcpServer({ mode: "create", id: "srv", config: { command: "node" } }),
    ).resolves.toBeDefined();
    await expect(runtime.setSkillEnabled({ name: "any", enabled: false })).resolves.toEqual({
      affectedSessions: 0,
    });
    await expect(runtime.updateProviders(await config.reload())).resolves.toBeUndefined();

    // 锁已释放：带替代模型重新打开同一会话
    const resumed = await runtime.resumeSession(id, { model: "fake/fake-1" });
    try {
      expect(resumed.state().config.model).toEqual({ provider: "fake", model: "fake-1" });
      await expect(runtime.setSkillEnabled({ name: "any", enabled: true })).resolves.toEqual({
        affectedSessions: 1,
      });
    } finally {
      await resumed.close();
    }
  });
});

describe("配置广播逐会话隔离", () => {
  it("一个会话的 MCP 更新失败只在该会话发 warning，其余会话照常生效", async () => {
    const { home, config, sessionsDir } = await setup();
    const goodReconcile = vi.fn(async () => undefined);
    let opened = 0;
    const runtime = await createRuntime({
      cwd: home,
      sessionsDir,
      config,
      providers: [new FakeProvider({})],
      mcp: {
        probe: async () => ({ ok: true, durationMs: 0, tools: [] }),
        open: async () =>
          fakeMcpSession({
            reconcile:
              opened++ === 0
                ? async () => {
                    throw new Error("boom");
                  }
                : goodReconcile,
          }),
      },
    });
    const broken = await runtime.createSession({ model: "fake/fake-1" });
    const healthy = await runtime.createSession({ model: "fake/fake-1" });
    const brokenWarnings: unknown[] = [];
    const healthyWarnings: unknown[] = [];
    broken.subscribe((e) => {
      if (e.type === "runtime.warning") brokenWarnings.push(e.payload);
    });
    healthy.subscribe((e) => {
      if (e.type === "runtime.warning") healthyWarnings.push(e.payload);
    });
    try {
      await expect(
        runtime.saveMcpServer({ mode: "create", id: "srv", config: { command: "node" } }),
      ).resolves.toBeDefined();
      expect(goodReconcile).toHaveBeenCalledOnce();
      expect(brokenWarnings).toEqual([
        expect.objectContaining({
          code: "config_apply_failed",
          message: expect.stringContaining("boom"),
        }),
      ]);
      expect(healthyWarnings).toEqual([]);
    } finally {
      await broken.close();
      await healthy.close();
    }
  });
});
