import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createPlatform,
  createRuntime,
  FakeProvider,
  loadConfig,
  type RuntimeEvent,
  type FakeHandler,
} from "../src/index.js";
import { replaySessionView } from "../src/protocol/index.js";

let root: string;
let home: string;
let workspace: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "nct-roles-"));
  home = path.join(root, "home");
  workspace = path.join(root, "ws");
  await Promise.all([mkdir(home), mkdir(workspace)]);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const json = (name: string, value: unknown) =>
  writeFile(path.join(home, name), JSON.stringify(value));
const load = () => loadConfig(createPlatform(), { nocturneHome: home, env: () => undefined });

const png = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 2,
  0, 0, 0, 3, 8, 6, 0, 0, 0,
]);
const visionRequests = (provider: FakeProvider) =>
  provider.roleRequests.filter((r) => r.purpose === "vision");
const image = { data: png, mimeType: "image/png" as const, label: "截图" };
async function visionSetup(
  roleHandler: FakeHandler = () => [
    { type: "text_delta", text: "屏幕显示错误 E42" },
    { type: "usage", usage: { inputTokens: 500, outputTokens: 100, cacheReadTokens: 400 } },
    { type: "finish", reason: "stop" },
  ],
  handler?: FakeHandler,
  firstEventTimeoutMs?: number,
) {
  await json("settings.json", { modelRoles: { vision: "fake/vision" } });
  const base = new FakeProvider({}).models()[0];
  if (base === undefined) throw new Error("missing fake model");
  const provider = new FakeProvider({
    models: [
      base,
      {
        ...base,
        ref: { provider: "fake", model: "vision" },
        capabilities: { ...base.capabilities, imageInput: true },
      },
    ],
    roleHandler: (request, index) =>
      request.purpose == "title"
        ? [{ type: "text_delta", text: "测试标题" }]
        : roleHandler(request, index),
    handler:
      handler ??
      (() => [
        { type: "text_delta", text: "完成" },
        { type: "usage", usage: { inputTokens: 10, outputTokens: 2 } },
        { type: "finish", reason: "stop" },
      ]),
  });
  const runtime = await createRuntime({
    cwd: workspace,
    config: await load(),
    providers: [provider],
    turn: firstEventTimeoutMs === undefined ? {} : { firstEventTimeoutMs },
  });
  return {
    runtime,
    provider,
    session: await runtime.createSession({ model: "fake/fake-1", reasoningEffort: "high" }),
  };
}

it("用户图片描述一次：请求约束、文字投影、重放恢复与独立用量", async () => {
  const { runtime, provider, session } = await visionSetup();
  expect(session.visionInfo()).toEqual({
    imageInput: false,
    available: true,
    model: "fake/vision",
  });
  expect(await session.submit({ text: "检查报错", attachments: [image] })).toBe("done");
  expect(visionRequests(provider)[0]).toMatchObject({
    purpose: "vision",
    model: "vision",
    tools: [],
    maxOutputTokens: 1000,
  });
  expect(visionRequests(provider)[0]).not.toHaveProperty("reasoningEffort");
  expect(visionRequests(provider)[0]?.messages[0]).toMatchObject({
    images: [{ data: Buffer.from(png).toString("base64") }],
    content: [{ text: "检查报错" }],
  });
  expect(JSON.stringify(provider.requests[0]?.messages)).toContain(
    "图片 #1 描述（由 fake/vision 生成）",
  );
  expect(JSON.stringify(provider.requests[0]?.messages)).toContain("屏幕显示错误 E42");
  const view = replaySessionView(session.session.durableEvents());
  expect(view.usage).toEqual({ inputTokens: 10, outputTokens: 2 });
  expect(view.entries.find((e) => e.kind === "user")).toMatchObject({
    descriptions: [{ model: "fake/vision", usage: { inputTokens: 500 } }],
  });
  await session.submit({ text: "继续" });
  const id = session.id;
  await session.close();
  const resumed = await runtime.resumeSession(id);
  await resumed.submit({ text: "恢复继续" });
  expect(visionRequests(provider)).toHaveLength(1);
  await resumed.close();
});

