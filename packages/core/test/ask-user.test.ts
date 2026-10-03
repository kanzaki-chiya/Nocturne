/**
 * ADR-0032 ask_user（Core）：输入校验边界、回复校验、回答/逐题拒绝/中断/
 * 超时/非交互四种结算、恰好一个 tool.completed、进程退出恢复为
 * interrupted、子代理池排除 needsUser、不新增持久化事件类型。
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { createRuntime, type Runtime, type RuntimeSession } from "../src/index.js";
import { FakeProvider, type FakeScript, type ModelRequest } from "../src/provider/index.js";
import {
  createSessionView,
  DURABLE_EVENT_TYPES,
  isDurableEventType,
  isEphemeralEventType,
  LOG_FORMAT_VERSION,
  reduceSessionView,
  type DurableEvent,
  type RuntimeEvent,
} from "../src/protocol/index.js";
import { createPlatform } from "../src/platform/index.js";
import { createWorkspaceReadPolicy } from "../src/permission/index.js";
import {
  askUserTool,
  builtinTools,
  createPolicyGate,
  createQuestionBroker,
  createReadStateStore,
  createToolExecutor,
  createToolRegistry,
  type ExecutionScope,
} from "../src/tools/index.js";
import { internalSession } from "./internal-session.js";

const tmpRoots: string[] = [];
afterEach(() => {
  for (const r of tmpRoots.splice(0)) rmSync(r, { recursive: true, force: true });
});
const makeTmp = (p: string) => {
  const d = mkdtempSync(path.join(tmpdir(), p));
  tmpRoots.push(d);
  return d;
};

async function makeRuntime(
  scripts: FakeScript[] | undefined,
  extra: { interactive?: boolean; autoApproveAsk?: boolean; provider?: FakeProvider } = {},
): Promise<{ runtime: Runtime; ws: string; provider: FakeProvider }> {
  const ws = makeTmp("nct-au-ws-");
  const provider = extra.provider ?? new FakeProvider({ scripts });
  const runtime = await createRuntime({
    cwd: ws,
    sessionsDir: makeTmp("nct-au-sd-"),
    providers: [provider],
    interactive: extra.interactive,
    permissions: extra.autoApproveAsk === true ? { autoApproveAsk: true } : undefined,
  });
  return { runtime, ws, provider };
}

const makeSession = (runtime: Runtime) => runtime.createSession({ model: "fake/fake-model" });

function collect(session: RuntimeSession): RuntimeEvent[] {
  const events: RuntimeEvent[] = [];
  session.subscribe((e) => {
    events.push(e);
  });
  return events;
}

/** 单问脚本：先调用 ask_user，下一轮直接收尾 */
const askThenDone = (questions: unknown): FakeScript[] => [
  [
    { type: "tool_call", toolCallId: "q1", name: "ask_user", input: { questions } },
    { type: "finish", reason: "tool_calls" },
  ],
  [
    { type: "text_delta", text: "done" },
    { type: "finish", reason: "stop" },
  ],
];

// 运行时分配 callId（非 provider 的 toolCallId）；按工具名定位本次调用
const completedFor = (events: RuntimeEvent[], name = "ask_user") =>
  events.filter(
    (e): e is DurableEvent<"tool.completed"> =>
      e.type === "tool.completed" && e.payload.name === name,
  );

const questionRequested = (events: RuntimeEvent[]) =>
  events.filter((e) => e.type === "question.requested");

const statusEvents = (events: RuntimeEvent[]) =>
  events
    .filter((e) => e.type === "runtime.status")
    .map((e) => (e.type === "runtime.status" ? e.payload.status : ""));

/** 等待一个满足条件的事件（事件可能已到——先回放再订阅） */
function waitEvent(
  session: RuntimeSession,
  seen: RuntimeEvent[],
  match: (e: RuntimeEvent) => boolean,
): Promise<RuntimeEvent> {
  const found = seen.find(match);
  if (found !== undefined) return Promise.resolve(found);
  return new Promise((resolve) => {
    const off = session.subscribe((e) => {
      if (match(e)) {
        off();
        resolve(e);
      }
    });
  });
}

