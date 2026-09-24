/**
 * REPL 生命周期回归测试（cli.md 第 3 节）：EOF 与活跃 Turn 的竞态。
 * 历史缺陷：EOF 时 readline 关闭但 Turn 未收束，Turn 结束后的 finally
 * 对已关闭的 rl 调 prompt() → ERR_USE_AFTER_CLOSE。
 */
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import type { Runtime, RuntimeSession } from "@nocturne/core";
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
    const requested = (id: string) =>
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
          options: ["allow_once", "allow_session", "allow_project", "deny", "deny_stop"],
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
    // 提示块列出了全部五个选项
    const prompt = stdoutChunks.join("");
    expect(prompt).toContain("本会话内允许");
    expect(prompt).toContain("拒绝并停止");
    stdin.end();
    expect(await done).toBe(0);
  });
});
