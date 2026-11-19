import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPlatform, createRuntime, loadConfig, type Runtime } from "@nocturne/core";
import { createRuntimeStub } from "@nocturne/core/testing";
import { createMemoryTransportPair, createRpcClient } from "@nocturne/rpc/client";
import { createRpcServer } from "@nocturne/rpc/server";
import { cleanupTmp, tmpDir } from "./harness.js";

afterEach(cleanupTmp);

describe("hooks.describeHooks RPC 往返与远程权限", () => {
  it("返回合并后的用户层与未信任项目 Hook，且远程连接调用被拒绝", async () => {
    const root = tmpDir("nct-rpc-hooks-");
    const home = path.join(root, "home");
    const ws = path.join(root, "project");
    mkdirSync(home, { recursive: true });
    mkdirSync(path.join(ws, ".nocturne"), { recursive: true });

    const userConfigPath = path.join(home, "config.json");
    writeFileSync(
      userConfigPath,
      JSON.stringify({
        modelsDev: false,
        hooks: {
          PreToolUse: [
            { matcher: "shell", command: "node", args: ["./guard.mjs"], timeoutMs: 8000 },
          ],
          TurnEnd: [{ command: "node", args: ["./audit.mjs"] }],
        },
      }),
    );
    writeFileSync(
      path.join(ws, ".nocturne", "config.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [{ command: "node", args: ["./repo-check.mjs"] }],
        },
      }),
    );

    const plat = createPlatform();
    const config = await loadConfig(plat, { nocturneHome: home, env: () => undefined });
    let runtime: Runtime | undefined;
    const server = createRpcServer({
      nocturneVersion: "0.0.0-test",
      createRuntime: async () => {
        runtime = await createRuntime({ cwd: ws, config });
        return { runtime };
      },
    });

    const [cLocal, sLocal] = createMemoryTransportPair();
    const servedLocal = server.serve(sLocal);
    const client = createRpcClient(cLocal, { clientName: "test-local" });

    const [cRemote, sRemote] = createMemoryTransportPair();
    const servedRemote = server.serve(sRemote, { origin: "remote" });
    const remoteClient = createRpcClient(cRemote, { clientName: "test-remote" });

    try {
      await client.initialize();
      await remoteClient.initialize();

      const realProjectConfig = path.join(await plat.resolveReal(ws), ".nocturne", "config.json");
      const desc = await client.runtime.describeHooks({ workspaceRoot: ws });
      expect(desc.hooks).toEqual([
        {
          point: "PreToolUse",
          matcher: "shell",
          command: "node",
          args: ["./guard.mjs"],
          timeoutMs: 8000,
          origin: "user",
          path: userConfigPath,
          trusted: true,
        },
        {
          point: "PreToolUse",
          command: "node",
          args: ["./repo-check.mjs"],
          timeoutMs: 5000,
          origin: "project",
          path: realProjectConfig,
          trusted: false,
        },
        {
          point: "TurnEnd",
          command: "node",
          args: ["./audit.mjs"],
          timeoutMs: 5000,
          origin: "user",
          path: userConfigPath,
          trusted: true,
        },
      ]);

      await client.runtime.setWorkspaceTrusted({ workspace: ws, trusted: true });
      const trustedDesc = await client.runtime.describeHooks({ workspaceRoot: ws });
      expect(trustedDesc.hooks.find((h) => h.origin === "project")?.trusted).toBe(true);

      await expect(remoteClient.runtime.describeHooks({ workspaceRoot: ws })).rejects.toMatchObject(
        { code: "remote_not_allowed" },
      );
    } finally {
      await remoteClient.close();
      await client.shutdown();
      await Promise.all([servedLocal, servedRemote]);
      await runtime?.close();
    }
  });

  it("服务端路由把 workspaceRoot 透传给 Runtime.describeHooks（使用 createRuntimeStub）", async () => {
    const received: (string | undefined)[] = [];
    const server = createRpcServer({
      nocturneVersion: "0.0.0-test",
      createRuntime: async () => ({
        runtime: createRuntimeStub({
          describeHooks: async (input) => {
            received.push(input?.workspaceRoot);
            return { hooks: [], warnings: [] };
          },
        }),
      }),
    });
    const [cEnd, sEnd] = createMemoryTransportPair();
    const served = server.serve(sEnd);
    const client = createRpcClient(cEnd, { clientName: "test-stub" });
    try {
      await client.initialize();
      expect(await client.runtime.describeHooks({ workspaceRoot: "/demo/ws" })).toEqual({
        hooks: [],
        warnings: [],
      });
      expect(received).toEqual(["/demo/ws"]);
    } finally {
      await client.shutdown();
      await served;
    }
  });
});
