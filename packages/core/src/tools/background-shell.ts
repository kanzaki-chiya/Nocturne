import { randomUUID } from "node:crypto";
import type { Platform, ShellSpawnOptions, SpawnedProcess } from "../platform/index.js";
import { truncateModelContent } from "./budget.js";
import {
  effectiveEvents,
  type DurableEvent,
  type PreparedInput,
  type BackgroundShellResult,
} from "../protocol/index.js";

import type { BackgroundShellTask } from "../protocol/background-shell.js";
export type { BackgroundShellTask } from "../protocol/background-shell.js";
export function shellResultInput(meta: BackgroundShellResult, text: string): PreparedInput {
  return {
    backgroundShell: meta,
    content: [
      {
        type: "text",
        text: `<shell-result id="${meta.taskId}" status="${meta.status}" exit="${meta.exitCode ?? ""}">\n${text}\n</shell-result>`,
      },
    ],
    appended: [],
  };
}

interface Job {
  task: BackgroundShellTask;
  process: SpawnedProcess;
  cursor: number;
  writes: Promise<void>;
  settled: Promise<void>;
  discard: boolean;
  stopSource?: "user" | "model";
  updateTimer?: ReturnType<typeof setTimeout>;
  updatedAt: number;
}

/** 客户端观察者使用绝对字符偏移，与模型读取游标和预算无关。 */
export function observerOutput(task: BackgroundShellTask, text: string, offset?: number) {
  const end = text.length;
  const start = Math.max(Math.min(offset ?? 0, end), end - 200000);
  return {
    task: { ...task, outputChars: end },
    text: text.slice(start),
    start,
    end,
    durationMs: Math.max(
      0,
      Date.parse(task.endedAt ?? new Date().toISOString()) - Date.parse(task.startedAt),
    ),
  };
}
export interface ShellStart {
  command: string;
  name?: string | undefined;
  cwd: string;
  callId: string;
  timeoutMs?: number | undefined;
  shell?: ShellSpawnOptions["shell"];
  envStrip?: readonly string[] | undefined;
}

/** 会话持有的进程与日志；不绑定 Turn 的中止信号。 */
export class BackgroundShells {
  private readonly jobs = new Map<string, Job>();
  private closed = false;
  private readonly unsettled = new Set<string>();

  count(): number {
    return this.unsettled.size;
  }
  constructor(
    private readonly options: {
      platform: Platform;
      sessionsDir: string;
      sessionId: string;
      deliver?: (input: PreparedInput) => Promise<void>;
      updated?: (task: BackgroundShellTask) => void;
      settled?: () => void;
      stopped?: (
        result: BackgroundShellResult & { status: "killed"; source: "user" | "model" },
      ) => Promise<void>;
    },
  ) {}

  async start(input: ShellStart): Promise<{ taskId: string; logPath: string; background: true }> {
    if (this.closed) throw new Error("Background commands are closed");
    const { platform, sessionsDir, sessionId } = this.options;
    const taskId = randomUUID();
    const directory = platform.paths.join(sessionsDir, `${sessionId}.tasks`);
    await platform.fs.mkdir(directory);
    const logPath = platform.paths.join(directory, `${taskId}.log`);
    await platform.fs.createExclusive(logPath, "");
    const proc = platform.process.spawnShell(input.command, {
      cwd: input.cwd,
      timeoutMs: input.timeoutMs,
      shell: input.shell,
      envStrip: input.envStrip,
      env: { PYTHONUNBUFFERED: process.env.PYTHONUNBUFFERED ?? "1" },
    });
    if (proc.pid <= 0) {
      await proc.wait();
      throw new Error("Background command failed to start");
    }
    const task: BackgroundShellTask = {
      taskId,
      callId: input.callId,
      name: input.name?.length ? input.name : (input.command.split(/\r?\n/)[0] ?? input.command),
      command: input.command,
      logPath,
      status: "running",
      outputChars: 0,
      startedAt: new Date().toISOString(),
    };
    const job: Job = {
      task,
      process: proc,
      cursor: 0,
      writes: Promise.resolve(),
      settled: Promise.resolve(),
      discard: false,
      updatedAt: Date.now(),
    };
    this.jobs.set(taskId, job);
    this.unsettled.add(taskId);
    this.options.updated?.({ ...task });
    const notifyOutput = () => {
      if (job.discard || task.status !== "running" || job.updateTimer) return;
      job.updateTimer = setTimeout(
        () => {
          delete job.updateTimer;
          if (job.discard || task.status !== "running") return;
          if (Date.now() - job.updatedAt < 500) {
            notifyOutput();
            return;
          }
          job.updatedAt = Date.now();
          this.options.updated?.({ ...task });
        },
        Math.max(0, 500 - (Date.now() - job.updatedAt)),
      );
    };
    const pump = async (stream: AsyncIterable<string>) => {
      for await (const chunk of stream) {
        job.writes = job.writes.then(async () => {
          await platform.fs.appendFile(logPath, chunk);
          task.outputChars += chunk.length;
          if (chunk.length > 0) notifyOutput();
        });
        await job.writes;
      }
    };
    const pumps = Promise.all([pump(proc.stdout), pump(proc.stderr)]);
    void pumps.catch(() => undefined);
    job.settled = (async () => {
      try {
        const exit = await proc.wait();
        let timer: NodeJS.Timeout | undefined;
        try {
          const drained = await Promise.race([
            pumps.then(() => true),
            new Promise<boolean>((resolve) => {
              timer = setTimeout(() => {
                resolve(false);
              }, 500);
            }),
          ]);
          if (!drained) proc.detachOutput();
        } finally {
          if (timer) clearTimeout(timer);
        }
        await pumps;
        task.status = job.stopSource
          ? "killed"
          : exit.timedOut
            ? "timeout"
            : exit.killed
              ? "interrupted"
              : "exited";
        if (exit.code !== null) task.exitCode = exit.code;
        if (exit.signal !== null) task.signal = exit.signal;
      } catch {
        await proc.kill();
        task.status = "interrupted";
      }
      if (job.updateTimer) clearTimeout(job.updateTimer);
      delete job.updateTimer;
      task.endedAt = new Date().toISOString();
      if (job.discard) return;
      if (job.stopSource && task.status === "killed") {
        await this.options.stopped?.({
          ...this.result(task),
          status: "killed",
          source: job.stopSource,
        });
        this.options.updated?.({ ...task });
        return;
      }
      this.options.updated?.({ ...task });
      if (this.options.deliver) {
        await this.options.deliver(shellResultInput(this.result(task), await this.unreadTail(job)));
      }
    })().finally(() => {
      this.unsettled.delete(taskId);
      this.options.settled?.();
    });
    void job.settled.catch(() => undefined);
    return { taskId, logPath, background: true };
  }

