/**
 * 调度器（ADR-0064 第 1、3、4 节，schedule.md）。
 * 独立于 Agent Loop 和 UI：到点时通过注入的 `runner` 开会话并提交指令，
 * 调度器只管计划、错过补跑、跳过规则、时长上限、历史和单调度器锁。
 * 时间和计时器都经 `clock` 注入，测试用假时钟推进。
 */
import { randomUUID } from "node:crypto";

import { acquireSessionLock, SessionError, type SessionLock } from "../session/index.js";
import type { Platform } from "../platform/index.js";
import {
  SCHEDULE_CATCHUP_DAYS,
  SCHEDULE_MAX_CONCURRENT,
  type ScheduleChangedPayload,
  type ScheduleHistoryEntry,
  type ScheduleListResult,
  type ScheduleRunNowResult,
  type ScheduleSaveInput,
  type ScheduleSchedulerStatus,
  type ScheduleSkipReason,
  type ScheduledTask,
  type ScheduleTaskOverview,
  type ScheduleTrigger,
} from "../protocol/index.js";
import { firesBetween, nextFire, ScheduleError, type PlanContext } from "./plan.js";
import type { ScheduleStore, StoredTask } from "./store.js";
import { createZone, type Zone } from "./zone.js";

const MINUTE = 60_000;
const DAY = 86_400_000;
/** 检查间隔 */
const TICK_MS = MINUTE;
/** 晚于计划时间超过它就按补跑处理，并在原计划时间前加说明 */
const CATCHUP_GRACE_MS = 2 * MINUTE;
/** 一次检查最多写多少条「错过」记录（更早的丢弃，不再逐条记） */
const MAX_MISSED_ROWS = 20;
/** 停止调度器时等待运行结束的上限 */
const STOP_WAIT_MS = 5_000;

export interface ScheduleClock {
  now(): number;
  setInterval(fn: () => void, ms: number): () => void;
  setTimeout(fn: () => void, ms: number): () => void;
}

export const realClock: ScheduleClock = {
  now: () => Date.now(),
  setInterval(fn, ms) {
    const timer = setInterval(fn, ms);
    timer.unref();
    return () => {
      clearInterval(timer);
    };
  },
  setTimeout(fn, ms) {
    const timer = setTimeout(fn, ms);
    timer.unref();
    return () => {
      clearTimeout(timer);
    };
  },
};

export interface RunContext {
  trigger: ScheduleTrigger;
  /** 原计划时间（UTC 毫秒）；手动运行为触发时刻 */
  scheduledAt: number;
  /** 超时或调度器停止时中止；runner 应据此中断会话的这一轮 */
  signal: AbortSignal;
  /** 会话建好后调用，历史行据此记下会话 id */
  onSession(sessionId: string): void;
}

export interface RunOutcome {
  result: "done" | "error" | "aborted";
  error?: string | undefined;
  /** 运行中因无人值守被拒绝的操作数 */
  denied?: number | undefined;
}

/** 由 createRuntime 装配：开会话、提交指令、等这一轮结束 */
export interface ScheduleRunner {
  run(task: ScheduledTask, ctx: RunContext): Promise<RunOutcome>;
}

export interface SchedulerOptions {
  platform: Platform;
  /** NOCTURNE_HOME */
  home: string;
  store: ScheduleStore;
  runner: ScheduleRunner;
  /** 是否在本进程里调度（`RuntimeOptions.scheduler`）；false 时只能管理任务 */
  enabled: boolean;
  clock?: ScheduleClock | undefined;
  zone?: Zone | undefined;
  /** 列表、状态变化时通知（`schedule.changed`） */
  onChanged?: ((payload: ScheduleChangedPayload) => void) | undefined;
  warn?: ((code: string, message: string) => void) | undefined;
}

interface ActiveRun {
  taskId: string;
  entryId: string;
  controller: AbortController;
  sessionReady: Promise<string | undefined>;
  done: Promise<void>;
}