describe("ask_user 输入校验（ADR-0032 §1）", () => {
  const invalidInputs: [string, unknown][] = [
    ["空数组", []],
    ["超过 4 题", [1, 2, 3, 4, 5].map((i) => ({ question: `问题${i}` }))],
    ["question 空白", [{ question: "   " }]],
    ["question 超 300 字符", [{ question: "长".repeat(301) }]],
    ["question 含控制字符（Tab）", [{ question: "选\t哪个" }]],
    ["header 超 12 字符", [{ question: "q", header: "1234567890123" }]],
    ["header 含换行", [{ question: "q", header: "a\nb" }]],
    ["只有 1 个选项", [{ question: "q", options: [{ label: "独" }] }]],
    [
      "超过 6 个选项",
      [{ question: "q", options: [1, 2, 3, 4, 5, 6, 7].map((i) => ({ label: `o${i}` })) }],
    ],
    ["label 空白", [{ question: "q", options: [{ label: "  " }, { label: "b" }] }]],
    [
      "label 超 60 字符",
      [{ question: "q", options: [{ label: "长".repeat(61) }, { label: "b" }] }],
    ],
    ["label 重复", [{ question: "q", options: [{ label: "a" }, { label: " a " }] }]],
    ["label 含换行", [{ question: "q", options: [{ label: "a\nb" }, { label: "c" }] }]],
    [
      "description 超 200 字符",
      [{ question: "q", options: [{ label: "a", description: "长".repeat(201) }, { label: "b" }] }],
    ],
    ["question 内未知字段", [{ question: "q", priority: "high" }]],
    ["选项内未知字段", [{ question: "q", options: [{ label: "a", tip: "x" }, { label: "b" }] }]],
    [
      "顶层未知字段",
      [
        { question: "q", options: undefined },
        { question: "q2", extra: 1 },
      ],
    ],
  ];

  it.each(invalidInputs)(
    "非法输入（%s）→ invalid_input，不发 question.requested",
    async (_tag, questions) => {
      const { runtime } = await makeRuntime(askThenDone(questions), { interactive: true });
      const session = await makeSession(runtime);
      const events = collect(session);
      const reason = await session.submit({ text: "ask" });
      expect(reason).toBe("done");
      expect(questionRequested(events)).toHaveLength(0);
      const completed = completedFor(events);
      expect(completed).toHaveLength(1);
      const p = completed[0]?.payload;
      expect(p?.status).toBe("error");
      expect(p?.error?.code).toBe("invalid_input");
      await session.close();
    },
  );

  it("questions 缺省/非数组 → invalid_input", async () => {
    const { runtime } = await makeRuntime(
      [
        [
          { type: "tool_call", toolCallId: "q1", name: "ask_user", input: {} },
          { type: "finish", reason: "tool_calls" },
        ],
        [
          { type: "text_delta", text: "done" },
          { type: "finish", reason: "stop" },
        ],
      ],
      { interactive: true },
    );
    const session = await makeSession(runtime);
    const events = collect(session);
    await session.submit({ text: "ask" });
    const p = completedFor(events)[0]?.payload;
    expect(p?.status).toBe("error");
    expect(p?.error?.code).toBe("invalid_input");
    await session.close();
  });

  it("边界合法输入规范化后发出 question.requested（修整/空 options 视作省略）", async () => {
    const questions = [
      {
        question: ` ${"边".repeat(299)} `,
        header: ` ${"标".repeat(12)} `,
        options: [],
      },
      {
        question: "多行\n问题",
        options: [
          { label: ` ${"长".repeat(60)} `, description: ` ${"描".repeat(200)} ` },
          { label: "B" },
        ],
        multiSelect: true,
      },
    ];
    const { runtime } = await makeRuntime(askThenDone(questions), { interactive: true });
    const session = await makeSession(runtime);
    const events = collect(session);
    session.subscribe((e) => {
      if (e.type === "question.requested") {
        void session.respondQuestion(e.payload.requestId, {
          answers: e.payload.questions.map(() => ({ declined: true })),
        });
      }
    });
    await session.submit({ text: "ask" });
    const requested = questionRequested(events);
    expect(requested).toHaveLength(1);
    const qs = requested[0]?.type === "question.requested" ? requested[0].payload.questions : [];
    // question/header/label/description 去首尾空白；options: [] 与缺省等价
    expect(qs[0]?.question).toBe("边".repeat(299));
    expect(qs[0]?.header).toBe("标".repeat(12));
    expect(qs[0]?.options).toBeUndefined();
    expect(qs[1]?.options?.[0]?.label).toBe("长".repeat(60));
    expect(qs[1]?.options?.[0]?.description).toBe("描".repeat(200));
    expect(qs[1]?.multiSelect).toBe(true);
    const p = completedFor(events)[0]?.payload;
    expect(p?.status).toBe("ok");
    expect(p?.output).toMatchObject({ answers: [{ declined: true }, { declined: true }] });
    await session.close();
  });
});

