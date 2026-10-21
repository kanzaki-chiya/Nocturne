/**
 * 子会话只读观察的 RPC 映射（rpc.md 4.1）：subagent.list/subscribe/unsubscribe/readAttachment
 * 与 subagent.event/closed 通知；参数与错误、替换与取消清理、远程拒绝。
 * 日志用手写 JSONL 构造（不依赖 FakeProvider 时序），运行中的 child 用真实 Runtime + 门闩。
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  createRuntime,
  FakeProvider,
  type FakeScript,
  type ModelRequest,
  type Runtime,
} from "@nocturne/core";
import type {
  RuntimeEvent,
  SubagentObservation,
  SubagentObserver,
  SubagentReadEnd,
  SubagentSummary,
} from "@nocturne/core/protocol";
import {
  createMemoryTransportPair,
  createRpcClient,
  type LineTransport,
  type RpcError,
  type RpcClient,
} from "@nocturne/rpc/client";
import { createRpcServer, REMOTE_METHODS } from "@nocturne/rpc/server";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const tmp = (prefix: string): string => {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
};

const PNG_2x3 = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 2,
  0, 0, 0, 3, 8, 6, 0, 0, 0,
]);

// ── 手写日志 ────────────────────────────────────────────────

const iso = (seq: number): string => new Date(Date.UTC(2026, 9, 21, 8, 0, seq)).toISOString();
const created = (id: string, parent?: { sessionId: string; callId: string }) => ({
  type: "session.created",
  sessionId: id,
  seq: 1,
  time: iso(0),
  payload: {
    formatVersion: 1,
    nocturneVersion: "0.0.0",
    cwd: "Z:\\repo",
    workspaceRoot: "Z:\\repo",
    model: { provider: "fake", model: "fake-1" },
    permissionPreset: "default",
    ...(parent !== undefined ? { parent } : {}),
  },
});
const event = (
  id: string,
  seq: number,
  type: string,
  payload: unknown,
  turnId: string | undefined = "t1",
) => ({ type, sessionId: id, seq, time: iso(seq), turnId, payload });

function writeLog(dir: string, id: string, lines: unknown[], tail = ""): void {
  writeFileSync(
    path.join(dir, `${id}.jsonl`),
    `${lines.map((l) => JSON.stringify(l)).join("\n")}\n${tail}`,
  );
}

interface HandMade {
  sessionsDir: string;
  parentId: string;
  childId: string;
  /** 子日志里的持久事件数 */
  childEvents: number;
}

/** 父：一条已结算的 task；子：message.user × messages + finish + turn.completed(done) */
function handMade(
  messages = 5,
  options: { attachment?: boolean; sessionsDir?: string } = {},
): HandMade {
  const sessionsDir = options.sessionsDir ?? tmp("nct-rpc-sub-");
  const parentId = "20261021-parent01";
  const childId = "20261021-child001";
  writeLog(sessionsDir, parentId, [
    created(parentId),
    event(parentId, 2, "turn.started", { turnIndex: 1 }),
    event(parentId, 3, "tool.started", {
      callId: "call-1",
      name: "task",
      input: { task: "手写的任务", profile: "quick" },
      subjects: [],
      permission: { action: "allow", source: "rule" },
    }),
    event(parentId, 4, "tool.completed", {
      callId: "call-1",
      name: "task",
      status: "ok",
      modelContent: "ok",
      durationMs: 1234,
    }),
  ]);
  const child: unknown[] = [
    created(childId, { sessionId: parentId, callId: "call-1" }),
    event(childId, 2, "turn.started", { turnIndex: 1 }),
  ];
  for (let i = 0; i < messages; i++) {
    child.push(
      event(childId, child.length + 1, "message.user", {
        messageId: `m${i}`,
        content: [{ type: "text", text: `第 ${i} 条` }],
      }),
    );
  }
  if (options.attachment === true) {
    mkdirSync(path.join(sessionsDir, "attachments", childId), { recursive: true });
    writeFileSync(path.join(sessionsDir, "attachments", childId, "img-1.png"), PNG_2x3);
    child.push(
      event(childId, child.length + 1, "tool.completed", {
        callId: "r1",
        name: "read",
        status: "ok",
        modelContent: "image",
        attachments: [
          {
            type: "image",
            file: "img-1.png",
            mimeType: "image/png",
            bytes: PNG_2x3.byteLength,
            sha256: createHash("sha256").update(PNG_2x3).digest("hex"),
            source: "read",
          },
        ],
      }),
    );
  }
  child.push(
    event(childId, child.length + 1, "turn.completed", {
      reason: "done",
      steps: 1,
      usage: { inputTokens: 1, outputTokens: 1 },
    }),
  );
  writeLog(sessionsDir, childId, child);
  return { sessionsDir, parentId, childId, childEvents: child.length };
}