  list(): BackgroundShellTask[] {
    return [...this.jobs.values()].map(({ task }) => ({ ...task }));
  }

  async output(
    id: string,
    since?: "start",
    consume = true,
  ): Promise<{ task: BackgroundShellTask; text: string; durationMs: number }> {
    const job = this.require(id);
    await job.writes;
    const text = await this.options.platform.fs.readTextFile(job.task.logPath);
    const unread = text.slice(since === "start" ? 0 : job.cursor);
    if (consume) job.cursor = text.length;
    const truncated = truncateModelContent(unread, 30000);
    return {
      task: { ...job.task },
      text: truncated.truncated ? `${truncated.text}\n${job.task.logPath}` : unread,
      durationMs: Math.max(
        0,
        Date.parse(job.task.endedAt ?? new Date().toISOString()) - Date.parse(job.task.startedAt),
      ),
    };
  }

  async observe(id: string, offset?: number) {
    const job = this.require(id);
    await job.writes;
    const text = await this.options.platform.fs.readTextFile(job.task.logPath);
    return observerOutput(job.task, text, offset);
  }

  async kill(id: string, source: "user" | "model" = "model"): Promise<PreparedInput> {
    const job = this.require(id);
    if (job.task.status !== "running" || job.stopSource)
      throw new Error("Background command is not running");
    job.stopSource = source;
    await job.process.kill();
    await job.settled;
    return shellResultInput(
      this.result(job.task),
      source === "model" ? await this.unreadTail(job) : "",
    );
  }

  async discard(keep?: ReadonlySet<string>): Promise<void> {
    if (keep === undefined) this.closed = true;
    const jobs = [...this.jobs.values()].filter((job) => !keep?.has(job.task.callId));
    for (const job of jobs) job.discard = true;
    await Promise.all(
      jobs.map(async (job) => {
        if (job.task.status === "running") await job.process.kill();
        await job.settled;
      }),
    );
    for (const job of jobs) this.jobs.delete(job.task.taskId);
  }

  async settled(): Promise<void> {
    await Promise.all([...this.jobs.values()].map((job) => job.settled));
  }

  recover(log: readonly DurableEvent[], afterSeq = 0): PreparedInput[] {
    const events = effectiveEvents(log);
    const delivered = new Set(
      events.flatMap((event) =>
        event.type === "shell.result_discarded" || event.type === "shell.task_stopped"
          ? [event.payload.callId]
          : event.type === "message.user" && event.payload.backgroundShell
            ? [event.payload.backgroundShell.callId]
            : [],
      ),
    );
    return events.flatMap((event) => {
      if (
        event.seq <= afterSeq ||
        event.type !== "tool.completed" ||
        event.payload.name !== "shell" ||
        delivered.has(event.payload.callId)
      )
        return [];
      const output = event.payload.output as
        { background?: unknown; taskId?: unknown; logPath?: unknown } | undefined;
      if (output?.background !== true || typeof output.taskId !== "string") return [];
      return [
        shellResultInput(
          {
            taskId: output.taskId,
            callId: event.payload.callId,
            status: "interrupted",
            name: (() => {
              const started = events.find(
                (item) =>
                  item.type === "tool.started" && item.payload.callId === event.payload.callId,
              );
              const input =
                started?.type === "tool.started"
                  ? (started.payload.input as { name?: string; command?: string })
                  : undefined;
              return input?.name?.length
                ? input.name
                : (input?.command?.split(/\r?\n/)[0] ?? output.taskId);
            })(),
          },
          typeof output.logPath === "string" ? output.logPath : "",
        ),
      ];
    });
  }

  private result(task: BackgroundShellTask): BackgroundShellResult {
    if (task.status === "running") throw new Error("Background command is still running");
    return {
      taskId: task.taskId,
      callId: task.callId,
      name: task.name,
      status: task.status,
      ...(task.exitCode !== undefined ? { exitCode: task.exitCode } : {}),
      ...(task.signal !== undefined ? { signal: task.signal } : {}),
    };
  }

  private async unreadTail(job: Job): Promise<string> {
    const text = await this.options.platform.fs.readTextFile(job.task.logPath);
    const unread = text.slice(job.cursor);
    job.cursor = text.length;
    return unread.length > 28000 ? `${unread.slice(-28000)}\n${job.task.logPath}` : unread;
  }

  private require(id: string): Job {
    const job = this.jobs.get(id);
    if (!job) throw new Error("Unknown background command in this session");
    return job;
  }
}
