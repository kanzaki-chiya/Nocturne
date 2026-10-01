/**
 * REPL 生命周期回归测试（cli.md 第 3 节）：EOF 与活跃 Turn 的竞态。
 * 历史缺陷：EOF 时 readline 关闭但 Turn 未收束，Turn 结束后的 finally
 * 对已关闭的 rl 调 prompt() → ERR_USE_AFTER_CLOSE。
 */
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import type { Runtime, RuntimeSession, SessionSummary } from "@nocturne/core";
import type { RuntimeEvent, TurnEndReason } from "@nocturne/core/protocol";

import { runRepl } from "../src/repl.js";

function makeIo() {
  const stdin = new PassThrough();
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  stdout.on("data", (c) => stdoutChunks.push(String(c)));
  stderr.on("data", (c) => stderrChunks.push(String(c)));
  return {
    io: {
      stdin: stdin as NodeJS.ReadableStream & { isTTY?: boolean },
      stdout: stdout as NodeJS.WritableStream,
      stderr: stderr as NodeJS.WritableStream,
    },
    stdin,
    stdoutChunks,
    stderrChunks,
  };
}

interface TurnControl {
  resolve(reason: TurnEndReason): void;
  reject(e: unknown): void;
}

function fakeSessionWithPendingTurn(interrupted: { value: boolean }) {
  let control: TurnControl | undefined;
  const session = {
    id: "s1",
    subscribe: (_fn: (ev: RuntimeEvent) => void) => () => undefined,
    submit: (_input: { text: string }) =>
      new Promise<TurnEndReason>((resolve, reject) => {
        control = { resolve, reject };
      }),
    interrupt: () => {
      interrupted.value = true;
      queueMicrotask(() => control?.resolve("aborted"));
    },
    respondPermission: () => Promise.resolve(),
    state: () =>
      ({
        config: { model: { provider: "p", model: "m1" } },
      }) as ReturnType<RuntimeSession["state"]>,
  } as unknown as RuntimeSession;
  return { session, settle: () => control };
}

const fakeRuntime = {
  listModels: () => [],
} as unknown as Runtime;

const tick = () => new Promise((r) => setTimeout(r, 10));

