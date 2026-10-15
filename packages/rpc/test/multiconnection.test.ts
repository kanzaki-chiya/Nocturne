import { existsSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { RuntimeEvent } from "@nocturne/core/protocol";
import { createMemoryTransportPair, REMOTE_METHODS } from "@nocturne/rpc/server";
import { cleanupTmp, connectMany, connectWithConfig, MODEL, textScript, until } from "./harness.js";
import { createRpcClient } from "@nocturne/rpc/client";

afterEach(cleanupTmp);

describe("多连接共享后台", () => {
  it("远程模型读方法不再限定工作区，cwd 过滤不受限", async () => {
    const h = await connectMany();
    const remote = await h.add();
    const workspaceRoot = path.dirname(h.ws);
    for (const method of ["runtime.listModels", "runtime.defaultModel"] as const) {
      expect(await remote.client.call(method, { workspaceRoot })).toEqual(
        await h.client.call(method, { workspaceRoot }),
      );
      await remote.client.call(method, {});
    }
    await remote.client.runtime.listSessions({ cwd: workspaceRoot });
    await h.client.shutdown();
    await Promise.all([h.served, remote.served]);
  });

  it("远程模型读方法接受已知工作区", async () => {
    const h = await connectMany();
    await h.client.runtime.createSession({ model: MODEL, cwd: h.ws });
    const remote = await h.add();
    for (const method of ["runtime.listModels", "runtime.defaultModel"] as const) {
      expect(await remote.client.call(method, { workspaceRoot: h.ws })).toEqual(
        await h.client.call(method, { workspaceRoot: h.ws }),
      );
    }
    await h.client.shutdown();
    await Promise.all([h.served, remote.served]);
  });

  it("远程先握手报 runtime_unavailable，本机握手后可重试且只创建一次 Runtime", async () => {
    const h = await connectMany({ initialize: false });
    const remote = await h.add("remote", false);
    await expect(remote.client.initialize()).rejects.toMatchObject({
      code: "runtime_unavailable",
      rpcCode: -32004,
    });
    const localInit = await h.client.initialize();
    expect(await remote.client.initialize()).toEqual(localInit);
    expect(h.inits).toHaveLength(1);
    await h.client.shutdown();
    await h.served;
    await remote.served;
  });

  it("第二条本机连接被拒绝，远程连接数量不限", async () => {
    const h = await connectMany();
    const [transport, peer] = createMemoryTransportPair();
    await expect(h.server.serve(transport)).rejects.toThrow("只接一个客户端");
    peer.close();
    const a = await h.add();
    const b = await h.add();
    await h.client.shutdown();
    await Promise.all([h.served, a.served, b.served]);
  });

  it("共享会话各自回放 afterSeq 与实时事件，无重复且同连接重复打开仍被拒", async () => {
    const h = await connectMany({ scripts: [textScript("一"), textScript("二")] });
    const { session: a } = await h.client.runtime.createSession({ model: MODEL });
    const eventsA: RuntimeEvent[] = [];
    await a.subscribe((e) => eventsA.push(e));
    await a.submit({ text: "一" });
    const before = (await a.state()).lastSeq;
    const remote = await h.add();
    const { session: b, opened } = await remote.client.runtime.resumeSession(a.id);
    expect(opened.lastSeq).toBe(before);
    const eventsB: RuntimeEvent[] = [];
    await b.subscribe((e) => eventsB.push(e), { afterSeq: before - 1 });
    await b.submit({ text: "二" });
    const seqs = eventsB.filter((e) => "seq" in e).map((e) => e.seq);
    expect(seqs[0]).toBe(before);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(eventsA.some((e) => e.type === "turn.completed")).toBe(true);
    expect(eventsB.some((e) => e.type === "turn.completed")).toBe(true);
    await expect(remote.client.runtime.resumeSession(a.id)).rejects.toMatchObject({
      code: "session_already_open",
    });
    await h.client.shutdown();
    await Promise.all([h.served, remote.served]);
  });

  it("A 关闭不影响 B submit，最后引用关闭释放锁", async () => {
    const h = await connectMany({ scripts: [textScript("ok")] });
    const { session: a } = await h.client.runtime.createSession({ model: MODEL });
    const remote = await h.add();
    const { session: b } = await remote.client.runtime.resumeSession(a.id);
    const lock = path.join(h.sessionsDir, `${a.id}.lock`);
    await a.close();
    expect(existsSync(lock)).toBe(true);
    expect(await b.submit({ text: "ok" })).toBe("done");
    await b.close();
    expect(existsSync(lock)).toBe(false);
    await h.client.shutdown();
    await Promise.all([h.served, remote.served]);
  });

  it("关闭后两端并发恢复只取一次锁，同连接并发重复恢复被拒", async () => {
    const h = await connectMany();
    const { session } = await h.client.runtime.createSession({ model: MODEL });
    await session.close();
    const remote = await h.add();
    const [a, b] = await Promise.all([
      h.client.runtime.resumeSession(session.id),
      remote.client.runtime.resumeSession(session.id),
    ]);
    expect(a.opened.lastSeq).toBe(b.opened.lastSeq);
    await a.session.close();
    await b.session.close();
    const results = await Promise.allSettled([
      remote.client.runtime.resumeSession(session.id),
      remote.client.runtime.resumeSession(session.id),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({
      reason: { code: "session_already_open" },
    });
    await h.client.shutdown();
    await Promise.all([h.served, remote.served]);
  });

  it("只有远程引用的 Turn 断开后继续运行，结束后释放锁", async () => {
    const h = await connectMany({ scripts: [[{ type: "wait", ms: 150 }, ...textScript("ok")]] });
    const remote = await h.add();
    const { session } = await remote.client.runtime.createSession({ model: MODEL });
    const turn = session.submit({ text: "慢" });
    const rejected = expect(turn).rejects.toMatchObject({ code: "connection_closed" });
    await until(() => h.provider.requests.length > 0);
    remote.client.close();
    await remote.served;
    await rejected;
    const lock = path.join(h.sessionsDir, `${session.id}.lock`);
    expect(existsSync(lock)).toBe(true);
    await until(() => !existsSync(lock));
    expect(h.durable(session.id).find((e) => e.type === "turn.completed")).toMatchObject({
      payload: { reason: "done" },
    });
    await h.client.shutdown();
    await h.served;
  });

  it("远程 interrupt 通知允许；本机关闭后的服务端可再次握手", async () => {
    const h = await connectMany({ scripts: [[{ type: "wait", ms: 60000 }]] });
    const remote = await h.add();
    const { session } = await remote.client.runtime.createSession({ model: MODEL });
    const turn = session.submit({ text: "慢" });
    await until(() => h.durable(session.id).some((e) => e.type === "turn.started"));
    session.interrupt();
    expect(await turn).toBe("aborted");
    await h.client.shutdown();
    await Promise.all([h.served, remote.served]);
    const local = await h.add("local");
    expect(h.inits).toHaveLength(2);
    await local.client.shutdown();
    await local.served;
  });

  it.each([false, true])(
    "引用归零运行中不关，重新打开=%s，Turn 结束后按引用关闭",
    async (reopen) => {
      const h = await connectMany({ scripts: [[{ type: "wait", ms: 200 }, ...textScript("ok")]] });
      const remote = await h.add();
      const { session } = await remote.client.runtime.createSession({ model: MODEL });
      const turn = session.submit({ text: "慢" });
      await until(() => h.provider.requests.length > 0);
      await session.close();
      const lock = path.join(h.sessionsDir, `${session.id}.lock`);
      expect(existsSync(lock)).toBe(true);
      const resumed = reopen ? await h.client.runtime.resumeSession(session.id) : undefined;
      expect(await turn).toBe("done");
      expect(existsSync(lock)).toBe(reopen);
      await resumed?.session.close();
      await h.client.shutdown();
      await Promise.all([h.served, remote.served]);
    },
  );

  it("远程断开不阻止 Turn 完成，本机仍收到 turn.completed", async () => {
    const h = await connectMany({ scripts: [[{ type: "wait", ms: 150 }, ...textScript("ok")]] });
    const { session: a } = await h.client.runtime.createSession({ model: MODEL });
    const events: RuntimeEvent[] = [];
    await a.subscribe((e) => events.push(e));
    const remote = await h.add();
    const { session: b } = await remote.client.runtime.resumeSession(a.id);
    const turn = b.submit({ text: "慢" });
    const rejected = expect(turn).rejects.toMatchObject({ code: "connection_closed" });
    await until(() => h.provider.requests.length > 0);
    remote.transport.close();
    await remote.served;
    await rejected;
    await until(() => events.some((e) => e.type === "turn.completed"));
    expect(events.find((e) => e.type === "turn.completed")).toMatchObject({
      payload: { reason: "done" },
    });
    await h.client.shutdown();
    await h.served;
  });

  it("本机断开关闭远程传输并中断 Turn", async () => {
    const h = await connectMany({ scripts: [[{ type: "wait", ms: 60000 }]] });
    const remote = await h.add();
    const { session } = await remote.client.runtime.createSession({ model: MODEL });
    const turn = session.submit({ text: "慢" });
    const rejected = expect(turn).rejects.toMatchObject({ code: "connection_closed" });
    await until(() => h.provider.requests.length > 0);
    h.client.close();
    await Promise.all([h.served, remote.served, remote.client.closed, rejected]);
    expect(h.durable(session.id).find((e) => e.type === "turn.completed")).toMatchObject({
      payload: { reason: "aborted" },
    });
    expect(h.disposed()).toBe(true);
  });

  it("两端并发 submit 一个 session_busy，任一端请求形式 interrupt 可中断", async () => {
    const h = await connectMany({ scripts: [[{ type: "wait", ms: 60000 }]] });
    const { session: a } = await h.client.runtime.createSession({ model: MODEL });
    const remote = await h.add();
    const { session: b } = await remote.client.runtime.resumeSession(a.id);
    const turn = a.submit({ text: "慢" });
    await until(() => h.durable(a.id).some((e) => e.type === "turn.started"));
    await expect(b.submit({ text: "冲突" })).rejects.toMatchObject({ code: "session_busy" });
    await remote.client.call("session.interrupt", { sessionId: a.id });
    expect(await turn).toBe("aborted");
    await h.client.shutdown();
    await Promise.all([h.served, remote.served]);
  });

  it.each(["project", "session"] as const)(
    "权限两端收到，remember=%s 按远程边界处理且重复回复 unknown_request",
    async (remember) => {
      const h = await connectMany({
        scripts: [
          [
            {
              type: "tool_call",
              toolCallId: "w",
              name: "write",
              input: { path: "out.txt", content: "ok" },
            },
            { type: "finish", reason: "tool_calls" },
          ],
          textScript("ok"),
        ],
      });
      const { session: a } = await h.client.runtime.createSession({ model: MODEL });
      const remote = await h.add();
      const { session: b } = await remote.client.runtime.resumeSession(a.id);
      const eventsA: RuntimeEvent[] = [],
        eventsB: RuntimeEvent[] = [];
      await a.subscribe((e) => eventsA.push(e));
      await b.subscribe((e) => eventsB.push(e));
      const turn = a.submit({ text: "写" });
      await until(() => eventsB.some((e) => e.type === "permission.requested"));
      const event = eventsB.find((e) => e.type === "permission.requested");
      if (event?.type !== "permission.requested") throw new Error("缺少权限请求");
      const id = event.payload.requestId;
      if (remember === "project") {
        await expect(
          b.respondPermission(id, { decision: "allow", remember }),
        ).rejects.toMatchObject({ code: "remote_not_allowed" });
        await a.respondPermission(id, { decision: "allow" });
      } else await b.respondPermission(id, { decision: "allow", remember });
      expect(await turn).toBe("done");
      await expect(b.respondPermission(id, { decision: "allow" })).rejects.toMatchObject({
        code: "unknown_request",
      });
      expect(eventsA.some((e) => e.type === "permission.resolved")).toBe(true);
      expect(eventsB.some((e) => e.type === "permission.resolved")).toBe(true);
      await h.client.shutdown();
      await Promise.all([h.served, remote.served]);
    },
  );

  it("白名单外方法统一拒绝，shutdown 只在本机", async () => {
    const h = await connectMany();
    const remote = await h.add();
    for (const method of [
      "runtime.updateSettings",
      "provider.setCredential",
      "mcp.saveMcpServer",
      "mcp.deleteMcpServer",
      "mcp.setMcpServerEnabled",
      "session.setShell",
      "shutdown",
    ]) {
      await expect(remote.client.call(method as "shutdown", {})).rejects.toMatchObject({
        code: "remote_not_allowed",
        rpcCode: -32004,
      });
    }
    expect(REMOTE_METHODS).not.toContain("shutdown");
    expect(await remote.client.runtime.listModels()).not.toHaveLength(0);
    await h.client.shutdown();
    await Promise.all([h.served, remote.served]);
  });

  it("远程可回复提问，两端收到 tool.completed 且重复回复拒绝", async () => {
    const h = await connectMany({
      scripts: [
        [
          {
            type: "tool_call",
            toolCallId: "q",
            name: "ask_user",
            input: {
              questions: [
                {
                  question: "选哪个？",
                  header: "选择",
                  options: [
                    { label: "甲", description: "第一项" },
                    { label: "乙", description: "第二项" },
                  ],
                },
              ],
            },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        textScript("ok"),
      ],
    });
    const { session: a } = await h.client.runtime.createSession({ model: MODEL });
    const remote = await h.add();
    const { session: b } = await remote.client.runtime.resumeSession(a.id);
    const eventsA: RuntimeEvent[] = [],
      eventsB: RuntimeEvent[] = [];
    await a.subscribe((e) => eventsA.push(e));
    await b.subscribe((e) => eventsB.push(e));
    const turn = a.submit({ text: "问" });
    await until(() => eventsB.some((e) => e.type === "question.requested"));
    const event = eventsB.find((e) => e.type === "question.requested");
    if (event?.type !== "question.requested") throw new Error("缺少提问");
    const id = event.payload.requestId;
    await b.respondQuestion(id, { answers: [{ selected: ["甲"] }] });
    expect(await turn).toBe("done");
    await expect(a.respondQuestion(id, { answers: [{ selected: ["乙"] }] })).rejects.toMatchObject({
      code: "unknown_request",
    });
    expect(eventsA.some((e) => e.type === "tool.completed")).toBe(true);
    expect(eventsB.some((e) => e.type === "tool.completed")).toBe(true);
    await h.client.shutdown();
    await Promise.all([h.served, remote.served]);
  });

  it("providersChanged 广播给已握手连接，诊断只增加 origin 不记参数", async () => {
    const h = await connectWithConfig();
    const [serverEnd, transport] = createMemoryTransportPair();
    const served = h.server.serve(serverEnd, { origin: "remote" });
    const remote = createRpcClient(transport, { clientName: "remote" });
    await remote.initialize();
    let localCount = 0,
      remoteCount = 0;
    h.client.onProvidersChanged(() => localCount++);
    remote.onProvidersChanged(() => remoteCount++);
    await h.client.runtime.reloadConfig();
    expect(localCount).toBe(1);
    expect(remoteCount).toBe(1);
    expect(h.diagnostics).toContainEqual({ kind: "connection", state: "open", origin: "remote" });
    await h.client.shutdown();
    await Promise.all([h.served, served]);
  });
});