// ── 带观察间谍的服务端 ───────────────────────────────────────

interface SpyCall {
  input: Parameters<Runtime["observeSubagent"]>[0];
  observer: SubagentObserver;
  /** manual 模式：由测试决定何时、如何完成建立 */
  finish(observation: SubagentObservation): void;
  fail(error: Error): void;
  unsubscribed: number;
}

interface Started {
  client: RpcClient;
  served: Promise<void>;
  server: ReturnType<typeof createRpcServer>;
  sessionsDir: string;
  ws: string;
  /** 服务端→客户端的每一行原文 */
  wire: string[];
  /** 把一行原文塞给客户端（伪造迟到的通知） */
  inject(line: string): void;
  clientTransport: LineTransport;
  calls: SpyCall[];
  runtime: () => Runtime;
}

async function start(
  options: {
    sessionsDir?: string;
    handler?: (req: ModelRequest, index: number) => FakeScript | Promise<FakeScript>;
    /** manual：observeSubagent 不碰真实 Core，返回由测试控制的 promise */
    manual?: boolean;
  } = {},
): Promise<Started> {
  const ws = tmp("nct-rpc-sub-ws-");
  const sessionsDir = options.sessionsDir ?? tmp("nct-rpc-sub-");
  const calls: SpyCall[] = [];
  let real: Runtime | undefined;
  const server = createRpcServer({
    nocturneVersion: "0.0.0-test",
    createRuntime: async (init) => {
      real = await createRuntime({
        cwd: ws,
        sessionsDir,
        providers: [new FakeProvider({ handler: options.handler ?? (() => []) })],
        interactive: init.interactive,
        permissions: { autoApproveAsk: true },
      });
      const base = real;
      const wrapped: Runtime = {
        ...base,
        observeSubagent: async (input, observer) => {
          if (options.manual === true) {
            return new Promise<SubagentObservation>((resolve, reject) => {
              const call: SpyCall = {
                input,
                observer,
                unsubscribed: 0,
                finish: (observation) => resolve(observation),
                fail: reject,
              };
              calls.push(call);
            });
          }
          const call: SpyCall = {
            input,
            observer,
            unsubscribed: 0,
            finish: () => undefined,
            fail: () => undefined,
          };
          calls.push(call);
          const observation = await base.observeSubagent(input, observer);
          return {
            ...observation,
            unsubscribe: () => {
              call.unsubscribed += 1;
              observation.unsubscribe();
            },
          };
        },
      };
      return { runtime: wrapped, sessionsDir };
    },
  });
  const [serverEnd, clientEnd] = createMemoryTransportPair();
  const served = server.serve(serverEnd);
  const wire: string[] = [];
  const handlers: ((line: string) => void)[] = [];
  const recordingEnd: LineTransport = {
    send: (line) => clientEnd.send(line),
    onLine: (handler) => {
      handlers.push(handler);
      clientEnd.onLine((line) => {
        wire.push(line);
        handler(line);
      });
    },
    onClose: (handler) => clientEnd.onClose(handler),
    close: () => clientEnd.close(),
  };
  const client = createRpcClient(recordingEnd, { clientName: "rpc-subagent-test" });
  await client.initialize();
  return {
    client,
    served,
    server,
    sessionsDir,
    ws,
    wire,
    inject: (line) => {
      for (const handler of handlers) handler(line);
    },
    clientTransport: clientEnd,
    calls,
    runtime: () => {
      if (real === undefined) throw new Error("Runtime 尚未创建");
      return real;
    },
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, label: string): Promise<void> {
  const begin = Date.now();
  while (!check()) {
    if (Date.now() - begin > 10_000) throw new Error(`等待超时：${label}`);
    await sleep(5);
  }
}

function collect() {
  const events: RuntimeEvent[] = [];
  const ends: SubagentReadEnd[] = [];
  const order: string[] = [];
  return {
    events,
    ends,
    order,
    observer: {
      onEvent: (e: RuntimeEvent) => {
        events.push(e);
        order.push(`event:${"seq" in e ? e.seq : e.type}`);
      },
      onEnd: (end: SubagentReadEnd) => {
        ends.push(end);
        order.push("end");
      },
    } satisfies SubagentObserver,
  };
}

const seqs = (events: RuntimeEvent[]): number[] =>
  events.flatMap((e) => ("seq" in e ? [e.seq] : []));
const notifications = (wire: string[], method: string) =>
  wire
    .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> })
    .filter((message) => message.method === method);