describe("ask_user 回答与逐题拒绝（ADR-0032 §2/§3）", () => {
  const twoQuestions = [
    {
      question: "用哪个数据库？",
      header: "选型",
      options: [{ label: "PostgreSQL（推荐）", description: "默认即可" }, { label: "SQLite" }],
    },
    { question: "补充约束？" },
  ];

  it("正常回答：selected + text 进入 output/modelContent，恰好一个 tool.completed", async () => {
    const { runtime, provider } = await makeRuntime(askThenDone(twoQuestions), {
      interactive: true,
    });
    const session = await makeSession(runtime);
    const events = collect(session);
    const view = createSessionView();
    session.subscribe((e) => {
      reduceSessionView(view, e);
      if (e.type === "question.requested") {
        void session.respondQuestion(e.payload.requestId, {
          answers: [
            { selected: ["PostgreSQL（推荐）"] },
            { selected: [], text: "  要兼容 13 版  " },
          ],
        });
      }
    });
    const reason = await session.submit({ text: "ask" });
    expect(reason).toBe("done");

    const completed = completedFor(events);
    expect(completed).toHaveLength(1);
    const p = completed[0]?.payload;
    expect(p?.status).toBe("ok");
    expect(p?.output).toEqual({
      answers: [
        { question: "用哪个数据库？", selected: ["PostgreSQL（推荐）"] },
        { question: "补充约束？", selected: [], text: "要兼容 13 版" },
      ],
    });
    expect(String(p?.modelContent)).toContain("问：用哪个数据库？");
    expect(String(p?.modelContent)).toContain("答：PostgreSQL（推荐）");
    expect(String(p?.modelContent)).toContain("补充：要兼容 13 版");
    // 回答随下一次模型请求的 tool 消息回给模型
    const toolMsg = provider.requests[1]?.messages.find((m) => m.role === "tool");
    expect(toolMsg?.role === "tool" && toolMsg.content).toContain("要兼容 13 版");
    await session.close();
  });

  it.each([
    [true, false],
    [false, true],
    [true, true],
  ])("逐题拒绝与混合回答：%s / %s", async (first, second) => {
    const { runtime } = await makeRuntime(askThenDone(twoQuestions), { interactive: true });
    const session = await makeSession(runtime);
    const events = collect(session);
    session.subscribe((e) => {
      if (e.type === "question.requested") {
        void session.respondQuestion(e.payload.requestId, {
          answers: [
            first ? { declined: true } : { selected: ["SQLite"] },
            second ? { declined: true } : { selected: [], text: "尽快" },
          ],
        });
      }
    });
    await session.submit({ text: "ask" });
    const p = completedFor(events)[0]?.payload;
    expect(p?.status).toBe("ok");
    expect(p?.output).toEqual({
      answers: [
        { question: "用哪个数据库？", ...(first ? { declined: true } : { selected: ["SQLite"] }) },
        {
          question: "补充约束？",
          ...(second ? { declined: true } : { selected: [], text: "尽快" }),
        },
      ],
    });
    expect(p?.modelContent).toContain("答：用户拒绝回答");
    expect(p?.modelContent).toContain(
      "对用户拒绝回答的问题，请按你的判断继续，不要就同一问题再次提问，并在回复中说明所做的假设。",
    );
    await session.close();
  });

  it("invalid_reply：条数不符/未知 label/单选多项 → 拒绝且请求保持等待", async () => {
    const { runtime } = await makeRuntime(askThenDone(twoQuestions), { interactive: true });
    const session = await makeSession(runtime);
    const events = collect(session);
    const turn = session.submit({ text: "ask" });
    const req = await waitEvent(session, events, (e) => e.type === "question.requested");
    const requestId = req.type === "question.requested" ? req.payload.requestId : "";

    // 条数不符
    await expect(
      session.respondQuestion(requestId, { answers: [{ selected: ["SQLite"] }] }),
    ).rejects.toMatchObject({ code: "invalid_reply" });
    // 未知 label
    await expect(
      session.respondQuestion(requestId, {
        answers: [{ selected: ["Oracle"] }, { selected: [] }],
      }),
    ).rejects.toMatchObject({ code: "invalid_reply" });
    // 单选选了多项
    await expect(
      session.respondQuestion(requestId, {
        answers: [{ selected: ["SQLite", "PostgreSQL（推荐）"] }, { selected: [] }],
      }),
    ).rejects.toMatchObject({ code: "invalid_reply" });
    for (const invalid of [
      { declined: true, selected: [] },
      { declined: true, text: "不答" },
      { declined: false },
    ]) {
      await expect(
        session.respondQuestion(requestId, { answers: [invalid, { selected: [] }] } as never),
      ).rejects.toMatchObject({ code: "invalid_reply" });
    }
    await expect(
      session.respondQuestion(requestId, {
        answers: [{ selected: [] }, { selected: [], text: "字".repeat(2001) }],
      }),
    ).rejects.toMatchObject({ code: "invalid_reply" });
    // 未知请求
    await expect(session.respondQuestion("q-unknown", { answers: [] })).rejects.toMatchObject({
      code: "unknown_request",
    });
    // 请求仍在等待：没有第二个 requested，也没有 tool.completed
    expect(questionRequested(events)).toHaveLength(1);
    expect(completedFor(events)).toHaveLength(0);

    await session.respondQuestion(requestId, {
      answers: [{ selected: ["SQLite"] }, { selected: [] }],
    });
    const reason = await turn;
    expect(reason).toBe("done");
    expect(completedFor(events)[0]?.payload.status).toBe("ok");
    await session.close();
  });

  it("中断：interrupt → tool.completed(cancelled)，恰好一个", async () => {
    const { runtime } = await makeRuntime(askThenDone(twoQuestions), { interactive: true });
    const session = await makeSession(runtime);
    const events = collect(session);
    const turn = session.submit({ text: "ask" });
    await waitEvent(session, events, (e) => e.type === "question.requested");
    session.interrupt();
    const reason = await turn;
    expect(reason).toBe("aborted");
    const completed = completedFor(events);
    expect(completed).toHaveLength(1);
    expect(completed[0]?.payload.status).toBe("cancelled");
    await session.close();
  });

  it("非交互：not_interactive，不发 question.requested / waiting_user", async () => {
    const { runtime } = await makeRuntime(askThenDone(twoQuestions));
    const session = await makeSession(runtime);
    const events = collect(session);
    await session.submit({ text: "ask" });
    expect(questionRequested(events)).toHaveLength(0);
    expect(statusEvents(events)).not.toContain("waiting_user");
    const completed = completedFor(events);
    expect(completed).toHaveLength(1);
    const p = completed[0]?.payload;
    expect(p?.status).toBe("error");
    expect(p?.error?.code).toBe("not_interactive");
    expect(String(p?.modelContent)).toContain("非交互");
    await session.close();
  });

  it("超时：等待超过 timeoutMs → tool.completed(timeout)", async () => {
    // 执行器级：traits.timeoutMs 覆小（默认 24h 不可在测试里等）
    const ws = makeTmp("nct-au-ws-");
    const platform = createPlatform();
    const workspaceRoot = await platform.resolveReal(ws);
    const registry = createToolRegistry();
    registry.register({
      ...askUserTool,
      traits: { ...askUserTool.traits, timeoutMs: 30 },
    });
    const executor = createToolExecutor(registry);
    const broker = createQuestionBroker({ interactive: true });
    const events: { type: string; payload: unknown }[] = [];
    const scope: ExecutionScope = {
      cwd: ws,
      workspaceRoot,
      paths: platform.paths,
      sessionId: "s1",
      turnId: "t1",
      signal: new AbortController().signal,
      platform,
      gate: createPolicyGate(
        createWorkspaceReadPolicy({ workspaceRoot, caseSensitive: platform.caseSensitivePaths }),
      ),
      readState: createReadStateStore(platform.paths),
      events: {
        emit: (type, payload) => {
          events.push({ type, payload });
          return Promise.resolve();
        },
        emitEphemeral: (type, payload) => {
          events.push({ type, payload });
        },
      },
      askUser: broker,
    };
    const exec = await executor.execute(
      { callId: "q1", name: "ask_user", input: { questions: [{ question: "等不到回答" }] } },
      scope,
    );
    expect(exec.status).toBe("error");
    const completed = events.filter((e) => e.type === "tool.completed");
    expect(completed).toHaveLength(1);
    const p = completed[0]?.payload as { status: string; error?: { code: string } };
    expect(p.status).toBe("error");
    expect(p.error?.code).toBe("timeout");
  });

  it("视图派生：question.requested → pendingQuestion + waiting_user，结算后清除", async () => {
    const { runtime } = await makeRuntime(askThenDone(twoQuestions), { interactive: true });
    const session = await makeSession(runtime);
    const events = collect(session);
    const view = createSessionView();
    session.subscribe((e) => reduceSessionView(view, e));
    const turn = session.submit({ text: "ask" });
    const req = await waitEvent(session, events, (e) => e.type === "question.requested");
    const requestId = req.type === "question.requested" ? req.payload.requestId : "";
    // 派生状态：待回答问题 + waiting_user
    const callId = req.type === "question.requested" ? req.payload.callId : "";
    expect(view.pendingQuestion?.requestId).toBe(requestId);
    expect(view.pendingQuestion?.callId).toBe(callId);
    expect(view.pendingQuestion?.questions).toHaveLength(2);
    expect(view.status).toBe("waiting_user");
    await session.respondQuestion(requestId, {
      answers: [{ selected: ["SQLite"] }, { selected: [], text: "无" }],
    });
    await turn;
    expect(view.pendingQuestion).toBeUndefined();
    expect(view.status).toBe("idle");
    // 回答进入持久化条目：tool.completed.output 保留问题与回答
    const toolEntry = view.entries.find((e) => e.kind === "tool" && e.name === "ask_user");
    expect(toolEntry?.kind === "tool" && toolEntry.status).toBe("ok");
    await session.close();
  });
});

