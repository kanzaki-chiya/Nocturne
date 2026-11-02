/**
 * ADR-0076 执行方式：提交入口 `workMode`、说明块快照、待发输入与各模式的状态与行为。
 */
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { worktreeGit } from "../src/agent/worktree.js";

import {
  createRuntime,
  RuntimeCommandError,
  type Runtime,
  type RuntimeSession,
} from "../src/index.js";
import { FakeProvider, type FakeScript, type ModelRequest } from "../src/provider/index.js";
import {
  goalStatusLines,
  formatGoalDuration,
  parseWorkModeSlash,
  replaySessionView,
  userEntryText,
  userWorkMode,
  workModeDisplayText,
  workModeOrigins,
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
  const dir = realpathSync.native(mkdtempSync(path.join(tmpdir(), prefix)));
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
    expect(parseWorkModeSlash("/goal cancel")).toEqual({ kind: "action", action: "goal-cancel" });
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
    expect(steers[0]?.payload.workMode?.body).toContain("Goal check 1.");
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

  it("取消运行中的目标立即中断；恢复后仍无目标", async () => {
    const provider = new FakeProvider({ scripts: [[{ type: "wait" }]] });
    const runtime = await makeRuntime(provider);
    const session = await runtime.createSession({ model: "fake/fake-1" });
    const running = session.submit({ text: "长任务", workMode: "goal" });
    await expect.poll(() => provider.waitState.waiting).toBe(1);
    await session.cancelGoal();
    expect(await running).toBe("aborted");
    expect(session.state().goal).toBeUndefined();
    expect(goalSteers(session)).toHaveLength(0);
    const id = session.id;
    await session.close();
    const restored = await runtime.resumeSession(id);
    expect(restored.state().goal).toBeUndefined();
    await restored.close();
  });

  it("空闲受阻的目标也可取消，持久重放后不存在", async () => {
    const runtime = await makeRuntime(new FakeProvider({ handler: () => textScript("无工具") }));
    const session = await runtime.createSession({ model: "fake/fake-1" });
    await session.submit({ text: "x", workMode: "goal" });
    expect(session.state().goal?.status).toBe("blocked");
    await session.cancelGoal();
    expect(replaySessionView(session.durableEvents()).goal).toBeUndefined();
    await session.close();
  });

  it("连续三轮核对无工具调用：写 blocked 并结束，不额外请求模型", async () => {
    const provider = new FakeProvider({ handler: () => textScript("还在做") });
    const runtime = await makeRuntime(provider);
    const session = await runtime.createSession({ model: "fake/fake-1" });
    expect(await session.submit({ text: "做完它", workMode: "goal" })).toBe("done");
    expect(provider.requests).toHaveLength(4);
    const steers = goalSteers(session);
    expect(steers).toHaveLength(3);
    expect(session.state().goal).toMatchObject({
      status: "blocked",
      rounds: 3,
      noProgressRounds: 3,
    });
    expect(session.state().goal?.reason).toContain("No progress");
    expect(replaySessionView(session.durableEvents()).goal).toEqual(session.state().goal);
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
    // 继续目标不是新目标：目标正文保留
    expect(resumed.state().goal).toMatchObject({ objective: "收尾", status: "met", rounds: 0 });
    const goalWrites = resumed
      .durableEvents()
      .flatMap((e) =>
        e.type === "session.config_changed" && e.payload.goal ? [e.payload.goal] : [],
      );
    expect(goalWrites.every((goal) => goal.objective === "收尾")).toBe(true);
    await resumed.close();
  });

  it("没有目标时 stopGoal / resumeGoal 报 invalid_command", async () => {
    const runtime = await makeRuntime(new FakeProvider({ scripts: [] }));
    const session = await runtime.createSession({ model: "fake/fake-1" });
    await rejects(session.stopGoal(), "invalid_command");
    await rejects(session.resumeGoal(), "invalid_command");
    await rejects(session.cancelGoal(), "invalid_command");
    await session.close();
  });

  it("续跑判断：后台子代理、排队、计划暂停核对；50轮和2小时仍继续", () => {
    const goal: GoalState = {
      objective: "x",
      status: "active",
      maxMinutes: 60,
      maxRounds: 10,
      since: 1,
      rounds: 0,
      activeMs: 0,
    };
    const base = { backgroundRunning: 0, queued: false, planning: false, nowMs: 0 };
    expect(goalContinuation(goal, base).kind).toBe("check");
    expect(goalContinuation(goal, { ...base, planning: true }).kind).toBe("none");
    // 计划模式期间连上限收尾也不做：等计划结束后的下一轮再判断
    expect(goalContinuation({ ...goal, rounds: 10 }, { ...base, planning: true }).kind).toBe(
      "none",
    );
    expect(goalContinuation(goal, { ...base, backgroundRunning: 1 }).kind).toBe("none");
    expect(goalContinuation(goal, { ...base, queued: true }).kind).toBe("none");
    expect(goalContinuation({ ...goal, status: "met" }, base).kind).toBe("none");
    expect(goalContinuation({ ...goal, rounds: 50, activeMs: 2 * 60 * 60_000 }, base).kind).toBe(
      "check",
    );
    const running = { ...goal, turnStartedAt: new Date(0).toISOString() };
    expect(goalContinuation(running, { ...base, nowMs: 59 * 60_000 }).kind).toBe("check");
    expect(goalContinuation(running, { ...base, nowMs: 120 * 60_000 }).kind).toBe("check");
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
    ).toEqual(["目标：修好测试", "状态：受阻（缺密钥）", "轮数：3", "时长：2分5秒"]);
  });
  it.each([
    [0, "0秒"],
    [59_000, "59秒"],
    [60_000, "1分0秒"],
    [3_599_000, "59分59秒"],
    [3_600_000, "1小时0分0秒"],
    [3_788_000, "1小时3分8秒"],
    [728_999, "12分8秒"],
  ])("时长 %ims → %s", (ms, text) => {
    expect(formatGoalDuration(ms)).toBe(text);
  });
});

