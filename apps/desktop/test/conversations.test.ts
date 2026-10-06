import {
  createMemoryTransportPair,
  createRpcClient,
  type RpcClient,
  type LineTransport,
} from "@nocturne/rpc/client";
import { createSessionView } from "@nocturne/core/protocol";
import { describe, expect, it, vi } from "vitest";

import {
  activeConversationCount,
  Conversations,
  conversationStatus,
  type OpenConversation,
} from "../src/conversations";
import { projectKey } from "../src/session-tree";

function fixture(lockedId?: string, rejectSubmit = false, failResume?: ReadonlySet<string>) {
  const clients = new Map<string, RpcClient>();
  const opened = new Map<string, string>();
  const calls: { workspace: string; method: string; params: Record<string, unknown> }[] = [];
  const streams = new Map<string, LineTransport>();
  const turns = new Map<string, { workspace: string; id: unknown }>();
  const seqs = new Map<string, number>();
  /** 崩溃过的工作区：failResume 只在新后台的 resumeSession 上生效 */
  const crashed = new Set<string>();
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
          failResume?.has(id) === true &&
          crashed.has(workspace)
        ) {
          server.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id: request.id,
              error: { code: -32004, message: "会话日志已损坏", data: { code: "io" } },
            }),
          );
          return;
        }
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
        if (request.method === "session.readAttachment") {
          result = { data: "AQID", mimeType: "image/png", bytes: 3 };
        }
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
  /** 模拟后台进程退出：BackendPool 会把条目移除，下一次 ensure 起新进程 */
  function crash(workspace: string) {
    clients.delete(workspace);
    streams.delete(workspace);
    crashed.add(workspace);
  }
  return { controller, pool, calls, opened, failures, event, complete, crash };
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

describe("后台崩溃与重启恢复", () => {
  /** a 忙（send 未 complete）所以切到 b 后仍打开；b 空闲但被选中 */
  async function twoSessionsOnProject(f: ReturnType<typeof fixture>) {
    await f.controller.open("a", "project");
    await f.controller.send({ text: "run", attachments: [] }); // a 收到 seq 1
    await f.controller.open("b", "project");
    f.event("a", "message.user", { content: [{ type: "text", text: "x" }] }); // a 收到 seq 2
  }

  it("后台退出时会话标 dead，保留 id、视图与 lastSeq 断点，选中不变", async () => {
    const f = fixture();
    await twoSessionsOnProject(f);
    const viewA = f.controller.opened.get("a")?.view;
    f.crash("project");
    f.controller.backendExited(projectKey("project"));
    expect(f.controller.opened.get("a")?.dead).toBe(true);
    expect(f.controller.opened.get("b")?.dead).toBe(true);
    expect(f.controller.selectedId).toBe("b");
    expect(f.controller.opened.get("a")?.view).toBe(viewA);
    expect(viewA?.lastSeq).toBe(2);
    // dead 会话不可再提交
    await expect(f.controller.send({ text: "x", attachments: [] })).rejects.toThrow("后台已退出");
    // dead 会话不被空闲清理
    await f.controller.newConversation("plain");
    expect(f.controller.opened.get("a")?.dead).toBe(true);
  });

  it("重启后台后逐个 resumeSession 并按各自 lastSeq 续接订阅", async () => {
    const f = fixture();
    await twoSessionsOnProject(f);
    const viewA = f.controller.opened.get("a")?.view;
    const viewB = f.controller.opened.get("b")?.view;
    f.crash("project");
    f.controller.backendExited(projectKey("project"));

    const result = await f.controller.resumeBackend("project");
    expect(result.failed).toEqual([]);
    // 新后台重新握手并逐个 resumeSession（旧后台的两个 + 新后台的两个）
    expect(f.calls.filter((c) => c.method === "initialize")).toHaveLength(2);
    expect(f.calls.filter((c) => c.method === "runtime.resumeSession")).toHaveLength(4);
    const subA = f.calls
      .filter((c) => c.method === "session.subscribe" && c.params.sessionId === "a")
      .at(-1);
    const subB = f.calls
      .filter((c) => c.method === "session.subscribe" && c.params.sessionId === "b")
      .at(-1);
    expect(subA?.params.afterSeq).toBe(2);
    expect(subB?.params.afterSeq).toBe(0);
    // 视图对象延续：浏览位置不变；选中仍是 b
    expect(f.controller.opened.get("a")?.view).toBe(viewA);
    expect(f.controller.opened.get("b")?.view).toBe(viewB);
    expect(f.controller.opened.get("a")?.dead).toBeUndefined();
    expect(f.controller.selectedId).toBe("b");
  });

  it("单个会话恢复失败不阻塞其他会话，失败的保持 dead", async () => {
    const f = fixture(undefined, false, new Set(["a"]));
    await twoSessionsOnProject(f);
    f.crash("project");
    f.controller.backendExited(projectKey("project"));

    const result = await f.controller.resumeBackend("project");
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toMatchObject({ id: "a" });
    expect(result.failed[0]?.message).toContain("会话日志已损坏");
    // a 仍是 dead 可重试；b 已正常续接
    expect(f.controller.opened.get("a")?.dead).toBe(true);
    expect(f.controller.opened.get("b")?.dead).toBeUndefined();
    const subB = f.calls
      .filter((c) => c.method === "session.subscribe" && c.params.sessionId === "b")
      .at(-1);
    expect(subB?.params.afterSeq).toBe(0);
  });

  it("点开 dead 会话自动重启后台并按 lastSeq 续接", async () => {
    const f = fixture();
    await twoSessionsOnProject(f);
    const viewA = f.controller.opened.get("a")?.view;
    f.crash("project");
    f.controller.backendExited(projectKey("project"));

    await f.controller.open("a", "project");
    const subA = f.calls
      .filter((c) => c.method === "session.subscribe" && c.params.sessionId === "a")
      .at(-1);
    expect(subA?.params.afterSeq).toBe(2);
    expect(f.controller.opened.get("a")?.view).toBe(viewA);
    expect(f.controller.opened.get("a")?.dead).toBeUndefined();
    // b 仍是 dead，等「重启后台」或点开时再恢复
    expect(f.controller.opened.get("b")?.dead).toBe(true);
  });
});

describe("activeConversationCount", () => {
  /** 只填状态判断用到的字段 */
  const entry = (
    patch: Partial<Pick<OpenConversation, "busy">> & {
      turn?: boolean;
      permission?: boolean;
    },
  ): OpenConversation => {
    const view = createSessionView();
    if (patch.turn === true) view.currentTurn = { turnId: "t1", turnIndex: 0 };
    if (patch.permission === true) {
      view.pendingPermission = {} as NonNullable<typeof view.pendingPermission>;
    }
    return { view, busy: patch.busy ?? false } as unknown as OpenConversation;
  };

  it("运行中的 Turn、等待确认、发送中都计入；空闲不计", () => {
    expect(activeConversationCount([])).toBe(0);
    expect(activeConversationCount([entry({}), entry({})])).toBe(0);
    expect(
      activeConversationCount([
        entry({ turn: true }),
        entry({ permission: true }),
        entry({ busy: true }),
        entry({}),
      ]),
    ).toBe(3);
  });
});