describe("ask_user 恢复与协议不变量", () => {
  it("进程退出：等待中的提问恢复为 tool.completed(interrupted)", async () => {
    const { runtime } = await makeRuntime(askThenDone([{ question: "来得及吗？" }]), {
      interactive: true,
    });
    const session = await makeSession(runtime);
    const events = collect(session);
    const turn = session.submit({ text: "ask" });
    void turn.catch(() => undefined);
    await waitEvent(session, events, (e) => e.type === "question.requested");
    // 模拟进程退出：绕过 RuntimeSession.close 的 Turn 收束，只释放存储锁
    await internalSession(session).close();

    const s2 = await runtime.resumeSession(session.id);
    expect(s2.recovery?.interruptedCalls).toBe(1);
    const durable = s2.durableEvents();
    const fixed = durable.find((e) => e.type === "tool.completed" && e.payload.name === "ask_user");
    expect(fixed?.type === "tool.completed" && fixed.payload.status).toBe("interrupted");
    // 提问是临时事件，不写日志；重放视图没有待回答问题
    expect(durable.some((e) => e.type.startsWith("question."))).toBe(false);
    const view = createSessionView();
    for (const e of durable) reduceSessionView(view, e);
    expect(view.pendingQuestion).toBeUndefined();
    await s2.close();
  });

  it("不新增持久化事件类型；formatVersion 不变；question.requested 是临时事件", () => {
    expect(DURABLE_EVENT_TYPES).toEqual(
      expect.arrayContaining([
        "session.created",
        "session.config_changed",
        "turn.started",
        "message.user",
        "message.assistant",
        "tool.started",
        "permission.requested",
        "permission.resolved",
        "permission.reviewed",
        "tool.completed",
        "context.compacted",
        "turn.completed",
      ]),
    );
    expect(LOG_FORMAT_VERSION).toBe(1);
    expect(isEphemeralEventType("question.requested")).toBe(true);
    expect(isDurableEventType("question.requested")).toBe(false);
  });

  it("Agent Loop 与 Context 源码不按 ask_user 名字分支", () => {
    // AGENTS.md 硬性约束：工具差异只经 traits 表达——守卫住这条边界
    const srcRoot = fileURLToPath(new URL("../src", import.meta.url));
    const offenders: string[] = [];
    const scan = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = path.join(dir, name);
        if (statSync(p).isDirectory()) {
          scan(p);
        } else if (name.endsWith(".ts")) {
          // 系统提示会点名 ask_user（ADR-0035 §7 的新版 Tools 节），那不是分支；
          // 按名字分支的写法必然带引号比较/字面量，只查带引号的引用
          const src = readFileSync(p, "utf8");
          if (src.includes('"ask_user"') || src.includes("'ask_user'")) offenders.push(p);
        }
      }
    };
    for (const d of ["agent", "context"]) scan(path.join(srcRoot, d));
    expect(offenders).toEqual([]);
  });
});

