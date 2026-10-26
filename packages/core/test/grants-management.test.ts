import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config/index.js";
import { loadGrantStore, workspaceKey } from "../src/config/grants.js";
import { createPlatform } from "../src/platform/index.js";
import { createRuntime } from "../src/index.js";
import { FakeProvider, type FakeScript } from "../src/provider/index.js";
import { createRulePolicy } from "../src/permission/index.js";
import {
  durableEventSchema,
  replaySessionView,
  type Grant,
  type RuntimeEvent,
} from "../src/protocol/index.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nct-grants-"));
  roots.push(root);
  const workspace = path.join(root, "workspace");
  const home = path.join(root, "home");
  await fs.mkdir(workspace);
  await fs.mkdir(home);
  await fs.writeFile(
    path.join(home, "config.json"),
    JSON.stringify({ modelsDev: false, skills: { sources: { agents: false, claude: false } } }),
  );
  const platform = {
    ...createPlatform(),
    homeDir: () => root,
    nocturneHome: () => home,
    env: () => undefined,
  };
  const config = await loadConfig(platform, { nocturneHome: home, env: () => undefined });
  return { root, home, workspace, platform, config };
}
const grant: Grant = { kind: "mcp", target: "server/change", createdAt: "2026-10-20T14:03:00Z" };

it("add/remove/clear 原子重写；写失败列表不变，队列可以继续", async () => {
  const { home, workspace, platform } = await fixture();
  const dir = path.join(home, "grants");
  const { store } = await loadGrantStore(platform, dir, workspace);
  await store.add(grant);
  const file = path.join(dir, `${workspaceKey(platform.paths.canonicalize(workspace))}.json`);
  const before = await fs.readFile(file, "utf8");
  const rename = vi.spyOn(platform.fs, "rename").mockRejectedValue(new Error("disk full"));
  await expect(store.add({ ...grant, target: "server/other" })).rejects.toThrow("disk full");
  await expect(store.remove(grant.kind, grant.target)).rejects.toThrow("disk full");
  await expect(store.clear()).rejects.toThrow("disk full");
  expect(store.list()).toEqual([grant]);
  expect(await fs.readFile(file, "utf8")).toBe(before);
  rename.mockRestore();
  await store.remove(grant.kind, grant.target);
  expect(store.list()).toEqual([]);
  await store.add(grant);
  await store.clear();
  expect(JSON.parse(await fs.readFile(file, "utf8")).grants).toEqual([]);
});

it("同一配置的工作区共享存储；撤销立即影响已建策略，RuleHit 范围准确", async () => {
  const { config, workspace, platform } = await fixture();
  const first = await config.forWorkspace(workspace);
  await first.grants.add(grant);
  const second = await config.forWorkspace(workspace);
  expect(second.grants).toBe(first.grants);
  const policy = createRulePolicy({
    workspaceRoot: workspace,
    caseSensitive: platform.caseSensitivePaths,
    grants: { project: first.grants },
  });
  expect(
    policy.evaluate([{ kind: grant.kind, target: grant.target }]).decision.matchedRule?.grant,
  ).toEqual({ scope: "project", createdAt: grant.createdAt });
  await second.grants.remove(grant.kind, grant.target);
  expect(policy.evaluate([{ kind: grant.kind, target: grant.target }]).decision.action).toBe("ask");
  const session = [grant];
  const sessionPolicy = createRulePolicy({
    workspaceRoot: workspace,
    caseSensitive: platform.caseSensitivePaths,
    grants: { session },
  });
  expect(
    sessionPolicy.evaluate([{ kind: grant.kind, target: grant.target }]).decision.matchedRule?.grant
      ?.scope,
  ).toBe("session");
});

