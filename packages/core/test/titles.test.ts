import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createPlatform,
  createRuntime,
  FakeProvider,
  loadConfig,
  type FakeHandler,
  type RuntimeEvent,
} from "../src/index.js";
import { decodeDurableEvent, replaySessionView } from "../src/protocol/index.js";
import { internalSession } from "./internal-session.js";

let root: string;
let home: string;
let workspace: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "nct-title-"));
  home = path.join(root, "home");
  workspace = path.join(root, "ws");
  await Promise.all([mkdir(home), mkdir(workspace)]);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
async function setup(
  configured = false,
  roleHandler: FakeHandler = () => [
    { type: "text_delta", text: " “排查\n登录错误” " },
    { type: "usage", usage: { inputTokens: 80, outputTokens: 5, cacheReadTokens: 70 } },
  ],
  handler?: FakeHandler,
  timeout?: number,
) {
  await writeFile(
    path.join(home, "settings.json"),
    JSON.stringify({ modelRoles: configured ? { smol: "fake/small" } : {} }),
  );
  const base = new FakeProvider({}).models()[0];
  if (base === undefined) throw new Error("FakeProvider 缺少默认模型");
  const provider = new FakeProvider({
    models: [base, { ...base, ref: { provider: "fake", model: "small" } }],
    roleHandler,
    handler:
      handler ??
      (() => [
        { type: "text_delta", text: "完成" },
        { type: "usage", usage: { inputTokens: 10, outputTokens: 2 } },
      ]),
  });
  const runtime = await createRuntime({
    cwd: workspace,
    providers: [provider],
    config: await loadConfig(createPlatform(), { nocturneHome: home, env: () => undefined }),
    debug: { enabled: true, file: path.join(home, "diagnostic.jsonl") },
    turn: timeout === undefined ? {} : { firstEventTimeoutMs: timeout },
  });
  const session = await runtime.createSession({ model: "fake/fake-1", reasoningEffort: "high" });
  return { runtime, session, provider };
}
it.each([true, false])(
  "首条消息后台生成标题，smol 配置=%s，独立用量、清理、列表及恢复",
  async (configured) => {
    const { runtime, session, provider } = await setup(configured);
    expect(provider.roleRequests).toHaveLength(0);
    await session.submit({ text: "你好\n" + "长".repeat(2500) });
    await vi.waitFor(() =>
      expect(session.durableEvents().some((e) => e.type === "session.titled")).toBe(true),
    );
    const request = provider.roleRequests[0];
    if (request === undefined) throw new Error("未收到标题请求");
    expect(request).toMatchObject({
      purpose: "title",
      model: configured ? "small" : "fake-1",
      tools: [],
    });
    expect(request).not.toHaveProperty("reasoningEffort");
    expect(JSON.stringify(request.system)).toContain("20");
    expect(request.messages[0]?.content).toEqual([
      { type: "text", text: ("你好\n" + "长".repeat(2500)).slice(0, 2000) },
    ]);
    const view = replaySessionView(session.durableEvents());
    expect(view.title).toBe("排查登录错误");
    expect(view.usage).toEqual({ inputTokens: 10, outputTokens: 2 });
    expect(session.durableEvents().find((e) => e.type === "session.titled")?.payload).toMatchObject(
      {
        title: "排查登录错误",
        model: configured ? "fake/small" : "fake/fake-1",
        usage: { inputTokens: 80, cacheReadTokens: 70 },
      },
    );
    await session.submit({ text: "继续" });
    await session.close();
    expect((await runtime.listSessions())[0]?.firstText).toBe("排查登录错误");
    const resumed = await runtime.resumeSession(session.id);
    await resumed.submit({ text: "再次继续" });
    expect(provider.roleRequests).toHaveLength(1);
    expect(replaySessionView(resumed.durableEvents()).title).toBe("排查登录错误");
    await resumed.close();
  },
);
it("标题按 grapheme 截到 40 显示宽度", async () => {
  const { session } = await setup(false, () => [
    { type: "text_delta", text: "「" + "甲".repeat(30) + "」" },
  ]);
  await session.submit({ text: "输入" });
  await vi.waitFor(() =>
    expect(replaySessionView(session.durableEvents()).title).toBe("甲".repeat(20)),
  );
  await session.close();
});
it.each(["error", "empty", "timeout"])("标题 %s 静默放弃，仅记诊断，不重试", async (failure) => {
  const { session, provider } = await setup(
    false,
    () =>
      failure === "error"
        ? [{ type: "throw", error: new Error("title error") }]
        : failure === "timeout"
          ? [{ type: "wait" }]
          : [],
    undefined,
    20,
  );
  const events: RuntimeEvent[] = [];
  session.subscribe((e) => events.push(e));
  await session.submit({ text: "原文首行\n后续内容" });
  await vi.waitFor(async () =>
    expect(await readFile(path.join(home, "diagnostic.jsonl"), "utf8")).toContain(
      "session.title_failed",
    ),
  );
  expect(events.some((e) => e.type === "runtime.warning")).toBe(false);
  expect(replaySessionView(session.durableEvents()).title).toBe("原文首行");
  await session.submit({ text: "继续" });
  expect(provider.roleRequests).toHaveLength(1);
  await session.close();
});
it("恢复没有标题的旧会话不补生成，保留原文首行", async () => {
  const { session, runtime, provider } = await setup(false, () => [{ type: "wait" }]);
  await session.submit({ text: "旧会话标题\n正文" });
  await session.close();
  const resumed = await runtime.resumeSession(session.id);
  await resumed.submit({ text: "补一条" });
  expect(provider.roleRequests).toHaveLength(1);
  expect((await runtime.listSessions())[0]?.firstText).toBe("旧会话标题");
  await resumed.close();
});
it("未写过用户消息的恢复会话也不补标题", async () => {
  const { session, runtime, provider } = await setup();
  await session.close();
  const resumed = await runtime.resumeSession(session.id);
  await resumed.submit({ text: "恢复后的第一条" });
  expect(provider.roleRequests).toHaveLength(0);
  await resumed.close();
});
it("标题请求不阻塞 Turn，Esc 不取消标题，会话关闭才取消", async () => {
  const { session, provider } = await setup(false, () => [{ type: "wait" }]);
  expect(await session.submit({ text: "继续工作" })).toBe("done");
  expect(provider.roleRequests).toHaveLength(1);
  session.interrupt();
  await session.setModel("fake/small");
  expect(provider.roleRequests[0]?.model).toBe("fake-1");
  await session.close();
  expect(session.durableEvents().some((e) => e.type === "session.titled")).toBe(false);
});
it("后台标题与 Turn 同时完成：日志、发布、重放的 seq 顺序一致", async () => {
  let finishTitle!: () => void;
  let finishTurn!: () => void;
  const titleReady = new Promise<void>((resolve) => {
    finishTitle = resolve;
  });
  const turnReady = new Promise<void>((resolve) => {
    finishTurn = resolve;
  });
  const { session, provider } = await setup(
    false,
    async () => {
      await titleReady;
      return [{ type: "text_delta", text: "并发标题" }];
    },
    async () => {
      await turnReady;
      return [{ type: "text_delta", text: "并发回答" }];
    },
  );
  const published: number[] = [];
  session.subscribe((e) => {
    if ("seq" in e) published.push(e.seq);
  });
  const pending = session.submit({ text: "同时写入" });
  await vi.waitFor(() => {
    expect(provider.requests).toHaveLength(1);
    expect(provider.roleRequests).toHaveLength(1);
  });
  finishTitle();
  finishTurn();
  await pending;
  await vi.waitFor(() =>
    expect(session.durableEvents().some((e) => e.type === "session.titled")).toBe(true),
  );
  const live = [...session.durableEvents()];
  await session.close();
  const disk = (await readFile(internalSession(session).logPath, "utf8"))
    .trim()
    .split("\n")
    .map(decodeDurableEvent);
  expect(disk).toEqual(live);
  expect(disk.map((e) => e.seq)).toEqual(Array.from({ length: disk.length }, (_, i) => i + 1));
  expect(published).toEqual(disk.slice(1).map((e) => e.seq));
  expect(replaySessionView(disk).title).toBe("并发标题");
});
