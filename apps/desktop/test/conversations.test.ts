import {
  createMemoryTransportPair,
  createRpcClient,
  type RpcClient,
  type LineTransport,
} from "@nocturne/rpc/client";
import { createSessionView, type RuntimeEvent, type TurnChanges } from "@nocturne/core/protocol";
import { describe, expect, it, vi } from "vitest";

import {
  activeConversationCount,
  Conversations,
  conversationStatus,
  type OpenConversation,
} from "../src/conversations";

/**
 * 单后台假池（ADR-0051）：ensure 第一次调用建起唯一一个 client，
 * 之后复用它；crash() 模拟进程退出，下一次 ensure 起新进程。
 * deferResume 里的会话：resumeSession 收到后不立即应答，由 releaseResume 放行，
 * 用来模拟「先发出的打开请求晚返回」。
 */
function fixture(
  lockedId?: string,
  rejectSubmit = false,
  failResume?: ReadonlySet<string>,
  deferResume?: ReadonlySet<string>,
  /** rejectSubmit 时替换默认的错误（message + data 覆盖） */
  submitError?: { message: string; data?: Record<string, unknown> },
  /** 会话事件回调（订阅 live 边界测试用：记录 sessionId/event/live） */
  onEvent?: (sessionId: string, event: RuntimeEvent, live: boolean) => void,
  /** 扣住 session.subscribe 的响应：用来制造「回放期间到达」的事件 */
  deferSubscribe?: ReadonlySet<string>,
) {
  let client: RpcClient | undefined;
  let server: LineTransport | undefined;
  /** 会话所在的工作区（打开时记录；事件回放按会话路由，与真实后台一致） */
  const opened = new Map<string, string>();
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const turns = new Map<string, unknown>();
  const seqs = new Map<string, number>();
  const stalled = new Map<string, { id: unknown }>();
  /** 被扣住的 session.subscribe 响应（releaseSubscribe 放行） */
  const stalledSub = new Map<string, { id: unknown }>();
  let changes: TurnChanges[] = [];
  let changesError = false;
  /** crash 后为 true：failResume 只在重建的新后台生效 */
  let afterCrash = false;
  let nextSession = 1;
  const pool = {
    ensure: vi.fn(async () => {
      if (client !== undefined) return client;
      const [transport, serverEnd] = createMemoryTransportPair();
      server = serverEnd;
      serverEnd.onLine((line) => {
        const request = JSON.parse(line) as {
          id: unknown;
          method: string;
          params: Record<string, unknown>;
        };
        calls.push({ method: request.method, params: request.params });
        const id = String(request.params.sessionId ?? `new-${nextSession++}`);
        let result: unknown = null;
        const sendResult = () =>
          serverEnd.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
        if (request.method === "runtime.resumeSession" && deferResume?.has(id) === true) {
          stalled.set(id, { id: request.id });
          return;
        }
        if (
          request.method === "runtime.resumeSession" &&
          failResume?.has(id) === true &&
          afterCrash
        ) {
          serverEnd.send(
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
          serverEnd.send(
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
          const workspace = String(request.params.cwd ?? opened.get(id) ?? "project");
          opened.set(id, workspace);
          result = {
            sessionId: id,
            meta: { id, cwd: workspace },
            config: { model: { provider: "test", model: "cheap" } },
            warnings: [],
            lastSeq: 0,
          };
        }
        if (request.method === "session.subscribe" && deferSubscribe?.has(id) === true) {
          stalledSub.set(id, { id: request.id });
          return;
        }
        if (request.method === "session.subscribe") result = { lastSeq: 0 };
        if (request.method === "session.turnChanges") {
          if (changesError) {
            serverEnd.send(
              JSON.stringify({
                jsonrpc: "2.0",
                id: request.id,
                error: { code: -32000, message: "查询失败" },
              }),
            );
            return;
          }
          result = changes;
        }
        if (request.method === "session.turnChangeDiff") result = { diff: "+new" };
        if (request.method === "session.rewind") {
          const files = [{ path: "Z:/project/a", result: "restored" as const }];
          event(id, "session.rewound", {
            targetSeq: request.params.targetSeq,
            mode: request.params.mode,
            files,
          });
          changes = changes.map((t) => ({ ...t, reverted: { seq: seqs.get(id) ?? 0, files } }));
          result = files;
        }
        if (request.method === "session.readAttachment") {
          result = { data: "AQID", mimeType: "image/png", bytes: 3 };
        }
        if (request.method === "session.close") opened.delete(id);
        if (request.method === "session.submit") {
          if (rejectSubmit) {
            serverEnd.send(
              JSON.stringify({
                jsonrpc: "2.0",
                id: request.id,
                error: {
                  code: -32003,
                  message: submitError?.message ?? "图片格式或尺寸不符合要求",
                  data: { code: "invalid_command", ...(submitError?.data ?? {}) },
                },
              }),
            );
            return;
          }
          turns.set(id, request.id);
          // 接受语义：先发 message.user 事件，响应留到 complete()
          const seq = (seqs.get(id) ?? 0) + 1;
          seqs.set(id, seq);
          serverEnd.send(
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
        sendResult();
      });
      const c = createRpcClient(transport, { clientName: "test" });
      await c.initialize();
      client = c;
      return c;
    }),
    get: () => client,
  };
  const failures: unknown[] = [];
  const changed = vi.fn();
  const controller = new Conversations(
    pool,
    () => "plain",
    changed,
    (e) => failures.push(e),
    onEvent,
  );
  function event(id: string, type: string, payload: unknown, time = "2026-01-01T00:00:00Z") {
    if (!opened.has(id)) throw new Error("会话未打开");
    const seq = (seqs.get(id) ?? 0) + 1;
    seqs.set(id, seq);
    server?.send(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "event",
        params: {
          sessionId: id,
          event: {
            sessionId: id,
            seq,
            time,
            type,
            payload,
            ...(type === "turn.started" || type === "turn.completed"
              ? { turnId: "test-turn" }
              : {}),
          },
        },
      }),
    );
  }
  /**
   * 发一条易失事件（runtime.status/question.requested）：不占 seq、不进回放；
   * 订阅期间到达即实时（live=true），与服务端语义一致。
   */
  function emitEphemeral(id: string, type: string, payload: unknown) {
    if (!opened.has(id)) throw new Error("会话未打开");
    server?.send(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "event",
        params: {
          sessionId: id,
          event: {
            sessionId: id,
            runId: "run-test",
            eseq: 1,
            afterSeq: seqs.get(id) ?? 0,
            time: "2026-01-01T00:00:00Z",
            type,
            payload,
          },
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
    server?.send(JSON.stringify({ jsonrpc: "2.0", id: turn, result: "done" }));
  }
  /** 模拟后台进程退出：下一次 ensure 起新进程，已打开会话由 backendExited 标 dead */
  function crash() {
    client?.close();
    client = undefined;
    server = undefined;
    afterCrash = true;
  }
  /** 放行被 deferResume 卡住的 resumeSession */
  function releaseResume(id: string) {
    const pending = stalled.get(id);
    if (pending === undefined || server === undefined) throw new Error("没有卡住的请求");
    stalled.delete(id);
    opened.set(id, "");
    server.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: pending.id,
        result: {
          sessionId: id,
          meta: { id, cwd: "" },
          config: { model: { provider: "test", model: "cheap" } },
          warnings: [],
          lastSeq: 0,
        },
      }),
    );
  }
  /** 放行被 deferSubscribe 卡住的 session.subscribe（回放结束、转实时） */
  function releaseSubscribe(id: string) {
    const pending = stalledSub.get(id);
    if (pending === undefined || server === undefined) throw new Error("没有卡住的订阅");
    stalledSub.delete(id);
    server.send(JSON.stringify({ jsonrpc: "2.0", id: pending.id, result: { lastSeq: 0 } }));
  }
  return {
    changed,
    controller,
    pool,
    calls,
    opened,
    failures,
    event,
    emitEphemeral,
    complete,
    crash,
    releaseResume,
    releaseSubscribe,
    setChanges: (value: TurnChanges[]) => {
      changes = value;
    },
    failChanges: () => {
      changesError = true;
    },
  };
}

describe("desktop conversation lifecycle", () => {
  it("首次打开、重新打开和 afterSeq 恢复的回放只在结束时通知 listeners", async () => {
    const deferred = new Set(["a"]);
    const observed = vi.fn();
    const f = fixture(undefined, false, undefined, undefined, undefined, observed, deferred);
    let seq = 0;
    for (const mode of ["initial", "reopen", "afterSeq"] as const) {
      const before = f.controller.opened.get("a")?.view.lastSeq ?? 0;
      const opening =
        mode === "afterSeq" ? f.controller.resumeBackend() : f.controller.open("a", "project");
      await vi.waitFor(() => expect(f.controller.opened.get("a")?.replaying).toBe(true));
      const entry = f.controller.opened.get("a");
      if (!entry) throw new Error("missing entry");
      const listener = vi.fn();
      entry.listeners.add(listener);
      f.changed.mockClear();
      observed.mockClear();
      for (let i = 0; i < 20; i++) {
        f.event("a", "message.user", { content: [{ type: "text", text: `replay-${mode}-${i}` }] });
      }
      seq += 20;
      await vi.waitFor(() => expect(entry.view.lastSeq).toBe(seq));
      expect(listener).not.toHaveBeenCalled();
      expect(f.changed).not.toHaveBeenCalled();
      expect(observed).toHaveBeenCalledTimes(20);
      expect(observed.mock.calls.every((call) => call[2] === false)).toBe(true);
      expect(
        f.calls.filter((call) => call.method === "session.subscribe").at(-1)?.params.afterSeq,
      ).toBe(before);
      f.releaseSubscribe("a");
      await opening;
      expect(entry.replaying).toBe(false);
      expect(listener).toHaveBeenCalledTimes(1);
      f.event("a", "session.titled", { title: "live" });
      seq++;
      await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(2));
      if (mode === "initial") {
        await f.controller.newConversation("plain");
      } else if (mode === "reopen") {
        f.crash();
        f.controller.backendExited();
      }
    }
  });

  it("新建只选择工作区，首次消息才建会话；单后台常驻不释放", async () => {
    const f = fixture();
    await f.controller.newConversation("plain");
    expect(f.pool.ensure).not.toHaveBeenCalled();
    expect(f.controller.opened.size).toBe(0);
    await f.controller.send({ text: "hello", attachments: [] });
    const id = f.controller.selectedId;
    expect(id).not.toBeNull();
    const create = f.calls.find((c) => c.method === "runtime.createSession");
    // 会话级 cwd/workspaceRoot 随会话传给后台（ADR-0051）
    expect(create?.params).toMatchObject({ cwd: "plain", workspaceRoot: "plain" });
    expect(f.calls.filter((c) => c.method === "runtime.createSession")).toHaveLength(1);
    f.complete(id as string);
    await vi.waitFor(() => expect(f.controller.selected?.busy).toBe(false));
    await f.controller.newConversation("project");
    expect(f.opened.size).toBe(0);
    // 后台只有一个且常驻：会话关闭不重启也不释放进程
    expect(f.calls.filter((c) => c.method === "initialize")).toHaveLength(1);
  });

  it("草稿与已有会话都原样传递delegate，不创建外部子会话", async () => {
    const f = fixture();
    const delegate = { agent: "omp", task: "原样转交任务" };
    await f.controller.newConversation("plain");
    await f.controller.send({ text: "/omp 原样转交任务", delegate, attachments: [] });
    const id = f.controller.selectedId as string;
    expect(f.calls.find((call) => call.method === "session.submit")?.params).toMatchObject({
      text: "/omp 原样转交任务",
      delegate,
    });
    f.complete(id);
    await vi.waitFor(() => expect(f.controller.selected?.busy).toBe(false));
    await f.controller.send({ text: "/omp 原样转交任务", delegate, attachments: [] });
    expect(f.calls.filter((call) => call.method === "session.submit")).toHaveLength(2);
    expect(f.calls.filter((call) => call.method === "runtime.createSession")).toHaveLength(1);
    f.complete(id);
  });

  it("不同项目的会话在同一个后台打开；切走的空闲会话释放锁", async () => {
    const f = fixture();
    await f.controller.open("a", "project-a");
    await f.controller.open("b", "project-b");
    expect(f.controller.selectedId).toBe("b");
    expect(f.opened.has("a")).toBe(false);
    expect(f.opened.has("b")).toBe(true);
    // 后台只启动一次；a 在同一个连接上 unsubscribe+close
    expect(f.calls.filter((c) => c.method === "initialize")).toHaveLength(1);
    expect(
      f.calls.filter((c) => c.method === "session.close" && c.params.sessionId === "a"),
    ).toHaveLength(1);
  });

  it("运行与待确认旧会话保持打开，完成后自动释放；同项目其他会话不受影响", async () => {
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
    f.complete("a");
    await vi.waitFor(() => expect(f.opened.has("a")).toBe(false));
    expect(f.opened.has("b")).toBe(true);
    expect(f.failures).toEqual([]);
  });

  it("还有 agent 浏览器标签的会话跑完后切走也不关；标签都关了再按空闲规则关", async () => {
    const f = fixture();
    await f.controller.open("a", "project");
    f.controller.setAgentSessions(new Set(["a"]));
    await f.controller.send({ text: "打开网页", attachments: [] });
    await f.controller.open("b", "project");
    // 用户切走后 agent 跑完：空闲、没被选中，但标签还活着，绑定不能撤
    f.complete("a");
    const a = f.controller.opened.get("a");
    if (a === undefined) throw new Error("有 agent 标签的会话被提前关闭");
    await vi.waitFor(() => expect(conversationStatus(a)).toBe("idle"));
    await f.controller.open("c", "project");
    expect(f.opened.has("a")).toBe(true);
    expect(f.calls.some((c) => c.method === "session.close" && c.params.sessionId === "a")).toBe(
      false,
    );
    // 切回来仍是同一个打开的会话
    await f.controller.open("a", "project");
    expect(f.controller.opened.get("a")).toBe(a);
    await f.controller.open("b", "project");
    // 集合内容不变（快照重推）不触发关闭
    f.controller.setAgentSessions(new Set(["a"]));
    expect(f.opened.has("a")).toBe(true);
    // 标签都关了：空闲且没被选中，按原规则关闭
    f.controller.setAgentSessions(new Set());
    await vi.waitFor(() => expect(f.opened.has("a")).toBe(false));
    expect(f.failures).toEqual([]);
  });

  it("锁定目标打开失败：选中留在目标会话并显示错误，显式 force 才能接管", async () => {
    const f = fixture("locked");
    await f.controller.open("old", "plain");
    await expect(f.controller.open("locked", "project")).rejects.toMatchObject({
      code: "session_locked",
    });
    // 选中不退回旧会话：占位区按 openErrors 显示错误与「重试」（ADR-0051）
    expect(f.controller.selectedId).toBe("locked");
    expect(f.controller.openErrors.get("locked")?.message).toContain("正在别处使用");
    expect(f.controller.openErrors.get("locked")?.workspace).toBe("project");
    expect(f.opened.has("locked")).toBe(false);
    await vi.waitFor(() => expect(f.opened.has("old")).toBe(false));
    await f.controller.open("locked", "project", true);
    expect(f.controller.selectedId).toBe("locked");
    expect(f.controller.openErrors.has("locked")).toBe(false);
    expect(f.opened.has("locked")).toBe(true);
  });

  it("快速连点：被取代的打开不再请求后台，最后点击的会话生效", async () => {
    const f = fixture();
    const pending = [
      f.controller.open("a", "project-a"),
      f.controller.open("b", "project-b"),
      f.controller.open("c", "project-c"),
    ];
    await Promise.all(pending);
    expect(f.controller.selectedId).toBe("c");
    expect(f.opened.has("c")).toBe(true);
    // a、b 的打开在串行队列里被 token 跳过：没有发 resumeSession
    expect(f.calls.filter((c) => c.method === "runtime.resumeSession")).toHaveLength(1);
    expect(f.calls.find((c) => c.method === "runtime.resumeSession")?.params.sessionId).toBe("c");
    await f.controller.newConversation("plain");
    expect(f.controller.selectedId).toBeNull();
    expect(f.opened.size).toBe(0);
  });

  it("先发出的打开晚返回时不覆盖界面：接上的会话按空闲路径关闭", async () => {
    const f = fixture(undefined, false, undefined, new Set(["a"]));
    const openA = f.controller.open("a", "project-a");
    // a 的 resumeSession 真正到达后台并被扣住；这期间用户改点 b（b 排在 a 之后）
    await vi.waitFor(() =>
      expect(
        f.calls.some((c) => c.method === "runtime.resumeSession" && c.params.sessionId === "a"),
      ).toBe(true),
    );
    const openB = f.controller.open("b", "project-b");
    expect(f.controller.selectedId).toBe("b");
    // a 的迟到响应到了：a 接上后发现自己已不是选中项，按空闲路径关闭
    f.releaseResume("a");
    await Promise.all([openA, openB]);
    await vi.waitFor(() => expect(f.opened.has("a")).toBe(false));
    expect(f.opened.has("b")).toBe(true);
    expect(f.controller.selectedId).toBe("b");
    expect(
      f.calls.filter((c) => c.method === "session.close" && c.params.sessionId === "a"),
    ).toHaveLength(1);
  });

  it("订阅边界：旧回放按时间判 live=false，回放期间的新 durable 判 live=true", async () => {
    const seen: { type: string; time: string; live: boolean }[] = [];
    const onEvent = (_id: string, event: RuntimeEvent, live: boolean) => {
      seen.push({ type: event.type, time: event.time, live });
    };
    // deferSubscribe 扣住 session.subscribe 的响应：回放窗口期内到达的事件先缓冲，
    // 与服务端「先挂监听+缓冲再回放」语义一致；新旧按 event.time 与订阅起始区分
    const f = fixture(undefined, false, undefined, undefined, undefined, onEvent, new Set(["a"]));
    const opening = f.controller.open("a", "project-a");
    await vi.waitFor(() =>
      expect(
        f.calls.some((c) => c.method === "session.subscribe" && c.params.sessionId === "a"),
      ).toBe(true),
    );
    // 旧回放：time 远早于订阅起始 → live=false
    expect(f.controller.opened.get("a")?.replaying).toBe(true);
    f.event("a", "message.user", { messageId: "replay-1", content: [] });
    // 回放窗口期内新产生的 permission.requested/turn.completed：time 取订阅起始
    // 时刻及之后 → live=true（同 ms 取 >=，默认实时）
    const fresh = new Date().toISOString();
    f.event(
      "a",
      "permission.requested",
      { requestId: "r", callId: "c", subjects: [], reason: "", options: [] },
      fresh,
    );
    f.event(
      "a",
      "turn.completed",
      { reason: "done", steps: 1, usage: { inputTokens: 1, outputTokens: 1 } },
      fresh,
    );
    // 回放期间到达的易失事件：不进回放，算实时（question.requested 可视实时）
    f.emitEphemeral("a", "runtime.status", { status: "thinking" });
    await vi.waitFor(() => expect(seen.length).toBeGreaterThanOrEqual(4));
    expect(seen.find((s) => s.type === "message.user")?.live).toBe(false);
    expect(seen.find((s) => s.type === "permission.requested")?.live).toBe(true);
    expect(seen.find((s) => s.type === "turn.completed")?.live).toBe(true);
    expect(seen.find((s) => s.type === "runtime.status")?.live).toBe(true);
    // 放行订阅响应：转实时，此后持久事件也是实时
    f.releaseSubscribe("a");
    await opening;
    expect(f.controller.opened.get("a")?.replaying).toBe(false);
    f.event("a", "turn.started", { turnIndex: 1 }, new Date().toISOString());
    await vi.waitFor(() => expect(seen.some((s) => s.type === "turn.started")).toBe(true));
    expect(seen.filter((s) => s.type === "turn.started").every((s) => s.live)).toBe(true);
  });

  it("订阅期间的易失事件是实时（live=true）：question.requested 可视实时", async () => {
    const seen: { type: string; live: boolean }[] = [];
    const f = fixture(undefined, false, undefined, undefined, undefined, (id, event, live) => {
      seen.push({ type: event.type, live });
    });
    await f.controller.open("a", "project-a");
    f.emitEphemeral("a", "question.requested", {
      requestId: "q",
      callId: "c",
      questions: [{ question: "继续吗" }],
    });
    await vi.waitFor(() => expect(seen.some((s) => s.type === "question.requested")).toBe(true));
    expect(seen.filter((s) => s.type === "question.requested").every((s) => s.live)).toBe(true);
  });

  it("恢复补写的 turn.completed 时间是新的故 live=true，但下游按 recovered 挡掉", async () => {
    const seen: { type: string; live: boolean }[] = [];
    const f = fixture(undefined, false, undefined, undefined, undefined, (id, event, live) => {
      seen.push({ type: event.type, live });
    });
    await f.controller.open("a", "project-a");
    // 打开历史会话后到达的恢复补写（recovered:true）：time 是打开时新写的，
    // 故 live=true 透出；App 侧 decideNotification/sessionMarkFor 按 recovered
    // 挡掉，不提醒不留痕（见 notify.test.ts「恢复补写的 turn.completed 不提醒」）
    f.event(
      "a",
      "turn.completed",
      {
        reason: "error",
        steps: 0,
        usage: { inputTokens: 0, outputTokens: 0 },
        error: { code: "process_exited", message: "进程在 Turn 结束前退出" },
        recovered: true,
      },
      new Date().toISOString(),
    );
    await vi.waitFor(() => expect(seen.some((s) => s.type === "turn.completed")).toBe(true));
    expect(seen.filter((s) => s.type === "turn.completed").every((s) => s.live)).toBe(true);
  });
});

