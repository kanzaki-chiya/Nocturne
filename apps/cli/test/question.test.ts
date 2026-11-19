/**
 * 逐行 CLI 提问交互（ADR-0032 §6）：question.requested 后逐题打印，
 * 编号/直接文字/空行重提示/非法编号重试/Ctrl+C 中断。
 */
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import type { RuntimeSession } from "@nocturne/core";
import type { QuestionItem, RuntimeEvent, TurnEndReason } from "@nocturne/core/protocol";
import { createRuntimeStub } from "@nocturne/core/testing";

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

const fakeRuntime = createRuntimeStub({ listModels: () => [] });
/** 就绪：readline 建好后写出的第一条提示符 */
const ready = (stdoutChunks: string[]) =>
  vi.waitFor(() => expect(stdoutChunks.join("")).toContain("nctrn> "));

interface QuestionReplySeen {
  requestId: string;
  reply: unknown;
}

/** 假会话：submit 挂起直至 interrupt，subscribe 捕获 listener，respondQuestion 记录回复 */
function fakeSession(interrupted?: { value: boolean }) {
  let listener: ((ev: RuntimeEvent) => void) | undefined;
  let questions: QuestionItem[] = [];
  let control: { resolve(r: TurnEndReason): void } | undefined;
  const replies: QuestionReplySeen[] = [];
  const session = {
    describeSkills: () => ({ skills: [] }),
    describeExternalAgents: async () => ({ agents: [], warnings: [] }),
    id: "s1",
    subscribe: (fn: (ev: RuntimeEvent) => void) => {
      listener = fn;
      return () => undefined;
    },
    submit: () =>
      new Promise<TurnEndReason>((resolve) => {
        control = { resolve };
      }),
    interrupt: () => {
      if (interrupted !== undefined) interrupted.value = true;
      // 与真实会话一致：中断使挂起的 Turn 收束（close 路径等待它）
      queueMicrotask(() => control?.resolve("aborted"));
    },
    respondPermission: () => Promise.resolve(),
    respondQuestion: (requestId: string, reply: unknown) => {
      replies.push({ requestId, reply });
      const answers = (reply as { answers: unknown[] }).answers;
      listener?.({
        type: "tool.completed",
        sessionId: "s1",
        seq: 3,
        time: "t",
        turnId: "t1",
        payload: {
          callId: "c1",
          name: "ask_user",
          status: "ok",
          modelContent: "问：重复摘要不可显示",
          output: {
            answers: answers.map((a, i) => ({
              question: questions[i]?.question,
              ...(a as object),
            })),
          },
        },
      } as RuntimeEvent);
      return Promise.resolve();
    },
    readInputHistory: () => Promise.resolve([]),
    recordInputHistory: () => Promise.resolve(),
    state: () =>
      ({ config: { model: { provider: "p", model: "m1" } } }) as ReturnType<
        RuntimeSession["state"]
      >,
  } as unknown as RuntimeSession;
  return {
    session,
    replies,
    /** 提交已发生：Turn 挂起中（busy），之后的行不会再被当成提交 */
    settle: () => control,
    emit: (ev: RuntimeEvent) => {
      if (ev.type === "question.requested") questions = ev.payload.questions;
      listener?.(ev);
    },
  };
}

function questionEvent(requestId: string, questions: QuestionItem[], callId = "c1"): RuntimeEvent {
  return {
    type: "question.requested",
    sessionId: "s1",
    runId: "r1",
    eseq: 1,
    time: "t",
    turnId: "t1",
    payload: { requestId, callId, questions },
  } as RuntimeEvent;
}

const twoOption: QuestionItem = {
  question: "用哪个数据库？",
  header: "选型",
  options: [{ label: "PostgreSQL（推荐）", description: "兼容 13 版" }, { label: "SQLite" }],
};

