/**
 * 调度器（ADR-0064 验收）：到点触发、错过只补最近一次、7 天外丢弃、上一次未结束时跳过、
 * 并发上限、时长上限按中断结束、锁文件保证单调度器、历史与进程崩溃后的收尾。
 * 时间与计时器用假时钟推进，runner 用假实现；文件读写是真的（临时目录）。
 */
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createPlatform } from "../platform/index.js";
import type { ScheduleHistoryEntry, ScheduleSaveInput } from "../protocol/index.js";
import {
  createScheduler,
  type RunContext,
  type RunOutcome,
  type ScheduleClock,
  type Scheduler,
  type ScheduleRunner,
} from "./scheduler.js";
import { createScheduleStore } from "./store.js";
import { createZone } from "./zone.js";

const roots: string[] = [];
const toStop: Scheduler[] = [];
afterEach(async () => {
  for (const s of toStop.splice(0)) await s.stop().catch(() => undefined);
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
const tmp = (prefix: string): string => {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  roots.push(d);
  return d;
};

const at = (iso: string): number => Date.parse(iso);
const MINUTE = 60_000;

/** 假时钟：推进时按时间顺序触发到期的计时器 */
class FakeClock implements ScheduleClock {
  private timers: { id: number; at: number; fn: () => void; every?: number }[] = [];
  private seq = 0;
  constructor(public t: number) {}
  now = (): number => this.t;
  setInterval = (fn: () => void, ms: number): (() => void) => this.add(fn, ms, ms);
  setTimeout = (fn: () => void, ms: number): (() => void) => this.add(fn, ms);
  private add(fn: () => void, ms: number, every?: number): () => void {
    const id = ++this.seq;
    this.timers.push({ id, at: this.t + ms, fn, ...(every !== undefined ? { every } : {}) });
    return () => {
      this.timers = this.timers.filter((timer) => timer.id !== id);
    };
  }
  /** 把时间推到 target，途中到期的计时器依次触发 */
  async advanceTo(target: number): Promise<void> {
    for (;;) {
      const due = this.timers.filter((timer) => timer.at <= target).sort((a, b) => a.at - b.at)[0];
      if (due === undefined) break;
      this.t = due.at;
      if (due.every !== undefined) due.at += due.every;
      else this.timers = this.timers.filter((timer) => timer.id !== due.id);
      due.fn();
      await sleep(15);
    }
    this.t = target;
  }
  pending = (): number => this.timers.length;
  /** 直接跳到某个时刻，不触发计时器（模拟睡眠 / 长时间关闭）；之后手动 tick */
  jumpTo(target: number): void {
    this.t = target;
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function waitFor(cond: () => boolean | Promise<boolean>, what = "条件"): Promise<void> {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await sleep(5);
  }
  throw new Error(`等待超时：${what}`);
}

interface FakeCall {
  taskName: string;
  ctx: RunContext;
  sessionId: string;
  finish(outcome?: RunOutcome): void;
  fail(error: Error): void;
}

/** runner：每次运行挂起，直到测试调用 finish；`auto` 时立即按给定结果结束 */
function makeRunner(options: { auto?: RunOutcome; noSession?: boolean } = {}) {
  const calls: FakeCall[] = [];
  const runner: ScheduleRunner = {
    run(task, ctx) {
      return new Promise<RunOutcome>((resolve, reject) => {
        const call: FakeCall = {
          taskName: task.name,
          ctx,
          sessionId: `sess-${calls.length + 1}`,
          finish: (outcome = { result: "done" }) => resolve(outcome),
          fail: (error) => reject(error),
        };
        calls.push(call);
        if (options.noSession !== true) ctx.onSession(call.sessionId);
        if (options.auto !== undefined) resolve(options.auto);
        // 被中止时按中断结束，和真实 runner（interrupt 当前 Turn）一致
        ctx.signal.addEventListener("abort", () => resolve({ result: "aborted" }), { once: true });
      });
    },
  };
  return { runner, calls };
}

function setup(
  options: {
    start?: string;
    runner?: ScheduleRunner;
    enabled?: boolean;
    home?: string;
    zone?: string;
  } = {},
) {
  const home = options.home ?? tmp("nct-sched-home-");
  const workspace = tmp("nct-sched-ws-");
  const clock = new FakeClock(at(options.start ?? "2026-10-25T00:30:00Z"));
  const zone = createZone(options.zone ?? "Asia/Shanghai");
  const platform = createPlatform();
  const store = createScheduleStore({ platform, home, zone, now: clock.now });
  const fake = makeRunner();
  const warnings: string[] = [];
  const changed = vi.fn();
  const scheduler = createScheduler({
    platform,
    home,
    store,
    runner: options.runner ?? fake.runner,
    enabled: options.enabled ?? true,
    clock,
    zone,
    warn: (code, message) => warnings.push(`${code}:${message}`),
    onChanged: changed,
  });
  toStop.push(scheduler);
  const make = (patch: Partial<ScheduleSaveInput> = {}) =>
    store.save({
      name: "每日提交汇总",
      prompt: "汇总提交",
      workspace,
      schedule: { type: "daily", time: "09:00" },
      ...patch,
    });
  return { home, workspace, clock, store, scheduler, make, calls: fake.calls, warnings, changed };
}

const history = (s: ReturnType<typeof setup>, id: string): Promise<ScheduleHistoryEntry[]> =>
  s.store.history(id);

describe("到点触发", () => {
  it("到点前不触发；到点后触发一次，同一计划时间不会再触发", async () => {
    const s = setup();
    const task = await s.make();
    await s.scheduler.start();

    await s.clock.advanceTo(at("2026-10-25T00:59:30Z"));
    expect(s.calls).toHaveLength(0);

    await s.clock.advanceTo(at("2026-10-25T01:00:20Z"));
    await waitFor(() => s.calls.length === 1, "触发一次");
    expect(s.calls[0]?.ctx.trigger).toBe("schedule");
    expect(s.calls[0]?.ctx.scheduledAt).toBe(at("2026-10-25T01:00:00Z"));

    s.calls[0]?.finish();
    await waitFor(async () => (await history(s, task.id))[0]?.result === "done", "写入完成行");
    await s.clock.advanceTo(at("2026-10-25T01:03:00Z"));
    expect(s.calls).toHaveLength(1);

    const [entry] = await history(s, task.id);
    expect(entry).toMatchObject({
      trigger: "schedule",
      result: "done",
      sessionId: "sess-1",
      scheduledAt: "2026-10-25T01:00:00.000Z",
    });
    expect(entry?.durationMs).toBe(20_000);

    // 次日同一时刻再触发
    s.clock.jumpTo(at("2026-10-26T01:00:30Z"));
    await s.scheduler.tick();
    await waitFor(() => s.calls.length === 2, "次日触发");
    expect(s.calls[1]?.ctx.trigger).toBe("schedule");
  });

  it("已暂停和 manual 的任务不会自动触发", async () => {
    const s = setup();
    await s.make({ enabled: false });
    await s.make({ name: "手动", schedule: { type: "manual" } });
    await s.scheduler.start();
    await s.clock.advanceTo(at("2026-10-25T03:00:00Z"));
    expect(s.calls).toHaveLength(0);
  });

  it("每次检查之间的墙钟跳变（睡眠恢复）：醒来后的第一次检查补跑", async () => {
    const s = setup({ start: "2026-10-25T00:00:00Z" });
    const task = await s.make({ schedule: { type: "interval", minutes: 30 } });
    await s.scheduler.start();
    await s.clock.advanceTo(at("2026-10-25T00:31:00Z"));
    await waitFor(() => s.calls.length === 1, "第一次触发");
    s.calls[0]?.finish();
    await waitFor(async () => (await history(s, task.id))[0]?.result === "done");

    // 合盖睡了 4 小时：时钟直接跳过去，旧的计时器还在
    s.clock.t = at("2026-10-25T04:41:00Z");
    await s.scheduler.tick();
    await waitFor(() => s.calls.length === 2, "醒来后补跑一次");
    expect(s.calls[1]?.ctx.trigger).toBe("catchup");
    expect(s.calls[1]?.ctx.scheduledAt).toBe(at("2026-10-25T04:30:00Z"));
  });
});

describe("错过的运行", () => {
  it("启动时只补最近一次，更早的记为跳过（missed）", async () => {
    const s = setup();
    const task = await s.make();
    // 创建后一直没开，三天后才打开应用
    s.clock.t = at("2026-10-28T03:00:00Z");
    await s.scheduler.start();
    await waitFor(() => s.calls.length === 1, "补跑");
    expect(s.calls[0]?.ctx.trigger).toBe("catchup");
    expect(s.calls[0]?.ctx.scheduledAt).toBe(at("2026-10-28T01:00:00Z"));

    const rows = await history(s, task.id);
    const missed = rows.filter((r) => r.result === "skipped");
    expect(missed.map((r) => [r.scheduledAt, r.reason])).toEqual([
      ["2026-10-27T01:00:00.000Z", "missed"],
      ["2026-10-26T01:00:00.000Z", "missed"],
      ["2026-10-25T01:00:00.000Z", "missed"],
    ]);
    expect(rows.find((r) => r.result === "running")).toMatchObject({
      trigger: "catchup",
      scheduledAt: "2026-10-28T01:00:00.000Z",
    });

    // 再检查不会重复补跑
    s.calls[0]?.finish();
    await s.scheduler.tick();
    await sleep(30);
    expect(s.calls).toHaveLength(1);
  });

  it("只回看 7 天：更早的直接丢弃，不记录", async () => {
    const s = setup({ start: "2026-10-01T00:30:00Z" });
    const task = await s.make();
    s.clock.t = at("2026-10-28T03:00:00Z");
    await s.scheduler.start();
    await waitFor(() => s.calls.length === 1);
    const rows = await history(s, task.id);
    const days = rows.map((r) => r.scheduledAt.slice(0, 10)).sort();
    // 10-22 … 10-28 共 7 个计划时间：1 个补跑 + 6 个 missed；没有 10-21 及更早的
    expect(days).toEqual([
      "2026-10-22",
      "2026-10-23",
      "2026-10-24",
      "2026-10-25",
      "2026-10-26",
      "2026-10-27",
      "2026-10-28",
    ]);
    expect(rows.filter((r) => r.reason === "missed")).toHaveLength(6);
  });

  it("补跑的触发时间离计划不到 2 分钟时仍算 schedule（刚好在打开应用时到点）", async () => {
    const s = setup();
    await s.make();
    s.clock.t = at("2026-10-25T01:01:00Z");
    await s.scheduler.start();
    await waitFor(() => s.calls.length === 1);
    expect(s.calls[0]?.ctx.trigger).toBe("schedule");
  });

  it("暂停期间的计划时间不补跑；恢复时从恢复那一刻重新算", async () => {
    const s = setup();
    const task = await s.make({ enabled: false });
    s.clock.t = at("2026-10-27T03:00:00Z");
    await s.scheduler.start();
    await s.scheduler.tick();
    expect(s.calls).toHaveLength(0);
    // 恢复：起算时刻重置成现在，之前的 09:00 不算错过
    await s.store.save({
      id: task.id,
      name: task.name,
      prompt: task.prompt,
      workspace: task.workspace,
      schedule: task.schedule,
      enabled: true,
    });
    await s.scheduler.tick();
    await sleep(30);
    expect(s.calls).toHaveLength(0);
    s.clock.jumpTo(at("2026-10-28T01:00:30Z"));
    await s.scheduler.tick();
    await waitFor(() => s.calls.length === 1);
  });

  it("新建任务时已经过了今天的时间点：今天不补", async () => {
    const s = setup({ start: "2026-10-25T05:00:00Z" });
    await s.make();
    await s.scheduler.start();
    await sleep(30);
    expect(s.calls).toHaveLength(0);
  });
});

describe("跳过规则", () => {
  it("上一次还在运行：本次跳过并记 previous_running，不排队", async () => {
    const s = setup({ start: "2026-10-25T00:00:00Z" });
    const task = await s.make({ schedule: { type: "interval", minutes: 30 } });
    await s.scheduler.start();
    await s.clock.advanceTo(at("2026-10-25T00:31:00Z"));
    await waitFor(() => s.calls.length === 1);

    // 第一次还没结束，下一个计划时间到了
    await s.clock.advanceTo(at("2026-10-25T01:01:00Z"));
    await waitFor(async () => (await history(s, task.id)).some((r) => r.result === "skipped"));
    expect(s.calls).toHaveLength(1);
    const skipped = (await history(s, task.id)).find((r) => r.result === "skipped");
    expect(skipped).toMatchObject({
      reason: "previous_running",
      trigger: "schedule",
      scheduledAt: "2026-10-25T01:00:00.000Z",
    });
    expect(skipped?.sessionId).toBeUndefined();

    // 结束后下一个计划时间正常触发
    s.calls[0]?.finish();
    await waitFor(() => s.scheduler.activeRuns() === 0);
    await s.clock.advanceTo(at("2026-10-25T01:31:00Z"));
    await waitFor(() => s.calls.length === 2);
  });

  it("同时运行的定时任务最多 2 个，超出的跳过并记 concurrency", async () => {
    const s = setup();
    const a = await s.make({ name: "A" });
    const b = await s.make({ name: "B" });
    const c = await s.make({ name: "C" });
    await s.scheduler.start();
    await s.clock.advanceTo(at("2026-10-25T01:00:30Z"));
    await waitFor(() => s.calls.length === 2, "两个任务运行");
    await waitFor(
      async () =>
        (await Promise.all([a, b, c].map((t) => history(s, t.id))))
          .flat()
          .filter((r) => r.reason === "concurrency").length === 1,
      "第三个被跳过",
    );
    expect(s.calls.map((call) => call.taskName).sort()).toEqual(["A", "B"]);
    const skipped = (await history(s, c.id))[0];
    expect(skipped).toMatchObject({ result: "skipped", reason: "concurrency" });

    // 一个结束后名额释放：手动运行 C 能起
    s.calls[0]?.finish();
    await waitFor(() => s.scheduler.activeRuns() === 1);
    const result = await s.scheduler.runNow(c.id);
    expect(result).toMatchObject({ started: true });
  });

  it("手动运行同样受限：上一次未结束返回 previous_running，名额满返回 concurrency", async () => {
    const s = setup();
    const a = await s.make({ name: "A", schedule: { type: "manual" } });
    const b = await s.make({ name: "B", schedule: { type: "manual" } });
    const c = await s.make({ name: "C", schedule: { type: "manual" } });
    await s.scheduler.start();
    expect(await s.scheduler.runNow(a.id)).toMatchObject({ started: true });
    expect(await s.scheduler.runNow(a.id)).toEqual({ started: false, reason: "previous_running" });
    expect(await s.scheduler.runNow(b.id)).toMatchObject({ started: true });
    expect(await s.scheduler.runNow(c.id)).toEqual({ started: false, reason: "concurrency" });
    const skipped = (await history(s, c.id))[0];
    expect(skipped).toMatchObject({ result: "skipped", reason: "concurrency", trigger: "manual" });
  });
});

describe("立即运行", () => {
  it("trigger 为 manual，不改动计划的下一次时间，也不影响当天的计划触发", async () => {
    const s = setup({ start: "2026-10-25T00:00:00Z" });
    const task = await s.make();
    await s.scheduler.start();
    const before = (await s.scheduler.list()).tasks[0]?.nextRunAt;
    expect(before).toBe("2026-10-25T01:00:00.000Z");

    const started = await s.scheduler.runNow(task.id);
    expect(started).toEqual({ started: true, sessionId: "sess-1" });
    expect(s.calls[0]?.ctx.trigger).toBe("manual");
    s.calls[0]?.finish();
    await waitFor(() => s.scheduler.activeRuns() === 0);

    expect((await s.scheduler.list()).tasks[0]?.nextRunAt).toBe(before);
    await s.clock.advanceTo(at("2026-10-25T01:00:30Z"));
    await waitFor(() => s.calls.length === 2);
    expect(s.calls[1]?.ctx.trigger).toBe("schedule");
  });

  it("manual 计划的任务可以运行；任务不存在时报错", async () => {
    const s = setup();
    const task = await s.make({ schedule: { type: "manual" } });
    await s.scheduler.start();
    expect(await s.scheduler.runNow(task.id)).toMatchObject({ started: true });
    await expect(s.scheduler.runNow("nope")).rejects.toThrow("任务不存在");
  });

  it("会话没建成就失败：抛出原因，历史记 error", async () => {
    const failing: ScheduleRunner = {
      run: () => Promise.reject(new Error("no_model")),
    };
    const s = setup({ runner: failing });
    const task = await s.make({ schedule: { type: "manual" } });
    await s.scheduler.start();
    await expect(s.scheduler.runNow(task.id)).rejects.toThrow("no_model");
    await waitFor(async () => (await history(s, task.id))[0]?.result === "error");
    expect((await history(s, task.id))[0]).toMatchObject({ result: "error", error: "no_model" });
  });
});

describe("时长上限", () => {
  it("到点按中断结束这一轮，历史记 aborted（max_duration）", async () => {
    const s = setup();
    const task = await s.make({ schedule: { type: "manual" }, maxDurationMinutes: 5 });
    await s.scheduler.start();
    await s.scheduler.runNow(task.id);
    const call = s.calls[0] as FakeCall;
    expect(call.ctx.signal.aborted).toBe(false);

    await s.clock.advanceTo(s.clock.t + 4 * MINUTE + 59_000);
    expect(call.ctx.signal.aborted).toBe(false);
    await s.clock.advanceTo(s.clock.t + 2_000);
    expect(call.ctx.signal.aborted).toBe(true);

    await waitFor(async () => (await history(s, task.id))[0]?.result === "aborted");
    expect((await history(s, task.id))[0]).toMatchObject({
      result: "aborted",
      error: "max_duration",
      durationMs: 5 * MINUTE,
    });
    expect(s.scheduler.activeRuns()).toBe(0);
  });

  it("缺省 60 分钟", async () => {
    const s = setup();
    const task = await s.make({ schedule: { type: "manual" } });
    expect(task.maxDurationMinutes).toBe(60);
    await s.scheduler.start();
    await s.scheduler.runNow(task.id);
    await s.clock.advanceTo(s.clock.t + 59 * MINUTE);
    expect(s.calls[0]?.ctx.signal.aborted).toBe(false);
    await s.clock.advanceTo(s.clock.t + 2 * MINUTE);
    expect(s.calls[0]?.ctx.signal.aborted).toBe(true);
  });

  it("按时结束的运行不会留下计时器", async () => {
    const s = setup();
    const task = await s.make({ schedule: { type: "manual" } });
    await s.scheduler.start();
    const before = s.clock.pending();
    await s.scheduler.runNow(task.id);
    s.calls[0]?.finish();
    await waitFor(() => s.scheduler.activeRuns() === 0);
    expect(s.clock.pending()).toBe(before);
  });
});

describe("结果记录", () => {
  it("runner 报告的错误码和被拒绝的操作数写进历史", async () => {
    const s = setup();
    const task = await s.make({ schedule: { type: "manual" } });
    await s.scheduler.start();
    await s.scheduler.runNow(task.id);
    s.calls[0]?.finish({ result: "done", denied: 2 });
    await waitFor(async () => (await history(s, task.id))[0]?.result === "done");
    expect((await history(s, task.id))[0]).toMatchObject({ result: "done", denied: 2 });

    await s.scheduler.runNow(task.id);
    s.calls[1]?.finish({ result: "error", error: "stream_timeout" });
    await waitFor(async () => (await history(s, task.id))[0]?.result === "error");
    expect((await history(s, task.id))[0]).toMatchObject({
      result: "error",
      error: "stream_timeout",
    });
    expect((await history(s, task.id))[0]?.denied).toBeUndefined();
  });

  it("runner 抛错记为 error，不影响后续运行", async () => {
    const s = setup();
    const task = await s.make({ schedule: { type: "manual" } });
    await s.scheduler.start();
    await s.scheduler.runNow(task.id);
    s.calls[0]?.fail(new Error("boom"));
    await waitFor(async () => (await history(s, task.id))[0]?.result === "error");
    expect((await history(s, task.id))[0]?.error).toBe("boom");
    expect(await s.scheduler.runNow(task.id)).toMatchObject({ started: true });
  });

  it("list：下次运行、上次结果、是否在运行、最近 7 天统计与平均用时", async () => {
    const s = setup({ start: "2026-10-25T00:00:00Z" });
    const task = await s.make({ schedule: { type: "manual" } });
    await s.scheduler.start();
    await s.scheduler.runNow(task.id);
    await s.clock.advanceTo(s.clock.t + 2 * MINUTE);
    expect((await s.scheduler.list()).tasks[0]).toMatchObject({ running: true });
    s.calls[0]?.finish();
    await waitFor(async () => (await history(s, task.id))[0]?.result === "done");

    await s.scheduler.runNow(task.id);
    await s.clock.advanceTo(s.clock.t + 4 * MINUTE);
    s.calls[1]?.finish({ result: "error", error: "x" });
    await waitFor(async () => (await history(s, task.id))[0]?.result === "error");
    // 一次被占用的跳过
    await s.scheduler.runNow(task.id);
    await s.scheduler.runNow(task.id);

    const listed = await s.scheduler.list();
    const overview = listed.tasks[0];
    expect(listed.scheduler).toEqual({ running: true });
    expect(overview?.nextRunAt).toBeUndefined();
    expect(overview?.running).toBe(true);
    expect(overview?.stats.last7Days).toEqual({ runs: 3, skipped: 1 });
    expect(overview?.stats.averageDurationMs).toBe(3 * MINUTE);
    expect(overview?.lastRun?.result).toBe("running");
    expect(overview).not.toHaveProperty("anchorAt");
  });

  it("下次运行：暂停的任务没有", async () => {
    const s = setup({ start: "2026-10-25T00:00:00Z" });
    await s.make({ enabled: false });
    const [task] = (await s.scheduler.list()).tasks;
    expect(task?.nextRunAt).toBeUndefined();
  });

  it("保存、删除、运行状态变化都发 schedule.changed", async () => {
    const s = setup();
    s.changed.mockClear();
    const saved = await s.scheduler.save({
      name: "n",
      prompt: "p",
      schedule: { type: "manual" },
    });
    expect(s.changed).toHaveBeenLastCalledWith({ taskId: saved.id });
    await s.scheduler.start();
    s.changed.mockClear();
    await s.scheduler.runNow(saved.id);
    expect(s.changed).toHaveBeenCalled();
    s.calls[0]?.finish();
    await waitFor(() => s.scheduler.activeRuns() === 0);
    s.changed.mockClear();
    expect(await s.scheduler.remove(saved.id)).toBe(true);
    expect(s.changed).toHaveBeenCalledWith({ taskId: saved.id });
  });

  it("删除任务时它还在运行：历史文件不会被重建", async () => {
    const s = setup();
    const task = await s.make({ schedule: { type: "manual" } });
    await s.scheduler.start();
    await s.scheduler.runNow(task.id);
    await s.scheduler.remove(task.id);
    s.calls[0]?.finish();
    await waitFor(() => s.scheduler.activeRuns() === 0);
    expect(existsSync(path.join(s.home, "schedules", "history", `${task.id}.jsonl`))).toBe(false);
  });
});

describe("单调度器锁", () => {
  it("同一个 home 下只有一个调度器：第二个拿不到锁，不触发任务，发警告，任务仍可编辑", async () => {
    const home = tmp("nct-sched-lock-");
    const first = setup({ home });
    const task = await first.make();
    expect(await first.scheduler.start()).toEqual({ running: true });

    const second = setup({ home, start: "2026-10-25T00:30:00Z" });
    expect(await second.scheduler.start()).toEqual({ running: false, reason: "locked" });
    expect(second.warnings.join()).toContain("schedule_locked");
    // 不触发
    await second.clock.advanceTo(at("2026-10-25T02:00:00Z"));
    expect(second.calls).toHaveLength(0);
    expect(second.clock.pending()).toBe(0);
    // 能读能改
    expect((await second.scheduler.list()).scheduler).toEqual({ running: false, reason: "locked" });
    expect((await second.scheduler.list()).tasks.map((t) => t.id)).toEqual([task.id]);
    const edited = await second.scheduler.save({
      id: task.id,
      name: "改过",
      prompt: "p",
      workspace: first.workspace,
      schedule: { type: "daily", time: "10:00" },
    });
    expect(edited.name).toBe("改过");
    await expect(second.scheduler.runNow(task.id)).rejects.toThrow("另一个 Nocturne");

    // 第一个释放后第二个可以接手
    await first.scheduler.stop();
    expect(existsSync(path.join(home, "schedules", "scheduler.lock"))).toBe(false);
    expect(await second.scheduler.start()).toEqual({ running: true });
  });

  it("上一个进程崩溃留下的陈旧锁会被接管", async () => {
    const home = tmp("nct-sched-stale-");
    const platform = createPlatform();
    mkdtempSync(path.join(home, "unused-"));
    const lockDir = path.join(home, "schedules");
    const fs = await import("node:fs");
    fs.mkdirSync(lockDir, { recursive: true });
    // 本机上一个不存在的 pid
    writeFileSync(
      path.join(lockDir, "scheduler.lock"),
      JSON.stringify({
        pid: 2_147_483_000,
        hostname: platform.hostname(),
        startedAt: Date.now(),
        token: "dead",
      }),
    );
    const s = setup({ home });
    expect(await s.scheduler.start()).toEqual({ running: true });
  });

  it("本进程没启用调度器：start 返回 disabled，不拿锁，不触发；任务可管理", async () => {
    const s = setup({ enabled: false });
    const task = await s.make();
    expect(await s.scheduler.start()).toEqual({ running: false, reason: "disabled" });
    await s.scheduler.tick();
    expect(existsSync(path.join(s.home, "schedules", "scheduler.lock"))).toBe(false);
    expect((await s.scheduler.list()).tasks).toHaveLength(1);
    await expect(s.scheduler.runNow(task.id)).rejects.toThrow("只在桌面端打开时运行");
  });
});

describe("启动与停止", () => {
  it("启动时把上个进程遗留的「运行中」行收尾为 aborted（process_exited）", async () => {
    const s = setup();
    const task = await s.make({ schedule: { type: "manual" } });
    await s.store.appendHistory(task.id, {
      id: "leftover",
      scheduledAt: "2026-10-25T00:10:00.000Z",
      trigger: "manual",
      result: "running",
      sessionId: "old-session",
    });
    await s.scheduler.start();
    expect((await history(s, task.id))[0]).toMatchObject({
      id: "leftover",
      result: "aborted",
      error: "process_exited",
      sessionId: "old-session",
    });
  });

  it("停止：中止正在运行的任务、等它们收尾、释放锁、不再检查", async () => {
    const s = setup();
    const task = await s.make({ schedule: { type: "manual" } });
    await s.scheduler.start();
    await s.scheduler.runNow(task.id);
    const stopping = s.scheduler.stop();
    await waitFor(() => s.calls[0]?.ctx.signal.aborted === true, "收到中止");
    await stopping;
    expect((await history(s, task.id))[0]).toMatchObject({ result: "aborted", error: "stopped" });
    expect(existsSync(path.join(s.home, "schedules", "scheduler.lock"))).toBe(false);
    expect(s.scheduler.status()).toMatchObject({ running: false });
    expect(s.clock.pending()).toBe(0);
  });

  it("停止后残留的目录里只有预期的文件", async () => {
    const s = setup();
    await s.make();
    await s.scheduler.start();
    await s.scheduler.stop();
    expect(readdirSync(path.join(s.home, "schedules"))).toEqual([]);
  });
});
