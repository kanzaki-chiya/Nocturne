/**
 * ADR-0076 执行方式在完整 App 里的往返：计划模式中设定目标、/goal 状态与停止。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createElement } from "react";
import { cleanup, render } from "ink-testing-library";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRuntime, FakeProvider, replaySessionView, type FakeScript } from "@nocturne/core";
import { App } from "../src/app.js";
import { settle } from "./provider-test-utils.js";

const dirs: string[] = [];
const temp = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "nct-wm-ui-"));
  dirs.push(dir);
  return dir;
};
beforeEach(() => vi.stubEnv("NOCTURNE_HOME", temp()));
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const pause = (ms = 100) => new Promise((resolve) => setTimeout(resolve, ms));
const text = (value: string): FakeScript => [
  { type: "text_delta", text: value },
  { type: "finish", reason: "stop" },
];
const callTool = (id: string, name: string, input: unknown): FakeScript[number] => ({
  type: "tool_call",
  toolCallId: id,
  name,
  input,
});

it("计划模式中设定目标：回复照常显示、不续跑；/goal 看到进行中，/goal stop 停止", async () => {
  const provider = new FakeProvider({ scripts: [text("计划初稿"), text("交付清单已列出")] });
  const runtime = await createRuntime({ cwd: temp(), sessionsDir: temp(), providers: [provider] });
  const session = await runtime.createSession({ model: "fake/fake-1" });
  const ui = render(
    createElement(App, { session, runtime, env: { ascii: false, animated: false } }),
  );
  const frame = () => ui.lastFrame() ?? "";
  const settleOn = async (want: string) => {
    try {
      await settle(() => frame().includes(want));
    } catch {
      throw new Error(`等待「${want}」超时，当前帧：\n${frame()}`);
    }
  };
  const enter = async (value: string) => {
    ui.stdin.write(value);
    await pause();
    ui.stdin.write("\r");
  };
  try {
    await settleOn("fake-1");
    await enter("/plan 加功能");
    await settleOn("计划初稿");
    await enter("/goal 测试全过");
    await settleOn("交付清单已列出");
    expect(provider.requests).toHaveLength(2);
    await pause(200);
    await enter("/goal");
    await settleOn("状态：进行中");
    // 本地提示行推入后，之前的助手回复仍在原位
    expect(frame()).toContain("交付清单已列出");
    await enter("/goal stop");
    await settleOn("目标已停止");
    expect(session.state().goal).toMatchObject({ status: "stopped", reason: "user" });
    await enter("/goal cancel");
    await settleOn("目标已取消");
    expect(session.state().goal).toBeUndefined();
  } finally {
    ui.unmount();
    await session.close();
  }
});

it("/swarm board 只提示用法；/swarm end 无未合并分支时不输出，有未合并分支时逐行显示 @name 分支名", async () => {
  const provider = new FakeProvider({
    scripts: [
      [
        callTool("init", "swarm_init", { title: "测试协作" }),
        { type: "finish", reason: "tool_calls" },
      ],
      text("协作已建立"),
    ],
  });
  const runtime = await createRuntime({
    cwd: temp(),
    sessionsDir: temp(),
    providers: [provider],
    interactive: true,
    subagent: { background: true },
  });
  const session = await runtime.createSession({ model: "fake/fake-1" });
  const ui = render(
    createElement(App, { session, runtime, env: { ascii: false, animated: false } }),
  );
  const frame = () => ui.lastFrame() ?? "";
  const settleOn = async (want: string) => {
    try {
      await settle(() => frame().includes(want));
    } catch {
      throw new Error(`等待「${want}」超时，当前帧：\n${frame()}`);
    }
  };
  const enter = async (value: string) => {
    ui.stdin.write(value);
    await pause();
    ui.stdin.write("\r");
  };
  const swarmStatus = () => replaySessionView(session.durableEvents()).swarm?.status;
  try {
    await settleOn("fake-1");
    // /swarm board 没有 TUI 页面：只提示用法，不能落到 resumeGoal 报「没有目标」
    await enter("/swarm board");
    await settleOn("用法：/swarm 任务");
    expect(frame()).not.toContain("! 没有目标");
    // 无 Swarm 时 /swarm end 走 endSwarm 报错路径
    await enter("/swarm end");
    await settleOn("! 当前会话没有进行中的 Swarm");
    expect(frame()).not.toContain("! 没有目标");
    expect(swarmStatus()).toBeUndefined();
    // 用协调者的 swarm_init 建立活动 Swarm
    await enter("/swarm 测试协作");
    await settleOn("协作已建立");
    await settle(() => swarmStatus() === "active");
    await enter("/swarm end");
    await settle(() => swarmStatus() === "ended");
    expect(frame()).not.toContain("Swarm 已结束");
    // 有未合并工作树时逐行输出 `@name 分支名`
    const originalEnd = session.endSwarm.bind(session);
    session.endSwarm = async () => ({
      unmerged: [
        {
          name: "orders",
          childSessionId: "child-orders",
          branch: "nocturne/orders-wt",
          base: "aaaa",
          head: "bbbb",
          worktree: "/tmp/wt1",
          files: [],
        },
        {
          name: "users",
          childSessionId: "child-users",
          branch: "nocturne/users-wt",
          base: "aaaa",
          head: "cccc",
          worktree: "/tmp/wt2",
          files: [],
        },
      ],
    });
    try {
      await enter("/swarm end");
      await settleOn("@orders nocturne/orders-wt");
      await settleOn("@users nocturne/users-wt");
      expect(frame()).not.toContain("Swarm 已结束");
    } finally {
      session.endSwarm = originalEnd;
    }
  } finally {
    ui.unmount();
    await session.close();
  }
});

it("全屏无任务清单也显示目标；暂停、继续和取消往返", async () => {
  const provider = new FakeProvider({ scripts: [[{ type: "wait" }]] });
  const runtime = await createRuntime({ cwd: temp(), sessionsDir: temp(), providers: [provider] });
  const session = await runtime.createSession({ model: "fake/fake-1" });
  const ui = render(
    createElement(App, { session, runtime, inline: false, env: { ascii: false, animated: false } }),
  );
  const enter = async (value: string) => {
    ui.stdin.write(value);
    await pause();
    ui.stdin.write("\r");
  };
  try {
    await enter("/goal x");
    await settle(() => (ui.lastFrame() ?? "").includes("│ /goal x │"));
    await enter("/goal stop");
    await settle(() => session.state().goal?.status === "stopped");
    await enter("/goal resume");
    await settle(() => session.state().goal?.status === "active");
    await enter("/goal cancel");
    await settle(
      () => session.state().goal === undefined && !(ui.lastFrame() ?? "").includes("│ /goal x │"),
    );
    expect(ui.lastFrame()).toContain("目标已取消");
  } finally {
    ui.unmount();
    await session.close();
  }
});