describe("/plan（ADR-0076 §5）", () => {
  const writeScript = (file: string): FakeScript => [
    {
      type: "tool_call",
      toolCallId: `write-${file}`,
      name: "write",
      input: { path: file, content: "x" },
    },
    { type: "finish", reason: "tool_calls" },
  ];
  const preset = (session: RuntimeSession) => session.state().config.permissionPreset;
  const statusOf = (session: RuntimeSession, name: string) =>
    session
      .durableEvents()
      .flatMap((e) =>
        e.type === "tool.completed" && e.payload.name === name ? [e.payload.status] : [],
      );

  it("进入只读、记下原预设；计划轮内写入被拒；再次 /plan 保留最初的预设", async () => {
    const provider = new FakeProvider({
      scripts: [writeScript("a.txt"), textScript("# 计划\n1. 改 a"), textScript("# 计划 v2")],
    });
    const runtime = await makeRuntime(provider);
    const session = await runtime.createSession({
      model: "fake/fake-1",
      permissionPreset: "auto-edit",
    });
    await session.submit({ text: "加个功能", workMode: "plan" });
    expect(preset(session)).toBe("read-only");
    expect(session.state().plan).toEqual({ restorePreset: "auto-edit" });
    expect(statusOf(session, "write")).toHaveLength(1);
    expect(statusOf(session, "write")[0]).not.toBe("ok");
    expect(requestText(provider.requests[0])).toContain("Plan mode");
    // 预设与 plan 在同一条 config_changed 里，且早于 turn.started
    const events = session.durableEvents();
    const switched = events.findIndex(
      (e) => e.type === "session.config_changed" && e.payload.plan !== undefined,
    );
    expect(events[switched]?.payload).toMatchObject({
      permissionPreset: "read-only",
      plan: { restorePreset: "auto-edit" },
    });
    expect(switched).toBeLessThan(events.findIndex((e) => e.type === "turn.started"));

    await session.submit({ text: "改一下", workMode: "plan" });
    expect(session.state().plan).toEqual({ restorePreset: "auto-edit" });
    expect(replaySessionView(session.durableEvents()).plan).toEqual({ restorePreset: "auto-edit" });
    await session.close();
  });

  it("批准：恢复原预设、退出计划模式，开新 Turn 按计划实施", async () => {
    const provider = new FakeProvider({
      scripts: [textScript("# 计划"), writeScript("a.txt"), textScript("已实施")],
    });
    const runtime = await makeRuntime(provider);
    const session = await runtime.createSession({
      model: "fake/fake-1",
      permissionPreset: "auto-edit",
    });
    await session.submit({ text: "加个功能", workMode: "plan" });
    await session.approvePlan();
    expect(preset(session)).toBe("auto-edit");
    expect(session.state().plan).toBeUndefined();
    expect(replaySessionView(session.durableEvents()).plan).toBeUndefined();
    expect(session.durableEvents().filter((e) => e.type === "turn.started")).toHaveLength(2);
    const approval = users(session).at(-1);
    expect(approval?.payload.workMode?.name).toBe("plan");
    expect(approval?.payload.steer).toBeUndefined();
    const lastEntry = replaySessionView(session.durableEvents()).entries.findLast(
      (item) => item.kind === "user",
    );
    expect(lastEntry && userEntryText(lastEntry)).toBe("批准");
    expect(requestText(provider.requests[1])).toContain("approved the latest plan");
    expect(statusOf(session, "write")).toEqual(["ok"]);
    await session.close();
  });

  it("原本就是只读时批准改用 default；放弃恢复原预设且不开 Turn", async () => {
    const provider = new FakeProvider({
      scripts: [textScript("# 计划"), textScript("实施"), textScript("# 计划")],
    });
    const runtime = await makeRuntime(provider);
    const session = await runtime.createSession({
      model: "fake/fake-1",
      permissionPreset: "read-only",
    });
    await session.submit({ text: "任务", workMode: "plan" });
    await session.approvePlan();
    expect(preset(session)).toBe("default");

    await session.setPermissionPreset("guarded");
    await session.submit({ text: "任务二", workMode: "plan" });
    const turns = session.durableEvents().filter((e) => e.type === "turn.started").length;
    await session.cancelPlan();
    expect(preset(session)).toBe("guarded");
    expect(session.state().plan).toBeUndefined();
    expect(session.durableEvents().filter((e) => e.type === "turn.started")).toHaveLength(turns);
    await session.close();
  });

  it("不在计划模式时 approve / cancel 报 invalid_command；忙时批准报 session_busy", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const provider = new FakeProvider({
      handler: async () => {
        calls += 1;
        if (calls === 2) await gate;
        return textScript(calls === 1 ? "# 计划" : "继续");
      },
    });
    const runtime = await makeRuntime(provider);
    const session = await runtime.createSession({ model: "fake/fake-1" });
    await rejects(session.approvePlan(), "invalid_command");
    await rejects(session.cancelPlan(), "invalid_command");
    await session.submit({ text: "任务", workMode: "plan" });
    const running = session.submit({ text: "补充一点" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await rejects(session.approvePlan(), "session_busy");
    release();
    await running;
    expect(session.state().plan).toBeDefined();
    await session.close();
  });

  it("恢复会话：计划模式与只读预设原样保留，批准照常可用", async () => {
    const provider = new FakeProvider({ scripts: [textScript("# 计划"), textScript("实施")] });
    const sessionsDir = makeTmp("nct-wm-plan-");
    const cwd = makeTmp("nct-wm-plan-ws-");
    const first = await makeRuntime(provider, { sessionsDir, cwd });
    const session = await first.createSession({
      model: "fake/fake-1",
      permissionPreset: "default",
    });
    await session.submit({ text: "任务", workMode: "plan" });
    const id = session.id;
    await session.close();

    const second = await makeRuntime(provider, { sessionsDir, cwd });
    const resumed = await second.resumeSession(id);
    expect(resumed.state().plan).toEqual({ restorePreset: "default" });
    expect(preset(resumed)).toBe("read-only");
    await resumed.approvePlan();
    expect(preset(resumed)).toBe("default");
    await resumed.close();
  });

  it("斜杠：/plan approve|cancel 是操作，只有命令名给用法，其余是任务", () => {
    expect(parseWorkModeSlash("/plan approve")).toEqual({ kind: "action", action: "plan-approve" });
    expect(parseWorkModeSlash(" /Plan CANCEL ")).toEqual({ kind: "action", action: "plan-cancel" });
    expect(parseWorkModeSlash("/plan")).toEqual({
      kind: "usage",
      name: "plan",
      hint: "用法：/plan 任务",
    });
    expect(parseWorkModeSlash("/plan approve the design")).toEqual({
      kind: "submit",
      workMode: "plan",
      text: "approve the design",
    });
  });
});

describe("/boost（ADR-0076 §6）", () => {
  async function initGitRepo(): Promise<string> {
    const root = makeTmp("nct-wm-boost-");
    await worktreeGit(root, ["init"]);
    await worktreeGit(root, ["config", "core.autocrlf", "false"]);
    writeFileSync(path.join(root, "readme.txt"), "base\n");
    await worktreeGit(root, ["add", "readme.txt"]);
    await worktreeGit(root, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@localhost",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--no-verify",
      "-m",
      "initial",
    ]);
    return root;
  }

  it("未开启后台子代理或子代理停用时报 invalid_command；非 git 目录写明只并行调查", async () => {
    const noBg = await makeRuntime(new FakeProvider({ scripts: [] }));
    const s1 = await noBg.createSession({ model: "fake/fake-1" });
    await rejects(s1.submit({ text: "攻坚", workMode: "boost" }), "invalid_command");
    await s1.close();

    const disabled = await makeRuntime(new FakeProvider({ scripts: [] }), {
      subagent: { enabled: false, background: true },
    });
    const s2 = await disabled.createSession({ model: "fake/fake-1" });
    await rejects(s2.submit({ text: "攻坚", workMode: "boost" }), "invalid_command");
    await s2.close();

    const provider = new FakeProvider({ scripts: [textScript("已调查")] });
    const nonGit = await makeRuntime(provider, {
      subagent: { background: true, maxBackground: 2 },
    });
    const s3 = await nonGit.createSession({ model: "fake/fake-1" });
    await s3.submit({ text: "攻坚", workMode: "boost" });
    const body = users(s3)[0]?.payload.workMode?.body ?? "";
    expect(body).toContain("at most 2 background subagents");
    expect(body).toContain("not a git repository");
    expect(body).toContain("use ask_user to ask whether to set that up");
    expect(body).toContain("Delegate by default");
    await s3.close();
  });

  it("并行工作树子代理实现 → 收束唤起 → apply_subagent_changes 并回两份改动", async () => {
    const root = await initGitRepo();
    const childStarted = new Set<string>();
    let parentStep = 0;
    const provider = new FakeProvider({
      handler: (request) => {
        const isChild = request.tools.some((tool) => tool.name === "finish");
        if (isChild) {
          const text = requestText(request);
          const file = text.includes("模块 A") ? "a.txt" : "b.txt";
          if (!childStarted.has(file)) {
            childStarted.add(file);
            return [
              {
                type: "tool_call",
                toolCallId: `cw-${file}`,
                name: "write",
                input: { path: file, content: `${file}-done\n` },
              },
              { type: "finish", reason: "tool_calls" },
            ];
          }
          return [
            {
              type: "tool_call",
              toolCallId: `cf-${file}`,
              name: "finish",
              input: { result: `已写入 ${file}` },
            },
            { type: "finish", reason: "tool_calls" },
          ];
        }
        parentStep += 1;
        if (parentStep === 1) {
          return [
            {
              type: "tool_call",
              toolCallId: "t-a",
              name: "task",
              input: { task: "实现模块 A", background: true, isolation: "worktree" },
            },
            {
              type: "tool_call",
              toolCallId: "t-b",
              name: "task",
              input: { task: "实现模块 B", background: true, isolation: "worktree" },
            },
            { type: "finish", reason: "tool_calls" },
          ];
        }
        if (parentStep === 2) return textScript("已启动两个后台子代理，等待结果。");
        // 子代理结果到达：找出尚未并回的 childSessionId 并回
        const applied = new Set(
          session
            .durableEvents()
            .flatMap((e) =>
              e.type === "tool.completed" &&
              e.payload.name === "apply_subagent_changes" &&
              e.payload.status === "ok"
                ? [(e.payload.output as { id?: string } | undefined)?.id ?? ""]
                : [],
            ),
        );
        const unapplied = session
          .durableEvents()
          .flatMap((e) =>
            e.type === "message.user" &&
            e.payload.subagent?.changes &&
            !applied.has(e.payload.subagent.childSessionId)
              ? [e.payload.subagent.childSessionId]
              : [],
          );
        if (unapplied.length > 0) {
          return [
            ...unapplied.map((id, index) => ({
              type: "tool_call" as const,
              toolCallId: `apply-${parentStep}-${index}`,
              name: "apply_subagent_changes",
              input: { id },
            })),
            { type: "finish" as const, reason: "tool_calls" as const },
          ];
        }
        return textScript("全部并回并验证通过。");
      },
    });
    const runtime = await makeRuntime(provider, {
      cwd: root,
      subagent: { background: true, maxBackground: 3 },
    });
    const session = await runtime.createSession({
      model: "fake/fake-1",
      permissionPreset: "guarded",
    });
    await session.submit({ text: "并行实现 A 和 B", workMode: "boost" });
    const boostBody = users(session)[0]?.payload.workMode?.body ?? "";
    expect(boostBody).toContain('isolation: "worktree"');
    expect(boostBody).toContain("apply_subagent_changes");

    await vi.waitFor(
      () => {
        expect(readFileSync(path.join(root, "a.txt"), "utf8")).toBe("a.txt-done\n");
        expect(readFileSync(path.join(root, "b.txt"), "utf8")).toBe("b.txt-done\n");
      },
      { timeout: 15_000 },
    );
    await session.close();
  }, 25_000);
});

