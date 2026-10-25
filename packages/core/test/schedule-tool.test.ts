/**
 * ADR-0064 第 7 节：`schedule` 工具。
 * 普通会话里的调用走常规权限层并需要确认（全部预设，含 bypass；smart 不送审）、
 * 定时任务发起的会话和子代理看不到它、调度器没启用时结果里有提示。
 * 任务写在隔离的 NOCTURNE_HOME 下。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createRuntime, type Runtime, type RuntimeSession } from "../src/index.js";
import { FakeProvider, type FakeScript } from "../src/provider/index.js";
import type { PermissionPresetName, RuntimeEvent } from "../src/protocol/index.js";
import { PERMISSION_PRESET_NAMES } from "../src/protocol/index.js";
import { createRulePolicy, type SecurityReviewer } from "../src/permission/index.js";
import { builtinTools, scheduleSubjectDetail, scheduleTool } from "../src/tools/index.js";

const roots: string[] = [];
const runtimes: Runtime[] = [];
afterEach(async () => {
  for (const r of runtimes.splice(0)) await r.stopScheduler().catch(() => undefined);
  vi.unstubAllEnvs();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
const tmp = (prefix: string): string => {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  roots.push(d);
  return d;
};

const call = (input: Record<string, unknown>, id = "c1"): FakeScript => [
  { type: "tool_call", toolCallId: id, name: "schedule", input },
  { type: "finish", reason: "tool_calls" },
];
const done: FakeScript = [
  { type: "text_delta", text: "好" },
  { type: "finish", reason: "stop" },
];

const SEED_ID = "tseed1";

async function setup(
  scripts: FakeScript[],
  options: { scheduler?: boolean; seed?: boolean; reviewer?: SecurityReviewer } = {},
) {
  const home = tmp("nct-st-home-");
  const ws = tmp("nct-st-ws-");
  vi.stubEnv("NOCTURNE_HOME", home);
  if (options.seed === true) {
    mkdirSync(home, { recursive: true });
    const at = new Date().toISOString();
    writeFileSync(
      path.join(home, "schedules.json"),
      JSON.stringify({
        version: 1,
        tasks: [
          {
            id: SEED_ID,
            name: "已有任务",
            prompt: "原指令",
            workspace: ws,
            model: "fake/fake-model",
            schedule: { type: "daily", time: "09:00" },
            enabled: true,
            maxDurationMinutes: 60,
            createdAt: at,
            anchorAt: at,
          },
        ],
      }),
    );
  }
  const provider = new FakeProvider({ scripts });
  const runtime = await createRuntime({
    cwd: ws,
    sessionsDir: path.join(home, "sessions"),
    providers: [provider],
    interactive: true,
    scheduler: options.scheduler ?? false,
    permissions: options.reviewer !== undefined ? { reviewer: options.reviewer } : undefined,
  });
  runtimes.push(runtime);
  return { runtime, provider, ws, home };
}

/** 订阅事件；遇到权限请求按 decide 回复，并把请求记下来 */
function watch(session: RuntimeSession, decide: "allow" | "deny" = "allow") {
  const events: RuntimeEvent[] = [];
  session.subscribe((e) => {
    events.push(e);
    if (e.type === "permission.requested")
      void session.respondPermission(e.payload.requestId, { decision: decide });
  });
  return {
    events,
    requests: () => events.filter((e) => e.type === "permission.requested"),
    completed: () => events.filter((e) => e.type === "tool.completed"),
  };
}

const CREATE = {
  action: "create",
  name: "错误日志巡检",
  prompt: "检查 logs/ 下最近一天的错误日志，按服务汇总前 5 条。",
  workspace: null,
  permissionPreset: "read-only",
  schedule: { type: "daily", time: "09:00" },
};

