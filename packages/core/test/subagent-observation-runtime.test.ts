/**
 * 子会话只读观察 × 真实 Runtime（rpc.md 4.1）：launcher 登记、催促轮不提前结束、
 * 嵌套与多会话共享登记簿、重启后只读快照。全部经 FakeProvider 脚本化，不触网。
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createRuntime, type Runtime, type RuntimeSession } from "../src/index.js";
import { FakeProvider, type FakeScript, type ModelRequest } from "../src/provider/index.js";
import type {
  RuntimeEvent,
  SubagentObservation,
  SubagentReadEnd,
  SubagentSummary,
} from "../src/protocol/index.js";

const tmpRoots: string[] = [];
afterEach(() => {
  for (const root of tmpRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const tmp = (prefix: string): string => {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
};

const isChild = (req: ModelRequest) => req.tools.some((tool) => tool.name === "finish");
const isNested = (req: ModelRequest) =>
  isChild(req) && req.tools.some((tool) => tool.name === "task");
const done: FakeScript = [
  { type: "text_delta", text: "没有提交" },
  { type: "finish", reason: "stop" },
];
const finishScript = (result = "ok"): FakeScript => [
  { type: "tool_call", toolCallId: `f-${result}`, name: "finish", input: { result } },
  { type: "finish", reason: "tool_calls" },
];
const taskScript = (input: Record<string, unknown>, id = "task-1"): FakeScript => [
  { type: "tool_call", toolCallId: id, name: "task", input },
  { type: "finish", reason: "tool_calls" },
];

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** 请求里第一条用户文本（子会话是任务原文，父会话是 submit 的文本） */
const userText = (req: ModelRequest): string => {
  const first = req.messages.find((m) => m.role === "user");
  const content = first?.content;
  if (typeof content === "string") return content;
  return content?.find((block) => block.type === "text")?.text ?? "";
};

async function makeRuntime(
  handler: (req: ModelRequest, index: number) => FakeScript | Promise<FakeScript>,
  options: {
    sessionsDir?: string;
    subagent?: { maxDepth?: number; maxConcurrent?: number; maxAttempts?: number };
  } = {},
) {
  const ws = tmp("nct-obsrt-ws-");
  const sessionsDir = options.sessionsDir ?? tmp("nct-obsrt-sess-");
  const runtime = await createRuntime({
    cwd: ws,
    sessionsDir,
    providers: [new FakeProvider({ handler })],
    permissions: { autoApproveAsk: true },
    ...(options.subagent !== undefined ? { subagent: options.subagent } : {}),
  });
  return { runtime, ws, sessionsDir };
}

