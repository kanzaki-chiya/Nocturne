/**
 * 通知响铃（ADR-0056 §3）：判定规则（三类事件、开关、完成阈值、
 * 中断与恢复补写不响、只对实时事件）、终端焦点回送（失焦时三类事件
 * 各响一次 BEL、聚焦不响、从未回送按没在看）、退出关闭焦点报告。
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createPlatform,
  createRuntime,
  FakeProvider,
  loadConfig,
  type FakeScript,
  type Runtime,
  type RuntimeEvent,
  type RuntimeSession,
  type TurnEndReason,
} from "@nocturne/core";

import { runTui } from "../src/index.js";
import { FOCUS_DISABLE, FOCUS_ENABLE } from "../src/mouse.js";
import {
  BELL,
  NOTIFY_DEFAULTS,
  openTurnStarts,
  readNotifySettings,
  shouldRing,
  type NotifySettings,
} from "../src/notify.js";
import { APP_VERSION } from "../src/version.js";

const tmpRoots: string[] = [];
const tmp = (prefix: string) => {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
};
beforeEach(() => vi.stubEnv("NOCTURNE_HOME", tmp("nct-notify-home-")));
afterEach(() => {
  vi.unstubAllEnvs();
  for (const r of tmpRoots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function ttyPair() {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const stdout = new EventEmitter() as NodeJS.WriteStream;
  stdout.columns = 80;
  stdout.rows = 24;
  stdout.isTTY = true;
  stdout.write = ((chunk: string | Uint8Array) => {
    stdoutChunks.push(String(chunk));
    return true;
  }) as NodeJS.WriteStream["write"];
  const stderr = new EventEmitter() as NodeJS.WriteStream;
  stderr.write = ((chunk: string | Uint8Array) => {
    stderrChunks.push(String(chunk));
    return true;
  }) as NodeJS.WriteStream["write"];
  const stdin = new EventEmitter() as NodeJS.ReadStream & { write: (d: string) => void };
  stdin.isTTY = true;
  let pending: string | null = null;
  stdin.setRawMode = () => stdin;
  stdin.setEncoding = () => stdin;
  stdin.resume = () => stdin;
  stdin.pause = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;
  stdin.read = (() => {
    const data = pending;
    pending = null;
    return data;
  }) as NodeJS.ReadStream["read"];
  stdin.write = ((data: string) => {
    pending = data;
    stdin.emit("readable");
    stdin.emit("data", data);
    return true;
  }) as NodeJS.ReadStream["write"] & ((d: string) => void);
  return { stdin, stdout, stderr, stdoutChunks, stderrChunks };
}

async function openSession(
  scripts?: FakeScript[],
): Promise<{ runtime: Runtime; session: RuntimeSession }> {
  const root = mkdtempSync(path.join(tmpdir(), "nct-notify-ws-"));
  const sessionsDir = mkdtempSync(path.join(tmpdir(), "nct-notify-sd-"));
  tmpRoots.push(root, sessionsDir);
  const config = await loadConfig(createPlatform(), {
    nocturneHome: process.env.NOCTURNE_HOME,
    env: () => undefined,
  });
  const runtime = await createRuntime({
    cwd: root,
    sessionsDir,
    interactive: true,
    config,
    providers: [new FakeProvider({ scripts: scripts ?? [] })],
  });
  const session = await runtime.createSession({ model: "fake/fake-model" });
  return { runtime, session };
}

async function waitFor(check: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("waitFor 超时");
    await new Promise((r) => setTimeout(r, 20));
  }
}

const bellCount = (chunks: string[]): number => chunks.join("").split(BELL).length - 1;

// ── 判定规则（纯函数） ─────────────────────────────────────

const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);
const at = (seconds: number): string => new Date(T0 + seconds * 1000).toISOString();

function started(turnId = "t1"): RuntimeEvent {
  return {
    type: "turn.started",
    sessionId: "s",
    seq: 1,
    time: at(0),
    turnId,
    payload: { turnIndex: 1 },
  };
}

function completed(
  seconds: number,
  reason: TurnEndReason,
  extra: { recovered?: true } = {},
  turnId = "t1",
): RuntimeEvent {
  return {
    type: "turn.completed",
    sessionId: "s",
    seq: 2,
    time: at(seconds),
    turnId,
    payload: { reason, steps: 1, usage: { inputTokens: 10, outputTokens: 5 }, ...extra },
  };
}

function permission(): RuntimeEvent {
  return {
    type: "permission.requested",
    sessionId: "s",
    seq: 3,
    time: at(1),
    turnId: "t1",
    payload: { requestId: "r1", callId: "c1", subjects: [], reason: "需要确认", options: [] },
  };
}

function question(): RuntimeEvent {
  return {
    type: "question.requested",
    sessionId: "s",
    runId: "run",
    eseq: 1,
    afterSeq: 3,
    time: at(1),
    turnId: "t1",
    payload: { requestId: "r1", callId: "c1", questions: [{ question: "继续吗" }] },
  };
}

describe("判定规则", () => {
  const settings = (patch: Partial<NotifySettings> = {}): NotifySettings => ({
    ...NOTIFY_DEFAULTS,
    ...patch,
  });
  const away = { focused: false, turnStartedAt: T0 };

  it("需要确认：permission.requested 与 question.requested 各一次", () => {
    expect(shouldRing(permission(), away, settings())).toBe("attention");
    expect(shouldRing(question(), away, settings())).toBe("attention");
    expect(shouldRing(permission(), away, settings({ attention: false }))).toBeUndefined();
    expect(shouldRing(question(), away, settings({ attention: false }))).toBeUndefined();
  });

  it("出错停止：turn.completed(error) 不看用时", () => {
    expect(shouldRing(completed(1, "error"), { focused: false }, settings())).toBe("error");
    expect(shouldRing(completed(1, "error"), { focused: false }, settings({ error: false }))).toBe(
      undefined,
    );
  });

  it("完成：等于阈值提醒，少 1 秒不提醒；中断与恢复补写不提醒", () => {
    expect(shouldRing(completed(60, "done"), away, settings())).toBe("done"); // 等于阈值
    expect(shouldRing(completed(59, "done"), away, settings())).toBeUndefined(); // 少 1 秒
    expect(shouldRing(completed(600, "aborted"), away, settings())).toBeUndefined(); // 用户中断
    expect(
      shouldRing(completed(600, "done", { recovered: true }), away, settings()),
    ).toBeUndefined(); // 恢复补写不算实时事件
    expect(shouldRing(completed(600, "max_steps"), away, settings())).toBe("done"); // 其他非中断结束
    expect(
      shouldRing(completed(600, "done"), { focused: false, turnStartedAt: undefined }, settings()),
    ).toBeUndefined(); // 起点未知（没有对应 turn.started）
    expect(shouldRing(completed(600, "done"), away, settings({ done: false }))).toBeUndefined();
  });

  it("总开关关闭、聚焦或非提醒事件：不响", () => {
    expect(shouldRing(permission(), away, settings({ enabled: false }))).toBeUndefined();
    expect(shouldRing(completed(600, "done"), away, settings({ enabled: false }))).toBeUndefined();
    expect(
      shouldRing(completed(600, "done"), { focused: true, turnStartedAt: T0 }, settings()),
    ).toBeUndefined();
    expect(shouldRing(permission(), { focused: true }, settings())).toBeUndefined();
    expect(shouldRing(completed(1, "error"), { focused: true }, settings())).toBeUndefined();
    expect(shouldRing(started(), away, settings())).toBeUndefined();
  });

  it("openTurnStarts：未闭合的 turn.started 计时，闭合后移除", () => {
    const events = [started("t1"), completed(10, "done", {}, "t1"), started("t2")];
    expect([...openTurnStarts(events)]).toEqual([["t2", T0]]);
  });
});

describe("设置读取（Runtime.describeSettings）", () => {
  it("六个逐字段的生效值，保存后立即反映（下次判定即生效）", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "nct-notify-set-"));
    const sessionsDir = mkdtempSync(path.join(tmpdir(), "nct-notify-set-sd-"));
    tmpRoots.push(root, sessionsDir);
    const config = await loadConfig(createPlatform(), {
      nocturneHome: process.env.NOCTURNE_HOME,
      env: () => undefined,
    });
    const runtime = await createRuntime({ cwd: root, sessionsDir, config });
    expect(readNotifySettings(runtime)).toEqual(NOTIFY_DEFAULTS);
    await runtime.updateSettings({
      "notifications.enabled": false,
      "notifications.events.done": false,
      "notifications.doneAfterSeconds": 5,
    });
    expect(readNotifySettings(runtime)).toEqual({
      enabled: false,
      attention: true,
      error: true,
      done: false,
      doneAfterSeconds: 5,
    });
  });
});

// ── 集成：焦点回送驱动的响铃 ───────────────────────────────

const ATTENTION: FakeScript[] = [
  [
    { type: "tool_call", toolCallId: "need", name: "shell", input: { command: "echo hi" } },
    { type: "finish", reason: "tool_calls" },
  ],
];
const DONE: FakeScript[] = [
  [
    { type: "text_delta", text: "完成文字" },
    { type: "finish", reason: "stop" },
  ],
];
const ERROR: FakeScript[] = [[{ type: "throw", error: new Error("上游炸了") }]];

describe("响铃（集成，全屏）", { timeout: 20_000 }, () => {
  it("失焦时权限请求响一次；聚焦不响；从未回送按没在看照常响", async () => {
    for (const mode of ["out", "in", "none"] as const) {
      const { runtime, session } = await openSession(ATTENTION);
      const io = ttyPair();
      const done = runTui({ session }, runtime, {
        stdin: io.stdin,
        stdout: io.stdout,
        stderr: io.stderr,
        patchConsole: false,
      });
      try {
        await waitFor(() => io.stdoutChunks.join("").includes(APP_VERSION));
        if (mode !== "none") io.stdin.write(mode === "in" ? "\x1b[I" : "\x1b[O");
        const turn = session.submit({ text: "需要我确认" });
        await waitFor(() => session.durableEvents().some((e) => e.type === "permission.requested"));
        await waitFor(() => io.stdoutChunks.join("").includes("等待权限确认"));
        const rings = bellCount(io.stdoutChunks);
        expect(rings).toBe(mode === "in" ? 0 : 1);
        // 中断收尾不响（aborted 永不提醒），随后退出
        session.interrupt();
        await turn;
        expect(bellCount(io.stdoutChunks)).toBe(rings);
        io.stdin.write("\x03");
        await done;
      } finally {
        await session.close();
      }
    }
  });

  it("失焦时出错停止响一次；聚焦不响", async () => {
    for (const mode of ["out", "in"] as const) {
      const { runtime, session } = await openSession(ERROR);
      const io = ttyPair();
      const done = runTui({ session }, runtime, {
        stdin: io.stdin,
        stdout: io.stdout,
        stderr: io.stderr,
        patchConsole: false,
      });
      try {
        await waitFor(() => io.stdoutChunks.join("").includes(APP_VERSION));
        io.stdin.write(mode === "in" ? "\x1b[I" : "\x1b[O");
        expect(await session.submit({ text: "让它出错" })).toBe("error");
        expect(bellCount(io.stdoutChunks)).toBe(mode === "in" ? 0 : 1);
        io.stdin.write("\x03");
        await done;
      } finally {
        await session.close();
      }
    }
  });

  it("失焦时完成响一次（阈值 0 热更新后生效）；聚焦不响", async () => {
    for (const mode of ["out", "in"] as const) {
      const { runtime, session } = await openSession(DONE);
      const io = ttyPair();
      const done = runTui({ session }, runtime, {
        stdin: io.stdin,
        stdout: io.stdout,
        stderr: io.stderr,
        patchConsole: false,
      });
      try {
        await waitFor(() => io.stdoutChunks.join("").includes(APP_VERSION));
        io.stdin.write(mode === "in" ? "\x1b[I" : "\x1b[O");
        // 启动后再保存：判定时重读设置，无需重启
        await runtime.updateSettings({ "notifications.doneAfterSeconds": 0 });
        expect(await session.submit({ text: "做完它" })).toBe("done");
        await waitFor(() => io.stdoutChunks.join("").includes("完成文字"));
        expect(bellCount(io.stdoutChunks)).toBe(mode === "in" ? 0 : 1);
        io.stdin.write("\x03");
        await done;
      } finally {
        await session.close();
      }
    }
  });

  it("焦点回送不进输入框（与按键混排）", async () => {
    const { runtime, session } = await openSession();
    const io = ttyPair();
    const done = runTui({ session }, runtime, {
      stdin: io.stdin,
      stdout: io.stdout,
      stderr: io.stderr,
      patchConsole: false,
    });
    await waitFor(() => io.stdoutChunks.join("").includes(APP_VERSION));
    io.stdin.write("abc\x1b[O\x1b[Id");
    await waitFor(() => io.stdoutChunks.join("").includes("abcd"));
    io.stdin.write("\x03");
    await done;
    await session.close();
  });

  it("恢复会话的历史事件不响：只对本次运行实时到达的事件判定", async () => {
    // ATTENTION 脚本只有一轮 tool_calls；先用同脚本的会话跑完一轮、关闭，
    // 再恢复同一会话：回放的历史事件不走 subscribe，无响铃可响。
    const { runtime, session } = await openSession(ATTENTION);
    const id = session.id;
    const first = session.submit({ text: "先跑完一轮" });
    await waitFor(() => session.durableEvents().some((e) => e.type === "permission.requested"));
    session.interrupt();
    await first;
    await session.close();
    const resumed = await runtime.resumeSession(id);
    const io = ttyPair();
    const done = runTui({ session: resumed }, runtime, {
      stdin: io.stdin,
      stdout: io.stdout,
      stderr: io.stderr,
      patchConsole: false,
    });
    try {
      await waitFor(() => io.stdoutChunks.join("").includes(APP_VERSION));
      // 历史里有 permission.requested，但恢复时不重响
      expect(bellCount(io.stdoutChunks)).toBe(0);
      // 随后新一轮实时 Turn（DONE 脚本另起会话）仍照常判定：这里只验证
      // 恢复本身不响，实时判定由前面的三类集成用例覆盖
      io.stdin.write("\x03");
      await done;
    } finally {
      await resumed.close();
    }
  });
});

// ── 退出路径 ───────────────────────────────────────────────

describe("退出关闭焦点报告", { timeout: 15_000 }, () => {
  it("全屏：启动开启 ?1004h；退出在回主屏之前写 ?1004l（与 ?1049l 同笔）", async () => {
    const { runtime, session } = await openSession();
    const io = ttyPair();
    const done = runTui({ session }, runtime, {
      stdin: io.stdin,
      stdout: io.stdout,
      stderr: io.stderr,
      patchConsole: false,
    });
    await waitFor(() => io.stdoutChunks.join("").includes(APP_VERSION));
    const boot = io.stdoutChunks.join("");
    expect(boot).toContain(FOCUS_ENABLE);
    expect(boot).not.toContain(FOCUS_DISABLE);
    io.stdin.write("\x04");
    await done;
    const text = io.stdoutChunks.join("");
    expect(text).toContain(FOCUS_DISABLE);
    // 全屏复位点：?1004l 经 beforeExitAlt 与 ?1049l 原子同笔写出（先关焦点报告
    // 再回主屏）；finally 的 disableFocus 是已关后的空操作——同一笔内必有
    // "?1004l…?1049l" 相邻顺序。
    expect(text).toContain("?1004l\x1b[?1049l");
    await session.close();
  });

  it("未捕获异常：也关闭焦点报告", async () => {
    const { runtime, session } = await openSession();
    const io = ttyPair();
    const done = runTui({ session }, runtime, {
      stdin: io.stdin,
      stdout: io.stdout,
      stderr: io.stderr,
      exitProcess: () => undefined,
      patchConsole: false,
    });
    await waitFor(() => io.stdoutChunks.join("").includes(APP_VERSION));
    process.emit("unhandledRejection", new Error("boom"), Promise.resolve());
    await done;
    expect(io.stdoutChunks.join("")).toContain(FOCUS_DISABLE);
    await session.close();
  });

  it("--inline：启动开启、退出关闭", async () => {
    const { runtime, session } = await openSession();
    const io = ttyPair();
    const done = runTui({ session }, runtime, {
      stdin: io.stdin,
      stdout: io.stdout,
      stderr: io.stderr,
      inline: true,
      patchConsole: false,
    });
    await waitFor(() => io.stdoutChunks.join("").includes(APP_VERSION));
    expect(io.stdoutChunks.join("")).toContain(FOCUS_ENABLE);
    io.stdin.write("\x04");
    await done;
    expect(io.stdoutChunks.join("")).toContain(FOCUS_DISABLE);
    await session.close();
  });
});
