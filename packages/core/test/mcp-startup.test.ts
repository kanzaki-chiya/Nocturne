import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  createCredentialStore,
  createPlatform,
  createRuntime,
  FakeProvider,
  loadConfig,
  type McpConnector,
  type McpSession,
  type ToolDefinition,
  type RuntimeEvent,
  createSessionView,
  reduceSessionView,
} from "../src/index.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
function deferred<T>() {
  let resolve!: (value?: T) => void;
  const promise = new Promise<T | undefined>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const tool: ToolDefinition = {
  name: "mcp__slow__echo",
  description: "slow echo",
  inputSchema: { type: "object" },
  traits: { mutates: false, concurrencySafe: true, timeoutMs: 1000 },
  permissionSubjects: () => [{ kind: "mcp", target: "slow/echo" }],
  execute: async () => ({ status: "ok", modelContent: "ok" }),
};

async function fixture(
  handler?: ConstructorParameters<typeof FakeProvider>[0]["handler"],
  recover = false,
) {
  const root = await mkdtemp(path.join(tmpdir(), "nct-mcp-startup-"));
  roots.push(root);
  const gate = deferred<boolean>();
  const waited = deferred<undefined>();
  let state: "starting" | "ready" | "failed" = "starting";
  let staged = false;
  let applied = false;
  let prepareCalls = 0;
  let scope: Parameters<McpConnector["open"]>[0] | undefined;
  const provider = new FakeProvider({
    handler,
    scripts: [
      [
        { type: "text_delta", text: "first" },
        { type: "finish", reason: "stop" },
      ],
      [
        { type: "text_delta", text: "second" },
        { type: "finish", reason: "stop" },
      ],
    ],
  });
  const connector: McpConnector = {
    probe: async () => ({ ok: true, durationMs: 0, tools: [] }),
    open: async (s) => {
      scope = s;
      const startup = gate.promise.then((ok) => {
        state = ok ? "ready" : "failed";
        staged = ok === true;
        if (!ok) s.warn("mcp_server_failed", "slow failed");
      });
      const session: McpSession = {
        startup: async (signal) => {
          waited.resolve();
          if (signal?.aborted) return;
          let abort!: () => void;
          const cancelled = new Promise<void>((r) => {
            abort = () => {
              r();
            };
            signal?.addEventListener("abort", abort, { once: true });
          });
          try {
            await Promise.race([startup, cancelled]);
          } finally {
            signal?.removeEventListener("abort", abort);
          }
        },
        status: () => [{ name: "slow", state, toolCount: 0, restarts: 0 }],
        ...(recover
          ? {
              prepareTurn: async () => {
                prepareCalls++;
                state = "ready";
                staged = true;
              },
            }
          : {}),
        tools: () => (applied ? [tool] : []),
        reconcile: async () => undefined,
        applyPendingTools: () => {
          const add = staged && !applied ? [tool] : [];
          applied ||= staged;
          staged = false;
          return { add, remove: [] };
        },
        close: async () => undefined,
      };
      return session;
    },
  };
  const runtime = await createRuntime({
    cwd: root,
    sessionsDir: path.join(root, "sessions"),
    providers: [provider],
    mcp: connector,
  });
  return {
    runtime,
    provider,
    gate,
    waited,
    prepareCalls: () => prepareCalls,
    scope: () => scope,
    stage: () => {
      state = "ready";
      staged = true;
      applied = false;
    },
  };
}

it("createSession 与 resumeSession 在慢服务器完成前返回；首 Turn 等待后请求包含工具", async () => {
  const f = await fixture();
  let session = await f.runtime.createSession({ model: "fake/fake-1" });
  expect(session.mcpServers()[0]?.state).toBe("starting");
  const id = session.id;
  await session.close();
  session = await f.runtime.resumeSession(id);
  expect(session.mcpServers()[0]?.state).toBe("starting");
  const turn = session.submit({ text: "first" });
  await f.waited.promise;
  expect(f.provider.requests).toHaveLength(0);
  f.gate.resolve(true);
  expect(await turn).toBe("done");
  expect(f.provider.requests[0]?.tools.some((t) => t.name === tool.name)).toBe(true);
  await session.close();
});

it("Turn 等待中断以 aborted 结束，后台继续、下一 Turn 获得工具", async () => {
  const f = await fixture();
  const session = await f.runtime.createSession({ model: "fake/fake-1" });
  const events: RuntimeEvent[] = [];
  session.subscribe((e) => events.push(e));
  const first = session.submit({ text: "first" });
  await f.waited.promise;
  session.interrupt();
  expect(await first).toBe("aborted");
  expect(events.some((e) => e.type === "turn.completed" && e.payload.reason === "aborted")).toBe(
    true,
  );
  expect(session.mcpServers()[0]?.state).toBe("starting");
  f.gate.resolve(true);
  await session.submit({ text: "second" });
  expect(f.provider.requests[0]?.tools.some((t) => t.name === tool.name)).toBe(true);
  await session.close();
});

it("启动失败解除首 Turn 等待，不注册工具，警告保持", async () => {
  const f = await fixture();
  const session = await f.runtime.createSession({ model: "fake/fake-1" });
  const warnings: RuntimeEvent[] = [];
  session.subscribe((e) => {
    if (e.type === "runtime.warning") warnings.push(e);
  });
  const first = session.submit({ text: "first" });
  await f.waited.promise;
  f.gate.resolve(false);
  expect(await first).toBe("done");
  expect(f.provider.requests[0]?.tools.some((t) => t.name === tool.name)).toBe(false);
  expect(warnings).toHaveLength(1);
  const warning = warnings[0];
  expect(warning?.type === "runtime.warning" && warning.payload.code).toBe("mcp_server_failed");
  const view = createSessionView();
  for (const event of warnings) reduceSessionView(view, event);
  expect(view.notices).toEqual([
    { level: "warning", code: "mcp_server_failed", message: "slow failed" },
  ]);
  await session.close();
});

it("每个主 Turn 调用 prepareTurn，恢复工具在首次请求前应用", async () => {
  const f = await fixture(undefined, true);
  const session = await f.runtime.createSession({ model: "fake/fake-1" });
  f.gate.resolve(false);
  try {
    expect(await session.submit({ text: "first" })).toBe("done");
    expect(f.prepareCalls()).toBe(1);
    expect(f.provider.requests[0]?.tools.some((t) => t.name === tool.name)).toBe(true);
    expect(await session.submit({ text: "second" })).toBe("done");
    expect(f.prepareCalls()).toBe(2);
  } finally {
    await session.close();
  }
});

it("Turn 进行中才就绪的工具保持暂存，本轮请求不变、下一 Turn 出现", async () => {
  const entered = deferred<undefined>();
  const hold = deferred<undefined>();
  const f = await fixture(async (_request, index) => {
    if (index === 0) {
      entered.resolve();
      await hold.promise;
    }
    return [
      { type: "text_delta", text: "done" },
      { type: "finish", reason: "stop" },
    ];
  });
  const session = await f.runtime.createSession({ model: "fake/fake-1" });
  f.gate.resolve(false);
  const first = session.submit({ text: "first" });
  await entered.promise;
  f.stage();
  expect(f.provider.requests[0]?.tools.some((t) => t.name === tool.name)).toBe(false);
  hold.resolve();
  expect(await first).toBe("done");
  expect(f.provider.requests[0]?.tools.some((t) => t.name === tool.name)).toBe(false);
  await session.submit({ text: "next" });
  expect(f.provider.requests[1]?.tools.some((t) => t.name === tool.name)).toBe(true);
  await session.close();
});

it("重配挂起时中断立即结束 Turn，后台完成后下一 Turn 应用新工具", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "nct-mcp-reconcile-"));
  roots.push(home);
  const platform = createPlatform();
  const credentials = (await createCredentialStore(platform, home, { backend: "memory" })).store;
  const config = await loadConfig(platform, {
    nocturneHome: home,
    credentials,
    env: () => undefined,
  });
  const entered = deferred<undefined>();
  const hold = deferred<undefined>();
  let staged = false;
  let applied = false;
  const fresh: ToolDefinition = {
    name: "mcp__fresh__echo",
    description: "fresh echo",
    inputSchema: { type: "object" },
    traits: { mutates: false, concurrencySafe: true, timeoutMs: 1000 },
    permissionSubjects: () => [{ kind: "mcp", target: "fresh/echo" }],
    execute: async () => ({ status: "ok", modelContent: "ok" }),
  };
  const provider = new FakeProvider({
    handler: () => [
      { type: "text_delta", text: "done" },
      { type: "finish", reason: "stop" },
    ],
  });
  const connector: McpConnector = {
    probe: async () => ({ ok: true, durationMs: 0, tools: [] }),
    open: async () => ({
      startup: async () => undefined,
      tools: () => (applied ? [fresh] : []),
      status: () => [{ name: "fresh", state: "ready", toolCount: applied ? 1 : 0, restarts: 0 }],
      reconcile: async () => {
        entered.resolve();
        await hold.promise;
        staged = true;
      },
      applyPendingTools: () => {
        const add = staged && !applied ? [fresh] : [];
        applied ||= staged;
        staged = false;
        return { add, remove: [] };
      },
      close: async () => undefined,
    }),
  };
  const runtime = await createRuntime({
    cwd: home,
    config,
    providers: [provider],
    mcp: connector,
  });
  const session = await runtime.createSession({ model: "fake/fake-1" });
  const events: RuntimeEvent[] = [];
  session.subscribe((event) => events.push(event));
  // 空闲保存：refreshMcp 立即开始 reconcile，并卡在 hold 上。
  const saved = runtime.saveMcpServer({ mode: "create", id: "fresh", config: { command: "node" } });
  void saved.catch(() => undefined);
  await entered.promise;
  const turn = session.submit({ text: "first" });
  session.interrupt();
  // 中断只放弃等待：Turn 立即以 aborted 结束，且没有发出模型请求。
  expect(await turn).toBe("aborted");
  expect(
    events.some((event) => event.type === "turn.completed" && event.payload.reason === "aborted"),
  ).toBe(true);
  expect(provider.requests).toHaveLength(0);
  // 放行后台 reconcile：完成后下一 Turn 应该能用到新工具。
  hold.resolve();
  await saved;
  expect(await session.submit({ text: "second" })).toBe("done");
  expect(provider.requests.at(-1)?.tools.some((t) => t.name === fresh.name)).toBe(true);
  await session.close();
});