describe("模式消息来源与重发（ADR-0076 §1）", () => {
  it("用户提交的模式消息没有 source；核对、继续目标、批准计划是 runtime", async () => {
    const provider = new FakeProvider({
      scripts: [
        textScript("在做"),
        goalMet("m1"),
        textScript("完成"),
        textScript("接着做"),
        goalMet("m2"),
        textScript("又完成"),
        textScript("# 计划"),
        textScript("实施完"),
      ],
    });
    const runtime = await makeRuntime(provider);
    const session = await runtime.createSession({ model: "fake/fake-1" });
    await session.submit({ text: "修好测试", workMode: "goal" });
    await session.resumeGoal();
    await session.submit({ text: "加功能", workMode: "plan" });
    await session.approvePlan();
    const modes = users(session).map((event) => ({
      name: event.payload.workMode?.name,
      source: event.payload.workMode?.source,
      steer: event.payload.steer,
      user: userWorkMode(event.payload.workMode),
    }));
    expect(modes).toEqual([
      { name: "goal", source: undefined, steer: undefined, user: "goal" },
      { name: "goal", source: "runtime", steer: true, user: undefined },
      { name: "goal", source: "runtime", steer: undefined, user: undefined },
      { name: "goal", source: "runtime", steer: true, user: undefined },
      { name: "plan", source: undefined, steer: undefined, user: "plan" },
      { name: "plan", source: "runtime", steer: undefined, user: undefined },
    ]);
    await session.close();
  });

  it("/rewind 列表与回填：用户模式消息带命令名、不含说明块；Runtime 写入的不回填", async () => {
    const provider = new FakeProvider({
      scripts: [
        textScript("在做"),
        goalMet("m1"),
        textScript("完成"),
        textScript("接着做"),
        goalMet("m2"),
        textScript("又完成"),
        textScript("# 计划"),
        textScript("实施完"),
      ],
    });
    const runtime = await makeRuntime(provider);
    const session = await runtime.createSession({ model: "fake/fake-1" });
    await session.submit({ text: "修好测试\n第二行", workMode: "goal" });
    await session.resumeGoal();
    await session.submit({ text: "加功能", workMode: "plan" });
    await session.approvePlan();
    const rows = (await session.rewindTargets()).map((row) => [row.firstLine, row.text]);
    // 新的在前；核对说明是插话，不是回退目标
    expect(rows).toEqual([
      ["/plan 批准", ""],
      ["/plan 加功能", "/plan 加功能"],
      ["/goal", ""],
      ["/goal 修好测试", "/goal 修好测试\n第二行"],
    ]);
    // 回填的文字按原模式解析
    expect(parseWorkModeSlash(rows[3]?.[1] ?? "")).toEqual({
      kind: "submit",
      workMode: "goal",
      text: "修好测试\n第二行",
    });
    await session.close();
  });

  it("四种模式各重发一次：回退后带原 workMode 提交，照常走模式起始流程", async () => {
    const provider = new FakeProvider({ handler: () => textScript("好") });
    const runtime = await makeRuntime(provider, { subagent: { background: true } });
    const session = await runtime.createSession({
      model: "fake/fake-1",
      permissionPreset: "auto-edit",
    });
    for (const name of ["grill-me", "boost", "plan", "goal"] as const) {
      await session.submit({ text: `任务 ${name}`, workMode: name });
      if (name === "plan") await session.cancelPlan();
      if (name === "goal") await session.stopGoal();
      const target = users(session).findLast(
        (event) => userWorkMode(event.payload.workMode) === name,
      );
      if (target === undefined) throw new Error(`missing ${name}`);
      // 与客户端重发相同：回退到这条消息之前，再以 userWorkMode 提交原文
      await session.rewind(target.seq, "conversation");
      const entry = replaySessionView([...session.durableEvents()]).entries;
      expect(entry.some((item) => item.kind === "user" && item.seq === target.seq)).toBe(false);
      await session.submit({
        text: `任务 ${name}`,
        workMode: userWorkMode(target.payload.workMode),
      });
      // 核对说明是插话；重发的那条是最后一条非插话用户消息
      const resent = users(session).findLast((event) => event.payload.steer !== true);
      expect(resent?.seq).toBeGreaterThan(target.seq);
      expect(resent?.payload.workMode).toMatchObject({ name });
      expect(resent?.payload.workMode?.source).toBeUndefined();
      if (name === "plan") {
        expect(session.state().plan).toEqual({ restorePreset: "auto-edit" });
        expect(session.state().config.permissionPreset).toBe("read-only");
        await session.cancelPlan();
      }
      if (name === "goal") {
        // 回退撤回了目标；重发重新设定并核对，假模型持续无工具时受阻。
        const configs = session
          .durableEvents()
          .filter(
            (e) =>
              e.type === "session.config_changed" &&
              e.seq > target.seq &&
              e.payload.goal?.status === "active",
          );
        expect(configs.length).toBeGreaterThan(0);
        expect(session.state().goal).toMatchObject({ objective: "任务 goal", status: "blocked" });
      }
    }
    await session.close();
  });
});

