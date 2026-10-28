/**
 * ADR-0070 待发输入（运行中插话与排队）：安全点消费、排队在 done 后接续、
 * 非 done 结束暂停、编辑/撤回与消费的竞争、快照下发、回退目标与子会话拒绝。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createRuntime,
  type Runtime,
  type RuntimeSession,
  type SubmitInput,
} from "../src/index.js";
import { createPlatform } from "../src/platform/index.js";
import type { FileSystem } from "../src/platform/fs.js";
import { PendingInputs } from "../src/pending-inputs.js";
import { FakeProvider, type FakeScript, type ModelRequest } from "../src/provider/index.js";
import type { RuntimeEvent } from "../src/protocol/index.js";
import { createSessionStore } from "../src/session/index.js";
import { internalSession } from "./internal-session.js";

const tmpRoots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of tmpRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const makeTmp = (prefix: string): string => {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
};

async function makeRuntime(options: {
  scripts?: FakeScript[] | undefined;
  provider?: FakeProvider | undefined;
  maxSteps?: number | undefined;
  retryLimit?: number | undefined;
  turn?: Record<string, unknown> | undefined;
}): Promise<{ runtime: Runtime; provider: FakeProvider; sessionsDir: string }> {
  const provider =
    options.provider ?? new FakeProvider({ scripts: options.scripts ?? [textScript("ok")] });
  const sessionsDir = makeTmp("nct-pi-sd-");
  const runtime = await createRuntime({
    cwd: makeTmp("nct-pi-ws-"),
    sessionsDir,
    providers: [provider],
    interactive: true,
    turn: {
      ...(options.maxSteps !== undefined ? { maxSteps: options.maxSteps } : {}),
      ...(options.retryLimit !== undefined ? { retryLimit: options.retryLimit } : {}),
      ...options.turn,
    },
  });
  return { runtime, provider, sessionsDir };
}

/** 一段文本后正常结束的脚本 */
const textScript = (text: string): FakeScript => [
  { type: "text_delta", text },
  { type: "finish", reason: "stop" },
];

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function expectSentOnce(session: RuntimeSession, events: RuntimeEvent[], texts: string[]) {
  const users = events.filter((event) => event.type === "message.user");
  expect(users.map((event) => messageText(event.payload))).toEqual(texts);
  expect(users.every((event) => event.payload.steer !== true)).toBe(true);
  expect(session.pendingInputs()).toEqual({ items: [], paused: false });
}

/** 调用 ask_user 等待回答：测试用来把 Turn 稳定停在"工具执行中" */
const askScript: FakeScript = [
  {
    type: "tool_call",
    toolCallId: "q1",
    name: "ask_user",
    input: { questions: [{ question: "用哪个方案？" }] },
  },
  { type: "finish", reason: "tool_calls" },
];

function collect(session: RuntimeSession): RuntimeEvent[] {
  const events: RuntimeEvent[] = [];
  session.subscribe((event) => events.push(event));
  return events;
}

const durableTypes = (events: RuntimeEvent[]): string[] =>
  events
    .filter((event): event is Extract<RuntimeEvent, { seq: number }> => "seq" in event)
    .map((event) => event.type);

const messageText = (message: { content: unknown }): string => {
  if (typeof message.content === "string") return message.content;
  return (message.content as { type: string; text?: string }[])
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
};

const requestText = (request: ModelRequest): string =>
  request.messages.map((message) => messageText(message)).join("\n");

/** 待发列表变化事件（快照） */
const pendingSnapshots = (events: RuntimeEvent[]) =>
  events
    .filter((event) => event.type === "input.pending")
    .map((event) => (event.type === "input.pending" ? event.payload : undefined));

const steerMessages = (events: RuntimeEvent[]) =>
  events.filter(
    (event): event is Extract<RuntimeEvent, { seq: number }> & { type: "message.user" } =>
      event.type === "message.user" && event.payload.steer === true,
  );

