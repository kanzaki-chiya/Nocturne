// @vitest-environment jsdom
/**
 * 成员会话标签（src/ensemble-member-session.ts）：挂载时经幂等的 session.open
 * 打开成员子会话并折叠事件，可直接对成员发私信、确认权限；关闭标签只释放
 * 本连接的引用（session.close），绝不中断仍在工作的成员。
 */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { RuntimeEvent } from "@nocturne/core/protocol";
import { createMemoryTransportPair, createRpcClient } from "@nocturne/rpc/client";

import {
  useEnsembleMemberSession,
  type EnsembleMemberSessionReady,
} from "../src/ensemble-member-session";

afterEach(cleanup);

const CHILD = "child-1";

/**
 * 假后台：按方法名应答，并把收到的每一行原样归档——`session.interrupt`
 * 是没有 id 的通知，只有记录原始报文才能断言它没有发出。
 */
function harness() {
  const [clientEnd, serverEnd] = createMemoryTransportPair();
  const requests: { id?: unknown; method: string; params: Record<string, unknown> }[] = [];
  const replies: Record<string, unknown> = {
    initialize: { protocolVersion: 1, nocturneVersion: "test" },
    "session.open": {
      sessionId: CHILD,
      meta: {
        id: CHILD,
        cwd: "Z:/project",
        workspaceRoot: "Z:/project",
        formatVersion: 1,
        nocturneVersion: "test",
      },
      config: { model: { provider: "test", model: "cheap" } },
      warnings: [],
      lastSeq: 0,
    },
    "session.subscribe": { lastSeq: 0 },
    "session.pendingInputs": { items: [], paused: false },
    "session.describeSkills": {
      skills: [{ name: "review" }],
      warnings: [],
      budget: {},
      scannedDirs: [],
      homeDir: "C:/home",
    },
    "session.describeExternalAgents": { agents: [{ name: "omp", enabled: false }], warnings: [] },
    "session.shellInfo": {
      selected: "auto",
      source: "auto",
      effective: { kind: "pwsh", name: "PowerShell 7", path: "pwsh" },
    },
    "session.submit": "done",
    "session.respondPermission": null,
    "session.close": null,
  };

  serverEnd.onLine((line) => {
    const request = JSON.parse(line) as {
      id?: unknown;
      method?: string;
      params?: Record<string, unknown>;
    };
    const method = request.method ?? "";
    requests.push({ id: request.id, method, params: request.params ?? {} });
    // 通知（interrupt 等）没有 id：只归档，不回复
    if (request.id === undefined) return;
    serverEnd.send(
      JSON.stringify({ jsonrpc: "2.0", id: request.id, result: replies[method] ?? null }),
    );
  });

  const client = createRpcClient(clientEnd, { clientName: "test", interactive: false });
  let initialized: Promise<unknown> | undefined;
  return {
    requests,
    calls: (method: string) => requests.filter((request) => request.method === method),
    /** 服务端 → 客户端推一条会话事件 */
    emit(event: RuntimeEvent) {
      serverEnd.send(
        JSON.stringify({ jsonrpc: "2.0", method: "event", params: { sessionId: CHILD, event } }),
      );
    },
    ensureClient: () => {
      initialized ??= client.initialize();
      return initialized.then(() => client);
    },
    close() {
      client.close();
      serverEnd.close();
    },
  };
}