describe("schedule 工具：普通会话", () => {
  it("create 需要确认：权限主体是 schedule、target 为「动作:任务名」，detail 含全部字段与完整指令", async () => {
    const { runtime } = await setup([call(CREATE), done]);
    const session = await runtime.createSession({ model: "fake/fake-model" });
    const w = watch(session);
    await session.submit({ text: "每天 9 点帮我巡检日志" });

    const [asked] = w.requests();
    if (asked?.type !== "permission.requested") throw new Error("缺少权限请求");
    expect(asked.payload.subjects).toHaveLength(1);
    expect(asked.payload.subjects[0]).toMatchObject({
      kind: "schedule",
      target: "create:错误日志巡检",
    });
    const detail = asked.payload.subjects[0]?.detail ?? "";
    expect(detail).toContain("新建定时任务");
    expect(detail).toContain("名称：错误日志巡检");
    expect(detail).toContain("计划：每天 09:00");
    expect(detail).toContain("工作区：普通对话");
    expect(detail).toContain("模型 · 档位 · 权限：默认 · 默认 · read-only");
    expect(detail).toContain("时长上限：60 分钟");
    expect(detail).toContain(CREATE.prompt);
    // 落盘的项目级授权不提供：Grant 只按 target 匹配、不看指令内容
    expect(asked.payload.options).toEqual(["allow_once", "allow_session", "deny", "deny_stop"]);

    const listed = await runtime.listSchedules();
    expect(listed.tasks).toHaveLength(1);
    expect(listed.tasks[0]).toMatchObject({ name: "错误日志巡检", permissionPreset: "read-only" });
    await session.close();
  });

  it("调度器没启用：创建成功，结果注明只在桌面端打开时运行", async () => {
    const { runtime } = await setup([call(CREATE), done]);
    const session = await runtime.createSession({ model: "fake/fake-model" });
    const w = watch(session);
    await session.submit({ text: "建任务" });
    const completed = w.completed()[0];
    expect(completed?.payload).toMatchObject({ status: "ok" });
    expect(JSON.stringify(completed?.payload)).toContain("定时任务只在桌面端打开时运行");
    await session.close();
  });

  it("调度器启用时结果里没有这条提示", async () => {
    const { runtime } = await setup([call(CREATE), done], { scheduler: true });
    const session = await runtime.createSession({ model: "fake/fake-model" });
    const w = watch(session);
    await session.submit({ text: "建任务" });
    expect(JSON.stringify(w.completed()[0]?.payload)).not.toContain("只在桌面端打开时运行");
    expect((await runtime.listSchedules()).scheduler).toEqual({ running: true });
    await session.close();
  });

  it("用户拒绝：任务不创建，调用以 denied 结算", async () => {
    const { runtime } = await setup([call(CREATE), done]);
    const session = await runtime.createSession({ model: "fake/fake-model" });
    const w = watch(session, "deny");
    await session.submit({ text: "建任务" });
    expect(w.completed()[0]?.payload).toMatchObject({ status: "denied" });
    expect((await runtime.listSchedules()).tasks).toEqual([]);
    await session.close();
  });

  it("全部预设下都需要确认（含 bypass），smart 不送审、直接交人", async () => {
    for (const preset of PERMISSION_PRESET_NAMES) {
      const review = vi.fn(() => Promise.resolve({ verdict: "allow" as const, reason: "x" }));
      const reviewer = { review } as unknown as SecurityReviewer;
      const { runtime } = await setup([call(CREATE), done], { reviewer });
      const session = await runtime.createSession({
        model: "fake/fake-model",
        permissionPreset: preset,
      });
      const w = watch(session);
      await session.submit({ text: "建任务" });
      expect(w.requests(), preset).toHaveLength(1);
      expect(review, preset).not.toHaveBeenCalled();
      await session.close();
    }
  });

  it("本会话允许只对同一个任务的同一个动作生效", async () => {
    const other = { ...CREATE, name: "另一个任务" };
    const { runtime } = await setup([call(CREATE, "a"), call(CREATE, "b"), call(other, "c"), done]);
    const session = await runtime.createSession({ model: "fake/fake-model" });
    const events: RuntimeEvent[] = [];
    session.subscribe((e) => {
      events.push(e);
      if (e.type === "permission.requested")
        void session.respondPermission(e.payload.requestId, {
          decision: "allow",
          remember: "session",
        });
    });
    await session.submit({ text: "建任务" });
    const asks = events.filter((e) => e.type === "permission.requested");
    // 第一次问；同名同动作命中会话授权不再问；换一个任务名要再问
    expect(
      asks.map((e) => (e.type === "permission.requested" ? e.payload.subjects[0]?.target : "")),
    ).toEqual(["create:错误日志巡检", "create:另一个任务"]);
    await session.close();
  });

  it("update / pause / delete 按 id 生效：先 list 取 id，update 只改传入的字段", async () => {
    const { runtime } = await setup(
      [
        call({ action: "list" }, "l"),
        call(
          {
            action: "update",
            id: SEED_ID,
            prompt: "新指令",
            schedule: { type: "weekdays", time: "08:30" },
          },
          "u",
        ),
        call({ action: "pause", id: SEED_ID }, "p"),
        call({ action: "delete", id: SEED_ID }, "d"),
        done,
      ],
      { seed: true },
    );
    const session = await runtime.createSession({ model: "fake/fake-model" });
    const w = watch(session);
    const snapshots: unknown[] = [];
    session.subscribe((e) => {
      if (e.type === "tool.completed")
        void runtime.listSchedules().then((r) => snapshots.push(r.tasks[0]));
    });
    await session.submit({ text: "整理定时任务" });

    // list 不需要确认；其余三个各问一次，主体 target 带动作与 id
    expect(
      w
        .requests()
        .map((e) => (e.type === "permission.requested" ? e.payload.subjects[0]?.target : "")),
    ).toEqual([`update:${SEED_ID}`, `pause:${SEED_ID}`, `delete:${SEED_ID}`]);
    expect(w.completed().map((e) => e.payload)).toSatisfy((all: unknown[]) =>
      all.every((p) => (p as { status: string }).status === "ok"),
    );
    expect((await runtime.listSchedules()).tasks).toEqual([]);
    // update 之后的快照：只改了指令与计划，名称与工作区不变；pause 之后 enabled 为 false
    await vi.waitFor(() => expect(snapshots.length).toBeGreaterThanOrEqual(3));
    expect(snapshots[1]).toMatchObject({
      name: "已有任务",
      prompt: "新指令",
      schedule: { type: "weekdays", time: "08:30" },
      enabled: true,
    });
    expect(snapshots[2]).toMatchObject({ enabled: false });
    await session.close();
  });

  it("字段不合法：以 invalid_input 结算并带出错字段，不写入", async () => {
    const bad = { ...CREATE, schedule: { type: "interval", minutes: 5 } };
    const { runtime } = await setup([call(bad), done]);
    const session = await runtime.createSession({ model: "fake/fake-model" });
    const w = watch(session);
    await session.submit({ text: "建任务" });
    const payload = w.completed()[0]?.payload;
    expect(payload).toMatchObject({ status: "error" });
    expect(JSON.stringify(payload)).toContain("invalid_input");
    expect(JSON.stringify(payload)).toContain("schedule：");
    expect((await runtime.listSchedules()).tasks).toEqual([]);
    await session.close();
  });

  it("id 不存在：not_found，先用 list 查看", async () => {
    const { runtime } = await setup([call({ action: "delete", id: "nope" }), done]);
    const session = await runtime.createSession({ model: "fake/fake-model" });
    const w = watch(session);
    await session.submit({ text: "删" });
    expect(JSON.stringify(w.completed()[0]?.payload)).toContain("not_found");
    await session.close();
  });

  it("模型能看到这个工具，说明里有三条关键提示", async () => {
    const { runtime, provider } = await setup([done]);
    const session = await runtime.createSession({ model: "fake/fake-model" });
    await session.submit({ text: "你好" });
    const spec = provider.requests[0]?.tools.find((t) => t.name === "schedule");
    expect(spec).toBeDefined();
    expect(spec?.description).toContain("全新的会话");
    expect(spec?.description).toContain("写进 prompt");
    expect(spec?.description).toContain("无人值守");
    await session.close();
  });
});