/** Turn 运行中（ask_user 挂起）时执行动作，动作完成后回答问题放行 */
function onQuestion(session: RuntimeSession, action: () => Promise<void>): void {
  session.subscribe((event) => {
    if (event.type !== "question.requested") return;
    void (async () => {
      await action();
      await session.respondQuestion(event.payload.requestId, {
        answers: [{ selected: [], text: "按你说的" }],
      });
    })();
  });
}

/** Turn 运行中（ask_user 挂起）时执行动作，不回答问题（用于中断场景） */
function onQuestionWithoutAnswer(session: RuntimeSession, action: () => Promise<void>): void {
  session.subscribe((event) => {
    if (event.type !== "question.requested") return;
    void action();
  });
}

async function enqueue(
  session: RuntimeSession,
  mode: "steer" | "queue",
  input: SubmitInput,
): Promise<string> {
  const result = await session.enqueueInput(mode, input);
  expect(result.queued).toBe(true);
  return result.id;
}

describe("ADR-0070 插话（安全点消费）", () => {
  it("工具执行中插话：下一次请求里位于工具结果之后，日志带 steer", async () => {
    const provider = new FakeProvider({
      scripts: [askScript, textScript("收到补充要求")],
    });
    const { runtime } = await makeRuntime({ provider });
    const session = await runtime.createSession({ model: "fake/fake-model" });
    const events = collect(session);
    let steerId = "";
    onQuestion(session, async () => {
      steerId = await enqueue(session, "steer", { text: "改成蓝色主题" });
    });

    expect(await session.submit({ text: "做个页面" })).toBe("done");
    expect(provider.requests).toHaveLength(2);
    const second = provider.requests[1]?.messages ?? [];
    // 末尾是「工具结果 → 插话」
    expect(second.at(-2)?.role).toBe("tool");
    expect(second.at(-1)?.role).toBe("user");
    expect(messageText(second.at(-1) ?? { content: "" })).toContain("改成蓝色主题");

    const types = durableTypes(events);
    const steer = steerMessages(events);
    expect(steer).toHaveLength(1);
    expect(steer[0]?.payload.steer).toBe(true);
    const completedAt = types.lastIndexOf("tool.completed");
    const steerAt = events.findIndex(
      (event) => event.type === "message.user" && event.payload.steer === true,
    );
    expect(completedAt).toBeGreaterThanOrEqual(0);
    expect(steerAt).toBeGreaterThan(events.findIndex((event) => event.type === "tool.completed"));
    // 快照：入队 1 条，消费后清空
    expect(pendingSnapshots(events).map((snapshot) => snapshot?.items.length)).toEqual([1, 0]);
    expect(session.pendingInputs()).toEqual({ items: [], paused: false });
    expect(steerId).not.toBe("");
    await session.close();
  });

  it("纯文本输出中插话：不打断流，stop 后继续下一个 Step", async () => {
    const provider = new FakeProvider({
      scripts: [
        [
          { type: "text_delta", text: "先想一下" },
          { type: "wait", ms: 120 },
          { type: "text_delta", text: "结论如下" },
          { type: "finish", reason: "stop" },
        ],
        textScript("收到"),
      ],
    });
    const { runtime } = await makeRuntime({ provider });
    const session = await runtime.createSession({ model: "fake/fake-model" });
    const events = collect(session);
    let sent = false;
    session.subscribe((event) => {
      if (event.type !== "message.assistant.delta" || sent) return;
      sent = true;
      void session.enqueueInput("steer", { text: "补充：用蓝色" });
    });

    expect(await session.submit({ text: "分析一下" })).toBe("done");
    expect(provider.requests).toHaveLength(2);
    const assist = events.filter(
      (event): event is Extract<RuntimeEvent, { seq: number }> & { type: "message.assistant" } =>
        event.type === "message.assistant",
    );
    // 流没有被打断：第一条助手消息包含两段文字
    expect(JSON.stringify(assist[0]?.payload.content)).toContain("先想一下");
    expect(JSON.stringify(assist[0]?.payload.content)).toContain("结论如下");
    // 第二阶段请求带上插话
    expect(requestText(provider.requests[1] as ModelRequest)).toContain("补充：用蓝色");
    // 同一条 Turn 内：只有一次 turn.started
    expect(durableTypes(events).filter((type) => type === "turn.started")).toHaveLength(1);
    expect(steerMessages(events)).toHaveLength(1);
    await session.close();
  });

  it("多条插话一次取出且顺序正确", async () => {
    const provider = new FakeProvider({
      scripts: [askScript, textScript("都收到了")],
    });
    const { runtime } = await makeRuntime({ provider });
    const session = await runtime.createSession({ model: "fake/fake-model" });
    const events = collect(session);
    onQuestion(session, async () => {
      await enqueue(session, "steer", { text: "第一条：用蓝色" });
      await enqueue(session, "steer", { text: "第二条：字号大一点" });
    });

    expect(await session.submit({ text: "做个页面" })).toBe("done");
    const texts = steerMessages(events).map((event) =>
      event.payload.content
        .filter((block) => block.type === "text")
        .map((block) => (block.type === "text" ? block.text : ""))
        .join(""),
    );
    expect(texts).toEqual(["第一条：用蓝色", "第二条：字号大一点"]);
    const second = provider.requests[1]?.messages ?? [];
    expect(messageText(second.at(-2) ?? { content: "" })).toContain("第一条");
    expect(messageText(second.at(-1) ?? { content: "" })).toContain("第二条");
    await session.close();
  });
});