describe("REPL 提问交互（ADR-0032 §6）", () => {
  it("单选：打印编号选项，输入编号后提交 answers", async () => {
    const { io, stdin, stdoutChunks } = makeIo();
    const { session, replies, emit, settle } = fakeSession();
    const done = runRepl(session, fakeRuntime, io);
    await ready(stdoutChunks);
    stdin.write("干活\n");
    await vi.waitFor(() => expect(settle()).toBeDefined());
    emit(questionEvent("q-1", [twoOption]));
    await vi.waitFor(() => expect(stdoutChunks.join("")).toContain("[选型] 用哪个数据库？"));
    const shown = stdoutChunks.join("");
    expect(shown).toContain("1. PostgreSQL（推荐） — 兼容 13 版");
    expect(shown).toContain("2. SQLite");
    expect(shown).toContain("其他");
    expect(shown).toContain("3. 拒绝回答");
    stdin.write("1\n");
    await vi.waitFor(() =>
      expect(replies).toEqual([
        {
          requestId: "q-1",
          reply: { answers: [{ selected: ["PostgreSQL（推荐）"] }] },
        },
      ]),
    );
    // 提交后打印摘要
    expect(stdoutChunks.join("").match(/用哪个数据库？ → PostgreSQL（推荐）/g)).toHaveLength(1);
    expect(stdoutChunks.join("")).not.toContain("重复摘要");
    stdin.end();
    expect(await done).toBe(0);
  });

  it("多选：逗号分隔编号；非法编号提示后重新输入，不提交", async () => {
    const { io, stdin, stdoutChunks } = makeIo();
    const { session, replies, emit, settle } = fakeSession();
    const done = runRepl(session, fakeRuntime, io);
    await ready(stdoutChunks);
    stdin.write("干活\n");
    await vi.waitFor(() => expect(settle()).toBeDefined());
    emit(
      questionEvent("q-2", [
        {
          question: "选哪几项？",
          multiSelect: true,
          options: [{ label: "甲" }, { label: "乙" }, { label: "丙" }],
        },
      ]),
    );
    await vi.waitFor(() => expect(stdoutChunks.join("")).toContain("可输入多个编号，用逗号分隔"));
    // 非法编号：提示并重输，不发 respondQuestion
    stdin.write("9\n");
    await vi.waitFor(() => expect(stdoutChunks.join("")).toContain("无效编号"));
    expect(replies).toHaveLength(0);
    stdin.write("1,4\n");
    await vi.waitFor(() => expect(stdoutChunks.join("")).toContain("拒绝回答须单独选择"));
    expect(replies).toHaveLength(0);
    stdin.write("1,3\n");
    await vi.waitFor(() =>
      expect(replies).toEqual([
        { requestId: "q-2", reply: { answers: [{ selected: ["甲", "丙"] }] } },
      ]),
    );
    stdin.end();
    expect(await done).toBe(0);
  });

  it("直接输入文字作为「其他」；自由文本题整行即回答", async () => {
    const { io, stdin, stdoutChunks } = makeIo();
    const { session, replies, emit, settle } = fakeSession();
    const done = runRepl(session, fakeRuntime, io);
    await ready(stdoutChunks);
    stdin.write("干活\n");
    await vi.waitFor(() => expect(settle()).toBeDefined());
    emit(questionEvent("q-3", [twoOption, { question: "还有补充吗？" }]));
    await vi.waitFor(() => expect(stdoutChunks.join("")).toContain("用哪个数据库？"));
    stdin.write("我要自定义方案\n");
    // 第二题（自由文本）被打印
    await vi.waitFor(() => expect(stdoutChunks.join("")).toContain("还有补充吗？"));
    expect(replies).toHaveLength(0);
    stdin.write("尽快上线\n");
    await vi.waitFor(() =>
      expect(replies).toEqual([
        {
          requestId: "q-3",
          reply: {
            answers: [
              { selected: [], text: "我要自定义方案" },
              { selected: [], text: "尽快上线" },
            ],
          },
        },
      ]),
    );
    stdin.end();
    expect(await done).toBe(0);
  });

  it("空行重提示，最后的拒绝编号只拒绝本题", async () => {
    const { io, stdin, stdoutChunks } = makeIo();
    const { session, replies, emit, settle } = fakeSession();
    const done = runRepl(session, fakeRuntime, io);
    await ready(stdoutChunks);
    stdin.write("干活\n");
    await vi.waitFor(() => expect(settle()).toBeDefined());
    emit(questionEvent("q-4", [twoOption, { question: "第二题" }]));
    await vi.waitFor(() => expect(stdoutChunks.join("")).toContain("用哪个数据库？"));
    // 第一题拒绝，第二题处空行重提示，保留逐题拒绝。
    stdin.write("3\n");
    await vi.waitFor(() => expect(stdoutChunks.join("").match(/第二题/g)?.length).toBe(1));
    stdin.write("\n");
    await vi.waitFor(() => expect(stdoutChunks.join("").match(/第二题/g)?.length).toBe(2));
    expect(replies).toHaveLength(0);
    stdin.write("1\n");
    await vi.waitFor(() =>
      expect(replies).toEqual([
        { requestId: "q-4", reply: { answers: [{ declined: true }, { declined: true }] } },
      ]),
    );
    expect(stdoutChunks.join("")).toContain("第二题 → 拒绝回答");
    stdin.end();
    expect(await done).toBe(0);
  });

  it("Ctrl+C 中断提问：interrupt 会话且不提交回答", async () => {
    const { io, stdin, stdoutChunks } = makeIo();
    // TTY + setRawMode 桩使 readline 进入 terminal 模式：
    // stdin 里的 Ctrl+C（\x03）会被转成 SIGINT 事件
    io.stdin.isTTY = true;
    (io.stdin as typeof io.stdin & { setRawMode: (e: boolean) => void }).setRawMode = () =>
      undefined;
    const interrupted = { value: false };
    const { session, replies, emit, settle } = fakeSession(interrupted);
    const done = runRepl(session, fakeRuntime, io);
    await ready(stdoutChunks);
    stdin.write("干活\n");
    await vi.waitFor(() => expect(settle()).toBeDefined());
    emit(questionEvent("q-5", [twoOption]));
    await vi.waitFor(() => expect(stdoutChunks.join("")).toContain("用哪个数据库？"));
    stdin.write("\x03");
    await vi.waitFor(() => expect(stdoutChunks.join("")).toContain("已中断"));
    expect(interrupted.value).toBe(true);
    expect(replies).toHaveLength(0);
    stdin.end();
    expect(await done).toBe(0);
  });

  it("tool.completed 到达后提问状态清除；单选题多编号被拒", async () => {
    const { io, stdin, stdoutChunks } = makeIo();
    const { session, replies, emit, settle } = fakeSession();
    const done = runRepl(session, fakeRuntime, io);
    await ready(stdoutChunks);
    stdin.write("干活\n");
    await vi.waitFor(() => expect(settle()).toBeDefined());
    emit(questionEvent("q-6", [twoOption]));
    await vi.waitFor(() => expect(stdoutChunks.join("")).toContain("用哪个数据库？"));
    stdin.write("1,2\n");
    await vi.waitFor(() => expect(stdoutChunks.join("")).toContain("单选"));
    expect(replies).toHaveLength(0);
    // 对应调用的 tool.completed（中断/超时路径）到达后状态清除
    emit({
      type: "tool.completed",
      sessionId: "s1",
      seq: 8,
      time: "t",
      turnId: "t1",
      payload: {
        callId: "c1",
        name: "ask_user",
        status: "cancelled",
        modelContent: "",
      },
    } as RuntimeEvent);
    stdin.write("1\n");
    // 已清除：普通行落到 busy 提示，不再触发 respondQuestion
    await vi.waitFor(() =>
      expect(stdoutChunks.join("")).toContain("会话忙（本轮进行中）；Ctrl+C 可中断"),
    );
    expect(replies).toHaveLength(0);
    stdin.end();
    expect(await done).toBe(0);
  });
});