const fakeSummary = (parentSessionId: string, childSessionId: string): SubagentSummary => ({
  parentSessionId,
  callId: "call-x",
  childSessionId,
  profile: "default",
  taskSummary: "假的",
  startedAt: iso(0),
  state: "running",
});
const fakeObservation = (
  parentSessionId: string,
  childSessionId: string,
  call: { unsubscribed: number },
): SubagentObservation => ({
  lastSeq: 0,
  summary: fakeSummary(parentSessionId, childSessionId),
  mode: "live",
  unsubscribe: () => {
    call.unsubscribed += 1;
  },
});

// ── 测试 ────────────────────────────────────────────────────

describe("subagent.list / subscribe：已结束与快照", () => {
  it("list 不要求打开父会话；subscribe 回放快照，每条事件单独一条通知，closed 在最后", async () => {
    const made = handMade(600);
    const h = await start({ sessionsDir: made.sessionsDir });
    const list = await h.client.runtime.listSubagents(made.parentId);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      parentSessionId: made.parentId,
      childSessionId: made.childId,
      callId: "call-1",
      profile: "quick",
      taskSummary: "手写的任务",
      state: "ended",
      durationMs: 1234,
      outcome: { status: "ok" },
    });
    // 与进程内同形的对象参数
    expect(await h.client.runtime.listSubagents({ parentSessionId: made.parentId })).toEqual(list);

    const got = collect();
    const observation = await h.client.runtime.observeSubagent(
      { parentSessionId: made.parentId, childSessionId: made.childId },
      got.observer,
    );
    expect(observation.mode).toBe("snapshot");
    expect(observation.lastSeq).toBe(made.childEvents);
    expect(seqs(got.events)).toEqual(Array.from({ length: made.childEvents }, (_, i) => i + 1));
    expect(got.ends).toHaveLength(1);
    expect(got.ends[0]).toMatchObject({ source: "snapshot", tailIgnored: false });
    expect(got.order.at(-1)).toBe("end");
    expect(got.order.filter((item) => item === "end")).toHaveLength(1);

    // 线上：每条事件一条独立通知（不批量），closed 只有一条且在最后一条事件之后
    const wireEvents = notifications(h.wire, "subagent.event");
    expect(wireEvents).toHaveLength(made.childEvents);
    for (const message of wireEvents) {
      expect(message.params).toMatchObject({
        parentSessionId: made.parentId,
        childSessionId: made.childId,
      });
      expect((message.params?.event as RuntimeEvent).sessionId).toBe(made.childId);
    }
    const indices = h.wire.map((line) => (JSON.parse(line) as { method?: string }).method);
    const closedAt = indices.indexOf("subagent.closed");
    expect(indices.filter((m) => m === "subagent.closed")).toHaveLength(1);
    expect(indices.lastIndexOf("subagent.event")).toBeLessThan(closedAt);
    // 快照的 closed 先于 subscribe 响应：服务端释放表项，退订是空操作
    observation.unsubscribe();
    await sleep(20);
    expect(
      h.wire.filter((line) => (JSON.parse(line) as { id?: unknown }).id !== undefined).length,
    ).toBeGreaterThan(0);
    h.client.close();
    await h.served;
  });

  it("afterSeq 续接；非法形状 invalid_params，超过高水位同样 invalid_params", async () => {
    const made = handMade(5);
    const h = await start({ sessionsDir: made.sessionsDir });
    const got = collect();
    await h.client.runtime.observeSubagent(
      { parentSessionId: made.parentId, childSessionId: made.childId, afterSeq: 4 },
      got.observer,
    );
    expect(seqs(got.events)).toEqual(Array.from({ length: made.childEvents - 4 }, (_, i) => i + 5));

    const call = (params: Record<string, unknown>) =>
      h.client.call("subagent.subscribe", params as never);
    const base = {
      parentSessionId: made.parentId,
      childSessionId: made.childId,
      subscriptionId: "s-ok",
    };
    for (const afterSeq of [-1, 1.5, "3", Number.MAX_SAFE_INTEGER, made.childEvents + 1]) {
      await expect(call({ ...base, afterSeq })).rejects.toMatchObject({
        code: "invalid_params",
        rpcCode: -32602,
      });
    }
    for (const bad of [
      { subscriptionId: "" },
      { subscriptionId: "x".repeat(129) },
      { subscriptionId: 7 },
      { parentSessionId: 1 },
      { childSessionId: null },
    ]) {
      await expect(call({ ...base, ...bad })).rejects.toMatchObject({
        code: "invalid_params",
        rpcCode: -32602,
      });
    }
    await expect(h.client.call("subagent.list", {} as never)).rejects.toMatchObject({
      code: "invalid_params",
    });
    await expect(
      h.client.call("subagent.unsubscribe", { subscriptionId: 1 } as never),
    ).rejects.toMatchObject({ code: "invalid_params" });
    await expect(
      h.client.call("subagent.readAttachment", {
        parentSessionId: made.parentId,
        childSessionId: made.childId,
      } as never),
    ).rejects.toMatchObject({ code: "invalid_params" });
    h.client.close();
    await h.served;
  });

  it("Core 错误按 SessionError(-32002) 映射：不存在、非法 id、关系不符、日志损坏", async () => {
    const made = handMade(3);
    writeLog(made.sessionsDir, "20261021-top00001", [created("20261021-top00001")]);
    writeFileSync(path.join(made.sessionsDir, "20261021-bad00001.jsonl"), "不是 JSON\n{}\n");
    const h = await start({ sessionsDir: made.sessionsDir });
    const observe = (parentSessionId: string, childSessionId: string) =>
      h.client.runtime.observeSubagent({ parentSessionId, childSessionId }, collect().observer);
    const code = async (promise: Promise<unknown>): Promise<[string, number]> => {
      const error = (await promise.catch((e: unknown) => e)) as RpcError;
      return [error.code, error.rpcCode];
    };

    expect(await code(observe(made.parentId, "no-such-child"))).toEqual([
      "session_not_found",
      -32002,
    ]);
    expect(await code(h.client.runtime.listSubagents("no-such-parent"))).toEqual([
      "session_not_found",
      -32002,
    ]);
    expect(await code(observe(made.parentId, "../escape"))).toEqual(["invalid_session_id", -32002]);
    expect(await code(observe("a/b", made.childId))).toEqual(["invalid_session_id", -32002]);
    expect(await code(observe(made.parentId, "20261021-top00001"))).toEqual([
      "subagent_parent_mismatch",
      -32002,
    ]);
    expect(await code(observe("20261021-top00001", made.childId))).toEqual([
      "subagent_parent_mismatch",
      -32002,
    ]);
    expect(await code(observe(made.parentId, "20261021-bad00001"))).toEqual([
      "session_log_corrupt",
      -32002,
    ]);
    // 失败的订阅不留任何路由与表项：同一 id 之后仍可正常订阅
    const ok = collect();
    await h.client.runtime.observeSubagent(
      { parentSessionId: made.parentId, childSessionId: made.childId },
      ok.observer,
    );
    expect(ok.ends).toHaveLength(1);
    h.client.close();
    await h.served;
  });

  it("坏尾只忽略不写：tailIgnored 经 closed 带回，日志文件不变", async () => {
    const made = handMade(3);
    const file = path.join(made.sessionsDir, `${made.childId}.jsonl`);
    const { readFileSync, appendFileSync } = await import("node:fs");
    appendFileSync(file, '{"type":"turn.sta');
    const before = readFileSync(file);
    const h = await start({ sessionsDir: made.sessionsDir });
    const got = collect();
    await h.client.runtime.observeSubagent(
      { parentSessionId: made.parentId, childSessionId: made.childId },
      got.observer,
    );
    expect(got.ends[0]?.tailIgnored).toBe(true);
    expect(readFileSync(file).equals(before)).toBe(true);
    h.client.close();
    await h.served;
  });

  it("readAttachment：base64 往返为字节；校验失败沿用附件错误码；不要求先订阅", async () => {
    const made = handMade(2, { attachment: true });
    const h = await start({ sessionsDir: made.sessionsDir });
    const input = { parentSessionId: made.parentId, childSessionId: made.childId };
    const result = await h.client.runtime.readSubagentAttachment({ ...input, file: "img-1.png" });
    expect(result.mimeType).toBe("image/png");
    expect(result.bytes).toBe(PNG_2x3.byteLength);
    expect(Array.from(result.data)).toEqual(Array.from(PNG_2x3));
    const code = async (file: string): Promise<string> =>
      (
        (await h.client.runtime
          .readSubagentAttachment({ ...input, file })
          .catch((e: unknown) => e)) as RpcError
      ).code;
    expect(await code("img-9.png")).toBe("attachment_not_found");
    expect(await code("../img-1.png")).toBe("invalid_attachment_file");
    const other = await h.client.runtime
      .readSubagentAttachment({ ...input, parentSessionId: "20261021-nobody01", file: "img-1.png" })
      .catch((e: unknown) => e as RpcError);
    expect((other as RpcError).code).toBe("subagent_parent_mismatch");
    h.client.close();
    await h.served;
  });
});