describe("ADR-0070 编辑与撤回", () => {
  it("编辑多块正文保留 reasoning、@ 引用快照，且重复编辑只替换正文文本", async () => {
    const { runtime } = await makeRuntime({ scripts: [askScript, textScript("好")] });
    const session = await runtime.createSession({ model: "fake/fake-model" });
    const events = collect(session);
    const fs = createPlatform().fs;
    await fs.writeFile(path.join(session.state().meta.cwd, "reference.txt"), "引用原始快照");
    onQuestion(session, async () => {
      const id = await enqueue(session, "steer", {
        content: [
          { type: "reasoning", text: "保留的非文本块", providerData: { signature: "saved" } },
          { type: "text", text: "原正文 @reference.txt" },
          { type: "text", text: "第二段正文" },
        ],
      });
      await fs.writeFile(path.join(session.state().meta.cwd, "reference.txt"), "引用已经改变");
      await session.updateInput(id, { input: { text: "第一次编辑" } });
      await session.updateInput(id, { input: { text: "最终正文" } });
    });
    expect(await session.submit({ text: "开始" })).toBe("done");
    const content = steerMessages(events)[0]?.payload.content;
    expect(content?.slice(0, 2)).toEqual([
      { type: "reasoning", text: "保留的非文本块", providerData: { signature: "saved" } },
      { type: "text", text: "最终正文" },
    ]);
    expect(JSON.stringify(content)).toContain("引用原始快照");
    expect(JSON.stringify(content)).not.toContain("引用已经改变");
    expect(JSON.stringify(content)).not.toContain("第二段正文");
    expect(session.pendingInputs().items).toHaveLength(0);
    await session.close();
  });

  it("消费前编辑生效：发出的是新内容", async () => {
    const provider = new FakeProvider({ scripts: [askScript, textScript("好")] });
    const { runtime } = await makeRuntime({ provider });
    const session = await runtime.createSession({ model: "fake/fake-model" });
    const events = collect(session);
    onQuestion(session, async () => {
      const id = await enqueue(session, "steer", { text: "改成蓝色" });
      await session.updateInput(id, { input: { text: "改成绿色" } });
      // 切换成排队再切回插话：模式可改
      await session.updateInput(id, { mode: "queue" });
      await session.updateInput(id, { mode: "steer" });
    });

    expect(await session.submit({ text: "做个页面" })).toBe("done");
    const texts = steerMessages(events).map((event) => JSON.stringify(event.payload.content));
    expect(texts.join("\n")).toContain("改成绿色");
    expect(texts.join("\n")).not.toContain("改成蓝色");
    await session.close();
  });

  it("消费后编辑或撤回返回 input_consumed", async () => {
    const provider = new FakeProvider({ scripts: [askScript, textScript("好")] });
    const { runtime } = await makeRuntime({ provider });
    const session = await runtime.createSession({ model: "fake/fake-model" });
    const ids: string[] = [];
    onQuestion(session, async () => {
      ids.push(await enqueue(session, "steer", { text: "改成蓝色" }));
    });

    expect(await session.submit({ text: "做个页面" })).toBe("done");
    const id = ids[0] as string;
    await expect(session.updateInput(id, { input: { text: "太晚了" } })).rejects.toMatchObject({
      code: "input_consumed",
    });
    await expect(session.cancelInput(id)).rejects.toMatchObject({ code: "input_consumed" });
    await session.close();
  });

  it("撤回后不会发出", async () => {
    const provider = new FakeProvider({ scripts: [askScript, textScript("好")] });
    const { runtime } = await makeRuntime({ provider });
    const session = await runtime.createSession({ model: "fake/fake-model" });
    const events = collect(session);
    onQuestion(session, async () => {
      const id = await enqueue(session, "steer", { text: "不要这条" });
      await session.cancelInput(id);
    });

    expect(await session.submit({ text: "做个页面" })).toBe("done");
    expect(steerMessages(events)).toHaveLength(0);
    expect(requestText(provider.requests[1] as ModelRequest)).not.toContain("不要这条");
    await session.close();
  });
});