describe("REPL 生命周期", () => {
  it("TTY readline 读取 Core 历史并记录新输入", async () => {
    const { io, stdin } = makeIo();
    io.stdin.isTTY = true;
    (io.stdin as typeof io.stdin & { setRawMode: (enabled: boolean) => void }).setRawMode = () =>
      undefined;
    const submitted: string[] = [];
    const recorded: string[] = [];
    let reads = 0;
    const { session } = fakeSessionWithPendingTurn({ value: false });
    session.readInputHistory = async () => {
      reads++;
      return ["上次输入"];
    };
    session.recordInputHistory = async (text) => {
      recorded.push(text);
    };
    session.submit = async ({ text }) => {
      submitted.push(text ?? "");
      return "done";
    };
    const done = runRepl(session, fakeRuntime, io);
    await tick();
    stdin.write("新输入\n");
    await tick();
    stdin.end();
    expect(await done).toBe(0);
    expect(reads).toBe(1);
    expect(submitted).toEqual(["新输入"]);
    expect(recorded).toEqual(["新输入"]);
  });

  it("EOF（Ctrl+D / stdin 结束）时 Turn 进行中：中断并等待收束后退出，无 prompt-after-close", async () => {
    const { io, stdin, stderrChunks } = makeIo();
    const interrupted = { value: false };
    const { session } = fakeSessionWithPendingTurn(interrupted);

    const done = runRepl(session, fakeRuntime, io);
    stdin.write("修一个 bug\n");
    await tick(); // 让 line 处理进入 Turn（busy）
    stdin.end(); // Turn 尚未结束时 EOF
    const code = await done; // 修复前：这里返回后 finally 再 rl.prompt() → ERR_USE_AFTER_CLOSE
    expect(code).toBe(0);
    expect(interrupted.value).toBe(true);
    expect(stderrChunks.join("")).not.toContain("ERR_USE_AFTER_CLOSE");
    // 进程已返回，不应再有遗留回调抛错（让事件循环跑一拍）
    await tick();
  });

  it("空闲时 EOF：直接退出", async () => {
    const { io, stdin } = makeIo();
    const { session } = fakeSessionWithPendingTurn({ value: false });
    const done = runRepl(session, fakeRuntime, io);
    stdin.end();
    expect(await done).toBe(0);
  });

  it("Turn 正常结束后 EOF：不重复中断，直接退出", async () => {
    const { io, stdin } = makeIo();
    const interrupted = { value: false };
    const { session, settle } = fakeSessionWithPendingTurn(interrupted);
    const done = runRepl(session, fakeRuntime, io);
    stdin.write("hi\n");
    await tick();
    settle()?.resolve("done");
    await tick();
    stdin.end();
    expect(await done).toBe(0);
    expect(interrupted.value).toBe(false);
  });

  it("权限确认五键：a/s/p/d/x 映射到 PermissionReply（cli.md 第 6 节）", async () => {
    const { io, stdin, stdoutChunks } = makeIo();
    let listener: ((ev: RuntimeEvent) => void) | undefined;
    const replies: { requestId: string; reply: unknown }[] = [];
    const session = {
      id: "s1",
      subscribe: (fn: (ev: RuntimeEvent) => void) => {
        listener = fn;
        return () => undefined;
      },
      submit: () => new Promise<TurnEndReason>(() => undefined),
      interrupt: () => undefined,
      respondPermission: (requestId: string, reply: unknown) => {
        replies.push({ requestId, reply });
        return Promise.resolve();
      },
      state: () =>
        ({ config: { model: { provider: "p", model: "m1" } } }) as ReturnType<
          RuntimeSession["state"]
        >,
    } as unknown as RuntimeSession;

    const done = runRepl(session, fakeRuntime, io);
    await tick();
    const requested = (id: string, restricted = false) =>
      listener?.({
        type: "permission.requested",
        sessionId: "s1",
        seq: 9,
        time: "t",
        payload: {
          requestId: id,
          callId: "c1",
          subjects: [{ kind: "edit", target: "/x/a.ts" }],
          reason: "命中规则：工作区外编辑",
          options: restricted
            ? ["allow_once", "deny", "deny_stop"]
            : ["allow_once", "allow_session", "allow_project", "deny", "deny_stop"],
        },
      } as RuntimeEvent);

    const cases: [string, unknown][] = [
      ["a", { decision: "allow" }],
      ["s", { decision: "allow", remember: "session" }],
      ["p", { decision: "allow", remember: "project" }],
      ["d 先别改", { decision: "deny", feedback: "先别改" }],
      ["x", { decision: "deny", stop: true }],
    ];
    for (const [i, [key, expected]] of cases.entries()) {
      requested(`req-${i}`);
      await tick();
      stdin.write(`${key}\n`);
      await tick();
      expect(replies.at(-1)).toEqual({ requestId: `req-${i}`, reply: expected });
    }
    requested("restricted", true);
    await tick();
    stdin.write("s\n");
    await tick();
    stdin.write("p\n");
    await tick();
    expect(replies).toHaveLength(5);
    stdin.write("a\n");
    await tick();
    expect(replies.at(-1)).toEqual({ requestId: "restricted", reply: { decision: "allow" } });
    // 提示块列出了全部五个选项
    const prompt = stdoutChunks.join("");
    expect(prompt).toContain("本会话内允许");
    expect(prompt).toContain("拒绝并停止");
    stdin.end();
    expect(await done).toBe(0);
  });
});