describe("运行中的 child：真实 Runtime 门闩", () => {
  const isChild = (req: ModelRequest) => req.tools.some((tool) => tool.name === "finish");
  const finish: FakeScript = [
    { type: "tool_call", toolCallId: "f", name: "finish", input: { result: "ok" } },
    { type: "finish", reason: "tool_calls" },
  ];
  const done: FakeScript = [
    { type: "text_delta", text: "done" },
    { type: "finish", reason: "stop" },
  ];

  async function running(options: { holdUntil?: Promise<void> } = {}) {
    let open!: () => void;
    const hold = options.holdUntil ?? new Promise<void>((resolve) => (open = resolve));
    const h = await start({
      handler: async (req) => {
        if (isChild(req)) {
          await hold;
          return finish;
        }
        return req.messages.at(-1)?.role === "tool"
          ? done
          : [
              { type: "tool_call", toolCallId: "t", name: "task", input: { task: "跑一会儿" } },
              { type: "finish", reason: "tool_calls" },
            ];
      },
    });
    const { opened, session } = await h.client.runtime.createSession({ model: "fake/fake-1" });
    const submitting = session.submit({ text: "go" });
    let child: SubagentSummary | undefined;
    await until(() => {
      void h.client.runtime
        .listSubagents(opened.sessionId)
        .then((list) => {
          child = list.find((s) => s.state === "running");
        })
        .catch(() => undefined);
      return child !== undefined;
    }, "child running");
    if (child === undefined) throw new Error("unreachable");
    return { h, opened, session, submitting, child, open };
  }

  it("实时事件逐条通知；launcher 收尾后恰好一条 closed；退订之后零交付", async () => {
    const r = await running();
    const got = collect();
    const observation = await r.h.client.runtime.observeSubagent(
      { parentSessionId: r.opened.sessionId, childSessionId: r.child.childSessionId },
      got.observer,
    );
    expect(observation.mode).toBe("live");
    expect(observation.summary.state).toBe("running");
    const replayed = got.events.length;
    expect(replayed).toBeGreaterThan(0);
    // 线上没有走父 event 通道
    expect(
      notifications(r.h.wire, "event").some(
        (m) => (m.params as { sessionId: string }).sessionId === r.child.childSessionId,
      ),
    ).toBe(false);

    r.open();
    await expect(r.submitting).resolves.toBe("done");
    await until(() => got.ends.length === 1, "closed");
    expect(got.ends[0]).toMatchObject({ source: "launcher", tailIgnored: false });
    expect(got.ends[0]?.summary.state).toBe("ended");
    expect(got.order.at(-1)).toBe("end");
    expect(notifications(r.h.wire, "subagent.closed")).toHaveLength(1);
    // 自然结束后退订是空操作，不再发请求
    const before = r.h.wire.length;
    observation.unsubscribe();
    await sleep(20);
    expect(r.h.wire.length).toBe(before);
    expect(r.h.calls[0]?.unsubscribed).toBe(0);
    await r.session.close();
    r.h.client.close();
    await r.h.served;
  });

  it("退订：服务端撤销观察，child 的运行与结果不受影响，之后不再有通知", async () => {
    const r = await running();
    const got = collect();
    const observation = await r.h.client.runtime.observeSubagent(
      { parentSessionId: r.opened.sessionId, childSessionId: r.child.childSessionId },
      got.observer,
    );
    observation.unsubscribe();
    observation.unsubscribe();
    await until(() => r.h.calls[0]?.unsubscribed === 1, "服务端撤销");
    const delivered = got.events.length;
    const notices = r.h.wire.length;
    r.open();
    await expect(r.submitting).resolves.toBe("done");
    await sleep(30);
    expect(got.events).toHaveLength(delivered);
    expect(got.ends).toEqual([]);
    expect(notifications(r.h.wire.slice(notices), "subagent.event")).toEqual([]);
    expect(notifications(r.h.wire.slice(notices), "subagent.closed")).toEqual([]);
    expect(r.h.calls[0]?.unsubscribed).toBe(1);
    await r.session.close();
    r.h.client.close();
    await r.h.served;
  });

  it("同一 child 再订阅替换旧观察：旧的在服务端被撤销，迟到消息被客户端丢弃", async () => {
    const r = await running();
    const first = collect();
    const a = await r.h.client.runtime.observeSubagent(
      { parentSessionId: r.opened.sessionId, childSessionId: r.child.childSessionId },
      first.observer,
    );
    const second = collect();
    const b = await r.h.client.runtime.observeSubagent(
      { parentSessionId: r.opened.sessionId, childSessionId: r.child.childSessionId },
      second.observer,
    );
    expect(r.h.calls[0]?.unsubscribed).toBe(1);
    const firstSeen = first.events.length;
    // 旧 subscriptionId 的迟到通知被丢弃
    const stale = JSON.stringify({
      jsonrpc: "2.0",
      method: "subagent.event",
      params: {
        subscriptionId: "subagent-1",
        parentSessionId: r.opened.sessionId,
        childSessionId: r.child.childSessionId,
        event: second.events[0],
      },
    });
    r.h.inject(stale);
    expect(first.events).toHaveLength(firstSeen);
    a.unsubscribe();
    expect(r.h.calls[0]?.unsubscribed).toBe(1);

    r.open();
    await expect(r.submitting).resolves.toBe("done");
    await until(() => second.ends.length === 1, "新观察 closed");
    expect(first.ends).toEqual([]);
    expect(seqs(second.events)).toEqual(
      Array.from({ length: seqs(second.events).length }, (_, i) => i + 1),
    );
    b.unsubscribe();
    await r.session.close();
    r.h.client.close();
    await r.h.served;
  });

  it("父会话 session.close 撤销以它为 parent 的观察，不影响 child 运行", async () => {
    const r = await running();
    const got = collect();
    await r.h.client.runtime.observeSubagent(
      { parentSessionId: r.opened.sessionId, childSessionId: r.child.childSessionId },
      got.observer,
    );
    r.open();
    await r.submitting;
    await until(() => got.ends.length === 1, "closed");
    // 自然结束后表项已释放：关闭父会话时没有可撤销的观察
    await r.session.close();
    expect(r.h.calls[0]?.unsubscribed).toBe(0);
    r.h.client.close();
    await r.h.served;
  });

  it("本机断线按既有宿主行为中断 Turn：child 收尾时观察自然结束，服务端不残留表项", async () => {
    const r = await running();
    const got = collect();
    await r.h.client.runtime.observeSubagent(
      { parentSessionId: r.opened.sessionId, childSessionId: r.child.childSessionId },
      got.observer,
    );
    r.submitting.catch(() => undefined);
    r.h.client.close();
    await r.h.served;
    // 要么先自然结束（closed 已发出），要么被清理退订；两种都不留监听
    const ended = notifications(r.h.wire, "subagent.closed").length;
    expect(ended + (r.h.calls[0]?.unsubscribed ?? 0)).toBe(1);
  });
});

