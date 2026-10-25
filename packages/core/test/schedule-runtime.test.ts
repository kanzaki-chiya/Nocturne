/**
 * ADR-0064：Runtime 里的定时任务装配——立即运行开出带来源的无人值守会话、标题、
 * 被拒绝的写入计入历史、补跑前缀、调度器未启用时的行为。
 * 隔离的 NOCTURNE_HOME，FakeProvider 脚本化模型。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createRuntime, ScheduleError, type Runtime } from "../src/index.js";
import { FakeProvider, type FakeScript } from "../src/provider/index.js";

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

async function setup(scripts: FakeScript[], scheduler = true) {
  const home = tmp("nct-sr-home-");
  const ws = tmp("nct-sr-ws-");
  vi.stubEnv("NOCTURNE_HOME", home);
  const provider = new FakeProvider({ scripts });
  const runtime = await createRuntime({
    cwd: ws,
    sessionsDir: path.join(home, "sessions"),
    providers: [provider],
    interactive: true,
    scheduler,
  });
  runtimes.push(runtime);
  return { runtime, home, ws, provider };
}

const writeThenDone = (rel: string): FakeScript[] => [
  [
    { type: "tool_call", toolCallId: "w", name: "write", input: { path: rel, content: "x" } },
    { type: "finish", reason: "tool_calls" },
  ],
  [
    { type: "text_delta", text: "没能写入，已列出" },
    { type: "finish", reason: "stop" },
  ],
];

async function waitForHistory(runtime: Runtime, id: string, result: string) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const [entry] = await runtime.scheduleHistory({ id });
    if (entry?.result === result) return entry;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`等待历史 ${result} 超时`);
}

describe("Runtime 定时任务", () => {
  it("立即运行：新会话带 meta.schedule、标题「任务名 · 月-日 时:分」，被拒绝的写入计入历史", async () => {
    const { runtime, ws } = await setup(writeThenDone("out.txt"));
    const task = await runtime.saveSchedule({
      name: "每日提交汇总",
      prompt: "汇总提交",
      workspace: ws,
      model: "fake/fake-1",
      schedule: { type: "manual" },
    });
    const started = await runtime.runSchedule({ id: task.id });
    expect(started.started).toBe(true);

    const entry = await waitForHistory(runtime, task.id, "done");
    expect(entry).toMatchObject({ trigger: "manual", denied: 1 });
    expect(existsSync(path.join(ws, "out.txt"))).toBe(false);

    const sessions = await runtime.listSessions();
    const session = sessions.find((s) => s.id === entry.sessionId);
    expect(session?.schedule).toMatchObject({ taskId: task.id, trigger: "manual" });
    expect(session?.firstText).toMatch(/^每日提交汇总 · \d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it("启动时补跑：用户消息开头附原计划时间，历史 trigger 为 catchup，错过的记 missed", async () => {
    const home = tmp("nct-sr-home-");
    const ws = tmp("nct-sr-ws-");
    vi.stubEnv("NOCTURNE_HOME", home);
    mkdirSync(home, { recursive: true });
    const anchor = new Date(Date.now() - (3 * 60 + 30) * 60_000).toISOString();
    writeFileSync(
      path.join(home, "schedules.json"),
      JSON.stringify({
        version: 1,
        tasks: [
          {
            id: "tcatch",
            name: "每小时汇总",
            prompt: "汇总提交",
            workspace: ws,
            model: "fake/fake-1",
            schedule: { type: "interval", minutes: 60 },
            enabled: true,
            maxDurationMinutes: 60,
            createdAt: anchor,
            anchorAt: anchor,
          },
        ],
      }),
    );
    const runtime = await createRuntime({
      cwd: ws,
      sessionsDir: path.join(home, "sessions"),
      providers: [new FakeProvider({ scripts: writeThenDone("out.txt") })],
      interactive: true,
      scheduler: true,
    });
    runtimes.push(runtime);

    const entry = await waitForHistory(runtime, "tcatch", "done");
    expect(entry.trigger).toBe("catchup");
    const history = await runtime.scheduleHistory({ id: "tcatch" });
    expect(history.filter((h) => h.reason === "missed")).toHaveLength(2);

    const session = await runtime.resumeSession(entry.sessionId as string);
    const first = session.durableEvents().find((e) => e.type === "message.user");
    const text =
      first?.type === "message.user"
        ? first.payload.content.map((b) => (b.type === "text" ? b.text : "")).join("")
        : "";
    expect(text).toMatch(
      /^原计划 \d{2}-\d{2} 周. \d{2}:\d{2}，当时 Nocturne 没开，现在补跑。\n汇总提交$/,
    );
    expect(session.state().meta.schedule?.trigger).toBe("catchup");
    await session.close();
  });

  it("任务指令、模型缺省：用默认模型；没有默认模型时历史记 error 且 runNow 抛错", async () => {
    const { runtime, ws } = await setup([]);
    const task = await runtime.saveSchedule({
      name: "无模型",
      prompt: "p",
      workspace: ws,
      schedule: { type: "manual" },
    });
    await expect(runtime.runSchedule({ id: task.id })).rejects.toThrow("no_model");
    const entry = await waitForHistory(runtime, task.id, "error");
    expect(entry.error).toBe("no_model");
  });

  it("工作区不存在：记 error（workspace_missing）", async () => {
    const { runtime } = await setup([]);
    const gone = tmp("nct-sr-gone-");
    const task = await runtime.saveSchedule({
      name: "n",
      prompt: "p",
      workspace: gone,
      model: "fake/fake-1",
      schedule: { type: "manual" },
    });
    rmSync(gone, { recursive: true, force: true });
    await expect(runtime.runSchedule({ id: task.id })).rejects.toThrow("workspace_missing");
  });

  it("保存时拒绝未知模型与非法字段：抛 ScheduleError，带出错的字段名", async () => {
    const { runtime } = await setup([]);
    await expect(
      runtime.saveSchedule({
        name: "n",
        prompt: "p",
        model: "nope/none",
        schedule: { type: "manual" },
      }),
    ).rejects.toMatchObject({ field: "model" });
    await expect(
      runtime.saveSchedule({ name: "", prompt: "p", schedule: { type: "manual" } }),
    ).rejects.toMatchObject({ field: "name" });
    await expect(
      runtime.saveSchedule({
        name: "n",
        prompt: "p",
        schedule: { type: "interval", minutes: 5 },
      }),
    ).rejects.toBeInstanceOf(ScheduleError);
  });

  it("删除：任务和历史消失，已有会话还在；删除不存在的任务不报错", async () => {
    const { runtime, ws } = await setup(writeThenDone("out.txt"));
    const task = await runtime.saveSchedule({
      name: "n",
      prompt: "p",
      workspace: ws,
      model: "fake/fake-1",
      schedule: { type: "manual" },
    });
    await runtime.runSchedule({ id: task.id });
    const entry = await waitForHistory(runtime, task.id, "done");
    await runtime.deleteSchedule({ id: task.id });
    await runtime.deleteSchedule({ id: task.id });
    expect((await runtime.listSchedules()).tasks).toEqual([]);
    expect(await runtime.scheduleHistory({ id: task.id })).toEqual([]);
    expect((await runtime.listSessions()).some((s) => s.id === entry.sessionId)).toBe(true);
  });

  it("schedule.changed：保存与运行状态变化都通知；取消订阅后不再通知", async () => {
    const { runtime, ws } = await setup(writeThenDone("out.txt"));
    const seen: (string | undefined)[] = [];
    const off = runtime.onScheduleChanged((p) => seen.push(p.taskId));
    const task = await runtime.saveSchedule({
      name: "n",
      prompt: "p",
      workspace: ws,
      model: "fake/fake-1",
      schedule: { type: "manual" },
    });
    expect(seen).toContain(task.id);
    await runtime.runSchedule({ id: task.id });
    await waitForHistory(runtime, task.id, "done");
    const count = seen.length;
    expect(count).toBeGreaterThan(2);
    off();
    await runtime.deleteSchedule({ id: task.id });
    expect(seen).toHaveLength(count);
  });

  it("调度器没启用：任务可管理，列表标明 disabled，立即运行被拒", async () => {
    const { runtime, ws } = await setup([], false);
    const task = await runtime.saveSchedule({
      name: "n",
      prompt: "p",
      workspace: ws,
      model: "fake/fake-1",
      schedule: { type: "daily", time: "09:00" },
    });
    const listed = await runtime.listSchedules();
    expect(listed.scheduler).toEqual({ running: false, reason: "disabled" });
    expect(listed.tasks[0]?.nextRunAt).toBeDefined();
    await expect(runtime.runSchedule({ id: task.id })).rejects.toMatchObject({
      field: "scheduler",
    });
  });

  it("启用调度器时拿锁；停止后释放", async () => {
    const { runtime, home } = await setup([]);
    expect((await runtime.listSchedules()).scheduler).toEqual({ running: true });
    expect(existsSync(path.join(home, "schedules", "scheduler.lock"))).toBe(true);
    await runtime.stopScheduler();
    expect(existsSync(path.join(home, "schedules", "scheduler.lock"))).toBe(false);
  });
});