describe("目标与计划同时存在（ADR-0076 §4.3）", () => {
  const idle = async (session: RuntimeSession, turns: number) => {
    await expect
      .poll(
        () =>
          session.pendingInputs().items.length === 0 &&
          session.durableEvents().filter((e) => e.type === "turn.completed").length === turns,
      )
      .toBe(true);
  };

  it("目标进行中进入计划：计划回复不被核对接管；批准后实施轮照常核对", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const scripts = [
      textScript("# 计划"),
      textScript("实施完"),
      goalMet("g1"),
      textScript("目标完成"),
    ];
    let calls = 0;
    const provider = new FakeProvider({
      handler: async () => {
        calls += 1;
        if (calls === 1) {
          await gate;
          return textScript("在做目标");
        }
        return scripts[calls - 2] ?? textScript("多余");
      },
    });
    const runtime = await makeRuntime(provider);
    const session = await runtime.createSession({
      model: "fake/fake-1",
      permissionPreset: "auto-edit",
    });
    const running = session.submit({ text: "修好测试", workMode: "goal" });
    await expect.poll(() => calls).toBe(1);
    // 目标那一轮进行中排队一条 /plan：安全点 2 让排队先发，之后进入计划模式
    await session.enqueueInput("queue", { text: "加功能", workMode: "plan" });
    release();
    await running;
    await idle(session, 2);
    expect(session.state().goal?.status).toBe("active");
    expect(session.state().plan).toEqual({ restorePreset: "auto-edit" });
    // 计划回复结束后没有核对说明，等用户评论或批准
    expect(goalSteers(session)).toHaveLength(0);
    expect(provider.requests).toHaveLength(2);

    await session.approvePlan();
    expect(session.state().config.permissionPreset).toBe("auto-edit");
    expect(goalSteers(session)).toHaveLength(1);
    expect(session.state().goal?.status).toBe("met");
    await session.close();
  });

  it("计划模式里设定目标：计划期间不续跑；批准后目标照常生效", async () => {
    const provider = new FakeProvider({
      scripts: [
        textScript("# 计划"),
        textScript("# 计划 v2：含目标"),
        textScript("实施完"),
        goalMet("g2"),
        textScript("目标完成"),
      ],
    });
    const runtime = await makeRuntime(provider);
    const session = await runtime.createSession({
      model: "fake/fake-1",
      permissionPreset: "auto-edit",
    });
    await session.submit({ text: "加功能", workMode: "plan" });
    expect(await session.submit({ text: "测试全过", workMode: "goal" })).toBe("done");
    expect(session.state().goal?.status).toBe("active");
    expect(session.state().config.permissionPreset).toBe("read-only");
    expect(goalSteers(session)).toHaveLength(0);
    expect(provider.requests).toHaveLength(2);

    await session.approvePlan();
    expect(goalSteers(session)).toHaveLength(1);
    expect(session.state().goal?.status).toBe("met");
    await session.close();
  });

  it("放弃计划后目标仍是 active：下一条消息照常核对", async () => {
    const provider = new FakeProvider({
      scripts: [
        textScript("# 计划"),
        textScript("# 计划 v2"),
        textScript("在做"),
        goalMet("g3"),
        textScript("目标完成"),
      ],
    });
    const runtime = await makeRuntime(provider);
    const session = await runtime.createSession({ model: "fake/fake-1" });
    await session.submit({ text: "加功能", workMode: "plan" });
    await session.submit({ text: "测试全过", workMode: "goal" });
    await session.cancelPlan();
    expect(goalSteers(session)).toHaveLength(0);
    await session.submit({ text: "开始吧" });
    expect(goalSteers(session)).toHaveLength(1);
    expect(session.state().goal?.status).toBe("met");
    await session.close();
  });
});