describe("ask_user 与子代理池（ADR-0032 §4）", () => {
  const isChildRequest = (r: ModelRequest) => r.tools.some((t) => t.name === "finish");

  it("子会话工具池按特性排除 needsUser：child 请求不含 ask_user", async () => {
    const provider = new FakeProvider({
      handler: (req) => {
        if (isChildRequest(req)) {
          return [
            {
              type: "tool_call",
              toolCallId: "cf1",
              name: "finish",
              input: { result: "完成" },
            },
            { type: "finish", reason: "tool_calls" },
          ];
        }
        return req.messages.some((m) => m.role === "tool")
          ? [
              { type: "text_delta", text: "收到" },
              { type: "finish", reason: "stop" },
            ]
          : [
              {
                type: "tool_call",
                toolCallId: "task-1",
                name: "task",
                input: { task: "调查", preset: "general" },
              },
              { type: "finish", reason: "tool_calls" },
            ];
      },
    });
    const { runtime } = await makeRuntime(undefined, { provider, autoApproveAsk: true });
    const session = await makeSession(runtime);
    await session.submit({ text: "跑个子任务" });
    const childReq = provider.requests.find(isChildRequest);
    expect(childReq).toBeDefined();
    const names = childReq?.tools.map((t) => t.name) ?? [];
    expect(names).toContain("read");
    expect(names).not.toContain("ask_user");
    // 父池仍含 ask_user（顶层会话可交互）
    expect(provider.requests[0]?.tools.some((t) => t.name === "ask_user")).toBe(true);
    await session.close();
  });

  it("显式 tools 白名单点名 ask_user → 不可用名 invalid_input", async () => {
    const { runtime } = await makeRuntime(
      [
        [
          {
            type: "tool_call",
            toolCallId: "task-1",
            name: "task",
            input: { task: "提问", tools: ["read", "ask_user"] },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        [
          { type: "text_delta", text: "done" },
          { type: "finish", reason: "stop" },
        ],
      ],
      { autoApproveAsk: true },
    );
    const session = await makeSession(runtime);
    const events = collect(session);
    await session.submit({ text: "派生" });
    const completed = events.find((e) => e.type === "tool.completed" && e.payload.name === "task");
    expect(completed?.type === "tool.completed" && completed.payload.status).toBe("error");
    expect(completed?.type === "tool.completed" && completed.payload.error?.code).toBe(
      "invalid_input",
    );
    const text = completed?.type === "tool.completed" ? String(completed.payload.modelContent) : "";
    expect(text).toContain("ask_user");
    await session.close();
  });

  it("builtinTools 含 ask_user 且声明 needsUser", () => {
    const tool = builtinTools().find((t) => t.name === "ask_user");
    expect(tool?.traits.needsUser).toBe(true);
    expect(tool?.traits.concurrencySafe).toBe(false);
    expect(tool?.traits.mutates).toBe(false);
  });
});