describe("ADR-0070 排队", () => {
  it.each(["update", "resume"] as const)("空闲时 %s 会发出未暂停的残留插话", async (action) => {
    const { runtime, provider } = await makeRuntime({
      scripts: [textScript("好"), textScript("已发出")],
    });
    const session = await runtime.createSession({ model: "fake/fake-model" });
    const events = collect(session);
    const take = PendingInputs.prototype.takeQueueHead;
    let add: PendingInputs["add"] | undefined;
    vi.spyOn(PendingInputs.prototype, "takeQueueHead").mockImplementation(function (
      this: PendingInputs,
    ) {
      add = this.add.bind(this);
      return take.call(this);
    });
    expect(await session.submit({ text: "开始" })).toBe("done");
    if (add === undefined) throw new Error("未捕获待发列表");
    // 模拟没有 Turn 消费的遗留条目；通过公开命令验证空闲恢复路径。
    const id = add("steer", { content: [{ type: "text", text: "残留插话" }], appended: [] });
    if (action === "update") await session.updateInput(id, { mode: "steer" });
    else await session.resumeInputs();
    expectSentOnce(session, events, ["开始", "残留插话"]);
    expect(provider.requests).toHaveLength(2);
    await session.close();
  });

  it("最后安全点之后、turn.completed 日志写入期间的插话按顺序开新 Turn", async () => {
    const { runtime } = await makeRuntime({
      provider: new FakeProvider({ handler: () => textScript("好") }),
    });
    const session = await runtime.createSession({ model: "fake/fake-model" });
    const events = collect(session);
    const writing = deferred();
    const release = deferred();
    const fs = (internalSession(session) as unknown as { fs: FileSystem }).fs;
    const append = fs.appendFile.bind(fs);
    let held = false;
    vi.spyOn(fs, "appendFile").mockImplementation(async (file, data, options) => {
      if (!held && data.includes('"type":"turn.completed"')) {
        held = true;
        writing.resolve();
        await release.promise;
      }
      await append(file, data, options);
    });
    const submitting = session.submit({ text: "开始" });
    await writing.promise;
    await enqueue(session, "queue", { text: "先排队" });
    await enqueue(session, "steer", { text: "错过安全点的插话" });
    await enqueue(session, "queue", { text: "后排队" });
    release.resolve();
    expect(await submitting).toBe("done");
    expectSentOnce(session, events, ["开始", "先排队", "错过安全点的插话", "后排队"]);
    await session.close();
  });

  it.each(["steer", "queue"] as const)(
    "队首检查已空、循环清理时提交 %s 仍发出一次",
    async (mode) => {
      const modelStarted = deferred();
      const releaseModel = deferred();
      const provider = new FakeProvider({
        handler: async (_request, index) => {
          if (index === 0) {
            modelStarted.resolve();
            await releaseModel.promise;
          }
          return textScript("好");
        },
      });
      const { runtime } = await makeRuntime({ provider });
      const session = await runtime.createSession({ model: "fake/fake-model" });
      const events = collect(session);
      const take = PendingInputs.prototype.takeQueueHead;
      let inserted = false;
      vi.spyOn(PendingInputs.prototype, "takeQueueHead").mockImplementation(function (
        this: PendingInputs,
      ) {
        const head = take.call(this);
        if (head === undefined && !inserted) {
          inserted = true;
          // 精确停在最后一次空检查之后，模拟 enqueueInput 已完成准备并入列。
          // 同步注入避免文件引用准备的微任务时序把输入推迟到空闲直发路径。
          this.add(mode, { content: [{ type: "text", text: "收尾窗口输入" }], appended: [] });
        }
        return head;
      });
      const submitting = session.submit({ text: "开始" });
      await modelStarted.promise;
      releaseModel.resolve();
      expect(await submitting).toBe("done");
      expect(inserted).toBe(true);
      expectSentOnce(session, events, ["开始", "收尾窗口输入"]);
      expect(provider.requests).toHaveLength(2);
      await session.close();
    },
  );

  it("done 后取队首一条开新 Turn，逐条发完", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const provider = new FakeProvider({
      handler: async (_request, index) => {
        if (index === 0) {
          // 第一个 Turn 卡住一下，好在此期间入列两条排队输入
          await new Promise((resolve) => setTimeout(resolve, 60));
        }
        return textScript(index === 0 ? "第一条回复" : "继续");
      },
    });
    const { runtime } = await makeRuntime({ provider });
    const session = await runtime.createSession({ model: "fake/fake-model" });
    let queued = false;
    session.subscribe((event) => {
      if (event.type !== "message.assistant.delta" || queued) return;
      queued = true;
      void (async () => {
        await enqueue(session, "queue", { text: "第二条消息" });
        await enqueue(session, "queue", { text: "第三条消息" });
        release();
      })();
    });

    expect(await session.submit({ text: "第一条消息" })).toBe("done");
    await gate;
    expect(provider.requests).toHaveLength(3);
    expect(requestText(provider.requests[1] as ModelRequest)).toContain("第二条消息");
    expect(requestText(provider.requests[1] as ModelRequest)).not.toContain("第三条消息");
    expect(requestText(provider.requests[2] as ModelRequest)).toContain("第三条消息");
    expect(session.pendingInputs()).toEqual({ items: [], paused: false });
    const users = session
      .state()
      .history.filter((entry) => entry.kind === "user")
      .map((entry) => (entry.kind === "user" ? entry.messageId : ""));
    expect(users).toHaveLength(3);
    await session.close();
  });

  it("空闲时 enqueue 直接开始 Turn，返回 queued=false", async () => {
    const provider = new FakeProvider({ scripts: [textScript("直接开始")] });
    const { runtime } = await makeRuntime({ provider });
    const session = await runtime.createSession({ model: "fake/fake-model" });
    const events = collect(session);
    const result = await session.enqueueInput("steer", { text: "现在就开始" });
    expect(result.queued).toBe(false);
    expect(provider.requests).toHaveLength(1);
    expect(requestText(provider.requests[0] as ModelRequest)).toContain("现在就开始");
    expect(session.pendingInputs()).toEqual({ items: [], paused: false });
    // 直接开始的那条不是插话
    expect(steerMessages(events)).toHaveLength(0);
    await session.close();
  });
});