it("工作区汇总合并授权、信任和打开会话；坏版本跳过并发 runtime.warning", async () => {
  const { config, workspace, home, root, platform } = await fixture();
  const trusted = path.join(root, "trusted");
  const opened = path.join(root, "opened");
  await fs.mkdir(trusted);
  await fs.mkdir(opened);
  await config.setWorkspaceTrusted(trusted, true);
  await (await config.forWorkspace(workspace)).grants.add(grant);
  await fs.writeFile(
    path.join(home, "grants", "bad.json"),
    JSON.stringify({ version: 2, workspaceRoot: root, grants: [] }),
  );
  const runtime = await createRuntime({ config, cwd: opened, providers: [new FakeProvider({})] });
  const session = await runtime.createSession({ model: "fake/fake-1" });
  const events: RuntimeEvent[] = [];
  session.subscribe((event) => events.push(event));
  try {
    const list = await runtime.listGrantWorkspaces();
    expect(list).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workspace: await platform.resolveReal(workspace),
          grantCount: 1,
          trusted: false,
        }),
        expect.objectContaining({
          workspace: await platform.resolveReal(trusted),
          grantCount: 0,
          trusted: true,
        }),
        expect.objectContaining({ workspace: await platform.resolveReal(opened), grantCount: 0 }),
      ]),
    );
    expect(list).toHaveLength(3);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "runtime.warning",
        payload: expect.objectContaining({ code: "grants_invalid" }),
      }),
    );
  } finally {
    await session.close();
  }
});

it("describeProject 只解析 MCP 命令参数、事件 Hook 数和放宽规则，不启动进程", async () => {
  const { config, workspace, platform } = await fixture();
  await fs.mkdir(path.join(workspace, ".nocturne"));
  await fs.writeFile(
    path.join(workspace, ".nocturne", "config.json"),
    JSON.stringify({
      mcp: { servers: { example: { command: "node", args: ["danger.js", "--flag"] } } },
      hooks: {
        SessionStart: [{ command: "danger" }],
        PreToolUse: [{ command: "first" }, { command: "second" }],
      },
      permissions: {
        rules: [
          { kind: "shell", pattern: "*", action: "allow" },
          { kind: "edit", pattern: "*", action: "deny" },
        ],
      },
    }),
  );
  const spawn = vi.spyOn(platform.process, "spawn").mockImplementation(() => {
    throw new Error("must not spawn");
  });
  expect(await config.describeProject(workspace)).toEqual({
    mcpServers: [{ name: "example", command: "node danger.js --flag" }],
    hooks: [
      { event: "SessionStart", count: 1 },
      { event: "PreToolUse", count: 2 },
    ],
    relaxedRuleCount: 1,
  });
  expect(spawn).not.toHaveBeenCalled();
});