describe("send 接受语义与创建选项", () => {
  it("草稿发送把显式模型/档位/预设与会话工作区传给 createSession，未选项省略", async () => {
    const f = fixture();
    await f.controller.newConversation("project-x");
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
      cwd: "project-x",
      workspaceRoot: "project-x",
      model: { provider: "test", model: "fancy" },
      reasoningEffort: "high",
      permissionPreset: "smart",
    });
    const submit = f.calls.find((c) => c.method === "session.submit");
    expect(submit?.params).toMatchObject({ text: "hi", attachments: [] });
    // 默认模型查询带草稿工作区（项目层配置可能覆盖默认模型）
    expect(f.calls.find((c) => c.method === "runtime.defaultModel")).toBeUndefined();
  });

  it("未触碰的档位与预设不进 createSession 参数；defaultModel 按工作区查", async () => {
    const f = fixture();
    await f.controller.newConversation("project-x");
    await f.controller.send({ text: "hi", attachments: [] });
    const create = f.calls.find((c) => c.method === "runtime.createSession");
    expect(create?.params).toEqual({
      cwd: "project-x",
      workspaceRoot: "project-x",
      model: { provider: "test", model: "cheap" },
    });
    expect(f.calls.find((c) => c.method === "runtime.defaultModel")?.params).toEqual({
      workspaceRoot: "project-x",
    });
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

  it("已打开的会话提交被 invalid_model 拒绝：记入 openErrors 供换模型卡片（ADR-0054）", async () => {
    const f = fixture(undefined, true, undefined, undefined, {
      message: "服务商 test 已停用（可在 设置 › 服务商 或 /provider 重新启用）",
      data: {
        code: "invalid_model",
        disabled: "provider",
        model: { provider: "test", model: "cheap" },
      },
    });
    await f.controller.open("a", "project");
    await expect(f.controller.send({ text: "hi", attachments: [] })).rejects.toThrow(
      "服务商 test 已停用",
    );
    expect(f.controller.openErrors.get("a")).toMatchObject({
      code: "invalid_model",
      disabled: "provider",
      disabledModel: { provider: "test", model: "cheap" },
    });
    // 不落全局错误条；会话仍打开且仍选中（主区由卡片替换，会话不关闭）
    expect(f.failures).toEqual([]);
    expect(f.controller.selectedId).toBe("a");
    expect(f.controller.opened.get("a")).toBeDefined();

    // 「用这个模型继续」对已打开会话走 setModel，不重新 resume
    await f.controller.open("a", "project", false, { provider: "test", model: "fancy" });
    expect(f.calls.filter((c) => c.method === "runtime.resumeSession")).toHaveLength(1);
    expect(f.calls.find((c) => c.method === "session.setModel")?.params).toMatchObject({
      model: { provider: "test", model: "fancy" },
    });
    expect(f.controller.openErrors.get("a")).toBeUndefined();

    // 重新启用后回到会话：只对已打开的会话清记录
    f.controller.openErrors.set("a", { message: "x", workspace: "project" });
    f.controller.acknowledgeReenabled("a");
    expect(f.controller.openErrors.get("a")).toBeUndefined();
    f.controller.openErrors.set("zz", { message: "x", workspace: "project" });
    f.controller.acknowledgeReenabled("zz");
    expect(f.controller.openErrors.get("zz")).toBeDefined();
  });
});