describe("回退撤回模式（ADR-0076 §2）", () => {
  it("回退到设定目标的消息：目标停止（rewound）；回退到它之后不受影响；恢复会话一致", async () => {
    const provider = new FakeProvider({ handler: () => textScript("好") });
    const sessionsDir = makeTmp("nct-wm-rw-");
    const cwd = makeTmp("nct-wm-rw-ws-");
    const first = await makeRuntime(provider, { sessionsDir, cwd });
    const session = await first.createSession({ model: "fake/fake-1" });
    // 计划模式里设定目标：目标保持 active 且会话空闲（§4.3 计划期间不续跑）
    await session.submit({ text: "加功能", workMode: "plan" });
    await session.submit({ text: "修好测试", workMode: "goal" });
    await session.submit({ text: "随便说一句" });
    const [, goalMessage, later] = users(session);
    if (goalMessage === undefined || later === undefined) throw new Error("missing messages");
    expect(session.state().goal?.status).toBe("active");

    await session.rewind(later.seq, "conversation");
    expect(session.state().goal?.status).toBe("active");
    expect(workModeOrigins(session.durableEvents()).goal).toBe(goalMessage.seq);

    await session.rewind(goalMessage.seq, "conversation");
    expect(session.state().goal).toMatchObject({ status: "stopped", reason: "rewound" });
    expect(replaySessionView(session.durableEvents()).goal).toMatchObject({
      status: "stopped",
      reason: "rewound",
    });
    // 计划不受目标回退影响
    expect(session.state().plan).toBeDefined();
    // 退出计划后的普通消息不再被核对接管
    await session.cancelPlan();
    const before = provider.requests.length;
    await session.submit({ text: "换个话题" });
    expect(provider.requests.length - before).toBe(1);
    const id = session.id;
    await session.close();

    const second = await makeRuntime(provider, { sessionsDir, cwd });
    const resumed = await second.resumeSession(id);
    expect(resumed.state().goal).toMatchObject({ status: "stopped", reason: "rewound" });
    await resumed.close();
  });

  it("回退到进入计划的消息：恢复原预设并退出；回退到修订消息仍在计划模式", async () => {
    const provider = new FakeProvider({ handler: () => textScript("# 计划") });
    const sessionsDir = makeTmp("nct-wm-rwp-");
    const cwd = makeTmp("nct-wm-rwp-ws-");
    const first = await makeRuntime(provider, { sessionsDir, cwd });
    const session = await first.createSession({
      model: "fake/fake-1",
      permissionPreset: "auto-edit",
    });
    await session.submit({ text: "加功能", workMode: "plan" });
    await session.submit({ text: "改一下", workMode: "plan" });
    const [entered, revised] = users(session);
    if (entered === undefined || revised === undefined) throw new Error("missing messages");

    await session.rewind(revised.seq, "conversation");
    expect(session.state().plan).toEqual({ restorePreset: "auto-edit" });
    expect(session.state().config.permissionPreset).toBe("read-only");

    await session.rewind(entered.seq, "conversation");
    expect(session.state().plan).toBeUndefined();
    expect(session.state().config.permissionPreset).toBe("auto-edit");
    expect(replaySessionView(session.durableEvents()).plan).toBeUndefined();
    await rejects(session.approvePlan(), "invalid_command");
    const id = session.id;
    await session.close();

    const second = await makeRuntime(provider, { sessionsDir, cwd });
    const resumed = await second.resumeSession(id);
    expect(resumed.state().plan).toBeUndefined();
    expect(resumed.state().config.permissionPreset).toBe("auto-edit");
    await resumed.close();
  });

  it("只还原文件不撤回模式", async () => {
    const provider = new FakeProvider({ handler: () => textScript("# 计划") });
    const runtime = await makeRuntime(provider);
    const session = await runtime.createSession({ model: "fake/fake-1" });
    await session.submit({ text: "加功能", workMode: "plan" });
    const entered = users(session)[0];
    if (entered === undefined) throw new Error("missing message");
    await session.rewind(entered.seq, "files");
    expect(session.state().plan).toBeDefined();
    await session.close();
  });
});
