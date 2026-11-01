/**
 * ADR-0076 执行方式：提交入口 `workMode`、说明块快照、待发输入与各模式的状态与行为。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  createRuntime,
  RuntimeCommandError,
  type Runtime,
  type RuntimeSession,
} from "../src/index.js";
import { FakeProvider, type FakeScript, type ModelRequest } from "../src/provider/index.js";
import {
  goalStatusLines,
  parseWorkModeSlash,
  replaySessionView,
  userEntryText,
  workModeDisplayText,
  type DurableEvent,
  type GoalState,
  type RuntimeEvent,
} from "../src/protocol/index.js";
import { goalContinuation } from "../src/work-modes/index.js";

const tmpRoots: string[] = [];
afterEach(() => {
  for (const root of tmpRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const makeTmp = (prefix: string): string => {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
};

async function makeRuntime(
  provider: FakeProvider,
  extra: Partial<Parameters<typeof createRuntime>[0]> = {},
): Promise<Runtime> {
  return await createRuntime({
    cwd: makeTmp("nct-wm-ws-"),
    sessionsDir: makeTmp("nct-wm-sd-"),
    providers: [provider],
    interactive: true,
    ...extra,
  });
}

const textScript = (text: string): FakeScript => [
  { type: "text_delta", text },
  { type: "finish", reason: "stop" },
];

const askScript = (question: string, options?: string[]): FakeScript => [
  {
    type: "tool_call",
    toolCallId: `ask-${question}`,
    name: "ask_user",
    input: {
      questions: [
        {
          question,
          ...(options ? { options: options.map((label) => ({ label })) } : {}),
        },
      ],
    },
  },
  { type: "finish", reason: "tool_calls" },
];

function collect(session: RuntimeSession): RuntimeEvent[] {
  const events: RuntimeEvent[] = [];
  session.subscribe((event) => events.push(event));
  return events;
}

const users = (session: RuntimeSession) =>
  session
    .durableEvents()
    .filter((event): event is DurableEvent<"message.user"> => event.type === "message.user");

const requestText = (request: ModelRequest | undefined): string =>
  (request?.messages ?? [])
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : message.content
            .map((block) => ("text" in block && typeof block.text === "string" ? block.text : ""))
            .join("\n"),
    )
    .join("\n");

async function rejects(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toSatisfy(
    (error: unknown) => error instanceof RuntimeCommandError && error.code === code,
  );
}

describe("protocol：斜杠解析与显示", () => {
  it("命令名不区分大小写，任务可多行；只有命令名时给用法", () => {
    expect(parseWorkModeSlash("/Grill-Me 做个登录页\n要支持暗色")).toEqual({
      kind: "submit",
      workMode: "grill-me",
      text: "做个登录页\n要支持暗色",
    });
    expect(parseWorkModeSlash("  /grill-me   ")).toEqual({
      kind: "usage",
      name: "grill-me",
      hint: "用法：/grill-me 需求",
    });
    expect(parseWorkModeSlash("/grill-mex 任务")).toBeUndefined();
    expect(parseWorkModeSlash("grill-me 任务")).toBeUndefined();
  });

  it("显示文本：执行方式消息加命令名，正文为空时只有命令名", () => {
    expect(workModeDisplayText("做个页面", { name: "grill-me" })).toBe("/grill-me 做个页面");
    expect(workModeDisplayText("", { name: "goal" })).toBe("/goal");
    expect(workModeDisplayText("普通", undefined)).toBe("普通");
  });
});

describe("提交入口 workMode", () => {
  it("说明块追加在末尾并随 message.user 快照；视图正文只剩任务", async () => {
    const provider = new FakeProvider({ scripts: [textScript("好")] });
    const runtime = await makeRuntime(provider);
    const session = await runtime.createSession({ model: "fake/fake-1" });
    expect(await session.submit({ text: "做个登录页", workMode: "grill-me" })).toBe("done");

    const [message] = users(session);
    expect(message?.payload.workMode?.name).toBe("grill-me");
    expect(message?.payload.workMode?.body).toContain("ask_user");
    const last = message?.payload.content.at(-1);
    expect(last?.type === "text" ? last.text : "").toMatch(
      /^<work-mode name="grill-me">\n[\s\S]*\n<\/work-mode>$/,
    );
    expect(requestText(provider.requests[0])).toContain('<work-mode name="grill-me">');

    const view = replaySessionView(session.durableEvents());
    const entry = view.entries.find((item) => item.kind === "user");
    if (entry?.kind !== "user") throw new Error("missing user entry");
    expect(entry.workMode?.name).toBe("grill-me");
    expect(userEntryText(entry)).toBe("做个登录页");
    await session.close();
  });

  it("任务为空、与技能或委派同时出现、名字未知：invalid_command 且不写 Turn", async () => {
    const runtime = await makeRuntime(new FakeProvider({ scripts: [] }));
    const session = await runtime.createSession({ model: "fake/fake-1" });
    await rejects(session.submit({ text: "   ", workMode: "grill-me" }), "invalid_command");
    await rejects(
      session.submit({ text: "x", workMode: "grill-me", skill: { name: "demo" } }),
      "invalid_command",
    );
    await rejects(
      session.submit({ text: "x", workMode: "grill-me", delegate: { agent: "a", task: "b" } }),
      "invalid_command",
    );
    await rejects(
      session.submit({ text: "x", workMode: "nope" as unknown as "grill-me" }),
      "invalid_command",
    );
    expect(session.durableEvents().some((event) => event.type === "turn.started")).toBe(false);
    await session.close();
  });

  it("运行中：插话带执行方式被拒；排队可以，快照带名字且不能转成插话，done 后按模式发出", async () => {
    const provider = new FakeProvider({
      scripts: [askScript("用哪个？"), textScript("先做完"), textScript("开始追问")],
    });
    const runtime = await makeRuntime(provider);
    const session = await runtime.createSession({ model: "fake/fake-1" });
    let queuedId = "";
    session.subscribe((event) => {
      if (event.type !== "question.requested") return;
      void (async () => {
        await rejects(
          session.enqueueInput("steer", { text: "做 B", workMode: "grill-me" }),
          "invalid_command",
        );
        queuedId = (await session.enqueueInput("queue", { text: "做 B", workMode: "grill-me" })).id;
        expect(session.pendingInputs().items[0]?.workMode).toBe("grill-me");
        await rejects(session.updateInput(queuedId, { mode: "steer" }), "invalid_command");
        await rejects(session.updateInput(queuedId, { input: { text: "  " } }), "invalid_command");
        await session.updateInput(queuedId, { input: { text: "做 B，带暗色" } });
        await session.respondQuestion(event.payload.requestId, {
          answers: [{ selected: [], text: "A" }],
        });
      })();
    });
    expect(await session.submit({ text: "做 A" })).toBe("done");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const all = users(session);
    expect(all.at(-1)?.payload.workMode?.name).toBe("grill-me");
    expect(all.at(-1)?.payload.steer).toBeUndefined();
    // 编辑只换任务文本，说明块仍在末尾
    const content = all.at(-1)?.payload.content ?? [];
    expect(content[0]?.type === "text" ? content[0].text : "").toBe("做 B，带暗色");
    expect(content.at(-1)?.type === "text" ? content.at(-1)?.text : "").toContain("<work-mode");
    expect(queuedId).not.toBe("");
    await session.close();
  });
});

describe("/grill-me", () => {
  it("假模型跑通：一次一个问题，回答后给出需求清单", async () => {
    const provider = new FakeProvider({
      scripts: [
        askScript("登录方式用哪种？", ["邮箱密码（推荐）", "手机验证码"]),
        askScript("需要记住登录状态吗？", ["需要（推荐）", "不需要"]),
        textScript("需求清单：邮箱密码登录；记住登录状态。"),
      ],
    });
    const runtime = await makeRuntime(provider);
    const session = await runtime.createSession({ model: "fake/fake-1" });
    const events = collect(session);
    session.subscribe((event) => {
      if (event.type !== "question.requested") return;
      const label = event.payload.questions[0]?.options?.[0]?.label ?? "";
      void session.respondQuestion(event.payload.requestId, {
        answers: [{ selected: [label] }],
      });
    });
    expect(await session.submit({ text: "做个登录页", workMode: "grill-me" })).toBe("done");
    const questions = events.filter((event) => event.type === "question.requested");
    expect(questions).toHaveLength(2);
    expect(
      questions.every(
        (event) => event.type === "question.requested" && event.payload.questions.length === 1,
      ),
    ).toBe(true);
    // 说明块在首个请求里，后续请求沿用同一条用户消息
    expect(requestText(provider.requests[0])).toContain("exactly one question per call");
    expect(requestText(provider.requests[2])).toContain("邮箱密码（推荐）");
    await session.close();
  });
});

const goalMet = (id: string): FakeScript => [
  {
    type: "tool_call",
    toolCallId: id,
    name: "update_goal",
    input: { status: "met", checklist: [{ item: "测试通过", evidence: "pnpm test 0 failed" }] },
  },
  { type: "finish", reason: "tool_calls" },
];

const goalSteers = (session: RuntimeSession) =>
  users(session).filter((event) => event.payload.steer === true && event.payload.workMode);

const toolNames = (request: ModelRequest | undefined): string[] =>
  (request?.tools ?? []).map((tool) => tool.name);

describe("/goal", () => {
  it("斜杠解析：无参数看状态，stop/resume 是子命令，其余文字都是目标", () => {
    expect(parseWorkModeSlash("/goal")).toEqual({ kind: "action", action: "goal-status" });
    expect(parseWorkModeSlash("/goal Stop")).toEqual({ kind: "action", action: "goal-stop" });
    expect(parseWorkModeSlash("/goal resume")).toEqual({ kind: "action", action: "goal-resume" });
    expect(parseWorkModeSlash("/goal stop the dev server")).toEqual({
      kind: "submit",
      workMode: "goal",
      text: "stop the dev server",
    });
  });

  it("假模型跑通：Turn 想结束被拦下核对，update_goal(met) 后照常结束，只有一个 Turn", async () => {
    const provider = new FakeProvider({
      scripts: [
        textScript("清单：1. 测试通过。已改完。"),
        goalMet("g1"),
        textScript("全部核对完成。"),
      ],
    });
    const runtime = await makeRuntime(provider);
    const session = await runtime.createSession({ model: "fake/fake-1" });
    expect(await session.submit({ text: "修好测试", workMode: "goal" })).toBe("done");

    const durable = session.durableEvents();
    expect(durable.filter((event) => event.type === "turn.started")).toHaveLength(1);
    // 设定目标的 config_changed 写在 turn.started 之前
    const goalAt = durable.findIndex(
      (event) => event.type === "session.config_changed" && event.payload.goal !== undefined,
    );
    expect(goalAt).toBeLessThan(durable.findIndex((event) => event.type === "turn.started"));
    const steers = goalSteers(session);
    expect(steers).toHaveLength(1);
    expect(steers[0]?.payload.workMode?.name).toBe("goal");
    expect(steers[0]?.payload.workMode?.body).toContain("Goal check 1/10");
    expect(steers[0]?.payload.workMode?.body).toContain("修好测试");
    expect(toolNames(provider.requests[0])).toContain("update_goal");

    const goal = session.state().goal;
    expect(goal).toMatchObject({ objective: "修好测试", status: "met", rounds: 1 });
    expect(goal?.turnStartedAt).toBeUndefined();
    const completed = durable.find(
      (event) => event.type === "tool.completed" && event.payload.name === "update_goal",
    );
    expect(completed?.type === "tool.completed" ? completed.payload.output : undefined).toEqual({
      status: "met",
      checklist: [{ item: "测试通过", evidence: "pnpm test 0 failed" }],
    });
    // 视图与 Core 折叠同源
    expect(replaySessionView(durable).goal).toEqual(goal);
    // 核对说明在视图里只有命令名
    const entry = replaySessionView(durable).entries.filter((item) => item.kind === "user")[1];
    if (entry?.kind !== "user") throw new Error("missing goal entry");
    expect(workModeDisplayText(userEntryText(entry), entry.workMode)).toBe("/goal");
    await session.close();
  });

  it("没有目标时不注册 update_goal、不续跑", async () => {
    const provider = new FakeProvider({ scripts: [textScript("好")] });
    const runtime = await makeRuntime(provider);
    const session = await runtime.createSession({ model: "fake/fake-1" });
    expect(await session.submit({ text: "随便聊聊" })).toBe("done");
    expect(toolNames(provider.requests[0])).not.toContain("update_goal");
    expect(provider.requests).toHaveLength(1);
    expect(session.state().goal).toBeUndefined();
    await session.close();
  });

  it("到达轮数上限：写 limit，送一条收尾说明，这一轮随后结束", async () => {
    const provider = new FakeProvider({ handler: () => textScript("还在做") });
    const runtime = await makeRuntime(provider);
    const session = await runtime.createSession({ model: "fake/fake-1" });
    expect(await session.submit({ text: "做完它", workMode: "goal" })).toBe("done");
    // 首个请求 + 10 次核对 + 1 次收尾
    expect(provider.requests).toHaveLength(12);
    const steers = goalSteers(session);
    expect(steers).toHaveLength(11);
    expect(steers.at(-1)?.payload.workMode?.body).toContain("The goal limit was reached");
    expect(session.state().goal).toMatchObject({ status: "limit", rounds: 10 });
    expect(toolNames(provider.requests.at(-1))).not.toContain("update_goal");
    await session.close();
  });

  it("用户中断：目标停止（interrupted），之后的普通消息不被接管", async () => {
    const provider = new FakeProvider({
      scripts: [[{ type: "wait" }], textScript("普通回复")],
    });
    const runtime = await makeRuntime(provider);
    const session = await runtime.createSession({ model: "fake/fake-1" });
    const running = session.submit({ text: "长任务", workMode: "goal" });
    await expect.poll(() => provider.waitState.waiting).toBe(1);
    session.interrupt();
    expect(await running).toBe("aborted");
    expect(session.state().goal).toMatchObject({ status: "stopped", reason: "interrupted" });
    expect(await session.submit({ text: "换个话题" })).toBe("done");
    expect(provider.requests).toHaveLength(2);
    await session.close();
  });

  it("stopGoal：Turn 进行中停止后不再续跑；update_goal 以 invalid_input 结算", async () => {
    const provider = new FakeProvider({
      scripts: [askScript("继续吗？"), goalMet("late"), textScript("停了")],
    });
    const runtime = await makeRuntime(provider);
    const session = await runtime.createSession({ model: "fake/fake-1" });
    session.subscribe((event) => {
      if (event.type !== "question.requested") return;
      void (async () => {
        await session.stopGoal();
        await session.respondQuestion(event.payload.requestId, {
          answers: [{ selected: [], text: "嗯" }],
        });
      })();
    });
    expect(await session.submit({ text: "做个东西", workMode: "goal" })).toBe("done");
    expect(session.state().goal).toMatchObject({ status: "stopped", reason: "user" });
    expect(goalSteers(session)).toHaveLength(0);
    const late = session
      .durableEvents()
      .find((event) => event.type === "tool.completed" && event.payload.name === "update_goal");
    expect(late?.type === "tool.completed" ? late.payload.status : undefined).toBe("error");
    expect(late?.type === "tool.completed" ? late.payload.error?.code : undefined).toBe(
      "invalid_input",
    );
    await session.close();
  });

  it("update_goal 输入校验：met 要有带证据的清单，blocked 要有原因", async () => {
    const provider = new FakeProvider({
      scripts: [
        [
          {
            type: "tool_call",
            toolCallId: "bad-met",
            name: "update_goal",
            input: { status: "met", checklist: [{ item: "x", evidence: " " }] },
          },
          {
            type: "tool_call",
            toolCallId: "bad-blocked",
            name: "update_goal",
            input: { status: "blocked" },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        [
          {
            type: "tool_call",
            toolCallId: "blocked",
            name: "update_goal",
            input: { status: "blocked", reason: "需要生产环境密钥" },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        textScript("需要你提供密钥"),
      ],
    });
    const runtime = await makeRuntime(provider);
    const session = await runtime.createSession({ model: "fake/fake-1" });
    expect(await session.submit({ text: "部署", workMode: "goal" })).toBe("done");
    // callId 由 Runtime 重新编号，按顺序比对结果
    const statuses = session
      .durableEvents()
      .flatMap((event) =>
        event.type === "tool.completed"
          ? [[event.payload.status, event.payload.error?.code ?? ""]]
          : [],
      );
    expect(statuses).toEqual([
      ["error", "invalid_input"],
      ["error", "invalid_input"],
      ["ok", ""],
    ]);
    expect(session.state().goal).toMatchObject({ status: "blocked", reason: "需要生产环境密钥" });
    expect(goalSteers(session)).toHaveLength(0);
    await session.close();
  });

  it("恢复会话：目标原样恢复且不自动开 Turn；resumeGoal 空闲时开新 Turn，轮数重算", async () => {
    const provider = new FakeProvider({
      scripts: [
        textScript("先做一部分"),
        goalMet("g1"),
        textScript("完成"),
        goalMet("g2"),
        textScript("又核对了一遍"),
      ],
    });
    const sessionsDir = makeTmp("nct-wm-resume-");
    const cwd = makeTmp("nct-wm-resume-ws-");
    const first = await makeRuntime(provider, { sessionsDir, cwd });
    const session = await first.createSession({ model: "fake/fake-1" });
    await session.submit({ text: "收尾", workMode: "goal" });
    const id = session.id;
    const before = session.state().goal;
    await session.close();

    const second = await makeRuntime(provider, { sessionsDir, cwd });
    const resumed = await second.resumeSession(id);
    expect(resumed.state().goal).toEqual(before);
    expect(resumed.durableEvents().filter((e) => e.type === "turn.started")).toHaveLength(1);

    await resumed.resumeGoal();
    const turns = resumed.durableEvents().filter((e) => e.type === "turn.started");
    expect(turns).toHaveLength(2);
    const opener = users(resumed).at(-1);
    expect(opener?.payload.steer).toBeUndefined();
    expect(opener?.payload.workMode?.body).toContain("Resume working on this goal");
    expect(resumed.state().goal).toMatchObject({ status: "met", rounds: 0 });
    await resumed.close();
  });

  it("没有目标时 stopGoal / resumeGoal 报 invalid_command", async () => {
    const runtime = await makeRuntime(new FakeProvider({ scripts: [] }));
    const session = await runtime.createSession({ model: "fake/fake-1" });
    await rejects(session.stopGoal(), "invalid_command");
    await rejects(session.resumeGoal(), "invalid_command");
    await session.close();
  });

  it("续跑判断：后台子代理在跑或有排队输入时不续；时长上限同样生效", () => {
    const goal: GoalState = {
      objective: "x",
      status: "active",
      maxMinutes: 60,
      maxRounds: 10,
      since: 1,
      rounds: 0,
      activeMs: 0,
    };
    const base = { backgroundRunning: 0, queued: false, nowMs: 0 };
    expect(goalContinuation(goal, base).kind).toBe("check");
    expect(goalContinuation(goal, { ...base, backgroundRunning: 1 }).kind).toBe("none");
    expect(goalContinuation(goal, { ...base, queued: true }).kind).toBe("none");
    expect(goalContinuation({ ...goal, status: "met" }, base).kind).toBe("none");
    expect(goalContinuation({ ...goal, activeMs: 60 * 60_000 }, base).kind).toBe("limit");
    const running = { ...goal, turnStartedAt: new Date(0).toISOString() };
    expect(goalContinuation(running, { ...base, nowMs: 59 * 60_000 }).kind).toBe("check");
    expect(goalContinuation(running, { ...base, nowMs: 61 * 60_000 }).kind).toBe("limit");
  });

  it("状态行：目标、状态、轮数与时长", () => {
    expect(goalStatusLines(undefined, 0)).toEqual(["没有目标"]);
    expect(
      goalStatusLines(
        {
          objective: "修好测试",
          status: "blocked",
          reason: "缺密钥",
          maxMinutes: 60,
          maxRounds: 10,
          since: 1,
          rounds: 3,
          activeMs: 125_000,
        },
        0,
      ),
    ).toEqual(["目标：修好测试", "状态：受阻（缺密钥）", "轮数：3/10", "时长：2/60 分钟"]);
  });
});