describe("建订阅中的取消（观察由测试控制完成时机）", () => {
  const ids = { parent: "20261021-parent01", child: "20261021-child001" };

  it("建立中被同一 child 的新订阅替换：旧请求以 subscription_cancelled 失败，迟到的旧观察立即退订", async () => {
    const h = await start({ manual: true });
    const first = collect();
    const second = collect();
    const a = h.client.runtime.observeSubagent(
      { parentSessionId: ids.parent, childSessionId: ids.child },
      first.observer,
    );
    await until(() => h.calls.length === 1, "第一次建立开始");
    const b = h.client.runtime.observeSubagent(
      { parentSessionId: ids.parent, childSessionId: ids.child },
      second.observer,
    );
    await until(() => h.calls.length === 2, "第二次建立开始");
    expect(h.calls[0]?.input.signal?.aborted).toBe(true);
    // 迟到完成的旧观察不得复活：服务端拿到它就退订，并让旧请求失败
    h.calls[0]?.finish(fakeObservation(ids.parent, ids.child, h.calls[0]));
    await expect(a).rejects.toMatchObject({ code: "subscription_cancelled", rpcCode: -32004 });
    expect(h.calls[0]?.unsubscribed).toBe(1);
    h.calls[1]?.finish(fakeObservation(ids.parent, ids.child, h.calls[1]));
    const observation = await b;
    expect(observation.mode).toBe("live");
    expect(h.calls[1]?.unsubscribed).toBe(0);
    // 旧观察的 observer 之后收到事件也被服务端挡住（已取消）
    h.calls[0]?.observer.onEvent({
      type: "runtime.status",
      sessionId: ids.child,
      runId: "r",
      eseq: 1,
      afterSeq: 0,
      time: iso(1),
      payload: { status: "thinking" },
    });
    h.calls[1]?.observer.onEvent({
      type: "runtime.status",
      sessionId: ids.child,
      runId: "r",
      eseq: 2,
      afterSeq: 0,
      time: iso(2),
      payload: { status: "idle" },
    });
    await until(() => second.events.length === 1, "新观察收到事件");
    expect(first.events).toEqual([]);
    expect(notifications(h.wire, "subagent.event")).toHaveLength(1);
    h.client.close();
    await h.served;
    expect(h.calls[1]?.unsubscribed).toBe(1);
  });

  it("建立中断线：signal 立即取消，迟到的结果不复活，且不向已断开的连接发任何消息", async () => {
    const h = await start({ manual: true });
    const pending = h.client.runtime.observeSubagent(
      { parentSessionId: ids.parent, childSessionId: ids.child },
      collect().observer,
    );
    const settled = pending.then(
      () => "resolved",
      (error: RpcError) => error.code,
    );
    await until(() => h.calls.length === 1, "建立开始");
    h.client.close();
    // 断线不等在途的建立：signal 马上被取消
    await until(() => h.calls[0]?.input.signal?.aborted === true, "signal 被取消");
    const sent = h.wire.length;
    h.calls[0]?.finish(fakeObservation(ids.parent, ids.child, h.calls[0]));
    await h.served;
    expect(h.calls[0]?.unsubscribed).toBe(1);
    expect(notifications(h.wire.slice(sent), "subagent.event")).toEqual([]);
    expect(await settled).toBe("connection_closed");
  });

  it("已建立的观察：本机断线与 shutdown 都撤销它", async () => {
    const first = await start({ manual: true });
    const a = first.client.runtime.observeSubagent(
      { parentSessionId: ids.parent, childSessionId: ids.child },
      collect().observer,
    );
    await until(() => first.calls.length === 1, "建立开始");
    first.calls[0]?.finish(fakeObservation(ids.parent, ids.child, first.calls[0]));
    await a;
    first.client.close();
    await first.served;
    expect(first.calls[0]?.unsubscribed).toBe(1);

    const second = await start({ manual: true });
    const b = second.client.runtime.observeSubagent(
      { parentSessionId: ids.parent, childSessionId: ids.child },
      collect().observer,
    );
    await until(() => second.calls.length === 1, "建立开始");
    second.calls[0]?.finish(fakeObservation(ids.parent, ids.child, second.calls[0]));
    await b;
    await second.client.shutdown();
    await second.served;
    expect(second.calls[0]?.unsubscribed).toBe(1);
  });

  it("已建立的观察：关闭它的父会话只撤销以该会话为 parent 的观察，其余不受影响", async () => {
    const h = await start({ manual: true });
    const { opened, session } = await h.client.runtime.createSession({ model: "fake/fake-1" });
    const mine = h.client.runtime.observeSubagent(
      { parentSessionId: opened.sessionId, childSessionId: ids.child },
      collect().observer,
    );
    const other = h.client.runtime.observeSubagent(
      { parentSessionId: ids.parent, childSessionId: ids.child },
      collect().observer,
    );
    await until(() => h.calls.length === 2, "两个建立都开始");
    h.calls[0]?.finish(fakeObservation(opened.sessionId, ids.child, h.calls[0]));
    h.calls[1]?.finish(fakeObservation(ids.parent, ids.child, h.calls[1]));
    await Promise.all([mine, other]);
    await session.close();
    expect(h.calls[0]?.unsubscribed).toBe(1);
    expect(h.calls[0]?.input.signal?.aborted).toBe(true);
    expect(h.calls[1]?.unsubscribed).toBe(0);
    h.client.close();
    await h.served;
    expect(h.calls[1]?.unsubscribed).toBe(1);
  });

  it("建立中被 subagent.unsubscribe 或父 session.close 取消", async () => {
    const h = await start({ manual: true });
    // subagent.unsubscribe（直接按线上协议，客户端封装在建立期间不暴露句柄）
    const first = h.client.call("subagent.subscribe", {
      parentSessionId: ids.parent,
      childSessionId: ids.child,
      subscriptionId: "manual-1",
    });
    first.catch(() => undefined);
    await until(() => h.calls.length === 1, "第一次建立开始");
    await h.client.call("subagent.unsubscribe", { subscriptionId: "manual-1" });
    expect(h.calls[0]?.input.signal?.aborted).toBe(true);
    // 重复退订幂等
    await h.client.call("subagent.unsubscribe", { subscriptionId: "manual-1" });
    h.calls[0]?.finish(fakeObservation(ids.parent, ids.child, h.calls[0]));
    await expect(first).rejects.toMatchObject({ code: "subscription_cancelled" });
    expect(h.calls[0]?.unsubscribed).toBe(1);
    // 同一 subscriptionId 取消后可以再次使用
    const again = h.client.call("subagent.subscribe", {
      parentSessionId: ids.parent,
      childSessionId: ids.child,
      subscriptionId: "manual-1",
    });
    again.catch(() => undefined);
    await until(() => h.calls.length === 2, "再次建立开始");
    // 在用的 subscriptionId 重复 → invalid_params，且不影响在建的那一个
    await expect(
      h.client.call("subagent.subscribe", {
        parentSessionId: ids.parent,
        childSessionId: "20261021-child002",
        subscriptionId: "manual-1",
      }),
    ).rejects.toMatchObject({ code: "invalid_params" });
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]?.input.signal?.aborted).toBe(false);

    // 父会话 close：打开真实父会话，在建的观察以它为 parent
    const { opened, session } = await h.client.runtime.createSession({ model: "fake/fake-1" });
    const forParent = h.client.call("subagent.subscribe", {
      parentSessionId: opened.sessionId,
      childSessionId: ids.child,
      subscriptionId: "manual-2",
    });
    forParent.catch(() => undefined);
    await until(() => h.calls.length === 3, "父会话下建立开始");
    await session.close();
    expect(h.calls[2]?.input.signal?.aborted).toBe(true);
    expect(h.calls[1]?.input.signal?.aborted).toBe(false);
    h.calls[2]?.finish(fakeObservation(opened.sessionId, ids.child, h.calls[2]));
    await expect(forParent).rejects.toMatchObject({ code: "subscription_cancelled" });
    expect(h.calls[2]?.unsubscribed).toBe(1);
    h.calls[1]?.fail(new Error("收尾"));
    h.client.close();
    await h.served;
  });

  it("建立期间 Core 抛错：表项清理，错误原样返回", async () => {
    const h = await start({ manual: true });
    const pending = h.client.runtime.observeSubagent(
      { parentSessionId: ids.parent, childSessionId: ids.child },
      collect().observer,
    );
    await until(() => h.calls.length === 1, "建立开始");
    h.calls[0]?.fail(new Error("读取失败"));
    await expect(pending).rejects.toMatchObject({ message: "读取失败" });
    // 同一对 (parent, child) 的表项已清理，再订阅不会误判替换
    const retry = h.client.runtime.observeSubagent(
      { parentSessionId: ids.parent, childSessionId: ids.child },
      collect().observer,
    );
    await until(() => h.calls.length === 2, "再次建立开始");
    expect(h.calls[0]?.input.signal?.aborted).toBe(true);
    expect(h.calls[1]?.input.signal?.aborted).toBe(false);
    h.calls[1]?.finish(fakeObservation(ids.parent, ids.child, h.calls[1]));
    await retry;
    h.client.close();
    await h.served;
  });
});

