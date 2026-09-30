/**
 * 提问面板测试（ADR-0032 §6 TUI）：ink-testing-library 帧断言。
 * 组件级覆盖单选、多选、「其他」文本、自由文本、多题切换、确认行、
 * Esc 退出输入/跳过；App 级覆盖面板独占焦点（Esc 不中断 Turn）、
 * Ctrl+C 中断与对话摘要。
 * 注：框内行的「→」经 boxSafe 渲染为「>」（conhost 宽度安全约定）；
 * App 级用例在面板出现后要等一拍再写键，等 useInput 订阅生效。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { render } from "ink-testing-library";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createRuntime, FakeProvider } from "@nocturne/core";
import type { PendingQuestion } from "@nocturne/core/protocol";

import { App } from "../src/app.js";
import { QuestionDialog } from "../src/components/question-dialog.js";
import { TuiEnvContext } from "../src/env.js";

const tmpRoots: string[] = [];
beforeEach(() => vi.stubEnv("NOCTURNE_HOME", tmp("nct-tui-home-")));
afterEach(() => {
  vi.unstubAllEnvs();
  for (const r of tmpRoots.splice(0)) rmSync(r, { recursive: true, force: true });
});
const tmp = (p: string) => {
  const d = mkdtempSync(path.join(tmpdir(), p));
  tmpRoots.push(d);
  return d;
};

const ENV = { ascii: false, animated: false };
const pause = (ms = 30) => new Promise((r) => setTimeout(r, ms));

async function waitFor(check: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("waitFor 超时");
    await pause(20);
  }
}
const inEnv = (child: React.ReactNode, env = ENV) =>
  createElement(TuiEnvContext.Provider, { value: env }, child);

const choiceQ = (multi = false): PendingQuestion => ({
  requestId: "q1",
  callId: "c1",
  questions: [
    {
      question: "选哪个方案？",
      header: "方案",
      multiSelect: multi,
      options: [
        { label: "方案A", description: "保守做法" },
        { label: "方案B", description: "激进做法" },
      ],
    },
  ],
});

const freeQ = (): PendingQuestion => ({
  requestId: "q1",
  callId: "c1",
  questions: [{ question: "想要什么名字？" }],
});

const twoQ = (): PendingQuestion => ({
  requestId: "q1",
  callId: "c1",
  questions: [
    { question: "第一题？", options: [{ label: "甲" }, { label: "乙" }] },
    { question: "第二题？", options: [{ label: "丙" }, { label: "丁" }] },
  ],
});

describe("提问面板", () => {
  it("单选：Enter 选中焦点项并进确认行，再 Enter 提交", async () => {
    const reply = vi.fn();
    const { lastFrame, stdin, unmount } = render(
      inEnv(
        createElement(QuestionDialog, {
          pending: choiceQ(),
          active: true,
          onReply: reply,
          width: 80,
        }),
      ),
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("提问");
    expect(frame).toContain("[方案]");
    expect(frame).toContain("选哪个方案？");
    expect(frame).toContain("( ) 方案A");
    expect(frame).toContain("( ) 方案B");
    expect(frame).toContain("[其他]");
    expect(frame).toContain("保守做法");
    // ↓ 到方案B，Enter 选中并进确认行（单题直接到确认）
    stdin.write("\x1b[B");
    await pause();
    stdin.write("\r");
    await pause();
    expect(lastFrame()).toContain("确认回答");
    expect(lastFrame()).toContain("选哪个方案？ > 方案B"); // 框内 → 经 boxSafe 显示为 >
    stdin.write("\r");
    await pause();
    expect(reply).toHaveBeenCalledWith({ answers: [{ selected: ["方案B"] }] });
    unmount();
  });

  it("多选：Space 勾选两项，Enter 进确认行提交", async () => {
    const reply = vi.fn();
    const { lastFrame, stdin, unmount } = render(
      inEnv(
        createElement(QuestionDialog, {
          pending: choiceQ(true),
          active: true,
          onReply: reply,
          width: 80,
        }),
      ),
    );
    expect(lastFrame()).toContain("[ ] 方案A");
    stdin.write(" ");
    await pause();
    expect(lastFrame()).toContain("[x] 方案A");
    stdin.write("\x1b[B");
    await pause();
    stdin.write(" ");
    await pause();
    expect(lastFrame()).toContain("[x] 方案B");
    stdin.write("\r");
    await pause();
    expect(lastFrame()).toContain("方案A、方案B");
    stdin.write("\r");
    await pause();
    expect(reply).toHaveBeenCalledWith({ answers: [{ selected: ["方案A", "方案B"] }] });
    unmount();
  });

  it("「其他」行：焦点落下后直接输入文本，Enter 提交为 text", async () => {
    const reply = vi.fn();
    const { lastFrame, stdin, unmount } = render(
      inEnv(
        createElement(QuestionDialog, {
          pending: choiceQ(),
          active: true,
          onReply: reply,
          width: 80,
        }),
      ),
    );
    // ↓ ↓ 到「其他」行（两个选项之后）
    stdin.write("\x1b[B");
    await pause();
    stdin.write("\x1b[B");
    await pause();
    stdin.write("自己写");
    await pause();
    expect(lastFrame()).toContain("自己写");
    stdin.write("\r");
    await pause();
    expect(lastFrame()).toContain("自己写");
    stdin.write("\r");
    await pause();
    expect(reply).toHaveBeenCalledWith({ answers: [{ selected: [], text: "自己写" }] });
    unmount();
  });

  it("自由文本题：打开即输入，Enter 进确认行提交", async () => {
    const reply = vi.fn();
    const { lastFrame, stdin, unmount } = render(
      inEnv(
        createElement(QuestionDialog, {
          pending: freeQ(),
          active: true,
          onReply: reply,
          width: 80,
        }),
      ),
    );
    expect(lastFrame()).toContain("[回答]");
    stdin.write("小夜曲");
    await pause();
    expect(lastFrame()).toContain("小夜曲");
    stdin.write("\r");
    await pause();
    expect(lastFrame()).toContain("想要什么名字？ > 小夜曲");
    stdin.write("\r");
    await pause();
    expect(reply).toHaveBeenCalledWith({ answers: [{ selected: [], text: "小夜曲" }] });
    unmount();
  });

  it("多题：←/→ 与 Tab/Shift+Tab 切题，显示第 n/N 题", async () => {
    const reply = vi.fn();
    const { lastFrame, stdin, unmount } = render(
      inEnv(
        createElement(QuestionDialog, {
          pending: twoQ(),
          active: true,
          onReply: reply,
          width: 80,
        }),
      ),
    );
    expect(lastFrame()).toContain("第 1/2 题");
    expect(lastFrame()).toContain("第一题？");
    stdin.write("\x1b[C"); // → 下一题
    await pause();
    expect(lastFrame()).toContain("第 2/2 题");
    expect(lastFrame()).toContain("第二题？");
    stdin.write("\x1b[Z"); // Shift+Tab 回上一题
    await pause();
    expect(lastFrame()).toContain("第 1/2 题");
    stdin.write("\t"); // Tab 再切到第二题
    await pause();
    expect(lastFrame()).toContain("第 2/2 题");
    unmount();
  });

  it("确认行 ← 返回上一题可改选", async () => {
    const reply = vi.fn();
    const { lastFrame, stdin, unmount } = render(
      inEnv(
        createElement(QuestionDialog, {
          pending: choiceQ(),
          active: true,
          onReply: reply,
          width: 80,
        }),
      ),
    );
    stdin.write("\r"); // 选中 方案A → 确认行
    await pause();
    expect(lastFrame()).toContain("方案A");
    stdin.write("\x1b[D"); // ← 返回
    await pause();
    expect(lastFrame()).toContain("(o) 方案A"); // 之前的选择保留
    stdin.write("\x1b[B"); // ↓ 到方案B
    await pause();
    stdin.write("\r");
    await pause();
    expect(lastFrame()).toContain("选哪个方案？ > 方案B");
    stdin.write("\r");
    await pause();
    expect(reply).toHaveBeenCalledWith({ answers: [{ selected: ["方案B"] }] });
    unmount();
  });

  it("Esc：非输入态跳过整次提问", async () => {
    const reply = vi.fn();
    const { stdin, unmount } = render(
      inEnv(
        createElement(QuestionDialog, {
          pending: choiceQ(),
          active: true,
          onReply: reply,
          width: 80,
        }),
      ),
    );
    stdin.write("\x1b");
    await pause();
    expect(reply).toHaveBeenCalledWith({ skipped: true });
    unmount();
  });

  it("Esc：文本输入中先退出输入，再按一次才跳过", async () => {
    const reply = vi.fn();
    const { lastFrame, stdin, unmount } = render(
      inEnv(
        createElement(QuestionDialog, {
          pending: freeQ(),
          active: true,
          onReply: reply,
          width: 80,
        }),
      ),
    );
    stdin.write("abc");
    await pause();
    stdin.write("\x1b"); // 退出输入
    await pause();
    expect(reply).not.toHaveBeenCalled();
    expect(lastFrame()).toContain("abc");
    stdin.write("\x1b"); // 跳过
    await pause();
    expect(reply).toHaveBeenCalledWith({ skipped: true });
    unmount();
  });

  it("ASCII 环境：直角边框与文字符号仍可操作", async () => {
    const reply = vi.fn();
    const { lastFrame, stdin, unmount } = render(
      inEnv(
        createElement(QuestionDialog, {
          pending: choiceQ(true),
          active: true,
          onReply: reply,
          width: 80,
        }),
        { ascii: true, animated: false },
      ),
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("? 提问"); // ASCII 下 wait 标记为 ?
    expect(frame).toContain("[ ] 方案A");
    stdin.write(" ");
    await pause();
    expect(lastFrame()).toContain("[x] 方案A");
    stdin.write("\r");
    await pause();
    stdin.write("\r");
    await pause();
    expect(reply).toHaveBeenCalledWith({ answers: [{ selected: ["方案A"] }] });
    unmount();
  });

  it("窄终端（宽 32）：隐藏选项描述，选项仍可操作", async () => {
    const reply = vi.fn();
    const { lastFrame, stdin, unmount } = render(
      inEnv(
        createElement(QuestionDialog, {
          pending: choiceQ(),
          active: true,
          onReply: reply,
          width: 32,
        }),
      ),
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("方案A");
    expect(frame).not.toContain("保守做法");
    stdin.write("\r");
    await pause();
    stdin.write("\r");
    await pause();
    expect(reply).toHaveBeenCalledWith({ answers: [{ selected: ["方案A"] }] });
    unmount();
  });
});

describe("提问面板 · App 集成", () => {
  async function makeQuestionSession(questions: unknown[]) {
    const runtime = await createRuntime({
      cwd: tmp("nct-tui-ws-"),
      sessionsDir: tmp("nct-tui-sd-"),
      interactive: true,
      providers: [
        new FakeProvider({
          scripts: [
            [
              { type: "tool_call", toolCallId: "q1", name: "ask_user", input: { questions } },
              { type: "finish", reason: "tool_calls" },
            ],
          ],
        }),
      ],
    });
    const session = await runtime.createSession({ model: "fake/fake-model" });
    return { runtime, session };
  }

  it("面板打开：Esc 跳过不中断 Turn，对话留「已跳过」摘要", async () => {
    const { session, runtime } = await makeQuestionSession([
      { question: "选哪个？", options: [{ label: "A" }, { label: "B" }] },
    ]);
    const interrupt = vi.spyOn(session, "interrupt");
    const { lastFrame, stdin, unmount } = render(
      createElement(App, { session, runtime, env: ENV }),
    );
    void session.submit({ text: "干活" });
    await waitFor(() => (lastFrame() ?? "").includes("Esc 跳过"));
    await pause(60); // 等面板 useInput 订阅生效
    stdin.write("\x1b"); // Esc：面板内跳过，不是中断 Turn
    await waitFor(() => (lastFrame() ?? "").includes("提问已跳过"));
    expect(interrupt).not.toHaveBeenCalled();
    unmount();
    await session.close();
  });

  it("面板打开：Ctrl+C 沿用现有中断", async () => {
    const { session, runtime } = await makeQuestionSession([
      { question: "选哪个？", options: [{ label: "A" }, { label: "B" }] },
    ]);
    const interrupt = vi.spyOn(session, "interrupt");
    const { lastFrame, stdin, unmount } = render(
      createElement(App, { session, runtime, env: ENV }),
    );
    void session.submit({ text: "干活" });
    await waitFor(() => (lastFrame() ?? "").includes("Esc 跳过"));
    stdin.write("\x03");
    await waitFor(() => interrupt.mock.calls.length > 0);
    await waitFor(() => (lastFrame() ?? "").includes("调用已被中断"));
    unmount();
    await session.close();
  });

  it("提交后对话中留「问题 → 回答」摘要，状态栏显示等待回答", async () => {
    const { session, runtime } = await makeQuestionSession([
      { question: "选哪个？", options: [{ label: "A" }, { label: "B" }] },
    ]);
    const { lastFrame, stdin, unmount } = render(
      createElement(App, { session, runtime, env: ENV, inline: true }),
    );
    void session.submit({ text: "干活" });
    await waitFor(() => (lastFrame() ?? "").includes("Esc 跳过"));
    expect(lastFrame()).toContain("等待回答");
    await pause(60); // 等面板 useInput 订阅生效
    stdin.write("\r"); // 选中 A → 确认行
    await waitFor(() => (lastFrame() ?? "").includes("确认回答"));
    stdin.write("\r"); // 提交
    await waitFor(() => (lastFrame() ?? "").includes("已提交回答"));
    expect(lastFrame()).toContain("选哪个？ → A");
    unmount();
    await session.close();
  });
});