it("活动子会话查询和撤销作用于根，后续子调用失去授权", async () => {
  const { config, workspace, root } = await fixture();
  const outside = path.join(root, "outside.txt");
  await fs.writeFile(outside, "data");
  let childCalls = 0;
  let parentCalls = 0;
  const provider = new FakeProvider({
    handler: async (request) => {
      if (request.tools.some((tool) => tool.name === "finish")) {
        childCalls++;
        if (childCalls === 2) {
          const sessionId = request.sessionId;
          if (!sessionId) throw new Error("missing child session id");
          const before = runtime.listSessionGrants({ sessionId });
          expect(before).toHaveLength(1);
          const entry = before[0];
          if (!entry) throw new Error("missing session grant");
          await runtime.revokeSessionGrant({ sessionId, kind: entry.kind, target: entry.target });
          expect(runtime.listSessionGrants({ sessionId })).toEqual([]);
        }
        return childCalls <= 2
          ? [
              {
                type: "tool_call",
                toolCallId: `r${childCalls}`,
                name: "read",
                input: { path: outside },
              },
              { type: "finish", reason: "tool_calls" },
            ]
          : [
              { type: "tool_call", toolCallId: "f", name: "finish", input: { result: "done" } },
              { type: "finish", reason: "tool_calls" },
            ];
      }
      parentCalls++;
      if (parentCalls === 1)
        return [
          { type: "tool_call", toolCallId: "r", name: "read", input: { path: outside } },
          { type: "finish", reason: "tool_calls" },
        ];
      if (parentCalls === 2)
        return [
          {
            type: "tool_call",
            toolCallId: "task",
            name: "task",
            input: { task: "read twice", preset: "explore" },
          },
          { type: "finish", reason: "tool_calls" },
        ];
      return [
        { type: "text_delta", text: "done" },
        { type: "finish", reason: "stop" },
      ];
    },
  });
  const runtime = await createRuntime({
    config,
    cwd: workspace,
    interactive: true,
    providers: [provider],
  });
  const session = await runtime.createSession({ model: "fake/fake-1" });
  session.subscribe((event) => {
    if (event.type === "permission.requested")
      void session.respondPermission(event.payload.requestId, {
        decision: "allow",
        remember: "session",
      });
  });
  try {
    await session.submit({ text: "go" });
    expect(childCalls).toBe(3);
    expect(session.listGrants()).toEqual([]);
    const children = await runtime.listSubagents({ parentSessionId: session.id });
    const child = children[0];
    if (!child) throw new Error("missing child session");
    const events: RuntimeEvent[] = [];
    const observation = await runtime.observeSubagent(
      { parentSessionId: session.id, childSessionId: child.childSessionId },
      {
        onEvent: (event) => {
          events.push(event);
        },
        onEnd: () => undefined,
      },
    );
    observation.unsubscribe();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool.started",
        payload: expect.objectContaining({
          permission: expect.objectContaining({
            source: "grant",
            grant: expect.objectContaining({ scope: "session" }),
          }),
        }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "permission.resolved",
        payload: expect.objectContaining({ source: "non_interactive" }),
      }),
    );
  } finally {
    await session.close();
  }
});

it.each(["session", "project"] as const)(
  "%s 授权撤销后同会话下一次同目标重新询问，事件和重放保留 grant",
  async (scope) => {
    const { config, workspace } = await fixture();
    const write: FakeScript = [
      { type: "tool_call", toolCallId: "w", name: "write", input: { path: "a.txt", content: "a" } },
      { type: "finish", reason: "tool_calls" },
    ];
    const done: FakeScript = [
      { type: "text_delta", text: "done" },
      { type: "finish", reason: "stop" },
    ];
    const runtime = await createRuntime({
      config,
      cwd: workspace,
      interactive: true,
      providers: [new FakeProvider({ scripts: [write, done, write, done, write, done] })],
    });
    const session = await runtime.createSession({ model: "fake/fake-1" });
    const events: RuntimeEvent[] = [];
    session.subscribe((event) => {
      events.push(event);
      if (event.type === "permission.requested")
        void session.respondPermission(event.payload.requestId, {
          decision: "allow",
          remember: scope,
        });
    });
    try {
      await session.submit({ text: "first" });
      await session.submit({ text: "second" });
      expect(events.filter((event) => event.type === "permission.requested")).toHaveLength(1);
      const started = events.filter((event) => event.type === "tool.started").at(-1);
      expect(started?.payload.permission).toMatchObject({
        source: "grant",
        grant: { scope, createdAt: expect.any(String) },
      });
      expect(
        events.filter((event) => event.type === "permission.resolved").at(-1)?.payload,
      ).toMatchObject({ source: "grant", grant: { scope } });
      if (started) {
        expect(durableEventSchema.parse(started)).toMatchObject({
          payload: { permission: { grant: { scope } } },
        });
        const view = replaySessionView(session.durableEvents());
        expect(view.entries.filter((entry) => entry.kind === "tool").at(-1)).toMatchObject({
          permission: { grant: { scope } },
        });
      }
      if (scope === "session") await session.revokeAllGrants();
      else await runtime.revokeAllGrants({ workspace });
      await session.submit({ text: "third" });
      expect(events.filter((event) => event.type === "permission.requested")).toHaveLength(2);
    } finally {
      await session.close();
    }
  },
);