describe("远程连接：新方法不进白名单", () => {
  it("四个方法与两个通知都不对远程开放，Core 零调用", async () => {
    for (const method of [
      "subagent.list",
      "subagent.readAttachment",
      "subagent.subscribe",
      "subagent.unsubscribe",
    ]) {
      expect((REMOTE_METHODS as readonly string[]).includes(method)).toBe(false);
    }
    const made = handMade(3);
    const h = await start({ sessionsDir: made.sessionsDir });
    const [serverEnd, remoteEnd] = createMemoryTransportPair();
    const servedRemote = h.server.serve(serverEnd, { origin: "remote" });
    const remote = createRpcClient(remoteEnd, { clientName: "phone" });
    await remote.initialize();
    const params = {
      parentSessionId: made.parentId,
      childSessionId: made.childId,
      subscriptionId: "r-1",
      file: "img-1.png",
    };
    const denied = async (promise: Promise<unknown>) =>
      expect(await promise.catch((e: unknown) => e)).toMatchObject({
        code: "remote_not_allowed",
        rpcCode: -32004,
      });
    await denied(remote.call("subagent.list", { parentSessionId: made.parentId }));
    await denied(remote.call("subagent.subscribe", params));
    await denied(remote.call("subagent.unsubscribe", { subscriptionId: "r-1" }));
    await denied(remote.call("subagent.readAttachment", params));
    await denied(remote.runtime.listSubagents(made.parentId));
    await denied(
      remote.runtime.observeSubagent(
        { parentSessionId: made.parentId, childSessionId: made.childId },
        collect().observer,
      ),
    );
    expect(h.calls).toEqual([]);
    // 本机连接不受影响
    expect(await h.client.runtime.listSubagents(made.parentId)).toHaveLength(1);
    remote.close();
    await servedRemote;
    h.client.close();
    await h.served;
  });
});

describe("订阅标识", () => {
  it("客户端为每次观察生成本连接内不复用的 subscriptionId", async () => {
    const made = handMade(2);
    const h = await start({ sessionsDir: made.sessionsDir });
    for (let i = 0; i < 3; i++) {
      await h.client.runtime.observeSubagent(
        { parentSessionId: made.parentId, childSessionId: made.childId },
        collect().observer,
      );
    }
    const ids = notifications(h.wire, "subagent.closed").map((m) => m.params?.subscriptionId);
    expect(new Set(ids).size).toBe(3);
    h.client.close();
    await h.served;
  });
});
