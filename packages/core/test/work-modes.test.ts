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
  parseWorkModeSlash,
  replaySessionView,
  userEntryText,
  workModeDisplayText,
  type DurableEvent,
  type RuntimeEvent,
} from "../src/protocol/index.js";

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
