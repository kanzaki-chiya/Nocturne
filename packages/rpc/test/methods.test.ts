import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createRuntime, FakeProvider } from "@nocturne/core";
import type { RuntimeEvent } from "@nocturne/core/protocol";
import { encodeBase64 } from "@nocturne/rpc/client";
import {
  createRpcServer,
  RUNTIME_METHODS,
  RUNTIME_NOT_MAPPED,
  SESSION_METHODS,
  SESSION_NOT_MAPPED,
} from "@nocturne/rpc/server";

import { cleanupTmp, connect, MODEL, textScript, tmpDir, VISION_MODELS } from "./harness.js";

afterEach(cleanupTmp);

const PNG_2x3 = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 2,
  0, 0, 0, 3, 8, 6, 0, 0, 0,
]);

describe("runtime.* 方法映射", () => {
  it("createSession / listSessions / resumeSession / forkSession", async () => {
    const h = await connect({ scripts: [textScript("hello")] });
    const { opened, session } = await h.client.runtime.createSession({ model: MODEL });
    expect(opened).toMatchObject({
      sessionId: session.id,
      config: { model: { provider: "fake", model: "fake-model" }, permissionPreset: "default" },
      warnings: [],
      lastSeq: 1,
    });
    expect(opened.meta.id).toBe(session.id);

    expect(await session.submit({ text: "hi" })).toBe("done");
    const listed = await h.client.runtime.listSessions();
    expect(listed.map((s) => s.id)).toEqual([session.id]);
    expect(await h.client.runtime.listSessions({ cwd: path.join(h.ws, "elsewhere") })).toEqual([]);

    // 同一连接里已打开的会话不能再 resume
    await expect(h.client.runtime.resumeSession(session.id)).rejects.toMatchObject({
      code: "session_already_open",
    });

    const userSeq = (await session.rewindTargets())[0]?.seq ?? 0;
    const forkedId = await h.client.runtime.forkSession(session.id, { targetSeq: userSeq });
    expect(forkedId).not.toBe(session.id);
    await session.close();

    const resumed = await h.client.runtime.resumeSession(forkedId);
    expect(resumed.opened.meta.id).toBe(forkedId);
    expect(resumed.opened.meta.forkedFrom).toMatchObject({ sessionId: session.id });
    await resumed.session.close();

    // 已关闭的会话上的调用报 unknown_session
    await expect(session.state()).rejects.toMatchObject({ code: "unknown_session" });
    h.client.close();
    await h.served;
  });

  it("只读查询与偏好：undefined 在线上是 null，客户端还原", async () => {
    const h = await connect();
    const { runtime } = h.client;
    expect((await runtime.listModels()).map((m) => `${m.ref.provider}/${m.ref.model}`)).toContain(
      MODEL,
    );
    expect(await runtime.defaultModel()).toBeUndefined();
    expect(await runtime.listRecentModels()).toEqual([]);
    expect(await runtime.describeSettings()).toEqual(h.runtimes[0]?.describeSettings());
    expect((await runtime.describeModelRoles()).map((r) => r.role)).toEqual([
      "task",
      "vision",
      "smol",
    ]);
    expect(await runtime.getPreference("theme")).toBeUndefined();
    expect(await runtime.listReviewerProviders()).toEqual([]);
    // 未注入 RuntimeConfig：写偏好被拒绝，文案原样返回
    await expect(runtime.setPreference("theme", "dark")).rejects.toMatchObject({
      rpcCode: -32000,
      message: "未注入 RuntimeConfig，无法保存偏好",
    });
    h.client.close();
    await h.served;
  });

  it("参数校验与 Runtime 拒绝：reasoningEffort、role、model 形状", async () => {
    const h = await connect();
    await expect(
      h.client.runtime.createSession({ model: MODEL, reasoningEffort: "ultra" as "high" }),
    ).rejects.toMatchObject({ code: "invalid_params" });
    await expect(
      h.client.call("runtime.setModelRole", { role: "boss" as "task", ref: null }),
    ).rejects.toMatchObject({ code: "invalid_params" });
    await expect(h.client.runtime.createSession({ model: "no-slash" })).rejects.toMatchObject({
      code: "invalid_command",
      rpcCode: -32001,
    });
    // { provider, model } 形式同样接受
    const { session } = await h.client.runtime.createSession({
      model: { provider: "fake", model: "fake-model" },
    });
    await session.close();
    h.client.close();
    await h.served;
  });
});