export function createScheduler(options: SchedulerOptions) {
  const { platform, home, store, runner } = options;
  const { fs, paths } = platform;
  const clock = options.clock ?? realClock;
  const zone = options.zone ?? createZone();
  const warn = options.warn ?? (() => undefined);
  const emit = (taskId?: string): void =>
    options.onChanged?.(taskId !== undefined ? { taskId } : {});
  const lockPath = paths.join(home, "schedules", "scheduler.lock");

  let lock: SessionLock | undefined;
  let stopTimer: (() => void) | undefined;
  let lockedByOther = false;
  let ticking = false;
  const runs = new Map<string, ActiveRun>();
  /** 每个任务已处理到的计划时间（UTC 毫秒） */
  const cursors = new Map<string, number>();

  const active = (): boolean => lock !== undefined;

  function status(): ScheduleSchedulerStatus {
    if (active()) return { running: true };
    return { running: false, reason: options.enabled && lockedByOther ? "locked" : "disabled" };
  }

  const planContext = (task: StoredTask): PlanContext => ({
    zone,
    anchor: Date.parse(task.anchorAt),
  });

  async function cursorOf(task: StoredTask): Promise<number> {
    const cached = cursors.get(task.id);
    if (cached !== undefined) return cached;
    let cursor = Date.parse(task.anchorAt);
    for (const entry of await store.history(task.id))
      if (entry.trigger !== "manual") cursor = Math.max(cursor, Date.parse(entry.scheduledAt));
    cursors.set(task.id, cursor);
    return cursor;
  }

  /** 任务已被删除就不再写历史（免得重建它的历史文件） */
  async function record(
    taskId: string,
    row: Parameters<ScheduleStore["appendHistory"]>[1],
  ): Promise<void> {
    await store.appendHistory(taskId, row, { requireTask: true });
  }

  async function skip(
    task: StoredTask,
    scheduledAt: number,
    trigger: ScheduleTrigger,
    reason: ScheduleSkipReason,
  ): Promise<void> {
    await record(task.id, {
      id: `${scheduledAt.toString(36)}-${randomUUID().slice(0, 6)}`,
      scheduledAt: new Date(scheduledAt).toISOString(),
      trigger,
      result: "skipped",
      reason,
    });
    emit(task.id);
  }

  /**
   * 同一任务上一次还在运行、或同时运行的任务已满时跳过（返回原因，调用方写历史）；
   * 否则登记并启动一次运行。登记是同步的，同一次检查里不会超卖名额。
   */
  function launch(
    task: StoredTask,
    scheduledAt: number,
    trigger: ScheduleTrigger,
  ): ActiveRun | Exclude<ScheduleSkipReason, "missed"> {
    if (runs.has(task.id)) return "previous_running";
    if (runs.size >= SCHEDULE_MAX_CONCURRENT) return "concurrency";
    const entryId = `${scheduledAt.toString(36)}-${randomUUID().slice(0, 6)}`;
    const controller = new AbortController();
    let resolveSession!: (id: string | undefined) => void;
    const sessionReady = new Promise<string | undefined>((resolve) => {
      resolveSession = resolve;
    });
    const startedAt = clock.now();
    const run: ActiveRun = {
      taskId: task.id,
      entryId,
      controller,
      sessionReady,
      done: Promise.resolve(),
    };
    runs.set(task.id, run);
    run.done = (async () => {
      const base = {
        id: entryId,
        scheduledAt: new Date(scheduledAt).toISOString(),
        trigger,
      };
      // 对象字段：计时器回调里置位，避免被当成恒为 false 的局部变量
      const flags = { timedOut: false };
      const cancelTimer = clock.setTimeout(() => {
        flags.timedOut = true;
        controller.abort("max_duration");
      }, task.maxDurationMinutes * MINUTE);
      let sessionId: string | undefined;
      // 「拿到会话」那一行必须先于结束行落盘，否则合并时会把结果盖回 running
      let sessionRow: Promise<void> = Promise.resolve();
      try {
        await record(task.id, {
          ...base,
          result: "running",
          startedAt: new Date(startedAt).toISOString(),
        });
        emit(task.id);
        let outcome: RunOutcome;
        try {
          outcome = await runner.run(task, {
            trigger,
            scheduledAt,
            signal: controller.signal,
            onSession(id) {
              sessionId = id;
              resolveSession(id);
              sessionRow = record(task.id, { ...base, result: "running", sessionId: id })
                .then(() => {
                  emit(task.id);
                })
                .catch(() => undefined);
            },
          });
        } catch (e) {
          outcome = {
            result: "error",
            error: e instanceof Error && e.message !== "" ? e.message.slice(0, 200) : "run_failed",
          };
        }
        const stopping = controller.signal.aborted && !flags.timedOut;
        const result = flags.timedOut || stopping ? "aborted" : outcome.result;
        const error = flags.timedOut ? "max_duration" : stopping ? "stopped" : outcome.error;
        const endedAt = clock.now();
        await sessionRow;
        cancelTimer();
        runs.delete(task.id);
        await record(task.id, {
          ...base,
          result,
          ...(error !== undefined ? { error } : {}),
          ...(sessionId !== undefined ? { sessionId } : {}),
          endedAt: new Date(endedAt).toISOString(),
          durationMs: endedAt - startedAt,
          ...(outcome.denied !== undefined && outcome.denied > 0 ? { denied: outcome.denied } : {}),
        });
      } catch (e) {
        warn(
          "schedule_history_failed",
          `写入定时任务历史失败：${e instanceof Error ? e.message : String(e)}`,
        );
      } finally {
        cancelTimer();
        resolveSession(sessionId);
        runs.delete(task.id);
        emit(task.id);
      }
    })();
    return run;
  }

  /** 处理一个任务在 (游标, now] 内到期的计划时间 */
  async function checkTask(task: StoredTask, now: number): Promise<void> {
    if (!task.enabled || task.schedule.type === "manual") return;
    const cursor = await cursorOf(task);
    const planned = firesBetween(
      task.schedule,
      Math.max(cursor, now - SCHEDULE_CATCHUP_DAYS * DAY),
      now,
      planContext(task),
    );
    const latest = planned.at(-1);
    if (latest === undefined) return;
    cursors.set(task.id, latest);
    for (const missed of planned.slice(0, -1).slice(-MAX_MISSED_ROWS))
      await skip(task, missed, "schedule", "missed");
    const trigger: ScheduleTrigger = now - latest > CATCHUP_GRACE_MS ? "catchup" : "schedule";
    const result = launch(task, latest, trigger);
    if (typeof result === "string") await skip(task, latest, trigger, result);
  }

  async function tick(): Promise<void> {
    if (!active() || ticking) return;
    ticking = true;
    try {
      // 每次检查都评估 (游标, 此刻]：启动、睡眠恢复后的第一次检查自然就是补跑检查，
      // 不需要单独检测墙钟跳变（schedule.md 第 5 节）
      const now = clock.now();
      for (const task of await store.list()) {
        try {
          await checkTask(task, now);
        } catch (e) {
          warn(
            "schedule_check_failed",
            `检查定时任务 ${task.name} 失败：${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
    } finally {
      ticking = false;
    }
  }

  /** 进程在运行中退出留下的「运行中」行：补一行已中断 */
  async function recoverStaleRuns(): Promise<void> {
    for (const task of await store.list()) {
      for (const entry of await store.history(task.id)) {
        if (entry.result !== "running") continue;
        await store.appendHistory(task.id, {
          id: entry.id,
          scheduledAt: entry.scheduledAt,
          result: "aborted",
          error: "process_exited",
          endedAt: new Date(clock.now()).toISOString(),
        });
      }
    }
  }

  async function start(): Promise<ScheduleSchedulerStatus> {
    if (!options.enabled || active()) return status();
    await fs.mkdir(paths.dirname(lockPath), { mode: 0o700 });
    try {
      lock = await acquireSessionLock(fs, platform, lockPath);
    } catch (e) {
      if (!(e instanceof SessionError) || e.code !== "session_locked") throw e;
      lockedByOther = true;
      warn(
        "schedule_locked",
        "另一个 Nocturne 正在调度定时任务，本进程不会触发任务；任务仍可以编辑",
      );
      return status();
    }
    lockedByOther = false;
    await recoverStaleRuns();
    // 启动时先检查一次（补跑），再按固定间隔检查
    await tick();
    stopTimer = clock.setInterval(() => {
      void tick();
    }, TICK_MS);
    return status();
  }

  async function stop(): Promise<void> {
    stopTimer?.();
    stopTimer = undefined;
    const held = lock;
    if (held === undefined) return;
    lock = undefined;
    const pending = [...runs.values()];
    for (const run of pending) run.controller.abort("stopped");
    await new Promise<void>((resolve) => {
      const cancel = clock.setTimeout(resolve, STOP_WAIT_MS);
      void Promise.allSettled(pending.map((run) => run.done)).then(() => {
        cancel();
        resolve();
      });
    });
    await held.release();
  }

  // ── 管理接口（Runtime.schedule） ──

  async function overview(task: StoredTask): Promise<ScheduleTaskOverview> {
    const now = clock.now();
    const entries = await store.history(task.id);
    const since = now - SCHEDULE_CATCHUP_DAYS * DAY;
    const recent = entries.filter((e) => Date.parse(e.scheduledAt) >= since);
    const finished = recent.filter(
      (e) => e.durationMs !== undefined && (e.result === "done" || e.result === "error"),
    );
    const next =
      task.enabled && task.schedule.type !== "manual"
        ? nextFire(task.schedule, now, planContext(task))
        : undefined;
    const lastRun = entries.find((e) => e.result !== "skipped");
    const { anchorAt: _anchorAt, ...rest } = task;
    return {
      ...rest,
      ...(next !== undefined ? { nextRunAt: new Date(next).toISOString() } : {}),
      ...(lastRun !== undefined ? { lastRun } : {}),
      running: runs.has(task.id) || (!active() && entries[0]?.result === "running"),
      stats: {
        last7Days: {
          runs: recent.filter((e) => e.result !== "skipped").length,
          skipped: recent.filter((e) => e.result === "skipped").length,
        },
        ...(finished.length > 0
          ? {
              averageDurationMs: Math.round(
                finished.reduce((sum, e) => sum + (e.durationMs ?? 0), 0) / finished.length,
              ),
            }
          : {}),
      },
    };
  }

  return {
    status,
    start,
    stop,
    tick,
    /** 测试与诊断用：正在运行的任务数 */
    activeRuns: () => runs.size,

    async list(): Promise<ScheduleListResult> {
      const tasks = await store.list();
      return {
        tasks: await Promise.all(tasks.map(overview)),
        scheduler: status(),
        warnings: [...store.warnings],
      };
    },

    async save(input: ScheduleSaveInput): Promise<ScheduleTaskOverview> {
      const saved = await store.save(input);
      cursors.delete(saved.id);
      emit(saved.id);
      return overview(saved);
    },

    async remove(id: string): Promise<boolean> {
      const removed = await store.remove(id);
      cursors.delete(id);
      // 正在运行的那次不打断：它是一个普通会话，结束后历史行写不进已删除的任务也无妨
      if (removed) emit(id);
      return removed;
    },

    async runNow(id: string): Promise<ScheduleRunNowResult> {
      const task = await store.get(id);
      if (task === undefined) throw new ScheduleError("id", `任务不存在：${id}`);
      if (!active())
        throw new ScheduleError(
          "scheduler",
          status().reason === "locked"
            ? "另一个 Nocturne 正在调度定时任务，请在那个窗口里运行"
            : "定时任务只在桌面端打开时运行",
        );
      const now = clock.now();
      const result = launch(task, now, "manual");
      if (typeof result === "string") {
        await skip(task, now, "manual", result);
        return { started: false, reason: result };
      }
      const sessionId = await result.sessionReady;
      if (sessionId === undefined) {
        const failed = (await store.history(task.id)).find((e) => e.id === result.entryId);
        throw new ScheduleError("run", `运行没有开始：${failed?.error ?? "未能创建会话"}`);
      }
      return { started: true, sessionId };
    },

    history: (id: string): Promise<ScheduleHistoryEntry[]> => store.history(id),
  };
}

export type Scheduler = ReturnType<typeof createScheduler>;