const until = async (check: () => boolean | Promise<boolean>, label: string): Promise<void> => {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > 10_000) throw new Error(`等待超时：${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

function observer() {
  const events: RuntimeEvent[] = [];
  const ends: SubagentReadEnd[] = [];
  const marks: { event: RuntimeEvent; endsSoFar: number }[] = [];
  return {
    events,
    ends,
    marks,
    callbacks: {
      onEvent: (event: RuntimeEvent) => {
        events.push(event);
        marks.push({ event, endsSoFar: ends.length });
      },
      onEnd: (end: SubagentReadEnd) => {
        ends.push(end);
      },
    },
  };
}

const durable = (events: RuntimeEvent[]) =>
  events.flatMap((event) => ("seq" in event ? [event.seq] : []));

async function runningChild(runtime: Runtime, parent: RuntimeSession): Promise<SubagentSummary> {
  let found: SubagentSummary | undefined;
  await until(async () => {
    found = (await runtime.listSubagents({ parentSessionId: parent.id })).find(
      (summary) => summary.state === "running",
    );
    return found !== undefined;
  }, "子会话进入 running");
  if (found === undefined) throw new Error("unreachable");
  return found;
}

const taskCompleted = (session: RuntimeSession) =>
  session.durableEvents().findLast((e) => e.type === "tool.completed" && e.payload.name === "task");

describe("运行中的子会话", () => {
  it("list 能在父 task 结算前找到 child；observe 接前缀与实时，launcher 收尾后自然结束", async () => {
    const hold = gate();
    const { runtime, sessionsDir } = await makeRuntime(async (req) => {
      if (isChild(req)) {
        await hold.promise;
        return finishScript("子结果");
      }
      return req.messages.at(-1)?.role === "tool"
        ? done
        : taskScript({ task: "整理\n   日志文件" });
    });
    const session = await runtime.createSession({ model: "fake/fake-1" });
    const submitting = session.submit({ text: "go" });

    const child = await runningChild(runtime, session);
    expect(child).toMatchObject({
      parentSessionId: session.id,
      state: "running",
      profile: "default",
      taskSummary: "整理 日志文件",
    });
    const started = session
      .durableEvents()
      .find((e) => e.type === "tool.started" && e.payload.name === "task");
    expect(started?.type === "tool.started" && child.callId === started.payload.callId).toBe(true);
    expect(child.endedAt).toBeUndefined();
    // 父 task 还没有 tool.completed：映射来自登记簿与子日志，不靠父工具输出
    expect(taskCompleted(session)).toBeUndefined();

    const files = readdirSync(sessionsDir).sort();
    const obs = observer();
    const observation = await runtime.observeSubagent(
      { parentSessionId: session.id, childSessionId: child.childSessionId },
      obs.callbacks,
    );
    expect(observation.mode).toBe("live");
    expect(observation.summary.state).toBe("running");
    expect(obs.events.length).toBeGreaterThan(0);
    // 观察没有新建任何文件，child 的锁仍由 launcher 持有
    expect(readdirSync(sessionsDir).sort()).toEqual(files);
    expect(existsSync(path.join(sessionsDir, `${child.childSessionId}.lock`))).toBe(true);

    hold.open();
    await expect(submitting).resolves.toBe("done");
    expect(obs.ends).toHaveLength(1);
    expect(obs.ends[0]?.source).toBe("launcher");
    expect(obs.ends[0]?.summary.state).toBe("ended");
    expect(obs.marks.at(-1)?.endsSoFar).toBe(0);
    // 与子日志逐条一致，临时事件（如流式增量）也交付过
    const log = readFileSync(path.join(sessionsDir, `${child.childSessionId}.jsonl`), "utf8")
      .trimEnd()
      .split("\n")
      .map((line) => (JSON.parse(line) as { seq: number }).seq);
    expect(durable(obs.events)).toEqual(log);
    expect(obs.events.some((e) => e.type === "message.assistant.delta")).toBe(false);
    expect(obs.events.some((e) => e.type === "tool.completed" && e.payload.name === "finish")).toBe(
      true,
    );
    expect(existsSync(path.join(sessionsDir, `${child.childSessionId}.lock`))).toBe(false);

    // 父结算之后：list 回到日志映射，outcome 与耗时取父的持久结算
    const completed = taskCompleted(session);
    const [after] = await runtime.listSubagents({ parentSessionId: session.id });
    expect(after).toMatchObject({
      childSessionId: child.childSessionId,
      state: "ended",
      outcome: { status: "ok" },
      durationMs: completed?.type === "tool.completed" ? completed.payload.durationMs : -1,
    });
    expect(after?.durationApproximate).toBeUndefined();
    await session.close();
  });

  it("催促轮：第一轮 turn.completed(done) 之后观察不结束，finish 之后才自然结束", async () => {
    let childCalls = 0;
    const { runtime } = await makeRuntime((req) => {
      if (isChild(req)) {
        childCalls += 1;
        return childCalls === 1 ? done : finishScript("催促后提交");
      }
      return req.messages.at(-1)?.role === "tool" ? done : taskScript({ task: "要催促的任务" });
    });
    const session = await runtime.createSession({ model: "fake/fake-1" });
    const obs = observer();
    let observation: SubagentObservation | undefined;
    // 子会话创建（session.created 提交）之后立刻接上
    const submitting = session.submit({ text: "go" });
    const child = await runningChild(runtime, session).catch(() => undefined);
    if (child !== undefined) {
      observation = await runtime.observeSubagent(
        { parentSessionId: session.id, childSessionId: child.childSessionId },
        obs.callbacks,
      );
    }
    await submitting;
    const [summary] = await runtime.listSubagents({ parentSessionId: session.id });
    expect(summary?.state).toBe("ended");
    if (child === undefined) throw new Error("没有观察到运行中的 child");
    expect(observation?.mode).toBe("live");
    const turnDone = obs.marks.filter(
      (m) => m.event.type === "turn.completed" && m.event.payload.reason === "done",
    );
    expect(turnDone).toHaveLength(2);
    // 第一个 turn.completed(done) 时观察仍然存活
    expect(turnDone[0]?.endsSoFar).toBe(0);
    expect(obs.ends).toHaveLength(1);
    const finishIndex = obs.events.findIndex(
      (e) => e.type === "tool.completed" && e.payload.name === "finish",
    );
    const firstDoneIndex = obs.events.findIndex((e) => e.type === "turn.completed");
    expect(finishIndex).toBeGreaterThan(firstDoneIndex);
    expect(childCalls).toBe(2);
    await session.close();
  });

  it("全部催促轮都没有 finish：自然结束，状态 ended，父结算为失败 outcome", async () => {
    const { runtime } = await makeRuntime(
      (req) =>
        isChild(req)
          ? done
          : req.messages.at(-1)?.role === "tool"
            ? done
            : taskScript({ task: "不提交的任务" }),
      { subagent: { maxAttempts: 2 } },
    );
    const session = await runtime.createSession({ model: "fake/fake-1" });
    await session.submit({ text: "go" });
    const [summary] = await runtime.listSubagents({ parentSessionId: session.id });
    expect(summary).toMatchObject({
      state: "ended",
      outcome: { status: "error", error: { code: "subagent_no_result" } },
    });
    const obs = observer();
    const observation = await runtime.observeSubagent(
      { parentSessionId: session.id, childSessionId: summary?.childSessionId ?? "" },
      obs.callbacks,
    );
    expect(observation.mode).toBe("snapshot");
    expect(obs.events.filter((e) => e.type === "turn.completed")).toHaveLength(2);
    expect(obs.ends[0]?.summary.outcome?.status).toBe("error");
    await session.close();
  });

  it("观察者抛错、退订与断开都不影响 child 的运行、锁、并发槽与结果", async () => {
    const hold = gate();
    const { runtime, sessionsDir } = await makeRuntime(
      async (req) => {
        if (isChild(req)) {
          await hold.promise;
          return finishScript("还是成功了");
        }
        return req.messages.at(-1)?.role === "tool" ? done : taskScript({ task: "被观察的任务" });
      },
      { subagent: { maxConcurrent: 1 } },
    );
    const session = await runtime.createSession({ model: "fake/fake-1" });
    const submitting = session.submit({ text: "go" });
    const child = await runningChild(runtime, session);
    const calls = { events: 0, ends: 0 };
    const observation = await runtime.observeSubagent(
      { parentSessionId: session.id, childSessionId: child.childSessionId },
      {
        onEvent: () => {
          calls.events += 1;
          throw new Error("观察者的错误");
        },
        onEnd: () => {
          calls.ends += 1;
          throw new Error("观察者的错误");
        },
      },
    );
    observation.unsubscribe();
    observation.unsubscribe();
    const second = observer();
    await runtime.observeSubagent(
      { parentSessionId: session.id, childSessionId: child.childSessionId },
      second.callbacks,
    );
    hold.open();
    await expect(submitting).resolves.toBe("done");
    const completed = taskCompleted(session);
    expect(completed?.type === "tool.completed" && completed.payload.status).toBe("ok");
    expect(calls.ends).toBe(0);
    expect(second.ends).toHaveLength(1);
    expect(existsSync(path.join(sessionsDir, `${child.childSessionId}.lock`))).toBe(false);
    // 并发槽已归还：maxConcurrent=1 下还能再派一个
    const again = await runtime.createSession({ model: "fake/fake-1" });
    hold.open();
    await expect(again.submit({ text: "go" })).resolves.toBe("done");
    const retry = again
      .durableEvents()
      .findLast((e) => e.type === "tool.completed" && e.payload.name === "task");
    expect(retry?.type === "tool.completed" && retry.payload.status).toBe("ok");
    await session.close();
    await again.close();
  });

  it("launcher 失败路径同样清理登记簿与并发槽", async () => {
    const { runtime } = await makeRuntime(
      (req) =>
        isChild(req)
          ? finishScript()
          : req.messages.at(-1)?.role === "tool"
            ? done
            : taskScript({ task: "t", tools: ["不存在的工具"] }),
      { subagent: { maxConcurrent: 1 } },
    );
    const session = await runtime.createSession({ model: "fake/fake-1" });
    await session.submit({ text: "go" });
    const completed = taskCompleted(session);
    expect(completed?.type === "tool.completed" && completed.payload.error?.code).toBe(
      "invalid_input",
    );
    // child 已创建后才失败：日志存在，没有 Turn，父已结算 → ended；登记项已移除 → 快照
    const [summary] = await runtime.listSubagents({ parentSessionId: session.id });
    expect(summary).toMatchObject({ state: "ended", outcome: { status: "error" } });
    const obs = observer();
    const observation = await runtime.observeSubagent(
      { parentSessionId: session.id, childSessionId: summary?.childSessionId ?? "" },
      obs.callbacks,
    );
    expect(observation.mode).toBe("snapshot");
    await session.close();
  });
});

describe("全 Runtime 共享登记簿", () => {
  it("嵌套：孙会话经 child 作为 parent 观察；顶层概览只列直接子级", async () => {
    const holdGrand = gate();
    const { runtime } = await makeRuntime(
      async (req) => {
        if (isNested(req)) {
          return req.messages.at(-1)?.role === "tool"
            ? finishScript("孙子完成")
            : taskScript({ task: "孙任务" }, "task-g");
        }
        if (isChild(req)) {
          await holdGrand.promise;
          return finishScript("孙结果");
        }
        return req.messages.at(-1)?.role === "tool" ? done : taskScript({ task: "子任务" });
      },
      { subagent: { maxDepth: 2 } },
    );
    const session = await runtime.createSession({ model: "fake/fake-1" });
    const submitting = session.submit({ text: "go" });
    const child = await runningChild(runtime, session);
    const grand = await runningChild(runtime, {
      id: child.childSessionId,
    } as unknown as RuntimeSession);
    expect(grand.parentSessionId).toBe(child.childSessionId);
    expect(grand.taskSummary).toBe("孙任务");
    const top = await runtime.listSubagents({ parentSessionId: session.id });
    expect(top.map((s) => s.childSessionId)).toEqual([child.childSessionId]);

    const obs = observer();
    const observation = await runtime.observeSubagent(
      { parentSessionId: child.childSessionId, childSessionId: grand.childSessionId },
      obs.callbacks,
    );
    expect(observation.mode).toBe("live");
    // 把孙当作顶层 child 观察属于关系不符
    await expect(
      runtime.observeSubagent(
        { parentSessionId: session.id, childSessionId: grand.childSessionId },
        observer().callbacks,
      ),
    ).rejects.toMatchObject({ code: "subagent_parent_mismatch" });
    holdGrand.open();
    await expect(submitting).resolves.toBe("done");
    expect(obs.ends).toHaveLength(1);
    expect(obs.ends[0]?.summary.childSessionId).toBe(grand.childSessionId);
    await session.close();
  });

  it("两个会话并发派发：各自只看到自己的 child，互相观察报关系不符", async () => {
    const hold = gate();
    const { runtime } = await makeRuntime(async (req) => {
      if (isChild(req)) {
        await hold.promise;
        return finishScript(userText(req));
      }
      return req.messages.at(-1)?.role === "tool"
        ? done
        : taskScript({ task: `任务-${userText(req)}` });
    });
    const a = await runtime.createSession({ model: "fake/fake-1" });
    const b = await runtime.createSession({ model: "fake/fake-1" });
    const submitA = a.submit({ text: "A" });
    const submitB = b.submit({ text: "B" });
    const childA = await runningChild(runtime, a);
    const childB = await runningChild(runtime, b);
    expect(childA.taskSummary).toBe("任务-A");
    expect(childB.taskSummary).toBe("任务-B");
    expect(childA.childSessionId).not.toBe(childB.childSessionId);
    await expect(
      runtime.observeSubagent(
        { parentSessionId: a.id, childSessionId: childB.childSessionId },
        observer().callbacks,
      ),
    ).rejects.toMatchObject({ code: "subagent_parent_mismatch" });
    hold.open();
    await Promise.all([submitA, submitB]);
    await a.close();
    await b.close();
  });
});

describe("重启后（新 Runtime、同一目录）", () => {
  it("只读快照：映射、状态与事件取自日志，不复活、不写、不取锁", async () => {
    const sessionsDir = tmp("nct-obsrt-restart-");
    const first = await makeRuntime(
      (req) =>
        isChild(req)
          ? finishScript("历史结果")
          : req.messages.at(-1)?.role === "tool"
            ? done
            : taskScript({ task: "历史任务" }),
      { sessionsDir },
    );
    const session = await first.runtime.createSession({ model: "fake/fake-1" });
    await session.submit({ text: "go" });
    const sessionId = session.id;
    await session.close();

    const second = await makeRuntime(() => done, { sessionsDir });
    const files = readdirSync(sessionsDir).sort();
    const [summary] = await second.runtime.listSubagents({ parentSessionId: sessionId });
    expect(summary).toMatchObject({
      parentSessionId: sessionId,
      state: "ended",
      profile: "default",
      taskSummary: "历史任务",
      outcome: { status: "ok" },
    });
    const bytes = readFileSync(path.join(sessionsDir, `${summary?.childSessionId}.jsonl`));
    const obs = observer();
    const observation = await second.runtime.observeSubagent(
      { parentSessionId: sessionId, childSessionId: summary?.childSessionId ?? "" },
      obs.callbacks,
    );
    expect(observation.mode).toBe("snapshot");
    expect(obs.ends).toHaveLength(1);
    expect(obs.ends[0]?.source).toBe("snapshot");
    expect(obs.events.some((e) => e.type === "tool.completed" && e.payload.name === "finish")).toBe(
      true,
    );
    expect(readdirSync(sessionsDir).sort()).toEqual(files);
    expect(
      readFileSync(path.join(sessionsDir, `${summary?.childSessionId}.jsonl`)).equals(bytes),
    ).toBe(true);
    // 子日志可被只读读取，resume 取锁与修复仍是另一件事（未被调用）
    expect(existsSync(path.join(sessionsDir, `${summary?.childSessionId}.lock`))).toBe(false);
  });
});