describe("schedule 工具：不该出现的地方", () => {
  it("定时任务发起的会话看不到它（按 mutatesSchedule 特性排除）", async () => {
    const { runtime, provider } = await setup([done]);
    const session = await runtime.createSession({
      model: "fake/fake-model",
      interactive: false,
      schedule: { taskId: "t1", scheduledAt: new Date().toISOString(), trigger: "schedule" },
    });
    await session.submit({ text: "指令" });
    const names = provider.requests[0]?.tools.map((t) => t.name) ?? [];
    expect(names).toContain("read");
    expect(names).not.toContain("schedule");
    await session.close();
  });

  it("子代理的可选工具池同样按特性排除它，父会话仍有", async () => {
    const isChild = (tools: { name: string }[]) => tools.some((t) => t.name === "finish");
    const provider = new FakeProvider({
      handler: (req) => {
        if (isChild(req.tools)) {
          return [
            { type: "tool_call", toolCallId: "cf", name: "finish", input: { result: "完成" } },
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
    const home = tmp("nct-st-home-");
    vi.stubEnv("NOCTURNE_HOME", home);
    const runtime = await createRuntime({
      cwd: tmp("nct-st-ws-"),
      sessionsDir: path.join(home, "sessions"),
      providers: [provider],
      interactive: true,
      permissions: { autoApproveAsk: true },
    });
    runtimes.push(runtime);
    const session = await runtime.createSession({ model: "fake/fake-model" });
    await session.submit({ text: "跑个子任务" });
    const child = provider.requests.find((r) => isChild(r.tools));
    expect(child?.tools.map((t) => t.name)).toContain("read");
    expect(child?.tools.map((t) => t.name)).not.toContain("schedule");
    expect(provider.requests[0]?.tools.some((t) => t.name === "schedule")).toBe(true);
    await session.close();
  });

  it("特性只在 schedule 工具上声明；其余内置工具都不带", () => {
    expect(
      builtinTools()
        .filter((t) => t.traits.mutatesSchedule === true)
        .map((t) => t.name),
    ).toEqual(["schedule"]);
  });
});

describe("schedule 工具：输入校验与展示", () => {
  const validate = (input: Record<string, unknown>) => scheduleTool.validateInput?.(input as never);

  it("各动作的必填与互斥", () => {
    expect(validate({ action: "list" })).toBeUndefined();
    expect(validate({ action: "list", id: "x" })).toMatch(/list/);
    expect(validate({ action: "create", name: "n", prompt: "p" })).toMatch(/schedule/);
    expect(
      validate({ action: "create", name: "n", prompt: " ", schedule: { type: "manual" } }),
    ).toMatch(/prompt/);
    expect(
      validate({ action: "create", id: "x", name: "n", prompt: "p", schedule: { type: "manual" } }),
    ).toMatch(/id/);
    expect(
      validate({ action: "create", name: "a\nb", prompt: "p", schedule: { type: "manual" } }),
    ).toMatch(/name/);
    expect(validate({ action: "update", id: "x" })).toMatch(/至少/);
    expect(validate({ action: "update", prompt: "p" })).toMatch(/id/);
    expect(validate({ action: "pause", id: "x", name: "n" })).toMatch(/只需要 id/);
    expect(validate({ action: "delete" })).toMatch(/id/);
    expect(validate({ action: "delete", id: "x" })).toBeUndefined();
  });

  it("list 没有权限主体；其余动作各一个 schedule 主体", () => {
    const subjects = (input: Record<string, unknown>) =>
      scheduleTool.permissionSubjects(input as never, {} as never);
    expect(subjects({ action: "list" })).toEqual([]);
    expect(
      subjects({ action: "create", name: " 巡检 ", prompt: "p", schedule: { type: "manual" } }),
    ).toMatchObject([{ kind: "schedule", target: "create:巡检" }]);
    expect(subjects({ action: "pause", id: "t1" })).toMatchObject([
      { kind: "schedule", target: "pause:t1" },
    ]);
  });

  it("detail：update 只列出要改的字段；delete 说明历史一并删除", () => {
    const update = scheduleSubjectDetail({
      action: "update",
      id: "t1",
      prompt: "新指令",
      enabled: true,
    });
    expect(update).toContain("修改定时任务 t1");
    expect(update).toContain("状态：启用");
    expect(update).toContain("新指令");
    expect(update).not.toContain("工作区");
    expect(scheduleSubjectDetail({ action: "delete", id: "t1" })).toContain("运行历史一并删除");
  });
});

describe("权限层：schedule 主体", () => {
  const subject = [{ kind: "schedule" as const, target: "create:巡检" }];
  const policy = (
    preset: PermissionPresetName,
    rules: Parameters<typeof createRulePolicy>[0]["rules"] = [],
  ) => createRulePolicy({ workspaceRoot: "/ws", caseSensitive: true, preset, rules });

  it("每个预设默认 ask 且只能由用户确认（userOnly）", () => {
    for (const preset of PERMISSION_PRESET_NAMES) {
      const r = policy(preset).evaluate(subject);
      expect(r.decision.action, preset).toBe("ask");
      expect(r.userOnly, preset).toBe(true);
    }
  });

  it("用户显式规则 schedule * → allow 可以放行；schedule * → deny 可以关闭", () => {
    const allow = policy("default", [
      { rule: { kind: "schedule", pattern: "*", action: "allow" }, origin: "user" },
    ]);
    expect(allow.evaluate(subject).decision.action).toBe("allow");
    const deny = policy("bypass", [
      { rule: { kind: "schedule", pattern: "*", action: "deny" }, origin: "user" },
    ]);
    expect(deny.evaluate(subject).decision.action).toBe("deny");
  });

  it("--yes（autoApproveAsk）沿既有规则提升", () => {
    const yes = createRulePolicy({
      workspaceRoot: "/ws",
      caseSensitive: true,
      preset: "default",
      autoApproveAsk: true,
    });
    expect(yes.evaluate(subject).decision.action).toBe("allow");
  });
});
