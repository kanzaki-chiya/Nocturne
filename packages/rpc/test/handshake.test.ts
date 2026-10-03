import { afterEach, describe, expect, it } from "vitest";

import { RpcError } from "@nocturne/rpc/client";
import { RPC_PROTOCOL_VERSION } from "@nocturne/rpc/server";

import { cleanupTmp, connect, connectRaw, MODEL, textScript } from "./harness.js";

afterEach(cleanupTmp);

describe("握手", () => {
  it("initialize 返回协议版本、nocturne 版本与 sessionsDir", async () => {
    const h = await connect({ initialize: false });
    const result = await h.client.initialize();
    expect(result).toEqual({
      protocolVersion: RPC_PROTOCOL_VERSION,
      nocturneVersion: "0.0.0-test",
      sessionsDir: h.sessionsDir,
    });
    expect(h.inits).toEqual([{ clientName: "rpc-test", interactive: true }]);
    h.client.close();
    await h.served;
  });

  it("协议版本不一致：错误带 data.code，且不创建 Runtime", async () => {
    const raw = await connectRaw();
    raw.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: 999, clientName: "x", capabilities: { interactive: true } },
    });
    const reply = await raw.waitFor((m) => m["id"] === 1);
    expect(reply["error"]).toMatchObject({
      code: -32004,
      data: { code: "protocol_version_mismatch" },
    });
    expect(raw.inits).toEqual([]);
    raw.transport.close();
    await raw.served;
  });

  it("握手前的请求被拒绝 not_initialized；重复握手被拒绝 already_initialized", async () => {
    const h = await connect({ initialize: false });
    await expect(h.client.runtime.listSessions()).rejects.toMatchObject({
      code: "not_initialized",
    });
    await h.client.initialize();
    await expect(h.client.initialize()).rejects.toMatchObject({ code: "already_initialized" });
    h.client.close();
    await h.served;
  });

  it("管线化：initialize 未返回时发出的后续请求等握手结束再处理", async () => {
    const h = await connect({ initialize: false });
    const init = h.client.initialize();
    const listed = h.client.runtime.listSessions();
    await init;
    expect(await listed).toEqual([]);
    h.client.close();
    await h.served;
  });

  it("客户端声明 interactive=false：Runtime 以非交互创建，ask 一律拒绝且不发 permission.requested", async () => {
    const h = await connect({
      interactive: false,
      scripts: [
        [
          {
            type: "tool_call",
            toolCallId: "w1",
            name: "write",
            input: { path: "x.txt", content: "x" },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        textScript("done"),
      ],
    });
    expect(h.inits[0]?.interactive).toBe(false);
    const { session } = await h.client.runtime.createSession({ model: MODEL });
    const events: string[] = [];
    const sources: string[] = [];
    await session.subscribe((e) => {
      events.push(e.type);
      if (e.type === "permission.resolved") sources.push(e.payload.source);
    });
    expect(await session.submit({ text: "write" })).toBe("done");
    expect(events).not.toContain("permission.requested");
    expect(sources).toEqual(["non_interactive"]);
    h.client.close();
    await h.served;
  });
});

describe("报文层", () => {
  it("非法 JSON、批量、缺 method、版本号错误分别返回标准错误码", async () => {
    const raw = await connectRaw();
    raw.sendLine("{not json");
    raw.sendLine("[]");
    raw.send({ jsonrpc: "2.0", id: 7 });
    raw.send({ jsonrpc: "1.0", id: 8, method: "initialize" });
    await raw.waitFor((m) => m["id"] === 8);
    const errors = raw.received.map((m) => (m["error"] as { code: number }).code);
    expect(errors).toEqual([-32700, -32600, -32600, -32600]);
    expect(raw.received[2]?.["id"]).toBe(7);
    raw.transport.close();
    await raw.served;
  });

  it("未知方法 → method_not_found；参数类型不对 → invalid_params", async () => {
    const h = await connect();
    await expect(h.client.call("runtime.nope" as "runtime.listModels", {})).rejects.toMatchObject({
      code: "method_not_found",
      rpcCode: -32601,
    });
    await expect(
      h.client.call("runtime.getPreference", { key: 5 } as unknown as { key: string }),
    ).rejects.toMatchObject({ code: "invalid_params", rpcCode: -32602 });
    const err = await h.client.runtime.getPreference("k").catch((e: unknown) => e);
    expect(err).toBeUndefined();
    h.client.close();
    await h.served;
  });

  it("RpcError 的 code 与进程内错误码等价，message 为原文案", async () => {
    const h = await connect({ scripts: [textScript("x")] });
    const { session } = await h.client.runtime.createSession({ model: MODEL });
    const error = await session.respondPermission("nope", { decision: "allow" }).catch((e) => e);
    expect(error).toBeInstanceOf(RpcError);
    expect(error).toMatchObject({
      code: "unknown_request",
      rpcCode: -32001,
      errorName: "RuntimeCommandError",
      message: "没有等待中的权限请求",
    });
    h.client.close();
    await h.served;
  });
});
