import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCredentialStore, loadConfig } from "../src/config/index.js";
import { createRuntime, type RuntimeSession } from "../src/index.js";
import { createPlatform } from "../src/platform/index.js";
import { createRulePolicy } from "../src/permission/policy.js";
import { decodeDurableEvent, goalReasonText, type DurableEvent } from "../src/protocol/index.js";
import { FakeProvider, type FakeScript } from "../src/provider/index.js";
import { assembleGoalCheckInput, redactGoalText } from "../src/work-modes/goal-check-input.js";
import { checkGoalWithDecision, parseSmolGoalCheck } from "../src/work-modes/goal-check.js";

const checklist = [{ item: "Tests pass", evidence: "Run pnpm test" }];
const roots: string[] = [];
const activeSessions: RuntimeSession[] = [];
afterEach(async () => {
  for (const session of activeSessions.splice(0)) await session.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function eventLog() {
  const events: DurableEvent[] = [];
  const push = (type: string, payload: unknown) =>
    events.push(
      decodeDurableEvent(
        JSON.stringify({
          type,
          payload,
          seq: events.length + 1,
          time: new Date().toISOString(),
          sessionId: "s",
          turnId: "t",
        }),
      ),
    );
  const start = (callId: string, name: string, kind: string, target: string) =>
    push("tool.started", {
      callId,
      name,
      input: { opaque: "RAW_INPUT" },
      subjects: [{ kind, target }],
      permission: { action: "allow", source: "rule" },
    });
  const complete = (callId: string, name: string, modelContent: string, output?: unknown) =>
    push("tool.completed", { callId, name, status: "ok", modelContent, output });
  return { events, push, start, complete };
}

describe("goal check evidence", () => {
  it.each([
    ["OpenAI-style key", "sk-example123", "<redacted>"],
    ["GitHub PAT", "ghp_example123", "<redacted>"],
    ["GitHub OAuth token", "gho_example123", "<redacted>"],
    ["GitHub fine-grained PAT", "github_pat_example123", "<redacted>"],
    ["Notion token", "ntn_example123", "<redacted>"],
    ["Slack tokens", "xoxa-test123 xoxb-test123 xoxp-test123", "<redacted> <redacted> <redacted>"],
    ["Google API key", "AIzaExample123", "<redacted>"],
    ["AWS access key", "AKIAEXAMPLE123", "<redacted>"],
    ["bearer credential", "Bearer ey.example-123", "Bearer <redacted>"],
    [
      "private key block",
      "before\n-----BEGIN RSA PRIVATE KEY-----\nsecret\n-----END RSA PRIVATE KEY-----\nafter",
      "before\n<redacted>\nafter",
    ],
    [
      "credential assignment",
      'API_KEY="an escaped \\" secret"; retries=1',
      'API_KEY="<redacted>"; retries=1',
    ],
    [
      "credential JSON value",
      '{"access_token":"first\\\" second","label":"OK"}',
      '{"access_token":"<redacted>","label":"OK"}',
    ],
    [
      "ordinary text",
      'monosk-example BOARD_COLOR=blue {"label":"Bearer-style output"}',
      'monosk-example BOARD_COLOR=blue {"label":"Bearer-style output"}',
    ],
  ])("redacts only credential content in %s", (_name, input, expected) => {
    expect(redactGoalText(input)).toBe(expected);
  });

  it("orders invocations across Turns, omits older events and sends edit counts without diff text", () => {
    const log = eventLog();
    log.start("old", "shell", "shell", "old-command");
    log.complete("old", "shell", "old-output");
    const since = log.events.length + 1;
    log.push("message.user", { messageId: "u", content: [{ type: "text", text: "USER_MESSAGE" }] });
    log.push("message.assistant", {
      messageId: "a",
      model: { provider: "fake", model: "fake-1" },
      content: [],
      finishReason: "tool_calls",
      toolCalls: [
        { callId: "edit", name: "edit", input: { path: "/ws/x.ts" } },
        { callId: "test", name: "shell", input: { command: "pnpm test" } },
      ],
    });
    log.start("edit", "edit", "edit", "/ws/x.ts");
    log.start("test", "shell", "shell", "pnpm test");
    log.complete("test", "shell", Array.from({ length: 44 }, (_, i) => `line ${i}`).join("\n"), {
      exitCode: 0,
    });
    log.complete("edit", "edit", "HIDDEN_EDIT", {
      path: "/ws/x.ts",
      diff: "@@ -1,1 +1,2 @@\n-old\n+first\n+second",
    });
    const input = assembleGoalCheckInput(
      "Run tests",
      [{ item: "run", evidence: "a".repeat(1001) }],
      log.events,
      since,
      () => false,
    );
    expect(input.checklist[0]?.evidence).toHaveLength(1000);
    expect(input.records).toEqual([
      { number: 1, tool: "edit", status: "ok", subject: "/ws/x.ts +2 −1" },
      {
        number: 2,
        tool: "shell",
        status: "ok",
        subject: "pnpm test",
        exitCode: 0,
        result: expect.stringMatching(/^line 4\n[\s\S]+line 43$/),
      },
    ]);
    expect(JSON.stringify(input)).not.toMatch(/USER_MESSAGE|RAW_INPUT|HIDDEN_EDIT|old-output/);
  });

  it("uses the latest records inside the 60,000 character budget and counts the omissions", () => {
    const log = eventLog();
    for (let i = 1; i <= 20; i++) {
      log.start(String(i), "shell", "shell", `test-${i}`);
      log.complete(String(i), "shell", `${"X".repeat(4250)}tail-${i}`);
    }
    const { records } = assembleGoalCheckInput("test", checklist, log.events, 1, () => false);
    expect(records[0]).toBe("省略 6 条");
    expect(JSON.stringify(records).length).toBeLessThanOrEqual(60_000);
    expect(records.at(-1)).toMatchObject({
      number: 20,
      subject: "test-20",
      result: expect.stringMatching(/tail-20$/),
    });
    expect(records.at(1)).toMatchObject({ number: 7 });
  });

  it("keeps only name and status for credential paths, commands and authorization data", () => {
    const policy = createRulePolicy({
      workspaceRoot: "/ws",
      caseSensitive: true,
      presetContext: { nocturneHome: "/home/.nocturne" },
      protectedPaths: { lexical: ["/home/.nocturne/credentials.json"] },
      externalCredentialPaths: { lexical: ["/home/external-secret"] },
    });
    const log = eventLog();
    for (const [kind, subject] of [
      ["read", "/home/.nocturne/credentials.json"],
      ["shell", "cat /home/.nocturne/credentials.json"],
      ["read", "/home/.nocturne/grants/workspace.json"],
      ["read", "/home/external-secret"],
    ] as const) {
      const id = `call-${log.events.length}`;
      log.start(id, "tool", kind, subject);
      log.complete(id, "tool", "sensitive-result", { exitCode: 1 });
    }
    const input = assembleGoalCheckInput(
      "Check",
      checklist,
      log.events,
      1,
      (subjects) => policy.sensitiveForModel?.(subjects) ?? false,
    );
    expect(input.records).toEqual(
      [1, 2, 3, 4].map((number) => ({ number, tool: "tool", status: "ok" })),
    );
  });
});

describe("independent check backends", () => {
  it.each(["gemini", "jev"] as const)(
    "sends the %s loopback wire format and applies the evidence threshold and coverage question",
    async (source) => {
      const received: { url?: string; key?: string; body: Record<string, unknown> }[] = [];
      const server = createServer(async (request, response) => {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk as Buffer);
        const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
        received.push({
          body,
          ...(request.url && { url: request.url }),
          key: String(request.headers["x-goog-api-key"] ?? request.headers.authorization),
        });
        response.setHeader("Content-Type", "application/json");
        const answers = [
          { choice: "no", confidence: 0.699 },
          { choice: "no", confidence: 0.7 },
          { choice: "no", confidence: 0.95 },
        ];
        response.end(
          JSON.stringify(
            source === "gemini"
              ? {
                  answers: Object.fromEntries(
                    answers.map((answer, index) => [String(index + 1), answer]),
                  ),
                  usage: { total_input_tokens: 36 },
                }
              : { answers, usage: { input_tokens: 36, output_tokens: 4 } },
          ),
        );
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      try {
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("expected a loopback port");
        const input = {
          objective: "Save and test",
          checklist: [...checklist, { item: "Save", evidence: "edit succeeded" }],
          records: [],
        };
        const result = await checkGoalWithDecision(
          input,
          {
            source,
            endpoint: "custom",
            model: "fixture",
            baseURL: `http://127.0.0.1:${address.port}/v1`,
            key: async () => "fixture-key",
          },
          0.7,
          new AbortController().signal,
        );
        expect(received).toHaveLength(1);
        expect(received[0]).toMatchObject({
          url: source === "gemini" ? "/v1/decisions" : "/v1/systemone",
          key: source === "gemini" ? "fixture-key" : "Bearer fixture-key",
        });
        expect(
          source === "gemini"
            ? JSON.parse(String(received[0]?.body.input))
            : received[0]?.body.state,
        ).toEqual(input);
        expect(received[0]?.body.questions).toMatchObject({
          "1": {
            type: "choice",
            instructions: expect.stringContaining("last related modification"),
          },
          "2": { type: "choice" },
          "3": { type: "choice", instructions: expect.stringContaining("every requirement") },
        });
        expect(result.check).toMatchObject({
          result: "rejected",
          coverage: false,
          items: [
            { index: 1, confidence: 0.699, passed: true },
            { index: 2, confidence: 0.7, passed: false },
          ],
        });
        expect(result.usage).toEqual({
          inputTokens: 36,
          outputTokens: source === "gemini" ? 0 : 4,
        });
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    },
  );

  it("parses a numbered smol verdict and rejects bad or incomplete JSON", () => {
    const verdict = {
      items: [{ index: 1, supported: false, note: "No test output" }],
      coverage: true,
      note: "Covered",
    };
    expect(parseSmolGoalCheck(JSON.stringify(verdict), 1)).toEqual({
      items: [{ index: 1, passed: false, note: "No test output" }],
      coverage: true,
      note: "Covered",
    });
    expect(parseSmolGoalCheck("{bad JSON", 1)).toBeUndefined();
    expect(
      parseSmolGoalCheck(
        JSON.stringify({ ...verdict, items: [verdict.items[0], verdict.items[0]] }),
        2,
      ),
    ).toBeUndefined();
  });
});

const done: FakeScript = [
  { type: "usage", usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2 } },
  { type: "text_delta", text: "Done." },
  { type: "finish", reason: "stop" },
];
const met = (id: string): FakeScript => [
  { type: "tool_call", toolCallId: id, name: "update_goal", input: { status: "met", checklist } },
  { type: "finish", reason: "tool_calls" },
];
const checkReply = (supported: boolean): FakeScript => [
  {
    type: "text_delta",
    text: JSON.stringify({
      items: [{ index: 1, supported, note: "A test should run first." }],
      coverage: true,
      note: "Covered.",
    }),
  },
  { type: "usage", usage: { inputTokens: 20, outputTokens: 8, cacheReadTokens: 18 } },
  { type: "finish", reason: "stop" },
];

async function start(
  backend: "smol" | "decision" | "off",
  provider: FakeProvider,
  settings: Record<string, unknown> = {},
) {
  const root = await mkdtemp(join(tmpdir(), "nocturne-goal-check-"));
  roots.push(root);
  const home = join(root, "home");
  const cwd = join(root, "workspace");
  await mkdir(home);
  await mkdir(cwd);
  await writeFile(
    join(home, "settings.json"),
    JSON.stringify({ goalCheck: { backend }, ...settings }),
  );
  const platform = createPlatform();
  const credentials = (await createCredentialStore(platform, home, { backend: "memory" })).store;
  const config = await loadConfig(platform, {
    nocturneHome: home,
    env: () => undefined,
    credentials,
  });
  const runtime = await createRuntime({
    cwd,
    sessionsDir: join(root, "sessions"),
    providers: [provider],
    config,
  });
  const session = await runtime.createSession({ model: "fake/fake-1" });
  activeSessions.push(session);
  return { runtime, session };
}

const goalCompletions = (session: RuntimeSession) =>
  session
    .durableEvents()
    .flatMap((event) =>
      event.type === "tool.completed" && event.payload.name === "update_goal"
        ? [event.payload]
        : [],
    );

describe("goal check Runtime lifecycle", () => {
  it("preserves off and finishes when a separate model is unavailable", async () => {
    for (const backend of ["off", "decision"] as const) {
      const provider = new FakeProvider({ scripts: [met("g"), done] });
      const { session } = await start(backend, provider);
      await session.submit({ text: "Run tests", workMode: "goal" });
      expect(session.state().goal?.status).toBe("met");
      const [completion] = goalCompletions(session);
      expect(completion).toMatchObject({ status: "ok", output: { status: "met", checklist } });
      if (backend === "off") expect(completion?.output).toEqual({ status: "met", checklist });
      else
        expect(completion?.output).toMatchObject({
          check: { backend, result: "unavailable", reason: "决策模型未设置" },
        });
      expect(provider.roleRequests.every(({ purpose }) => purpose !== "goal_check")).toBe(true);
    }
  });

  it("requires goal disclosure separately from reviewer consent before sending", async () => {
    const provider = new FakeProvider({ scripts: [met("g"), done] });
    const { runtime, session } = await start("decision", provider, {
      decisionModel: {
        source: "gemini",
        endpoint: "custom",
        baseURL: "http://127.0.0.1:1/v1",
        model: "gemini-decision-1",
        credential: { stored: true },
      },
    });
    await runtime.setPreference("decisionDisclosureAccepted", "custom");
    await session.submit({ text: "Run tests", workMode: "goal" });
    expect(session.state().goal?.status).toBe("met");
    expect(goalCompletions(session)[0]?.output).toMatchObject({
      check: { result: "unavailable", reason: "尚未确认目标核对的数据外发说明" },
    });
  });

  it("blocks an unchanged repeat without checking again and preserves the English and Chinese explanations", async () => {
    const provider = new FakeProvider({
      scripts: [met("g1"), met("g2"), done],
      roleHandler: (req) => (req.purpose === "goal_check" ? checkReply(false) : done.slice(1)),
    });
    const { session } = await start("smol", provider);
    await session.submit({ text: "Run tests", workMode: "goal" });
    const [first, second] = goalCompletions(session);
    expect(first).toMatchObject({
      status: "error",
      error: { code: "goal_unverified" },
      modelContent: expect.stringContaining("Item 1: Tests pass (A test should run first.)"),
      output: { check: { result: "rejected" } },
    });
    expect(second).toMatchObject({ status: "ok", output: { status: "blocked" } });
    const goal = session.state().goal;
    expect(goal).toMatchObject({
      status: "blocked",
      reason: expect.stringContaining("Item 1: Tests pass"),
    });
    expect(goalReasonText(goal?.reason ?? "")).toContain("第 1 项：Tests pass");
    expect(provider.roleRequests.filter(({ purpose }) => purpose === "goal_check")).toHaveLength(1);
  });

  it("checks again after the model gathers new tool evidence", async () => {
    const provider = new FakeProvider({
      scripts: [
        met("g1"),
        [
          {
            type: "tool_call",
            toolCallId: "evidence",
            name: "glob",
            input: { pattern: "*.test.ts" },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        met("g2"),
        done,
      ],
      roleHandler: (req, index) =>
        req.purpose === "goal_check" ? checkReply(index === 1) : done.slice(1),
    });
    const { session } = await start("smol", provider);
    await session.submit({ text: "Run tests", workMode: "goal" });
    expect(session.state().goal?.status).toBe("met");
    expect(goalCompletions(session).map(({ status }) => status)).toEqual(["error", "ok"]);
    const checks = provider.roleRequests.filter(({ purpose }) => purpose === "goal_check");
    expect(checks).toHaveLength(2);
    expect(JSON.stringify(checks[1]?.messages)).toContain("glob");
  });

  it("counts auxiliary tokens in session statistics and keeps Turn usage and cache totals separate", async () => {
    const provider = new FakeProvider({
      scripts: [met("g"), done],
      roleHandler: (req) => (req.purpose === "goal_check" ? checkReply(true) : done.slice(1)),
    });
    const { runtime, session } = await start("smol", provider);
    await session.submit({ text: "Run tests", workMode: "goal" });
    expect(goalCompletions(session)[0]).toMatchObject({
      status: "ok",
      output: { check: { result: "passed", model: "fake/fake-1" } },
      usage: { inputTokens: 20, outputTokens: 8 },
    });
    const turn = session.durableEvents().find((event) => event.type === "turn.completed");
    expect(turn?.payload.usage).toMatchObject({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 2,
    });
    const stats = await runtime.usageStats({});
    expect(stats.totals).toMatchObject({ inputTokens: 30, outputTokens: 13, cacheReadTokens: 20 });
    expect(stats.cacheHitRate).toBe(0.2);
    expect(stats.models[0]?.cacheHitRate).toBe(0.2);
  });

  it.each(["interrupt", "stopGoal", "cancelGoal"] as const)(
    "discards a running check after %s",
    async (action) => {
      const provider = new FakeProvider({
        scripts: [met("g"), done],
        roleHandler: (req) =>
          req.purpose === "goal_check" ? [{ type: "wait" }, ...checkReply(true)] : done.slice(1),
      });
      const { session } = await start("smol", provider);
      const submission = session.submit({ text: "Run tests", workMode: "goal" });
      await vi.waitFor(() => expect(provider.waitState.waiting).toBe(1));
      await session[action]();
      await submission;
      expect(provider.waitState).toEqual({ waiting: 0, aborts: 1 });
      expect(goalCompletions(session)[0]?.output).toBeUndefined();
      expect(session.state().goal?.status).not.toBe("met");
    },
  );
});
