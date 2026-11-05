import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createPlatform, createRuntime, loadConfig } from "../src/index.js";
import {
  FakeProvider,
  type FakeScript,
  type ModelRequest,
  type ModelInfo,
} from "../src/provider/index.js";
import { worktreeGit } from "../src/agent/worktree.js";
import { createTaskTool } from "../src/tools/index.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const done: FakeScript = [
  { type: "text_delta", text: "done" },
  { type: "finish", reason: "stop" },
];

async function run(input: Record<string, unknown>, isolated = false) {
  const root = mkdtempSync(path.join(tmpdir(), "task-model-"));
  roots.push(root);
  const cwd = path.join(root, "ws");
  mkdirSync(cwd);
  if (isolated) {
    await worktreeGit(cwd, ["init"]);
    await worktreeGit(cwd, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@localhost",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "--no-verify",
      "-m",
      "initial",
    ]);
  }
  const base = new FakeProvider({}).models()[0];
  if (!base) throw new Error("missing fake model");
  const childRequests: ModelRequest[] = [];
  const models: ModelInfo[] = ["main", "shared", "nested/name"].map((model) => ({
    ...base,
    ref: { provider: "p", model },
    capabilities: { ...base.capabilities, reasoningEffort: ["low", "medium", "high"] },
    pricing: { input: 2, output: 4 },
  }));
  let called = false;
  const provider = new FakeProvider({
    id: "p",
    models,
    handler: (request) => {
      if (request.tools.some((tool) => tool.name === "finish")) {
        childRequests.push(request);
        return [
          { type: "wait", ms: 20 },
          { type: "tool_call", toolCallId: "f", name: "finish", input: { result: "child result" } },
          { type: "usage", usage: { inputTokens: 100, outputTokens: 20 } },
          { type: "finish", reason: "tool_calls" },
        ];
      }
      if (called) return done;
      called = true;
      return [
        { type: "tool_call", toolCallId: "t", name: "task", input: { task: "test", ...input } },
        { type: "finish", reason: "tool_calls" },
      ];
    },
  });
  const other = new FakeProvider({
    id: "q",
    models: [{ ...base, ref: { provider: "q", model: "shared" } }],
  });
  const platform = { ...createPlatform(), env: () => undefined, homeDir: () => root };
  writeFileSync(
    path.join(root, "config.json"),
    JSON.stringify({ modelsDev: false, skills: { sources: { agents: false, claude: false } } }),
  );
  const config = await loadConfig(platform, { nocturneHome: root, env: () => undefined });
  const runtime = await createRuntime({
    config,
    cwd,
    sessionsDir: path.join(root, "sessions"),
    providers: [provider, other],
    permissions: { autoApproveAsk: true },
    subagent: { background: true },
  });
  const session = await runtime.createSession({ model: "p/main", reasoningEffort: "high" });
  await session.submit({ text: "go" });
  if (input.background)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new Error("background did not finish"));
      }, 3000);
      const unsubscribe = session.subscribe((event) => {
        if (
          event.type === "turn.completed" &&
          session.durableEvents().some((e) => e.type === "message.user" && e.payload.subagent)
        ) {
          clearTimeout(timer);
          unsubscribe();
          resolve();
        }
      });
    });
  const completion = session
    .durableEvents()
    .find((e) => e.type === "tool.completed" && e.payload.name === "task");
  return { root, cwd, runtime, session, provider, childRequests, completion };
}

it("同名模型歧义列出两个完整 id，不启动子会话", async () => {
  const result = await run({ model: "shared" });
  try {
    expect(result.completion?.payload).toMatchObject({ error: { code: "invalid_input" } });
    expect(JSON.stringify(result.completion)).toContain("p/shared");
    expect(JSON.stringify(result.completion)).toContain("q/shared");
    expect(result.childRequests).toHaveLength(0);
  } finally {
    await result.session.close();
  }
});

it("模型名包含斜线时仍按 provider/ 后的完整模型名精确匹配", async () => {
  const result = await run({ model: "nested/name", effort: "medium" });
  try {
    expect(result.childRequests[0]).toMatchObject({
      model: "nested/name",
      reasoningEffort: "medium",
    });
  } finally {
    await result.session.close();
  }
});

it.each([false, true])("后台模型、用量与费用记到实际模型（隔离 %s）", async (isolated) => {
  const result = await run(
    {
      model: "p/nested/name",
      effort: "medium",
      background: true,
      ...(isolated ? { isolation: "worktree" } : { preset: "explore" }),
    },
    isolated,
  );
  try {
    expect(result.childRequests[0]).toMatchObject({
      model: "nested/name",
      reasoningEffort: "medium",
    });
    const completion = result.completion;
    if (completion?.type !== "tool.completed") throw new Error("missing task completion");
    const output = completion.payload.output as {
      model: string;
      childLogPath: string;
      childSessionId: string;
    };
    expect(output.model).toBe("p/nested/name");
    expect(await result.runtime.listSubagents({ parentSessionId: result.session.id })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ model: "p/nested/name", effort: "medium" }),
      ]),
    );
    const log = readFileSync(output.childLogPath, "utf8");
    expect(log).toContain('"reasoningEffort":"medium"');
    expect(log).toContain('"inputTokens":100');
    const stats = await result.runtime.usageStats({});
    const used = stats.models.find(
      (item) => item.model.provider === "p" && item.model.model === "nested/name",
    );
    expect(used).toMatchObject({ inputTokens: 100, outputTokens: 20, requests: 1 });
    expect(used?.cost.total).toBeCloseTo(0.00028, 8);
    expect(
      result.session
        .durableEvents()
        .find((event) => event.type === "message.user" && event.payload.subagent)?.payload,
    ).toMatchObject({ subagent: { status: "ok" } });
    if (isolated)
      expect(
        await result.runtime.listSubagentWorktrees({ parentSessionId: result.session.id }),
      ).toHaveLength(0);
  } finally {
    await result.session.close();
  }
});

it.each(["agent", "profile"] as const)("外部 %s 与 model、effort 互斥", (field) => {
  const tool = createTaskTool(
    {
      launch: async () => {
        throw new Error("must not launch");
      },
    },
    {
      agents: [{ name: "external" }],
      run: async () => {
        throw new Error("must not run");
      },
    },
  );
  for (const override of [{ model: "p/m" }, { effort: "high" as const }]) {
    expect(tool.validateInput?.({ task: "test", [field]: "external", ...override })).toContain(
      "互斥",
    );
  }
});