it("工具附件由同一通道描述，附带工具名与路径", async () => {
  await writeFile(path.join(workspace, "screen.png"), png);
  const { provider, session } = await visionSetup(undefined, (_request, index) =>
    index === 0
      ? [
          {
            type: "tool_call",
            toolCallId: "read-image",
            name: "read",
            input: { path: "screen.png" },
          },
          { type: "finish", reason: "tool_calls" },
        ]
      : [
          { type: "text_delta", text: "完成" },
          { type: "finish", reason: "stop" },
        ],
  );
  expect(await session.submit({ text: "查看截图" })).toBe("done");
  expect(JSON.stringify(visionRequests(provider)[0]?.messages)).toMatch(/read.*screen.png/u);
  expect(JSON.stringify(provider.requests[1]?.messages)).toContain("屏幕显示错误 E42");
  expect(
    replaySessionView(session.session.durableEvents()).entries.find((e) => e.kind === "tool"),
  ).toMatchObject({ descriptions: [{ text: "屏幕显示错误 E42" }] });
  await session.close();
});

it("能看图的模型收到原图，切到文字模型后补描述，再切回仍发原图", async () => {
  const { provider, session } = await visionSetup();
  await session.setModel("fake/vision");
  await session.submit({ text: "看图", attachments: [image] });
  expect(visionRequests(provider)).toHaveLength(0);
  expect(provider.requests[0]?.messages[0]).toHaveProperty("images");
  await session.setModel("fake/fake-1");
  await session.submit({ text: "继续" });
  expect(visionRequests(provider)).toHaveLength(1);
  await session.setModel("fake/vision");
  await session.submit({ text: "直接看图" });
  expect(
    provider.requests.at(-1)?.messages.some((m) => m.role !== "assistant" && m.images?.length),
  ).toBe(true);
  expect(visionRequests(provider)).toHaveLength(1);
  await session.close();
});

it.each(["error", "empty", "timeout"])("描述 %s 时警告并继续，恢复后不重试", async (kind) => {
  const { runtime, provider, session } = await visionSetup(
    () =>
      kind === "error"
        ? [{ type: "throw", error: new Error("fail") }]
        : kind === "timeout"
          ? [{ type: "wait" }]
          : [{ type: "finish", reason: "stop" }],
    undefined,
    kind === "timeout" ? 20 : undefined,
  );
  const events: RuntimeEvent[] = [];
  session.subscribe((e) => events.push(e));
  const pending = session.submit({ text: "看图", attachments: [image] });
  expect(await pending).toBe("done");
  expect(
    events.some(
      (e) => e.type === "runtime.warning" && e.payload.code === "attachment_description_failed",
    ),
  ).toBe(true);
  expect(JSON.stringify(provider.requests[0]?.messages)).toContain("image omitted");
  await session.submit({ text: "继续" });
  const id = session.id;
  await session.close();
  const resumed = await runtime.resumeSession(id);
  await resumed.submit({ text: "再看" });
  expect(visionRequests(provider)).toHaveLength(1);
  await resumed.close();
});

it("Esc 中断同时取消正在进行的描述请求，已完成描述保留", async () => {
  const { provider, session } = await visionSetup((_r, index) =>
    index === 0
      ? [
          { type: "text_delta", text: "第一张" },
          { type: "finish", reason: "stop" },
        ]
      : [{ type: "wait" }],
  );
  const pending = session.submit({ text: "看图", attachments: [image, image] });
  await vi.waitFor(() => expect(visionRequests(provider)).toHaveLength(2));
  session.interrupt();
  expect(await pending).toBe("aborted");
  expect(
    session.session.durableEvents().filter((e) => e.type === "attachment.described"),
  ).toHaveLength(1);
  expect(provider.requests).toHaveLength(0);
  await session.close();
});

it("模型角色逐项分层合并，项目仅信任后参与；来源与保存值可复核", async () => {
  await json("settings.json", {
    modelRoles: { task: "fake/fake-1", vision: "fake/image" },
    theme: "dark",
  });
  await json("config.json", { modelRoles: { smol: "fake/title" } });
  await mkdir(path.join(workspace, ".nocturne"));
  await writeFile(
    path.join(workspace, ".nocturne/config.json"),
    JSON.stringify({ modelRoles: { task: "fake/child" } }),
  );
  const config = await load();
  expect((await config.forWorkspace(workspace)).resolved.modelRoles).toEqual({
    task: "fake/fake-1",
    vision: "fake/image",
    smol: "fake/title",
  });
  await config.setWorkspaceTrusted(workspace, true);
  expect((await config.forWorkspace(workspace)).resolved.modelRoles?.task).toBe("fake/child");
  expect(config.describeSettings(workspace).find((s) => s.key === "modelRoles.task")).toMatchObject(
    { source: "project", saved: "fake/fake-1", overridden: true },
  );
  await config.setModelRole("vision", null);
  expect(JSON.parse(await readFile(path.join(home, "settings.json"), "utf8"))).toEqual({
    modelRoles: { task: "fake/fake-1" },
    theme: "dark",
  });
});

