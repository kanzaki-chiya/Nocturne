/**
 * 全屏交互：帧高、滚动提示、浮层不丢输入、快捷键不插条目、补全键位、状态栏。
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { render as inkRender } from "ink";
import { render } from "ink-testing-library";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createRuntime, FakeProvider, type Runtime, type RuntimeSession } from "@nocturne/core";

import { App } from "../src/app.js";
import { NEW_CONTENT_HINT, SCROLLED_HINT } from "../src/lines.js";

const tmpRoots: string[] = [];
afterEach(() => {
  for (const r of tmpRoots.splice(0)) rmSync(r, { recursive: true, force: true });
});
const tmp = (p: string) => {
  const d = mkdtempSync(path.join(tmpdir(), p));
  tmpRoots.push(d);
  return d;
};
const ENV = { ascii: false, animated: false };
const pause = (ms = 40) => new Promise((r) => setTimeout(r, ms));

async function waitFor(check: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("waitFor 超时");
    await pause(20);
  }
}

async function sessionWithEffort(): Promise<{ runtime: Runtime; session: RuntimeSession }> {
  const runtime = await createRuntime({
    cwd: tmp("nct-fs-ws-"),
    sessionsDir: tmp("nct-fs-sd-"),
    providers: [
      new FakeProvider({
        id: "commandcode",
        scripts: [
          [
            { type: "text_delta", text: `${"甲\n".repeat(30)}完毕` },
            { type: "finish", reason: "stop" },
          ],
          // 第二次提交也要有正文：空回复会触发退避重试，拖到接近测试超时
          [
            { type: "text_delta", text: "新的回答" },
            { type: "finish", reason: "stop" },
          ],
        ],
        models: [
          {
            ref: { provider: "commandcode", model: "deepseek/deepseek-v4.1-flash" },
            displayName: "Flash",
            contextWindow: 1_000_000,
            maxOutputTokens: 8192,
            capabilities: {
              toolCalls: true,
              parallelToolCalls: true,
              reasoning: "visible",
              imageInput: false,
              promptCache: false,
              reasoningEffort: ["low", "high"],
            },
          },
        ],
      }),
    ],
  });
  const session = await runtime.createSession({
    model: "commandcode/deepseek/deepseek-v4.1-flash",
  });
  return { runtime, session };
}

function frameLines(frame: string | undefined): string[] {
  const lines = (frame ?? "").replace(/\r\n/g, "\n").split("\n");
  while (lines.length > 0 && lines.at(-1) === "") lines.pop();
  return lines;
}

describe("全屏界面", () => {
  it("/preset 与 /effort 无参选择高亮当前值，Enter 生效、Esc 取消", async () => {
    const { runtime, session } = await sessionWithEffort();
    const { lastFrame, stdin, unmount } = render(
      createElement(App, { session, runtime, env: ENV }),
    );
    await pause(80);
    stdin.write("/preset");
    await pause(40);
    stdin.write("\r");
    await waitFor(() => (lastFrame() ?? "").includes("选择权限预设"));
    expect(lastFrame()).toContain("› default");
    await pause(60);
    stdin.write("\x1b[B");
    await pause(80);
    expect(lastFrame()).toContain("› auto-edit");
    stdin.write("\r");
    await waitFor(() => session.state().config.permissionPreset === "auto-edit");
    stdin.write("/effort");
    await pause(40);
    stdin.write("\r");
    await waitFor(() => (lastFrame() ?? "").includes("选择思考强度"));
    expect(lastFrame()).toContain("› off");
    await pause(60);
    stdin.write("\x1b[B");
    await waitFor(() => (lastFrame() ?? "").includes("› low"));
    stdin.write("\r");
    await waitFor(() => (lastFrame() ?? "").includes("思考:low"));
    stdin.write("/effort");
    await pause(40);
    stdin.write("\r");
    await waitFor(() => (lastFrame() ?? "").includes("选择思考强度"));
    expect(lastFrame()).toContain("› low");
    stdin.write("\x1b");
    await waitFor(() => !(lastFrame() ?? "").includes("选择思考强度"));
    expect(lastFrame()).toContain("思考:low");
    unmount();
    await session.close();
  }, 10000);

  it("忙时 Esc 中断，空闲 Esc 保留输入；紧跟字母的 Esc 不误中断", async () => {
    const root = tmp("nct-esc-ws-");
    const runtime = await createRuntime({
      cwd: root,
      sessionsDir: tmp("nct-esc-sd-"),
      providers: [
        new FakeProvider({
          scripts: [
            [
              { type: "wait", ms: 5000 },
              { type: "text_delta", text: "太晚" },
            ],
          ],
        }),
      ],
    });
    const session = await runtime.createSession({ model: "fake/fake-1" });
    const interrupt = vi.spyOn(session, "interrupt");
    const { lastFrame, stdin, unmount } = render(
      createElement(App, { session, runtime, env: ENV }),
    );
    await pause(80);
    stdin.write("草稿");
    stdin.write("\x1b");
    await pause(120);
    expect(lastFrame()).toContain("草稿");
    expect(interrupt).not.toHaveBeenCalled();
    const turn = session.submit({ text: "开始" });
    await waitFor(() => (lastFrame() ?? "").includes("思考中"));
    stdin.write("\x1b");
    stdin.write("m");
    await pause(120);
    expect(interrupt).not.toHaveBeenCalled();
    stdin.write("\x1b");
    await waitFor(() => interrupt.mock.calls.length === 1);
    await turn;
    await waitFor(() => (lastFrame() ?? "").includes("idle"));
    unmount();
    await session.close();
  }, 10000);

  it("默认帧高等于 rows-1", async () => {
    const { runtime, session } = await sessionWithEffort();
    const { lastFrame, unmount } = render(createElement(App, { session, runtime, env: ENV }));
    await pause(80);
    // ink-testing-library 不报 rows，App 按 24 行计算，帧高 23
    expect(frameLines(lastFrame()).length).toBe(23);
    unmount();
    await session.close();
  });

  it("矮终端先减候选再压对话，帧高仍是 rows-1", async () => {
    const { runtime, session } = await sessionWithEffort();
    const stdout = new EventEmitter() as NodeJS.WriteStream & { frames: string[] };
    stdout.frames = [];
    stdout.columns = 40;
    stdout.rows = 8;
    stdout.isTTY = false;
    stdout.write = ((chunk: string | Uint8Array) => {
      stdout.frames.push(String(chunk));
      return true;
    }) as NodeJS.WriteStream["write"];
    const stdin = new EventEmitter() as NodeJS.ReadStream;
    stdin.isTTY = true;
    stdin.setRawMode = () => {
      return stdin;
    };
    stdin.setEncoding = () => stdin;
    stdin.resume = () => stdin;
    stdin.pause = () => stdin;
    stdin.ref = () => stdin;
    stdin.unref = () => stdin;
    stdin.read = () => null;
    const stderr = new EventEmitter() as NodeJS.WriteStream;
    stderr.write = (() => true) as NodeJS.WriteStream["write"];
    const app = inkRender(createElement(App, { session, runtime, env: ENV }), {
      stdout,
      stdin,
      stderr,
      exitOnCtrlC: false,
      patchConsole: false,
      debug: true,
    });
    await pause(80);
    const frame = stdout.frames.at(-1) ?? "";
    const lines = frameLines(frame);
    expect(lines.length).toBeLessThanOrEqual(7);
    expect(lines.length).toBe(7);
    app.unmount();
    await session.close();
  });

  it("翻页先提示已翻阅，新输出后提示新内容，回到底部消失", async () => {
    const { runtime, session } = await sessionWithEffort();
    const { lastFrame, stdin, unmount } = render(
      createElement(App, { session, runtime, env: ENV }),
    );
    await pause(60);
    await session.submit({ text: "长回答" });
    await pause(80);
    expect(lastFrame()).not.toContain(NEW_CONTENT_HINT);
    stdin.write("\x1b[5~");
    await pause(60);
    expect(lastFrame()).toContain(SCROLLED_HINT);
    expect(lastFrame()).not.toContain(NEW_CONTENT_HINT);
    await session.submit({ text: "新回答" });
    await pause(80);
    expect(lastFrame()).toContain(NEW_CONTENT_HINT);
    stdin.write("\x1b[1;5F");
    await pause(60);
    expect(lastFrame()).not.toContain(NEW_CONTENT_HINT);
    expect(lastFrame()).not.toContain(SCROLLED_HINT);
    unmount();
    await session.close();
  });

  it("打开模型页再关闭，输入框文字还在", async () => {
    const { runtime, session } = await sessionWithEffort();
    const provider = {
      config: {
        describeProviders: () => Promise.resolve([]),
        setDefaultModel: () => Promise.resolve(),
        removeSetupProvider: () => Promise.resolve(),
        refreshUpstreamLimits: () => Promise.resolve(),
        credentials: { backend: () => "none" as const },
        base: { providers: [] },
      } as never,
      reloadConfig: () => Promise.resolve({} as never),
      updateProviders: () => undefined,
    };
    const { lastFrame, stdin, unmount } = render(
      createElement(App, { session, runtime, env: ENV, provider }),
    );
    await pause(60);
    stdin.write("草稿");
    await pause(40);
    expect(lastFrame()).toContain("草稿");
    for (const _ of "草稿") stdin.write("\x7f");
    await pause(40);
    stdin.write("/model");
    stdin.write("\r");
    await pause(250);
    expect(lastFrame()).toContain("搜索");
    stdin.write("\x1b");
    stdin.write("\x1b");
    await pause(150);
    expect(lastFrame()).toContain("/model");
    unmount();
    await session.close();
  });

  it("Shift+Tab 与 Alt+M 不插入对话条目，状态栏更新", async () => {
    const { runtime, session } = await sessionWithEffort();
    const { lastFrame, stdin, unmount } = render(
      createElement(App, { session, runtime, env: ENV }),
    );
    await pause(80);
    stdin.write("\x1b[Z");
    await pause(80);
    expect(lastFrame()).toContain("思考:low");
    expect(lastFrame()).not.toContain("思考档位已切换");
    stdin.write("\x1bm");
    await pause(80);
    expect(lastFrame()).toContain("auto-edit");
    expect(lastFrame()).not.toContain("权限预设已切换");
    unmount();
    await session.close();
  });

  it("状态栏是百分比 / 大写长度，模型段只显示模型 ID", async () => {
    const { runtime, session } = await sessionWithEffort();
    const { lastFrame, unmount } = render(createElement(App, { session, runtime, env: ENV }));
    await pause(80);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("deepseek/deepseek-v4.1-flash");
    expect(frame).not.toContain("commandcode/");
    expect(frame).toMatch(/\d+\.\d% \/ 1M|\d+% \/ 1M/);
    unmount();
    await session.close();
  });

  it("输入 /p 显示候选，Tab 补全，Esc 保留文字", async () => {
    const { runtime, session } = await sessionWithEffort();
    const { lastFrame, stdin, unmount } = render(
      createElement(App, { session, runtime, env: ENV }),
    );
    await pause(60);
    stdin.write("/p");
    await pause(60);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("/provider");
    expect(frame).toContain("/preset");
    expect(frame.indexOf("/preset")).toBeLessThan(frame.indexOf("/provider"));
    stdin.write("\t");
    await pause(40);
    expect(lastFrame()).toContain("/preset");
    stdin.write("\x1b");
    await pause(40);
    expect(lastFrame()).toContain("/preset");
    unmount();
    await session.close();
  });

  it("Tab 补全后退格再插入发生在末尾", async () => {
    const { runtime, session } = await sessionWithEffort();
    const { lastFrame, stdin, unmount } = render(
      createElement(App, { session, runtime, env: ENV }),
    );
    await pause(60);
    stdin.write("/pre");
    await pause(40);
    stdin.write("\t");
    await pause(40);
    stdin.write("\x1b");
    await pause(40);
    stdin.write("\x7f");
    stdin.write("X");
    await pause(60);
    expect(lastFrame()).toContain("› /preseX");
    expect(lastFrame()).not.toContain("/prXset");
    unmount();
    await session.close();
  });

  it("多行粘贴收成占位、不提交；退格整块删除；提交时发原文", async () => {
    const { runtime, session } = await sessionWithEffort();
    const submit = vi.spyOn(session, "submit");
    const { lastFrame, stdin, unmount } = render(
      createElement(App, { session, runtime, env: ENV }),
    );
    await pause(60);
    stdin.write("看：");
    stdin.write("\x1b[200~第一行\r\r* 第二行\x1b[201~");
    await pause(60);
    expect(lastFrame()).toContain("› 看：[Paste #1, +2 lines]");
    expect(lastFrame()).toContain("idle");
    stdin.write("\x7f");
    await pause(40);
    expect(lastFrame()).toContain("› 看：");
    expect(lastFrame()).not.toContain("[Paste");
    stdin.write("\x1b[200~甲\r乙\x1b[201~");
    await pause(40);
    expect(lastFrame()).toContain("› 看：[Paste #2, +1 lines]");
    stdin.write("\r");
    await waitFor(() => (lastFrame() ?? "").includes("完毕"));
    // 发给模型的是原文，不是占位
    expect(submit.mock.calls[0]?.[0]).toEqual({ text: "看：甲\n乙" });
    unmount();
    await session.close();
  });

  it("历史回填后退格再插入发生在末尾", async () => {
    const { runtime, session } = await sessionWithEffort();
    const { lastFrame, stdin, unmount } = render(
      createElement(App, { session, runtime, env: ENV }),
    );
    await pause(60);
    stdin.write("你好abc");
    stdin.write("\r");
    // Turn 结束（回到 idle）后输入框才接受 ↑；固定等待在慢机器上会与 Turn 赛跑
    await waitFor(() => {
      const frame = lastFrame() ?? "";
      return frame.includes("完毕") && frame.includes("idle");
    });
    stdin.write("\x1b[A");
    await pause(50);
    stdin.write("\x7f");
    stdin.write("X");
    await pause(60);
    expect(lastFrame()).toContain("› 你好abX");
    expect(lastFrame()).not.toContain("› 你好Xbc");
    unmount();
    await session.close();
  });

  it("/effort 空格后列出档位和 off", async () => {
    const { runtime, session } = await sessionWithEffort();
    const { lastFrame, stdin, unmount } = render(
      createElement(App, { session, runtime, env: ENV }),
    );
    await pause(60);
    stdin.write("/effort ");
    await pause(60);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("off");
    expect(frame).toContain("low");
    expect(frame).toContain("high");
    unmount();
    await session.close();
  });
});
