import {
  createMemoryTransportPair,
  createRpcClient,
  type RpcClient,
  type LineTransport,
} from "@nocturne/rpc/client";
import { describe, expect, it, vi } from "vitest";

import { Conversations, conversationStatus } from "../src/conversations";

function fixture(lockedId?: string, rejectSubmit = false) {
  const clients = new Map<string, RpcClient>();
  const opened = new Map<string, string>();
  const calls: { workspace: string; method: string; params: Record<string, unknown> }[] = [];
  const streams = new Map<string, LineTransport>();
  const turns = new Map<string, { workspace: string; id: unknown }>();
  const seqs = new Map<string, number>();
  let nextSession = 1;
  const pool = {
    ensure: vi.fn(async (workspace: string) => {
      const existing = clients.get(workspace);
      if (existing !== undefined) return existing;
      const [transport, server] = createMemoryTransportPair();
      streams.set(workspace, server);
      server.onLine((line) => {
        const request = JSON.parse(line) as {
          id: unknown;
          method: string;
          params: Record<string, unknown>;
        };
        calls.push({ workspace, method: request.method, params: request.params });
        const id = String(request.params.sessionId ?? `new-${nextSession++}`);
        let result: unknown = null;
        if (
          request.method === "runtime.resumeSession" &&
          id === lockedId &&
          request.params.force !== true
        ) {
          server.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id: request.id,
              error: { code: -32002, message: "正在别处使用", data: { code: "session_locked" } },
            }),
          );
          return;
        }
        if (request.method === "initialize")
          result = { protocolVersion: 1, nocturneVersion: "test" };
        if (request.method === "runtime.defaultModel")
          result = { provider: "test", model: "cheap" };
        if (
          request.method === "runtime.resumeSession" ||
          request.method === "runtime.createSession"
        ) {
          opened.set(id, workspace);
          result = {
            sessionId: id,
            meta: { id, cwd: workspace },
            config: { model: { provider: "test", model: "cheap" } },
            warnings: [],
            lastSeq: 0,
          };
        }
        if (request.method === "session.subscribe") result = { lastSeq: 0 };
        if (request.method === "session.close") opened.delete(id);
        if (request.method === "session.submit") {
          if (rejectSubmit) {
            server.send(
              JSON.stringify({
                jsonrpc: "2.0",
                id: request.id,
                error: {
                  code: -32003,
                  message: "图片格式或尺寸不符合要求",
                  data: { code: "invalid_command" },
                },
              }),
            );
            return;
          }
          turns.set(id, { workspace, id: request.id });
          // 接受语义：先发 message.user 事件，响应留到 complete()
          const seq = (seqs.get(id) ?? 0) + 1;
          seqs.set(id, seq);
          server.send(
            JSON.stringify({
              jsonrpc: "2.0",
              method: "event",
              params: {
                sessionId: id,
                event: {
                  sessionId: id,
                  seq,
                  time: "2026-01-01T00:00:00Z",
                  type: "message.user",
                  payload: { content: [{ type: "text", text: "hi" }] },
                },
              },
            }),
          );
          return;
        }
        server.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
      });
      const client = createRpcClient(transport, { clientName: "test" });
      await client.initialize();
      clients.set(workspace, client);
      return client;
    }),
    release: vi.fn(async (workspace: string) => {
      clients.get(workspace)?.close();
      clients.delete(workspace);
    }),
  };
  const failures: unknown[] = [];
  const controller = new Conversations(
    pool,
    () => "plain",
    () => undefined,
    (e) => failures.push(e),
  );
  function event(id: string, type: string, payload: unknown) {
    const workspace = opened.get(id);
    if (workspace === undefined) throw new Error("会话未打开");
    const seq = (seqs.get(id) ?? 0) + 1;
    seqs.set(id, seq);
    streams.get(workspace)?.send(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "event",
        params: {
          sessionId: id,
          event: { sessionId: id, seq, time: "2026-01-01T00:00:00Z", type, payload },
        },
      }),
    );
  }
  function complete(id: string) {
    const turn = turns.get(id);
    if (turn === undefined) throw new Error("Turn 未开始");
    event(id, "turn.completed", {
      reason: "done",
      steps: 1,
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    streams
      .get(turn.workspace)
      ?.send(JSON.stringify({ jsonrpc: "2.0", id: turn.id, result: "done" }));
  }
  return { controller, pool, calls, opened, failures, event, complete };
}

describe("desktop conversation lifecycle", () => {
  it("新建只选择工作区，首次消息才建会话；普通对话后台不释放", async () => {
    const f = fixture();
    await f.controller.newConversation("plain");
    expect(f.pool.ensure).not.toHaveBeenCalled();
    expect(f.controller.opened.size).toBe(0);
    await f.controller.send({ text: "hello", attachments: [] });
    const id = f.controller.selectedId;
    expect(id).not.toBeNull();
    expect(f.calls.filter((c) => c.method === "runtime.createSession")).toHaveLength(1);
    f.complete(id as string);
    await vi.waitFor(() => expect(f.controller.selected?.busy).toBe(false));
    await f.controller.newConversation("project");
    expect(f.opened.size).toBe(0);
    expect(f.pool.release).not.toHaveBeenCalled();
  });

  it("打开回放后切换：空闲旧会话释放锁并退出旧项目后台", async () => {
    const f = fixture();
    await f.controller.open("a", "project-a");
    await f.controller.open("b", "project-b");
    expect(f.controller.selectedId).toBe("b");
    expect(f.opened.has("a")).toBe(false);
    expect(f.opened.has("b")).toBe(true);
    expect(f.pool.release).toHaveBeenCalledWith("project-a");
    expect(f.calls.filter((c) => c.workspace === "project-a").map((c) => c.method)).toEqual([
      "initialize",
      "runtime.resumeSession",
      "session.subscribe",
      "session.unsubscribe",
      "session.close",
    ]);
  });

  it("运行与待确认旧会话保持打开，完成后自动释放；同项目其他会话不退出", async () => {
    const f = fixture();
    await f.controller.open("a", "project");
    await f.controller.send({ text: "run", attachments: [] });
    await f.controller.open("b", "project");
    expect(f.opened.has("a")).toBe(true);
    f.event("a", "permission.requested", {
      requestId: "r",
      callId: "c",
      subjects: [],
      reason: "ask",
      options: [],
    });
    const pending = f.controller.opened.get("a");
    if (pending === undefined) throw new Error("运行中的会话提前关闭");
    await vi.waitFor(() => expect(conversationStatus(pending)).toBe("pending"));
    expect(f.pool.release).not.toHaveBeenCalled();
    f.complete("a");
    await vi.waitFor(() => expect(f.opened.has("a")).toBe(false));
    expect(f.opened.has("b")).toBe(true);
    expect(f.pool.release).not.toHaveBeenCalled();
    expect(f.failures).toEqual([]);
  });

  it("锁定目标打开失败不关闭旧会话；只有显式force才能接管", async () => {
    const f = fixture("locked");
    await f.controller.open("old", "plain");
    await expect(f.controller.open("locked", "project")).rejects.toMatchObject({
      code: "session_locked",
    });
    expect(f.controller.selectedId).toBe("old");
    expect(f.opened.has("old")).toBe(true);
    expect(f.opened.has("locked")).toBe(false);
    await f.controller.open("locked", "project", true);
    expect(f.controller.selectedId).toBe("locked");
    expect(f.opened.has("old")).toBe(false);
  });

  it("并发切换按点击顺序执行，不遗留多个空闲项目后台", async () => {
    const f = fixture();
    await Promise.all([
      f.controller.open("a", "project-a"),
      f.controller.open("b", "project-b"),
      f.controller.newConversation("plain"),
    ]);
    expect(f.controller.selectedId).toBeNull();
    expect(f.opened.size).toBe(0);
    expect(f.pool.release.mock.calls).toEqual([["project-a"], ["project-b"]]);
  });
});

describe("send 接受语义与创建选项", () => {
  it("草稿发送把显式模型/档位/预设传给 createSession，未选项省略", async () => {
    const f = fixture();
    await f.controller.newConversation("plain");
    await f.controller.send(
      { text: "hi", attachments: [] },
      {
        model: { provider: "test", model: "fancy" },
        reasoningEffort: "high",
        permissionPreset: "smart",
      },
    );
    const create = f.calls.find((c) => c.method === "runtime.createSession");
    expect(create?.params).toMatchObject({
      model: { provider: "test", model: "fancy" },
      reasoningEffort: "high",
      permissionPreset: "smart",
    });
    const submit = f.calls.find((c) => c.method === "session.submit");
    expect(submit?.params).toMatchObject({ text: "hi", attachments: [] });
  });

  it("未触碰的档位与预设不进 createSession 参数", async () => {
    const f = fixture();
    await f.controller.newConversation("plain");
    await f.controller.send({ text: "hi", attachments: [] });
    const create = f.calls.find((c) => c.method === "runtime.createSession");
    expect(create?.params).toEqual({ model: { provider: "test", model: "cheap" } });
  });

  it("submit 在接受前被拒绝时抛出，会话保持未选中并按空闲路径关闭", async () => {
    const f = fixture(undefined, true);
    await f.controller.newConversation("plain");
    await expect(f.controller.send({ text: "hi", attachments: [] })).rejects.toThrow(
      "图片格式或尺寸不符合要求",
    );
    expect(f.controller.selectedId).toBeNull();
    await vi.waitFor(() => expect(f.opened.size).toBe(0));
    expect(f.calls.some((c) => c.method === "session.close")).toBe(true);
  });
});
