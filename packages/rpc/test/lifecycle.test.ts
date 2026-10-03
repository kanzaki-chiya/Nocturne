import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createRuntime, FakeProvider } from "@nocturne/core";
import type { DurableEvent } from "@nocturne/core/protocol";
import { RpcError } from "@nocturne/rpc/client";
import { createMemoryTransportPair, createRpcServer } from "@nocturne/rpc/server";

import { cleanupTmp, connect, MODEL, textScript, until } from "./harness.js";

afterEach(cleanupTmp);

const readLog = (sessionsDir: string, id: string): DurableEvent[] =>
  readFileSync(path.join(sessionsDir, `${id}.jsonl`), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as DurableEvent);

describe("断开与关闭清理", () => {
  it("传输断开：中断运行中的 Turn、关闭全部会话（刷盘、释放会话锁）、释放 Runtime 资源后才结束 serve", async () => {
    const h = await connect({ scripts: [[{ type: "wait", ms: 60_000 }]] });
    const { session } = await h.client.runtime.createSession({ model: MODEL });
    const idle = await h.client.runtime.createSession({ model: MODEL });
    const turn = session.submit({ text: "慢" });
    turn.catch(() => undefined);
    await until(() => h.durable(session.id).some((e) => e.type === "turn.started"), "Turn 开始");
    expect(existsSync(path.join(h.sessionsDir, `${session.id}.lock`))).toBe(true);

    h.clientTransport.close();
    await h.served;

    // 在途的 submit 以连接断开结束，而不是悬挂
    await expect(turn).rejects.toMatchObject({ code: "connection_closed" });
    await h.client.closed;
    expect(h.disposed()).toBe(true);
    for (const id of [session.id, idle.session.id]) {
      expect(existsSync(path.join(h.sessionsDir, `${id}.lock`))).toBe(false);
    }
    // 被中断的 Turn 已收束落盘
    const events = readLog(h.sessionsDir, session.id);
    const completed = events.find((e) => e.type === "turn.completed");
    expect(completed?.type === "turn.completed" && completed.payload.reason).toBe("aborted");

    // 全新的 Runtime 可以直接恢复该会话：没有残留的锁
    const again = await createRuntime({
      cwd: h.ws,
      sessionsDir: h.sessionsDir,
      providers: [new FakeProvider({ scripts: [] })],
    });
    const resumed = await again.resumeSession(session.id);
    expect(resumed.recovery).toBeUndefined();
    await resumed.close();
  });

  it("shutdown 请求：同样清理后回复，再关闭传输", async () => {
    const h = await connect({ scripts: [[{ type: "wait", ms: 60_000 }]] });
    const { session } = await h.client.runtime.createSession({ model: MODEL });
    const turn = session.submit({ text: "慢" });
    await until(() => h.durable(session.id).some((e) => e.type === "turn.started"), "Turn 开始");
    await h.client.shutdown();
    // shutdown 回复之前清理已完成：submit 以 aborted 结束或连接断开，二者其一
    await turn.then(
      (reason) => expect(reason).toBe("aborted"),
      (error: unknown) => expect(error).toBeInstanceOf(RpcError),
    );
    await h.served;
    expect(h.disposed()).toBe(true);
    expect(existsSync(path.join(h.sessionsDir, `${session.id}.lock`))).toBe(false);
    const completed = readLog(h.sessionsDir, session.id).find((e) => e.type === "turn.completed");
    expect(completed?.type === "turn.completed" && completed.payload.reason).toBe("aborted");
  });

  it("握手前断开：不创建 Runtime，serve 正常结束", async () => {
    const h = await connect({ initialize: false });
    h.client.close();
    await h.served;
    expect(h.inits).toEqual([]);
  });

  it("session.close 只关闭那一个会话，其余不受影响", async () => {
    const h = await connect({ scripts: [textScript("a")] });
    const a = await h.client.runtime.createSession({ model: MODEL });
    const b = await h.client.runtime.createSession({ model: MODEL });
    await a.session.close();
    expect(existsSync(path.join(h.sessionsDir, `${a.session.id}.lock`))).toBe(false);
    expect(await b.session.submit({ text: "仍可用" })).toBe("done");
    await h.client.shutdown();
    await h.served;
  });
});

describe("连接约束", () => {
  it("一个服务端同一时刻只接一个客户端", async () => {
    const server = createRpcServer({
      nocturneVersion: "0",
      createRuntime: () => Promise.reject(new Error("不会被调用")),
    });
    const [s1, c1] = createMemoryTransportPair();
    const [s2] = createMemoryTransportPair();
    const first = server.serve(s1);
    await expect(server.serve(s2)).rejects.toThrow("只接一个客户端");
    c1.close();
    await first;
    // 上一个客户端走后可以再接
    const [s3, c3] = createMemoryTransportPair();
    const third = server.serve(s3);
    c3.close();
    await third;
  });

  it("createRuntime 失败：握手报错，连接保持，可重试", async () => {
    let attempts = 0;
    const server = createRpcServer({
      nocturneVersion: "0",
      createRuntime: () => {
        attempts++;
        return attempts === 1
          ? Promise.reject(new Error("配置有误"))
          : Promise.resolve({
              runtime: undefined as never,
            });
      },
    });
    const [serverEnd, clientEnd] = createMemoryTransportPair();
    const served = server.serve(serverEnd);
    const replies: Record<string, unknown>[] = [];
    clientEnd.onLine((line) => replies.push(JSON.parse(line) as Record<string, unknown>));
    clientEnd.onClose(() => undefined);
    const init = (id: number) =>
      clientEnd.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "initialize",
          params: { protocolVersion: 1, clientName: "t", capabilities: { interactive: true } },
        }),
      );
    init(1);
    await until(() => replies.length === 1, "第一次握手回复");
    expect(replies[0]?.["error"]).toMatchObject({ message: "配置有误" });
    init(2);
    await until(() => replies.length === 2, "第二次握手回复");
    expect(replies[1]?.["result"]).toMatchObject({ protocolVersion: 1 });
    clientEnd.close();
    await served;
  });
});

describe("诊断与密钥", () => {
  it("诊断记录只含方法名与结果，不含任何参数内容", async () => {
    const h = await connect({ scripts: [textScript("ok")] });
    const { session } = await h.client.runtime.createSession({ model: MODEL });
    await session.submit({ text: "sk-SECRET-VALUE-12345" });
    await session.recordInputHistory("sk-SECRET-VALUE-12345");
    await h.client.runtime.setPreference("k", "sk-SECRET-VALUE-12345").catch(() => undefined);
    await h.client.shutdown();
    await h.served;
    const text = JSON.stringify(h.diagnostics);
    expect(text).not.toContain("SECRET");
    expect(h.diagnostics).toContainEqual(
      expect.objectContaining({ kind: "request", method: "session.submit" }),
    );
    expect(h.diagnostics).toContainEqual({ kind: "connection", state: "closed" });
  });
});