describe("ADR-0070 非 done 结束：转排队并暂停", () => {
  it("空闲时将暂停条目改为插话再恢复，按普通消息发出且仅一次", async () => {
    const { runtime, provider } = await makeRuntime({ scripts: [askScript, textScript("恢复")] });
    const session = await runtime.createSession({ model: "fake/fake-model" });
    const events = collect(session);
    let id = "";
    onQuestionWithoutAnswer(session, async () => {
      id = await enqueue(session, "queue", { text: "暂停后改插话" });
      session.interrupt();
    });
    expect(await session.submit({ text: "开始" })).toBe("aborted");
    await session.updateInput(id, { mode: "steer" });
    expect(session.pendingInputs().items[0]).toMatchObject({ mode: "steer", paused: true });
    expect(provider.requests).toHaveLength(1);
    await session.resumeInputs();
    await session.resumeInputs();
    expectSentOnce(session, events, ["开始", "暂停后改插话"]);
    expect(provider.requests).toHaveLength(2);
    await session.close();
  });

  it("中断后全部转排队并暂停，不自动发送；resumeInputs 从队首恢复", async () => {
    const provider = new FakeProvider({
      scripts: [askScript, textScript("恢复后继续"), textScript("第二条排队")],
    });
    const { runtime } = await makeRuntime({ provider });
    const session = await runtime.createSession({ model: "fake/fake-model" });
    const events = collect(session);
    onQuestionWithoutAnswer(session, async () => {
      await enqueue(session, "steer", { text: "插话 A" });
      await enqueue(session, "queue", { text: "排队 B" });
      session.interrupt();
    });

    expect(await session.submit({ text: "开始" })).toBe("aborted");
    const paused = session.pendingInputs();
    expect(paused.paused).toBe(true);
    expect(paused.items.map((item) => item.mode)).toEqual(["queue", "queue"]);
    expect(provider.requests).toHaveLength(1);

    await session.resumeInputs();
    expect(provider.requests).toHaveLength(3);
    const users = session
      .state()
      .history.filter((entry) => entry.kind === "user")
      .map((entry) => JSON.stringify(entry.kind === "user" ? entry.content : ""));
    expect(users[1]).toContain("插话 A");
    expect(users[2]).toContain("排队 B");
    expect(session.pendingInputs()).toEqual({ items: [], paused: false });
    expect(pendingSnapshots(events).at(-1)).toEqual({ items: [], paused: false });
    await session.close();
  });

  it("max_steps 后暂停；暂停中提交追加到队尾并恢复", async () => {
    const provider = new FakeProvider({
      scripts: [askScript, textScript("恢复"), textScript("第二条"), textScript("第三条")],
    });
    const { runtime } = await makeRuntime({ provider, maxSteps: 1 });
    const session = await runtime.createSession({ model: "fake/fake-model" });
    onQuestion(session, async () => {
      await enqueue(session, "queue", { text: "第一条待发" });
      await enqueue(session, "queue", { text: "第二条待发" });
    });

    expect(await session.submit({ text: "开始" })).toBe("max_steps");
    expect(session.pendingInputs().paused).toBe(true);
    expect(provider.requests).toHaveLength(1);

    // 暂停中提交 = 追加到队尾并恢复；空闲时队首先发出
    const result = await session.enqueueInput("steer", { text: "第三条待发" });
    expect(result.queued).toBe(true);
    await expect.poll(() => session.pendingInputs().items.length).toBe(0);
    const users = session
      .state()
      .history.filter((entry) => entry.kind === "user")
      .map((entry) => JSON.stringify(entry.kind === "user" ? entry.content : ""));
    expect(users[1]).toContain("第一条待发");
    expect(users[2]).toContain("第二条待发");
    expect(users[3]).toContain("第三条待发");
    await session.close();
  });

  it("错误结束同样转排队并暂停", async () => {
    const provider = new FakeProvider({
      handler: (_request, index) => {
        if (index === 0) return askScript;
        if (index === 1) return [{ type: "throw", error: new Error("provider down") }];
        return textScript("恢复后");
      },
    });
    const { runtime } = await makeRuntime({ provider, retryLimit: 0 });
    const session = await runtime.createSession({ model: "fake/fake-model" });
    onQuestion(session, async () => {
      await enqueue(session, "queue", { text: "错误后的排队" });
    });

    expect(await session.submit({ text: "开始" })).toBe("error");
    expect(session.pendingInputs().paused).toBe(true);
    expect(session.pendingInputs().items).toHaveLength(1);
    expect(provider.requests).toHaveLength(2);

    await session.resumeInputs();
    expect(provider.requests).toHaveLength(3);
    expect(requestText(provider.requests[2] as ModelRequest)).toContain("错误后的排队");
    expect(session.pendingInputs()).toEqual({ items: [], paused: false });
    await session.close();
  });
});

