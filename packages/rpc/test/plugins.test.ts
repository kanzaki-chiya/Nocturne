import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPlatform, createRuntime, loadConfig, type Runtime } from "@nocturne/core";
import { createMemoryTransportPair, createRpcClient } from "@nocturne/rpc/client";
import { createRpcServer } from "@nocturne/rpc/server";
import { cleanupTmp, tmpDir } from "./harness.js";

afterEach(cleanupTmp);

describe("plugins.* RPC 往返与校验", () => {
  it("describePlugins / setPluginEnabled 经 RPC 往返、发 providersChanged、拒绝非法参数与符号链接插件", async () => {
    const root = tmpDir("nct-rpc-plugins-");
    const home = path.join(root, "home");
    const codexHome = path.join(root, "codex");
    const claudeHome = path.join(root, "claude");
    const ws = path.join(root, "ws");
    mkdirSync(home, { recursive: true });
    mkdirSync(codexHome, { recursive: true });
    mkdirSync(claudeHome, { recursive: true });
    mkdirSync(ws, { recursive: true });
    writeFileSync(
      path.join(home, "config.json"),
      JSON.stringify({ modelsDev: false, skills: { sources: { agents: false, claude: false } } }),
    );

    // 正常 Codex 插件
    const okDir = path.join(codexHome, "plugins", "cache", "mkt", "ok", "1.0.0");
    mkdirSync(path.join(okDir, ".codex-plugin"), { recursive: true });
    mkdirSync(path.join(okDir, "skills", "ok-skill"), { recursive: true });
    writeFileSync(
      path.join(okDir, ".codex-plugin", "plugin.json"),
      JSON.stringify({ interface: { displayName: "OK Plugin" } }),
    );
    writeFileSync(
      path.join(okDir, "skills", "ok-skill", "SKILL.md"),
      "---\ndescription: ok\n---\nbody",
    );

    // 含符号链接的插件
    const linkDir = path.join(codexHome, "plugins", "cache", "mkt", "sym", "1.0.0");
    mkdirSync(path.join(linkDir, ".codex-plugin"), { recursive: true });
    writeFileSync(
      path.join(linkDir, ".codex-plugin", "plugin.json"),
      JSON.stringify({
        interface: { displayName: "Sym Plugin" },
        hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo sym" }] }] },
      }),
    );
    const targetDir = path.join(root, "target");
    mkdirSync(targetDir, { recursive: true });
    symlinkSync(
      targetDir,
      path.join(linkDir, "bad-link"),
      process.platform === "win32" ? "junction" : "dir",
    );

    writeFileSync(
      path.join(codexHome, "config.toml"),
      `[plugins."ok@mkt"]\nenabled = true\n\n[plugins."sym@mkt"]\nenabled = true\n`,
    );

    const plat = createPlatform();
    const config = await loadConfig(plat, { nocturneHome: home });
    let runtime: Runtime | undefined;
    const server = createRpcServer({
      nocturneVersion: "0.0.0-test",
      createRuntime: async () => {
        runtime = await createRuntime({
          cwd: ws,
          sessionsDir: path.join(home, "sessions"),
          config,
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
    const client = createRpcClient(clientTransport, { clientName: "test", interactive: false });
    await client.initialize();

    try {
      const desc = await client.runtime.describePlugins();
      expect(desc.plugins.map((p) => [p.id, p.state])).toEqual([
        ["codex:ok@mkt", "off"],
        ["codex:sym@mkt", "off"],
      ]);

      let notified = false;
      const off = client.onProvidersChanged(() => {
        notified = true;
      });
      expect(await client.runtime.setPluginEnabled({ id: "codex:ok@mkt", enabled: true })).toEqual({
        affectedSessions: 0,
      });
      expect(notified).toBe(true);
      off();

      const saved = JSON.parse(readFileSync(path.join(home, "plugins.json"), "utf8"));
      expect(saved.plugins["codex:ok@mkt"]?.enabled).toBe(true);

      await expect(
        client.runtime.setPluginEnabled({ id: "codex:sym@mkt", enabled: true }),
      ).rejects.toMatchObject({ code: "invalid_command" });

      await expect(
        client.call("plugins.setPluginEnabled", { id: "codex:ok@mkt", enabled: "yes" as never }),
      ).rejects.toMatchObject({ rpcCode: -32602 });

      // installLocalPlugin / uninstallPlugin 往返与 providersChanged 通知
      const localSrc = path.join(root, "local-src");
      mkdirSync(path.join(localSrc, ".nocturne-plugin"), { recursive: true });
      mkdirSync(path.join(localSrc, "skills", "rpc-hello"), { recursive: true });
      writeFileSync(
        path.join(localSrc, ".nocturne-plugin", "plugin.json"),
        JSON.stringify({ name: "rpc-demo", version: "1.0.0", description: "RPC 测试插件" }),
      );
      writeFileSync(
        path.join(localSrc, "skills", "rpc-hello", "SKILL.md"),
        "---\ndescription: rpc hello\n---\nHello",
      );

      let notifyCount = 0;
      const offInstall = client.onProvidersChanged(() => {
        notifyCount += 1;
      });
      const installed = await client.runtime.installLocalPlugin({ path: localSrc });
      expect(installed.id).toBe("nocturne:rpc-demo@local");
      expect(installed.state).toBe("off");
      expect(installed.skills).toEqual(["rpc-hello"]);
      expect(notifyCount).toBe(1);

      expect(await client.runtime.uninstallPlugin({ id: installed.id })).toEqual({
        affectedSessions: 0,
      });
      expect(notifyCount).toBe(2);
      offInstall();

      const afterUninstall = await client.runtime.describePlugins();
      expect(afterUninstall.plugins.some((p) => p.id === installed.id)).toBe(false);

      await expect(client.call("plugins.installLocalPlugin", { path: "" })).rejects.toMatchObject({
        rpcCode: -32602,
      });
      await expect(client.call("plugins.uninstallPlugin", { id: "" })).rejects.toMatchObject({
        rpcCode: -32602,
      });
    } finally {
      await client.shutdown();
      await served;
      await runtime?.close();
    }
  });

  it("远程连接禁止调用 plugins.* 方法", async () => {
    const root = tmpDir("nct-rpc-plugins-remote-");
    const home = path.join(root, "home");
    const codexHome = path.join(root, "codex");
    const claudeHome = path.join(root, "claude");
    const ws = path.join(root, "ws");
    mkdirSync(home, { recursive: true });
    mkdirSync(codexHome, { recursive: true });
    mkdirSync(claudeHome, { recursive: true });
    mkdirSync(ws, { recursive: true });
    writeFileSync(
      path.join(home, "config.json"),
      JSON.stringify({ modelsDev: false, skills: { sources: { agents: false, claude: false } } }),
    );

    const plat = createPlatform();
    const config = await loadConfig(plat, { nocturneHome: home });
    let runtime: Runtime | undefined;
    const server = createRpcServer({
      nocturneVersion: "0.0.0-test",
      createRuntime: async () => {
        runtime = await createRuntime({
          cwd: ws,
          sessionsDir: path.join(home, "sessions"),
          config,
          plugins: { codexHome, claudeHome },
        });
        return { runtime };
      },
    });

    const [localClientEnd, localServerEnd] = createMemoryTransportPair();
    const localServed = server.serve(localServerEnd, { origin: "local" });
    const localClient = createRpcClient(localClientEnd, {
      clientName: "local",
      interactive: false,
    });
    await localClient.initialize();

    const [remoteClientEnd, remoteServerEnd] = createMemoryTransportPair();
    const remoteServed = server.serve(remoteServerEnd, { origin: "remote" });
    const remoteClient = createRpcClient(remoteClientEnd, {
      clientName: "remote",
      interactive: false,
    });
    await remoteClient.initialize();

    try {
      await expect(remoteClient.runtime.describePlugins()).rejects.toMatchObject({
        code: "remote_not_allowed",
        rpcCode: -32004,
      });
      await expect(
        remoteClient.runtime.setPluginEnabled({ id: "codex:ok@mkt", enabled: true }),
      ).rejects.toMatchObject({
        code: "remote_not_allowed",
        rpcCode: -32004,
      });
      await expect(remoteClient.runtime.installLocalPlugin({ path: ws })).rejects.toMatchObject({
        code: "remote_not_allowed",
        rpcCode: -32004,
      });
      await expect(
        remoteClient.runtime.uninstallPlugin({ id: "nocturne:demo@local" }),
      ).rejects.toMatchObject({
        code: "remote_not_allowed",
        rpcCode: -32004,
      });
    } finally {
      await localClient.shutdown();
      await Promise.all([localServed, remoteServed]);
      await runtime?.close();
    }
  });
});
