import { randomUUID } from "node:crypto";
import type { Platform, ShellSpawnOptions, SpawnedProcess } from "../platform/index.js";
import { truncateModelContent } from "./budget.js";

export interface BackgroundShellTask {
  taskId: string;
  callId: string;
  name: string;
  command: string;
  logPath: string;
  status: "running" | "exited" | "timeout" | "killed" | "interrupted";
  startedAt: string;
  endedAt?: string;
  exitCode?: number;
  signal?: string;
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
  constructor(private readonly options: {
    platform: Platform;
    sessionsDir: string;
    sessionId: string;
  }) {}

  async start(input: ShellStart): Promise<{ taskId: string; logPath: string; background: true }> {
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
      taskId, callId: input.callId, name: input.name ?? input.command.split(/\r?\n/)[0] ?? input.command,
      command: input.command, logPath, status: "running", startedAt: new Date().toISOString(),
    };
    const job: Job = { task, process: proc, cursor: 0, writes: Promise.resolve(), settled: Promise.resolve(), discard: false };
    this.jobs.set(taskId, job);
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
            new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), 500); }),
          ]);
          if (!drained) proc.detachOutput();
        } finally { if (timer) clearTimeout(timer); }
        await pumps;
        task.status = exit.timedOut ? "timeout" : exit.killed ? "killed" : "exited";
        if (exit.code !== null) task.exitCode = exit.code;
        if (exit.signal !== null) task.signal = exit.signal;
      } catch {
        await proc.kill();
        task.status = "interrupted";
      }
      task.endedAt = new Date().toISOString();
    })();
    return { taskId, logPath, background: true };
  }

  list(): BackgroundShellTask[] {
    return [...this.jobs.values()].map(({ task }) => ({ ...task }));
  }

  async output(id: string, since?: "start"): Promise<{ task: BackgroundShellTask; text: string; durationMs: number }> {
    const job = this.require(id);
    await job.writes;
    const text = await this.options.platform.fs.readTextFile(job.task.logPath);
    const unread = text.slice(since === "start" ? 0 : job.cursor);
    job.cursor = text.length;
    const truncated = truncateModelContent(unread, 30000);
    return {
      task: { ...job.task },
      text: truncated.truncated ? `${truncated.text}\n${job.task.logPath}` : unread,
      durationMs: Math.max(0, Date.parse(job.task.endedAt ?? new Date().toISOString()) - Date.parse(job.task.startedAt)),
    };
  }

  async kill(id: string): Promise<void> {
    const job = this.require(id);
    if (job.task.status !== "running") throw new Error("Background command is not running");
    await job.process.kill();
    await job.settled;
  }

  async discard(keep?: ReadonlySet<string>): Promise<void> {
    const jobs = [...this.jobs.values()].filter((job) => !keep?.has(job.task.callId));
    for (const job of jobs) job.discard = true;
    await Promise.all(jobs.map(async (job) => {
      if (job.task.status === "running") await job.process.kill();
      await job.settled;
    }));
    for (const job of jobs) this.jobs.delete(job.task.taskId);
  }

  async settled(): Promise<void> {
    await Promise.all([...this.jobs.values()].map((job) => job.settled));
  }

  private require(id: string): Job {
    const job = this.jobs.get(id);
    if (!job) throw new Error("Unknown background command in this session");
    return job;
  }
}
