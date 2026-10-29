import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  createRuntime,
  FakeProvider,
  createMcpOnDemandTools,
  createPlatform,
  createCredentialStore,
  loadConfig,
  createSessionView,
  reduceSessionView,
  type McpConnector,
  type McpServerStatus,
  type RuntimeEvent,
} from "../src/index.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture(
  initial: McpServerStatus["state"] = "failed",
  autoRetry = true,
  abort = false,
  configured = false,
) {
  const root = await mkdtemp(path.join(tmpdir(), "nct-mcp-notes-"));
  roots.push(root);
  let statuses: McpServerStatus[] = [
    {
      name: "browseros",
      state: initial,
      toolCount: 0,
      restarts: 0,
      error: "connection refused",
      autoRetry,
    },
  ];
  const provider = new FakeProvider({
    handler: () => [
      { type: "text_delta", text: "done" },
      { type: "finish", reason: "stop" },
    ],
  });
  const platform = createPlatform();
  const credentials = (await createCredentialStore(platform, root, { backend: "memory" })).store;
  const config = await loadConfig(platform, {
    nocturneHome: root,
    credentials,
    env: () => undefined,
  });
  if (configured)
    await config.saveMcpServer({ mode: "create", id: "browseros", config: { command: "unused" } });
  let interrupt: () => void = () => undefined;
  const connector: McpConnector = {
    probe: async () => ({ ok: true, durationMs: 0, tools: [] }),
    open: async () => ({
      startup: async () => {
        if (abort) interrupt();
      },
      prepareTurn: async () => {
        if (abort) interrupt();
      },
      tools: () => [],
      status: () => statuses,
      reconcile: async (servers) => {
        statuses = servers
          .filter((s) => s.enabled !== false)
          .map(
            (s) =>
              statuses.find((status) => status.name === s.name) ?? {
                name: s.name,
                state: "failed",
                error: "connection refused",
                autoRetry: true,
                restarts: 0,
                toolCount: 0,
              },
          );
      },
      applyPendingTools: () => ({ add: [], remove: [] }),
      close: async () => undefined,
    }),
  };
  const runtime = await createRuntime({
    cwd: root,
    ...(configured ? { config } : {}),
    sessionsDir: path.join(root, "sessions"),
    providers: [provider],
    mcp: connector,
  });
  let session = await runtime.createSession({ model: "fake/fake-1" });
  interrupt = () => session.interrupt();
  const events: RuntimeEvent[] = [];
  session.subscribe((e) => events.push(e));
  return {
    provider,
    runtime,
    events,
    get session() {
      return session;
    },
    setState(state: McpServerStatus["state"]) {
      statuses = statuses.map((s) => ({ ...s, state }));
    },
    remove() {
      statuses = [];
    },
    async resume() {
      const id = session.id;
      await session.close();
      session = await runtime.resumeSession(id);
      session.subscribe((e) => events.push(e));
    },
  };
}
function notes(events: RuntimeEvent[]) {
  return events.filter((e) => e.type === "session.config_changed" && e.payload.mcp !== undefined);
}