describe("session.* 方法映射", () => {
  it("状态、配置与只读查询", async () => {
    const h = await connect({ scripts: [textScript("hello")] });
    writeFileSync(path.join(h.ws, "a.txt"), "x");
    const { session } = await h.client.runtime.createSession({ model: MODEL });
    await session.submit({ text: "hi" });

    const state = await session.state();
    expect(state).toMatchObject({ meta: { id: session.id }, lastSeq: expect.any(Number) });
    expect(state).not.toHaveProperty("history");
    expect(state).not.toHaveProperty("unsettledCalls");

    const context = await session.describeContext();
    expect(context).not.toHaveProperty("request");
    expect(context).toMatchObject({ overBudget: false, mustCompact: false });
    expect(context.report).toBeDefined();

    expect(await session.reasoningEffortInfo()).toMatchObject({ current: "off", available: [] });
    expect(await session.visionInfo()).toMatchObject({ imageInput: true });
    expect((await session.listShells()).length).toBeGreaterThan(0);
    expect(await session.shellInfo()).toMatchObject({ selected: expect.any(String) });
    expect(await session.mcpServers()).toEqual([]);
    expect((await session.fileIndex()).map((e) => e.path)).toContain("a.txt");

    expect(await session.readInputHistory()).toEqual([]);
    await session.recordInputHistory("第一条");
    expect(await session.readInputHistory()).toEqual(["第一条"]);

    await session.setPermissionPreset("auto-edit");
    await session.setModel({ provider: "fake", model: "fake-model" });
    expect((await session.state()).config.permissionPreset).toBe("auto-edit");
    await expect(session.setPermissionPreset("nope")).rejects.toMatchObject({
      code: "invalid_command",
    });
    await expect(session.setReasoningEffort("high")).rejects.toMatchObject({
      code: "invalid_command",
    });
    await expect(session.setShell("no-such-shell")).rejects.toMatchObject({
      code: "invalid_command",
    });
    await session.close();
    h.client.close();
    await h.served;
  });

  it("rewindTargets / rewind(conversation) / compact 的结果与错误经 RPC 透传", async () => {
    const h = await connect({ scripts: [textScript("a"), textScript("b")] });
    const { session } = await h.client.runtime.createSession({ model: MODEL });
    await session.submit({ text: "第一轮" });
    await session.submit({ text: "第二轮" });
    const targets = await session.rewindTargets();
    expect(targets).toHaveLength(2);
    const files = await session.rewind(targets[0]?.seq ?? 0, "conversation");
    expect(files).toEqual([]);
    expect((await session.rewindTargets()).length).toBeLessThanOrEqual(1);
    await expect(session.rewind(9999, "conversation")).rejects.toMatchObject({
      code: "invalid_command",
    });
    // 历史已回退到空：没有可压缩边界，错误码原样返回
    await expect(session.compact()).rejects.toMatchObject({ code: expect.any(String) });
    await session.close();
    h.client.close();
    await h.served;
  });

  it("图片附件以 base64 传输，Core 校验后落盘", async () => {
    const h = await connect({ scripts: [textScript("看到了")] });
    const { session } = await h.client.runtime.createSession({ model: MODEL });
    const events: RuntimeEvent[] = [];
    await session.subscribe((e) => events.push(e));
    await session.submit({
      text: "看 [Image #1]",
      attachments: [{ data: PNG_2x3, mimeType: "image/png", label: "剪贴板" }],
    });
    const user = events.find((e) => e.type === "message.user");
    expect(user?.type === "message.user" && user.payload.attachments?.[0]).toMatchObject({
      file: "img-1.png",
      label: "剪贴板",
    });
    const saved = path.join(h.sessionsDir, "attachments", session.id, "img-1.png");
    expect(new Uint8Array(readFileSync(saved))).toEqual(PNG_2x3);

    // 不是 base64：invalid_params，不进 Runtime
    await expect(
      h.client.call("session.submit", {
        sessionId: session.id,
        text: "x",
        attachments: [{ data: "###", mimeType: "image/png" }],
      }),
    ).rejects.toMatchObject({ code: "invalid_params" });
    await session.close();
    h.client.close();
    await h.served;
  });

  it("base64 编码与 Node Buffer 一致（大数组分块）", () => {
    const big = new Uint8Array(100_000).map((_, i) => i % 251);
    expect(encodeBase64(big)).toBe(Buffer.from(big).toString("base64"));
    expect(encodeBase64(new Uint8Array())).toBe("");
  });
});

describe("公开 API 与 RPC 方法集合一致", () => {
  it("Runtime 与 RuntimeSession 的每个成员要么映射到服务端方法，要么登记了不映射的原因", async () => {
    const runtime = await createRuntime({
      cwd: tmpDir("nct-rpc-cov-ws-"),
      sessionsDir: tmpDir("nct-rpc-cov-sessions-"),
      providers: [new FakeProvider({ scripts: [], models: VISION_MODELS })],
    });
    const session = await runtime.createSession({ model: MODEL });
    const server = createRpcServer({
      nocturneVersion: "0",
      createRuntime: () => Promise.resolve({ runtime }),
    });
    const served = new Set<string>(server.methods);

    const check = (
      publicKeys: string[],
      mapped: Record<string, string>,
      notMapped: Record<string, string>,
    ) => {
      expect(publicKeys.sort()).toEqual([...Object.keys(mapped), ...Object.keys(notMapped)].sort());
      for (const method of Object.values(mapped)) expect(served.has(method)).toBe(true);
    };
    check(Object.keys(runtime), RUNTIME_METHODS, RUNTIME_NOT_MAPPED);
    check(Object.keys(session), SESSION_METHODS, SESSION_NOT_MAPPED);

    // 服务端方法表里的每个 runtime./session. 方法都对应公开成员（unsubscribe 是 subscribe 的退订半边）
    const mappedMethods = new Set<string>([
      ...Object.values(RUNTIME_METHODS),
      ...Object.values(SESSION_METHODS),
      "session.unsubscribe",
    ]);
    for (const method of server.methods) {
      if (method === "initialize" || method === "shutdown") continue;
      expect(mappedMethods.has(method)).toBe(true);
    }
    await session.close();
  });
});