describe("后台崩溃与重启恢复", () => {
  /** a 忙（send 未 complete）所以切到 b 后仍打开；b 空闲但被选中 */
  async function twoSessions(f: ReturnType<typeof fixture>, wsA = "project", wsB = "project") {
    await f.controller.open("a", wsA);
    await f.controller.send({ text: "run", attachments: [] }); // a 收到 seq 1
    await f.controller.open("b", wsB);
    f.event("a", "message.user", { content: [{ type: "text", text: "x" }] }); // a 收到 seq 2
  }

  it("后台退出时会话标 dead，保留 id、视图与 lastSeq 断点，选中不变", async () => {
    const f = fixture();
    await twoSessions(f);
    const viewA = f.controller.opened.get("a")?.view;
    f.crash();
    f.controller.backendExited();
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
    await twoSessions(f);
    const viewA = f.controller.opened.get("a")?.view;
    const viewB = f.controller.opened.get("b")?.view;
    f.crash();
    f.controller.backendExited();

    const result = await f.controller.resumeBackend();
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

  it("多个项目的会话在同一个后台一起恢复，单个失败不阻塞其余", async () => {
    const f = fixture(undefined, false, new Set(["a"]));
    // a 在 project-x、b 在 project-y：单后台崩溃后都在新后台恢复
    await twoSessions(f, "project-x", "project-y");
    f.crash();
    f.controller.backendExited();

    const result = await f.controller.resumeBackend();
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toMatchObject({ id: "a" });
    expect(result.failed[0]?.message).toContain("会话日志已损坏");
    // a 仍是 dead 可重试；b 已正常续接（没有按工作区分后台）
    expect(f.controller.opened.get("a")?.dead).toBe(true);
    expect(f.controller.opened.get("b")?.dead).toBeUndefined();
    expect(f.controller.opened.get("b")?.workspace).toBe("project-y");
    const subB = f.calls
      .filter((c) => c.method === "session.subscribe" && c.params.sessionId === "b")
      .at(-1);
    expect(subB?.params.afterSeq).toBe(0);
  });

  it("点开 dead 会话自动重启后台并按 lastSeq 续接", async () => {
    const f = fixture();
    await twoSessions(f);
    const viewA = f.controller.opened.get("a")?.view;
    f.crash();
    f.controller.backendExited();

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

describe("每轮文件更改查询与文件撤销", () => {
  const change = (): TurnChanges => ({
    seq: 1,
    files: [
      {
        path: "Z:/project/a",
        status: "modified",
        added: 1,
        removed: 1,
        restorable: true,
        external: false,
      },
    ],
    untrackedCalls: 0,
  });
  it("打开、完成（含中断）与回退刷新；只撤销文件不提交、不删对话", async () => {
    const f = fixture();
    f.setChanges([change()]);
    await f.controller.open("a", "project");
    const entry = f.controller.selected;
    if (!entry) throw new Error("缺会话");
    expect(entry.turnChanges.get(1)).toEqual(change());
    expect(f.calls.filter((c) => c.method === "session.turnChanges")).toHaveLength(1);
    await f.controller.send({ text: "hello", attachments: [] });
    f.event("a", "turn.started", { turnIndex: 1 });
    expect(f.calls.filter((c) => c.method === "session.turnChanges")).toHaveLength(1);
    await expect(f.controller.rewindFiles(1)).rejects.toThrow("会话正在运行");
    f.event("a", "turn.completed", {
      reason: "aborted",
      steps: 1,
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    f.complete("a");
    await vi.waitFor(() => expect(entry.busy).toBe(false));
    const before = f.calls.filter((c) => c.method === "session.turnChanges").length;
    const userEntries = entry.view.entries.filter((e) => e.kind === "user");
    await f.controller.rewindFiles(1);
    expect(f.calls.find((c) => c.method === "session.rewind")?.params).toMatchObject({
      targetSeq: 1,
      mode: "files",
    });
    expect(f.calls.filter((c) => c.method === "session.submit")).toHaveLength(1);
    expect(entry.view.entries.filter((e) => e.kind === "user")).toEqual(userEntries);
    expect(entry.turnChanges.get(1)?.reverted).toBeDefined();
    expect(f.calls.filter((c) => c.method === "session.turnChanges")).toHaveLength(before + 1);
  });
  it("懒加载 diff 命中缓存；计数变化清缓存，external 单独变化不清", async () => {
    const f = fixture();
    const turn = change();
    f.setChanges([turn]);
    await f.controller.open("a", "project");
    const entry = f.controller.selected;
    if (!entry) throw new Error("缺会话");
    await f.controller.turnChangeDiff(entry, 1, "Z:/project/a");
    await f.controller.turnChangeDiff(entry, 1, "Z:/project/a");
    expect(f.calls.filter((c) => c.method === "session.turnChangeDiff")).toHaveLength(1);
    f.setChanges([{ ...turn, files: turn.files.map((file) => ({ ...file, external: true })) }]);
    f.event("a", "turn.completed", {
      reason: "done",
      steps: 1,
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    await vi.waitFor(() => expect(entry.turnChanges.get(1)?.files[0]?.external).toBe(true));
    expect(entry.changeDiffs.size).toBe(1);
    f.setChanges([{ ...turn, files: turn.files.map((file) => ({ ...file, added: 2 })) }]);
    f.event("a", "turn.completed", {
      reason: "done",
      steps: 1,
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    await vi.waitFor(() => expect(entry.changeDiffs.size).toBe(0));
    await f.controller.turnChangeDiff(entry, 1, "Z:/project/a");
    expect(f.calls.filter((c) => c.method === "session.turnChangeDiff")).toHaveLength(2);
  });
  it("查询失败清卡片，只写诊断不打断对话", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const f = fixture();
      f.setChanges([change()]);
      await f.controller.open("a", "project");
      f.failChanges();
      f.event("a", "turn.completed", {
        reason: "aborted",
        steps: 1,
        usage: { inputTokens: 0, outputTokens: 0 },
      });
      await vi.waitFor(() => expect(f.controller.selected?.turnChanges.size).toBe(0));
      expect(warn).toHaveBeenCalledTimes(1);
      expect(f.failures).toEqual([]);
    } finally {
      warn.mockRestore();
    }
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