it("经 session.open 打开成员子会话：折叠事件、发私信、确认权限", async () => {
  const server = harness();
  const hook = renderHook(() =>
    useEnsembleMemberSession({
      ensureClient: server.ensureClient,
      childSessionId: CHILD,
      fallbackCwd: "Z:/maestro",
    }),
  );
  await vi.waitFor(() => expect(hook.result.current.status).toBe("ready"));
  const ready = () => hook.result.current as EnsembleMemberSessionReady;

  // 打开走 session.open（幂等），cwd 取会话元数据而不是回退值
  expect(server.calls("session.open").map((call) => call.params)).toEqual([{ sessionId: CHILD }]);
  expect(server.calls("runtime.resumeSession")).toEqual([]);
  expect(ready().session.id).toBe(CHILD);
  expect(ready().cwd).toBe("Z:/project");
  expect(ready().running).toBe(false);
  expect(ready().busy).toBe(false);
  await vi.waitFor(() => expect(ready().shellKind).toBe("pwsh"));
  await vi.waitFor(() => expect(ready().skills.map((skill) => skill.name)).toEqual(["review"]));
  await vi.waitFor(() =>
    expect(ready().externalAgents.map((agent) => agent.name)).toEqual(["omp"]),
  );

  // 持久事件折叠进 entries，临时 runtime.status 进 status 并让 running/busy 跟随
  const before = ready().version;
  await act(async () => {
    server.emit({
      type: "message.user",
      sessionId: CHILD,
      seq: 1,
      time: "2026-11-12T00:00:00.000Z",
      payload: { messageId: "m-1", content: [{ type: "text", text: "私信内容" }] },
    });
    server.emit({
      type: "runtime.status",
      sessionId: CHILD,
      runId: "run-1",
      eseq: 1,
      afterSeq: 1,
      time: "2026-11-12T00:00:01.000Z",
      payload: { status: "thinking" },
    });
  });
  await vi.waitFor(() => expect(ready().version).toBeGreaterThan(before));
  expect(ready().view.entries).toHaveLength(1);
  expect(ready().view.status).toBe("thinking");
  expect(ready().running).toBe(true);
  expect(ready().busy).toBe(true);

  // 等待确认时 busy 保持，确认走成员自己的会话
  await act(async () => {
    server.emit({
      type: "permission.requested",
      sessionId: CHILD,
      seq: 2,
      time: "2026-11-12T00:00:02.000Z",
      payload: {
        requestId: "req-1",
        callId: "c-1",
        subjects: [{ kind: "shell", target: "pnpm test" }],
        reason: "需要确认",
        options: ["allow_once", "deny"],
      },
    });
  });
  await vi.waitFor(() => expect(ready().view.pendingPermission?.requestId).toBe("req-1"));
  await act(async () => {
    await ready().session.respondPermission("req-1", { decision: "allow" });
  });
  expect(server.calls("session.respondPermission").map((call) => call.params)).toEqual([
    { sessionId: CHILD, requestId: "req-1", reply: { decision: "allow" } },
  ]);

  // 私信：直接对成员会话 submit，不经过指挥
  await act(async () => {
    await ready().session.submit({ text: "把校验补上" });
  });
  expect(server.calls("session.submit").map((call) => call.params)).toEqual([
    { sessionId: CHILD, text: "把校验补上" },
  ]);

  // 外部订阅者（Conversation 的思考计时）拿到同一路事件
  const seen: string[] = [];
  const stop = ready().subscribeEvents((event) => seen.push(event.type));
  await act(async () => {
    server.emit({
      type: "question.requested",
      sessionId: CHILD,
      runId: "run-1",
      eseq: 2,
      afterSeq: 2,
      time: "2026-11-12T00:00:03.000Z",
      payload: { requestId: "q-1", callId: "c-2", questions: [{ question: "继续吗" }] },
    });
  });
  await vi.waitFor(() => expect(seen).toEqual(["question.requested"]));
  stop();
  server.close();
});

it("关闭成员标签只退订并 session.close，不中断成员", async () => {
  const server = harness();
  const hook = renderHook(() =>
    useEnsembleMemberSession({
      ensureClient: server.ensureClient,
      childSessionId: CHILD,
      fallbackCwd: "Z:/maestro",
    }),
  );
  await vi.waitFor(() => expect(hook.result.current.status).toBe("ready"));

  await act(async () => {
    hook.unmount();
  });
  await vi.waitFor(() => expect(server.calls("session.close")).toHaveLength(1));
  const methods = server.requests.map((request) => request.method);
  expect(methods).toContain("session.unsubscribe");
  expect(methods.indexOf("session.unsubscribe")).toBeLessThan(methods.indexOf("session.close"));
  expect(server.calls("session.close").map((call) => call.params)).toEqual([{ sessionId: CHILD }]);
  // 成员可能仍在工作：关闭标签绝不发 interrupt
  expect(methods).not.toContain("session.interrupt");
  server.close();
});
