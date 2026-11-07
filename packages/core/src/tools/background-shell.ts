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
  constructor(
    private readonly options: {
      platform: Platform;
      sessionsDir: string;
      sessionId: string;
      deliver?: (input: PreparedInput) => Promise<void>;
      updated?: (task: BackgroundShellTask) => void;
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
      name: input.name ?? input.command.split(/\r?\n/)[0] ?? input.command,
      command: input.command,
      logPath,
      status: "running",
      startedAt: new Date().toISOString(),
    };
    const job: Job = {
      task,
      process: proc,
      cursor: 0,
      writes: Promise.resolve(),
      settled: Promise.resolve(),
      discard: false,
    };
    this.jobs.set(taskId, job);
    this.options.updated?.({ ...task });
    const pump = async (stream: AsyncIterable<string>) => {
      for await (const chunk of stream) {
        job.writes = job.writes.then(() => platform.fs.appendFile(logPath, chunk));
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
        task.status = exit.timedOut ? "timeout" : exit.killed ? "killed" : "exited";
        if (exit.code !== null) task.exitCode = exit.code;
        if (exit.signal !== null) task.signal = exit.signal;
      } catch {
        await proc.kill();
        task.status = "interrupted";
      }
      task.endedAt = new Date().toISOString();
      if (!job.discard) this.options.updated?.({ ...task });
      if (!job.discard && this.options.deliver) {
        const text = await this.options.platform.fs.readTextFile(task.logPath);
        const unread = text.slice(job.cursor);
        job.cursor = text.length;
        const tail = unread.length > 28000 ? `${unread.slice(-28000)}\n${task.logPath}` : unread;
        await this.options.deliver(
          shellResultInput(
            {
              taskId: task.taskId,
              callId: task.callId,
              status: task.status,
              ...(task.exitCode !== undefined ? { exitCode: task.exitCode } : {}),
              ...(task.signal !== undefined ? { signal: task.signal } : {}),
            },
            tail,
          ),
        );
      }
    })();
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

  async kill(id: string): Promise<void> {
    const job = this.require(id);
    if (job.task.status !== "running") throw new Error("Background command is not running");
    await job.process.kill();
    await job.settled;
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
        event.type === "message.user" && event.payload.backgroundShell
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
          { taskId: output.taskId, callId: event.payload.callId, status: "interrupted" },
          typeof output.logPath === "string" ? output.logPath : "",
        ),
      ];
    });
  }

  private require(id: string): Job {
    const job = this.jobs.get(id);
    if (!job) throw new Error("Unknown background command in this session");
    return job;
  }
}