it("未知服务商、未知模型和非图片 vision 降级并警告，启动成功", async () => {
  await json("config.json", {
    modelRoles: { task: "missing/model", smol: "fake/missing", vision: "fake/fake-1" },
  });
  const runtime = await createRuntime({
    cwd: workspace,
    config: await load(),
    providers: [new FakeProvider({})],
  });
  expect(runtime.describeModelRoles().map((r) => r.available)).toEqual([false, false, false]);
  const session = await runtime.createSession({ model: "fake/fake-1" });
  expect(session.warnings.filter((w) => w.includes("模型角色"))).toHaveLength(3);
  await expect(runtime.setModelRole("vision", "fake/fake-1")).rejects.toThrow("不可用");
  await session.close();
});

it("设置接口保存、清除角色，Settings 包含三行；畸形引用拒绝写入", async () => {
  const config = await load();
  const runtime = await createRuntime({
    cwd: workspace,
    config,
    providers: [new FakeProvider({})],
  });
  await runtime.setModelRole("task", "fake/fake-1");
  expect(runtime.describeModelRoles()[0]).toMatchObject({
    role: "task",
    configured: "fake/fake-1",
    model: "fake/fake-1",
    source: "settings",
    available: true,
  });
  expect(runtime.describeSettings().filter((s) => s.key.startsWith("modelRoles."))).toHaveLength(3);
  await expect(config.setModelRole("task", "broken")).rejects.toThrow();
  await runtime.setModelRole("task", null);
  expect(runtime.describeModelRoles()[0]?.configured).toBeUndefined();
});

it.each([true, false])(
  "task 角色配置=%s：请求、日志、结果模型一致，档位按子模型降档",
  async (configured) => {
    if (configured) await json("settings.json", { modelRoles: { task: "fake/child" } });
    const base = new FakeProvider({}).models()[0];
    if (base === undefined) throw new Error("FakeProvider 必须有默认模型");
    const provider = new FakeProvider({
      models: [
        base,
        {
          ...base,
          ref: { provider: "fake", model: "child" },
          capabilities: { ...base.capabilities, reasoningEffort: ["low"] },
        },
      ],
      handler: (request) =>
        request.tools.some((t) => t.name === "finish")
          ? [
              {
                type: "tool_call",
                toolCallId: "finish",
                name: "finish",
                input: { result: "结果" },
              },
              { type: "finish", reason: "tool_calls" },
            ]
          : request.messages.some((m) => m.role === "tool")
            ? [
                { type: "text_delta", text: "done" },
                { type: "finish", reason: "stop" },
              ]
            : [
                {
                  type: "tool_call",
                  toolCallId: "task",
                  name: "task",
                  input: { task: "调查", preset: "explore" },
                },
                { type: "finish", reason: "tool_calls" },
              ],
    });
    const runtime = await createRuntime({
      cwd: workspace,
      config: await load(),
      providers: [provider],
    });
    const session = await runtime.createSession({ model: "fake/fake-1", reasoningEffort: "high" });
    const events: RuntimeEvent[] = [];
    session.subscribe((e) => events.push(e));
    expect(await session.submit({ text: "调查" })).toBe("done");
    const childRequest = provider.requests.find((r) => r.tools.some((t) => t.name === "finish"));
    expect(childRequest).toMatchObject({
      model: configured ? "child" : "fake-1",
      reasoningEffort: configured ? "low" : "high",
    });
    const completed = events.find((e) => e.type === "tool.completed" && e.payload.name === "task");
    expect(completed?.type === "tool.completed" && completed.payload.output).toMatchObject({
      model: configured ? "fake/child" : "fake/fake-1",
    });
    if (completed?.type === "tool.completed") {
      const output = completed.payload.output as { childLogPath: string };
      const created = JSON.parse(
        (await readFile(output.childLogPath, "utf8")).split("\n")[0] ?? "",
      );
      expect(created.payload.model.model).toBe(childRequest?.model);
      expect(await readFile(output.childLogPath, "utf8")).not.toContain('"session.titled"');
    }
    expect(provider.roleRequests.filter((r) => r.purpose === "title")).toHaveLength(1);
    await session.close();
  },
);