it("首轮失败在用户消息后持久记录；恢复与后续稳定轮只写变化，消息前缀稳定", async () => {
  const f = await fixture();
  try {
    await f.session.submit({ text: "first" });
    expect(notes(f.events)).toHaveLength(1);
    const view = createSessionView();
    for (const event of notes(f.events)) reduceSessionView(view, event);
    expect(view.entries).toEqual([]);
    expect(notes(f.events)[0]).toMatchObject({
      payload: {
        mcp: [
          { server: "browseros", available: false, reason: "connection refused", autoRetry: true },
        ],
      },
    });
    const first = f.provider.requests[0] as (typeof f.provider.requests)[number];
    expect(JSON.stringify(first.messages)).toContain("[Environment change] MCP server");
    expect(JSON.stringify(first.messages).indexOf("first")).toBeLessThan(
      JSON.stringify(first.messages).indexOf("[Environment change]"),
    );
    f.setState("ready");
    await f.session.submit({ text: "second" });
    expect(notes(f.events)).toHaveLength(2);
    expect(JSON.stringify(f.provider.requests[1]?.messages)).toContain("available again");
    expect(f.provider.requests[1]?.messages.slice(0, first.messages.length)).toEqual(
      first.messages,
    );
    await f.session.submit({ text: "third" });
    expect(notes(f.events)).toHaveLength(2);
  } finally {
    await f.session.close();
  }
});
it("恢复会话仍失败不重复写，重放 note 一致；压缩不记录 MCP", async () => {
  const f = await fixture();
  try {
    await f.session.submit({ text: "first" });
    const before = f.provider.requests[0]?.messages;
    await f.resume();
    await f.session.submit({ text: "second" });
    expect(notes(f.events)).toHaveLength(1);
    expect(f.provider.requests[1]?.messages.slice(0, before?.length)).toEqual(before);
    f.setState("ready");
    await f.session.compact();
    expect(notes(f.events)).toHaveLength(1);
  } finally {
    await f.session.close();
  }
});
it.each(["ready", "stopped"] as const)("%s 不记录不可用", async (state) => {
  const f = await fixture(state);
  try {
    await f.session.submit({ text: "test" });
    expect(notes(f.events)).toEqual([]);
    expect(JSON.stringify(f.provider.requests[0]?.messages)).not.toContain("[Environment change]");
  } finally {
    await f.session.close();
  }
});
it("starting 超时与重连耗尽使用对应文字", async () => {
  const f = await fixture("starting", false);
  try {
    await f.session.submit({ text: "test" });
    expect(notes(f.events)[0]).toMatchObject({
      payload: { mcp: [{ reason: "startup timed out", autoRetry: false }] },
    });
    expect(JSON.stringify(f.provider.requests[0]?.messages)).toContain(
      "will not retry it automatically in this session",
    );
  } finally {
    await f.session.close();
  }
});
it("删除失败服务器不补恢复说明", async () => {
  const f = await fixture();
  try {
    await f.session.submit({ text: "first" });
    f.remove();
    await f.session.submit({ text: "second" });
    expect(notes(f.events)).toHaveLength(1);
  } finally {
    await f.session.close();
  }
});
it("准备阶段已中断不写说明", async () => {
  const f = await fixture("starting", true, true);
  try {
    expect(await f.session.submit({ text: "test" })).toBe("aborted");
    expect(notes(f.events)).toEqual([]);
    expect(f.provider.requests).toEqual([]);
  } finally {
    await f.session.close();
  }
});
it.each(["disable", "delete"] as const)(
  "配置 %s 经 reconcile 不写恢复，新增失败服务器记录不可用",
  async (action) => {
    const f = await fixture("failed", true, false, true);
    try {
      await f.session.submit({ text: "first" });
      if (action === "disable")
        await f.runtime.setMcpServerEnabled({ id: "browseros", enabled: false });
      else await f.runtime.deleteMcpServer({ id: "browseros" });
      await f.session.submit({ text: "second" });
      expect(notes(f.events)).toHaveLength(1);
      await f.runtime.saveMcpServer({
        mode: "create",
        id: "newserver",
        config: { command: "unused" },
      });
      await f.session.submit({ text: "third" });
      expect(notes(f.events)).toHaveLength(2);
      expect(notes(f.events)[1]).toMatchObject({
        payload: { mcp: [{ server: "newserver", available: false }] },
      });
    } finally {
      await f.session.close();
    }
  },
);

it("新增服务器正常时不记录说明", async () => {
  const f = await fixture("ready", true, false, true);
  try {
    await f.session.submit({ text: "first" });
    await f.runtime.saveMcpServer({
      mode: "create",
      id: "newserver",
      config: { command: "unused" },
    });
    f.setState("ready");
    await f.session.submit({ text: "second" });
    expect(notes(f.events)).toEqual([]);
  } finally {
    await f.session.close();
  }
});

it("回退掉不可用说明后仍失败，下一 Turn 重新记录", async () => {
  const f = await fixture();
  try {
    await f.session.submit({ text: "first" });
    const user = f.events.find((e) => e.type === "message.user");
    if (user?.type !== "message.user") throw new Error("missing user message");
    await f.session.rewind(user.seq, "conversation");
    await f.session.submit({ text: "second" });
    expect(notes(f.events)).toHaveLength(2);
    expect(JSON.stringify(f.provider.requests[1]?.messages)).not.toContain("first");
    expect(JSON.stringify(f.provider.requests[1]?.messages)).toContain("is unavailable");
  } finally {
    await f.session.close();
  }
});

it("按需工具名服务器段规范化后指出不可用与原因，仍列可用服务器", () => {
  const pair = createMcpOnDemandTools([], ["healthy"], () => [
    { name: "Browser-OS", state: "failed", toolCount: 0, restarts: 0, error: "connection refused" },
  ]);
  const result = pair.callTool.traits.dispatch?.({ tool: "mcp__browser_os__open" });
  expect(result).toMatchObject({ code: "unknown_tool" });
  expect(JSON.stringify(result)).toContain("当前不可用（connection refused）");
  expect(JSON.stringify(result)).toContain("healthy");
});