describe("REPL /resume 会话切换", () => {
  const fakeSession = (id: string) =>
    ({
      id,
      subscribe: (_fn: (ev: RuntimeEvent) => void) => () => undefined,
      submit: () => new Promise<TurnEndReason>(() => undefined),
      interrupt: () => undefined,
      respondPermission: () => Promise.resolve(),
      state: () =>
        ({
          config: { model: { provider: "p", model: "m1" } },
          openTurn: undefined,
          meta: { cwd: "/ws" },
        }) as unknown as ReturnType<RuntimeSession["state"]>,
      warnings: [],
      session: { durableEvents: () => [] },
    }) as unknown as RuntimeSession;

  const summary = (id: string, mtimeMs: number, locked = false) =>
    ({
      id,
      createdAt: "2026-09-24 10:00",
      cwd: "C:\\ws",
      workspaceRoot: "C:\\ws",
      model: { provider: "p", model: "m1" },
      mtimeMs,
      ...(locked ? { locked: true } : {}),
    }) as SessionSummary;

  it("/new 与 /clear 切换新会话且事件订阅换绑", async () => {
    const { io, stdin, stdoutChunks } = makeIo();
    const s1 = fakeSession("s1");
    const s2 = fakeSession("s2");
    const s3 = fakeSession("s3");
    let count = 0;
    const done = runRepl(s1, { listModels: () => [] } as unknown as Runtime, io, {
      newSession: async () => ({ kind: "ok", session: ++count === 1 ? s2 : s3 }),
    });
    await tick();
    stdin.write("/new\n");
    await tick();
    stdin.write("/clear\n");
    await tick();
    expect(count).toBe(2);
    expect(stdoutChunks.join("")).toContain("新会话 s2");
    expect(stdoutChunks.join("")).toContain("新会话 s3");
    stdin.end();
    expect(await done).toBe(0);
  });

  it("/resume 列编号列表，输入编号切换并打印分隔线", async () => {
    const { io, stdin, stdoutChunks } = makeIo();
    const s1 = fakeSession("s1");
    const s2 = fakeSession("s2");
    const rt = {
      listModels: () => [],
      listSessions: (filter?: { cwd?: string }) => {
        expect(filter?.cwd).toBe("/ws");
        return Promise.resolve([summary("s2", 100), summary("s1", 200)]);
      },
    } as unknown as Runtime;
    const calls: string[] = [];
    const done = runRepl(s1, rt, io, {
      switchSession: async (id) => {
        calls.push(id);
        return { kind: "ok", session: s2 };
      },
    });
    await tick();
    stdin.write("/resume\n");
    await tick();
    stdin.write("2\n");
    await tick();
    const out = stdoutChunks.join("");
    expect(out).toContain("1. s1");
    expect(out).toContain("2. s2");
    expect(out).toContain("已切换到会话 s2");
    expect(calls).toEqual(["s2"]);
    stdin.end();
    expect(await done).toBe(0);
  });

  it("/resume 空行取消；/resume <id> 直接切换", async () => {
    const { io, stdin, stdoutChunks } = makeIo();
    const s1 = fakeSession("s1");
    const s2 = fakeSession("s2");
    const rt = {
      listModels: () => [],
      listSessions: (filter?: { cwd?: string }) => {
        expect(filter?.cwd).toBe("/ws");
        return Promise.resolve([summary("s2", 100), summary("s1", 200)]);
      },
    } as unknown as Runtime;
    const calls: string[] = [];
    const done = runRepl(s1, rt, io, {
      switchSession: async (id) => {
        calls.push(id);
        return { kind: "ok", session: s2 };
      },
    });
    await tick();
    stdin.write("/resume\n");
    await tick();
    stdin.write("\n"); // 空行取消
    await tick();
    expect(stdoutChunks.join("")).toContain("已取消");
    expect(calls).toEqual([]);
    stdin.write("/resume s2\n");
    await tick();
    expect(calls).toEqual(["s2"]);
    expect(stdoutChunks.join("")).toContain("已切换到会话 s2");
    stdin.end();
    expect(await done).toBe(0);
  });

  it("跨目录：先询问，y 后以 allowForeign 重试；n 取消", async () => {
    const { io, stdin, stdoutChunks } = makeIo();
    const s1 = fakeSession("s1");
    const s2 = fakeSession("s2");
    const calls: { id: string; foreign: boolean }[] = [];
    const done = runRepl(s1, fakeRuntime, io, {
      switchSession: async (id, opts) => {
        const foreign = opts?.allowForeign === true;
        calls.push({ id, foreign });
        if (!foreign) return { kind: "foreign", workspaceRoot: "D:\\other" };
        return { kind: "ok", session: s2 };
      },
    });
    await tick();
    stdin.write("/resume s2\n");
    await tick();
    expect(stdoutChunks.join("")).toContain("与当前目录不同");
    stdin.write("y\n");
    await tick();
    expect(calls).toEqual([
      { id: "s2", foreign: false },
      { id: "s2", foreign: true },
    ]);
    expect(stdoutChunks.join("")).toContain("已切换到会话 s2");
    stdin.end();
    expect(await done).toBe(0);
  });

  it("切换失败（锁冲突）：打印原因并留在原会话", async () => {
    const { io, stdin, stdoutChunks } = makeIo();
    const s1 = fakeSession("s1");
    const done = runRepl(s1, fakeRuntime, io, {
      switchSession: () =>
        Promise.resolve({ kind: "error", message: "会话被另一个进程占用（锁文件…）" }),
    });
    await tick();
    stdin.write("/resume s2\n");
    await tick();
    expect(stdoutChunks.join("")).toContain("占用");
    expect(stdoutChunks.join("")).not.toContain("已切换");
    stdin.end();
    expect(await done).toBe(0);
  });
});