describe("ADR-0070 快照、回退与子会话", () => {
  it("运行中入列后 pendingInputs() 与最后一份快照一致（新附加客户端对齐用）", async () => {
    const provider = new FakeProvider({ scripts: [askScript, textScript("好")] });
    const { runtime } = await makeRuntime({ provider });
    const session = await runtime.createSession({ model: "fake/fake-model" });
    const events = collect(session);
    let during: ReturnType<RuntimeSession["pendingInputs"]> | undefined;
    onQuestion(session, async () => {
      await enqueue(session, "steer", { text: "在运行中的插话" });
      during = session.pendingInputs();
    });

    expect(await session.submit({ text: "做个页面" })).toBe("done");
    expect(during?.items).toHaveLength(1);
    expect(during?.items[0]?.mode).toBe("steer");
    const snapshots = pendingSnapshots(events);
    // 入列的那份快照与 pendingInputs() 同形（除时间外逐字段一致）
    expect(snapshots[0]?.items.map((item) => item.text)).toEqual(["在运行中的插话"]);
    expect(snapshots[0]?.paused).toBe(false);
    await session.close();
  });

  it("回退目标不含插话，且不能回退到插话", async () => {
    const provider = new FakeProvider({ scripts: [askScript, textScript("好")] });
    const { runtime } = await makeRuntime({ provider });
    const session = await runtime.createSession({ model: "fake/fake-model" });
    const events = collect(session);
    onQuestion(session, async () => {
      await enqueue(session, "steer", { text: "插话" });
    });

    expect(await session.submit({ text: "原始请求" })).toBe("done");
    const targets = await session.rewindTargets();
    expect(targets).toHaveLength(1);
    expect(targets[0]?.text).toContain("原始请求");
    const steerSeq = steerMessages(events)[0]?.seq as number;
    expect(targets.some((target) => target.seq === steerSeq)).toBe(false);
    await expect(session.rewind(steerSeq, "conversation")).rejects.toMatchObject({
      code: "invalid_command",
    });
    await session.close();
  });

  it("子会话拒绝待发输入（invalid_command）", async () => {
    const provider = new FakeProvider({ scripts: [textScript("好")] });
    const { runtime, sessionsDir } = await makeRuntime({ provider });
    const parent = await runtime.createSession({ model: "fake/fake-model" });
    const child = await createSessionStore({
      platform: createPlatform(),
      sessionsDir,
    }).create({
      cwd: parent.state().meta.cwd,
      workspaceRoot: parent.state().meta.workspaceRoot,
      model: { provider: "fake", model: "fake-model" },
      permissionPreset: "default",
      nocturneVersion: "0.0.0-test",
      parent: { sessionId: parent.id, callId: "child-call" },
    });
    await child.close();
    const childSession = await runtime.resumeSession(child.id);
    await expect(childSession.enqueueInput("steer", { text: "不行" })).rejects.toMatchObject({
      code: "invalid_command",
    });
    await expect(childSession.resumeInputs()).rejects.toMatchObject({
      code: "invalid_command",
    });
    expect(childSession.pendingInputs()).toEqual({ items: [], paused: false });
    await childSession.close();
    await parent.close();
  });
});
