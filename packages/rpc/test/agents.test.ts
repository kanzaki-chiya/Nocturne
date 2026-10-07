import { afterEach, expect, it, vi } from "vitest";
import { cleanupTmp, connectWithConfig, MODEL, textScript } from "./harness.js";

afterEach(cleanupTmp);

it("外部 agent 五方法、会话快照、委派和配置通知往返", async () => {
  const probe = vi.fn(async () => ({
    ok: true,
    durationMs: 1,
    agentInfo: { name: "fake-acp", version: "1" },
    authMethods: [{ id: "local", name: "本地登录" }],
    configOptions: [
      {
        id: "model",
        name: "模型",
        currentValue: "offline",
        options: [{ value: "offline", name: "离线" }],
      },
    ],
  }));
  const run = vi.fn();
  const h = await connectWithConfig({
    externalAgents: { run, probe },
    scripts: [textScript("没有执行外部任务")],
  });
  try {
    expect(await h.client.runtime.describeExternalAgents()).toEqual({ agents: [], warnings: [] });
    const { session } = await h.client.runtime.createSession({ model: MODEL });
    expect((await session.describeExternalAgents()).agents).toEqual([]);
    let notifications = 0;
    const off = h.client.onProvidersChanged(() => {
      notifications += 1;
    });
    const saved = await h.client.runtime.saveExternalAgent({
      mode: "create",
      name: "fake",
      config: {
        command: "fake-command",
        args: [],
        enabled: true,
        configOptions: { model: "offline" },
      },
    });
    expect(saved).toMatchObject({ name: "fake", origin: "app", editable: true, enabled: true });
    expect(notifications).toBe(1);
    expect(h.reloadCount()).toBe(0);
    expect((await session.describeExternalAgents()).agents[0]).toMatchObject({ name: "fake" });
    await expect(
      h.client.runtime.saveExternalAgent({
        mode: "create",
        name: "FAKE",
        config: { command: "fake-command", args: [], enabled: true },
      }),
    ).rejects.toMatchObject({ rpcCode: -32005, field: "name" });
    expect(notifications).toBe(1);
    expect(await h.client.runtime.probeExternalAgent({ name: "fake" })).toMatchObject({
      ok: true,
      agentInfo: { name: "fake-acp" },
      configOptions: [{ id: "model" }],
    });
    await h.client.runtime.probeExternalAgent({
      config: { name: "draft", command: "draft-command", args: [], enabled: false },
    });
    expect(probe.mock.calls).toHaveLength(2);
    expect(notifications).toBe(1);
    const task = "保留原文\n第二行  两个空格";
    await session.submit({ text: `/fake ${task}`, delegate: { agent: "fake", task } });
    expect(
      h.durable(session.id).find((event) => event.type === "message.user")?.payload,
    ).toMatchObject({
      delegate: { agent: "fake", task },
    });
    expect(run).not.toHaveBeenCalled();
    await expect(
      h.client.call("session.submit", {
        sessionId: session.id,
        text: "bad",
        delegate: { agent: 42 as never, task: "test" },
      }),
    ).rejects.toMatchObject({ rpcCode: -32602 });
    await expect(
      session.submit({
        text: "bad",
        delegate: { agent: "fake", task },
        skill: { name: "missing" },
      }),
    ).rejects.toMatchObject({ rpcCode: -32001 });
    await h.client.runtime.setExternalAgentEnabled({ name: "fake", enabled: false });
    expect(notifications).toBe(2);
    expect((await session.describeExternalAgents()).agents[0]?.enabled).toBe(false);
    await expect(
      session.submit({ text: "bad", delegate: { agent: "fake", task } }),
    ).rejects.toMatchObject({ rpcCode: -32001 });
    await expect(
      h.client.call("agents.setExternalAgentEnabled", { name: "fake", enabled: "yes" as never }),
    ).rejects.toMatchObject({ rpcCode: -32602 });
    expect(notifications).toBe(2);
    await h.client.runtime.saveExternalAgent({
      mode: "replace",
      name: "fake",
      config: { command: "updated", args: [], enabled: false },
    });
    expect(notifications).toBe(3);
    await h.client.runtime.deleteExternalAgent({ name: "fake" });
    expect(notifications).toBe(4);
    expect((await session.describeExternalAgents()).agents).toEqual([]);
    expect((await h.client.runtime.describeExternalAgents()).agents).toEqual([]);
    const messages = h.wire.map(
      (line) => JSON.parse(line) as { method?: string; id?: number; result?: unknown },
    );
    for (let index = 0; index < messages.length; index += 1) {
      if (messages[index]?.method === "runtime.providersChanged") {
        expect(messages[index + 1]).toHaveProperty("result");
        expect(messages[index + 1]).toHaveProperty("id");
      }
    }
    off();
    await session.close();
  } finally {
    await h.client.shutdown();
    await h.served;
  }
});
